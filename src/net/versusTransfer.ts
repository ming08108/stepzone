/**
 * Binary audio streaming for the P2P song transfer (docs/VERSUS.md): the
 * host pushes the song's audio over the already-open RTCDataChannel in small
 * chunks with backpressure (bufferedamountlow), the joiner reassembles them.
 * Control flow (fileReq/fileMeta/fileDone) rides the JSON match protocol;
 * this module only moves bytes. No server touches the song at any point.
 */

/** SCTP-safe chunk size (works across browsers without negotiation). */
const CHUNK_BYTES = 16 * 1024;
/** Pause sending when this much is queued on the channel... */
const HIGH_WATER = 1 << 20;
/** ...and resume once it drains below this. */
const LOW_WATER = 256 * 1024;

/** Stream a buffer as ordered binary frames, yielding to backpressure. */
export async function sendAudioChunks(channel: RTCDataChannel, buf: ArrayBuffer): Promise<void> {
  channel.bufferedAmountLowThreshold = LOW_WATER;
  for (let at = 0; at < buf.byteLength; at += CHUNK_BYTES) {
    if (channel.bufferedAmount > HIGH_WATER) {
      await new Promise<void>((resolve) => {
        const drained = () => {
          channel.removeEventListener('bufferedamountlow', drained);
          resolve();
        };
        channel.addEventListener('bufferedamountlow', drained);
      });
      if (channel.readyState !== 'open') return; // peer left mid-transfer
    }
    channel.send(buf.slice(at, Math.min(buf.byteLength, at + CHUNK_BYTES)));
  }
}

/** Reassembles the joiner's incoming chunks up to the announced size. */
export class ChunkSink {
  private readonly parts: ArrayBuffer[] = [];
  received = 0;

  constructor(
    readonly total: number,
    private readonly onChunk?: (received: number) => void,
  ) {}

  push(chunk: ArrayBuffer): void {
    if (this.received >= this.total) return; // over-send — ignore
    this.parts.push(chunk);
    this.received += chunk.byteLength;
    this.onChunk?.(this.received);
  }

  get complete(): boolean {
    return this.received >= this.total;
  }

  bytes(): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(this.received);
    let at = 0;
    for (const part of this.parts) {
      out.set(new Uint8Array(part), at);
      at += part.byteLength;
    }
    return out;
  }
}
