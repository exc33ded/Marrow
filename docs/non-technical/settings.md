---
covers: [index.html, server.js]
---

# Settings

Open Settings with the gear at the bottom of the left rail.

## Look

Pick one of seven looks: Studio (the default), Lab notebook (the original), Concourse, Barcode, Cyanotype, Survey or Page. Each changes colour, type and density, and each works in light and dark. The moon/sun button switches between light and dark. The choice is remembered in this browser.

## AI services

Marrow has no AI key of its own; you bring yours.

1. **Add providers.** Add each AI service you have a key for: OpenRouter, OpenAI, Claude, Gemini, a local Ollama, or anything else that uses the OpenAI chat format. Each has its own address and key.
2. **Pick models.** "Find models" lists what a provider offers. Pick from the list, or type a model name.
3. **Order them.** Use ↑ and ↓ to set the order they are tried in. If one fails or is rate-limited, the next one answers, and the models can come from different providers.
4. **Figures** have their own list, because the model has to accept images.
5. **Test the connection** to see which model answered.

Keys are stored encrypted on the server and are never sent back to the browser. Settings only shows the last four characters. On OpenRouter only free models are used, unless you allow paid ones. Other providers are always asked, so choose their models with care.

## Transcription

- **YouTube helper** (yt-dlp): downloads with one click and fetches a video's own captions.
- **Whisper**: transcribes on the server's computer. On Windows, Marrow downloads the program for you; on a Mac, run `brew install whisper-cpp` first. Then download a model, from *Tiny* (fastest) to *Medium* (most accurate, slow on a laptop).

Everything downloaded here can be removed again from the same screen.

## Log out

The arrow button at the bottom of the rail logs you out.
