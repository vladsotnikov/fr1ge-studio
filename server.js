import express from "express";
import multer from "multer";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import { randomUUID, createHash } from "crypto";
import { promises as fs } from "fs";
import { createReadStream, createWriteStream, mkdirSync, existsSync as _existsSync } from "fs";
const fsSync = { existsSync: _existsSync };
import { pipeline } from "stream/promises";
import { spawn } from "child_process";

const app = express();
const upload = multer({
  limits: {
    fileSize: 250 * 1024 * 1024,
    fieldSize: 220 * 1024 * 1024,
    fields: 5000
  }
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const OUTPUT_DIR = path.join(__dirname, "outputs");
const CUTTER_UPLOAD_DIR = path.join(os.tmpdir(), "vss_cutter_uploads");
const CUTTER_MAX_FILE_BYTES = 50 * 1024 * 1024 * 1024;
const CUTTER_MAX_FILE_LABEL = "50 GB";

await fs.mkdir(OUTPUT_DIR, { recursive: true });
mkdirSync(CUTTER_UPLOAD_DIR, { recursive: true });

const cutterUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      mkdirSync(CUTTER_UPLOAD_DIR, { recursive: true });
      cb(null, CUTTER_UPLOAD_DIR);
    },
    filename: (_req, file, cb) => {
      const ext = safeExtFromName(file.originalname, ".mp4");
      cb(null, `source_${Date.now()}_${randomUUID()}${ext}`);
    }
  }),
  limits: {
    fileSize: CUTTER_MAX_FILE_BYTES,
    fieldSize: 128 * 1024 * 1024,
    fields: 200
  }
});

app.use(express.json({ limit: "32mb" }));
app.use("/outputs", express.static(OUTPUT_DIR));
app.use(express.static(path.join(__dirname, "public")));

const STOP_WORDS = new Set([
  "і", "й", "та", "в", "у", "на", "по", "для", "до", "з", "із", "це", "як", "про",
  "the", "a", "an", "of", "to", "for", "in", "on", "and", "is", "are"
]);

const STOCK_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const stockApiCache = new Map();
const OPENAI_AUDIO_MAX_BYTES = 25 * 1024 * 1024;

function getStockCache(cacheKey) {
  const hit = stockApiCache.get(cacheKey);
  if (!hit) return null;
  if (Date.now() - hit.ts > STOCK_CACHE_TTL_MS) {
    stockApiCache.delete(cacheKey);
    return null;
  }
  return hit.value;
}

function setStockCache(cacheKey, value) {
  stockApiCache.set(cacheKey, { ts: Date.now(), value });
}

function tokenize(text) {
  return (String(text || "").toLowerCase().match(/[a-zа-яіїєґ0-9]+/gi) || []);
}

function extractKeywords(text, limit = 10) {
  const words = tokenize(text);
  const uniq = [];
  const seen = new Set();
  for (const w of words) {
    if (w.length < 3 || STOP_WORDS.has(w) || seen.has(w)) continue;
    seen.add(w);
    uniq.push(w);
    if (uniq.length >= limit) break;
  }
  return uniq;
}

function toSegment(id, start, end, text) {
  const safeStart = Number.isFinite(start) ? Number(start) : 0;
  const safeEnd = Number.isFinite(end) ? Number(end) : safeStart + 1;
  return {
    id,
    start: Math.max(0, safeStart),
    end: Math.max(safeStart + 0.35, safeEnd),
    text: String(text || "").trim(),
    keywords: extractKeywords(text)
  };
}

function fallbackSegmentsFromText(text) {
  const cleaned = String(text || "").trim();
  if (!cleaned) return [];

  const sentences = cleaned
    .split(/(?<=[.!?])\s+/)
    .map((x) => x.trim())
    .filter(Boolean);

  if (!sentences.length) return [];

  let cursor = 0;
  return sentences.map((sentence, idx) => {
    const words = tokenize(sentence).length;
    const duration = Math.min(8, Math.max(1.8, words * 0.42));
    const seg = toSegment(idx, cursor, cursor + duration, sentence);
    cursor += duration;
    return seg;
  });
}

// Word-level VAD splitter. Uses Whisper's `words[]` (start/end/word) when
// available to cut on real silences and sentence-ending punctuation instead
// of relying on Whisper's coarse segment boundaries.
//
// Output shape is identical to buildContextSegments — toSegment() produces the
// same { id, start, end, text, keywords } objects, so downstream matching
// (CLIP embed-match, asset selection) is unaffected.
function buildVadSegments(words, fallbackSegments, rawText) {
  const cleaned = Array.isArray(words)
    ? words
        .map((w) => ({
          text: String(w.word || w.text || "").replace(/\s+/g, " ").trim(),
          start: Number(w.start || 0),
          end: Number(w.end || w.start || 0)
        }))
        .filter((w) => w.text && Number.isFinite(w.start) && Number.isFinite(w.end) && w.end >= w.start)
    : [];

  // No usable word timestamps — fall back to the segment-based splitter.
  if (cleaned.length < 4) return buildContextSegments(fallbackSegments, rawText);

  const SILENCE_GAP = 0.42;       // real pause between words → sentence break
  const SENTENCE_MIN_DUR = 1.4;   // don't split right after a single short sentence
  const SENTENCE_MIN_WORDS = 3;   // need a few words before honoring punctuation
  const MAX_DURATION = 7.5;       // hard cap to keep clips paceable
  const MAX_WORDS = 22;
  const MIN_TAIL_DURATION = 1.0;  // merge sub-1s tail segment into previous

  const out = [];
  let current = null;

  function flush() {
    if (!current) return;
    const text = current.parts.join(" ").replace(/\s+/g, " ").trim();
    if (text) {
      out.push(toSegment(out.length, current.start, current.end, text));
    }
    current = null;
  }

  for (const w of cleaned) {
    if (!current) {
      current = { start: w.start, end: w.end, parts: [w.text], wordCount: 1 };
      continue;
    }

    const gap = Math.max(0, w.start - current.end);
    const duration = current.end - current.start;
    const lastPart = current.parts[current.parts.length - 1] || "";
    const endsSentence = /[.!?…]\s*$/.test(lastPart);

    const shouldSplit =
      (gap >= SILENCE_GAP && duration >= SENTENCE_MIN_DUR) ||
      (endsSentence && duration >= SENTENCE_MIN_DUR && current.wordCount >= SENTENCE_MIN_WORDS) ||
      duration >= MAX_DURATION ||
      current.wordCount >= MAX_WORDS;

    if (shouldSplit) {
      flush();
      current = { start: w.start, end: w.end, parts: [w.text], wordCount: 1 };
    } else {
      current.end = Math.max(current.end, w.end);
      current.parts.push(w.text);
      current.wordCount += 1;
    }
  }

  flush();

  // Merge a tiny final segment into the previous one — avoids "blip" clips
  // that confuse asset matching and look choppy on screen.
  if (out.length >= 2) {
    const last = out[out.length - 1];
    if (last.end - last.start < MIN_TAIL_DURATION) {
      const prev = out[out.length - 2];
      const merged = toSegment(prev.id, prev.start, last.end, `${prev.text} ${last.text}`);
      out.splice(out.length - 2, 2, merged);
    }
  }

  if (!out.length) return buildContextSegments(fallbackSegments, rawText);
  return out;
}

function buildContextSegments(whisperSegments, rawText) {
  const source = Array.isArray(whisperSegments)
    ? whisperSegments
      .map((s, idx) => toSegment(idx, Number(s.start || 0), Number(s.end || 0), String(s.text || "")))
      .filter((s) => s.text)
    : [];

  if (!source.length) return fallbackSegmentsFromText(rawText);

  const out = [];
  let current = null;

  function flush() {
    if (!current) return;
    const text = current.parts.join(" ").replace(/\s+/g, " ").trim();
    if (!text) {
      current = null;
      return;
    }
    out.push(toSegment(out.length, current.start, current.end, text));
    current = null;
  }

  for (const seg of source) {
    if (!current) {
      current = { start: seg.start, end: seg.end, parts: [seg.text], wordCount: tokenize(seg.text).length };
      continue;
    }

    const gap = Math.max(0, seg.start - current.end);
    const currentDuration = Math.max(0.3, current.end - current.start);
    const segWords = tokenize(seg.text).length;
    const endsSentence = /[.!?…]\s*$/.test(current.parts[current.parts.length - 1]);

    const shouldSplit =
      gap > 0.85 ||
      currentDuration >= 8.5 ||
      current.wordCount >= 24 ||
      (endsSentence && currentDuration >= 1.8 && segWords >= 3);

    if (shouldSplit) {
      flush();
      current = { start: seg.start, end: seg.end, parts: [seg.text], wordCount: segWords };
      continue;
    }

    current.end = Math.max(current.end, seg.end);
    current.parts.push(seg.text);
    current.wordCount += segWords;
  }

  flush();

  if (!out.length) return fallbackSegmentsFromText(rawText);
  return out;
}

function buildFixedSegments(whisperSegments, rawText, fixedSeconds = 4) {
  const chunkSeconds = Math.min(30, Math.max(1, Number(fixedSeconds) || 4));
  const source = Array.isArray(whisperSegments)
    ? whisperSegments
      .map((s, idx) => toSegment(idx, Number(s.start || 0), Number(s.end || 0), String(s.text || "")))
      .filter((s) => s.text)
    : [];

  if (!source.length) {
    const fallback = fallbackSegmentsFromText(rawText);
    if (!fallback.length) return [];

    let cursor = 0;
    const out = [];
    for (const seg of fallback) {
      const words = tokenize(seg.text);
      const wordsPerChunk = Math.max(1, Math.round(words.length / Math.max(1, Math.ceil((seg.end - seg.start) / chunkSeconds))));
      for (let i = 0; i < words.length; i += wordsPerChunk) {
        const part = words.slice(i, i + wordsPerChunk).join(" ");
        const start = cursor;
        const end = cursor + chunkSeconds;
        out.push(toSegment(out.length, start, end, part));
        cursor = end;
      }
    }
    return out;
  }

  const endTime = Math.max(...source.map((s) => s.end), 0);
  const bucketCount = Math.max(1, Math.ceil(endTime / chunkSeconds));
  const buckets = Array.from({ length: bucketCount }, () => []);

  for (const seg of source) {
    const words = String(seg.text || "").replace(/\s+/g, " ").trim().split(/\s+/).filter(Boolean);
    if (!words.length) continue;

    const segStart = Math.max(0, Number(seg.start || 0));
    const segEnd = Math.max(segStart + 0.05, Number(seg.end || segStart + chunkSeconds));
    const segDuration = Math.max(0.05, segEnd - segStart);

    // Whisper often returns one long segment that spans several fixed buckets.
    // Distribute words by estimated timestamps instead of dumping the whole segment into its first bucket.
    words.forEach((word, wordIndex) => {
      const ratio = (wordIndex + 0.5) / Math.max(1, words.length);
      const estimatedTime = segStart + ratio * segDuration;
      const bucketIndex = Math.max(0, Math.min(bucketCount - 1, Math.floor(estimatedTime / chunkSeconds)));
      buckets[bucketIndex].push(word);
    });
  }

  const out = [];
  for (let i = 0; i < bucketCount; i += 1) {
    const bucketStart = i * chunkSeconds;
    const bucketEnd = Math.min(endTime, bucketStart + chunkSeconds);
    const text = buckets[i].join(" ").replace(/\s+/g, " ").trim();

    if (text) {
      out.push(toSegment(out.length, bucketStart, bucketEnd, text));
    } else {
      const prev = out[out.length - 1]?.text || "";
      const next = buckets.slice(i + 1).find((parts) => parts.length)?.join(" ") || "";
      const context = next || prev;
      if (context) {
        out.push(toSegment(out.length, bucketStart, bucketEnd, context.split(/\s+/).slice(0, 10).join(" ")));
      }
    }
  }

  return out;
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: options.env ? { ...process.env, ...options.env } : process.env
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeoutMs = Number(options.timeoutMs || 0);
    const timer = timeoutMs > 0
      ? setTimeout(() => {
          if (settled) return;
          settled = true;
          child.kill("SIGKILL");
          reject(new Error(`${command} timed out after ${Math.round(timeoutMs / 1000)}s`));
        }, timeoutMs)
      : null;

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(`${command} exited with code ${code}: ${stderr.slice(-1000) || stdout.slice(-1000)}`));
    });
  });
}

let ffmpegChecked = false;
let ffmpegBin = "ffmpeg";
let ffprobeBin = "ffprobe";
async function ensureFfmpegAvailable() {
  if (ffmpegChecked) return;
  const ffmpegCandidates = [
    process.env.FFMPEG_BIN,
    "/opt/homebrew/bin/ffmpeg",
    "/usr/local/bin/ffmpeg",
    "ffmpeg"
  ].filter(Boolean);
  const ffprobeCandidates = [
    process.env.FFPROBE_BIN,
    "/opt/homebrew/bin/ffprobe",
    "/usr/local/bin/ffprobe",
    "ffprobe"
  ].filter(Boolean);

  const pick = async (candidates) => {
    for (const bin of candidates) {
      try {
        await runCommand(bin, ["-version"]);
        return bin;
      } catch {
        // try next
      }
    }
    return "";
  };

  ffmpegBin = await pick(ffmpegCandidates);
  ffprobeBin = await pick(ffprobeCandidates);
  if (!ffmpegBin || !ffprobeBin) {
    throw new Error("FFmpeg/FFprobe не встановлені або недоступні в PATH. Встанови ffmpeg і перезапусти сервер.");
  }
  ffmpegChecked = true;
}

async function runFfmpeg(args, options = {}) {
  await ensureFfmpegAvailable();
  return runCommand(ffmpegBin, args, options);
}

// ─── Concurrency utilities ────────────────────────────────────────────────────

// Run `fn` over all items with at most `concurrency` parallel executions.
// Results are returned in the original order. Errors propagate per-item via
// the returned { result, error } shape — callers decide how to handle them.
async function parallelMap(items, fn, concurrency = 4) {
  const results = new Array(items.length).fill(null);
  const queue = items.map((item, i) => ({ item, i }));
  async function worker() {
    while (queue.length > 0) {
      const task = queue.shift();
      if (!task) break;
      try {
        results[task.i] = { result: await fn(task.item, task.i), error: null };
      } catch (err) {
        results[task.i] = { result: null, error: err };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

// Detect VideoToolbox hardware H.264 encoder (Apple Silicon / macOS).
// Returns "h264_videotoolbox" when available, falls back to "libx264".
let _hwEncoderCache = null;
async function detectVideoEncoder() {
  if (_hwEncoderCache !== null) return _hwEncoderCache;
  try {
    await ensureFfmpegAvailable();
    const result = await runCommand(ffmpegBin, ["-hide_banner", "-encoders"], {});
    _hwEncoderCache = result.includes("h264_videotoolbox") ? "h264_videotoolbox" : "libx264";
  } catch {
    _hwEncoderCache = "libx264";
  }
  return _hwEncoderCache;
}

// How many clip-build workers to run in parallel.
// Leave 1-2 cores for the OS / main event loop.
const CLIP_CONCURRENCY = Math.max(2, Math.min(6, os.cpus().length - 2));

// Local-asset analyzers parallelize OCR + ffmpeg frame extraction + OpenAI
// vision calls. BLIP is internally serialized via runBlipExclusive, so
// raising this past ~4 only helps the network-bound OpenAI path.
const ANALYZE_CONCURRENCY = Math.max(2, Math.min(4, os.cpus().length - 2));

// Returns FFmpeg video-encode args for a given quality level.
// h264_videotoolbox (Apple Silicon HW encoder) uses bitrate control; libx264
// uses preset+pix_fmt. Both produce yuv420p H.264 at 1280×720.
// Bitrates: clip = intermediate quality, final = output quality.
function videoCodecArgs(quality = "clip") {
  const enc = _hwEncoderCache || "libx264";
  if (enc === "h264_videotoolbox") {
    const br = quality === "final" ? "4500k" : quality === "timeline" ? "5000k" : "3000k";
    return ["-c:v", "h264_videotoolbox", "-b:v", br, "-pix_fmt", "yuv420p"];
  }
  const preset = quality === "final" ? "fast" : "veryfast";
  return ["-c:v", "libx264", "-preset", preset, "-pix_fmt", "yuv420p"];
}
// ─────────────────────────────────────────────────────────────────────────────

async function runFfprobe(args, options = {}) {
  await ensureFfmpegAvailable();
  return runCommand(ffprobeBin, args, options);
}

async function createZipArchive(sourceDir, zipPath) {
  await fs.rm(zipPath, { force: true }).catch(() => {});
  await runCommand("/usr/bin/zip", ["-qr", zipPath, "."], { cwd: sourceDir });
}

async function safeCopyFile(sourcePath, targetPath) {
  const sourceReal = await fs.realpath(sourcePath).catch(() => sourcePath);
  const targetReal = await fs.realpath(targetPath).catch(() => targetPath);
  if (sourceReal === targetReal) return;

  try {
    await fs.copyFile(sourcePath, targetPath);
    return;
  } catch (error) {
    const message = String(error?.message || "");
    if (error?.code !== "EDEADLK" && error?.errno !== 11 && !message.includes("Resource deadlock avoided")) {
      throw error;
    }
  }

  await pipeline(createReadStream(sourcePath), createWriteStream(targetPath));
}

async function mapWithConcurrency(items, limit, mapper) {
  const safeLimit = Math.max(1, Math.min(items.length || 1, Number(limit) || 1));
  const results = new Array(items.length);
  let cursor = 0;

  const workers = Array.from({ length: safeLimit }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  });

  await Promise.all(workers);
  return results;
}

function resolveCutterConcurrency(captionMode, requested) {
  const explicit = Number(requested || process.env.CUTTER_THREADS || 0);
  if (Number.isFinite(explicit) && explicit > 0) {
    return Math.max(1, Math.min(8, Math.floor(explicit)));
  }

  const cpuCount = Array.isArray(os.cpus?.()) ? os.cpus().length : 4;
  const base = Math.max(2, Math.min(4, cpuCount - 1 || 2));
  // BLIP imports a large local model. On macOS/iCloud-backed paths parallel imports can throw EDEADLK.
  return String(captionMode || "blip") === "ocr" ? base : 1;
}

let ytDlpChecked = false;
let ytDlpBin = "yt-dlp";

// Resolve a yt-dlp binary across the many install locations real users have:
// brew (Apple Silicon + Intel), Python framework (python.org installer),
// per-user pip (~/Library/Python/3.x/bin, ~/.local/bin), pipx, asdf, mise,
// and as a last resort whatever PATH resolves via `which`. Also expands
// glob patterns (Python version dirs change with each install).
async function ensureYtDlpAvailable() {
  if (ytDlpChecked) return;

  const home = os.homedir();
  const staticCandidates = [
    process.env.YT_DLP_BIN,
    "/opt/homebrew/bin/yt-dlp",
    "/usr/local/bin/yt-dlp",
    `${home}/.local/bin/yt-dlp`,
    `${home}/.pyenv/shims/yt-dlp`,
    "yt-dlp"
  ].filter(Boolean);

  // Glob-style locations (Python version varies). We expand them by listing
  // the parent dir and matching the pattern, since glob isn't in core Node.
  const globRoots = [
    "/Library/Frameworks/Python.framework/Versions",
    `${home}/Library/Python`
  ];
  const globCandidates = [];
  for (const root of globRoots) {
    try {
      const entries = await fs.readdir(root);
      for (const entry of entries) {
        globCandidates.push(path.join(root, entry, "bin", "yt-dlp"));
      }
    } catch {
      // root doesn't exist on this system — skip
    }
  }

  const allCandidates = [...staticCandidates, ...globCandidates];
  for (const bin of allCandidates) {
    try {
      await runCommand(bin, ["--version"], { timeoutMs: 5000 });
      ytDlpBin = bin;
      ytDlpChecked = true;
      return;
    } catch {
      // try next
    }
  }

  // Last resort: ask a login shell where yt-dlp lives. Catches asdf, mise,
  // nix, custom installs, anything in the user's interactive PATH.
  try {
    const shellPath = process.env.SHELL || "/bin/zsh";
    const result = await runCommand(shellPath, ["-l", "-c", "command -v yt-dlp"], { timeoutMs: 4000 });
    const resolved = String(result.stdout || "").trim().split("\n")[0].trim();
    if (resolved) {
      await runCommand(resolved, ["--version"], { timeoutMs: 5000 });
      ytDlpBin = resolved;
      ytDlpChecked = true;
      return;
    }
  } catch {
    // shell lookup failed — fall through to the install-instructions error
  }

  throw new Error(
    "yt-dlp не знайдено. Встанови його одним з варіантів:\n" +
    "  • brew install yt-dlp     (рекомендовано на macOS)\n" +
    "  • pip3 install --user yt-dlp\n" +
    "  • pipx install yt-dlp\n" +
    "Або задай шлях через змінну YT_DLP_BIN, наприклад:\n" +
    "  YT_DLP_BIN=/path/to/yt-dlp node server.js"
  );
}

let blipChecked = false;
let blipCheckPromise = null;
let blipQueue = Promise.resolve();
let blipPythonBin = "";
let blipScriptPath = "";
let blipInitError = "";

function getPythonSafeEnv() {
  // Point HuggingFace cache at the user's persistent data dir. Without this,
  // models would land in ~/.cache/huggingface and get re-downloaded on every
  // fresh machine, defeating the lazy-install flow.
  const { userModelsCache } = getBlipPaths();
  return {
    ...process.env,
    TOKENIZERS_PARALLELISM: "false",
    HF_HUB_DISABLE_TELEMETRY: "1",
    HF_HUB_OFFLINE: "1",
    TRANSFORMERS_OFFLINE: "1",
    ...(userModelsCache ? { HF_HOME: userModelsCache, TRANSFORMERS_CACHE: userModelsCache } : {})
  };
}

function runBlipExclusive(task) {
  const run = blipQueue.then(task, task);
  blipQueue = run.catch(() => {});
  return run;
}

// Resolve where BLIP runtime lives. Production (Electron): user-installed venv
// in $VSS_USER_DATA_DIR/blip/venv/. Development: project-level .venv-blip/.
// User-installed wins so the lazy install flow (downloaded once via the UI)
// survives DMG updates.
function getBlipPaths() {
  const userBlipRoot = process.env.VSS_USER_DATA_DIR
    ? path.join(process.env.VSS_USER_DATA_DIR, "blip")
    : "";
  const venvPython = process.platform === "win32" ? "Scripts/python.exe" : "bin/python";
  return {
    userBlipRoot,
    userVenvPython: userBlipRoot ? path.join(userBlipRoot, "venv", venvPython) : "",
    userModelsCache: userBlipRoot ? path.join(userBlipRoot, "hf-cache") : "",
    devVenvPython: path.join(__dirname, ".venv-blip", "bin", "python"),
    scriptPath: path.join(__dirname, "tools", "blip_caption.py")
  };
}

async function ensureBlipAvailable() {
  if (blipChecked) return blipPythonBin;
  if (blipCheckPromise) return blipCheckPromise;

  blipCheckPromise = (async () => {
    const { userVenvPython, devVenvPython, scriptPath } = getBlipPaths();
    const candidates = [userVenvPython, devVenvPython].filter(Boolean);

    let foundPython = "";
    for (const candidate of candidates) {
      try {
        await fs.access(candidate);
        foundPython = candidate;
        break;
      } catch { /* try next */ }
    }

    try {
      if (!foundPython) throw new Error("BLIP venv не знайдено — потребує одноразової установки в UI");
      await fs.access(scriptPath);

      // Do not import torch/transformers here. On macOS/Python 3.14 that
      // preflight can fail with "Resource deadlock avoided" even when the
      // real BLIP caption script works. Let the actual script be the source
      // of truth and surface its error per clip if it fails.
      blipPythonBin = foundPython;
      blipScriptPath = scriptPath;
      blipInitError = "";
    } catch (error) {
      blipPythonBin = "";
      blipScriptPath = "";
      blipInitError = error?.message || "BLIP не запустився";
    }
    blipChecked = true;
    blipCheckPromise = null;
    return blipPythonBin;
  })();

  return blipCheckPromise;
}

function slugifyText(text, fallback = "clip") {
  const raw = String(text || "").toLowerCase().trim();
  const tokens = extractKeywords(raw, 8);
  const base = (tokens.length ? tokens.join("-") : raw)
    .replace(/[^a-zа-яіїєґ0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return base || fallback;
}

function formatCutTimeCompact(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hh = Math.floor(total / 3600);
  const mm = Math.floor((total % 3600) / 60);
  const ss = total % 60;
  return hh > 0
    ? `${String(hh).padStart(2, "0")}-${String(mm).padStart(2, "0")}-${String(ss).padStart(2, "0")}`
    : `${String(mm).padStart(2, "0")}-${String(ss).padStart(2, "0")}`;
}

function formatCutTimeLabel(start, end) {
  return `${formatSrtTimestamp(start).replace(",000", "").slice(3)} - ${formatSrtTimestamp(end).replace(",000", "").slice(3)}`;
}

function toReadableSceneTitle(text, fallback = "Фрагмент відео") {
  const compressed = compressRepeatedSceneText(String(text || ""));
  const raw = compressed
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (isBadSceneTitleText(raw)) return fallback;
  if (!raw) return fallback;

  const firstSentence = raw.split(/(?<=[.!?])\s+/)[0] || raw;
  const words = firstSentence
    .split(/\s+/)
    .map((w) => w.trim())
    .filter(Boolean)
    .filter((w) => !/^\d+$/.test(w))
    .slice(0, 7);

  if (!words.length) return fallback;
  const joined = words.join(" ").trim();
  return joined.charAt(0).toUpperCase() + joined.slice(1);
}

function compressRepeatedSceneText(text = "") {
  const words = String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);

  if (words.length < 6) return String(text || "").trim();

  for (let size = 3; size <= Math.min(8, Math.floor(words.length / 2)); size += 1) {
    const head = words.slice(0, size).join(" ").toLowerCase();
    const next = words.slice(size, size * 2).join(" ").toLowerCase();
    if (head && head === next) {
      return words.slice(0, size).join(" ");
    }
  }

  return words.slice(0, 10).join(" ");
}

function normalizeSceneCandidateText(text = "") {
  return compressRepeatedSceneText(String(text || ""))
    .replace(/\b(the image shows|this image shows|there is|there are|a picture of|an image of)\b/gi, "")
    .replace(/\b(on the bottom of the image|in the image|in the picture|in the background)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeSceneTitle(text = "") {
  const raw = String(text || "").replace(/\s+/g, " ").trim();
  if (!raw) return "";
  return raw
    .replace(/люди\s+біля\s+будівлі\s+на\s+архівн[а-яіїєґ]*\s+хроніц[а-яіїєґ]*/gi, "архівний кадр")
    .replace(/люди\s+біля\s+будівлі\s+в\s+архівн[а-яіїєґ]*\s+кадр[а-яіїєґ]*/gi, "архівний кадр")
    .replace(/\s+/g, " ")
    .trim();
}

function hasMojibake(text = "") {
  const raw = String(text || "");
  return /[�]{1,}|[ÐÑÂÃ]{2,}|[^\s]{0,4}[ÐÑÂÃ][^\s]{0,4}|(?:ð|þ|º|¾|½|¼|¿|¡|¢|£|¤|¥|¦|§|¨|©){2,}/i.test(raw);
}

function isBadSceneTitleText(text = "") {
  const raw = String(text || "").trim();
  if (!raw) return true;
  if (hasMojibake(raw)) return true;

  const compact = raw.replace(/\s+/g, "");
  const letters = (compact.match(/[a-zа-яіїєґ]/gi) || []).length;
  const digits = (compact.match(/\d/g) || []).length;
  const badChars = (compact.match(/[^a-zа-яіїєґ0-9'’-]/gi) || []).length;
  const words = raw.match(/[a-zа-яіїєґ]{2,}/gi) || [];

  if (letters < 3) return true;
  if (badChars / Math.max(1, compact.length) > 0.28 && words.length < 4) return true;
  if (digits / Math.max(1, compact.length) > 0.35 && words.length < 3) return true;
  return false;
}

function isOcrGarbageText(text = "") {
  const raw = String(text || "").trim();
  if (!raw) return true;
  if (hasMojibake(raw)) return true;

  const compact = raw.replace(/\s+/g, "");
  if (!compact) return true;
  const letters = (compact.match(/[a-zа-яіїєґ]/gi) || []).length;
  const digits = (compact.match(/\d/g) || []).length;
  const symbols = Math.max(0, compact.length - letters - digits);
  const words = raw.match(/[a-zа-яіїєґ]{3,}/gi) || [];
  const alphaTokens = raw.match(/[a-zа-яіїєґ]{1,}/gi) || [];
  const uppercaseNoise = raw.match(/[A-Z]{2,}/g) || [];
  const avgTokenLength = alphaTokens.length
    ? alphaTokens.reduce((sum, token) => sum + token.length, 0) / alphaTokens.length
    : 0;

  if (letters < 4) return true;
  if (alphaTokens.length >= 5 && avgTokenLength < 3.2) return true;
  if (alphaTokens.length >= 4 && words.length < 2) return true;
  if (words.length < 2 && symbols / compact.length > 0.25) return true;
  if (symbols / compact.length > 0.42) return true;
  if (digits / compact.length > 0.35 && words.length < 4) return true;
  if (uppercaseNoise.length >= 4 && words.length < 5) return true;
  return false;
}

function normalizeSourceNameForCheck(text = "") {
  return String(text || "")
    .trim()
    .replace(/\.[a-z0-9]{1,8}$/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isGenericSourceName(text = "") {
  const clean = normalizeSourceNameForCheck(text).toLowerCase();
  if (!clean) return true;
  return [
    /^videoplayback(?:\s*\(\d+\)|\s+\d+)?$/i,
    /^(video|source|clip|cuts?)(?:\s*\(\d+\)|\s+\d+)?$/i,
    /^(screen recording|запис екрана)(?:\s*\d{4}.*)?$/i,
    /^архівний фрагмент відео$/i
  ].some((pattern) => pattern.test(clean));
}

function cleanOcrForTitle(text = "") {
  if (isOcrGarbageText(text)) return "";
  return String(text || "")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => {
      if (!/[a-zа-яіїєґ]/i.test(token)) return false;
      if (/^[^a-zа-яіїєґ]+$/i.test(token)) return false;
      if ((token.match(/[^\wа-яіїєґ'-]/gi) || []).length > 2) return false;
      return true;
    })
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function detectContextSceneHint(baseTitle = "", ocrText = "") {
  const context = `${baseTitle || ""} ${ocrText || ""}`;
  const lower = context.toLowerCase();
  const hints = [];

  const hasIrma = /\birma\b|\bgrese\b|ірм[а-яіїєґ]*|гр[іи]з[еа]?/i.test(lower);
  const hasNazi = /\bnazi|nazis|ss\b|gestapo|hitler|wehrmacht|concentration|camp|нацист|гітлер|концтаб/i.test(lower);
  const hasArchive = /british\s+pathe|pathe|archive|archival|хронік|архів/i.test(lower);
  const hasWar = /war|ww2|world war|military|soldier|army|військ|солдат|армі/i.test(lower);
  const hasCourt = /trial|court|tribunal|суд|трибунал|допит/i.test(lower);

  if (hasIrma) hints.push("Ірма Грізе");
  if (hasNazi) hints.push("нацисти");
  if (hasWar) hints.push("військова хроніка");
  if (hasCourt) hints.push("судовий або документальний епізод");
  if (hasArchive) hints.push("архівна хроніка");

  if (hasIrma && hasArchive) return "Архівні кадри про Ірму Грізе";
  if (hasIrma && hasNazi) return "Кадри про Ірму Грізе та нацистів";
  if (hasNazi && hasArchive) return "Нацистські охоронці в архівній хроніці";
  if (hasWar && hasArchive) return "Архівна військова хроніка";
  if (hasCourt && hasArchive) return "Архівні кадри судового епізоду";
  if (hints.length) return toReadableSceneTitle(hints.join(" "), "Архівний фрагмент");
  return "";
}

function detectContextLocation(context = "") {
  const lower = String(context || "").toLowerCase();
  if (/concentration|camp|auschwitz|belsen|таб[іо]р|концтаб/i.test(lower)) return "біля табору";
  if (/prison|jail|cell|bars|тюрм|в'язниц|камера/i.test(lower)) return "біля тюрми";
  if (/court|trial|tribunal|суд|трибунал/i.test(lower)) return "у суді";
  if (/street|road|city|town|вулиц|дорог/i.test(lower)) return "на вулиці";
  return "";
}

function isArchiveContext(context = "") {
  return /archive|pathe|archival|chronicle|хронік|архів/i.test(String(context || ""));
}

function detectContextSubject(context = "") {
  const lower = String(context || "").toLowerCase();
  if (/\birma\b|\bgrese\b|ірм[а-яіїєґ]*|гр[іи]з[еа]?/i.test(lower)) return "Ірма Грізе та охоронці";
  if (/\bnazi|nazis|ss\b|gestapo|hitler|wehrmacht|нацист|гітлер/i.test(lower)) return "нацистські охоронці";
  if (/guard|guards|officer|officers|uniform|soldier|army|military|war|ww2|військ|солдат|армі/i.test(lower)) return "військові";
  if (/prisoner|prisoners|ув'язнен|полонен/i.test(lower)) return "ув'язнені";
  if (/crowd|people|group|натовп|люд/i.test(lower)) return "група людей";
  return "";
}

function buildContextDetailedSceneTitle(contextText = "", visualText = "") {
  const context = `${contextText || ""} ${visualText || ""}`;
  const lower = context.toLowerCase();
  const subject = detectContextSubject(context) || "люди";
  const location = detectContextLocation(context);

  if (/trial|court|tribunal|суд|трибунал/i.test(lower)) {
    return `${subject} у судовій хроніці`;
  }
  if (location) {
    return `${subject} ${location}`;
  }
  if (isArchiveContext(lower)) {
    return subject === "люди"
      ? "архівний кадр"
      : `${subject} в архівному кадрі`;
  }
  return "";
}

function buildVisualSceneTitle(visualText = "", contextText = "") {
  const lower = normalizeSceneCandidateText(visualText).toLowerCase();
  if (!lower) return "";
  const contextSubject = detectContextSubject(contextText);

  let subject = "";
  if (/\b(soldier|soldiers|military|officer|officers|guard|guards|uniform|army|troops)\b/i.test(lower)) {
    subject = /нацист/i.test(contextSubject) ? "нацистські охоронці" : "військові";
  } else if (/\b(crowd|group|many people|people)\b/i.test(lower)) {
    subject = "група людей";
  } else if (/\b(woman|female|girl)\b/i.test(lower)) {
    subject = "жінка";
  } else if (/\b(man|male|boy)\b/i.test(lower)) {
    subject = "чоловік";
  } else if (/\b(person|human)\b/i.test(lower)) {
    subject = "людина";
  } else if (/\b(child|children|kid|kids)\b/i.test(lower)) {
    subject = "діти";
  } else if (/\b(prisoner|prisoners|inmate|inmates)\b/i.test(lower)) {
    subject = "ув'язнені";
  } else if (/\b(car|vehicle|truck|bus)\b/i.test(lower)) {
    subject = "машина";
  } else if (/\b(train|railway)\b/i.test(lower)) {
    subject = "поїзд";
  } else if (/\b(building|house|prison|jail|camp|gate|fence)\b/i.test(lower)) {
    subject = detectContextLocation(contextText) === "біля табору" ? "будівля табору" : "будівля";
  }

  let action = "";
  if (/\b(marching|parade|walking|walk|moving|running)\b/i.test(lower)) action = "рухаються";
  else if (/\b(standing|stand|posing)\b/i.test(lower)) action = "стоїть";
  else if (/\b(sitting|sit)\b/i.test(lower)) action = "сидить";
  else if (/\b(talking|speaking|interview)\b/i.test(lower)) action = "говорить";

  let location = detectContextLocation(`${contextText} ${visualText}`);
  if (!location) {
    if (/\b(in front of|outside|near|next to)\b.*\b(building|house|gate|fence|prison|jail)\b/i.test(lower)) {
      location = "біля будівлі";
    } else if (/\binside|room|hall|office\b/i.test(lower)) {
      location = "у приміщенні";
    } else if (/\bstreet|road|outside\b/i.test(lower)) {
      location = "на вулиці";
    }
  }

  if (!subject) return toReadableSceneTitle(visualText, "");
  if (subject === "група людей" && contextSubject && /охоронці|військові|ув'язнені/i.test(contextSubject)) {
    subject = contextSubject;
  }

  const isPlural = /^(військові|група людей|діти)$/.test(subject);
  const normalizedAction = action === "стоїть" && isPlural ? "стоять" : action;
  return [subject, normalizedAction, location].filter(Boolean).join(" ").trim();
}

function cleanVisualWords(text = "") {
  return String(text || "")
    .replace(/\b(the image shows|this image shows|there is|there are|a picture of|an image of|a group of)\b/gi, "")
    .replace(/\b(source|videoplayback|keyframe|frame|clip|stock footage)\b/gi, "")
    .replace(/[^\p{L}\p{N}\s'’-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractSimpleSceneFacts(visualText = "", contextText = "") {
  const visual = cleanVisualWords(visualText).toLowerCase();
  const context = cleanVisualWords(contextText).toLowerCase();
  const joined = `${visual} ${context}`;

  let subject = "";
  if (/\blion\b|лев/i.test(joined)) subject = "лев";
  else if (/\bmouse|mice|миша|мышь/i.test(joined)) subject = "миша";
  else if (/\bhorse|кінь|лошад/i.test(joined)) subject = "кінь";
  else if (/\bnazi|nazis|ss\b|gestapo|нацист|гітлер|гитлер/i.test(joined)) {
    if (/\bguard|guards|officer|officers|soldier|soldiers|uniform|troops|охорон|солдат|військ|военн/i.test(joined)) {
      subject = "нацистські військові";
    } else {
      subject = "нацисти";
    }
  } else if (/\bsoldier|soldiers|military|officer|officers|guard|guards|uniform|army|troops|військ|военн|солдат|охорон/i.test(joined)) {
    subject = "військові";
  } else if (/\bprisoner|prisoners|inmate|inmates|ув'язнен|полонен/i.test(joined)) {
    subject = "ув'язнені";
  } else if (/\bwoman|female|girl|жінка|женщина|дівчина|девушка/i.test(joined)) {
    subject = "жінка";
  } else if (/\bman|male|boy|чоловік|мужчина/i.test(joined)) {
    subject = "чоловік";
  } else if (/\bchild|children|kid|kids|діти|дети|дитина|ребенок/i.test(joined)) {
    subject = "діти";
  } else if (/\bcrowd|people|group|person|human|люди|людина|человек|толпа/i.test(joined)) {
    subject = "люди";
  }

  let place = "";
  if (/\bcamp|concentration|auschwitz|belsen|табір|лагер|концтаб/i.test(joined)) place = "у таборі";
  else if (/\bprison|jail|cell|bars|тюрм|в'язниц|камера/i.test(joined)) place = "у тюрмі";
  else if (/\bcourt|trial|tribunal|суд|трибунал/i.test(joined)) place = "у суді";
  else if (/\bstation|platform|train station|станц|вокзал/i.test(joined)) place = "на станції";
  else if (/\bstreet|road|city|town|вулиц|дорог/i.test(joined)) place = "на вулиці";
  else if (/\bforest|jungle|woods|ліс|лес|джунгл/i.test(joined)) place = "у лісі";
  else if (/\broom|hall|corridor|office|приміщ|кімнат|комнат|коридор/i.test(joined)) place = "у приміщенні";
  else if (/\bgate|fence|ворот|паркан|забор/i.test(joined)) place = "біля воріт";

  let action = "";
  if (/\bmarching|parade|march|walking|moving|ход|марш|йдуть|идут/i.test(joined)) action = "йдуть";
  else if (/\brunning|run|escape|тіка|беж/i.test(joined)) action = "біжать";
  else if (/\bstanding|stand|стоять|стоїть/i.test(joined)) action = subject === "люди" || subject.endsWith("і") ? "стоять" : "стоїть";
  else if (/\bsitting|sit|сид/i.test(joined)) action = subject === "люди" || subject.endsWith("і") ? "сидять" : "сидить";
  else if (/\btalking|speaking|speech|говор|розмов/i.test(joined)) action = "говорять";
  else if (/\bwatching|looking|дивляться|смотр/i.test(joined)) action = "дивляться";

  const archive = /\barchive|archival|chronicle|pathe|архів|архив|хронік|хроник/i.test(joined);
  return { subject, place, action, archive };
}

function buildSimpleSceneTitle({ visualText = "", contextText = "", fallback = "кадр з відео" } = {}) {
  const facts = extractSimpleSceneFacts(visualText, contextText);
  const parts = [];
  if (facts.subject) parts.push(facts.subject);
  if (facts.action) parts.push(facts.action);
  if (facts.place) parts.push(facts.place);
  if (!parts.length && facts.archive) return "архівний кадр";
  if (!parts.length) {
    const cleaned = cleanVisualWords(visualText);
    if (cleaned && !isBadSceneTitleText(cleaned) && !isGenericSceneCandidate(cleaned)) {
      return toReadableSceneTitle(cleaned, fallback).split(/\s+/).slice(0, 8).join(" ");
    }
    return fallback;
  }
  if (facts.archive && !parts.join(" ").includes("архів")) parts.push("в архівному кадрі");
  return sanitizeSceneTitle(parts.join(" "));
}

function buildVisualOnlySceneTitle(visualText = "") {
  const visual = cleanVisualWords(visualText).toLowerCase();
  if (!visual || isBadSceneTitleText(visual)) return "";
  const has = (pattern) => pattern.test(visual);

  const many = has(/\btwo\b|\bseveral\b|\bmany\b|\bgroup\b|\bpair\b|кілька|група|багато/i);
  const close = has(/close up|close-up|macro|крупн/i);
  const water = has(/water|underwater|river|lake|sea|ocean|вод|річк|озер|море|океан/i);
  const flower = has(/flower|flowers|квіт|цвет/i);
  const tree = has(/tree|branch|forest|jungle|woods|дерев|гілк|ліс|джунгл/i);
  const sky = has(/sky|cloud|неб|хмар/i);

  if (has(/minecraft|video game|gameplay|pixel|block|cube|screen shot|screenshot|майнкрафт|геймплей/i)) {
    if (water) return "ігровий кадр біля води";
    if (has(/stone|wall|cave|rock|камін|стіна|печер/i)) return "ігровий кадр біля блоків";
    return "ігровий кадр";
  }
  if (has(/airplane|plane|aircraft|jet|літак|самол[её]т/i)) return many ? "літаки летять у небі" : "літак летить у небі";
  if (has(/submarine|підводн|подводн/i)) return "підводний човен у воді";
  if (has(/ship|boat|кораб|човен|лодк/i)) return "човен на воді";
  if (has(/parrot|macaw|cockatoo|папуг/i)) return many ? "папуги серед зелені" : "папуга крупним планом";
  if (has(/butterfl|метелик|бабоч/i)) return flower ? "метелик на квітці" : "метелик серед рослин";
  if (has(/bee|бджол|пчел/i)) return flower ? "бджола на квітці" : "бджола крупним планом";
  if (has(/bird|birds|птах|птиц/i)) return sky ? "птахи летять у небі" : (tree ? "птахи на гілці" : "птахи в кадрі");
  if (has(/lion|лев/i)) return has(/grass|savanna|field|трава|саван/i) ? "лев у траві" : "лев у кадрі";
  if (has(/horse|кінь|лошад/i)) return "кінь у кадрі";
  if (has(/dog|собак/i)) return "собака в кадрі";
  if (has(/cat|кіт|кот/i)) return "кіт у кадрі";
  if (has(/mountain|hill|valley|гір|гор|пагорб|долин/i)) return water ? "водойма серед гір" : "гірський пейзаж";
  if (water && tree) return "вода серед зелені";
  if (water) return "водойма в кадрі";
  if (tree) return "зелений ліс";
  if (has(/field|meadow|grass|plain|поле|луг|трава/i)) return "трав'яне поле";
  if (has(/soldier|military|officer|uniform|army|troops|солдат|військ|форма/i)) return many ? "військові в кадрі" : "військовий у формі";
  if (has(/crowd|people|group|person|man|woman|child|люди|людина|чоловік|жінка|дитина/i)) return many ? "люди в кадрі" : "людина в кадрі";
  if (has(/building|house|street|road|city|будівл|дім|вулиц|дорог|міст/i)) return "міський кадр";

  const readable = toReadableSceneTitle(visual, "");
  if (!readable || isGenericSceneCandidate(readable) || isBadSceneTitleText(readable)) return "";
  return readable.split(/\s+/).slice(0, 10).join(" ");
}

function buildRawBlipSceneTitle(blipCaption = "", blipCaptions = []) {
  const captions = [blipCaption, ...(Array.isArray(blipCaptions) ? blipCaptions : [])]
    .map((item) => normalizeSceneCandidateText(item))
    .filter(Boolean)
    .filter((item, index, arr) => arr.indexOf(item) === index);
  const firstUseful = captions.find((item) => (
    !isBadSceneTitleText(item)
    && !isGenericSceneCandidate(item)
  )) || captions.find((item) => !isBadSceneTitleText(item)) || "";
  if (!firstUseful) return "";
  return toReadableSceneTitle(firstUseful, "").split(/\s+/).slice(0, 9).join(" ");
}

function pickUsefulBlipCaption(blipCaption = "", blipCaptions = []) {
  const captions = [blipCaption, ...(Array.isArray(blipCaptions) ? blipCaptions : [])]
    .map((item) => normalizeSceneCandidateText(item))
    .filter(Boolean)
    .filter((item, index, arr) => arr.indexOf(item) === index)
    .filter((item) => !isBadSceneTitleText(item));
  return captions.find((item) => !isGenericSceneCandidate(item)) || captions[0] || "";
}

function makePlainCutTitleFromCaption(caption = "") {
  const raw = normalizeSceneCandidateText(caption);
  if (!raw || isBadSceneTitleText(raw)) return "";
  const visualTitle = buildVisualOnlySceneTitle(raw);
  if (visualTitle && !isGenericSceneCandidate(visualTitle) && !isBadSceneTitleText(visualTitle)) {
    return sanitizeSceneTitle(visualTitle);
  }
  const readable = toReadableSceneTitle(raw, "");
  if (!readable || isGenericSceneCandidate(readable)) return "";
  return sanitizeSceneTitle(readable.split(/\s+/).slice(0, 9).join(" "));
}

function makeRawBlipCutTitle(blipCaption = "", blipCaptions = []) {
  const raw = String(blipCaption || "")
    || (Array.isArray(blipCaptions) ? blipCaptions.map((x) => String(x || "").trim()).filter(Boolean).join(". ") : "");
  const title = String(raw || "")
    .replace(/\s+/g, " ")
    .replace(/\s*\.\s*/g, ". ")
    .replace(/\.+$/g, "")
    .trim();
  if (!title || isBadSceneTitleText(title) || isGenericSceneCandidate(title)) return "";
  return sanitizeSceneTitle(title).slice(0, 180);
}

function isGenericSceneCandidate(text = "") {
  const normalized = normalizeSceneCandidateText(text).toLowerCase();
  if (!normalized) return true;
  const genericPatterns = [
    /^video$/i,
    /^videoplayback(?:\s*\(\d+\)|\s+\d+)?$/i,
    /^clip$/i,
    /^scene$/i,
    /^fragment/i,
    /^кадр з відео$/i,
    /^сцена з відео$/i,
    /^учасник/i,
    /учасник\s*\+\s*дія/i,
    /participant\s*\+\s*action/i,
    /^outdoor scene$/i,
    /^person standing$/i,
    /^dark room$/i,
    /^black background/i,
    /\bwith the words\b/i,
    /\btext on (the )?(screen|image|picture)\b/i,
    /\bthe words are written\b/i,
    /\bclose up of text\b/i
  ];
  return genericPatterns.some((pattern) => pattern.test(normalized));
}

function buildSceneCandidate({ sourceKey, text, contextKeywords = [] }) {
  const inputText = sourceKey === "ocr" ? cleanOcrForTitle(text) : text;
  const normalized = sanitizeSceneTitle(normalizeSceneCandidateText(inputText));
  const readable = toReadableSceneTitle(normalized, "");
  const keywords = extractKeywords(normalized, 10);
  const lowered = normalized.toLowerCase();
  const overlap = keywords.filter((w) => contextKeywords.includes(w)).length;
  const penalties = [];
  const bonuses = [];
  let score = 36;

  if (!normalized) {
    penalties.push({ type: "empty-candidate", value: -40, note: "Кандидат не дав осмисленого опису сцени" });
    score -= 40;
  }

  if (isBadSceneTitleText(normalized)) {
    penalties.push({ type: "bad-title-text", value: -90, note: "Назва схожа на бите кодування або технічне сміття" });
    score -= 90;
  }

  if (sourceKey === "ocr" && isOcrGarbageText(text)) {
    penalties.push({ type: "ocr-garbage", value: -70, note: "OCR схожий на шум/архівні артефакти, не можна брати як назву" });
    score -= 70;
  }

  if (keywords.length >= 4) {
    bonuses.push({ type: "rich-scene", value: 18, note: "Опис містить кілька змістовних слів" });
    score += 18;
  } else if (keywords.length >= 2) {
    bonuses.push({ type: "usable-scene", value: 10, note: "Опис придатний для назви сцени" });
    score += 10;
  } else if (keywords.length === 1) {
    penalties.push({ type: "weak-scene", value: -10, note: "Опис занадто бідний" });
    score -= 10;
  }

  if (overlap > 0) {
    const value = Math.min(18, overlap * 6);
    bonuses.push({ type: "context-match", value, note: "Є збіг із контекстом ролика" });
    score += value;
  } else {
    penalties.push({ type: "off-context", value: -8, note: "Опис слабко пов'язаний із контекстом" });
    score -= 8;
  }

  if (isGenericSceneCandidate(normalized)) {
    penalties.push({ type: "generic-scene", value: -26, note: "Опис занадто загальний або описує лише текст/фон" });
    score -= 26;
  }

  if (sourceKey === "source-title" && isGenericSourceName(normalized)) {
    penalties.push({ type: "generic-source-title", value: -80, note: "Назва файлу технічна, її не можна використовувати як назву сцени" });
    score -= 80;
  }

  if (/\b(word|words|text|caption|background)\b/i.test(lowered)) {
    penalties.push({ type: "text-only-scene", value: -16, note: "Опис схожий на текстову підказку, а не на зміст сцени" });
    score -= 16;
  }

  const titleWords = String(readable).split(/\s+/).filter(Boolean);
  if (titleWords.length >= 3 && titleWords.length <= 9) {
    bonuses.push({ type: "readable-title", value: 10, note: "Назва виглядає як нормальний scene title" });
    score += 10;
  } else if (titleWords.length < 3) {
    penalties.push({ type: "too-short-title", value: -10, note: "Назва занадто коротка" });
    score -= 10;
  } else {
    penalties.push({ type: "too-long-title", value: -6, note: "Назва занадто довга" });
    score -= 6;
  }

  return {
    sourceKey,
    raw: String(text || "").trim(),
    normalized,
    readable,
    keywords,
    score: Math.max(0, Math.round(score)),
    bonuses,
    penalties
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CLIP-based embedding matching for local assets. Reuses .venv-blip Python env.
// Returns { ok, scores: { [segId]: { [fileIndex]: score } }, diag } or { ok:false }.
// Embedding cache keeps re-runs fast (per-asset hash).
// ─────────────────────────────────────────────────────────────────────────────
const EMBED_CACHE_DIR = path.join(os.tmpdir(), "vss_embed_cache");
mkdirSync(EMBED_CACHE_DIR, { recursive: true });

let embedScriptPath = "";
async function ensureEmbedMatchAvailable() {
  const py = await ensureBlipAvailable();
  if (!py) return null;
  if (!embedScriptPath) {
    const candidate = path.join(__dirname, "tools", "embed_match.py");
    try {
      await fs.access(candidate);
      embedScriptPath = candidate;
    } catch (_) {
      embedScriptPath = "";
    }
  }
  return embedScriptPath ? py : null;
}

async function runEmbedMatch(payload, { timeoutMs = 600000 } = {}) {
  const py = await ensureEmbedMatchAvailable();
  if (!py || !embedScriptPath) {
    return { ok: false, error: "embed_match не доступний (немає .venv-blip або скрипта)" };
  }

  return runBlipExclusive(async () => {
    return new Promise((resolve) => {
      const child = spawn(py, [embedScriptPath], {
        env: getPythonSafeEnv(),
        stdio: ["pipe", "pipe", "pipe"]
      });
      let stdoutBuf = "";
      let stderrBuf = "";
      let timer = null;
      const cleanup = () => {
        if (timer) { clearTimeout(timer); timer = null; }
      };
      child.stdout.on("data", (chunk) => { stdoutBuf += chunk.toString("utf8"); });
      child.stderr.on("data", (chunk) => { stderrBuf += chunk.toString("utf8"); });
      child.on("error", (err) => {
        cleanup();
        resolve({ ok: false, error: `embed_match spawn error: ${err.message}` });
      });
      child.on("close", () => {
        cleanup();
        const txt = stdoutBuf.trim();
        if (!txt) {
          return resolve({ ok: false, error: `embed_match: empty output. stderr: ${stderrBuf.slice(-400)}` });
        }
        try {
          const parsed = JSON.parse(txt);
          resolve(parsed);
        } catch (e) {
          resolve({ ok: false, error: `embed_match: bad json: ${e.message}. raw: ${txt.slice(0, 200)}` });
        }
      });
      timer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch (_) {}
      }, timeoutMs);
      try {
        child.stdin.write(JSON.stringify(payload));
        child.stdin.end();
      } catch (e) {
        cleanup();
        resolve({ ok: false, error: `embed_match stdin error: ${e.message}` });
      }
    });
  });
}

async function describeFramesWithBlip(framePaths = []) {
  const py = await ensureBlipAvailable();
  if (!py || !blipScriptPath || !Array.isArray(framePaths) || !framePaths.length) {
    return {
      available: false,
      caption: "",
      captions: [],
      error: !py
        ? `BLIP не доступний: ${blipInitError || ".venv-blip або залежності не запустились"}`
        : "BLIP не отримав кадри для аналізу"
    };
  }

  try {
    const { stdout } = await runBlipExclusive(() => runCommand(
      py,
      [blipScriptPath, ...framePaths],
      { timeoutMs: 120000, env: getPythonSafeEnv() }
    ));
    const parsed = JSON.parse(String(stdout || "{}"));
    const captions = Array.isArray(parsed.captions)
      ? parsed.captions.map((x) => String(x || "").trim()).filter(Boolean)
      : [];
    const caption = captions.length
      ? captions.filter((value, index, arr) => arr.indexOf(value) === index).join(". ")
      : String(parsed.caption || "").trim();
    return { available: true, caption, captions };
  } catch (error) {
    return { available: false, caption: "", captions: [], error: error.message || "BLIP failed" };
  }
}

function buildCutTitleAnalysis({ baseTitle, ocrText, blipCaption = "", blipCaptions = [], blipError = "", start, end, namingMode = "auto" }) {
  const timeLabel = formatCutTimeLabel(start, end);
  const cleanOcr = cleanOcrForTitle(ocrText);
  const usefulBlipCaption = pickUsefulBlipCaption(blipCaption, blipCaptions);
  const rawBlipTitle = makeRawBlipCutTitle(blipCaption, blipCaptions);
  const blipTitle = rawBlipTitle || makePlainCutTitleFromCaption(usefulBlipCaption);
  const ocrTitle = cleanOcr && !isOcrGarbageText(cleanOcr)
    ? sanitizeSceneTitle(toReadableSceneTitle(cleanOcr, "").split(/\s+/).slice(0, 8).join(" "))
    : "";
  const title = blipTitle || ocrTitle || "BLIP не зміг назвати сцену";
  const source = blipTitle ? "blip-3-frames" : (ocrTitle ? "ocr-fallback" : "blip-empty");
  const finalScore = blipTitle ? 90 : (ocrTitle ? 55 : 0);
  const fileSlug = slugifyText(title, `fragment-${formatCutTimeCompact(start)}-to-${formatCutTimeCompact(end)}`);
  const bonuses = blipTitle ? [{ type: "blip-caption", value: 90, note: "Назва взята з BLIP-аналізу трьох кадрів" }] : [];
  const penalties = blipTitle ? [] : [{ type: "no-blip-caption", value: -90, note: blipError || "BLIP не повернув опис кадру" }];
  const captionsList = Array.isArray(blipCaptions) ? blipCaptions : [];
  const summaryLead = blipTitle
    ? "Сцена названа по BLIP-аналізу трьох кадрів."
    : "BLIP не дав нормальний опис трьох кадрів.";
  const summaryTail = blipTitle
    ? `${title} / ${String(usefulBlipCaption).slice(0, 160)}`
    : `${title}${blipError ? ` / ${String(blipError).slice(0, 180)}` : ""}`;
  const candidates = [
    { source: "blip", title: usefulBlipCaption || "", score: blipTitle ? 90 : 0 },
    { source: "ocr", title: ocrTitle || "", score: ocrTitle ? 55 : 0 }
  ];

  if (String(namingMode || "auto") === "time") {
    return {
      title: `${title} ${timeLabel}`.trim(),
      fileSlug,
      summary: `${summaryLead} ${summaryTail}`.trim(),
      scoring: {
        finalScore,
        source,
        bonuses,
        penalties,
        blipCaptions: captionsList,
        candidates
      }
    };
  }
  return {
    title,
    fileSlug,
    summary: `${summaryLead} ${summaryTail}`.trim(),
    scoring: {
      finalScore,
      source,
      bonuses,
      penalties,
      blipCaptions: captionsList,
      candidates
    }
  };
}

async function extractPreviewForClip(videoPath, outputPath, atSeconds = 0.4) {
  await runFfmpeg([
    "-y",
    "-ss", String(Math.max(0, atSeconds)),
    "-i", videoPath,
    "-frames:v", "1",
    "-q:v", "4",
    outputPath
  ]);
}

async function downloadYouTubeVideo(youtubeUrl, tempDir) {
  await ensureYtDlpAvailable();
  const outTemplate = path.join(tempDir, "source.%(ext)s");
  const { stdout } = await runCommand(ytDlpBin, [
    "--no-playlist",
    "--restrict-filenames",
    "--merge-output-format", "mp4",
    "--print", "title",
    "-o", outTemplate,
    String(youtubeUrl || "").trim()
  ]);
  const title = String(stdout || "").trim().split(/\r?\n/).filter(Boolean).pop() || "youtube-video";
  const files = await fs.readdir(tempDir);
  const sourceName = files.find((name) => /^source\./.test(name) && !name.endsWith(".part"));
  if (!sourceName) throw new Error("yt-dlp не зміг завантажити YouTube-відео");
  return {
    videoPath: path.join(tempDir, sourceName),
    title
  };
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function pickExtFromUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    const ext = path.extname(pathname).toLowerCase();
    return ext && ext.length <= 6 ? ext : ".bin";
  } catch {
    return ".bin";
  }
}

function ensureTimeline(raw) {
  let timeline;
  try {
    timeline = JSON.parse(String(raw || "[]"));
  } catch {
    throw new Error("Невірний timeline JSON");
  }

  if (!Array.isArray(timeline) || !timeline.length) {
    throw new Error("Timeline порожній");
  }

  return timeline
    .map((item, idx) => {
      const start = Number(item.start || 0);
      const end = Number(item.end || 0);
      const duration = Math.max(0.6, end - start);
      const asset = item.asset || {};
      return {
        id: idx,
        start,
        end,
        duration,
        text: String(item.text || "").trim(),
        asset: {
          kind: asset.kind === "image" ? "image" : "video",
          source: asset.source || "unknown",
          previewUrl: String(asset.previewUrl || ""),
          fileIndex: Number.isInteger(asset.fileIndex) ? asset.fileIndex : null
        }
      };
    })
    .sort((a, b) => a.start - b.start);
}

function parseMontageSettings(raw) {
  let input = {};
  try {
    input = raw ? JSON.parse(String(raw)) : {};
  } catch {
    input = {};
  }

  const preset = ["smooth", "dynamic", "aggressive"].includes(String(input.preset))
    ? String(input.preset)
    : "dynamic";
  const imageAnimationStyle = ["combo", "zoom", "shake", "drift"].includes(String(input.imageAnimationStyle))
    ? String(input.imageAnimationStyle)
    : "combo";
  const transitionPack = ["smooth", "dynamic", "aggressive"].includes(String(input.transitionPack))
    ? String(input.transitionPack)
    : preset;
  const imageAnimationStrength = Math.max(1, Math.min(3, Number(input.imageAnimationStrength) || (preset === "aggressive" ? 3 : preset === "smooth" ? 1 : 2)));
  const defaultTransition = preset === "aggressive" ? 0.34 : preset === "smooth" ? 0.16 : 0.26;
  const transitionDuration = Math.max(0.08, Math.min(0.8, Number(input.transitionDuration) || defaultTransition));
  const subtitlesEnabled = input.subtitlesEnabled !== false;
  const proMontageMode = ["off", "auto", "intense"].includes(String(input.proMontageMode))
    ? String(input.proMontageMode)
    : "off";
  const proInsertDensity = ["low", "medium", "high"].includes(String(input.proInsertDensity))
    ? String(input.proInsertDensity)
    : "medium";
  const proInsertTitle = input.proInsertTitle !== false;
  const proInsertNumber = input.proInsertNumber !== false;
  const proInsertDocument = input.proInsertDocument !== false;
  const proInsertTimeline = input.proInsertTimeline !== false;
  const proInsertPhotoFrame = input.proInsertPhotoFrame !== false;
  const proInsertSplitScreen = input.proInsertSplitScreen !== false;
  const proInsertBreakingNews = input.proInsertBreakingNews !== false;
  const proInsertLocationStamp = input.proInsertLocationStamp !== false;
  const proInsertChapterCard = input.proInsertChapterCard !== false;
  const proInsertRedactedDoc = input.proInsertRedactedDoc !== false;
  const proInsertTypewriter = input.proInsertTypewriter !== false;
  const sfxEnabled = input.sfxEnabled !== false;
  const sfxVolume = Math.max(0, Math.min(1.5, Number(input.sfxVolume) || 0.85));
  const sfxPack = ["cinematic", "subtle", "minimal"].includes(String(input.sfxPack))
    ? String(input.sfxPack)
    : "cinematic";
  const language = normalizeInsertLanguage(input.language || "");
  const focusLanguage = normalizeInsertLanguage(input.focusLanguage || "");

  return {
    preset,
    imageAnimationStyle,
    imageAnimationStrength,
    transitionPack,
    transitionDuration,
    subtitlesEnabled,
    proMontageMode,
    proInsertDensity,
    proInsertTitle,
    proInsertNumber,
    proInsertDocument,
    proInsertTimeline,
    proInsertPhotoFrame,
    proInsertSplitScreen,
    proInsertBreakingNews,
    proInsertLocationStamp,
    proInsertChapterCard,
    proInsertRedactedDoc,
    proInsertTypewriter,
    sfxEnabled,
    sfxVolume,
    sfxPack,
    language,
    focusLanguage
  };
}

function escapeDrawtextPath(inputPath) {
  return String(inputPath || "")
    .replace(/\\/g, "/")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'");
}

// ─────────────────────────────────────────────────────────────────────────────
// Typography for cinematic inserts. Use system condensed-bold fonts for that
// «documentary headline» feel. Escape colons/spaces for ffmpeg drawtext.
// ─────────────────────────────────────────────────────────────────────────────
function pickFontPath(candidates) {
  for (const candidate of candidates) {
    try {
      if (fsSync.existsSync(candidate)) return candidate;
    } catch (_) {}
  }
  return "";
}
const _FONT_HEADLINE_PATH = pickFontPath([
  "/System/Library/Fonts/Supplemental/DIN Condensed Bold.ttf",
  "/System/Library/Fonts/Supplemental/Impact.ttf",
  "/System/Library/Fonts/Avenir Next Condensed.ttc",
  "/Library/Fonts/Impact.ttf"
]);
const _FONT_BODY_PATH = pickFontPath([
  "/System/Library/Fonts/Avenir Next Condensed.ttc",
  "/System/Library/Fonts/Supplemental/Avenir Next Condensed.ttc",
  "/System/Library/Fonts/Helvetica.ttc",
  "/System/Library/Fonts/HelveticaNeue.ttc"
]);
function escapeFontfile(p) {
  return String(p || "").replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
}
const FONT_HEADLINE = _FONT_HEADLINE_PATH ? `:fontfile='${escapeFontfile(_FONT_HEADLINE_PATH)}'` : "";
const FONT_BODY = _FONT_BODY_PATH ? `:fontfile='${escapeFontfile(_FONT_BODY_PATH)}'` : "";

// ─────────────────────────────────────────────────────────────────────────────
// Smooth keyframe animation expression builder. Returns an alpha expr that:
//  - stays 0 until tIn
//  - eases in to 1 over fadeIn seconds (smoothstep)
//  - holds 1
//  - eases out to 0 over fadeOut seconds before tOut
// And a slide-y offset that decays from `slideStart` to 0 over fadeIn.
// ─────────────────────────────────────────────────────────────────────────────
function buildAlphaExpr(tIn, fadeIn, tOut, fadeOut) {
  const tInS = Number(tIn).toFixed(2);
  const tInEnd = (Number(tIn) + Number(fadeIn)).toFixed(2);
  const tOutStart = (Number(tOut) - Number(fadeOut)).toFixed(2);
  const tOutS = Number(tOut).toFixed(2);
  const fadeInS = Number(fadeIn).toFixed(2);
  const fadeOutS = Number(fadeOut).toFixed(2);
  // ease-out: 1 - (1-x)^2 where x = (t-tIn)/fadeIn
  // simplified: smooth ramp
  const inRamp = `((t-${tInS})/${fadeInS})`;
  const outRamp = `((${tOutS}-t)/${fadeOutS})`;
  return `if(lt(t\\,${tInS})\\,0\\,if(lt(t\\,${tInEnd})\\,${inRamp}*(2-${inRamp})\\,if(lt(t\\,${tOutStart})\\,1\\,if(lt(t\\,${tOutS})\\,${outRamp}*(2-${outRamp})\\,0))))`;
}

// y-offset that starts at `slideStart` px and eases to 0 over fadeIn,
// then stays 0, then drifts to `slideEnd` px during fadeOut.
function buildSlideOffsetExpr(tIn, fadeIn, tOut, fadeOut, slideStart = 24, slideEnd = -8) {
  const tInS = Number(tIn).toFixed(2);
  const tInEnd = (Number(tIn) + Number(fadeIn)).toFixed(2);
  const tOutStart = (Number(tOut) - Number(fadeOut)).toFixed(2);
  const tOutS = Number(tOut).toFixed(2);
  const fadeInS = Number(fadeIn).toFixed(2);
  const fadeOutS = Number(fadeOut).toFixed(2);
  // ease-out cubic: (1-progress)^3 * slideStart
  const inP = `((t-${tInS})/${fadeInS})`;
  const outP = `((t-${tOutStart})/${fadeOutS})`;
  return `if(lt(t\\,${tInS})\\,${slideStart}\\,if(lt(t\\,${tInEnd})\\,${slideStart}*(1-${inP})*(1-${inP})*(1-${inP})\\,if(lt(t\\,${tOutStart})\\,0\\,if(lt(t\\,${tOutS})\\,${slideEnd}*${outP}*${outP}\\,${slideEnd}))))`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Smart content extraction. Pulls a meaningful headline/sublabel pair from the
// actual segment text — numbers, dates, place names, key phrases — instead of
// repeating canned bank entries.
// ─────────────────────────────────────────────────────────────────────────────
const MONTH_NAMES = {
  en: ["JANUARY","FEBRUARY","MARCH","APRIL","MAY","JUNE","JULY","AUGUST","SEPTEMBER","OCTOBER","NOVEMBER","DECEMBER"],
  uk: ["СІЧЕНЬ","ЛЮТИЙ","БЕРЕЗЕНЬ","КВІТЕНЬ","ТРАВЕНЬ","ЧЕРВЕНЬ","ЛИПЕНЬ","СЕРПЕНЬ","ВЕРЕСЕНЬ","ЖОВТЕНЬ","ЛИСТОПАД","ГРУДЕНЬ"],
  ru: ["ЯНВАРЬ","ФЕВРАЛЬ","МАРТ","АПРЕЛЬ","МАЙ","ИЮНЬ","ИЮЛЬ","АВГУСТ","СЕНТЯБРЬ","ОКТЯБРЬ","НОЯБРЬ","ДЕКАБРЬ"],
  de: ["JANUAR","FEBRUAR","MÄRZ","APRIL","MAI","JUNI","JULI","AUGUST","SEPTEMBER","OKTOBER","NOVEMBER","DEZEMBER"]
};
const MONTH_PATTERNS = [
  { re: /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/i, lang: "en" },
  { re: /\b(січ(ень|ня)?|лют(ий|ого)?|берез(ень|ня)?|квіт(ень|ня)?|трав(ень|ня)?|черв(ень|ня)?|лип(ень|ня)?|серп(ень|ня)?|верес(ень|ня)?|жовт(ень|ня)?|листопад[аи]?|груд(ень|ня)?)\b/i, lang: "uk" },
  { re: /\b(январ[ьяе]?|феврал[ьяе]?|март[ае]?|апрел[ьяе]?|ма[йяе]|июн[ьяе]?|июл[ьяе]?|август[ае]?|сентябр[ьяе]?|октябр[ьяе]?|ноябр[ьяе]?|декабр[ьяе]?)\b/i, lang: "ru" },
  { re: /\b(januar|februar|märz|april|mai|juni|juli|august|september|oktober|november|dezember)\b/i, lang: "de" }
];
function detectMonthYear(source = "") {
  const text = String(source || "");
  for (const { re, lang } of MONTH_PATTERNS) {
    const m = text.match(re);
    if (m) {
      const yearMatch = text.match(/\b(19|20)\d{2}\b/);
      const monthIdxMap = {
        "jan":0,"feb":1,"mar":2,"apr":3,"may":4,"jun":5,"jul":6,"aug":7,"sep":8,"oct":9,"nov":10,"dec":11,
        "січ":0,"лют":1,"берез":2,"квіт":3,"трав":4,"черв":5,"лип":6,"серп":7,"верес":8,"жовт":9,"листоп":10,"груд":11,
        "янв":0,"фев":1,"март":2,"апр":3,"ма":4,"июн":5,"июл":6,"авг":7,"сент":8,"окт":9,"нояб":10,"дек":11,
        "januar":0,"februar":1,"märz":2,"mai":4,"juni":5,"juli":6,"oktober":9,"dezember":11
      };
      const key = m[1].toLowerCase().slice(0, 6);
      let idx = -1;
      for (const k of Object.keys(monthIdxMap)) {
        if (key.startsWith(k)) { idx = monthIdxMap[k]; break; }
      }
      if (idx < 0) continue;
      const monthName = MONTH_NAMES[lang][idx];
      const year = yearMatch ? yearMatch[0] : "";
      return year ? `${monthName} ${year}` : monthName;
    }
  }
  // bare year only
  const yearOnly = text.match(/\b(19|20)\d{2}\b/);
  if (yearOnly) return yearOnly[0];
  return "";
}
function extractKeyNumber(source = "") {
  const text = String(source || "");
  // currency or percent first
  const money = text.match(/[$€£₴]\s?\d+(?:[.,]\d+)?\s?(?:k|m|млн|млрд|million|billion|тис)?/i);
  if (money) return money[0].toUpperCase().replace(/\s+/g, "");
  const percent = text.match(/\b\d+(?:[.,]\d+)?\s?%/);
  if (percent) return percent[0].replace(/\s+/g, "");
  const bigUnit = text.match(/\b\d+(?:[.,]\d+)?\s?(million|billion|million|млн|млрд|тис|тысяч)\b/i);
  if (bigUnit) return bigUnit[0].toUpperCase();
  const minutes = text.match(/\b\d+\s?(min|minutes|хв|мин)\b/i);
  if (minutes) return minutes[0].toUpperCase().replace(/\s+/g, " ");
  return "";
}
function extractKeyPhrase(source = "", maxWords = 5) {
  // pick the most "loaded" sentence (longest with most nouns/proper nouns)
  const sentences = String(source || "").split(/(?<=[.!?])\s+/).filter(s => s.length > 10);
  if (!sentences.length) return compactWords(source, maxWords);
  let best = sentences[0];
  let bestScore = 0;
  for (const s of sentences) {
    const caps = (s.match(/[A-ZА-ЯҐЇІЄ][a-zа-яґїіє]+/g) || []).length;
    const nums = (s.match(/\d/g) || []).length;
    const score = caps * 2 + nums + s.length * 0.02;
    if (score > bestScore) { bestScore = score; best = s; }
  }
  return compactWords(best.replace(/[«»"“”]/g, ""), maxWords);
}
function defaultSublabel(type, lang) {
  const map = {
    en: { number: "REPORTED FIGURE", document: "ARCHIVE NOTE", timeline: "ON THE RECORD", warning: "PRIORITY ALERT", quote: "ON THE RECORD", analysis: "EVIDENCE LOG", place: "LOCATION", person: "KEY FIGURE", title: "CASE FILE", "breaking-news": "BREAKING NEWS", "location-stamp": "LOCATION", "chapter-card": "CHAPTER", "redacted-doc": "CLASSIFIED", "typewriter": "FACT CONFIRMED" },
    uk: { number: "ЗАФІКСОВАНІ ДАНІ", document: "ЗАПИС АРХІВУ", timeline: "ХРОНОЛОГІЯ", warning: "СИГНАЛ ТРИВОГИ", quote: "ЗАЯВА", analysis: "СЛІДЧИЙ ЛОГ", place: "ЛОКАЦІЯ", person: "ГОЛОВНА ОСОБА", title: "ДОСЬЄ", "breaking-news": "ТЕРМІНОВІ НОВИНИ", "location-stamp": "ЛОКАЦІЯ", "chapter-card": "РОЗДІЛ", "redacted-doc": "СЕКРЕТНО", "typewriter": "ПІДТВЕРДЖЕНО" },
    ru: { number: "ЗАФИКСИРОВАННЫЕ ДАННЫЕ", document: "ЗАПИСЬ АРХИВА", timeline: "ХРОНОЛОГИЯ", warning: "СИГНАЛ ТРЕВОГИ", quote: "ЗАЯВЛЕНИЕ", analysis: "СЛЕДСТВЕННЫЙ ЛОГ", place: "ЛОКАЦИЯ", person: "ГЛАВНОЕ ЛИЦО", title: "ДОСЬЕ", "breaking-news": "СРОЧНО В ЭФИР", "location-stamp": "ЛОКАЦИЯ", "chapter-card": "РАЗДЕЛ", "redacted-doc": "СЕКРЕТНО", "typewriter": "ПОДТВЕРЖДЕНО" },
    de: { number: "FAKT", document: "AKTENNOTIZ", timeline: "CHRONOLOGIE", warning: "WARNHINWEIS", quote: "AUSSAGE", analysis: "BEWEISLOG", place: "ORT", person: "HAUPTPERSON", title: "AKTE", "breaking-news": "EILMELDUNG", "location-stamp": "STANDORT", "chapter-card": "KAPITEL", "redacted-doc": "GEHEIM", "typewriter": "BESTÄTIGT" }
  };
  return (map[lang] || map.en)[type] || (map[lang] || map.en).title;
}
// Returns { title, sublabel } for an insert. Pulls real content first; falls
// back to phrase bank only as a last resort. `usedTitles` tracks already-shown
// phrases to suppress duplicates within a single render.
function buildSmartInsertContent(rawText = "", type = "title", index = 0, lang = "en", usedTitles = new Set(), globalMood = null) {
  const source = stripInsertNoise(rawText);
  const genre = globalMood?.genre || "documentary";
  let title = "";
  let sublabel = "";

  if (type === "timeline") {
    const dateStr = detectMonthYear(source);
    if (dateStr) { title = dateStr; sublabel = defaultSublabel("timeline", lang); }
  }
  if (!title && type === "number") {
    const num = extractKeyNumber(source);
    if (num) { title = num; sublabel = defaultSublabel("number", lang); }
  }
  if (!title && type === "quote") {
    const phrase = extractKeyPhrase(source, 6);
    if (phrase) { title = phrase; sublabel = defaultSublabel("quote", lang); }
  }
  // New types: extract longer real text from narration
  if (!title && type === "breaking-news") {
    const phrase = extractKeyPhrase(source, 7);
    if (phrase) { title = phrase; sublabel = defaultSublabel("breaking-news", lang); }
  }
  if (!title && type === "location-stamp") {
    // Try to extract actual location name from text
    const locMatch = source.match(/\b(Kyiv|Київ|Москва|Berlin|London|Paris|Warsaw|Варшав\w*|Лондон|Париж|Берлін|Польщ\w*|Україн\w*|Росі\w*|Germany|France|Poland|Ukraine|Russia|America|China|Japan|[A-ZА-ЯҐЇІЄ][a-zа-яґїіє]+ (?:Oblast|Region|Province|District|область|район|провінц))/);
    if (locMatch) { title = locMatch[0]; sublabel = defaultSublabel("location-stamp", lang); }
    else {
      const phrase = extractKeyPhrase(source, 5);
      if (phrase) { title = phrase; sublabel = defaultSublabel("location-stamp", lang); }
    }
  }
  if (!title && type === "redacted-doc") {
    const phrase = extractKeyPhrase(source, 6);
    if (phrase) { title = phrase; sublabel = defaultSublabel("redacted-doc", lang); }
  }
  if (!title && type === "typewriter") {
    // Extract the revelation sentence — the longest sentence with a confirm/reveal word
    const sentences = source.split(/(?<=[.!?])\s+/).filter(s => s.length > 8);
    const revealSentence = sentences.find(s => /(revealed|discovered|confirmed|виявлен|підтверджен|виявилось|оказалось|подтвержден|обнаружен)/i.test(s));
    const phrase = compactWords(revealSentence || sentences[0] || source, 8);
    if (phrase) { title = phrase; sublabel = defaultSublabel("typewriter", lang); }
  }
  if (!title && type === "chapter-card") {
    const phrase = extractKeyPhrase(source, 5);
    if (phrase) { title = phrase; sublabel = defaultSublabel("chapter-card", lang); }
  }
  if (!title) {
    // Mood-aware extraction: pick the sentence from the segment that best matches
    // the detected narrative genre, so the insert text feels native to the story.
    const sentences = source.split(/(?<=[.!?…])\s+/).filter(s => s.trim().length > 8);
    const sLower = (s) => s.toLowerCase();
    let bestSentence = "";

    if (sentences.length > 1) {
      if (genre === "thriller") {
        // Pick sentence with most tension/action words
        bestSentence = sentences
          .map(s => ({ s, score: (sLower(s).match(/(died|killed|shot|arrested|ran|screamed|feared|suddenly|знали|вбили|загинув|заарештували)/g) || []).length }))
          .sort((a, b) => b.score - a.score)[0].s;
      } else if (genre === "investigation") {
        bestSentence = sentences
          .map(s => ({ s, score: (sLower(s).match(/(evidence|witness|document|found|investigation|доказ|свідок|документ|знайшли|слідств)/g) || []).length }))
          .sort((a, b) => b.score - a.score)[0].s;
      } else if (genre === "personal") {
        bestSentence = sentences
          .map(s => ({ s, score: (sLower(s).match(/(she|he|mother|father|child|alone|tears|він|вона|мати|батько|дитина|сльози|самотн)/g) || []).length }))
          .sort((a, b) => b.score - a.score)[0].s;
      } else if (genre === "news") {
        // Pick longest declarative sentence (news-style lead)
        bestSentence = sentences.sort((a, b) => b.length - a.length)[0];
      }
    }

    // More words for dramatic genres so inserts feel content-rich
    const phraseLen = genre === "thriller" || genre === "investigation" ? 7 : genre === "news" ? 8 : 5;
    const phrase = extractKeyPhrase(bestSentence || source, phraseLen);
    const sanitized = sanitizeInsertTitle(phrase, lang);
    if (sanitized && sanitized.split(/\s+/).length >= 2 && !usedTitles.has(sanitized.toLowerCase())) {
      title = sanitized;
      sublabel = defaultSublabel(type, lang);
    }
  }
  if (!title) {
    // Last resort: phrase bank, but skip recently used
    const bank = insertPhraseBank(lang, type);
    for (let k = 0; k < bank.length; k += 1) {
      const candidate = bank[(index + k) % bank.length];
      if (!usedTitles.has(candidate.toLowerCase())) { title = candidate; break; }
    }
    if (!title) title = bank[index % bank.length];
    sublabel = defaultSublabel(type, lang);
  }

  // For headline-style layouts, force uppercase look on title.
  const upperTitle = title.toUpperCase();
  usedTitles.add(title.toLowerCase());
  return { title: upperTitle, sublabel: (sublabel || "").toUpperCase() };
}

function compactWords(text, maxWords = 7) {
  const words = String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  return words.slice(0, maxWords).join(" ").trim();
}

function normalizeInsertLine(text, maxLen = 48) {
  const clean = String(text || "")
    .replace(/[“”"]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return "";
  if (clean.length <= maxLen) return clean;
  return `${clean.slice(0, maxLen - 1).trim()}…`;
}

function wrapInsertText(text, maxLineLength = 24, maxLines = 2) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length <= maxLineLength) {
      current = next;
      continue;
    }
    if (current) lines.push(current);
    current = word;
    if (lines.length >= maxLines - 1) break;
  }
  if (current && lines.length < maxLines) lines.push(current);
  return lines.map((line) => normalizeInsertLine(line, maxLineLength)).filter(Boolean);
}

function pickFirstMatch(text = "", patterns = []) {
  for (const pattern of patterns) {
    const match = String(text || "").match(pattern);
    if (match?.[0]) return match[0];
  }
  return "";
}

function detectTextLanguage(text = "") {
  const source = String(text || "").toLowerCase();
  const cyrillic = (source.match(/[а-яіїєґё]/g) || []).length;
  const ukrainianHits = (source.match(/\b(він|вона|його|її|що|цей|ця|було|після|перед|тому|людина|люди|року|тюрм|в'язниц|слід|доказ|архів)\b|[іїєґ]/g) || []).length;
  const russianHits = (source.match(/\b(он|она|его|ее|что|этот|эта|было|после|перед|поэтому|человек|люди|года|тюрьм|след|доказ|архив)\b|[ёъыэ]/g) || []).length;
  const germanHits = (source.match(/\b(der|die|das|und|nicht|ein|eine|einem|dass|wurde|waren|hatte|nach|vor|später|lager|gefängnis|akte|warnung)\b|[äöüß]/g) || []).length;

  if (cyrillic > 0) return ukrainianHits >= russianHits ? "uk" : "ru";
  if (germanHits >= 2) return "de";
  return "en";
}

function normalizeInsertLanguage(value = "") {
  const raw = String(value || "").toLowerCase().trim();
  const short = raw.slice(0, 2);
  if (["uk", "ru", "en", "de"].includes(short)) return short;
  return "";
}

function stripInsertNoise(text = "") {
  return String(text || "")
    .replace(/\b(keyframe|clip|frame|b-roll|broll|stock footage|source title)\b/gi, "")
    .replace(/[“”"]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function insertPhraseBank(lang, type) {
  const banks = {
    en: {
      warning: ["A Quiet Warning Appeared", "The Risk Was Already Clear", "One Signal Changed Everything"],
      quote: ["The Words Changed The Room", "One Sentence Stayed Behind", "The Answer Was Too Calm"],
      document: ["The Archive Revealed A Detail", "The File Changed Everything", "One Record Raised Questions"],
      number: ["The Scale Became Impossible", "The Number Told The Story", "One Figure Explained Everything"],
      timeline: ["Then Everything Shifted", "That Moment Changed The Timeline", "The Next Step Was Decisive"],
      analysis: ["The Pattern Became Clear", "One Detail Did Not Fit", "The Evidence Pointed Elsewhere"],
      place: ["Behind Those Doors", "Inside The Silent Corridor", "The Location Mattered"],
      person: ["One Person Became The Focus", "Her Silence Said Too Much", "The Face Stayed Unreadable"],
      title: ["The Truth Was Still Hidden", "No One Saw It Coming", "The Past Started Speaking"],
      "breaking-news": ["Confirmed: Major Development", "The Story Breaks Wide Open", "What Happened Next Changed Everything"],
      "location-stamp": ["The Location Mattered Most", "Behind These Walls", "A Place Nobody Talked About"],
      "chapter-card": ["A New Chapter Begins", "The Story Shifts", "What Came Next"],
      "redacted-doc": ["The File Was Never Meant To Be Seen", "Parts Of The Record Were Missing", "Someone Crossed Out The Truth"],
      "typewriter": ["The Key Fact Emerged", "One Detail Confirmed Everything", "The Evidence Was Undeniable"]
    },
    uk: {
      warning: ["Тиха тривога вже звучала", "Ризик був надто очевидний", "Один сигнал змінив усе"],
      quote: ["Ці слова змінили кімнату", "Одна фраза залишилась", "Відповідь була надто спокійна"],
      document: ["Архів відкрив нову деталь", "Файл змінив усе", "Один запис викликав питання"],
      number: ["Масштаб став неможливим", "Цифра сказала все", "Один факт пояснив усе"],
      timeline: ["Потім усе зрушило", "Цей момент змінив хід подій", "Наступний крок став вирішальним"],
      analysis: ["Схема стала очевидною", "Одна деталь не сходилась", "Докази вели в інший бік"],
      place: ["За цими дверима", "У тихому коридорі", "Місце мало значення"],
      person: ["Одна людина стала фокусом", "Її мовчання сказало більше", "Обличчя лишалось спокійним"],
      title: ["Правда ще була прихована", "Ніхто цього не очікував", "Минуле почало говорити"],
      "breaking-news": ["Підтверджено: нова подія", "Це змінило все", "Те, що сталося далі"],
      "location-stamp": ["Місце мало вирішальне значення", "За цими стінами", "Про це місце мовчали"],
      "chapter-card": ["Новий розділ починається", "Оповідь змінює напрямок", "Що сталося далі"],
      "redacted-doc": ["Цей файл не мали побачити", "Частина записів зникла", "Хтось закреслив правду"],
      "typewriter": ["Ключовий факт спливає", "Одна деталь підтвердила все", "Докази були незаперечними"]
    },
    ru: {
      warning: ["Тихая тревога уже звучала", "Риск был слишком очевиден", "Один сигнал изменил всё"],
      quote: ["Эти слова изменили комнату", "Одна фраза осталась", "Ответ был слишком спокойным"],
      document: ["Архив открыл новую деталь", "Файл изменил всё", "Одна запись вызвала вопросы"],
      number: ["Масштаб стал невозможным", "Цифра сказала всё", "Один факт объяснил всё"],
      timeline: ["Потом всё сдвинулось", "Этот момент изменил ход событий", "Следующий шаг стал решающим"],
      analysis: ["Схема стала очевидной", "Одна деталь не сходилась", "Доказательства вели в другую сторону"],
      place: ["За этими дверями", "В тихом коридоре", "Место имело значение"],
      person: ["Один человек стал фокусом", "Её молчание сказало больше", "Лицо оставалось спокойным"],
      title: ["Правда всё ещё была скрыта", "Никто этого не ожидал", "Прошлое начало говорить"],
      "breaking-news": ["Подтверждено: новое событие", "Это изменило всё", "То, что случилось дальше"],
      "location-stamp": ["Место имело решающее значение", "За этими стенами", "Об этом месте молчали"],
      "chapter-card": ["Новая глава начинается", "Рассказ меняет направление", "Что случилось дальше"],
      "redacted-doc": ["Этот файл не должны были увидеть", "Часть записей исчезла", "Кто-то вычеркнул правду"],
      "typewriter": ["Ключевой факт всплывает", "Одна деталь подтвердила всё", "Доказательства были неопровержимы"]
    },
    de: {
      warning: ["Eine stille Warnung erschien", "Das Risiko war schon klar", "Ein Signal änderte alles"],
      quote: ["Dieser Satz veränderte den Raum", "Eine Antwort blieb zurück", "Die Worte klangen zu ruhig"],
      document: ["Die Akte zeigte ein Detail", "Ein Dokument änderte alles", "Ein Eintrag war entscheidend"],
      number: ["Die Zahl erzählte alles", "Das Ausmaß wurde sichtbar", "Eine Zahl erklärte alles"],
      timeline: ["Dann verschob sich alles", "Dieser Moment änderte den Verlauf", "Der nächste Schritt war entscheidend"],
      analysis: ["Das Muster wurde sichtbar", "Ein Detail passte nicht", "Die Spuren führten weiter"],
      place: ["Hinter diesen Türen", "In einem stillen Korridor", "Der Ort war entscheidend"],
      person: ["Eine Person rückte in den Fokus", "Ihr Schweigen sagte mehr", "Das Gesicht blieb ruhig"],
      title: ["Die Wahrheit blieb verborgen", "Niemand sah es kommen", "Die Vergangenheit sprach wieder"],
      "breaking-news": ["Bestätigt: Neue Entwicklung", "Das änderte alles", "Was dann geschah"],
      "location-stamp": ["Der Ort war entscheidend", "Hinter diesen Mauern", "Über diesen Ort schwieg man"],
      "chapter-card": ["Ein neues Kapitel beginnt", "Die Geschichte nimmt eine Wende", "Was dann folgte"],
      "redacted-doc": ["Diese Akte war nicht für Augen bestimmt", "Teile des Dokuments fehlten", "Jemand schwärzte die Wahrheit"],
      "typewriter": ["Die entscheidende Tatsache kommt ans Licht", "Ein Detail bestätigte alles", "Die Beweise waren eindeutig"]
    }
  };
  return banks[lang]?.[type] || banks.en[type] || banks.en.title;
}

function buildCinematicInsertText(text = "", type = "title", index = 0, forcedLanguage = "") {
  const source = stripInsertNoise(text);
  const lower = source.toLowerCase();
  const lang = normalizeInsertLanguage(forcedLanguage) || detectTextLanguage(source);
  const year = pickFirstMatch(source, [/\b(18|19|20)\d{2}\b/]);
  const number = pickFirstMatch(source, [/(?:[$€£₴]\s?)?\b\d+(?:[.,]\d+)?\s?(?:%|percent|відсотків|процент|usd|eur|uah|million|billion|тис|млн|млрд)?\b/i]);
  const hasPrison = /(prison|jail|cell|camp|concentration|таб[іо]р|концтаб|тюрм|в'язниц|лагер|gefängnis|lager)/i.test(lower);
  const hasWar = /(war|soldier|army|military|nazi|ss|hitler|військ|солдат|нацист|гітлер|войн|гитлер|krieg)/i.test(lower);
  const hasCrime = /(crime|murder|missing|disappear|investigation|police|detective|зник|вбив|слідств|поліці|исчез|убий|следств|полици|ermittlung)/i.test(lower);
  const hasDocument = /(document|archive|file|report|protocol|record|архів|документ|файл|протокол|звіт|архив|отчет|akte|bericht)/i.test(lower);
  const hasWarning = /(warning|danger|risk|alarm|threat|поперед|небезп|ризик|тривог|угроз|опасн|warnung|gefahr|risiko)/i.test(lower);
  const hasNight = /(night|midnight|dark|ніч|темряв|ноч|dunkel|nacht)/i.test(lower);
  const hasDoor = /(door|opened|locked|gate|двер|відчин|замкн|ворот|открыл|закрыт|tür|tor)/i.test(lower);

  if (type === "number" && (year || number)) {
    const value = year || number;
    if (lang === "uk") return hasPrison ? `${value} — двері відчинились` : `${value} — масштаб став видимим`;
    if (lang === "ru") return hasPrison ? `${value} — двери открылись` : `${value} — масштаб стал видимым`;
    if (lang === "de") return hasPrison ? `${value} — die Türen öffneten sich` : `${value} — das Ausmaß wurde sichtbar`;
    return hasPrison ? `${value} — The Doors Opened` : `${value} — The Scale Became Clear`;
  }

  const thematic = [];
  if (hasWarning) thematic.push(insertPhraseBank(lang, "warning")[index % insertPhraseBank(lang, "warning").length]);
  if (hasDocument) thematic.push(insertPhraseBank(lang, "document")[(index + 1) % insertPhraseBank(lang, "document").length]);
  if (hasPrison) thematic.push(insertPhraseBank(lang, "place")[(index + 2) % insertPhraseBank(lang, "place").length]);
  if (hasWar) thematic.push(insertPhraseBank(lang, "analysis")[(index + 3) % insertPhraseBank(lang, "analysis").length]);
  if (hasCrime) thematic.push(insertPhraseBank(lang, "analysis")[(index + 4) % insertPhraseBank(lang, "analysis").length]);
  if (hasNight || hasDoor) thematic.push(insertPhraseBank(lang, "timeline")[(index + 5) % insertPhraseBank(lang, "timeline").length]);

  const bank = insertPhraseBank(lang, type);
  return sanitizeInsertTitle(thematic[0] || bank[index % bank.length], lang);
}

function sanitizeInsertTitle(text = "", lang = "en") {
  const cleaned = stripInsertNoise(text)
    .replace(/[^\p{L}\p{N}\s.,:;!?—-]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return insertPhraseBank(lang, "title")[0];
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length <= 8) return cleaned;
  return words.slice(0, 8).join(" ");
}

function detectProfInsertType(text, montageSettings = {}, globalMood = null) {
  const source = stripInsertNoise(text);
  if (!source) return null;
  const lower = source.toLowerCase();
  const hasNumber = /(?:[$€£₴]\s?\d|\d+\s?(?:%|percent|відсот|процент|usd|eur|uah|million|billion|тис|млн|млрд))/i.test(source) || /\b\d{4}\b/.test(source);
  const hasDocument = /(nda|document|agreement|contract|report|archive|protocol|record|file|протокол|архів|звіт|документ|договір|угода|файл|архив|отчет|akte|bericht)/i.test(lower);
  const hasTimeline = /(first|second|third|then|after|before|later|next|start|phase|stage|october|november|december|january|february|march|april|may|june|july|august|september|жовт|листоп|груд|січ|лют|берез|квіт|трав|черв|лип|серп|верес|етап|потім|після|спочатку|потом|после|сначала|dann|später|danach|zuerst)/i.test(lower);
  const hasWarning = /(warning|danger|risk|alarm|threat|поперед|небезп|ризик|тривог|угроз|опасн|warnung|gefahr|risiko)/i.test(lower);
  const hasQuote = /[«»”””]/.test(source) || /\b(said|asked|answered|told|сказ|запит|відпов|говор|спрос|ответ|sagte|fragte|antwortete)\b/i.test(lower);
  const hasPlace = /(prison|jail|court|camp|cell|corridor|room|street|hospital|school|тюрм|в'язниц|суд|таб[іо]р|камера|коридор|кімнат|вулиц|лікар|школ|тюрьм|лагер|комнат|улиц|gefängnis|gericht|zimmer|korridor)/i.test(lower);
  const hasPerson = /(girl|woman|man|child|soldier|officer|guard|дівчин|жінк|чоловік|дитин|солдат|офіцер|охорон|девуш|женщин|мужчин|ребен|soldat|offizier|wache|frau|mann|kind)/i.test(lower);
  const hasAnalysis = /(evidence|pattern|detail|proof|investigation|reason|cause|доказ|схем|детал|причин|слідств|улика|beweis|muster|grund)/i.test(lower);
  const wordCount = source.split(/\s+/).filter(Boolean).length;

  // ── New smart types — checked FIRST (higher specificity) ─────────────────────
  const hasDramatic = /(died|killed|executed|sentenced|arrested|shot dead|murder|explosion|disaster|catastrophe|tragedy|загин|вбит|розстріл|засуджен|заарешт|вбивств|трагед|вибух|катастроф|загибель|умер|погиб|расстрел|арестован|взорвал|убийств|gestorben|getötet|erschossen|verhaftet|katastrophe|verurteilt)/i.test(lower);
  const hasLocationName = /\b(kyiv|київ|москва|berlin|london|paris|new york|washington|warsaw|варшав|лондон|париж|берлін|польщ|україн|росі|germany|france|poland|ukraine|russia|america|china|japan|місто|столиц|область|район|провін|region|province|district|oblast)\b/i.test(lower);
  const hasClassified = /(classified|top secret|confidential|restricted|declassified|redacted|конфіденціал|таємн|засекречен|секретн|нерозсекречен|geheim|vertraulich|eingestuft)/i.test(lower);
  const hasRevealFact = /\b(revealed|discovered|found out|uncovered|confirmed|it turned out|виявлен|відкрит|підтверджен|виявилось|стало відомо|оказалось|подтверждено|обнаружен|enthüllt|herausgefunden|bestätigt)\b/i.test(lower);

  if (hasDramatic && montageSettings.proInsertBreakingNews) return "breaking-news";
  if (hasClassified && montageSettings.proInsertRedactedDoc) return "redacted-doc";
  if (hasRevealFact && montageSettings.proInsertTypewriter) return "typewriter";
  if (hasLocationName && montageSettings.proInsertLocationStamp) return "location-stamp";
  // ─────────────────────────────────────────────────────────────────────────────

  if (hasWarning && montageSettings.proInsertTitle) return "warning";
  if (hasQuote && montageSettings.proInsertTitle) return "quote";
  if (hasDocument && montageSettings.proInsertDocument) return "document";
  if (hasNumber && montageSettings.proInsertNumber) return "number";
  if (hasTimeline && montageSettings.proInsertTimeline) return "timeline";
  if (hasAnalysis && montageSettings.proInsertTitle) return "analysis";
  if (hasPlace && montageSettings.proInsertTitle) return "place";
  if (hasPerson && montageSettings.proInsertTitle) return "person";
  // Don't auto-create generic title cards on plain dialogue lines.
  // Title insert needs an actual hook (proper noun, capitalized phrase, named
  // entity) — not just "когда она подросла, она".
  const hasProperNoun = /\b[A-ZА-ЯҐЇІЄ][a-zа-яґїіє]{2,}/.test(source) && /\b[A-ZА-ЯҐЇІЄ][a-zа-яґїіє]{2,}\b.*\b[A-ZА-ЯҐЇІЄ][a-zа-яґїіє]{2,}\b/.test(source);
  if (wordCount >= 6 && hasProperNoun && montageSettings.proInsertTitle) return "title";

  // ── Mood-based fallback: when no keyword matches but the global narrative
  // tone is strong, use a lower-threshold signal to infer an insert type.
  // Thresholds are intentionally low — most narratives sit at intensity
  // 0.05-0.25, so 0.30+ thresholds meant new inserts never fired in practice.
  if (globalMood && wordCount >= 4) {
    const genre = globalMood.genre;
    const intensity = globalMood.intensity || 0;
    const hasAction  = /(walked|entered|stood|looked|turned|realized|knew|felt|heard|saw|зайш|відчу|зрозумі|побач|почу|поверну|увій|подив|вош|почувств|понял|увид|услыш)/i.test(lower);
    const hasNarrate = /(he |she |they |it was|there was|when |then |він |вона |вони |це було|там |коли |тоді |он |она |они |когда |тогда |es war)/i.test(lower);

    if (genre === "thriller" && intensity > 0.10 && (hasAction || hasNarrate) && montageSettings.proInsertBreakingNews) {
      return "breaking-news";
    }
    if (genre === "investigation" && intensity > 0.10 && hasNarrate && montageSettings.proInsertRedactedDoc) {
      return "redacted-doc";
    }
    if (genre === "personal" && intensity > 0.08 && hasNarrate && montageSettings.proInsertTypewriter) {
      return "typewriter";
    }
    if (genre === "news" && intensity > 0.10 && (hasAction || hasNarrate) && montageSettings.proInsertLocationStamp) {
      return "location-stamp";
    }
    // Generic high-intensity → typewriter (subtle, works for any genre)
    if (intensity > 0.20 && hasNarrate && montageSettings.proInsertTypewriter) {
      return "typewriter";
    }
    if (intensity > 0.25 && hasNarrate && montageSettings.proInsertTitle) {
      return "title";
    }
  }

  return null;
}

function resolveMontageInsertLanguage(timeline = [], montageSettings = {}) {
  const explicit = normalizeInsertLanguage(montageSettings.language || "");
  if (explicit) return explicit;

  const combinedText = Array.isArray(timeline)
    ? timeline.map((item) => item?.text || "").join(" ").slice(0, 8000)
    : "";
  const detected = detectTextLanguage(combinedText);
  if (detected) return detected;

  return normalizeInsertLanguage(montageSettings.focusLanguage || "") || "en";
}

function pickProfInsertLayout(type, index = 0) {
  const layouts = {
    title: ["center-title", "side-card", "lower-third"],
    warning: ["alert-card", "lower-third", "center-title"],
    quote: ["quote-card", "side-card"],
    document: ["document-card", "stamp-card", "side-card"],
    number: ["big-number", "metric-bars", "ring-stat"],
    timeline: ["timeline-line", "step-card"],
    analysis: ["metric-bars", "evidence-board", "side-card"],
    place: ["lower-third", "center-title", "side-card"],
    person: ["side-card", "lower-third", "quote-card"]
  }[type] || ["center-title"];
  return layouts[index % layouts.length];
}

function pickProfOverlayLayout(type, index = 0, settings = {}, globalMood = null) {
  const genre = globalMood?.genre || "documentary";

  // Base layout pools per insert type.
  const base = {
    title:            ["headline-card", "photo-frame", "title-stack", "tag-pill", "overlay-center"],
    warning:          ["tag-pill", "overlay-pulse", "headline-card"],
    quote:            ["split-screen", "headline-card", "overlay-center", "overlay-lower"],
    document:         ["tag-pill", "overlay-side", "headline-card"],
    number:           ["counter-callout", "stat-callout", "headline-card"],
    timeline:         ["date-stamp", "headline-card", "overlay-lower"],
    analysis:         ["split-screen", "bar-chart", "headline-card", "overlay-side"],
    place:            ["photo-frame", "corner-flag", "tag-pill", "overlay-lower"],
    person:           ["photo-frame", "headline-card", "overlay-side", "tag-pill"],
    "breaking-news":  ["news-ticker", "overlay-pulse", "headline-card"],
    "location-stamp": ["location-stamp", "corner-flag", "overlay-lower"],
    "chapter-card":   ["chapter-card", "headline-card", "title-stack"],
    "redacted-doc":   ["redacted-doc", "overlay-side", "tag-pill"],
    "typewriter":     ["typewriter-card", "overlay-center", "title-stack"]
  };

  // Genre-aware overrides: re-order or substitute layouts to match narrative tone.
  // This means the same insert TYPE gets a different VISUAL depending on the story.
  const moodOverrides = {
    thriller: {
      title:    ["headline-card", "chapter-card", "title-stack", "overlay-pulse"],
      quote:    ["headline-card", "overlay-pulse", "overlay-center"],
      place:    ["chapter-card", "photo-frame", "overlay-lower"],
      person:   ["headline-card", "overlay-pulse", "photo-frame"],
      analysis: ["redacted-doc", "overlay-side", "headline-card"]
    },
    investigation: {
      title:    ["overlay-side", "headline-card", "corner-flag", "tag-pill"],
      document: ["redacted-doc", "overlay-side", "tag-pill"],
      analysis: ["redacted-doc", "bar-chart", "overlay-side"],
      person:   ["overlay-side", "corner-flag", "tag-pill"],
      quote:    ["typewriter-card", "overlay-side", "overlay-center"]
    },
    news: {
      title:    ["news-ticker", "overlay-pulse", "headline-card"],
      warning:  ["news-ticker", "overlay-pulse", "tag-pill"],
      place:    ["location-stamp", "news-ticker", "corner-flag"],
      timeline: ["date-stamp", "news-ticker", "overlay-lower"]
    },
    personal: {
      title:    ["photo-frame", "split-screen", "overlay-center", "tag-pill"],
      quote:    ["split-screen", "overlay-center", "overlay-lower"],
      person:   ["photo-frame", "split-screen", "overlay-lower"],
      place:    ["photo-frame", "overlay-lower", "corner-flag"]
    },
    documentary: {
      number:   ["stat-callout", "counter-callout", "bar-chart"],
      timeline: ["date-stamp", "bar-chart", "overlay-lower"],
      analysis: ["bar-chart", "stat-callout", "overlay-side"]
    }
  };

  const override = moodOverrides[genre]?.[type];
  const pool = (override || base[type] || ["overlay-lower"]).filter((l) => {
    if (l === "photo-frame" && settings.proInsertPhotoFrame === false) return false;
    if (l === "split-screen" && settings.proInsertSplitScreen === false) return false;
    return true;
  });
  return (pool.length ? pool : ["overlay-lower"])[index % (pool.length || 1)];
}

// Returns unique content words (>4 chars) from text for topic-change detection.
function getTopicKeywords(text = "") {
  const STOP = new Set(["that","this","with","from","have","they","were","will","been","when","than","their","said","which","what","then","more","also","some","into","after","about","over","other","these","would","there","could","before","between","during","through","перед","після","потім","також","коли","буде","який","яка","які","його","своє","якщо","тому","адже","хоча","після","поки","якщо","можна","навіть","вони","його","вона","також"]);
  return new Set(
    text.toLowerCase().split(/\W+/).filter(w => w.length > 4 && !STOP.has(w) && isNaN(Number(w)))
  );
}

// Returns true if current segment has < 20% keyword overlap with recent context.
function isTopicChange(currentText = "", recentTexts = []) {
  const current = getTopicKeywords(currentText);
  if (current.size < 3) return false;
  const prevWords = new Set(recentTexts.flatMap(t => [...getTopicKeywords(t)]));
  if (prevWords.size === 0) return false;
  const overlap = [...current].filter(w => prevWords.has(w)).length;
  return overlap / current.size < 0.20;
}

function buildProfInsertTimeline(timeline, montageSettings = {}) {
  if (!Array.isArray(timeline) || montageSettings.proMontageMode === "off") {
    return Array.isArray(timeline) ? timeline.map((item) => ({ ...item })) : [];
  }

  const densityConfig = {
    low: { minGapSeconds: 12, minGapSegments: 3, maxPerMinute: 2.2, forcedEvery: 5 },
    medium: { minGapSeconds: 8, minGapSegments: 2, maxPerMinute: 4.0, forcedEvery: 3 },
    high: { minGapSeconds: 5, minGapSegments: 1, maxPerMinute: 6.5, forcedEvery: 2 }
  };
  const density = densityConfig[montageSettings.proInsertDensity] || densityConfig.medium;
  const modeBoost = montageSettings.proMontageMode === "intense" ? 0.55 : 1;
  const insertLanguage = resolveMontageInsertLanguage(timeline, montageSettings);
  // Analyse the entire transcript once so all insert decisions share the same
  // narrative context: genre, intensity, dominant emotion signals.
  const globalMood = analyzeTranscriptMood(timeline);
  const usedTitles = new Set();
  const result = [];
  let lastInsertStart = -Infinity;
  let lastInsertSegment = -Infinity;
  let lastChapterCardStart = -Infinity;
  let insertsAdded = 0;
  let chapterNumber = 0;
  // Sliding window of last 4 segment texts for topic change detection
  const recentTexts = [];

  for (let i = 0; i < timeline.length; i += 1) {
    const item = { ...timeline[i] };
    const itemDuration = Math.max(0.6, Number(item.duration || 0));
    const processedMinutes = Math.max(1, Number(item.start || 0) / 60);
    const currentRate = insertsAdded / processedMinutes;
    // We no longer force a title-card every N segments — that produced generic
    // bank phrases on plain dialogue. Inserts are now driven entirely by
    // detected hooks (number, date, document, warning, quote, analysis, place,
    // person, or text with proper-noun pairs).
    let insertType = detectProfInsertType(item.text, montageSettings, globalMood);

    // Smart chapter-card: inject at topic changes (min 30s gap between chapter cards)
    if (!insertType && montageSettings.proInsertChapterCard && recentTexts.length >= 3) {
      const timeSinceChapter = Number(item.start || 0) - lastChapterCardStart;
      if (timeSinceChapter >= 30 && isTopicChange(item.text, recentTexts)) {
        insertType = "chapter-card";
      }
    }

    // Maintain rolling context window
    if (item.text) {
      recentTexts.push(item.text);
      if (recentTexts.length > 4) recentTexts.shift();
    }
    const enoughRoom = itemDuration >= 2.4;
    const farEnoughInTime = Number(item.start || 0) - lastInsertStart >= density.minGapSeconds * modeBoost;
    const farEnoughInSegments = i - lastInsertSegment >= Math.max(1, Math.floor(density.minGapSegments * modeBoost));
    const underRate = currentRate < density.maxPerMinute;

    if (insertType && enoughRoom && farEnoughInTime && farEnoughInSegments && (underRate || insertType === "chapter-card")) {
      const insertDurationMap = {
        title: 3.0,
        number: 3.4,
        document: 3.8,
        timeline: 3.4,
        warning: 3.2,
        quote: 3.2,
        analysis: 3.8,
        place: 2.8,
        person: 3.0,
        "breaking-news":  3.5,
        "location-stamp": 3.0,
        "chapter-card":   4.0,
        "redacted-doc":   4.2,
        "typewriter":     3.8
      };
      // Insert appears AFTER the voice has had time to set context — at ~40%
      // into the segment, capped at 1.6s. That way headlines never beat the
      // narration to the punchline.
      const startOffset = Math.max(0.5, Math.min(itemDuration * 0.42, 1.6));
      const remainingRoom = Math.max(1.4, itemDuration - startOffset - 0.30);
      const insertDuration = Math.min(insertDurationMap[insertType] || 3.0, remainingRoom, 4.2);
      const smart = buildSmartInsertContent(item.text, insertType, insertsAdded + i, insertLanguage, usedTitles, globalMood);
      const insertText = smart.title || buildCinematicInsertText(item.text, insertType, insertsAdded + i, insertLanguage);

      // Проф-вставка має жити на тому самому сегменті, а не зсувати таймлайн окремим кліпом.
      item.overlayInsert = {
        type: insertType,
        layout: pickProfOverlayLayout(insertType, insertsAdded + i, montageSettings, globalMood),
        text: insertText,
        title: insertText,
        sublabel: smart.sublabel || "",
        language: insertLanguage,
        duration: insertDuration,
        startOffset,
        paletteIndex: insertsAdded
      };

      if (insertType === "chapter-card") {
        chapterNumber += 1;
        lastChapterCardStart = Number(item.start || 0);
        // Embed chapter number into sublabel so the filter can use it
        item.overlayInsert.chapterNumber = chapterNumber;
        item.overlayInsert.sublabel = `${defaultSublabel("chapter-card", insertLanguage)} ${chapterNumber}`;
      }
      lastInsertStart = Number(item.start || 0);
      lastInsertSegment = i;
      insertsAdded += 1;
    }

    result.push(item);
  }

  return result;
}

async function buildProfInsertClip({ type, layout, text, duration, outputPath, tempDir }) {
  const safeDuration = Math.max(1.8, Math.min(6.0, Number(duration) || 3.0));
  const source = sanitizeInsertTitle(text, detectTextLanguage(text));
  const lines = wrapInsertText(source, type === "number" ? 18 : 24, type === "timeline" ? 2 : 2);
  const numberMatch = source.match(/([$€£₴]?\s?\d+(?:[.,]\d+)?\s?(?:%|percent|USD|EUR|UAH|million|billion|тис|млн|млрд)?)/i);
  const bigNumber = normalizeInsertLine(numberMatch?.[1] || compactWords(source, 4) || "FACT", 18);
  const titleLine = normalizeInsertLine(lines[0] || compactWords(source, 6) || "Main moment", 24);
  let bodyLine = normalizeInsertLine(lines.slice(1).join(" ") || (type === "title" ? "" : source), 34);
  if (bodyLine.toLowerCase() === titleLine.toLowerCase()) bodyLine = "";
  const themeColor = {
    title: "#0f172a",
    number: "#0c4a6e",
    document: "#3f1d2e",
    timeline: "#16302b",
    warning: "#3b1414",
    quote: "#141827",
    analysis: "#10223c",
    place: "#1f2933",
    person: "#241a35"
  }[type] || "#0f172a";
  const accentColor = {
    title: "#60a5fa",
    number: "#f59e0b",
    document: "#fb7185",
    timeline: "#34d399",
    warning: "#f97316",
    quote: "#e5e7eb",
    analysis: "#38bdf8",
    place: "#a7f3d0",
    person: "#c084fc"
  }[type] || "#60a5fa";
  const textColor = "#f8fafc";

  const titleFile = path.join(tempDir, `insert_${type}_${randomUUID()}_title.txt`);
  const bodyFile = path.join(tempDir, `insert_${type}_${randomUUID()}_body.txt`);
  await fs.writeFile(titleFile, type === "number" ? bigNumber : titleLine, "utf8");
  await fs.writeFile(bodyFile, type === "timeline" ? lines.join("  •  ") : bodyLine, "utf8");

  const escapedTitle = escapeDrawtextPath(titleFile);
  const escapedBody = escapeDrawtextPath(bodyFile);
  const filters = [
    `color=c=${themeColor}:s=1280x720:d=${safeDuration}`,
    `drawbox=x=0:y=0:w=1280:h=720:color=black@0.18:t=fill`,
    `drawbox=x=0:y=0:w=1280:h=6:color=${accentColor}@0.85:t=fill`,
    `drawbox=x=0:y=714:w=1280:h=6:color=${accentColor}@0.55:t=fill`
  ];

  const chosenLayout = layout || pickProfInsertLayout(type, 0);

  if (chosenLayout === "big-number" || type === "number") {
    filters.push(
      `drawtext=textfile='${escapedTitle}'${FONT_HEADLINE}:fontcolor=${accentColor}:fontsize=118:x=(w-text_w)/2:y=222`,
      `drawtext=textfile='${escapedBody}'${FONT_BODY}:fontcolor=${textColor}:fontsize=34:x=(w-text_w)/2:y=388`
    );
  } else if (chosenLayout === "metric-bars") {
    filters.push(
      `drawtext=textfile='${escapedTitle}'${FONT_HEADLINE}:fontcolor=${textColor}:fontsize=42:x=170:y=142`,
      `drawbox=x=170:y=270:w=850:h=8:color=white@0.22:t=fill`,
      `drawbox=x=170:y=270:w=690:h=8:color=${accentColor}:t=fill`,
      `drawbox=x=170:y=350:w=850:h=8:color=white@0.18:t=fill`,
      `drawbox=x=170:y=350:w=520:h=8:color=${accentColor}@0.82:t=fill`,
      `drawbox=x=170:y=430:w=850:h=8:color=white@0.14:t=fill`,
      `drawbox=x=170:y=430:w=360:h=8:color=${accentColor}@0.64:t=fill`,
      `drawtext=textfile='${escapedBody}'${FONT_BODY}:fontcolor=${textColor}:fontsize=26:x=170:y=495`
    );
  } else if (chosenLayout === "ring-stat") {
    filters.push(
      `drawbox=x=198:y=168:w=324:h=324:color=white@0.12:t=12`,
      `drawbox=x=232:y=202:w=256:h=256:color=${accentColor}@0.45:t=10`,
      `drawtext=textfile='${escapedTitle}'${FONT_HEADLINE}:fontcolor=${accentColor}:fontsize=76:x=285:y=298`,
      `drawtext=textfile='${escapedBody}'${FONT_BODY}:fontcolor=${textColor}:fontsize=28:x=620:y=300`
    );
  } else if (chosenLayout === "document-card" || type === "document") {
    filters.push(
      `drawbox=x=180:y=122:w=920:h=450:color=white@0.09:t=fill`,
      `drawbox=x=210:y=154:w=860:h=2:color=${accentColor}@0.8:t=fill`,
      `drawbox=x=210:y=510:w=260:h=46:color=${accentColor}@0.25:t=fill`,
      `drawtext=textfile='${escapedTitle}'${FONT_HEADLINE}:fontcolor=${textColor}:fontsize=44:x=220:y=230`,
      `drawtext=textfile='${escapedBody}'${FONT_BODY}:fontcolor=${textColor}:fontsize=28:x=220:y=326`
    );
  } else if (chosenLayout === "stamp-card") {
    filters.push(
      `drawbox=x=214:y=176:w=852:h=330:color=white@0.08:t=fill`,
      `drawbox=x=792:y=204:w=210:h=92:color=${accentColor}@0.22:t=8`,
      `drawtext=textfile='${escapedTitle}'${FONT_HEADLINE}:fontcolor=${textColor}:fontsize=42:x=250:y=260`,
      `drawtext=textfile='${escapedBody}'${FONT_BODY}:fontcolor=${textColor}:fontsize=28:x=250:y=358`
    );
  } else if (chosenLayout === "timeline-line" || type === "timeline") {
    filters.push(
      `drawbox=x=180:y=356:w=920:h=6:color=${accentColor}:t=fill`,
      `drawbox=x=210:y=338:w=38:h=38:color=${accentColor}:t=fill`,
      `drawbox=x=620:y=338:w=38:h=38:color=${accentColor}:t=fill`,
      `drawbox=x=1030:y=338:w=38:h=38:color=${accentColor}:t=fill`,
      `drawtext=textfile='${escapedTitle}'${FONT_HEADLINE}:fontcolor=${textColor}:fontsize=38:x=220:y=248`,
      `drawtext=textfile='${escapedBody}'${FONT_BODY}:fontcolor=${textColor}:fontsize=26:x=170:y=420`
    );
  } else if (chosenLayout === "alert-card") {
    filters.push(
      `drawbox=x=138:y=210:w=1004:h=230:color=black@0.28:t=fill`,
      `drawbox=x=138:y=210:w=18:h=230:color=${accentColor}:t=fill`,
      `drawbox=x=186:y=462:w=908:h=4:color=${accentColor}@0.85:t=fill`,
      `drawtext=textfile='${escapedTitle}'${FONT_HEADLINE}:fontcolor=${textColor}:fontsize=46:x=190:y=282`,
      `drawtext=textfile='${escapedBody}'${FONT_BODY}:fontcolor=${accentColor}:fontsize=30:x=190:y=370`
    );
  } else if (chosenLayout === "quote-card") {
    filters.push(
      `drawtext=text='“'${FONT_HEADLINE}:fontcolor=${accentColor}@0.85:fontsize=170:x=170:y=122`,
      `drawtext=textfile='${escapedTitle}'${FONT_HEADLINE}:fontcolor=${textColor}:fontsize=42:x=275:y=238`,
      `drawtext=textfile='${escapedBody}'${FONT_BODY}:fontcolor=${textColor}@0.78:fontsize=28:x=280:y=338`
    );
  } else if (chosenLayout === "lower-third") {
    filters.push(
      `drawbox=x=90:y=440:w=790:h=126:color=black@0.42:t=fill`,
      `drawbox=x=90:y=440:w=12:h=126:color=${accentColor}:t=fill`,
      `drawtext=textfile='${escapedTitle}'${FONT_HEADLINE}:fontcolor=${textColor}:fontsize=34:x=128:y=472`,
      `drawtext=textfile='${escapedBody}'${FONT_BODY}:fontcolor=${textColor}@0.82:fontsize=24:x=128:y=528`
    );
  } else if (chosenLayout === "side-card" || chosenLayout === "evidence-board") {
    filters.push(
      `drawbox=x=750:y=86:w=430:h=548:color=black@0.34:t=fill`,
      `drawbox=x=784:y=128:w=330:h=3:color=${accentColor}:t=fill`,
      `drawbox=x=784:y=518:w=330:h=3:color=${accentColor}@0.45:t=fill`,
      `drawtext=textfile='${escapedTitle}'${FONT_HEADLINE}:fontcolor=${textColor}:fontsize=30:x=784:y=206`,
      `drawtext=textfile='${escapedBody}'${FONT_BODY}:fontcolor=${textColor}@0.82:fontsize=22:x=784:y=316`
    );
  } else {
    filters.push(
      `drawbox=x=132:y=178:w=1016:h=330:color=black@0.22:t=fill`,
      `drawbox=x=252:y=512:w=776:h=4:color=${accentColor}:t=fill`,
      `drawtext=textfile='${escapedTitle}'${FONT_HEADLINE}:fontcolor=${textColor}:fontsize=48:x=(w-text_w)/2:y=282`,
      `drawtext=textfile='${escapedBody}'${FONT_BODY}:fontcolor=${textColor}@0.82:fontsize=26:x=(w-text_w)/2:y=374`
    );
  }

  await runFfmpeg([
    "-y",
    "-f", "lavfi",
    "-i", "anullsrc=r=44100:cl=stereo",
    "-f", "lavfi",
    "-i", filters.join(","),
    "-t", String(safeDuration),
    "-map", "1:v:0",
    "-map", "0:a:0",
    ...videoCodecArgs(),
    "-c:a", "aac",
    "-shortest",
    outputPath
  ]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Synth-based SFX engine. No external assets — every cue is generated on the
// fly via ffmpeg lavfi (aevalsrc / anoisesrc) so it works offline. Cues are
// timed from the assembled timeline (insert starts, scene transitions) and
// mixed into the narration audio in the final render pass.
// ─────────────────────────────────────────────────────────────────────────────
const SFX_RECIPES = {
  // Deep-bass impact — the "headline lands" thud
  impact: {
    src: "aevalsrc='exp(-t*9)*sin(2*PI*60*t)+exp(-t*15)*0.6*sin(2*PI*120*t)+exp(-t*22)*0.3*sin(2*PI*240*t)':d=0.55",
    dur: 0.55,
    chain: "alowpass=f=900",
    gain: 1.00
  },
  // Sub-thud, no harmonics — for date stamps / corner flags
  thud: {
    src: "aevalsrc='exp(-t*12)*sin(2*PI*45*t)':d=0.40",
    dur: 0.40,
    chain: "alowpass=f=400",
    gain: 0.90
  },
  // Pink-noise whoosh — for tag-pill / overlay-pulse / overlay-side
  whoosh: {
    src: "anoisesrc=color=pink:amplitude=0.75:d=0.55",
    dur: 0.55,
    chain: "afade=t=in:d=0.06,afade=t=out:st=0.30:d=0.25,highpass=f=350,lowpass=f=3500",
    gain: 0.90
  },
  // Rising sweep — pre-roll for cinematic moments (200Hz → 1700Hz over 0.9s)
  riser: {
    src: "aevalsrc='sin(2*PI*(200+1500*t)*t)*max(0\\,t/0.9)*0.65':d=0.90",
    dur: 0.90,
    chain: "afade=t=out:st=0.75:d=0.15,highpass=f=180",
    gain: 0.85
  },
  // Short tick / click — for counter ticks / typewriter feel
  tick: {
    src: "anoisesrc=color=white:amplitude=0.55:d=0.06",
    dur: 0.07,
    chain: "highpass=f=2200,afade=t=out:d=0.06",
    gain: 0.80
  },
  // Atmospheric drone — for warning / alert cues (sub-bass + 5th)
  drone: {
    src: "aevalsrc='sin(2*PI*55*t)*0.6+sin(2*PI*82.5*t)*0.28':d=2.20",
    dur: 2.20,
    chain: "afade=t=in:d=0.40,afade=t=out:st=1.70:d=0.50,alowpass=f=1200",
    gain: 0.75
  },
  // Soft chime / ping — for quote inserts (sine pluck with decay)
  chime: {
    src: "aevalsrc='exp(-t*4)*sin(2*PI*880*t)*0.65+exp(-t*5)*sin(2*PI*1320*t)*0.35':d=0.85",
    dur: 0.85,
    chain: "afade=t=out:st=0.55:d=0.30",
    gain: 0.70
  },
  // Sharp stinger — short climactic hit for revelation/peak-drama moments
  stinger: {
    src: "aevalsrc='exp(-t*18)*sin(2*PI*180*t)+exp(-t*12)*0.4*sin(2*PI*360*t)+exp(-t*25)*0.2*sin(2*PI*720*t)':d=0.45",
    dur: 0.45,
    chain: "highpass=f=80,alowpass=f=2000",
    gain: 1.10
  },
  // Low tension rumble — sub-bass oscillation for sustained dread (investigation/thriller)
  tension: {
    src: "aevalsrc='sin(2*PI*38*t)*0.5+sin(2*PI*57*t)*0.18+sin(2*PI*41*t)*0.14':d=3.00",
    dur: 3.00,
    chain: "afade=t=in:d=0.60,afade=t=out:st=2.30:d=0.70,alowpass=f=800",
    gain: 0.65
  }
};

// Map insert layouts to sfx cues. Each cue is { type, offsetSec } relative to
// insert start. paletteIndex is used to alternate between two cue patterns so
// the same insert type doesn't always sound identical.
function pickInsertSfx(layout, type, paletteIndex = 0) {
  const isAlt = (paletteIndex % 2) === 1;
  switch (layout) {
    case "headline-card":
    case "title-stack":
      return isAlt
        ? [{ type: "riser", offset: -0.60 }, { type: "impact", offset: 0.0 }]
        : [{ type: "whoosh", offset: -0.20 }, { type: "impact", offset: 0.0 }];
    case "stat-callout":
    case "counter-callout":
      return [{ type: "riser", offset: -0.55 }, { type: "thud", offset: 0.0 }];
    case "tag-pill":
      return [{ type: "whoosh", offset: -0.10 }, { type: "thud", offset: 0.05 }];
    case "date-stamp":
      return [{ type: "tick", offset: -0.05 }, { type: "tick", offset: 0.10 }, { type: "thud", offset: 0.0 }];
    case "corner-flag":
      return [{ type: "tick", offset: 0.0 }];
    case "bar-chart":
      return [
        { type: "whoosh", offset: -0.20 },
        { type: "tick", offset: 0.10 },
        { type: "tick", offset: 0.30 },
        { type: "tick", offset: 0.50 }
      ];
    case "overlay-center":
    case "overlay-lower":
    case "overlay-pulse":
      return type === "warning"
        ? [{ type: "drone", offset: -0.10 }, { type: "impact", offset: 0.0 }]
        : type === "quote"
          ? [{ type: "chime", offset: 0.0 }]
          : [{ type: "whoosh", offset: -0.15 }, { type: "thud", offset: 0.0 }];
    case "overlay-side":
      return [{ type: "tick", offset: 0.0 }, { type: "thud", offset: 0.05 }];
    case "news-ticker":
      return [{ type: "impact", offset: 0.0 }, { type: "drone", offset: 0.15 }];
    case "location-stamp":
      return [{ type: "tick", offset: 0.0 }, { type: "whoosh", offset: -0.10 }];
    case "chapter-card":
      return [{ type: "riser", offset: -0.70 }, { type: "impact", offset: 0.0 }];
    case "redacted-doc":
      return [{ type: "whoosh", offset: -0.15 }, { type: "tick", offset: 0.05 }, { type: "thud", offset: 0.12 }];
    case "typewriter-card":
      return [{ type: "tick", offset: 0.0 }, { type: "tick", offset: 0.18 }, { type: "tick", offset: 0.36 }, { type: "tick", offset: 0.54 }];
    default:
      return [{ type: "whoosh", offset: -0.10 }, { type: "thud", offset: 0.0 }];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MOOD ANALYSIS — reads the full transcript and returns a genre/intensity
// profile that drives semantic SFX placement.
// ─────────────────────────────────────────────────────────────────────────────

function analyzeTranscriptMood(timeline = []) {
  const fullText = timeline.map(t => String(t.text || "")).join(" ");
  const lower = fullText.toLowerCase();
  const wordCount = Math.max(1, lower.split(/\s+/).filter(Boolean).length);

  const countHits = (re) => (lower.match(re) || []).length;

  // Drama: death, violence, crisis, catastrophe
  const dramaHits = countHits(/(died|killed|executed|arrested|sentenced|murder|shot dead|shooting|death|tragedy|war|bomb|explosion|crisis|massacre|torture|prison|загин|вбит|смерт|тюрм|вбивств|загибель|катастроф|убийств|расстрел|тюрьм|взорвал|война)/g);
  // Revelation: discovered, confirmed, uncovered
  const revealHits = countHits(/(revealed|discovered|found out|uncovered|confirmed|turned out|it emerged|виявилось|підтверджен|стало відомо|оказалось|обнаружили|выяснилось)/g);
  // Investigation: evidence, suspects, documents, proof
  const investigationHits = countHits(/(evidence|investigation|suspect|proof|witness|document|archive|classified|case file|доказ|слідств|підозр|свідок|архів|справ|секретн|таємн)/g);
  // Urgent/news: breaking, alert, emergency
  const newsHits = countHits(/(breaking|emergency|urgent|crisis|alert|just in|developing|термінов|надзвичайн|тривог|криз|позачергов)/g);
  // Personal/emotional: family, memory, loss, grief
  const emotionHits = countHits(/(family|mother|father|child|memory|love|grief|tears|heartbroken|alone|loss|silent|невинн|сім|матір|батько|дитин|пам|страх|самотн|плакав|горе|втрат)/g);
  // Documentary/factual: statistics, dates, reports, percentages
  const docHits = countHits(/\b(19|20)\d{2}\b|\b(according|reported|statistics|percent|data|record|survey|звіт|даних|статистик|відсотк|відповідн)/g);

  // Normalise to hits-per-100-words
  const norm = (n) => (n / wordCount) * 100;
  const d = norm(dramaHits);
  const r = norm(revealHits);
  const inv = norm(investigationHits);
  const n = norm(newsHits);
  const e = norm(emotionHits);
  const doc = norm(docHits);

  // Pick dominant genre
  const scores = { thriller: d * 2 + inv, investigation: inv * 2 + d, news: n * 3 + d, personal: e * 2.5, documentary: doc * 1.5 };
  const genre = Object.entries(scores).sort((a, b) => b[1] - a[1])[0][0];

  // Overall dramatic intensity 0-1
  const intensity = Math.min(1, (d * 0.8 + r * 0.5 + n * 0.6 + inv * 0.4) / 6);

  return { genre, intensity, d, r, inv, n, e, doc };
}

// Score a single segment for mood signals. Returns values 0-1.
function scoreSegmentMood(text = "", globalMood = {}) {
  const lower = String(text).toLowerCase();
  const boost = 1 + (globalMood.intensity || 0) * 0.5;

  const drama = Math.min(1, boost * (
    (/(died|killed|executed|arrested|sentenced|murder|shot|death|tragedy|bomb|explosion|загин|вбит|смерт|тюрм|вбивств|загибель|убийств|расстрел|взорвал)/i.test(lower) ? 0.70 : 0) +
    (/(suddenly|without warning|instantly|out of nowhere|раптом|відразу|несподіван|раптово|вдруг|внезапно)/i.test(lower) ? 0.30 : 0)
  ));

  const reveal = Math.min(1, boost * (
    (/(revealed|discovered|found out|confirmed|turned out|it emerged|виявилось|підтверджен|стало відомо|оказалось|обнаружили|виявили)/i.test(lower) ? 0.85 : 0)
  ));

  const location = Math.min(1, boost * (
    (/(arrived|entered|walked into|came to|зайшов|прийшов|приїхав|потрапив|вошел|прибыл|прибув|повернувся)/i.test(lower) ? 0.70 : 0)
  ));

  const emotion = Math.min(1, boost * (
    (/(cried|tears|grief|heartbroken|couldn't|alone|silent|last time|плакав|сльози|самотн|тихо|беззвучн|востаннє|не міг|не могла)/i.test(lower) ? 0.80 : 0)
  ));

  const tension = Math.min(1, boost * (
    (/(suspected|investigated|tracked|followed|watched|knew that|підозрюв|слідкув|знали що|знал что|следил|подозревал)/i.test(lower) ? 0.65 : 0)
  ));

  return { drama, reveal, location, emotion, tension };
}

// Map per-segment mood scores → SFX cue list { type, offset, boost }
function selectMoodSfxCues(score, globalMood = {}) {
  const genre = globalMood.genre || "documentary";
  const cues = [];

  if (score.drama > 0.60) {
    // Biggest moment: riser anticipation → hard impact
    if (genre === "thriller" || genre === "news") {
      cues.push({ type: "riser",   offset: -0.65, boost: 0.70 });
      cues.push({ type: "stinger", offset:  0.00, boost: 0.75 });
    } else if (genre === "investigation") {
      cues.push({ type: "whoosh",  offset: -0.20, boost: 0.60 });
      cues.push({ type: "impact",  offset:  0.00, boost: 0.70 });
    } else {
      cues.push({ type: "whoosh",  offset: -0.20, boost: 0.55 });
      cues.push({ type: "thud",    offset:  0.00, boost: 0.60 });
    }
  } else if (score.reveal > 0.60) {
    // Revelation moment: sweep in → sharp hit
    cues.push({ type: "riser",   offset: -0.55, boost: 0.60 });
    cues.push({ type: "impact",  offset:  0.00, boost: 0.65 });
  } else if (score.emotion > 0.60) {
    // Emotional beat: soft chime
    cues.push({ type: "chime", offset: 0.0, boost: 0.60 });
  } else if (score.tension > 0.55) {
    // Investigative tension: low rumble
    cues.push({ type: "tension", offset: 0.0, boost: 0.55 });
  } else if (score.location > 0.55) {
    // Scene/location change: tick + light whoosh
    cues.push({ type: "tick",   offset: 0.0,   boost: 0.50 });
    cues.push({ type: "whoosh", offset: -0.10, boost: 0.45 });
  } else if (score.drama > 0.30 && genre !== "personal") {
    // Mild drama under a thriller/investigation tone: subtle drone pad
    cues.push({ type: "drone", offset: 0.0, boost: 0.45 });
  }

  return cues;
}

// Walk timeline and emit absolute-time SFX events.
// Two layers:
//   1. Insert-triggered SFX  — fires when a visual overlay appears (same as before)
//   2. Mood-triggered SFX    — fires at semantically significant moments in the
//      narration even when there is no visual insert. Driven by analyzeTranscriptMood
//      + scoreSegmentMood so SFX matches the CONTENT, not just the visuals.
function collectSfxEvents(timeline = [], montageSettings = {}) {
  if (!montageSettings.sfxEnabled) return [];
  const pack = String(montageSettings.sfxPack || "cinematic");
  const packGain = pack === "minimal" ? 0.45 : pack === "subtle" ? 0.70 : 1.0;
  const events = [];

  // ── Layer 1: insert-triggered SFX ──────────────────────────────────────────
  let cursor = 0;
  for (const item of timeline) {
    const itemStart = Number(item.start || cursor);
    const itemDur = Math.max(0.6, Number(item.duration || 0));
    const insert = item.overlayInsert;
    if (insert?.type) {
      const insertAbsStart = itemStart + Number(insert.startOffset || 0);
      const cues = pickInsertSfx(insert.layout, insert.type, insert.paletteIndex);
      for (const cue of cues) {
        const t = Math.max(0.05, insertAbsStart + cue.offset);
        if (pack === "minimal" && cue.type !== "thud" && cue.type !== "impact") continue;
        events.push({ time: t, type: cue.type, gainBoost: packGain });
      }
    }
    cursor = itemStart + itemDur;
  }

  // ── Layer 2: mood-triggered SFX ────────────────────────────────────────────
  // Only in cinematic/subtle packs (not minimal) and only when there is actual
  // content to analyse (>= 3 segments).
  if (pack !== "minimal" && timeline.length >= 3) {
    const globalMood = analyzeTranscriptMood(timeline);
    // Mood SFX gain is lower than insert SFX — it acts as underpinning, not lead.
    const moodGainScale = pack === "subtle" ? 0.45 : 0.60;
    // Minimum gap between mood SFX events (don't stack with insert SFX or each other).
    const MIN_MOOD_GAP = 8.0;
    let lastMoodSfxTime = -MIN_MOOD_GAP;

    cursor = 0;
    for (const item of timeline) {
      const itemStart = Number(item.start || cursor);
      const itemDur = Math.max(0.6, Number(item.duration || 0));
      const hasInsert = Boolean(item.overlayInsert?.type);

      // Don't double-fire on a segment that already has insert SFX.
      if (!hasInsert && item.text && itemStart - lastMoodSfxTime >= MIN_MOOD_GAP) {
        const score = scoreSegmentMood(item.text, globalMood);
        const cues = selectMoodSfxCues(score, globalMood);
        if (cues.length) {
          for (const cue of cues) {
            const t = Math.max(0.05, itemStart + (cue.offset || 0));
            events.push({ time: t, type: cue.type, gainBoost: packGain * moodGainScale * (cue.boost || 1) });
          }
          lastMoodSfxTime = itemStart;
        }
      }
      cursor = itemStart + itemDur;
    }
  }

  return events;
}

// Build a self-contained SFX audio file by mixing per-event lavfi sources.
async function buildSfxTrack({ events, totalDuration, outputPath, sfxVolume = 0.55 }) {
  if (!Array.isArray(events) || !events.length) return false;
  const safeDur = Math.max(1.0, Number(totalDuration) || 1);
  const inputs = [];
  const filterParts = [];
  let idx = 0;
  // Cap events to a reasonable count so the filter graph doesn't explode.
  const MAX_EVENTS = 80;
  const capped = events.slice(0, MAX_EVENTS);
  for (const ev of capped) {
    const recipe = SFX_RECIPES[ev.type];
    if (!recipe) continue;
    const delayMs = Math.max(0, Math.round(ev.time * 1000));
    if (delayMs > safeDur * 1000 + 500) continue;
    const gain = (sfxVolume) * (recipe.gain || 1) * (ev.gainBoost || 1);
    inputs.push("-f", "lavfi", "-t", String(recipe.dur), "-i", recipe.src);
    const chain = recipe.chain ? `${recipe.chain},` : "";
    filterParts.push(
      `[${idx}:a]${chain}adelay=${delayMs}|${delayMs},volume=${gain.toFixed(3)},apad=whole_dur=${safeDur.toFixed(2)}[s${idx}]`
    );
    idx += 1;
  }
  if (!filterParts.length) return false;
  const mixLabels = filterParts.map((_, i) => `[s${i}]`).join("");
  const filterGraph = `${filterParts.join(';')};${mixLabels}amix=inputs=${filterParts.length}:duration=longest:dropout_transition=0:normalize=0,alimiter=limit=0.92,atrim=duration=${safeDur.toFixed(2)}[out]`;
  await runFfmpeg([
    "-y",
    ...inputs,
    "-filter_complex", filterGraph,
    "-map", "[out]",
    "-c:a", "aac",
    "-b:a", "160k",
    "-ar", "44100",
    "-ac", "2",
    outputPath
  ]);
  return true;
}

function formatSrtTimestamp(seconds) {
  const ms = Math.max(0, Math.floor(Number(seconds || 0) * 1000));
  const hh = Math.floor(ms / 3600000);
  const mm = Math.floor((ms % 3600000) / 60000);
  const ss = Math.floor((ms % 60000) / 1000);
  const msec = ms % 1000;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")},${String(msec).padStart(3, "0")}`;
}

async function writeSrtFromTimeline(timeline, outputPath) {
  const rows = [];
  let index = 1;
  for (const item of timeline || []) {
    const text = String(item?.text || "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    const start = Math.max(0, Number(item.start || 0));
    const end = Math.max(start + 0.2, Number(item.end || (start + Number(item.duration || 1))));
    rows.push(
      String(index),
      `${formatSrtTimestamp(start)} --> ${formatSrtTimestamp(end)}`,
      text,
      ""
    );
    index += 1;
  }
  if (!rows.length) return false;
  await fs.writeFile(outputPath, rows.join("\n"), "utf8");
  return true;
}

function safeExtFromName(name, fallback = ".mp4") {
  const ext = path.extname(String(name || "")).toLowerCase();
  if (!ext || ext.length > 8) return fallback;
  return ext;
}

// Pre-flight check: HEAD-probe every stock URL in the timeline in parallel
// (5s per request) before we start the long render. Catches dead Pexels links,
// expired Pixabay tokens, network blips — instead of failing on clip 47/60
// and burning 4 minutes of CPU.
async function preflightStockAssets(timeline = []) {
  const urls = new Set();
  for (const item of timeline) {
    if (item?.asset?.kind === "insert") continue;
    const url = item?.asset?.previewUrl;
    if (typeof url !== "string") continue;
    if (!/^https?:\/\//i.test(url)) continue;        // local/data:/generated → skip
    urls.add(url);
  }
  if (!urls.size) return { ok: true, failures: [] };

  const list = [...urls];
  const results = await parallelMap(
    list,
    async (url) => {
      try {
        const resp = await fetchWithTimeout(url, { method: "HEAD" }, 5000);
        if (!resp.ok) {
          // Some CDNs reject HEAD with 405; retry GET-range to confirm.
          if (resp.status === 405 || resp.status === 403) {
            const getResp = await fetchWithTimeout(url, {
              headers: { Range: "bytes=0-127" }
            }, 5000);
            if (!getResp.ok && getResp.status !== 206) {
              return { url, status: getResp.status };
            }
            return { url, status: 200 };
          }
          return { url, status: resp.status };
        }
        return { url, status: 200 };
      } catch (e) {
        return { url, status: 0, error: String(e?.message || "network").slice(0, 80) };
      }
    },
    8
  );

  const failures = results
    .map(({ result }) => result)
    .filter((r) => r && (r.status === 0 || r.status >= 400));

  return { ok: failures.length === 0, failures };
}

// Stable hash of all inputs that determine the rendered output. Same inputs
// → same renderId → same tempDir → already-built clips are reused on retry.
// Audio bytes are sampled (head + tail) instead of fully hashed to avoid
// reading 30MB on every render start.
function computeRenderId({ audio, timelineRaw, montageSettingsRaw, localFiles }) {
  const hasher = createHash("sha256");
  const buf = audio?.buffer;
  if (Buffer.isBuffer(buf)) {
    const head = buf.slice(0, Math.min(buf.length, 256 * 1024));
    const tail = buf.slice(Math.max(0, buf.length - 256 * 1024));
    hasher.update(head);
    hasher.update(tail);
    hasher.update(`size:${buf.length}`);
  }
  hasher.update("|t|");
  hasher.update(JSON.stringify(timelineRaw || ""));
  hasher.update("|s|");
  hasher.update(JSON.stringify(montageSettingsRaw || ""));
  hasher.update("|f|");
  for (const f of localFiles || []) {
    hasher.update(`${f?.originalname || ""}:${f?.size || 0}|`);
  }
  return hasher.digest("hex").slice(0, 16);
}

// GC stale render dirs older than 24h so the deterministic-tempDir scheme
// doesn't grow unbounded across runs.
async function gcOldRenderDirs() {
  const root = os.tmpdir();
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  try {
    const entries = await fs.readdir(root);
    for (const entry of entries) {
      if (!entry.startsWith("vss_render_")) continue;
      const full = path.join(root, entry);
      try {
        const stat = await fs.stat(full);
        if (stat.mtimeMs < cutoff) {
          await fs.rm(full, { recursive: true, force: true });
        }
      } catch { /* ignore per-entry errors */ }
    }
  } catch { /* ignore */ }
}

async function materializeAsset({ item, localFiles, tempDir, assetCache }) {
  if (item.asset.source === "local") {
    const idx = item.asset.fileIndex;
    if (idx === null || idx < 0 || idx >= localFiles.length) {
      throw new Error(`Local asset index некоректний: ${idx}`);
    }

    const key = `local:${idx}`;
    if (assetCache.has(key)) return assetCache.get(key);

    const file = localFiles[idx];
    const ext = path.extname(file.originalname || "").toLowerCase() || (file.mimetype.startsWith("image/") ? ".jpg" : ".mp4");
    const outPath = path.join(tempDir, `local_${idx}${ext}`);
    await fs.writeFile(outPath, file.buffer);
    assetCache.set(key, outPath);
    return outPath;
  }

  const url = item.asset.previewUrl;
  if (typeof url === "string" && url.startsWith("/outputs/")) {
    const safeName = path.basename(url);
    const localOutputPath = path.join(OUTPUT_DIR, safeName);
    try {
      await fs.access(localOutputPath);
      return localOutputPath;
    } catch {
      throw new Error("Generated asset path not found in outputs");
    }
  }

  if (url.startsWith("data:image/")) {
    const key = `data:${url.slice(0, 48)}`;
    if (assetCache.has(key)) return assetCache.get(key);

    const m = url.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
    if (!m) {
      throw new Error("Generated image має невалідний data URL");
    }
    const extByMime = {
      "image/jpeg": ".jpg",
      "image/jpg": ".jpg",
      "image/png": ".png",
      "image/webp": ".webp"
    };
    const ext = extByMime[m[1].toLowerCase()] || ".png";
    const outPath = path.join(tempDir, `generated_${assetCache.size}${ext}`);
    await fs.writeFile(outPath, Buffer.from(m[2], "base64"));
    assetCache.set(key, outPath);
    return outPath;
  }

  if (!/^https?:\/\//i.test(url)) {
    throw new Error("Stock asset має невалідний URL");
  }

  const key = `url:${url}`;
  if (assetCache.has(key)) return assetCache.get(key);

  let arrayBuffer = null;
  let lastStatus = 0;
  let lastError = "";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetchWithTimeout(url, {}, 15000);
      lastStatus = Number(response.status || 0);
      if (!response.ok) {
        lastError = `status ${response.status}`;
        continue;
      }
      arrayBuffer = await response.arrayBuffer();
      break;
    } catch (error) {
      lastError = String(error?.message || "network error");
    }
  }
  if (!arrayBuffer) {
    const msg = lastStatus ? `Не вдалося завантажити asset: ${lastStatus}` : `Не вдалося завантажити asset: ${lastError || "network error"}`;
    throw new Error(msg);
  }

  const ext = pickExtFromUrl(url);
  const outPath = path.join(tempDir, `stock_${assetCache.size}${ext}`);
  await fs.writeFile(outPath, Buffer.from(arrayBuffer));
  assetCache.set(key, outPath);
  return outPath;
}

async function buildProfOverlayFilters({ overlayInsert, duration, tempDir }) {
  if (!overlayInsert?.text || !tempDir) return [];
  const type = String(overlayInsert.type || "title");
  const layout = String(overlayInsert.layout || "overlay-lower");
  const safeDuration = Math.max(0.8, Number(duration) || 1);
  const requestedDuration = Math.max(0, Number(overlayInsert.duration || 0));
  const visibleEnd = Math.max(0.6, Math.min(safeDuration - 0.15, requestedDuration || 4.8, 4.8));
  const lang = normalizeInsertLanguage(overlayInsert.language || "") || detectTextLanguage(overlayInsert.text);

  // Headline + sublabel (sublabel may have been pre-baked in pipeline; if not — derive)
  const rawTitle = String(overlayInsert.title || overlayInsert.text || "").trim();
  const rawSub = String(overlayInsert.sublabel || "").trim();
  const titleLine = normalizeInsertLine(rawTitle.toUpperCase(), 36);
  const subLine = normalizeInsertLine(
    rawSub ? rawSub.toUpperCase() : defaultSublabel(type, lang),
    32
  );

  const titleFile = path.join(tempDir, `overlay_${type}_${randomUUID()}.txt`);
  const subFile = path.join(tempDir, `overlay_${type}_${randomUUID()}_sub.txt`);
  await fs.writeFile(titleFile, titleLine, "utf8");
  await fs.writeFile(subFile, subLine, "utf8");
  const escapedTitle = escapeDrawtextPath(titleFile);
  const escapedSub = escapeDrawtextPath(subFile);

  // Per-type palettes — each insert rotates through 3-5 cohesive colors via
  // paletteIndex so the same type doesn't hit the screen with the identical
  // accent twice in a row. Palettes are tuned to a "warm documentary" base.
  const ACCENT_PALETTES = {
    title:            ["#fbbf24", "#f59e0b", "#fb923c", "#fde047"],
    number:           ["#f59e0b", "#fbbf24", "#fb923c", "#facc15"],
    document:         ["#fb7185", "#f43f5e", "#e879f9", "#f472b6"],
    timeline:         ["#84cc16", "#22c55e", "#a3e635", "#10b981"],
    warning:          ["#f97316", "#ef4444", "#dc2626", "#fb923c"],
    quote:            ["#fde047", "#fbbf24", "#facc15", "#eab308"],
    analysis:         ["#38bdf8", "#06b6d4", "#0ea5e9", "#22d3ee"],
    place:            ["#a3e635", "#84cc16", "#34d399", "#22d3ee"],
    person:           ["#c084fc", "#a78bfa", "#e879f9", "#d8b4fe"],
    "breaking-news":  ["#ef4444", "#dc2626", "#f97316", "#ef4444"],
    "location-stamp": ["#22d3ee", "#0ea5e9", "#34d399", "#38bdf8"],
    "chapter-card":   ["#fbbf24", "#f59e0b", "#fb923c", "#fde047"],
    "redacted-doc":   ["#ef4444", "#dc2626", "#e879f9", "#f43f5e"],
    "typewriter":     ["#94a3b8", "#64748b", "#cbd5e1", "#94a3b8"]
  };
  const palette = ACCENT_PALETTES[type] || ACCENT_PALETTES.title;
  const paletteIndex = Math.max(0, Number(overlayInsert.paletteIndex || 0));
  const accentColor = palette[paletteIndex % palette.length];
  // Secondary color (used on title-stack for value text or as a subtle alt)
  const accentColor2 = palette[(paletteIndex + 1) % palette.length];

  // Animation envelope: smooth ease-in/out via alpha + slide-up offset.
  // Insert is delayed so it appears AFTER the voice has had a moment to set
  // context. For typical 4-8 sec segments this puts the headline around the
  // midpoint, never at t=0 where the user hasn't heard the line yet.
  const requestedTIn = Math.max(0, Number(overlayInsert.startOffset || 0));
  const autoTIn = Math.max(0.5, Math.min(safeDuration * 0.42, 1.6));
  const tIn = requestedTIn > 0 ? requestedTIn : autoTIn;
  const fadeIn = 0.40;
  const fadeOut = 0.40;
  const tOut = Math.min(safeDuration - 0.20, tIn + Math.max(1.6, visibleEnd));
  const enable = `between(t\\,${tIn.toFixed(2)}\\,${tOut.toFixed(2)})`;
  const alpha = buildAlphaExpr(tIn, fadeIn, tOut, fadeOut);
  // Title slides up from +24 px, sublabel from +12 px (slight stagger via trick:
  // we keep timing the same — different distances are enough for parallax feel).
  const slideTitle = buildSlideOffsetExpr(tIn, fadeIn, tOut, fadeOut, 26, -6);
  const slideSub   = buildSlideOffsetExpr(tIn, fadeIn, tOut, fadeOut, 14, -4);

  // ─── Polish helpers shared across layouts ───────────────────────────────────
  // Drop shadow makes white text readable on any footage.
  const TEXT_SHADOW = `:shadowcolor=black@0.65:shadowx=2:shadowy=3`;
  const SUB_SHADOW  = `:shadowcolor=black@0.55:shadowx=1:shadowy=2`;

  // Background dim — full-frame dark scrim during the insert. Drawbox doesn't
  // animate alpha, so we approximate fade-in/out with two stacked boxes that
  // toggle on at slightly different times for a "stair-step" feel.
  const dimEnable1 = `between(t\\,${(tIn + 0.10).toFixed(2)}\\,${(tOut - 0.10).toFixed(2)})`;
  const dimEnable2 = `between(t\\,${(tIn + 0.25).toFixed(2)}\\,${(tOut - 0.25).toFixed(2)})`;
  const buildBgDim = () => [
    `drawbox=x=0:y=0:w=1280:h=720:color=black@0.18:t=fill:enable='${dimEnable1}'`,
    `drawbox=x=0:y=0:w=1280:h=720:color=black@0.14:t=fill:enable='${dimEnable2}'`
  ];

  // Wipe-in expression for accent bar width — bar draws from 0 to maxW over
  // wipeDur seconds at the start of the insert, then holds full width.
  const buildWipeWidth = (maxW, wipeDur = 0.55) => {
    const tInS = tIn.toFixed(2);
    const tWipeEnd = (tIn + wipeDur).toFixed(2);
    return `if(lt(t\\,${tWipeEnd})\\,${maxW}*((t-${tInS})/${wipeDur.toFixed(2)})\\,${maxW})`;
  };

  // Letterbox bars — slide-in from top/bottom for a "cinematic moment" feel.
  // Used only on the big-headline layouts (headline-card, stat-callout).
  const letterboxH = 72;
  const slideDur = 0.40;
  const buildLetterbox = () => {
    const tInS = tIn.toFixed(2);
    const tInEnd = (tIn + slideDur).toFixed(2);
    const tOutStart = (tOut - slideDur).toFixed(2);
    const tOutS = tOut.toFixed(2);
    // Top bar y: -H -> 0 -> -H
    const yTop = `if(lt(t\\,${tInS})\\,-${letterboxH}\\,if(lt(t\\,${tInEnd})\\,-${letterboxH}+${letterboxH}*((t-${tInS})/${slideDur.toFixed(2)})\\,if(lt(t\\,${tOutStart})\\,0\\,if(lt(t\\,${tOutS})\\,-${letterboxH}*((t-${tOutStart})/${slideDur.toFixed(2)})\\,-${letterboxH}))))`;
    const yBot = `if(lt(t\\,${tInS})\\,720\\,if(lt(t\\,${tInEnd})\\,720-${letterboxH}*((t-${tInS})/${slideDur.toFixed(2)})\\,if(lt(t\\,${tOutStart})\\,${720 - letterboxH}\\,if(lt(t\\,${tOutS})\\,${720 - letterboxH}+${letterboxH}*((t-${tOutStart})/${slideDur.toFixed(2)})\\,720))))`;
    return [
      `drawbox=x=0:y='${yTop}':w=1280:h=${letterboxH}:color=black:t=fill:enable='${enable}'`,
      `drawbox=x=0:y='${yBot}':w=1280:h=${letterboxH}:color=black:t=fill:enable='${enable}'`
    ];
  };

  // ───────── NEW LAYOUT: headline-card — full cinematic moment
  if (layout === "headline-card") {
    const titleLen = titleLine.length || 24;
    const headlineSize = titleLen > 28 ? 48 : titleLen > 20 ? 58 : 72;
    const wipeW = buildWipeWidth(820);
    const subY = 320 + headlineSize + 18;
    return [
      ...buildLetterbox(),
      ...buildBgDim(),
      // animated wipe accent bar above headline
      `drawbox=x=(1280-${820})/2+(${820}-(${wipeW}))/2:y=288:w=${wipeW}:h=3:color=${accentColor}@0.9:t=fill:enable='${enable}'`,
      // mirror wipe under sublabel for symmetric "framed" feel
      `drawbox=x=(1280-${360})/2+(${360}-(${buildWipeWidth(360, 0.65)}))/2:y=${subY + 32}:w=${buildWipeWidth(360, 0.65)}:h=2:color=${accentColor}@0.55:t=fill:enable='${enable}'`,
      // headline + sublabel with drop shadow
      `drawtext=textfile='${escapedTitle}'${FONT_HEADLINE}:fontcolor=white:fontsize=${headlineSize}${TEXT_SHADOW}:x=(w-text_w)/2:y=320+(${slideTitle}):alpha='${alpha}':enable='${enable}'`,
      `drawtext=textfile='${escapedSub}'${FONT_BODY}:fontcolor=${accentColor}:fontsize=22${SUB_SHADOW}:x=(w-text_w)/2:y=${subY}+(${slideSub}):alpha='${alpha}':enable='${enable}'`
    ];
  }

  // ───────── NEW LAYOUT: date-stamp (small green box bottom-left)
  if (layout === "date-stamp") {
    return [
      `drawbox=x=64:y=624+(${slideTitle}):w=320:h=72:color=black@0.55:t=fill:enable='${enable}'`,
      `drawbox=x=64:y=624+(${slideTitle}):w=320:h=72:color=${accentColor}@0.72:t=fill:enable='${enable}'`,
      `drawbox=x=64:y=624+(${slideTitle}):w=4:h=72:color=white@0.95:t=fill:enable='${enable}'`,
      `drawtext=textfile='${escapedTitle}'${FONT_HEADLINE}:fontcolor=white:fontsize=44${TEXT_SHADOW}:x=88:y=640+(${slideTitle}):alpha='${alpha}':enable='${enable}'`
    ];
  }

  // ───────── NEW LAYOUT: tag-pill — auto-sized colored plate behind title
  if (layout === "tag-pill") {
    return [
      `drawtext=textfile='${escapedTitle}'${FONT_HEADLINE}:fontcolor=white:fontsize=44${TEXT_SHADOW}:x=(w-text_w)/2:y=320+(${slideTitle}):alpha='${alpha}':box=1:boxcolor=${accentColor}@0.88:boxborderw=22:enable='${enable}'`
    ];
  }

  // ───────── NEW LAYOUT: corner-flag — small badge top-center
  if (layout === "corner-flag") {
    return [
      `drawbox=x=520:y=72+(${slideTitle}):w=240:h=44:color=black@0.65:t=fill:enable='${enable}'`,
      `drawbox=x=536:y=88+(${slideTitle}):w=12:h=12:color=${accentColor}:t=fill:enable='${enable}'`,
      `drawtext=textfile='${escapedTitle}'${FONT_BODY}:fontcolor=white:fontsize=22${SUB_SHADOW}:x=560:y=85+(${slideTitle}):alpha='${alpha}':enable='${enable}'`
    ];
  }

  // ───────── NEW LAYOUT: stat-callout — huge number + label, full cinematic
  if (layout === "stat-callout") {
    const wipeW = buildWipeWidth(220);
    return [
      ...buildLetterbox(),
      ...buildBgDim(),
      `drawtext=textfile='${escapedTitle}'${FONT_HEADLINE}:fontcolor=white:fontsize=132${TEXT_SHADOW}:x=(w-text_w)/2:y=270+(${slideTitle}):alpha='${alpha}':enable='${enable}'`,
      // animated wipe-in line
      `drawbox=x=(1280-${220})/2+(${220}-(${wipeW}))/2:y=434+(${slideSub}):w=${wipeW}:h=3:color=${accentColor}:t=fill:enable='${enable}'`,
      `drawtext=textfile='${escapedSub}'${FONT_BODY}:fontcolor=${accentColor}:fontsize=24${SUB_SHADOW}:x=(w-text_w)/2:y=448+(${slideSub}):alpha='${alpha}':enable='${enable}'`
    ];
  }

  // ───────── NEW LAYOUT: bar-chart — up to 4 horizontal bars animating width
  // (AgriDemo "PRECISION AGRICULTURE SCALE" style). Auto-extracts numbers from
  // segment text. If only 1 number found, shows a single bar.
  if (layout === "bar-chart") {
    // Pull every standalone integer/decimal from the source text.
    const sourceForBars = String(overlayInsert.text || titleLine || "");
    const numbersRaw = (sourceForBars.match(/\d{1,3}(?:[,.]\d{3})*(?:\.\d+)?\s?%?/g) || [])
      .map((s) => s.trim()).slice(0, 4);
    const numbers = numbersRaw.length ? numbersRaw : ["100%"];
    // Each bar value parsed as float for relative width.
    const parsed = numbers.map((s) => {
      const n = Number(String(s).replace(/[^\d.]/g, ""));
      return { label: s, value: Number.isFinite(n) ? Math.max(1, n) : 50 };
    });
    const maxVal = Math.max(...parsed.map((p) => p.value));
    const barLeftX = 100;
    const barMaxW = 1080;
    const baseY = 240;
    const rowGap = 84;
    const rows = parsed.map((p, idx) => {
      const targetW = Math.round((p.value / maxVal) * barMaxW);
      const yRow = baseY + idx * rowGap;
      // Per-bar wipe — each bar fills 0 → targetW over barDur seconds, with a
      // small stagger so they cascade.
      const barStartT = (tIn + 0.15 * idx).toFixed(2);
      const barDur = 0.65;
      const barEndT = (Number(barStartT) + barDur).toFixed(2);
      const wExpr = `if(lt(t\\,${barStartT})\\,0\\,if(lt(t\\,${barEndT})\\,${targetW}*((t-${barStartT})/${barDur.toFixed(2)})\\,${targetW}))`;
      return [
        // bar background (rail)
        `drawbox=x=${barLeftX}:y=${yRow}:w=${barMaxW}:h=10:color=white@0.10:t=fill:enable='${enable}'`,
        // bar fill (animated)
        `drawbox=x=${barLeftX}:y=${yRow}:w='${wExpr}':h=10:color=${accentColor}@0.92:t=fill:enable='${enable}'`,
        // value text at bar end
        `drawtext=text='${String(p.label).replace(/'/g, "\\'")}'${FONT_HEADLINE}:fontcolor=white:fontsize=22${TEXT_SHADOW}:x=${barLeftX + barMaxW - 80}:y=${yRow - 32}:alpha='${alpha}':enable='${enable}'`
      ];
    });
    const wipeHead = buildWipeWidth(420, 0.55);
    return [
      ...buildBgDim(),
      // top header line
      `drawbox=x=${barLeftX}:y=164:w=${wipeHead}:h=3:color=${accentColor}@0.85:t=fill:enable='${enable}'`,
      // headline (left aligned doc style)
      `drawtext=textfile='${escapedTitle}'${FONT_HEADLINE}:fontcolor=white:fontsize=34${TEXT_SHADOW}:x=${barLeftX}:y=180+(${slideTitle}):alpha='${alpha}':enable='${enable}'`,
      `drawtext=textfile='${escapedSub}'${FONT_BODY}:fontcolor=white@0.65:fontsize=18${SUB_SHADOW}:x=${barLeftX}:y=220+(${slideSub}):alpha='${alpha}':enable='${enable}'`,
      ...rows.flat()
    ];
  }

  // ───────── NEW LAYOUT: title-stack — kicker + headline + value + footnote
  // with two thin horizontal reveal-in lines top/bottom (AgriDemo "JOHN DEERE
  // / COMBINE HARVESTER / $800,000 / UPFRONT" style).
  if (layout === "title-stack") {
    // Try to extract a numeric value from the title; everything else becomes
    // the headline. If no number — title goes to headline, sublabel below.
    const numMatch = String(titleLine).match(/([$€£₴]\s?\d[\d.,]*\s?(?:k|m|mln|млн|млрд)?|\b\d[\d.,]*\s?%?)\b/i);
    const valueText = numMatch ? numMatch[0].trim().toUpperCase() : "";
    const headlineText = valueText
      ? String(titleLine).replace(numMatch[0], "").replace(/\s+/g, " ").trim()
      : String(titleLine);
    // Write split files
    const stackHeadFile = path.join(tempDir, `overlay_${type}_${randomUUID()}_head.txt`);
    const stackValFile  = path.join(tempDir, `overlay_${type}_${randomUUID()}_val.txt`);
    await fs.writeFile(stackHeadFile, headlineText, "utf8");
    if (valueText) await fs.writeFile(stackValFile, valueText, "utf8");
    const escapedHead = escapeDrawtextPath(stackHeadFile);
    const escapedVal  = escapeDrawtextPath(stackValFile);

    // Reveal-in lines: animate width from 0 to ~880px during fade-in.
    const lineW = buildWipeWidth(880, 0.55);
    return [
      ...buildBgDim(),
      // top reveal line
      `drawbox=x=(1280-880)/2+(880-(${lineW}))/2:y=192:w=${lineW}:h=2:color=${accentColor}@0.85:t=fill:enable='${enable}'`,
      // bottom reveal line
      `drawbox=x=(1280-880)/2+(880-(${lineW}))/2:y=556:w=${lineW}:h=2:color=${accentColor}@0.85:t=fill:enable='${enable}'`,
      // kicker (sublabel acts as kicker on top)
      `drawtext=textfile='${escapedSub}'${FONT_BODY}:fontcolor=white@0.75:fontsize=18${SUB_SHADOW}:x=(w-text_w)/2:y=234+(${slideSub}):alpha='${alpha}':enable='${enable}'`,
      // headline
      `drawtext=textfile='${escapedHead}'${FONT_HEADLINE}:fontcolor=white:fontsize=58${TEXT_SHADOW}:x=(w-text_w)/2:y=276+(${slideTitle}):alpha='${alpha}':enable='${enable}'`,
      // value (orange/accent)
      ...(valueText ? [
        `drawtext=textfile='${escapedVal}'${FONT_HEADLINE}:fontcolor=${accentColor}:fontsize=98${TEXT_SHADOW}:x=(w-text_w)/2:y=360+(${slideTitle}):alpha='${alpha}':enable='${enable}'`
      ] : []),
      // small bottom label (re-uses sublabel mirrored)
      `drawtext=textfile='${escapedSub}'${FONT_BODY}:fontcolor=white@0.55:fontsize=16:x=(w-text_w)/2:y=478+(${slideSub}):alpha='${alpha}':enable='${enable}'`
    ];
  }

  // ───────── NEW LAYOUT: counter-callout — number animates 0 → target,
  // then sublabel reveals (AgriDemo "148,105 → 400,000" style).
  if (layout === "counter-callout") {
    // Parse a target integer out of the title. Strip currency symbols and units.
    const numericMatch = String(titleLine).replace(/[^\d.,]/g, "").match(/(\d+(?:[.,]\d+)?)/);
    if (numericMatch) {
      const targetRaw = numericMatch[1].replace(/,/g, "");
      const target = Math.max(1, Math.round(Number(targetRaw)));
      // Detect "$" and "%" prefix/suffix from original title for formatting.
      const hasDollar = /[$€£₴]/.test(titleLine);
      const hasPercent = /%/.test(titleLine);
      // Optional unit suffix from title (e.g. "MIN", "K", "M") — keep last 1-3 letters.
      const unitMatch = String(titleLine).match(/[A-ZА-ЯҐЇІЄ]{1,3}\s*$/);
      const unit = unitMatch ? unitMatch[0].trim() : "";
      // Counter runs over the first ~75% of the visible window, then locks.
      const tickEnd = (tIn + Math.min(1.4, (tOut - tIn) * 0.6)).toFixed(2);
      const tInS = tIn.toFixed(2);
      // Eased linear interp from 0 to target during [tIn .. tickEnd], then hold.
      // ffmpeg drawtext understands `text='%{eif\:expr\:d}'` to print integer of expr.
      // We can't use textfile + dynamic text together, so put the whole expression in `text`.
      // Build prefix/suffix outside of expression.
      const prefix = hasDollar ? "$" : "";
      const suffix = hasPercent ? "%" : (unit ? ` ${unit}` : "");
      const counterExpr = `min(${target}\\,floor(${target}*max(0\\,(t-${tInS})/(${tickEnd}-${tInS}))))`;
      // Format with thousands separator using locale-aware approach is hard in
      // ffmpeg expression; we emit raw integers. For aesthetic, prepend prefix
      // and append unit/percent.
      const counterText = `${prefix.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}%{eif\\:${counterExpr}\\:d}${suffix.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}`;
      return [
        ...buildLetterbox(),
        ...buildBgDim(),
        // animated counter
        `drawtext=text='${counterText}'${FONT_HEADLINE}:fontcolor=white:fontsize=132${TEXT_SHADOW}:x=(w-text_w)/2:y=270+(${slideTitle}):alpha='${alpha}':enable='${enable}'`,
        // sublabel fades in slightly later via secondary alpha (re-uses same alpha curve, looks fine)
        `drawbox=x=(1280-220)/2+(220-(${buildWipeWidth(220, 0.65)}))/2:y=434+(${slideSub}):w=${buildWipeWidth(220, 0.65)}:h=3:color=${accentColor}:t=fill:enable='${enable}'`,
        `drawtext=textfile='${escapedSub}'${FONT_BODY}:fontcolor=${accentColor}:fontsize=24${SUB_SHADOW}:x=(w-text_w)/2:y=448+(${slideSub}):alpha='${alpha}':enable='${enable}'`
      ];
    }
    // No number found — fall through to stat-callout style.
    const wipeW = buildWipeWidth(220);
    return [
      ...buildLetterbox(),
      ...buildBgDim(),
      `drawtext=textfile='${escapedTitle}'${FONT_HEADLINE}:fontcolor=white:fontsize=132${TEXT_SHADOW}:x=(w-text_w)/2:y=270+(${slideTitle}):alpha='${alpha}':enable='${enable}'`,
      `drawbox=x=(1280-${220})/2+(${220}-(${wipeW}))/2:y=434+(${slideSub}):w=${wipeW}:h=3:color=${accentColor}:t=fill:enable='${enable}'`,
      `drawtext=textfile='${escapedSub}'${FONT_BODY}:fontcolor=${accentColor}:fontsize=24${SUB_SHADOW}:x=(w-text_w)/2:y=448+(${slideSub}):alpha='${alpha}':enable='${enable}'`
    ];
  }

  // ───────── EXISTING LAYOUTS — polished with shadows + wipes + soft dim
  if (layout === "overlay-center") {
    const wipeW = buildWipeWidth(680);
    return [
      ...buildBgDim(),
      `drawbox=x=220:y=274:w=840:h=146:color=black@0.45:t=fill:enable='${enable}'`,
      `drawbox=x=(1280-${680})/2+(${680}-(${wipeW}))/2:y=434:w=${wipeW}:h=3:color=${accentColor}@0.9:t=fill:enable='${enable}'`,
      `drawtext=textfile='${escapedTitle}'${FONT_HEADLINE}:fontcolor=white:fontsize=52${TEXT_SHADOW}:x=(w-text_w)/2:y=314+(${slideTitle}):alpha='${alpha}':enable='${enable}'`,
      `drawtext=textfile='${escapedSub}'${FONT_BODY}:fontcolor=${accentColor}:fontsize=22${SUB_SHADOW}:x=(w-text_w)/2:y=388+(${slideSub}):alpha='${alpha}':enable='${enable}'`
    ];
  }
  if (layout === "overlay-side") {
    return [
      `drawbox=x=70:y=112:w=520:h=132:color=black@0.50:t=fill:enable='${enable}'`,
      `drawbox=x=70:y=112:w=8:h=132:color=${accentColor}:t=fill:enable='${enable}'`,
      `drawtext=textfile='${escapedTitle}'${FONT_HEADLINE}:fontcolor=white:fontsize=34${TEXT_SHADOW}:x=98:y=146+(${slideTitle}):alpha='${alpha}':enable='${enable}'`,
      `drawtext=textfile='${escapedSub}'${FONT_BODY}:fontcolor=${accentColor}:fontsize=18${SUB_SHADOW}:x=98:y=200+(${slideSub}):alpha='${alpha}':enable='${enable}'`
    ];
  }
  if (layout === "overlay-pulse") {
    const wipeW = buildWipeWidth(960);
    return [
      `drawbox=x=160:y=92:w=960:h=92:color=black@0.50:t=fill:enable='${enable}'`,
      `drawbox=x=160+(${960}-(${wipeW}))/2:y=192:w=${wipeW}:h=3:color=${accentColor}@0.9:t=fill:enable='${enable}'`,
      `drawtext=textfile='${escapedTitle}'${FONT_HEADLINE}:fontcolor=white:fontsize=42${TEXT_SHADOW}:x=(w-text_w)/2:y=118+(${slideTitle}):alpha='${alpha}':enable='${enable}'`,
      `drawtext=textfile='${escapedSub}'${FONT_BODY}:fontcolor=${accentColor}:fontsize=18${SUB_SHADOW}:x=(w-text_w)/2:y=170+(${slideSub}):alpha='${alpha}':enable='${enable}'`
    ];
  }
  // photo-frame: title + sublabel below the framed content area (y>630)
  if (layout === "photo-frame") {
    return [
      `drawtext=textfile='${escapedTitle}'${FONT_HEADLINE}:fontcolor=white:fontsize=30${TEXT_SHADOW}:x=(w-text_w)/2:y=642+(${slideTitle}):alpha='${alpha}':enable='${enable}'`,
      `drawtext=textfile='${escapedSub}'${FONT_BODY}:fontcolor=${accentColor}:fontsize=18${SUB_SHADOW}:x=(w-text_w)/2:y=682+(${slideSub}):alpha='${alpha}':enable='${enable}'`
    ];
  }

  // ───────── LAYOUT: news-ticker — CNN/BBC breaking-news style red bar
  if (layout === "news-ticker") {
    // "BREAKING" badge on left, headline scrolls in from right
    const badgeW = 192;
    const tickerY = 620;
    const tickerH = 100;
    const tInS = tIn.toFixed(2);
    const slideEndT = (tIn + 0.55).toFixed(2);
    // Headline slides from right edge into view over 0.55s
    const headlineX = badgeW + 18;
    const slideInX = `if(lt(t,${slideEndT}),${headlineX}+1080*max(0,1-(t-${tInS})/0.55),${headlineX})`;
    // Badge text file
    const badgeFile = path.join(tempDir, `overlay_badge_${randomUUID()}.txt`);
    await fs.writeFile(badgeFile, subLine, "utf8");
    const escapedBadge = escapeDrawtextPath(badgeFile);
    return [
      // Full-width dark base strip
      `drawbox=x=0:y=${tickerY}:w=1280:h=${tickerH}:color=black@0.88:t=fill:enable='${enable}'`,
      // Red badge block on left
      `drawbox=x=0:y=${tickerY}:w=${badgeW}:h=${tickerH}:color=#cc0000:t=fill:enable='${enable}'`,
      // Thin accent top border on full strip
      `drawbox=x=0:y=${tickerY}:w=1280:h=4:color=#ff3333:t=fill:enable='${enable}'`,
      // Badge label (e.g. "BREAKING NEWS") centered in red block
      `drawtext=textfile='${escapedBadge}'${FONT_HEADLINE}:fontcolor=white:fontsize=18${TEXT_SHADOW}:x=(${badgeW}-text_w)/2:y=${tickerY + 38}:alpha='${alpha}':enable='${enable}'`,
      // Headline slides in from right
      `drawtext=textfile='${escapedTitle}'${FONT_HEADLINE}:fontcolor=white:fontsize=34${TEXT_SHADOW}:x='${slideInX}':y=${tickerY + 30}:alpha='${alpha}':enable='${enable}'`,
      // Sublabel below headline (right of badge)
      `drawtext=textfile='${escapedSub}'${FONT_BODY}:fontcolor=${accentColor}:fontsize=18${SUB_SHADOW}:x=${headlineX}:y=${tickerY + 70}:alpha='${alpha}':enable='${enable}'`
    ];
  }

  // ───────── LAYOUT: location-stamp — GPS-style location badge lower-left
  if (layout === "location-stamp") {
    const stampX = 56;
    const stampY = 580;
    const stampW = 460;
    const stampH = 110;
    const dotSize = 20;
    const dotX = stampX + 22;
    const dotY = stampY + (stampH / 2) - dotSize / 2;
    const textX = dotX + dotSize + 16;
    return [
      // Background pill
      `drawbox=x=${stampX}:y=${stampY}:w=${stampW}:h=${stampH}:color=black@0.72:t=fill:enable='${enable}'`,
      // Left accent bar
      `drawbox=x=${stampX}:y=${stampY}:w=5:h=${stampH}:color=${accentColor}:t=fill:enable='${enable}'`,
      // Location dot/pin (small filled square)
      `drawbox=x=${dotX}:y=${dotY}:w=${dotSize}:h=${dotSize}:color=${accentColor}:t=fill:enable='${enable}'`,
      // Location name
      `drawtext=textfile='${escapedTitle}'${FONT_HEADLINE}:fontcolor=white:fontsize=36${TEXT_SHADOW}:x=${textX}:y=${stampY + 22}+(${slideTitle}):alpha='${alpha}':enable='${enable}'`,
      // Coordinates-style sublabel
      `drawtext=textfile='${escapedSub}'${FONT_BODY}:fontcolor=${accentColor}:fontsize=17${SUB_SHADOW}:x=${textX}:y=${stampY + 68}+(${slideSub}):alpha='${alpha}':enable='${enable}'`
    ];
  }

  // ───────── LAYOUT: chapter-card — full-screen cinematic chapter break
  if (layout === "chapter-card") {
    // Heavy dark scrim + wipe-in center line + large title
    const wipeW = buildWipeWidth(720, 0.65);
    // Sub (chapter number label) above line; title below
    return [
      // Full screen dark overlay (heavier than regular dim)
      `drawbox=x=0:y=0:w=1280:h=720:color=black@0.82:t=fill:enable='${enable}'`,
      // Horizontal wipe line at center
      `drawbox=x=(1280-720)/2+(720-(${wipeW}))/2:y=334:w=${wipeW}:h=2:color=${accentColor}@0.9:t=fill:enable='${enable}'`,
      // Chapter label above line (small kicker)
      `drawtext=textfile='${escapedSub}'${FONT_BODY}:fontcolor=${accentColor}:fontsize=20${SUB_SHADOW}:x=(w-text_w)/2:y=294+(${slideSub}):alpha='${alpha}':enable='${enable}'`,
      // Chapter title below line (large)
      `drawtext=textfile='${escapedTitle}'${FONT_HEADLINE}:fontcolor=white:fontsize=64${TEXT_SHADOW}:x=(w-text_w)/2:y=356+(${slideTitle}):alpha='${alpha}':enable='${enable}'`
    ];
  }

  // ───────── LAYOUT: redacted-doc — classified document aesthetic
  if (layout === "redacted-doc") {
    const docX = 140;
    const docY = 160;
    const docW = 1000;
    const docH = 400;
    const wipeW = buildWipeWidth(docW, 0.50);
    // Redaction bar covers part of title line to simulate blacked-out text
    const redactY = docY + 92;
    const redactW = Math.min(380, Math.max(120, Math.floor(titleLine.length * 9)));
    const stampFile = path.join(tempDir, `overlay_stamp_${randomUUID()}.txt`);
    const stampText = subLine; // "CLASSIFIED" / "СЕКРЕТНО"
    await fs.writeFile(stampFile, stampText, "utf8");
    const escapedStamp = escapeDrawtextPath(stampFile);
    return [
      ...buildBgDim(),
      // Document background
      `drawbox=x=${docX}:y=${docY}:w=${docW}:h=${docH}:color=black@0.60:t=fill:enable='${enable}'`,
      // Top wipe-in accent border
      `drawbox=x=${docX}+(${docW}-(${wipeW}))/2:y=${docY}:w=${wipeW}:h=4:color=${accentColor}@0.9:t=fill:enable='${enable}'`,
      // Title text
      `drawtext=textfile='${escapedTitle}'${FONT_HEADLINE}:fontcolor=white:fontsize=38${TEXT_SHADOW}:x=${docX + 28}:y=${docY + 48}+(${slideTitle}):alpha='${alpha}':enable='${enable}'`,
      // Redaction bar over bottom of title line
      `drawbox=x=${docX + 28}:y=${redactY}:w=${redactW}:h=26:color=black:t=fill:enable='${enable}'`,
      // Horizontal rule
      `drawbox=x=${docX + 20}:y=${docY + 138}:w=${docW - 40}:h=1:color=white@0.20:t=fill:enable='${enable}'`,
      // Sublabel (CLASSIFIED stamp style)
      `drawtext=textfile='${escapedStamp}'${FONT_HEADLINE}:fontcolor=${accentColor}:fontsize=22${SUB_SHADOW}:x=${docX + 28}:y=${docY + 160}+(${slideSub}):alpha='${alpha}':enable='${enable}'`,
      // Second redaction bar in lower area
      `drawbox=x=${docX + 28}:y=${docY + 220}:w=${Math.min(600, redactW + 120)}:h=22:color=black@0.85:t=fill:enable='${enable}'`,
      `drawbox=x=${docX + 28}:y=${docY + 258}:w=${Math.min(440, redactW + 60)}:h=22:color=black@0.70:t=fill:enable='${enable}'`
    ];
  }

  // ───────── LAYOUT: typewriter-card — cream card, typed reveal feel
  if (layout === "typewriter-card") {
    const cardX = 140;
    const cardY = 200;
    const cardW = 1000;
    const cardH = 320;
    const wipeW = buildWipeWidth(cardW, 0.45);
    // Cursor blink: appears and disappears rapidly via alternating enable windows
    const cursorOnA  = `between(t\\,${(tIn + 0.3).toFixed(2)}\\,${(tIn + 0.8).toFixed(2)})`;
    const cursorOnB  = `between(t\\,${(tIn + 1.1).toFixed(2)}\\,${(tIn + 1.6).toFixed(2)})`;
    const cursorOnC  = `between(t\\,${(tIn + 1.9).toFixed(2)}\\,${(tIn + 2.4).toFixed(2)})`;
    const approxTextW = Math.min(900, titleLine.length * 20);
    const cursorX = cardX + 28 + approxTextW;
    return [
      ...buildBgDim(),
      // Cream card background
      `drawbox=x=${cardX}:y=${cardY}:w=${cardW}:h=${cardH}:color=#f5f0e8@0.94:t=fill:enable='${enable}'`,
      // Top accent bar wipe-in
      `drawbox=x=${cardX}+(${cardW}-(${wipeW}))/2:y=${cardY}:w=${wipeW}:h=5:color=${accentColor}@0.85:t=fill:enable='${enable}'`,
      // Main text (dark ink on cream)
      `drawtext=textfile='${escapedTitle}'${FONT_HEADLINE}:fontcolor=#1a1a1a:fontsize=36:x=${cardX + 28}:y=${cardY + 50}+(${slideTitle}):alpha='${alpha}':enable='${enable}'`,
      // Blinking cursor
      `drawbox=x=${cursorX}:y=${cardY + 50}:w=4:h=38:color=#1a1a1a:t=fill:enable='${cursorOnA}'`,
      `drawbox=x=${cursorX}:y=${cardY + 50}:w=4:h=38:color=#1a1a1a:t=fill:enable='${cursorOnB}'`,
      `drawbox=x=${cursorX}:y=${cardY + 50}:w=4:h=38:color=#1a1a1a:t=fill:enable='${cursorOnC}'`,
      // Sublabel below
      `drawtext=textfile='${escapedSub}'${FONT_BODY}:fontcolor=${accentColor}:fontsize=20${SUB_SHADOW}:x=${cardX + 28}:y=${cardY + 240}+(${slideSub}):alpha='${alpha}':enable='${enable}'`
    ];
  }

  // default: overlay-lower
  return [
    `drawbox=x=92:y=500:w=860:h=120:color=black@0.50:t=fill:enable='${enable}'`,
    `drawbox=x=92:y=500:w=8:h=120:color=${accentColor}:t=fill:enable='${enable}'`,
    `drawtext=textfile='${escapedTitle}'${FONT_HEADLINE}:fontcolor=white:fontsize=38${TEXT_SHADOW}:x=120:y=528+(${slideTitle}):alpha='${alpha}':enable='${enable}'`,
    `drawtext=textfile='${escapedSub}'${FONT_BODY}:fontcolor=${accentColor}:fontsize=20${SUB_SHADOW}:x=120:y=586+(${slideSub}):alpha='${alpha}':enable='${enable}'`
  ];
}

// ── Split-screen: two clips side by side ─────────────────────────────────────
async function buildSplitScreenClip({ sourcePath, isImage, secondSourcePath, duration, outputPath, overlayInsert = null, tempDir = "" }) {
  const safeDuration = Math.max(0.6, Number(duration) || 1);
  const isSecondImage = /\.(jpg|jpeg|png|webp|gif|bmp)$/i.test(String(secondSourcePath || ""));

  const leftFilter = isImage
    ? `[0:v]loop=loop=-1:size=32767:start=0,setpts=N/FRAME_RATE/TB,scale=640:720:force_original_aspect_ratio=increase,crop=640:720,fps=30[left]`
    : `[0:v]scale=640:720:force_original_aspect_ratio=increase,crop=640:720,fps=30[left]`;
  const rightFilter = isSecondImage
    ? `[1:v]loop=loop=-1:size=32767:start=0,setpts=N/FRAME_RATE/TB,scale=640:720:force_original_aspect_ratio=increase,crop=640:720,fps=30[right]`
    : `[1:v]scale=640:720:force_original_aspect_ratio=increase,crop=640:720,fps=30[right]`;

  // Thin white divider + subtle gradient darkening at edges
  const filterComplex = [
    leftFilter,
    rightFilter,
    `[left][right]hstack=inputs=2[stacked]`,
    `[stacked]drawbox=x=637:y=0:w=6:h=720:color=white@0.75:t=fill[out]`
  ].join(";");

  const inputs = [];
  if (isImage) inputs.push("-loop", "1");
  inputs.push("-i", sourcePath);
  if (isSecondImage) inputs.push("-loop", "1");
  inputs.push("-i", secondSourcePath);

  await runFfmpeg([
    "-y",
    ...inputs,
    "-t", String(safeDuration),
    "-filter_complex", filterComplex,
    "-map", "[out]",
    "-an",
    ...videoCodecArgs(),
    outputPath
  ]);
}

async function buildClip({ sourcePath, isImage, duration, outputPath, montageSettings = {}, overlayInsert = null, tempDir = "", secondSourcePath = null }) {
  const layout = overlayInsert?.layout || "";

  // Split-screen: hand off to dedicated function
  if (layout === "split-screen" && secondSourcePath) {
    return buildSplitScreenClip({ sourcePath, isImage, secondSourcePath, duration, outputPath, overlayInsert, tempDir });
  }

  const safeDuration = Math.max(0.6, Number(duration) || 1);
  const imageCropTo16x9 = "crop='if(gte(iw/ih,16/9),ih*16/9,iw)':'if(gte(iw/ih,16/9),ih,iw*9/16)':(iw-ow)/2:(ih-oh)/2,scale=1280:720,setsar=1,setdar=16/9";
  const videoScaleTo16x9 = "scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,setsar=1,setdar=16/9";
  const strength = Math.max(1, Math.min(3, Number(montageSettings.imageAnimationStrength) || 2));
  const zoomGain = (0.0007 + strength * 0.00045).toFixed(5);
  const zoomMax = (1.08 + strength * 0.07).toFixed(3);
  const driftX = 8 + strength * 8;
  const driftY = 6 + strength * 6;
  const imageAnimationsByStyle = {
    zoom: [
      `zoompan=z='min(zoom+${zoomGain},${zoomMax})':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1280x720:fps=30`,
      `zoompan=z='if(lte(on,90),min(zoom+${zoomGain},${zoomMax}),max(zoom-${(Number(zoomGain) * 0.8).toFixed(5)},1.0))':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1280x720:fps=30`
    ],
    shake: [
      `zoompan=z='min(zoom+${(Number(zoomGain) * 0.8).toFixed(5)},${(Number(zoomMax) - 0.02).toFixed(3)})':x='iw/2-(iw/zoom/2)+${driftX}*sin(on/8)':y='ih/2-(ih/zoom/2)+${driftY}*cos(on/10)':d=1:s=1280x720:fps=30`,
      `zoompan=z='min(zoom+${(Number(zoomGain) * 0.75).toFixed(5)},${(Number(zoomMax) - 0.03).toFixed(3)})':x='iw/2-(iw/zoom/2)+${driftX + 6}*sin(on/7)':y='ih/2-(ih/zoom/2)+${driftY + 4}*sin(on/9)':d=1:s=1280x720:fps=30`
    ],
    drift: [
      `zoompan=z='min(zoom+${(Number(zoomGain) * 0.55).toFixed(5)},${(Number(zoomMax) - 0.04).toFixed(3)})':x='iw/2-(iw/zoom/2)+${driftX + 4}*(on/240)':y='ih/2-(ih/zoom/2)':d=1:s=1280x720:fps=30`,
      `zoompan=z='min(zoom+${(Number(zoomGain) * 0.6).toFixed(5)},${(Number(zoomMax) - 0.03).toFixed(3)})':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)+${driftY + 4}*(on/220)':d=1:s=1280x720:fps=30`
    ]
  };
  const imageAnimations = [
    ...imageAnimationsByStyle.zoom,
    ...imageAnimationsByStyle.shake,
    ...imageAnimationsByStyle.drift
  ];
  const style = String(montageSettings.imageAnimationStyle || "combo");
  const stylePool = style === "combo"
    ? imageAnimations
    : (imageAnimationsByStyle[style] || imageAnimationsByStyle.zoom);
  const pickedAnimation = stylePool[Math.floor(Math.random() * stylePool.length)];

  // Photo-frame: scale content into a framed box centered on black canvas.
  // The border + text are drawn on top via overlayFilters.
  const isPhotoFrame = layout === "photo-frame";
  const photoFrameVf =
    // Scale to fit inside 794×536, letterbox with black, then center on 1280×720
    "scale=794:536:force_original_aspect_ratio=decrease," +
    "pad=794:536:(ow-iw)/2:(oh-ih)/2:black," +
    "pad=1280:720:243:82:black," +
    // Outer white border
    "drawbox=x=237:y=76:w=806:h=548:color=white@0.88:t=7," +
    // Thin inner shadow line
    "drawbox=x=244:y=83:w=792:h=534:color=black@0.25:t=3," +
    // Subtle corner accent dots
    "drawbox=x=237:y=76:w=14:h=14:color=white:t=fill," +
    "drawbox=x=1029:y=76:w=14:h=14:color=white:t=fill," +
    "drawbox=x=237:y=610:w=14:h=14:color=white:t=fill," +
    "drawbox=x=1029:y=610:w=14:h=14:color=white:t=fill";

  const baseVf = isPhotoFrame
    ? (isImage
        ? `${imageCropTo16x9},${pickedAnimation},${photoFrameVf}`
        : `${videoScaleTo16x9},fps=30,${photoFrameVf}`)
    : (isImage ? `${imageCropTo16x9},${pickedAnimation}` : `${videoScaleTo16x9},fps=30`);

  const overlayFilters = await buildProfOverlayFilters({ overlayInsert, duration: safeDuration, tempDir });
  const vf = [baseVf, ...overlayFilters].filter(Boolean).join(",");

  const args = isImage
    ? [
        "-y",
        "-loop", "1",
        "-i", sourcePath,
        "-t", String(safeDuration),
        "-vf", vf,
        "-an",
        ...videoCodecArgs(),
        outputPath
      ]
    : [
        "-y",
        "-stream_loop", "-1",
        "-i", sourcePath,
        "-t", String(safeDuration),
        "-vf", vf,
        "-an",
        ...videoCodecArgs(),
        outputPath
      ];

  await runFfmpeg(args);
}

async function buildTimelineWithTransitions({ clipPaths, clipDurations, transitionDuration, outputPath, montageSettings = {} }) {
  const safeDuration = Math.max(0.08, Math.min(0.6, Number(transitionDuration) || 0.22));
  if (clipPaths.length === 1) {
    await runFfmpeg([
      "-y",
      "-i", clipPaths[0],
      "-vf", "fps=30,format=yuv420p",
      ...videoCodecArgs(),
      outputPath
    ]);
    return;
  }

  const transitionPacks = {
    smooth: ["fade", "fadeblack", "dissolve", "smoothleft", "smoothright"],
    dynamic: ["fade", "wipeleft", "wiperight", "slideleft", "slideright", "circleopen", "circleclose"],
    aggressive: ["pixelize", "circleopen", "circleclose", "wipeup", "wipedown", "distance", "fadeblack"]
  };
  const packName = ["smooth", "dynamic", "aggressive"].includes(String(montageSettings.transitionPack))
    ? String(montageSettings.transitionPack)
    : "dynamic";
  const transitions = transitionPacks[packName];
  const args = ["-y"];
  for (const clipPath of clipPaths) {
    args.push("-i", clipPath);
  }

  let filterGraph = "";
  for (let i = 0; i < clipPaths.length; i += 1) {
    filterGraph += `[${i}:v]fps=30,scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,setsar=1,format=yuv420p,settb=AVTB,setpts=PTS-STARTPTS[v${i}];`;
  }

  let prevLabel = "v0";
  let offset = 0;

  for (let i = 1; i < clipPaths.length; i += 1) {
    const transition = transitions[(i - 1) % transitions.length];
    const prevDuration = Math.max(0.6, Number(clipDurations?.[i - 1]) || 1);
    offset += Math.max(0.05, prevDuration - safeDuration);
    const outLabel = i === clipPaths.length - 1 ? "vout" : `vxf${i}`;
    filterGraph += `[${prevLabel}][v${i}]xfade=transition=${transition}:duration=${safeDuration}:offset=${offset.toFixed(3)}[${outLabel}];`;
    prevLabel = outLabel;
  }

  const normalizedOut = "vfinal";
  const fullGraph = `${filterGraph}[${prevLabel}]fps=30,format=yuv420p[${normalizedOut}]`.replace(/;$/, "");

  args.push(
    "-filter_complex", fullGraph,
    "-map", `[${normalizedOut}]`,
    ...videoCodecArgs(),
    outputPath
  );

  await runFfmpeg(args);
}

async function buildTimelineByConcat({ clipPaths, outputPath, tempDir }) {
  const concatPath = path.join(tempDir, `concat_${randomUUID().slice(0, 8)}.txt`);
  const concatContent = clipPaths
    .map((clipPath) => `file '${clipPath.replaceAll("'", "'\\''")}'`)
    .join("\n");
  await fs.writeFile(concatPath, concatContent, "utf8");

  await runFfmpeg([
    "-y",
    "-f", "concat",
    "-safe", "0",
    "-i", concatPath,
    "-vf", "fps=30,format=yuv420p",
    "-vsync", "cfr",
    ...videoCodecArgs(),
    outputPath
  ]);
}

async function buildPlaceholderClip({ duration, outputPath }) {
  await runFfmpeg([
    "-y",
    "-f", "lavfi",
    "-i", "color=c=black:s=1280x720:r=30",
    "-t", String(Math.max(0.6, Number(duration) || 1)),
    "-vf", "format=yuv420p",
    "-an",
    ...videoCodecArgs(),
    outputPath
  ]);
}

function parseJsonObject(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;

  try {
    const direct = JSON.parse(raw);
    if (direct && typeof direct === "object") return direct;
  } catch {
    // noop
  }

  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;

  try {
    const picked = JSON.parse(match[0]);
    return picked && typeof picked === "object" ? picked : null;
  } catch {
    return null;
  }
}

function parseJsonArray(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;

  try {
    const direct = JSON.parse(raw);
    return Array.isArray(direct) ? direct : null;
  } catch {
    // noop
  }

  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) return null;

  try {
    const picked = JSON.parse(match[0]);
    return Array.isArray(picked) ? picked : null;
  } catch {
    return null;
  }
}

async function describeVisualWithOpenAI({ openaiApiKey, mediaParts, locale }) {
  if (!openaiApiKey) {
    return {
      summary: "",
      tags: [],
      scene: "",
      objects: []
    };
  }

  const prompt = locale?.toLowerCase().startsWith("uk")
    ? "Проаналізуй контент і поверни ТІЛЬКИ JSON: {\"summary\": string, \"scene\": string, \"tags\": string[], \"objects\": string[]}. tags: до 14 коротких слів, без загальних слів типу красиво/круто."
    : "Analyze visual content and return ONLY JSON: {\"summary\": string, \"scene\": string, \"tags\": string[], \"objects\": string[]}. tags: up to 14 short concrete words, no generic adjectives.";

  const body = {
    model: "gpt-4o-mini",
    temperature: 0.2,
    messages: [
      {
        role: "system",
        content: "You are a strict JSON generator. Return valid JSON only, with no markdown and no extra text."
      },
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          ...mediaParts
        ]
      }
    ]
  };

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${openaiApiKey}`
    },
    body: JSON.stringify(body)
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const msg = payload?.error?.message || `OpenAI error ${response.status}`;
    throw new Error(msg);
  }

  const content = payload?.choices?.[0]?.message?.content || "";
  const parsed = parseJsonObject(content) || {};

  const tags = Array.isArray(parsed.tags)
    ? parsed.tags.map((x) => String(x).toLowerCase().trim()).filter((x) => x.length > 1).slice(0, 14)
    : [];

  const objects = Array.isArray(parsed.objects)
    ? parsed.objects.map((x) => String(x).toLowerCase().trim()).filter((x) => x.length > 1).slice(0, 14)
    : [];

  const summary = String(parsed.summary || "").trim();
  const scene = String(parsed.scene || "").trim();

  return { summary, scene, tags, objects };
}

async function openAiChatJson({ openaiApiKey, systemPrompt, userPrompt, model = "gpt-4o-mini", temperature = 0.2 }) {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${openaiApiKey}`
    },
    body: JSON.stringify({
      model,
      temperature,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ]
    })
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const msg = payload?.error?.message || `OpenAI error ${response.status}`;
    throw new Error(msg);
  }

  return payload?.choices?.[0]?.message?.content || "";
}

function detectThemeFallback(text = "") {
  const t = String(text || "").toLowerCase();
  const has = (re) => re.test(t);

  if (has(/нацист|nazi|nazis|gestapo|hitler|wehrmacht|ss\b|концтаб|auschwitz|belsen|holocaust|world war|ww2|друга світова|вторая мировая/i)) {
    return { id: "history", label: "Історія / Друга світова", tokens: ["history", "archive", "ww2", "nazi", "documentary"] };
  }
  if (has(/зникнен|исчезновен|disappear|missing|пропал|kidnap|похищен|abduction|следств|investigation|murder|crime|forensic|detective/i)) {
    return { id: "true_crime", label: "Зникнення / True Crime", tokens: ["missing", "true crime", "investigation", "evidence", "forensic"] };
  }
  if (has(/космос|space|galaxy|nebula|planet|астро|universe|star/i)) {
    return { id: "space", label: "Космос", tokens: ["space", "galaxy", "planet", "nebula", "stars"] };
  }
  if (has(/лев|lion/i)) {
    return { id: "lion_story", label: "Історія про лева", tokens: ["lion", "wildlife", "savannah", "animal", "nature"] };
  }
  if (has(/crime|murder|detective|investigation|forensic|police|kidnap|court|serial/i)) {
    return { id: "true_crime", label: "True Crime", tokens: ["crime", "investigation", "detective", "evidence", "forensic"] };
  }
  if (has(/war|military|army|soldier|battle|frontline|tank|weapon|invasion|conflict/i)) {
    return { id: "war", label: "War", tokens: ["war", "military", "soldier", "battle", "frontline"] };
  }
  if (has(/history|historical|century|ancient|empire|archive|chronicle/i)) {
    return { id: "history", label: "History", tokens: ["history", "archive", "historical", "timeline", "ancient"] };
  }
  if (has(/business|startup|market|finance|sales|marketing/i)) {
    return { id: "business", label: "Business", tokens: ["business", "market", "finance", "strategy", "office"] };
  }
  if (has(/animal|lion|mouse|forest|wildlife|nature|pet/i)) {
    return { id: "animals", label: "Animals", tokens: ["animal", "wildlife", "forest", "nature", "lion"] };
  }

  return { id: "general", label: "General", tokens: extractKeywords(t, 6) };
}

function fallbackFocusHints(segments = []) {
  const pronouns = new Set(["вона", "він", "она", "он", "she", "he"]);
  const out = [];
  let lastSubject = "";

  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i] || {};
    const id = Number(seg.id ?? i);
    const text = String(seg.text || "").replace(/\s+/g, " ").trim();
    const words = tokenize(text);
    const first = words[0] || "";

    const localSubject = extractKeywords(text, 3)[0] || "";
    if (localSubject) lastSubject = localSubject;

    let focus = text.split(/[.!?]/)[0] || text;
    focus = focus.split(/\s+/).slice(0, 12).join(" ");

    if (pronouns.has(first) && lastSubject) {
      focus = `${lastSubject}: ${focus}`;
    }

    out.push({ id, focus: focus.trim() });
  }

  return out;
}

function normalizeFocusLanguage(text = "", targetLanguage = "uk") {
  const lang = String(targetLanguage || "uk").toLowerCase();
  let out = String(text || "").replace(/\s+/g, " ").trim();
  if (!out) return out;

  const ukPairs = [
    [/\blion\b/gi, "лев"],
    [/\bmouse\b/gi, "миша"],
    [/\bforest\b/gi, "ліс"],
    [/\banimal\b/gi, "тварина"],
    [/\bwildlife\b/gi, "дика природа"],
    [/\bsoldiers?\b/gi, "солдати"],
    [/\bmilitary\b/gi, "військові"],
    [/\bwar\b/gi, "війна"],
    [/\bnazi(s)?\b/gi, "нацисти"],
    [/\barchive\b/gi, "архівна хроніка"],
    [/\binvestigation\b/gi, "розслідування"],
    [/\bmissing\b/gi, "зникнення"],
    [/\bcrime\b/gi, "злочин"],
    [/\bprison\b/gi, "тюрма"],
    [/\bcamp\b/gi, "табір"],
    [/\bcourt\b/gi, "суд"]
  ];
  const enPairs = [
    [/\bлев[а-яіїєґ]*\b/gi, "lion"],
    [/\bмиш[а-яіїєґ]*\b/gi, "mouse"],
    [/\bліс[а-яіїєґ]*\b/gi, "forest"],
    [/\bтварин[а-яіїєґ]*\b/gi, "animal"],
    [/\bсолдат[а-яіїєґ]*\b/gi, "soldier"],
    [/\bвійськ[а-яіїєґ]*\b/gi, "military"],
    [/\bнацист[а-яіїєґ]*\b/gi, "nazi"],
    [/\bархів[а-яіїєґ]*\b/gi, "archive"],
    [/\bрозслід[а-яіїєґ]*\b/gi, "investigation"],
    [/\bзникнен[а-яіїєґ]*\b/gi, "missing"],
    [/\bзлочин[а-яіїєґ]*\b/gi, "crime"],
    [/\bтюрм[а-яіїєґ]*\b/gi, "prison"],
    [/\bтаб[іо]р[а-яіїєґ]*\b/gi, "camp"],
    [/\bсуд[а-яіїєґ]*\b/gi, "court"]
  ];

  const pairs = lang.startsWith("en") ? enPairs : ukPairs;
  for (const [re, replacement] of pairs) out = out.replace(re, replacement);
  return out.replace(/\s+/g, " ").trim();
}

function scoreTextOverlap(a, b) {
  const ta = new Set(extractKeywords(a, 24));
  const tb = new Set(extractKeywords(b, 24));
  if (!ta.size || !tb.size) return 0;
  let hit = 0;
  for (const x of ta) {
    if (tb.has(x)) hit += 1;
  }
  return hit / Math.max(1, Math.min(ta.size, tb.size));
}

async function probeMediaDuration(mediaPath) {
  const { stdout } = await runFfprobe([
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    mediaPath
  ]);
  const sec = Number.parseFloat(String(stdout || "").trim());
  return Number.isFinite(sec) ? Math.max(0.1, sec) : 1;
}

async function extractFramePaths(videoPath, tempDir) {
  const duration = await probeMediaDuration(videoPath).catch(() => 1);
  const marks = [0.12, 0.5, 0.82]
    .map((p) => Math.max(0, Math.min(duration - 0.05, duration * p)))
    .filter((x, idx, arr) => idx === 0 || Math.abs(x - arr[idx - 1]) > 0.15);

  const framePaths = [];
  for (let i = 0; i < marks.length; i += 1) {
    const framePath = path.join(tempDir, `frame_${i}.jpg`);
    await runFfmpeg([
      "-y",
      "-ss", String(marks[i]),
      "-i", videoPath,
      "-frames:v", "1",
      "-q:v", "4",
      framePath
    ]);
    framePaths.push(framePath);
  }

  return framePaths;
}

async function extractOcrTextFromImagePath(imagePath) {
  try {
    const escaped = String(imagePath).replace(/\\/g, "/").replace(/'/g, "\\'");
    const { stdout } = await runFfprobe([
      "-v", "error",
      "-f", "lavfi",
      "-i", `movie='${escaped}',ocr`,
      "-show_entries", "frame_tags=lavfi.ocr.text",
      "-of", "default=nw=1:nk=1"
    ]);

    return String(stdout || "")
      .split("\n")
      .map((x) => x.trim())
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  } catch {
    return "";
  }
}

async function extractOcrFromVideoFrames(videoPath, tempDir) {
  const frames = await extractFramePaths(videoPath, tempDir).catch(() => []);
  if (!frames.length) return "";

  const chunks = [];
  for (const framePath of frames.slice(0, 4)) {
    const text = await extractOcrTextFromImagePath(framePath);
    if (text) chunks.push(text);
  }
  return chunks.join(" ").replace(/\s+/g, " ").trim();
}

function parseFps(rawFps) {
  const text = String(rawFps || "").trim();
  if (!text) return 0;
  if (!text.includes("/")) {
    const n = Number(text);
    return Number.isFinite(n) ? n : 0;
  }
  const [a, b] = text.split("/");
  const x = Number(a);
  const y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y) || y === 0) return 0;
  return x / y;
}

async function probeMediaTechnicalInfo(mediaPath) {
  try {
    const { stdout } = await runFfprobe([
      "-v", "error",
      "-print_format", "json",
      "-show_streams",
      "-show_format",
      mediaPath
    ]);
    const parsed = JSON.parse(String(stdout || "{}"));
    const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
    const video = streams.find((s) => String(s.codec_type) === "video") || {};
    const audio = streams.find((s) => String(s.codec_type) === "audio") || {};
    const format = parsed.format || {};

    return {
      durationSec: Number(format.duration || video.duration || 0) || 0,
      width: Number(video.width || 0) || 0,
      height: Number(video.height || 0) || 0,
      fps: parseFps(video.avg_frame_rate || video.r_frame_rate || ""),
      videoCodec: String(video.codec_name || ""),
      audioCodec: String(audio.codec_name || ""),
      hasAudio: Boolean(audio.codec_name),
      bitRate: Number(format.bit_rate || 0) || 0
    };
  } catch {
    return {
      durationSec: 0,
      width: 0,
      height: 0,
      fps: 0,
      videoCodec: "",
      audioCodec: "",
      hasAudio: false,
      bitRate: 0
    };
  }
}

async function extractFramePathsDeep(videoPath, tempDir, frameCount = 3) {
  const duration = await probeMediaDuration(videoPath).catch(() => 1);
  const safeCount = Math.max(2, Math.min(8, Number(frameCount) || 3));
  const framePaths = [];
  const marks = safeCount === 3
    ? [
        Math.max(0, Math.min(duration - 0.05, 0.05)),
        Math.max(0, Math.min(duration - 0.05, duration / 2)),
        Math.max(0, Math.min(duration - 0.05, duration - 0.05))
      ]
    : Array.from({ length: safeCount }, (_value, i) => {
        const ratio = safeCount === 1 ? 0.5 : i / (safeCount - 1);
        return Math.max(0, Math.min(duration - 0.05, duration * (0.06 + ratio * 0.88)));
      });

  for (let i = 0; i < safeCount; i += 1) {
    const sec = marks[i];
    const framePath = path.join(tempDir, `deep_frame_${i}.jpg`);
    await runFfmpeg([
      "-y",
      "-ss", String(sec),
      "-i", videoPath,
      "-frames:v", "1",
      "-q:v", "4",
      framePath
    ]);
    framePaths.push(framePath);
  }

  return framePaths;
}

function keywordsOverlapRatio(expected, actual) {
  const expectedWords = extractKeywords(expected, 48);
  const actualWords = new Set(extractKeywords(actual, 64));
  if (!expectedWords.length || !actualWords.size) return 0;
  let hits = 0;
  for (const w of expectedWords) {
    if (actualWords.has(w)) hits += 1;
  }
  return hits / Math.max(1, expectedWords.length);
}

function detectSemanticBuckets(text = "") {
  const t = String(text || "").toLowerCase();
  const buckets = new Set();
  const addIf = (name, re) => {
    if (re.test(t)) buckets.add(name);
  };

  addIf("animals", /\blion|mouse|rodent|animal|wildlife|forest|savannah|jungle|cat|dog\b|лев|миш|тварин|животн|ліс|лес|природ/i);
  addIf("crime", /\bcrime|murder|detective|investigation|forensic|police|evidence|court|prison|kidnap|missing\b|зникнен|исчезнов|розслід|расслед|тюрм|суд|допит|доказ/i);
  addIf("war", /\bwar|military|army|soldier|battle|weapon|tank|frontline|explosion|ww2|nazi\b|військ|военн|солдат|армі|армия|битв|збро|оруж|танк|нацист|гітлер|гитлер/i);
  addIf("history", /\bhistory|historical|archive|ancient|museum|timeline|retro|ww2|nazi\b|істор|истор|архів|архив|хронік|хроник|музей|нацист/i);
  addIf("space", /\bspace|galaxy|nebula|cosmos|planet|astronomy|moon|mars|saturn\b/i);
  addIf("office", /\boffice|corporate|business|meeting|keyboard|laptop|desk|typing\b/i);
  addIf("fitness", /\bfitness|gym|workout|treadmill|training|exercise\b/i);
  addIf("beauty", /\bbeauty|makeup|fashion|cosmetics|skincare\b/i);
  addIf("nature", /\bnature|landscape|mountain|river|sea|outdoor|sunset\b/i);
  addIf("people", /\bperson|people|man|woman|child|children|family\b/i);
  return buckets;
}

function inferSemanticProfile(expected = "") {
  const e = String(expected || "").toLowerCase();
  const buckets = detectSemanticBuckets(e);

  const profile = {
    preferred: new Set(),
    forbidden: new Set(),
    themeId: "general"
  };

  if (/\blion|лев\b/i.test(e) || (buckets.has("animals") && /\bmouse|rodent|savannah|wildlife\b/i.test(e))) {
    profile.themeId = "lion_story";
    profile.preferred = new Set(["animals", "nature"]);
    profile.forbidden = new Set(["office", "fitness", "beauty", "space"]);
    return profile;
  }
  if (buckets.has("crime")) {
    profile.themeId = "true_crime";
    profile.preferred = new Set(["crime", "people"]);
    profile.forbidden = new Set(["space", "beauty", "fitness", "animals"]);
    return profile;
  }
  if (buckets.has("war")) {
    profile.themeId = "war";
    profile.preferred = new Set(["war", "people"]);
    profile.forbidden = new Set(["space", "beauty", "fitness"]);
    return profile;
  }
  if (buckets.has("history")) {
    profile.themeId = "history";
    profile.preferred = new Set(["history", "people"]);
    profile.forbidden = new Set(["space", "beauty", "fitness"]);
    return profile;
  }
  if (buckets.has("space")) {
    profile.themeId = "space";
    profile.preferred = new Set(["space"]);
    profile.forbidden = new Set(["crime", "war", "office", "fitness", "beauty"]);
    return profile;
  }

  profile.preferred = new Set([...buckets].slice(0, 3));
  return profile;
}

function scoreLocalAssetForSegment(segment, asset, usageCount = 0) {
  const expected = [
    segment?.text,
    segment?.focus,
    Array.isArray(segment?.keywords) ? segment.keywords.join(" ") : ""
  ].filter(Boolean).join(" ");
  const actual = [
    asset?.title,
    asset?.filename,
    asset?.summary,
    asset?.scene,
    asset?.ocrText,
    asset?.blipCaption,
    Array.isArray(asset?.tags) ? asset.tags.join(" ") : "",
    Array.isArray(asset?.objects) ? asset.objects.join(" ") : ""
  ].filter(Boolean).join(" ");
  const overlap = scoreTextOverlap(expected, actual);
  const coverage = keywordsOverlapRatio(expected, actual);
  const expectedBuckets = detectSemanticBuckets(expected);
  const actualBuckets = detectSemanticBuckets(actual);
  let bucketScore = 0;
  for (const bucket of expectedBuckets) {
    if (actualBuckets.has(bucket)) bucketScore += 0.18;
  }
  const usagePenalty = usageCount <= 0 ? 0 : usageCount === 1 ? 0.16 : usageCount === 2 ? 0.34 : 0.9;
  return Math.round(Math.max(0, Math.min(1, overlap * 0.5 + coverage * 0.28 + bucketScore - usagePenalty)) * 100);
}

function fallbackMatchLocalAssets({ segments = [], assets = [], mediaType = "both" }) {
  const filteredAssets = assets.filter((asset) => {
    const kind = asset?.kind === "image" ? "image" : "video";
    if (mediaType === "both") return true;
    return kind === mediaType;
  });
  const usage = new Map();
  return segments.map((segment, idx) => {
    let best = null;
    for (const asset of filteredAssets) {
      const fileIndex = Number(asset.fileIndex);
      const count = usage.get(fileIndex) || 0;
      if (count >= 3) continue;
      const score = scoreLocalAssetForSegment(segment, asset, count);
      if (!best || score > best.score) best = { asset, score };
    }
    if (!best) return null;
    const fileIndex = Number(best.asset.fileIndex);
    usage.set(fileIndex, (usage.get(fileIndex) || 0) + 1);
    return {
      segmentId: Number(segment.id ?? idx),
      fileIndex,
      reason: `Локальний підбір: score ${best.score}, повторів ${usage.get(fileIndex)}`
    };
  }).filter(Boolean);
}

async function analyzeStockAssetCvDeep({ kind, mediaPath, title, tags, expected, tempDir }) {
  const safeTitle = String(title || "");
  const safeTags = Array.isArray(tags) ? tags.map((x) => String(x || "")).filter(Boolean) : [];
  const textFromMeta = `${safeTitle} ${safeTags.join(" ")}`.trim();
  const overlapMetaOnly = scoreTextOverlap(expected, textFromMeta);
  const profile = inferSemanticProfile(expected);
  const metaBuckets = detectSemanticBuckets(textFromMeta);
  const metaHasForbidden = [...profile.forbidden].some((x) => metaBuckets.has(x));

  if (kind === "video" && overlapMetaOnly >= 0.55 && !metaHasForbidden) {
    return {
      score: Math.round(Math.min(1, 0.55 + overlapMetaOnly * 0.45) * 100),
      suitable: true,
      analysis: {
        summary: safeTitle || "Stock video",
        scene: "",
        tags: safeTags,
        objects: [],
        cvDetails: {
          fastPath: "meta-strong-match",
          overlapMeta: overlapMetaOnly,
          frameCount: 0,
          technical: {}
        }
      }
    };
  }

  if (kind === "video" && overlapMetaOnly <= 0.02) {
    return {
      score: 1,
      suitable: false,
      analysis: {
        summary: safeTitle || "Stock video",
        scene: "",
        tags: safeTags,
        objects: [],
        cvDetails: {
          fastPath: "meta-weak-reject",
          overlapMeta: overlapMetaOnly,
          frameCount: 0,
          technical: {}
        }
      }
    };
  }

  let ocrText = "";
  let frameCount = 0;
  let technical = {};

  if (kind === "image") {
    ocrText = await extractOcrTextFromImagePath(mediaPath);
  } else {
    technical = await probeMediaTechnicalInfo(mediaPath);
    const framePaths = await extractFramePathsDeep(mediaPath, tempDir, 3).catch(() => []);
    frameCount = framePaths.length;
    const chunks = [];
    for (const framePath of framePaths.slice(0, 2)) {
      const text = await extractOcrTextFromImagePath(framePath);
      if (text) chunks.push(text);
    }
    ocrText = chunks.join(" ").replace(/\s+/g, " ").trim();
  }

  const actual = `${textFromMeta} ${ocrText}`.trim();
  const assetBuckets = detectSemanticBuckets(actual);
  const overlapMain = scoreTextOverlap(expected, actual);
  const overlapMeta = scoreTextOverlap(expected, textFromMeta);
  const overlapOcr = scoreTextOverlap(expected, ocrText);
  const keywordCoverage = keywordsOverlapRatio(expected, actual);

  let semanticBoost = 0;
  let forbiddenPenalty = 0;
  let preferredHits = 0;
  for (const p of profile.preferred) {
    if (assetBuckets.has(p)) preferredHits += 1;
  }
  if (profile.preferred.size > 0 && preferredHits === 0) forbiddenPenalty += 0.16;
  semanticBoost += Math.min(0.22, preferredHits * 0.07);
  for (const bad of profile.forbidden) {
    if (assetBuckets.has(bad)) forbiddenPenalty += 0.26;
  }

  const technicalBonus = kind === "video" && technical.durationSec > 0 && technical.width > 0 ? 0.02 : 0;
  const weighted =
    (overlapMain * 0.48) +
    (overlapMeta * 0.2) +
    (overlapOcr * 0.22) +
    (keywordCoverage * 0.1) +
    semanticBoost +
    technicalBonus -
    forbiddenPenalty;
  const score = Math.round(Math.max(0, Math.min(1, weighted)) * 100);
  const suitableBase = kind === "video" ? 18 : 14;
  const suitable = score >= suitableBase && forbiddenPenalty < 0.5;

  return {
    score,
    suitable,
    analysis: {
      summary: safeTitle || `Stock ${kind}`,
      scene: ocrText.slice(0, 320),
      tags: safeTags,
      objects: [],
      cvDetails: {
        overlapMain,
        overlapMeta,
        overlapOcr,
        keywordCoverage,
        semanticProfile: {
          themeId: profile.themeId,
          preferred: [...profile.preferred],
          forbidden: [...profile.forbidden],
          assetBuckets: [...assetBuckets],
          preferredHits,
          forbiddenPenalty
        },
        frameCount,
        technical
      }
    }
  };
}

async function buildImagePartFromBuffer(buffer, mimeType = "image/jpeg") {
  const b64 = Buffer.from(buffer).toString("base64");
  return {
    type: "image_url",
    image_url: {
      url: `data:${mimeType};base64,${b64}`
    }
  };
}

app.post("/api/transcribe", upload.single("audio"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "Аудіофайл не передано" });
    }
    if ((req.file.size || 0) > OPENAI_AUDIO_MAX_BYTES) {
      const mb = ((req.file.size || 0) / (1024 * 1024)).toFixed(1);
      return res.status(400).json({ error: `Аудіо завелике для OpenAI (${mb} MB). Ліміт 25 MB. Стисни або розріж файл.` });
    }

    const openaiApiKey = req.body.openaiApiKey || process.env.OPENAI_API_KEY;
    if (!openaiApiKey) {
      return res.status(400).json({ error: "Потрібен OpenAI API key" });
    }

    const form = new FormData();
    const blob = new Blob([req.file.buffer], { type: req.file.mimetype || "audio/mpeg" });
    form.append("file", blob, req.file.originalname || "voice.mp3");
    form.append("model", "whisper-1");
    form.append("response_format", "verbose_json");
    // Word-level timestamps power the VAD-based splitter (real silence gaps +
    // sentence-ending punctuation). No extra cost — same Whisper request.
    form.append("timestamp_granularities[]", "word");
    form.append("timestamp_granularities[]", "segment");
    if (req.body.language) form.append("language", req.body.language);

    const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${openaiApiKey}`
      },
      body: form
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const rawMsg = String(data?.error?.message || "");
      if (/maximum content size limit|413/i.test(rawMsg)) {
        return res.status(400).json({ error: "OpenAI відхилив аудіо через ліміт 25 MB. Стисни або розріж файл." });
      }
      return res.status(response.status).json({ error: rawMsg || "Помилка транскрипції" });
    }

    const text = data.text || "";
    const splitMode = req.body.splitMode === "fixed" ? "fixed" : "context";
    const fixedSeconds = Number(req.body.fixedSeconds || 4);
    // "context" mode silently upgrades to word-level VAD when Whisper returned
    // word timestamps — same UI option, sharper boundaries. Falls back to the
    // segment-level splitter automatically when words[] is missing.
    const segments = splitMode === "fixed"
      ? buildFixedSegments(data.segments, text, fixedSeconds)
      : buildVadSegments(data.words, data.segments, text);

    return res.json({ text, segments });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Невідома помилка" });
  }
});

// Persistent analyze workspace — frames are kept so /api/local/embed-match can
// reuse them. Lazy GC removes dirs older than 30 minutes on each call.
const LOCAL_ANALYZE_KEEP_ROOT = path.join(os.tmpdir(), "vss_analyze_keep");
mkdirSync(LOCAL_ANALYZE_KEEP_ROOT, { recursive: true });
async function gcOldAnalyzeDirs(thresholdMs = 30 * 60 * 1000) {
  try {
    const entries = await fs.readdir(LOCAL_ANALYZE_KEEP_ROOT);
    const now = Date.now();
    await Promise.all(entries.map(async (name) => {
      const p = path.join(LOCAL_ANALYZE_KEEP_ROOT, name);
      try {
        const st = await fs.stat(p);
        if (now - st.mtimeMs > thresholdMs) {
          await fs.rm(p, { recursive: true, force: true });
        }
      } catch (_) {}
    }));
  } catch (_) {}
}

app.post("/api/local/analyze", upload.array("localAssets", 1000), async (req, res) => {
  // BLIP can be slow; never let Node short-circuit the analyze request.
  req.setTimeout(0);
  res.setTimeout(0);
  gcOldAnalyzeDirs().catch(() => {});
  const tempDir = path.join(LOCAL_ANALYZE_KEEP_ROOT, randomUUID());

  try {
    const files = req.files || [];
    if (!files.length) {
      return res.status(400).json({ error: "Локальні файли не передано" });
    }

    const locale = String(req.body.language || "uk");
    const localAnalyzeMode = String(req.body.localAnalyzeMode || "cv").toLowerCase();
    const userOpenaiKey = String(req.body.openaiApiKey || "").trim();
    const openaiApiKey = localAnalyzeMode === "openai"
      ? (userOpenaiKey || process.env.OPENAI_API_KEY || "")
      : "";
    await fs.mkdir(tempDir, { recursive: true });

    const videoExt = new Set([".mp4", ".mov", ".m4v", ".webm", ".avi", ".mkv"]);
    const imageExt = new Set([".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif"]);

    const parallelAssets = await parallelMap(
      files,
      async (file, i) => {
        const mimetype = String(file.mimetype || "").toLowerCase();
        const filename = String(file.originalname || "").toLowerCase();
        const ext = path.extname(filename);
        const kind = mimetype.startsWith("video/") || videoExt.has(ext)
          ? "video"
          : (mimetype.startsWith("image/") || imageExt.has(ext) ? "image" : "other");
        if (kind === "other") return null;

        const baseName = String(file.originalname || `asset_${i}`).replace(/\.[a-z0-9]+$/i, "");
        const baseTags = extractKeywords(baseName, 12);
        const useExt = ext || (kind === "image" ? ".jpg" : ".mp4");
        const localPath = path.join(tempDir, `asset_${i}${useExt}`);
        await fs.writeFile(localPath, file.buffer);

        let summary = "";
        let scene = "";
        let tags = [...baseTags];
        let objects = [];
        let ocrText = "";

        if (kind === "image") {
          ocrText = await extractOcrTextFromImagePath(localPath);
        } else {
          ocrText = await extractOcrFromVideoFrames(localPath, tempDir);
        }
        const ocrTags = extractKeywords(ocrText, 18);
        tags = [...new Set([...tags, ...ocrTags])].slice(0, 20);

        let blipCaption = "";
        let blipCaptions = [];
        // Frames are persisted (vss_analyze_keep/<uuid>) so /api/local/embed-match
        // can re-use them without re-uploading the originals.
        let framePathsForEmbed = [];
        if (kind === "image") {
          framePathsForEmbed = [localPath];
        } else {
          try {
            framePathsForEmbed = await extractFramePathsDeep(localPath, tempDir, 4);
          } catch (_) { framePathsForEmbed = []; }
        }
        if (!openaiApiKey && localAnalyzeMode !== "none") {
          try {
            const framePaths = framePathsForEmbed.length ? framePathsForEmbed : [localPath];
            const blip = await describeFramesWithBlip(framePaths);
            blipCaption = blip.caption || "";
            blipCaptions = Array.isArray(blip.captions) ? blip.captions : [];
            if (blipCaption) {
              const visualTitle = buildSimpleSceneTitle({
                visualText: blipCaption,
                contextText: `${baseName} ${ocrText}`,
                fallback: ""
              });
              scene = visualTitle;
              summary = visualTitle || blipCaption;
              objects = extractKeywords(visualTitle || blipCaption, 8);
              tags = [...new Set([...tags, ...extractKeywords(blipCaption, 16), ...objects])].slice(0, 24);
            }
          } catch {
            // BLIP is optional; filename/OCR fallback stays available.
          }
        }

        if (openaiApiKey) {
          try {
            let mediaParts = [];

            if (kind === "image") {
              mediaParts = [await buildImagePartFromBuffer(file.buffer, mimetype || "image/jpeg")];
            } else {
              const frames = await extractFramePaths(localPath, tempDir);
              const imageParts = await Promise.all(
                frames.map(async (framePath) => {
                  const frame = await fs.readFile(framePath);
                  return buildImagePartFromBuffer(frame, "image/jpeg");
                })
              );
              mediaParts = imageParts;
            }

            const ai = await describeVisualWithOpenAI({ openaiApiKey, mediaParts, locale });
            summary = ai.summary;
            scene = ai.scene;
            objects = ai.objects;
            tags = [...new Set([...tags, ...ai.tags, ...ai.objects])].slice(0, 24);
          } catch {
            // Fallback to filename-based tags only.
          }
        }

        if (!summary && ocrText) {
          summary = `Text found in frames: ${ocrText.slice(0, 220)}`;
        } else if (!summary) {
          const simpleTitle = buildSimpleSceneTitle({
            visualText: ocrText,
            contextText: baseName,
            fallback: toReadableSceneTitle(baseName, `локальний ${kind === "image" ? "кадр" : "відеофрагмент"}`)
          });
          summary = simpleTitle;
          scene = scene || simpleTitle;
        }

        return {
          fileIndex: i,
          kind,
          filename: file.originalname,
          summary,
          scene,
          tags,
          objects,
          ocrText,
          blipCaption,
          blipCaptions,
          framePaths: framePathsForEmbed,
          analyzed: Boolean(summary || scene || objects.length || ocrText)
        };
      },
      ANALYZE_CONCURRENCY
    );

    const results = parallelAssets
      .filter(({ result, error }) => result && !error)
      .map(({ result }) => result);

    return res.json({ assets: results });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Помилка аналізу медіа" });
  }
  // NOTE: tempDir is kept on disk so /api/local/embed-match can reuse the
  // extracted frames. gcOldAnalyzeDirs() prunes dirs older than 30 minutes
  // on subsequent /api/local/analyze calls.
});

app.post("/api/context/theme", async (req, res) => {
  try {
    const { text = "", language = "uk", openaiApiKey } = req.body || {};
    const raw = String(text || "").trim();
    if (!raw) {
      return res.json({ theme: { id: "general", label: "General", tokens: [] }, source: "empty" });
    }

    const fallback = detectThemeFallback(raw);
    if (!openaiApiKey) {
      return res.json({ theme: fallback, source: "fallback" });
    }

    const prompt = [
      `Language hint: ${String(language || "uk")}` ,
      "Detect the MAIN content theme for this script.",
      "Return ONLY JSON object: {\"id\": string, \"label\": string, \"tokens\": string[]}",
      "Use stable ids like: true_crime, war, history, business, animals, education, technology, general.",
      `Script: ${raw.slice(0, 6000)}`
    ].join("\n");

    const content = await openAiChatJson({
      openaiApiKey,
      systemPrompt: "You are a topic classifier. Return valid JSON only.",
      userPrompt: prompt
    });

    const parsed = parseJsonObject(content) || {};
    const aiIdRaw = String(parsed.id || "").toLowerCase().replace(/[^a-z0-9_]/g, "");
    const stableAllowed = new Set(["true_crime", "war", "history", "business", "animals", "education", "technology", "general", "space", "lion_story"]);
    const id = stableAllowed.has(aiIdRaw) ? aiIdRaw : fallback.id;
    const label = String(parsed.label || fallback.label || id).trim();
    const tokens = Array.isArray(parsed.tokens)
      ? parsed.tokens.map((x) => String(x).toLowerCase().trim()).filter(Boolean).slice(0, 12)
      : fallback.tokens;
    const theme = {
      id: fallback.id === "lion_story" || fallback.id === "true_crime" || fallback.id === "space" ? fallback.id : id,
      label: fallback.id === "lion_story" || fallback.id === "true_crime" || fallback.id === "space" ? fallback.label : label,
      tokens: fallback.id === "lion_story" || fallback.id === "true_crime" || fallback.id === "space"
        ? [...new Set([...(fallback.tokens || []), ...tokens])].slice(0, 12)
        : tokens
    };
    return res.json({ theme, source: "ai+fallback" });
  } catch {
    const fallback = detectThemeFallback(req.body?.text || "");
    return res.json({ theme: fallback, source: "fallback-error" });
  }
});

app.post("/api/context/query-batch", async (req, res) => {
  try {
    const { segments = [], language = "uk", focusLanguage = "uk", openaiApiKey, globalContext = "", themeId = "general", themeTokens = [] } = req.body || {};
    if (!Array.isArray(segments) || !segments.length) {
      return res.status(400).json({ error: "Сегменти не передано" });
    }

    const fallback = segments.map((seg, idx) => {
      const query = extractKeywords(seg.text || "", 5).join(" ") || String(seg.text || "").split(/\s+/).slice(0, 6).join(" ");
      return { id: Number(seg.id ?? idx), query: String(query || "").trim() };
    });

    if (!openaiApiKey) {
      return res.json({ queries: fallback, source: "fallback" });
    }

    const compactSegments = segments.map((seg, idx) => ({
      id: Number(seg.id ?? idx),
      text: String(seg.text || "").trim(),
      keywords: Array.isArray(seg.keywords) ? seg.keywords.slice(0, 8) : []
    }));

    const prompt = [
      `Language hint: ${String(language || "uk")}`,
      `Segment focus language: ${String(focusLanguage || "uk")}`,
      "Build one SHORT stock-media search query per segment. Focus on visual scene, objects and actions.",
      "Prefer English terms for stock platforms (Pexels style).",
      "Output ONLY JSON array: [{\"id\": number, \"query\": string}]",
      `Global theme: ${String(themeId || "general")} | tokens: ${Array.isArray(themeTokens) ? themeTokens.join(", ") : ""}`,
      `Global context of the whole video: ${String(globalContext || "").slice(0, 3000)}`,
      `Segments: ${JSON.stringify(compactSegments)}`
    ].join("\n");

    const content = await openAiChatJson({
      openaiApiKey,
      systemPrompt: "You generate concise visual search queries. Return valid JSON only.",
      userPrompt: prompt
    });

    const parsed = parseJsonArray(content);
    if (!parsed?.length) {
      return res.json({ queries: fallback, source: "fallback" });
    }

    const byId = new Map(parsed.map((row) => [Number(row?.id), String(row?.query || "").trim()]));
    const queries = compactSegments.map((seg) => ({
      id: seg.id,
      query: byId.get(seg.id) || fallback.find((x) => x.id === seg.id)?.query || seg.text.slice(0, 48)
    }));

    return res.json({ queries, source: "ai" });
  } catch (error) {
    const segmentsSafe = Array.isArray(req.body?.segments) ? req.body.segments : [];
    const fallback = segmentsSafe.map((seg, idx) => {
      const query = extractKeywords(seg?.text || "", 5).join(" ") || String(seg?.text || "").split(/\s+/).slice(0, 6).join(" ");
      return { id: Number(seg?.id ?? idx), query: String(query || "").trim() };
    });
    return res.json({ queries: fallback, source: "fallback-error" });
  }
});

app.post("/api/context/focus-batch", async (req, res) => {
  try {
    const { segments = [], language = "uk", focusLanguage = "uk", openaiApiKey, globalContext = "" } = req.body || {};
    if (!Array.isArray(segments) || !segments.length) {
      return res.status(400).json({ error: "Сегменти не передано" });
    }

    const compactSegments = segments.map((seg, idx) => ({
      id: Number(seg.id ?? idx),
      text: String(seg.text || "").trim()
    }));

    if (!openaiApiKey) {
      return res.json({
        focuses: fallbackFocusHints(compactSegments).map((row) => ({
          ...row,
          focus: normalizeFocusLanguage(row.focus, focusLanguage)
        })),
        source: "fallback"
      });
    }

    const prompt = [
      `Language hint: ${String(language || "uk")}`,
      `Output focus language: ${String(focusLanguage || "uk")}`,
      "Build one short semantic focus line per segment.",
      "The focus must be one clear visual/narrative idea, not just comma keywords.",
      "Keep narrative continuity and resolve pronouns from context (e.g., who is 'she/he').",
      "Output ONLY JSON array: [{\"id\": number, \"focus\": string}]",
      `Global context: ${String(globalContext || "").slice(0, 3000)}`,
      `Segments: ${JSON.stringify(compactSegments)}`
    ].join("\n");

    const content = await openAiChatJson({
      openaiApiKey,
      systemPrompt: "You are a precise narrative editor. Return valid JSON only.",
      userPrompt: prompt
    });

    const parsed = parseJsonArray(content);
    if (!parsed?.length) {
      return res.json({ focuses: fallbackFocusHints(compactSegments), source: "fallback" });
    }

    const byId = new Map(parsed.map((row) => [Number(row?.id), String(row?.focus || "").trim()]));
    const focuses = compactSegments.map((seg) => ({
      id: seg.id,
      focus: normalizeFocusLanguage(
        byId.get(seg.id) || (fallbackFocusHints([seg])[0]?.focus || seg.text.slice(0, 70)),
        focusLanguage
      )
    }));

    return res.json({ focuses, source: "ai" });
  } catch (error) {
    const compactSegments = Array.isArray(req.body?.segments)
      ? req.body.segments.map((seg, idx) => ({ id: Number(seg?.id ?? idx), text: String(seg?.text || "") }))
      : [];
    const focusLanguage = String(req.body?.focusLanguage || "uk");
    return res.json({
      focuses: fallbackFocusHints(compactSegments).map((row) => ({
        ...row,
        focus: normalizeFocusLanguage(row.focus, focusLanguage)
      })),
      source: "fallback-error"
    });
  }
});

// CLIP-embed match endpoint: takes segments + already-analyzed assets (with
// framePaths persisted from /api/local/analyze), returns score matrix.
app.post("/api/local/embed-match", async (req, res) => {
  // No browser timeout — heavy ML can take a while on cold model load.
  req.setTimeout(0);
  res.setTimeout(0);
  try {
    const { segments = [], assets = [] } = req.body || {};
    if (!Array.isArray(segments) || !segments.length) {
      return res.status(400).json({ ok: false, error: "Сегменти не передано" });
    }
    if (!Array.isArray(assets) || !assets.length) {
      return res.status(400).json({ ok: false, error: "Assets не передано" });
    }
    const compactSegments = segments.map((seg, idx) => ({
      id: String(seg.id ?? idx),
      text: String(seg.text || "").trim()
    })).filter((s) => s.text);

    const compactAssets = assets.map((a) => {
      const framePaths = Array.isArray(a.framePaths) ? a.framePaths.filter(Boolean).slice(0, 4) : [];
      const tagsText = Array.isArray(a.aiTags) ? a.aiTags.join(" ") : "";
      const text = [
        a.aiSummary,
        a.title,
        tagsText,
        a.aiOcr,
        a.scene
      ].map((x) => String(x || "").trim()).filter(Boolean).join(". ");
      return {
        fileIndex: Number(a.fileIndex),
        framePaths,
        text
      };
    }).filter((a) => Number.isFinite(a.fileIndex));

    if (!compactSegments.length || !compactAssets.length) {
      return res.json({ ok: true, scores: {}, diag: { reason: "empty after compaction" } });
    }

    const result = await runEmbedMatch({
      segments: compactSegments,
      assets: compactAssets,
      cacheDir: EMBED_CACHE_DIR
    }, { timeoutMs: 600000 });

    if (!result?.ok) {
      // Soft failure — frontend will fall back to token-only matching.
      return res.json({ ok: false, error: result?.error || "embed-match failed", scores: {} });
    }
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || "embed-match error" });
  }
});

app.post("/api/context/match-local", async (req, res) => {
  try {
    const { segments = [], assets = [], mediaType = "both", language = "uk", openaiApiKey, globalContext = "" } = req.body || {};
    if (!Array.isArray(segments) || !segments.length) {
      return res.status(400).json({ error: "Сегменти не передано" });
    }
    if (!Array.isArray(assets) || !assets.length) {
      return res.status(400).json({ error: "Assets не передано" });
    }
    const filteredAssets = assets.filter((asset) => {
      const kind = asset?.kind === "image" ? "image" : "video";
      if (mediaType === "both") return true;
      return kind === mediaType;
    });

    if (!filteredAssets.length) {
      return res.json({ matches: [], source: "fallback" });
    }

    const compactSegments = segments.map((seg, idx) => ({
      id: Number(seg.id ?? idx),
      text: String(seg.text || "").trim(),
      keywords: Array.isArray(seg.keywords) ? seg.keywords.slice(0, 10) : []
    }));

    const compactAssets = filteredAssets.map((asset) => ({
      fileIndex: Number(asset.fileIndex),
      kind: asset.kind === "image" ? "image" : "video",
      title: String(asset.title || asset.filename || ""),
      summary: String(asset.summary || asset.aiSummary || ""),
      ocrText: String(asset.ocrText || asset.aiOcr || "").slice(0, 240),
      scene: String(asset.scene || ""),
      tags: Array.isArray(asset.tags) ? asset.tags.slice(0, 20) : []
    }));

    if (!openaiApiKey) {
      return res.json({
        matches: fallbackMatchLocalAssets({ segments: compactSegments, assets: compactAssets, mediaType }),
        source: "fallback-local"
      });
    }

    const prompt = [
      `Language hint: ${String(language || "uk")}`,
      "Task: match every segment to the best visual asset by meaning.",
      "Try to vary assets so the same file is not repeated too often.",
      "Output ONLY JSON array: [{\"segmentId\": number, \"fileIndex\": number, \"reason\": string}]",
      `Global context of the whole video: ${String(globalContext || "").slice(0, 3000)}`,
      `Segments: ${JSON.stringify(compactSegments)}`,
      `Assets: ${JSON.stringify(compactAssets)}`
    ].join("\n");

    const content = await openAiChatJson({
      openaiApiKey,
      systemPrompt: "You are a precise video editor assistant. Return valid JSON only.",
      userPrompt: prompt
    });

    const parsed = parseJsonArray(content);
    if (!parsed?.length) {
      return res.json({ matches: [], source: "ai" });
    }

    const validIndexes = new Set(compactAssets.map((a) => a.fileIndex));
    const bySegmentId = new Map();

    for (const row of parsed) {
      const segmentId = Number(row?.segmentId);
      const fileIndex = Number(row?.fileIndex);
      if (!Number.isFinite(segmentId) || !Number.isFinite(fileIndex)) continue;
      if (!validIndexes.has(fileIndex)) continue;
      if (bySegmentId.has(segmentId)) continue;
      bySegmentId.set(segmentId, {
        segmentId,
        fileIndex,
        reason: String(row?.reason || "").slice(0, 220)
      });
    }

    const matches = compactSegments
      .map((seg) => bySegmentId.get(seg.id))
      .filter(Boolean);

    return res.json({ matches, source: "ai" });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Помилка AI-матчингу локального контенту" });
  }
});

app.post("/api/stock/verify-asset", async (req, res) => {
  const tempDir = path.join(os.tmpdir(), `vss_verify_${randomUUID()}`);
  try {
    const {
      asset = {},
      segmentText = "",
      segmentFocus = "",
      globalContext = "",
      verifyMode = "api",
      openaiApiKey,
      language = "uk"
    } = req.body || {};

    const mode = String(verifyMode || "api").toLowerCase();
    const key = openaiApiKey || process.env.OPENAI_API_KEY;
    if (mode === "api" && !key) return res.status(400).json({ error: "Потрібен OpenAI API key" });
    if (!asset?.previewUrl) return res.status(400).json({ error: "Asset URL відсутній" });

    await fs.mkdir(tempDir, { recursive: true });

    const kind = asset.kind === "image" ? "image" : "video";
    const response = await fetchWithTimeout(String(asset.previewUrl), {}, 12000);
    if (!response.ok) {
      return res.status(400).json({ error: `Не вдалося завантажити asset (${response.status})` });
    }
    const content = Buffer.from(await response.arrayBuffer());

    const expected = `${segmentText}. ${segmentFocus}. ${globalContext}`.trim();

    if (mode === "cv") {
      const ext = kind === "image"
        ? (pickExtFromUrl(String(asset.previewUrl)) || ".jpg")
        : (pickExtFromUrl(String(asset.previewUrl)) || ".mp4");
      const mediaPath = path.join(tempDir, `stock_candidate${ext}`);
      await fs.writeFile(mediaPath, content);

      const title = String(asset.title || "");
      const tags = Array.isArray(asset.tags) ? asset.tags.map((x) => String(x || "")) : [];
      const deep = await analyzeStockAssetCvDeep({
        kind,
        mediaPath,
        title,
        tags,
        expected,
        tempDir
      });

      return res.json({
        ok: true,
        mode: "cv_deep",
        score: deep.score,
        suitable: deep.suitable,
        analysis: deep.analysis
      });
    }

    let mediaParts = [];
    if (kind === "image") {
      mediaParts = [await buildImagePartFromBuffer(content, "image/jpeg")];
    } else {
      const ext = pickExtFromUrl(String(asset.previewUrl)) || ".mp4";
      const videoPath = path.join(tempDir, `stock_candidate${ext}`);
      await fs.writeFile(videoPath, content);
      const frames = await extractFramePaths(videoPath, tempDir);
      mediaParts = await Promise.all(
        frames.slice(0, 2).map(async (framePath) => {
          const frame = await fs.readFile(framePath);
          return buildImagePartFromBuffer(frame, "image/jpeg");
        })
      );
    }

    const ai = await describeVisualWithOpenAI({
      openaiApiKey: key,
      mediaParts,
      locale: String(language || "uk")
    });

    const actual = `${ai.summary} ${ai.scene} ${(ai.tags || []).join(" ")} ${(ai.objects || []).join(" ")}`.trim();
    const overlap = scoreTextOverlap(expected, actual);
    const score = Math.round(overlap * 100);

    return res.json({
      ok: true,
      mode: "api",
      score,
      suitable: score >= 18,
      analysis: {
        summary: ai.summary,
        scene: ai.scene,
        tags: ai.tags || [],
        objects: ai.objects || []
      }
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Помилка Vision-перевірки" });
  } finally {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

app.post("/api/stock/search", async (req, res) => {
  try {
    const {
      query,
      mediaType = "both",
      providers = ["pexels"],
      pexelsApiKey,
      pixabayApiKey,
      unsplashAccessKey,
      perPage = 8,
      language = "en"
    } = req.body || {};

    if (!query || String(query).trim().length < 2) {
      return res.status(400).json({ error: "Порожній запит" });
    }

    const qRaw = String(query).trim();
    const q = encodeURIComponent(qRaw);
    const limit = Math.max(1, Math.min(30, Number(perPage) || 8));
    const doVideos = mediaType === "video" || mediaType === "both";
    const doImages = mediaType === "image" || mediaType === "both";

    const requestedProviders = Array.isArray(providers)
      ? providers
      : (typeof providers === "string" ? [providers] : ["pexels"]);

    const normalizedProviders = [...new Set(requestedProviders
      .map((x) => String(x || "").toLowerCase().trim())
      .filter((x) => ["pexels", "pixabay", "unsplash"].includes(x)))];

    const activeProviders = normalizedProviders.length ? normalizedProviders : ["pexels"];
    const tasks = [];

    if (activeProviders.includes("pexels") && pexelsApiKey) {
      const headers = { Authorization: pexelsApiKey };

      if (doVideos) {
        const cacheKey = `pexels|video|${qRaw.toLowerCase()}|${limit}`;
        const cached = getStockCache(cacheKey);
        if (cached) {
          tasks.push(Promise.resolve(cached));
        } else {
          tasks.push(
            fetchWithTimeout(`https://api.pexels.com/videos/search?query=${q}&per_page=${limit}`, { headers }, 10000)
              .then(async (r) => (r.ok ? r.json() : { videos: [] }))
              .then((payload) => {
                const assets = [];
                for (const v of payload.videos || []) {
                  const file =
                    (v.video_files || []).find((f) => f.quality === "hd" && f.width >= 1280) ||
                    (v.video_files || []).find((f) => f.quality === "sd") ||
                    (v.video_files || [])[0];
                  if (!file?.link) continue;

                  const title = String(v.url || `Pexels video ${v.id}`);
                  assets.push({
                    kind: "video",
                    source: "pexels",
                    title,
                    previewUrl: file.link,
                    thumbUrl: v.image,
                    duration: v.duration || 0,
                    tags: extractKeywords(title, 10)
                  });
                }
                setStockCache(cacheKey, assets);
                return assets;
              })
          );
        }
      }

      if (doImages) {
        const cacheKey = `pexels|image|${qRaw.toLowerCase()}|${limit}`;
        const cached = getStockCache(cacheKey);
        if (cached) {
          tasks.push(Promise.resolve(cached));
        } else {
          tasks.push(
            fetchWithTimeout(`https://api.pexels.com/v1/search?query=${q}&per_page=${limit}`, { headers }, 10000)
              .then(async (r) => (r.ok ? r.json() : { photos: [] }))
              .then((payload) => {
                const assets = [];
                for (const p of payload.photos || []) {
                  const title = String(p.alt || `Pexels photo ${p.id}`);
                  assets.push({
                    kind: "image",
                    source: "pexels",
                    title,
                    previewUrl: p.src?.large || p.src?.original,
                    thumbUrl: p.src?.medium || p.src?.small,
                    duration: 0,
                    tags: extractKeywords(title, 10)
                  });
                }
                setStockCache(cacheKey, assets);
                return assets;
              })
          );
        }
      }
    }

    if (activeProviders.includes("pixabay") && pixabayApiKey) {
      if (doVideos) {
        const cacheKey = `pixabay|video|${qRaw.toLowerCase()}|${limit}`;
        const cached = getStockCache(cacheKey);
        if (cached) {
          tasks.push(Promise.resolve(cached));
        } else {
          tasks.push(
            fetchWithTimeout(`https://pixabay.com/api/videos/?key=${encodeURIComponent(pixabayApiKey)}&q=${q}&per_page=${limit}&safesearch=true&order=popular`, {}, 10000)
              .then(async (r) => (r.ok ? r.json() : { hits: [] }))
              .then((payload) => {
                const assets = [];
                for (const hit of payload.hits || []) {
                  const videos = hit.videos || {};
                  const file = videos.large || videos.medium || videos.small || videos.tiny;
                  if (!file?.url) continue;

                  const title = String(hit.tags || `Pixabay video ${hit.id}`);
                  assets.push({
                    kind: "video",
                    source: "pixabay",
                    title,
                    previewUrl: file.url,
                    thumbUrl: file.thumbnail || hit.videos?.tiny?.thumbnail || "",
                    duration: Number(hit.duration || 0),
                    tags: extractKeywords(title, 12)
                  });
                }
                setStockCache(cacheKey, assets);
                return assets;
              })
          );
        }
      }

      if (doImages) {
        const cacheKey = `pixabay|image|${qRaw.toLowerCase()}|${limit}|${String(language || "en").toLowerCase()}`;
        const cached = getStockCache(cacheKey);
        if (cached) {
          tasks.push(Promise.resolve(cached));
        } else {
          const lang = encodeURIComponent(String(language || "en").slice(0, 2));
          tasks.push(
            fetchWithTimeout(`https://pixabay.com/api/?key=${encodeURIComponent(pixabayApiKey)}&q=${q}&image_type=photo&per_page=${limit}&safesearch=true&order=popular&lang=${lang}`, {}, 10000)
              .then(async (r) => (r.ok ? r.json() : { hits: [] }))
              .then((payload) => {
                const assets = [];
                for (const hit of payload.hits || []) {
                  const title = String(hit.tags || `Pixabay photo ${hit.id}`);
                  assets.push({
                    kind: "image",
                    source: "pixabay",
                    title,
                    previewUrl: hit.largeImageURL || hit.webformatURL || hit.previewURL,
                    thumbUrl: hit.webformatURL || hit.previewURL || "",
                    duration: 0,
                    tags: extractKeywords(title, 12)
                  });
                }
                setStockCache(cacheKey, assets);
                return assets;
              })
          );
        }
      }
    }

    if (activeProviders.includes("unsplash") && unsplashAccessKey && doImages) {
      const cacheKey = `unsplash|image|${qRaw.toLowerCase()}|${limit}`;
      const cached = getStockCache(cacheKey);
      if (cached) {
        tasks.push(Promise.resolve(cached));
      } else {
        tasks.push(
          fetchWithTimeout(`https://api.unsplash.com/search/photos?query=${q}&per_page=${limit}&orientation=landscape`, {
            headers: { Authorization: `Client-ID ${unsplashAccessKey}` }
          }, 10000)
            .then(async (r) => (r.ok ? r.json() : { results: [] }))
            .then((payload) => {
              const assets = [];
              for (const p of payload.results || []) {
                const title = String(p.alt_description || p.description || `Unsplash photo ${p.id}`);
                const tagBag = [
                  ...(Array.isArray(p.tags) ? p.tags.map((t) => t?.title || "") : []),
                  ...extractKeywords(title, 10)
                ].filter(Boolean);
                assets.push({
                  kind: "image",
                  source: "unsplash",
                  title,
                  previewUrl: p.urls?.regular || p.urls?.full || p.urls?.small,
                  thumbUrl: p.urls?.small || p.urls?.thumb,
                  duration: 0,
                  tags: [...new Set(tagBag)].slice(0, 12)
                });
              }
              setStockCache(cacheKey, assets);
              return assets;
            })
        );
      }
    }

    if (!tasks.length) {
      return res.status(400).json({ error: "Немає активних провайдерів або API ключів для вибраного типу контенту" });
    }

    const settled = await Promise.allSettled(tasks);
    const assets = settled
      .filter((x) => x.status === "fulfilled")
      .flatMap((x) => x.value || [])
      .filter((a) => a?.previewUrl);

    const unique = [];
    const seen = new Set();
    for (const asset of assets) {
      const key = `${asset.kind}|${asset.previewUrl}`;
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(asset);
    }

    return res.json({ assets: unique });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Помилка пошуку на стоках" });
  }
});

app.post("/api/image/generate", async (req, res) => {
  try {
    const { prompt = "", openaiApiKey, size = "1024x1024" } = req.body || {};
    const key = openaiApiKey || process.env.OPENAI_API_KEY;
    if (!key) return res.status(400).json({ error: "Потрібен OpenAI API key" });
    if (String(prompt).trim().length < 3) return res.status(400).json({ error: "Порожній prompt" });

    const response = await fetchWithTimeout("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`
      },
      body: JSON.stringify({
        model: "gpt-image-1",
        prompt: String(prompt).slice(0, 1200),
        size,
        quality: "medium"
      })
    }, 30000);

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      return res.status(response.status).json({ error: payload?.error?.message || "Помилка генерації зображення" });
    }

    const b64 = payload?.data?.[0]?.b64_json;
    if (!b64) return res.status(500).json({ error: "OpenAI не повернув зображення" });

    const imageBuffer = Buffer.from(b64, "base64");
    const filename = `generated_${Date.now()}_${randomUUID().slice(0, 8)}.png`;
    const outputPath = path.join(OUTPUT_DIR, filename);
    await fs.writeFile(outputPath, imageBuffer);

    return res.json({
      ok: true,
      asset: {
        kind: "image",
        source: "generated",
        title: "Generated image",
        previewUrl: `/outputs/${filename}`,
        tags: extractKeywords(prompt, 12)
      }
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Помилка генерації зображення" });
  }
});

async function buildMontageInternal({ audio, timelineRaw, localFiles, montageSettingsRaw, onProgress }) {
  // Deterministic tempDir keyed on all inputs that affect output. If a previous
  // render with identical inputs crashed mid-build, the surviving clip_NNNN.mp4
  // files are reused on retry — no rebuild from scratch.
  const renderId = computeRenderId({ audio, timelineRaw, montageSettingsRaw, localFiles });
  const tempDir = path.join(os.tmpdir(), `vss_render_${renderId}`);
  await fs.mkdir(tempDir, { recursive: true });
  // Lazy GC of old render dirs (>24h) — fire-and-forget, never blocks.
  gcOldRenderDirs().catch(() => {});

  let renderSucceeded = false;
  try {
    await ensureFfmpegAvailable();
    await detectVideoEncoder();
    const timeline = ensureTimeline(timelineRaw);
    onProgress?.(4, "Підготовка таймлайна...");

    const audioExt = path.extname(audio.originalname || "").toLowerCase() || ".mp3";
    const audioPath = path.join(tempDir, `voice${audioExt}`);
    await fs.writeFile(audioPath, audio.buffer);
    const audioDuration = await probeMediaDuration(audioPath).catch(() => 0);

    const montageSettings = parseMontageSettings(montageSettingsRaw);
    const transitionDuration = montageSettings.transitionDuration;
    const timelineWithDurationFix = timeline.map((x) => ({ ...x }));
    const visualDuration = timelineWithDurationFix.reduce((sum, x) => sum + Number(x.duration || 0), 0);
    const overlapTotal = Math.max(0, timelineWithDurationFix.length - 1) * transitionDuration;
    const effectiveVisualDuration = Math.max(0.1, visualDuration - overlapTotal);
    if (audioDuration > 0.2 && effectiveVisualDuration + 0.2 < audioDuration && timelineWithDurationFix.length) {
      const extra = audioDuration - effectiveVisualDuration;
      timelineWithDurationFix[timelineWithDurationFix.length - 1].duration += extra;
    }
    const renderTimeline = buildProfInsertTimeline(timelineWithDurationFix, montageSettings);

    // Pre-flight stock URL check: HEAD-probe everything in parallel before
    // we burn CPU on FFmpeg. Fails fast with a concrete list instead of
    // crashing 90% into the render.
    onProgress?.(5, "Перевірка стокових ресурсів...");
    const preflight = await preflightStockAssets(renderTimeline);
    if (!preflight.ok) {
      const sample = preflight.failures.slice(0, 3)
        .map((f) => `${f.status || "net"} → ${String(f.url).slice(0, 80)}`)
        .join("\n");
      const more = preflight.failures.length > 3 ? `\n…і ще ${preflight.failures.length - 3}` : "";
      throw new Error(
        `${preflight.failures.length} стокових ресурс(ів) недоступні. Перепідбери їх у попередньому кроці.\n${sample}${more}`
      );
    }

    const assetCache = new Map();
    // Assign split-screen second sources from local files (random, different from current asset).
    if (localFiles?.length) {
      const localIndices = localFiles.map((_, idx) => idx);
      for (const item of renderTimeline) {
        if (item.overlayInsert?.layout === "split-screen") {
          const currentIdx = Number(item.asset?.fileIndex ?? -1);
          const candidates = localIndices.filter((idx) => idx !== currentIdx);
          const pool = candidates.length ? candidates : localIndices;
          item.overlayInsert.splitSourceIndex = pool[Math.floor(Math.random() * pool.length)];
        }
      }
    }

    const clipErrors = [];
    const total = renderTimeline.length;
    let doneCount = 0;

    const parallelResults = await parallelMap(
      renderTimeline,
      async (item, i) => {
        const clipPath = path.join(tempDir, `clip_${String(i).padStart(4, "0")}.mp4`);

        // Resume-from-cache: if a previous run already built this clip and
        // tempDir survived (deterministic renderId means it does), reuse it.
        // Empty/zero-byte files indicate a partial write — rebuild those.
        try {
          const stat = await fs.stat(clipPath);
          if (stat.size > 1024) {
            doneCount += 1;
            onProgress?.(8 + Math.floor((doneCount / Math.max(1, total)) * 78), `Рендер кліпів ${doneCount}/${total} (з кешу)`);
            return clipPath;
          }
        } catch { /* file doesn't exist — proceed to build */ }

        if (item?.asset?.kind === "insert") {
          await buildProfInsertClip({
            type: item.asset.source,
            layout: item.asset.layout,
            text: item.text,
            duration: item.duration,
            outputPath: clipPath,
            tempDir
          });
        } else {
          const sourcePath = await materializeAsset({ item, localFiles, tempDir, assetCache });
          let secondSourcePath = null;
          if (item.overlayInsert?.layout === "split-screen" && item.overlayInsert.splitSourceIndex != null) {
            try {
              secondSourcePath = await materializeAsset({
                item: { asset: { source: "local", fileIndex: item.overlayInsert.splitSourceIndex } },
                localFiles,
                tempDir,
                assetCache
              });
            } catch { secondSourcePath = null; }
          }
          await buildClip({
            sourcePath,
            isImage: item.asset.kind === "image",
            duration: item.duration,
            outputPath: clipPath,
            montageSettings,
            overlayInsert: item.overlayInsert || null,
            tempDir,
            secondSourcePath
          });
        }
        doneCount += 1;
        onProgress?.(8 + Math.floor((doneCount / Math.max(1, total)) * 78), `Рендер кліпів ${doneCount}/${total}`);
        return clipPath;
      },
      CLIP_CONCURRENCY
    );

    // Collect ordered clip paths; fall back to placeholder on per-clip errors.
    const clipPaths = [];
    for (let i = 0; i < parallelResults.length; i += 1) {
      const { result, error } = parallelResults[i];
      const item = renderTimeline[i];
      const clipPath = path.join(tempDir, `clip_${String(i).padStart(4, "0")}.mp4`);
      if (!error) {
        clipPaths.push(result);
      } else {
        clipErrors.push({
          index: i,
          kind: item?.asset?.kind || "unknown",
          source: item?.asset?.source || "unknown",
          message: String(error?.message || "clip build failed").slice(0, 220)
        });
        // Keep timeline length stable even when stock asset is broken/unreachable.
        try {
          await buildPlaceholderClip({ duration: item.duration, outputPath: clipPath });
          clipPaths.push(clipPath);
        } catch (placeholderError) {
          clipErrors.push({
            index: i,
            kind: "placeholder",
            source: "system",
            message: String(placeholderError?.message || "placeholder build failed").slice(0, 220)
          });
        }
      }
    }

    if (!clipPaths.length) {
      const detail = clipErrors.slice(0, 3).map((x) => `#${x.index} ${x.kind}/${x.source}: ${x.message}`).join(" | ");
      throw new Error(`Немає кліпів для монтажу. ${detail || "Всі джерела недоступні або ffmpeg не працює."}`);
    }

    const timelineVideoPath = path.join(tempDir, "timeline_with_transitions.mp4");
    const tooManyClipsForXfade = clipPaths.length > 90;
    const transitionDisabled = transitionDuration < 0.1;
    let usedTransitions = false;
    onProgress?.(90, "Фінальна склейка...");

    if (!tooManyClipsForXfade && !transitionDisabled) {
      try {
        await buildTimelineWithTransitions({
          clipPaths,
          clipDurations: renderTimeline.map((x) => x.duration),
          transitionDuration,
          montageSettings,
          outputPath: timelineVideoPath
        });
        usedTransitions = true;
      } catch {
        await buildTimelineByConcat({
          clipPaths,
          outputPath: timelineVideoPath,
          tempDir
        });
      }
    } else {
      await buildTimelineByConcat({
        clipPaths,
        outputPath: timelineVideoPath,
        tempDir
      });
    }

    const finalName = `montage_${Date.now()}.mp4`;
    const finalPath = path.join(OUTPUT_DIR, finalName);

    const srtPath = path.join(tempDir, "subtitles.srt");
    const hasSubtitles = montageSettings.subtitlesEnabled
      ? await writeSrtFromTimeline(timelineWithDurationFix, srtPath)
      : false;

    // ─── SFX track: synth-based audio cues mixed with narration ─────────────
    // collectSfxEvents needs renderTimeline (which has overlayInsert on each item),
    // not timelineWithDurationFix (which has none — buildProfInsertTimeline copies).
    const sfxTrackPath = path.join(tempDir, "sfx_track.aac");
    let hasSfx = false;
    if (montageSettings.sfxEnabled) {
      try {
        const sfxEvents = collectSfxEvents(renderTimeline, montageSettings);
        const sfxDur = (audioDuration > 0 ? audioDuration : visualDuration);
        if (sfxEvents.length) {
          // Scale overall SFX volume by detected narrative mood:
          // thriller/news → louder (more impact), personal → quieter.
          const moodAnalysis = analyzeTranscriptMood(renderTimeline);
          const moodGainMultiplier =
            moodAnalysis.genre === "thriller"      ? 1.25 :
            moodAnalysis.genre === "news"          ? 1.15 :
            moodAnalysis.genre === "investigation" ? 1.10 :
            moodAnalysis.genre === "personal"      ? 0.70 : 1.0;
          hasSfx = await buildSfxTrack({
            events: sfxEvents,
            totalDuration: sfxDur,
            outputPath: sfxTrackPath,
            sfxVolume: Number(montageSettings.sfxVolume || 0.85) * moodGainMultiplier
          });
        }
      } catch (sfxError) {
        // SFX is a polish layer — never fail the whole render because of it.
        hasSfx = false;
      }
    }

    const ffmpegArgs = [
      "-y",
      "-i", timelineVideoPath,
      "-i", audioPath,
      ...(hasSfx ? ["-i", sfxTrackPath] : [])
    ];

    // Audio production chain — applied to the final mix:
    //   1. Pre-amp SFX so it's audibly present during silences.
    //   2. Sidechain-compress SFX using voice as trigger → SFX ducks ~9dB
    //      when narration is loud, full volume during pauses. Threshold is
    //      tuned to "loud speech" (-12dB), not "any signal" — prevents
    //      constant ducking that masks SFX entirely.
    //   3. Mix voice + ducked-SFX.
    //   4. EBU R128 / ITU-R BS.1770 loudness normalization to I=-16 LUFS,
    //      true peak -1.5dB — YouTube/podcast standard.
    const SFX_PREAMP = 2.2;  // bring SFX up; ducking will tame it during voice
    const DUCK_PARAMS = "threshold=0.18:ratio=4:attack=20:release=400:makeup=1:level_sc=1";
    const LOUDNORM = "loudnorm=I=-16:TP=-1.5:LRA=11";
    const audioChainWithSfx =
      `[2:a]volume=${SFX_PREAMP}[sfxraw];` +
      `[1:a]asplit=2[v1][v2];` +
      `[sfxraw][v1]sidechaincompress=${DUCK_PARAMS}[sfxd];` +
      `[v2][sfxd]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[premix];` +
      `[premix]${LOUDNORM}[aout]`;

    // Build video+audio filter args. -vf and -filter_complex conflict when both
    // are needed: -map 0:v:0 bypasses a -vf subtitles filter. Fix: fold subtitles
    // into the filter_complex graph so all mappings stay consistent.
    if (hasSubtitles) {
      const escapedSrtPath = srtPath
        .replace(/\\/g, "/")
        .replace(/:/g, "\\:")
        .replace(/'/g, "\\'");
      const subsFilter = `subtitles='${escapedSrtPath}':force_style='FontName=Avenir Next Condensed,FontSize=26,Bold=1,Alignment=2,MarginV=42,PrimaryColour=&H00F8FAFC,OutlineColour=&HC0000000,BackColour=&H88000000,BorderStyle=3,Outline=2,Shadow=1'`;
      if (hasSfx) {
        // Both subtitles and SFX: fold everything into one filter_complex.
        ffmpegArgs.push(
          "-filter_complex", `[0:v]${subsFilter}[vout];${audioChainWithSfx}`,
          "-map", "[vout]",
          "-map", "[aout]"
        );
      } else {
        // Subtitles only: -vf for video, -af loudnorm for stable loudness.
        ffmpegArgs.push(
          "-vf", subsFilter,
          "-map", "0:v:0",
          "-map", "1:a:0",
          "-af", LOUDNORM
        );
      }
    } else if (hasSfx) {
      // SFX only, no subtitles: filter_complex for audio (duck + loudnorm), raw video.
      ffmpegArgs.push(
        "-filter_complex", audioChainWithSfx,
        "-map", "0:v:0",
        "-map", "[aout]"
      );
    } else {
      // Neither subtitles nor SFX: still loudnorm voice for consistent output level.
      ffmpegArgs.push(
        "-map", "0:v:0",
        "-map", "1:a:0",
        "-af", LOUDNORM
      );
    }
    ffmpegArgs.push(
      ...videoCodecArgs(),
      "-c:a", "aac",
      "-b:a", "192k",
      "-movflags", "+faststart",
      "-t", String(audioDuration > 0 ? audioDuration : visualDuration),
      finalPath
    );
    let finalRenderError = null;
    try {
      await runFfmpeg(ffmpegArgs);
    } catch (error) {
      finalRenderError = error;
    }

    if (finalRenderError) {
      // Fallback 1: retry without hard subtitles filter.
      const noSubsArgs = [
        "-y",
        "-i", timelineVideoPath,
        "-i", audioPath,
        "-map", "0:v:0",
        "-map", "1:a:0",
        ...videoCodecArgs(),
        "-c:a", "aac",
        "-b:a", "192k",
        "-movflags", "+faststart",
        "-shortest",
        "-t", String(audioDuration > 0 ? audioDuration : visualDuration),
        finalPath
      ];
      try {
        await runFfmpeg(noSubsArgs);
        finalRenderError = null;
      } catch (error) {
        finalRenderError = error;
      }
    }

    if (finalRenderError) {
      // Fallback 2: safe normalize pass before encode.
      const safeArgs = [
        "-y",
        "-i", timelineVideoPath,
        "-i", audioPath,
        "-filter_complex", "[0:v]fps=30,scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,format=yuv420p[v]",
        "-map", "[v]",
        "-map", "1:a:0",
        ...videoCodecArgs(),
        "-c:a", "aac",
        "-b:a", "192k",
        "-movflags", "+faststart",
        "-shortest",
        "-t", String(audioDuration > 0 ? audioDuration : visualDuration),
        finalPath
      ];
      await runFfmpeg(safeArgs);
    }

    const doneMessage = usedTransitions
      ? "Готово (з переходами)"
      : "Готово (safe mode без переходів)";
    onProgress?.(100, doneMessage);
    renderSucceeded = true;
    return {
      ok: true,
      url: `/outputs/${finalName}`,
      filename: finalName
    };
  } finally {
    // Only clean up on success. On failure, tempDir survives so the next
    // run with identical inputs can resume from the last good clip.
    // gcOldRenderDirs() prunes failed dirs older than 24h on subsequent runs.
    if (renderSucceeded) {
      try {
        await fs.rm(tempDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup error
      }
    }
  }
}

app.post(
  "/api/montage",
  upload.fields([
    { name: "audio", maxCount: 1 },
    { name: "localAssets", maxCount: 1000 }
  ]),
  async (req, res) => {
    try {
      const audio = req.files?.audio?.[0];
      if (!audio) return res.status(400).json({ error: "Аудіофайл не передано" });

      const localFiles = req.files?.localAssets || [];
      const result = await buildMontageInternal({
        audio,
        timelineRaw: req.body.timeline,
        localFiles,
        montageSettingsRaw: req.body.montageSettings
      });
      return res.json(result);
    } catch (error) {
      return res.status(500).json({ error: error.message || "Помилка монтажу" });
    }
  }
);

app.post(
  "/api/montage/stream",
  upload.fields([
    { name: "audio", maxCount: 1 },
    { name: "localAssets", maxCount: 1000 }
  ]),
  async (req, res) => {
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");

    const send = (payload) => res.write(`${JSON.stringify(payload)}\n`);

    try {
      const audio = req.files?.audio?.[0];
      if (!audio) {
        send({ type: "error", error: "Аудіофайл не передано" });
        res.end();
        return;
      }

      const localFiles = req.files?.localAssets || [];
      const result = await buildMontageInternal({
        audio,
        timelineRaw: req.body.timeline,
        localFiles,
        montageSettingsRaw: req.body.montageSettings,
        onProgress: (percent, message) => send({ type: "progress", percent, message })
      });
      send({ type: "done", ...result });
      res.end();
    } catch (error) {
      send({ type: "error", error: error.message || "Помилка монтажу" });
      res.end();
    }
  }
);

app.post(
  "/api/cutter/run",
  cutterUpload.fields([
    { name: "videoFile", maxCount: 1 }
  ]),
  async (req, res) => {
    // BLIP can take many minutes per call on slow machines / Python 3.14
    // without Metal. Make sure Node never times out the cutter request itself.
    req.setTimeout(0);
    res.setTimeout(0);
    const tempDir = path.join(os.tmpdir(), `vss_cutter_${randomUUID()}`);
    const uploadedPaths = [];
    try {
      await ensureFfmpegAvailable();
      await fs.mkdir(tempDir, { recursive: true });

      const youtubeUrl = String(req.body.youtubeUrl || "").trim();
      const uploaded = req.files?.videoFile?.[0] || null;
      if (!youtubeUrl && !uploaded) {
        return res.status(400).json({ error: "Додай YouTube-посилання або локальний відеофайл" });
      }

      const segmentSeconds = Math.max(2, Math.min(120, Number(req.body.segmentSeconds || 8) || 8));
      const namingMode = String(req.body.namingMode || "auto").trim().toLowerCase() === "time" ? "time" : "auto";
      const projectLabelRaw = String(req.body.projectLabel || "").trim();
      const captionMode = String(req.body.captionMode || "blip").trim().toLowerCase();
      const cutterConcurrency = resolveCutterConcurrency(captionMode, req.body.cutterThreads);

      const useLocalFile = Boolean(uploaded);
      let sourceVideoPath = "";
      let sourceTitle = projectLabelRaw || "video";

      if (useLocalFile) {
        if (uploaded.path) {
          sourceVideoPath = uploaded.path;
          uploadedPaths.push(uploaded.path);
        } else {
          const ext = safeExtFromName(uploaded.originalname, ".mp4");
          sourceVideoPath = path.join(tempDir, `source${ext}`);
          await fs.writeFile(sourceVideoPath, uploaded.buffer);
        }
        if (!projectLabelRaw) {
          sourceTitle = String(uploaded.originalname || "video").replace(/\.[a-z0-9]+$/i, "");
        }
      } else {
        const downloaded = await downloadYouTubeVideo(youtubeUrl, tempDir);
        sourceVideoPath = downloaded.videoPath;
        if (!projectLabelRaw) sourceTitle = downloaded.title;
      }

      const duration = await probeMediaDuration(sourceVideoPath).catch(() => 0);
      if (!duration || duration < 0.5) {
        return res.status(400).json({ error: "Не вдалося визначити тривалість відео для нарізки" });
      }

      const isGenericSourceTitle = isGenericSourceName(sourceTitle);
      const sourceContextDir = path.join(tempDir, "source_context");
      await fs.mkdir(sourceContextDir, { recursive: true });
      const sourceFramePaths = await extractFramePathsDeep(sourceVideoPath, sourceContextDir, 3).catch(() => []);
      const sourceBlip = await describeFramesWithBlip(sourceFramePaths);
      const sourceOcr = await extractOcrFromVideoFrames(sourceVideoPath, sourceContextDir).catch(() => "");
      const sourceAnalysisContext = [
        isGenericSourceTitle ? "" : sourceTitle,
        sourceBlip.caption,
        cleanOcrForTitle(sourceOcr)
      ].filter(Boolean).join(". ");
      const titleContextBase = sourceAnalysisContext || (isGenericSourceTitle ? "архівний фрагмент відео" : sourceTitle);

      const projectSlug = slugifyText(projectLabelRaw || (isGenericSourceTitle ? "cuts" : sourceTitle) || "cuts", "cuts");
      const folderName = `cuts_${projectSlug}_${Date.now()}`;
      const projectDir = path.join(OUTPUT_DIR, folderName);
      const clipsDir = path.join(projectDir, "clips");
      const previewsDir = path.join(projectDir, "previews");
      await fs.mkdir(clipsDir, { recursive: true });
      await fs.mkdir(previewsDir, { recursive: true });

      const segmentsToCut = [];
      for (let start = 0; start < duration - 0.05; start += segmentSeconds) {
        const end = Math.min(duration, start + segmentSeconds);
        segmentsToCut.push({
          index: segmentsToCut.length,
          start,
          end,
          clipDuration: Math.max(0.5, end - start)
        });
      }

      const processedSegments = await mapWithConcurrency(segmentsToCut, cutterConcurrency, async (segment) => {
        const { index, start, end, clipDuration } = segment;
        const segmentTempDir = path.join(tempDir, `segment_${String(index + 1).padStart(5, "0")}`);
        await fs.mkdir(segmentTempDir, { recursive: true });
        const tempClipPath = path.join(segmentTempDir, `clip_${String(index + 1).padStart(4, "0")}.mp4`);
        await runFfmpeg([
          "-y",
          "-ss", String(start),
          "-i", sourceVideoPath,
          "-t", String(clipDuration),
          "-vf", "fps=30,format=yuv420p",
          ...videoCodecArgs(),
          "-c:a", "aac",
          "-b:a", "128k",
          "-movflags", "+faststart",
          tempClipPath
        ]);

        const ocrText = await extractOcrFromVideoFrames(tempClipPath, segmentTempDir).catch(() => "");
        const framePaths = await extractFramePathsDeep(tempClipPath, segmentTempDir, 3).catch(() => []);
        // Auto names must be based on the visible clip, not on OCR noise or
        // the source filename. OCR is only a fallback when BLIP cannot caption.
        const blip = await describeFramesWithBlip(framePaths);
        const titleMeta = buildCutTitleAnalysis({
          baseTitle: titleContextBase,
          ocrText,
          blipCaption: blip.caption,
          blipCaptions: blip.captions,
          blipError: blip.error,
          start,
          end,
          namingMode
        });
        const clipTitle = titleMeta.title;
        const timeSlug = `${formatCutTimeCompact(start)}_to_${formatCutTimeCompact(end)}`;
        const baseStem = String(titleMeta.fileSlug || "").trim() || slugifyText(clipTitle, `fragment-${timeSlug}`);

        return {
          index,
          start,
          end,
          clipDuration,
          tempClipPath,
          clipTitle,
          timeSlug,
          baseStem,
          titleMeta,
          blip,
          ocrText
        };
      });

      const clips = [];
      const usedFileStems = new Set();
      for (const processed of processedSegments.sort((a, b) => a.index - b.index)) {
        const { index, start, end, clipDuration, tempClipPath, clipTitle, timeSlug, baseStem, titleMeta, blip, ocrText } = processed;
        let fileStem = baseStem;
        if (!fileStem) fileStem = `fragment-${timeSlug}`;
        let suffix = 2;
        while (usedFileStems.has(fileStem)) {
          fileStem = `${baseStem || "fragment"}-${suffix}`;
          suffix += 1;
        }
        usedFileStems.add(fileStem);
        const finalFilename = `${fileStem}.mp4`;
        const finalClipPath = path.join(clipsDir, finalFilename);
        await safeCopyFile(tempClipPath, finalClipPath);

        const previewName = `${fileStem}.jpg`;
        const previewPath = path.join(previewsDir, previewName);
        await extractPreviewForClip(finalClipPath, previewPath, Math.min(clipDuration / 2, 1.0)).catch(() => {});

        clips.push({
          index: index + 1,
          title: clipTitle,
          filename: finalFilename,
          start,
          end,
          duration: clipDuration,
          timeLabel: formatCutTimeLabel(start, end),
          summary: titleMeta.summary,
          scoring: titleMeta.scoring,
          captionSource: titleMeta.scoring?.source || (blip.available && blip.caption ? "blip" : (ocrText ? "ocr" : "source")),
          blipCaption: blip.caption || "",
          blipCaptions: Array.isArray(blip.captions) ? blip.captions : [],
          blipError: blip.error || "",
          ocrText,
          url: `/outputs/${folderName}/clips/${finalFilename}`,
          previewUrl: `/outputs/${folderName}/previews/${previewName}`
        });
      }

      const metadata = {
        ok: true,
        projectName: projectSlug,
        sourceTitle,
        sourceType: useLocalFile ? "local" : "youtube",
        youtubeUrl,
        duration,
        segmentSeconds,
        cutterConcurrency,
        namingMode,
        captionMode,
        sourceAnalysisContext,
        clipsCount: clips.length,
        folderName,
        folderPath: projectDir,
        clips
      };
      await fs.writeFile(path.join(projectDir, "metadata.json"), JSON.stringify(metadata, null, 2), "utf8");

      const bundleFilename = `${folderName}.zip`;
      const bundlePath = path.join(OUTPUT_DIR, bundleFilename);
      await createZipArchive(projectDir, bundlePath);

      return res.json({
        ok: true,
        projectName: projectSlug,
        segmentSeconds,
        cutterConcurrency,
        clipsCount: clips.length,
        folderName,
        folderPath: projectDir,
        captionMode,
        metadataUrl: `/outputs/${folderName}/metadata.json`,
        bundleUrl: `/outputs/${bundleFilename}`,
        bundleFilename,
        clips
      });
    } catch (error) {
      return res.status(500).json({ error: error.message || "Помилка нарізки" });
    } finally {
      try {
        await fs.rm(tempDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
      await Promise.all(uploadedPaths.map((filePath) => fs.rm(filePath, { force: true }).catch(() => {})));
    }
  }
);

app.post(
  "/api/minimontage/run",
  upload.fields([
    { name: "audio", maxCount: 1 },
    { name: "clips", maxCount: 400 }
  ]),
  async (req, res) => {
    const tempDir = path.join(os.tmpdir(), `vss_minimontage_${randomUUID()}`);
    try {
      const audio = req.files?.audio?.[0];
      const clips = req.files?.clips || [];
      if (!audio) return res.status(400).json({ error: "Аудіофайл не передано" });
      if (!clips.length) return res.status(400).json({ error: "Кліпи не передано" });

      const resolution = String(req.body.resolution || "1280x720").trim();
      const sceneMode = String(req.body.sceneMode || "auto").trim();
      let sceneTexts = [];
      try {
        sceneTexts = JSON.parse(String(req.body.scenes || "[]"));
      } catch {
        sceneTexts = [];
      }
      if (!Array.isArray(sceneTexts)) sceneTexts = [];
      sceneTexts = sceneTexts.map((x) => String(x || "").trim()).filter(Boolean);

      await fs.mkdir(tempDir, { recursive: true });
      const inputDir = path.join(tempDir, "input");
      const clipsDir = path.join(inputDir, "clips");
      const outputDir = path.join(tempDir, "output");
      await fs.mkdir(inputDir, { recursive: true });
      await fs.mkdir(clipsDir, { recursive: true });
      await fs.mkdir(outputDir, { recursive: true });

      const audioExt = safeExtFromName(audio.originalname, ".mp3");
      const audioName = `voiceover${audioExt}`;
      const audioPath = path.join(inputDir, audioName);
      await fs.writeFile(audioPath, audio.buffer);

      const normalizedClipNames = [];
      for (let i = 0; i < clips.length; i += 1) {
        const clip = clips[i];
        const ext = safeExtFromName(clip.originalname, ".mp4");
        const filename = `${String(i + 1).padStart(3, "0")}-video${ext}`;
        const outPath = path.join(clipsDir, filename);
        await fs.writeFile(outPath, clip.buffer);
        normalizedClipNames.push(filename);
      }

      const sceneCount =
        sceneMode === "lines" && sceneTexts.length
          ? sceneTexts.length
          : Math.max(1, sceneTexts.length || normalizedClipNames.length);

      const scenes = [];
      for (let i = 0; i < sceneCount; i += 1) {
        const clipName = normalizedClipNames[i % normalizedClipNames.length];
        const text = sceneTexts[i] || `Scene ${i + 1}`;
        scenes.push({
          id: i + 1,
          clip: clipName,
          text
        });
      }

      const projectJson = {
        audio_file: `input/${audioName}`,
        output_file: "output/final_video.mp4",
        resolution,
        clips_dir: "input/clips",
        scenes
      };
      const projectPath = path.join(tempDir, "project.json");
      await fs.writeFile(projectPath, JSON.stringify(projectJson, null, 2), "utf8");

      const montageScriptPath = path.join(__dirname, "tools", "minimontager", "template", "scripts", "montage.py");
      try {
        await fs.access(montageScriptPath);
      } catch {
        return res.status(500).json({ error: "Скрипт МініМонтажера не знайдено в tools/minimontager/template/scripts/montage.py" });
      }

      await runCommand("python3", [montageScriptPath, projectPath], { cwd: tempDir });

      const renderedPath = path.join(tempDir, "output", "final_video.mp4");
      try {
        await fs.access(renderedPath);
      } catch {
        return res.status(500).json({ error: "МініМонтажер не створив output/final_video.mp4" });
      }

      const finalName = `mini_montage_${Date.now()}.mp4`;
      const finalPath = path.join(OUTPUT_DIR, finalName);
      await safeCopyFile(renderedPath, finalPath);

      return res.json({
        ok: true,
        url: `/outputs/${finalName}`,
        filename: finalName,
        scenesCount: scenes.length,
        clipsCount: normalizedClipNames.length
      });
    } catch (error) {
      return res.status(500).json({ error: error.message || "Помилка запуску МініМонтажера" });
    } finally {
      try {
        await fs.rm(tempDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }
);

// ─── BLIP lazy install ────────────────────────────────────────────────────────
// Status: tells the UI whether BLIP is ready, in-progress, or needs install.
// Install: streams progress as plain text/event-stream while it downloads
// portable Python, creates a venv, installs torch+transformers, and pulls
// the BLIP model. ~1.3 GB total. Files land in $VSS_USER_DATA_DIR/blip/ so
// they survive DMG updates.

const blipInstallState = { running: false, progress: 0, log: [], error: "" };

app.get("/api/blip/status", async (_req, res) => {
  const { userBlipRoot, userVenvPython } = getBlipPaths();
  let installed = false;
  if (userVenvPython) {
    try {
      await fs.access(userVenvPython);
      installed = true;
    } catch { /* not installed */ }
  }
  res.json({
    installed,
    installing: blipInstallState.running,
    progress: blipInstallState.progress,
    error: blipInstallState.error,
    location: userBlipRoot || "(dev mode — uses .venv-blip)"
  });
});

app.post("/api/blip/install", async (req, res) => {
  // Install can take 5-15 min. Stop Node from killing the socket on us.
  req.setTimeout(0);
  res.setTimeout(0);

  if (blipInstallState.running) {
    return res.status(409).json({ error: "Установка вже йде, перевір прогрес через /api/blip/status" });
  }
  const { userBlipRoot } = getBlipPaths();
  if (!userBlipRoot) {
    return res.status(400).json({ error: "VSS_USER_DATA_DIR не задано — встановлення доступне тільки у Electron-білді" });
  }

  // SSE stream: each `data: {...}` block is one progress event.
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  // Heartbeat ping every 15s prevents proxies/timeouts on long pip install.
  const heartbeat = setInterval(() => { try { res.write(": ping\n\n"); } catch {} }, 15000);
  res.on("close", () => clearInterval(heartbeat));

  const send = (event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  blipInstallState.running = true;
  blipInstallState.progress = 0;
  blipInstallState.log = [];
  blipInstallState.error = "";

  // Detach response from the install promise so even if client disconnects,
  // the install continues and state is queryable via /status.
  const installPromise = installBlipRuntime((event) => {
    if (event.progress != null) blipInstallState.progress = event.progress;
    if (event.log) blipInstallState.log.push(event.log);
    send(event);
  });

  installPromise.then(() => {
    blipInstallState.running = false;
    blipInstallState.progress = 100;
    // Reset BLIP cache so next describeFramesWithBlip rechecks paths.
    blipChecked = false;
    blipPythonBin = "";
    blipScriptPath = "";
    blipInitError = "";
    send({ done: true });
    res.end();
  }).catch((err) => {
    blipInstallState.running = false;
    blipInstallState.error = String(err?.message || err);
    send({ error: blipInstallState.error });
    res.end();
  });
});

// Implementation: download portable Python, create venv, install deps,
// download BLIP model. Each step reports progress via onEvent callback.
async function installBlipRuntime(onEvent) {
  const { userBlipRoot, userVenvPython, userModelsCache, scriptPath } = getBlipPaths();
  if (!userBlipRoot) throw new Error("userData not configured");

  const platform = process.platform;
  const arch = process.arch;
  const pyDir = path.join(userBlipRoot, "python");
  const venvDir = path.join(userBlipRoot, "venv");

  await fs.mkdir(userBlipRoot, { recursive: true });
  await fs.mkdir(userModelsCache, { recursive: true });

  // 1. Pick python-build-standalone URL (indygreg/python-build-standalone).
  // These are pre-built CPython distributions with no system dependencies.
  const PY_VERSION = "3.11.11";
  const PY_RELEASE = "20250109";
  let pyUrl = "";
  let pyArchive = "tar.gz";
  if (platform === "darwin" && arch === "arm64") {
    pyUrl = `https://github.com/astral-sh/python-build-standalone/releases/download/${PY_RELEASE}/cpython-${PY_VERSION}+${PY_RELEASE}-aarch64-apple-darwin-install_only.tar.gz`;
  } else if (platform === "darwin" && arch === "x64") {
    pyUrl = `https://github.com/astral-sh/python-build-standalone/releases/download/${PY_RELEASE}/cpython-${PY_VERSION}+${PY_RELEASE}-x86_64-apple-darwin-install_only.tar.gz`;
  } else if (platform === "win32") {
    pyUrl = `https://github.com/astral-sh/python-build-standalone/releases/download/${PY_RELEASE}/cpython-${PY_VERSION}+${PY_RELEASE}-x86_64-pc-windows-msvc-install_only.tar.gz`;
  } else {
    throw new Error(`Платформа ${platform}-${arch} не підтримується для авто-встановлення BLIP`);
  }

  // 2. Download Python tarball if not already extracted.
  const pythonBin = path.join(pyDir, "python", platform === "win32" ? "python.exe" : "bin/python3");
  let pythonReady = false;
  try { await fs.access(pythonBin); pythonReady = true; } catch { /* not yet */ }

  if (!pythonReady) {
    onEvent({ progress: 5, log: `Завантаження Python ${PY_VERSION} (~30MB)...` });
    const tarPath = path.join(userBlipRoot, "python.tar.gz");
    const resp = await fetchWithTimeout(pyUrl, {}, 120000);
    if (!resp.ok) throw new Error(`Python download failed: HTTP ${resp.status}`);
    await fs.writeFile(tarPath, Buffer.from(await resp.arrayBuffer()));
    onEvent({ progress: 15, log: "Розпаковка Python..." });
    await fs.mkdir(pyDir, { recursive: true });
    await runCommand("tar", ["-xzf", tarPath, "-C", pyDir], { timeoutMs: 120000 });
    await fs.unlink(tarPath).catch(() => {});
  }

  // 3. Create venv from portable Python.
  let venvReady = false;
  try { await fs.access(userVenvPython); venvReady = true; } catch { /* not yet */ }

  if (!venvReady) {
    onEvent({ progress: 25, log: "Створення віртуального середовища..." });
    await runCommand(pythonBin, ["-m", "venv", venvDir], { timeoutMs: 60000 });
  }

  // 4. Install Python deps (torch CPU + transformers + pillow). ~600MB download.
  onEvent({ progress: 30, log: "Встановлення PyTorch + Transformers (~600MB)..." });
  const pipBin = path.join(venvDir, platform === "win32" ? "Scripts" : "bin", platform === "win32" ? "pip.exe" : "pip");
  await runCommand(pipBin, [
    "install",
    "--upgrade",
    "--no-cache-dir",
    "torch",
    "torchvision",
    "transformers>=4.40",
    "pillow",
    "huggingface_hub"
  ], { timeoutMs: 600000, env: { ...process.env, PIP_DISABLE_PIP_VERSION_CHECK: "1" } });

  onEvent({ progress: 70, log: "Завантаження BLIP моделі (~700MB)..." });

  // 5. Pre-fetch BLIP model so first run is offline-fast. transformers will
  // store it in HF_HOME (which we've pointed at userModelsCache).
  const downloadScript = `
import os
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ["HF_HOME"] = "${userModelsCache.replace(/\\/g, "/")}"
os.environ["TRANSFORMERS_CACHE"] = "${userModelsCache.replace(/\\/g, "/")}"
from transformers import BlipProcessor, BlipForConditionalGeneration
BlipProcessor.from_pretrained("Salesforce/blip-image-captioning-base")
BlipForConditionalGeneration.from_pretrained("Salesforce/blip-image-captioning-base")
print("OK")
`;
  await runCommand(userVenvPython, ["-c", downloadScript], { timeoutMs: 900000 });

  onEvent({ progress: 100, log: "Готово! BLIP працює офлайн." });
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.use((err, req, res, _next) => {
  const status = Number(err?.statusCode || err?.status || 500);
  const isMulterError = err instanceof multer.MulterError;
  const message =
    isMulterError && err.code === "LIMIT_FILE_SIZE"
      ? `Файл завеликий для цього режиму. Для Нарізки ліміт ${CUTTER_MAX_FILE_LABEL}; перезапусти сервер і спробуй ще раз.`
      : isMulterError && err.code === "LIMIT_UNEXPECTED_FILE"
        ? `Забагато файлів або неочікуване поле "${err.field || "file"}". Для монтажу зараз ліміт 1000 локальних файлів.`
      : err?.message || "Внутрішня помилка сервера";

  if (req.path && req.path.startsWith("/api/")) {
    return res.status(isMulterError ? 413 : status).json({ error: message });
  }

  return res.status(isMulterError ? 413 : status).send(message);
});

const port = Number(process.env.PORT) || 3333;
const host = process.env.HOST || "127.0.0.1";

const server = app.listen(port, host, () => {
  console.log(`Voice Stock Studio running on http://${host}:${port}`);
});

server.requestTimeout = 0;
server.headersTimeout = 0;
server.keepAliveTimeout = 120000;

server.on("error", (error) => {
  if (error?.code === "EADDRINUSE") {
    console.error(`Voice Stock Studio: port ${port} already in use. Existing server keeps running.`);
    process.exit(0);
  }
  throw error;
});
