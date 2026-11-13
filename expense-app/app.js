"use strict";

/* =========================================================================
 * 経費申請アプリ
 *
 * 機能は「レシートのAI読み取り → 申請 → スプレッドシートへ蓄積」と
 * 「月ごとの一覧（申請者は自分の分、管理者は全体）」、管理者向けの
 * 「アカウント・事業部の管理」だけ。承認フローはなく、申請はそのまま計上される。
 *
 * 設定（WebアプリURL）とログイン状態は localStorage に置く。
 * ========================================================================= */

const CONFIG_KEY = "expense-app:config";
const SESSION_KEY = "expense-app:session";
const CACHE_KEY = "expense-lite:months"; // 一覧キャッシュ（月ごと）。旧名のまま（変えると一度キャッシュが消える）

const CATEGORIES = ["交通費", "交際費", "会議費", "消耗品費", "通信費", "宿泊費", "その他"];
const GROUP_KEYS = { month: "月", department: "事業部", applicant: "申請者", category: "費目" };

const state = {
  endpoint: "",
  session: null, // { token, user: { username, displayName, role, department } }
  departments: [],
  months: {}, // 月ごとの一覧。キーは "2026-11"、全期間は "all"
  loadGen: 0, // 月の切り替えの世代番号（遅れて届いた古い応答で上書きしないため）
  failedKey: "", // 取得に失敗した月（キャッシュが無いときの表示用）
  image: null, // { base64, mime } 申請時にドライブへ保存する画像
  analyzing: 0, // 解析の世代番号（古い解析結果で上書きしないため）
  loginMode: "code", // "code" = 利用コード / "password" = IDとパスワード（管理者用）/ "setup" = 最初の管理者の作成
  users: [], // アカウント画面の利用者一覧（管理者のみ）
  editing: "", // 事業部を編集中の利用者（username）
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
  // サーバーが新しいトークンを返したとき（有効期間の更新・自分のコードの再発行）は差し替える
  if (data.token && state.session && RENEW_ACTIONS.includes(body.action)) {
    state.session.token = data.token;
    writeJson(SESSION_KEY, state.session);
  }
  return data;
}
const RENEW_ACTIONS = ["bootstrap", "issueAccessCode", "upsertUser"];

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
    imageFileId: String(r.imageFileId || ""),
    month: String(r.date || "").slice(0, 7), // 「月ごと」の並べ替え用
    createdAt: String(r.createdAt || ""),
  };
}

/* ---------- 領収書の画像 ---------- */
/** ドライブのファイルID。行に無ければ、領収書URL（…/d/<ID>/view）から取る */
const fileIdOf = (r) => r.imageFileId || ((r.imageUrl.match(/\/d\/([^/?#]+)/) || [])[1] || "");
/**
 * ドライブが作る縮小画像。「リンクを知っている人は閲覧可」にしてあるので、ログインなしで読める
 * （共有を外すと開けなくなり、一覧では 🧾 に置き換わる）。
 */
const thumbUrl = (id, width) => "https://drive.google.com/thumbnail?id=" + encodeURIComponent(id) + "&sz=w" + width;

/* ---------- 月ごとの一覧 ---------- */
const monthKey = () => $("#month").value || "all";
const inMonth = (r, key) => key === "all" || r.date.startsWith(key);

/** 端末に残すのは直近3か月だけ（全期間は残さない） */
function persistMonths() {
  if (!state.session) return;
  const months = {};
  Object.keys(state.months)
    .filter((k) => k !== "all")
    .sort()
    .reverse()
    .slice(0, 3)
    .forEach((k) => (months[k] = state.months[k]));
  writeJson(CACHE_KEY, { user: state.session.user.username, months });
}

/** 古いバックエンドは月を絞らず全期間を返すので、受け取ったあとで手元でも絞る */
function setMonth(key, records) {
  state.months[key] = records.map(normalize).filter((r) => inMonth(r, key));
}

async function fetchMonth(key) {
  const month = key === "all" ? "" : key;
  let data;
  try {
    data = await api({ action: "list", month });
  } catch (err) {
    // 月ごとの取得に未対応の古いバックエンドでは、起動用の取得で代用する
    if (!/unknown action/i.test(err.message)) throw err;
    data = await api({ action: "bootstrap", month });
  }
  setMonth(key, data.records || []);
}

/** 月を切り替えたとき。キャッシュがあれば先に描き、そのあと最新を取りに行く */
async function loadMonth() {
  const key = monthKey();
  const gen = ++state.loadGen;
  state.failedKey = "";
  render();
  try {
    await fetchMonth(key);
    persistMonths();
    if (gen === state.loadGen) render();
  } catch (err) {
    if (err instanceof AuthError) return showLogin("ログインの有効期限が切れました");
    if (gen !== state.loadGen) return;
    if (!state.months[key]) state.failedKey = key;
    render();
    toast("一覧を取得できませんでした: " + err.message);
  }
}

/** 申請したものを、載るべき月のキャッシュへ加える（一覧を取り直さない） */
function addToMonths(rec) {
  Object.keys(state.months).forEach((k) => {
    if (inMonth(rec, k)) state.months[k] = [rec, ...state.months[k].filter((x) => x.id !== rec.id)];
  });
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
  const mode = state.loginMode;
  const byCode = mode === "code";
  const setup = mode === "setup"; // まだ管理者がいない（初回）
  $("#codeRow").hidden = !byCode;
  $("#pwRows").hidden = byCode;
  $("#nameRow").hidden = !setup;
  $("#loginCode").required = byCode;
  $("#loginId").required = $("#loginPw").required = !byCode;
  $("#setupName").required = setup;
  $("#loginTitle").textContent = setup ? "最初の管理者を作る" : "ログイン";
  $("#loginSubmit").textContent = setup ? "管理者を作成" : "ログイン";
  $("#loginModeBtn").hidden = setup;
  $("#loginModeBtn").textContent = byCode ? "IDとパスワードでログイン（管理者）" : "利用コードでログイン";
  $("#loginErr").textContent = message || "";
}

function showApp() {
  const u = state.session.user;
  $("#loginView").hidden = true;
  $("#appView").hidden = false;
  $("#userBox").hidden = false;
  $("#userName").textContent = `${u.displayName}${isAdmin() ? "（管理者）" : ""}`;
  $("#accountsTab").hidden = !isAdmin();
  if (!isAdmin() && !$('[data-panel="accounts"]').hidden) switchTab("apply");
  fillDepartments();
  render();
}

function switchTab(name) {
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("is-active", b.dataset.tab === name));
  document.querySelectorAll("[data-panel]").forEach((p) => (p.hidden = p.dataset.panel !== name));
  if (name === "accounts") loadUsers();
}

/** 利用者の事業部は複数持てる（シートには「人材,BAR」で入っている） */
function splitDepts(v) {
  return [...new Set(String(v || "").split(/[,、]/).map((d) => d.trim()).filter(Boolean))];
}

/** 申請の事業部: 自分に割り当てられた事業部から選ぶ（未割り当てなら全事業部） */
function fillDepartments() {
  const mine = splitDepts(state.session && state.session.user.department);
  const list = mine.length ? mine : state.departments;
  $("#fDept").innerHTML =
    (mine.length ? "" : '<option value="">（未設定）</option>') +
    list.map((d) => `<option>${esc(d)}</option>`).join("");
  $("#fDept").value = mine[0] || "";
}

/** 事業部のチェックボックス群。マスタから消えた事業部も、付いていれば外せるように出す */
function deptChecks(name, selected) {
  const all = [...state.departments, ...selected.filter((d) => !state.departments.includes(d))];
  return (
    '<div class="checkList">' +
    all
      .map(
        (d) =>
          `<label><input type="checkbox" name="${name}" value="${esc(d)}"${selected.includes(d) ? " checked" : ""} />${esc(d)}</label>`
      )
      .join("") +
    "</div>"
  );
}
const checkedValues = (root, name) =>
  [...root.querySelectorAll(`input[name="${name}"]:checked`)].map((i) => i.value);

/* ---------- 起動・同期 ---------- */
async function sync() {
  // status + ログイン中のユーザー + 一覧 を1往復で取得する
  const key = monthKey();
  const data = await api({ action: "bootstrap", month: key === "all" ? "" : key });
  if (!data.authEnabled) {
    state.session = null;
    writeJson(SESSION_KEY, null);
    state.loginMode = "setup";
    showLogin("まだ管理者がいません。最初の管理者を作成してください");
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
  setMonth(key, data.records || []);
  persistMonths();
  showApp();
}

async function start() {
  state.endpoint = (readJson(CONFIG_KEY, {}) || {}).endpoint || "";
  state.session = readJson(SESSION_KEY, null);
  CATEGORIES.forEach((c) => $("#fCategory").insertAdjacentHTML("beforeend", `<option>${c}</option>`));
  $("#fDate").value = today();
  $("#month").value = today().slice(0, 7);

  // 案内リンク（…/#api=<URL>&code=<利用コード>）から開いたとき。
  // URLの # 以降はサーバーへ送られない。履歴に残さないよう読んだらすぐ消す。
  const invite = new URLSearchParams(location.hash.slice(1));
  if (invite.get("api") || invite.get("code")) {
    history.replaceState(null, "", location.pathname + location.search);
    if (invite.get("api")) {
      state.endpoint = invite.get("api");
      writeJson(CONFIG_KEY, { ...(readJson(CONFIG_KEY, {}) || {}), endpoint: state.endpoint });
    }
    if (invite.get("code") && state.endpoint) {
      // 別の人のログインが残っていても、案内されたコードで入り直す
      state.session = null;
      writeJson(SESSION_KEY, null);
      writeJson(CACHE_KEY, null);
      state.loginMode = "code";
      showLogin("");
      $("#loginCode").value = invite.get("code");
      return login();
    }
  }

  if (!state.endpoint || !state.session) return showLogin("");

  // 通信の前に前回の一覧を描く（白い画面を見せない）
  const cache = readJson(CACHE_KEY, null);
  if (cache && cache.user === state.session.user.username && cache.months) {
    // 古い版が残したキャッシュは項目が足りないので、今の形へ作り直す
    Object.keys(cache.months).forEach((k) => (state.months[k] = (cache.months[k] || []).map(normalize)));
    if (state.months[monthKey()]) showApp();
  }
  try {
    await sync();
  } catch (err) {
    if (err instanceof AuthError) return showLogin("ログインの有効期限が切れました");
    if (state.months[monthKey()]) toast("最新の一覧を取得できませんでした: " + err.message);
    else showLogin(err.message);
  }
}

/* ---------- ログイン ---------- */
function onLogin(e) {
  e.preventDefault();
  if (!$("#endpointRow").hidden) {
    state.endpoint = $("#endpoint").value.trim();
    writeJson(CONFIG_KEY, { ...(readJson(CONFIG_KEY, {}) || {}), endpoint: state.endpoint });
  }
  return login();
}

async function login() {
  const btn = $("#loginForm .btn");
  btn.disabled = true;
  $("#loginErr").textContent = "";
  try {
    const mode = state.loginMode;
    const data =
      mode === "code"
        ? await api({ action: "loginCode", code: $("#loginCode").value })
        : mode === "setup"
          ? await api({
              action: "setup",
              displayName: $("#setupName").value.trim(),
              username: $("#loginId").value.trim(),
              password: $("#loginPw").value,
            })
          : await api({ action: "login", username: $("#loginId").value.trim(), password: $("#loginPw").value });
    state.session = { token: data.token, user: data.user };
    writeJson(SESSION_KEY, state.session);
    $("#loginPw").value = "";
    $("#loginCode").value = "";
    await sync();
  } catch (err) {
    // 管理者がまだ一人もいない（初回）。作成の画面へ切り替える
    if (/初期設定/.test(err.message)) {
      state.loginMode = "setup";
      return showLogin("まだ管理者がいません。最初の管理者を作成してください");
    }
    showLogin(
      /unknown action/.test(err.message)
        ? "サーバーが利用コードに未対応です（バックエンドの更新待ち）。管理者はIDとパスワードでログインできます"
        : err.message
    );
  } finally {
    btn.disabled = false;
  }
}

function toggleLoginMode() {
  state.loginMode = state.loginMode === "code" ? "password" : "code";
  showLogin("");
}

function logout() {
  state.session = null;
  state.users = [];
  $("#issued").hidden = true;
  state.months = {};
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
    addToMonths(normalize(data.record || record));
    persistMonths();
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
  if (key === "month") return list.sort(byDate); // 月は新しい順（日付順にすれば月もまとまる）
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
  const recs = state.months[monthKey()];
  if (!recs) {
    // まだ取得できていない月（取得に失敗したときは、その旨を出す）
    const failed = state.failedKey === monthKey();
    $("#total").textContent = failed ? "" : "読み込み中…";
    $("#rows").innerHTML = `<li class="empty">${failed ? "取得できませんでした。「再読込」を押してください" : "読み込み中…"}</li>`;
    return;
  }
  const list = sortRecords(recs.slice(), key);
  state.shown = list; // 領収書の拡大表示が、いま並んでいる順に前後へ移るために持つ
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
      const label = key === "month" ? (current ? current.replace("-", "年") + "月" : "（日付なし）") : current || "（未設定）";
      html.push(
        `<li class="group"><span>${esc(label)}　${group.filter((x) => !isRejected(x)).length}件</span>` +
          `<span>${yen(sum(group))}</span></li>`
      );
    }
    const canDelete = isAdmin() || r.applicantId === me;
    // 申請者は管理者にだけ出す（一般ユーザーは自分の分しか見ないため）
    const meta = [r.date.slice(5).replace("-", "/"), isAdmin() && r.applicant, r.department, r.category, isRejected(r) && "却下"]
      .filter(Boolean)
      .map(esc)
      .join("・");
    const fid = fileIdOf(r);
    html.push(
      `<li class="item${isRejected(r) ? " is-rejected" : ""}">` +
        (fid
          ? `<button type="button" class="thumb" data-view="${esc(r.id)}" aria-label="領収書を拡大">` +
            `<img src="${esc(thumbUrl(fid, 160))}" alt="領収書" loading="lazy" referrerpolicy="no-referrer" /></button>`
          : "") +
        `<div class="item__main"><div class="item__title">${esc(r.vendor || r.category || "（支払先なし）")}` +
        `${r.description ? `<small>${esc(r.description)}</small>` : ""}</div>` +
        `<div class="item__meta">${meta}</div></div>` +
        `<div class="item__side">${yen(r.amount)}<div class="acts">` +
        `${!fid && r.imageUrl ? `<a href="${esc(r.imageUrl)}" target="_blank" rel="noopener">🧾領収書</a>` : ""}` +
        `${canDelete ? `<button type="button" class="link danger" data-del="${esc(r.id)}">削除</button>` : ""}` +
        `</div></div></li>`
    );
  });
  $("#rows").innerHTML = html.join("");
}

async function onRowsClick(e) {
  const view = e.target.closest && e.target.closest("[data-view]");
  if (view) return openLightbox(view.dataset.view, view);
  const id = e.target.dataset && e.target.dataset.del;
  if (!id) return;
  const r = (state.months[monthKey()] || []).find((x) => x.id === id);
  if (!r || !confirm(`${r.date} ${r.vendor || r.category} ${yen(r.amount)} を削除しますか？`)) return;
  e.target.disabled = true;
  try {
    await api({ action: "delete", id });
    Object.keys(state.months).forEach((k) => (state.months[k] = state.months[k].filter((x) => x.id !== id)));
    persistMonths();
    render();
    toast("削除しました");
  } catch (err) {
    e.target.disabled = false;
    if (err instanceof AuthError) return showLogin("ログインの有効期限が切れました");
    toast("削除できませんでした: " + err.message);
  }
}

/* ---------- 領収書の拡大表示 ---------- */
const lb = { ids: [], i: 0, opener: null };

function openLightbox(id, opener) {
  // いま一覧に並んでいる順のうち、画像があるものだけを前後に送れるようにする
  lb.ids = (state.shown || []).filter((r) => fileIdOf(r)).map((r) => r.id);
  lb.i = Math.max(0, lb.ids.indexOf(id));
  lb.opener = opener || null;
  $("#lightbox").hidden = false;
  document.body.style.overflow = "hidden"; // 背景の一覧が一緒に動かないように
  showLightbox();
  $("#lbClose").focus();
}

function showLightbox() {
  const r = (state.shown || []).find((x) => x.id === lb.ids[lb.i]);
  if (!r) return closeLightbox(); // 表示中に消された
  const fid = fileIdOf(r);
  const img = $("#lbImg");
  img.classList.add("is-loading");
  img.onload = () => img.classList.remove("is-loading");
  img.onerror = () => {
    img.classList.remove("is-loading");
    $("#lbCap").textContent = "画像を読み込めませんでした。下のリンクから開けます";
  };
  img.src = thumbUrl(fid, 1600);
  const meta = [r.date.slice(5).replace("-", "/"), r.applicant, r.department, r.category].filter(Boolean).join("・");
  $("#lbCap").textContent = `${r.vendor || r.category}　${yen(r.amount)}　${meta}`;
  $("#lbCount").textContent = lb.ids.length > 1 ? `${lb.i + 1} / ${lb.ids.length}` : "";
  $("#lbOpen").href = r.imageUrl || "https://drive.google.com/file/d/" + encodeURIComponent(fid) + "/view";
  $("#lbPrev").hidden = $("#lbNext").hidden = lb.ids.length < 2;
}

function stepLightbox(d) {
  if (lb.ids.length < 2) return;
  lb.i = (lb.i + d + lb.ids.length) % lb.ids.length;
  showLightbox();
}

function closeLightbox() {
  $("#lightbox").hidden = true;
  $("#lbImg").removeAttribute("src");
  document.body.style.overflow = "";
  if (lb.opener && document.contains(lb.opener)) lb.opener.focus();
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

/* ---------- アカウント（管理者のみ） ---------- */
async function loadUsers() {
  renderDepartments();
  if (!state.users.length) $("#userRows").innerHTML = '<li class="empty">読み込み中…</li>';
  try {
    const data = await api({ action: "listUsers" });
    state.users = data.users || [];
    renderUsers();
  } catch (err) {
    if (err instanceof AuthError) return showLogin("ログインの有効期限が切れました");
    $("#userRows").innerHTML = `<li class="empty">読み込めませんでした: ${esc(err.message)}</li>`;
  }
}

function renderUsers() {
  const me = state.session.user.username;
  // 有効な人を先に、その中は事業部・名前順
  const list = state.users
    .slice()
    .sort(
      (a, b) =>
        (b.active ? 1 : 0) - (a.active ? 1 : 0) ||
        String(a.department).localeCompare(String(b.department), "ja") ||
        String(a.displayName).localeCompare(String(b.displayName), "ja")
    );
  $("#userRows").innerHTML = list.length
    ? list
        .map((u) => {
          const depts = splitDepts(u.department);
          const meta = [depts.join("・") || "事業部未設定", u.role === "admin" ? "管理者" : "一般", !u.active && "無効"]
            .filter(Boolean)
            .map(esc)
            .join("・");
          const self = u.username === me;
          const editing = state.editing === u.username;
          return (
            `<li class="item${u.active ? "" : " is-inactive"}${editing ? " is-editing" : ""}">` +
            `<div class="item__main"><div class="item__title">${esc(u.displayName)}${self ? "<small>（自分）</small>" : ""}</div>` +
            `<div class="item__meta">${meta}</div></div>` +
            `<div class="item__side"><div class="acts">` +
            `<button type="button" class="link" data-edit="${esc(u.username)}">事業部</button>` +
            (u.active ? `<button type="button" class="link" data-issue="${esc(u.username)}">コード再発行</button>` : "") +
            (self
              ? ""
              : `<button type="button" class="link${u.active ? " danger" : ""}" data-active="${esc(u.username)}">${
                  u.active ? "無効化" : "有効化"
                }</button>`) +
            `</div></div>` +
            (editing
              ? `<div class="editDepts">${deptChecks("edit", depts)}<div class="row">` +
                `<button type="button" class="btn btn--sm" data-save="${esc(u.username)}">保存</button>` +
                `<button type="button" class="link" data-cancel="1">やめる</button></div></div>`
              : "") +
            `</li>`
          );
        })
        .join("")
    : '<li class="empty">利用者がいません</li>';
}

function showIssued(name, code) {
  $("#issuedTitle").textContent = `${name}さんの利用コード`;
  $("#issuedCode").textContent = code;
  $("#issued").dataset.name = name;
  $("#issued").hidden = false;
  $("#issued").scrollIntoView({ behavior: "smooth", block: "center" });
}

/** 利用者へ送る案内文。リンクを開けば接続先の設定もコードの入力も要らない */
function inviteText() {
  const name = $("#issued").dataset.name;
  const code = $("#issuedCode").textContent;
  const link =
    location.origin + location.pathname + "#api=" + encodeURIComponent(state.endpoint) + "&code=" + encodeURIComponent(code);
  return `${name}さん\n経費申請アプリの利用コードです: ${code}\n次のリンクを開くとログインできます。\n${link}`;
}

async function onAddUser(e) {
  e.preventDefault();
  const btn = e.target.querySelector(".btn");
  const name = $("#uName").value.trim();
  btn.disabled = true;
  try {
    const data = await api({
      action: "issueAccessCode",
      user: { displayName: name, department: checkedValues($("#uDepts"), "add"), role: $("#uRole").value },
    });
    $("#addUserForm").reset();
    renderDepartments();
    showIssued(name, data.code);
    loadUsers();
  } catch (err) {
    if (err instanceof AuthError) return showLogin("ログインの有効期限が切れました");
    toast("追加できませんでした: " + err.message);
  } finally {
    btn.disabled = false;
  }
}

async function onUserRowsClick(e) {
  const t = e.target.dataset;
  if (t.edit || t.cancel) {
    state.editing = t.edit && state.editing !== t.edit ? t.edit : "";
    return renderUsers();
  }
  if (t.save) {
    const depts = checkedValues(e.target.closest(".item"), "edit");
    e.target.disabled = true;
    try {
      await api({ action: "upsertUser", user: { username: t.save, department: depts } });
      state.editing = "";
      toast("事業部を変更しました");
      // 自分の事業部を変えたら申請フォームの選択肢にも反映する
      if (t.save === state.session.user.username) {
        state.session.user.department = depts.join(",");
        writeJson(SESSION_KEY, state.session);
        fillDepartments();
      }
      await loadUsers();
    } catch (err) {
      e.target.disabled = false;
      if (err instanceof AuthError) return showLogin("ログインの有効期限が切れました");
      toast("変更できませんでした: " + err.message);
    }
    return;
  }
  const issue = e.target.dataset.issue;
  const active = e.target.dataset.active;
  const u = state.users.find((x) => x.username === (issue || active));
  if (!u) return;
  const self = u.username === state.session.user.username;
  try {
    if (issue) {
      const warn = self
        ? "自分のコードを発行し直すと、パスワードもこのコードに変わります（IDとパスワードでログインするときも、このコードを使います）。続けますか？"
        : `${u.displayName}さんのコードを発行し直しますか？\n今のコードは使えなくなります。`;
      if (!confirm(warn)) return;
      e.target.disabled = true;
      const data = await api({ action: "issueAccessCode", user: { username: u.username } });
      showIssued(u.displayName, data.code);
    } else {
      if (!confirm(`${u.displayName}さんを${u.active ? "無効化" : "有効化"}しますか？`)) return;
      e.target.disabled = true;
      await api({ action: "upsertUser", user: { username: u.username, active: !u.active } });
      toast(u.active ? "無効化しました（ログインできなくなります）" : "有効化しました");
      await loadUsers();
    }
  } catch (err) {
    e.target.disabled = false;
    if (err instanceof AuthError) return showLogin("ログインの有効期限が切れました");
    toast("操作できませんでした: " + err.message);
  }
}

/* 事業部マスタ（追加・削除）。追加・削除の応答に最新の一覧が入っている */
function renderDepartments() {
  const keep = checkedValues($("#uDepts"), "add");
  $("#uDepts").innerHTML = state.departments.length
    ? deptChecks("add", keep)
    : '<p class="note">先に下の「事業部」で事業部を追加してください</p>';
  $("#deptRows").innerHTML = state.departments.length
    ? state.departments
        .map((d) => `<li>${esc(d)}<button type="button" class="link danger" data-deldept="${esc(d)}" title="削除">✕</button></li>`)
        .join("")
    : '<li class="empty">事業部がありません</li>';
}

async function updateDepartments(payload, done) {
  try {
    const data = await api(payload);
    state.departments = data.departments || [];
    renderDepartments();
    renderUsers();
    fillDepartments();
    toast(done);
    return true;
  } catch (err) {
    if (err instanceof AuthError) return showLogin("ログインの有効期限が切れました");
    toast("できませんでした: " + err.message);
    return false;
  }
}

async function onAddDept(e) {
  e.preventDefault();
  const name = $("#deptName").value.trim();
  if (!name) return;
  if (await updateDepartments({ action: "addDepartment", name }, `「${name}」を追加しました`)) $("#deptName").value = "";
}

async function onDeptRowsClick(e) {
  const name = e.target.dataset.deldept;
  if (!name || !confirm(`事業部「${name}」を削除しますか？\n過去の申請や利用者に付いている事業部名はそのまま残ります。`)) return;
  await updateDepartments({ action: "deleteDepartment", name }, `「${name}」を削除しました`);
}

async function onCopyInvite() {
  try {
    await navigator.clipboard.writeText(inviteText());
    toast("案内文をコピーしました。LINEやメールで本人に送ってください");
  } catch {
    // クリップボードが使えない環境では選択できる形で出す
    prompt("この案内文をコピーして本人に送ってください", inviteText());
  }
}

/* ---------- イベント ---------- */
$("#loginForm").addEventListener("submit", onLogin);
$("#logoutBtn").addEventListener("click", logout);
$("#loginModeBtn").addEventListener("click", toggleLoginMode);
$("#addUserForm").addEventListener("submit", onAddUser);
$("#userRows").addEventListener("click", onUserRowsClick);
$("#copyInviteBtn").addEventListener("click", onCopyInvite);
$("#addDeptForm").addEventListener("submit", onAddDept);
$("#deptRows").addEventListener("click", onDeptRowsClick);
$("#closeIssuedBtn").addEventListener("click", () => ($("#issued").hidden = true));
$("#photo").addEventListener("change", onPhoto);
$("#applyForm").addEventListener("submit", onSubmit);
$("#month").addEventListener("change", loadMonth);
$("#sortKey").addEventListener("change", render);
$("#reloadBtn").addEventListener("click", onReload);
$("#rows").addEventListener("click", onRowsClick);
// 画像が読み込めなかったとき（共有が外れている等）は 🧾 に置き換える。ボタンは押せるまま
$("#rows").addEventListener(
  "error",
  (e) => {
    if (e.target.tagName === "IMG") e.target.replaceWith(document.createTextNode("🧾"));
  },
  true
);
$("#allMonthsBtn").addEventListener("click", () => {
  $("#month").value = "";
  loadMonth();
});
$("#lbClose").addEventListener("click", closeLightbox);
$("#lbPrev").addEventListener("click", () => stepLightbox(-1));
$("#lbNext").addEventListener("click", () => stepLightbox(1));
$("#lightbox").addEventListener("click", (e) => {
  if (e.target === $("#lightbox")) closeLightbox(); // 背景をタップで閉じる
});
document.addEventListener("keydown", (e) => {
  if ($("#lightbox").hidden) return;
  if (e.key === "Escape") closeLightbox();
  else if (e.key === "ArrowLeft") stepLightbox(-1);
  else if (e.key === "ArrowRight") stepLightbox(1);
});
// スマホでは左右のスワイプで前後の領収書へ
let swipeX = null;
$("#lightbox").addEventListener("touchstart", (e) => (swipeX = e.touches[0].clientX), { passive: true });
$("#lightbox").addEventListener("touchend", (e) => {
  if (swipeX == null) return;
  const dx = e.changedTouches[0].clientX - swipeX;
  swipeX = null;
  if (Math.abs(dx) > 60) stepLightbox(dx < 0 ? 1 : -1);
});
document.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.tab)));

start();
