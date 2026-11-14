# Marrow

A research desk for one. Everything you read, watch and think about for your research lives in one place, and Marrow makes you actually understand it instead of handing you a summary.

## What goes in

Paste a link into one box, or drop a PDF anywhere:

- **Papers** – a PDF, an arXiv ID or link, a DOI, or any PDF URL.
- **Articles and blog posts** – any web page, cleaned into a reader view (ads and navigation removed).
- **Videos** – a YouTube link. The video plays next to its transcript; paste the transcript once (YouTube's "Show transcript" panel, SRT or VTT) and every note, card and AI answer links to its moment in the video.
- **Discover** – search 250M scholarly works (OpenAlex) and add open-access papers with one click. Follow blogs, journals and arXiv categories by their address (RSS/Atom, found automatically from a blog's home page); new posts are listed there, one click from your library.

## What you do with it

Every source, whatever its kind, gets the same four steps:

1. **Brief** – the skeleton first: problem, core idea, method, results, weaknesses, prerequisites.
2. **Read / Watch** – section by section; each has a checkpoint question you answer from memory, graded against the source.
3. **Teach** – explain it in your own words; the AI finds gaps and misconceptions.
4. **Keep** – spaced-repetition flashcards and a concept map.

Around that:

- **Library** – projects, tags, filters, and full-text search across every word of every source.
- **Review** – due cards from the whole library, with a streak and a 12-week activity view.
- **Matrix** – a literature-review table (problem, idea, method, findings, limitations, your take) per project, exportable as CSV or Markdown, plus an AI-drafted synthesis.
- **Notebook** – your own notes in Markdown with math.
- **Map** – one concept map linking everything you've studied.
- **Jump** – `Ctrl K` (or `/`) opens one box that finds any source, note or page, searches the full text, or adds a pasted link. In Review, `Space` shows the answer and `1` `2` `3` grade it.
- Highlights and notes on PDFs, articles and transcripts; snip a figure or equation to have it explained; chat with citations; BibTeX; Markdown export with `[[wikilinks]]`; light and dark themes.

AI-generated flashcards and feedback must quote the source; quotes are checked against its text and anything unverified is flagged.

## Run

Requires Node 22.13+ (it uses Node's built-in SQLite) and an [OpenRouter](https://openrouter.ai) API key. No dependencies to install.

```bash
cp .env.example .env   # then put your key in .env
node --env-file=.env server.js
```

Open http://localhost:5173.

- `node test.js` checks the server (storage, search, link-fetching rules).
- Add `#test` to the URL to run the browser self-check (see the console).

## How it works

- `server.js` – serves the app, stores the library, proxies AI calls (the key never reaches the browser, and only free models are allowed), and fetches the links you add. It listens on this machine only; set `HOST=0.0.0.0` in `.env` to reach it from other devices.
- `index.html` – the whole app.
- `data/marrow.db` – the SQLite database: `items` (sources), `parts` (their text, indexed with FTS5), `cards`, `notes`, `activity`. PDFs sit next to it in `data/files/`. Copy the `data/` folder to back everything up, or use Backup in the Library for a single portable file.

Upgrading from the first version: your papers were stored in the browser. Open Marrow in that same browser once and they are moved into the database automatically (the browser copy is left alone). Old backup files still restore.
