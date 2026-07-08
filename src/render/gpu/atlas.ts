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
 *
 * `size` and `bakeScale` are fixed per instance: the note field constructs a
 * new atlas when the display demands different ones (a 4K fullscreen needs a
 * 4096² texture; bake resolution follows devicePixelRatio so sprites are
 * exactly backing-store sharp with no wasted memory).
 */

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
  private warnedClamp = false;
  /** Diagnostic: total sprite rasterizations (a mid-frame bake is a stutter). */
  bakes = 0;
  // Shelf allocator state.
  private shelfX = PAD;
  private shelfY = PAD;
  private shelfH = 0;

  constructor(
    private readonly device: GPUDevice,
    /** Texture edge in px (2048 normally, 4096 for 4K-class layouts). */
    readonly size = 2048,
    /** Bake resolution multiplier over css px (the display's dpr, 1..2). */
    readonly bakeScale = 2,
  ) {
    this.texture = device.createTexture({
      label: 'notefield-atlas',
      size: [size, size],
      format: 'rgba8unorm',
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.scratch = document.createElement('canvas');
    this.scratch.width = size;
    this.scratch.height = 1024;
    const c = this.scratch.getContext('2d');
    if (!c) throw new Error('2D scratch context unavailable for atlas baking');
    this.sctx = c;
  }

  /** Pixel size of `n` css px at this atlas's bake resolution, clamped to
   *  what the texture can hold (with a one-time squawk — a clamped sprite
   *  draws stretched, which should never happen if sizing upstream is right). */
  private toPx(n: number, cap: number): number {
    const px = Math.max(1, Math.ceil(n * this.bakeScale));
    if (px > cap) {
      if (!this.warnedClamp) {
        this.warnedClamp = true;
        console.warn(`[gpu-notefield] sprite exceeds ${this.size}px atlas (${px}px) — clamped`);
      }
      return cap;
    }
    return px;
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
    if (this.shelfX + pw + PAD > this.size) {
      this.shelfX = PAD;
      this.shelfY += this.shelfH + PAD;
      this.shelfH = 0;
    }
    if (this.shelfY + ph + PAD > this.size || pw + 2 * PAD > this.size) return null;
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
    this.bakes++;
    const c = this.sctx;
    c.save();
    c.clearRect(0, 0, uw, uh);
    c.beginPath();
    c.rect(0, 0, uw, uh);
    c.clip();
    c.scale(this.bakeScale, this.bakeScale);
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
    const pw = this.toPx(w, this.size - 2 * PAD);
    const ph = this.toPx(h, 1024);
    const at = this.alloc(pw, ph);
    if (!at) {
      // Full — remember the miss so we don't re-try every frame.
      this.sprites.set(key, null);
      return null;
    }
    this.bake(at.px, at.py, pw, ph, paint);
    rect = {
      u0: at.px / this.size,
      v0: at.py / this.size,
      u1: (at.px + pw) / this.size,
      v1: (at.py + ph) / this.size,
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
    const pw = this.toPx(w, this.size - 2 * PAD);
    const ph = this.toPx(h, 1024);
    let s = this.slots.get(slot);
    if (s && (pw > s.pw || ph > s.ph)) s = undefined; // outgrown — reallocate
    if (!s) {
      // Over-allocate a little so combo growing a digit doesn't reallocate.
      const aw = Math.min(this.size - 2 * PAD, Math.ceil(pw * 1.25));
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
        u0: s.px / this.size,
        v0: s.py / this.size,
        u1: (s.px + pw) / this.size,
        v1: (s.py + ph) / this.size,
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
