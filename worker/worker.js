// Cloudflare Worker for Fr1Ge STUDIO licenses + admin panel.
//
// Routes:
//   POST /              → validate license key (used by the app)
//   GET  /admin         → admin HTML page (password-gated client-side)
//   POST /admin/list    → list all keys (Bearer auth required)
//   POST /admin/add     → generate a new license key
//   POST /admin/update  → toggle revoked / change user label
//   POST /admin/delete  → remove a key
//
// KV namespace: VSS_KEYS
//   key = "vss-xxxx-xxxx-xxxx"
//   value = { user: string, revoked: bool, created: ISO date }
//
// Worker secret: ADMIN_TOKEN
//   Set with: wrangler secret put ADMIN_TOKEN
//   Used as Bearer token by the admin panel.

const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;  // 7 days

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization"
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }

    // Public license validation (used by the app)
    if (url.pathname === "/" && request.method === "POST") {
      return validateLicense(request, env);
    }

    // Admin HTML page
    if (url.pathname === "/admin" && request.method === "GET") {
      return new Response(ADMIN_HTML, {
        headers: { "Content-Type": "text/html; charset=utf-8" }
      });
    }

    // Admin API endpoints (require Bearer token)
    if (url.pathname.startsWith("/admin/")) {
      const authError = checkAdminAuth(request, env);
      if (authError) return authError;

      if (url.pathname === "/admin/list" && request.method === "POST") return listKeys(env);
      if (url.pathname === "/admin/add" && request.method === "POST") return addKey(request, env);
      if (url.pathname === "/admin/update" && request.method === "POST") return updateKey(request, env);
      if (url.pathname === "/admin/delete" && request.method === "POST") return deleteKey(request, env);
    }

    return jsonResponse({ error: "Not found" }, 404);
  }
};

// ─── License validation (public) ──────────────────────────────────────────────
async function validateLicense(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return jsonResponse({ valid: false, error: "Bad JSON" }, 400); }

  const key = String(body?.key || "").trim();
  if (!key) return jsonResponse({ valid: false, error: "Empty key" }, 400);

  let record;
  try {
    const raw = await env.VSS_KEYS.get(key);
    record = raw ? JSON.parse(raw) : null;
  } catch {
    return jsonResponse({ valid: false, error: "KV read error" }, 500);
  }

  if (!record) return jsonResponse({ valid: false, error: "Ключ не знайдено" });
  if (record.revoked === true) return jsonResponse({ valid: false, error: "Доступ відкликано" });

  return jsonResponse({
    valid: true,
    userLabel: record.user || "",
    expiresAt: Date.now() + TOKEN_TTL_MS
  });
}

// ─── Admin auth ───────────────────────────────────────────────────────────────
function checkAdminAuth(request, env) {
  const expected = env.ADMIN_TOKEN;
  if (!expected) return jsonResponse({ error: "ADMIN_TOKEN не задано на сервері" }, 500);

  const auth = request.headers.get("Authorization") || "";
  const match = auth.match(/^Bearer\s+(.+)$/);
  if (!match || match[1] !== expected) {
    return jsonResponse({ error: "Невірний пароль" }, 401);
  }
  return null;  // ok
}

// ─── Admin API ────────────────────────────────────────────────────────────────
async function listKeys(env) {
  const list = await env.VSS_KEYS.list();
  const results = await Promise.all(
    list.keys.map(async (entry) => {
      const raw = await env.VSS_KEYS.get(entry.name);
      const record = raw ? JSON.parse(raw) : {};
      return { key: entry.name, ...record };
    })
  );
  return jsonResponse({ keys: results.sort((a, b) => (a.created || "").localeCompare(b.created || "")) });
}

async function addKey(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return jsonResponse({ error: "Bad JSON" }, 400); }

  const userLabel = String(body?.user || "").trim() || "(no name)";
  const newKey = generateKey();
  const record = {
    user: userLabel,
    revoked: false,
    created: new Date().toISOString().slice(0, 10)
  };
  await env.VSS_KEYS.put(newKey, JSON.stringify(record));
  return jsonResponse({ key: newKey, ...record });
}

async function updateKey(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return jsonResponse({ error: "Bad JSON" }, 400); }

  const key = String(body?.key || "").trim();
  if (!key) return jsonResponse({ error: "key required" }, 400);

  const raw = await env.VSS_KEYS.get(key);
  if (!raw) return jsonResponse({ error: "Not found" }, 404);
  const record = JSON.parse(raw);
  if (typeof body.revoked === "boolean") record.revoked = body.revoked;
  if (typeof body.user === "string") record.user = body.user;
  await env.VSS_KEYS.put(key, JSON.stringify(record));
  return jsonResponse({ key, ...record });
}

async function deleteKey(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return jsonResponse({ error: "Bad JSON" }, 400); }

  const key = String(body?.key || "").trim();
  if (!key) return jsonResponse({ error: "key required" }, 400);
  await env.VSS_KEYS.delete(key);
  return jsonResponse({ deleted: key });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function generateKey() {
  // Format: vss-xxxx-xxxx-xxxx (12 hex chars in 3 groups)
  const buf = new Uint8Array(6);
  crypto.getRandomValues(buf);
  const hex = [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `vss-${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}`;
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS }
  });
}

// ─── Admin HTML (single-page) ─────────────────────────────────────────────────
const ADMIN_HTML = `<!doctype html>
<html lang="uk">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Fr1Ge STUDIO — Admin</title>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font: 14px/1.5 -apple-system, "Segoe UI", "Avenir Next", sans-serif;
    color: #13212f;
    background: radial-gradient(circle at 15% -10%, #f8d4b4 0, transparent 40%),
                radial-gradient(circle at 90% 100%, #c7def8 0, transparent 35%),
                #eef3f8;
    min-height: 100vh;
    padding: 24px 20px;
  }
  .wrap { max-width: 980px; margin: 0 auto; }
  .kicker { margin: 0; font-size: 11px; letter-spacing: .14em; color: #0b5cab; font-weight: 700; }
  h1 { margin: 4px 0 16px; font-size: 28px; }
  .card {
    background: #fdfefe;
    border: 1px solid #bdd0e0;
    border-radius: 16px;
    padding: 20px;
    margin-bottom: 14px;
  }
  .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  input, button {
    padding: 10px 12px;
    border-radius: 10px;
    border: 1px solid #bdd0e0;
    font: inherit;
    background: #fff;
  }
  input:focus { outline: 2px solid #0b5cab; outline-offset: -1px; }
  button { cursor: pointer; transition: filter .12s ease; }
  button:hover { filter: brightness(1.06); }
  button.primary { background: #0b5cab; color: #fff; border-color: #074a8a; font-weight: 700; }
  button.danger  { background: #fff; color: #dc2626; border-color: #fca5a5; }
  button.success { background: #fff; color: #15803d; border-color: #86efac; }
  button:disabled { opacity: .5; cursor: not-allowed; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 10px 8px; border-bottom: 1px solid #e5edf5; }
  th { font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: #4e6479; }
  td.key { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
  .badge { display: inline-block; padding: 3px 8px; border-radius: 99px; font-size: 12px; font-weight: 600; }
  .badge.active  { background: #dcfce7; color: #15803d; }
  .badge.revoked { background: #fee2e2; color: #dc2626; }
  .actions { display: flex; gap: 6px; }
  .actions button { padding: 6px 10px; font-size: 12px; }
  .empty { text-align: center; color: #4e6479; padding: 40px 0; }
  .muted { color: #4e6479; font-size: 13px; }
  .toast {
    position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
    background: #0b5cab; color: #fff; padding: 10px 16px; border-radius: 10px;
    box-shadow: 0 4px 16px rgba(11,92,171,.3);
    opacity: 0; transition: opacity .2s; pointer-events: none;
  }
  .toast.show { opacity: 1; }
  .login-card { max-width: 400px; margin: 80px auto 0; }
  .hidden { display: none !important; }
  .copy { cursor: pointer; }
  .copy:hover { background: #f3f8fc; }
</style>
</head>
<body>
<div class="wrap">
  <p class="kicker">FR1GE Studio</p>
  <h1>Адмін-панель ліцензій</h1>

  <div id="loginCard" class="card login-card">
    <p class="muted">Введи admin-токен (значення ADMIN_TOKEN).</p>
    <div class="row">
      <input id="loginToken" type="password" placeholder="admin token" style="flex:1; min-width: 200px;" autofocus>
      <button class="primary" id="loginBtn">Увійти</button>
    </div>
    <p id="loginError" class="muted" style="color:#dc2626; min-height: 18px; margin: 8px 0 0;"></p>
  </div>

  <div id="mainPanel" class="hidden">
    <div class="card">
      <div class="row" style="justify-content: space-between;">
        <div><strong id="statTotal">0</strong> ключів</div>
        <div class="row">
          <input id="newUserLabel" type="text" placeholder="Імʼя/email юзера" style="min-width: 200px;">
          <button class="primary" id="addBtn">+ Згенерувати ключ</button>
        </div>
      </div>
    </div>

    <div class="card">
      <table id="keysTable">
        <thead>
          <tr>
            <th>Ключ</th>
            <th>Юзер</th>
            <th>Статус</th>
            <th>Створено</th>
            <th></th>
          </tr>
        </thead>
        <tbody id="keysBody"></tbody>
      </table>
      <div id="emptyState" class="empty hidden">Поки нема жодного ключа. Створи перший вище.</div>
    </div>

    <div class="card">
      <div class="row" style="justify-content: space-between;">
        <span class="muted">Зміни синхронізуються з KV за ~60с.</span>
        <button id="logoutBtn">Вийти</button>
      </div>
    </div>
  </div>
</div>

<div id="toast" class="toast"></div>

<script>
let token = sessionStorage.getItem("vss_admin_token") || "";

const $ = (id) => document.getElementById(id);
const loginCard = $("loginCard");
const mainPanel = $("mainPanel");

function showToast(msg, kind = "ok") {
  const t = $("toast");
  t.textContent = msg;
  t.style.background = kind === "error" ? "#dc2626" : "#0b5cab";
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2200);
}

async function api(path, body) {
  const resp = await fetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + token
    },
    body: JSON.stringify(body || {})
  });
  if (resp.status === 401) {
    sessionStorage.removeItem("vss_admin_token");
    token = "";
    showLogin("Сесія завершена або невірний токен");
    throw new Error("Unauthorized");
  }
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error || "HTTP " + resp.status);
  }
  return resp.json();
}

function showLogin(errorMsg = "") {
  loginCard.classList.remove("hidden");
  mainPanel.classList.add("hidden");
  $("loginError").textContent = errorMsg;
  $("loginToken").value = "";
  $("loginToken").focus();
}

function showMain() {
  loginCard.classList.add("hidden");
  mainPanel.classList.remove("hidden");
  refresh();
}

async function login() {
  const value = $("loginToken").value.trim();
  if (!value) { $("loginError").textContent = "Введи токен"; return; }
  token = value;
  try {
    await api("/admin/list");
    sessionStorage.setItem("vss_admin_token", token);
    showMain();
  } catch (e) {
    if (e.message !== "Unauthorized") $("loginError").textContent = e.message;
  }
}

async function refresh() {
  try {
    const data = await api("/admin/list");
    const keys = data.keys || [];
    $("statTotal").textContent = keys.length;
    const body = $("keysBody");
    body.innerHTML = "";
    if (!keys.length) {
      $("emptyState").classList.remove("hidden");
      return;
    }
    $("emptyState").classList.add("hidden");
    for (const k of keys) {
      const tr = document.createElement("tr");
      tr.innerHTML = \`
        <td class="key copy" title="Клікни щоб скопіювати">\${k.key}</td>
        <td>\${escapeHtml(k.user || "—")}</td>
        <td>\${k.revoked
          ? '<span class="badge revoked">Відкликано</span>'
          : '<span class="badge active">Активний</span>'}</td>
        <td class="muted">\${k.created || "—"}</td>
        <td><div class="actions">
          \${k.revoked
            ? \`<button class="success" data-act="restore" data-key="\${k.key}">Активувати</button>\`
            : \`<button class="danger"  data-act="revoke"  data-key="\${k.key}">Відкликати</button>\`}
          <button class="danger" data-act="delete" data-key="\${k.key}">Видалити</button>
        </div></td>
      \`;
      body.appendChild(tr);
    }
  } catch (e) {
    if (e.message !== "Unauthorized") showToast(e.message, "error");
  }
}

async function addKey() {
  const user = $("newUserLabel").value.trim();
  if (!user) { showToast("Введи імʼя юзера", "error"); return; }
  $("addBtn").disabled = true;
  try {
    const data = await api("/admin/add", { user });
    await navigator.clipboard.writeText(data.key).catch(() => {});
    showToast("Ключ створено і скопійовано в буфер: " + data.key);
    $("newUserLabel").value = "";
    refresh();
  } catch (e) {
    showToast(e.message, "error");
  } finally {
    $("addBtn").disabled = false;
  }
}

async function tableClick(evt) {
  const btn = evt.target.closest("button[data-act]");
  if (btn) {
    const key = btn.dataset.key;
    const act = btn.dataset.act;
    if (act === "delete" && !confirm("Видалити ключ " + key + " остаточно?")) return;
    btn.disabled = true;
    try {
      if (act === "revoke")  await api("/admin/update", { key, revoked: true });
      if (act === "restore") await api("/admin/update", { key, revoked: false });
      if (act === "delete")  await api("/admin/delete", { key });
      showToast("Зроблено");
      refresh();
    } catch (e) {
      showToast(e.message, "error");
      btn.disabled = false;
    }
    return;
  }
  const cell = evt.target.closest("td.key");
  if (cell) {
    const key = cell.textContent.trim();
    navigator.clipboard.writeText(key).catch(() => {});
    showToast("Скопійовано: " + key);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[c]);
}

$("loginBtn").addEventListener("click", login);
$("loginToken").addEventListener("keydown", (e) => { if (e.key === "Enter") login(); });
$("addBtn").addEventListener("click", addKey);
$("newUserLabel").addEventListener("keydown", (e) => { if (e.key === "Enter") addKey(); });
$("keysBody").addEventListener("click", tableClick);
$("logoutBtn").addEventListener("click", () => {
  sessionStorage.removeItem("vss_admin_token");
  token = "";
  showLogin();
});

if (token) {
  api("/admin/list").then(showMain).catch((e) => {
    if (e.message === "Unauthorized") return;  // showLogin вже викликався
    showLogin(e.message);
  });
} else {
  showLogin();
}
</script>
</body>
</html>`;
