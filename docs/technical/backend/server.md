---
covers: [server.js]
---

# Server and API

`server.js` is a single `http.createServer` handler with no framework and no npm dependencies. Every route is an `if` on method and path, in one function. Errors are thrown with `fail(code, message)` and come back as `{ error }` JSON with that status.

## Request checks (every request)

1. **Host.** It must be `localhost`, an IP address, or a name in `ALLOWED_HOSTS`. This blocks DNS rebinding.
2. **Origin.** If an `Origin` header is sent, it must match `Host`.
3. **Cross-site.** `/api/*` refuses `Sec-Fetch-Site: cross-site` or `same-site`, which catches `<img>`/`<script>` GETs that carry no `Origin`.
4. **Login.** Every route except `/`, `/api/login` and `/api/logout` needs a session (`session()`). Otherwise it answers `401 log in`.

## Routes

| Method & path | Does |
|---|---|
| `GET /` | serves `index.html` |
| `POST /api/login`, `POST /api/logout` | see [auth](auth-and-ai.md) |
| `GET /api/me` | the logged-in email |
| `GET /api/library` | everything at start, via the `library()` database function |
| `PUT /api/items/:id` | save a source with its cards, notes and, optionally, `parts` (`put_item`) |
| `GET /api/items/:id/parts` | a source's text |
| `DELETE /api/items/:id` | delete the source and its PDF |
| `PUT` / `GET /api/files/:id` | upload (must start with `%PDF-`, max 150 MB) / download a PDF from Storage |
| `PUT` / `DELETE /api/notes/:id` | save / delete a notebook page |
| `PUT /api/projects` | the project-name list |
| `GET /api/search?q=&phrase=` | full-text search (`search_parts`) |
| `GET /api/discover?q=` | OpenAlex search, abstracts rebuilt from the inverted index |
| `PUT` / `DELETE /api/feeds` | follow / unfollow a feed |
| `POST /api/activity` | log a study event |
| `GET /api/fetch?url=` | fetch a pasted link (below) |
| `POST /api/ai` | AI proxy |
| `GET` / `PUT /api/settings`, `POST /api/settings/models`, `POST /api/settings/test` | AI settings |
| `/api/whisper`, `/api/whisper/use`, `/api/transcribe`, `/api/ytaudio`, `/api/ytsubs` | see [transcription](transcription.md) |

IDs in paths must match `[\w-]{1,64}`.

## Fetching pasted links: `fetchPublic()`

- Only `http` and `https` are allowed.
- The host is resolved, and refused if any of its addresses is private, loopback, link-local or CGNAT (`internal` block list, IPv4 and IPv6).
- Redirects are followed by hand, up to 6, and the address is checked again at every hop.
- The response is capped at 80 MB. A body starting with `%PDF-` is returned as a PDF. HTML, XML and text are returned as JSON `{ url, html }`, never as a page, so fetched HTML cannot run on Marrow's origin.

> ponytail note in the code: the host is resolved once for the check and again by `fetch`. Pin the resolved address if this ever runs on a shared server.

## Request size limits

`json(req, max)` caps request bodies: 40 MB by default, 6 MB for `/api/ai`, and less for small routes. `slurp()` throws `413 too large` beyond that.
