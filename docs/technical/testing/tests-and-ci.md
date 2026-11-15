---
covers: [test.js, test-frontend.js, test-ui.mjs, .github/workflows/ci.yml, package.json]
---

# Tests and CI

| Command | Script | Checks |
|---|---|---|
| `npm test` (first half) | `test.js` | the server, against your **real Supabase project** |
| `npm test` (second half) | `test-frontend.js` | `index.html`, with no browser |
| `npm run test:ui` | `test-ui.mjs` | every look, light and dark, on every screen, in a real browser |

## `test.js`

Run with `node --env-file=.env --env-file=.env.test test.js`. It needs `TEST_EMAIL_A`, `TEST_EMAIL_B` and `TEST_PASSWORD` in `.env.test`: two throwaway users created in Supabase (Authentication > Users, auto-confirm on).

It starts the server on port 5981 with a temporary `DATA_DIR`, and checks that:

- every route refuses requests without a login;
- wrong passwords are rejected;
- session cookies are `HttpOnly`;
- a source round-trips with its cards, notes and parts;
- full-text and phrase search work;
- user B can't see user A's data;
- the link-fetching rules hold;
- AI settings never return a key.

It only touches the two test accounts, and removes what it adds.

## `test-frontend.js`

1. The module script parses (`node --check`).
2. Every look defines every token, in light and dark.
3. Every look's fonts are loaded, it appears in `LOOKS`, and its text contrast is at least 4.5:1.

It finds looks by itself, so adding a look needs no test edit.

## `test-ui.mjs`

Needs Playwright (`npm i --no-save playwright && npx playwright install chromium`) and a running server (`BASE`, default `http://localhost:5173`). `PW_CHANNEL=chrome` uses the Chrome you already have installed. `npm run test:ui` loads `.env.test`.

It logs in once through `POST /api/login` as `TEST_EMAIL_A` and gives each browser context that session's cookies (`ctx.addCookies`). Without them, the app would wait at the login form and never draw a screen. It stops with exit code 2 if the test-user variables are missing or the login fails.

For each look and theme it visits each view in `VIEWS` (home, library, discover, review, matrix, notebook, map, settings), and reports:

- script and console errors;
- horizontal overflow;
- contrast measured in the rendered page;
- whether the activity grid can be read without colour.

With `CI=true` it also creates a notebook page to exercise the editor.

## CI (`.github/workflows/ci.yml`)

Runs on every push and pull request:

- `backend`: `node test.js` on Node 22 and 24, one at a time (`max-parallel: 1`), because both use the same two test accounts;
- `frontend`: `node test-frontend.js`;
- `ui`: runs after `backend` (`needs: backend`), for the same reason. It starts `node server.js` and runs `test-ui.mjs` with `CI=true`.

The `CI passed` job is green only when all three are, and it is the one check to require in branch protection.

**Secrets.** The workflow reads `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `APP_SECRET`, `TEST_EMAIL_A`, `TEST_EMAIL_B` and `TEST_PASSWORD` from the repository's Actions secrets, through a top-level `env:`. Without them, `server.js` exits at startup and `test.js` exits with code 2.

> **Known failures in `ui`** (as of 8e6a7f7): 16 problems, all in the activity grid. In every look, the five levels `--h0`…`--h4` are not all distinct, and in some looks the empty squares are nearly invisible (about 1.0–1.25:1 against the background, with no outline). These were hidden while the test could not log in.
>
> In CI, the notebook page that `test-ui.mjs` creates is left in test user A's account after each run.
