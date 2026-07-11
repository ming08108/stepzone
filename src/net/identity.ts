/**
 * Anonymous online identity — no accounts. The client invents a random
 * playerId + secret once and persists them; the first score submission claims
 * the id on the server (which stores only a hash of the secret), and every
 * later submission must present the same secret. Losing localStorage means a
 * fresh identity — accepted for M1; real accounts can claim ids later.
 *
 * The display name is user-chosen and travels with every submission (the
 * server updates it on each accepted score, so renames propagate).
 */

import { isRecord, loadJson, saveJson } from '../app/storage';

export interface NetIdentity {
  playerId: string;
  secret: string;
  name: string;
  /** True while the name is the auto-generated one (never customized). Drives
   *  the first-visit prompt; a user-set or imported name clears it. */
  generated?: boolean;
}

const STORAGE_KEY = 'notefield.net.identity.v1';
const DEFAULT_NAME = 'PLAYER';

/** Arcade-themed pieces for a fun, distinctive first-visit name. */
const NAME_ADJ = [
  'Neon',
  'Swift',
  'Hyper',
  'Turbo',
  'Cosmic',
  'Retro',
  'Pixel',
  'Laser',
  'Disco',
  'Volt',
  'Nova',
  'Blaze',
  'Astro',
  'Sonic',
  'Chroma',
  'Vivid',
];
const NAME_NOUN = [
  'Stomper',
  'Dancer',
  'Stepper',
  'Arrow',
  'Groove',
  'Rhythm',
  'Combo',
  'Streak',
  'Freeze',
  'Runner',
  'Ace',
  'Star',
  'Beat',
  'Pulse',
  'Rider',
  'Phantom',
];

let cached: NetIdentity | null = null;

function randomId(): string {
  // crypto.randomUUID needs a secure context; fall back to getRandomValues.
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** A random arcade name like "NeonStomper42" — unique enough for a party. */
function randomName(): string {
  const r = new Uint8Array(3);
  crypto.getRandomValues(r);
  const adj = NAME_ADJ[r[0] % NAME_ADJ.length];
  const noun = NAME_NOUN[r[1] % NAME_NOUN.length];
  return `${adj}${noun}${10 + (r[2] % 90)}`;
}

function sanitize(v: unknown): NetIdentity | null {
  if (!isRecord(v)) return null;
  if (typeof v.playerId !== 'string' || v.playerId.length === 0) return null;
  if (typeof v.secret !== 'string' || v.secret.length === 0) return null;
  const name = typeof v.name === 'string' && v.name.length > 0 ? v.name : DEFAULT_NAME;
  return { playerId: v.playerId, secret: v.secret, name, generated: v.generated === true };
}

/** The persistent identity, created on first use. */
export function getIdentity(): NetIdentity {
  if (cached) return cached;
  const stored = sanitize(loadJson<unknown>(STORAGE_KEY));
  if (stored) {
    cached = stored;
    return stored;
  }
  const fresh: NetIdentity = {
    playerId: randomId(),
    secret: randomId(),
    name: randomName(),
    generated: true,
  };
  saveJson(STORAGE_KEY, fresh);
  cached = fresh;
  return fresh;
}

/** Rename (trimmed, capped to the protocol limit); propagates on next submit. */
export function setPlayerName(name: string): NetIdentity {
  const id = getIdentity();
  const trimmed = name.trim().slice(0, 24);
  // A user-set name is no longer the auto-generated one (empty keeps the current).
  cached = { ...id, name: trimmed.length > 0 ? trimmed : id.name, generated: false };
  saveJson(STORAGE_KEY, cached);
  return cached;
}

const PROMPTED_KEY = 'notefield.net.namePrompted.v1';

/** Ask for a name once, on the first visit, and only while it's the freshly
 *  generated one (a user-set or imported name is never nagged). */
export function shouldPromptForName(): boolean {
  return loadJson<unknown>(PROMPTED_KEY) !== true && getIdentity().generated === true;
}

export function markNamePrompted(): void {
  saveJson(PROMPTED_KEY, true);
}
