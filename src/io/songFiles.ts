/**
 * Load a song from user-provided files (a dropped folder or a folder picker).
 * Browser-only (File API); kept out of the pure engine. Finds the simfile,
 * parses it, locates the referenced audio + banner, and reads the audio bytes.
 */

import { parseSimfile } from '../parse/loader';
import type { Song } from '../song/song';

export interface LoadedSong {
  song: Song;
  /** Encoded audio bytes to decode/play, or null if none was found. */
  encodedAudio: ArrayBuffer | null;
  audioName: string | null;
  /** Object URL for the banner image, or null. Revoke when done. */
  bannerUrl: string | null;
  /** Simfile file name the song was loaded from. */
  sourceName: string;
  warnings: string[];
}

const AUDIO_EXT = ['.ogg', '.oga', '.mp3', '.wav', '.m4a', '.aac', '.flac', '.opus'];

function basename(name: string): string {
  const n = name.replace(/\\/g, '/');
  return n.slice(n.lastIndexOf('/') + 1).toLowerCase();
}

function ext(name: string): string {
  const b = basename(name);
  const i = b.lastIndexOf('.');
  return i >= 0 ? b.slice(i) : '';
}

async function readAllEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  const out: FileSystemEntry[] = [];
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
    if (batch.length === 0) break;
    out.push(...batch);
  }
  return out;
}

async function entryToFiles(entry: FileSystemEntry): Promise<File[]> {
  if (entry.isFile) {
    const file = await new Promise<File>((res, rej) =>
      (entry as FileSystemFileEntry).file(res, rej),
    );
    return [file];
  }
  if (entry.isDirectory) {
    const entries = await readAllEntries((entry as FileSystemDirectoryEntry).createReader());
    const nested = await Promise.all(entries.map(entryToFiles));
    return nested.flat();
  }
  return [];
}

/** Flatten a drop (files and/or dropped folders) into a flat File list. */
export async function filesFromDataTransfer(dt: DataTransfer): Promise<File[]> {
  const items = dt.items ? Array.from(dt.items) : [];
  const entries = items
    .map((it) => it.webkitGetAsEntry?.() ?? null)
    .filter((e): e is FileSystemEntry => e !== null);
  if (entries.length > 0) {
    const all = await Promise.all(entries.map(entryToFiles));
    return all.flat();
  }
  return dt.files ? Array.from(dt.files) : [];
}

/** Load one song from a set of files (e.g. everything under a song folder). */
export async function loadSongFromFiles(files: File[]): Promise<LoadedSong> {
  const warnings: string[] = [];

  // Simfile: prefer .ssc, then .sma, then .sm.
  const byExt = (e: string) => files.find((f) => ext(f.name) === e);
  const sim = byExt('.ssc') ?? byExt('.sma') ?? byExt('.sm');
  if (!sim) throw new Error('No .ssc or .sm simfile found in the selected files.');

  const text = await sim.text();
  const song = parseSimfile(text, sim.name);
  if (song.charts.length === 0) warnings.push('The simfile has no charts.');

  // Audio: match #MUSIC by basename, else fall back to the first audio file.
  let audioFile: File | undefined;
  if (song.musicFile) {
    const want = basename(song.musicFile);
    audioFile = files.find((f) => basename(f.name) === want);
  }
  if (!audioFile) audioFile = files.find((f) => AUDIO_EXT.includes(ext(f.name)));
  if (!audioFile) warnings.push('No audio file found — a metronome will play instead.');

  const encodedAudio = audioFile ? await audioFile.arrayBuffer() : null;

  // Banner (optional).
  let bannerUrl: string | null = null;
  if (song.bannerFile) {
    const want = basename(song.bannerFile);
    const banner = files.find((f) => basename(f.name) === want);
    if (banner) bannerUrl = URL.createObjectURL(banner);
  }

  return {
    song,
    encodedAudio,
    audioName: audioFile?.name ?? null,
    bannerUrl,
    sourceName: sim.name,
    warnings,
  };
}
