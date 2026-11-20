---
covers: [index.html]
---

# Study flow and AI on the client

## Calling the AI

- `ai(messages)` posts to `/api/ai` with a random request id. The browser never sees an API key; the server picks the model (see [AI proxy](../backend/auth-and-ai.md)). While it waits, it polls `GET /api/ai/progress` every second and `paintStatus()` fills the status pill (bottom right): the job's label, the seconds so far, "usually about N s" once this kind of job has run before (`took`, kept in `localStorage.aiTook` and keyed by the first 40 characters of the instructions), the model being asked ("model 2 of 8") and the last failure. If models failed before one answered, a toast lists them. If none answered, the error lists every model's reason, one per line.
- `aiJSON(system, user)` asks for a single JSON object and cuts it out of the reply, so a model that wraps it in prose still works.
- `fullText(p)` builds the prompt text, with each part prefixed `[p.N]`. It is capped at 150,000 characters.

- `sourceText(p, q)` is what Ask sends. Up to 150,000 characters it is `fullText(p)`. Above that it calls `POST /api/retrieve` with the question and sends the best-matching parts (`[p.N]`, in order), and falls back to the cut-off text when no embedding model is set or the call fails.

## Analysis

`analyze()` sends `SYS_ANALYZE` together with the source. The answer fills the item:

- `brief`: tldr, problem, idea, method, results, limitations;
- `meta`: title, authors, year, venue;
- `sections`, each with a checkpoint question;
- `concepts` and `links` for the map;
- `cards` (8-12), each with a verbatim `quote`. The card rules are `CARD_RULES`, shared with the AI card button (`SYS_CARDS`) and the select-text "Card" action: questions test understanding of the argument, not recall, and answers follow the ASD-STE100 writing rules (short sentences, active voice, present tense) while keeping the source's own terms;
- `references`.

Concept names already in the library are passed in (up to 150), so the same concept keeps the same name across sources. Only the four checkpoint fields are kept from each section, so a model can't pre-fill the reader's answer box. References are kept only if their title actually appears in the source. Citation links are found both ways: library titles that appear in this text, and this title found in the library through phrase search.

## Grounding

The AI must quote the source. `findQuote(p, quote)` finds the part that contains a quote, ignoring spacing, punctuation, hyphenation and ligatures (`norm()`). A quote can run on into the next part. Quotes that aren't found are flagged in the UI, not hidden.

A citation that shows a quote carries it: `cite(p, n, q)` adds `data-q`. Clicking it opens the source (or scrolls to the part) and `flashQuote(n, q)` lights the sentence with the `cite` CSS highlight for 4.5 s. `quoteRange()` builds the text of part `n` and the next (a PDF's `.textLayer`, or the block) as letters and digits only, mapped back to each text node, so a sentence split over spans, lines and hyphens still matches. If the exact quote is not there, it matches the first and last 40 characters, then either end alone; if nothing matches, the page opens with nothing lit. A PDF page draws its text only when scrolled to, so it retries for up to 5 s. Quotes are passed by flashcards, card lists, checkpoint evidence, notes, the map's highlights and explanations, and Matrix cells (which now store `{ n, q }`; older cells hold only the page number).

`ckey()` normalises concept names, so "Self-Attention", "self attention (SA)" and "Self-attentions" merge on the map. `related(p)` links sources that cite each other, share concepts or share tags.

## Progress

`parts(p)` measures three things separately:

- `read`: the average checkpoint score;
- `teach`: the teach-back score;
- `keep`: the share of cards with an interval of at least a day.

`mastery(p)` blends them 40 / 35 / 25 into the ring's number, and `breakdown(p)` is the ring's tooltip.

## Spaced repetition

`grade(c, g, s)` is SM-2 style with Anki's four grades: `g` = 0 (again), 1 (hard), 2 (good), 3 (easy). `s` is the session's memory of the card. It returns `true` when the card stays in today's deck (`stays()`): Again and Hard always do, and Good does once while the card is new or relearning (`ivl` 0). A card that stays is due now (Again also resets `ivl` to 0); anything else gets `ivl = nextIvl(c, g)` days and `due` that far ahead. `ease` changes by -0.2 / -0.15 / 0 / +0.15 and never drops below 1.3. `when(c, g, s)` is the label on each button. `due(ps)` lists the cards due now, oldest first. Each review, checkpoint and teach-back is logged with `log()` and feeds the streak and the activity grid (`streak()`, `heat()`).

## Study panel

`VIEW` has one function per tab: brief, read, teach, cards (`cardsHTML()` plus `deckHTML(P)`), map (`drawMap([P])`), notes, ask. Ask can include other sources from the library (`askWith`).

## Study deck

`sess` holds the deck on screen, so a card can go back "3 cards down" and come up again in the same session, which `due` alone can't express. `session(ps, key)` builds it: live cards first and done cards under them, each entry `{ p, c, k, s, done }`, where `k` names the card's element. It keeps the order across renders, drops deleted cards, and adds cards that came due. `key` is the scope (`rv:all:<project>`, `rv:<source id>` or `tab:<source id>`); a new key starts a new deck.

`cardsHTML(ps, key, all)` draws the stack. `pose()` gives each card its depth, spread over at most 28 px so positions look different in any size of deck. `flipTop()` turns the top card. `gradeTop(g)` grades it, moves it to `slot(g, n)` among the `n` live cards (Again 1, Hard 3, Good the middle, at least 4), or to the bottom when it is done. It then animates it with the Web Animations API: out to the side, then back in under exactly the cards above its new place. `layout()` and `paintDeck()` update the stack and the buttons without a full render, so the animation is never interrupted. When no live cards are left it renders the "Nothing due" box. `.study` clips sideways overflow, so the card flying out never adds a scrollbar.

Review has two tabs (`rtab`): Study, optionally limited to one source (`rdeck`), and Decks, a folder per source (`folders()`), with one deck open at a time (`ropen`). `deckHTML(p, inReview)` lists a deck's cards with **+ New card** (the `newcard` form; `adding` is the deck whose form is open), **Delete** (`delcard`), and **More cards with AI** (`morecards`). That last one sends the source text and the existing questions with `SYS_CARDS`, and checks each new card's quote with `findQuote()`. The `#keys` popover lists the shortcuts; `?` toggles it.
