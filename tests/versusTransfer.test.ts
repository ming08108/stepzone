/**
 * P2P song transfer plumbing: the fileReq/fileMeta/fileDone handshake over
 * the match protocol, and the binary chunk sink that reassembles the audio.
 */
import { describe, expect, it } from 'vitest';
import { ChunkSink } from '../src/net/versusTransfer';
import { parsePeerMsg } from '../src/net/versus';

describe('ChunkSink', () => {
  it('reassembles ordered chunks and reports progress', () => {
    const seen: number[] = [];
    const sink = new ChunkSink(6, (n) => seen.push(n));
    sink.push(new Uint8Array([1, 2, 3]).buffer);
    expect(sink.complete).toBe(false);
    sink.push(new Uint8Array([4, 5, 6]).buffer);
    expect(sink.complete).toBe(true);
    expect([...sink.bytes()]).toEqual([1, 2, 3, 4, 5, 6]);
    expect(seen).toEqual([3, 6]);
  });

  it('ignores over-send past the announced size', () => {
    const sink = new ChunkSink(2);
    sink.push(new Uint8Array([9, 9]).buffer);
    sink.push(new Uint8Array([7]).buffer); // hostile extra
    expect(sink.received).toBe(2);
    expect([...sink.bytes()]).toEqual([9, 9]);
  });
});

describe('transfer frames', () => {
  it('parses a valid fileMeta and rejects hostile ones', () => {
    const ok = {
      t: 'fileMeta',
      simfileName: 'song.ssc',
      simfile: '#TITLE:x;',
      audioName: 'song.ogg',
      audioBytes: 1234,
    };
    expect(parsePeerMsg(JSON.stringify(ok))).toEqual(ok);
    expect(
      parsePeerMsg(JSON.stringify({ ...ok, simfileName: '../escape.ssc' })), // path smuggling
    ).toBeNull();
    expect(parsePeerMsg(JSON.stringify({ ...ok, audioBytes: -1 }))).toBeNull();
    expect(parsePeerMsg(JSON.stringify({ ...ok, audioBytes: 1e12 }))).toBeNull();
    expect(parsePeerMsg(JSON.stringify({ t: 'fileErr', message: 'x'.repeat(300) }))).toBeNull();
  });
});
