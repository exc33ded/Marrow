---
covers: [server.js]
---

# Transcription: Whisper and yt-dlp

Both run on the server's own computer, from files under `./data/whisper/`, or `DATA_DIR/whisper/` when that is set (`WH`). They stay with the app, not in the library folder, so moving the library does not copy them.

> ponytail note in the code: Whisper and yt-dlp are shared by every user of the server. Fine on your own machine; a small free host can't run them.

## Downloads

`POST /api/whisper?what=` starts a download, and `DELETE` removes it or stops it. `what` is one of:

| `what` | Gets |
|---|---|
| `model:<id>` | `ggml-<id>.bin` from Hugging Face (`ggerganov/whisper.cpp`). Ids are in `WMODELS`: `tiny.en`, `base.en`, `small`, `large-v3-turbo-q5_0`, `medium`. |
| `program` | Windows only: `getProgram()` finds the newest numbered whisper.cpp release that has `whisper-bin-x64.zip`, then unpacks it into `whisper/bin` with Windows' own `tar.exe` (a Git or MSYS tar would misread `D:\` paths). On a Mac, use `brew install whisper-cpp`, which `onPath()` then finds. |
| `ytdlp` | the yt-dlp build for the platform, from its GitHub releases |

- **Progress.** Downloads run in the background (`start()`, `download()`) and write to `.part`, renamed when complete, so a cancelled download leaves nothing behind. `GET /api/whisper` reports progress (`whisperState()`) and the Settings page polls it.
- **Choosing a model.** `PUT /api/whisper/use?id=` picks the model; it must already be downloaded.

## Transcribing

- **`POST /api/transcribe?id=`.** The browser streams 16 kHz mono WAV, up to 900 MB. `transcribe()` runs `whisper-cli -oj` using all CPU cores but one. The language is `en` for `.en` models, otherwise `auto`. Progress is read from stderr.
- **`GET /api/transcribe?id=`.** Returns `{ pct }` while it runs, then `{ segs }` or `{ error }` once (the finished job is cleared after it is read).
- **`DELETE`.** Kills the run.
- **Clean-up.** Temporary `.wav` and `.json` files are deleted when it ends.

## YouTube

- **Audio.** `GET /api/ytaudio?vid=` (11-character id). yt-dlp downloads audio only (`bestaudio[ext=m4a]/bestaudio`) and streams it to the browser, then deletes the file.
- **Captions.** `GET /api/ytsubs?vid=`. `youtubeCaptions()` asks yt-dlp for the video's languages and caption tracks. It prefers human-written tracks to auto-generated ones, and the video's own language to English.
  - It takes `json3` (parsed by `json3Segs()`) and falls back to VTT/SRT (`capsSegs()`, which merges YouTube's rolling repeated cues).
  - `fetchCaptions()` follows redirects only within `youtube.com` and `googlevideo.com`.
