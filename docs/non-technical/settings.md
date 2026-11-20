---
covers: [index.html, server.js]
---

# Settings

Open Settings with the gear at the bottom of the left rail.

## Look

Pick one of seven looks: Studio (the default), Lab notebook (the original), Concourse, Barcode, Cyanotype, Survey or Page. Each changes colour, type and density, and each works in light and dark. The moon/sun button switches between light and dark. The choice is remembered in this browser.

## AI services

Marrow has no AI key of its own, and no service is set up when you start: you add the one you have a key for.

1. **Add providers.** Pick a service from the list (OpenRouter, OpenAI, Claude, Gemini, NVIDIA, Groq, DeepSeek, Mistral, xAI, Together AI, Fireworks, Hugging Face, Cerebras, SambaNova, a local Ollama) or choose Other and type its address. Anything that uses the OpenAI chat format works. Each provider is its own panel with its own key; the address is under "Name and API address".
2. **Save and test.** Paste the key and press **Save & test connection**. Marrow saves, asks the service for its model list, and shows "Connected · N models" in green or the service's error in red. On OpenRouter, whose model list is public, it also checks the key itself, so a missing or wrong key shows an error instead of "Connected". "Save & test all" does every panel at once.
3. **Pick models.** After a successful test the panel lists the models on offer. Filter and click one to add it; models already chosen are not offered again. You can also type a model name.
4. **Order them.** Drag a model by its ⠿ handle to set the order they are tried in. If one fails or is rate-limited, the next one answers, and the models can come from different providers. Picks, removals and reordering are saved at once.
5. **Test one model.** Each model has a Test button that asks only that model for a reply.
6. **Figures** have their own list, because the model has to accept images.
7. **Test the connection** at the bottom checks which model answers first.

Keys are stored encrypted on the server and are never sent back to the browser. A saved key is shown as dots plus its last four characters, with Replace and Remove key. On OpenRouter only free models are used, unless you allow paid ones. Other providers are always asked, so choose their models with care.

## Transcription

- **YouTube helper** (yt-dlp): downloads with one click and fetches a video's own captions.
- **Whisper**: transcribes on the server's computer. On Windows, Marrow downloads the program for you; on a Mac, run `brew install whisper-cpp` first. Then download a model, from *Tiny* (fastest) to *Medium* (most accurate, slow on a laptop).

Everything downloaded here can be removed again from the same screen.

## Embedding model

Optional. Pick a provider and an embedding model so Ask can handle sources too long to send whole (books, theses, long lectures): the passages that best match the question are found by meaning and sent instead. "Index my library" prepares sources you saved earlier; new ones are indexed when saved. The same model also lets the concept map join concepts that mean similar things, across sources too.

## Library folder

The first time Marrow starts, it asks where to keep your library. Everything goes in that one folder, so backing it up backs up everything:
- the library itself (`marrow.db`);
- a README;
- a folder per project with its PDFs (`papers`), a Markdown copy of each source (`sources`) and of each notebook page (`pages`).

Things not in a project go in `Unfiled`. The Markdown copies open in Obsidian, VS Code or any editor, and Marrow rewrites them whenever you change something, so make your changes in Marrow. Don't move or rename the PDFs, or Marrow can't open them.

To move the library, type an empty folder's full path under "Library folder" and choose "Move library here". Marrow copies everything, checks the copy, then switches to it. The old folder is left as it was, for you to delete once you're happy.
