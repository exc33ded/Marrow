---
covers: [server.js]
---

# Sessions, keys and the AI proxy

## Talking to Supabase

`sb(path, opts)` calls Supabase with the publishable key and, when given one, the user's access token. `db()`, `rpc()` and `upsert()` go through PostgREST *as the user*. No query in `server.js` filters by user; row-level security in the database does that (see [schema](../database/schema.md)).

## Sessions

- **Accounts.** There is no sign-up route. Accounts are created in the Supabase dashboard.
- **Login.** `POST /api/login` exchanges email and password with Supabase Auth (`grant_type=password`). It stores the access and refresh tokens in `HttpOnly; SameSite=Lax` cookies, `mw_at` and `mw_rt`, which last 30 days and get `Secure` behind HTTPS. Page scripts never see the tokens.
- **Checking a token.** `whoIs(token)` checks it with `/auth/v1/user` and caches the result for 5 minutes, up to 500 entries.
- **Expired tokens.** `session()` refreshes from `mw_rt`. Concurrent requests share one refresh (`refreshing` map), because a refresh token works only once.
- **Logout.** `POST /api/logout` clears the cookies and tells Supabase.

## AI keys

Each user brings their own keys; the server has none.

- **Encryption.** `seal()` encrypts a key with AES-256-GCM using `APP_SECRET`, stored as `enc1:<iv>.<tag>.<ciphertext>`. `unseal()` decrypts it only to call the provider. A wrong `APP_SECRET` gives an empty key, so the user has to enter it again.
- **What the browser gets.** `GET /api/settings` never returns a key, only `hasKey` and the last four characters (`hint`).
- **Saving.** `PUT /api/settings` keeps the stored, already-encrypted key unless a new key is sent or `clearKey` is set. Provider addresses must be `http(s)`, and at least one provider and one model are required. Saving also clears that user's cooled-down models.

Settings are rows in the `settings` table:

| Key | Holds |
|---|---|
| `providers` | `[{ id, name, url, key }]` |
| `chain` | the ordered `[{ p, m }]` list for text |
| `vchain` | the ordered list for images |
| `paid` | `'1'` allows paid OpenRouter models |
| `whisper` | the chosen Whisper model |
| `projects` | the project names |

`conf(S)` turns those rows into the working configuration. Without saved settings it uses one OpenRouter provider and the `MODELS` / `VISION_MODELS` lists.

## The AI proxy: `ai(uid, conf, messages)`

1. It uses the vision chain if any message carries an image, otherwise the text chain.
2. It skips models that failed in the last 10 minutes (the `cooling` map, keyed by user, provider and model), unless every model is cooling.
3. On OpenRouter it skips non-`:free` models unless `paid` is set. It never spends money unless told to.
4. It posts to `{provider url}/chat/completions` with `temperature: 0.3` and a 90 s timeout. Anthropic addresses also get `x-api-key` and `anthropic-version`.
5. It returns the first reply that has text, as `{ text, model, provider }`. A `401`/`403` skips the rest of that provider's models. If nothing answers, it returns `502` with every model's error joined together.

`offered(conf, id)` lists a provider's models from `GET {url}/models` (the OpenAI format), for the model picker.
