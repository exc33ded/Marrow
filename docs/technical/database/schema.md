---
covers: [schema.sql]
---

# Database (Supabase)

`schema.sql` is run once in Supabase's SQL editor. It is safe to run again. It sets up Postgres tables, row-level security, a storage bucket and three functions.

## Tables

Every table has `user_id uuid`, which defaults to `auth.uid()` and is deleted along with the user.

| Table | Holds |
|---|---|
| `items` | sources: `id`, `kind` (`pdf`/`web`/`video`), `title`, `url`, `project`, `done`, `added`, `opened`, and `data jsonb` for everything else (brief, sections, concepts, tags, chat…) |
| `parts` | a source's text, one row per page/block/chunk: `n`, `t` (seconds, for videos), `body`, `html`, and a generated `fts tsvector` (English) |
| `cards` | flashcards: `q`, `a`, `quote`, `src` (part number), `ease`, `ivl`, `due` |
| `notes` | with `item_id`: a highlight or note on a source (`page`, `a`, `b`, `eb`, `c`, `ul`). With `item_id` null: a notebook page (`title`, `project`, `note` holds the page document) |
| `activity` | study events: `ts`, `kind` (`review`, `check`, `teach`), `item_id` |
| `feeds` | followed feeds, keyed by `(user_id, url)` |
| `settings` | key/value per user, keyed by `(user_id, k)` (keys listed in [auth-and-ai](../backend/auth-and-ai.md)) |

Deleting an item deletes its parts, cards and notes too.

## Row-level security

Every table gets a single policy, `own`, for the `authenticated` role: `user_id = auth.uid()` for both reading and writing. The server always calls Supabase with the user's own token, so a user can never read or overwrite another user's rows.

## Storage

There is one private bucket, `files`. PDFs are stored at `<user id>/<item id>.pdf`, and the `own_files` policy only allows a user into their own folder. The server adds a unique `?t=` when downloading, so Supabase's CDN can't serve a PDF that was just replaced or deleted.

## Functions

All run as the calling user (`security invoker`), so row-level security still applies.

- **`put_item(p_id, p jsonb)`** saves one source in a single transaction:
  - it upserts the item (`kind` never changes after creation);
  - it rewrites the item's cards and notes;
  - it replaces the parts only when `p.parts` is an array, so a save without text keeps the text.

  > ponytail note in `server.js`: cards and notes are rewritten on every save. Diff them if items grow to thousands of cards.
- **`library()`** returns everything the app needs at start as one JSON object:
  - `items` (with their cards and notes);
  - notebook pages (`notes` with no `item_id`);
  - `activity` from the last 400 days;
  - `feeds` and `projects`.

  Empty fields are left out.
- **`search_parts(q, phrase)`** does full-text search with `plainto_tsquery`, or `phraseto_tsquery` plus a regex check so the words really are adjacent and in order. It returns up to 40 `{ item_id, n, s }` rows, ranked, where `s` is a snippet with matches wrapped in `\x01`…`\x02`.

## Known issue

The storage bucket, `put_item` and `library` blocks appear twice in `schema.sql` (lines 58–104 are repeated at 106–152). It is harmless, because every statement is idempotent, but the second copy can be deleted.
