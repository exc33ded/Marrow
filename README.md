# Marrow

Read research papers to the bone. Marrow is a paper reader built around what actually makes understanding stick, instead of handing you a summary.

1. **Brief** – get the skeleton first: problem, core idea, method, results, weaknesses, prerequisites.
2. **Read** – go section by section; each has a checkpoint question you answer from memory, graded against the paper.
3. **Teach** – explain the paper in your own words; the AI finds gaps and misconceptions.
4. **Keep** – spaced-repetition flashcards and a concept map that links every paper in your library.

Also: highlights and notes on the PDF, find and zoom, "snip" a figure or equation to have it explained, chat with page citations, tags, BibTeX, Markdown export with `[[wikilinks]]`, and backup/restore.

AI-generated flashcards and feedback must quote the paper; quotes are checked against the PDF text and anything unverified is flagged.

## Run

Requires Node 20.6+ and an [OpenRouter](https://openrouter.ai) API key. No dependencies to install.

```bash
cp .env.example .env   # then put your key in .env
node --env-file=.env server.js
```

Open http://localhost:5173. Add `#test` to the URL to run the built-in self-check (see the console).

## How it works

- `server.js` – serves the app, proxies AI calls (the key never reaches the browser, and only free models are allowed), and fetches PDFs from arXiv.
- `index.html` – the whole app. Papers, notes and progress are stored in the browser (IndexedDB).
