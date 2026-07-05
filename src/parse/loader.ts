/** Dispatch to the right simfile parser by extension or content sniff. */

import { Song } from '../song/song';
import { parseSm } from './sm';
import { parseSsc } from './ssc';

export type SimfileFormat = 'ssc' | 'sm';

export function detectFormat(text: string, filename?: string): SimfileFormat {
  const ext = filename?.toLowerCase().split('.').pop();
  if (ext === 'ssc') return 'ssc';
  if (ext === 'sm') return 'sm';
  // Content sniff: `.ssc` is the only format with `#NOTEDATA`.
  return /#NOTEDATA\b/i.test(text) ? 'ssc' : 'sm';
}

/**
 * Parse a simfile's text into a Song. `filename` is optional but improves
 * detection. Parse warnings are appended to the optional `warnings` array
 * (surfacing them in the UI is deferred; see also Steps.noteWarnings).
 */
export function parseSimfile(text: string, filename?: string, warnings: string[] = []): Song {
  return detectFormat(text, filename) === 'ssc'
    ? parseSsc(text, warnings)
    : parseSm(text, warnings);
}
