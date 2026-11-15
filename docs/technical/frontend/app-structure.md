---
covers: [index.html]
---

# Frontend structure

Everything is in `index.html`: the stylesheet, the page skeleton, and one `<script type="module">`. There is no build step and no framework. Screens are template strings rendered into `#page` or the reader.

## Layout of the file

| Part | What is there |
|---|---|
| `<head>` | CDN scripts (Editor.js and its plugins, Cytoscape, KaTeX, DOMPurify, Readability, PDF.js). A tiny inline script applies `?look=` and `?theme=` before first paint. |
| `<style>` | Base styles, then every look between `/* LOOKS-BEGIN */` and `/* LOOKS-END */` (see [looks](looks.md)). |
| `<body>` | `#signin` (login form), `#rail` (left navigation), `#page` (every screen except the reader), `#reader` (source plus study panel), the selection toolbar `#sel`, and dialogs `#pal` (command palette), `#peek` (matrix cell) and `#sure` (confirmations). |
| module script | Sections marked `// ---------- name ----------`, in this order: helpers, storage, AI, state, transcription, adding sources, feeds, readers, study panel, pages, export/backup/migration, notebook, actions, reader tools, selection toolbar, boot. |

## Talking to the server

- `api(path, opts)` wraps `fetch('/api/' + path)`. On a `401` it shows the login form (`signIn()`), waits for a successful login, then repeats the request, so work in progress is not lost.
- `save(p, parts)` queues every item save behind the one before it, so an older save can never land after a newer one. The source text (`parts`) is sent only when it changed.
- `saveNote()`, `saveProjects()` and `log()` (activity) save notebook pages, the project list and study activity.

> The comment above the storage section still says "everything lives in the server's SQLite database". Storage is in Supabase now; see [database](../database/schema.md).

## State and rendering

- Global state: `lib` (sources), `notes` (notebook pages), `activity`, `feeds`, `PJ` (project names), `P` (open source), `N` (open page), `view`, `tab`.
- `F.project` is the current project. `inScope()` returns the sources in it, and every screen uses that.
- `render()` draws the rail, then either `PAGE[view]()` into `#page`, or the reader with `VIEW[tab]()` in the study panel.
- `NAV` lists the screens (home, library, discover, review, matrix, notebook, map), and `TABS` lists the study tabs (brief, read, teach, cards, map, notes, ask).
- Clicks are handled in one place, `onClick()`, by each element's `data-act`, `data-view` or `data-open` attribute.

## Kept in the browser only

`localStorage` holds per-browser conveniences: `project` (current project), `mx` (matrix columns shown, per project), `seen`, `later` and `newsCache` (feed posts), plus the look and theme. Everything else is on the server.

## Boot

`GET /api/library` loads everything at once. Then the boot code:

- moves any old browser-only project names into the database;
- repairs sources whose checkpoint answers were pre-filled by the AI;
- runs `migrate()`, which moves a library from the very first version (IndexedDB) to the server once;
- renders, and starts loading feeds and Whisper's status.
