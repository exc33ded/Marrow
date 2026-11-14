# Marrow

A research desk for one. Everything you read, watch and think about for your research lives in one place, and Marrow makes you actually understand it instead of handing you a summary.

## What goes in

Paste a link into one box, or drop a PDF anywhere:

- **Papers** – a PDF, an arXiv ID or link, a DOI, or any PDF URL.
- **Articles and blog posts** – any web page, cleaned into a reader view (ads and navigation removed).
- **Videos** – a YouTube link. The video plays next to its transcript; Marrow fetches YouTube's own captions when the video has them, or writes the transcript with Whisper on this computer, and every note, card and AI answer links to its moment in the video. Pasting a transcript (YouTube's "Show transcript" panel, SRT or VTT) still works too.
- **Discover** – search 250M scholarly works (OpenAlex) and add open-access papers with one click. Follow blogs, journals and arXiv categories by their address (RSS/Atom, found automatically from a blog's home page); new posts are listed there, one click from your library.

## What you do with it

Every source, whatever its kind, gets the same four steps:

1. **Brief** – the skeleton first: problem, core idea, method, results, weaknesses, prerequisites.
2. **Read / Watch** – section by section; each has a checkpoint question you answer from memory, graded against the source.
3. **Teach** – explain it in your own words; the AI finds gaps and misconceptions.
4. **Keep** – spaced-repetition flashcards and a concept map.

Around that:

- **Projects** – a project (say "Watermarking" and "Hydrology") keeps its own sources, matrix, map, review queue and notebook pages. Create one on Home, switch with the selector at the top of every page, and move sources in by ticking them in the Library. Home lists every source under the project it belongs to. Rename or delete a project from "Project settings" at the foot of its Home page; deleting keeps its sources and pages, unfiled.
- **Library** – tags, filters, and full-text search across every word of every source.
- **Review** – due cards from the whole library, with a streak and a 12-week activity view.
- **Matrix** – a literature-review table, one row per source. Filter by text, kind, project and year; show only the columns you need (click a heading to see one column alone); click a cell to pop it out for reading (arrow keys move between cells); add your own columns and have the AI fill them from each source's text, with a link to the passage it used. A fill covers only the rows on screen, asks first when there are many, can be stopped, and can be run for one cell. Exports what is on screen as CSV or Markdown, and drafts a synthesis.
- **Notebook** – pages of blocks (headings, lists, checklists, toggles, callouts, tables, quotes, code, math; press `/`, drag a block by its handle, `@` cites a source), each with an icon, an outline of its headings and its project. A page carries the sources you are working with: tick sources in the Library and choose "Work with these in the Notebook", then ask across them. The answer is written into the page with citations that open the cited passage. Your highlights and a comparison table can be inserted the same way.
- **Map** – one concept map linking everything you've studied. The same filters as the Matrix, a "shared concepts only" view for large libraries, a layout by year, and a panel that says what each concept means and which sources use it.
- **Search** – `Ctrl K` (or `/`) opens one box that finds any source, note or page, searches the full text, or adds a pasted link. In Review, `Space` shows the answer and `1` `2` `3` grade it.
- Highlights and notes on PDFs, articles and transcripts; snip a figure or equation to have it explained; chat with citations; BibTeX; Markdown export with `[[wikilinks]]`; light and dark themes.

AI-generated flashcards and feedback must quote the source; quotes are checked against its text and anything unverified is flagged.

## Run

Requires Node 22.13+ (it uses Node's built-in SQLite). No dependencies to install.

```bash
node server.js
```

Open http://localhost:5173, then open **Settings** (the gear, bottom left) and enter the address and key of your AI service: [OpenRouter](https://openrouter.ai), OpenAI, or anything else that speaks the OpenAI chat format, including a local Ollama. "Test the connection" tells you whether it answers. The key is stored on your computer in `data/marrow.db`, is never sent to the browser, and can be replaced or deleted from the same screen. On OpenRouter only free models are used unless you allow paid ones.

A key can also be supplied in a `.env` file (`cp .env.example .env`, then `node --env-file=.env server.js`); a key saved in Settings takes precedence.

**Transcription.** In Settings, download the *YouTube helper* (yt-dlp) to fetch a video's existing captions with one click, or Whisper to transcribe anything: the Whisper program is fetched from whisper.cpp's GitHub releases on Windows (on a Mac run `brew install whisper-cpp` first), then pick a model and download it from Hugging Face. Videos use YouTube's captions when available and fall back to Whisper; you can also transcribe any audio or video file from a video's page. Audio is decoded in the browser, so no ffmpeg is needed, and Whisper runs on this computer: nothing but the video's captions or sound is fetched, and nothing is uploaded. Everything is stored under `data/whisper/` and can be removed again from Settings.

- `node test.js` checks the server (storage, search, link-fetching rules).
- Add `#test` to the URL to run the browser self-check (see the console).

## How it works

- `server.js` – serves the app, stores the library, proxies AI calls (the key never reaches the browser, and only free models are allowed), fetches the links you add, and fetches captions or runs Whisper for videos. It listens on this machine only; set `HOST=0.0.0.0` in `.env` to reach it from other devices.
- `index.html` – the whole app.
- `data/marrow.db` – the SQLite database: `items` (sources), `parts` (their text, indexed with FTS5), `cards`, `notes`, `activity`. PDFs sit next to it in `data/files/`. Copy the `data/` folder to back everything up, or use Backup in the Library for a single portable file.

Upgrading from the first version: your papers were stored in the browser. Open Marrow in that same browser once and they are moved into the database automatically (the browser copy is left alone). Old backup files still restore.
