/**
 * Parser for ITGmania V1 replay files (Save/Replays/replay#####.xml), reverse-
 * engineered from the source serialization:
 *   NoteData::CreateNode  -> <NoteData> with one <TapNote Track Row> per note
 *   TapNote::CreateNode   -> child <TapNoteResult> (+ an empty <HoldNoteResult>)
 *   TapNoteResult::CreateNode -> attrs TapNoteScore (short name) + TapNoteOffset
 * Offset is in seconds with ITGmania's sign: POSITIVE = early (noteTime -
 * pressTime), the opposite of our judge's (pressTime - noteTime). So a press is
 * reconstructed as `noteTime - offset`. Only the tap result is stored — hold
 * Held/LetGo is not in a V1 replay (HoldNoteResult serializes empty).
 */
import { TapNoteScore } from '../../src/notes/noteTypes';

export interface ReplayNote {
  track: number;
  row: number;
  tns: TapNoteScore;
  /** Seconds, ITGmania convention (positive = early). */
  offset: number;
}

const TNS_FROM_NAME: Record<string, TapNoteScore> = {
  None: TapNoteScore.None,
  HitMine: TapNoteScore.HitMine,
  AvoidMine: TapNoteScore.AvoidMine,
  CheckpointMiss: TapNoteScore.Miss,
  Miss: TapNoteScore.Miss,
  W5: TapNoteScore.W5,
  W4: TapNoteScore.W4,
  W3: TapNoteScore.W3,
  W2: TapNoteScore.W2,
  W1: TapNoteScore.W1,
  CheckpointHit: TapNoteScore.W1,
  // legacy aliases from StepMania's conversion_map
  Boo: TapNoteScore.W5,
  Good: TapNoteScore.W4,
  Great: TapNoteScore.W3,
  Perfect: TapNoteScore.W2,
  Marvelous: TapNoteScore.W1,
};

function attr(s: string, name: string): string | null {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(s);
  return m ? m[1] : null;
}

/** Extract every judged note (track, row, ITG judgment, ITG offset). */
export function parseReplayXml(xml: string): ReplayNote[] {
  const notes: ReplayNote[] = [];
  const re = /<TapNote\b([^>]*)>([\s\S]*?)<\/TapNote>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const track = Number(attr(m[1], 'Track'));
    const row = Number(attr(m[1], 'Row'));
    const res = /<TapNoteResult\b([^>]*?)\/?>/.exec(m[2]);
    if (!res || !Number.isFinite(track) || !Number.isFinite(row)) continue;
    const rawTns = (attr(res[1], 'TapNoteScore') ?? 'None').replace(/^TapNoteScore_/, '');
    notes.push({
      track,
      row,
      tns: TNS_FROM_NAME[rawTns] ?? TapNoteScore.None,
      offset: Number(attr(res[1], 'TapNoteOffset') ?? '0'),
    });
  }
  return notes;
}
