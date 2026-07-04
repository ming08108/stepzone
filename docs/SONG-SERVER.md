# Loading songs from a server

notefield can load songs from any static HTTP server and **caches them locally**
(Cache Storage API), so after the first play a song works offline and loads
instantly. Local folder loading still works exactly as before — this is additive.

## How it works

1. You host a folder of songs plus a small `catalog.json` over HTTP.
2. In notefield, paste the catalog URL into the **"Load from server"** box on the
   song-select screen (or it auto-loads the last URL you used).
3. Only the simfiles + banners are fetched up front (to build the table). A
   song's audio and background are fetched the first time you play it.
4. Every fetched file is stored in the `notefield-songs-v1` cache. Subsequent
   loads/plays read from the cache — no network needed.

## Catalog format

`catalog.json` (at any URL). `dir`, `sm`, and `banner` resolve relative to the
catalog's own URL:

```json
{
  "name": "DDR 1st Mix",
  "songs": [
    { "dir": "Butterfly", "sm": "Butterfly.sm", "banner": "Butterfly.png" },
    { "dir": "PARANOiA", "sm": "PARANOiA.sm" }
  ]
}
```

- `dir` — song folder, relative to the catalog (omit if the simfile sits next to
  the catalog).
- `sm` — the simfile filename (`.sm`/`.ssc`/`.sma`).
- `banner` — optional; if omitted, the `#BANNER` from the simfile is used.
- The audio and background come from the simfile's `#MUSIC` / `#BACKGROUND`
  filenames, resolved inside `dir`.

## Running a server (easiest)

A ready-made server (TypeScript, run directly by Node ≥ 22.6 — no build step)
scans a Songs library (packs of song folders, nested), serves it with CORS +
HTTP Range, and generates the catalog dynamically:

```
npm run song-server                       # serves C:/Games/ITGmania/Songs on :8760
npm run song-server -- "D:/Songs" 9000    # custom dir + port
```

It prints the URL to paste (`http://localhost:8760/catalog.json`). The catalog
includes each song's title/artist so a multi-thousand-song library lists
instantly; simfiles/audio/backgrounds are fetched only when you open or play a
song.

## Static hosting (no Node at serve time)

To host on GitHub Pages / S3 / any static host, pre-generate the catalog:

```
npm run make-catalog -- "/path/to/Songs"
```

writes `catalog.json` into that folder. Then serve the folder statically. If the
host is a **different origin** than the app, it must send
`Access-Control-Allow-Origin` (CORS) headers, or the browser blocks the fetches.

## Notes & limits

- Cache Storage needs a secure context (`https://` or `localhost`).
- Audio/video must be in browser-decodable formats (`.ogg`/`.mp3` audio;
  `.mp4`/`.webm` video). Old `.avi`/`.mpg` backgrounds are skipped.
- There's no cache-eviction UI yet; the browser manages storage pressure. A
  "manage cache / go offline" screen is future work (see ROADMAP).
