/**
 * P2P song transfer plumbing: the multi-file binary sink that reassembles the
 * announced files (audio + optional background art) from ordered chunks, and
 * the hostile-frame rejections of the fileMeta parser.
 */
import { describe, expect, it } from 'vitest';
import { TransferSink } from '../src/net/versusTransfer';
import { parseHostMsg, parseSnap, type TransferBinary } from '../src/net/versus';

const files = (...sizes: number[]): TransferBinary[] =>
  sizes.map((bytes, i) => ({
    name: i === 0 ? 'song.ogg' : 'bg.png',
    kind: i === 0 ? ('audio' as const) : ('bg' as const),
    bytes,
  }));

describe('TransferSink', () => {
  it('reassembles ordered chunks and reports progress', () => {
    const seen: Array<[number, number]> = [];
    const sink = new TransferSink(files(6), (n, total) => seen.push([n, total]));
    sink.push(new Uint8Array([1, 2, 3]).buffer);
    expect(sink.complete).toBe(false);
    sink.push(new Uint8Array([4, 5, 6]).buffer);
    expect(sink.complete).toBe(true);
    expect([...sink.bytes(0)]).toEqual([1, 2, 3, 4, 5, 6]);
    expect(seen).toEqual([
      [3, 6],
      [6, 6],
    ]);
  });

  it('splits a chunk spanning a file boundary across both files', () => {
    const sink = new TransferSink(files(3, 2));
    sink.push(new Uint8Array([1, 2]).buffer);
    sink.push(new Uint8Array([3, 7, 8]).buffer); // 3 finishes the audio; 7,8 are the bg
    expect(sink.complete).toBe(true);
    expect([...sink.bytes(0)]).toEqual([1, 2, 3]);
    expect([...sink.bytes(1)]).toEqual([7, 8]);
  });

  it('ignores over-send past the announced total', () => {
    const sink = new TransferSink(files(2));
    sink.push(new Uint8Array([9, 9]).buffer);
    sink.push(new Uint8Array([7]).buffer); // hostile extra
    expect(sink.received).toBe(2);
    expect([...sink.bytes(0)]).toEqual([9, 9]);
  });
});

describe('transfer frames', () => {
  it('parses a valid fileMeta and rejects hostile ones', () => {
    const ok = {
      t: 'fileMeta',
      simfileName: 'song.ssc',
      simfile: '#TITLE:x;',
      files: [
        { name: 'song.ogg', kind: 'audio', bytes: 1234 },
        { name: 'bg.mp4', kind: 'bg', bytes: 999 },
      ],
    };
    expect(parseHostMsg(JSON.stringify(ok))).toEqual(ok);
    expect(
      parseHostMsg(JSON.stringify({ ...ok, simfileName: '../escape.ssc' })), // path smuggling
    ).toBeNull();
    const withFiles = (f: unknown) => JSON.stringify({ ...ok, files: f });
    expect(parseHostMsg(withFiles([{ name: 'a.ogg', kind: 'audio', bytes: -1 }]))).toBeNull();
    expect(parseHostMsg(withFiles([{ name: 'a.ogg', kind: 'audio', bytes: 1e12 }]))).toBeNull();
    expect(parseHostMsg(withFiles([{ name: 'b.mp4', kind: 'bg', bytes: 1e9 }]))).toBeNull(); // bg over cap
    expect(parseHostMsg(withFiles([{ name: 'x/y.ogg', kind: 'audio', bytes: 1 }]))).toBeNull();
    expect(parseHostMsg(withFiles([]))).toBeNull();
    expect(parseHostMsg(JSON.stringify({ t: 'fileErr', message: 'x'.repeat(300) }))).toBeNull();
    // Path smuggling via backslash or dot-dot (no slash) is rejected too.
    expect(parseHostMsg(withFiles([{ name: 'a\\b.ogg', kind: 'audio', bytes: 1 }]))).toBeNull();
    expect(parseHostMsg(withFiles([{ name: '..', kind: 'audio', bytes: 1 }]))).toBeNull();
    // A zero-byte "file" is only ever hostile — every real transfer has content.
    expect(parseHostMsg(withFiles([{ name: 'a.ogg', kind: 'audio', bytes: 0 }]))).toBeNull();
    // Each file is under its per-kind cap, but the whole transfer exceeds the
    // aggregate ceiling — reject so a host can't force ~256 MB of allocation.
    const big = 60 * 1024 * 1024;
    expect(
      parseHostMsg(
        withFiles([
          { name: 'a.ogg', kind: 'audio', bytes: big },
          { name: 'b.ogg', kind: 'audio', bytes: big },
        ]),
      ),
    ).toBeNull();
  });
});

describe('parseSnap', () => {
  const base = { atSong: 1, percent: 0.5, combo: 3, life: 1, failed: false };
  it('accepts a valid integer seq and clamps ranges', () => {
    expect(parseSnap({ ...base, seq: 7 })?.seq).toBe(7);
    expect(parseSnap({ ...base, seq: 0, percent: 2 })?.percent).toBe(1);
  });
  it('rejects non-integer, negative, or non-finite seq (freeze guard)', () => {
    // A huge/fractional seq would pass a bare finite check and, being > every
    // real integer seq, freeze the monotonic receiver on a fake sample.
    expect(parseSnap({ ...base, seq: 1e308 })).toBeNull();
    expect(parseSnap({ ...base, seq: 1.5 })).toBeNull();
    expect(parseSnap({ ...base, seq: -1 })).toBeNull();
    expect(parseSnap({ ...base, seq: Number.NaN })).toBeNull();
  });
});
