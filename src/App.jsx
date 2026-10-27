import React, { useEffect, useRef, useState } from "react";
import ePub from "epubjs";
import { BookOpen, Headphones, Upload, Play, Pause, SkipBack, SkipForward, ChevronLeft, ChevronRight, FileAudio, FileText, Info } from "lucide-react";

function normalizeToken(s) {
  return (s || "").toLocaleLowerCase("en").replace(/[’‘]/g, "'").replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, "");
}
const fmt = n => {
  if (!Number.isFinite(n)) return "0:00";
  const m = Math.floor(n / 60), s = Math.floor(n % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
};

/* Expected alignment JSON:
{
  "words": [
    { "text": "The", "start": 0.12, "end": 0.31 },
    { "text": "room", "start": 0.32, "end": 0.61 }
  ]
}
Times are seconds from the beginning of the MP3. Prefer a forced aligner output.
*/
function validateAlignment(data) {
  const rows = Array.isArray(data) ? data : data?.words;
  if (!Array.isArray(rows) || !rows.length) throw new Error("Alignment JSON must contain a non-empty words array.");
  const words = rows.map((w, i) => ({
    text: String(w.text ?? w.word ?? "").trim(),
    start: Number(w.start ?? w.start_time),
    end: Number(w.end ?? w.end_time),
    index: i
  }));
  if (words.some(w => !w.text || !Number.isFinite(w.start) || !Number.isFinite(w.end) || w.start < 0 || w.end <= w.start)) {
    throw new Error("Every word needs text plus valid start/end timestamps in seconds.");
  }
  return words.sort((a, b) => a.start - b.start);
}

function splitSentences(words) {
  const result = [];
  let current = [];
  for (let i = 0; i < words.length; i++) {
    current.push(i);
    if (/[.!?][”’\"')\]]*$/.test(words[i].text)) { result.push(current); current = []; }
  }
  if (current.length) result.push(current);
  return result;
}

export default function App() {
  const viewerRef = useRef(null);
  const renditionRef = useRef(null);
  const bookRef = useRef(null);
  const audioRef = useRef(null);
  const wordMapRef = useRef([]);
  const activeWordRef = useRef(-1);
  const lastSentenceRef = useRef(-1);
  const lastDisplayCfiRef = useRef("");
  const [epubName, setEpubName] = useState("");
  const [audioName, setAudioName] = useState("");
  const [alignmentName, setAlignmentName] = useState("");
  const [audioUrl, setAudioUrl] = useState("");
  const [words, setWords] = useState([]);
  const [wordMap, setWordMap] = useState([]);
  const [activeWord, setActiveWord] = useState(-1);
  const [activeSentence, setActiveSentence] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [bookReady, setBookReady] = useState(false);
  const [indexing, setIndexing] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("Load a DRM-free EPUB, an MP3, and a word-level alignment JSON file.");
  const [rate, setRate] = useState("1");

  const loadEpub = async file => {
    setError(""); setBookReady(false); setWordMap([]); wordMapRef.current = [];
    try {
      if (bookRef.current) { bookRef.current.destroy(); bookRef.current = null; }
      const book = ePub(await file.arrayBuffer());
      bookRef.current = book;
      const rendition = book.renderTo(viewerRef.current, { width: "100%", height: "100%", spread: "none", flow: "paginated", manager: "default" });
      renditionRef.current = rendition;
      rendition.themes.default({
        "body": { "font-family": "Georgia, serif !important", "color": "#262626", "line-height": "1.8 !important", "padding": "12px !important" },
        "p": { "margin": "0 0 1em !important" },
        ".sync-active-sentence": { "background": "#fff0b3 !important", "border-radius": "3px" },
        ".sync-active-word": { "background": "#ffbd4a !important", "color": "#171717 !important", "border-radius": "3px", "font-weight": "700 !important" }
      });
      await rendition.display();
      setEpubName(file.name); setBookReady(true);
      setNotice("EPUB loaded. Load an MP3 and a word-level alignment JSON to map words into the book.");
    } catch (e) { setError("Could not open this EPUB. Try a standard, DRM-free .epub file."); console.error(e); }
  };

  const loadAudio = file => {
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    const url = URL.createObjectURL(file);
    setAudioUrl(url); setAudioName(file.name); setCurrentTime(0); setDuration(0); setPlaying(false);
    setNotice("MP3 loaded. Next, import alignment JSON generated from this exact recording.");
  };

  // Build stable EPUB CFI ranges for each word in reading order. This is done once per book/alignment pair.
  const mapWordsToEpub = async (alignedWords) => {
    const book = bookRef.current;
    if (!book) throw new Error("Open the EPUB before importing alignment JSON.");
    setIndexing(true);
    try {
      await book.ready;
      const tokens = [];
      const spineItems = book.spine?.spineItems || [];
      for (const section of spineItems) {
        let doc;
        try { doc = await section.load(book.load.bind(book)); }
        catch (e) { console.warn("Skipping EPUB section", section.href, e); continue; }
        if (!doc?.body) continue;
        const walker = doc.createTreeWalker(doc.body, 4);
        let node;
        while ((node = walker.nextNode())) {
          if (!node.nodeValue || !node.nodeValue.trim()) continue;
          const re = /[\p{L}\p{N}][\p{L}\p{N}'’\-]*/gu;
          let match;
          while ((match = re.exec(node.nodeValue))) {
            const range = doc.createRange();
            range.setStart(node, match.index); range.setEnd(node, match.index + match[0].length);
            let cfi = null;
            try { cfi = section.cfiFromRange(range); } catch {}
            if (cfi) tokens.push({ token: normalizeToken(match[0]), text: match[0], cfi, sectionIndex: section.index, href: section.href });
          }
        }
        try { section.unload(); } catch {}
      }
      if (!tokens.length) throw new Error("No readable words were found in this EPUB.");

      // Monotonic matching tolerates punctuation and modest transcription differences, but never guesses backwards.
      let cursor = 0;
      const mapped = alignedWords.map((w, i) => {
        const target = normalizeToken(w.text);
        if (!target) return { ...w, cfi: null, sectionIndex: null, sentenceIndex: -1 };
        let found = -1;
        const max = Math.min(tokens.length, cursor + 18);
        for (let j = cursor; j < max; j++) {
          if (tokens[j].token === target) { found = j; break; }
        }
        // If local lookahead fails, search further ahead for the next exact word; this helps with short omissions.
        if (found < 0) {
          for (let j = max; j < Math.min(tokens.length, cursor + 180); j++) {
            if (tokens[j].token === target) { found = j; break; }
          }
        }
        if (found < 0) return { ...w, cfi: null, sectionIndex: null, sentenceIndex: -1 };
        cursor = found + 1;
        return { ...w, cfi: tokens[found].cfi, sectionIndex: tokens[found].sectionIndex, href: tokens[found].href, epubText: tokens[found].text, sentenceIndex: -1 };
      });
      let sentenceIndex = 0;
      let sentenceStart = 0;
      for (let i = 0; i < mapped.length; i++) {
        mapped[i].sentenceIndex = sentenceIndex;
        if (/[.!?][”’\"')\]]*$/.test(mapped[i].text)) { sentenceIndex++; sentenceStart = i + 1; }
      }
      // Fill any trailing words into the last sentence; sentenceStart is intentionally unused for mapping.
      const matched = mapped.filter(w => w.cfi).length;
      if (matched < alignedWords.length * 0.55) {
        throw new Error(`Only ${matched} of ${alignedWords.length} words matched the EPUB. Check that the transcript matches this edition and starts at the same point.`);
      }
      setWordMap(mapped); wordMapRef.current = mapped;
      setNotice(`Mapped ${matched} of ${alignedWords.length} aligned words to EPUB locations. Unmatched words will be skipped.`);
      return mapped;
    } finally { setIndexing(false); }
  };

  const loadAlignment = async file => {
    setError("");
    try {
      const parsed = validateAlignment(JSON.parse(await file.text()));
      setWords(parsed);
      setAlignmentName(file.name);
      if (bookRef.current) await mapWordsToEpub(parsed);
      else setNotice("Alignment loaded. Open the EPUB to map its words to book locations.");
    } catch (e) { setError(e.message || "Could not read alignment JSON."); }
  };

  const highlightWord = async index => {
    const rendition = renditionRef.current;
    const mapped = wordMapRef.current;
    if (!rendition || index < 0 || index >= mapped.length) return;
    const current = mapped[index];
    if (!current?.cfi) return;
    const previousIndex = activeWordRef.current;
    const previous = previousIndex >= 0 ? mapped[previousIndex] : null;
    try {
      if (previous?.cfi) rendition.annotations.remove(previous.cfi, "highlight");
      // Apply a pale sentence highlight to each mapped word in the current sentence.
      if (lastSentenceRef.current !== current.sentenceIndex) {
        if (lastSentenceRef.current >= 0) {
          mapped.forEach(w => {
            if (w.cfi && w.sentenceIndex === lastSentenceRef.current) rendition.annotations.remove(w.cfi, "highlight");
          });
        }
        mapped.forEach(w => {
          if (w.cfi && w.sentenceIndex === current.sentenceIndex) {
            rendition.annotations.add("highlight", w.cfi, {}, null, "sync-active-sentence");
          }
        });
        lastSentenceRef.current = current.sentenceIndex;
      } else if (previous?.cfi && previous.sentenceIndex === current.sentenceIndex) {
        // Removing the previous word highlight also removes its annotation at that CFI; restore the sentence shade.
        rendition.annotations.add("highlight", previous.cfi, {}, null, "sync-active-sentence");
      }
      // Use EPUB CFI ranges, not a browser selection: these remain anchored through reflow.
      const contents = rendition.getContents();
      const targetDoc = (() => { try { return bookRef.current.getRange(current.cfi).startContainer.ownerDocument; } catch { return null; } })();
      const location = rendition.currentLocation();
      let isVisible = targetDoc ? contents.some(c => c.document === targetDoc) : location?.start?.index === current.sectionIndex;
      // If this is the same chapter but the target CFI lies outside the visible page range, navigate to it.
      try {
        const CFI = ePub.CFI;
        if (location?.start?.cfi && location?.end?.cfi && CFI?.compare && location.start.index === current.sectionIndex) {
          const before = CFI.compare(current.cfi, location.start.cfi) < 0;
          const after = CFI.compare(current.cfi, location.end.cfi) > 0;
          isVisible = !before && !after;
        }
      } catch {}
      if (!isVisible && current.cfi !== lastDisplayCfiRef.current) {
        await rendition.display(current.cfi);
        lastDisplayCfiRef.current = current.cfi;
      }
      rendition.annotations.add("highlight", current.cfi, {}, null, "sync-active-word");
      activeWordRef.current = index;
      setActiveWord(index);
      setActiveSentence(current.sentenceIndex);
    } catch (e) { console.debug("Could not highlight CFI", current.cfi, e); }
  };

  useEffect(() => {
    if (!bookReady || !words.length || !bookRef.current) return;
    let cancelled = false;
    mapWordsToEpub(words).catch(e => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
    // Re-map when a different EPUB is loaded. Alignment JSON is kept in state.
  }, [bookReady, epubName]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onTime = () => {
      const t = audio.currentTime;
      setCurrentTime(t);
      const list = wordMapRef.current;
      if (!list.length) return;
      // Binary search for the latest word whose start <= current time.
      let lo = 0, hi = list.length - 1, candidate = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (list[mid].start <= t) { candidate = mid; lo = mid + 1; }
        else hi = mid - 1;
      }
      if (candidate >= 0 && t <= list[candidate].end + 0.02 && candidate !== activeWordRef.current) highlightWord(candidate);
    };
    const onMeta = () => setDuration(audio.duration || 0);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onEnded = () => setPlaying(false);
    audio.addEventListener("timeupdate", onTime);
    audio.addEventListener("loadedmetadata", onMeta);
    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("ended", onEnded);
    return () => {
      audio.removeEventListener("timeupdate", onTime);
      audio.removeEventListener("loadedmetadata", onMeta);
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("ended", onEnded);
    };
  }, [audioUrl]);

  const seek = t => { if (audioRef.current) audioRef.current.currentTime = Math.max(0, Math.min(duration || Infinity, t)); };
  const togglePlay = async () => {
    if (!audioRef.current) return;
    if (audioRef.current.paused) { try { await audioRef.current.play(); } catch { setError("Your browser could not play this audio file."); } }
    else audioRef.current.pause();
  };
  const displayWords = wordMap.length ? wordMap : words;
  const visibleSentenceWords = activeSentence >= 0
    ? displayWords.filter(w => w.sentenceIndex === activeSentence)
    : [];

  return <div className="app-shell">
    <header className="topbar">
      <div className="brand-mark"><BookOpen size={22}/></div>
      <div><div className="brand">SyncReader</div><div className="tagline">Read along with your audiobook</div></div>
      <div className="top-pill">MVP · local files</div>
    </header>
    <main className="layout">
      <section className="reader-panel panel">
        <div className="panel-head"><div><div className="eyebrow">YOUR BOOK</div><h1>{epubName || "Choose an EPUB"}</h1></div>
          <label className="file-button"><Upload size={16}/> Open EPUB<input type="file" accept=".epub,application/epub+zip" onChange={e => e.target.files?.[0] && loadEpub(e.target.files[0])}/></label>
        </div>
        <div className="reader-frame">
          {!bookReady && <div className="empty-reader"><BookOpen size={42}/><h2>Your reading space</h2><p>Open a DRM-free EPUB to start.</p></div>}
          <div ref={viewerRef} className="epub-viewer" />
        </div>
        <div className="page-controls">
          <button className="icon-button" onClick={() => renditionRef.current?.prev()} disabled={!bookReady}><ChevronLeft size={18}/> Previous</button>
          <span>EPUB navigation</span>
          <button className="icon-button" onClick={() => renditionRef.current?.next()} disabled={!bookReady}>Next <ChevronRight size={18}/></button>
        </div>
      </section>
      <aside className="side-column">
        <section className="panel audio-panel">
          <div className="panel-head compact"><div><div className="eyebrow">NOW PLAYING</div><h2>{audioName || "Your audiobook"}</h2></div><Headphones size={22}/></div>
          <label className="upload-drop"><FileAudio size={22}/><span><strong>Choose audio file</strong><small>MP3, M4A, WAV, or browser-supported audio</small></span><input type="file" accept="audio/*" onChange={e => e.target.files?.[0] && loadAudio(e.target.files[0])}/></label>
          {audioUrl && <audio ref={audioRef} src={audioUrl} preload="metadata" />}
          <div className="player-controls">
            <button className="plain-control" onClick={() => seek(currentTime - 15)} disabled={!audioUrl}><SkipBack size={19}/><small>15s</small></button>
            <button className="play-button" onClick={togglePlay} disabled={!audioUrl}>{playing ? <Pause fill="currentColor" size={22}/> : <Play fill="currentColor" size={22}/>}</button>
            <button className="plain-control" onClick={() => seek(currentTime + 15)} disabled={!audioUrl}><SkipForward size={19}/><small>15s</small></button>
          </div>
          <div className="timeline-labels"><span>{fmt(currentTime)}</span><span>{fmt(duration)}</span></div>
          <input aria-label="Audio position" className="timeline" type="range" min="0" max={duration || 100} step="0.1" value={Math.min(currentTime, duration || 100)} onChange={e => seek(Number(e.target.value))} disabled={!audioUrl || !duration}/>
          <div className="speed-row"><span>Playback speed</span><select value={rate} onChange={e => {setRate(e.target.value); if(audioRef.current) audioRef.current.playbackRate = Number(e.target.value)}}><option value="0.75">0.75×</option><option value="1">1×</option><option value="1.25">1.25×</option><option value="1.5">1.5×</option><option value="2">2×</option></select></div>
        </section>
        <section className="panel sync-panel">
          <div className="panel-head compact"><div><div className="eyebrow">SYNC STATUS</div><h2>Text alignment</h2></div><FileText size={21}/></div>
          <label className="upload-drop slim"><FileText size={21}/><span><strong>{alignmentName || "Import word alignment (.json)"}</strong><small>One start/end timestamp per spoken word</small></span><input type="file" accept=".json,application/json" onChange={e => e.target.files?.[0] && loadAlignment(e.target.files[0])}/></label>
          <div className="sync-stat"><span>Aligned words</span><strong>{words.length}</strong></div>
          <div className="sync-stat"><span>Mapped to EPUB</span><strong>{wordMap.filter(w => w.cfi).length}</strong></div>
          <div className="sync-stat"><span>Current word</span><strong>{activeWord >= 0 ? `${activeWord + 1} / ${words.length}` : "—"}</strong></div>
          <div className="caption-preview">
            <div className="caption-label">LIVE TRANSCRIPT · {activeSentence >= 0 ? `SENTENCE ${activeSentence + 1}` : "WAITING"}</div>
            {activeWord >= 0 && visibleSentenceWords.length ? <p>{visibleSentenceWords.map((w) => <React.Fragment key={w.index}><span className={w.index === activeWord ? "current-word" : ""}>{w.text}</span>{" "}</React.Fragment>)}</p> : <p className="muted">Import a word-level JSON alignment file generated from this exact MP3. The active word will be highlighted in the EPUB.</p>}
          </div>
          {indexing && <div className="sync-stat"><span>Indexing EPUB text…</span><strong>Working</strong></div>}
          <button className="secondary-button" onClick={() => {setError(""); setNotice("For accurate sync, generate word timestamps from the exact MP3 and a matching transcript using a forced-alignment model. See README for the JSON format.")}}><Info size={15}/> How synchronization works</button>
        </section>
      </aside>
    </main>
    <footer className="statusbar">
      <span className={`status-dot ${error ? "error-dot" : ""}`}></span>
      <span>{error || notice}</span>
      <span className="footer-right">Files stay in this browser session</span>
    </footer>
  </div>;
}
