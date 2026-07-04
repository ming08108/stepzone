import type { Song } from '../song/song';
import type { Steps } from '../song/steps';

/** Everything the Play view needs to run one chart. */
export interface PlayRequest {
  song: Song;
  chart: Steps;
  /** Encoded audio bytes, or null to play the synthesized metronome. */
  encodedAudio: ArrayBuffer | null;
  /** Background image/video File, or null. Play owns its object URL. */
  backgroundFile: File | null;
}
