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
}

const STORAGE_KEY = 'notefield.net.identity.v1';
const DEFAULT_NAME = 'PLAYER';

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

function sanitize(v: unknown): NetIdentity | null {
  if (!isRecord(v)) return null;
  if (typeof v.playerId !== 'string' || v.playerId.length === 0) return null;
  if (typeof v.secret !== 'string' || v.secret.length === 0) return null;
  const name = typeof v.name === 'string' && v.name.length > 0 ? v.name : DEFAULT_NAME;
  return { playerId: v.playerId, secret: v.secret, name };
}

/** The persistent identity, created on first use. */
export function getIdentity(): NetIdentity {
  if (cached) return cached;
  const stored = sanitize(loadJson<unknown>(STORAGE_KEY));
  if (stored) {
    cached = stored;
    return stored;
  }
  const fresh: NetIdentity = { playerId: randomId(), secret: randomId(), name: DEFAULT_NAME };
  saveJson(STORAGE_KEY, fresh);
  cached = fresh;
  return fresh;
}

/** Rename (trimmed, capped to the protocol limit); propagates on next submit. */
export function setPlayerName(name: string): NetIdentity {
  const id = getIdentity();
  const trimmed = name.trim().slice(0, 24);
  cached = { ...id, name: trimmed.length > 0 ? trimmed : DEFAULT_NAME };
  saveJson(STORAGE_KEY, cached);
  return cached;
}
