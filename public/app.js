"use strict";

const el = {
  tabAutopilot: document.getElementById("tabAutopilot"),
  tabMontage: document.getElementById("tabMontage"),
  tabCutter: document.getElementById("tabCutter"),
  autopilotPanel: document.getElementById("autopilotPanel"),
  montagePanel: document.getElementById("montagePanel"),
  cutterPanel: document.getElementById("cutterPanel"),
  audioFile: document.getElementById("audioFile"),
  language: document.getElementById("language"),
  focusLanguage: document.getElementById("focusLanguage"),
  splitMode: document.getElementById("splitMode"),
  fixedSecondsWrap: document.getElementById("fixedSecondsWrap"),
  fixedSeconds: document.getElementById("fixedSeconds"),
  openaiKey: document.getElementById("openaiKey"),
  sourceMode: document.getElementById("sourceMode"),
  mediaType: document.getElementById("mediaType"),
  stockProvider: document.getElementById("stockProvider"),
  pexelsKey: document.getElementById("pexelsKey"),
  pixabayKey: document.getElementById("pixabayKey"),
  visionMode: document.getElementById("visionMode"),
  visionVerifyAllVideo: document.getElementById("visionVerifyAllVideo"),
  visionVerifyAllImage: document.getElementById("visionVerifyAllImage"),
  allowAiFallback: document.getElementById("allowAiFallback"),
  montagePreset: document.getElementById("montagePreset"),
  imageAnimStyle: document.getElementById("imageAnimStyle"),
  imageAnimStrength: document.getElementById("imageAnimStrength"),
  transitionPack: document.getElementById("transitionPack"),
  transitionDuration: document.getElementById("transitionDuration"),
  subtitlesEnabled: document.getElementById("subtitlesEnabled"),
  proMontageMode: document.getElementById("proMontageMode"),
  proInsertDensity: document.getElementById("proInsertDensity"),
  proInsertTitle: document.getElementById("proInsertTitle"),
  proInsertNumber: document.getElementById("proInsertNumber"),
  proInsertDocument: document.getElementById("proInsertDocument"),
  proInsertTimeline: document.getElementById("proInsertTimeline"),
  proInsertPhotoFrame: document.getElementById("proInsertPhotoFrame"),
  proInsertSplitScreen: document.getElementById("proInsertSplitScreen"),
  proInsertBreakingNews: document.getElementById("proInsertBreakingNews"),
  proInsertLocationStamp: document.getElementById("proInsertLocationStamp"),
  proInsertChapterCard: document.getElementById("proInsertChapterCard"),
  proInsertRedactedDoc: document.getElementById("proInsertRedactedDoc"),
  proInsertTypewriter: document.getElementById("proInsertTypewriter"),
  sfxEnabled: document.getElementById("sfxEnabled"),
  sfxVolume: document.getElementById("sfxVolume"),
  sfxPack: document.getElementById("sfxPack"),
  visionVerifyVideoWrap: document.getElementById("visionVerifyVideoWrap"),
  visionVerifyImageWrap: document.getElementById("visionVerifyImageWrap"),
  localAnalyzeMode: document.getElementById("localAnalyzeMode"),
  localFiles: document.getElementById("localFiles"),
  localFolders: document.getElementById("localFolders"),
  addLocalFilesBtn: document.getElementById("addLocalFilesBtn"),
  addLocalFolderBtn: document.getElementById("addLocalFolderBtn"),
  clearLocalFilesBtn: document.getElementById("clearLocalFilesBtn"),
  localFilesSummary: document.getElementById("localFilesSummary"),
  stockOptions: document.getElementById("stockOptions"),
  localOptions: document.getElementById("localOptions"),
  transcribeBtn: document.getElementById("transcribeBtn"),
  matchBtn: document.getElementById("matchBtn"),
  rerollBtn: document.getElementById("rerollBtn"),
  renderBtn: document.getElementById("renderBtn"),
  autopilotBtn: document.getElementById("autopilotBtn"),
  status: document.getElementById("status"),
  themeInfo: document.getElementById("themeInfo"),
  segments: document.getElementById("segments"),
  matches: document.getElementById("matches"),
  renderResult: document.getElementById("renderResult")
  ,
  miniAudioFile: document.getElementById("miniAudioFile"),
  miniClipsFiles: document.getElementById("miniClipsFiles"),
  miniResolution: document.getElementById("miniResolution"),
  miniSceneMode: document.getElementById("miniSceneMode"),
  miniSceneLines: document.getElementById("miniSceneLines"),
  miniRunBtn: document.getElementById("miniRunBtn"),
  miniStatus: document.getElementById("miniStatus"),
  miniRenderResult: document.getElementById("miniRenderResult"),
  cutYoutubeUrl: document.getElementById("cutYoutubeUrl"),
  cutVideoFile: document.getElementById("cutVideoFile"),
  cutSegmentPreset: document.getElementById("cutSegmentPreset"),
  cutSegmentCustomWrap: document.getElementById("cutSegmentCustomWrap"),
  cutSegmentSeconds: document.getElementById("cutSegmentSeconds"),
  cutProjectLabel: document.getElementById("cutProjectLabel"),
  cutNamingMode: document.getElementById("cutNamingMode"),
  cutCaptionMode: document.getElementById("cutCaptionMode"),
  cutRunBtn: document.getElementById("cutRunBtn"),
  cutStatus: document.getElementById("cutStatus"),
  cutResults: document.getElementById("cutResults")
};

const state = {
  segments: [],
  selectedLocalFiles: [],
  localAssets: [],
  currentMatches: [],
  queryHints: new Map(),
  fullText: "",
  globalKeywords: [],
  globalTheme: { id: "general", label: "General", tokens: [] },
  autopilotRunning: false,
  stockSearchCache: new Map(),
  rerollSeed: 0,
  visionVerifyCache: new Map(),
  rerollCounts: new Map(),
  transcribedAudioKey: ""
};

const stopWords = new Set([
  "і", "й", "та", "в", "у", "на", "по", "для", "до", "з", "із", "це", "як", "про",
  "the", "a", "an", "of", "to", "for", "in", "on", "and", "is", "are",
  "это", "как", "что", "его", "её", "она", "они", "или", "при", "над", "под", "без",
  "this", "that", "with", "from", "into", "over", "under", "about", "than"
]);

const STORAGE_KEY = "vss_settings_v1";

function setStatus(text, isError = false) {
  el.status.textContent = text;
  el.status.style.color = isError ? "#b83016" : "#005f73";
}

function setMiniStatus(text, isError = false) {
  if (!el.miniStatus) return;
  el.miniStatus.textContent = text;
  el.miniStatus.style.color = isError ? "#b83016" : "#005f73";
}

function setCutStatus(text, isError = false) {
  if (!el.cutStatus) return;
  el.cutStatus.textContent = text;
  el.cutStatus.style.color = isError ? "#b83016" : "#005f73";
}

function getLocalFileStableKey(file) {
  if (!file) return "";
  const rel = String(file.webkitRelativePath || "");
  return `${rel || file.name}::${Number(file.size || 0)}::${Number(file.lastModified || 0)}`;
}

function updateLocalFilesSummary() {
  if (!el.localFilesSummary) return;
  const files = state.selectedLocalFiles || [];
  if (!files.length) {
    el.localFilesSummary.textContent = "Файлів поки не додано";
    return;
  }
  const videoCount = files.filter((file) => {
    const mime = String(file?.type || "").toLowerCase();
    const name = String(file?.name || "").toLowerCase();
    return mime.startsWith("video/") || [".mp4", ".mov", ".m4v", ".webm", ".avi", ".mkv"].some((ext) => name.endsWith(ext));
  }).length;
  const imageCount = files.length - videoCount;
  const folderCount = new Set(files.map((file) => String(file.webkitRelativePath || "").split("/")[0]).filter(Boolean)).size;
  el.localFilesSummary.textContent = `Додано: ${files.length} файлів (${videoCount} відео, ${imageCount} зображень)${folderCount ? `, папок: ${folderCount}` : ""}`;
}

function appendLocalFiles(fileList) {
  const incoming = Array.from(fileList || []);
  if (!incoming.length) return;
  const existing = new Map((state.selectedLocalFiles || []).map((file) => [getLocalFileStableKey(file), file]));
  for (const file of incoming) {
    const key = getLocalFileStableKey(file);
    if (!key || existing.has(key)) continue;
    existing.set(key, file);
  }
  state.selectedLocalFiles = Array.from(existing.values());
  updateLocalFilesSummary();
}

function clearLocalFilesSelection() {
  state.selectedLocalFiles = [];
  state.localAssets.forEach((x) => {
    try { URL.revokeObjectURL(x.previewUrl); } catch {}
  });
  state.localAssets = [];
  if (el.localFiles) el.localFiles.value = "";
  if (el.localFolders) el.localFolders.value = "";
  updateLocalFilesSummary();
}

const HERO_COPY = {
  autopilot: {
    title: "Відео Автопілот",
    subtitle: "Озвучка -> контекст -> відео/картинки. Завантаж аудіо, обери джерело контенту, отримай автопідбір медіа та готовий змонтований ролик."
  },
  montage: {
    title: "МініМонтажер",
    subtitle: "Швидкий монтаж зі своїх локальних файлів за заданими сценами і налаштуваннями."
  },
  cutter: {
    title: "Нарізка відео",
    subtitle: "Завантаж YouTube-посилання або локальний відеофайл — отримай готові кліпи з автоназвами для монтажу або повторного використання."
  }
};

function switchMainTab(mode) {
  const isAutopilot = mode === "autopilot";
  const isMontage = mode === "montage";
  const isCutter = mode === "cutter";
  if (el.tabAutopilot) el.tabAutopilot.classList.toggle("active", isAutopilot);
  if (el.tabMontage) el.tabMontage.classList.toggle("active", isMontage);
  if (el.tabCutter) el.tabCutter.classList.toggle("active", isCutter);
  if (el.autopilotPanel) el.autopilotPanel.classList.toggle("hidden", !isAutopilot);
  if (el.montagePanel) el.montagePanel.classList.toggle("hidden", !isMontage);
  if (el.cutterPanel) el.cutterPanel.classList.toggle("hidden", !isCutter);

  const copy = HERO_COPY[mode] || HERO_COPY.autopilot;
  const titleEl = document.getElementById("heroTitle");
  const subtitleEl = document.getElementById("heroSubtitle");
  if (titleEl) titleEl.textContent = copy.title;
  if (subtitleEl) subtitleEl.textContent = copy.subtitle;
}

function saveUiSettings() {
  try {
    const payload = {
      language: el.language?.value || "",
      focusLanguage: el.focusLanguage?.value || "uk",
      splitMode: el.splitMode?.value || "context",
      fixedSeconds: el.fixedSeconds?.value || "4",
      sourceMode: "local",
      mediaType: el.mediaType?.value || "both",
      stockProvider: el.stockProvider?.value || "all",
      visionMode: el.visionMode?.value || "turbo_no_vision",
      localAnalyzeMode: el.localAnalyzeMode?.value || "cv",
      montagePreset: el.montagePreset?.value || "dynamic",
      imageAnimStyle: el.imageAnimStyle?.value || "combo",
      imageAnimStrength: el.imageAnimStrength?.value || "2",
      transitionPack: el.transitionPack?.value || "dynamic",
      transitionDuration: el.transitionDuration?.value || "0.26",
      subtitlesEnabled: Boolean(el.subtitlesEnabled?.checked),
      proMontageMode: el.proMontageMode?.value || "auto",
      proInsertDensity: el.proInsertDensity?.value || "medium",
      proInsertTitle: Boolean(el.proInsertTitle?.checked),
      proInsertNumber: Boolean(el.proInsertNumber?.checked),
      proInsertDocument: Boolean(el.proInsertDocument?.checked),
      proInsertTimeline: Boolean(el.proInsertTimeline?.checked),
      proInsertPhotoFrame: Boolean(el.proInsertPhotoFrame?.checked),
      proInsertSplitScreen: Boolean(el.proInsertSplitScreen?.checked),
      proInsertBreakingNews: Boolean(el.proInsertBreakingNews?.checked),
      proInsertLocationStamp: Boolean(el.proInsertLocationStamp?.checked),
      proInsertChapterCard: Boolean(el.proInsertChapterCard?.checked),
      proInsertRedactedDoc: Boolean(el.proInsertRedactedDoc?.checked),
      proInsertTypewriter: Boolean(el.proInsertTypewriter?.checked),
      sfxEnabled: Boolean(el.sfxEnabled?.checked),
      sfxVolume: el.sfxVolume?.value || "0.85",
      sfxPack: el.sfxPack?.value || "cinematic",
      visionVerifyAllVideo: Boolean(el.visionVerifyAllVideo?.checked),
      visionVerifyAllImage: Boolean(el.visionVerifyAllImage?.checked),
      allowAiFallback: Boolean(el.allowAiFallback?.checked),
      openaiKey: el.openaiKey?.value || "",
      pexelsKey: el.pexelsKey?.value || "",
      pixabayKey: el.pixabayKey?.value || "",
      cutYoutubeUrl: el.cutYoutubeUrl?.value || "",
      cutSegmentPreset: el.cutSegmentPreset?.value || "8",
      cutSegmentSeconds: el.cutSegmentSeconds?.value || "8",
      cutProjectLabel: el.cutProjectLabel?.value || "",
      cutNamingMode: el.cutNamingMode?.value || "auto",
      cutCaptionMode: el.cutCaptionMode?.value || "blip"
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // ignore
  }
}

function restoreUiSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object") return;

    const setVal = (node, value) => {
      if (!node || typeof value !== "string") return;
      node.value = value;
    };
    setVal(el.language, String(data.language || ""));
    setVal(el.focusLanguage, String(data.focusLanguage || "uk"));
    setVal(el.splitMode, String(data.splitMode || "context"));
    setVal(el.fixedSeconds, String(data.fixedSeconds || "4"));
    setVal(el.sourceMode, "local");
    setVal(el.mediaType, String(data.mediaType || "both"));
    setVal(el.stockProvider, String(data.stockProvider || "all"));
    setVal(el.visionMode, String(data.visionMode || "turbo_no_vision"));
    setVal(el.localAnalyzeMode, String(data.localAnalyzeMode || "cv"));
    setVal(el.montagePreset, String(data.montagePreset || "dynamic"));
    setVal(el.imageAnimStyle, String(data.imageAnimStyle || "combo"));
    setVal(el.imageAnimStrength, String(data.imageAnimStrength || "2"));
    setVal(el.transitionPack, String(data.transitionPack || "dynamic"));
    setVal(el.transitionDuration, String(data.transitionDuration || "0.26"));
    if (el.subtitlesEnabled) el.subtitlesEnabled.checked = data.subtitlesEnabled !== false;
    setVal(el.proMontageMode, String(data.proMontageMode || "auto"));
    setVal(el.proInsertDensity, String(data.proInsertDensity || "medium"));
    if (el.proInsertTitle) el.proInsertTitle.checked = data.proInsertTitle !== false;
    if (el.proInsertNumber) el.proInsertNumber.checked = data.proInsertNumber !== false;
    if (el.proInsertDocument) el.proInsertDocument.checked = data.proInsertDocument !== false;
    if (el.proInsertTimeline) el.proInsertTimeline.checked = data.proInsertTimeline !== false;
    setVal(el.openaiKey, String(data.openaiKey || ""));
    setVal(el.pexelsKey, String(data.pexelsKey || ""));
    setVal(el.pixabayKey, String(data.pixabayKey || ""));
    setVal(el.cutYoutubeUrl, String(data.cutYoutubeUrl || ""));
    setVal(el.cutSegmentPreset, String(data.cutSegmentPreset || "8"));
    setVal(el.cutSegmentSeconds, String(data.cutSegmentSeconds || "8"));
    setVal(el.cutProjectLabel, String(data.cutProjectLabel || ""));
    setVal(el.cutNamingMode, String(data.cutNamingMode || "auto"));
    setVal(el.cutCaptionMode, String(data.cutCaptionMode || "blip"));

    if (el.visionVerifyAllVideo) el.visionVerifyAllVideo.checked = Boolean(data.visionVerifyAllVideo);
    if (el.visionVerifyAllImage) el.visionVerifyAllImage.checked = Boolean(data.visionVerifyAllImage);
    if (el.allowAiFallback) el.allowAiFallback.checked = Boolean(data.allowAiFallback);
  } catch {
    // ignore
  }
}

function renderThemeInfo() {
  if (!el.themeInfo) return;
  const theme = state.globalTheme || {};
  const label = String(theme.label || theme.id || "не визначено").trim();
  const tokens = Array.isArray(theme.tokens) ? theme.tokens.filter(Boolean).slice(0, 5) : [];
  const focusLang = el.focusLanguage?.value || "uk";
  el.themeInfo.textContent = tokens.length
    ? `Тема: ${label} (${tokens.join(", ")}). Фокус: ${focusLang}`
    : `Тема: ${label}. Фокус: ${focusLang}`;
  el.themeInfo.style.color = "#49637d";
}

function setWorkingState(isWorking) {
  el.transcribeBtn.disabled = isWorking;
  el.matchBtn.disabled = isWorking || !state.segments.length;
  el.rerollBtn.disabled = isWorking || !state.segments.length;
  el.renderBtn.disabled = isWorking || state.currentMatches.length === 0;
  el.autopilotBtn.disabled = isWorking;
}

function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .match(/[a-zа-яіїєґ0-9]+/gi) || [];
}

function getFileChangeKey(file) {
  if (!file) return "";
  return `${file.name || ""}::${Number(file.size || 0)}::${Number(file.lastModified || 0)}`;
}

function resetAutopilotStateForNewAudio() {
  state.segments = [];
  state.currentMatches = [];
  state.queryHints = new Map();
  state.fullText = "";
  state.globalKeywords = [];
  state.globalTheme = { id: "general", label: "General", tokens: [] };
  state.rerollSeed = 0;
  state.rerollCounts.clear();
  state.stockSearchCache.clear();
  state.visionVerifyCache.clear();
  state.transcribedAudioKey = "";
  renderSegments();
  renderMatches([]);
  renderThemeInfo();
  resetRenderResult();
  setWorkingState(false);
}

function extractKeywords(text, limit = 10) {
  const words = tokenize(text);
  const result = [];
  const seen = new Set();

  for (const w of words) {
    if (w.length < 3 || stopWords.has(w) || seen.has(w)) continue;
    seen.add(w);
    result.push(w);
    if (result.length >= limit) break;
  }

  return result;
}

function buildBigrams(tokens) {
  const out = [];
  for (let i = 0; i < tokens.length - 1; i += 1) {
    out.push(`${tokens[i]} ${tokens[i + 1]}`);
  }
  return out;
}

function normalizeToken(token) {
  let t = String(token || "").toLowerCase().trim();
  t = t.replace(/[^a-zа-яіїєґ0-9]/gi, "");
  if (!t) return "";

  const endings = [
    "ами", "ями", "ові", "еві", "ого", "ому", "ими", "ій", "ий", "ий", "а", "я", "у", "ю", "і", "и", "е", "о", "ть", "ти", "ing", "ed", "es", "s"
  ];

  for (const end of endings) {
    if (t.length > end.length + 2 && t.endsWith(end)) {
      t = t.slice(0, -end.length);
      break;
    }
  }

  return t;
}

function tokenMatchScore(a, b) {
  const x = normalizeToken(a);
  const y = normalizeToken(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.startsWith(y) || y.startsWith(x)) return 0.75;
  if (x.includes(y) || y.includes(x)) return 0.55;

  let prefix = 0;
  while (prefix < x.length && prefix < y.length && x[prefix] === y[prefix]) prefix += 1;
  const ratio = prefix / Math.max(x.length, y.length);
  return ratio >= 0.6 ? 0.4 : 0;
}

function expandSemanticAliases(tokens = []) {
  const aliases = {
    лев: ["lion", "wildlife", "animal"],
    лева: ["lion", "wildlife", "animal"],
    lion: ["лев", "wildlife", "animal"],
    миша: ["mouse", "rodent", "animal"],
    мышь: ["mouse", "rodent", "animal"],
    mouse: ["миша", "rodent", "animal"],
    солдати: ["soldier", "military", "army"],
    soldier: ["солдати", "military", "army"],
    військові: ["military", "soldier", "army"],
    военные: ["military", "soldier", "army"],
    нацисти: ["nazi", "ww2", "archive", "history"],
    nazi: ["нацисти", "ww2", "archive", "history"],
    тюрма: ["prison", "jail", "bars"],
    prison: ["тюрма", "jail", "bars"],
    табір: ["camp", "concentration", "archive"],
    camp: ["табір", "concentration", "archive"],
    зникнення: ["missing", "disappearance", "investigation"],
    missing: ["зникнення", "disappearance", "investigation"],
    розслідування: ["investigation", "detective", "evidence"],
    investigation: ["розслідування", "detective", "evidence"],
    архів: ["archive", "historical", "documentary"],
    archive: ["архів", "historical", "documentary"]
  };
  const out = [];
  const seen = new Set();
  for (const token of tokens || []) {
    const key = normalizeToken(token);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(token);
    for (const alias of aliases[key] || []) {
      const aliasKey = normalizeToken(alias);
      if (!aliasKey || seen.has(aliasKey)) continue;
      seen.add(aliasKey);
      out.push(alias);
    }
  }
  return out;
}

function secToTime(value) {
  const sec = Math.max(0, Math.floor(Number(value) || 0));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function parseApiResponse(response, endpointLabel) {
  const raw = await response.text();
  let data = null;

  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      if (!response.ok) {
        throw new Error(`${endpointLabel} (${response.status}) повернув не JSON. Перезапусти Node-сервер і відкрий http://127.0.0.1:3000`);
      }
      throw new Error(`${endpointLabel}: невалідна відповідь сервера`);
    }
  }

  if (!response.ok) {
    throw new Error(data?.error || `${endpointLabel}: помилка ${response.status}`);
  }

  return data || {};
}

function setProgress(label, percent, message = "") {
  const p = Math.max(0, Math.min(100, Math.floor(percent)));
  setStatus(`${label}: ${p}%${message ? `. ${message}` : ""}`);
}

function getVisionMode() {
  return el.visionMode?.value || "turbo_no_vision";
}

function isTurboNoVisionMode() {
  return getVisionMode() === "turbo_no_vision";
}

function isNoVisionMode() {
  const v = getVisionMode();
  return v === "no_vision" || v === "turbo_no_vision";
}

function isVisionCvMode() {
  return getVisionMode() === "no_vision";
}

function isVisionApiMode() {
  const v = getVisionMode();
  return v === "vision_api" || v === "on";
}

function getStockVerificationMode() {
  if (isVisionApiMode() && Boolean(el.openaiKey.value.trim())) return "api";
  if (isVisionCvMode()) return "cv";
  return "none";
}

function shouldVerifyAllVideosVision() {
  return Boolean(el.visionVerifyAllVideo?.checked);
}

function shouldVerifyAllImagesVision() {
  return Boolean(el.visionVerifyAllImage?.checked);
}

function getStockPerPage() {
  if (isTurboNoVisionMode()) return 6;
  if (isNoVisionMode()) return 10;
  return 12;
}

function getEffectiveThreadCount() {
  return 8;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runWithConcurrency(items, worker, limit = 4, onItemDone = null) {
  const out = [];
  const queue = [...items];
  let doneCount = 0;
  const total = items.length;
  const workers = Array.from({ length: Math.max(1, limit) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      const value = await worker(item);
      out.push(value);
      doneCount += 1;
      if (onItemDone) onItemDone(doneCount, total, item, value);
    }
  });
  await Promise.all(workers);
  return out;
}

// Order-preserving parallel map. Use when result order must match input order
// (e.g., Vision verifications where we want highest-ranked passing candidate).
async function parallelMapOrdered(items, worker, concurrency = 6) {
  const results = new Array(items.length);
  const queue = items.map((item, i) => ({ item, i }));
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (queue.length) {
      const task = queue.shift();
      if (!task) break;
      results[task.i] = await worker(task.item, task.i);
    }
  }));
  return results;
}

async function postFormJsonWithUploadProgress(url, formData, endpointLabel, onUploadPercent) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url, true);
    xhr.timeout = 0;

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      const percent = (event.loaded / event.total) * 100;
      onUploadPercent?.(percent);
    };

    xhr.onerror = () => reject(new Error(`${endpointLabel}: помилка мережі`));
    xhr.onload = () => {
      const raw = xhr.responseText || "";
      let data = {};
      if (raw) {
        try {
          data = JSON.parse(raw);
        } catch {
          reject(new Error(`${endpointLabel} (${xhr.status}) повернув не JSON`));
          return;
        }
      }
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(data?.error || `${endpointLabel}: помилка ${xhr.status}`));
        return;
      }
      resolve(data);
    };

    xhr.send(formData);
  });
}

function getLocalVideoDuration(file) {
  return new Promise((resolve) => {
    if (!file) return resolve(0);
    const video = document.createElement("video");
    const url = URL.createObjectURL(file);
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(url);
      video.removeAttribute("src");
      resolve(Number.isFinite(value) ? value : 0);
    };
    video.preload = "metadata";
    video.onloadedmetadata = () => finish(video.duration || 0);
    video.onerror = () => finish(0);
    video.src = url;
  });
}

function startCutterTicker(totalSegments) {
  if (!totalSegments) return () => {};
  let current = 1;
  setCutStatus(`Нарізка: обробляється фрагмент ${current}/${totalSegments}...`);
  const timer = setInterval(() => {
    current = Math.min(totalSegments, current + 1);
    setCutStatus(`Нарізка: обробляється фрагмент ${current}/${totalSegments}...`);
  }, 3500);
  return () => clearInterval(timer);
}

function getSegmentQuery(segment) {
  const segmentFeatures = buildSegmentTokens(segment);
  const hint = state.queryHints.get(Number(segment.id));
  const focus = getSegmentFocus(segment);
  const anchors = buildStoryAnchors();

  const candidates = [
    hint,
    [focus, ...segmentFeatures.tokens.slice(0, 4)].join(" "),
    [...segmentFeatures.focusTokens.slice(0, 4), ...anchors.slice(0, 2)].join(" "),
    segmentFeatures.tokens.slice(0, 6).join(" "),
    segment.text.split(/\s+/).slice(0, 7).join(" ")
  ];

  const base = candidates
    .map((x) => String(x || "").replace(/\s+/g, " ").trim())
    .find((x) => x.split(/\s+/).filter(Boolean).length >= 2) || "";

  return normalizeQueryByStory(base, segmentFeatures);
}

function normalizeQueryByStory(query, segmentFeatures) {
  const raw = String(query || "").replace(/\s+/g, " ").trim();
  if (!raw) return raw;

  const bag = [
    ...(segmentFeatures?.tokens || []),
    ...(segmentFeatures?.globalTokens || []),
    ...getThemeTokens()
  ].map((x) => normalizeToken(x)).filter(Boolean);

  const animalStory = bag.some((t) => ["lion", "lev", "mouse", "mysh", "animal", "wildlife", "forest", "nature", "savannah"].includes(t));
  if (!animalStory) return raw;

  let out = raw;
  out = out.replace(/\b(computer mouse|mouse pad|gaming mouse|office mouse)\b/gi, " ");
  if (/\bmouse\b/i.test(out) && !/\b(rodent|animal|wildlife)\b/i.test(out)) {
    out = `${out} rodent animal wildlife`;
  }
  if (/\blion\b/i.test(out) && !/\b(wildlife|savannah|animal)\b/i.test(out)) {
    out = `${out} wildlife animal`;
  }

  const words = out.split(/\s+/).filter(Boolean);
  const uniq = [];
  const seen = new Set();
  for (const w of words) {
    const key = normalizeToken(w);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    uniq.push(w);
  }
  return uniq.join(" ").trim();
}

function getThemeTokens() {
  const theme = state.globalTheme || {};
  const idTokens = String(theme.id || "").split(/[_\s-]+/).filter(Boolean);
  const labelTokens = extractKeywords(String(theme.label || ""), 6);
  const explicit = Array.isArray(theme.tokens) ? theme.tokens : [];
  return [...new Set([...explicit, ...idTokens, ...labelTokens])].slice(0, 10);
}

function buildThemeFallbackQueries() {
  const themeId = String(state.globalTheme?.id || "general").toLowerCase();
  const map = {
    true_crime: ["dark forest", "foggy forest", "abandoned corridor", "night street", "moody nature"],
    war: ["dramatic landscape", "foggy field", "stormy sky", "ruins landscape", "nature background"],
    history: ["historical architecture", "old city street", "archive paper texture", "vintage landscape", "nature background"],
    animal_story: ["wildlife nature", "forest path", "savannah landscape", "animals in nature", "nature background"],
    lion_story: ["lion in savannah", "wildlife lion", "savannah landscape", "nature background", "african wildlife"],
    space: ["space nebula", "galaxy stars", "planet cosmos", "universe background", "astronomy sky"],
    general: ["nature landscape", "cinematic nature", "neutral background", "outdoor scenic", "moody landscape"]
  };
  const base = map[themeId] || map.general;
  const tokens = getThemeTokens().slice(0, 3);
  const tokenQuery = tokens.length ? `${tokens.join(" ")} nature` : "";
  return [...new Set([tokenQuery, ...base].filter(Boolean))].slice(0, 6);
}

async function detectGlobalTheme() {
  const text = String(state.fullText || "").trim();
  if (!text) return { id: "general", label: "General", tokens: [] };

  try {
    const response = await fetch("/api/context/theme", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        openaiApiKey: el.openaiKey.value.trim(),
        language: el.language.value.trim() || "uk",
        text: text.slice(0, 12000)
      })
    });

    const data = await parseApiResponse(response, "Тема відео");
    const theme = data?.theme || {};
    const id = String(theme.id || "general").trim() || "general";
    const label = String(theme.label || id).trim() || id;
    const tokens = Array.isArray(theme.tokens) ? theme.tokens.map((x) => String(x).toLowerCase().trim()).filter(Boolean) : [];
    return { id, label, tokens: tokens.slice(0, 12) };
  } catch {
    const fallbackTokens = extractKeywords(text, 10);
    const low = text.toLowerCase();
    if (/нацист|nazi|nazis|gestapo|hitler|wehrmacht|ss\b|концтаб|auschwitz|belsen|holocaust|world war|ww2|друга світова|вторая мировая/i.test(low)) {
      return { id: "history", label: "Історія / Друга світова", tokens: ["history", "archive", "ww2", "nazi", "documentary"] };
    }
    if (/war|military|army|soldier|battle|frontline|tank|weapon|invasion|conflict|військ|военн|солдат|армі|армия|битв|збро|оруж|танк/i.test(low)) {
      return { id: "war", label: "Війна / Military", tokens: ["war", "military", "soldier", "battle", "frontline"] };
    }
    if (/(лев|lion)/i.test(low)) {
      return { id: "lion_story", label: "Історія про лева", tokens: ["lion", "wildlife", "savannah", "animal", "nature"] };
    }
    if (/зникнен|исчезновен|missing|kidnap|murder|crime|detective|investigation/i.test(low)) {
      return { id: "true_crime", label: "Зникнення / True Crime", tokens: ["missing", "true crime", "investigation", "evidence"] };
    }
    if (/космос|space|galaxy|nebula|planet|astronomy/i.test(low)) {
      return { id: "space", label: "Космос", tokens: ["space", "galaxy", "planet", "nebula"] };
    }
    return { id: "general", label: "General", tokens: fallbackTokens };
  }
}

function buildStoryAnchors() {
  const anchors = new Set((state.globalKeywords || []).map((x) => normalizeToken(x)).filter(Boolean));
  for (const tk of getThemeTokens()) anchors.add(normalizeToken(tk));
  const text = String(state.fullText || "").toLowerCase();

  const patterns = [
    { test: /\b(лев|lion)\b/i, add: ["lion", "animal", "wildlife"] },
    { test: /\b(миш|mouse)\b/i, add: ["mouse", "animal", "wildlife"] },
    { test: /\b(ліс|forest)\b/i, add: ["forest", "nature", "wild"] },
    { test: /\b(казк|fable|story)\b/i, add: ["fable", "story", "illustrative"] },
    { test: /\b(дит|child|kids)\b/i, add: ["children", "kids", "school"] }
  ];

  for (const p of patterns) {
    if (p.test.test(text)) {
      for (const word of p.add) anchors.add(word);
    }
  }

  return [...anchors].filter(Boolean).slice(0, 12);
}

function getSegmentFocus(segment) {
  if (segment.focus) return segment.focus;
  const text = String(segment.text || "").replace(/\s+/g, " ").trim();
  const phrase = text.split(/[.!?]/)[0] || text;
  const localFocus = phrase.split(/\s+/).slice(0, 10).join(" ");
  if (localFocus) return localFocus;
  const hint = state.queryHints.get(Number(segment.id));
  return hint || "";
}

function resetRenderResult() {
  el.renderResult.className = "render-result empty";
  el.renderResult.textContent = "Готове змонтоване відео з'явиться тут";
}

function resetMiniRenderResult() {
  if (!el.miniRenderResult) return;
  el.miniRenderResult.className = "render-result empty";
  el.miniRenderResult.textContent = "Готове змонтоване відео (МініМонтажер) з'явиться тут";
}


function resetCutResults() {
  if (!el.cutResults) return;
  el.cutResults.className = "render-result empty";
  el.cutResults.textContent = "Готові нарізані кліпи з'являться тут";
}

function updateCutSegmentUi() {
  const isCustom = String(el.cutSegmentPreset?.value || "8") === "custom";
  el.cutSegmentCustomWrap?.classList.toggle("hidden", !isCustom);
}

function getCutSegmentSeconds() {
  const preset = String(el.cutSegmentPreset?.value || "8");
  if (preset === "custom") return Math.max(2, Math.min(120, Number(el.cutSegmentSeconds?.value || 8) || 8));
  return Math.max(2, Math.min(120, Number(preset) || 8));
}

function renderCutResults(data) {
  if (!el.cutResults) return;
  const clips = Array.isArray(data?.clips) ? data.clips : [];
  if (!clips.length) {
    resetCutResults();
    return;
  }

  const folderUrl = data.folderUrl ? `${data.folderUrl}?v=${Date.now()}` : "";
  const metadataUrl = data.metadataUrl ? `${data.metadataUrl}?v=${Date.now()}` : "";
  const bundleUrl = data.bundleUrl ? `${data.bundleUrl}?v=${Date.now()}` : "";
  el.cutResults.className = "render-result";
  el.cutResults.innerHTML = `
    <div class="cut-results">
      <div class="cut-summary">
        <div><strong>Проєкт:</strong> ${escapeHtml(data.projectName || "cut_project")}</div>
        <div><strong>Фрагментів:</strong> ${Number(data.clipsCount || clips.length)}</div>
        <div><strong>Довжина сегмента:</strong> ${Number(data.segmentSeconds || 0)} сек</div>
        <div><strong>Режим аналізу:</strong> ${escapeHtml(String(data.captionMode || "blip"))}</div>
        <div class="cut-links">
          ${metadataUrl ? `<a href="${metadataUrl}" target="_blank" rel="noopener">Відкрити metadata.json</a>` : ""}
          ${folderUrl ? `<a href="${folderUrl}" target="_blank" rel="noopener">Відкрити папку output</a>` : ""}
          ${bundleUrl ? `<a href="${bundleUrl}" download="${escapeHtml(data.bundleFilename || 'cuts_bundle.zip')}">Скачати всі нарізки zip</a>` : ""}
          ${bundleUrl ? `<button type="button" class="secondary" id="cutSaveBundleBtn">Зберегти zip у вибрану папку</button>` : ""}
        </div>
      </div>
      <div class="cut-list">
        ${clips.map((clip) => `
          <div class="cut-item">
            <div class="cut-item-head">
              <div class="cut-item-title">${escapeHtml(clip.title || clip.filename || "clip")}</div>
              <div class="cut-item-time">${escapeHtml(clip.timeLabel || `${secToTime(clip.start)} - ${secToTime(clip.end)}`)}</div>
            </div>
            ${clip.previewUrl ? `<div class="media"><img src="${clip.previewUrl}?v=${Date.now()}" alt="preview"></div>` : ""}
            <div>${escapeHtml(clip.summary || "Базова автоназва фрагмента")}</div>
            ${clip.captionSource ? `<div class="muted"><strong>Джерело назви:</strong> ${escapeHtml(String(clip.captionSource))}</div>` : ""}
            ${clip.blipCaption ? `<div class="muted"><strong>BLIP:</strong> ${escapeHtml(clip.blipCaption)}</div>` : ""}
            ${clip.blipError ? `<div class="muted"><strong>BLIP error:</strong> ${escapeHtml(clip.blipError)}</div>` : ""}
            ${clip.scoring ? `
              <div class="muted">
                Score: ${Number(clip.scoring.finalScore || 0)} |
                бонуси: ${Array.isArray(clip.scoring.bonuses) ? clip.scoring.bonuses.map((x) => `${x.type} ${x.value > 0 ? `+${x.value}` : x.value}`).join(", ") : "-"} |
                штрафи: ${Array.isArray(clip.scoring.penalties) && clip.scoring.penalties.length ? clip.scoring.penalties.map((x) => `${x.type} ${x.value}`).join(", ") : "нема"}
              </div>
            ` : ""}
            ${clip.scoring?.candidates?.length ? `
              <div class="muted">
                Кандидати: ${clip.scoring.candidates.map((x) => `${escapeHtml(String(x.source))}: ${escapeHtml(String(x.title || "-"))} (${Number(x.score || 0)})`).join(" | ")}
              </div>
            ` : ""}
            <div class="cut-links">
              <a href="${clip.url}?v=${Date.now()}" target="_blank" rel="noopener">Відкрити кліп</a>
              <a href="${clip.url}?v=${Date.now()}" download="${escapeHtml(clip.filename || 'clip.mp4')}">Завантажити</a>
            </div>
          </div>
        `).join("")}
      </div>
    </div>
  `;

  const saveBundleBtn = document.getElementById("cutSaveBundleBtn");
  if (saveBundleBtn && bundleUrl) {
    saveBundleBtn.addEventListener("click", async () => {
      try {
        await saveUrlToChosenLocation(bundleUrl, String(data.bundleFilename || "cuts_bundle.zip"));
        setCutStatus("Нарізка: пакет збережено у вибране місце.");
      } catch (error) {
        setCutStatus(error.message || "Не вдалося зберегти пакет", true);
      }
    });
  }
}

async function saveUrlToChosenLocation(url, suggestedName) {
  const response = await fetch(url);
  if (!response.ok) throw new Error("Не вдалося завантажити пакет для збереження");
  const blob = await response.blob();

  if (window.showSaveFilePicker) {
    const handle = await window.showSaveFilePicker({
      suggestedName,
      types: [
        {
          description: "ZIP archive",
          accept: { "application/zip": [".zip"] }
        }
      ]
    });
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
    return;
  }

  const anchor = document.createElement("a");
  const href = URL.createObjectURL(blob);
  anchor.href = href;
  anchor.download = suggestedName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(href);
}

function renderSegments() {
  if (!state.segments.length) {
    el.segments.className = "segments empty";
    el.segments.textContent = "Сегментів поки немає";
    return;
  }

  el.segments.className = "segments";
  el.segments.innerHTML = state.segments.map((seg) => {
    const duration = Math.max(0.2, Number(seg.end || 0) - Number(seg.start || 0));
    return `
      <article class="segment">
        <div class="time">${secToTime(seg.start)} - ${secToTime(seg.end)} (${duration.toFixed(1)} c)</div>
        <strong>${escapeHtml(seg.text)}</strong>
        <div>Фокус: ${escapeHtml(seg.focus || getSegmentFocus(seg) || "-")}</div>
      </article>
    `;
  }).join("");
}

function renderMatches(rows) {
  state.currentMatches = rows;
  el.renderBtn.disabled = rows.length === 0;

  if (!rows.length) {
    el.matches.className = "matches empty";
    el.matches.textContent = "Поки немає підбору";
    return;
  }

  el.matches.className = "matches";
  el.matches.innerHTML = rows.map((row, idx) => {
    const media = row.asset.kind === "video"
      ? `<video src="${row.asset.previewUrl}" controls muted></video>`
      : `<img src="${row.asset.previewUrl}" alt="asset">`;

    const aiInfo = row.asset.aiSummary
      ? `<div>AI-аналіз: ${escapeHtml(row.asset.aiSummary)}</div>`
      : "";
    const ocrInfo = row.asset.aiOcr
      ? `<div>OCR: ${escapeHtml(String(row.asset.aiOcr).slice(0, 180))}</div>`
      : "";
    const reasonInfo = row.reason ? `<div>Причина: ${escapeHtml(row.reason)}</div>` : "";

    const methodLabels = {
      "embed-strong": { label: "CLIP", color: "#10b981", title: "Сильний семантичний матч (CLIP)" },
      "embed":        { label: "CLIP", color: "#3b82f6", title: "Семантичний матч (CLIP)" },
      "token":        { label: "Tokens", color: "#6b7280", title: "Збіг по токенах" },
      "weak":         { label: "Weak", color: "#f59e0b", title: "Слабкий матч" },
      "ai-local":     { label: "AI", color: "#8b5cf6", title: "AI-локальний підбір" }
    };
    const m = methodLabels[row.matchSource];
    const methodBadge = m
      ? `<div style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;background:${m.color};color:#fff;margin-bottom:4px;" title="${escapeHtml(m.title)}">${m.label}${Number.isFinite(row.embScore) ? ` · ${row.embScore.toFixed(1)}` : ""}</div>`
      : "";

    return `
      <article class="match-item">
        <div><strong>${secToTime(row.segment.start)} - ${secToTime(row.segment.end)}</strong></div>
        ${methodBadge}
        <div>${escapeHtml(row.segment.text)}</div>
        <div>Запит: <em>${escapeHtml(row.query)}</em></div>
        <div>Джерело: ${escapeHtml(row.asset.source)} (${escapeHtml(row.asset.kind)})</div>
        ${aiInfo}
        ${ocrInfo}
        ${reasonInfo}
        <div class="media">${media}</div>
        <div class="frame-actions">
          <button type="button" class="frame-action reroll-one" data-index="${idx}">Підібрати інший футаж</button>
        </div>
      </article>
    `;
  }).join("");
}

function updateModeUi() {
  if (el.sourceMode) el.sourceMode.value = "local";
  const isStock = false;
  el.stockOptions.classList.remove("hidden");
  el.stockOptions.classList.toggle("hidden", !isStock);
  el.localOptions.classList.toggle("hidden", isStock);

  const showVisionToggles = isStock && isVisionApiMode();
  el.visionVerifyVideoWrap?.classList.toggle("hidden", !showVisionToggles);
  el.visionVerifyImageWrap?.classList.toggle("hidden", !showVisionToggles);

  const visionTogglesEnabled = showVisionToggles && Boolean(el.openaiKey.value.trim());
  if (el.visionVerifyAllVideo) el.visionVerifyAllVideo.disabled = !visionTogglesEnabled;
  if (el.visionVerifyAllImage) el.visionVerifyAllImage.disabled = !visionTogglesEnabled;
}

function getStockProviderConfig(mediaType) {
  const provider = el.stockProvider?.value || "all";
  const pexelsApiKey = el.pexelsKey.value.trim();
  const pixabayApiKey = el.pixabayKey.value.trim();

  const byProvider = {
    pexels: pexelsApiKey ? ["pexels"] : [],
    pixabay: pixabayApiKey ? ["pixabay"] : [],
  };

  let providers = [];
  if (provider === "all") {
    providers = [
      ...(pexelsApiKey ? ["pexels"] : []),
      ...(pixabayApiKey ? ["pixabay"] : []),
    ];
  } else {
    providers = byProvider[provider] || [];
  }

  return {
    providers,
    keys: {
      pexelsApiKey,
      pixabayApiKey
    }
  };
}

function updateSplitModeUi() {
  const isFixed = el.splitMode.value === "fixed";
  el.fixedSecondsWrap.classList.toggle("hidden", !isFixed);
}

async function transcribe() {
  try {
    const file = el.audioFile.files?.[0];
    if (!file) {
      setStatus("Додай аудіофайл", true);
      return;
    }

    const maxAudioBytes = 25 * 1024 * 1024;
    if ((file.size || 0) > maxAudioBytes) {
      const mb = (file.size / (1024 * 1024)).toFixed(1);
      setStatus(`Файл завеликий для транскрипції OpenAI (${mb} MB). Ліміт: 25 MB. Стисни або розріж аудіо.`, true);
      return false;
    }

    const form = new FormData();
    form.append("audio", file);
    form.append("openaiApiKey", el.openaiKey.value.trim());
    form.append("language", el.language.value.trim());
    form.append("splitMode", el.splitMode.value);
    form.append("fixedSeconds", el.fixedSeconds.value);

    setProgress("Транскрипція", 2, "Підготовка");
    setWorkingState(true);
    const data = await postFormJsonWithUploadProgress("/api/transcribe", form, "Транскрипція", (upload) => {
      setProgress("Транскрипція", Math.min(55, 5 + upload * 0.5), "Завантаження аудіо");
    });
    setProgress("Транскрипція", 75, "Розпізнавання");

    state.segments = (data.segments || []).map((seg) => ({
      ...seg,
      keywords: seg.keywords?.length ? seg.keywords : extractKeywords(seg.text),
      focus: ""
    }));
    state.fullText = String(data.text || "");
    state.globalKeywords = extractKeywords(state.fullText, 24);
    state.globalTheme = await detectGlobalTheme();
    renderThemeInfo();

    try {
      const focusHints = await generateFocusHints();
      state.segments = state.segments.map((seg) => ({
        ...seg,
        focus: focusHints.get(Number(seg.id)) || getSegmentFocus(seg)
      }));
    } catch {
      state.segments = state.segments.map((seg) => ({
        ...seg,
        focus: getSegmentFocus(seg)
      }));
    }

    renderSegments();
    renderMatches([]);
    resetRenderResult();
    state.rerollSeed = 0;
    state.rerollCounts.clear();
    state.transcribedAudioKey = getFileChangeKey(file);

    setProgress("Транскрипція", 100, `Сегментів: ${state.segments.length}`);
    return true;
  } catch (error) {
    setStatus(error.message, true);
    return false;
  } finally {
    setWorkingState(false);
  }
}

function fileToAsset(file, fileIndex) {
  const relativePath = String(file?.webkitRelativePath || "");
  const sourceLabel = relativePath || String(file?.name || "");
  const name = sourceLabel.toLowerCase();
  const mime = String(file?.type || "").toLowerCase();
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".")) : "";
  const videoExt = new Set([".mp4", ".mov", ".m4v", ".webm", ".avi", ".mkv"]);
  const imageExt = new Set([".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif"]);
  let kind = "other";
  if (mime.startsWith("video/") || videoExt.has(ext)) kind = "video";
  else if (mime.startsWith("image/") || imageExt.has(ext)) kind = "image";
  const tokens = extractKeywords(
    sourceLabel
      .replace(/\.[a-z0-9]+$/i, "")
      .replaceAll(/[_.\-\/\\]/g, " "),
    20
  );

  return {
    kind,
    source: "local",
    title: sourceLabel,
    previewUrl: URL.createObjectURL(file),
    fileIndex,
    tokens,
    aiTags: [],
    aiSummary: "",
    aiOcr: ""
  };
}

async function analyzeLocalAssets(files) {
  const localAnalyzeMode = el.localAnalyzeMode?.value || "cv";
  const form = new FormData();
  for (const file of files) form.append("localAssets", file);
  form.append("localAnalyzeMode", localAnalyzeMode);
  form.append("openaiApiKey", localAnalyzeMode === "openai" ? el.openaiKey.value.trim() : "");
  form.append("language", el.language.value.trim());

  const response = await fetch("/api/local/analyze", {
    method: "POST",
    body: form
  });
  const raw = await response.text();
  let data = {};

  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      if (response.status === 404) {
        return { assets: [], fallbackReason: "route_missing" };
      }
      if (!response.ok) {
        throw new Error(`Аналіз локального контенту (${response.status}) недоступний. Працюю у fallback-режимі`);
      }
      return { assets: [], fallbackReason: "non_json" };
    }
  }

  if (!response.ok) {
    if (response.status === 404) {
      return { assets: [], fallbackReason: "route_missing" };
    }
    throw new Error(data?.error || `Аналіз локального контенту: помилка ${response.status}`);
  }

  return {
    assets: Array.isArray(data.assets) ? data.assets : [],
    fallbackReason: ""
  };
}

async function generateQueryHints() {
  const openaiApiKey = el.openaiKey.value.trim();
  if (!openaiApiKey || !state.segments.length) return new Map();

  const response = await fetch("/api/context/query-batch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      openaiApiKey,
      language: el.language.value.trim() || "uk",
      focusLanguage: el.focusLanguage?.value || "uk",
      globalContext: state.fullText.slice(0, 6000),
      themeId: state.globalTheme?.id || "general",
      themeTokens: getThemeTokens(),
      segments: state.segments.map((seg) => ({
        id: seg.id,
        text: seg.text,
        keywords: seg.keywords || []
      }))
    })
  });

  const data = await parseApiResponse(response, "Контекстні запити");
  const out = new Map();
  for (const row of data.queries || []) {
    const id = Number(row.id);
    if (!Number.isFinite(id)) continue;
    out.set(id, String(row.query || "").trim());
  }
  return out;
}

async function generateFocusHints() {
  if (!state.segments.length) return new Map();
  const response = await fetch("/api/context/focus-batch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      openaiApiKey: el.openaiKey.value.trim(),
      language: el.language.value.trim() || "uk",
      focusLanguage: el.focusLanguage?.value || "uk",
      globalContext: state.fullText.slice(0, 6000),
      segments: state.segments.map((seg) => ({
        id: seg.id,
        text: seg.text
      }))
    })
  });
  const data = await parseApiResponse(response, "Фокус сегментів");
  const out = new Map();
  for (const row of data.focuses || []) {
    const id = Number(row.id);
    if (!Number.isFinite(id)) continue;
    out.set(id, String(row.focus || "").trim());
  }
  return out;
}

async function aiMatchLocalAssets({ segments, assets, mediaType }) {
  const openaiApiKey = el.openaiKey.value.trim();
  if (!openaiApiKey) return new Map();

  const response = await fetch("/api/context/match-local", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      openaiApiKey,
      language: el.language.value.trim() || "uk",
      mediaType,
      globalContext: state.fullText.slice(0, 6000),
      segments: segments.map((seg) => ({
        id: seg.id,
        text: seg.text,
        keywords: seg.keywords || []
      })),
      assets: assets.map((asset) => ({
        fileIndex: asset.fileIndex,
        kind: asset.kind,
        title: asset.title,
        summary: asset.aiSummary || "",
        ocrText: asset.aiOcr || "",
        tags: asset.aiTags || []
      }))
    })
  });

  const data = await parseApiResponse(response, "AI-матчинг локального контенту");
  const out = new Map();
  for (const row of data.matches || []) {
    const segmentId = Number(row.segmentId);
    const fileIndex = Number(row.fileIndex);
    if (!Number.isFinite(segmentId) || !Number.isFinite(fileIndex)) continue;
    out.set(segmentId, { fileIndex, reason: String(row.reason || "") });
  }
  return out;
}

// CLIP-based semantic matching. Returns Map<segmentId, Map<fileIndex, score>>.
// Soft-fails (returns empty Map) so existing token-based path keeps working.
async function embedMatchLocalAssets({ segments, assets }) {
  if (!segments?.length || !assets?.length) return new Map();
  // Skip the call if no asset has framePaths — embed-match needs them.
  const assetsWithFrames = assets.filter((a) => Array.isArray(a.framePaths) && a.framePaths.length);
  if (!assetsWithFrames.length) return new Map();

  let response;
  try {
    response = await fetch("/api/local/embed-match", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        segments: segments.map((seg) => ({ id: seg.id, text: seg.text })),
        assets: assets.map((a) => ({
          fileIndex: a.fileIndex,
          framePaths: Array.isArray(a.framePaths) ? a.framePaths : [],
          aiSummary: a.aiSummary || "",
          aiTags: a.aiTags || [],
          aiOcr: a.aiOcr || "",
          title: a.title || ""
        }))
      })
    });
  } catch (e) {
    console.warn("embed-match request failed:", e?.message);
    return new Map();
  }

  let data = {};
  try { data = await response.json(); } catch (_) { return new Map(); }
  if (!data?.ok) {
    console.warn("embed-match soft-fail:", data?.error);
    return new Map();
  }

  const out = new Map();
  const scores = data.scores || {};
  for (const segId of Object.keys(scores)) {
    const row = scores[segId] || {};
    const inner = new Map();
    for (const fi of Object.keys(row)) {
      const v = Number(row[fi]);
      if (Number.isFinite(v)) inner.set(Number(fi), v);
    }
    out.set(Number(segId), inner);
  }
  return out;
}

function buildSegmentTokens(segment) {
  const focusText = getSegmentFocus(segment);
  const focusTokens = extractKeywords(focusText, 12);
  const base = [
    ...focusTokens,
    ...(segment.keywords || []),
    ...extractKeywords(segment.text, 16),
    ...getThemeTokens()
  ];
  const uniq = [...new Set(expandSemanticAliases(base))];
  return {
    tokens: uniq,
    focusTokens: expandSemanticAliases(focusTokens),
    bigrams: buildBigrams(uniq),
    globalTokens: state.globalKeywords || []
  };
}

function detectSemanticBuckets(text) {
  const t = String(text || "").toLowerCase();
  const buckets = new Set();
  const addIf = (name, re) => { if (re.test(t)) buckets.add(name); };

  addIf("animals", /\blion|mouse|rodent|animal|wildlife|forest|savannah|jungle|cat|dog\b|лев|миш|тварин|животн|ліс|лес|природ/i);
  addIf("crime", /\bcrime|murder|detective|investigation|forensic|police|evidence|court|prison|kidnap|missing\b|зникнен|исчезнов|розслід|расслед|тюрм|суд|допит|доказ/i);
  addIf("war", /\bwar|military|army|soldier|battle|weapon|tank|frontline|explosion|ww2|nazi\b/i);
  addIf("war", /військ|военн|солдат|армі|армия|битв|збро|оруж|танк|нацист|гітлер|гитлер/i);
  addIf("history", /\bhistory|historical|archive|ancient|museum|timeline|retro|ww2|nazi\b|істор|истор|архів|архив|хронік|хроник|музей|нацист/i);
  addIf("space", /\bspace|galaxy|nebula|cosmos|planet|astronomy|moon|mars|saturn\b/i);
  addIf("office", /\boffice|corporate|business|meeting|keyboard|laptop|desk|typing\b/i);
  addIf("fitness", /\bfitness|gym|workout|treadmill|training|exercise\b/i);
  addIf("beauty", /\bbeauty|makeup|fashion|cosmetics|skincare\b/i);
  addIf("nature", /\bnature|landscape|mountain|river|sea|outdoor|sunset\b/i);
  addIf("people", /\bperson|people|man|woman|child|children|family\b/i);

  return buckets;
}

function getThemeSemanticProfile() {
  const themeId = String(state.globalTheme?.id || "general").toLowerCase();
  const profile = {
    preferred: new Set(),
    forbidden: new Set()
  };

  if (themeId === "lion_story" || themeId === "animals") {
    profile.preferred = new Set(["animals", "nature"]);
    profile.forbidden = new Set(["office", "fitness", "beauty", "space"]);
  } else if (themeId === "true_crime") {
    profile.preferred = new Set(["crime", "people"]);
    profile.forbidden = new Set(["space", "beauty", "fitness", "animals"]);
  } else if (themeId === "war") {
    profile.preferred = new Set(["war", "people"]);
    profile.forbidden = new Set(["space", "beauty", "fitness"]);
  } else if (themeId === "history") {
    profile.preferred = new Set(["history", "people"]);
    profile.forbidden = new Set(["space", "fitness", "beauty"]);
  }

  return profile;
}

function getAssetStableKey(asset) {
  if (!asset) return "";
  return String(asset.previewUrl || `${asset.source || "local"}:${asset.fileIndex ?? asset.title ?? ""}`);
}

function scoreLocal(segmentFeatures, asset, usageCount) {
  const titleTokens = extractKeywords(asset.title || "", 20);
  const ocrTokens = extractKeywords(asset.aiOcr || "", 20);
  const aiTokens = [
    ...(asset.aiTags || []),
    ...extractKeywords(asset.aiSummary || "", 16),
    ...ocrTokens,
    ...titleTokens,
    ...(asset.tokens || [])
  ];
  const uniqueAssetTokens = [...new Set(aiTokens)];
  const assetBigrams = buildBigrams(uniqueAssetTokens);
  const assetBuckets = detectSemanticBuckets(`${asset.title || ""} ${asset.aiSummary || ""} ${(asset.aiTags || []).join(" ")} ${asset.aiOcr || ""}`);
  const segmentBuckets = detectSemanticBuckets(`${(segmentFeatures.tokens || []).join(" ")} ${(segmentFeatures.focusTokens || []).join(" ")} ${(segmentFeatures.globalTokens || []).join(" ")}`);
  const profile = getThemeSemanticProfile();

  let score = 0;

  for (const t of segmentFeatures.tokens) {
    let best = 0;
    for (const at of uniqueAssetTokens) {
      best = Math.max(best, tokenMatchScore(t, at));
      if (best >= 1) break;
    }
    score += best * 4.5;

    if (best < 0.25 && (asset.title || "").toLowerCase().includes(String(t).toLowerCase())) {
      score += 3.2;
    }
  }

  const normalizedTitle = String(asset.title || "").toLowerCase();
  const focusTokens = segmentFeatures.focusTokens || [];
  for (const t of focusTokens) {
    if (normalizedTitle.includes(String(t).toLowerCase())) {
      score += 4.5;
    }
  }

  for (const bg of segmentFeatures.bigrams) {
    if (assetBigrams.includes(bg)) score += 2.5;
  }

  for (const g of segmentFeatures.globalTokens || []) {
    let best = 0;
    for (const at of uniqueAssetTokens) {
      best = Math.max(best, tokenMatchScore(g, at));
      if (best >= 1) break;
    }
    score += best * 1.1;
  }

  let preferredHit = 0;
  for (const p of profile.preferred) {
    if (assetBuckets.has(p) || segmentBuckets.has(p)) preferredHit += 1;
  }
  if (profile.preferred.size && preferredHit === 0) score -= 12;
  if (preferredHit > 0) score += preferredHit * 4;

  for (const bad of profile.forbidden) {
    if (assetBuckets.has(bad)) score -= 18;
  }

  if ((asset.aiSummary || "").length > 5) score += 1;
  if (ocrTokens.length) score += Math.min(3, ocrTokens.length * 0.2);
  const repeatPenalty = usageCount >= 3 ? 60 : usageCount === 2 ? 24 : usageCount === 1 ? 8 : 0;
  score -= repeatPenalty;

  const bag = [
    ...segmentFeatures.tokens,
    ...(segmentFeatures.globalTokens || [])
  ].map((x) => normalizeToken(x)).filter(Boolean);
  const animalStory = bag.some((t) => ["lion", "lev", "mouse", "mysh", "animal", "wildlife", "forest", "nature", "savannah"].includes(t));
  if (animalStory) {
    const text = `${asset.title || ""} ${asset.aiSummary || ""} ${(asset.aiTags || []).join(" ")} ${asset.aiOcr || ""}`.toLowerCase();
    if (/computer|keyboard|office|workplace|laptop|mouse pad|gaming mouse|desk|typing|fitness|treadmill/.test(text)) score -= 14;
    if (/lion|rodent|mouse|animal|wildlife|forest|nature|savannah/.test(text)) score += 4.5;
  }

  return score;
}

function listLocalCandidates(segment, mediaType, usageMap, excludeFileIndexes = new Set(), embedScores = null) {
  const candidates = state.localAssets.filter((asset) => {
    if (excludeFileIndexes.has(asset.fileIndex)) return false;
    if (mediaType === "both") return asset.kind === "video" || asset.kind === "image";
    return asset.kind === mediaType;
  });
  if (!candidates.length) return [];

  const segmentFeatures = buildSegmentTokens(segment);
  const embRow = embedScores?.get(Number(segment.id)) || null;
  return candidates
    .map((asset) => {
      const usageCount = usageMap.get(asset.fileIndex) || 0;
      const tokenScore = scoreLocal(segmentFeatures, asset, usageCount);
      // CLIP score is roughly in [-2, +3] range. Multiply x6 to make it
      // comparable to token-based scoring (which lives in [-20, +30]).
      const embRaw = embRow ? embRow.get(Number(asset.fileIndex)) : null;
      const embWeight = Number.isFinite(embRaw) ? embRaw * 6 : 0;
      const score = tokenScore + embWeight;
      // Tag the source so UI can show which method picked it.
      let matchSource = "token";
      if (Number.isFinite(embRaw)) {
        if (embRaw > 0.4) matchSource = "embed-strong";
        else if (embRaw > 0.1) matchSource = "embed";
        else if (tokenScore > 4) matchSource = "token";
        else matchSource = "weak";
      }
      return { asset, score, tokenScore, embScore: embWeight, matchSource };
    })
    .sort((a, b) => b.score - a.score);
}

function pickFromLocal(segment, mediaType, usageMap, excludeFileIndexes = new Set()) {
  const scored = listLocalCandidates(segment, mediaType, usageMap, excludeFileIndexes);
  if (!scored.length) return null;

  // Hard anti-duplicate balancing:
  // always pick from the least-used local files first, then by relevance score.
  const minUse = Math.min(...scored.map((x) => usageMap.get(x.asset.fileIndex) || 0));
  const leastUsedRanked = scored.filter((x) => (usageMap.get(x.asset.fileIndex) || 0) === minUse);
  if (leastUsedRanked.length) return leastUsedRanked[0].asset;

  return scored[0].asset;
}

const LOCAL_ASSET_MAX_REUSE = 3;
const STOCK_ASSET_MAX_REUSE = 3;
const RECENT_ASSET_LOOKBACK = 2;

function getRecentAssetKeys(picks, lookback = RECENT_ASSET_LOOKBACK) {
  return new Set(
    (picks || [])
      .slice(-Math.max(0, lookback))
      .map((row) => getAssetStableKey(row?.asset))
      .filter(Boolean)
  );
}

function getLocalReuseCapByKind(mediaType, totalSegments) {
  const countByKind = {
    video: state.localAssets.filter((a) => a.kind === "video").length,
    image: state.localAssets.filter((a) => a.kind === "image").length
  };
  const baseCap = (kind) => Math.max(1, Math.ceil(totalSegments / Math.max(1, countByKind[kind])));
  const caps = {
    video: Math.min(baseCap("video"), LOCAL_ASSET_MAX_REUSE),
    image: Math.min(baseCap("image"), LOCAL_ASSET_MAX_REUSE)
  };

  if (mediaType === "video") return { video: caps.video, image: 0 };
  if (mediaType === "image") return { video: 0, image: caps.image };
  return {
    video: Math.max(1, caps.video),
    image: Math.max(1, caps.image)
  };
}

function assignLocalAssetsGlobally({ segments, mediaType, aiMatches, embedScores }) {
  const usageByFile = new Map();
  const byFileIndex = new Map(state.localAssets.map((asset) => [asset.fileIndex, asset]));
  const caps = getLocalReuseCapByKind(mediaType, segments.length);
  const picks = [];

  for (const segment of segments) {
    const prevKey = getAssetStableKey(picks[picks.length - 1]?.asset);
    const recentKeys = getRecentAssetKeys(picks);
    const aiPick = aiMatches.get(Number(segment.id));
    const aiAsset = aiPick ? byFileIndex.get(aiPick.fileIndex) : null;

    let selected = null;
    let reason = "";
    let chosenEntry = null;

    if (aiAsset) {
      const used = usageByFile.get(aiAsset.fileIndex) || 0;
      const cap = caps[aiAsset.kind] || 0;
      const key = getAssetStableKey(aiAsset);
      if (cap > 0 && used < cap && key !== prevKey && !recentKeys.has(key)) {
        selected = aiAsset;
        reason = aiPick?.reason || "ai-local";
      }
    }

    if (!selected) {
      const ranked = listLocalCandidates(segment, mediaType, usageByFile, undefined, embedScores);
      const minUse = ranked.length ? Math.min(...ranked.map((x) => usageByFile.get(x.asset.fileIndex) || 0)) : 0;
      const balancedRanked = ranked.filter((x) => (usageByFile.get(x.asset.fileIndex) || 0) === minUse);
      const rankedSource = balancedRanked.length ? balancedRanked : ranked;
      const chosen = ranked.find((entry) => {
        const cap = caps[entry.asset.kind] || 0;
        const used = usageByFile.get(entry.asset.fileIndex) || 0;
        const key = getAssetStableKey(entry.asset);
        if (cap <= 0 || used >= cap) return false;
        if (key === prevKey && ranked.length > 1) return false;
        if (recentKeys.has(key) && ranked.length > recentKeys.size) return false;
        return entry.score >= -2;
      }) || rankedSource.find((entry) => {
        const cap = caps[entry.asset.kind] || 0;
        const used = usageByFile.get(entry.asset.fileIndex) || 0;
        if (cap <= 0 || used >= cap) return false;
        const key = getAssetStableKey(entry.asset);
        if (key === prevKey && rankedSource.length > 1) return false;
        if (recentKeys.has(key) && rankedSource.length > recentKeys.size) return false;
        return true;
      }) || ranked.find((entry) => (caps[entry.asset.kind] || 0) > 0) || null;

      // GUARANTEED FALLBACK: never let a segment go empty when we have any
      // candidates at all. We accept an over-cap or "bad-score" pick rather
      // than producing a blank slot in the timeline.
      const emergency = !chosen && ranked.length
        ? (ranked.find((entry) => getAssetStableKey(entry.asset) !== prevKey) || ranked[0])
        : null;

      chosenEntry = chosen || emergency || null;
      selected = chosenEntry?.asset || null;
      reason = chosen
        ? (chosenEntry?.matchSource ? `local-${chosenEntry.matchSource}` : "local-score")
        : (emergency ? "emergency-fallback" : "");
    }

    if (!selected) continue;
    usageByFile.set(selected.fileIndex, (usageByFile.get(selected.fileIndex) || 0) + 1);
    picks.push({
      segment,
      asset: selected,
      query: (segment.keywords || []).slice(0, 5).join(" "),
      reason,
      matchSource: chosenEntry?.matchSource || (aiAsset && selected === aiAsset ? "ai-local" : "token"),
      tokenScore: chosenEntry?.tokenScore,
      embScore: chosenEntry?.embScore
    });
  }

  if (mediaType === "both") {
    enforceMinVideoShare(picks);
    const targetVideos = Math.ceil(picks.length * MIN_VIDEO_SHARE_MIXED);
    const videos = picks.filter((p) => p.asset?.kind === "video");
    const images = picks.filter((p) => p.asset?.kind === "image");
    if (videos.length && images.length) {
      const mixed = [];
      let vi = 0;
      let ii = 0;
      for (let i = 0; i < picks.length; i += 1) {
        const remain = picks.length - i;
        const needVideos = Math.max(0, targetVideos - vi);
        const mustVideo = needVideos >= remain;
        const preferVideo = mustVideo || i % 2 === 0;
        if (preferVideo && vi < videos.length) mixed.push(videos[vi++]);
        else if (!preferVideo && ii < images.length) mixed.push(images[ii++]);
        else if (vi < videos.length) mixed.push(videos[vi++]);
        else if (ii < images.length) mixed.push(images[ii++]);
      }
      for (let i = 0; i < picks.length; i += 1) picks[i] = mixed[i] || picks[i];
    }
  }

  for (let i = 1; i < picks.length; i += 1) {
    const prev = picks[i - 1];
    const cur = picks[i];
    if (getAssetStableKey(prev.asset) !== getAssetStableKey(cur.asset)) continue;

    const ranked = listLocalCandidates(cur.segment, mediaType, usageByFile, new Set([cur.asset.fileIndex]), embedScores);
    const alternative = ranked.find((entry) => {
      const cap = caps[entry.asset.kind] || 0;
      const used = usageByFile.get(entry.asset.fileIndex) || 0;
      const key = getAssetStableKey(entry.asset);
      return cap > 0 && used < cap && key !== getAssetStableKey(prev.asset);
    });
    if (!alternative?.asset) continue;

    usageByFile.set(cur.asset.fileIndex, Math.max(0, (usageByFile.get(cur.asset.fileIndex) || 1) - 1));
    usageByFile.set(alternative.asset.fileIndex, (usageByFile.get(alternative.asset.fileIndex) || 0) + 1);
    picks[i] = {
      ...cur,
      asset: alternative.asset,
      reason: `${cur.reason || "local-score"}+adjacent-dedupe`
    };
  }

  return picks;
}

function scoreStockAsset(segmentFeatures, asset) {
  const bag = [
    ...extractKeywords(asset.title || "", 14),
    ...(asset.tags || [])
  ];
  const uniq = [...new Set(bag)];

  let score = 0;
  for (const token of segmentFeatures.tokens) {
    let best = 0;
    for (const a of uniq) {
      best = Math.max(best, tokenMatchScore(token, a));
      if (best >= 1) break;
    }
    score += best * 3.2;
  }

  for (const token of segmentFeatures.focusTokens || []) {
    let best = 0;
    for (const a of uniq) {
      best = Math.max(best, tokenMatchScore(token, a));
      if (best >= 1) break;
    }
    score += best * 2.2;
  }

  for (const token of segmentFeatures.globalTokens || []) {
    let best = 0;
    for (const a of uniq) {
      best = Math.max(best, tokenMatchScore(token, a));
      if (best >= 1) break;
    }
    score += best * 0.8;
  }

  const title = String(asset.title || "").toLowerCase();
  const bagText = `${title} ${(asset.tags || []).join(" ").toLowerCase()}`;
  const segmentNorm = (segmentFeatures.tokens || []).map((t) => normalizeToken(t)).filter(Boolean);
  const assetNorm = uniq.map((t) => normalizeToken(t)).filter(Boolean);
  const overlapHits = segmentNorm.filter((t) => assetNorm.some((a) => tokenMatchScore(t, a) >= 0.55)).length;
  const overlapRatio = segmentNorm.length ? overlapHits / segmentNorm.length : 0;
  score += overlapRatio * 7;
  const themeId = String(state.globalTheme?.id || "general").toLowerCase();
  const hasAnimalStory = (segmentFeatures.globalTokens || []).some((t) => ["lion", "lev", "mouse", "mysh", "animal", "wildlife", "forest", "nature"].includes(normalizeToken(t)));
  if (hasAnimalStory) {
    if (/computer|keyboard|office|workplace|laptop|mouse pad|gym|fitness|treadmill|business|corporate|meeting|desk|typing|workout/i.test(title)) score -= 8.5;
    if (/lion|wildlife|animal|nature|forest|savannah|cat|mouse|rodent/i.test(title)) score += 4.2;
  }

  // Hard off-topic penalties to block absurd picks (space/fitness/etc in crime/lion stories).
  if (themeId === "lion_story" || hasAnimalStory) {
    if (/space|galaxy|nebula|planet|cosmos|astronomy|computer|keyboard|office|corporate|workout|gym|fitness|treadmill|fashion|makeup/i.test(bagText)) score -= 45;
    if (!/lion|mouse|rodent|animal|wildlife|forest|savannah|nature/i.test(bagText)) score -= 12;
  }

  if (themeId === "true_crime") {
    if (/space|galaxy|nebula|stars?|astronomy|cosmos|universe|milky way|planet|saturn|mars|moon/i.test(bagText)) score -= 40;
    if (/wedding|fashion|fitness|gaming|makeup|travel vlog|cat cute|food blog|cosmetics|dance|party/i.test(title)) score -= 16;
    if (/crime|detective|investigation|forensic|police|evidence|cctv|court|prison|dark alley|murder/i.test(title)) score += 5;
    if (overlapRatio < 0.15) score -= 10;
  }
  if (themeId === "war") {
    if (/space|galaxy|nebula|stars?|astronomy|cosmos|universe|milky way|planet|saturn|mars|moon/i.test(bagText)) score -= 40;
    if (/wedding|beauty|shopping|cooking|makeup|office party|pet cute|fashion|party|vlog/i.test(title)) score -= 14;
    if (/war|army|military|soldier|battle|explosion|tank|frontline|weapon|conflict|map/i.test(title)) score += 5;
    if (overlapRatio < 0.12) score -= 8;
  }
  if (themeId === "history") {
    if (/space|galaxy|nebula|stars?|astronomy|cosmos|universe|milky way|planet|saturn|mars|moon/i.test(bagText)) score -= 35;
    if (/modern office|selfie|influencer|shopping mall|nightclub|fitness|gaming/i.test(title)) score -= 12;
    if (/archive|historical|old city|museum|ancient|retro|documentary|timeline/i.test(title)) score += 4;
    if (overlapRatio < 0.1) score -= 6;
  }

  return score;
}

const STOCK_IDEAL_VIDEO_SCORE = 5.5;
const STOCK_GOOD_VIDEO_SCORE = 3.2;
const VISION_STRICT_VIDEO_SCORE = 52;
const VISION_STRICT_IMAGE_SCORE = 48;
const VISION_MAX_VIDEO_CANDIDATES = 12;
const VISION_MAX_IMAGE_CANDIDATES = 8;
const VISION_CV_MAX_ATTEMPTS = 5;
const VISION_CV_VIDEO_SCORE = 14;
const VISION_CV_IMAGE_SCORE = 12;
const MIN_VIDEO_SHARE_MIXED = 0.4;
const MAX_AI_IMAGES_MIXED = 2;
const STOCK_ACCEPTABLE_VIDEO_SCORE = 2.1;

function enforceMinVideoShare(picks, minShare = MIN_VIDEO_SHARE_MIXED) {
  const total = picks.length;
  if (!total) return picks;

  const requiredVideos = Math.ceil(total * Math.max(0, Math.min(1, Number(minShare) || MIN_VIDEO_SHARE_MIXED)));
  let currentVideos = picks.filter((p) => p.asset?.kind === "video").length;
  if (currentVideos >= requiredVideos) return picks;

  const nonVideo = picks.filter((p) => p.asset?.kind !== "video");
  const upgradeCandidates = nonVideo
    .filter((p) => p.alternatives?.video)
    .sort((a, b) => (b.alternatives.videoScore || 0) - (a.alternatives.videoScore || 0));

  for (const pick of upgradeCandidates) {
    if (currentVideos >= requiredVideos) break;
    pick.asset = pick.alternatives.video;
    pick.reason = "video-quota-fallback";
    currentVideos += 1;
  }

  if (currentVideos >= requiredVideos) return picks;

  const bestVideo = picks
    .filter((p) => p.asset?.kind === "video")
    .sort((a, b) => (b.alternatives?.videoScore || 0) - (a.alternatives?.videoScore || 0))[0]?.asset;

  if (!bestVideo) return picks;

  for (const pick of nonVideo) {
    if (currentVideos >= requiredVideos) break;
    if (pick.asset?.kind === "video") continue;
    pick.asset = bestVideo;
    pick.reason = "video-reuse-quota";
    currentVideos += 1;
  }

  return picks;
}

function rebalanceMixedPicks(picks) {
  const targetVideos = Math.ceil(picks.length * MIN_VIDEO_SHARE_MIXED);
  let videoCount = picks.filter((p) => p.asset?.kind === "video").length;

  if (videoCount < targetVideos) {
    enforceMinVideoShare(picks, MIN_VIDEO_SHARE_MIXED);
    videoCount = picks.filter((p) => p.asset?.kind === "video").length;
  }

  for (let i = 1; i < picks.length; i += 1) {
    const prev = picks[i - 1];
    const cur = picks[i];
    if (!prev?.asset || !cur?.asset) continue;
    if (prev.asset.kind !== cur.asset.kind) continue;

    const needVideo = videoCount < targetVideos;
    if (cur.asset.kind === "video" && !needVideo && cur.alternatives?.image) {
      cur.asset = cur.alternatives.image;
      cur.reason = "mixed-balance-image";
      videoCount -= 1;
      continue;
    }

    if (cur.asset.kind === "image" && cur.alternatives?.video) {
      cur.asset = cur.alternatives.video;
      cur.reason = "mixed-balance-video";
      videoCount += 1;
    }
  }

  if (videoCount < targetVideos) {
    enforceMinVideoShare(picks, MIN_VIDEO_SHARE_MIXED);
  }

  const videos = picks.filter((p) => p.asset?.kind === "video");
  const images = picks.filter((p) => p.asset?.kind === "image");
  if (!videos.length || !images.length) return picks;

  const mixed = [];
  let vi = 0;
  let ii = 0;
  for (let idx = 0; idx < picks.length; idx += 1) {
    const remainingSlots = picks.length - idx;
    const videosUsed = vi;
    const videosRemainingNeeded = Math.max(0, targetVideos - videosUsed);
    const mustPickVideo = videosRemainingNeeded >= remainingSlots;
    const preferVideo = mustPickVideo || idx % 2 === 0;

    let next = null;
    if (preferVideo && vi < videos.length) {
      next = videos[vi];
      vi += 1;
    } else if (!preferVideo && ii < images.length) {
      next = images[ii];
      ii += 1;
    } else if (vi < videos.length) {
      next = videos[vi];
      vi += 1;
    } else if (ii < images.length) {
      next = images[ii];
      ii += 1;
    }

    if (next) mixed.push(next);
  }

  for (let i = 0; i < picks.length; i += 1) {
    picks[i] = mixed[i] || picks[i];
  }

  return picks;
}

function hardEnforceVideoShareWithGlobalPool(picks, minShare = MIN_VIDEO_SHARE_MIXED) {
  const total = picks.length;
  if (!total) return picks;
  const requiredVideos = Math.ceil(total * Math.max(0, Math.min(1, Number(minShare) || MIN_VIDEO_SHARE_MIXED)));
  let currentVideos = picks.filter((p) => p.asset?.kind === "video").length;
  if (currentVideos >= requiredVideos) return picks;

  const globalVideoPool = uniqueAssets(
    [...state.stockSearchCache.entries()]
      .filter(([k]) => k.startsWith("video::"))
      .flatMap(([, assets]) => assets || [])
  );
  if (!globalVideoPool.length) return picks;

  let poolIdx = 0;
  for (let i = 0; i < picks.length; i += 1) {
    if (currentVideos >= requiredVideos) break;
    if (picks[i]?.asset?.kind === "video") continue;
    const candidate = globalVideoPool[poolIdx % globalVideoPool.length];
    poolIdx += 1;
    if (!candidate) continue;
    picks[i].asset = candidate;
    picks[i].reason = `${picks[i].reason || "mixed"}+video-hard-quota`;
    currentVideos += 1;
  }

  return picks;
}

function rankStockAssets(assets, segmentFeatures, usageMap) {
  return assets
    .map((asset) => {
      const useKey = asset.previewUrl || asset.title || "";
      const used = usageMap.get(useKey) || 0;
      const repeatPenalty = used >= 3 ? 42 : used === 2 ? 16 : used === 1 ? 5.5 : 0;
      const score = scoreStockAsset(segmentFeatures, asset) - repeatPenalty;
      return { asset, score };
    })
    .filter((x) => x.score > -10)
    .sort((a, b) => b.score - a.score);
}

function uniqueAssets(assets) {
  const out = [];
  const seen = new Set();
  for (const asset of assets || []) {
    const key = asset?.previewUrl || asset?.title || "";
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(asset);
  }
  return out;
}

function chooseLeastUsedAsset(candidates, usageMap) {
  const normalized = uniqueAssets(candidates || []);
  if (!normalized.length) return null;
  normalized.sort((a, b) => {
    const ak = a?.previewUrl || a?.title || "";
    const bk = b?.previewUrl || b?.title || "";
    const au = usageMap.get(ak) || 0;
    const bu = usageMap.get(bk) || 0;
    return au - bu;
  });
  return normalized[0] || null;
}

function getStockReuseCapByKind(mediaType) {
  if (mediaType === "video") return { video: STOCK_ASSET_MAX_REUSE, image: 0 };
  if (mediaType === "image") return { video: 0, image: STOCK_ASSET_MAX_REUSE };
  return { video: STOCK_ASSET_MAX_REUSE, image: STOCK_ASSET_MAX_REUSE };
}

async function assignStockAssetsGlobally({ segments, mediaType, stockConfig, allowAiFallback, strictVision, reroll, verificationMode = "none", onProgress = null }) {
  const stockPicks = [];
  const usageMap = new Map();
  const usedFallbackPerSegment = new Set();
  const caps = getStockReuseCapByKind(mediaType);
  let aiGeneratedCount = 0;

  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    const prevKey = stockPicks.length
      ? (stockPicks[stockPicks.length - 1].asset?.previewUrl || stockPicks[stockPicks.length - 1].asset?.title || "")
      : "";
    const recentKeys = getRecentAssetKeys(stockPicks);

    const remaining = segments.length - i;
    const currentVideos = stockPicks.filter((p) => p.asset?.kind === "video").length;
    const requiredVideos = Math.ceil(segments.length * MIN_VIDEO_SHARE_MIXED);
    const mustPickVideoNow = mediaType === "both" && (requiredVideos - currentVideos) >= remaining;
    const preferredKind = mediaType === "both"
      ? (mustPickVideoNow ? "video" : (i % 2 === 0 ? "video" : "image"))
      : mediaType;

    const { asset, query, reason, alternatives, rankedVideo, rankedImage } = await pickFromStock(segment, mediaType, usageMap, {
      allowAiFallback,
      preferredKind,
      stockConfig,
      excludeKeys: new Set([...(prevKey ? [prevKey] : []), ...recentKeys])
    });

    let finalAsset = asset || null;
    let finalReason = reason || "";

    if (mediaType === "video" && Array.isArray(rankedVideo) && rankedVideo.length > 1) {
      const filtered = rankedVideo.filter((x) => {
        const key = x.asset?.previewUrl || x.asset?.title || "";
        return key && (usageMap.get(key) || 0) < (caps.video || 2) && key !== prevKey;
      });
      const source = filtered.length ? filtered : rankedVideo;
      const pickIndex = Math.min(source.length - 1, reroll % source.length);
      const candidate = source[pickIndex]?.asset;
      if (candidate) {
        finalAsset = candidate;
        finalReason = "video-reroll";
      }
    }

    if (mediaType === "video" && !finalAsset && !strictVision && verificationMode === "none") {
      const globalVideoPool = [...state.stockSearchCache.entries()]
        .filter(([k]) => k.startsWith("video::"))
        .flatMap(([, assets]) => assets || []);
      const rankedFallback = rankStockAssets(uniqueAssets(globalVideoPool), buildSegmentTokens(segment), usageMap);
      const pick = rankedFallback.find((x) => {
        const k = x.asset.previewUrl || x.asset.title || "";
        return k !== prevKey && !recentKeys.has(k) && !usedFallbackPerSegment.has(k);
      }) || rankedFallback.find((x) => {
        const k = x.asset.previewUrl || x.asset.title || "";
        return k && k !== prevKey && !recentKeys.has(k);
      }) || rankedFallback.find((x) => (x.asset.previewUrl || x.asset.title || "") !== prevKey) || rankedFallback[0];
      if (pick?.asset) {
        finalAsset = pick.asset;
        finalReason = "video-global-fallback";
        usedFallbackPerSegment.add(finalAsset.previewUrl || finalAsset.title || "");
      }
    }

    if (!finalAsset) continue;

    const maxReusePerAsset = caps[finalAsset.kind] || 0;
    const currentKey = finalAsset.previewUrl || finalAsset.title || "";
    const currentUsed = usageMap.get(currentKey) || 0;

    if (maxReusePerAsset <= 0) continue;

    if (currentUsed >= maxReusePerAsset || (prevKey && currentKey === prevKey)) {
      const rankedPool = finalAsset.kind === "video"
        ? (rankedVideo || []).map((x) => x.asset)
        : (rankedImage || []).map((x) => x.asset);
      const globalSameKindPool = uniqueAssets(
        [...state.stockSearchCache.values()]
          .flatMap((x) => x || [])
          .filter((a) => a?.kind === finalAsset.kind)
      );
      const fallbackPool = [...rankedPool, ...globalSameKindPool, alternatives?.video, alternatives?.image].filter(Boolean);
      const better = fallbackPool.find((a) => {
        const k = a?.previewUrl || a?.title || "";
        const used = usageMap.get(k) || 0;
        const cap = caps[a?.kind || "image"] || 0;
        if (!k || cap <= 0 || used >= cap) return false;
        if (prevKey && k === prevKey) return false;
        if (recentKeys.has(k) && fallbackPool.length > recentKeys.size) return false;
        return true;
      }) || null;

      if (better) {
        finalAsset = better;
        finalReason = finalReason ? `${finalReason}+dedupe` : "dedupe";
      } else if (finalAsset.kind === "image" && allowAiFallback && aiGeneratedCount < MAX_AI_IMAGES_MIXED) {
        const generated = await generateAiImageForSegment(segment);
        if (generated) {
          finalAsset = generated;
          finalReason = finalReason ? `${finalReason}+ai-fallback` : "ai-fallback";
          aiGeneratedCount += 1;
        } else {
          continue;
        }
      } else {
        continue;
      }
    }

    const finalKey = finalAsset.previewUrl || finalAsset.title || "";
    usageMap.set(finalKey, (usageMap.get(finalKey) || 0) + 1);
    stockPicks.push({
      segment,
      asset: finalAsset,
      query,
      reason: finalReason,
      alternatives,
      rankedVideo,
      rankedImage
    });

    onProgress?.(i + 1, segments.length);
  }

  if (mediaType === "both") {
    rebalanceMixedPicks(stockPicks);
  }

  for (let i = 1; i < stockPicks.length; i += 1) {
    const prev = stockPicks[i - 1];
    const cur = stockPicks[i];
    const prevKey = prev.asset?.previewUrl || prev.asset?.title || "";
    const curKey = cur.asset?.previewUrl || cur.asset?.title || "";
    if (!prevKey || !curKey || prevKey !== curKey) continue;

    const rankedPool = cur.asset.kind === "video"
      ? (cur.rankedVideo || []).map((x) => x.asset)
      : (cur.rankedImage || []).map((x) => x.asset);
    const alt = rankedPool.find((a) => {
      const k = a?.previewUrl || a?.title || "";
      if (!k || k === prevKey) return false;
      const used = usageMap.get(k) || 0;
      const cap = caps[a?.kind || "image"] || 0;
      return cap > 0 && used < cap;
    }) || null;
    if (!alt) continue;

    usageMap.set(curKey, Math.max(0, (usageMap.get(curKey) || 1) - 1));
    const altKey = alt.previewUrl || alt.title || "";
    usageMap.set(altKey, (usageMap.get(altKey) || 0) + 1);
    stockPicks[i] = {
      ...cur,
      asset: alt,
      reason: `${cur.reason || "stock-score"}+adjacent-dedupe`
    };
  }

  if (!stockPicks.length && segments.length) {
    const allAssets = uniqueAssets([...state.stockSearchCache.values()].flatMap((x) => x || []));
    const realVideo = allAssets.filter((a) => a?.kind === "video");
    const realImage = allAssets.filter((a) => a?.kind === "image");
    const realPool =
      mediaType === "video" ? realVideo :
      mediaType === "image" ? realImage :
      (realVideo.length ? realVideo : realImage);

    if (realPool.length) {
      for (let i = 0; i < segments.length; i += 1) {
        const segment = segments[i];
        const asset = realPool[i % realPool.length];
        stockPicks.push({
          segment,
          asset,
          query: getSegmentQuery(segment),
          reason: "emergency-real-stock-fallback",
          alternatives: {}
        });
        onProgress?.(i + 1, segments.length);
      }
      return stockPicks;
    }

    for (let i = 0; i < segments.length; i += 1) {
      if (!allowAiFallback || aiGeneratedCount >= MAX_AI_IMAGES_MIXED) break;
      const segment = segments[i];
      const query = getSegmentQuery(segment);
      let generated = null;
      try {
        generated = await generateAiImageForSegment(segment, query);
      } catch {
        generated = null;
      }
      if (!generated) continue;
      stockPicks.push({
        segment,
        asset: generated,
        query,
        reason: "emergency-ai-query-fallback",
        alternatives: {}
      });
      aiGeneratedCount += 1;
      onProgress?.(i + 1, segments.length);
    }
  }

  if (mediaType === "both") {
    hardEnforceVideoShareWithGlobalPool(stockPicks, MIN_VIDEO_SHARE_MIXED);
  }

  return stockPicks;
}

function buildQueryVariants(segment) {
  const primary = getSegmentQuery(segment);
  const focus = getSegmentFocus(segment);
  const tokens = extractKeywords(segment.text || "", 12);
  const focusTokens = extractKeywords(focus || "", 8);
  const global = (state.globalKeywords || []).slice(0, 6);
  const theme = getThemeTokens().slice(0, 4);
  const anchors = buildStoryAnchors();
  const variants = [
    primary,
    [focus, ...tokens.slice(0, 3)].join(" "),
    [...focusTokens.slice(0, 4), ...tokens.slice(0, 2)].join(" "),
    [...tokens.slice(0, 3), ...global.slice(0, 2)].join(" "),
    [...tokens.slice(0, 2), ...anchors.slice(0, 3)].join(" "),
    [...focusTokens.slice(0, 2), ...theme.slice(0, 2), ...anchors.slice(0, 2)].join(" "),
    [...theme.slice(0, 3), ...tokens.slice(0, 2)].join(" ")
  ].map((x) => String(x || "").replace(/\s+/g, " ").trim()).filter(Boolean);
  return [...new Set(variants)].slice(0, 6);
}

function disambiguateStockQuery(query) {
  let out = String(query || "").toLowerCase();
  if (!out) return "";

  const dict = [
    [/\bлев(а|у|ом|і|ы|е|ов|ам)?\b/gi, "lion"],
    [/\bмыш(ь|и|ью|ей|ами|ка|ку|кой)?\b/gi, "mouse"],
    [/\bмиша(і|ою|у|ам|ах)?\b/gi, "mouse"],
    [/\bліс(і|у|ом|ах)?\b/gi, "forest"],
    [/\bлес(у|ом|а|ах)?\b/gi, "forest"],
    [/\bприрод(а|и|е|ой|ою|і)\b/gi, "nature"],
    [/\bдики(й|е|х)\b/gi, "wild"],
    [/\bтварин(а|и|і|у|ою|ами)\b/gi, "animals"],
    [/\bживотн(ое|ые|ых|ым|ыми|ое)\b/gi, "animals"],
    [/\bказк(а|и|е|ой|у)\b/gi, "fable story"],
    [/\bзникнен(ня|ие|ия)\b/gi, "missing"],
    [/\bисчезновен(ие|ия)\b/gi, "disappearance"],
    [/\bрозслід(ування|увати)\b/gi, "investigation"],
    [/\bрасслед(ование|овать)\b/gi, "investigation"],
    [/\bнацист(и|ів|ам|ами|ський|ська|ські)?\b/gi, "nazi ww2 archive"],
    [/\bnazi(s)?\b/gi, "nazi ww2 archive"],
    [/\bgerman(s)?\b/gi, "german ww2 archive"],
    [/\bнімецьк(ий|і|а|е|ого)?\b/gi, "german ww2 archive"],
    [/\bконцтаб(ір|ору|орі)?\b/gi, "concentration camp archive"],
    [/\bтюрм(а|і|у|ою)?\b/gi, "prison archive"],
    [/\bсолдат(и|ів|ами)?\b/gi, "soldier military"],
    [/\bвійськ(ові|а|о)?\b/gi, "military soldier"]
  ];
  for (const [re, rep] of dict) out = out.replace(re, ` ${rep} `);

  out = out.replace(/[^a-z0-9\s-]/g, " ").replace(/\s+/g, " ").trim();
  const hasMouse = /\bmouse\b/.test(out);
  const hasLion = /\blion\b/.test(out) || /\blev\b/.test(out);
  const hasForest = /\bforest\b/.test(out);

  const extras = [];
  if (hasMouse) extras.push("rodent", "animal");
  if (hasLion) extras.push("wildlife", "animal");
  if (hasForest) extras.push("nature");
  if (hasMouse && hasLion) extras.push("fable", "storybook");

  return `${out} ${extras.join(" ")}`.trim().replace(/\s+/g, " ");
}

async function pickFromStock(segment, mediaType, usageMap, options = {}) {
  const segmentFeatures = buildSegmentTokens(segment);
  const queryBase = disambiguateStockQuery(getSegmentQuery(segment));
  const queryVariantsRaw = isTurboNoVisionMode() ? [queryBase] : buildQueryVariants(segment);
  const queryVariants = [...new Set(queryVariantsRaw.map((q) => disambiguateStockQuery(q)).filter(Boolean))];
  const allowAiFallback = options.allowAiFallback === true;
  const preferredKind = options.preferredKind === "video" || options.preferredKind === "image" ? options.preferredKind : "";
  const stockConfig = options.stockConfig || getStockProviderConfig(mediaType);
  const verifyMode = getStockVerificationMode();
  const useVisionApi = verifyMode === "api";
  const useVisionCv = verifyMode === "cv";
  const useVision = useVisionApi || useVisionCv;
  const excludeKeys = options.excludeKeys instanceof Set ? options.excludeKeys : new Set();

  function rankTop(assets) {
    if (!assets.length) return null;
    const ranked = assets
      .map((asset) => ({ asset, score: scoreStockAsset(segmentFeatures, asset) }))
      .sort((a, b) => b.score - a.score);
    return ranked[0] || null;
  }

  async function fetchStockAssetsCached(query, kind) {
    const key = `${kind}::${query.toLowerCase().trim()}`;
    if (state.stockSearchCache.has(key)) return state.stockSearchCache.get(key);

    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const safeQuery = disambiguateStockQuery(query);
        const response = await fetch("/api/stock/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query: safeQuery,
            mediaType: kind,
            providers: stockConfig.providers,
            pexelsApiKey: stockConfig.keys.pexelsApiKey,
            pixabayApiKey: stockConfig.keys.pixabayApiKey,
            language: el.language.value.trim() || "uk",
            perPage: getStockPerPage()
          })
        });

        const data = await parseApiResponse(response, "Пошук на стоках");
        const assets = Array.isArray(data.assets) ? data.assets : [];
        state.stockSearchCache.set(key, assets);
        return assets;
      } catch (error) {
        lastError = error;
        await sleep(220 * (attempt + 1));
      }
    }

    state.stockSearchCache.set(key, []);
    if (lastError) {
      console.warn("Stock search failed:", key, lastError.message);
    }
    return [];
  }

  async function generateImageFallback() {
    const themed = await pickThemeFallbackImage();
    if (themed) return themed;
    if (!allowAiFallback) return null;
    try {
      return await generateAiImageForSegment(segment);
    } catch {
      return null;
    }
  }

  async function pickThemeFallbackImage() {
    const queries = buildThemeFallbackQueries();
    const collected = [];
    for (const q of queries) {
      const chunk = await fetchStockAssetsCached(q, "image");
      collected.push(...(chunk || []));
    }
    const ranked = rankStockAssets(uniqueAssets(collected), segmentFeatures, usageMap || new Map())
      .filter((x) => !excludeKeys.has(x.asset?.previewUrl || x.asset?.title || ""));
    if (!ranked.length) return null;

    if (!useVision) {
      const soft = ranked.find((x) => Number(x.score || 0) >= 0);
      return (soft || ranked[0])?.asset || null;
    }

    const minScore = useVisionApi ? 10 : 8;
    for (const c of ranked.slice(0, 8)) {
      const v = await verifyWithVision(c.asset);
      if (!v.suitable || v.score < minScore) continue;
      return c.asset;
    }
    return null;
  }

  async function verifyWithVision(asset) {
    if (!useVision) return { score: 0, suitable: true };
    const cacheKey = `${verifyMode}::${asset.previewUrl}::${segment.id}::${segment.focus || ""}`;
    if (state.visionVerifyCache.has(cacheKey)) return state.visionVerifyCache.get(cacheKey);

    try {
      const response = await fetch("/api/stock/verify-asset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          asset: {
            kind: asset.kind,
            previewUrl: asset.previewUrl,
            title: asset.title || "",
            tags: Array.isArray(asset.tags) ? asset.tags : []
          },
          segmentText: segment.text,
          segmentFocus: segment.focus || "",
          globalContext: state.fullText.slice(0, 3000),
          verifyMode,
          openaiApiKey: el.openaiKey.value.trim(),
          language: el.language.value.trim() || "uk"
        })
      });
      const data = await parseApiResponse(response, "Vision-перевірка");
      const result = {
        score: Number(data.score || 0),
        suitable: Boolean(data.suitable)
      };
      state.visionVerifyCache.set(cacheKey, result);
      return result;
    } catch {
      return { score: 0, suitable: false };
    }
  }

  async function pickFirstVerified(ranked, maxAttempts, minScore) {
    const candidates = (ranked || []).slice(0, maxAttempts);
    if (!candidates.length) return null;

    // Verify all top-N candidates in parallel — Vision API is network-bound,
    // 6-way concurrency saturates without rate-limit issues. Result order is
    // preserved, so "first passing" still means "highest-ranked passing".
    const verified = await parallelMapOrdered(
      candidates,
      async (c) => ({ c, v: await verifyWithVision(c.asset) }),
      6
    );

    let bestSoft = null;
    for (let i = 0; i < verified.length; i += 1) {
      const { c, v } = verified[i];
      const softScore = c.score + Number(v.score || 0) * 0.08;
      if (!bestSoft || softScore > bestSoft.score) {
        bestSoft = { asset: c.asset, score: softScore, suitable: Boolean(v.suitable), verifyScore: Number(v.score || 0) };
      }
      if (!v.suitable || v.score < minScore) continue;
      return {
        asset: c.asset,
        score: c.score + v.score * 0.12,
        attempts: i + 1
      };
    }
    // Soft fallback: keep best real candidate even if none passed strict threshold.
    return bestSoft ? { asset: bestSoft.asset, score: bestSoft.score, attempts: candidates.length, soft: true } : null;
  }

  const preferVideo = mediaType === "video" || mediaType === "both";
  const preferImage = mediaType === "image" || mediaType === "both";

  const allVideoAssets = [];
  const allImageAssets = [];
  for (const q0 of queryVariants) {
    const q = disambiguateStockQuery(q0);
    if (preferVideo) {
      const chunk = await fetchStockAssetsCached(q, "video");
      allVideoAssets.push(...chunk);
    }
    if (preferImage) {
      const chunk = await fetchStockAssetsCached(q, "image");
      allImageAssets.push(...chunk);
    }
  }

  const videoAssets = uniqueAssets(allVideoAssets);
  const imageAssets = uniqueAssets(allImageAssets);
  if (preferVideo && videoAssets.length === 0) {
    const emergencyQueries = [...new Set([
      ...buildThemeFallbackQueries(),
      "wildlife cinematic",
      "nature cinematic",
      "story video",
      "documentary b roll"
    ].map((q) => disambiguateStockQuery(q)).filter(Boolean))];
    for (const eq of emergencyQueries) {
      const chunk = await fetchStockAssetsCached(eq, "video");
      if (Array.isArray(chunk) && chunk.length) {
        videoAssets.push(...chunk);
      }
    }
  }
  if (preferImage && imageAssets.length === 0) {
    const emergencyQueries = [...new Set([
      ...buildThemeFallbackQueries(),
      "nature landscape",
      "cinematic background"
    ].map((q) => disambiguateStockQuery(q)).filter(Boolean))];
    for (const eq of emergencyQueries) {
      const chunk = await fetchStockAssetsCached(eq, "image");
      if (Array.isArray(chunk) && chunk.length) {
        imageAssets.push(...chunk);
      }
    }
  }
  const videoTop = rankTop(videoAssets);
  const imageTop = rankTop(imageAssets);
  const rankedVideo = rankStockAssets(videoAssets, segmentFeatures, usageMap || new Map())
    .filter((x) => !excludeKeys.has(x.asset?.previewUrl || x.asset?.title || ""));
  const rankedImage = rankStockAssets(imageAssets, segmentFeatures, usageMap || new Map())
    .filter((x) => !excludeKeys.has(x.asset?.previewUrl || x.asset?.title || ""));
  const bestVideoByUsage = rankedVideo[0]?.asset || null;
  const bestImageByUsage = rankedImage[0]?.asset || null;

  let visionVideo = null;
  let visionImage = null;
  if (useVisionApi) {
    const videoCandidates = shouldVerifyAllVideosVision()
      ? rankedVideo
      : rankedVideo.slice(0, VISION_MAX_VIDEO_CANDIDATES);

    // Parallelize all video Vision verifications for this segment. Up to 12
    // concurrent OpenAI Vision calls — well within free-tier rate limits and
    // each call is independent. Single segment used to take 12×3s sequential
    // = 36s; now ~3-5s. Final selection is identical (max-score wins).
    const verifiedVideos = await parallelMapOrdered(
      videoCandidates,
      async (c) => ({ c, v: await verifyWithVision(c.asset) }),
      8
    );
    for (const { c, v } of verifiedVideos) {
      if (!v.suitable || v.score < VISION_STRICT_VIDEO_SCORE) continue;
      const score = c.score + v.score * 0.14;
      if (!visionVideo || score > visionVideo.score) {
        visionVideo = { asset: c.asset, score };
      }
    }

    const imageCandidates = shouldVerifyAllImagesVision()
      ? rankedImage
      : rankedImage.slice(0, VISION_MAX_IMAGE_CANDIDATES);
    const verifiedImages = await parallelMapOrdered(
      imageCandidates,
      async (c) => ({ c, v: await verifyWithVision(c.asset) }),
      8
    );
    for (const { c, v } of verifiedImages) {
      if (!v.suitable || v.score < VISION_STRICT_IMAGE_SCORE) continue;
      const score = c.score + v.score * 0.14;
      if (!visionImage || score > visionImage.score) {
        visionImage = { asset: c.asset, score };
      }
    }
  } else if (useVisionCv) {
    if (preferVideo) {
      visionVideo = await pickFirstVerified(rankedVideo, VISION_CV_MAX_ATTEMPTS, VISION_CV_VIDEO_SCORE);
    }
    if (preferImage) {
      visionImage = await pickFirstVerified(rankedImage, VISION_CV_MAX_ATTEMPTS, VISION_CV_IMAGE_SCORE);
    }
  }

  const chosenVideo = useVision ? (visionVideo?.asset || null) : (bestVideoByUsage || null);
  const chosenImage = useVision ? (visionImage?.asset || null) : (bestImageByUsage || null);
  const chosenVideoScore = useVision ? Number(visionVideo?.score || -999) : Number(videoTop?.score || -999);
  const chosenImageScore = useVision ? Number(visionImage?.score || -999) : Number(imageTop?.score || -999);

  const alternatives = {
    video: useVision ? (chosenVideo || null) : (chosenVideo || videoTop?.asset || null),
    image: useVision ? (chosenImage || null) : (chosenImage || imageTop?.asset || null),
    videoScore: Number(videoTop?.score || 0),
    imageScore: Number(imageTop?.score || 0)
  };

  if (mediaType === "video") {
    if (chosenVideo) {
      const reason = (useVisionCv && visionVideo?.soft) ? "video-only-cv-soft-fallback" : "video-only";
      return { asset: chosenVideo, query: queryBase, reason, alternatives, rankedVideo, rankedImage };
    }
    if (rankedVideo?.length) {
      return {
        asset: rankedVideo[0].asset,
        query: queryBase,
        reason: useVision ? "video-only-hard-fallback" : "video-only-ranked-fallback",
        alternatives,
        rankedVideo,
        rankedImage
      };
    }
    if (useVisionCv && bestVideoByUsage) {
      return { asset: bestVideoByUsage, query: queryBase, reason: "video-only-cv-ranked-fallback", alternatives, rankedVideo, rankedImage };
    }
    return { asset: null, query: queryBase, reason: useVision ? "vision-reject-video" : "video-not-found", alternatives, rankedVideo, rankedImage };
  }

  if (mediaType === "image") {
    if (chosenImage) return { asset: chosenImage, query: queryBase, reason: "image-only", alternatives, rankedVideo, rankedImage };
    const generatedOnlyImage = await generateImageFallback();
    if (generatedOnlyImage) return { asset: generatedOnlyImage, query: queryBase, reason: "generated-fallback", alternatives, rankedVideo, rankedImage };
    return { asset: null, query: queryBase, reason: "none", alternatives, rankedVideo, rankedImage };
  }

  if (chosenVideo && chosenVideoScore >= STOCK_IDEAL_VIDEO_SCORE) {
    return { asset: chosenVideo, query: queryBase, reason: "video-ideal", alternatives, rankedVideo, rankedImage };
  }

  if (mediaType === "both" && preferredKind === "video" && chosenVideo) {
    return { asset: chosenVideo, query: queryBase, reason: "video-preferred", alternatives, rankedVideo, rankedImage };
  }

  if (mediaType === "both" && preferredKind === "image" && chosenImage) {
    const imageClearlyBetter = chosenImageScore >= chosenVideoScore + 1.4;
    if (!chosenVideo || (chosenVideoScore < STOCK_ACCEPTABLE_VIDEO_SCORE && imageClearlyBetter)) {
      return { asset: chosenImage, query: queryBase, reason: "image-preferred", alternatives, rankedVideo, rankedImage };
    }
  }

  if (chosenVideo && chosenVideoScore >= STOCK_GOOD_VIDEO_SCORE) {
    return { asset: chosenVideo, query: queryBase, reason: "video-good", alternatives, rankedVideo, rankedImage };
  }

  if (chosenVideo && chosenVideoScore >= STOCK_ACCEPTABLE_VIDEO_SCORE) {
    return { asset: chosenVideo, query: queryBase, reason: "video-acceptable", alternatives, rankedVideo, rankedImage };
  }

  if (chosenImage && chosenImageScore >= 2.2) {
    return { asset: chosenImage, query: queryBase, reason: "image-fallback", alternatives, rankedVideo, rankedImage };
  }

  if (chosenVideo) {
    return { asset: chosenVideo, query: queryBase, reason: "video-nonideal-fallback", alternatives, rankedVideo, rankedImage };
  }

  const generated = await generateImageFallback();
  if (generated) return { asset: generated, query: queryBase, reason: "generated-fallback", alternatives, rankedVideo, rankedImage };

  return { asset: null, query: queryBase, reason: "none", alternatives, rankedVideo, rankedImage };
}

async function generateAiImageForSegment(segment, forcedQuery = "") {
  const base = String(forcedQuery || segment.text || "").trim();
  const prompt = `Create a realistic visual scene for query: ${base}. Scene text: ${segment.text}. Focus: ${segment.focus || ""}. Context: ${state.fullText.slice(0, 800)}`;
  const response = await fetch("/api/image/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt,
      openaiApiKey: el.openaiKey.value.trim()
    })
  });
  const data = await parseApiResponse(response, "Генерація зображення");
  return data.asset || null;
}

async function matchAssets() {
  try {
    const currentAudioKey = getFileChangeKey(el.audioFile.files?.[0]);
    if (currentAudioKey && state.transcribedAudioKey && currentAudioKey !== state.transcribedAudioKey) {
      throw new Error("Озвучка змінилася після транскрипції. Натисни Автопілот або спочатку 'Розпізнати озвучку', щоб не підбирати під старий текст.");
    }
    if (!state.segments.length) {
      setStatus("Спочатку зроби транскрипт", true);
      return;
    }

    const mode = el.sourceMode.value;
    const mediaType = el.mediaType.value;
    const rows = [];

    setProgress("Підбір контенту", 2, "Підготовка");
    setWorkingState(true);
    resetRenderResult();

    if (mode === "local") {
      if ((el.localAnalyzeMode?.value || "cv") === "openai" && !el.openaiKey.value.trim()) {
        throw new Error("Для режиму OpenAI Vision у локальних файлах додай OpenAI API key або перемкни на 'Без OpenAI'.");
      }
      state.localAssets.forEach((x) => URL.revokeObjectURL(x.previewUrl));
      const files = Array.from(state.selectedLocalFiles || []);

      state.localAssets = files
        .map((file, idx) => fileToAsset(file, idx))
        .filter((x) => x.kind !== "other");

      if (!state.localAssets.length) {
        throw new Error("У local-режимі додай хоча б один image/video файл");
      }

      setProgress("Підбір контенту", 12, "Аналіз локальних файлів");
      const { assets: analyzed, fallbackReason } = await analyzeLocalAssets(files);
      const byIndex = new Map(analyzed.map((item) => [item.fileIndex, item]));

      state.localAssets = state.localAssets.map((asset) => {
        const ai = byIndex.get(asset.fileIndex);
        if (!ai) return asset;

        return {
          ...asset,
          kind: ai.kind === "video" || ai.kind === "image" ? ai.kind : asset.kind,
          aiTags: Array.isArray(ai.tags) ? ai.tags : [],
          aiSummary: String(ai.summary || ai.scene || ""),
          aiOcr: String(ai.ocrText || ""),
          framePaths: Array.isArray(ai.framePaths) ? ai.framePaths : []
        };
      });

      if (mediaType === "video" && !state.localAssets.some((a) => a.kind === "video")) {
        throw new Error("У вибраних локальних файлах не знайдено відео. Додай .mp4/.mov або зміни тип контенту.");
      }
      if (mediaType === "image" && !state.localAssets.some((a) => a.kind === "image")) {
        throw new Error("У вибраних локальних файлах не знайдено картинок. Додай .jpg/.png або зміни тип контенту.");
      }

      let aiMatches = new Map();
      try {
        aiMatches = await aiMatchLocalAssets({ segments: state.segments, assets: state.localAssets, mediaType });
      } catch {
        aiMatches = new Map();
      }
      setProgress("Підбір контенту", 22, "CLIP-семантика");

      // CLIP-based embedding similarity (text↔image + text↔asset-text). Soft-fails
      // to token-only matching if Python/CLIP isn't ready. This is the main quality
      // upgrade — catches synonyms and visual matches the bag-of-words misses.
      let embedScores = new Map();
      try {
        embedScores = await embedMatchLocalAssets({ segments: state.segments, assets: state.localAssets });
      } catch (e) {
        console.warn("embed-match failed, falling back to tokens:", e?.message || e);
        embedScores = new Map();
      }

      setProgress("Підбір контенту", 28, "Пошук відповідностей");

      const localPicks = assignLocalAssetsGlobally({
        segments: state.segments,
        mediaType,
        aiMatches,
        embedScores
      });

      for (let i = 0; i < localPicks.length; i += 1) {
        rows.push(localPicks[i]);
        setProgress("Підбір контенту", 30 + Math.round(((i + 1) / Math.max(1, localPicks.length)) * 65), "Локальний підбір");
      }

      if (fallbackReason) {
        setProgress("Підбір контенту", 96, "Fallback-режим");
      }
    } else {
      const stockConfig = getStockProviderConfig(mediaType);
      if (!stockConfig.providers.length) {
        throw new Error("Додай API key для вибраного сток-провайдера (Pexels або Pixabay)");
      }
      if (isVisionApiMode() && !el.openaiKey.value.trim()) {
        throw new Error("Для режиму Vision API додай OpenAI API key або перемкни на Без Vision API / Vision CV.");
      }
      state.stockSearchCache.clear();
      state.visionVerifyCache.clear();
      if (isTurboNoVisionMode()) {
        state.queryHints = new Map();
      } else {
        try {
          state.queryHints = await generateQueryHints();
        } catch {
          state.queryHints = new Map();
        }
      }
      renderSegments();
      const modeLabel = isVisionApiMode()
        ? "Vision API (OpenAI)"
        : (isTurboNoVisionMode() ? "Turbo No Vision" : "Vision CV Deep (без API)");
      setProgress("Підбір контенту", 18, `Генерація контекстних запитів (${modeLabel})`);

      const uniqueQueries = [...new Set(state.segments.map((seg) => getSegmentQuery(seg).toLowerCase().trim()).filter(Boolean))];
      const prefetchKinds = mediaType === "video" ? ["video"] : mediaType === "image" ? ["image"] : ["video", "image"];
      const prefetchJobs = [];
      const stockErrors = [];
      for (const q of uniqueQueries) {
        for (const kind of prefetchKinds) {
          prefetchJobs.push({ q, kind });
        }
      }

      const threads = getEffectiveThreadCount();

      if (prefetchJobs.length) {
        await runWithConcurrency(
          prefetchJobs,
          async (job) => {
            const key = `${job.kind}::${job.q}`;
            if (state.stockSearchCache.has(key)) return;
            try {
              const response = await fetch("/api/stock/search", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  query: job.q,
                  mediaType: job.kind,
                  providers: stockConfig.providers,
                  pexelsApiKey: stockConfig.keys.pexelsApiKey,
                  pixabayApiKey: stockConfig.keys.pixabayApiKey,
                  language: el.language.value.trim() || "uk",
                  perPage: getStockPerPage()
                })
              });
              const data = await parseApiResponse(response, "Пошук на стоках");
              state.stockSearchCache.set(key, Array.isArray(data.assets) ? data.assets : []);
            } catch (error) {
              state.stockSearchCache.set(key, []);
              if (error?.message) stockErrors.push(error.message);
            }
          },
          threads
        );
      }
      setProgress("Підбір контенту", 27, `Кешування результатів (${threads} потоків)`);

      const reroll = Math.max(0, Number(state.rerollSeed || 0));
      const strictVision = isVisionApiMode() && Boolean(el.openaiKey.value.trim());
      const verificationMode = getStockVerificationMode();
      setProgress("Підбір контенту", 35, "Глобальний підбір зі стоків");
      const stockPicks = await assignStockAssetsGlobally({
        segments: state.segments,
        mediaType,
        stockConfig,
        allowAiFallback: !isTurboNoVisionMode() && Boolean(el.allowAiFallback?.checked),
        strictVision,
        reroll,
        verificationMode,
        onProgress: (done, total) => {
          const p = 35 + Math.round((done / Math.max(1, total)) * 55);
          setProgress("Підбір контенту", p, "Перевірка/підбір кадрів");
        }
      });
      setProgress("Підбір контенту", 92, "Фіналізація підбору");

      for (const pick of stockPicks) {
        rows.push({
          segment: pick.segment,
          asset: pick.asset,
          query: pick.query,
          reason: pick.reason || ""
        });
      }

      const sourceStat = rows.reduce((acc, row) => {
        const src = row?.asset?.source || "unknown";
        acc[src] = (acc[src] || 0) + 1;
        return acc;
      }, {});
      const srcText = Object.entries(sourceStat).map(([k, v]) => `${k}: ${v}`).join(", ");
      if (srcText) setStatus(`Підбір завершено. Джерела: ${srcText}`);
    }

    renderMatches(rows);
    if (!rows.length) {
      if (typeof stockErrors !== "undefined" && stockErrors.length) {
        const msg = String(stockErrors[0]).slice(0, 220);
        throw new Error(`Стоки повернули помилку: ${msg}`);
      }
      throw new Error("Не вдалося підібрати контент навіть у fallback-режимі. Перевір API ключі стоків і доступ до інтернету.");
    }
    state.rerollCounts.clear();
    setProgress("Підбір контенту", 100, `Елементів: ${rows.length}. Можна натискати "Змонтувати відео".`);
    return rows;
  } catch (error) {
    setStatus(error.message, true);
    return [];
  } finally {
    setWorkingState(false);
  }
}

async function renderMontage() {
  try {
    const audio = el.audioFile.files?.[0];
    if (!audio) throw new Error("Додай аудіофайл");
    if (!state.currentMatches.length) throw new Error("Спочатку підбери медіа");

    setProgress("Монтаж", 3, "Підготовка");
    setWorkingState(true);

    const timeline = state.currentMatches.map((row) => ({
      start: Number(row.segment.start || 0),
      end: Number(row.segment.end || 0),
      text: String(row.segment.text || ""),
      asset: {
        kind: row.asset.kind,
        source: row.asset.source,
        previewUrl: row.asset.previewUrl,
        fileIndex: Number.isInteger(row.asset.fileIndex) ? row.asset.fileIndex : null
      }
    }));

    const form = new FormData();
    form.append("audio", audio);
    form.append("timeline", JSON.stringify(timeline));
    form.append("montageSettings", JSON.stringify({
      language: String(el.language?.value || ""),
      focusLanguage: String(el.focusLanguage?.value || ""),
      preset: String(el.montagePreset?.value || "dynamic"),
      imageAnimationStyle: String(el.imageAnimStyle?.value || "combo"),
      imageAnimationStrength: Number(el.imageAnimStrength?.value || 2),
      transitionPack: String(el.transitionPack?.value || "dynamic"),
      transitionDuration: Number(el.transitionDuration?.value || 0.26),
      subtitlesEnabled: Boolean(el.subtitlesEnabled?.checked),
      proMontageMode: String(el.proMontageMode?.value || "auto"),
      proInsertDensity: String(el.proInsertDensity?.value || "medium"),
      proInsertTitle: Boolean(el.proInsertTitle?.checked),
      proInsertNumber: Boolean(el.proInsertNumber?.checked),
      proInsertDocument: Boolean(el.proInsertDocument?.checked),
      proInsertTimeline: Boolean(el.proInsertTimeline?.checked),
      proInsertPhotoFrame: Boolean(el.proInsertPhotoFrame?.checked),
      proInsertSplitScreen: Boolean(el.proInsertSplitScreen?.checked),
      proInsertBreakingNews: Boolean(el.proInsertBreakingNews?.checked),
      proInsertLocationStamp: Boolean(el.proInsertLocationStamp?.checked),
      proInsertChapterCard: Boolean(el.proInsertChapterCard?.checked),
      proInsertRedactedDoc: Boolean(el.proInsertRedactedDoc?.checked),
      proInsertTypewriter: Boolean(el.proInsertTypewriter?.checked),
      sfxEnabled: Boolean(el.sfxEnabled?.checked),
      sfxVolume: Number(el.sfxVolume?.value || 0.85),
      sfxPack: String(el.sfxPack?.value || "cinematic")
    }));

    if (el.sourceMode.value === "local") {
      for (const file of Array.from(state.selectedLocalFiles || [])) {
        form.append("localAssets", file);
      }
    }

    const response = await fetch("/api/montage/stream", {
      method: "POST",
      body: form
    });
    if (!response.ok || !response.body) {
      await parseApiResponse(response, "Монтаж");
      throw new Error("Помилка монтажу");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let donePayload = null;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        let evt;
        try {
          evt = JSON.parse(line);
        } catch {
          continue;
        }
        if (evt.type === "progress") {
          setProgress("Монтаж", Number(evt.percent || 0), evt.message || "");
        } else if (evt.type === "error") {
          throw new Error(evt.error || "Помилка монтажу");
        } else if (evt.type === "done") {
          donePayload = evt;
        }
      }
    }

    if (!donePayload?.url) {
      throw new Error("Монтаж не повернув фінальний файл");
    }
    const finalUrl = `${donePayload.url}?v=${Date.now()}`;

    el.renderResult.className = "render-result";
    el.renderResult.innerHTML = `
      <video src="${finalUrl}" controls></video>
      <a href="${finalUrl}" download="${escapeHtml(donePayload.filename || "montage.mp4")}">Завантажити змонтоване відео</a>
    `;

    setProgress("Монтаж", 100, "Готово. Можна завантажувати mp4.");
    return true;
  } catch (error) {
    setStatus(error.message, true);
    return false;
  } finally {
    setWorkingState(false);
  }
}

function collectMiniScenes() {
  const mode = String(el.miniSceneMode?.value || "auto");
  if (mode === "auto") {
    if (Array.isArray(state.segments) && state.segments.length) {
      return state.segments.map((s) => String(s.text || "").trim()).filter(Boolean);
    }
    return [];
  }
  return String(el.miniSceneLines?.value || "")
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);
}

async function runMiniMontage() {
  try {
    const audio = el.miniAudioFile?.files?.[0];
    const clips = Array.from(el.miniClipsFiles?.files || []);
    if (!audio) throw new Error("Додай аудіо для МініМонтажера");
    if (!clips.length) throw new Error("Додай хоча б 1 відеокліп для МініМонтажера");

    const scenes = collectMiniScenes();
    if ((el.miniSceneMode?.value || "auto") === "lines" && !scenes.length) {
      throw new Error("У режимі 'Ручний' додай тексти сцен (по рядку)");
    }

    setMiniStatus("МініМонтажер: підготовка...");
    if (el.miniRunBtn) el.miniRunBtn.disabled = true;
    resetMiniRenderResult();

    const form = new FormData();
    form.append("audio", audio);
    for (const clip of clips) form.append("clips", clip);
    form.append("resolution", String(el.miniResolution?.value || "1280x720"));
    form.append("sceneMode", String(el.miniSceneMode?.value || "auto"));
    form.append("scenes", JSON.stringify(scenes));

    const response = await fetch("/api/minimontage/run", {
      method: "POST",
      body: form
    });
    const data = await parseApiResponse(response, "МініМонтажер");
    if (!data?.url) throw new Error("МініМонтажер не повернув фінальний файл");

    const finalUrl = `${data.url}?v=${Date.now()}`;
    el.miniRenderResult.className = "render-result";
    el.miniRenderResult.innerHTML = `
      <video src="${finalUrl}" controls></video>
      <a href="${finalUrl}" download="${escapeHtml(data.filename || "mini_montage.mp4")}">Завантажити змонтоване відео</a>
    `;
    setMiniStatus(`МініМонтажер: 100%. Сцен: ${Number(data.scenesCount || 0)}, кліпів: ${Number(data.clipsCount || 0)}.`);
  } catch (error) {
    setMiniStatus(error.message || "Помилка МініМонтажера", true);
  } finally {
    if (el.miniRunBtn) el.miniRunBtn.disabled = false;
  }
}

async function runCutter() {
  let stopTicker = null;
  try {
    const youtubeUrl = String(el.cutYoutubeUrl?.value || "").trim();
    const videoFile = el.cutVideoFile?.files?.[0] || null;
    const useLocalFile = Boolean(videoFile);
    if (!youtubeUrl && !videoFile) throw new Error("Додай YouTube-посилання або локальний відеофайл");

    setCutStatus(useLocalFile ? "Нарізка: підготовка локального відео..." : "Нарізка: підготовка YouTube-відео...");
    if (el.cutRunBtn) el.cutRunBtn.disabled = true;
    resetCutResults();

    const segmentSeconds = getCutSegmentSeconds();
    const duration = useLocalFile ? await getLocalVideoDuration(videoFile) : 0;
    const estimatedSegments = duration ? Math.max(1, Math.ceil(duration / segmentSeconds)) : 0;
    const form = new FormData();
    if (videoFile) {
      form.append("videoFile", videoFile);
    } else if (youtubeUrl) {
      form.append("youtubeUrl", youtubeUrl);
    }
    form.append("segmentSeconds", String(segmentSeconds));
    form.append("projectLabel", String(el.cutProjectLabel?.value || "").trim());
    form.append("namingMode", String(el.cutNamingMode?.value || "auto"));
    form.append("captionMode", String(el.cutCaptionMode?.value || "blip"));

    let tickerStarted = false;
    const data = await postFormJsonWithUploadProgress("/api/cutter/run", form, "Нарізка", (upload) => {
      const percent = Math.min(100, Math.max(0, Math.round(upload)));
      if (percent < 100) {
        setCutStatus(`Нарізка: завантаження ${percent}%${estimatedSegments ? `. Далі ${estimatedSegments} фрагментів.` : ""}`);
        return;
      }
      if (!tickerStarted) {
        tickerStarted = true;
        stopTicker = startCutterTicker(estimatedSegments);
        if (!estimatedSegments) setCutStatus("Нарізка: відео завантажено, йде нарізка...");
      }
    });
    renderCutResults(data);
    setCutStatus(`Нарізка: 100%. Фрагментів: ${Number(data.clipsCount || 0)}.`);
  } catch (error) {
    setCutStatus(error.message || "Помилка нарізки", true);
  } finally {
    if (stopTicker) stopTicker();
    if (el.cutRunBtn) el.cutRunBtn.disabled = false;
  }
}

async function rerollSingleFrame(index, mode = "auto") {
  const idx = Number(index);
  if (!Number.isFinite(idx) || idx < 0 || idx >= state.currentMatches.length) return;

  const current = state.currentMatches[idx];
  if (!current?.segment) return;
  const segmentId = Number(current.segment.id ?? idx);
  const newCount = (state.rerollCounts.get(segmentId) || 0) + 1;
  state.rerollCounts.set(segmentId, newCount);

  try {
    setWorkingState(true);
    setStatus(`Оновлення кадру ${idx + 1} (спроба ${newCount})...`);

    if (mode === "ai" || (mode === "auto" && newCount >= 4)) {
      const forcedAiAsset = await generateAiImageForSegment(current.segment);
      if (!forcedAiAsset) throw new Error("Не вдалося згенерувати AI-кадр для цього сегмента");
      state.currentMatches[idx] = {
        ...current,
        asset: forcedAiAsset,
        reason: "manual-reroll-ai-forced"
      };
      renderMatches(state.currentMatches);
      setStatus(`Кадр ${idx + 1} оновлено AI.`);
      return;
    }

    if (el.sourceMode.value === "local") {
      const usageMap = new Map();
      const exclude = new Set();
      for (let i = 0; i < state.currentMatches.length; i += 1) {
        const row = state.currentMatches[i];
        if (!row?.asset) continue;
        if (i === idx && Number.isInteger(row.asset.fileIndex)) {
          exclude.add(row.asset.fileIndex);
          continue;
        }
        if (Number.isInteger(row.asset.fileIndex)) {
          usageMap.set(row.asset.fileIndex, (usageMap.get(row.asset.fileIndex) || 0) + 1);
        }
      }

      const forcedLocalType = mode === "video" ? "video" : mode === "image" ? "image" : el.mediaType.value;
      let newAsset = pickFromLocal(current.segment, forcedLocalType, usageMap, exclude);
      if (!newAsset) {
        newAsset = await generateAiImageForSegment(current.segment);
      }
      if (!newAsset) throw new Error("Не знайшов альтернативний локальний кадр і не вдалося згенерувати AI-кадр");
      state.currentMatches[idx] = {
        ...current,
        asset: newAsset,
        reason: newAsset.source === "generated" ? "manual-reroll-ai-fallback" : "manual-reroll-local"
      };
    } else {
      const usageMap = new Map();
      for (let i = 0; i < state.currentMatches.length; i += 1) {
        if (i === idx) continue;
        const row = state.currentMatches[i];
        const key = row?.asset?.previewUrl || row?.asset?.title || "";
        if (!key) continue;
        usageMap.set(key, (usageMap.get(key) || 0) + 1);
      }

      const exclude = new Set();
      const currentKey = current.asset?.previewUrl || current.asset?.title || "";
      if (currentKey) exclude.add(currentKey);

      const forcedType = mode === "video" ? "video" : mode === "image" ? "image" : el.mediaType.value;
      let { asset, query, reason } = await pickFromStock(current.segment, forcedType, usageMap, { excludeKeys: exclude, allowAiFallback: mode === "ai" || !isTurboNoVisionMode() });
      if (!asset) {
        asset = await generateAiImageForSegment(current.segment);
        reason = "manual-reroll-ai-fallback";
      }
      if (!asset) throw new Error("Не знайшов альтернативний сток-кадр і не вдалося згенерувати AI-кадр");
      state.currentMatches[idx] = {
        ...current,
        asset,
        query,
        reason: reason || "manual-reroll-stock"
      };
    }

    renderMatches(state.currentMatches);
    setStatus(`Кадр ${idx + 1} оновлено.`);
  } catch (error) {
    setStatus(error.message || "Не вдалося перегенерувати кадр", true);
  } finally {
    setWorkingState(false);
  }
}

async function runAutopilot() {
  if (state.autopilotRunning) return;
  state.autopilotRunning = true;
  setWorkingState(true);
  try {
    const okTranscribe = await transcribe();
    if (!okTranscribe) return;

    const rows = await matchAssets();
    if (!rows.length) {
      setStatus("Автопілот: не вдалося підібрати контент.", true);
      return;
    }

    const okRender = await renderMontage();
    if (!okRender) return;
    setStatus("Автопілот завершено: 100%. Відео готове.");
  } finally {
    state.autopilotRunning = false;
    setWorkingState(false);
  }
}

async function rerollMatches() {
  if (!state.segments.length) {
    setStatus("Спочатку зроби транскрипт", true);
    return;
  }
  state.rerollSeed += 1;
  setStatus(`Перепідбір #${state.rerollSeed}...`);
  await matchAssets();
}

el.sourceMode.addEventListener("change", updateModeUi);
el.visionMode?.addEventListener("change", updateModeUi);
el.openaiKey?.addEventListener("input", updateModeUi);
el.audioFile?.addEventListener("change", () => {
  resetAutopilotStateForNewAudio();
  setStatus("Нова озвучка вибрана. Натисни 'Автопілот' або 'Розпізнати озвучку'.");
});
el.focusLanguage?.addEventListener("change", async () => {
  if (!state.segments.length) {
    renderThemeInfo();
    return;
  }
  try {
    const focusHints = await generateFocusHints();
    state.segments = state.segments.map((seg) => ({
      ...seg,
      focus: focusHints.get(Number(seg.id)) || getSegmentFocus(seg)
    }));
    state.queryHints = new Map();
    renderSegments();
    renderThemeInfo();
    setStatus("Мову фокусу оновлено. Натисни 'Підібрати медіа' ще раз.");
  } catch {
    renderThemeInfo();
  }
});
el.splitMode.addEventListener("change", updateSplitModeUi);
el.transcribeBtn.addEventListener("click", transcribe);
el.matchBtn.addEventListener("click", matchAssets);
el.rerollBtn.addEventListener("click", rerollMatches);
el.renderBtn.addEventListener("click", renderMontage);
el.autopilotBtn.addEventListener("click", runAutopilot);
el.tabAutopilot?.addEventListener("click", () => switchMainTab("autopilot"));
el.tabCutter?.addEventListener("click", () => switchMainTab("cutter"));
el.miniRunBtn?.addEventListener("click", runMiniMontage);
el.cutRunBtn?.addEventListener("click", runCutter);
el.addLocalFilesBtn?.addEventListener("click", () => el.localFiles?.click());
el.addLocalFolderBtn?.addEventListener("click", () => el.localFolders?.click());
el.clearLocalFilesBtn?.addEventListener("click", clearLocalFilesSelection);
el.localFiles?.addEventListener("change", () => {
  appendLocalFiles(el.localFiles.files || []);
  if (el.localFiles) el.localFiles.value = "";
});
el.localFolders?.addEventListener("change", () => {
  appendLocalFiles(el.localFolders.files || []);
  if (el.localFolders) el.localFolders.value = "";
});
el.cutSegmentPreset?.addEventListener("change", () => {
  updateCutSegmentUi();
  saveUiSettings();
});
el.matches.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const idx = target.getAttribute("data-index");
  if (target.classList.contains("reroll-one")) {
    rerollSingleFrame(idx, "auto");
    return;
  }
  if (target.classList.contains("find-video")) {
    rerollSingleFrame(idx, "video");
    return;
  }
  if (target.classList.contains("find-image")) {
    rerollSingleFrame(idx, "image");
    return;
  }
  if (target.classList.contains("force-ai")) {
    rerollSingleFrame(idx, "ai");
  }
});

[
  el.language,
  el.focusLanguage,
  el.splitMode,
  el.fixedSeconds,
  el.sourceMode,
  el.mediaType,
  el.stockProvider,
  el.visionMode,
  el.localAnalyzeMode,
  el.montagePreset,
  el.imageAnimStyle,
  el.imageAnimStrength,
  el.transitionPack,
  el.transitionDuration,
  el.subtitlesEnabled,
  el.proMontageMode,
  el.proInsertDensity,
  el.proInsertTitle,
  el.proInsertNumber,
  el.proInsertDocument,
  el.proInsertTimeline,
  el.visionVerifyAllVideo,
  el.visionVerifyAllImage,
  el.allowAiFallback,
  el.openaiKey,
  el.pexelsKey,
  el.pixabayKey,
  el.cutYoutubeUrl,
  el.cutSegmentPreset,
  el.cutSegmentSeconds,
  el.cutProjectLabel,
  el.cutNamingMode,
  el.cutCaptionMode
].filter(Boolean).forEach((node) => {
  const eventName = node instanceof HTMLInputElement && node.type === "checkbox" ? "change" : "input";
  node.addEventListener(eventName, saveUiSettings);
  if (eventName !== "change") node.addEventListener("change", saveUiSettings);
});

// ─── BLIP lazy install controls ────────────────────────────────────────────
const blipUi = {
  card: document.getElementById("blipSetupCard"),
  status: document.getElementById("blipSetupStatus"),
  actions: document.getElementById("blipSetupActions"),
  installBtn: document.getElementById("blipInstallBtn"),
  progressWrap: document.getElementById("blipSetupProgress"),
  progressBar: document.getElementById("blipSetupProgressBar"),
  progressLog: document.getElementById("blipSetupProgressLog")
};

async function refreshBlipStatus() {
  if (!blipUi.card) return;
  try {
    const data = await fetch("/api/blip/status").then((r) => r.json());
    if (data.installed) {
      blipUi.status.textContent = "✅ BLIP встановлено — локальний аналіз готовий до роботи";
      blipUi.actions.classList.add("hidden");
      blipUi.progressWrap.classList.add("hidden");
      return true;
    }
    if (data.installing) {
      blipUi.status.textContent = "⏳ Триває установка...";
      blipUi.actions.classList.add("hidden");
      blipUi.progressWrap.classList.remove("hidden");
      blipUi.progressBar.style.width = `${data.progress}%`;
      // Reconnect to the SSE log stream is non-trivial; tail the snapshot instead.
      blipUi.progressLog.textContent = `${data.progress}% — установка триває у фоні...`;
      return false;
    }
    blipUi.status.textContent = data.location.includes("dev mode")
      ? "ℹ️ Dev режим — використовується .venv-blip з проєкту"
      : "BLIP не встановлено. Він потрібен тільки для локального AI-аналізу файлів.";
    blipUi.actions.classList.remove("hidden");
    blipUi.progressWrap.classList.add("hidden");
    if (data.error) {
      blipUi.progressLog.textContent = `Остання помилка: ${data.error}`;
      blipUi.progressWrap.classList.remove("hidden");
    }
    return false;
  } catch (e) {
    blipUi.status.textContent = `Не вдалось перевірити статус: ${e.message}`;
    return false;
  }
}

async function startBlipInstall() {
  if (!blipUi.installBtn) return;
  blipUi.installBtn.disabled = true;
  blipUi.actions.classList.add("hidden");
  blipUi.progressWrap.classList.remove("hidden");
  blipUi.status.textContent = "⏳ Установка стартувала. Не закривай аппку (можна згорнути).";
  blipUi.progressBar.style.width = "0%";
  blipUi.progressLog.textContent = "Стартуємо...";

  try {
    const resp = await fetch("/api/blip/install", { method: "POST" });
    if (!resp.ok || !resp.body) {
      const err = await resp.json().catch(() => ({ error: "Невідома помилка" }));
      throw new Error(err.error || `HTTP ${resp.status}`);
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE events are split by blank lines. Process each complete event.
      const events = buffer.split("\n\n");
      buffer = events.pop() || "";
      for (const evt of events) {
        const dataLine = evt.split("\n").find((l) => l.startsWith("data:"));
        if (!dataLine) continue;
        try {
          const payload = JSON.parse(dataLine.slice(5).trim());
          if (payload.progress != null) blipUi.progressBar.style.width = `${payload.progress}%`;
          if (payload.log) blipUi.progressLog.textContent = payload.log;
          if (payload.done) {
            blipUi.status.textContent = "✅ BLIP готовий до використання!";
            blipUi.installBtn.disabled = false;
            await refreshBlipStatus();
            return;
          }
          if (payload.error) {
            throw new Error(payload.error);
          }
        } catch (parseErr) {
          // Bad SSE event — keep going.
          console.warn("BLIP SSE parse:", parseErr);
        }
      }
    }
  } catch (err) {
    blipUi.status.textContent = `❌ Помилка установки: ${err.message}`;
    blipUi.actions.classList.remove("hidden");
    blipUi.installBtn.disabled = false;
  }
}

blipUi.installBtn?.addEventListener("click", startBlipInstall);

restoreUiSettings();
updateModeUi();
updateSplitModeUi();
renderSegments();
renderMatches([]);
renderThemeInfo();
resetRenderResult();
resetMiniRenderResult();
resetCutResults();
updateCutSegmentUi();
switchMainTab("autopilot");
updateLocalFilesSummary();
refreshBlipStatus();
