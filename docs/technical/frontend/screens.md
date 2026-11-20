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
- It can be arranged by topic or by year (`M.by`). `conceptPanel()` explains a clicked concept: a summary line (links, sources, linked concepts not studied yet); each link as a sentence with the other concept's definition, a "Not studied yet" mark and the source that states it (rel edges carry `src`); **Explain these connections** (`mapexplain`), which sends the concept, its links and `sourceText()` of up to 3 of its sources to `aiJSON` and shows why each link holds with a quote checked by `findQuote()` (unfound quotes are flagged), kept in `explained` for the session; and **Similar ideas**, the concept's embedding neighbours across the whole library from `conceptNear()` above the `same` / `cross` cut-offs, or a pointer to Settings when there is no model (`CN.none`) or it failed (`CN.failed`). It does not use `run()`, so the map is not redrawn.
- A key (`.mlegend`) above the map lists only the marks that map shows.
- **Similar-meaning links** (dotted, `edge[sem]`) are added only in the many-source topic layout, not in By year, the one-source tree or a source's own map. Each concept keeps its top 3 neighbours, and a pair is drawn once. cola gives them a shorter length (`200 − 140 × similarity`) so similar concepts sit closer.
  - With an embedding model in Settings, `conceptNear()` sends every library concept ("name: definition") to `POST /api/concept-near` once per library state and keeps the answer in `CN`. A link needs the server's `same` cut-off within a source and the higher `cross` cut-off across sources. The map draws with local links first and redraws once the answer arrives; saving Settings clears `CN`.
  - With no model, `conceptVecs()`/`vecCos()` build local word + character 3-gram TF-IDF vectors, and links are kept within a source only (cosine ≥ 0.08), because local vectors cannot tell meanings apart across sources.
- **Dashed ring** (`node[gap]`): a concept that none of your highlights, cards or notebook pages (in the current project) mention. Rings appear only once at least one concept is covered.

## Command palette

`palette()` (`Ctrl K` or `/`) searches sources, notes and pages, runs full-text search, or adds a pasted link.

- **Settings** (`PAGE.settings`). One panel per AI provider: a one-line head (name, state, "Save & test", remove) and, folded once a key is saved, the masked key (Replace / Remove key) and address. "Save & test" runs `saveCfg()` then `probe()`, which calls `POST /api/settings/models`; providers with a saved key are probed when Settings opens. Then one ordered model list (`chainHTML('models')`). `merged()` builds `cfg.models` from the server's `chain` and `vision`, each row flagged `text` and/or `img` (the Text / Images switches, `cfgflag`); `saveCfg()` splits it back, keeping the order. Below it a service select and a search box (`pick`, `offered()`, `pickRows()`): typing lists matching models the service offers, minus those already chosen, with an `images` tag where the service says so; Enter adds the top match, or the name as typed, and `fresh()` switches Images on for a model that reads images. The list closes with ×, Esc or a click outside (`closePick()`). Rows reorder by drag and drop, picks and removals save at once (`persist()`), and each row has Test and Remove icon buttons, shown on hover or focus (`cfgtm`, `POST /api/settings/test` with `{ p, m }`). `PRESETS` holds the services offered in "Add a provider".
