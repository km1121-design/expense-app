/**
 * 経費申請アプリ バックエンド（Google Apps Script Web App）
 *
 * 役割:
 *   - スプレッドシートを経費データ／ユーザーのデータベースとして使用
 *   - アップロードされた領収書画像を Google Drive フォルダに保存し、URL を行に記録
 *   - ユーザー認証（ソルト付き SHA-256 ハッシュ）と署名付きセッショントークンの発行
 *   - 権限制御: user = 自分の申請のみ / admin = 全申請＋承認＋ユーザー管理
 *   - 実績管理・分析ツール向けに JSON API（doGet）で全データを提供
 *
 * デプロイ手順は apps-script/README.md を参照。
 *
 * スクリプトプロパティ（自動保存されるものを含む）:
 *   SPREADSHEET_ID  : 保存先スプレッドシートID（未設定なら初回に「経費申請データ」を
 *                     自動作成し、そのIDをここへ自動保存して以降再利用）
 *   DRIVE_FOLDER_ID : 領収書画像の保存先フォルダID（未設定なら「経費領収書」を
 *                     自動作成・自動保存して以降再利用）
 *   AUTH_SECRET     : セッショントークン署名鍵（初回に自動生成・自動保存）
 *   SHARED_TOKEN    : 分析ツール用の読み取りトークン（設定時、doGet ?token= で全件取得可）
 *   GEMINI_API_KEY    : 設定するとレシートのAI解析（Gemini vision・無料枠可）が有効
 *   GEMINI_MODEL      : Geminiのモデル（既定: gemini-2.5-flash）
 *   ANTHROPIC_API_KEY : 設定するとレシートのAI解析（Claude vision）が有効
 *   OCR_MODEL         : Claudeのモデル（既定: claude-opus-4-8。安価なら claude-haiku-4-5）
 *   OCR_PROVIDER      : 併用時の優先プロバイダ "gemini"/"claude"（未指定なら gemini 優先）
 *
 * 認証モード:
 *   users シートが空の間は「オープンモード」（認証なし・従来互換）。
 *   最初の管理者を action=setup で作成すると認証が有効になる。
 */

const SHEET_NAME = "expenses";
const HEADERS = [
  "id",
  "createdAt",
  "applicant",
  "date",
  "category",
  "vendor",
  "amount",
  "description",
  "status",
  "reviewedAt",
  "reviewer",
  "reviewComment",
  "imageUrl",
  "imageFileId",
  "applicantId",
  "department",
];

const USERS_SHEET = "users";
const USER_HEADERS = [
  "username",
  "displayName",
  "passwordHash",
  "salt",
  "role",
  "active",
  "createdAt",
  "department",
];

const DEPARTMENTS_SHEET = "departments";
const DEFAULT_DEPARTMENTS = [
  "BAR",
  "人材",
  "運送",
  "本部",
  "ARTGRAGE",
  "クリニック",
  "GoonerHouse",
];

const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12時間

function getProp_(key) {
  return PropertiesService.getScriptProperties().getProperty(key);
}

/**
 * 自動承認モード。既定は有効（申請は即 approved になる）。
 * 承認フローを復活させる場合はスクリプトプロパティ AUTO_APPROVE を "false" に設定。
 */
function isAutoApprove_() {
  return getProp_("AUTO_APPROVE") !== "false";
}

/* ========================= ストレージ ========================= */

function getSpreadsheet_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty("SPREADSHEET_ID");
  if (id) return SpreadsheetApp.openById(id);
  // スタンドアロン型では getActiveSpreadsheet() が null になるため、
  // 初回に作成したスプレッドシートのIDを保存し、以降は必ず同じものを使う
  const ss =
    SpreadsheetApp.getActiveSpreadsheet() ||
    SpreadsheetApp.create("経費申請データ");
  props.setProperty("SPREADSHEET_ID", ss.getId());
  return ss;
}

function ensureSheet_(name, headers) {
  const ss = getSpreadsheet_();
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(headers);
    sheet.setFrozenRows(1);
  } else {
    // 既存シートに新しい列が増えた場合はヘッダー行を末尾に追記
    const width = sheet.getLastColumn();
    if (width < headers.length) {
      sheet
        .getRange(1, width + 1, 1, headers.length - width)
        .setValues([headers.slice(width)]);
    }
  }
  return sheet;
}

function getSheet_() {
  return ensureSheet_(SHEET_NAME, HEADERS);
}

function getUsersSheet_() {
  return ensureSheet_(USERS_SHEET, USER_HEADERS);
}

/** 事業部マスタ。初回作成時に既定事業部をシードする。 */
function getDepartmentsSheet_() {
  const ss = getSpreadsheet_();
  let sheet = ss.getSheetByName(DEPARTMENTS_SHEET);
  const fresh = !sheet;
  if (!sheet) sheet = ss.insertSheet(DEPARTMENTS_SHEET);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(["name"]);
    sheet.setFrozenRows(1);
    if (fresh) {
      DEFAULT_DEPARTMENTS.forEach(function (d) {
        sheet.appendRow([d]);
      });
    }
  }
  return sheet;
}

function getFolder_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty("DRIVE_FOLDER_ID");
  if (id) return DriveApp.getFolderById(id);
  const name = "経費領収書";
  const it = DriveApp.getFoldersByName(name);
  const folder = it.hasNext() ? it.next() : DriveApp.createFolder(name);
  props.setProperty("DRIVE_FOLDER_ID", folder.getId());
  return folder;
}

/* --------- 領収書フォルダ体系: 経費領収書/<事業部>/<yyyy-MM>/ --------- */

function getOrCreateSubfolder_(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

/** 事業部フォルダ（無ければ作成）。事業部が未設定の申請は「未設定」へ */
function getDeptFolder_(department) {
  const name = String(department || "").trim() || "未設定";
  return getOrCreateSubfolder_(getFolder_(), name);
}

/** 対象月フォルダ（無ければ作成）。月は経費の日付から決定 */
function getReceiptMonthFolder_(department, dateStr) {
  const m = String(dateStr || "").match(/^(\d{4})-(\d{2})/);
  const month = m
    ? m[1] + "-" + m[2]
    : Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM");
  return getOrCreateSubfolder_(getDeptFolder_(department), month);
}

/** ファイル名に使えない文字と空白を除去 */
function sanitizeFileName_(s) {
  return String(s || "").replace(/[\\\/:*?"<>|\s]/g, "") || "不明";
}

/** 命名規則: 日付_申請者_採番(001〜)。同日・同申請者内で連番 */
function buildReceiptFileName_(folder, dateStr, applicant, mime) {
  const date =
    String(dateStr || "").slice(0, 10) ||
    Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd");
  const base = date + "_" + sanitizeFileName_(applicant) + "_";
  let count = 0;
  const it = folder.getFiles();
  while (it.hasNext()) {
    if (it.next().getName().indexOf(base) === 0) count++;
  }
  const ext = String(mime || "").indexOf("png") >= 0 ? ".png" : ".jpg";
  return base + String(count + 1).padStart(3, "0") + ext;
}

/* ========================= 認証 ========================= */

function getSecret_() {
  const props = PropertiesService.getScriptProperties();
  let s = props.getProperty("AUTH_SECRET");
  if (!s) {
    s = Utilities.getUuid() + Utilities.getUuid();
    props.setProperty("AUTH_SECRET", s);
  }
  return s;
}

function hexDigest_(text) {
  const bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    text,
    Utilities.Charset.UTF_8
  );
  return bytes
    .map(function (b) {
      return ((b + 256) % 256).toString(16).padStart(2, "0");
    })
    .join("");
}

function hashPassword_(password, salt) {
  return hexDigest_(salt + ":" + password);
}

function b64url_(data) {
  return Utilities.base64EncodeWebSafe(data).replace(/=+$/, "");
}

function issueToken_(user) {
  const payload = JSON.stringify({
    u: user.username,
    n: user.displayName,
    r: user.role,
    e: Date.now() + TOKEN_TTL_MS,
  });
  const p = b64url_(payload);
  const sig = b64url_(Utilities.computeHmacSha256Signature(p, getSecret_()));
  return p + "." + sig;
}

function verifyToken_(token) {
  if (!token) return null;
  const parts = String(token).split(".");
  if (parts.length !== 2) return null;
  const expected = b64url_(
    Utilities.computeHmacSha256Signature(parts[0], getSecret_())
  );
  if (expected !== parts[1]) return null;
  try {
    const payload = JSON.parse(
      Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString()
    );
    if (!payload.e || payload.e < Date.now()) return null;
    return { username: payload.u, displayName: payload.n, role: payload.r };
  } catch (err) {
    return null;
  }
}

function usersExist_() {
  return getUsersSheet_().getLastRow() > 1;
}

function readUsers_() {
  const sheet = getUsersSheet_();
  const values = sheet.getDataRange().getValues();
  const head = values[0];
  const users = [];
  for (let i = 1; i < values.length; i++) {
    if (!values[i][0]) continue;
    const u = { _row: i + 1 };
    head.forEach(function (h, j) {
      u[h] = values[i][j];
    });
    users.push(u);
  }
  return users;
}

function findUser_(username) {
  const users = readUsers_();
  for (let i = 0; i < users.length; i++) {
    if (String(users[i].username) === String(username)) return users[i];
  }
  return null;
}

/**
 * 認証必須アクションの共通チェック。
 * users シートが空（オープンモード）の場合は従来互換で通し、SHARED_TOKEN のみ検査。
 */
function requireUser_(token, adminOnly) {
  if (!usersExist_()) {
    const shared = getProp_("SHARED_TOKEN");
    if (shared && token !== shared) throw new Error("unauthorized");
    return { username: "", displayName: "", role: "admin", legacy: true };
  }
  const u = verifyToken_(token);
  if (!u) throw new Error("unauthorized");
  const rec = findUser_(u.username);
  if (!rec || rec.active === false || String(rec.active) === "false") {
    throw new Error("unauthorized");
  }
  // 役割はシートの最新値を正とする（トークン発行後に変更された場合に反映）
  u.role = String(rec.role || "user");
  u.displayName = String(rec.displayName || u.username);
  if (adminOnly && u.role !== "admin") throw new Error("forbidden");
  return u;
}

function validateUsername_(username) {
  if (!/^[a-zA-Z0-9._-]{3,32}$/.test(String(username || ""))) {
    throw new Error("ユーザーIDは半角英数と . _ - の3〜32文字で指定してください");
  }
}

function validatePassword_(password) {
  if (String(password || "").length < 8) {
    throw new Error("パスワードは8文字以上にしてください");
  }
}

function createUserRow_(username, displayName, password, role, department) {
  validateUsername_(username);
  validatePassword_(password);
  if (findUser_(username)) throw new Error("そのユーザーIDは既に存在します");
  const salt = Utilities.getUuid();
  getUsersSheet_().appendRow([
    username,
    displayName || username,
    hashPassword_(password, salt),
    salt,
    role === "admin" ? "admin" : "user",
    true,
    new Date().toISOString(),
    department || "",
  ]);
}

function publicUser_(u) {
  return {
    username: String(u.username),
    displayName: String(u.displayName || u.username),
    role: String(u.role || "user"),
    active: !(u.active === false || String(u.active) === "false"),
    createdAt: String(u.createdAt || ""),
    department: String(u.department || ""),
  };
}

/* --------- 認証系アクション --------- */

/** 事業部マスタの一覧（シート登録順） */
function listDepartments_() {
  const sheet = getDepartmentsSheet_();
  const last = sheet.getLastRow();
  if (last < 2) return [];
  return sheet
    .getRange(2, 1, last - 1, 1)
    .getValues()
    .map(function (r) {
      return String(r[0] || "").trim();
    })
    .filter(function (d) {
      return d;
    });
}

function actionAddDepartment_(body) {
  requireUser_(body.token, true);
  const name = String(body.name || "").trim();
  if (!name) throw new Error("事業部名を入力してください");
  if (name.length > 40) throw new Error("事業部名が長すぎます");
  if (listDepartments_().indexOf(name) >= 0) {
    throw new Error("その事業部は既に存在します");
  }
  getDepartmentsSheet_().appendRow([name]);
  getDeptFolder_(name); // 領収書フォルダを自動作成
  return { ok: true, departments: listDepartments_() };
}

function actionDeleteDepartment_(body) {
  requireUser_(body.token, true);
  const name = String(body.name || "").trim();
  const sheet = getDepartmentsSheet_();
  const last = sheet.getLastRow();
  if (last >= 2) {
    const vals = sheet.getRange(2, 1, last - 1, 1).getValues();
    for (let i = 0; i < vals.length; i++) {
      if (String(vals[i][0]).trim() === name) {
        sheet.deleteRow(i + 2);
        break;
      }
    }
  }
  // 既存ユーザー・申請に付与済みの事業部名（履歴）と、Drive上の領収書フォルダは
  // そのまま残す（選択肢から外すだけ）
  return { ok: true, departments: listDepartments_() };
}

function actionSetup_(body) {
  if (usersExist_()) throw new Error("既に管理者が設定されています");
  createUserRow_(body.username, body.displayName, body.password, "admin", body.department);
  const user = publicUser_(findUser_(body.username));
  return {
    ok: true,
    token: issueToken_(user),
    user: user,
    departments: listDepartments_(),
  };
}

function actionLogin_(body) {
  if (!usersExist_()) throw new Error("初期設定（管理者作成）が必要です");
  const rec = findUser_(body.username);
  if (!rec) throw new Error("ユーザーIDまたはパスワードが違います");
  if (rec.active === false || String(rec.active) === "false") {
    throw new Error("このアカウントは無効化されています");
  }
  if (hashPassword_(body.password, String(rec.salt)) !== String(rec.passwordHash)) {
    throw new Error("ユーザーIDまたはパスワードが違います");
  }
  const user = publicUser_(rec);
  return {
    ok: true,
    token: issueToken_(user),
    user: user,
    departments: listDepartments_(),
  };
}

function actionChangePassword_(body) {
  const u = requireUser_(body.token, false);
  if (u.legacy) throw new Error("認証が無効のため変更できません");
  const rec = findUser_(u.username);
  if (
    hashPassword_(body.currentPassword, String(rec.salt)) !==
    String(rec.passwordHash)
  ) {
    throw new Error("現在のパスワードが違います");
  }
  validatePassword_(body.newPassword);
  const salt = Utilities.getUuid();
  const sheet = getUsersSheet_();
  sheet
    .getRange(rec._row, USER_HEADERS.indexOf("passwordHash") + 1)
    .setValue(hashPassword_(body.newPassword, salt));
  sheet.getRange(rec._row, USER_HEADERS.indexOf("salt") + 1).setValue(salt);
  return { ok: true };
}

function actionListUsers_(body) {
  requireUser_(body.token, true);
  return { ok: true, users: readUsers_().map(publicUser_) };
}

function actionUpsertUser_(body) {
  const admin = requireUser_(body.token, true);
  const u = body.user || {};
  const existing = findUser_(u.username);
  if (!existing) {
    createUserRow_(u.username, u.displayName, u.password, u.role, u.department);
    return { ok: true, created: true };
  }
  const sheet = getUsersSheet_();
  const set = function (col, val) {
    sheet.getRange(existing._row, USER_HEADERS.indexOf(col) + 1).setValue(val);
  };
  if (u.displayName != null) set("displayName", u.displayName);
  if (u.department != null) set("department", u.department);
  if (u.role != null) set("role", u.role === "admin" ? "admin" : "user");
  if (u.active != null) {
    // 自分自身の無効化・降格による締め出しを防止
    if (
      String(u.username) === admin.username &&
      (u.active === false || u.role === "user")
    ) {
      throw new Error("自分自身のアカウントは無効化・降格できません");
    }
    set("active", !!u.active);
  }
  if (u.password) {
    validatePassword_(u.password);
    const salt = Utilities.getUuid();
    set("passwordHash", hashPassword_(u.password, salt));
    set("salt", salt);
  }
  return { ok: true, updated: true };
}

/* ========================= 応答ユーティリティ ========================= */

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON
  );
}

/** シートが自動変換した Date 型を文字列へ戻す（date 列は yyyy-MM-dd） */
function normalizeValue_(header, value) {
  if (value instanceof Date) {
    if (header === "date") {
      return Utilities.formatDate(value, Session.getScriptTimeZone(), "yyyy-MM-dd");
    }
    return value.toISOString();
  }
  return value;
}

function rowsToRecords_(sheet) {
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  const head = values[0];
  const records = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    if (!row[0]) continue;
    const rec = {};
    head.forEach(function (h, j) {
      rec[h] = normalizeValue_(h, row[j]);
    });
    rec.amount = Number(rec.amount) || 0;
    records.push(rec);
  }
  return records;
}

function findRow_(sheet, id) {
  const last = sheet.getLastRow();
  if (last < 2) return -1;
  const ids = sheet.getRange(2, 1, last - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(id)) return i + 2; // 1-based + header
  }
  return -1;
}

/* ========================= HTTPエントリポイント ========================= */

/**
 * GET: 経費データを JSON で返す。
 *   - 認証有効時: セッショントークン必須。user は自分の申請のみ、admin は全件。
 *   - SHARED_TOKEN 設定時: ?token= が一致すれば全件（分析ツール連携用・読み取り専用）。
 *   - オープンモード（users 空）: 従来互換（SHARED_TOKEN 設定時のみ検査）。
 */
function doGet(e) {
  try {
    const token = e && e.parameter ? e.parameter.token : "";
    const shared = getProp_("SHARED_TOKEN");
    let records;
    if (shared && token === shared) {
      records = rowsToRecords_(getSheet_());
    } else {
      const u = requireUser_(token, false);
      records = rowsToRecords_(getSheet_());
      if (!u.legacy && u.role !== "admin") {
        records = records.filter(function (r) {
          return String(r.applicantId) === u.username;
        });
      }
    }
    return json_({ ok: true, records: records });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

/** POST: 認証・申請の作成・更新・削除・ユーザー管理 */
function doPost(e) {
  try {
    const body = JSON.parse((e.postData && e.postData.contents) || "{}");
    switch (body.action) {
      // ---- 認証（トークン不要） ----
      case "status":
        return json_({
          ok: true,
          authEnabled: usersExist_(),
          autoApprove: isAutoApprove_(),
          aiOcr: !!resolveOcrProvider_(),
        });
      case "setup":
        return json_(actionSetup_(body));
      case "login":
        return json_(actionLogin_(body));
      // ---- 認証（トークン必要） ----
      case "me": {
        const u = requireUser_(body.token, false);
        const profile = u.legacy ? null : findUser_(u.username);
        return json_({
          ok: true,
          user: {
            username: u.username,
            displayName: u.displayName,
            role: u.role,
            department: String((profile && profile.department) || ""),
          },
          departments: listDepartments_(),
        });
      }
      case "changePassword":
        return json_(actionChangePassword_(body));
      case "listUsers":
        return json_(actionListUsers_(body));
      case "upsertUser":
        return json_(actionUpsertUser_(body));
      // ---- 事業部マスタ ----
      case "listDepartments": {
        requireUser_(body.token, false);
        return json_({ ok: true, departments: listDepartments_() });
      }
      case "addDepartment":
        return json_(actionAddDepartment_(body));
      case "deleteDepartment":
        return json_(actionDeleteDepartment_(body));
      // ---- AIレシート解析 ----
      case "analyzeReceipt":
        return json_(actionAnalyzeReceipt_(body));
      // ---- 経費データ ----
      case "create": {
        const u = requireUser_(body.token, false);
        return json_(createExpense_(body.record, u));
      }
      case "update": {
        const u = requireUser_(body.token, true); // 承認・却下・差戻は管理者のみ
        return json_(updateExpense_(body.id, body.fields || {}, u));
      }
      case "delete": {
        const u = requireUser_(body.token, false);
        return json_(deleteExpense_(body.id, u));
      }
      default:
        return json_({ ok: false, error: "unknown action" });
    }
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

/* ========================= 経費データ操作 ========================= */

function createExpense_(record, user) {
  const sheet = getSheet_();
  // 認証有効時は申請者名・事業部をサーバー側で強制（なりすまし防止）
  const applicant = user.legacy
    ? String(record.applicant || "")
    : user.displayName;
  const applicantId = user.legacy
    ? String(record.applicantId || record.applicant || "")
    : user.username;
  // 事業部: 申請時に指定があればそれを優先、なければプロフィールの既定値
  let department = String(record.department || "").trim();
  if (!user.legacy && !department) {
    const profile = findUser_(user.username);
    department = String((profile && profile.department) || "");
  }

  // 領収書画像: 経費領収書/<事業部>/<yyyy-MM>/日付_申請者_採番 で保存
  let imageUrl = "";
  let imageFileId = "";
  if (record.imageBase64) {
    const folder = getReceiptMonthFolder_(department, record.date);
    const fileName = buildReceiptFileName_(
      folder,
      record.date,
      applicant,
      record.imageMime
    );
    const bytes = Utilities.base64Decode(record.imageBase64);
    const blob = Utilities.newBlob(
      bytes,
      record.imageMime || "image/jpeg",
      fileName
    );
    const file = folder.createFile(blob);
    imageFileId = file.getId();
    imageUrl = "https://drive.google.com/file/d/" + imageFileId + "/view";
  }
  // 自動承認モードでは申請と同時に承認済みにする
  const auto = isAutoApprove_();
  const rec = {
    id: record.id,
    createdAt: record.createdAt || new Date().toISOString(),
    applicant: applicant,
    date: record.date || "",
    category: record.category || "",
    vendor: record.vendor || "",
    amount: Number(record.amount) || 0,
    description: record.description || "",
    status: auto ? "approved" : "pending",
    reviewedAt: auto ? new Date().toISOString() : "",
    reviewer: auto ? "自動承認" : "",
    reviewComment: "",
    imageUrl: imageUrl,
    imageFileId: imageFileId,
    applicantId: applicantId,
    department: department,
  };
  sheet.appendRow(
    HEADERS.map(function (h) {
      return rec[h];
    })
  );
  return { ok: true, record: rec };
}

function updateExpense_(id, fields, user) {
  const sheet = getSheet_();
  const row = findRow_(sheet, id);
  if (row < 0) return { ok: false, error: "not found" };
  // 承認系の記録者もサーバー側で強制
  if (!user.legacy && (fields.status || fields.reviewer != null)) {
    fields.reviewer = user.displayName;
  }
  Object.keys(fields).forEach(function (k) {
    const col = HEADERS.indexOf(k);
    if (col >= 0) sheet.getRange(row, col + 1).setValue(fields[k]);
  });
  return { ok: true };
}

function deleteExpense_(id, user) {
  const sheet = getSheet_();
  const row = findRow_(sheet, id);
  if (row < 0) return { ok: false, error: "not found" };
  // 一般ユーザーは「自分の申請」のみ取消可能（状態は問わない＝ミス時の自己取消）
  if (!user.legacy && user.role !== "admin") {
    const applicantId = String(
      sheet.getRange(row, HEADERS.indexOf("applicantId") + 1).getValue()
    );
    if (applicantId !== user.username) {
      throw new Error("forbidden");
    }
  }
  const fileId = sheet
    .getRange(row, HEADERS.indexOf("imageFileId") + 1)
    .getValue();
  if (fileId) {
    try {
      DriveApp.getFileById(fileId).setTrashed(true);
    } catch (err) {
      // 画像削除に失敗しても行削除は続行
    }
  }
  sheet.deleteRow(row);
  return { ok: true };
}

/* ========================= AIレシート解析 ========================= */

const RECEIPT_CATEGORIES = [
  "交通費", "交際費", "会議費", "消耗品費", "通信費", "宿泊費", "その他",
];

const RECEIPT_PROMPT =
  "これは経費申請用のレシートまたは領収書の写真です。" +
  "画像から発行日（yyyy-MM-dd形式）・税込の合計支払金額（円）・店名を正確に読み取り、" +
  "購入内容から最も適切な経費科目を選び、15文字以内の短い摘要を作成してください。" +
  "合計金額は「合計」「税込」「ご請求」等の行を優先し、「お預り」「お釣り」「現金」の金額と混同しないこと。" +
  "読み取れない項目は空文字（金額は0）にしてください。";

/**
 * 使用するAI解析プロバイダを決定する。
 * 優先: スクリプトプロパティ OCR_PROVIDER（"gemini" / "claude"）。
 * 未指定ならキーが設定されている方（両方あれば gemini）。無ければ ""。
 */
function resolveOcrProvider_() {
  const pref = String(getProp_("OCR_PROVIDER") || "").toLowerCase();
  const hasGemini = !!getProp_("GEMINI_API_KEY");
  const hasClaude = !!getProp_("ANTHROPIC_API_KEY");
  if (pref === "gemini" && hasGemini) return "gemini";
  if (pref === "claude" && hasClaude) return "claude";
  if (hasGemini) return "gemini";
  if (hasClaude) return "claude";
  return "";
}

/** 抽出結果を正規化（型・既定値をそろえる） */
function normalizeReceiptFields_(o) {
  o = o || {};
  const cat = RECEIPT_CATEGORIES.indexOf(o.category) >= 0 ? o.category : "その他";
  return {
    date: String(o.date || "").slice(0, 10),
    amount: Math.max(0, Math.round(Number(o.amount) || 0)),
    vendor: String(o.vendor || ""),
    category: cat,
    description: String(o.description || ""),
  };
}

/** レシート解析（AI）。プロバイダはサーバー設定で選択、3段フォールバックの1段目 */
function actionAnalyzeReceipt_(body) {
  requireUser_(body.token, false);
  if (!body.imageBase64) throw new Error("画像がありません");
  const provider = resolveOcrProvider_();
  if (!provider) {
    throw new Error("AI解析は未設定です（GEMINI_API_KEY または ANTHROPIC_API_KEY を設定してください）");
  }
  const fields =
    provider === "gemini" ? analyzeWithGemini_(body) : analyzeWithClaude_(body);
  return { ok: true, fields: fields, provider: provider };
}

/** Gemini（無料枠可）で解析。モデルは GEMINI_MODEL で変更可（既定 gemini-2.5-flash） */
function analyzeWithGemini_(body) {
  const apiKey = getProp_("GEMINI_API_KEY");
  const model = getProp_("GEMINI_MODEL") || "gemini-2.5-flash";
  const schema = {
    type: "OBJECT",
    properties: {
      date: { type: "STRING" },
      amount: { type: "INTEGER" },
      vendor: { type: "STRING" },
      category: { type: "STRING", enum: RECEIPT_CATEGORIES },
      description: { type: "STRING" },
    },
    required: ["date", "amount", "vendor", "category", "description"],
  };
  const payload = {
    contents: [
      {
        parts: [
          {
            inline_data: {
              mime_type: String(body.imageMime || "image/jpeg"),
              data: String(body.imageBase64),
            },
          },
          { text: RECEIPT_PROMPT },
        ],
      },
    ],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: schema,
      temperature: 0,
    },
  };
  const url =
    "https://generativelanguage.googleapis.com/v1beta/models/" +
    encodeURIComponent(model) +
    ":generateContent?key=" +
    encodeURIComponent(apiKey);
  const res = UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  let data;
  try {
    data = JSON.parse(res.getContentText());
  } catch (err) {
    throw new Error("Gemini解析の応答を読み取れませんでした（HTTP " + code + "）");
  }
  if (code !== 200) {
    const msg = data && data.error && data.error.message ? data.error.message : "HTTP " + code;
    throw new Error("Gemini解析エラー: " + msg);
  }
  const cand = (data.candidates || [])[0];
  if (!cand || !cand.content) throw new Error("Gemini解析が応答を返しませんでした");
  let text = "";
  (cand.content.parts || []).forEach(function (p) {
    if (p.text) text += p.text;
  });
  return normalizeReceiptFields_(JSON.parse(text));
}

/** Claude で解析。モデルは OCR_MODEL で変更可（既定 claude-opus-4-8） */
function analyzeWithClaude_(body) {
  const apiKey = getProp_("ANTHROPIC_API_KEY");
  const model = getProp_("OCR_MODEL") || "claude-opus-4-8";
  const schema = {
    type: "object",
    properties: {
      date: { type: "string" },
      amount: { type: "integer" },
      vendor: { type: "string" },
      category: { type: "string", enum: RECEIPT_CATEGORIES },
      description: { type: "string" },
    },
    required: ["date", "amount", "vendor", "category", "description"],
    additionalProperties: false,
  };
  const payload = {
    model: model,
    max_tokens: 1024,
    output_config: { format: { type: "json_schema", schema: schema } },
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: String(body.imageMime || "image/jpeg"),
              data: String(body.imageBase64),
            },
          },
          { type: "text", text: RECEIPT_PROMPT },
        ],
      },
    ],
  };
  const res = UrlFetchApp.fetch("https://api.anthropic.com/v1/messages", {
    method: "post",
    contentType: "application/json",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  let data;
  try {
    data = JSON.parse(res.getContentText());
  } catch (err) {
    throw new Error("AI解析の応答を読み取れませんでした（HTTP " + code + "）");
  }
  if (code !== 200) {
    const msg = data && data.error && data.error.message ? data.error.message : "HTTP " + code;
    throw new Error("AI解析エラー: " + msg);
  }
  if (data.stop_reason === "refusal") {
    throw new Error("AI解析が画像を処理できませんでした");
  }
  let text = "";
  (data.content || []).forEach(function (b) {
    if (b.type === "text") text += b.text;
  });
  return normalizeReceiptFields_(JSON.parse(text));
}

/* ========================= 月次フォルダの自動生成 ========================= */

/**
 * 全事業部（＋未設定）に翌月の領収書フォルダを作成する。
 * setupMonthlyFolderTrigger() で毎月末（28日）の自動実行を有効化できるほか、
 * エディタから手動実行も可能。申請保存時にも対象月フォルダは自動作成されるため、
 * トリガー未設定でも運用に支障はない（事前生成が不要ならこの設定は省略可）。
 */
function createNextMonthFolders() {
  const tz = Session.getScriptTimeZone();
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const month = Utilities.formatDate(next, tz, "yyyy-MM");
  const targets = listDepartments_().concat([""]); // "" = 未設定
  targets.forEach(function (d) {
    getOrCreateSubfolder_(getDeptFolder_(d), month);
  });
  Logger.log("翌月フォルダを作成: %s（%s事業部）", month, targets.length);
}

/**
 * メンテナンス用：エディタから一度実行すると、毎月28日23時台に
 * createNextMonthFolders を自動実行するトリガーを登録する（二重登録は自動で防止）。
 */
function setupMonthlyFolderTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "createNextMonthFolders") {
      ScriptApp.deleteTrigger(t);
    }
  });
  ScriptApp.newTrigger("createNextMonthFolders")
    .timeBased()
    .onMonthDay(28)
    .atHour(23)
    .create();
  createNextMonthFolders(); // 登録と同時に翌月分も作成しておく
  Logger.log("月次フォルダ自動生成トリガーを登録しました（毎月28日）");
}

/* ========================= メンテナンス ========================= */

/**
 * メンテナンス用：エディタから手動実行する（デプロイ不要）。
 * 正本（SPREADSHEET_ID に保存されたもの）以外の「経費申請データ」と、
 * 領収書フォルダ内の動作検証用テスト画像（e-verify-test*）をゴミ箱へ移動する。
 */
function cleanupStrayFiles() {
  const keepId = getProp_("SPREADSHEET_ID");
  if (!keepId) throw new Error("SPREADSHEET_ID が未保存です。先に一度アプリ／doGet を実行してください。");
  let trashed = [];

  const files = DriveApp.getFilesByName("経費申請データ");
  while (files.hasNext()) {
    const f = files.next();
    if (
      f.getId() !== keepId &&
      f.getMimeType() === "application/vnd.google-apps.spreadsheet" &&
      !f.isTrashed()
    ) {
      f.setTrashed(true);
      trashed.push("スプレッドシート: " + f.getId());
    }
  }

  try {
    const folderFiles = getFolder_().getFiles();
    while (folderFiles.hasNext()) {
      const f = folderFiles.next();
      if (f.getName().indexOf("e-verify-test") === 0 && !f.isTrashed()) {
        f.setTrashed(true);
        trashed.push("テスト画像: " + f.getName());
      }
    }
  } catch (err) {
    trashed.push("(フォルダ走査でエラー: " + err + ")");
  }

  Logger.log("ゴミ箱へ移動 %s 件:\n%s", trashed.length, trashed.join("\n"));
  return trashed;
}
