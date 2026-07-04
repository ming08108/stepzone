import { useMemo } from 'react';
import exampleSsc from '../dev/example.ssc?raw';
import { parseSimfile } from '../parse/loader';
import { difficultyToString } from '../song/difficulty';
import {
  NoteType,
  TapNoteType,
  beatToNoteType,
  getNoteType,
  noteRowToBeat,
  type TapNote,
} from '../notes/noteTypes';

/** Engine inspector: parses the bundled example and shows what was extracted. */

const NOTE_TYPE_NAME: Record<TapNoteType, string> = {
  [TapNoteType.Empty]: 'empty',
  [TapNoteType.Tap]: 'tap',
  [TapNoteType.HoldHead]: 'hold',
  [TapNoteType.HoldTail]: 'tail',
  [TapNoteType.Mine]: 'mine',
  [TapNoteType.Lift]: 'lift',
  [TapNoteType.Attack]: 'attack',
  [TapNoteType.AutoKeysound]: 'keysound',
  [TapNoteType.Fake]: 'fake',
};

const QUANT_COLOR: Record<NoteType, string> = {
  [NoteType.N4TH]: '#e64b4b',
  [NoteType.N8TH]: '#4b7be6',
  [NoteType.N12TH]: '#9b4be6',
  [NoteType.N16TH]: '#e6cf4b',
  [NoteType.N24TH]: '#e64bb4',
  [NoteType.N32ND]: '#e6944b',
  [NoteType.N48TH]: '#4be6c4',
  [NoteType.N64TH]: '#9ce64b',
  [NoteType.N192ND]: '#8a8a8a',
};

const TH = 'border-b border-line px-2 py-1.5 text-left text-xs font-medium uppercase text-muted';
const TD = 'border-b border-line px-2 py-1.5 text-left tabular-nums';
const DT = 'text-xs text-muted';
const DD = 'mt-0.5 tabular-nums';
const SWATCH = 'mr-2 inline-block h-[0.7em] w-[0.7em] rounded-[2px] align-baseline';

interface FlatNote {
  track: number;
  row: number;
  beat: number;
  seconds: number;
  note: TapNote;
}

export function Inspector() {
  const { song, chart, notes, timingTable } = useMemo(() => {
    const song = parseSimfile(exampleSsc, 'example.ssc');
    const chart = song.charts[0];
    const nd = chart?.getNoteData();
    const timing = chart ? chart.getTimingData(song.timing) : song.timing;

    const notes: FlatNote[] = [];
    if (nd) {
      for (let track = 0; track < nd.numTracks; track++) {
        for (const { row, note } of nd.getTrack(track)) {
          const beat = noteRowToBeat(row);
          notes.push({ track, row, beat, seconds: timing.getElapsedTimeFromBeat(beat), note });
        }
      }
    }
    notes.sort((a, b) => a.row - b.row || a.track - b.track);

    const lastBeat = nd ? Math.ceil(noteRowToBeat(nd.lastRow())) : 0;
    const timingTable = Array.from({ length: lastBeat + 1 }, (_, beat) => ({
      beat,
      seconds: timing.getElapsedTimeFromBeat(beat),
    }));

    return { song, chart, notes, timingTable };
  }, []);

  return (
    <>
      <section className="card">
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wider text-muted">Song</h2>
        <dl className="m-0 grid gap-x-6 gap-y-3 [grid-template-columns:repeat(auto-fit,minmax(180px,1fr))]">
          <div>
            <dt className={DT}>Title</dt>
            <dd className={DD}>{song.title || '—'}</dd>
          </div>
          <div>
            <dt className={DT}>Artist</dt>
            <dd className={DD}>{song.artist || '—'}</dd>
          </div>
          <div>
            <dt className={DT}>Music</dt>
            <dd className={DD}>{song.musicFile || '—'}</dd>
          </div>
          <div>
            <dt className={DT}>Offset</dt>
            <dd className={DD}>{song.timing.offsetSeconds.toFixed(3)} s</dd>
          </div>
          <div>
            <dt className={DT}>BPMs</dt>
            <dd className={DD}>
              {song.timing.bpms.map((b) => `${noteRowToBeat(b.row)}=${b.bps * 60}`).join(', ')}
            </dd>
          </div>
        </dl>
      </section>

      {chart && (
        <section className="card">
          <h2 className="mb-3 text-sm font-medium uppercase tracking-wider text-muted">
            Chart <span className="pill normal-case">{chart.stepsType}</span>
          </h2>
          <dl className="m-0 grid gap-x-6 gap-y-3 [grid-template-columns:repeat(auto-fit,minmax(180px,1fr))]">
            <div>
              <dt className={DT}>Difficulty</dt>
              <dd className={DD}>
                {difficultyToString(chart.difficulty)} ({chart.meter})
              </dd>
            </div>
            <div>
              <dt className={DT}>Columns</dt>
              <dd className={DD}>{chart.numTracks}</dd>
            </div>
            <div>
              <dt className={DT}>Counts</dt>
              <dd className={DD}>
                {(() => {
                  const c = chart.getNoteData().computeCounts();
                  return `${c.taps} taps · ${c.holdHeads} holds · ${c.rollHeads} rolls · ${c.mines} mines`;
                })()}
              </dd>
            </div>
          </dl>
        </section>
      )}

      <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
        <section className="card">
          <h2 className="mb-3 text-sm font-medium uppercase tracking-wider text-muted">
            Notes (beat → time)
          </h2>
          <table className="w-full border-collapse text-sm tabular-nums">
            <thead>
              <tr>
                <th className={TH}>col</th>
                <th className={TH}>beat</th>
                <th className={TH}>time</th>
                <th className={TH}>type</th>
                <th className={TH}>dur</th>
              </tr>
            </thead>
            <tbody>
              {notes.map((n, i) => (
                <tr key={i}>
                  <td className={TD}>{n.track}</td>
                  <td className={TD}>
                    <span
                      className={SWATCH}
                      style={{ background: QUANT_COLOR[getNoteType(n.row)] }}
                    />
                    {n.beat}
                  </td>
                  <td className={TD}>{n.seconds.toFixed(3)}s</td>
                  <td className={TD}>{NOTE_TYPE_NAME[n.note.type]}</td>
                  <td className={TD}>
                    {n.note.durationRows ? `${noteRowToBeat(n.note.durationRows)}b` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="card">
          <h2 className="mb-3 text-sm font-medium uppercase tracking-wider text-muted">
            Timing table
          </h2>
          <table className="w-full border-collapse text-sm tabular-nums">
            <thead>
              <tr>
                <th className={TH}>beat</th>
                <th className={TH}>audio time</th>
                <th className={TH} />
              </tr>
            </thead>
            <tbody>
              {timingTable.map((r) => (
                <tr key={r.beat}>
                  <td className={TD}>
                    <span
                      className={SWATCH}
                      style={{ background: QUANT_COLOR[beatToNoteType(r.beat)] }}
                    />
                    {r.beat}
                  </td>
                  <td className={TD}>{r.seconds.toFixed(3)}s</td>
                  <td className={`${TD} text-muted`}>{r.beat === 2 ? '← 0.5s stop here' : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </>
  );
}
