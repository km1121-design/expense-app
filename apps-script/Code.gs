/**
 * 経費申請アプリ バックエンド（Google Apps Script Web App）
 *
 * 役割:
 *   - スプレッドシートを経費データ／ユーザー／AI解析の学習ログのデータベースとして使用
 *     （タブ名・1行目の見出しは日本語。内部キー・JSON APIのキー名は英語で固定）
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
 *   GEMINI_API_KEY    : 設定するとレシートのAI解析（Gemini vision・無料枠可）と
 *                       交通費の運賃Web照合（Google検索グラウンディング）が有効
 *   FARE_MODEL        : 運賃照合に使うモデル（未設定なら現行の flash 系を順に試す）
 *   GEMINI_MODEL      : Geminiのモデル（未設定なら現行の flash 系を順に試す）
 *   ANTHROPIC_API_KEY : 設定するとレシートのAI解析（Claude vision）が有効
 *   OCR_MODEL         : Claudeのモデル（既定: claude-opus-4-8。安価なら claude-haiku-4-5）
 *   OCR_PROVIDER      : 併用時の優先プロバイダ "gemini"/"claude"（未指定なら gemini 優先）
 *
 * 認証モード:
 *   users シートが空の間は「オープンモード」（認証なし・従来互換）。
 *   最初の管理者を action=setup で作成すると認証が有効になる。
 */

/**
 * シートの列定義。[内部キー, シート1行目に表示する見出し] の順で列順そのものを表す。
 * 内部キーは JSON API・CSV・フロントエンドが使う名前なので変更しない。
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
  // 交通費の運賃照合（電車賃。区間と回数から想定額を出して申請額と突き合わせる）
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

/**
 * 区間運賃マスタ。一度Webで照合した区間の運賃を蓄積し、
 * 次回以降は検索せずに即照合する（結果がぶれず、検索の課金も発生しない）。
 * 運賃改定やAIの誤りは管理者が上書き・削除して直せる。
 */
const FARES_SHEET = "運賃マスタ";
const FARE_COLUMNS = [
  ["key", "区間キー"],
  ["from", "出発駅"],
  ["to", "到着駅"],
  ["fare", "片道運賃"],
  ["route", "経路"],
  ["source", "出典URL"],
  ["checkedAt", "照合日時"],
  ["checkedBy", "照合方法"],
];
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
 * AI解析の学習ログ（店舗ごとの手修正の履歴）。
 * 申請保存時に「AIの読み取り結果」と「利用者が確定した値」を1行ずつ記録し、
 * 次回以降の解析で ①辞書補正 ②誤読事例のフィードバック に再利用する。
 */
const CORRECTIONS_SHEET = "AI学習ログ";
const CORRECTIONS_SHEET_LEGACY = "corrections";
const CORRECTION_COLUMNS = [
  ["createdAt", "記録日時"],
  ["vendorKey", "店舗キー"],
  ["aiVendorKey", "店舗キー（AI読取）"],
  ["vendor", "店名（確定）"],
  ["date", "利用日（確定）"],
  ["amount", "金額（確定）"],
  ["category", "科目（確定）"],
  ["description", "摘要（確定）"],
  ["aiVendor", "店名（AI読取）"],
  ["aiDate", "利用日（AI読取）"],
  ["aiAmount", "金額（AI読取）"],
  ["aiCategory", "科目（AI読取）"],
  ["aiDescription", "摘要（AI読取）"],
  ["corrected", "修正された項目"],
  ["applicantId", "申請者ID"],
  ["rawHead", "書き起こし（先頭）"],
];
const CORRECTION_HEADERS = CORRECTION_COLUMNS.map(function (c) {
  return c[0];
});

/** 学習に使う直近の履歴件数（履歴が育っても解析の所要時間を一定に保つ） */
const CORRECTION_LOOKBACK = 600;
/** プロンプトへ添付する誤読事例の最大件数 */
const CORRECTION_HINT_MAX = 3;
/** 摘要を自動補正するのに必要な最低一致回数（1回だけの摘要は使い回さない） */
const DESCRIPTION_MIN_HITS = 2;
/**
 * レシートの書き起こし（raw_text）に許す行数の上限。
 * AI解析の応答時間は出力の長さでほぼ決まるため、根拠として必要な最小限に絞る。
 * 読み取り精度が落ちるようなら増やす（増やすほど解析は遅くなる）。
 */
const RECEIPT_RAW_TEXT_MAX_LINES = 6;

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

function getCorrectionsSheet_() {
  return ensureSheet_(
    CORRECTIONS_SHEET,
    CORRECTION_COLUMNS,
    CORRECTIONS_SHEET_LEGACY
  );
}

function getFaresSheet_() {
  return ensureSheet_(FARES_SHEET, FARE_COLUMNS);
}

/**
 * シート名・見出しの定義の版。ここを変えると次のリクエストで全シートを移行する。
 */
const SCHEMA_VERSION = "2026-08-ja-2";

/**
 * 全シートのタブ名と見出しを現在の定義に揃える。
 *
 * 各シートは使われたときにしか ensureSheet_ を通らないため、たとえば
 * AI学習ログ（旧 corrections）は「AI解析を使った申請」が発生するまで
 * 日本語化されない。それを避けるため、版が変わったときだけ全シートを
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
  getCorrectionsSheet_();
  getFaresSheet_();
  // PL連携用のシートは、連携を有効にしたときだけ作る（使わない人には出さない）
  if (isPlSyncEnabled_()) {
    getPlMappingSheet_();
    getPlSkippedSheet_();
  }
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

/**
 * 指定した内部キーの列だけを見て、値が一致する行番号を返す（無ければ -1）。
 * シート全体を読み込まずに済むよう、対象の1列だけを取得する。
 */
function findRowByColumn_(sheet, key, value, columns) {
  const last = sheet.getLastRow();
  if (last < 2) return -1;
  const head = headerKeys_(
    sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0],
    columns || EXPENSE_COLUMNS
  );
  const col = head.indexOf(key);
  if (col < 0) return -1;
  const values = sheet.getRange(2, col + 1, last - 1, 1).getValues();
  const target = String(value);
  for (let i = 0; i < values.length; i++) {
    if (String(values[i][0]) === target) return i + 2;
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
function recordsForUser_(u) {
  const records = rowsToRecords_(getSheet_());
  if (u.legacy || u.role === "admin") return records;
  return records.filter(function (r) {
    return String(r.applicantId) === u.username;
  });
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
    autoApprove: isAutoApprove_(),
    aiOcr: !!resolveOcrProvider_(),
    version: SCHEMA_VERSION,
    features: {
      fare: true, // 交通費の運賃照合
      fareWeb: isFareWebEnabled_(), // 運賃のWeb照合が使える設定か
      receiptImage: true, // 領収書画像のアプリ経由取得
      vendorMemory: true, // AI解析の学習
      jaSheets: true, // シートの日本語化
      bootstrap: true, // 起動を1往復にまとめられるか
      plSync: isPlSyncEnabled_(), // PL管理モデルへの連携（プロパティ1回の読み取り）
    },
  };
}

/**
 * 起動用。`status` `me` 一覧取得の3往復を1往復にまとめる。
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
  out.records = recordsForUser_(u);
  // PLへ反映できなかった申請の件数。管理者にだけ知らせれば足りるので、
  // 一般ユーザーの起動ではスキップ記録のシートを読まない。
  if (u.role === "admin" && isPlSyncEnabled_()) {
    try {
      out.plSkipped = countPlSkipped_();
    } catch (err) {
      // 件数が取れなくても起動は成立させる
    }
  }
  return out;
}

/** POST: 認証・申請の作成・更新・削除・ユーザー管理 */
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
      case "setup":
        return json_(actionSetup_(body));
      case "login":
        return json_(actionLogin_(body));
      // ---- 認証（トークン必要） ----
      case "me": {
        const u = requireUser_(body.token, false);
        return json_({
          ok: true,
          user: {
            username: u.username,
            displayName: u.displayName,
            role: u.role,
            department: String(u.department || ""), // requireUser_ が読み取り済み
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
      // ---- 交通費の運賃照合（電車賃） ----
      case "lookupFare":
        return json_(actionLookupFare_(body));
      case "listFares":
        return json_(actionListFares_(body));
      case "upsertFare":
        return json_(actionUpsertFare_(body));
      case "bulkUpsertFares":
        return json_(actionBulkUpsertFares_(body));
      case "deleteFare":
        return json_(actionDeleteFare_(body));
      // ---- 領収書画像（Driveの閲覧権限が無い利用者向け） ----
      case "receiptImage":
        return json_(actionReceiptImage_(body));
      // ---- AIレシート解析 ----
      case "analyzeReceipt":
        return json_(actionAnalyzeReceipt_(body));
      // ---- AI解析の学習データ（店舗別の補正記憶） ----
      case "listVendorMemory":
        return json_(actionListVendorMemory_(body));
      case "deleteVendorMemory":
        return json_(actionDeleteVendorMemory_(body));
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
      // ---- PL管理モデルへの連携 ----
      case "syncPl": {
        requireUser_(body.token, true); // 管理者のみ
        if (!isPlSyncEnabled_()) {
          return json_({ ok: false, error: "PL連携が未設定です（PL_SPREADSHEET_ID）" });
        }
        return json_({ ok: true, message: syncAllToPl(), skipped: countPlSkipped_() });
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
  if (!user.legacy && !department) department = String(user.department || "");

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
  // 交通費の運賃照合。片道運賃は運賃マスタ（サーバー側の正）から取り直して
  // 想定金額を計算するため、クライアントから送られた金額は信用しない。
  // 未登録の区間は、この申請額から運賃マスタへ登録する（誰が入れたか残す）。
  const fare = resolveFareForRecord_(record, Number(record.amount) || 0, applicant);

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
    fareFrom: fare.from,
    fareTo: fare.to,
    fareRound: fare.from ? fare.round : "",
    fareTrips: fare.from ? fare.trips : "",
    fareUnit: fare.unit || "",
    fareExpected: fare.expected || "",
    fareCheck: fare.check,
  };
  sheet.appendRow(
    HEADERS.map(function (h) {
      return rec[h];
    })
  );
  // AI解析を使った申請は「AIの読み取り」と「確定値」の差分を学習ログへ残す。
  // 学習ログの失敗で申請そのものを落とさないよう、例外は握りつぶす。
  if (record.ai) {
    try {
      logCorrection_(rec, record.ai, applicantId);
    } catch (err) {
      // noop
    }
  }
  // PL管理モデルへの連携（承認済みのみ反映。無効なら何もしない）
  safeSyncExpenseToPl_(rec);
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
  // 承認・却下・金額修正をPLへ反映する（却下・差戻しならPLから取り下げる）。
  // 連携が無効なら読み取りも起きないよう、判定を先に済ませる。
  if (isPlSyncEnabled_()) safeSyncExpenseToPl_(recordAtRow_(sheet, row));
  return { ok: true };
}

/** 指定行を1件のレコードとして読む（更新後の値をPLへ渡すために使う）。 */
function recordAtRow_(sheet, row) {
  const width = sheet.getLastColumn();
  const head = headerKeys_(
    sheet.getRange(1, 1, 1, width).getValues()[0],
    EXPENSE_COLUMNS
  );
  const values = sheet.getRange(row, 1, 1, width).getValues()[0];
  const rec = {};
  head.forEach(function (h, j) {
    rec[h] = normalizeValue_(h, values[j]);
  });
  rec.amount = Number(rec.amount) || 0;
  return rec;
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
  safeRemoveFromPl_(id); // PLに載っていれば取り下げる
  return { ok: true };
}

/* ==================== 交通費の運賃照合（電車賃） ==================== */

/** 1回の申請で認める回数の上限（打ち間違いで巨額にならないように） */
const FARE_TRIPS_MAX = 60;

/**
 * 申請から運賃マスタへ自動登録するときに認める片道運賃の上限。
 * 桁を打ち間違えた申請がそのままマスタになると、以降の申請が誤った金額で
 * 「一致」と判定されてしまうため、明らかに運賃ではない額は登録しない。
 */
const FARE_UNIT_MAX = 100000;

/** 駅名の照合キー。表記ゆれ（全半角・空白・「駅」の有無）を吸収する */
function stationKey_(s) {
  let v = String(s || "").trim();
  if (!v) return "";
  try {
    v = v.normalize("NFKC");
  } catch (err) {
    // 旧ランタイム互換
  }
  v = v.replace(/[\s　()（）]/g, "");
  v = v.replace(/駅$/, "");
  return v.toLowerCase().slice(0, 24);
}

/**
 * 区間キー。上りと下りで運賃は同じなので、2駅を並べ替えて同一視する。
 * これにより「A→B」で調べた運賃を「B→A」の申請にも使える。
 */
function fareKey_(from, to) {
  const a = stationKey_(from);
  const b = stationKey_(to);
  if (!a || !b || a === b) return "";
  return a < b ? a + "|" + b : b + "|" + a;
}

/** 運賃マスタを全件読む（件数は区間数なので多くならない） */
function readFares_() {
  const sheet = getFaresSheet_();
  const last = sheet.getLastRow();
  if (last < 2) return [];
  const values = sheet
    .getRange(2, 1, last - 1, FARE_COLUMNS.length)
    .getValues();
  const out = [];
  values.forEach(function (row, i) {
    if (!row[0]) return;
    const r = { _row: i + 2 };
    FARE_COLUMNS.forEach(function (c, j) {
      r[c[0]] = row[j];
    });
    r.fare = Math.max(0, Math.round(Number(r.fare) || 0));
    out.push(r);
  });
  return out;
}

/** 区間キーで運賃マスタを引く */
function findFare_(key) {
  if (!key) return null;
  const rows = readFares_();
  for (let i = 0; i < rows.length; i++) {
    if (String(rows[i].key) === key) return rows[i];
  }
  return null;
}

/** 運賃マスタの1行分（定義順） */
function fareRow_(rec) {
  return FARE_COLUMNS.map(function (c) {
    return rec[c[0]] == null ? "" : rec[c[0]];
  });
}

/** 運賃マスタへ登録（同じ区間があれば上書き） */
function saveFare_(rec) {
  const existing = findFare_(rec.key);
  if (existing) {
    getFaresSheet_()
      .getRange(existing._row, 1, 1, FARE_COLUMNS.length)
      .setValues([fareRow_(rec)]);
  } else {
    appendFare_(rec);
  }
}

/**
 * 未登録と分かっている区間を追記する。
 * 呼び出し側が既に findFare_ で不在を確認している場合に使い、
 * 運賃マスタを2度読まないようにする。
 */
function appendFare_(rec) {
  getFaresSheet_().appendRow(fareRow_(rec));
}

/**
 * 運賃のWeb照合（Gemini＋Google検索）を使うか。**既定は無効**。
 *
 * Google検索グラウンディングは Gemini API の無料枠では割当が0（limit: 0）で
 * 使えない。既定を有効にすると必ず一度失敗してから自動停止することになるため、
 * 使える環境でだけ明示的に有効化する形にしている。
 *
 * 有効にするには、スクリプトプロパティ `FARE_WEB_LOOKUP` に `"true"` を設定する
 * （課金を有効にした場合）。失敗を検知したときは "false" が保存される。
 */
function isFareWebEnabled_() {
  return getProp_("FARE_WEB_LOOKUP") === "true";
}

/**
 * 運賃マスタに未登録の区間を返す（エラーにしない）。
 * 申請自体は金額を手入力すれば進められるため、次の行動を伝えるだけにする。
 */
function unregisteredFare_(from, to, round, trips, justDisabled) {
  return {
    ok: true,
    registered: false,
    webDisabled: !isFareWebEnabled_(),
    justDisabled: !!justDisabled,
    from: from,
    to: to,
    round: round,
    trips: trips,
    unit: 0,
    expected: 0,
    route: "",
    source: "",
    message:
      "この区間は運賃マスタに未登録です。「🚉 路線検索で調べる」で運賃を確認して" +
      "金額を入力してください。この申請の金額から運賃マスタへ登録されるので、" +
      "次回からは自動で照合されます。" +
      (justDisabled
        ? "（無料枠ではWeb検索による照合が使えないため、以降はマスタのみで照合します）"
        : ""),
  };
}

/** 回数・往復から想定金額を組み立てる */
function fareTotal_(unit, round, trips) {
  const u = Math.max(0, Math.round(Number(unit) || 0));
  const n = Math.min(FARE_TRIPS_MAX, Math.max(1, Math.round(Number(trips) || 1)));
  return u * (round ? 2 : 1) * n;
}

/**
 * 区間の運賃を照合する。
 * 1. 運賃マスタにあればそれを使う（Web検索なし・即時・結果が一定）
 * 2. 無ければ Gemini の Google 検索グラウンディングで調べ、マスタへ登録する
 * 想定金額 = 片道運賃 × (往復なら2) × 回数。申請額との比較は呼び出し側で行う。
 */
function actionLookupFare_(body) {
  requireUser_(body.token, false);
  const from = String(body.from || "").trim();
  const to = String(body.to || "").trim();
  const key = fareKey_(from, to);
  if (!key) throw new Error("出発駅と到着駅を（別々の駅名で）入力してください");
  const round = !!body.round;
  const trips = Math.min(
    FARE_TRIPS_MAX,
    Math.max(1, Math.round(Number(body.trips) || 1))
  );

  let hit = findFare_(key);
  const cached = !!hit;
  if (!hit) {
    // Web照合を使わない運用（運賃マスタのみ）では、未登録をそのまま返す。
    // 申請者は路線検索で調べて金額を手入力し、管理者が区間を登録すれば
    // 次回から自動で照合される。
    if (!isFareWebEnabled_()) {
      return unregisteredFare_(from, to, round, trips, false);
    }
    let found;
    try {
      found = searchFareOnWeb_(from, to);
    } catch (err) {
      // limit: 0 は無料枠にそのリクエストの割当が無い状態。何度試しても同じなので、
      // 以降はWeb照合を止めて運賃マスタのみの運用に切り替える。
      if (/limit:\s*0/.test(String((err && err.message) || err))) {
        PropertiesService.getScriptProperties().setProperty(
          "FARE_WEB_LOOKUP",
          "false"
        );
        return unregisteredFare_(from, to, round, trips, true);
      }
      throw err;
    }
    hit = {
      key: key,
      from: from,
      to: to,
      fare: found.fare,
      route: found.route,
      source: found.source,
      checkedAt: new Date().toISOString(),
      // 出典が取れなかった＝Google検索が使われず、AIの記憶で答えた可能性がある。
      // 運賃マスタに残るので、後から確認・訂正できるよう印を付けておく。
      checkedBy: found.source ? "web" : "web（出典なし・要確認）",
    };
    saveFare_(hit);
  }
  return {
    ok: true,
    registered: true,
    cached: cached,
    from: String(hit.from || from),
    to: String(hit.to || to),
    unit: hit.fare,
    round: round,
    trips: trips,
    expected: fareTotal_(hit.fare, round, trips),
    route: String(hit.route || ""),
    source: String(hit.source || ""),
    checkedBy: String(hit.checkedBy || ""),
  };
}

/**
 * Gemini の Google 検索グラウンディングで片道運賃を調べる。
 * 構造化出力（responseSchema）は検索ツールと併用できないため、
 * JSONで答えるよう指示し、本文から取り出す。出典は groundingMetadata から拾う。
 */
function searchFareOnWeb_(from, to) {
  const apiKey = getProp_("GEMINI_API_KEY");
  if (!apiKey) {
    throw new Error(
      "運賃のWeb照合には GEMINI_API_KEY の設定が必要です（管理者に設定を依頼してください）"
    );
  }
  const prompt =
    "日本の鉄道運賃を調べてください。\n" +
    "区間: 「" + from + "」から「" + to + "」\n\n" +
    "検索して、次の条件の運賃を答えてください:\n" +
    "・大人1名の通常運賃（定期券・往復割引なし）\n" +
    "・ICカード利用時の片道運賃（IC運賃が無い場合は切符運賃）\n" +
    "・最も一般的・最短で案内される経路（乗換を含んでよい）\n\n" +
    "回答は次のJSONのみを出力してください（前後に説明を書かない）:\n" +
    '{"fare": 片道運賃の整数（円）, "route": "経路（例: 西武新宿線→JR埼京線 池袋乗換）", ' +
    '"note": "補足（乗換や運賃の種別など30文字以内）"}\n\n' +
    "運賃が確認できない場合は fare を 0 にしてください。推測で数字を書かないこと。";

  // モデル未提供・混雑時は次の候補へ。Web アプリの応答時間に収めるため
  // 思考は最小にする（運賃の照合は推論よりも検索結果の読み取りが主）。
  const cand = tryGeminiModels_(
    "運賃照合",
    apiKey,
    getProp_("FARE_MODEL"),
    function (model) {
      return callFareSearch_(apiKey, model, prompt);
    }
  );

  let out = "";
  (cand.content.parts || []).forEach(function (p) {
    if (p.text) out += p.text;
  });

  const parsed = parseJsonLoosely_(out);
  const fare = Math.max(0, Math.round(Number(parsed && parsed.fare) || 0));
  if (!fare) {
    throw new Error(
      "運賃を確認できませんでした。駅名を正式名称で入力するか、金額を手入力してください。"
    );
  }
  let route = String((parsed && parsed.route) || "").slice(0, 80);
  const note = String((parsed && parsed.note) || "").slice(0, 40);
  if (note) route = route ? route + "（" + note + "）" : note;
  return { fare: fare, route: route, source: groundingSource_(cand) };
}

/**
 * Gemini を1回呼び、候補（candidate）を返す。
 * Google 検索グラウンディングは thinkingLevel / responseSchema と併用できない構成が
 * あるため、400 のときは該当フィールドを外して1回だけ再試行する。
 */
function callFareSearch_(apiKey, model, prompt) {
  const url =
    "https://generativelanguage.googleapis.com/v1beta/models/" +
    encodeURIComponent(model) +
    ":generateContent?key=" +
    encodeURIComponent(apiKey);
  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
    tools: [{ google_search: {} }],
    generationConfig: { temperature: 0, maxOutputTokens: 900 },
  };
  // 応答時間を短縮（Webアプリのタイムアウトで画面がHTMLエラーになるのを避ける）
  if (/gemini-3/.test(model)) {
    payload.generationConfig.thinkingLevel = "minimal";
  } else if (/gemini-2\.5/.test(model)) {
    payload.generationConfig.thinkingConfig = { thinkingBudget: 0 };
  }

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
  let text = res.getContentText();
  // 思考制御・検索ツール非対応の構成では 400 になるため、外して一度だけ再試行
  if (code === 400 && /thinking|tool|search/i.test(text)) {
    delete payload.generationConfig.thinkingLevel;
    delete payload.generationConfig.thinkingConfig;
    if (/tool|search/i.test(text)) delete payload.tools;
    res = fetchOnce(payload);
    code = res.getResponseCode();
    text = res.getContentText();
  }
  // 無料枠では Google 検索を伴うリクエストの割当が 0 のことがある（429 / limit: 0）。
  // その場合は検索なしで一度だけ試す。出典が付かないため画面には
  // 「出典が取れていない＝要確認」の警告が出て、運賃マスタにも印が残る。
  if ((code === 429 || code === 403) && payload.tools) {
    delete payload.tools;
    res = fetchOnce(payload);
    code = res.getResponseCode();
    text = res.getContentText();
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error("運賃照合の応答を読み取れませんでした（HTTP " + code + "）");
  }
  if (code !== 200) {
    const msg =
      data && data.error && data.error.message ? data.error.message : "HTTP " + code;
    throw new Error("運賃照合エラー(" + model + " / HTTP " + code + "): " + msg);
  }
  const cand = (data.candidates || [])[0];
  if (!cand || !cand.content) {
    throw new Error("運賃照合が応答を返しませんでした（" + model + "）");
  }
  return cand;
}

/** ```json フェンスや前後の説明が付いていても JSON を取り出す */
function parseJsonLoosely_(text) {
  const s = String(text || "");
  try {
    return JSON.parse(s);
  } catch (err) {
    // 続けて本文中のオブジェクトを探す
  }
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch (err) {
    return null;
  }
}

/** グラウンディング（検索）で参照されたURLを1つ返す。無ければ空文字 */
function groundingSource_(cand) {
  const meta = cand.groundingMetadata || cand.grounding_metadata;
  const chunks = (meta && (meta.groundingChunks || meta.grounding_chunks)) || [];
  for (let i = 0; i < chunks.length; i++) {
    const web = chunks[i].web || chunks[i].Web;
    if (web && web.uri) return String(web.uri).slice(0, 400);
  }
  return "";
}

/**
 * 申請額から片道運賃を割り戻す。運賃マスタへ登録してよい額のときだけ返し、
 * 登録すべきでないときは 0 を返す。
 *
 * 往復・回数で割り切れない金額は、申請額に運賃以外（特急券など）が混ざって
 * いるか、区間か回数の入力が実態と合っていない。そのまま割ると端数の分だけ
 * 誤った運賃がマスタに残るため、登録しない。
 */
function fareUnitFromAmount_(amount, round, trips) {
  const total = Math.round(Number(amount) || 0);
  if (total <= 0) return 0;
  const n = Math.min(FARE_TRIPS_MAX, Math.max(1, Math.round(Number(trips) || 1)));
  const divisor = (round ? 2 : 1) * n;
  if (total % divisor !== 0) return 0;
  const unit = total / divisor;
  if (unit <= 0 || unit > FARE_UNIT_MAX) return 0;
  return unit;
}

/**
 * 申請に付いてきた区間から、保存する運賃照合の内容を決める。
 * 片道運賃は運賃マスタから取り直すため、申請者側で書き換えられない。
 *
 * マスタに無い区間は、申請額から片道運賃を割り戻してマスタへ登録する。
 * 運用しながら区間が貯まっていくようにするためで、以降の同じ区間の申請は
 * 自動で照合できる。ただし登録の元になった申請そのものは「一致」にしない
 * （自分の申請額で自分を照合しても確認したことにならない）。マスタ側には
 * 「申請（申請者名）」と記録されるので、管理者が後から確認・訂正できる。
 *   match      : 申請額 = 想定金額
 *   diff       : 申請額 ≠ 想定金額（管理者が確認する）
 *   registered : この申請額から運賃マスタへ登録した（まだ誰も確認していない）
 *   unchecked  : 区間はあるが、マスタにも無く申請額からも割り出せない
 *   ""         : 区間の指定なし（交通費以外など）
 */
function resolveFareForRecord_(record, amount, applicant) {
  const from = String((record && record.fareFrom) || "").trim();
  const to = String((record && record.fareTo) || "").trim();
  const key = fareKey_(from, to);
  if (!key) return { from: "", to: "", round: false, trips: 0, unit: 0, expected: 0, check: "" };
  const round = !!(record && record.fareRound);
  const trips = Math.min(
    FARE_TRIPS_MAX,
    Math.max(1, Math.round(Number(record && record.fareTrips) || 1))
  );
  const hit = findFare_(key);
  if (!hit || !hit.fare) {
    const unit = fareUnitFromAmount_(amount, round, trips);
    if (!unit) {
      return { from: from, to: to, round: round, trips: trips, unit: 0, expected: 0, check: "unchecked" };
    }
    // マスタへの登録に失敗しても申請そのものは通す（申請を落とさない）。
    // 未登録は上の findFare_ で確認済みなので、追記だけ行う（マスタを2度読まない）。
    try {
      appendFare_({
        key: key,
        from: from,
        to: to,
        fare: unit,
        route: "",
        source: "",
        checkedAt: new Date().toISOString(),
        checkedBy: "申請（" + (applicant || "不明") + "）",
      });
    } catch (err) {
      return { from: from, to: to, round: round, trips: trips, unit: 0, expected: 0, check: "unchecked" };
    }
    return {
      from: from,
      to: to,
      round: round,
      trips: trips,
      unit: unit,
      expected: fareTotal_(unit, round, trips),
      check: "registered",
    };
  }
  const expected = fareTotal_(hit.fare, round, trips);
  return {
    from: from,
    to: to,
    round: round,
    trips: trips,
    unit: hit.fare,
    expected: expected,
    check: expected === Math.round(amount) ? "match" : "diff",
  };
}

/** 管理者向け: 運賃マスタの一覧 */
function actionListFares_(body) {
  requireUser_(body.token, true);
  const items = readFares_().map(function (r) {
    return {
      key: String(r.key),
      from: String(r.from || ""),
      to: String(r.to || ""),
      fare: r.fare,
      route: String(r.route || ""),
      source: String(r.source || ""),
      checkedAt: correctionDate_(r.checkedAt) || String(r.checkedAt || ""),
      checkedBy: String(r.checkedBy || ""),
    };
  });
  items.sort(function (a, b) {
    return (a.from + a.to).localeCompare(b.from + b.to, "ja");
  });
  return { ok: true, items: items };
}

/** 管理者向け: 運賃の手修正・手動登録（運賃改定やAIの誤りを直す） */
function actionUpsertFare_(body) {
  const u = requireUser_(body.token, true);
  const from = String(body.from || "").trim();
  const to = String(body.to || "").trim();
  const key = fareKey_(from, to);
  if (!key) throw new Error("出発駅と到着駅を（別々の駅名で）入力してください");
  const fare = Math.round(Number(body.fare) || 0);
  if (fare <= 0) throw new Error("片道運賃は1円以上で入力してください");
  const existing = findFare_(key);
  saveFare_({
    key: key,
    from: from,
    to: to,
    fare: fare,
    route: String(body.route || (existing && existing.route) || ""),
    source: String(body.source || (existing && existing.source) || ""),
    checkedAt: new Date().toISOString(),
    checkedBy: "手動（" + (u.displayName || u.username || "管理者") + "）",
  });
  return { ok: true, items: actionListFares_(body).items };
}

/**
 * 管理者向け: 区間をまとめて登録する（初期設定を一気に済ませるため）。
 * 1行に「出発駅, 到着駅, 片道運賃[, 経路]」。区切りはカンマ・タブ・全角カンマ。
 * 読めない行は理由を付けて返し、読めた行だけ登録する（途中で止めない）。
 */
function actionBulkUpsertFares_(body) {
  const u = requireUser_(body.token, true);
  const lines = String(body.text || "").split(/\r?\n/);
  const by = "手動（" + (u.displayName || u.username || "管理者") + "）";
  let added = 0;
  const errors = [];
  lines.forEach(function (line, i) {
    const raw = String(line || "").trim();
    if (!raw) return;
    const cols = raw.split(/[,\t、，]/).map(function (c) {
      return c.trim();
    });
    const from = cols[0] || "";
    const to = cols[1] || "";
    const fare = Math.round(Number(String(cols[2] || "").replace(/[^\d.-]/g, "")));
    const key = fareKey_(from, to);
    if (!key) {
      errors.push(i + 1 + "行目: 出発駅と到着駅を別々の駅名で指定してください（" + raw + "）");
      return;
    }
    if (!fare || fare <= 0) {
      errors.push(i + 1 + "行目: 片道運賃を1円以上の数値で指定してください（" + raw + "）");
      return;
    }
    saveFare_({
      key: key,
      from: from,
      to: to,
      fare: fare,
      route: cols[3] || "",
      source: "",
      checkedAt: new Date().toISOString(),
      checkedBy: by,
    });
    added++;
  });
  return {
    ok: true,
    added: added,
    errors: errors,
    items: actionListFares_(body).items,
  };
}

/** 管理者向け: 運賃マスタから区間を削除（次回は再びWebで調べ直す） */
function actionDeleteFare_(body) {
  requireUser_(body.token, true);
  const key = String(body.key || "").trim();
  const existing = findFare_(key);
  if (existing) getFaresSheet_().deleteRow(existing._row);
  return { ok: true, items: actionListFares_(body).items };
}

/* ========================= 領収書画像の取得 ========================= */

/**
 * 領収書画像をアプリ経由（＝GASの実行アカウント権限）で返す。
 * ドライブのフォルダを共有していない場合、利用者のブラウザから
 * drive.google.com のサムネイルを直接読めないため、その代替として使う。
 * 一般ユーザーは自分の申請の画像のみ取得できる。
 *
 * thumb=true のときは Drive 生成のサムネイル（小さく軽い）を優先する。
 */
function actionReceiptImage_(body) {
  const u = requireUser_(body.token, false);
  const id = String(body.imageFileId || "").trim();
  if (!id) throw new Error("画像が指定されていません");

  // シートに登録されている画像だけを許可する（任意のファイルIDを読ませない）。
  // 画像1枚ごとにシート全体を読むと一覧表示が重くなるため、該当行だけを引く。
  const row = findRowByColumn_(getSheet_(), "imageFileId", id);
  if (row < 0) throw new Error("画像が見つかりません");
  if (!u.legacy && u.role !== "admin") {
    const sheet = getSheet_();
    const head = headerKeys_(
      sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0],
      EXPENSE_COLUMNS
    );
    const applicantId = String(
      sheet.getRange(row, head.indexOf("applicantId") + 1).getValue()
    );
    if (applicantId !== u.username) throw new Error("forbidden");
  }

  const file = DriveApp.getFileById(id);
  let blob = null;
  if (body.thumb) {
    try {
      blob = file.getThumbnail();
    } catch (err) {
      blob = null; // サムネイル未生成のファイルは原本で返す
    }
  }
  if (!blob) blob = file.getBlob();
  if (!blob) throw new Error("画像を取得できませんでした");
  return {
    ok: true,
    dataUrl:
      "data:" +
      blob.getContentType() +
      ";base64," +
      Utilities.base64Encode(blob.getBytes()),
  };
}

/* ==================== AI解析の学習（店舗別の補正記憶） ==================== */

/**
 * 店名の照合キー。表記ゆれ（全半角・空白・法人格・記号）を吸収して
 * 「同じ店」を同じキーに寄せる。空文字なら学習対象外。
 */
function vendorKey_(s) {
  let v = String(s || "").trim();
  if (!v) return "";
  try {
    v = v.normalize("NFKC"); // 全角英数・半角カナを正規化
  } catch (err) {
    // 旧ランタイム互換（normalize 未対応でも動作させる）
  }
  v = v.toLowerCase();
  v = v.replace(/(株式会社|有限会社|合同会社|㈱|㈲)/g, "");
  v = v.replace(/[\s　()（）\[\]【】「」・.,、。\-ー–—_/\\]/g, "");
  return v.slice(0, 24);
}

/** シートが Date へ自動変換した日付を yyyy-MM-dd の文字列へ戻す */
function correctionDate_(v) {
  if (v instanceof Date) {
    return Utilities.formatDate(v, Session.getScriptTimeZone(), "yyyy-MM-dd");
  }
  return String(v || "");
}

/**
 * 直近 CORRECTION_LOOKBACK 件の学習ログを読む（古い順）。
 * 1リクエスト内で複数回引くため結果を保持する（GASは実行ごとに初期化されるので
 * リクエストをまたいで古い内容が残ることはない）。
 */
let CORRECTIONS_CACHE_ = null;
function readRecentCorrections_() {
  if (CORRECTIONS_CACHE_) return CORRECTIONS_CACHE_;
  const sheet = getCorrectionsSheet_();
  const last = sheet.getLastRow();
  if (last < 2) return (CORRECTIONS_CACHE_ = []);
  const start = Math.max(2, last - CORRECTION_LOOKBACK + 1);
  const values = sheet
    .getRange(start, 1, last - start + 1, CORRECTION_HEADERS.length)
    .getValues();
  const out = [];
  values.forEach(function (row) {
    const r = {};
    CORRECTION_HEADERS.forEach(function (h, i) {
      r[h] = row[i];
    });
    if (!r.vendorKey && !r.aiVendorKey) return;
    r.date = correctionDate_(r.date);
    r.aiDate = correctionDate_(r.aiDate);
    r.amount = Number(r.amount) || 0;
    r.aiAmount = Number(r.aiAmount) || 0;
    out.push(r);
  });
  CORRECTIONS_CACHE_ = out;
  return out;
}

/**
 * 最頻値を返す。同数の場合は新しい行（＝配列の後ろ）を優先し、
 * 運用の変更が古い履歴に埋もれないようにする。
 */
function mostFrequent_(rows, field) {
  const counts = {};
  let best = "";
  let bestN = 0;
  rows.forEach(function (r) {
    const v = String(r[field] == null ? "" : r[field]).trim();
    if (!v) return;
    counts[v] = (counts[v] || 0) + 1;
    if (counts[v] >= bestN) {
      bestN = counts[v];
      best = v;
    }
  });
  return { value: best, count: bestN };
}

/** 学習ログ（同一店舗分）を、辞書＋誤読事例に要約する */
function summarizeCorrections_(rows) {
  const mistakes = [];
  for (let i = rows.length - 1; i >= 0 && mistakes.length < CORRECTION_HINT_MAX; i--) {
    const r = rows[i];
    const amountWrong = r.aiAmount > 0 && r.aiAmount !== r.amount && r.amount > 0;
    const dateWrong = !!r.aiDate && !!r.date && r.aiDate !== r.date;
    const vendorWrong =
      !!r.aiVendor && !!r.vendor && vendorKey_(r.aiVendor) !== vendorKey_(r.vendor);
    if (!amountWrong && !dateWrong && !vendorWrong) continue;
    mistakes.push({
      amountWrong: amountWrong,
      dateWrong: dateWrong,
      vendorWrong: vendorWrong,
      amount: r.amount,
      aiAmount: r.aiAmount,
      date: r.date,
      aiDate: r.aiDate,
      vendor: String(r.vendor || ""),
      aiVendor: String(r.aiVendor || ""),
      rawHead: String(r.rawHead || ""),
    });
  }
  return {
    count: rows.length,
    vendor: mostFrequent_(rows, "vendor"),
    category: mostFrequent_(rows, "category"),
    description: mostFrequent_(rows, "description"),
    mistakes: mistakes,
  };
}

/**
 * 指定した店舗キーの学習内容を取り出す（履歴が無ければ null）。
 * AIが誤った店名を返した場合でも、その誤読を記録した行から確定名にたどり、
 * 同じ店舗の履歴をまとめて集め直す（誤読1回分だけで判断しない）。
 */
function buildVendorMemory_(key) {
  if (!key) return null;
  const all = readRecentCorrections_();
  const match = function (r, k) {
    return r.vendorKey === k || r.aiVendorKey === k;
  };
  let rows = all.filter(function (r) {
    return match(r, key);
  });
  if (!rows.length) return null;
  const canonical = mostFrequent_(rows, "vendorKey").value;
  if (canonical && canonical !== key) {
    const merged = all.filter(function (r) {
      return match(r, canonical) || match(r, key);
    });
    if (merged.length > rows.length) rows = merged;
  }
  return summarizeCorrections_(rows);
}

/**
 * ①辞書補正: 過去の確定値で 店名・科目・摘要 を上書きする。
 * 金額・日付は毎回変わるため辞書では触らない（②のヒントで対応する）。
 */
function applyVendorMemory_(fields, memory) {
  const applied = [];
  if (!memory) return applied;
  if (memory.vendor.value && memory.vendor.value !== fields.vendor) {
    fields.vendor = memory.vendor.value;
    applied.push("店名");
  }
  if (memory.category.value && memory.category.value !== fields.category) {
    fields.category = memory.category.value;
    applied.push("科目");
  }
  if (
    memory.description.count >= DESCRIPTION_MIN_HITS &&
    memory.description.value &&
    memory.description.value !== fields.description
  ) {
    fields.description = memory.description.value;
    applied.push("摘要");
  }
  return applied;
}

/** ②誤読事例: 過去に間違えた読み取りをプロンプトへ添える */
/**
 * 今回のAIの読み取りが、この店舗で過去に実際にあった誤読と同じ値かを判定する。
 * 同じ値を出しているなら、その誤読を伝えて読み直す価値がある。
 * 違う値なら（正しく読めたか、未知の誤りか）読み直しても直せる根拠が無い。
 */
function repeatsKnownMistake_(fields, mistakes) {
  if (!fields || !mistakes || !mistakes.length) return false;
  const amount = Math.max(0, Math.round(Number(fields.amount) || 0));
  const date = String(fields.date || "");
  const vendorKey = vendorKey_(fields.vendor);
  for (let i = 0; i < mistakes.length; i++) {
    const m = mistakes[i];
    if (m.amountWrong && amount > 0 && amount === Number(m.aiAmount)) return true;
    if (m.dateWrong && date && date === String(m.aiDate)) return true;
    if (m.vendorWrong && vendorKey && vendorKey === vendorKey_(m.aiVendor)) return true;
  }
  return false;
}

function buildCorrectionHint_(memory) {
  const lines = memory.mistakes.map(function (m) {
    const parts = [];
    if (m.amountWrong) {
      parts.push("金額を " + m.aiAmount + " と読んだが、正しくは " + m.amount + " だった");
    }
    if (m.dateWrong) {
      parts.push("日付を " + m.aiDate + " と読んだが、正しくは " + m.date + " だった");
    }
    if (m.vendorWrong) {
      parts.push(
        "店名を「" + m.aiVendor + "」と読んだが、正しくは「" + m.vendor + "」だった"
      );
    }
    return "・" + parts.join("／") + (m.rawHead ? "（そのときの書き起こし: " + m.rawHead + "）" : "");
  });
  return (
    "\n\n【この店舗のレシートで過去に実際にあった誤読】\n" +
    lines.join("\n") +
    "\n同じ間違いを繰り返さないでください。金額は最終的な支払合計、日付は発行日を、" +
    "根拠になる行を慎重に選び直してから答えること。"
  );
}

/** 申請確定時に「AIの読み取り」と「確定値」を1行記録する */
function logCorrection_(rec, ai, applicantId) {
  const aiVendor = String(ai.vendor || "").slice(0, 60);
  const key = vendorKey_(rec.vendor);
  const aiKey = vendorKey_(aiVendor);
  if (!key && !aiKey) return; // 店名が無いと次回の手がかりにできない
  const aiDate = String(ai.date || "");
  const aiAmount = Math.max(0, Math.round(Number(ai.amount) || 0));
  const aiCategory = String(ai.category || "");
  const aiDescription = String(ai.description || "").slice(0, 60);
  const corrected = [];
  if (aiDate !== String(rec.date || "")) corrected.push("date");
  if (aiAmount !== Number(rec.amount || 0)) corrected.push("amount");
  if (aiKey !== key) corrected.push("vendor");
  if (aiCategory !== String(rec.category || "")) corrected.push("category");
  if (aiDescription !== String(rec.description || "")) corrected.push("description");
  const rawHead = String(ai.rawText || "")
    .replace(/\s+/g, " ")
    .slice(0, 150);
  const row = {
    createdAt: new Date().toISOString(),
    vendorKey: key,
    aiVendorKey: aiKey,
    vendor: String(rec.vendor || ""),
    date: String(rec.date || ""),
    amount: Number(rec.amount || 0),
    category: String(rec.category || ""),
    description: String(rec.description || "").slice(0, 60),
    aiVendor: aiVendor,
    aiDate: aiDate,
    aiAmount: aiAmount,
    aiCategory: aiCategory,
    aiDescription: aiDescription,
    corrected: corrected.join(","),
    applicantId: String(applicantId || ""),
    rawHead: rawHead,
  };
  getCorrectionsSheet_().appendRow(
    CORRECTION_HEADERS.map(function (h) {
      return row[h];
    })
  );
  CORRECTIONS_CACHE_ = null;
}

/** 管理者向け: 学習内容を店舗ごとに集計して返す */
function actionListVendorMemory_(body) {
  requireUser_(body.token, true);
  const groups = {};
  readRecentCorrections_().forEach(function (r) {
    const k = r.vendorKey || r.aiVendorKey;
    if (!groups[k]) groups[k] = [];
    groups[k].push(r);
  });
  const items = Object.keys(groups).map(function (k) {
    const m = summarizeCorrections_(groups[k]);
    return {
      key: k,
      vendor: m.vendor.value || String(groups[k][groups[k].length - 1].aiVendor || ""),
      category: m.category.value,
      description:
        m.description.count >= DESCRIPTION_MIN_HITS ? m.description.value : "",
      count: m.count,
      mistakes: m.mistakes.length,
    };
  });
  items.sort(function (a, b) {
    return b.count - a.count;
  });
  return { ok: true, items: items };
}

/** 管理者向け: 誤った学習をやり直すため、店舗単位で履歴を削除する */
function actionDeleteVendorMemory_(body) {
  requireUser_(body.token, true);
  const key = String(body.key || "").trim();
  if (!key) throw new Error("削除対象の店舗が指定されていません");
  const sheet = getCorrectionsSheet_();
  const last = sheet.getLastRow();
  if (last < 2) return { ok: true, deleted: 0 };
  const kCol = CORRECTION_HEADERS.indexOf("vendorKey");
  const aCol = CORRECTION_HEADERS.indexOf("aiVendorKey");
  const vals = sheet.getRange(2, 1, last - 1, CORRECTION_HEADERS.length).getValues();
  let deleted = 0;
  for (let i = vals.length - 1; i >= 0; i--) {
    if (String(vals[i][kCol]) === key || String(vals[i][aCol]) === key) {
      sheet.deleteRow(i + 2);
      deleted++;
    }
  }
  CORRECTIONS_CACHE_ = null;
  return { ok: true, deleted: deleted };
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
 * hint には過去の誤読事例（buildCorrectionHint_）を渡せる。
 */
function buildReceiptPrompt_(hint) {
  const today = todayStr_();
  return (
    "あなたは日本の経費精算の担当者です。添付はレシートまたは領収書の写真です。\n" +
    "今日の日付は " + today + " です（この日付より未来の発行日はありえません）。\n\n" +
    "重要: 写真は90度・180度回転している場合や、斜め・影・感熱紙のかすれがある場合があります。" +
    "文字の向きを判断し、必要なら頭の中で回転させて正しく読んでください。\n\n" +
    "手順を必ず守ってください:\n" +
    // raw_text は精度のための「根拠」だが、応答時間は出力の長さでほぼ決まる。
    // 全文を書き写させると解析が目に見えて遅くなるため、判断の決め手になる行だけに絞る。
    "手順1: まず raw_text に、判断の決め手になる行だけを書き写す" +
    "（店名の行・発行日の行・合計金額の行の3行が基本。判断に迷ったときだけ" +
    "根拠になる行を足し、多くても" + RECEIPT_RAW_TEXT_MAX_LINES + "行まで）。" +
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
    "読み取れない項目は空文字（amount は 0）にし、創作しないこと。" +
    String(hint || "")
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
 * レシート解析（AI）。プロバイダはサーバー設定で選択、3段フォールバックの1段目。
 * 解析後、読み取れた店名をキーに過去の手修正（学習ログ）を反映する:
 *   ② 過去に金額・日付・店名を誤読した店舗なら、その事例を添えて1回だけ読み直す
 *   ① 確定済みの 店名・科目・摘要 を辞書として上書きする
 */
function actionAnalyzeReceipt_(body) {
  requireUser_(body.token, false);
  if (!body.imageBase64) throw new Error("画像がありません");
  const provider = resolveOcrProvider_();
  if (!provider) {
    throw new Error("AI解析は未設定です（GEMINI_API_KEY または ANTHROPIC_API_KEY を設定してください）");
  }
  const analyze = function (hint) {
    return provider === "gemini"
      ? analyzeWithGemini_(body, hint)
      : analyzeWithClaude_(body, hint);
  };

  let out = analyze("");
  let fields = out.fields || out;
  let memory = buildVendorMemory_(vendorKey_(fields.vendor));
  let retried = false;

  // 読み直しはAI呼び出しがもう1回増えるので、今回の読み取りが過去の誤読を
  // 実際に再現したときだけ行う。誤読履歴があるだけで毎回読み直すと、
  // よく使う店舗ほど解析が遅くなってしまう。
  if (memory && repeatsKnownMistake_(fields, memory.mistakes)) {
    try {
      const out2 = analyze(buildCorrectionHint_(memory));
      const f2 = out2.fields || out2;
      // 読み直しで金額・日付のどちらも取れないなら初回結果の方が信頼できる
      if (f2 && (f2.amount || f2.date)) {
        out = out2;
        fields = f2;
        retried = true;
        const m2 = buildVendorMemory_(vendorKey_(fields.vendor));
        if (m2) memory = m2;
      }
    } catch (err) {
      // ヒント付きの読み直しに失敗しても、初回の結果で処理を続ける
    }
  }

  const applied = applyVendorMemory_(fields, memory);
  return {
    ok: true,
    fields: fields,
    provider: provider,
    model: out.model || "",
    learned: {
      applied: applied,
      count: memory ? memory.count : 0,
      retried: retried,
    },
  };
}

/**
 * Gemini（無料枠可）で解析。GEMINI_MODEL 未指定なら現行モデルを順に試す。
 * モデル未提供・クォータ超過（404/403/429）の場合は次の候補へフォールバックし、
 * 全滅した場合はこのキーで使えるモデルを調べて追い試ししてから、
 * 全モデルの失敗理由と使えるモデル一覧をまとめて投げる（＝原因が画面に出る）。
 */
function analyzeWithGemini_(body, hint) {
  // 1巡目で全滅した場合は少し待って再挑戦（503は一時的な混雑が多い）
  return tryGeminiModels_(
    "AI解析",
    getProp_("GEMINI_API_KEY"),
    getProp_("GEMINI_MODEL"),
    function (model) {
      return callGemini_(body, model, hint);
    },
    2
  );
}

function callGemini_(body, model, hint) {
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
          { text: buildReceiptPrompt_(hint) },
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
function analyzeWithClaude_(body, hint) {
  const apiKey = getProp_("ANTHROPIC_API_KEY");
  const model = getProp_("OCR_MODEL") || "claude-opus-4-8";
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
          { type: "text", text: buildReceiptPrompt_(hint) },
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

/* ==================== PL管理モデルへの連携 ==================== */

/**
 * 別スプレッドシート「PL管理プロトタイプ」の『経費入力テーブル』へ、承認済みの
 * 経費申請を1行ずつ反映する。PL計算シートの SUMIFS がこの表を集計しているため、
 * ここに書けば各事業部の月次PL・インセンティブへそのまま反映される。
 *
 * 連携は PL_SPREADSHEET_ID を設定したときだけ有効。未設定なら一切何もしないので、
 * 設定しなければ従来どおりの動作になる。
 *
 * PL側の表は「アプリからの自動連携」と「手動入力」が混在する設計なので、
 * G列『申請ID』の有無でどちらの行かを見分ける。
 * **申請IDが空の行（手動入力）は絶対に書き換えない。**
 * アプリ由来の行は申請IDで upsert するため、何度流しても重複しない。
 */
const PL_EXPENSE_SHEET = "経費入力テーブル";
const PL_SALES_SHEET = "案件・売上入力テーブル";

/** PL側の表は1行目がタイトル・4行目が見出しで、データは5行目から始まる */
const PL_HEADER_ROW = 4;
const PL_FIRST_ROW = 5;
/**
 * SUMIFS に持たせる範囲の最終行。元のモデルは 100 行（実質96件）で打ち止めだったため、
 * setupPlSheets() でこの行まで広げる。申請は貯まり続けるので余裕を持たせる。
 */
const PL_LAST_ROW = 2000;

/**
 * PL側『経費入力テーブル』の列。既存モデルの列順そのもので、読み書きは位置で行う。
 * 申請ID列だけがアプリ連携のために増える列（元のモデルには無い）。
 */
const PL_EXPENSE_COLUMNS = [
  ["date", "日付"],
  ["applicant", "担当者名"],
  ["department", "所属事業部"],
  ["category", "経費項目"],
  ["amount", "金額"],
  ["note", "備考"],
  ["id", "申請ID"],
];
const PL_ID_COLUMN = PL_EXPENSE_COLUMNS.length; // G列

/**
 * アプリの語彙（事業部・科目）をPL側の語彙へ変換する対応表。
 * PL側の SUMIFS は "イベント営業" "雑費交通費" のような固定文字列で拾うため、
 * そのままでは一件も一致しない。対応表はシートに置いて運用側で直せるようにする。
 */
const PL_MAPPING_SHEET = "PL連携マッピング";
const PL_MAPPING_COLUMNS = [
  ["kind", "種別"],
  ["appValue", "アプリの値"],
  ["plValue", "PLの値"],
];
const PL_KIND_DEPARTMENT = "事業部";
const PL_KIND_CATEGORY = "科目";
/** 対応先が無い科目の受け皿。setupPlSheets() がPL側に同名の行を作る。 */
const PL_OTHER_CATEGORY = "その他経費";
const PL_OTHER_ROW_LABEL = "  その他経費（実費）";

/**
 * 対応表の初期値。事業部はPL計算シートが存在する2つ（イベント営業／人材）しか
 * 受け皿が無いため、人材以外はイベント営業へ寄せる。実態に合わなければシートを直す。
 * 科目はPL側に行がある3つへ寄せ、残りは「その他経費」へ集める（落とさない）。
 */
const DEFAULT_PL_MAPPINGS = [
  [PL_KIND_DEPARTMENT, "人材", "人材"],
  [PL_KIND_DEPARTMENT, "BAR", "イベント営業"],
  [PL_KIND_DEPARTMENT, "運送", "イベント営業"],
  [PL_KIND_DEPARTMENT, "本部", "イベント営業"],
  [PL_KIND_DEPARTMENT, "ARTGRAGE", "イベント営業"],
  [PL_KIND_DEPARTMENT, "クリニック", "イベント営業"],
  [PL_KIND_DEPARTMENT, "GoonerHouse", "イベント営業"],
  [PL_KIND_CATEGORY, "交通費", "雑費交通費"],
  [PL_KIND_CATEGORY, "交際費", "接待交際費"],
  [PL_KIND_CATEGORY, "会議費", PL_OTHER_CATEGORY],
  [PL_KIND_CATEGORY, "消耗品費", PL_OTHER_CATEGORY],
  [PL_KIND_CATEGORY, "通信費", PL_OTHER_CATEGORY],
  [PL_KIND_CATEGORY, "宿泊費", PL_OTHER_CATEGORY],
  [PL_KIND_CATEGORY, "その他", PL_OTHER_CATEGORY],
];

/**
 * PLへ反映できなかった申請の記録。事業部の対応先が無いと金額の行き先を決められず、
 * 黙って捨てると利益が実態より良く見えてしまうため、ここへ残して管理画面で警告する。
 */
const PL_SKIPPED_SHEET = "PL連携スキップ";
const PL_SKIPPED_COLUMNS = [
  ["recordedAt", "記録日時"],
  ["id", "申請ID"],
  ["applicant", "申請者"],
  ["department", "事業部"],
  ["category", "科目"],
  ["amount", "金額"],
  ["reason", "理由"],
];

/** 連携先のPLスプレッドシート。PL_SPREADSHEET_ID 未設定なら null（連携無効）。 */
function getPlSpreadsheet_() {
  const id = getProp_("PL_SPREADSHEET_ID");
  if (!id) return null;
  return SpreadsheetApp.openById(id);
}

function isPlSyncEnabled_() {
  return !!getProp_("PL_SPREADSHEET_ID");
}

function getPlMappingSheet_() {
  const existed = !!getSpreadsheet_().getSheetByName(PL_MAPPING_SHEET);
  const sheet = ensureSheet_(PL_MAPPING_SHEET, PL_MAPPING_COLUMNS);
  if (!existed) {
    DEFAULT_PL_MAPPINGS.forEach(function (m) {
      sheet.appendRow(m);
    });
  }
  return sheet;
}

function getPlSkippedSheet_() {
  return ensureSheet_(PL_SKIPPED_SHEET, PL_SKIPPED_COLUMNS);
}

/** 対応表を読み、{department: {アプリ値: PL値}, category: {...}} を返す。 */
function loadPlMappings_() {
  const sheet = getPlMappingSheet_();
  const last = sheet.getLastRow();
  const maps = { department: {}, category: {} };
  if (last < 2) return maps;
  const values = sheet.getRange(2, 1, last - 1, PL_MAPPING_COLUMNS.length).getValues();
  values.forEach(function (r) {
    const kind = String(r[0] == null ? "" : r[0]).trim();
    const appValue = String(r[1] == null ? "" : r[1]).trim();
    const plValue = String(r[2] == null ? "" : r[2]).trim();
    if (!appValue || !plValue) return;
    if (kind === PL_KIND_DEPARTMENT) maps.department[appValue] = plValue;
    else if (kind === PL_KIND_CATEGORY) maps.category[appValue] = plValue;
  });
  return maps;
}

/**
 * PL側『経費入力テーブル』。連携が無効、またはシートが無ければ null。
 * 元のモデルには無い『申請ID』列の見出しだけは、無ければここで補う
 * （setupPlSheets() を流す前でも連携が成立するようにしておく）。
 */
function getPlExpenseSheet_() {
  const ss = getPlSpreadsheet_();
  if (!ss) return null;
  const sheet = ss.getSheetByName(PL_EXPENSE_SHEET);
  if (!sheet) return null;
  const label = PL_EXPENSE_COLUMNS[PL_ID_COLUMN - 1][1];
  const cell = sheet.getRange(PL_HEADER_ROW, PL_ID_COLUMN);
  if (String(cell.getValue() || "").trim() !== label) cell.setValue(label);
  return sheet;
}

/** 申請IDでPL側の行番号を探す（無ければ -1）。申請ID列だけを読む。 */
function findPlRow_(sheet, id) {
  const last = sheet.getLastRow();
  if (last < PL_FIRST_ROW) return -1;
  const values = sheet
    .getRange(PL_FIRST_ROW, PL_ID_COLUMN, last - PL_FIRST_ROW + 1, 1)
    .getValues();
  const target = String(id);
  for (let i = 0; i < values.length; i++) {
    if (String(values[i][0] || "").trim() === target) return PL_FIRST_ROW + i;
  }
  return -1;
}

/** その瞬間を指定タイムゾーンで見た「見かけの日時」を UTC ミリ秒として返す。 */
function tzShownMs_(instant, tz) {
  const p = Utilities.formatDate(instant, tz, "yyyy-MM-dd-HH-mm")
    .split("-")
    .map(Number);
  return Date.UTC(p[0], p[1] - 1, p[2], p[3], p[4]);
}

/**
 * 指定タイムゾーンで「その日の 0:00」になる Date を返す。
 *
 * `new Date(y, m, d)` はスクリプトのタイムゾーンでの 0:00 なので、
 * スプレッドシートのタイムゾーンが違うと**シート上では別の日付になる**。
 * 実際に起きた例: スクリプトが Asia/Tokyo(+9)、PLモデルが
 * America/Los_Angeles(-7) で 16時間巻き戻り、全ての日付が1日前になった。
 * 日付がずれると月初・月末の SUMIFS が外れ、その月の経費が消える。
 */
function dateInTimeZone_(y, m, d, tz) {
  const want = Date.UTC(y, m - 1, d);
  let t = want;
  // 見かけの日時と目的の日時の差を当てて補正する（夏時間の境界のため2回まで）
  for (let i = 0; i < 2; i++) {
    const diff = want - tzShownMs_(new Date(t), tz);
    if (!diff) break;
    t += diff;
  }
  return new Date(t);
}

/**
 * 日付を、PLシートのタイムゾーンで 0:00 になる Date にする。
 *
 * PL側の SUMIFS は ">=2026-08-01" と日付として比較するため、文字列のまま
 * 書くと一件も集計されない（元のモデルが全月 0 だった原因）。
 * `tz` を省略した場合はスクリプトのタイムゾーンでの 0:00（テスト用）。
 */
function toPlDate_(value, tz) {
  let y;
  let m;
  let d;
  if (value instanceof Date) {
    // シート上の表示日を取り出す（表示はシートのタイムゾーン基準）
    const p = Utilities.formatDate(value, tz || Session.getScriptTimeZone(), "yyyy-MM-dd")
      .split("-")
      .map(Number);
    y = p[0];
    m = p[1];
    d = p[2];
  } else {
    const s = String(value == null ? "" : value).trim();
    const mt = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (!mt) return null;
    y = Number(mt[1]);
    m = Number(mt[2]);
    d = Number(mt[3]);
  }
  return tz ? dateInTimeZone_(y, m, d, tz) : new Date(y, m - 1, d);
}

/** PLシートのタイムゾーン。日付を書くたびに必要なので、シートから直接取る。 */
function plTimeZone_(sheet) {
  return sheet.getParent().getSpreadsheetTimeZone();
}

/** PLの1行分の値。列は PL_EXPENSE_COLUMNS の定義順そのもの。 */
function buildPlRowValues_(rec, plDepartment, plCategory, tz) {
  const note = [rec.vendor, rec.description]
    .map(function (v) {
      return String(v == null ? "" : v).trim();
    })
    .filter(function (v) {
      return v;
    })
    .join(" / ");
  return [
    toPlDate_(rec.date, tz),
    String(rec.applicant || ""),
    plDepartment,
    plCategory,
    Number(rec.amount) || 0,
    note,
    String(rec.id || ""),
  ];
}

/**
 * 書き込み先の行を決める。申請IDも日付も金額も空の行があればそこを再利用し、
 * 無ければ最終行の次に足す。PL_LAST_ROW を超える場合は null（SUMIFS の範囲外に
 * 書いても集計されないため、黙って範囲外へ書かない）。
 */
function nextPlRow_(sheet) {
  const last = sheet.getLastRow();
  if (last >= PL_FIRST_ROW) {
    const values = sheet
      .getRange(PL_FIRST_ROW, 1, last - PL_FIRST_ROW + 1, PL_ID_COLUMN)
      .getValues();
    for (let i = 0; i < values.length; i++) {
      const r = values[i];
      const empty = !String(r[0] || "").trim() && !r[4] && !String(r[6] || "").trim();
      if (empty) return PL_FIRST_ROW + i;
    }
  }
  const row = Math.max(last + 1, PL_FIRST_ROW);
  return row > PL_LAST_ROW ? null : row;
}

function writePlRow_(sheet, row, values) {
  sheet.getRange(row, 1, 1, values.length).setValues([values]);
  sheet.getRange(row, 1).setNumberFormat("yyyy-mm-dd");
}

/** スキップ記録の upsert（同じ申請を何度も積まない）。 */
function recordPlSkip_(rec, reason) {
  const sheet = getPlSkippedSheet_();
  const values = [
    new Date().toISOString(),
    String(rec.id || ""),
    String(rec.applicant || ""),
    String(rec.department || ""),
    String(rec.category || ""),
    Number(rec.amount) || 0,
    reason,
  ];
  const row = findRowByColumn_(sheet, "id", String(rec.id || ""), PL_SKIPPED_COLUMNS);
  if (row > 0) sheet.getRange(row, 1, 1, values.length).setValues([values]);
  else sheet.appendRow(values);
}

function clearPlSkip_(id) {
  const sheet = getPlSkippedSheet_();
  const row = findRowByColumn_(sheet, "id", String(id), PL_SKIPPED_COLUMNS);
  if (row > 0) sheet.deleteRow(row);
}

function countPlSkipped_() {
  const sheet = getPlSkippedSheet_();
  return Math.max(0, sheet.getLastRow() - 1);
}

/**
 * 申請1件をPLへ反映する。
 *
 * - 承認済み以外（申請中・却下）はPLに載せない。既に載っていれば取り下げる。
 * - 事業部の対応先が無い場合は書かずにスキップ記録へ残す（金額の行き先を
 *   勝手に決めてしまうと、別の事業部のPLを汚す）。
 * - 科目の対応先が無い場合は「その他経費」へ寄せる（経費そのものは落とさない）。
 */
function syncExpenseToPl_(rec) {
  const sheet = getPlExpenseSheet_();
  if (!sheet) return { ok: false, reason: "disabled" };
  const id = String(rec.id || "");
  if (!id) return { ok: false, reason: "no id" };
  const row = findPlRow_(sheet, id);

  if (String(rec.status || "") !== "approved") {
    if (row > 0) sheet.deleteRow(row);
    clearPlSkip_(id);
    return { ok: true, posted: false, reason: "not approved" };
  }

  const maps = loadPlMappings_();
  const department = String(rec.department || "").trim();
  const plDepartment = maps.department[department];
  if (!plDepartment) {
    if (row > 0) sheet.deleteRow(row);
    recordPlSkip_(
      rec,
      "事業部「" + (department || "未設定") + "」のPL対応先が未設定"
    );
    return { ok: false, posted: false, reason: "unmapped department" };
  }
  const plCategory =
    maps.category[String(rec.category || "").trim()] || PL_OTHER_CATEGORY;
  const values = buildPlRowValues_(rec, plDepartment, plCategory, plTimeZone_(sheet));
  if (!values[0]) {
    recordPlSkip_(rec, "利用日が日付として読めない（" + rec.date + "）");
    return { ok: false, posted: false, reason: "bad date" };
  }

  if (row > 0) {
    writePlRow_(sheet, row, values);
  } else {
    const target = nextPlRow_(sheet);
    if (!target) {
      recordPlSkip_(rec, "PL側の行数上限（" + PL_LAST_ROW + "行）に達した");
      return { ok: false, posted: false, reason: "out of range" };
    }
    writePlRow_(sheet, target, values);
  }
  clearPlSkip_(id);
  return { ok: true, posted: true };
}

/**
 * PL連携の失敗で申請そのものを落とさないためのラッパー。
 * 連携先が一時的に開けなくても、申請の保存・承認は成立させる
 * （取りこぼしは syncAllToPl() で後から揃えられる）。
 */
function safeSyncExpenseToPl_(rec) {
  try {
    return syncExpenseToPl_(rec);
  } catch (err) {
    return { ok: false, reason: String(err && err.message ? err.message : err) };
  }
}

/** 申請IDでPLの行を取り下げる（削除時に使う）。 */
function safeRemoveFromPl_(id) {
  try {
    const sheet = getPlExpenseSheet_();
    if (!sheet) return;
    const row = findPlRow_(sheet, String(id));
    if (row > 0) sheet.deleteRow(row);
    clearPlSkip_(id);
  } catch (err) {
    // 連携先を触れなくても申請の削除は成立させる
  }
}

/**
 * メンテナンス用：既存の全申請をPLへ反映し直す（エディタから手動実行）。
 * 連携を有効にした直後の取り込みと、一時的な失敗の埋め戻しに使う。
 *
 * アプリ由来の行（申請IDあり）をいったん全て取り下げてから、承認済みを
 * まとめて書き直す。手動入力行（申請IDなし）は読み取りも書き換えもしない。
 */
function syncAllToPl() {
  const sheet = getPlExpenseSheet_();
  if (!sheet) {
    const msg =
      "PL連携が無効です。スクリプトプロパティ PL_SPREADSHEET_ID に" +
      "PL管理モデルのスプレッドシートIDを設定してください。";
    Logger.log(msg);
    return msg;
  }
  // 既存のアプリ由来の行を下から削除（手動入力行は申請IDが空なので残る）
  const last = sheet.getLastRow();
  if (last >= PL_FIRST_ROW) {
    const ids = sheet
      .getRange(PL_FIRST_ROW, PL_ID_COLUMN, last - PL_FIRST_ROW + 1, 1)
      .getValues();
    for (let i = ids.length - 1; i >= 0; i--) {
      if (String(ids[i][0] || "").trim()) sheet.deleteRow(PL_FIRST_ROW + i);
    }
  }
  // 承認済みを対応表で変換して書き出す
  const tz = plTimeZone_(sheet);
  const maps = loadPlMappings_();
  const records = rowsToRecords_(getSheet_());
  const rows = [];
  const skipped = [];
  records.forEach(function (rec) {
    if (String(rec.status || "") !== "approved") return;
    const department = String(rec.department || "").trim();
    const plDepartment = maps.department[department];
    if (!plDepartment) {
      skipped.push([rec, "事業部「" + (department || "未設定") + "」のPL対応先が未設定"]);
      return;
    }
    const plCategory =
      maps.category[String(rec.category || "").trim()] || PL_OTHER_CATEGORY;
    const values = buildPlRowValues_(rec, plDepartment, plCategory, tz);
    if (!values[0]) {
      skipped.push([rec, "利用日が日付として読めない（" + rec.date + "）"]);
      return;
    }
    rows.push(values);
  });

  const start = Math.max(sheet.getLastRow() + 1, PL_FIRST_ROW);
  const room = PL_LAST_ROW - start + 1;
  const writable = rows.slice(0, Math.max(0, room));
  rows.slice(writable.length).forEach(function (v) {
    skipped.push([{ id: v[6], applicant: v[1], department: v[2], category: v[3], amount: v[4] },
      "PL側の行数上限（" + PL_LAST_ROW + "行）に達した"]);
  });
  if (writable.length) {
    sheet.getRange(start, 1, writable.length, PL_ID_COLUMN).setValues(writable);
    sheet.getRange(start, 1, writable.length, 1).setNumberFormat("yyyy-mm-dd");
  }

  // スキップ記録は作り直す（解消済みの警告を残さない）
  const skipSheet = getPlSkippedSheet_();
  if (skipSheet.getLastRow() > 1) {
    skipSheet.deleteRows(2, skipSheet.getLastRow() - 1);
  }
  skipped.forEach(function (s) {
    recordPlSkip_(s[0], s[1]);
  });

  const msg =
    "PL連携: " + writable.length + "件を反映、" + skipped.length + "件をスキップ";
  Logger.log(msg);
  return msg;
}

/* ---------- PL側スプレッドシートの初期設定（1回だけ実行する） ---------- */

/**
 * メンテナンス用：PL管理モデル側をアプリ連携に合わせて整える（エディタから手動実行）。
 * 何度実行しても同じ結果になる（追加済みのものは飛ばす）。
 *
 *   1. 日付列を実日付へ移行する（経費・売上の両方）
 *   2. SUMIFS の範囲を 100 行から PL_LAST_ROW まで広げる
 *   3. 各PL計算シートへ「その他経費（実費）」行を足し、経費合計に含める
 *
 * 1 は元のモデルが全月 0 円だった原因への対処。日付列が文字列なのに SUMIFS が
 * ">=2026-08-01" と日付比較していたため、条件が一件も一致していなかった。
 */
function setupPlSheets() {
  const ss = getPlSpreadsheet_();
  if (!ss) {
    const msg =
      "PL連携が無効です。スクリプトプロパティ PL_SPREADSHEET_ID に" +
      "PL管理モデルのスプレッドシートIDを設定してください。";
    Logger.log(msg);
    return msg;
  }
  const done = [];
  // ずれた日付の復元 → 文字列日付の移行 の順に流す（復元は時刻を目印にするため、
  // 時刻を落とす移行より先に実行しないと目印が消える）
  [PL_EXPENSE_SHEET, PL_SALES_SHEET].forEach(function (name) {
    const n = repairPlShiftedDates_(ss, name);
    if (n > 0) done.push(name + "のずれた日付を復元: " + n + "件");
  });
  [PL_EXPENSE_SHEET, PL_SALES_SHEET].forEach(function (name) {
    const n = fixPlDateColumn_(ss, name);
    if (n > 0) done.push(name + "の日付を実日付へ移行: " + n + "件");
  });
  const widened = widenPlSumifsRanges_(ss);
  if (widened > 0) done.push("SUMIFS の範囲を拡張: " + widened + "式");
  getPlExpenseSheet_(); // 申請ID列の見出しを用意する
  done.push("『" + PL_EXPENSE_COLUMNS[PL_ID_COLUMN - 1][1] + "』列を用意");
  ss.getSheets().forEach(function (sheet) {
    const label = addPlOtherExpenseRow_(sheet);
    if (label) done.push(sheet.getName() + "に「" + label + "」行を追加");
  });
  // 月末の条件を半開区間へ（その他経費の行を作ったあとに変換する）
  const halfOpen = usePlHalfOpenRanges_(ss);
  if (halfOpen > 0) done.push("月末の条件を「<翌月1日」へ変更: " + halfOpen + "式");
  const msg = done.length ? done.join(" / ") : "変更はありませんでした（すでに設定済み）";
  Logger.log(msg);
  return msg;
}

/**
 * 日付列（A列）の文字列を Date に置き換える。
 * SUMIFS の日付条件は文字列の日付と一致しないため、これを直さないと
 * PL計算シートは何を書いても 0 円のままになる。
 */
function fixPlDateColumn_(ss, sheetName) {
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) return 0;
  const last = sheet.getLastRow();
  if (last < PL_FIRST_ROW) return 0;
  const tz = ss.getSpreadsheetTimeZone();
  const values = sheet
    .getRange(PL_FIRST_ROW, 1, last - PL_FIRST_ROW + 1, 1)
    .getValues();
  let changed = 0;
  values.forEach(function (r, i) {
    const v = r[0];
    if (v === "" || v == null) return;
    // すでに 0:00 の日付は書き換えない。
    // **判定はシートのタイムゾーンで行う**（読み書きともシート基準で解釈される）。
    // スクリプトのタイムゾーンで見ると、ずれた値がちょうど 0:00 に見えてしまう。
    if (v instanceof Date && Utilities.formatDate(v, tz, "HH-mm") === "00-00") {
      return;
    }
    const d = toPlDate_(v, tz);
    if (!d) return;
    writePlDateCell_(sheet, PL_FIRST_ROW + i, d);
    changed++;
  });
  return changed;
}

/**
 * 日付セルを1つだけ書き換える。
 * 範囲まとめての setValues は、直す必要のないセルまで書き戻してしまうため使わない。
 */
function writePlDateCell_(sheet, row, date) {
  const cell = sheet.getRange(row, 1);
  cell.setValue(date);
  cell.setNumberFormat("yyyy-mm-dd");
}

/**
 * タイムゾーンのずれで日付が1日前になってしまった行を復元する。
 *
 * 見分け方は「**シートのタイムゾーンでの時刻が 0:00 でない**」こと。人がシートへ
 * 入力した日付は 0:00 になるので触らない。旧コードは「スクリプトTZの 0:00」を
 * 書いていたため、シートのTZでは時刻が付いて見える（+9 と -7 なら前日 8:00）。
 *
 * 復元は簡単で、**スクリプトのタイムゾーンで読み直せば本来の日付が出る**
 * （旧コードがスクリプトTZの 0:00 として書いた値そのものだから）。それを
 * シートのタイムゾーンの 0:00 として書き直す。
 *
 * 念のため「スクリプトTZで 0:00 になる」ことも確かめ、旧コード由来でない
 * 時刻付きの値（人が時刻まで入れた場合）は触らない。
 * 2回目以降は対象が無くなるため、何度実行しても同じ結果になる。
 */
function repairPlShiftedDates_(ss, sheetName) {
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) return 0;
  const last = sheet.getLastRow();
  if (last < PL_FIRST_ROW) return 0;
  const tz = ss.getSpreadsheetTimeZone();
  const scriptTz = Session.getScriptTimeZone();
  const values = sheet
    .getRange(PL_FIRST_ROW, 1, last - PL_FIRST_ROW + 1, 1)
    .getValues();
  let changed = 0;
  values.forEach(function (r, i) {
    const v = r[0];
    if (!(v instanceof Date)) return;
    // シートのTZで 0:00 ＝ 日付として正しく入っている（人が入力した行）
    if (Utilities.formatDate(v, tz, "HH-mm") === "00-00") return;
    // 旧コードが書いた値は「スクリプトTZの 0:00」。その形でなければ触らない
    if (Utilities.formatDate(v, scriptTz, "HH-mm") !== "00-00") return;
    const p = Utilities.formatDate(v, scriptTz, "yyyy-MM-dd")
      .split("-")
      .map(Number);
    writePlDateCell_(sheet, PL_FIRST_ROW + i, dateInTimeZone_(p[0], p[1], p[2], tz));
    changed++;
  });
  return changed;
}

/**
 * 月末の条件を「<=月末」から「<翌月1日」へ変える。
 *
 * 日付セルに時刻が残っていると `"<=2026-08-31"` は 8/31 の経費を落とす。
 * 8月にも9月にも入らないため、その経費はPLから消える。半開区間にしておけば
 * 時刻が入っていても取りこぼさない。
 */
function usePlHalfOpenRanges_(ss) {
  let count = 0;
  ss.getSheets().forEach(function (sheet) {
    const formulas = sheet.getDataRange().getFormulas();
    formulas.forEach(function (row, i) {
      row.forEach(function (f, j) {
        if (!f) return;
        if (f.indexOf(PL_EXPENSE_SHEET) < 0 && f.indexOf(PL_SALES_SHEET) < 0) return;
        const next = f.replace(
          /"<=(\d{4})-(\d{2})-(\d{2})"/g,
          function (all, y, m, d) {
            const nd = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d) + 1));
            return (
              '"<' +
              nd.getUTCFullYear() +
              "-" +
              ("0" + (nd.getUTCMonth() + 1)).slice(-2) +
              "-" +
              ("0" + nd.getUTCDate()).slice(-2) +
              '"'
            );
          }
        );
        if (next === f) return;
        sheet.getRange(i + 1, j + 1).setFormula(next);
        count++;
      });
    });
  });
  return count;
}

/** 『経費入力テーブル』を参照する SUMIFS の範囲を PL_LAST_ROW まで広げる。 */
function widenPlSumifsRanges_(ss) {
  const pattern = new RegExp(
    "('" + PL_EXPENSE_SHEET + "'!\\$[A-Z]\\$" + PL_FIRST_ROW + ":\\$[A-Z]\\$)(\\d+)",
    "g"
  );
  let count = 0;
  ss.getSheets().forEach(function (sheet) {
    const formulas = sheet.getDataRange().getFormulas();
    formulas.forEach(function (row, i) {
      row.forEach(function (f, j) {
        if (!f || f.indexOf(PL_EXPENSE_SHEET) < 0) return;
        const next = f.replace(pattern, function (all, head, lastRow) {
          if (Number(lastRow) >= PL_LAST_ROW) return all;
          return head + PL_LAST_ROW;
        });
        if (next === f) return;
        // 変更した数式だけを個別に書き戻す。範囲まとめての setFormulas は、
        // 数式でないセル（見出し・固定人件費の実数値）を空文字で消してしまう。
        sheet.getRange(i + 1, j + 1).setFormula(next);
        count++;
      });
    });
  });
  return count;
}

/**
 * PL計算シートへ「その他経費（実費）」行を足し、経費合計に含める。
 *
 * 対応する経費項目の行が無い科目（会議費・消耗品費・通信費・宿泊費・その他）を
 * 受けるための行。個別の科目名で SUMIFS を書くのではなく
 * 「事業部×月の経費合計 − すでに個別行で拾っている分」の差で出すため、
 * **将来アプリ側に科目が増えてもPLから漏れない。**
 *
 * 経費合計の行が無いシート（ダッシュボード等）は対象外。すでに行があれば何もしない。
 */
function addPlOtherExpenseRow_(sheet) {
  const last = sheet.getLastRow();
  if (last < 2) return "";
  const labels = sheet.getRange(1, 1, last, 1).getValues();
  let totalRow = 0;
  for (let i = 0; i < labels.length; i++) {
    const t = String(labels[i][0] == null ? "" : labels[i][0]).trim();
    if (t === PL_OTHER_ROW_LABEL.trim()) return ""; // すでに追加済み
    if (!totalRow && t === "経費合計") totalRow = i + 1;
  }
  if (!totalRow) return "";

  // 経費合計より上で『経費入力テーブル』から拾っている行＝すでに個別計上済みの行。
  // 固定人件費や概算家賃のような手置きの行は引かない（差から漏れてしまう）。
  const lastCol = sheet.getLastColumn();
  const formulas = sheet.getRange(1, 1, totalRow, lastCol).getFormulas();
  const itemRows = [];
  for (let r = 1; r < totalRow; r++) {
    const f = formulas[r - 1][1]; // B列（最初の月）で判定する
    if (f && f.indexOf(PL_EXPENSE_SHEET) >= 0) itemRows.push(r);
  }
  if (!itemRows.length) return ""; // 経費を集計していないシート

  // 月ごとの条件（事業部・期間）は既存の数式から取り出して、そのまま使い回す。
  const sample = formulas[itemRows[0] - 1];
  const totalFormula = sheet.getRange(totalRow, 2).getFormula();

  sheet.insertRowBefore(totalRow);
  const newRow = totalRow; // 挿入した行。経費合計は1つ下へ動く
  sheet.getRange(newRow, 1).setValue(PL_OTHER_ROW_LABEL);

  const values = [];
  for (let c = 2; c <= lastCol; c++) {
    const src = sample[c - 1];
    const args = src ? parsePlSumifsArgs_(src) : null;
    if (!args) {
      // 合計列（SUM）などは、この行の月セルを足し合わせる
      values.push(c > 2 ? "=SUM(B" + newRow + ":" + columnLetter_(c - 1) + newRow + ")" : "");
      continue;
    }
    const total =
      "SUMIFS('" + PL_EXPENSE_SHEET + "'!$E$" + PL_FIRST_ROW + ":$E$" + PL_LAST_ROW +
      ", '" + PL_EXPENSE_SHEET + "'!$C$" + PL_FIRST_ROW + ":$C$" + PL_LAST_ROW +
      ', "' + args.department + '"' +
      ", '" + PL_EXPENSE_SHEET + "'!$A$" + PL_FIRST_ROW + ":$A$" + PL_LAST_ROW +
      ', "' + args.from + '"' +
      ", '" + PL_EXPENSE_SHEET + "'!$A$" + PL_FIRST_ROW + ":$A$" + PL_LAST_ROW +
      ', "' + args.to + '")';
    const subtract = itemRows
      .map(function (r) {
        // 挿入で1つ下へずれた行は番号を繰り下げる
        return columnLetter_(c) + (r >= newRow ? r + 1 : r);
      })
      .join(" - ");
    values.push("=" + total + (subtract ? " - " + subtract : ""));
  }
  sheet.getRange(newRow, 2, 1, values.length).setValues([values]);

  // 経費合計に新しい行を含める。挿入位置が SUM の範囲の「直後」なので、
  // 行の挿入では範囲が自動で広がらない（範囲の内側に挿した場合だけ広がる）。
  if (totalFormula) {
    const totalRowAfter = newRow + 1;
    for (let c = 2; c <= lastCol; c++) {
      const cell = sheet.getRange(totalRowAfter, c);
      const cur = cell.getFormula();
      if (!cur) continue; // 数式でないセルには書き込まない（実数値を消さない）
      const next = shiftPlSumRange_(cur, newRow);
      if (next !== cur) cell.setFormula(next);
    }
  }
  return PL_OTHER_ROW_LABEL.trim();
}

/** SUM(B12:B15) の終端を、挿入した行を含む位置まで広げる。 */
function shiftPlSumRange_(formula, insertedRow) {
  return formula.replace(
    /(\$?[A-Z]+\$?)(\d+):(\$?[A-Z]+\$?)(\d+)/,
    function (all, c1, r1, c2, r2) {
      const end = Number(r2);
      return c1 + r1 + ":" + c2 + (end + 1 === insertedRow ? end + 1 : end);
    }
  );
}

/** SUMIFS から 事業部の条件と日付の範囲条件を取り出す。 */
function parsePlSumifsArgs_(formula) {
  if (!formula || formula.indexOf("SUMIFS") < 0) return null;
  const dept = formula.match(/\$C\$\d+:\$C\$\d+,\s*"([^"]+)"/);
  // 月末の条件は "<=月末" と "<翌月1日" のどちらの形でも受ける
  const dates = formula.match(
    /\$A\$\d+:\$A\$\d+,\s*"(>=[^"]+)"[\s\S]*?\$A\$\d+:\$A\$\d+,\s*"(<=?[^"]+)"/
  );
  if (!dept || !dates) return null;
  return { department: dept[1], from: dates[1], to: dates[2] };
}

/** 1 → "A" の列記号。 */
function columnLetter_(index) {
  let n = index;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
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
