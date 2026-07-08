/**
 * GPU timing via WebGPU timestamp queries. Wraps the field's render pass with
 * a start/end timestamp, resolves + copies the pair to a pooled readback
 * buffer each frame, and maps it asynchronously — so the benchmark can report
 * the REAL GPU time of each PRESENTED frame, not a synthetic offscreen
 * throughput. `enabled` is false when the adapter lacks `timestamp-query`
 * (the caller must have requested the feature at device creation); then the
 * timer is a no-op and the bench simply omits GPU timing.
 *
 * The readback is a frame or two behind (mapAsync latency); results accumulate
 * into `read()` and are drained after the measured window (with a short flush).
 */

/** Readback buffers in flight; enough to cover mapAsync latency at high fps. */
const POOL = 8;

export class GpuTimer {
  readonly enabled: boolean;
  private querySet?: GPUQuerySet;
  private resolveBuf?: GPUBuffer;
  private pool: GPUBuffer[] = [];
  private pending: GPUBuffer | null = null;
  private times: number[] = [];

  constructor(device: GPUDevice) {
    this.enabled = device.features.has('timestamp-query');
    if (!this.enabled) return;
    this.querySet = device.createQuerySet({ type: 'timestamp', count: 2 });
    this.resolveBuf = device.createBuffer({
      size: 16, // 2 × u64
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
    });
    for (let i = 0; i < POOL; i++) {
      this.pool.push(
        device.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }),
      );
    }
  }

  /** Pass to beginRenderPass({ …, timestampWrites }); undefined when disabled. */
  private tsWrites?: GPURenderPassTimestampWrites;
  timestampWrites(): GPURenderPassTimestampWrites | undefined {
    if (!this.enabled || !this.querySet) return undefined;
    // Reused across frames (querySet is stable) — no per-frame descriptor alloc.
    if (!this.tsWrites)
      this.tsWrites = {
        querySet: this.querySet,
        beginningOfPassWriteIndex: 0,
        endOfPassWriteIndex: 1,
      };
    return this.tsWrites;
  }

  /** Resolve the pair into a pooled readback buffer. Call after pass.end(),
   *  before encoder.finish(). Skips the frame if the pool is momentarily dry. */
  resolve(enc: GPUCommandEncoder): void {
    this.pending = null;
    if (!this.enabled || !this.querySet || !this.resolveBuf) return;
    const rb = this.pool.pop();
    if (!rb) return;
    enc.resolveQuerySet(this.querySet, 0, 2, this.resolveBuf, 0);
    enc.copyBufferToBuffer(this.resolveBuf, 0, rb, 0, 16);
    this.pending = rb;
  }

  /** Kick off the async read of the just-resolved pair. Call after submit(). */
  afterSubmit(): void {
    const rb = this.pending;
    this.pending = null;
    if (!rb) return;
    rb.mapAsync(GPUMapMode.READ)
      .then(() => {
        const t = new BigUint64Array(rb.getMappedRange());
        const ms = Number(t[1] - t[0]) / 1e6; // timestamps are nanoseconds
        rb.unmap();
        if (ms > 0 && ms < 1000) this.times.push(ms);
        this.pool.push(rb);
      })
      .catch(() => {
        try {
          this.pool.push(rb);
        } catch {
          // buffer/device gone
        }
      });
  }

  reset(): void {
    this.times = [];
  }

  /** GPU ms of every presented frame timed since the last reset(). */
  read(): number[] {
    return this.times;
  }

  destroy(): void {
    try {
      this.querySet?.destroy();
      this.resolveBuf?.destroy();
      for (const b of this.pool) b.destroy();
    } catch {
      // device already lost
    }
  }
}
