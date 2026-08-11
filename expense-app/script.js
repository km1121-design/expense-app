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
const VIEW_KEY = "expense-app:views"; // 一覧の表示形式（カード／表）

// ローカル（試用）モードの事業部プルダウン初期値（クラウド時はサーバーのマスタを使用）
const DEFAULT_DEPARTMENTS = [
  "BAR", "人材", "運送", "本部", "ARTGRAGE", "クリニック", "GoonerHouse",
];

const state = {
  expenses: [],
  currentUser: "", // ローカルモードの氏名
  isAdmin: false,
  activeTab: "apply",
  lastImageThumb: null,
  lastImageFile: null,
  lastAiBase64: null, // AI解析用画像のキャッシュ（再解析を高速化）
  lastAiFields: null, // AIが提案した値（申請時に手修正との差分を学習ログへ送る）
  config: { endpoint: "" },
  session: null, // { token, user:{username,displayName,role,department} }
  departments: [], // 登録済み事業部の一覧（申請フォームの候補）
  authEnabled: false,
  autoApprove: false, // クラウド側の自動承認モード
  aiOcr: false, // サーバー側AIレシート解析（ANTHROPIC_API_KEY設定時）
  personalMonth: "", // "yyyy-MM" または "all"
  adminMonth: "",
  syncStatus: "local",
  // 一覧の表示形式（"cards" = 領収書サムネイル付きカード / "table" = 表）
  views: { personal: "cards", admin: "cards" },
  // 領収書ビューア: 表示中の一覧のうち画像がある申請のIDと現在位置
  lightbox: { ids: [], index: 0 },
  lastFare: null, // 直前の運賃照合結果（申請時にサーバーへ区間を送る）
  lastError: null, // 直前の通信エラー（同期バッジのクリックで確認できる）
  features: {}, // バックエンド（Apps Script）が対応している機能
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
function loadViews() {
  try {
    const raw = localStorage.getItem(VIEW_KEY);
    if (raw) state.views = { ...state.views, ...JSON.parse(raw) };
  } catch {
    /* noop */
  }
}
function saveViews() {
  localStorage.setItem(VIEW_KEY, JSON.stringify(state.views));
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
function toast(msg, ms) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms || 3200);
}

/**
 * 通信エラーの内容を控えておき、同期バッジのクリックでいつでも見られるようにする。
 * トーストは数秒で消えるため、原因の共有・調査ができるようにするのが目的。
 */
function recordError(context, err) {
  const msg = (err && err.message) || String(err);
  state.lastError = {
    at: new Date().toLocaleString("ja-JP"),
    context,
    message: msg,
  };
  console.error(context, err);
  return msg;
}

/** 同期バッジをクリックしたときに、直前のエラー内容を表示する */
function showLastError() {
  const e = state.lastError;
  if (!e) {
    toast("記録されているエラーはありません");
    return;
  }
  window.alert(
    `通信エラーの詳細\n\n発生: ${e.at}\n処理: ${e.context}\n\n${e.message}`
  );
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
    // 交通費の運賃照合（サーバー側で確定した内容）
    fareFrom: r.fareFrom || "",
    fareTo: r.fareTo || "",
    fareRound: r.fareRound === true || String(r.fareRound).toLowerCase() === "true",
    fareTrips: Number(r.fareTrips) || 0,
    fareUnit: Number(r.fareUnit) || 0,
    fareExpected: Number(r.fareExpected) || 0,
    fareCheck: r.fareCheck || "",
  };
}

/* =========================================================================
 * クラウドAPI（Google Apps Script Web App）
 *   POST は text/plain で送信し CORS プリフライトを回避
 * ========================================================================= */

class AuthError extends Error {}

/**
 * 応答をJSONとして読む。
 * Apps Script はエラー時やアクセス権限が足りないときにHTML（Googleのエラー画面や
 * ログイン画面）を返すため、そのまま JSON.parse すると原因の分からない
 * 「Unexpected token '<'」になる。何が起きているかを日本語で伝える。
 */
async function readJsonResponse(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (err) {
    const head = text.slice(0, 400);
    if (/accounts\.google\.com|ServiceLogin|Sign in|ログイン/i.test(head)) {
      throw new Error(
        "Googleのログイン画面が返されました。Apps Scriptのデプロイ設定で" +
          "「アクセスできるユーザー」を『全員』にしてください（HTTP " +
          res.status +
          "）"
      );
    }
    if (/<!DOCTYPE|<html/i.test(head)) {
      throw new Error(
        "サーバーがJSONではなくHTMLを返しました（HTTP " +
          res.status +
          "）。Apps Scriptを再デプロイ（デプロイを管理→新バージョン）したか、" +
          "⚙️のURLが正しい /exec のURLかを確認してください。" +
          "エディタの「実行数」に残ったエラーも確認してください。"
      );
    }
    throw new Error(
      "サーバーの応答を読み取れませんでした（HTTP " + res.status + "）: " + head
    );
  }
}

async function apiPost(payload) {
  const body = { ...payload };
  if (state.session && body.token === undefined) body.token = state.session.token;
  const res = await fetch(state.config.endpoint, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(body),
  });
  const data = await readJsonResponse(res);
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
  const data = await readJsonResponse(res);
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
  badge.textContent = status === "error" ? m.text + " ⓘ" : m.text;
  badge.className = "sync-badge " + m.cls;
  badge.title =
    status === "error"
      ? "クリックすると通信エラーの詳細を表示します"
      : "クラウド連携の状態";
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
    const msg = recordError("クラウドから読み込み（doGet）", err);
    setSync("error");
    loadCache();
    toast("クラウド読込に失敗：" + msg, 8000);
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
  $("#deptMgmtCard").hidden = !(cloud && state.isAdmin && state.authEnabled);
  $("#memoryCard").hidden = !(cloud && state.isAdmin && state.authEnabled);
  $("#fareMgmtCard").hidden = !(cloud && state.isAdmin && state.authEnabled);
  // 運賃のWeb照合はサーバー側で行うため、ローカル（試用）モードや
  // Code.gs が古い版のままの環境では使えない
  const fareBtn = $("#fareLookupBtn");
  const fareReady = cloud && !!state.session && !!state.features.fare;
  fareBtn.disabled = !fareReady;
  // Web照合を使わない運用（運賃マスタのみ）では、ボタンの文言を実態に合わせる
  const masterOnly = state.features.fareWeb === false;
  fareBtn.textContent = masterOnly ? "🔎 運賃マスタと照合" : "🔎 Webで運賃を照合";
  fareBtn.title = !cloud || !state.session
    ? "運賃の照合はクラウド連携（ログイン）が必要です。区間と回数は入力できます。"
    : !state.features.fare
    ? "Apps Script のコードが古い版です。最新の Code.gs を貼り付けて再デプロイしてください。"
    : masterOnly
    ? "運賃マスタに登録済みの区間と突き合わせます（未登録なら路線検索で調べてください）"
    : "出発駅・到着駅から運賃を調べて申請額と突き合わせます";
  if (cloud && state.session) {
    $("#sessionName").textContent = state.session.user.displayName;
    const roleEl = $("#sessionRole");
    const isAdmin = state.session.user.role === "admin";
    roleEl.textContent = isAdmin ? "管理者" : "一般";
    roleEl.className = "role-badge" + (isAdmin ? "" : " is-user");
  }
}

/** 事業部プルダウン・管理UIを state.departments に同期 */
function applyDeptUI() {
  const depts = state.departments || [];
  const myDept =
    cloudEnabled() && state.session ? state.session.user.department || "" : "";

  // 申請フォームの事業部プルダウン（既定=自分の所属。無ければ先頭）
  const opts = depts
    .map((d) => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`)
    .join("");
  const expDept = $("#expDept");
  if (expDept) {
    expDept.innerHTML =
      `<option value="">（未選択）</option>` + opts;
    expDept.value = myDept && depts.includes(myDept) ? myDept : "";
  }

  // ユーザー追加フォームの事業部プルダウン
  const nuDept = $("#nuDept");
  if (nuDept) nuDept.innerHTML = `<option value="">（未設定）</option>` + opts;

  // 管理画面の事業部チップ一覧
  const chips = $("#deptChips");
  if (chips) {
    chips.innerHTML = depts.length
      ? depts
          .map(
            (d) => `
        <span class="dept-chip">${escapeHtml(d)}
          <button type="button" data-dept-del="${escapeHtml(d)}" title="削除">×</button>
        </span>`
          )
          .join("")
      : `<span class="empty" style="padding:0">事業部が未登録です。</span>`;
  }
}

/** 事業部の選択肢HTML（インライン用・指定値をselected） */
function deptOptionsHtml(selected) {
  const blank = `<option value=""${selected ? "" : " selected"}>（未設定）</option>`;
  return (
    blank +
    (state.departments || [])
      .map(
        (d) =>
          `<option value="${escapeHtml(d)}"${
            d === selected ? " selected" : ""
          }>${escapeHtml(d)}</option>`
      )
      .join("")
  );
}

async function refreshDepartments() {
  try {
    const data = await apiPost({ action: "listDepartments" });
    if (data.departments) state.departments = data.departments;
    applyDeptUI();
  } catch (err) {
    if (err instanceof AuthError) return handleAuthError();
  }
}

async function handleDeptAdd(evt) {
  evt.preventDefault();
  const name = $("#newDeptName").value.trim();
  if (!name) return;
  try {
    const data = await apiPost({ action: "addDepartment", name });
    if (data.departments) state.departments = data.departments;
    $("#newDeptName").value = "";
    applyDeptUI();
    loadUsers();
    toast("事業部を追加しました");
  } catch (err) {
    if (err instanceof AuthError) return handleAuthError();
    toast(err.message || "追加に失敗しました");
  }
}

async function deleteDepartment(name) {
  if (!window.confirm(`事業部「${name}」を選択肢から削除しますか？\n（過去の申請データの事業部名は残ります）`)) return;
  try {
    const data = await apiPost({ action: "deleteDepartment", name });
    if (data.departments) state.departments = data.departments;
    applyDeptUI();
    loadUsers();
    toast("事業部を削除しました");
  } catch (err) {
    if (err instanceof AuthError) return handleAuthError();
    toast(err.message || "削除に失敗しました");
  }
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
        <td><select class="dept-inline-select" data-user-setdept="${escapeHtml(
          u.username
        )}">${deptOptionsHtml(u.department || "")}</select></td>
        <td><span class="role-badge ${u.role === "admin" ? "" : "is-user"}">${
            u.role === "admin" ? "管理者" : "一般"
          }</span></td>
        <td>${u.active ? "有効" : '<span style="color:var(--red)">無効</span>'}</td>
        <td>
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

/* =========================================================================
 * AI解析の学習データ（管理者のみ）
 * ========================================================================= */

async function loadVendorMemory() {
  try {
    const data = await apiPost({ action: "listVendorMemory" });
    renderVendorMemory(data.items || []);
  } catch (err) {
    if (err instanceof AuthError) return handleAuthError();
    toast(err.message || "学習データの取得に失敗しました");
  }
}

function renderVendorMemory(items) {
  const tbody = $("#memoryTable tbody");
  tbody.innerHTML = items.length
    ? items
        .map(
          (m) => `
      <tr>
        <td>${escapeHtml(m.vendor || "（店名なし）")}</td>
        <td>${escapeHtml(m.category || "—")}</td>
        <td>${escapeHtml(m.description || "—")}</td>
        <td>${m.count}</td>
        <td>${m.mistakes ? `${m.mistakes}件` : "—"}</td>
        <td>
          <button class="btn btn--ghost btn--sm" data-memory-del="${escapeHtml(
            m.key
          )}" data-memory-name="${escapeHtml(m.vendor || "")}">学習を削除</button>
        </td>
      </tr>`
        )
        .join("")
    : `<tr><td colspan="6" class="empty">まだ学習データがありません。AI解析を使って申請すると貯まります。</td></tr>`;
}

async function deleteVendorMemory(key, name) {
  if (
    !window.confirm(
      `「${name || key}」の学習内容を削除しますか？\n（この店舗の自動補正が初期状態に戻ります。申請データは消えません）`
    )
  ) {
    return;
  }
  try {
    const data = await apiPost({ action: "deleteVendorMemory", key });
    toast(`学習データを削除しました（${data.deleted || 0}件）`);
    await loadVendorMemory();
  } catch (err) {
    if (err instanceof AuthError) return handleAuthError();
    toast(err.message || "削除に失敗しました");
  }
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

async function handleUserDeptChange(e) {
  const sel = e.target.closest("[data-user-setdept]");
  if (!sel) return;
  const username = sel.dataset.userSetdept;
  try {
    await apiPost({
      action: "upsertUser",
      user: { username, department: sel.value },
    });
    toast("事業部を更新しました（以降の申請から反映）");
  } catch (err) {
    if (err instanceof AuthError) return handleAuthError();
    toast(err.message || "更新に失敗しました");
    loadUsers();
  }
}

async function handleUserTableClick(e) {
  const toggle = e.target.closest("[data-user-toggle]");
  const pw = e.target.closest("[data-user-pw]");
  try {
    if (toggle) {
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
  // 合計金額と誤認しやすい行は除外
  const negative = /(預り|預かり|お釣|釣り?銭|現金|クレジット|カード|ポイント|残高|値引|割引|チャージ)/;
  const strong = /(合\s*計|総額|ご?請求)/; // 最優先
  const medium = /(税込|お?支払)/;
  const weak = /計/; // 小計なども含むため弱い
  const candidates = [];
  for (const line of lines) {
    if (negative.test(line)) continue;
    const hasMoneyMark = /[¥￥]|円/.test(line);
    let weight = 0;
    if (strong.test(line)) weight = 3;
    else if (medium.test(line)) weight = 2;
    else if (weak.test(line)) weight = 1;
    if (!hasMoneyMark && !weight) continue;
    const nums = line.match(/[¥￥]?\s*[\d０-９][\d０-９,，]*/g) || [];
    for (const raw of nums) {
      const v = parseAmount(raw);
      if (!isNaN(v) && v >= 10 && v <= 100000000) {
        candidates.push({ v, weight: weight || 1 });
      }
    }
  }
  if (!candidates.length) return null;
  // 最も強いキーワード群の中の最大値を採用
  const top = Math.max(...candidates.map((c) => c.weight));
  const pool = candidates.filter((c) => c.weight === top);
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

/**
 * OCRの文字化けらしさを判定。誤った店名で埋めるより空にする方が安全。
 * 判定: 単語が細かく分断されている／記号や長音記号が多い／日本語らしい塊が無い。
 */
function looksGarbled(s) {
  const v = String(s || "").trim();
  if (v.length < 2) return true;
  const tokens = v.split(/\s+/);
  const shortTokens = tokens.filter((t) => t.length === 1).length;
  if (tokens.length >= 3 && shortTokens >= 2) return true; // 1文字トークンが散在
  if ((v.match(/[ー－~ｰ]/g) || []).length >= 3) return true; // 長音記号の連発
  if ((v.match(/[^\p{L}\p{N}\s()（）・\-＆&']/gu) || []).length >= 3) return true; // 記号過多
  // 3文字以上つながった日本語/英数の塊が1つも無ければ文字化けとみなす
  if (!/[\p{Script=Han}\p{Script=Katakana}\p{Script=Hiragana}A-Za-z0-9]{3,}/u.test(v)) {
    return true;
  }
  return false;
}

function extractVendor(text) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length >= 2);
  for (const line of lines.slice(0, 5)) {
    if (/^[\d\s¥￥,.\-\/:]+$/.test(line)) continue;
    if (/(領\s*収\s*書|レシート|receipt)/i.test(line)) continue;
    if (/(様|御中)\s*$/.test(line)) continue; // 宛名は店名ではない
    if (/^T\d{6,}/.test(line)) continue; // インボイス登録番号
    const v = line.slice(0, 40);
    if (looksGarbled(v)) continue; // 文字化けは採用しない
    return v;
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
// ドライブ保存用（サイズ節約）
async function makeUploadBase64(file) {
  const dataUrl = await scaleImage(file, 1600, 0.8);
  return dataUrl ? { base64: dataUrl.split(",")[1], mime: "image/jpeg" } : null;
}

/** 1回のデコードで縮小版を複数作る（スマホの大きな写真は decode が重いため） */
function decodeImage(file) {
  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => resolve({ img, url });
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    img.src = url;
  });
}
function imgToDataUrl(img, maxSize, quality) {
  const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", quality);
}

/**
 * サムネイルとAI解析用画像を1回のデコードで生成し、結果をキャッシュする。
 * AI解析用は 1600px/0.85（Geminiは内部でタイル分割するため過大な解像度は
 * 転送時間だけ増えて精度に寄与しにくい）。
 */
async function prepareImageVariants(file) {
  const decoded = await decodeImage(file);
  if (!decoded) return null;
  const { img, url } = decoded;
  const thumb = imgToDataUrl(img, 480, 0.7);
  const ai = imgToDataUrl(img, 1600, 0.85);
  URL.revokeObjectURL(url);
  return { thumb, aiBase64: ai.split(",")[1] };
}

/**
 * OCR前処理: 適正解像度へ拡大 → グレースケール → 大津の二値化。
 * レシートの薄い印字・低解像度写真での認識精度を上げる。
 */
function preprocessForOcr(file) {
  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const target = 1600;
      const maxDim = Math.max(img.width, img.height);
      const scale = Math.min(2.5, Math.max(1, target / maxDim)); // 小さい画像は拡大
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext("2d");
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      try {
        const im = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const d = im.data;
        // グレースケール + ヒストグラム
        const hist = new Array(256).fill(0);
        for (let i = 0; i < d.length; i += 4) {
          const g = Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
          d[i] = d[i + 1] = d[i + 2] = g;
          hist[g]++;
        }
        // 大津の方法で二値化しきい値を求める
        const total = d.length / 4;
        let sum = 0;
        for (let t = 0; t < 256; t++) sum += t * hist[t];
        let sumB = 0, wB = 0, maxVar = 0, threshold = 127;
        for (let t = 0; t < 256; t++) {
          wB += hist[t];
          if (!wB) continue;
          const wF = total - wB;
          if (!wF) break;
          sumB += t * hist[t];
          const mB = sumB / wB;
          const mF = (sum - sumB) / wF;
          const v = wB * wF * (mB - mF) * (mB - mF);
          if (v > maxVar) {
            maxVar = v;
            threshold = t;
          }
        }
        for (let i = 0; i < d.length; i += 4) {
          const v = d[i] > threshold ? 255 : 0;
          d[i] = d[i + 1] = d[i + 2] = v;
        }
        ctx.putImageData(im, 0, 0);
      } catch (err) {
        // 前処理に失敗しても拡大済みキャンバスをそのまま使う
        console.warn("preprocess failed", err);
      }
      resolve(canvas);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    img.src = url;
  });
}

/** Tesseract をレシート向け設定（単一ブロック・空白保持）で実行 */
async function tesseractRecognize(input, onProgress) {
  if (Tesseract.createWorker) {
    let worker;
    try {
      worker = await Tesseract.createWorker("jpn+eng", 1, { logger: onProgress });
      await worker.setParameters({
        tessedit_pageseg_mode: "6", // 単一の均一テキストブロックとして解析
        preserve_interword_spaces: "1",
      });
      const { data } = await worker.recognize(input);
      return data.text || "";
    } catch (err) {
      console.warn("worker OCR failed, falling back", err);
    } finally {
      if (worker) {
        try { await worker.terminate(); } catch { /* noop */ }
      }
    }
  }
  const { data } = await Tesseract.recognize(input, "jpn+eng", { logger: onProgress });
  return data.text || "";
}

/**
 * AIレシート解析（クラウド側 Claude vision）。
 * 成功時はフォームへ反映して true、未設定・失敗時は false（OCRへフォールバック）。
 */
async function runAiAnalyze(file) {
  const statusEl = $("#ocrStatus");
  const barFill = $("#ocrBarFill");
  const statusText = $("#ocrStatusText");
  statusEl.hidden = false;
  $("#ocrRawWrap").hidden = true;
  $("#ocrError").hidden = true;
  state.lastAiFields = null;
  barFill.style.width = "60%";
  statusText.textContent = "AIがレシートを解析中…（数秒かかります）";
  try {
    // アップロード時に作成済みのAI用画像を再利用（再エンコードしないので再解析が速い）
    let base64 = state.lastAiBase64;
    if (!base64) {
      const v = await prepareImageVariants(file);
      if (!v) return false;
      base64 = v.aiBase64;
      state.lastAiBase64 = base64;
    }
    const data = await apiPost({
      action: "analyzeReceipt",
      imageBase64: base64,
      imageMime: "image/jpeg",
    });
    const f = data.fields || {};
    const filled = [];
    const missing = [];
    if (f.amount) {
      $("#expAmount").value = f.amount;
      filled.push("金額");
    } else missing.push("金額");
    if (f.date) {
      $("#expDate").value = f.date;
      filled.push("日付");
    } else missing.push("日付");
    if (f.vendor) {
      $("#expVendor").value = f.vendor;
      filled.push("店名");
    } else missing.push("店名");
    if (f.category) {
      $("#expCategory").value = f.category;
      filled.push("科目");
    }
    if (f.description && !$("#expDesc").value) {
      $("#expDesc").value = f.description;
      filled.push("摘要");
    }

    // AIが読み取った全文を表示（誤読の確認・報告用）
    if (f.rawText) {
      $("#ocrRaw").textContent = f.rawText;
      $("#ocrRawWrap").hidden = false;
    }

    // AIの提案値を控えておき、送信時に手修正との差分を学習ログへ送る
    state.lastAiFields = {
      date: f.date || "",
      amount: Number(f.amount) || 0,
      vendor: f.vendor || "",
      category: f.category || "",
      description: f.description || "",
      rawText: (f.rawText || "").slice(0, 400),
    };

    barFill.style.width = "100%";
    let msg = filled.length
      ? `AI解析完了：${filled.join("・")}を自動入力しました（内容をご確認ください）`
      : "AI解析完了：読み取れた項目がありません。手入力してください。";
    if (filled.length && missing.length) {
      msg += ` ／ ${missing.join("・")}は読み取れませんでした（手入力してください）`;
    }
    const learned = data.learned || {};
    if (learned.retried) {
      msg += " ／ この店舗の過去の誤読を踏まえて読み直しました";
    }
    if (learned.applied && learned.applied.length) {
      msg += ` ／ 過去の修正から${learned.applied.join("・")}を自動補正しました`;
    }
    statusText.textContent = msg;
    return true;
  } catch (err) {
    if (err instanceof AuthError) {
      handleAuthError();
      return true; // ログイン画面へ誘導済み。OCRへは進まない
    }
    console.error(err);
    // 失敗理由を画面に残す（OCRのメッセージで上書きされないよう別要素に表示）
    const errEl = $("#ocrError");
    const raw = err.message || "不明";
    // 一時的な混雑（503等）は待って再試行すれば通ることが多い
    const busy = /503|high demand|overloaded|UNAVAILABLE|quota|RESOURCE_EXHAUSTED|429/i.test(raw);
    errEl.textContent = busy
      ? "AIが一時的に混雑して解析できませんでした。数十秒待って「⟳ もう一度AI解析」を押すと成功することが多いです。以下は端末内OCRの結果（精度が低い）なので必ず確認してください。／ 詳細: " +
        raw
      : "AI解析に失敗したため端末内OCRで解析します。原因: " + raw;
    errEl.hidden = false;
    statusText.textContent = "端末内OCRで解析します…";
    return false;
  }
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
    statusText.textContent = "画像を前処理中…";
    const canvas = await preprocessForOcr(file);
    const input = canvas || file;

    const text = await tesseractRecognize(input, (m) => {
      if (m.status === "recognizing text") {
        const pct = Math.round(m.progress * 100);
        barFill.style.width = pct + "%";
        statusText.textContent = `文字を認識中… ${pct}%`;
      }
    });
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
      ? `端末内OCRで解析：${filled.join("・")}を自動入力しました。精度が低い場合があるため必ず確認・修正してください`
      : "端末内OCRで解析：自動抽出できた項目はありません。手入力してください。";
  } catch (err) {
    console.error(err);
    statusText.textContent = "解析に失敗しました。手入力してください。";
  }
}

/* =========================================================================
 * 交通費の運賃照合（電車賃）
 * ========================================================================= */

/**
 * バックエンド（Apps Script）が古い版のときに案内を出す。
 * status の features は新しい Code.gs でしか返らないため、
 * 「アプリだけ更新されて Code.gs の再デプロイが済んでいない」状態を検出できる。
 */
function applyBackendNotice() {
  const el = $("#backendNotice");
  if (!el) return;
  const missing = [];
  if (!state.features.fare) missing.push("電車賃の運賃照合");
  if (!state.features.receiptImage) missing.push("領収書画像の表示");
  if (!state.features.vendorMemory) missing.push("AI解析の学習");
  if (!cloudEnabled() || !missing.length) {
    el.hidden = true;
    return;
  }
  el.innerHTML =
    "⚠️ <strong>Apps Script のコードが古い版です。</strong>" +
    escapeHtml(missing.join("・")) +
    " が使えません。最新の <code>Code.gs</code> を貼り付けて再デプロイしてください" +
    "（デプロイ → デプロイを管理 → ✏️ → 新バージョン）。";
  el.hidden = false;
}

/**
 * 科目が交通費のときだけ区間の欄を出す。
 * 電車賃を入れない申請も多いため既定は閉じておき、必要なときだけ開く。
 */
function applyFareUI() {
  const isTransit = $("#expCategory").value === "交通費";
  const box = $("#fareBox");
  box.hidden = !isTransit;
  if (!isTransit) {
    box.open = false;
    clearFareResult();
  }
  syncFareSummary();
}

/**
 * 閉じたままでも中身が分かるよう、見出しに区間の要約を出す。
 * 入力済みなら「新井薬師前→武蔵浦和 往復 ×2回」のように表示する。
 */
function syncFareSummary() {
  const el = $("#fareSummary");
  if (!el) return;
  const f = readFareInput();
  if (!f.from && !f.to) {
    el.textContent = "区間を入れると運賃を照合できます";
    el.classList.remove("is-set");
    return;
  }
  const parts = [`${f.from || "?"}→${f.to || "?"}`, f.round ? "往復" : "片道"];
  if (f.trips > 1) parts.push(`×${f.trips}回`);
  el.textContent = parts.join(" ");
  el.classList.add("is-set");
}

function clearFareResult() {
  state.lastFare = null;
  $("#fareResult").hidden = true;
  $("#fareResult").className = "fare-result";
  $("#fareApplyBtn").hidden = true;
}

/**
 * 路線検索を開くURL。AI・APIを使わず、利用者が自分のブラウザで確認するためのもの。
 * （検索サイトを自動で読み取る行為は各社の規約で禁止されているため、
 *   あくまで人が開くリンクとして提供する）
 */
function transitSearchUrl(from, to) {
  if (!from || !to) return "";
  return (
    "https://transit.yahoo.co.jp/search/result?from=" +
    encodeURIComponent(from) +
    "&to=" +
    encodeURIComponent(to)
  );
}

/** 区間の入力に合わせて「路線検索で調べる」リンクを更新する */
function syncFareSearchLink(linkId, from, to) {
  const el = $(linkId);
  if (!el) return;
  const url = transitSearchUrl(from, to);
  el.href = url || "#";
  el.classList.toggle("is-disabled", !url);
}

/** 入力欄から区間の指定を読み取る */
function readFareInput() {
  return {
    from: $("#fareFrom").value.trim(),
    to: $("#fareTo").value.trim(),
    round: $("#fareRound").value === "round",
    trips: Math.max(1, Math.min(60, Number($("#fareTrips").value) || 1)),
  };
}

/** 想定金額の内訳を「510円 × 往復 × 2回 = 2,040円」の形で表す */
function fareBreakdown(f) {
  const parts = [yen(f.unit)];
  if (f.round) parts.push("往復");
  if (f.trips > 1) parts.push(`${f.trips}回`);
  return `${parts.join(" × ")} = ${yen(f.expected)}`;
}

/** 区間の運賃を照合し、申請額と突き合わせて結果を表示する */
async function lookupFare() {
  if (!cloudEnabled() || !state.session) {
    toast("運賃の照合はクラウド連携（ログイン）が必要です");
    return;
  }
  const input = readFareInput();
  if (!input.from || !input.to) {
    toast("出発駅と到着駅を入力してください");
    return;
  }
  const btn = $("#fareLookupBtn");
  const result = $("#fareResult");
  btn.disabled = true;
  result.hidden = false;
  result.className = "fare-result";
  result.textContent = "運賃を照合中…（初めての区間はWebで調べるため数秒かかります）";
  try {
    const data = await apiPost({
      action: "lookupFare",
      from: input.from,
      to: input.to,
      round: input.round,
      trips: input.trips,
    });
    if (data.registered === false) {
      // 未登録はエラーではない。次にやること（路線検索→金額入力）を伝える
      state.lastFare = null;
      result.className = "fare-result is-warn";
      result.textContent = data.message || "この区間は運賃マスタに未登録です。";
      $("#fareApplyBtn").hidden = true;
      if (data.justDisabled) state.features.fareWeb = false;
      applySessionUI(); // 照合ボタンの表示を切り替える
      return;
    }
    state.lastFare = data;
    renderFareResult();
  } catch (err) {
    if (err instanceof AuthError) return handleAuthError();
    state.lastFare = null;
    result.className = "fare-result is-error";
    result.textContent =
      "照合できませんでした：" + recordError("運賃照合（lookupFare）", err);
    $("#fareApplyBtn").hidden = true;
  } finally {
    btn.disabled = false;
  }
}

/** 照合結果と、申請額との一致／差額を表示する */
function renderFareResult() {
  const f = state.lastFare;
  if (!f) return clearFareResult();
  const result = $("#fareResult");
  const amount = Number($("#expAmount").value);
  const lines = [`想定金額：${fareBreakdown(f)}`];
  if (f.route) lines.push(`経路：${f.route}`);
  // 手で登録した運賃は人が確認済みなので、出典が無くても警告しない
  const manual = /^手動/.test(f.checkedBy || "");
  lines.push(
    manual
      ? `運賃マスタの登録値で照合（${f.checkedBy}）`
      : f.cached
      ? "運賃マスタの登録値で照合（Web検索なし）"
      : "Web検索で照合し、運賃マスタへ登録しました"
  );
  // AIが答えたのに出典が無い＝検索が使われず記憶で答えた可能性があり、裏付けが弱い
  if (!manual && !f.source) {
    lines.push("⚠️ 検索の出典が取れていません。運賃が正しいか必ず確認してください");
  }

  let cls = manual || f.source ? "fare-result is-ok" : "fare-result is-warn";
  if (!amount) {
    lines.push("金額が空のため「金額に反映」で入力できます");
  } else if (amount === f.expected) {
    lines.unshift("✅ 申請額は想定金額と一致しています");
  } else {
    cls = "fare-result is-warn";
    const diff = amount - f.expected;
    lines.unshift(
      `⚠️ 申請額 ${yen(amount)} は想定金額と ${yen(Math.abs(diff))} ${
        diff > 0 ? "多い" : "少ない"
      }です`
    );
  }
  result.className = cls;
  result.innerHTML =
    lines.map((l) => `<span>${escapeHtml(l)}</span>`).join("") +
    (f.source
      ? `<a href="${escapeHtml(f.source)}" target="_blank" rel="noopener">出典を開く ↗</a>`
      : "");
  result.hidden = false;
  $("#fareApplyBtn").hidden = !f.expected;
}

/** 照合した想定金額を金額欄へ入れる */
function applyFareToAmount() {
  const f = state.lastFare;
  if (!f || !f.expected) return;
  $("#expAmount").value = f.expected;
  renderFareResult();
}

/* ---------- 運賃マスタ（管理者のみ） ---------- */

async function loadFares() {
  try {
    const data = await apiPost({ action: "listFares" });
    renderFares(data.items || []);
  } catch (err) {
    if (err instanceof AuthError) return handleAuthError();
    toast(err.message || "運賃マスタの取得に失敗しました");
  }
}

function renderFares(items) {
  const tbody = $("#fareTable tbody");
  tbody.innerHTML = items.length
    ? items
        .map(
          (f) => `
      <tr>
        <td>${escapeHtml(f.from)}</td>
        <td>${escapeHtml(f.to)}</td>
        <td class="num">
          <input class="fare-inline-input" type="number" min="1" step="1"
            value="${f.fare}" data-fare-edit="${escapeHtml(f.key)}"
            data-from="${escapeHtml(f.from)}" data-to="${escapeHtml(f.to)}" />
        </td>
        <td>${escapeHtml(f.route || "—")}</td>
        <td>${
          f.source
            ? `<a href="${escapeHtml(f.source)}" target="_blank" rel="noopener">出典 ↗</a>`
            : "—"
        }</td>
        <td>${escapeHtml((f.checkedAt || "").slice(0, 10))}<br /><span class="fare-by">${escapeHtml(
            f.checkedBy || ""
          )}</span></td>
        <td>
          <button class="btn btn--ghost btn--sm" data-fare-del="${escapeHtml(
            f.key
          )}" data-label="${escapeHtml(f.from + "〜" + f.to)}">削除</button>
        </td>
      </tr>`
        )
        .join("")
    : `<tr><td colspan="7" class="empty">まだ区間がありません。申請時に区間を照合すると貯まります。</td></tr>`;
}

async function saveFareEdit(el) {
  const fare = Number(el.value);
  if (!fare || fare <= 0) {
    toast("片道運賃は1円以上で入力してください");
    return loadFares();
  }
  try {
    const data = await apiPost({
      action: "upsertFare",
      from: el.dataset.from,
      to: el.dataset.to,
      fare,
    });
    renderFares(data.items || []);
    toast("運賃を更新しました");
  } catch (err) {
    if (err instanceof AuthError) return handleAuthError();
    toast(err.message || "更新に失敗しました");
    loadFares();
  }
}

async function handleFareAdd(evt) {
  evt.preventDefault();
  try {
    const data = await apiPost({
      action: "upsertFare",
      from: $("#nfFrom").value.trim(),
      to: $("#nfTo").value.trim(),
      fare: Number($("#nfFare").value),
      route: $("#nfRoute").value.trim(),
    });
    $("#fareAddForm").reset();
    syncFareSearchLink("#nfSearchLink", "", "");
    renderFares(data.items || []);
    toast("区間を登録しました");
  } catch (err) {
    if (err instanceof AuthError) return handleAuthError();
    toast(err.message || "登録に失敗しました");
  }
}

/** 区間をまとめて登録する（初期設定用） */
async function handleFareBulk() {
  const text = $("#fareBulkText").value.trim();
  const out = $("#fareBulkResult");
  if (!text) {
    toast("登録する内容を入力してください");
    return;
  }
  const btn = $("#fareBulkBtn");
  btn.disabled = true;
  try {
    const data = await apiPost({ action: "bulkUpsertFares", text });
    renderFares(data.items || []);
    const errors = data.errors || [];
    out.hidden = false;
    out.className = errors.length ? "fare-result is-warn" : "fare-result is-ok";
    out.innerHTML =
      `<span>${data.added} 件を登録しました。</span>` +
      errors.map((e) => `<span>⚠️ ${escapeHtml(e)}</span>`).join("");
    // 登録できた行だけ消し、直せなかった行は残して修正できるようにする
    if (!errors.length) $("#fareBulkText").value = "";
    toast(`運賃マスタへ ${data.added} 件を登録しました`);
  } catch (err) {
    if (err instanceof AuthError) return handleAuthError();
    out.hidden = false;
    out.className = "fare-result is-error";
    out.textContent = "登録に失敗しました：" + (err.message || "不明なエラー");
  } finally {
    btn.disabled = false;
  }
}

async function deleteFare(key, label) {
  if (
    !window.confirm(
      `区間「${label}」を運賃マスタから削除しますか？\n（次回この区間を照合すると、またWebで調べ直します）`
    )
  ) {
    return;
  }
  try {
    const data = await apiPost({ action: "deleteFare", key });
    renderFares(data.items || []);
    toast("区間を削除しました");
  } catch (err) {
    if (err instanceof AuthError) return handleAuthError();
    toast(err.message || "削除に失敗しました");
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
  // 1回のデコードでサムネイルとAI用画像を同時に用意（待ち時間短縮）
  const v = await prepareImageVariants(file);
  state.lastImageThumb = v ? v.thumb : null;
  state.lastAiBase64 = v ? v.aiBase64 : null;
  $("#previewImg").src = state.lastImageThumb || "";
  $("#preview").hidden = false;
  await analyzeCurrentImage();
}

/** 現在の画像を解析（AI → 端末内OCR の順でフォールバック） */
async function analyzeCurrentImage() {
  const file = state.lastImageFile;
  if (!file) return;
  if (cloudEnabled() && state.session && state.aiOcr) {
    const done = await runAiAnalyze(file);
    if (done) return;
  }
  runOcr(file);
}

/** 画像を時計回りに90度回転し、再解析する（倒れた写真の精度対策） */
async function rotateAndReanalyze() {
  const file = state.lastImageFile;
  if (!file) return;
  const rotated = await rotateImageFile(file, 90);
  if (!rotated) {
    toast("画像を回転できませんでした");
    return;
  }
  state.lastImageFile = rotated;
  const v = await prepareImageVariants(rotated);
  state.lastImageThumb = v ? v.thumb : null;
  state.lastAiBase64 = v ? v.aiBase64 : null; // 回転後は作り直す
  $("#previewImg").src = state.lastImageThumb || "";
  toast("画像を90°回転しました。再解析します…");
  await analyzeCurrentImage();
}

/** 画像ファイルを指定角度で回転した新しい File を返す */
function rotateImageFile(file, deg) {
  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const swap = deg % 180 !== 0;
      const canvas = document.createElement("canvas");
      canvas.width = swap ? img.height : img.width;
      canvas.height = swap ? img.width : img.height;
      const ctx = canvas.getContext("2d");
      ctx.translate(canvas.width / 2, canvas.height / 2);
      ctx.rotate((deg * Math.PI) / 180);
      ctx.drawImage(img, -img.width / 2, -img.height / 2);
      URL.revokeObjectURL(url);
      canvas.toBlob(
        (blob) => {
          resolve(
            blob
              ? new File([blob], (file.name || "receipt") + ".jpg", {
                  type: "image/jpeg",
                })
              : null
          );
        },
        "image/jpeg",
        0.95
      );
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    img.src = url;
  });
}

function clearImage() {
  state.lastImageThumb = null;
  state.lastImageFile = null;
  state.lastAiBase64 = null;
  state.lastAiFields = null;
  $("#preview").hidden = true;
  $("#previewImg").src = "";
  $("#imageInput").value = "";
  $("#ocrStatus").hidden = true;
  $("#ocrRawWrap").hidden = true;
  $("#ocrError").hidden = true;
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

  // 交通費で区間が入力されていれば、照合用に一緒に送る
  // （片道運賃と想定金額はサーバー側が運賃マスタから計算し直す）
  const fare = $("#expCategory").value === "交通費" ? readFareInput() : null;
  const fareFields =
    fare && fare.from && fare.to
      ? {
          fareFrom: fare.from,
          fareTo: fare.to,
          fareRound: fare.round,
          fareTrips: fare.trips,
        }
      : {};

  const base = {
    id: uid(),
    // クラウドモードでは申請者はサーバー側でセッションから強制される
    applicant: cloudEnabled()
      ? state.session.user.displayName
      : state.currentUser,
    ...fareFields,
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
      // 解析時に作成した画像を再利用（無ければここで生成）。再エンコードを避けて送信を高速化
      let img = null;
      if (state.lastAiBase64) {
        img = { base64: state.lastAiBase64, mime: "image/jpeg" };
      } else if (state.lastImageFile) {
        img = await makeUploadBase64(state.lastImageFile);
      }
      const record = { ...base };
      if (img) {
        record.imageBase64 = img.base64;
        record.imageMime = img.mime;
      }
      // AI解析を使った申請は提案値も送り、手修正の差分をサーバー側で学習させる
      if (state.lastAiFields) record.ai = state.lastAiFields;
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
    applyFareUI();
    clearFareResult();
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

/* ---------- 領収書画像 ---------- */

/** 申請から Drive のファイルIDを取り出す（古いデータは URL から拾う） */
function receiptFileId(e) {
  if (e.imageFileId) return String(e.imageFileId);
  const m = String(e.imageUrl || "").match(/\/file\/d\/([^/?#]+)/);
  return m ? m[1] : "";
}

/**
 * アプリ経由で取得した画像のキャッシュ（`ファイルID:t|f` → data URL）。
 * ドライブを共有していない環境では毎回の再描画で再取得しないために持つ。
 */
const receiptCache = new Map();
const receiptCacheKey = (id, thumb) => id + (thumb ? ":t" : ":f");

/**
 * 領収書画像の表示用URL。
 * クラウドモードは Drive のサムネイルエンドポイント（幅を指定して軽量化）、
 * ローカル（試用）モードは端末内に持っている data URL をそのまま使う。
 * アプリ経由で取得済みの画像があればそれを優先する。
 */
function receiptImageUrl(e, width) {
  const id = receiptFileId(e);
  if (id) {
    const cached = receiptCache.get(receiptCacheKey(id, isThumbSize(width)));
    if (cached) return cached;
    return (
      "https://drive.google.com/thumbnail?id=" +
      encodeURIComponent(id) +
      "&sz=w" +
      (width || 400)
    );
  }
  return e.imageThumb || "";
}

const isThumbSize = (width) => (width || 400) <= 400;

function hasReceipt(e) {
  return !!receiptImageUrl(e);
}

/**
 * アプリ（GAS）経由で画像を取得する。
 * 領収書はGAS実行アカウントのドライブにあるため、フォルダを共有していない
 * 利用者のブラウザからは drive.google.com のサムネイルを直接読めない。
 * その場合のフォールバック。
 */
async function fetchReceiptDataUrl(id, thumb) {
  const key = receiptCacheKey(id, thumb);
  if (receiptCache.has(key)) return receiptCache.get(key);
  const data = await apiPost({
    action: "receiptImage",
    imageFileId: id,
    thumb: !!thumb,
  });
  if (!data.dataUrl) throw new Error("画像を取得できませんでした");
  receiptCache.set(key, data.dataUrl);
  return data.dataUrl;
}

/** 画像が読めなかったとき（権限が無い・削除済みなど）に枠だけ残して知らせる */
function markReceiptBroken(img) {
  const box = img.closest(".thumb");
  if (box) box.classList.add("is-error");
  img.remove();
}

/** サムネイルの読み込み失敗 → アプリ経由で取り直し、それも駄目なら枠表示 */
function onReceiptImgError(img) {
  const id = img.dataset.fileId || "";
  if (!id || img.dataset.retried || !isCloudAuthed()) return markReceiptBroken(img);
  img.dataset.retried = "1";
  fetchReceiptDataUrl(id, img.dataset.thumb === "1").then(
    (url) => {
      img.src = url;
    },
    () => markReceiptBroken(img)
  );
}

/** サムネイル画像のHTML（読み込み失敗時はアプリ経由の取得へ切り替える） */
function receiptImgTag(e, width) {
  const thumb = isThumbSize(width);
  return `<img src="${escapeHtml(receiptImageUrl(e, width))}" alt="領収書" loading="lazy"
    data-file-id="${escapeHtml(receiptFileId(e))}" data-thumb="${thumb ? 1 : 0}"
    onerror="onReceiptImgError(this)" />`;
}

/** 表の「領収書」セル（クリックで拡大表示） */
function receiptCell(e, scope) {
  if (!hasReceipt(e)) return '<span class="thumb thumb--none thumb--sm">—</span>';
  return `<button type="button" class="thumb thumb--sm" data-receipt="${escapeHtml(
    e.id
  )}" data-scope="${scope}" title="領収書を拡大表示">${receiptImgTag(e, 200)}</button>`;
}

/** カード用の領収書サムネイル（画像が無い場合は同じ大きさの枠を出す） */
function receiptThumb(e, scope) {
  if (!hasReceipt(e)) {
    return '<span class="thumb thumb--none">領収書<br />なし</span>';
  }
  return `<button type="button" class="thumb" data-receipt="${escapeHtml(
    e.id
  )}" data-scope="${scope}" title="領収書を拡大表示">${receiptImgTag(e, 400)}</button>`;
}

/** 運賃照合の結果バッジ（交通費で区間が指定された申請にだけ付く） */
function fareBadge(e) {
  const label = {
    match: ["一致", "is-match", "申請額が想定運賃と一致"],
    diff: ["差額あり", "is-diff", "申請額が想定運賃と違う"],
    unchecked: ["未照合", "is-unchecked", "運賃マスタに区間が無く照合できていない"],
  }[e.fareCheck];
  if (!label) return "";
  const detail = e.fareExpected ? `（想定 ${yen(Number(e.fareExpected))}）` : "";
  return `<span class="fare-badge ${label[1]}" title="${escapeHtml(
    label[2] + detail
  )}">🚃 ${label[0]}</span>`;
}

/** 区間の説明（例: 新井薬師前→武蔵浦和 往復 ×2） */
function fareRouteText(e) {
  if (!e.fareFrom || !e.fareTo) return "";
  const round = e.fareRound === true || String(e.fareRound).toLowerCase() === "true";
  const trips = Number(e.fareTrips) || 1;
  return (
    `${e.fareFrom}→${e.fareTo}` +
    (round ? " 往復" : " 片道") +
    (trips > 1 ? ` ×${trips}回` : "")
  );
}

/**
 * カード表示（領収書サムネイル付き）。
 * ops は各申請の操作ボタンHTMLを返す関数（無ければ操作なし）。
 */
function expenseCardsHtml(rows, scope, ops) {
  return rows
    .map(
      (e) => `
    <article class="ecard">
      <header class="ecard__head">
        <span class="ecard__who">${escapeHtml(e.applicant || "—")}${
          e.department ? ` <span class="ecard__dept">${escapeHtml(e.department)}</span>` : ""
        }</span>
        <span class="ecard__date">${escapeHtml(e.date)}</span>
      </header>
      <div class="ecard__body">
        ${receiptThumb(e, scope)}
        <div class="ecard__main">
          <div class="ecard__tags">
            <span class="chip">${escapeHtml(e.category)}</span>
            <span class="badge badge--${e.status}">${STATUS_LABEL[e.status]}</span>
            ${fareBadge(e)}
          </div>
          <p class="ecard__amount">${yen(e.amount)}</p>
          <p class="ecard__vendor">${escapeHtml(
            fareRouteText(e) || e.vendor || "支払先なし"
          )}</p>
          ${e.description ? `<p class="ecard__desc">${escapeHtml(e.description)}</p>` : ""}
          ${
            e.reviewComment
              ? `<p class="ecard__note">${escapeHtml(e.reviewComment)}</p>`
              : ""
          }
          ${ops ? `<div class="ecard__ops">${ops(e)}</div>` : ""}
        </div>
      </div>
    </article>`
    )
    .join("");
}

/** 一覧の表示形式（カード／表）を切り替えて描画する */
function applyViewUI(scope) {
  const view = state.views[scope] === "table" ? "table" : "cards";
  const cards = $(`#${scope}Cards`);
  const table = $(`#${scope}TableWrap`);
  if (cards) cards.hidden = view !== "cards";
  if (table) table.hidden = view !== "table";
  $$(`#${scope}ViewToggle button`).forEach((b) =>
    b.classList.toggle("is-on", b.dataset.view === view)
  );
}

function setView(scope, view) {
  state.views[scope] = view === "table" ? "table" : "cards";
  saveViews();
  applyViewUI(scope);
}

/* ---------- 領収書ビューア（拡大表示） ---------- */

/** 表示中の一覧のうち画像がある申請を、ビューアの送り／戻し対象として覚えておく */
function setLightboxScope(scope, rows) {
  state.lightbox.scopeIds = state.lightbox.scopeIds || {};
  state.lightbox.scopeIds[scope] = rows.filter(hasReceipt).map((e) => e.id);
}

function openReceipt(id, scope) {
  const ids = (state.lightbox.scopeIds || {})[scope] || [id];
  const index = Math.max(0, ids.indexOf(id));
  state.lightbox = { ...state.lightbox, ids, index };
  showReceipt();
  $("#receiptModal").hidden = false;
}

function showReceipt() {
  const { ids, index } = state.lightbox;
  const e = findExpense(ids[index]);
  if (!e) return closeReceipt();
  const img = $("#lbImg");
  const showError = () => {
    img.hidden = true;
    $("#lbError").hidden = false;
  };
  $("#lbError").hidden = true;
  img.hidden = false;
  delete img.dataset.retried;
  img.src = receiptImageUrl(e, 1200);
  img.onerror = () => {
    // ドライブを直接読めない場合はアプリ経由で取り直す
    const id = receiptFileId(e);
    if (!id || img.dataset.retried || !isCloudAuthed()) return showError();
    img.dataset.retried = "1";
    fetchReceiptDataUrl(id, false).then((url) => {
      img.src = url;
    }, showError);
  };
  $("#lbTitle").textContent = `${e.date}　${yen(e.amount)}`;
  $("#lbSub").textContent = [e.applicant, e.department, e.category, e.vendor]
    .filter(Boolean)
    .join("　/　");
  $("#lbCount").textContent = ids.length > 1 ? `${index + 1} / ${ids.length}` : "";
  // ローカル（試用）モードは端末内の画像なので、ドライブのリンクは出さない
  const open = $("#lbOpen");
  open.hidden = !e.imageUrl;
  open.href = e.imageUrl || "#";
  $(".lightbox__foot").hidden = open.hidden;
  const single = ids.length < 2;
  $("[data-lb-prev]").hidden = single;
  $("[data-lb-next]").hidden = single;
}

function moveReceipt(step) {
  const { ids } = state.lightbox;
  if (ids.length < 2) return;
  state.lightbox.index = (state.lightbox.index + step + ids.length) % ids.length;
  showReceipt();
}

function closeReceipt() {
  $("#receiptModal").hidden = true;
  $("#lbImg").src = "";
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
  const cards = $("#personalCards");
  applyViewUI("personal");
  setLightboxScope("personal", rows);

  const empty = !identified
    ? cloudEnabled()
      ? "ログインすると自分の申請が表示されます。"
      : "右上で氏名を入力すると、自分の申請が表示されます。"
    : !rows.length
    ? "該当する申請はありません。"
    : "";
  if (empty) {
    tbody.innerHTML = `<tr><td colspan="8" class="empty">${empty}</td></tr>`;
    cards.innerHTML = `<p class="empty">${empty}</p>`;
    return;
  }

  const ops = (e) =>
    `<button class="btn btn--ghost btn--sm" data-del="${e.id}">取消</button>`;
  cards.innerHTML = expenseCardsHtml(rows, "personal", ops);
  tbody.innerHTML = rows
    .map(
      (e) => `
    <tr>
      <td>${escapeHtml(e.date)}</td>
      <td>${escapeHtml(e.category)}</td>
      <td>${escapeHtml(e.vendor || "—")}</td>
      <td class="num">${yen(e.amount)}</td>
      <td><span class="badge badge--${e.status}">${STATUS_LABEL[e.status]}</span>${fareBadge(e)}</td>
      <td>${receiptCell(e, "personal")}</td>
      <td>${escapeHtml(e.reviewComment || "")}</td>
      <td>${ops(e)}</td>
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

  const withReceipt = monthRecs.filter(hasReceipt).length;

  $("#adminStats").innerHTML = [
    statCard("申請件数", monthRecs.length + " 件"),
    statCard(
      "領収書あり",
      monthRecs.length ? `${withReceipt} / ${monthRecs.length} 件` : "— 件"
    ),
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
  const rf = $("#adminReceiptFilter").value;
  const ff = $("#adminFareFilter").value;
  let rows = monthRecs.filter((e) => {
    const matchQ =
      !q ||
      e.applicant.toLowerCase().includes(q) ||
      (e.vendor || "").toLowerCase().includes(q) ||
      (e.department || "").toLowerCase().includes(q);
    const matchS = sf === "all" || e.status === sf;
    const matchR =
      rf === "all" || (rf === "yes" ? hasReceipt(e) : !hasReceipt(e));
    const matchF = ff === "all" || e.fareCheck === ff;
    return matchQ && matchS && matchR && matchF;
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
  const cards = $("#adminCards");
  applyViewUI("admin");
  setLightboxScope("admin", rows);

  if (!rows.length) {
    const msg = "該当する申請はありません。";
    tbody.innerHTML = `<tr><td colspan="9" class="empty">${msg}</td></tr>`;
    cards.innerHTML = `<p class="empty">${msg}</p>`;
    return;
  }
  cards.innerHTML = expenseCardsHtml(rows, "admin", ops);
  tbody.innerHTML = rows
    .map(
      (e) => `
      <tr>
        <td>${escapeHtml(e.applicant)}</td>
        <td>${escapeHtml(e.department || "—")}</td>
        <td>${escapeHtml(e.date)}</td>
        <td>${escapeHtml(e.category)}</td>
        <td>${escapeHtml(e.vendor || "—")}</td>
        <td class="num">${yen(e.amount)}</td>
        <td>${receiptCell(e, "admin")}</td>
        <td><span class="badge badge--${e.status}">${STATUS_LABEL[e.status]}</span>${fareBadge(e)}</td>
        <td>${ops(e)}</td>
      </tr>`
    )
    .join("");
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
    "fareFrom", "fareTo", "fareRound", "fareTrips", "fareUnit",
    "fareExpected", "fareCheck",
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
    loadVendorMemory();
    loadFares();
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
    state.departments = DEFAULT_DEPARTMENTS.slice();
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
    state.aiOcr = !!st.aiOcr;
    state.features = st.features || {};
    applyBackendNotice();

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
    const msg = recordError("接続確認（status）", err);
    setSync("error");
    loadCache();
    syncAdminUI();
    render();
    toast("サーバーに接続できません：" + msg, 8000);
  }
}

function init() {
  loadConfig();
  loadViews();

  state.currentUser = localStorage.getItem(USER_KEY) || "";
  $("#currentUser").value = state.currentUser;
  $("#expDate").valueAsDate = new Date();
  applyFareUI(); // 既定の科目（交通費）に合わせて区間欄を出す
  syncFareSearchLink("#fareSearchLink", "", "");
  syncFareSearchLink("#nfSearchLink", "", "");

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
  // 同期バッジ: エラー時はクリックで詳細を表示
  $("#syncBadge").addEventListener("click", () => {
    if (state.syncStatus === "error") showLastError();
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
  $("#userTable").addEventListener("change", handleUserDeptChange);
  $("#userReloadBtn").addEventListener("click", loadUsers);

  // 交通費の運賃照合
  $("#expCategory").addEventListener("change", applyFareUI);
  $("#fareLookupBtn").addEventListener("click", lookupFare);
  $("#fareApplyBtn").addEventListener("click", applyFareToAmount);
  ["#fareRound", "#fareTrips"].forEach((sel) =>
    $(sel).addEventListener("change", () => {
      syncFareSummary();
      // 往復・回数を変えたら想定金額を作り直す（運賃は照合済みの値を再利用）
      if (!state.lastFare) return;
      const input = readFareInput();
      state.lastFare = {
        ...state.lastFare,
        round: input.round,
        trips: input.trips,
        expected: state.lastFare.unit * (input.round ? 2 : 1) * input.trips,
      };
      renderFareResult();
    })
  );
  $("#expAmount").addEventListener("input", () => {
    if (state.lastFare) renderFareResult();
  });
  ["#fareFrom", "#fareTo"].forEach((sel) =>
    $(sel).addEventListener("input", () => {
      clearFareResult();
      const f = readFareInput();
      syncFareSearchLink("#fareSearchLink", f.from, f.to);
      syncFareSummary();
    })
  );
  ["#nfFrom", "#nfTo"].forEach((sel) =>
    $(sel).addEventListener("input", () =>
      syncFareSearchLink("#nfSearchLink", $("#nfFrom").value.trim(), $("#nfTo").value.trim())
    )
  );

  // 運賃マスタ（管理者）
  $("#fareReloadBtn").addEventListener("click", loadFares);
  $("#fareAddForm").addEventListener("submit", handleFareAdd);
  $("#fareBulkBtn").addEventListener("click", handleFareBulk);
  $("#fareTable").addEventListener("click", (e) => {
    const del = e.target.closest("[data-fare-del]");
    if (del) deleteFare(del.dataset.fareDel, del.dataset.label);
  });
  $("#fareTable").addEventListener("change", (e) => {
    const edit = e.target.closest("[data-fare-edit]");
    if (edit) saveFareEdit(edit);
  });

  // AI解析の学習データ
  $("#memoryReloadBtn").addEventListener("click", loadVendorMemory);
  $("#memoryTable").addEventListener("click", (e) => {
    const del = e.target.closest("[data-memory-del]");
    if (del) deleteVendorMemory(del.dataset.memoryDel, del.dataset.memoryName);
  });

  // 事業部マスタ管理
  $("#deptAddForm").addEventListener("submit", handleDeptAdd);
  $("#deptChips").addEventListener("click", (e) => {
    const del = e.target.closest("[data-dept-del]");
    if (del) deleteDepartment(del.dataset.deptDel);
  });

  // 画像入力
  const dropzone = $("#dropzone");
  $("#imageInput").addEventListener("change", (e) => {
    if (e.target.files[0]) handleImageFile(e.target.files[0]);
  });
  // その場で撮影（モバイルではカメラ起動、PCでは対応環境でWebカメラ）
  $("#cameraInput").addEventListener("change", (e) => {
    if (e.target.files[0]) handleImageFile(e.target.files[0]);
    e.target.value = "";
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
  $("#rotateImage").addEventListener("click", rotateAndReanalyze);
  $("#retryAnalyze").addEventListener("click", () => analyzeCurrentImage());

  // フォーム
  $("#expenseForm").addEventListener("submit", submitExpense);

  // フィルタ
  $("#personalFilter").addEventListener("change", renderPersonal);
  $("#adminSearch").addEventListener("input", renderAdmin);
  $("#adminStatusFilter").addEventListener("change", renderAdmin);
  $("#adminReceiptFilter").addEventListener("change", renderAdmin);
  $("#adminFareFilter").addEventListener("change", renderAdmin);
  $("#csvBtn").addEventListener("click", exportCsv);

  // 表示形式の切替（カード／表）
  ["personal", "admin"].forEach((scope) => {
    $(`#${scope}ViewToggle`).addEventListener("click", (e) => {
      const btn = e.target.closest("[data-view]");
      if (btn) setView(scope, btn.dataset.view);
    });
  });

  // 一覧の操作（表・カードで共通。領収書サムネイルは拡大表示を開く）
  const bindListClicks = (el, admin) => {
    el.addEventListener("click", (e) => {
      const thumb = e.target.closest("[data-receipt]");
      if (thumb) return openReceipt(thumb.dataset.receipt, thumb.dataset.scope);
      const del = e.target.closest("[data-del]");
      if (del) return deleteExpense(del.dataset.del);
      if (!admin) return;
      const a = e.target.closest("[data-approve]");
      const r = e.target.closest("[data-reject]");
      const rs = e.target.closest("[data-reset]");
      const rm = e.target.closest("[data-remove]");
      if (a) approve(a.dataset.approve);
      else if (r) reject(r.dataset.reject);
      else if (rs) resetStatus(rs.dataset.reset);
      else if (rm) deleteExpense(rm.dataset.remove);
    });
  };
  bindListClicks($("#personalTable"), false);
  bindListClicks($("#personalCards"), false);
  bindListClicks($("#adminTable"), true);
  bindListClicks($("#adminCards"), true);

  // 領収書ビューア
  $("#receiptModal").addEventListener("click", (e) => {
    if (e.target.closest("[data-lb-close]")) closeReceipt();
    else if (e.target.closest("[data-lb-prev]")) moveReceipt(-1);
    else if (e.target.closest("[data-lb-next]")) moveReceipt(1);
  });
  document.addEventListener("keydown", (e) => {
    if ($("#receiptModal").hidden) return;
    if (e.key === "Escape") closeReceipt();
    else if (e.key === "ArrowLeft") moveReceipt(-1);
    else if (e.key === "ArrowRight") moveReceipt(1);
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
