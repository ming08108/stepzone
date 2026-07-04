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

## Generating a catalog

```
node scripts/make-catalog.mjs "/path/to/Songs/My Pack"
```

writes `catalog.json` into that folder. Then serve the folder with any static
host. If the host is a **different origin** than the app, it must send
`Access-Control-Allow-Origin` (CORS) headers, or the browser will block the
fetches.

## Notes & limits

- Cache Storage needs a secure context (`https://` or `localhost`).
- Audio/video must be in browser-decodable formats (`.ogg`/`.mp3` audio;
  `.mp4`/`.webm` video). Old `.avi`/`.mpg` backgrounds are skipped.
- There's no cache-eviction UI yet; the browser manages storage pressure. A
  "manage cache / go offline" screen is future work (see ROADMAP).
