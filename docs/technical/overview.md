---
covers: [server.js, local.js, index.html, schema.sql, package.json, .env.example]
---

# How Marrow fits together

```
browser                         server.js (Node 22.13+)                  local.js
index.html  ── /api/* (JSON) ──▶ checks host and origin ──▶ SQLite (marrow.db: library, FTS, vectors)
(the whole app,                  proxies AI calls                    <Project>/ (PDFs, Markdown copies)
 one ES module)                  fetches pasted links                in the folder the reader chose
                                 runs Whisper / yt-dlp locally
                                         │
                                         ▼
                               AI providers (OpenAI-format /chat/completions), OpenAlex, YouTube
```

- **[Frontend](frontend/)**: `index.html` is the whole app. It's plain HTML, CSS and one ES module, with no build step. Libraries (PDF.js, Editor.js, Cytoscape, KaTeX, DOMPurify, Readability) load from CDNs.
- **[Backend](backend/)**: `server.js` uses only Node's built-in modules and has no npm dependencies. It serves `index.html`, proxies AI calls with your keys, and fetches pasted links and captions.
- **[Database](database/schema.md)**: `schema.sql` is the SQLite schema; `local.js` creates it on first run in the library folder the reader chose (or `DATA_DIR`). One library, no accounts. Full-text search uses FTS5, meaning-based search uses a cosine function registered on the database.
- **[Testing](testing/tests-and-ci.md)**: three scripts (`test.js`, `test-frontend.js`, `test-ui.mjs`) and a GitHub Actions workflow.

## Running it

```bash
cp .env.example .env      # fill in APP_SECRET
npm start                 # node --env-file=.env server.js  ->  http://localhost:5173
```

`server.js` refuses to start without a 64-hex-character `APP_SECRET`. There is no sign-in screen.

| Variable | Default | Purpose |
|---|---|---|
| `APP_SECRET` | required | AES-256-GCM key that encrypts your AI keys. If you lose it, you have to re-enter them. |
| `PORT` | `5173` | |
| `HOST` | `127.0.0.1` | Set to `0.0.0.0` to reach the server from other devices. |
| `ALLOWED_HOSTS` | none | Extra host names the server answers to, besides `localhost` and IP addresses. |
| `DATA_DIR` | none: chosen on first launch, kept in `~/.marrow.json` | Fixes the library folder (Settings can no longer move it). Whisper and yt-dlp downloads live in `DATA_DIR/whisper`, or `./data/whisper` without it. |
| `MARROW_CONFIG`, `MARROW_LEGACY` | `~/.marrow.json`, `./data` | Where the chosen folder is remembered, and where an older library is looked for. Tests point both at temp folders. |

## Data flow for one source

1. The browser adds the source (`create()` in `index.html`): it extracts the text into numbered *parts*, then sends `PUT /api/items/:id`, and for PDFs also `PUT /api/files/:id`.
2. The server calls `local.putItem()`, which saves the item, its cards and notes, and its parts in one transaction.
3. The browser asks `POST /api/ai` for the Brief. The server tries your models in order and returns the first answer.
4. When the app starts, `GET /api/library` calls `local.library()`, which returns every item, page, activity entry, feed and project in one round trip. A source's text is loaded only when you open it (`GET /api/items/:id/parts`).

## Moving data in

`npm run migrate -- you@example.com` reads one Supabase account through the service-role key and writes it into the local store. See the README.
