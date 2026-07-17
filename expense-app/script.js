"use strict";

/* =========================================================================
 * 経費申請アプリ
 *
 * 保存方式:
 *   - クラウド連携ON（設定でWebアプリURLを指定）:
 *       申請データ → Googleスプレッドシート（DB）
 *       領収書画像 → Google ドライブ
 *       スプレッドシートを正とし、localStorage は読み取りキャッシュ／
 *       オフライン時の再送信キューとして使用
 *   - クラウド連携OFF（未設定）: この端末の localStorage にのみ保存
 * ========================================================================= */

const STORE_KEY = "expense-app:expenses"; // ローカルキャッシュ
const USER_KEY = "expense-app:currentUser";
const CONFIG_KEY = "expense-app:config";
const QUEUE_KEY = "expense-app:queue"; // 未同期の作成申請

/** @typedef {{
 *   id:string, applicant:string, date:string, category:string, vendor:string,
 *   amount:number, description:string, imageThumb?:string|null,
 *   imageUrl?:string, imageFileId?:string,
 *   status:'pending'|'approved'|'rejected', createdAt:string,
 *   reviewedAt:string|null, reviewer:string|null, reviewComment:string|null
 * }} Expense */

const state = {
  /** @type {Expense[]} */
  expenses: [],
  currentUser: "",
  isAdmin: false,
  activeTab: "apply",
  lastImageThumb: /** @type {string|null} */ (null),
  lastImageFile: /** @type {File|null} */ (null),
  config: { endpoint: "", token: "" },
  syncStatus: "local", // 'local' | 'syncing' | 'synced' | 'error'
};

const cloudEnabled = () => !!state.config.endpoint;

/* ---------- storage ---------- */
function loadConfig() {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (raw) state.config = { endpoint: "", token: "", ...JSON.parse(raw) };
  } catch {
    /* noop */
  }
}
function saveConfig() {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(state.config));
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

function normalizeRecord(r) {
  return {
    id: r.id,
    applicant: r.applicant || "",
    date: r.date || "",
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

async function apiPost(payload) {
  const res = await fetch(state.config.endpoint, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ ...payload, token: state.config.token }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || "APIエラー");
  return data;
}

async function apiGet() {
  const url =
    state.config.endpoint +
    (state.config.token ? "?token=" + encodeURIComponent(state.config.token) : "");
  const res = await fetch(url);
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || "APIエラー");
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
    } catch {
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
  if (!state.currentUser) {
    toast("先に画面右上でログインユーザー（氏名）を入力してください");
    $("#currentUser").focus();
    return;
  }
  const amount = Number($("#expAmount").value);
  if (!$("#expDate").value || !amount || amount <= 0) {
    toast("日付と金額（1円以上）は必須です");
    return;
  }

  const base = {
    id: uid(),
    applicant: state.currentUser,
    date: $("#expDate").value,
    category: $("#expCategory").value,
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
      // ローカルのみ
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
        toast("申請を保存しました（スプレッドシート／ドライブへ同期）");
      } catch (err) {
        console.error(err);
        // 失敗時はキューに積んでローカルにも反映
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

function renderPersonal() {
  const user = state.currentUser;
  const mine = state.expenses.filter((e) => e.applicant === user);
  const sum = (arr) => arr.reduce((t, e) => t + e.amount, 0);
  const pending = mine.filter((e) => e.status === "pending");
  const approved = mine.filter((e) => e.status === "approved");

  $("#personalStats").innerHTML = user
    ? [
        statCard("申請件数", mine.length + " 件"),
        statCard("申請中", pending.length + " 件"),
        statCard("承認済み金額", yen(sum(approved)), "is-green"),
        statCard("申請中金額", yen(sum(pending)), "is-accent"),
      ].join("")
    : `<div class="stat"><p class="stat__label">氏名未入力</p><p class="stat__value">—</p></div>`;

  const filter = $("#personalFilter").value;
  const rows = mine.filter((e) => filter === "all" || e.status === filter);
  const tbody = $("#personalTable tbody");

  if (!user) {
    tbody.innerHTML = `<tr><td colspan="8" class="empty">右上で氏名を入力すると、自分の申請が表示されます。</td></tr>`;
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
      <td>${
        e.status === "pending"
          ? `<button class="btn btn--ghost btn--sm" data-del="${e.id}">取消</button>`
          : ""
      }</td>
    </tr>`
    )
    .join("");
}

function renderAdmin() {
  const all = state.expenses;
  const sum = (arr) => arr.reduce((t, e) => t + e.amount, 0);
  const pending = all.filter((e) => e.status === "pending");
  const approved = all.filter((e) => e.status === "approved");

  $("#adminStats").innerHTML = [
    statCard("総申請件数", all.length + " 件"),
    statCard("承認待ち", pending.length + " 件", "is-accent"),
    statCard("承認待ち金額", yen(sum(pending)), "is-accent"),
    statCard("承認済み金額", yen(sum(approved)), "is-green"),
  ].join("");

  const byCat = {};
  for (const e of approved) byCat[e.category] = (byCat[e.category] || 0) + e.amount;
  const cats = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  const max = cats.length ? cats[0][1] : 0;
  $("#adminByCategory").innerHTML = cats.length
    ? cats
        .map(
          ([cat, val]) => `
      <div class="bar-row">
        <span>${escapeHtml(cat)}</span>
        <div class="bar-track"><div class="bar-fill" style="width:${
          max ? (val / max) * 100 : 0
        }%"></div></div>
        <span class="bar-val">${yen(val)}</span>
      </div>`
        )
        .join("")
    : `<p class="empty">承認済みの経費はまだありません。</p>`;

  const q = $("#adminSearch").value.trim().toLowerCase();
  const sf = $("#adminStatusFilter").value;
  const rows = all.filter((e) => {
    const matchQ =
      !q ||
      e.applicant.toLowerCase().includes(q) ||
      (e.vendor || "").toLowerCase().includes(q);
    const matchS = sf === "all" || e.status === sf;
    return matchQ && matchS;
  });

  const tbody = $("#adminTable tbody");
  tbody.innerHTML = rows.length
    ? rows
        .map(
          (e) => `
      <tr>
        <td>${escapeHtml(e.applicant)}</td>
        <td>${escapeHtml(e.date)}</td>
        <td>${escapeHtml(e.category)}</td>
        <td>${escapeHtml(e.vendor || "—")}</td>
        <td class="num">${yen(e.amount)}</td>
        <td>${receiptCell(e)}</td>
        <td><span class="badge badge--${e.status}">${STATUS_LABEL[e.status]}</span></td>
        <td>${
          e.status === "pending"
            ? `<button class="btn btn--sm btn--approve" data-approve="${e.id}">承認</button>
               <button class="btn btn--sm btn--reject" data-reject="${e.id}">却下</button>`
            : `<button class="btn btn--ghost btn--sm" data-reset="${e.id}">差戻</button>`
        }</td>
      </tr>`
        )
        .join("")
    : `<tr><td colspan="8" class="empty">該当する申請はありません。</td></tr>`;
}

function render() {
  renderPersonal();
  if (state.isAdmin) renderAdmin();
}

/* =========================================================================
 * 承認・却下・差戻・取消（クラウド連携時はスプレッドシートへ反映）
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
      console.error(err);
      setSync("error");
      toast("クラウド更新に失敗しました。");
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
      reviewer: state.currentUser || "管理者",
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
      reviewer: state.currentUser || "管理者",
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
      console.error(err);
      setSync("error");
      toast("クラウド削除に失敗しました。");
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
    "id", "createdAt", "applicant", "date", "category", "vendor",
    "amount", "description", "status", "reviewedAt", "reviewer",
    "reviewComment", "imageUrl",
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
 * タブ / ユーザー / 管理者 / 設定
 * ========================================================================= */

function setTab(tab) {
  if (tab === "admin" && !state.isAdmin) tab = "apply";
  state.activeTab = tab;
  $$(".tab").forEach((t) => t.classList.toggle("is-active", t.dataset.tab === tab));
  $$(".panel").forEach((p) =>
    p.classList.toggle("is-active", p.dataset.panel === tab)
  );
}

function setAdmin(on) {
  state.isAdmin = on;
  const btn = $("#adminToggle");
  btn.classList.toggle("is-on", on);
  btn.textContent = on ? "管理者モード ON" : "管理者モード";
  $(".is-admin-only").hidden = !on;
  if (!on && state.activeTab === "admin") setTab("apply");
  render();
}

function openSettings() {
  $("#cfgEndpoint").value = state.config.endpoint;
  $("#cfgToken").value = state.config.token;
  $("#settingsModal").hidden = false;
}
function closeSettings() {
  $("#settingsModal").hidden = true;
}
async function saveSettings() {
  state.config.endpoint = $("#cfgEndpoint").value.trim();
  state.config.token = $("#cfgToken").value.trim();
  saveConfig();
  closeSettings();
  if (cloudEnabled()) {
    toast("クラウド連携を有効化しました。データを読み込みます…");
    await refreshFromCloud();
  } else {
    setSync("local");
    loadCache();
    render();
  }
  updatePendingUI();
}
function clearSettings() {
  state.config = { endpoint: "", token: "" };
  saveConfig();
  $("#cfgEndpoint").value = "";
  $("#cfgToken").value = "";
  setSync("local");
  loadCache();
  updatePendingUI();
  render();
  toast("クラウド連携を解除しました（以降はこの端末に保存）");
}

/* =========================================================================
 * 初期化
 * ========================================================================= */

async function init() {
  loadConfig();
  loadCache();

  state.currentUser = localStorage.getItem(USER_KEY) || "";
  $("#currentUser").value = state.currentUser;
  $("#expDate").valueAsDate = new Date();

  $("#tabs").addEventListener("click", (e) => {
    const btn = e.target.closest(".tab");
    if (btn) setTab(btn.dataset.tab);
  });
  $("#currentUser").addEventListener("input", (e) => {
    state.currentUser = e.target.value.trim();
    localStorage.setItem(USER_KEY, state.currentUser);
    render();
  });
  $("#adminToggle").addEventListener("click", () => setAdmin(!state.isAdmin));

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

  $("#expenseForm").addEventListener("submit", submitExpense);

  $("#personalFilter").addEventListener("change", renderPersonal);
  $("#adminSearch").addEventListener("input", renderAdmin);
  $("#adminStatusFilter").addEventListener("change", renderAdmin);
  $("#csvBtn").addEventListener("click", exportCsv);

  $("#personalTable").addEventListener("click", (e) => {
    const del = e.target.closest("[data-del]");
    if (del) deleteExpense(del.dataset.del);
  });
  $("#adminTable").addEventListener("click", (e) => {
    const a = e.target.closest("[data-approve]");
    const r = e.target.closest("[data-reject]");
    const rs = e.target.closest("[data-reset]");
    if (a) approve(a.dataset.approve);
    else if (r) reject(r.dataset.reject);
    else if (rs) resetStatus(rs.dataset.reset);
  });

  // 設定モーダル
  $("#settingsBtn").addEventListener("click", openSettings);
  $("#cfgSave").addEventListener("click", saveSettings);
  $("#cfgClear").addEventListener("click", clearSettings);
  $("#reSyncBtn").addEventListener("click", () => refreshFromCloud());
  $$("[data-close]").forEach((el) => el.addEventListener("click", closeSettings));

  setAdmin(false);
  setTab("apply");
  updatePendingUI();

  if (cloudEnabled()) {
    await refreshFromCloud();
  } else {
    setSync("local");
    render();
  }
}

document.addEventListener("DOMContentLoaded", init);
