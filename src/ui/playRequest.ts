import type { PracticeSection } from '../game/playOptions';
import type { LibraryEntry } from '../io/songFiles';
import type { VersusChartMeta } from '../net/versus';
import type { RoomPeer } from '../net/roomPeer';
import type { Song } from '../song/song';
import type { Steps } from '../song/steps';

/** One rival in the current race (their pick pinned by their ready frame). */
export interface RoomOpponent {
  id: number;
  name: string;
  pick: VersusChartMeta;
  /** Their pick resolved in the LOCAL song copy — the seam for rendering a
   *  rival's playfield; null when that exact revision isn't local (degrade). */
  chart: Steps | null;
}

/** A live room race riding along with the play (docs/VERSUS.md). The room
 *  itself is global state (roomStore) and OUTLIVES the play — Play drives
 *  loaded -> go -> streams -> finish over it and detaches on exit; nothing
 *  here is torn down when the play view goes away. */
export interface RoomPlayInfo {
  room: RoomPeer;
  /** Room-locked music rate — overrides the local setting for this play. */
  musicRate: number;
  isHost: boolean;
  opponents: RoomOpponent[];
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
  /** The library entry this play came from — lets a room host serve the
   *  song's original files to a rival who lacks it (docs/VERSUS.md). */
  entry?: LibraryEntry;
  /** Live room race riding along with this play. */
  versus?: RoomPlayInfo;
}
