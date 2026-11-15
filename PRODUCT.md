# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack
Existing: one `index.html` (vanilla JS module, no build step) served by `server.js` on Node 22.13+ with built-in SQLite. No dependencies to install. Libraries load from CDNs (PDF.js, Editor.js, Cytoscape, KaTeX).

## Users
A solo researcher working on one or more projects, at a desk, in long sessions, often in the evening. They read papers, articles and videos, and need to understand them rather than skim a summary. (Confirmed by the user, 2026-11-15.)

## Product Purpose
A research desk for one. Everything read, watched and thought about for a project lives in one place, and Marrow makes the reader understand it instead of handing over a summary. Success is the reader being able to explain a source in their own words and still remember it weeks later.

## Positioning
Every source, whatever its kind, goes through the same four steps: Brief, Read/Watch with checkpoint questions answered from memory, Teach it back in your own words, Keep as spaced-repetition cards and a concept map. AI output must quote the source and quotes are checked against its text. Data stays on the user's computer.

## Operating Context
Papers (PDF, arXiv, DOI), web articles, YouTube videos with transcripts, a notebook of block pages, a literature-review matrix, a concept map, a review queue and a Library with full-text search. Projects group sources, matrix, map, review queue and notebook pages. Light and dark modes exist and must keep working.

## Capabilities and Constraints
- Light and dark themes both required for every look (confirmed).
- Single static HTML file today; themes must work without a build step.
- Library, Matrix, Map, Notebook, Review and Home are working screens used for long periods.
- Interface text says what a control does and what to do next on errors and empty states.
- Notebook uses drawn SVG icons, not emoji.

## Product Principles
1. Understanding over summary: the reader does the work, the AI checks it.
2. Every claim links back to the passage it came from.
3. Everything the reader makes lives in one place and on their own computer.
4. Comfort over long sessions matters more than first impressions.

## Accessibility & Inclusion
Text contrast at least 4.5:1 in every theme and mode. Keyboard focus always visible. Nothing conveyed by colour alone (the activity grid must also be readable without colour).
