# SyncReader MVP — word-level sync

A local-first React/Vite prototype for reading a DRM-free EPUB while listening to an MP3 audiobook.

## Run locally

Requires Node.js 20+.

```bash
npm install
npm run dev
```

Open the local URL Vite prints. Load the EPUB, MP3, and a JSON file containing word-level start/end timestamps.

## Accurate timing input

The app expects timestamps measured from the beginning of the exact MP3 file:

```json
{
  "words": [
    { "text": "The", "start": 0.12, "end": 0.31 },
    { "text": "room", "start": 0.32, "end": 0.61 },
    { "text": "was", "start": 0.62, "end": 0.81 },
    { "text": "quiet.", "start": 0.82, "end": 1.25 }
  ]
}
```

`sample-alignment.json` is only a format example; its times/text are not aligned to your book.

### Generate timestamps

Use a forced-alignment model such as WhisperX with a transcript that matches the audiobook. Run alignment against the same MP3 you will load into SyncReader. WhisperX installation varies by OS/GPU, so follow its current official installation instructions. Export its JSON output, then convert it:

```bash
python scripts/convert_whisperx.py whisperx-output.json aligned-words.json
```

Import `aligned-words.json` in the app. If your WhisperX export uses a different schema, adjust the converter to the actual JSON shape.

## What this version implements

- EPUB rendering and EPUB page navigation.
- Local MP3 playback, seek, and playback speed.
- Word-level timestamp JSON import.
- A one-time pass through EPUB spine text to create CFI anchors for words.
- Monotonic transcript-to-EPUB word matching with a bounded lookahead.
- CFI-based active-word highlight, sentence-level pale highlighting, and automatic `rendition.display(cfi)` when playback reaches a word outside the visible EPUB section.

## Known limitations / next engineering tasks

- Exact mapping depends on the transcript and EPUB edition matching. Skipped, repeated, or edited words may cause alignment drift; inspect the mapped-word count and improve matching for your book if needed.
- Some EPUBs have unusual markup, footnotes, repeated headers, or hyphenated line breaks. Add chapter-aware matching and a manual correction UI for production.
- Page-turn behavior depends on EPUB.js CFI navigation and should be tested against the actual book/browser. This prototype moves to the target CFI when its section is not currently rendered; fine-grained page visibility handling can be improved.
- Sentence highlighting is applied to mapped word ranges in the current sentence. It is an MVP implementation, not a substitute for comprehensive EPUB layout testing.
- For long books, indexing all spine text in the browser may take time. Add progress reporting and cache the mapping locally in a future version.
- Android packaging with Capacitor comes after synchronization works reliably in the web app.

All book/audio processing stays in the browser except for any separate alignment step you choose to run. Do not upload copyrighted books/audio to a service unless you have the rights and are comfortable with that service's terms.


## Android APK build from your phone (cloud build)

This repository includes a GitHub Actions workflow at `.github/workflows/android-apk.yml`. You do not need Android Studio on your phone; GitHub's cloud runner builds a debug APK.

1. On your Android phone, sign in to GitHub and create a **new empty repository**.
2. Upload the extracted project files/folders to the repository (GitHub mobile web upload may be awkward for folders; a browser-based IDE such as github.dev or Replit can be easier). Make sure `.github/workflows/android-apk.yml` is included and the default branch is `main`.
3. Open the repository's **Actions** tab and run **Build Android APK** (or push/commit to `main`).
4. When the workflow succeeds, open that workflow run, scroll to **Artifacts**, and download `SyncReader-debug-apk`.
5. Extract the artifact ZIP and install `app-debug.apk`. Android may ask you to allow installs from your browser/files app. Only install APKs built from your own repository.

This creates a debug APK for personal testing, not a Play Store release. The build workflow is provided but has not been executed or verified here. The app still needs real-device testing, especially Android file picker behavior, long-book performance, and audio playback while the screen is off.
