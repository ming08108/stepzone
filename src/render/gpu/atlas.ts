/**
 * Dynamic sprite atlas for the WebGPU note field. All static art (arrows,
 * receptors, HUD chrome, text) is rasterized ONCE by the same procedural
 * canvas paint code the 2D theme uses — so the two renderers are pixel-twins —
 * then packed into a single GPU texture. Per frame the renderer only draws
 * instanced quads sampling this texture; canvas 2D never runs on the hot path.
 *
 * Packing is a simple shelf allocator: sprites are grouped into rows. There
 * is no eviction — a design-scale change clears everything and rebakes (it
 * already invalidates every sprite, exactly like the 2D SpriteStore).
 * Dynamic text ("slots": combo counter, score panel) repaints in place when
 * its content key changes and only reallocates if it outgrows its region.
 */

/** Supersample factor for baked sprites, matching the 2D theme's SPRITE_SCALE. */
export const ATLAS_SPRITE_SCALE = 2;

const ATLAS_SIZE = 2048;
/** Empty border around every sprite so bilinear sampling never bleeds. */
const PAD = 2;

export interface AtlasRect {
  /** Normalized uv rect in the atlas texture. */
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  /** Logical (css px) size the sprite was baked for. */
  w: number;
  h: number;
}

interface Slot {
  rect: AtlasRect;
  key: string;
  /** Allocated pixel size (may exceed the current content's). */
  pw: number;
  ph: number;
  px: number;
  py: number;
}

export class GpuAtlas {
  readonly texture: GPUTexture;
  private readonly scratch: HTMLCanvasElement;
  private readonly sctx: CanvasRenderingContext2D;
  private sprites = new Map<string, AtlasRect | null>();
  private slots = new Map<string, Slot>();
  // Shelf allocator state.
  private shelfX = PAD;
  private shelfY = PAD;
  private shelfH = 0;

  constructor(private readonly device: GPUDevice) {
    this.texture = device.createTexture({
      label: 'notefield-atlas',
      size: [ATLAS_SIZE, ATLAS_SIZE],
      format: 'rgba8unorm',
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.scratch = document.createElement('canvas');
    this.scratch.width = ATLAS_SIZE;
    this.scratch.height = 1024;
    const c = this.scratch.getContext('2d');
    if (!c) throw new Error('2D scratch context unavailable for atlas baking');
    this.sctx = c;
  }

  /** Drop every sprite (design-scale change / font arrival); regions rebake lazily. */
  clear(): void {
    this.sprites.clear();
    this.slots.clear();
    this.shelfX = PAD;
    this.shelfY = PAD;
    this.shelfH = 0;
  }

  /** Allocate a pixel region, or null when the atlas is full. */
  private alloc(pw: number, ph: number): { px: number; py: number } | null {
    if (this.shelfX + pw + PAD > ATLAS_SIZE) {
      this.shelfX = PAD;
      this.shelfY += this.shelfH + PAD;
      this.shelfH = 0;
    }
    if (this.shelfY + ph + PAD > ATLAS_SIZE || pw + 2 * PAD > ATLAS_SIZE) return null;
    const at = { px: this.shelfX, py: this.shelfY };
    this.shelfX += pw + PAD;
    this.shelfH = Math.max(this.shelfH, ph);
    return at;
  }

  /** Paint into the scratch canvas at the supersampled size and upload the
   *  whole `uw`×`uh` region (which may exceed the painted content — slots
   *  upload their full allocation so stale pixels can't linger). */
  private bake(
    px: number,
    py: number,
    uw: number,
    uh: number,
    paint: (c: CanvasRenderingContext2D) => void,
  ): void {
    const c = this.sctx;
    c.save();
    c.clearRect(0, 0, uw, uh);
    c.beginPath();
    c.rect(0, 0, uw, uh);
    c.clip();
    c.scale(ATLAS_SPRITE_SCALE, ATLAS_SPRITE_SCALE);
    paint(c);
    c.restore();
    this.device.queue.copyExternalImageToTexture(
      { source: this.scratch, origin: { x: 0, y: 0 } },
      { texture: this.texture, origin: { x: px, y: py }, premultipliedAlpha: true },
      { width: uw, height: uh },
    );
  }

  /**
   * Static sprite: baked once per key. `w`/`h` are logical css px; the paint
   * callback draws at that scale (the supersample transform is pre-applied),
   * exactly like SpriteStore.sprite in the 2D theme.
   */
  sprite(
    key: string,
    w: number,
    h: number,
    paint: (c: CanvasRenderingContext2D) => void,
  ): AtlasRect | null {
    let rect = this.sprites.get(key);
    if (rect !== undefined) return rect;
    const pw = Math.min(ATLAS_SIZE - 2 * PAD, Math.max(1, Math.ceil(w * ATLAS_SPRITE_SCALE)));
    const ph = Math.min(1024, Math.max(1, Math.ceil(h * ATLAS_SPRITE_SCALE)));
    const at = this.alloc(pw, ph);
    if (!at) {
      // Full — remember the miss so we don't re-try every frame.
      this.sprites.set(key, null);
      return null;
    }
    this.bake(at.px, at.py, pw, ph, paint);
    rect = {
      u0: at.px / ATLAS_SIZE,
      v0: at.py / ATLAS_SIZE,
      u1: (at.px + pw) / ATLAS_SIZE,
      v1: (at.py + ph) / ATLAS_SIZE,
      w,
      h,
    };
    this.sprites.set(key, rect);
    return rect;
  }

  /**
   * Dynamic slot: one region per `slot` name, repainted in place when `key`
   * (a content hash: combo count, score digits…) changes. Grows by
   * reallocating; the old region is abandoned (rare — slots are sized by
   * their first, typical content).
   */
  slot(
    slot: string,
    key: string,
    w: number,
    h: number,
    paint: (c: CanvasRenderingContext2D) => void,
  ): AtlasRect | null {
    const pw = Math.min(ATLAS_SIZE - 2 * PAD, Math.max(1, Math.ceil(w * ATLAS_SPRITE_SCALE)));
    const ph = Math.min(1024, Math.max(1, Math.ceil(h * ATLAS_SPRITE_SCALE)));
    let s = this.slots.get(slot);
    if (s && (pw > s.pw || ph > s.ph)) s = undefined; // outgrown — reallocate
    if (!s) {
      // Over-allocate a little so combo growing a digit doesn't reallocate.
      const aw = Math.min(ATLAS_SIZE - 2 * PAD, Math.ceil(pw * 1.25));
      const at = this.alloc(aw, ph);
      if (!at) return null;
      s = {
        key: '',
        pw: aw,
        ph,
        px: at.px,
        py: at.py,
        rect: { u0: 0, v0: 0, u1: 0, v1: 0, w, h },
      };
      this.slots.set(slot, s);
    }
    if (s.key !== key) {
      s.key = key;
      this.bake(s.px, s.py, s.pw, s.ph, paint);
      s.rect = {
        u0: s.px / ATLAS_SIZE,
        v0: s.py / ATLAS_SIZE,
        u1: (s.px + pw) / ATLAS_SIZE,
        v1: (s.py + ph) / ATLAS_SIZE,
        w,
        h,
      };
    }
    return s.rect;
  }

  destroy(): void {
    try {
      this.texture.destroy();
    } catch {
      // device already lost
    }
  }
}
