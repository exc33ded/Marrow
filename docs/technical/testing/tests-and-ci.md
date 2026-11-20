---
covers: [test.js, test-frontend.js, test-ui.mjs, .github/workflows/ci.yml, package.json]
---

# Tests and CI

| Command | Script | Checks |
|---|---|---|
| `npm test` (first half) | `test.js` | the server, with a throwaway `DATA_DIR` |
| `npm test` (second half) | `test-frontend.js` | `index.html`, with no browser |
| `npm run test:ui` | `test-ui.mjs` | every look, light and dark, on every screen, in a real browser |

## `test.js`

Starts the server on port 5981 with a temporary `DATA_DIR`, so it never touches your library, and checks that:

- a source round-trips with its cards, notes and parts;
- full-text and phrase search work;
- PDFs are stored, served and deleted, with no path traversal;
- activity, projects, feeds and notebook pages round-trip;
- the link-fetching rules hold, and other sites cannot call the API;
- AI settings never return a key.

It also checks meaning-based search against a fake embedding service on port 5982: no model chosen gives 400, the model is saved, `/api/embed` indexes a source, and `/api/retrieve` returns the dictionary-learning passage first.

Run with `npm test` (which supplies `.env` for `APP_SECRET`) or `node test.js` (a test-only `APP_SECRET` is used if none is set). No accounts or external service are needed.

## `test-frontend.js`

1. The module script parses (`node --check`).
2. Every look defines every token, in light and dark.
3. Every look's fonts are loaded, it appears in `LOOKS`, and its text contrast is at least 4.5:1.

It finds looks by itself, so adding a look needs no test edit.

## `test-ui.mjs`

Needs Playwright (`npm i --no-save playwright && npx playwright install chromium`) and a running server (`BASE`, default `http://localhost:5173`). `PW_CHANNEL=chrome` uses the Chrome you already have installed.

It always opens `/?look=<name>&theme=<mode>`, with `look=` empty for Lab notebook, because a page with no look in the address gets the default look, Studio. For each look and theme it visits each view in `VIEWS` (home, library, discover, review, matrix, notebook, map, settings), and reports:

- script and console errors;
- horizontal overflow;
- contrast measured in the rendered page;
- whether the activity grid can be read without colour.

With `CI=true` it also creates a notebook page to exercise the editor. It leaves that page in the local library.

## CI (`.github/workflows/ci.yml`)

Runs on every push and pull request:

- `backend`: `node test.js` on Node 22 and 24;
- `frontend`: `node test-frontend.js`;
- `ui`: runs after `backend`, starts `node server.js` and runs `test-ui.mjs` with `CI=true`.

The `CI passed` job is green only when all three are, and it is the one check to require in branch protection.

**Secrets.** The only secret is `APP_SECRET` (any 64 hex characters), read from the repository's Actions secrets through a top-level `env:`. `server.js` exits at startup without it.

> **Known failures in `ui`** (as of fb04a90): 18 problems, all in the activity grid. In every look, the five levels `--h0`…`--h4` are not all distinct, and in some looks the empty squares are nearly invisible (about 1.0–1.25:1 against the background, with no outline).
