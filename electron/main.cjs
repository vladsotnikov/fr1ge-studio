// Electron entry point for VoiceStockStudio.
// Launches the existing Express server (server.js) on a random local port,
// then opens a BrowserWindow pointed at it. The user sees a native desktop
// app; under the hood it's the same UI/server we run in dev.
//
// Why CJS not ESM: Electron's main process loads .cjs cleanly without the
// dual-package quirks that "type":"module" introduces for binary tools.

const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const http = require("http");
const license = require("./license.cjs");

const isDev = !app.isPackaged;
// In production, the spawned server.js needs sibling node_modules + package.json
// (with "type":"module") + public/ + tools/. asarUnpack puts all of those into
// app.asar.unpacked/ so Node can resolve imports normally there.
const PROJECT_ROOT = isDev
  ? path.join(__dirname, "..")
  : path.join(process.resourcesPath, "app.asar.unpacked");
const SERVER_SCRIPT = path.join(PROJECT_ROOT, "server.js");

// Resolve bundled FFmpeg/FFprobe binaries. ffmpeg-static ships a single binary
// for the build host's platform; ffprobe-static ships per-platform. We also
// support a manually-bundled tools/ffmpeg/<platform>/ffmpeg for cross-platform
// builds (where ffmpeg-static's host-only binary isn't enough).
function resolveBundledFfmpeg() {
  const platDir =
    process.platform === "darwin" ? `darwin-${process.arch}` :
    process.platform === "win32"  ? "win32-x64" :
                                    `linux-${process.arch}`;

  const candidates = {
    ffmpeg: [
      path.join(PROJECT_ROOT, "tools", "ffmpeg", platDir, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg"),
      path.join(PROJECT_ROOT, "node_modules", "ffmpeg-static", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg")
    ],
    ffprobe: [
      path.join(PROJECT_ROOT, "tools", "ffmpeg", platDir, process.platform === "win32" ? "ffprobe.exe" : "ffprobe"),
      path.join(PROJECT_ROOT, "node_modules", "ffprobe-static", "bin",
        process.platform === "win32" ? "win32" : (process.platform === "darwin" ? "darwin" : "linux"),
        process.arch === "arm64" ? "arm64" : "x64",
        process.platform === "win32" ? "ffprobe.exe" : "ffprobe")
    ]
  };

  const pickExisting = (paths) => paths.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || "";
  return {
    ffmpeg: pickExisting(candidates.ffmpeg),
    ffprobe: pickExisting(candidates.ffprobe)
  };
}

// Bundled yt-dlp binary. Single macOS universal binary covers arm64+x64.
function resolveBundledYtDlp() {
  const subdir =
    process.platform === "darwin" ? "macos" :
    process.platform === "win32"  ? "win32-x64" :
                                    "linux-x64";
  const filename = process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp";
  const full = path.join(PROJECT_ROOT, "tools", "yt-dlp", subdir, filename);
  try { return fs.existsSync(full) ? full : ""; } catch { return ""; }
}

// Random local port so two instances don't collide; keeps us off the user's
// dev port (3333) too.
function pickPort() {
  return 30000 + Math.floor(Math.random() * 20000);
}

let serverProcess = null;
let mainWindow = null;
const PORT = pickPort();

function startServer() {
  const { ffmpeg, ffprobe } = resolveBundledFfmpeg();
  const ytDlp = resolveBundledYtDlp();
  // Persistent storage for runtime-installed components (BLIP venv + models).
  const userDataDir = app.getPath("userData");
  // Persistent log so users can share what crashed when there's no terminal.
  const logFile = path.join(userDataDir, "server.log");
  let logStream = null;
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    logStream = fs.createWriteStream(logFile, { flags: "w" });
    logStream.write(`=== Fr1Ge STUDIO server start @ ${new Date().toISOString()} ===\n`);
    logStream.write(`platform=${process.platform} arch=${process.arch}\n`);
    logStream.write(`PROJECT_ROOT=${PROJECT_ROOT}\n`);
    logStream.write(`SERVER_SCRIPT=${SERVER_SCRIPT}\n`);
    logStream.write(`FFMPEG=${ffmpeg || "(none)"}\n`);
    logStream.write(`FFPROBE=${ffprobe || "(none)"}\n`);
    logStream.write(`YT_DLP=${ytDlp || "(none)"}\n\n`);
  } catch (e) { /* logging is best-effort */ }
  if (isDev) {
    console.log("[VSS] FFmpeg:", ffmpeg || "(system)");
    console.log("[VSS] FFprobe:", ffprobe || "(system)");
    console.log("[VSS] yt-dlp:", ytDlp || "(system)");
    console.log("[VSS] userData:", userDataDir);
    console.log("[VSS] Log file:", logFile);
  }

  return new Promise((resolve, reject) => {
    serverProcess = spawn(process.execPath, [SERVER_SCRIPT], {
      env: {
        ...process.env,
        PORT: String(PORT),
        HOST: "127.0.0.1",
        ...(ffmpeg ? { FFMPEG_BIN: ffmpeg } : {}),
        ...(ffprobe ? { FFPROBE_BIN: ffprobe } : {}),
        ...(ytDlp ? { YT_DLP_BIN: ytDlp } : {}),
        VSS_USER_DATA_DIR: userDataDir,
        ELECTRON_RUN_AS_NODE: "1"
      },
      cwd: PROJECT_ROOT,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stderr = "";
    serverProcess.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      logStream?.write(chunk);
      if (isDev) process.stderr.write(chunk);
    });
    serverProcess.stdout.on("data", (chunk) => {
      logStream?.write(chunk);
      if (isDev) process.stdout.write(chunk);
    });

    serverProcess.on("error", (err) => {
      logStream?.write(`\n[spawn error] ${err.message}\n`);
      reject(err);
    });
    serverProcess.on("exit", (code) => {
      logStream?.write(`\n[exit] code=${code}\n`);
      if (code !== 0 && !mainWindow) {
        reject(new Error(`Server exited (${code}).\nЛог: ${logFile}\n\n${stderr.slice(0, 600)}`));
      }
    });

    // Poll the server until it accepts a connection. Server boot takes ~0.5-2s.
    const startTime = Date.now();
    const tryConnect = () => {
      const req = http.get(`http://127.0.0.1:${PORT}/`, (res) => {
        res.resume();
        resolve();
      });
      req.on("error", () => {
        if (Date.now() - startTime > 20000) {
          reject(new Error(`Server didn't start within 20s. ${stderr.slice(0, 400)}`));
          return;
        }
        setTimeout(tryConnect, 250);
      });
      req.setTimeout(2000, () => req.destroy());
    };
    setTimeout(tryConnect, 400);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#eef3f8",
    title: "Fr1Ge STUDIO",
    icon: path.join(__dirname, "icon.png"),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadURL(`http://127.0.0.1:${PORT}/`);
  mainWindow.on("closed", () => { mainWindow = null; });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  if (serverProcess && !serverProcess.killed) serverProcess.kill();
});

// ─── License gate ────────────────────────────────────────────────────────────
// Splash window asks for a license key. On success → save token → open main.
// Cached token (7 days) lets the user skip splash on subsequent launches.
let splashWindow = null;

function createSplash() {
  const iconPath = path.join(__dirname, "icon.png");
  splashWindow = new BrowserWindow({
    width: 460,
    height: 380,
    resizable: false,
    fullscreenable: false,
    minimizable: false,
    maximizable: false,
    title: "Fr1Ge STUDIO",
    icon: iconPath,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "splash-preload.cjs")
    }
  });
  splashWindow.removeMenu?.();
  splashWindow.loadFile(path.join(__dirname, "splash.html"));
  splashWindow.on("closed", () => { splashWindow = null; });
}

ipcMain.handle("license:validate", async (_evt, key) => {
  const result = await license.validateKey(key);
  if (result.valid) {
    license.persistSession(app.getPath("userData"), key, result);
  }
  return result;
});

ipcMain.on("license:accepted", async () => {
  // Close splash → start server → open main.
  if (splashWindow) splashWindow.close();
  try {
    await startServer();
    createWindow();
  } catch (err) {
    dialog.showErrorBox("Fr1Ge STUDIO failed to start", String(err?.message || err));
    app.quit();
  }
});

app.whenReady().then(async () => {
  // Returning user with valid cached session → skip splash entirely.
  if (license.hasValidCachedSession(app.getPath("userData"))) {
    try {
      await startServer();
      createWindow();
    } catch (err) {
      dialog.showErrorBox("Fr1Ge STUDIO failed to start", String(err?.message || err));
      app.quit();
    }
    return;
  }
  // First launch (or expired session) → show splash.
  createSplash();
});
