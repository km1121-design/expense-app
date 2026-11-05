"use strict";

/* =========================================================================
 * 経費申請（軽量版）
 *
 * 機能は「レシートのAI読み取り → 申請 → スプレッドシートへ蓄積」と
 * 「月ごとの一覧（申請者は自分の分、管理者は全体）」だけ。
 * バックエンドは通常版と同じ Apps Script を使う（承認フローなし＝自動承認）。
 *
 * 設定（WebアプリURL）とログイン状態は通常版と同じキーで localStorage に置く。
 * 同じオリジン（GitHub Pages）なので、通常版でログイン済みならそのまま使える。
 * ========================================================================= */

const CONFIG_KEY = "expense-app:config"; // 通常版と共有
const SESSION_KEY = "expense-app:session"; // 通常版と共有
const CACHE_KEY = "expense-lite:records"; // 軽量版の一覧キャッシュ

const CATEGORIES = ["交通費", "交際費", "会議費", "消耗品費", "通信費", "宿泊費", "その他"];
const GROUP_KEYS = { department: "事業部", applicant: "申請者", category: "費目" };

const state = {
  endpoint: "",
  session: null, // { token, user: { username, displayName, role, department } }
  departments: [],
  records: [],
  image: null, // { base64, mime } 申請時にドライブへ保存する画像
  analyzing: 0, // 解析の世代番号（古い解析結果で上書きしないため）
};

const $ = (s) => document.querySelector(s);
const yen = (n) => "¥" + Number(n || 0).toLocaleString("ja-JP");
const esc = (s) =>
  String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const isAdmin = () => !!(state.session && state.session.user && state.session.user.role === "admin");
const isRejected = (r) => r.status === "rejected";

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/* ---------- 保存 ---------- */
function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}
function writeJson(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 容量超過などは無視（キャッシュなので失っても困らない） */
  }
}

/* ---------- 通信 ---------- */
class AuthError extends Error {}

/** Apps Script はエラー時にHTMLを返すことがあるので、読める日本語にする */
async function readJsonResponse(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    if (/accounts\.google\.com|ServiceLogin/i.test(text.slice(0, 400))) {
      throw new Error("Googleのログイン画面が返されました。デプロイの公開範囲を『全員』にしてください");
    }
    throw new Error(`サーバーの応答を読み取れませんでした（HTTP ${res.status}）。URLが /exec か確認してください`);
  }
}

/** CORS のプリフライトを避けるため text/plain で送る（application/json にしないこと） */
async function api(payload) {
  const body = { ...payload };
  if (state.session && body.token === undefined) body.token = state.session.token;
  const res = await fetch(state.endpoint, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(body),
  });
  const data = await readJsonResponse(res);
  if (!data.ok) {
    if (String(data.error).includes("unauthorized")) throw new AuthError("unauthorized");
    throw new Error(data.error || "エラーが発生しました");
  }
  return data;
}

function normalize(r) {
  return {
    id: String(r.id || ""),
    date: String(r.date || "").slice(0, 10),
    applicant: String(r.applicant || ""),
    applicantId: String(r.applicantId || ""),
    department: String(r.department || ""),
    category: String(r.category || ""),
    vendor: String(r.vendor || ""),
    description: String(r.description || ""),
    amount: Number(r.amount) || 0,
    status: String(r.status || ""),
    imageUrl: String(r.imageUrl || ""),
    createdAt: String(r.createdAt || ""),
  };
}

/* ---------- 画面の切り替え ---------- */
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 3000);
}

function showLogin(message) {
  $("#appView").hidden = true;
  $("#userBox").hidden = true;
  $("#loginView").hidden = false;
  // URLが未設定のとき、または失敗したとき（URL違いの可能性）は接続先も直せるようにする
  $("#endpointRow").hidden = !!state.endpoint && !message;
  $("#endpoint").value = state.endpoint;
  $("#endpoint").required = true;
  $("#loginErr").textContent = message || "";
}

function showApp() {
  const u = state.session.user;
  $("#loginView").hidden = true;
  $("#appView").hidden = false;
  $("#userBox").hidden = false;
  $("#userName").textContent = `${u.displayName}${isAdmin() ? "（管理者）" : ""}`;
  fillDepartments();
  render();
}

function switchTab(name) {
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("is-active", b.dataset.tab === name));
  document.querySelectorAll("[data-panel]").forEach((p) => (p.hidden = p.dataset.panel !== name));
}

function fillDepartments() {
  const mine = (state.session && state.session.user.department) || "";
  const list = state.departments.slice();
  if (mine && !list.includes(mine)) list.unshift(mine);
  $("#fDept").innerHTML =
    '<option value="">（未設定）</option>' + list.map((d) => `<option>${esc(d)}</option>`).join("");
  $("#fDept").value = mine;
}

/* ---------- 起動・同期 ---------- */
async function sync() {
  // status + ログイン中のユーザー + 一覧 を1往復で取得する
  const data = await api({ action: "bootstrap" });
  if (!data.authEnabled) {
    state.session = null;
    writeJson(SESSION_KEY, null);
    showLogin("初期設定（最初の管理者の作成）は通常版で行ってください");
    return;
  }
  if (!data.user) {
    state.session = null;
    writeJson(SESSION_KEY, null);
    showLogin("");
    return;
  }
  state.session.user = data.user;
  writeJson(SESSION_KEY, state.session);
  state.departments = data.departments || [];
  state.records = (data.records || []).map(normalize);
  writeJson(CACHE_KEY, { user: data.user.username, records: state.records });
  showApp();
}

async function start() {
  state.endpoint = (readJson(CONFIG_KEY, {}) || {}).endpoint || "";
  state.session = readJson(SESSION_KEY, null);
  CATEGORIES.forEach((c) => $("#fCategory").insertAdjacentHTML("beforeend", `<option>${c}</option>`));
  $("#fDate").value = today();
  $("#month").value = today().slice(0, 7);

  if (!state.endpoint || !state.session) return showLogin("");

  // 通信の前に前回の一覧を描く（白い画面を見せない）
  const cache = readJson(CACHE_KEY, null);
  if (cache && cache.user === state.session.user.username) {
    state.records = cache.records || [];
    showApp();
  }
  try {
    await sync();
  } catch (err) {
    if (err instanceof AuthError) return showLogin("ログインの有効期限が切れました");
    if (cache) toast("最新の一覧を取得できませんでした: " + err.message);
    else showLogin(err.message);
  }
}

/* ---------- ログイン ---------- */
async function onLogin(e) {
  e.preventDefault();
  const btn = e.submitter || $("#loginForm .btn");
  if (!$("#endpointRow").hidden) {
    state.endpoint = $("#endpoint").value.trim();
    writeJson(CONFIG_KEY, { ...(readJson(CONFIG_KEY, {}) || {}), endpoint: state.endpoint });
  }
  btn.disabled = true;
  $("#loginErr").textContent = "";
  try {
    const data = await api({ action: "login", username: $("#loginId").value.trim(), password: $("#loginPw").value });
    state.session = { token: data.token, user: data.user };
    writeJson(SESSION_KEY, state.session);
    $("#loginPw").value = "";
    await sync();
  } catch (err) {
    showLogin(err.message);
  } finally {
    btn.disabled = false;
  }
}

function logout() {
  state.session = null;
  state.records = [];
  writeJson(SESSION_KEY, null);
  writeJson(CACHE_KEY, null);
  showLogin("");
}

/* ---------- レシート画像 → AI読み取り ---------- */
/** 1回のデコードで、ドライブ保存兼AI解析用（長辺1600px）の JPEG を作る */
function shrink(file) {
  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    img.src = url;
  });
}

async function onPhoto() {
  const file = $("#photo").files[0];
  if (!file) return;
  const gen = ++state.analyzing;
  const msg = $("#aiMsg");
  const dataUrl = await shrink(file);
  if (gen !== state.analyzing) return;
  if (!dataUrl) {
    state.image = null;
    msg.textContent = "画像を読み込めませんでした。別の画像を選んでください";
    return;
  }
  state.image = { base64: dataUrl.split(",")[1], mime: "image/jpeg" };
  $("#preview").src = dataUrl;
  $("#preview").hidden = false;
  $("#photoHint").hidden = true;

  msg.textContent = "AIで読み取り中…（数秒かかります）";
  try {
    const data = await api({ action: "analyzeReceipt", imageBase64: state.image.base64, imageMime: state.image.mime });
    if (gen !== state.analyzing) return; // 別の画像に差し替えられた
    const f = data.fields || {};
    if (f.date) $("#fDate").value = f.date;
    if (f.amount) $("#fAmount").value = f.amount;
    if (f.category && CATEGORIES.includes(f.category)) $("#fCategory").value = f.category;
    if (f.vendor) $("#fVendor").value = f.vendor;
    if (f.description) $("#fDesc").value = f.description;
    const missing = [!f.date && "日付", !f.amount && "金額"].filter(Boolean);
    msg.textContent = missing.length
      ? `読み取れなかった項目（${missing.join("・")}）を入力してください`
      : "読み取りました。内容を確認して申請してください";
  } catch (err) {
    if (gen !== state.analyzing) return;
    if (err instanceof AuthError) return showLogin("ログインの有効期限が切れました");
    msg.textContent = "AIで読み取れませんでした。手入力で申請できます（" + err.message + "）";
  }
}

function resetForm() {
  state.analyzing++;
  state.image = null;
  $("#applyForm").reset();
  $("#preview").hidden = true;
  $("#preview").removeAttribute("src");
  $("#photoHint").hidden = false;
  $("#aiMsg").textContent = "";
  $("#fDate").value = today();
  fillDepartments();
}

/* ---------- 申請 ---------- */
async function onSubmit(e) {
  e.preventDefault();
  const btn = $("#submitBtn");
  const record = {
    id: "e" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    createdAt: new Date().toISOString(),
    date: $("#fDate").value,
    amount: Math.round(Number($("#fAmount").value) || 0),
    category: $("#fCategory").value,
    department: $("#fDept").value,
    vendor: $("#fVendor").value.trim(),
    description: $("#fDesc").value.trim(),
  };
  if (state.image) {
    record.imageBase64 = state.image.base64;
    record.imageMime = state.image.mime;
  }
  btn.disabled = true;
  btn.textContent = "送信中…";
  try {
    const data = await api({ action: "create", record });
    // 保存済みのレコードが返るので、一覧を取り直さずにそのまま加える
    state.records.unshift(normalize(data.record || record));
    writeJson(CACHE_KEY, { user: state.session.user.username, records: state.records });
    resetForm();
    render();
    toast(`申請しました（${yen(record.amount)}）`);
  } catch (err) {
    if (err instanceof AuthError) return showLogin("ログインの有効期限が切れました。もう一度ログインして申請してください");
    toast("申請できませんでした: " + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "申請する";
  }
}

/* ---------- 一覧 ---------- */
function sortRecords(list, key) {
  const byDate = (a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt);
  if (key === "amount") return list.sort((a, b) => b.amount - a.amount || byDate(a, b));
  if (!GROUP_KEYS[key]) return list.sort(byDate);
  // グループごと：小計の大きい順、グループ内は日付の新しい順
  const totals = {};
  list.forEach((r) => {
    if (!isRejected(r)) totals[r[key]] = (totals[r[key]] || 0) + r.amount;
  });
  return list.sort(
    (a, b) =>
      (totals[b[key]] || 0) - (totals[a[key]] || 0) ||
      a[key].localeCompare(b[key], "ja") ||
      byDate(a, b)
  );
}

function render() {
  const month = $("#month").value;
  const key = $("#sortKey").value;
  const me = state.session ? state.session.user.username : "";
  const list = sortRecords(
    state.records.filter((r) => !month || r.date.startsWith(month)),
    key
  );
  const sum = (rs) => rs.reduce((s, r) => s + (isRejected(r) ? 0 : r.amount), 0);
  $("#total").textContent = `${month ? month.replace("-", "年") + "月" : "全期間"}　${
    list.filter((r) => !isRejected(r)).length
  }件　合計 ${yen(sum(list))}${isAdmin() ? "（全員分）" : ""}`;

  if (!list.length) {
    $("#rows").innerHTML = '<li class="empty">この月の申請はありません</li>';
    return;
  }
  const html = [];
  let current = null;
  list.forEach((r) => {
    if (GROUP_KEYS[key] && r[key] !== current) {
      current = r[key];
      const group = list.filter((x) => x[key] === current);
      html.push(
        `<li class="group"><span>${esc(current || "（未設定）")}　${group.filter((x) => !isRejected(x)).length}件</span>` +
          `<span>${yen(sum(group))}</span></li>`
      );
    }
    const canDelete = isAdmin() || r.applicantId === me;
    // 申請者は管理者にだけ出す（一般ユーザーは自分の分しか見ないため）
    const meta = [r.date.slice(5).replace("-", "/"), isAdmin() && r.applicant, r.department, r.category, isRejected(r) && "却下"]
      .filter(Boolean)
      .map(esc)
      .join("・");
    html.push(
      `<li class="item${isRejected(r) ? " is-rejected" : ""}">` +
        `<div class="item__main"><div class="item__title">${esc(r.vendor || r.category || "（支払先なし）")}` +
        `${r.description ? `<small>${esc(r.description)}</small>` : ""}</div>` +
        `<div class="item__meta">${meta}</div></div>` +
        `<div class="item__side">${yen(r.amount)}<div class="acts">` +
        `${r.imageUrl ? `<a href="${esc(r.imageUrl)}" target="_blank" rel="noopener">🧾領収書</a>` : ""}` +
        `${canDelete ? `<button type="button" class="link danger" data-del="${esc(r.id)}">削除</button>` : ""}` +
        `</div></div></li>`
    );
  });
  $("#rows").innerHTML = html.join("");
}

async function onRowsClick(e) {
  const id = e.target.dataset && e.target.dataset.del;
  if (!id) return;
  const r = state.records.find((x) => x.id === id);
  if (!r || !confirm(`${r.date} ${r.vendor || r.category} ${yen(r.amount)} を削除しますか？`)) return;
  e.target.disabled = true;
  try {
    await api({ action: "delete", id });
    state.records = state.records.filter((x) => x.id !== id);
    writeJson(CACHE_KEY, { user: state.session.user.username, records: state.records });
    render();
    toast("削除しました");
  } catch (err) {
    e.target.disabled = false;
    if (err instanceof AuthError) return showLogin("ログインの有効期限が切れました");
    toast("削除できませんでした: " + err.message);
  }
}

async function onReload() {
  try {
    await sync();
    toast("最新の一覧を取得しました");
  } catch (err) {
    if (err instanceof AuthError) return showLogin("ログインの有効期限が切れました");
    toast("取得できませんでした: " + err.message);
  }
}

/* ---------- イベント ---------- */
$("#loginForm").addEventListener("submit", onLogin);
$("#logoutBtn").addEventListener("click", logout);
$("#photo").addEventListener("change", onPhoto);
$("#applyForm").addEventListener("submit", onSubmit);
$("#month").addEventListener("change", render);
$("#sortKey").addEventListener("change", render);
$("#reloadBtn").addEventListener("click", onReload);
$("#rows").addEventListener("click", onRowsClick);
document.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.tab)));

start();
