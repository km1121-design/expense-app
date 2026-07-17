/**
 * 経費申請アプリ バックエンド（Google Apps Script Web App）
 *
 * 役割:
 *   - スプレッドシートを経費データのデータベースとして使用（1申請 = 1行）
 *   - アップロードされた領収書画像を Google Drive フォルダに保存し、URL を行に記録
 *   - 実績管理・分析ツール向けに JSON API（doGet）で全データを提供
 *
 * デプロイ手順は apps-script/README.md を参照。
 *
 * スクリプトプロパティ（プロジェクトの設定 > スクリプト プロパティ）で上書き可能:
 *   SPREADSHEET_ID  : 保存先スプレッドシートID（未設定なら初回に「経費申請データ」を
 *                     自動作成し、そのIDをここへ自動保存して以降再利用）
 *   DRIVE_FOLDER_ID : 領収書画像の保存先フォルダID（未設定なら「経費領収書」を
 *                     自動作成・自動保存して以降再利用）
 *   SHARED_TOKEN    : 共有トークン（設定時はリクエストの token と一致必須）
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
];

function getProp_(key) {
  return PropertiesService.getScriptProperties().getProperty(key);
}

function getSheet_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty("SPREADSHEET_ID");
  let ss;
  if (id) {
    ss = SpreadsheetApp.openById(id);
  } else {
    // スタンドアロン型では getActiveSpreadsheet() が null になるため、
    // 初回に作成したスプレッドシートのIDを保存し、以降は必ず同じものを使う
    ss =
      SpreadsheetApp.getActiveSpreadsheet() ||
      SpreadsheetApp.create("経費申請データ");
    props.setProperty("SPREADSHEET_ID", ss.getId());
  }
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
    sheet.setFrozenRows(1);
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

function checkToken_(token) {
  const expected = getProp_("SHARED_TOKEN");
  if (expected && token !== expected) throw new Error("unauthorized");
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON
  );
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
    head.forEach((h, j) => (rec[h] = row[j]));
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

/** GET: 全データを JSON で返す（分析ツール・ダッシュボードからの読み込み用） */
function doGet(e) {
  try {
    checkToken_(e && e.parameter ? e.parameter.token : "");
    return json_({ ok: true, records: rowsToRecords_(getSheet_()) });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

/** POST: 申請の作成・更新・削除 */
function doPost(e) {
  try {
    const body = JSON.parse((e.postData && e.postData.contents) || "{}");
    checkToken_(body.token);
    switch (body.action) {
      case "create":
        return json_(createExpense_(body.record));
      case "update":
        return json_(updateExpense_(body.id, body.fields || {}));
      case "delete":
        return json_(deleteExpense_(body.id));
      default:
        return json_({ ok: false, error: "unknown action" });
    }
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function createExpense_(record) {
  const sheet = getSheet_();
  let imageUrl = "";
  let imageFileId = "";
  if (record.imageBase64) {
    const folder = getFolder_();
    const bytes = Utilities.base64Decode(record.imageBase64);
    const blob = Utilities.newBlob(
      bytes,
      record.imageMime || "image/jpeg",
      (record.id || "receipt") + ".jpg"
    );
    const file = folder.createFile(blob);
    imageFileId = file.getId();
    imageUrl = "https://drive.google.com/file/d/" + imageFileId + "/view";
  }
  const rec = {
    id: record.id,
    createdAt: record.createdAt || new Date().toISOString(),
    applicant: record.applicant || "",
    date: record.date || "",
    category: record.category || "",
    vendor: record.vendor || "",
    amount: Number(record.amount) || 0,
    description: record.description || "",
    status: record.status || "pending",
    reviewedAt: "",
    reviewer: "",
    reviewComment: "",
    imageUrl: imageUrl,
    imageFileId: imageFileId,
  };
  sheet.appendRow(HEADERS.map((h) => rec[h]));
  return { ok: true, record: rec };
}

function updateExpense_(id, fields) {
  const sheet = getSheet_();
  const row = findRow_(sheet, id);
  if (row < 0) return { ok: false, error: "not found" };
  Object.keys(fields).forEach((k) => {
    const col = HEADERS.indexOf(k);
    if (col >= 0) sheet.getRange(row, col + 1).setValue(fields[k]);
  });
  return { ok: true };
}

function deleteExpense_(id) {
  const sheet = getSheet_();
  const row = findRow_(sheet, id);
  if (row < 0) return { ok: false, error: "not found" };
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
