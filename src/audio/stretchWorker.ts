/**
 * Worker wrapper for the WSOLA time-stretch — a 2-minute track takes seconds
 * of pure float math, which must not freeze the loading splash. The clock
 * transfers the channel data in, we transfer the stretched channels back.
 */
import { stretchChannels } from './timeStretch';

self.onmessage = (e: MessageEvent) => {
  const { channels, sampleRate, rate } = e.data as {
    channels: Float32Array[];
    sampleRate: number;
    rate: number;
  };
  const out = stretchChannels(channels, sampleRate, rate);
  (self as unknown as Worker).postMessage(
    { channels: out },
    out.map((c) => c.buffer),
  );
};
