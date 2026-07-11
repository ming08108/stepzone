import type { PracticeSection } from '../game/playOptions';
import type { VersusMatch } from '../net/versusMatch';
import type { VersusConnection } from '../net/versusSignal';
import type { Song } from '../song/song';
import type { Steps } from '../song/steps';

/** A live P2P match riding along with the play (docs/VERSUS.md). The match
 *  was set up on the versus panel; Play drives loaded -> go -> snaps -> finish
 *  over it. App owns teardown (leave + close) when the play view exits. */
export interface VersusInfo {
  match: VersusMatch;
  connection: VersusConnection;
  opponentName: string;
  /** Room-locked music rate — overrides the local setting for this play. */
  musicRate: number;
  isHost: boolean;
}

/** Everything the Play view needs to run one chart. */
export interface PlayRequest {
  song: Song;
  chart: Steps;
  /** Encoded audio bytes, or null to play the synthesized metronome. */
  encodedAudio: ArrayBuffer | null;
  /** Background image/video File, or null. Play owns its object URL. */
  backgroundFile: File | null;
  /** Practice-loop section (in beats), or null/absent to play the song through. */
  practice?: PracticeSection | null;
  /** Live versus match; goes straight to gameplay (no Player Options stop). */
  versus?: VersusInfo;
}
