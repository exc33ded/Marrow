---
covers: [schema.sql, local.js]
---

# Database (local SQLite)

`schema.sql` is the schema of record, but you never paste it anywhere: `local.js` reads it and creates the tables on first run. It is safe to run again. It lives in the library folder (see below).

There is one reader, so no table has a `user_id` and no row-level security is needed. Every query in `local.js` addresses the single library.

## Tables

| Table | Holds |
|---|---|
| `items` | sources: kind, title, URL, project, done, timestamps, and `data` (all other fields as JSON) |
| `parts` | the numbered text of a source, its HTML, timestamp and embedding vector |
| `cards` | flashcards, ordered by `pos` |
| `notes` | highlights when `item_id` is set, notebook pages when it is null |
| `activity` | study events by timestamp |
| `feeds` | followed RSS/Atom addresses |
| `paths` | where each file in the library folder is: a source's PDF and Markdown copy, a page's Markdown copy |
| `concept_emb` | the concept map's vectors, one per concept text ("name: definition") and model |
| `settings` | AI providers, model lists, project names, Whisper choice |

Parts, cards and item-level notes cascade when their source is deleted.

## Full-text search

`parts_fts` is an FTS5 virtual table over `parts.body` with external content and three triggers to keep it in step with inserts, deletes and updates. `searchParts()` builds a safe query from the words in the search box: words joined with `AND`, or one quoted phrase. `snippet()` marks matches with `\x01` and `\x02`, which the browser turns into highlights. A phrase must appear in order, so `search?phrase=1&q=is all attention` does not match "Attention is all you need".

## Vectors

Embeddings are 1024-dimension Float64 blobs on `parts.emb`, with the model name in `emb_model`. A library made before vector search lacks both columns; `open()` adds them before running the schema, since `create table if not exists` never adds columns. `local.js` registers a `cosine()` SQL function so ranking can happen in the database. `matchParts()` merges the vector ranking with the FTS ranking by reciprocal rank fusion, the same shape as the old `match_parts` database function. Rewriting a source's text deletes its parts and therefore its vectors; the server embeds them again in the background.

Concept vectors live in `concept_emb`, keyed by text and model, so a concept is embedded once per model and a renamed or redefined concept gets a new row. `conceptEmbs()` reads the cached vectors (null where none) and `saveConceptEmbs()` writes new ones. Rows are not removed when a source is deleted; they are small and are reused if the concept comes back.

## Library folder

Everything lives in one folder the reader picks on first launch: `DATA_DIR` if set (it fixes the folder), else the `dir` saved in `~/.marrow.json` (`MARROW_CONFIG`). With neither, `open()` fails with 409 and the browser shows the first-run screen (`GET`/`POST /api/store`). `store()` reports the folder and suggests the old `./data` (`MARROW_LEGACY`) when it holds a library, else `Documents/Marrow`.

```
<library>/README.md            written once, explains the folder
<library>/marrow.db
<library>/<Project>/papers/    PDFs              (Unfiled/ when there is no project)
<library>/<Project>/sources/   one .md per source
<library>/<Project>/pages/     one .md per notebook page
```

- **`paths` table.** Records where each file is (`pdf:<id>`, `src:<id>`, `pg:<id>`), so a file can be found, moved and removed. `relOf()` builds the name: `safe()` keeps Unicode, drops reserved characters and device names, and caps at 80 characters. A name already taken, in any letter case, gets the id's first 6 characters.
- **`place()`.** Moves a file from its old path and writes the new body. The row changes only once the file exists. `unplace()` deletes it, and `prune()` removes folders left empty, up to the library folder.
- **Markdown.** The browser renders it and sends it as `md` with each save (`srcMd()`, `pageMd()`). `putItem()` keeps `md` out of `items.data` and calls `mirrorItem()` after the commit, which also moves the PDF when the title or project changed. `saveNote()` does the same for pages.
  - These copies go through `quietly()`: a file problem, such as a PDF open in a viewer on Windows, is logged and retried on the next save, and never fails the save.
  - `library()` lists `unmirrored` sources and pages, and the browser saves each once to write its copy.
- **PDFs.** `putFile()` checks the id against `[\w-]{1,64}` (the server has already checked the `%PDF-` magic bytes), then writes the PDF to `<Project>/papers/`. A PDF uploaded before its source is saved waits in `Unfiled/papers/` and moves on the first save. A failed write does fail the upload, because the PDF is the only copy. `getFile()` answers 404 with the expected path when the file has gone.
- **Older libraries.** On open, PDFs under `files/<id>.pdf` move into their project folders once.
- **Moving.** `choose(dir)` needs a full path.
  - On first launch, it opens a library already in `dir`, or copies the old `./data` there.
  - Later, `copyLibrary()` checkpoints the database, closes it and copies everything except `whisper/` into an empty folder, with no overwrites. It then checks `integrity_check`, the row count of every table and the file count. If any check fails, it removes the copy and changes nothing.
  - On success it switches to the new folder and saves the choice. The old folder is left for the reader to delete.
