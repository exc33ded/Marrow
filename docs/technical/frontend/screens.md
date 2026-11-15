---
covers: [index.html]
---

# Screens: home, library, matrix, notebook, map

Each screen is a function on `PAGE`, rendered by `render()`. A project selector (`projSel()`) sits at the top of every screen, and choosing a project sets `F.project`.

## Home and Library

- **Home** (`PAGE.home`). Shows the first-run screen with sample sources (`SAMPLES`) and the add box (`ADDBAR`). After that it shows projects, sources grouped by project, the next source to continue, and the activity grid. Project rename and delete live in "Project settings" here.
- **Library** (`PAGE.library`, `libRows()`). Filters (`F.q`, `F.kind`, `F.status`), plus full-text search through `/api/search` (`ftSearch()`). Matched words come back marked with `\x01`/`\x02`; the client escapes the text first, then styles the marked words.
- **Backup and restore** (`backup()`, `restore()`, `importItem()`). One JSON file with every source (including PDFs) and every notebook page.
- **Export.** `exportMd()` writes one source as Markdown with `[[wikilinks]]` for Obsidian. `bib` builds BibTeX.

## Matrix

`PAGE.matrix` and `mxTable()`.

- **Columns.** The five brief fields (`MX`), then custom columns, then "My take".
- **Custom columns.** A column added inside a project is stored on each source as `p.cols`. One added under "All projects" is stored as `p.colsAll`. That way a column never leaks from one into the other (`CS()`, `CQ()`).
- **Shown columns.** Which columns are shown is remembered per project in `localStorage.mx`.
- **AI fill.** `fillCell()` fills one cell from the source and stores the passage it used.
- **Which rows an action uses.** `mxPick()`: the ticked rows if any are ticked, otherwise every row the filters show. The synthesis button is the exception: it needs 2 to 40 ticked rows, is disabled outside that and shows the count.
- **Export.** CSV (`csv`) and Markdown, of what is on screen.

## Notebook

From `// ---------- notebook` onward.

- **Pages.** Pages are rows in `notes` with no `item_id`. `docOf(n)` reads a page's stored document: Editor.js blocks, icon, folder and sources. `putDoc()` writes it back.
- **Editor.** `mountEd()` starts Editor.js with header, list (including checklists), the custom `Toggle` and `Callout` blocks, quote, code, delimiter, table, inline code and marker. It adds drag-and-drop and undo. Markdown shortcuts (`# `, `- `, `---`) are converted as you type.
- **Asking across sources.** `work()` and `ask()` answer across the page's sources, and `addBlocks()` writes the answer into the page with citations.
- **Drag to file.** Sidebar rows carry `data-pg`; folder rows and project labels carry `data-dp` / `data-df`. The document-level `drop` handler sets the page's `project` and `folder` and saves with `putDoc()` (a project label clears the folder).
- **Side panels.** `nbSide()` (page list and folders; a folder row folds on click even when it holds the open page; the **+** on a project label calls `newPage([], '', project)`), `nbSrc()` (the page's sources), `nbToc()` (outline).

## Map

`PAGE.map`, `drawBig()`, `drawMap()`, `mapLayout()`.

- Drawn with Cytoscape. Squares are sources, circles are concepts, diamonds are notebook pages.
- It uses the same filters as the Matrix (the shared `S` object), so narrowing one narrows the other.
- "Shared concepts only" (`M.shared`) is on by default once more than 6 sources have concepts.
- The topic layout runs Cose once, then cola (`cytoscape-cola`, from jsdelivr, `infinite: true`, up to 400 nodes) keeps simulating so dragging tugs neighbours. Wheel zoom is replaced by `smoothZoom()`, which eases to the target. Link labels show only on `.hl` edges (hover or pick).
- It can be arranged by topic or by year (`M.by`). `conceptPanel()` explains a clicked concept.

## Command palette

`palette()` (`Ctrl K` or `/`) searches sources, notes and pages, runs full-text search, or adds a pasted link.

- **Settings** (`PAGE.settings`). One panel per AI provider: masked key (Replace / Remove key), "Save & test connection" (`saveCfg()` then `probe()`, which calls `POST /api/settings/models`), a pick list of the models on offer minus those already chosen (`left()`), then the ordered model lists (`chainHTML()`). Rows reorder by drag and drop, picks and removals save at once (`persist()`), and each row has a Test button (`cfgtm`, `POST /api/settings/test` with `{ p, m }`). `PRESETS` holds the services offered in "Add a provider".
