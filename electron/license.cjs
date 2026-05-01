// License management. Calls a Cloudflare Worker (configured via
// LICENSE_VALIDATION_URL env or hardcoded fallback) to validate a key,
// then caches a session token in userData/license.json for offline use.
//
// To replace the validator URL: deploy the Worker in worker/ and update
// VALIDATION_URL below (or set env var when launching).

const fs = require("fs");
const path = require("path");

// 🔧 SET THIS to your deployed Worker URL after wrangler deploy.
// Until then the app stays in "any-key-works" dev mode (handy for testing).
const VALIDATION_URL = process.env.LICENSE_VALIDATION_URL || "https://fr1ge-studio-license.n682ypzdth.workers.dev";

// Token cached locally is good for 7 days; after that re-validate.
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function tokenPath(userDataDir) {
  return path.join(userDataDir, "license.json");
}

function readToken(userDataDir) {
  try {
    const raw = fs.readFileSync(tokenPath(userDataDir), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeToken(userDataDir, token) {
  try {
    fs.writeFileSync(tokenPath(userDataDir), JSON.stringify(token, null, 2));
    return true;
  } catch {
    return false;
  }
}

function clearToken(userDataDir) {
  try { fs.unlinkSync(tokenPath(userDataDir)); } catch { /* ignore */ }
}

// True if the cached token is still valid for offline use.
function hasValidCachedSession(userDataDir) {
  const token = readToken(userDataDir);
  if (!token || !token.validUntil) return false;
  return Date.now() < Number(token.validUntil);
}

// Call the Worker. If VALIDATION_URL is empty, accept any non-empty key
// (dev/test mode). The Worker should respond with { valid: bool, error?: string,
// userLabel?: string, expiresAt?: ms_timestamp }.
async function validateKey(key) {
  const trimmed = String(key || "").trim();
  if (!trimmed) return { valid: false, error: "Порожній ключ" };

  if (!VALIDATION_URL) {
    // No remote validator configured → accept anything for dev. Visible to
    // the user as "test mode" indirectly: the worker URL is just unset.
    return { valid: true, userLabel: "dev", source: "dev-mode" };
  }

  try {
    const response = await fetch(VALIDATION_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: trimmed })
    });
    if (!response.ok) {
      return { valid: false, error: `Сервер повернув ${response.status}` };
    }
    const data = await response.json().catch(() => ({}));
    return {
      valid: Boolean(data.valid),
      error: data.error,
      userLabel: data.userLabel,
      expiresAt: Number(data.expiresAt) || 0
    };
  } catch (e) {
    return { valid: false, error: `Мережева помилка: ${String(e?.message || e)}` };
  }
}

// Save a successful validation to disk so subsequent launches skip the splash.
function persistSession(userDataDir, key, validationResult) {
  const validUntil = validationResult.expiresAt || (Date.now() + TOKEN_TTL_MS);
  writeToken(userDataDir, {
    key,
    userLabel: validationResult.userLabel || "",
    validatedAt: Date.now(),
    validUntil,
    source: validationResult.source || "remote"
  });
}

module.exports = {
  hasValidCachedSession,
  validateKey,
  persistSession,
  clearToken
};
