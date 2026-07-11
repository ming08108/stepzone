/**
 * Binary streaming for the P2P song transfer (docs/VERSUS.md): the host
 * pushes each announced file's bytes over the guest's RTCDataChannel in small
 * chunks with backpressure (bufferedamountlow); the guest reassembles them.
 * Control flow (fileReq/fileMeta/fileDone) rides the JSON room protocol and
 * the fileMeta's `files` list fixes the order and size of every binary that
 * follows — audio first, then background art when it fits the cap. This
 * module only moves bytes; no server touches the song at any point.
 */

import type { TransferBinary } from './versus';

/** SCTP-safe chunk size (works across browsers without negotiation). */
const CHUNK_BYTES = 16 * 1024;
/** Pause sending when this much is queued on the channel... */
const HIGH_WATER = 1 << 20;
/** ...and resume once it drains below this. */
const LOW_WATER = 256 * 1024;

/** Stream a buffer as ordered binary frames, yielding to backpressure. */
export async function sendBinaryChunks(channel: RTCDataChannel, buf: ArrayBuffer): Promise<void> {
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

/**
 * Reassembles the guest's incoming chunks into the files fileMeta announced.
 * The channel is ordered, so bytes belong to the files in list order; a chunk
 * spanning a file boundary is split across both.
 */
export class TransferSink {
  private readonly parts: ArrayBuffer[][] = [];
  private fileAt = 0;
  private fileReceived = 0;
  received = 0;
  readonly total: number;

  constructor(
    readonly files: TransferBinary[],
    private readonly onChunk?: (received: number, total: number) => void,
  ) {
    this.total = files.reduce((sum, f) => sum + f.bytes, 0);
    for (let i = 0; i < files.length; i++) this.parts.push([]);
  }

  push(chunk: ArrayBuffer): void {
    let at = 0;
    while (at < chunk.byteLength && this.fileAt < this.files.length) {
      const room = this.files[this.fileAt].bytes - this.fileReceived;
      const take = Math.min(room, chunk.byteLength - at);
      if (take > 0) {
        this.parts[this.fileAt].push(chunk.slice(at, at + take));
        this.fileReceived += take;
        this.received += take;
        at += take;
      }
      if (this.fileReceived >= this.files[this.fileAt].bytes) {
        this.fileAt++;
        this.fileReceived = 0;
      }
    }
    // Bytes past the announced total are an over-send — dropped.
    this.onChunk?.(this.received, this.total);
  }

  get complete(): boolean {
    return this.received >= this.total;
  }

  /** The reassembled bytes of the i-th announced file. */
  bytes(index: number): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(this.files[index]?.bytes ?? 0);
    let at = 0;
    for (const part of this.parts[index] ?? []) {
      out.set(new Uint8Array(part), at);
      at += part.byteLength;
    }
    return out;
  }
}
