/**
 * Pure helpers for matching a versus room's song descriptor against the local
 * library (docs/VERSUS.md): rooms advertise every chart hash of the host's
 * song; the joiner finds their copy by ANY hash match, and either side can
 * resolve the rival's exact pick to a local chart (for labels now, and for
 * rendering the rival's playfield later).
 */
import { chartKey } from '../app/scores';
import type { LibraryEntry } from '../io/songFiles';
import type { VersusChartMeta, VersusSongRef } from '../net/versus';
import type { Song } from '../song/song';
import type { Steps } from '../song/steps';

/** The local copy of a room's song: the first entry whose parsed charts match
 *  ANY advertised hash (lazy catalog entries have no parsed charts and are
 *  skipped — open the pack first, per the documented limitation). Returns the
 *  matching chart too: it doubles as the joiner's default pick. */
export function findSongByAnyHash(
  entries: LibraryEntry[],
  charts: VersusChartMeta[],
): { entry: LibraryEntry; chart: Steps } | null {
  const wanted = new Set(charts.map((c) => c.chartHash));
  for (const entry of entries) {
    for (const chart of entry.song.charts) {
      if (wanted.has(chartKey(entry.song, chart))) return { entry, chart };
    }
  }
  return null;
}

/** Unopened catalog rows whose title matches the room's song. `findSongByAnyHash`
 *  can only match PARSED entries, so a song the user owns but hasn't opened yet
 *  looks missing and would trigger a needless P2P transfer. These candidates are
 *  worth loading (just the title matches, not the whole library) and re-checking
 *  by hash first. Title is the display-full title on both ends. */
export function unopenedTitleMatches(
  entries: LibraryEntry[],
  songRef: VersusSongRef,
): LibraryEntry[] {
  const want = songRef.title.trim().toLowerCase();
  return entries.filter(
    (e) =>
      e.lazyDir != null &&
      e.song.charts.length === 0 &&
      (e.song.displayFullTitle || e.song.title).trim().toLowerCase() === want,
  );
}

/** Resolve one player's pick against a loaded song — null when the local copy
 *  doesn't contain that exact chart revision (callers must degrade). */
export function chartForPick(song: Song, pick: VersusChartMeta): Steps | null {
  for (const chart of song.charts) {
    if (chartKey(song, chart) === pick.chartHash) return chart;
  }
  return null;
}

/** A chart's wire identity (the pick sent to the rival). */
export function pickOf(song: Song, chart: Steps): VersusChartMeta {
  return {
    chartHash: chartKey(song, chart),
    stepsType: chart.stepsType,
    difficulty: chart.difficulty,
    meter: chart.meter,
  };
}
