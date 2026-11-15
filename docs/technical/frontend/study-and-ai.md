---
covers: [index.html]
---

# Study flow and AI on the client

## Calling the AI

- `ai(messages)` posts to `/api/ai`. The browser never sees an API key; the server picks the model (see [AI proxy](../backend/auth-and-ai.md)).
- `aiJSON(system, user)` asks for a single JSON object and cuts it out of the reply, so a model that wraps it in prose still works.
- `fullText(p)` builds the prompt text, with each part prefixed `[p.N]`. It is capped at 150,000 characters.

- `sourceText(p, q)` is what Ask sends. Up to 150,000 characters it is `fullText(p)`. Above that it calls `POST /api/retrieve` with the question and sends the best-matching parts (`[p.N]`, in order), and falls back to the cut-off text when no embedding model is set or the call fails.

## Analysis

`analyze()` sends `SYS_ANALYZE` together with the source. The answer fills the item:

- `brief`: tldr, problem, idea, method, results, limitations;
- `meta`: title, authors, year, venue;
- `sections`, each with a checkpoint question;
- `concepts` and `links` for the map;
- `cards`, each with a verbatim `quote`;
- `references`.

Concept names already in the library are passed in (up to 150), so the same concept keeps the same name across sources. Only the four checkpoint fields are kept from each section, so a model can't pre-fill the reader's answer box. References are kept only if their title actually appears in the source. Citation links are found both ways: library titles that appear in this text, and this title found in the library through phrase search.

## Grounding

The AI must quote the source. `findQuote(p, quote)` finds the part that contains a quote, ignoring spacing, punctuation, hyphenation and ligatures (`norm()`). A quote can run on into the next part. Quotes that aren't found are flagged in the UI, not hidden.

`ckey()` normalises concept names, so "Self-Attention", "self attention (SA)" and "Self-attentions" merge on the map. `related(p)` links sources that cite each other, share concepts or share tags.

## Progress

`parts(p)` measures three things separately:

- `read`: the average checkpoint score;
- `teach`: the teach-back score;
- `keep`: the share of cards with an interval of at least a day.

`mastery(p)` blends them 40 / 35 / 25 into the ring's number, and `breakdown(p)` is the ring's tooltip.

## Spaced repetition

`grade(c, g)` is SM-2 style, with `g` = 0 (again), 1 (good) or 2 (easy). It updates `ease` (never below 1.3), `ivl` in days, and `due`. `due(ps)` lists the cards due now, oldest first. Each review, checkpoint and teach-back is logged with `log()` and feeds the streak and the activity grid (`streak()`, `heat()`).

## Study panel

`VIEW` has one function per tab: brief, read, teach, cards (`cardsHTML()`), map (`drawMap([P])`), notes, ask. Ask can include other sources from the library (`askWith`).
