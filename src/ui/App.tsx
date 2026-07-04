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

/**
 * Milestone-1 dev inspector: parse the bundled example chart in the browser and
 * show what the engine extracted. This is temporary scaffolding — the playable
 * note field (docs 7/8/9) replaces it in the next milestone.
 */

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

interface FlatNote {
  track: number;
  row: number;
  beat: number;
  seconds: number;
  note: TapNote;
}

export function App() {
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
    <div className="app">
      <header>
        <h1>
          notefield <span className="tag">engine inspector · milestone 1</span>
        </h1>
        <p className="sub">
          Framework-free TypeScript engine parsing a StepMania simfile in the browser. Playable note
          field is next.
        </p>
      </header>

      <section className="card">
        <h2>Song</h2>
        <dl>
          <div>
            <dt>Title</dt>
            <dd>{song.title || '—'}</dd>
          </div>
          <div>
            <dt>Artist</dt>
            <dd>{song.artist || '—'}</dd>
          </div>
          <div>
            <dt>Music</dt>
            <dd>{song.musicFile || '—'}</dd>
          </div>
          <div>
            <dt>Offset</dt>
            <dd>{song.timing.offsetSeconds.toFixed(3)} s</dd>
          </div>
          <div>
            <dt>BPMs</dt>
            <dd>
              {song.timing.bpms.map((b) => `${noteRowToBeat(b.row)}=${b.bps * 60}`).join(', ')}
            </dd>
          </div>
        </dl>
      </section>

      {chart && (
        <section className="card">
          <h2>
            Chart <span className="tag">{chart.stepsType}</span>
          </h2>
          <dl>
            <div>
              <dt>Difficulty</dt>
              <dd>
                {difficultyToString(chart.difficulty)} ({chart.meter})
              </dd>
            </div>
            <div>
              <dt>Columns</dt>
              <dd>{chart.numTracks}</dd>
            </div>
            <div>
              <dt>Counts</dt>
              <dd>
                {(() => {
                  const c = chart.getNoteData().computeCounts();
                  return `${c.taps} taps · ${c.holdHeads} holds · ${c.rollHeads} rolls · ${c.mines} mines`;
                })()}
              </dd>
            </div>
          </dl>
        </section>
      )}

      <div className="columns">
        <section className="card">
          <h2>Notes (beat → time)</h2>
          <table>
            <thead>
              <tr>
                <th>col</th>
                <th>beat</th>
                <th>time</th>
                <th>type</th>
                <th>dur</th>
              </tr>
            </thead>
            <tbody>
              {notes.map((n, i) => (
                <tr key={i}>
                  <td>{n.track}</td>
                  <td>
                    <span
                      className="swatch"
                      style={{ background: QUANT_COLOR[getNoteType(n.row)] }}
                    />
                    {n.beat}
                  </td>
                  <td>{n.seconds.toFixed(3)}s</td>
                  <td>{NOTE_TYPE_NAME[n.note.type]}</td>
                  <td>{n.note.durationRows ? `${noteRowToBeat(n.note.durationRows)}b` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="card">
          <h2>Timing table</h2>
          <table>
            <thead>
              <tr>
                <th>beat</th>
                <th>audio time</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {timingTable.map((r) => (
                <tr key={r.beat}>
                  <td>
                    <span
                      className="swatch"
                      style={{ background: QUANT_COLOR[beatToNoteType(r.beat)] }}
                    />
                    {r.beat}
                  </td>
                  <td>{r.seconds.toFixed(3)}s</td>
                  <td className="muted">{r.beat === 2 ? '← 0.5s stop here' : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>

      <footer>
        <code>src/dev/example.ssc</code> · engine verified by <code>npm test</code> (29 tests)
      </footer>
    </div>
  );
}
