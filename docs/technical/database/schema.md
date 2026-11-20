---
covers: [schema.sql, local.js]
---

# Database (local SQLite)

`schema.sql` is the schema of record, but you never paste it anywhere: `local.js` reads it and creates the tables on first run. It is safe to run again. `DATA_DIR` decides where `marrow.db` and `files/` live (default `./data`).

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
| `settings` | AI providers, model lists, project names, Whisper choice |

Parts, cards and item-level notes cascade when their source is deleted.

## Full-text search

`parts_fts` is an FTS5 virtual table over `parts.body` with external content and three triggers to keep it in step with inserts, deletes and updates. `searchParts()` builds a safe query from the words in the search box: words joined with `AND`, or one quoted phrase. `snippet()` marks matches with `\x01` and `\x02`, which the browser turns into highlights. A phrase must appear in order, so `search?phrase=1&q=is all attention` does not match "Attention is all you need".

## Vectors

Embeddings are 1024-dimension Float64 blobs on `parts.emb`, with the model name in `emb_model`. `local.js` registers a `cosine()` SQL function so ranking can happen in the database. `matchParts()` merges the vector ranking with the FTS ranking by reciprocal rank fusion, the same shape as the old `match_parts` database function. Rewriting a source's text deletes its parts and therefore its vectors; the server embeds them again in the background.

## PDFs

PDFs are files under `DATA_DIR/files/<item id>.pdf`, written by `local.putFile()` after checking the `%PDF-` magic bytes and the id against `[\w-]{1,64}`. `GET /api/files/:id` reads the file; a missing file answers 404.
