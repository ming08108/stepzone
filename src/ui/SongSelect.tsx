import { type DragEvent, useEffect, useMemo, useRef, useState } from 'react';
import exampleSsc from '../dev/example.ssc?raw';
import { parseSimfile } from '../parse/loader';
import { filesFromDataTransfer, loadSongFromFiles, type LoadedSong } from '../io/songFiles';
import { difficultyToString } from '../song/difficulty';
import type { Song } from '../song/song';
import type { Steps } from '../song/steps';
import type { PlayRequest } from './playRequest';

const CHART_BTN =
  'rounded-lg border border-line bg-white/[0.03] px-3 py-2 text-left hover:border-accent hover:bg-accent/10';

export function SongSelect({
  onPlay,
  onInspect,
  onOptions,
}: {
  onPlay: (r: PlayRequest) => void;
  onInspect: () => void;
  onOptions: () => void;
}) {
  const exampleSong = useMemo(() => parseSimfile(exampleSsc, 'example.ssc'), []);
  const [loaded, setLoaded] = useState<LoadedSong | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const folderRef = useRef<HTMLInputElement>(null);

  // Make the file input pick a whole directory.
  useEffect(() => {
    if (folderRef.current) folderRef.current.webkitdirectory = true;
  }, []);

  // Revoke the previous banner object URL when it changes / unmounts.
  useEffect(() => {
    const url = loaded?.bannerUrl;
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [loaded]);

  const handleFiles = async (files: File[]) => {
    if (files.length === 0) return;
    setError(null);
    setBusy(true);
    try {
      setLoaded(await loadSongFromFiles(files));
    } catch (e) {
      setLoaded(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onDrop = async (e: DragEvent<HTMLElement>) => {
    e.preventDefault();
    setDrag(false);
    await handleFiles(await filesFromDataTransfer(e.dataTransfer));
  };

  const charts = (song: Song, audio: ArrayBuffer | null) => {
    const sorted = [...song.charts].sort(
      (a, b) => a.difficulty - b.difficulty || a.meter - b.meter,
    );
    return (
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
        {sorted.map((chart: Steps, i) => (
          <button
            key={i}
            className={CHART_BTN}
            onClick={() => onPlay({ song, chart, encodedAudio: audio })}
          >
            <div className="text-xs text-muted">{chart.stepsType}</div>
            <div className="font-semibold">
              {difficultyToString(chart.difficulty)}{' '}
              <span className="text-accent">{chart.meter}</span>
            </div>
          </button>
        ))}
      </div>
    );
  };

  return (
    <div className="mx-auto max-w-[900px] px-6 pb-16 pt-8">
      <header className="mb-6 flex items-center justify-between">
        <div className="text-xl font-bold">
          notefield <span className="pill">song select</span>
        </div>
        <div className="flex gap-2">
          <button
            onClick={onOptions}
            className="rounded-lg border border-line px-4 py-2 text-muted hover:border-accent hover:text-ink"
          >
            ⚙ Options
          </button>
          <button
            onClick={onInspect}
            className="rounded-lg border border-line px-4 py-2 text-muted hover:border-accent hover:text-ink"
          >
            Inspect
          </button>
        </div>
      </header>

      <section className="card">
        <h2 className="mb-1 text-sm font-medium uppercase tracking-wider text-muted">
          Bundled example
        </h2>
        <div className="text-lg font-semibold">{exampleSong.title}</div>
        <div className="text-sm text-muted">Demo chart · metronome (no audio file)</div>
        {charts(exampleSong, null)}
      </section>

      <section
        className={`card border-2 border-dashed transition-colors ${
          drag ? 'border-accent bg-accent/5' : 'border-line'
        }`}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={onDrop}
      >
        <h2 className="mb-1 text-sm font-medium uppercase tracking-wider text-muted">
          Load a song
        </h2>
        <p className="text-muted">
          Drop a StepMania song <strong>folder</strong> here (a <code>.sm</code>/<code>.ssc</code>{' '}
          plus its audio), or:
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            className="cursor-pointer rounded-xl bg-accent px-6 py-2 text-base font-bold text-night hover:brightness-110"
            onClick={() => folderRef.current?.click()}
          >
            Choose folder…
          </button>
          {busy && <span className="text-muted">Loading…</span>}
          {error && <span className="text-[#ff6b6b]">{error}</span>}
        </div>
        <input
          ref={folderRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => handleFiles(Array.from(e.target.files ?? []))}
        />
      </section>

      {loaded && (
        <section className="card">
          <div className="flex items-start gap-4">
            {loaded.bannerUrl && (
              <img src={loaded.bannerUrl} alt="" className="h-16 w-40 rounded-md object-cover" />
            )}
            <div className="min-w-0">
              <div className="truncate text-lg font-semibold">
                {loaded.song.title || loaded.sourceName}
              </div>
              <div className="truncate text-sm text-muted">
                {loaded.song.artist || '—'}
                {loaded.audioName ? ` · ♪ ${loaded.audioName}` : ' · no audio (metronome)'}
              </div>
            </div>
          </div>
          {loaded.warnings.length > 0 && (
            <ul className="mt-2 text-sm text-[#e6b04b]">
              {loaded.warnings.map((w, i) => (
                <li key={i}>• {w}</li>
              ))}
            </ul>
          )}
          {loaded.song.charts.length > 0 ? (
            charts(loaded.song, loaded.encodedAudio)
          ) : (
            <p className="mt-3 text-muted">No charts in this simfile.</p>
          )}
        </section>
      )}
    </div>
  );
}
