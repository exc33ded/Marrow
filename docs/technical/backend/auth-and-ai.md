---
covers: [server.js, local.js]
---

# Keys and the AI proxy

## No sessions

Marrow is a single-user local server: there are no accounts, no login and no cookies. `server.js` still checks the host, the `Origin` header and `Sec-Fetch-Site` on every request, so another website cannot call the API from your browser.

## AI keys

You bring your own keys; the server has none.

- **Encryption.** `seal()` encrypts a key with AES-256-GCM using `APP_SECRET`, stored as `enc1:<iv>.<tag>.<ciphertext>`. `unseal()` decrypts it only to call the provider. A wrong `APP_SECRET` gives an empty key, so you have to enter it again.
- **What the browser gets.** `GET /api/settings` never returns a key, only `hasKey` and the last four characters (`hint`).
- **Saving.** `PUT /api/settings` keeps the stored, already-encrypted key unless a new key is sent or `clearKey` is set. Provider addresses must be `http(s)`. The lists may be empty, so a key can be saved and tested before any model is picked. Saving clears the cooled-down models.

Settings are rows in the `settings` table:

| Key | Holds |
|---|---|
| `providers` | `[{ id, name, url, key }]` |
| `chain` | the ordered `[{ p, m }]` list for text |
| `vchain` | the ordered list for images |
| `paid` | `'1'` allows paid OpenRouter models |
| `embed` | `{ p, m }` for embeddings |
| `whisper` | the chosen Whisper model |
| `projects` | the project names |

`conf(S)` turns those rows into the working configuration. There are no defaults: without saved settings there are no providers and no models, and `ai()` answers `502` asking you to set one up in Settings.

## The AI proxy: `ai(conf, messages, rid)`

1. It uses the vision chain if any message carries an image and that chain is not empty, otherwise the text chain. (Saving no longer copies the text chain into an empty vision chain.)
2. It skips models that failed in the last 10 minutes (the `cooling` map, keyed by provider and model), unless every model is cooling.
3. On OpenRouter it skips non-`:free` models unless `paid` is set. It never spends money unless told to.
4. It posts to `{provider url}/chat/completions` with `temperature: 0.3` and a 90 s timeout. Anthropic addresses also get `x-api-key` and `anthropic-version`.
5. It returns the first reply that has text, as `{ text, model, provider, failed }`, where `failed` lists the models that failed before it. A `401`/`403` skips the rest of that provider's models. If nothing answers, it returns `502` with every model's error, one per line.
6. Each error uses the service's own words where it gives any: a `429` says `rate limited (…)` with the service's message (OpenRouter names a used-up daily free quota there). A `200` with no text says whether the model ran out of room (`finish_reason: length`) or only returned its reasoning.

While it works, `progress` (an in-memory map keyed by the request id `rid` the browser sends) holds which model is being asked (`n` of `of`), and the errors so far. `GET /api/ai/progress?id=` reads it; the entry is removed when the request ends.

`offered(p)` lists a provider's models from `GET {url}/models` (the OpenAI format), for the model picker, as `{ id, free, img }`; `img` is true when the service lists `image` in `architecture.input_modalities` (OpenRouter does). `POST /api/settings/models` calls it with the address and key as typed in the form, falling back to the saved key of that provider id, so a provider can be tested before it is saved. OpenRouter lists its models to anyone, so for OpenRouter `offered()` first checks the key with `GET {url}/key` and fails on a missing key or a `401`/`403`.

**Embeddings.** The `embed` setting (`{ p, m }`) names a provider and model. `embed(c, texts)` posts to `{url}/embeddings` with `dimensions: 1024` (`DIM`; parts are cut at 6000 characters) and rejects any other vector size. `embedItem()` embeds a source's parts that have no vector, 64 at a time, through `local.setEmb()`; `PUT /api/items/:id` runs it in the background when parts were saved, so a failure never blocks the save. `POST /api/embed` does one source (`item`) or all (`all`). `POST /api/retrieve` embeds the question and calls `local.matchParts()` for the 12 best parts.

`conceptNear(c, texts)` serves the concept map. It embeds texts with no cached vector (64 per call) and stores them with `local.saveConceptEmbs()`. Then it compares every pair, which takes about a second at 1000 concepts, and returns each concept's top 10 neighbours. It also returns two cut-offs taken as percentiles of all pair similarities: the 88th (`same`, for concepts sharing a source) and the 98th (`cross`). Percentiles are used instead of fixed numbers because cosine ranges differ between models; the tiers were measured on three models (see `auto-research/logs.md`, exp-17).

`POST /api/settings/test` asks for a one-word reply. With `{ p, m }` in the body it tests only that model; without a body it tests the saved list in order.
