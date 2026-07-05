# Songs library

## Your local library loads automatically

The dev/preview server serves your Songs library at `/songs`, and Stepzone
**auto-loads it on startup — nothing to paste, no separate process, no CORS.**
By default it serves `C:/Games/ITGmania/Songs`; point it elsewhere with the
`SONGS_DIR` env var:

```
SONGS_DIR="D:/Songs" npm run dev
```

The catalog embeds each song's title/artist, so even a multi-thousand-song
library lists instantly; simfiles/audio/backgrounds load only when you open or
play a song, and every fetched file is cached (`notefield-songs-v1` Cache
Storage) for offline/instant replay.

You can also **drop a folder/pack** onto the page, or add an **external** server
in the box on the song-select screen (see below).

## Adding an external server (optional)

To browse a library hosted elsewhere, host a folder of songs plus a small
`catalog.json` over HTTP and paste its URL into the "add another song server"
box. Same-origin isn't required, but a different origin must send
`Access-Control-Allow-Origin` (CORS) headers.

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
