---
covers: [index.html]
---

# Adding sources and the reader

## Adding

`addLink(v)` takes whatever was pasted and decides what it is:

| Input | Becomes |
|---|---|
| YouTube URL (`watch`, `youtu.be`, `embed`, `shorts`, `live`) | `addVideo(vid)`: title and channel come from YouTube's oEmbed, fetched through `/api/fetch` |
| arXiv ID or link (`ARXIV` regex) | `https://arxiv.org/pdf/<id>` |
| DOI | `https://doi.org/<doi>`; arXiv DOIs (`10.48550/arxiv.*`) go to arXiv |
| any other `http(s)` URL | fetched with `/api/fetch`: a PDF becomes `addPdf()`, a page becomes `addWeb()` |

A duplicate (same URL or arXiv ID) is opened instead of being added again.

- **`addPdf(buf)`** uploads the file (`PUT /api/files/:id`), then extracts one part per page with PDF.js. A page with under 20 characters of text (a scan) is rendered to a canvas at scale 2 and read with Tesseract.js (`createWorker('eng')`, loaded on first need from jsdelivr and terminated after the file).
- **`addWeb(html, url)`** parses the page with Readability and sanitises it with DOMPurify (rules in `PURE`). Each block becomes a part with both `body` (text) and `html`. Pages with less than 200 characters of article text are refused with advice to save the page as a PDF.
- **`create(kind, title, extra, parts)`** saves the new item, opens it, and starts `analyze()` when there are at least 500 characters of text.

A source's text is a list of **parts**, numbered from 1. For a PDF each part is a page, for an article a block, and for a video about 40 seconds of transcript. The AI cites parts as `[p.N]`, and `loc()` shows them to the reader as `p.N`, `¶N` or a timestamp.

## Feeds (Discover)

`parseFeed()` reads RSS and Atom. `getFeed()` finds a blog's feed from its home page. `loadNews()` collects posts from every followed feed. Followed feeds are saved on the server (`PUT/DELETE /api/feeds`). Read/unread (`seen`), "read later" (`later`) and the post cache (`newsCache`) are kept in `localStorage`. Paper search calls `/api/discover`, which goes to OpenAlex.

## Videos

- Transcript from YouTube: `GET /api/ytsubs?vid=` (server side, via yt-dlp).
- Transcript from Whisper: the browser gets the audio (`/api/ytaudio` or a local file), decodes it, and resamples it to 16 kHz mono WAV (`wav16`). It then posts that to `/api/transcribe` and polls the same URL for progress. Because the browser does the decoding, the server never needs ffmpeg.
- Pasted transcripts: `parseTranscript()` accepts YouTube's panel text, SRT, VTT or plain text, and groups it into ~40-second chunks.

## Reader

- **PDFs.** `renderPdf()` / `drawPage()` render pages lazily, with a selectable text layer.
- **Articles and videos.** `renderBlocks()` shows numbered blocks. For videos, `player()` embeds YouTube, and `nowPart()` keeps the transcript in step with playback.
- **Highlights and notes** are stored on the item (`p.notes`) with their position (`page`, `a`, `b`, colour `c`, underline `ul`) and are painted back by `paint()` / `paintBlocks()`.
- **Reader tools.** Find in source (`find()`), zoom (`rezoom()`), the figure snip, and timestamped notes on videos.
- `openItem(id)` loads the parts on first open and shows the reader. `gotoPage(n)` jumps to a part. Clicking a citation calls it.
