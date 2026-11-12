/**
 * 経費申請アプリ バックエンド（Google Apps Script Web App）
 *
 * 役割:
 *   - スプレッドシートを経費データ／ユーザー／事業部のデータベースとして使用
 *     （タブ名・1行目の見出しは日本語。内部キー・JSON APIのキー名は英語で固定）
 *   - アップロードされた領収書画像を Google Drive フォルダに保存し、URL を行に記録
 *   - ユーザー認証（ソルト付き SHA-256 ハッシュ）と署名付きセッショントークンの発行
 *   - 権限制御: user = 自分の申請のみ / admin = 全申請＋ユーザー・事業部の管理
 *   - 承認の手続きは無い（申請はそのまま計上される）
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
 *   GEMINI_MODEL      : Geminiのモデル（未設定なら現行の flash 系を順に試す）
 *   ANTHROPIC_API_KEY : 設定するとレシートのAI解析（Claude vision）が有効
 *   OCR_MODEL         : Claudeのモデル（既定: claude-opus-5。安価なら claude-haiku-4-5）
 *   OCR_PROVIDER      : 併用時の優先プロバイダ "gemini"/"claude"（未指定なら gemini 優先）
 *   OCR_ESCALATE_PROVIDER : 1回目で金額・日付が取れなかったときだけ読み直すプロバイダ
 *                       "gemini"/"claude"。**未設定なら読み直さない**（既定で無効）。
 *                       有料モデルを指定すると、読めなかった分だけ課金が発生する
 *   OCR_ESCALATE_MODEL    : 読み直しに使うモデル（未指定ならそのプロバイダの既定）
 *
 * 認証モード:
 *   users シートが空の間は「オープンモード」（認証なし・従来互換）。
 *   最初の管理者を action=setup で作成すると認証が有効になる。
 */

/**
 * シートの列定義。[内部キー, シート1行目に表示する見出し] の順で列順そのものを表す。
 * 内部キーは JSON API・フロントエンドが使う名前なので変更しない。
 * 見出しだけを日本語にすることで、シートを直接見る人にわかりやすくする。
 * 旧版で作られた英語見出し・英語タブ名は ensureSheet_ が自動で日本語へ移行する。
 */
const SHEET_NAME = "経費データ";
const SHEET_NAME_LEGACY = "expenses";
const EXPENSE_COLUMNS = [
  ["id", "申請ID"],
  ["createdAt", "申請日時"],
  ["applicant", "申請者"],
  ["date", "利用日"],
  ["category", "科目"],
  ["vendor", "支払先"],
  ["amount", "金額"],
  ["description", "摘要"],
  ["status", "状態"],
  ["reviewedAt", "処理日時"],
  ["reviewer", "処理者"],
  ["reviewComment", "却下理由・備考"],
  ["imageUrl", "領収書URL"],
  ["imageFileId", "領収書ファイルID"],
  ["applicantId", "申請者ID"],
  ["department", "事業部"],
  // 以下は、かつての交通費の運賃照合の列。機能は削除したが、過去の行と列の位置を
  // そろえるため（列は位置で読み書きする）定義だけ残している。新しい申請では空。
  ["fareFrom", "出発駅"],
  ["fareTo", "到着駅"],
  ["fareRound", "往復"],
  ["fareTrips", "回数"],
  ["fareUnit", "片道運賃"],
  ["fareExpected", "想定金額"],
  ["fareCheck", "運賃照合"],
];
const HEADERS = EXPENSE_COLUMNS.map(function (c) {
  return c[0];
});

const USERS_SHEET = "ユーザー";
const USERS_SHEET_LEGACY = "users";
const USER_COLUMNS = [
  ["username", "ユーザーID"],
  ["displayName", "表示名"],
  ["passwordHash", "パスワードハッシュ"],
  ["salt", "ソルト"],
  ["role", "権限"],
  ["active", "有効"],
  ["createdAt", "登録日時"],
  ["department", "事業部"],
];
const USER_HEADERS = USER_COLUMNS.map(function (c) {
  return c[0];
});

const DEPARTMENTS_SHEET = "事業部マスタ";
const DEPARTMENTS_SHEET_LEGACY = "departments";
const DEPARTMENT_COLUMNS = [["name", "事業部名"]];

const DEFAULT_DEPARTMENTS = [
  "BAR",
  "人材",
  "運送",
  "本部",
  "ARTGRAGE",
  "クリニック",
  "GoonerHouse",
];

/**
 * レシートの書き起こし（raw_text）に許す行数の上限。
 *
 * AI解析の応答時間は出力の長さでほぼ決まるので、精度と速度はこの数字で
 * 正面から綱引きする。通常の読み取りは速度寄りに抑え、必須項目が取れなかった
 * ときだけ `RECEIPT_RAW_TEXT_RETRY_LINES` で丁寧に読み直す（大半の申請は
 * 1回目で終わるため、平均の待ち時間を増やさずに読み取れる範囲を広げられる）。
 */
const RECEIPT_RAW_TEXT_MAX_LINES = 12;
/** 読み直し時の上限。難しいレシートはここで根拠を厚くする */
const RECEIPT_RAW_TEXT_RETRY_LINES = 24;

/**
 * ログインの有効期間。スタッフが半日ごとに入り直さなくて済むよう30日にしている。
 * 残りが半分を切った状態で起動（bootstrap）すると新しいトークンを返す（使うたびに延びる）。
 * 失効させたいときは、利用コードの再発行・パスワードの変更・無効化（tokenVersion_）。
 */
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30日
const TOKEN_RENEW_MS = TOKEN_TTL_MS / 2;

function getProp_(key) {
  return PropertiesService.getScriptProperties().getProperty(key);
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

/**
 * シートを取得（無ければ作成）し、タブ名と1行目の見出しを日本語に揃える。
 * 旧版で作られた英語タブ（expenses など）は見つけ次第リネームし、
 * 英語の見出し行も日本語ラベルへ置き換えるため、移行作業は不要。
 * 列は EXPENSE_COLUMNS 等の定義順そのもので、内部の読み書きは位置で行う。
 */
function ensureSheet_(name, columns, legacyName) {
  const ss = getSpreadsheet_();
  let sheet = ss.getSheetByName(name);
  if (!sheet && legacyName) {
    const legacy = ss.getSheetByName(legacyName);
    if (legacy) {
      legacy.setName(name); // 旧英語タブ名 → 日本語タブ名
      sheet = legacy;
    }
  }
  const labels = columns.map(function (c) {
    return c[1];
  });
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(labels);
    sheet.setFrozenRows(1);
    return sheet;
  }
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(labels);
    sheet.setFrozenRows(1);
    return sheet;
  }
  // 既存シート: 列の追加と、英語見出し → 日本語見出しの置き換え
  const width = Math.max(sheet.getLastColumn(), labels.length);
  const head = sheet.getRange(1, 1, 1, width).getValues()[0];
  let changed = false;
  labels.forEach(function (label, i) {
    if (String(head[i] == null ? "" : head[i]).trim() !== label) {
      head[i] = label;
      changed = true;
    }
  });
  if (changed) sheet.getRange(1, 1, 1, width).setValues([head]);
  return sheet;
}

/**
 * 1行目の見出し（日本語ラベル／旧英語名のどちらでも）を内部キーの配列に変換する。
 * 見出しが書き換えられていても、定義に無い列は元の文字列のまま残す。
 */
function headerKeys_(headRow, columns) {
  return headRow.map(function (h) {
    const t = String(h == null ? "" : h).trim();
    for (let i = 0; i < columns.length; i++) {
      if (columns[i][1] === t || columns[i][0] === t) return columns[i][0];
    }
    return t;
  });
}

function getSheet_() {
  return ensureSheet_(SHEET_NAME, EXPENSE_COLUMNS, SHEET_NAME_LEGACY);
}

function getUsersSheet_() {
  return ensureSheet_(USERS_SHEET, USER_COLUMNS, USERS_SHEET_LEGACY);
}

/**
 * シート名・見出しの定義の版。ここを変えると次のリクエストで全シートを移行する。
 */
const SCHEMA_VERSION = "2026-08-ja-2";

/**
 * 全シートのタブ名と見出しを現在の定義に揃える。
 *
 * 各シートは使われたときにしか ensureSheet_ を通らないため、使われていない
 * シートは日本語化されない。それを避けるため、版が変わったときだけ全シートを
 * まとめて移行する（普段はプロパティ1回の読み取りだけで終わる）。
 * 存在しないシートはここで作成され、見出しだけの空シートになる。
 */
function migrateSheetsIfNeeded_() {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty("SCHEMA_VERSION") === SCHEMA_VERSION) return;
  migrateSheets();
  props.setProperty("SCHEMA_VERSION", SCHEMA_VERSION);
}

/**
 * メンテナンス用：エディタから手動実行できる全シートの移行（デプロイ不要）。
 * タブ名のリネームと見出しの日本語化・列の追記を、全シートに対して行う。
 */
function migrateSheets() {
  getSheet_();
  getUsersSheet_();
  getDepartmentsSheet_();
}

/** 移行の失敗でリクエスト自体を落とさないためのラッパー */
function safeMigrateSheets_() {
  try {
    migrateSheetsIfNeeded_();
  } catch (err) {
    // 移行できなくても本来の処理は続行する（次回のリクエストで再試行される）
  }
}

/** 事業部マスタ。初回作成時に既定事業部をシードする。 */
function getDepartmentsSheet_() {
  const existed =
    !!getSpreadsheet_().getSheetByName(DEPARTMENTS_SHEET) ||
    !!getSpreadsheet_().getSheetByName(DEPARTMENTS_SHEET_LEGACY);
  const sheet = ensureSheet_(
    DEPARTMENTS_SHEET,
    DEPARTMENT_COLUMNS,
    DEPARTMENTS_SHEET_LEGACY
  );
  if (!existed) {
    DEFAULT_DEPARTMENTS.forEach(function (d) {
      sheet.appendRow([d]);
    });
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
  // 月フォルダの全ファイルを走査すると、その月の申請が増えるほど申請の保存が
  // 遅くなる。同じ日・同じ申請者のファイルだけをドライブ側で絞ってから数える。
  const it = folder.searchFiles(
    "title contains '" + base.replace(/'/g, "\\'") + "'"
  );
  while (it.hasNext()) {
    if (it.next().getName().indexOf(base) === 0) count++; // contains は部分一致なので前方一致で確認する
  }
  const ext = String(mime || "").indexOf("png") >= 0 ? ".png" : ".jpg";
  return base + String(count + 1).padStart(3, "0") + ext;
}

/**
 * 領収書画像を「リンクを知っている人は閲覧可」にする。
 *
 * こうしないと、画像はスクリプト所有者のドライブにあるため、所有者以外のブラウザ
 * からはサムネイルの直リンクが 403 になる。その場合アプリは画像1枚ごとに
 * バックエンドへ取得を投げ直すことになり、一覧表示が目に見えて遅くなる。
 *
 * **URLを知っていれば誰でも閲覧できる状態になる**（ファイルIDは推測できない長さだが、
 * 認証はかからない）。この扱いで問題がある運用では、この関数の中身を空にすれば
 * 従来どおりアプリ経由の取得（遅いが所有者のみに閉じる）へ戻る。
 */
function shareReceiptFile_(file) {
  try {
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (err) {
    // 組織のポリシーで外部共有が禁止されている場合など。共有できなくても
    // アプリ経由の取得で表示はできるので、申請そのものは失敗させない。
  }
}

/**
 * 既存の領収書画像をまとめてリンク共有にする（エディタから手動実行する）。
 * 共有設定を入れる前に保存された画像は直リンクが通らないままなので、
 * 一度だけこれを流すと以降は他の画像と同じ速さで表示される。
 */
function shareExistingReceipts() {
  const sheet = getSheet_();
  const last = sheet.getLastRow();
  if (last < 2) return "対象の申請がありません";
  const head = headerKeys_(
    sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0],
    EXPENSE_COLUMNS
  );
  const col = head.indexOf("imageFileId");
  if (col < 0) return "領収書ファイルIDの列が見つかりません";
  const ids = sheet.getRange(2, col + 1, last - 1, 1).getValues();
  let done = 0;
  let failed = 0;
  ids.forEach(function (r) {
    const id = String(r[0] || "").trim();
    if (!id) return;
    try {
      shareReceiptFile_(DriveApp.getFileById(id));
      done++;
    } catch (err) {
      failed++; // 削除済みなど
    }
  });
  const msg = "共有設定: " + done + "件を処理、" + failed + "件は失敗（削除済みなど）";
  Logger.log(msg);
  return msg;
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

/**
 * トークンの世代。パスワード（＝利用コード）を変えるとソルトが変わるので、
 * ソルトから作ったこの値も変わり、それ以前に発行したトークンはすべて無効になる。
 * トークンの中身は読めるため、ソルトそのものは入れずに一方向の値だけを入れる。
 */
function tokenVersion_(rec) {
  return hexDigest_("tv:" + String(rec.salt)).slice(0, 12);
}

function issueToken_(user, version) {
  const payload = JSON.stringify({
    u: user.username,
    n: user.displayName,
    r: user.role,
    s: version,
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
    return {
      username: payload.u,
      displayName: payload.n,
      role: payload.r,
      version: payload.s, // 世代の無い旧トークンは undefined（発行は最長12時間前までなので期限切れを待つ）
      exp: payload.e,
    };
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
  const head = headerKeys_(values[0], USER_COLUMNS);
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
  // パスワード・利用コードが変わった後は、古いトークンを受け付けない
  u.tokenVersion = tokenVersion_(rec);
  if (u.version !== undefined && u.version !== u.tokenVersion) {
    throw new Error("unauthorized");
  }
  // 役割はシートの最新値を正とする（トークン発行後に変更された場合に反映）
  u.role = String(rec.role || "user");
  u.displayName = String(rec.displayName || u.username);
  // 事業部もここで持たせる。呼び出し側が findUser_ を呼び直すと、1リクエストで
  // ユーザーシートを2回読むことになるため。
  u.department = String(rec.department || "");
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

/**
 * 利用者の事業部は複数持てる。シートには「人材,BAR」のようにカンマ区切りで入れる
 * （人がシートを直すときの「、」も受け付ける）。配列でも文字列でも受け取り、
 * 空・重複を除いた正規の形へそろえる。
 */
function splitDepartments_(v) {
  const list = Array.isArray(v) ? v : String(v == null ? "" : v).split(/[,、]/);
  const out = [];
  list.forEach(function (d) {
    const t = String(d == null ? "" : d).trim();
    if (t && out.indexOf(t) < 0) out.push(t);
  });
  return out;
}
function joinDepartments_(v) {
  return splitDepartments_(v).join(",");
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
  const created = findUser_(body.username);
  const user = publicUser_(created);
  return {
    ok: true,
    token: issueToken_(user, tokenVersion_(created)),
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
    token: issueToken_(user, tokenVersion_(rec)),
    user: user,
    departments: listDepartments_(),
  };
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
    createUserRow_(u.username, u.displayName, u.password, u.role, joinDepartments_(u.department));
    return { ok: true, created: true };
  }
  const sheet = getUsersSheet_();
  const set = function (col, val) {
    sheet.getRange(existing._row, USER_HEADERS.indexOf(col) + 1).setValue(val);
  };
  if (u.displayName != null) set("displayName", u.displayName);
  if (u.department != null) set("department", joinDepartments_(u.department));
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
  let renewed = null;
  if (u.password) {
    validatePassword_(u.password);
    const salt = Utilities.getUuid();
    set("passwordHash", hashPassword_(u.password, salt));
    set("salt", salt);
    // 自分のパスワードを変えると自分のトークンも失効するので、新しいものを返す
    if (String(u.username) === admin.username) {
      renewed = issueToken_(
        { username: admin.username, displayName: admin.displayName, role: admin.role },
        tokenVersion_({ salt: salt })
      );
    }
  }
  const out = { ok: true, updated: true };
  if (renewed) out.token = renewed;
  return out;
}

/* ==================== 利用コードでのログイン（軽量版） ==================== */

/**
 * 利用コード: 管理者が発行し、利用者はこれだけでログインする（IDもパスワードも不要）。
 *
 * - コードはパスワードと同じ列（パスワードハッシュ・ソルト）にハッシュで保存する。
 *   シートを見てもコードは分からないので、忘れたら再発行する。
 *   通常版の「IDとパスワード」でログインするときは、コードがパスワードとして通る。
 * - 紛らわしい文字（0/O・1/I）を除いた32文字から8桁。約40ビットで、
 *   総当たりは1回あたり数秒かかる Apps Script では現実的でない。
 */
const ACCESS_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const ACCESS_CODE_LENGTH = 8;

/** 入力のゆれ（小文字・ハイフン・空白）を吸収する */
function normalizeAccessCode_(code) {
  return String(code || "")
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, "");
}

/** 新しいコードを作る。乱数は Utilities.getUuid（暗号論的乱数）から取る */
function generateAccessCode_() {
  const hex = Utilities.getUuid().replace(/[^0-9a-f]/gi, "");
  let out = "";
  for (let i = 0; out.length < ACCESS_CODE_LENGTH; i += 2) {
    // 256 は 32 で割り切れるので、1バイトを32で割った余りに偏りは出ない
    out += ACCESS_CODE_ALPHABET[parseInt(hex.substr(i, 2), 16) % ACCESS_CODE_ALPHABET.length];
  }
  return out;
}

/** 表示用（ABCD-EFGH） */
function formatAccessCode_(code) {
  return code.slice(0, 4) + "-" + code.slice(4);
}

/** コードに一致する利用者（無ければ null）。利用者数ぶんハッシュを計算する */
function findUserByAccessCode_(code, users) {
  const list = users || readUsers_();
  for (let i = 0; i < list.length; i++) {
    if (hashPassword_(code, String(list[i].salt)) === String(list[i].passwordHash)) {
      return list[i];
    }
  }
  return null;
}

function actionLoginCode_(body) {
  if (!usersExist_()) throw new Error("初期設定（管理者作成）が必要です");
  const code = normalizeAccessCode_(body.code);
  const rec = code.length === ACCESS_CODE_LENGTH ? findUserByAccessCode_(code) : null;
  if (!rec) {
    Utilities.sleep(1000); // 総当たりを遅らせる
    throw new Error("利用コードが違います");
  }
  if (rec.active === false || String(rec.active) === "false") {
    throw new Error("このアカウントは無効化されています");
  }
  const user = publicUser_(rec);
  return {
    ok: true,
    token: issueToken_(user, tokenVersion_(rec)),
    user: user,
    departments: listDepartments_(),
  };
}

/**
 * 利用コードの発行（管理者のみ）。
 *   username なし → 利用者を新規作成してコードを発行（ユーザーIDは自動で振る）
 *   username あり → その利用者のコードを再発行（前のコードは使えなくなる）
 * コードは応答でしか返さない（保存はハッシュのみ）。
 */
function actionIssueAccessCode_(body) {
  const admin = requireUser_(body.token, true);
  const u = body.user || {};
  const users = readUsers_();
  // 他人とコードが重なると、ログイン時にどちらか一方にしか入れなくなるので避ける
  let code;
  do {
    code = generateAccessCode_();
  } while (findUserByAccessCode_(code, users));

  const sheet = getUsersSheet_();
  const salt = Utilities.getUuid();
  let username = String(u.username || "").trim();
  if (!username) {
    const displayName = String(u.displayName || "").trim();
    if (!displayName) throw new Error("名前を入力してください");
    do {
      username = "u" + generateAccessCode_().toLowerCase().slice(0, 6);
    } while (users.some(function (x) { return String(x.username) === username; }));
    sheet.appendRow([
      username,
      displayName,
      hashPassword_(code, salt),
      salt,
      u.role === "admin" ? "admin" : "user",
      true,
      new Date().toISOString(),
      joinDepartments_(u.department),
    ]);
  } else {
    const rec = users.filter(function (x) { return String(x.username) === username; })[0];
    if (!rec) throw new Error("利用者が見つかりません");
    sheet.getRange(rec._row, USER_HEADERS.indexOf("passwordHash") + 1).setValue(hashPassword_(code, salt));
    sheet.getRange(rec._row, USER_HEADERS.indexOf("salt") + 1).setValue(salt);
  }
  const out = { ok: true, username: username, code: formatAccessCode_(code) };
  // 自分のコードを発行し直すと自分のトークンも失効するので、新しいものを返す
  if (username === admin.username) {
    out.token = issueToken_(
      { username: admin.username, displayName: admin.displayName, role: admin.role },
      tokenVersion_({ salt: salt })
    );
  }
  return out;
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
  const head = headerKeys_(values[0], EXPENSE_COLUMNS);
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
    safeMigrateSheets_();
    const token = e && e.parameter ? e.parameter.token : "";
    const shared = getProp_("SHARED_TOKEN");
    let records;
    if (shared && token === shared) {
      records = rowsToRecords_(getSheet_());
    } else {
      records = recordsForUser_(requireUser_(token, false));
    }
    return json_({ ok: true, records: records });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

/** 一般ユーザーには自分の申請だけを返す（絞り込みはサーバー側で行う） */
function recordsForUser_(u, month) {
  let records = rowsToRecords_(getSheet_());
  if (!(u.legacy || u.role === "admin")) {
    records = records.filter(function (r) {
      return String(r.applicantId) === u.username;
    });
  }
  // 月の指定があれば、その月の分だけ返す（一覧のダウンロード量を月の件数に抑える）
  const m = normalizeMonth_(month);
  if (!m) return records;
  return records.filter(function (r) {
    return String(r.date || "").slice(0, 7) === m;
  });
}

/** "yyyy-MM" だけを月として認める。空・不正な値は「全期間」（従来の動作） */
function normalizeMonth_(month) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(month || "")) ? String(month) : "";
}

/**
 * アプリ側が「このバックエンドで何が使えるか」を判定するための情報。
 * 古いコードのままデプロイされている場合は features のキー自体が返らないので、
 * アプリは機能が無いものとして扱い、再デプロイを促す。
 */
function statusPayload_() {
  return {
    ok: true,
    authEnabled: usersExist_(),
    aiOcr: !!resolveOcrProvider_(),
    version: SCHEMA_VERSION,
    features: {
      bootstrap: true, // 起動を1往復にまとめられるか
      list: true, // 月ごとの一覧
      accessCode: true, // 利用コードでのログイン
    },
  };
}

/**
 * 起動用。`status`・ログイン中のユーザー・一覧取得の3往復を1往復にまとめる。
 *
 * トークンが無効でもエラーにしない（`user: null` を返す）。ここで例外にすると、
 * アプリはログイン画面を出すためにもう1往復することになり、統合の意味がなくなる。
 */
function actionBootstrap_(body) {
  const out = statusPayload_();
  out.user = null;
  out.departments = null;
  out.records = null;
  if (!out.authEnabled) return out; // 初期設定（最初の管理者作成）が先
  let u;
  try {
    u = requireUser_(body.token, false);
  } catch (err) {
    return out; // 未ログイン・期限切れ。アプリはログイン画面を出す
  }
  out.user = {
    username: u.username,
    displayName: u.displayName,
    role: u.role,
    department: String(u.department || ""), // requireUser_ が読み取り済み
  };
  out.departments = listDepartments_();
  out.records = recordsForUser_(u, body.month);
  out.month = normalizeMonth_(body.month); // 返した範囲（空 = 全期間）
  // 残りの有効期間が半分を切っていたら新しいトークンを返す（使うたびに延びる）
  if (u.exp && u.exp - Date.now() < TOKEN_RENEW_MS) {
    out.token = issueToken_(
      { username: u.username, displayName: u.displayName, role: u.role },
      u.tokenVersion
    );
  }
  return out;
}

/** POST: 認証・申請の作成と削除・一覧・ユーザーと事業部の管理 */
function doPost(e) {
  try {
    safeMigrateSheets_();
    const body = JSON.parse((e.postData && e.postData.contents) || "{}");
    switch (body.action) {
      // ---- 認証（トークン不要） ----
      case "status":
        return json_(statusPayload_());
      // 起動用。status + me + 一覧を1往復で返す（起動の待ち時間を減らすため）。
      case "bootstrap":
        return json_(actionBootstrap_(body));
      // 月ごとの一覧（軽量版）。月を切り替えたときに、その月の分だけ取得する
      case "list": {
        const u = requireUser_(body.token, false);
        return json_({
          ok: true,
          month: normalizeMonth_(body.month),
          records: recordsForUser_(u, body.month),
        });
      }
      case "setup":
        return json_(actionSetup_(body));
      case "login":
        return json_(actionLogin_(body));
      // 利用コードだけでログイン（軽量版）
      case "loginCode":
        return json_(actionLoginCode_(body));
      // ---- 利用者（管理者のみ） ----
      case "listUsers":
        return json_(actionListUsers_(body));
      case "upsertUser":
        return json_(actionUpsertUser_(body));
      case "issueAccessCode":
        return json_(actionIssueAccessCode_(body));
      // ---- 事業部マスタ（管理者のみ） ----
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
  // （requireUser_ が読み取り済みなので、ここでユーザーシートを読み直さない）
  let department = String(record.department || "").trim();
  // 利用者が複数の事業部に属している場合は先頭を既定にする（「人材,BAR」をそのまま入れない）
  if (!user.legacy && !department) department = splitDepartments_(user.department)[0] || "";

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
    shareReceiptFile_(file);
    imageFileId = file.getId();
    imageUrl = "https://drive.google.com/file/d/" + imageFileId + "/view";
  }
  // 承認の手続きは無い。申請はそのまま計上される（状態は常に approved）。
  // 運賃照合の列は、過去の行と列の位置をそろえるために空のまま残している。
  const rec = {
    id: record.id,
    createdAt: record.createdAt || new Date().toISOString(),
    applicant: applicant,
    date: record.date || "",
    category: record.category || "",
    vendor: record.vendor || "",
    amount: Number(record.amount) || 0,
    description: record.description || "",
    status: "approved",
    reviewedAt: new Date().toISOString(),
    reviewer: "自動承認",
    reviewComment: "",
    imageUrl: imageUrl,
    imageFileId: imageFileId,
    applicantId: applicantId,
    department: department,
  };
  sheet.appendRow(
    HEADERS.map(function (h) {
      return rec[h] === undefined ? "" : rec[h];
    })
  );
  return { ok: true, record: rec };
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

/** 今日の日付（JST等スクリプトTZ）をプロンプトに渡すためのヘルパ */
function todayStr_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd");
}

/**
 * レシート解析プロンプト（今日の日付を埋め込む）。
 * maxLines は書き起こし（raw_text）に許す行数の上限。
 */
function buildReceiptPrompt_(maxLines) {
  const today = todayStr_();
  const lines = Math.max(3, Math.round(Number(maxLines) || RECEIPT_RAW_TEXT_MAX_LINES));
  return (
    "あなたは日本の経費精算の担当者です。添付はレシートまたは領収書の写真です。\n" +
    "今日の日付は " + today + " です（この日付より未来の発行日はありえません）。\n\n" +
    "重要: 写真は90度・180度回転している場合や、斜め・影・感熱紙のかすれがある場合があります。" +
    "文字の向きを判断し、必要なら頭の中で回転させて正しく読んでください。\n\n" +
    "手順を必ず守ってください:\n" +
    // raw_text は精度のための「根拠」だが、応答時間は出力の長さでほぼ決まる。
    // 全文を書き写させると解析が目に見えて遅くなるため、根拠になる行だけに絞る。
    "手順1: まず raw_text に、判断の根拠になる行を書き写す" +
    "（店名の行・発行日の行・合計金額の行は必ず。読みにくい・紛らわしいときは" +
    "周辺の行も足してよく、多くても" + lines + "行まで）。" +
    "品目の羅列・住所・電話番号・登録番号は書かない。読めない箇所は ? と書く。\n" +
    "手順2: その書き写しを根拠に、他の項目を埋める。書き写しに無い情報を創作しないこと。\n\n" +
    "各項目のルール:\n" +
    "・date: 発行日を yyyy-MM-dd で。和暦は西暦へ変換（令和N年 = 2018+N。例: 令和6年→2024年、R8→2026年）。" +
    "『2026年7月15日』『26/07/15』『7/15』等の表記に対応。年の記載が無い場合は " + today + " を基準に" +
    "直近の過去日として補う（未来日にしない）。日と月の判別に迷う場合は日本式（月/日）と解釈する。" +
    "利用日と発行日が異なる場合は発行日を採用。\n" +
    "・amount: 実際に支払った税込の合計金額（整数・円）。『合計』『税込合計』『ご請求額』『お会計』『領収金額』を最優先。" +
    "『小計』『税抜』『内消費税』『お預り/預り金』『お釣り/釣銭』『現金』『クレジット』『ポイント利用』『前回残高』は絶対に採用しない。" +
    "割引・値引後の最終支払額を採る。\n" +
    "・vendor: 領収書を発行した店舗・会社の名前（屋号）。判定のヒント: 通常はレシート最上部やロゴ部分、" +
    "または住所・電話番号・インボイス登録番号（T+13桁）が並ぶ発行者情報ブロックの先頭にある。" +
    "次のものは店名ではないので絶対に採用しない: 宛名（『〇〇様』『〇〇御中』『上記正に領収いたしました』の相手先）、" +
    "『領収書』『レシート』『お買上票』等の見出し、住所・電話番号・登録番号そのもの、商品名・品目名、" +
    "『但し書き』の内容、決済会社名（〇〇Pay/カード会社）。支店名や法人格（株式会社等）は含めてよい。\n" +
    "・category: 品目から最適な経費科目を1つ（交通費=切符/IC/タクシー/高速/駐車, 交際費=接待飲食/手土産, " +
    "会議費=打合せ飲食/会議室, 消耗品費=文具/日用品/備品, 通信費=携帯/切手/宅配便, 宿泊費=ホテル/旅館, その他=該当なし）。\n" +
    "・description: 何の支払いかを15文字以内で簡潔に（例: 取引先との会食、事務用品購入）。\n\n" +
    "読み取れない項目は空文字（amount は 0）にし、創作しないこと。"
  );
}

/* ---------------- Gemini のモデル選択と失敗時の案内 ---------------- */

/**
 * 試すモデルの候補。設定値があれば最優先。
 * 個別のバージョン名（gemini-3.6-flash 等）はAPIキーの種類によって
 * 使えたり使えなかったりする（無料枠が無いモデルは 429、廃止済みは 404）ため、
 * **常に現行モデルを指す別名（-latest）を先に試す**。
 */
const GEMINI_FALLBACK_MODELS = [
  "gemini-flash-latest",
  "gemini-3-flash-preview",
  "gemini-flash-lite-latest",
];

function buildModelCandidates_(configured) {
  const out = [];
  [String(configured || "").trim()]
    .concat(GEMINI_FALLBACK_MODELS)
    .forEach(function (m) {
      if (m && out.indexOf(m) < 0) out.push(m);
    });
  return out;
}

/**
 * モデル名の一覧から、文章生成に使えそうなものを優先度順に並べる。
 * 別名（-latest）＞ flash ＞ pro の順。読み上げ・画像生成などの専用モデルは除く。
 */
function pickUsableGeminiModels_(names) {
  const usable = (names || []).filter(function (n) {
    return (
      /flash|pro/.test(n) &&
      !/tts|image|audio|live|embedding|customtools/.test(n)
    );
  });
  const score = function (n) {
    let s = 0;
    if (/-latest$/.test(n)) s -= 100; // モデル名の変更に強い別名を最優先
    if (/flash/.test(n)) s -= 50; // 速くて安い
    if (/lite/.test(n)) s += 10;
    if (/preview/.test(n)) s += 5;
    return s;
  };
  return usable.slice().sort(function (a, b) {
    return score(a) - score(b) || a.localeCompare(b);
  });
}

/**
 * 候補モデルを順に試し、最初に成功した結果を返す。
 *
 * 候補が全滅した場合は、そのAPIキーで **実際に使えるモデル**を取得して追い試しする。
 * モデル名の変更・廃止や、キーの種類による利用可否の違いで全滅しても、
 * 設定を変えずに自動で復旧させるため。
 *
 * @param label   エラー文に出す処理名
 * @param apiKey  Gemini の APIキー
 * @param configured スクリプトプロパティで指定されたモデル（最優先・空可）
 * @param call    model を受け取って結果を返す関数（失敗時は例外）
 * @param passes  候補を何巡するか（混雑時の再挑戦用。既定1）
 */
function tryGeminiModels_(label, apiKey, configured, call, passes) {
  const failures = [];
  const everTried = {};
  const run = function (models, record) {
    const tried = {};
    for (let i = 0; i < models.length; i++) {
      const model = models[i];
      if (!model || tried[model]) continue;
      tried[model] = true;
      everTried[model] = true;
      try {
        return call(model);
      } catch (err) {
        const msg = String((err && err.message) || err);
        if (record) failures.push(model + " → " + msg);
        // APIキー自体が無効なら、どのモデルでも成功しないので即中断
        if (/API_KEY_INVALID|API key not valid|API key expired/i.test(msg)) throw err;
        // 混雑・未提供・権限・クォータは次候補へ。それ以外は本当の異常なので投げる
        if (
          !/HTTP (40[0349]|429|500|503)|UNAVAILABLE|overloaded|high demand|not found|not supported|no longer available|quota|RESOURCE_EXHAUSTED|PERMISSION/i.test(
            msg
          )
        ) {
          throw err;
        }
      }
    }
    return null;
  };

  const candidates = buildModelCandidates_(configured);
  const rounds = Math.max(1, passes || 1);
  for (let pass = 0; pass < rounds; pass++) {
    const out = run(candidates, pass === 0);
    if (out) return out;
    if (pass + 1 < rounds) Utilities.sleep(1500); // 503は一時的な混雑が多い
  }

  // ここまで全滅 → このキーで使えるモデルを調べ、未試行のものを追加で試す
  const usable = listAvailableGeminiModels_(apiKey);
  const extra = pickUsableGeminiModels_(usable).filter(function (m) {
    return !everTried[m];
  });
  const out2 = run(extra.slice(0, 3), true);
  if (out2) return out2;

  throw new Error(buildModelFailureMessage_(label, usable, failures));
}

/**
 * このAPIキーで実際に使えるモデル名を取得する（generateContent 対応のもの）。
 * モデル名の変更・廃止で全滅したときに、設定すべき値をその場で示すために使う。
 */
function listAvailableGeminiModels_(apiKey) {
  try {
    const res = UrlFetchApp.fetch(
      "https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=" +
        encodeURIComponent(apiKey),
      { muteHttpExceptions: true }
    );
    if (res.getResponseCode() !== 200) return [];
    const data = JSON.parse(res.getContentText());
    return (data.models || [])
      .filter(function (m) {
        const methods = m.supportedGenerationMethods || m.supportedActions || [];
        return methods.indexOf("generateContent") >= 0;
      })
      .map(function (m) {
        return String(m.name || "").replace(/^models\//, "");
      })
      .filter(function (n) {
        return n;
      });
  } catch (err) {
    return [];
  }
}

/** 全モデルで失敗したときの案内文（各モデルの失敗理由＋原因別の対処） */
function buildModelFailureMessage_(label, usableModels, failures) {
  const all = failures.join(" / ");
  let msg = label + "に失敗しました。試したモデル: " + all;

  // limit: 0 は「使いすぎ」ではなく「そのリクエストの無料枠の割当が最初から無い」。
  // モデルを変えても解決しないので、課金の有効化か手動登録を案内する。
  if (/limit:\s*0/.test(all)) {
    msg +=
      "\n\n【原因】このAPIキーの無料枠では、このリクエストの割当が 0 です" +
      "（limit: 0）。モデルを変えても解決しません。" +
      "\n【対処】次のいずれかをご検討ください。" +
      "\n・Google Cloud プロジェクトで課金を有効にする（従量課金。少量なら数十円/月程度）" +
      "\n・運賃マスタに区間と片道運賃を手で登録する（AIを使わないので無料・確実）";
  } else if (/429|quota|RESOURCE_EXHAUSTED/i.test(all)) {
    msg +=
      "\n\n【原因】無料枠の上限に達している可能性があります。" +
      "時間をおいて再試行するか、運賃マスタへ手で登録してください。";
  } else {
    const usable = pickUsableGeminiModels_(usableModels);
    if (usable.length) {
      msg +=
        "\nこのAPIキーで使えるモデル: " +
        usable.slice(0, 12).join(", ") +
        "\nスクリプトプロパティにこのいずれかを設定してください。";
    }
  }
  return msg;
}

/**
 * メンテナンス用：エディタから実行すると、このAPIキーで使えるモデルをログに出す。
 * モデル名が変わって解析・照合が失敗したときの確認用（デプロイ不要）。
 */
function showGeminiModels() {
  const apiKey = getProp_("GEMINI_API_KEY");
  if (!apiKey) throw new Error("GEMINI_API_KEY が未設定です");
  const models = listAvailableGeminiModels_(apiKey);
  Logger.log(
    "使えるモデル（%s件）:\n%s",
    models.length,
    models.join("\n") || "(取得できませんでした)"
  );
  return models;
}

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

/**
 * 日付の妥当性チェック。yyyy-MM-dd 以外・実在しない日・未来日・
 * 10年より前は採用しない（誤った日付で埋めるより空にする方が安全）。
 */
function sanitizeReceiptDate_(s) {
  const m = String(s || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return "";
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return "";
  const today = new Date();
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  if (dt >= tomorrow) return ""; // 未来日は誤読
  if (y < today.getFullYear() - 10) return "";
  return m[0];
}

/** 店名として不適切な値（宛名・見出し・番号など）を除外 */
function sanitizeReceiptVendor_(s) {
  let v = String(s || "").trim();
  if (!v) return "";
  if (/(領\s*収\s*書|レシート|お?買上票|明細書|請求書|控え)$/.test(v)) return "";
  if (/(様|御中)\s*$/.test(v)) return ""; // 宛名
  if (/^T\d{6,}/.test(v)) return ""; // インボイス登録番号
  if (/^[\d\s\-()+]+$/.test(v)) return ""; // 電話番号・数字のみ
  if (/^(〒|\d{3}-?\d{4})/.test(v)) return ""; // 住所（郵便番号始まり）
  return v.slice(0, 60);
}

/** 抽出結果を正規化（型・既定値をそろえ、明らかな誤りは空にする） */
function normalizeReceiptFields_(o) {
  o = o || {};
  const cat = RECEIPT_CATEGORIES.indexOf(o.category) >= 0 ? o.category : "その他";
  return {
    date: sanitizeReceiptDate_(o.date),
    amount: Math.max(0, Math.round(Number(o.amount) || 0)),
    vendor: sanitizeReceiptVendor_(o.vendor),
    category: cat,
    description: String(o.description || "").slice(0, 60),
    rawText: String(o.raw_text || o.rawText || ""),
  };
}

/**
 * レシート解析（AI）。プロバイダはサーバー設定で選択する。
 *
 * AI呼び出しは1リクエストにつき最大2回。1回目は速度寄りの行数で読み、
 * 金額か日付が取れなかったときだけ、行数を増やして読み直す（needsEscalation_）。
 */
function actionAnalyzeReceipt_(body) {
  requireUser_(body.token, false);
  if (!body.imageBase64) throw new Error("画像がありません");
  const provider = resolveOcrProvider_();
  if (!provider) {
    throw new Error("AI解析は未設定です（GEMINI_API_KEY または ANTHROPIC_API_KEY を設定してください）");
  }
  const analyze = function (opts) {
    const o = opts || {};
    return o.provider === "claude" || (!o.provider && provider === "claude")
      ? analyzeWithClaude_(body, o)
      : analyzeWithGemini_(body, o);
  };

  let out = analyze({ lines: RECEIPT_RAW_TEXT_MAX_LINES });
  let fields = out.fields || out;
  let escalated = false;

  // 1回目で必須項目（金額・日付）が取れなかったときだけ、丁寧な設定で読み直す。
  // 読み直し先が設定されていればそちらへ回す（上位モデルなど）。未設定なら
  // 同じプロバイダで行数だけ増やして読み直すので、追加の課金は発生しない。
  if (needsEscalation_(fields)) {
    try {
      const esc = resolveEscalation_();
      const out2 = analyze({
        lines: RECEIPT_RAW_TEXT_RETRY_LINES,
        provider: esc.provider,
        model: esc.model,
      });
      const f2 = out2.fields || out2;
      if (f2 && (f2.amount || f2.date)) {
        out = out2;
        fields = f2;
        escalated = true;
      }
    } catch (err) {
      // 読み直しに失敗しても、1回目の結果で処理を続ける（申請は進められる）
    }
  }

  return {
    ok: true,
    fields: fields,
    provider: provider,
    model: out.model || "",
    escalated: escalated,
  };
}

/**
 * 1回目の読み取りで「申請に必要な項目」が欠けているか。
 * 金額と日付は申請の必須項目なので、どちらかが空なら読めていないとみなす。
 */
function needsEscalation_(fields) {
  if (!fields) return true;
  return !(Math.round(Number(fields.amount) || 0) > 0) || !String(fields.date || "");
}

/**
 * 読み直し先の設定。`OCR_ESCALATE_PROVIDER` が未設定なら空を返し、
 * 呼び出し側は同じプロバイダのまま行数だけ増やして読み直す（追加課金なし）。
 * 指定されていてもそのプロバイダのキーが無ければ、同じく空として扱う。
 */
function resolveEscalation_() {
  const provider = String(getProp_("OCR_ESCALATE_PROVIDER") || "").toLowerCase();
  const ok =
    (provider === "claude" && !!getProp_("ANTHROPIC_API_KEY")) ||
    (provider === "gemini" && !!getProp_("GEMINI_API_KEY"));
  if (!ok) return { provider: "", model: "" };
  return { provider: provider, model: String(getProp_("OCR_ESCALATE_MODEL") || "").trim() };
}

/**
 * Gemini（無料枠可）で解析。GEMINI_MODEL 未指定なら現行モデルを順に試す。
 * モデル未提供・クォータ超過（404/403/429）の場合は次の候補へフォールバックし、
 * 全滅した場合はこのキーで使えるモデルを調べて追い試ししてから、
 * 全モデルの失敗理由と使えるモデル一覧をまとめて投げる（＝原因が画面に出る）。
 */
function analyzeWithGemini_(body, opts) {
  const o = opts || {};
  // 1巡目で全滅した場合は少し待って再挑戦（503は一時的な混雑が多い）
  return tryGeminiModels_(
    "AI解析",
    getProp_("GEMINI_API_KEY"),
    o.model || getProp_("GEMINI_MODEL"),
    function (model) {
      return callGemini_(body, model, o.lines);
    },
    2
  );
}

function callGemini_(body, model, maxLines) {
  const apiKey = getProp_("GEMINI_API_KEY");
  // raw_text を先に書き起こさせることで抽出の根拠を作り、精度を上げる
  const schema = {
    type: "OBJECT",
    properties: {
      raw_text: { type: "STRING" },
      date: { type: "STRING" },
      amount: { type: "INTEGER" },
      vendor: { type: "STRING" },
      category: { type: "STRING", enum: RECEIPT_CATEGORIES },
      description: { type: "STRING" },
    },
    // プロパティ順（＝生成順）を明示。raw_text を最初に生成させる
    propertyOrdering: [
      "raw_text", "date", "amount", "vendor", "category", "description",
    ],
    required: ["raw_text", "date", "amount", "vendor", "category", "description"],
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
          { text: buildReceiptPrompt_(maxLines) },
        ],
      },
    ],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: schema,
      temperature: 0,
      maxOutputTokens: 1200, // 出力を絞って生成時間を短縮
    },
  };
  // 思考時間の短縮（レシート読み取りは推論より知覚のタスク）。
  // 3.x 系は thinkingLevel、2.5 系は thinkingConfig.thinkingBudget=0 で無効化。
  const level = String(getProp_("GEMINI_THINKING") || "low").toLowerCase();
  if (level !== "default") {
    if (/gemini-3/.test(model)) {
      payload.generationConfig.thinkingLevel = level; // minimal | low | medium | high
    } else if (/gemini-2\.5/.test(model)) {
      payload.generationConfig.thinkingConfig = { thinkingBudget: 0 };
    }
  }
  const url =
    "https://generativelanguage.googleapis.com/v1beta/models/" +
    encodeURIComponent(model) +
    ":generateContent?key=" +
    encodeURIComponent(apiKey);
  const fetchOnce = function (p) {
    return UrlFetchApp.fetch(url, {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify(p),
      muteHttpExceptions: true,
    });
  };

  let res = fetchOnce(payload);
  let code = res.getResponseCode();
  let body2 = res.getContentText();
  // 思考制御フィールド非対応モデルは 400 になるため、その場合は外して1回だけ再試行
  if (code === 400 && /thinking/i.test(body2)) {
    delete payload.generationConfig.thinkingLevel;
    delete payload.generationConfig.thinkingConfig;
    res = fetchOnce(payload);
    code = res.getResponseCode();
    body2 = res.getContentText();
  }

  let data;
  try {
    data = JSON.parse(body2);
  } catch (err) {
    throw new Error("Gemini解析の応答を読み取れませんでした（HTTP " + code + "）");
  }
  if (code !== 200) {
    const msg = data && data.error && data.error.message ? data.error.message : "HTTP " + code;
    throw new Error("Gemini解析エラー(" + model + " / HTTP " + code + "): " + msg);
  }
  const cand = (data.candidates || [])[0];
  if (!cand || !cand.content) throw new Error("Gemini解析が応答を返しませんでした（" + model + "）");
  let text = "";
  (cand.content.parts || []).forEach(function (p) {
    if (p.text) text += p.text;
  });
  return { fields: normalizeReceiptFields_(JSON.parse(text)), model: model };
}

/** Claude で解析。モデルは OCR_MODEL で変更可（既定 claude-opus-4-8） */
function analyzeWithClaude_(body, opts) {
  const o = opts || {};
  const apiKey = getProp_("ANTHROPIC_API_KEY");
  const model = o.model || getProp_("OCR_MODEL") || "claude-opus-5";
  const schema = {
    type: "object",
    properties: {
      raw_text: { type: "string" },
      date: { type: "string" },
      amount: { type: "integer" },
      vendor: { type: "string" },
      category: { type: "string", enum: RECEIPT_CATEGORIES },
      description: { type: "string" },
    },
    required: ["raw_text", "date", "amount", "vendor", "category", "description"],
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
          { type: "text", text: buildReceiptPrompt_(o.lines) },
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
  return {
    fields: normalizeReceiptFields_(JSON.parse(text)),
    model: String(data.model || model),
  };
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
