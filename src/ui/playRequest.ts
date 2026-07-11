import type { PracticeSection } from '../game/playOptions';
import type { LibraryEntry } from '../io/songFiles';
import type { VersusChartMeta } from '../net/versus';
import type { VersusMatch } from '../net/versusMatch';
import type { VersusConnection } from '../net/versusSignal';
import type { Song } from '../song/song';
import type { Steps } from '../song/steps';

/** A live P2P match riding along with the play (docs/VERSUS.md). The session
 *  was set up on PLAYER OPTIONS (versusSession store); Play drives
 *  loaded -> go -> snaps -> finish over it. App owns teardown
 *  (abandonVersus) when the play view exits. */
export interface VersusInfo {
  match: VersusMatch;
  connection: VersusConnection;
  opponentName: string;
  /** Room-locked music rate — overrides the local setting for this play. */
  musicRate: number;
  isHost: boolean;
  /** The rival's chart choice, pinned by their ready frame. */
  opponentPick: VersusChartMeta;
  /** Their pick resolved in the LOCAL song copy — the seam for rendering the
   *  rival's playfield; null when that exact revision isn't local (degrade). */
  opponentChart: Steps | null;
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
  /** The library entry this play came from — lets a versus host serve the
   *  song's original files to a rival who lacks it (docs/VERSUS.md). */
  entry?: LibraryEntry;
  /** Live versus match; goes straight to gameplay (no Player Options stop). */
  versus?: VersusInfo;
}
