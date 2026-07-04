/**
 * The song-server catalog contract — shared by the server
 * (`scripts/song-server.ts`) and the client (`io/remoteLibrary.ts`) so the two
 * can't drift. Pure types; no runtime code, no browser/node deps.
 */

export interface RemoteSong {
  /** Song folder path, relative to the catalog URL (omit if beside the catalog). */
  dir?: string;
  /** Simfile filename within `dir`. */
  sm: string;
  /** Banner filename within `dir` (optional). */
  banner?: string;
  /** Pre-read metadata so the client can render rows without fetching each simfile. */
  title?: string;
  artist?: string;
  /** Top-level pack folder, for grouping/display. */
  pack?: string;
}

export interface RemoteCatalog {
  name?: string;
  count?: number;
  songs: RemoteSong[];
}
