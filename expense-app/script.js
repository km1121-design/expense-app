"use strict";

/* =========================================================================
 * 経費申請アプリ
 *
 * モード:
 *   - クラウドモード（⚙️でWebアプリURLを設定）:
 *       ログイン必須。申請データ → Googleスプレッドシート、領収書画像 → ドライブ。
 *       権限: user = 自分の申請のみ / admin = 全件・承認・ユーザー管理。
 *       localStorage は読み取りキャッシュ／オフライン時の再送信キュー。
 *   - ローカルモード（未設定）: 認証なしの試用モード。この端末にのみ保存。
 * ========================================================================= */

const STORE_KEY = "expense-app:expenses"; // ローカルキャッシュ
const USER_KEY = "expense-app:currentUser"; // ローカルモードの氏名
const CONFIG_KEY = "expense-app:config";
const QUEUE_KEY = "expense-app:queue"; // 未同期の作成申請
const SESSION_KEY = "expense-app:session"; // クラウドモードのセッション

const state = {
  expenses: [],
  currentUser: "", // ローカルモードの氏名
  isAdmin: false,
  activeTab: "apply",
  lastImageThumb: null,
  lastImageFile: null,
  config: { endpoint: "" },
  session: null, // { token, user:{username,displayName,role,department} }
  departments: [], // 登録済み事業部の一覧（申請フォームの候補）
  authEnabled: false,
  autoApprove: false, // クラウド側の自動承認モード
  personalMonth: "", // "yyyy-MM" または "all"
  adminMonth: "",
  syncStatus: "local",
};

const cloudEnabled = () => !!state.config.endpoint;
const isCloudAuthed = () => cloudEnabled() && !!state.session;

/* ---------- storage ---------- */
function loadConfig() {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (raw) state.config = { endpoint: "", ...JSON.parse(raw) };
  } catch {
    /* noop */
  }
}
function saveConfig() {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(state.config));
}
function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    state.session = raw ? JSON.parse(raw) : null;
  } catch {
    state.session = null;
  }
}
function saveSession() {
  if (state.session) {
    localStorage.setItem(SESSION_KEY, JSON.stringify(state.session));
  } else {
    localStorage.removeItem(SESSION_KEY);
  }
}
function loadCache() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    state.expenses = raw ? JSON.parse(raw) : [];
  } catch {
    state.expenses = [];
  }
}
function saveCache() {
  localStorage.setItem(STORE_KEY, JSON.stringify(state.expenses));
}
function loadQueue() {
  try {
    return JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]");
  } catch {
    return [];
  }
}
function saveQueue(q) {
  localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
}

/* ---------- helpers ---------- */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function yen(n) {
  return "¥" + (Number(n) || 0).toLocaleString("ja-JP");
}
function uid() {
  return "e" + Date.now().toString(36) + Math.floor(performance.now()).toString(36);
}
function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
const STATUS_LABEL = { pending: "申請中", approved: "承認済み", rejected: "却下" };

let toastTimer = null;
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3200);
}

/** シート由来のISO日時文字列を yyyy-MM-dd へ整形（既に日付形式ならそのまま） */
function normalizeDateStr(v) {
  if (!v) return "";
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/* ---------- 月表示ヘルパー ---------- */
function currentMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
function shiftMonth(m, delta) {
  const [y, mo] = m.split("-").map(Number);
  const d = new Date(y, mo - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
function inMonth(e, m) {
  return m === "all" || (e.date || "").startsWith(m);
}

function normalizeRecord(r) {
  return {
    id: r.id,
    applicant: r.applicant || "",
    applicantId: r.applicantId || "",
    department: r.department || "",
    date: normalizeDateStr(r.date),
    category: r.category || "",
    vendor: r.vendor || "",
    amount: Number(r.amount) || 0,
    description: r.description || "",
    imageThumb: r.imageThumb || null,
    imageUrl: r.imageUrl || "",
    imageFileId: r.imageFileId || "",
    status: r.status || "pending",
    createdAt: r.createdAt || "",
    reviewedAt: r.reviewedAt || null,
    reviewer: r.reviewer || null,
    reviewComment: r.reviewComment || null,
  };
}

/* =========================================================================
 * クラウドAPI（Google Apps Script Web App）
 *   POST は text/plain で送信し CORS プリフライトを回避
 * ========================================================================= */

class AuthError extends Error {}

async function apiPost(payload) {
  const body = { ...payload };
  if (state.session && body.token === undefined) body.token = state.session.token;
  const res = await fetch(state.config.endpoint, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) {
    if (String(data.error).includes("unauthorized")) throw new AuthError("unauthorized");
    throw new Error(data.error || "APIエラー");
  }
  return data;
}

async function apiGet() {
  const token = state.session ? state.session.token : "";
  const url =
    state.config.endpoint + (token ? "?token=" + encodeURIComponent(token) : "");
  const res = await fetch(url);
  const data = await res.json();
  if (!data.ok) {
    if (String(data.error).includes("unauthorized")) throw new AuthError("unauthorized");
    throw new Error(data.error || "APIエラー");
  }
  return (data.records || []).map(normalizeRecord);
}

/* ---------- 同期ステータス表示 ---------- */
function setSync(status) {
  state.syncStatus = status;
  const badge = $("#syncBadge");
  const map = {
    local: { text: "ローカルのみ", cls: "" },
    syncing: { text: "同期中…", cls: "is-syncing" },
    synced: { text: "クラウド同期済み", cls: "is-synced" },
    error: { text: "同期エラー", cls: "is-error" },
  };
  const m = map[status] || map.local;
  badge.textContent = m.text;
  badge.className = "sync-badge " + m.cls;
}

function updatePendingUI() {
  const n = loadQueue().length;
  const btn = $("#reSyncBtn");
  btn.hidden = !(cloudEnabled() && n > 0);
  btn.textContent = `再同期 (${n})`;
}

/* ---------- リポジトリ層 ---------- */
async function refreshFromCloud() {
  if (!cloudEnabled()) {
    loadCache();
    setSync("local");
    render();
    return;
  }
  setSync("syncing");
  try {
    state.expenses = await apiGet();
    saveCache();
    setSync("synced");
    await flushQueue();
  } catch (err) {
    if (err instanceof AuthError) return handleAuthError();
    console.error(err);
    setSync("error");
    loadCache();
    toast("クラウド読込に失敗しました。ローカルの内容を表示します。");
  }
  render();
}

async function flushQueue() {
  if (!cloudEnabled()) return;
  const q = loadQueue();
  if (!q.length) return;
  const remaining = [];
  for (const rec of q) {
    try {
      await apiPost({ action: "create", record: rec });
    } catch (err) {
      if (err instanceof AuthError) {
        remaining.push(rec, ...q.slice(q.indexOf(rec) + 1));
        saveQueue(remaining);
        updatePendingUI();
        return handleAuthError();
      }
      remaining.push(rec);
    }
  }
  saveQueue(remaining);
  updatePendingUI();
  if (remaining.length < q.length) {
    state.expenses = await apiGet();
    saveCache();
    setSync("synced");
  }
}

/* =========================================================================
 * 認証（クラウドモード）
 * ========================================================================= */

function showAuthOverlay(mode) {
  $("#authOverlay").hidden = false;
  $("#loginForm").hidden = mode !== "login";
  $("#setupForm").hidden = mode !== "setup";
  $("#loginError").hidden = true;
  $("#setupError").hidden = true;
}
function hideAuthOverlay() {
  $("#authOverlay").hidden = true;
}

function applySessionUI() {
  const cloud = cloudEnabled();
  $("#localUserBox").hidden = cloud;
  $("#sessionBox").hidden = !(cloud && state.session);
  $("#passwordCard").hidden = !(cloud && state.session && state.authEnabled);
  $("#userMgmtCard").hidden = !(cloud && state.isAdmin && state.authEnabled);
  if (cloud && state.session) {
    $("#sessionName").textContent = state.session.user.displayName;
    const roleEl = $("#sessionRole");
    const isAdmin = state.session.user.role === "admin";
    roleEl.textContent = isAdmin ? "管理者" : "一般";
    roleEl.className = "role-badge" + (isAdmin ? "" : " is-user");
  }
}

/** 申請フォームの事業部候補と既定値を反映 */
function applyDeptUI() {
  const dl = $("#deptList");
  dl.innerHTML = state.departments
    .map((d) => `<option value="${escapeHtml(d)}"></option>`)
    .join("");
  const input = $("#expDept");
  input.value =
    cloudEnabled() && state.session ? state.session.user.department || "" : "";
}

function setSessionFromResponse(data) {
  state.session = { token: data.token, user: data.user };
  saveSession();
  if (data.departments) state.departments = data.departments;
  state.isAdmin = data.user.role === "admin";
  syncAdminUI();
  applySessionUI();
  applyDeptUI();
}

function handleAuthError() {
  // トークン失効・無効化など。セッションを破棄してログイン画面へ
  state.session = null;
  saveSession();
  state.isAdmin = false;
  syncAdminUI();
  applySessionUI();
  setSync("error");
  toast("セッションの有効期限が切れました。再ログインしてください。");
  showAuthOverlay("login");
}

async function logout() {
  state.session = null;
  saveSession();
  state.isAdmin = false;
  state.expenses = [];
  saveCache();
  syncAdminUI();
  applySessionUI();
  render();
  showAuthOverlay("login");
}

async function handleLogin(evt) {
  evt.preventDefault();
  const errEl = $("#loginError");
  errEl.hidden = true;
  try {
    const data = await apiPost({
      action: "login",
      token: "",
      username: $("#loginUsername").value.trim(),
      password: $("#loginPassword").value,
    });
    setSessionFromResponse(data);
    hideAuthOverlay();
    $("#loginForm").reset();
    toast(`ようこそ、${data.user.displayName} さん`);
    await refreshFromCloud();
  } catch (err) {
    errEl.textContent = err.message || "ログインに失敗しました";
    errEl.hidden = false;
  }
}

async function handleSetup(evt) {
  evt.preventDefault();
  const errEl = $("#setupError");
  errEl.hidden = true;
  try {
    const data = await apiPost({
      action: "setup",
      token: "",
      username: $("#setupUsername").value.trim(),
      displayName: $("#setupDisplayName").value.trim(),
      password: $("#setupPassword").value,
    });
    state.authEnabled = true;
    setSessionFromResponse(data);
    hideAuthOverlay();
    $("#setupForm").reset();
    toast("管理者アカウントを作成しました");
    await refreshFromCloud();
  } catch (err) {
    errEl.textContent = err.message || "作成に失敗しました";
    errEl.hidden = false;
  }
}

async function handleChangePassword(evt) {
  evt.preventDefault();
  try {
    await apiPost({
      action: "changePassword",
      currentPassword: $("#pwCurrent").value,
      newPassword: $("#pwNew").value,
    });
    $("#passwordForm").reset();
    toast("パスワードを変更しました");
  } catch (err) {
    if (err instanceof AuthError) return handleAuthError();
    toast(err.message || "変更に失敗しました");
  }
}

/* =========================================================================
 * ユーザー管理（管理者のみ）
 * ========================================================================= */

async function loadUsers() {
  try {
    const data = await apiPost({ action: "listUsers" });
    renderUsers(data.users || []);
  } catch (err) {
    if (err instanceof AuthError) return handleAuthError();
    toast(err.message || "ユーザー一覧の取得に失敗しました");
  }
}

function renderUsers(users) {
  const tbody = $("#userTable tbody");
  const me = state.session ? state.session.user.username : "";
  tbody.innerHTML = users.length
    ? users
        .map(
          (u) => `
      <tr>
        <td>${escapeHtml(u.username)}</td>
        <td>${escapeHtml(u.displayName)}</td>
        <td>${escapeHtml(u.department || "—")}</td>
        <td><span class="role-badge ${u.role === "admin" ? "" : "is-user"}">${
            u.role === "admin" ? "管理者" : "一般"
          }</span></td>
        <td>${u.active ? "有効" : '<span style="color:var(--red)">無効</span>'}</td>
        <td>
          <button class="btn btn--ghost btn--sm" data-user-dept="${escapeHtml(
            u.username
          )}" data-dept="${escapeHtml(u.department || "")}">事業部変更</button>
          ${
            u.username === me
              ? '<span class="empty" style="padding:0">（自分）</span>'
              : `<button class="btn btn--ghost btn--sm" data-user-toggle="${escapeHtml(
                  u.username
                )}" data-active="${u.active}">${u.active ? "無効化" : "有効化"}</button>
                 <button class="btn btn--ghost btn--sm" data-user-pw="${escapeHtml(
                   u.username
                 )}">PW再設定</button>`
          }
        </td>
      </tr>`
        )
        .join("")
    : `<tr><td colspan="6" class="empty">ユーザーがいません。</td></tr>`;
}

async function handleUserAdd(evt) {
  evt.preventDefault();
  try {
    await apiPost({
      action: "upsertUser",
      user: {
        username: $("#nuUsername").value.trim(),
        displayName: $("#nuDisplayName").value.trim(),
        department: $("#nuDept").value.trim(),
        password: $("#nuPassword").value,
        role: $("#nuRole").value,
      },
    });
    $("#userAddForm").reset();
    toast("ユーザーを追加しました");
    await loadUsers();
  } catch (err) {
    if (err instanceof AuthError) return handleAuthError();
    toast(err.message || "追加に失敗しました");
  }
}

async function handleUserTableClick(e) {
  const toggle = e.target.closest("[data-user-toggle]");
  const pw = e.target.closest("[data-user-pw]");
  const dept = e.target.closest("[data-user-dept]");
  try {
    if (dept) {
      const username = dept.dataset.userDept;
      const next = window.prompt(`${username} の事業部`, dept.dataset.dept || "");
      if (next === null) return;
      await apiPost({ action: "upsertUser", user: { username, department: next.trim() } });
      toast("事業部を更新しました（以降の申請から反映）");
      await loadUsers();
    } else if (toggle) {
      const username = toggle.dataset.userToggle;
      const nowActive = toggle.dataset.active === "true";
      if (!window.confirm(`${username} を${nowActive ? "無効化" : "有効化"}しますか？`)) return;
      await apiPost({ action: "upsertUser", user: { username, active: !nowActive } });
      toast(nowActive ? "無効化しました" : "有効化しました");
      await loadUsers();
    } else if (pw) {
      const username = pw.dataset.userPw;
      const newPw = window.prompt(`${username} の新しいパスワード（8文字以上）`);
      if (newPw === null) return;
      await apiPost({ action: "upsertUser", user: { username, password: newPw } });
      toast("パスワードを再設定しました");
    }
  } catch (err) {
    if (err instanceof AuthError) return handleAuthError();
    toast(err.message || "操作に失敗しました");
  }
}

/* =========================================================================
 * 画像解析（OCR）— レシートから金額・日付・店名を推定
 * ========================================================================= */

function parseAmount(str) {
  const normalized = str
    .replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0))
    .replace(/[，,]/g, "")
    .replace(/[^\d]/g, "");
  return normalized ? parseInt(normalized, 10) : NaN;
}

function extractAmount(text) {
  const lines = text.split(/\r?\n/);
  const keywords = /(合\s*計|税込|お?支払|総額|請求|計)/;
  const candidates = [];
  for (const line of lines) {
    const hasMoneyMark = /[¥￥]|円/.test(line);
    const hasKeyword = keywords.test(line);
    if (!hasMoneyMark && !hasKeyword) continue;
    const nums = line.match(/[¥￥]?\s*[\d０-９][\d０-９,，]*/g) || [];
    for (const raw of nums) {
      const v = parseAmount(raw);
      if (!isNaN(v) && v >= 10 && v <= 100000000) {
        candidates.push({ v, weight: hasKeyword ? 2 : 1 });
      }
    }
  }
  if (!candidates.length) return null;
  const keyed = candidates.filter((c) => c.weight === 2);
  const pool = keyed.length ? keyed : candidates;
  return pool.reduce((m, c) => Math.max(m, c.v), 0);
}

function extractDate(text) {
  const t = text.replace(/[０-９]/g, (d) =>
    String.fromCharCode(d.charCodeAt(0) - 0xfee0)
  );
  const patterns = [
    /(\d{4})\s*[年\/\.\-]\s*(\d{1,2})\s*[月\/\.\-]\s*(\d{1,2})/,
    /(\d{2})\s*[\/\.\-]\s*(\d{1,2})\s*[\/\.\-]\s*(\d{1,2})/,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m) {
      let [, y, mo, d] = m;
      if (y.length === 2) y = "20" + y;
      const yy = Number(y), mm = Number(mo), dd = Number(d);
      if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
        return `${yy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
      }
    }
  }
  return null;
}

function extractVendor(text) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length >= 2);
  for (const line of lines.slice(0, 5)) {
    if (/^[\d\s¥￥,.\-\/:]+$/.test(line)) continue;
    if (/(領\s*収\s*書|レシート|receipt)/i.test(line)) continue;
    return line.slice(0, 40);
  }
  return null;
}

/** 画像を縮小して dataURL を返す */
function scaleImage(file, maxSize, quality) {
  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL("image/jpeg", quality));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    img.src = url;
  });
}
const makeThumb = (file) => scaleImage(file, 480, 0.7);
async function makeUploadBase64(file) {
  const dataUrl = await scaleImage(file, 1600, 0.8);
  return dataUrl ? { base64: dataUrl.split(",")[1], mime: "image/jpeg" } : null;
}

async function runOcr(file) {
  const statusEl = $("#ocrStatus");
  const barFill = $("#ocrBarFill");
  const statusText = $("#ocrStatusText");
  const rawWrap = $("#ocrRawWrap");
  const rawEl = $("#ocrRaw");

  if (typeof Tesseract === "undefined") {
    toast("OCRライブラリを読み込めませんでした（ネットワークをご確認ください）");
    return;
  }

  statusEl.hidden = false;
  rawWrap.hidden = true;
  barFill.style.width = "0%";
  statusText.textContent = "画像を解析中…";

  try {
    const { data } = await Tesseract.recognize(file, "jpn+eng", {
      logger: (m) => {
        if (m.status === "recognizing text") {
          const pct = Math.round(m.progress * 100);
          barFill.style.width = pct + "%";
          statusText.textContent = `文字を認識中… ${pct}%`;
        } else {
          statusText.textContent = m.status;
        }
      },
    });

    const text = data.text || "";
    rawEl.textContent = text.trim() || "(テキストを検出できませんでした)";
    rawWrap.hidden = false;

    const amount = extractAmount(text);
    const date = extractDate(text);
    const vendor = extractVendor(text);
    const filled = [];
    if (amount != null) {
      $("#expAmount").value = amount;
      filled.push("金額");
    }
    if (date) {
      $("#expDate").value = date;
      filled.push("日付");
    }
    if (vendor) {
      $("#expVendor").value = vendor;
      filled.push("店名");
    }
    statusText.textContent = filled.length
      ? `解析完了：${filled.join("・")}を自動入力しました（内容をご確認ください）`
      : "解析完了：自動抽出できた項目はありません。手入力してください。";
  } catch (err) {
    console.error(err);
    statusText.textContent = "解析に失敗しました。手入力してください。";
  }
}

/* =========================================================================
 * 申請フォーム
 * ========================================================================= */

async function handleImageFile(file) {
  if (!file || !file.type.startsWith("image/")) {
    toast("画像ファイルを選択してください");
    return;
  }
  state.lastImageFile = file;
  const thumb = await makeThumb(file);
  state.lastImageThumb = thumb;
  $("#previewImg").src = thumb || "";
  $("#preview").hidden = false;
  runOcr(file);
}

function clearImage() {
  state.lastImageThumb = null;
  state.lastImageFile = null;
  $("#preview").hidden = true;
  $("#previewImg").src = "";
  $("#imageInput").value = "";
  $("#ocrStatus").hidden = true;
  $("#ocrRawWrap").hidden = true;
}

async function submitExpense(evt) {
  evt.preventDefault();
  if (!cloudEnabled() && !state.currentUser) {
    toast("先に画面右上で氏名を入力してください");
    $("#currentUser").focus();
    return;
  }
  if (cloudEnabled() && !state.session) {
    showAuthOverlay("login");
    return;
  }
  const amount = Number($("#expAmount").value);
  if (!$("#expDate").value || !amount || amount <= 0) {
    toast("日付と金額（1円以上）は必須です");
    return;
  }

  const base = {
    id: uid(),
    // クラウドモードでは申請者はサーバー側でセッションから強制される
    applicant: cloudEnabled()
      ? state.session.user.displayName
      : state.currentUser,
    date: $("#expDate").value,
    category: $("#expCategory").value,
    // 空の場合はサーバー側でプロフィールの事業部が入る
    department: $("#expDept").value.trim(),
    vendor: $("#expVendor").value.trim(),
    amount,
    description: $("#expDesc").value.trim(),
    status: "pending",
    createdAt: new Date().toISOString(),
    reviewedAt: null,
    reviewer: null,
    reviewComment: null,
  };

  const submitBtn = $("#submitBtn");
  submitBtn.disabled = true;

  try {
    if (!cloudEnabled()) {
      state.expenses.unshift({ ...base, imageThumb: state.lastImageThumb });
      saveCache();
      toast("経費を申請しました（この端末に保存）");
    } else {
      setSync("syncing");
      const img = state.lastImageFile ? await makeUploadBase64(state.lastImageFile) : null;
      const record = { ...base };
      if (img) {
        record.imageBase64 = img.base64;
        record.imageMime = img.mime;
      }
      try {
        await apiPost({ action: "create", record });
        await refreshFromCloud();
        toast(
          state.autoApprove
            ? "申請を保存しました（自動承認済み）"
            : "申請を保存しました（スプレッドシート／ドライブへ同期）"
        );
      } catch (err) {
        if (err instanceof AuthError) {
          handleAuthError();
          return;
        }
        console.error(err);
        const q = loadQueue();
        q.push(record);
        saveQueue(q);
        state.expenses.unshift({ ...base, imageThumb: state.lastImageThumb });
        saveCache();
        updatePendingUI();
        setSync("error");
        toast("クラウド保存に失敗。ローカルに保存し、後で再同期します。");
      }
    }
    $("#expenseForm").reset();
    $("#expDate").valueAsDate = new Date();
    applyDeptUI(); // 事業部の既定値を再設定
    clearImage();
    render();
  } finally {
    submitBtn.disabled = false;
  }
}

/* =========================================================================
 * ダッシュボード描画
 * ========================================================================= */

function statCard(label, value, cls = "") {
  return `<div class="stat"><p class="stat__label">${escapeHtml(
    label
  )}</p><p class="stat__value ${cls}">${escapeHtml(value)}</p></div>`;
}

function receiptCell(e) {
  const href = e.imageUrl || e.imageThumb;
  return href
    ? `<a class="receipt-link" href="${escapeHtml(href)}" target="_blank" rel="noopener" title="領収書を開く">🧾</a>`
    : "—";
}

/** 「自分の申請」を返す（モード・権限に応じて） */
function myExpenses() {
  if (cloudEnabled() && state.session) {
    if (state.session.user.role === "admin") {
      // 管理者は全件取得しているため自分の分を抽出
      return state.expenses.filter(
        (e) => e.applicantId === state.session.user.username
      );
    }
    return state.expenses; // 一般はサーバー側で自分の分のみ返却
  }
  return state.expenses.filter((e) => e.applicant === state.currentUser);
}

/** 月ナビUIを状態に同期 */
function syncMonthNav(prefix, month) {
  const input = $(`#${prefix}Month`);
  const allBtn = $(`#${prefix}All`);
  input.value = month === "all" ? "" : month;
  allBtn.classList.toggle("is-on", month === "all");
}

function renderPersonal() {
  if (!state.personalMonth) state.personalMonth = currentMonth();
  syncMonthNav("personal", state.personalMonth);

  const identified = cloudEnabled() ? !!state.session : !!state.currentUser;
  const mine = identified
    ? myExpenses().filter((e) => inMonth(e, state.personalMonth))
    : [];

  const sum = (arr) => arr.reduce((t, e) => t + e.amount, 0);
  const pending = mine.filter((e) => e.status === "pending");
  const approved = mine.filter((e) => e.status === "approved");

  $("#personalStats").innerHTML = identified
    ? [
        statCard("申請件数", mine.length + " 件"),
        statCard("申請中", pending.length + " 件"),
        statCard("承認済み金額", yen(sum(approved)), "is-green"),
        statCard("申請中金額", yen(sum(pending)), "is-accent"),
      ].join("")
    : `<div class="stat"><p class="stat__label">未ログイン</p><p class="stat__value">—</p></div>`;

  const filter = $("#personalFilter").value;
  const rows = mine.filter((e) => filter === "all" || e.status === filter);
  const tbody = $("#personalTable tbody");

  if (!identified) {
    tbody.innerHTML = `<tr><td colspan="8" class="empty">${
      cloudEnabled()
        ? "ログインすると自分の申請が表示されます。"
        : "右上で氏名を入力すると、自分の申請が表示されます。"
    }</td></tr>`;
    return;
  }
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="empty">該当する申請はありません。</td></tr>`;
    return;
  }
  tbody.innerHTML = rows
    .map(
      (e) => `
    <tr>
      <td>${escapeHtml(e.date)}</td>
      <td>${escapeHtml(e.category)}</td>
      <td>${escapeHtml(e.vendor || "—")}</td>
      <td class="num">${yen(e.amount)}</td>
      <td><span class="badge badge--${e.status}">${STATUS_LABEL[e.status]}</span></td>
      <td>${receiptCell(e)}</td>
      <td>${escapeHtml(e.reviewComment || "")}</td>
      <td><button class="btn btn--ghost btn--sm" data-del="${e.id}">取消</button></td>
    </tr>`
    )
    .join("");
}

/** バー横棒グラフのHTML（[ラベル, 金額] の配列から） */
function barsHtml(entries, emptyMsg) {
  if (!entries.length) return `<p class="empty">${escapeHtml(emptyMsg)}</p>`;
  const max = Math.max(...entries.map(([, v]) => v));
  return entries
    .map(
      ([label, val]) => `
    <div class="bar-row">
      <span>${escapeHtml(label)}</span>
      <div class="bar-track"><div class="bar-fill" style="width:${
        max ? (val / max) * 100 : 0
      }%"></div></div>
      <span class="bar-val">${yen(val)}</span>
    </div>`
    )
    .join("");
}

const GROUP_LABEL = {
  category: "区分（科目）別",
  department: "事業部別",
  applicant: "スタッフ別",
};

function renderAdmin() {
  if (!state.adminMonth) state.adminMonth = currentMonth();
  syncMonthNav("admin", state.adminMonth);

  const all = state.expenses;
  const monthRecs = all.filter((e) => inMonth(e, state.adminMonth));
  const sum = (arr) => arr.reduce((t, e) => t + e.amount, 0);
  const pending = monthRecs.filter((e) => e.status === "pending");
  const approved = monthRecs.filter((e) => e.status === "approved");

  $("#adminStats").innerHTML = [
    statCard("申請件数", monthRecs.length + " 件"),
    statCard("承認待ち", pending.length + " 件", "is-accent"),
    statCard("承認待ち金額", yen(sum(pending)), "is-accent"),
    statCard("承認済み金額", yen(sum(approved)), "is-green"),
  ].join("");

  // グループ別集計（表示中の月の承認済み金額）
  const groupBy = $("#adminGroupBy").value;
  $("#adminGroupTitle").textContent = GROUP_LABEL[groupBy] + " 承認済み金額";
  const byGroup = {};
  for (const e of approved) {
    const key = (e[groupBy] || "未設定").trim() || "未設定";
    byGroup[key] = (byGroup[key] || 0) + e.amount;
  }
  $("#adminByGroup").innerHTML = barsHtml(
    Object.entries(byGroup).sort((a, b) => b[1] - a[1]),
    "承認済みの経費はまだありません。"
  );

  // 月次推移（直近6ヶ月・全データの承認済み金額）
  const months = [];
  let m = currentMonth();
  for (let i = 5; i >= 0; i--) months.push(shiftMonth(m, -i));
  const trend = months.map((mo) => [
    mo.replace("-", "/"),
    sum(all.filter((e) => e.status === "approved" && inMonth(e, mo))),
  ]);
  $("#adminTrend").innerHTML = barsHtml(trend, "データがありません。");

  // 一覧（検索・状態フィルタ・ソート）
  const q = $("#adminSearch").value.trim().toLowerCase();
  const sf = $("#adminStatusFilter").value;
  let rows = monthRecs.filter((e) => {
    const matchQ =
      !q ||
      e.applicant.toLowerCase().includes(q) ||
      (e.vendor || "").toLowerCase().includes(q) ||
      (e.department || "").toLowerCase().includes(q);
    const matchS = sf === "all" || e.status === sf;
    return matchQ && matchS;
  });

  const sortKey = $("#adminSort").value;
  const cmp = {
    date_desc: (a, b) => (b.date || "").localeCompare(a.date || ""),
    date_asc: (a, b) => (a.date || "").localeCompare(b.date || ""),
    amount_desc: (a, b) => b.amount - a.amount,
    applicant: (a, b) =>
      a.applicant.localeCompare(b.applicant, "ja") ||
      (b.date || "").localeCompare(a.date || ""),
    department: (a, b) =>
      (a.department || "").localeCompare(b.department || "", "ja") ||
      (b.date || "").localeCompare(a.date || ""),
    category: (a, b) =>
      a.category.localeCompare(b.category, "ja") ||
      (b.date || "").localeCompare(a.date || ""),
  }[sortKey];
  if (cmp) rows = rows.slice().sort(cmp);

  // 操作列: 自動承認モードでは削除のみ、フローモードでは承認/却下/差戻＋削除
  const flowMode = !(cloudEnabled() && state.autoApprove);
  const ops = (e) => {
    const del = `<button class="btn btn--ghost btn--sm btn--reject" data-remove="${e.id}">削除</button>`;
    if (!flowMode) return del;
    return e.status === "pending"
      ? `<button class="btn btn--sm btn--approve" data-approve="${e.id}">承認</button>
         <button class="btn btn--sm btn--reject" data-reject="${e.id}">却下</button> ${del}`
      : `<button class="btn btn--ghost btn--sm" data-reset="${e.id}">差戻</button> ${del}`;
  };

  const tbody = $("#adminTable tbody");
  tbody.innerHTML = rows.length
    ? rows
        .map(
          (e) => `
      <tr>
        <td>${escapeHtml(e.applicant)}</td>
        <td>${escapeHtml(e.department || "—")}</td>
        <td>${escapeHtml(e.date)}</td>
        <td>${escapeHtml(e.category)}</td>
        <td>${escapeHtml(e.vendor || "—")}</td>
        <td class="num">${yen(e.amount)}</td>
        <td>${receiptCell(e)}</td>
        <td><span class="badge badge--${e.status}">${STATUS_LABEL[e.status]}</span></td>
        <td>${ops(e)}</td>
      </tr>`
        )
        .join("")
    : `<tr><td colspan="9" class="empty">該当する申請はありません。</td></tr>`;
}

function render() {
  renderPersonal();
  if (state.isAdmin) renderAdmin();
}

/* =========================================================================
 * 承認・却下・差戻・取消
 * ========================================================================= */

function findExpense(id) {
  return state.expenses.find((e) => e.id === id);
}

async function applyReview(id, fields, message) {
  if (cloudEnabled()) {
    setSync("syncing");
    try {
      await apiPost({ action: "update", id, fields });
      await refreshFromCloud();
      toast(message);
    } catch (err) {
      if (err instanceof AuthError) return handleAuthError();
      console.error(err);
      setSync("error");
      toast(err.message || "クラウド更新に失敗しました。");
    }
  } else {
    const e = findExpense(id);
    if (e) Object.assign(e, fields);
    saveCache();
    toast(message);
    render();
  }
}

function approve(id) {
  applyReview(
    id,
    {
      status: "approved",
      reviewedAt: new Date().toISOString(),
      reviewer: cloudEnabled()
        ? state.session.user.displayName
        : state.currentUser || "管理者",
      reviewComment: "",
    },
    "承認しました"
  );
}

function reject(id) {
  const comment = window.prompt("却下理由を入力してください（任意）", "");
  if (comment === null) return;
  applyReview(
    id,
    {
      status: "rejected",
      reviewedAt: new Date().toISOString(),
      reviewer: cloudEnabled()
        ? state.session.user.displayName
        : state.currentUser || "管理者",
      reviewComment: comment.trim(),
    },
    "却下しました"
  );
}

function resetStatus(id) {
  applyReview(
    id,
    { status: "pending", reviewedAt: "", reviewer: "", reviewComment: "" },
    "申請中に差し戻しました"
  );
}

async function deleteExpense(id) {
  if (!window.confirm("この申請を取り消しますか？")) return;
  if (cloudEnabled()) {
    setSync("syncing");
    try {
      await apiPost({ action: "delete", id });
      await refreshFromCloud();
      toast("申請を取り消しました");
    } catch (err) {
      if (err instanceof AuthError) return handleAuthError();
      console.error(err);
      setSync("error");
      toast(err.message || "クラウド削除に失敗しました。");
    }
  } else {
    state.expenses = state.expenses.filter((e) => e.id !== id);
    saveCache();
    toast("申請を取り消しました");
    render();
  }
}

/* =========================================================================
 * CSV書き出し（分析ツール取り込み用）
 * ========================================================================= */

function exportCsv() {
  const cols = [
    "id", "createdAt", "applicant", "applicantId", "department", "date",
    "category", "vendor", "amount", "description", "status", "reviewedAt",
    "reviewer", "reviewComment", "imageUrl",
  ];
  const esc = (v) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [cols.join(",")];
  for (const e of state.expenses) {
    lines.push(cols.map((c) => esc(e[c])).join(","));
  }
  const blob = new Blob(["﻿" + lines.join("\n")], {
    type: "text/csv;charset=utf-8",
  });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "expenses.csv";
  a.click();
  URL.revokeObjectURL(a.href);
}

/* =========================================================================
 * タブ / モード切替 / 設定
 * ========================================================================= */

function setTab(tab) {
  if (tab === "admin" && !state.isAdmin) tab = "apply";
  state.activeTab = tab;
  $$(".tab").forEach((t) => t.classList.toggle("is-active", t.dataset.tab === tab));
  $$(".panel").forEach((p) =>
    p.classList.toggle("is-active", p.dataset.panel === tab)
  );
  if (tab === "admin" && cloudEnabled() && state.isAdmin && state.authEnabled) {
    loadUsers();
  }
}

function syncAdminUI() {
  $(".is-admin-only").hidden = !state.isAdmin;
  const btn = $("#adminToggle");
  btn.classList.toggle("is-on", state.isAdmin);
  btn.textContent = state.isAdmin ? "管理者モード ON" : "管理者モード";
  if (!state.isAdmin && state.activeTab === "admin") setTab("apply");
  render();
}

function openSettings() {
  $("#cfgEndpoint").value = state.config.endpoint;
  $("#settingsModal").hidden = false;
}
function closeSettings() {
  $("#settingsModal").hidden = true;
}
async function saveSettings() {
  const prev = state.config.endpoint;
  state.config.endpoint = $("#cfgEndpoint").value.trim();
  saveConfig();
  closeSettings();
  if (state.config.endpoint !== prev) {
    state.session = null;
    saveSession();
  }
  await initMode();
}
async function clearSettings() {
  state.config = { endpoint: "" };
  saveConfig();
  state.session = null;
  saveSession();
  $("#cfgEndpoint").value = "";
  toast("クラウド連携を解除しました（以降はこの端末に保存）");
  await initMode();
}

/* =========================================================================
 * 起動フロー
 * ========================================================================= */

async function initMode() {
  hideAuthOverlay();
  applySessionUI();
  updatePendingUI();

  if (!cloudEnabled()) {
    // ローカル（試用）モード
    state.authEnabled = false;
    state.isAdmin = false;
    loadCache();
    setSync("local");
    syncAdminUI();
    applyDeptUI();
    render();
    return;
  }

  // クラウドモード: 認証状態を確認
  setSync("syncing");
  try {
    const st = await apiPost({ action: "status", token: "" });
    state.authEnabled = !!st.authEnabled;
    state.autoApprove = !!st.autoApprove;

    if (!state.authEnabled) {
      // 初期設定（最初の管理者作成）が必要
      setSync("synced");
      showAuthOverlay("setup");
      return;
    }

    loadSession();
    if (state.session) {
      try {
        const me = await apiPost({ action: "me" });
        state.session.user = me.user;
        saveSession();
        if (me.departments) state.departments = me.departments;
        state.isAdmin = me.user.role === "admin";
        syncAdminUI();
        applySessionUI();
        applyDeptUI();
        hideAuthOverlay();
        await refreshFromCloud();
        return;
      } catch (err) {
        state.session = null;
        saveSession();
      }
    }
    state.isAdmin = false;
    syncAdminUI();
    applySessionUI();
    showAuthOverlay("login");
    setSync("synced");
  } catch (err) {
    console.error(err);
    setSync("error");
    loadCache();
    syncAdminUI();
    render();
    toast("サーバーに接続できません。ローカルのキャッシュを表示します。");
  }
}

function init() {
  loadConfig();

  state.currentUser = localStorage.getItem(USER_KEY) || "";
  $("#currentUser").value = state.currentUser;
  $("#expDate").valueAsDate = new Date();

  // タブ
  $("#tabs").addEventListener("click", (e) => {
    const btn = e.target.closest(".tab");
    if (btn) setTab(btn.dataset.tab);
  });

  // ローカルモード: 氏名・管理者トグル
  $("#currentUser").addEventListener("input", (e) => {
    state.currentUser = e.target.value.trim();
    localStorage.setItem(USER_KEY, state.currentUser);
    render();
  });
  $("#adminToggle").addEventListener("click", () => {
    state.isAdmin = !state.isAdmin;
    syncAdminUI();
  });

  // 認証
  $("#loginForm").addEventListener("submit", handleLogin);
  $("#setupForm").addEventListener("submit", handleSetup);
  $("#logoutBtn").addEventListener("click", logout);
  $("#passwordForm").addEventListener("submit", handleChangePassword);

  // ユーザー管理
  $("#userAddForm").addEventListener("submit", handleUserAdd);
  $("#userTable").addEventListener("click", handleUserTableClick);
  $("#userReloadBtn").addEventListener("click", loadUsers);

  // 画像入力
  const dropzone = $("#dropzone");
  $("#imageInput").addEventListener("change", (e) => {
    if (e.target.files[0]) handleImageFile(e.target.files[0]);
  });
  ["dragenter", "dragover"].forEach((ev) =>
    dropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      dropzone.classList.add("is-drag");
    })
  );
  ["dragleave", "drop"].forEach((ev) =>
    dropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      dropzone.classList.remove("is-drag");
    })
  );
  dropzone.addEventListener("drop", (e) => {
    const file = e.dataTransfer.files[0];
    if (file) handleImageFile(file);
  });
  $("#clearImage").addEventListener("click", clearImage);

  // フォーム
  $("#expenseForm").addEventListener("submit", submitExpense);

  // フィルタ
  $("#personalFilter").addEventListener("change", renderPersonal);
  $("#adminSearch").addEventListener("input", renderAdmin);
  $("#adminStatusFilter").addEventListener("change", renderAdmin);
  $("#csvBtn").addEventListener("click", exportCsv);

  // テーブル操作
  $("#personalTable").addEventListener("click", (e) => {
    const del = e.target.closest("[data-del]");
    if (del) deleteExpense(del.dataset.del);
  });
  $("#adminTable").addEventListener("click", (e) => {
    const a = e.target.closest("[data-approve]");
    const r = e.target.closest("[data-reject]");
    const rs = e.target.closest("[data-reset]");
    const rm = e.target.closest("[data-remove]");
    if (a) approve(a.dataset.approve);
    else if (r) reject(r.dataset.reject);
    else if (rs) resetStatus(rs.dataset.reset);
    else if (rm) deleteExpense(rm.dataset.remove);
  });

  // 月ナビ（個人・管理者）
  const bindMonthNav = (prefix, key, rerender) => {
    $(`#${prefix}Prev`).addEventListener("click", () => {
      const cur = state[key] === "all" ? currentMonth() : state[key];
      state[key] = shiftMonth(cur, -1);
      rerender();
    });
    $(`#${prefix}Next`).addEventListener("click", () => {
      const cur = state[key] === "all" ? currentMonth() : state[key];
      state[key] = shiftMonth(cur, 1);
      rerender();
    });
    $(`#${prefix}Month`).addEventListener("change", (e) => {
      state[key] = e.target.value || currentMonth();
      rerender();
    });
    $(`#${prefix}All`).addEventListener("click", () => {
      state[key] = state[key] === "all" ? currentMonth() : "all";
      rerender();
    });
  };
  bindMonthNav("personal", "personalMonth", renderPersonal);
  bindMonthNav("admin", "adminMonth", renderAdmin);

  // グループ別集計・ソート
  $("#adminGroupBy").addEventListener("change", renderAdmin);
  $("#adminSort").addEventListener("change", renderAdmin);

  // 設定モーダル
  $("#settingsBtn").addEventListener("click", openSettings);
  $("#cfgSave").addEventListener("click", saveSettings);
  $("#cfgClear").addEventListener("click", clearSettings);
  $("#reSyncBtn").addEventListener("click", () => refreshFromCloud());
  $$("[data-close]").forEach((el) => el.addEventListener("click", closeSettings));

  setTab("apply");
  initMode();
}

document.addEventListener("DOMContentLoaded", init);
