import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cachedFetch,
  ensureRemoteLoaded,
  isCached,
  loadRemoteLibrary,
} from '../src/io/remoteLibrary';
import type { RemoteCatalog, RemoteSong } from '../src/io/catalog';

// --- Fakes -------------------------------------------------------------------

/** Map-backed stand-in for a Cache Storage `Cache` (match/put by URL string). */
class FakeCache {
  readonly store = new Map<string, Response>();
  async match(url: RequestInfo | URL): Promise<Response | undefined> {
    return this.store.get(String(url))?.clone();
  }
  async put(url: RequestInfo | URL, res: Response): Promise<void> {
    this.store.set(String(url), res.clone());
  }
}

class FakeCacheStorage {
  readonly opened = new Map<string, FakeCache>();
  async open(name: string): Promise<FakeCache> {
    let c = this.opened.get(name);
    if (!c) {
      c = new FakeCache();
      this.opened.set(name, c);
    }
    return c;
  }
}

let fetchCalls: string[];

/** Stub `fetch` with a URL→response-factory routing table; unrouted URLs 404. */
function stubFetch(routes: Record<string, () => Response>): void {
  vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
    const url = String(input);
    fetchCalls.push(url);
    const make = routes[url];
    return Promise.resolve(make ? make() : new Response('not found', { status: 404 }));
  });
}

/** Stub `fetch` to reject every request, as when the network is unreachable. */
function stubOffline(): void {
  vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
    fetchCalls.push(String(input));
    return Promise.reject(new TypeError('network down'));
  });
}

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

// --- Fixtures ----------------------------------------------------------------

const CATALOG_URL = 'https://songs.example/pack/catalog.json';
const SM_URL = 'https://songs.example/pack/Butterfly/Butterfly.sm';

const BUTTERFLY: RemoteSong = {
  dir: 'Butterfly',
  sm: 'Butterfly.sm',
  banner: 'Butterfly.png',
  title: 'Butterfly',
  artist: 'smile.dk',
};

const catalog = (songs: RemoteSong[]): RemoteCatalog => ({ name: 'Test Pack', songs });

/** Minimal valid .sm: metadata + one dance-single chart (6-field #NOTES). */
const SM_TEXT = [
  '#TITLE:Butterfly;',
  '#ARTIST:smile.dk;',
  '#MUSIC:Butterfly.ogg;',
  '#OFFSET:0.000;',
  '#BPMS:0.000=135.000;',
  '#NOTES:',
  '     dance-single:',
  '     :',
  '     Medium:',
  '     5:',
  '     :',
  '0000',
  '1000',
  '0000',
  '0001',
  ';',
].join('\n');

// --- Tests -------------------------------------------------------------------

describe('remoteLibrary', () => {
  beforeEach(() => {
    fetchCalls = [];
    vi.stubGlobal('caches', new FakeCacheStorage());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resolves song dir / banner / simfile URLs relative to the catalog URL', async () => {
    stubFetch({
      [CATALOG_URL]: () => json(catalog([BUTTERFLY, { sm: 'Loose.sm', title: 'Loose' }])),
    });
    const { entries, name, warnings } = await loadRemoteLibrary(CATALOG_URL);
    expect(name).toBe('Test Pack');
    expect(warnings).toEqual([]);
    expect(entries).toHaveLength(2);
    expect(entries[0].remoteDir).toBe('https://songs.example/pack/Butterfly/');
    expect(entries[0].remoteSm).toBe('Butterfly.sm');
    expect(entries[0].bannerUrl).toBe('https://songs.example/pack/Butterfly/Butterfly.png');
    expect(entries[0].song.title).toBe('Butterfly');
    expect(entries[0].song.artist).toBe('smile.dk');
    // No `dir`: the song lives beside the catalog itself.
    expect(entries[1].remoteDir).toBe('https://songs.example/pack/');
    expect(entries[1].bannerUrl).toBeNull();
  });

  it('fetches the catalog network-first, so server-side additions appear', async () => {
    stubFetch({ [CATALOG_URL]: () => json(catalog([BUTTERFLY])) });
    const first = await loadRemoteLibrary(CATALOG_URL);
    expect(first.entries).toHaveLength(1);
    expect(await isCached(CATALOG_URL)).toBe(true);

    // The server gains a song; a returning user must see it despite the cache.
    stubFetch({
      [CATALOG_URL]: () => json(catalog([BUTTERFLY, { dir: 'Loose', sm: 'Loose.sm' }])),
    });
    const second = await loadRemoteLibrary(CATALOG_URL);
    expect(second.entries).toHaveLength(2);
    expect(fetchCalls.filter((u) => u === CATALOG_URL)).toHaveLength(2);
  });

  it('serves the catalog from cache when the network is unreachable', async () => {
    stubFetch({ [CATALOG_URL]: () => json(catalog([BUTTERFLY])) });
    await loadRemoteLibrary(CATALOG_URL); // populates the cache

    stubOffline();
    const { entries } = await loadRemoteLibrary(CATALOG_URL);
    expect(entries).toHaveLength(1);
    expect(entries[0].song.title).toBe('Butterfly');
  });

  it('rejects when offline with nothing cached', async () => {
    stubOffline();
    await expect(loadRemoteLibrary(CATALOG_URL)).rejects.toThrow('network down');
  });

  it('serves per-song assets cache-first (one network fetch, then cached)', async () => {
    stubFetch({ [SM_URL]: () => new Response(SM_TEXT, { status: 200 }) });
    const first = await cachedFetch(SM_URL);
    expect(await first.text()).toBe(SM_TEXT);
    expect(fetchCalls).toEqual([SM_URL]);

    const second = await cachedFetch(SM_URL);
    expect(await second.text()).toBe(SM_TEXT);
    expect(fetchCalls).toEqual([SM_URL]); // no second network hit
    expect(await isCached(SM_URL)).toBe(true);
  });

  it('ensureRemoteLoaded parses once and reuses entry.song on repeat calls', async () => {
    stubFetch({
      [CATALOG_URL]: () => json(catalog([BUTTERFLY])),
      [SM_URL]: () => new Response(SM_TEXT, { status: 200 }),
    });
    const { entries } = await loadRemoteLibrary(CATALOG_URL);
    const entry = entries[0];
    expect(entry.song.charts).toHaveLength(0); // placeholder until loaded

    const first = await ensureRemoteLoaded(entry);
    expect(first.charts).toHaveLength(1);
    expect(first.charts[0].stepsType).toBe('dance-single');
    expect(first.musicFile).toBe('Butterfly.ogg');
    expect(entry.song).toBe(first); // parsed song written back onto the entry

    const callsAfterFirst = fetchCalls.length;
    const second = await ensureRemoteLoaded(entry);
    expect(second).toBe(first); // same instance: no re-fetch, no re-parse
    expect(fetchCalls).toHaveLength(callsAfterFirst);
  });
});
