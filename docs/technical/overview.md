---
covers: [server.js, index.html, schema.sql, package.json, .env.example]
---

# How Marrow fits together

```
browser                         server.js (Node 22.13+)             Supabase
index.html  ── /api/* (JSON) ──▶ checks host, origin, session ──▶  Auth      (logins)
(the whole app,                  proxies AI calls               ──▶  Postgres  (library, RLS per user)
 one ES module)                  fetches pasted links           ──▶  Storage   (PDFs, bucket "files")
                                 runs Whisper / yt-dlp locally
                                        │
                                        ▼
                              AI providers (OpenAI-format /chat/completions), OpenAlex, YouTube
```

- **[Frontend](frontend/)**: `index.html` is the whole app. It's plain HTML, CSS and one ES module, with no build step. Libraries (PDF.js, Editor.js, Cytoscape, KaTeX, DOMPurify, Readability) load from CDNs.
- **[Backend](backend/)**: `server.js` uses only Node's built-in modules and has no npm dependencies. It serves `index.html`, keeps the login session in cookies, and talks to Supabase *as the logged-in user*, so row-level security keeps each user's data apart.
- **[Database](database/schema.md)**: `schema.sql` is pasted once into Supabase's SQL editor. It creates the tables, the row-level-security policies, the `files` storage bucket, and the `put_item`, `library` and `search_parts` functions.
- **[Testing](testing/tests-and-ci.md)**: three scripts (`test.js`, `test-frontend.js`, `test-ui.mjs`) and a GitHub Actions workflow.

## Running it

```bash
cp .env.example .env      # fill in SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, APP_SECRET
npm start                 # node --env-file=.env server.js  ->  http://localhost:5173
```

`server.js` refuses to start without `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` and a 64-hex-character `APP_SECRET`.

| Variable | Default | Purpose |
|---|---|---|
| `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` | required | The Supabase project. Use the publishable key, never the service-role key. |
| `APP_SECRET` | required | AES-256-GCM key that encrypts each user's AI keys. If you lose it, users have to re-enter their keys. |
| `PORT` | `5173` | |
| `HOST` | `127.0.0.1` | Set to `0.0.0.0` to reach the server from other devices. |
| `ALLOWED_HOSTS` | none | Extra host names the server answers to, besides `localhost` and IP addresses. |
| `DATA_DIR` | `./data` | Only Whisper's and yt-dlp's downloads live here now. |
| `MODELS`, `VISION_MODELS` | built-in free OpenRouter list | Default model order for a user who hasn't set one. |

## Data flow for one source

1. The browser adds the source (`create()` in `index.html`): it extracts the text into numbered *parts*, then sends `PUT /api/items/:id`, and for PDFs also `PUT /api/files/:id`.
2. The server calls the `put_item` database function, which saves the item, its cards and notes, and its parts in one transaction.
3. The browser asks `POST /api/ai` for the Brief. The server tries the user's models in order and returns the first answer.
4. When the app starts, `GET /api/library` calls the `library` function, which returns every item, page, activity entry, feed and project in one round trip. A source's text is loaded only when you open it (`GET /api/items/:id/parts`).
