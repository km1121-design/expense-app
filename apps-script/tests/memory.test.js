/**
 * Code.gs の回帰テスト（シートの移行・AI解析の読み直しとモデル選択・領収書の採番・
 * 利用コードでのログイン・ログインの有効期間と失効・事業部・月ごとの一覧）。
 *
 *   node apps-script/tests/memory.test.js
 *
 * Apps Script のサービスを最小限スタブして Code.gs を読み込み、期待どおり動くかを
 * 確認する。依存ライブラリなし・Google への接続なしで実行できる。
 * （ファイル名の memory は、削除した「AI解析の学習」のテストから始まった名残。
 *   デプロイのワークフローが参照しているので名前は変えていない。）
 */
const fs = require("fs");
const vm = require("vm");
const assert = require("assert");

// ---- 最小限の GAS スタブ ----
/**
 * タイムゾーンの再現。スプレッドシートの日付は**シートのタイムゾーン基準**で
 * 読み書きされる（読み出しでスクリプトのTZは使われない）。
 * そのため `new Date(y, m, d)`（スクリプトTZの 0:00）を書くと、シート上では
 * タイムゾーン差のぶん巻き戻って別の日付になる。実際に1日ずれる事故が起きた。
 */
const SCRIPT_TZ = "Asia/Tokyo";
/** vm の中と外では Date が別物なので、シートに入れる日付は中側の Date で作る */
let SBDate = null;
const mkDate = (ms) => new (SBDate || Date)(ms);
const TZ_OFFSET = { "Asia/Tokyo": 9, "America/Los_Angeles": -7, UTC: 0 };
const shownParts = (d, tz) => {
  const t = new Date(d.getTime() + TZ_OFFSET[tz] * 3600000);
  return [t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), t.getUTCHours(), t.getUTCMinutes()];
};
const instantFor = (p, tz) =>
  mkDate(Date.UTC(p[0], p[1], p[2], p[3], p[4]) - TZ_OFFSET[tz] * 3600000);

/** シート上での表示（検証用）。表示はシートのタイムゾーン基準。 */
const SHEET_TZ = "America/Los_Angeles";
const displayed = (v) => shownIn(v, SHEET_TZ);
const shownIn = (d, tz) => {
  const p = shownParts(d, tz);
  const z = (n) => String(n).padStart(2, "0");
  return `${p[0]}-${z(p[1] + 1)}-${z(p[2])} ${z(p[3])}:${z(p[4])}`;
};
class FakeSheet {
  constructor(name, rows) {
    this.name = name;
    this.rows = rows || [];
    // 数式は値と別に持つ。"=" で始まる値を書いたら数式にもなる（実物と同じ挙動）
    this.formulas = [];
  }
  getName() { return this.name; }
  setName(n) { renameSheet(this, n); }
  getParent() { return this.parent || FAKE_SS; }
  getLastRow() { return this.rows.length; }
  getLastColumn() {
    return this.rows.reduce((max, r) => Math.max(max, (r || []).length), 0);
  }
  appendRow(r) { this.rows.push(r.slice()); }
  setFrozenRows() {}
  getDataRange() {
    return this.getRange(1, 1, this.getLastRow(), this.getLastColumn());
  }
  deleteRow(n) { this.rows.splice(n - 1, 1); this.formulas.splice(n - 1, 1); }
  deleteRows(n, count) {
    this.rows.splice(n - 1, count);
    this.formulas.splice(n - 1, count);
  }
  /** 行の挿入。実物は参照を自動で追随させるが、ここでは行をずらすだけ。 */
  insertRowBefore(n) {
    this.rows.splice(n - 1, 0, []);
    this.formulas.splice(n - 1, 0, []);
  }
  getRange(row, col, numRows, numCols) {
    const self = this;
    return {
      getValues() {
        const out = [];
        for (let i = 0; i < numRows; i++) {
          const src = self.rows[row - 1 + i] || [];
          const line = [];
          for (let j = 0; j < numCols; j++) line.push(src[col - 1 + j]);
          out.push(line);
        }
        return out;
      },
      setValues(vals) {
        vals.forEach((line, i) => {
          const target = (self.rows[row - 1 + i] = self.rows[row - 1 + i] || []);
          const fRow = (self.formulas[row - 1 + i] = self.formulas[row - 1 + i] || []);
          line.forEach((v, j) => {
            target[col - 1 + j] = v;
            // "=" で始まる文字列を書くと数式になる
            fRow[col - 1 + j] = typeof v === "string" && v[0] === "=" ? v : "";
          });
        });
      },
      getFormulas() {
        const out = [];
        for (let i = 0; i < numRows; i++) {
          const src = self.formulas[row - 1 + i] || [];
          const line = [];
          for (let j = 0; j < numCols; j++) line.push(src[col - 1 + j] || "");
          out.push(line);
        }
        return out;
      },
      setFormulas(vals) {
        vals.forEach((line, i) => {
          const target = (self.rows[row - 1 + i] = self.rows[row - 1 + i] || []);
          const fRow = (self.formulas[row - 1 + i] = self.formulas[row - 1 + i] || []);
          line.forEach((v, j) => {
            fRow[col - 1 + j] = v;
            target[col - 1 + j] = v;
          });
        });
      },
      getFormula() { return (self.formulas[row - 1] || [])[col - 1] || ""; },
      setFormula(f) {
        const target = (self.rows[row - 1] = self.rows[row - 1] || []);
        const fRow = (self.formulas[row - 1] = self.formulas[row - 1] || []);
        fRow[col - 1] = f;
        target[col - 1] = f;
      },
      setValue(v) {
        const target = (self.rows[row - 1] = self.rows[row - 1] || []);
        target[col - 1] = v;
      },
      getValue() { return (self.rows[row - 1] || [])[col - 1]; },
      setNumberFormat() {},
    };
  }
}

const sheets = {};
function renameSheet(sheet, newName) {
  delete sheets[sheet.name];
  sheet.name = newName;
  sheets[newName] = sheet;
}
const props = {};
const sandbox = {
  console,
  PropertiesService: {
    getScriptProperties: () => ({
      getProperty: (k) => props[k] || null,
      setProperty: (k, v) => { props[k] = v; },
    }),
  },
  SpreadsheetApp: {},
  Session: { getScriptTimeZone: () => "Asia/Tokyo" },
  Utilities: {
    // タイムゾーンを固定オフセットで再現する（PL連携の日付ずれを検証するため）
    formatDate: (d, tz, fmt) => {
      const OFFSET = { "Asia/Tokyo": 9, "America/Los_Angeles": -7, UTC: 0 };
      const off = OFFSET[tz] === undefined ? 9 : OFFSET[tz];
      const t = new Date(d.getTime() + off * 3600000);
      const p = (n) => String(n).padStart(2, "0");
      const map = {
        yyyy: String(t.getUTCFullYear()),
        MM: p(t.getUTCMonth() + 1),
        dd: p(t.getUTCDate()),
        HH: p(t.getUTCHours()),
        mm: p(t.getUTCMinutes()),
        ss: p(t.getUTCSeconds()),
      };
      return fmt.replace(/yyyy|MM|dd|HH|mm|ss/g, (k) => map[k]);
    },
    getUuid: () => "uuid",
  },
  DriveApp: {},
  ContentService: { createTextOutput: () => ({ setMimeType: () => ({}) }) },
  ScriptApp: {},
  Logger: { log: () => {} },
};
const FAKE_SS = {
  getId: () => "fake",
  getSheetByName: (n) => sheets[n] || null,
  insertSheet: (n) => (sheets[n] = new FakeSheet(n)),
};
/** PL管理モデル側のスプレッドシート（別ファイル）。連携のテストで使う。 */
const plSheets = {};
const FAKE_PL_SS = {
  getId: () => "pl-model",
  // 実物と同じ条件: スクリプトは Asia/Tokyo、PLモデルは America/Los_Angeles
  getSpreadsheetTimeZone: () => "America/Los_Angeles",
  getSheetByName: (n) => plSheets[n] || null,
  insertSheet: (n) => (plSheets[n] = plSheet(n)),
  getSheets: () => Object.keys(plSheets).map((k) => plSheets[k]),
};
sandbox.SpreadsheetApp.getActiveSpreadsheet = () => FAKE_SS;
sandbox.SpreadsheetApp.openById = (id) => (id === "pl-model" ? FAKE_PL_SS : FAKE_SS);
sandbox.SpreadsheetApp.create = () => FAKE_SS;

/** PL側のシートを作る（getParent が PLスプレッドシートを返すようにする） */
function plSheet(name, rows) {
  const s = new FakeSheet(name, rows);
  s.parent = FAKE_PL_SS;
  s.tz = "America/Los_Angeles";
  return s;
}

// 旧版（英語タブ・英語見出し）で作られた状態を用意し、自動移行を検証する。
// corrections は「AI解析を使った申請」でしか触られないタブなので、
// 全シート移行が走ることの確認用にデータ行つきで置いておく。
sheets["corrections"] = new FakeSheet("corrections", [
  ["createdAt", "vendorKey", "aiVendorKey", "vendor", "date", "amount", "category",
   "description", "aiVendor", "aiDate", "aiAmount", "aiCategory", "aiDescription",
   "corrected", "applicantId", "rawHead"],
  ["2026-07-01T00:00:00Z", "旧店舗", "旧店舗", "旧店舗", "2026-07-01", 700,
   "消耗品費", "移行前の学習", "旧店舗", "2026-07-01", 700, "消耗品費", "移行前の学習",
   "", "yamada", ""],
]);
sheets["expenses"] = new FakeSheet("expenses", [
  ["id", "createdAt", "applicant", "date", "category", "vendor", "amount",
   "description", "status", "reviewedAt", "reviewer", "reviewComment",
   "imageUrl", "imageFileId", "applicantId", "department"],
  ["e1", "2026-07-20T00:00:00Z", "山田太郎", "2026-07-20", "会議費", "旧データ店",
   500, "移行前の申請", "approved", "", "自動承認", "", "", "OLDFILE", "yamada", "本部"],
]);

vm.createContext(sandbox);
SBDate = vm.runInContext("Date", sandbox);
vm.runInContext(fs.readFileSync(__dirname + "/../Code.gs", "utf8"), sandbox);
const g = sandbox; // function 宣言はグローバルオブジェクトに乗る
/** const 宣言はグローバルオブジェクトに乗らないため、式を評価して取り出す */
const val = (expr) => vm.runInContext(expr, sandbox);

/* -------- 0. 旧英語タブ／英語見出しの自動移行と、既存データの読み出し -------- */
// 使われていないタブも含め、全シートがまとめて移行される
g.migrateSheetsIfNeeded_();
["経費データ", "ユーザー", "事業部マスタ"].forEach((n) =>
  assert.ok(sheets[n], `${n} タブが用意される`)
);
["expenses", "users", "departments"].forEach((n) =>
  assert.strictEqual(sheets[n], undefined, `旧名 ${n} のタブは残らない`)
);
// 削除した機能（運賃マスタ・AI学習ログ）のタブは、作りもしないし触りもしない。
// 過去のデータが入っているので、残っていれば中身はそのまま。
assert.strictEqual(sheets["運賃マスタ"], undefined, "運賃マスタは作らない");
assert.strictEqual(sheets["AI学習ログ"], undefined, "AI学習ログは作らない");
assert.strictEqual(sheets["corrections"].rows[0][0], "createdAt", "古い学習ログのタブには触らない");
assert.strictEqual(sheets["corrections"].getLastRow(), 2, "古い学習ログのデータは消えない");
// 2回目は版が一致するので何もしない（毎リクエストの負荷を増やさない）
assert.strictEqual(props.SCHEMA_VERSION, val("SCHEMA_VERSION"));
g.migrateSheetsIfNeeded_();
console.log("✓ migrateSheetsIfNeeded_: 使うシートを一度で移行し、削除した機能のタブには触らない");

const sheet = g.getSheet_();
assert.strictEqual(sheet.getName(), "経費データ", "タブ名が日本語へリネームされる");
assert.strictEqual(sheets["expenses"], undefined, "旧名のタブは残らない");
assert.strictEqual(
  sheet.rows[0].join(","),
  val("EXPENSE_COLUMNS").map((c) => c[1]).join(","),
  "1行目が日本語見出しに置き換わる（列が増えた場合も追記される）"
);
assert.ok(
  sheet.rows[0].join(",").startsWith("申請ID,申請日時,申請者,利用日,科目,支払先,金額,摘要"),
  "先頭の見出しは日本語"
);
assert.ok(
  sheet.rows[0].indexOf("運賃照合") > 0,
  "旧シートにも新しい列（運賃照合）の見出しが追記される"
);
// 移行前に入っていた行は、そのまま同じ内部キーで読み出せる
const migrated = g.rowsToRecords_(sheet)[0];
assert.strictEqual(migrated.id, "e1");
assert.strictEqual(migrated.applicant, "山田太郎");
assert.strictEqual(migrated.amount, 500);
assert.strictEqual(migrated.department, "本部");
assert.strictEqual(migrated.imageFileId, "OLDFILE");
// 2回目の呼び出しでも壊れない（見出しは日本語のまま、データ行は増えない）
assert.strictEqual(g.getSheet_().rows.length, 2);
// 日本語見出し・英語見出しのどちらからでも内部キーへ解決できる
assert.strictEqual(
  g.headerKeys_(["利用日", "金額", "領収書ファイルID"], val("EXPENSE_COLUMNS")).join(","),
  "date,amount,imageFileId"
);
assert.strictEqual(
  g.headerKeys_(["date", "amount", "imageFileId"], val("EXPENSE_COLUMNS")).join(","),
  "date,amount,imageFileId"
);
// 事業部マスタは初回作成時だけ既定値を入れる
assert.strictEqual(g.getDepartmentsSheet_().rows[0][0], "事業部名");
assert.ok(g.listDepartments_().indexOf("BAR") >= 0);
assert.strictEqual(g.listDepartments_().length, val("DEFAULT_DEPARTMENTS").length);
g.getDepartmentsSheet_(); // 2回目でシードが重複しないこと
assert.strictEqual(g.listDepartments_().length, val("DEFAULT_DEPARTMENTS").length);
console.log("✓ 旧英語タブ・英語見出しを自動で日本語へ移行し、既存データも読める");

/* -------- 10.5 必須項目が取れなかったときだけ丁寧に読み直す（段階的エスカレーション） -------- */
// 1回目は速度優先の短い書き起こしで読む。金額・日付が欠けたときだけ、行数を
// 増やして（設定があれば上位プロバイダで）読み直す。大半の申請は1回で終わる。
assert.strictEqual(g.needsEscalation_({ amount: 1200, date: "2026-08-01" }), false);
assert.strictEqual(g.needsEscalation_({ amount: 0, date: "2026-08-01" }), true, "金額0は読めていない");
assert.strictEqual(g.needsEscalation_({ amount: 1200, date: "" }), true, "日付なしは読めていない");
assert.strictEqual(g.needsEscalation_(null), true);

// (a) 読めていれば読み直さない（1回で終わる）
props.GEMINI_API_KEY = "dummy";
let res;
let seen = [];
const recordingStub = (byCall) => (b, opts) => {
  seen.push({ lines: (opts || {}).lines, provider: (opts || {}).provider, model: (opts || {}).model });
  return { fields: Object.assign({}, byCall(seen.length)), model: "stub" };
};
g.analyzeWithGemini_ = recordingStub(() => ({
  date: "2026-08-01", amount: 980, vendor: "読めた店", category: "その他", description: "飲食",
}));
res = g.actionAnalyzeReceipt_({ token: "", imageBase64: "x" });
assert.strictEqual(seen.length, 1, "読めていれば1回で終わる");
assert.strictEqual(res.escalated, false);
assert.strictEqual(seen[0].lines, 12, "1回目は速度優先の行数");

// (b) 金額が取れなければ、行数を増やして読み直す（プロバイダ未設定なので同じ無料枠のまま）
seen = [];
g.analyzeWithGemini_ = recordingStub((n) =>
  n === 1
    ? { date: "", amount: 0, vendor: "", category: "その他", description: "" }
    : { date: "2026-08-02", amount: 3300, vendor: "難しい店", category: "会議費", description: "打合せ" }
);
res = g.actionAnalyzeReceipt_({ token: "", imageBase64: "x" });
assert.strictEqual(seen.length, 2, "読めなければ1回だけ読み直す");
assert.strictEqual(seen[1].lines, 24, "読み直しは根拠を厚くする");
assert.strictEqual(seen[1].provider, "", "プロバイダ未設定なら同じプロバイダのまま（追加課金なし）");
assert.strictEqual(res.escalated, true);
assert.strictEqual(res.fields.amount, 3300, "読み直しの結果を採用する");

// (c) 読み直しても取れなければ、1回目の結果でそのまま応答する（エラーにしない）
seen = [];
g.analyzeWithGemini_ = recordingStub(() => ({
  date: "", amount: 0, vendor: "", category: "その他", description: "",
}));
res = g.actionAnalyzeReceipt_({ token: "", imageBase64: "x" });
assert.strictEqual(seen.length, 2);
assert.strictEqual(res.escalated, false, "読み直しでも取れなければ採用しない");
assert.strictEqual(res.ok, true, "読めなくてもエラーにしない（手入力で申請できる）");

// (d) 読み直しが例外で落ちても、1回目の結果で応答する
seen = [];
g.analyzeWithGemini_ = (b, opts) => {
  seen.push(opts || {});
  if (seen.length > 1) throw new Error("503 overloaded");
  return { fields: { date: "2026-08-03", amount: 0, vendor: "店", category: "その他", description: "" }, model: "stub" };
};
res = g.actionAnalyzeReceipt_({ token: "", imageBase64: "x" });
assert.strictEqual(res.ok, true);
assert.strictEqual(res.escalated, false);

// (e) OCR_ESCALATE_PROVIDER を設定すると、読み直しだけそちらへ回る
props.ANTHROPIC_API_KEY = "dummy-claude";
props.OCR_ESCALATE_PROVIDER = "claude";
props.OCR_ESCALATE_MODEL = "claude-haiku-4-5";
seen = [];
let claudeCalls = 0;
g.analyzeWithGemini_ = recordingStub(() => ({
  date: "", amount: 0, vendor: "", category: "その他", description: "",
}));
g.analyzeWithClaude_ = (b, opts) => {
  claudeCalls++;
  seen.push({ lines: (opts || {}).lines, provider: "claude", model: (opts || {}).model });
  return { fields: { date: "2026-08-04", amount: 5400, vendor: "手書きの店", category: "その他", description: "" }, model: "claude-haiku-4-5" };
};
res = g.actionAnalyzeReceipt_({ token: "", imageBase64: "x" });
assert.strictEqual(seen.length, 2, "1回目は無料枠、2回目だけ上位へ");
assert.strictEqual(claudeCalls, 1, "上位プロバイダは読めなかったときだけ呼ぶ");
assert.strictEqual(seen[1].model, "claude-haiku-4-5", "読み直し用モデルを使う");
assert.strictEqual(res.fields.amount, 5400);
assert.strictEqual(res.escalated, true);

// (f) キーが無ければ、設定されていても上位へは回さない（同じプロバイダで読み直す）
delete props.ANTHROPIC_API_KEY;
assert.strictEqual(g.resolveEscalation_().provider, "", "キーが無ければ上位へ回さない");
delete props.OCR_ESCALATE_PROVIDER;
delete props.OCR_ESCALATE_MODEL;
assert.strictEqual(g.resolveEscalation_().provider, "", "未設定が既定（課金しない）");
props.ANTHROPIC_API_KEY = "dummy-claude";
console.log("✓ 必須項目が取れないときだけ読み直し、設定があれば上位プロバイダへ回す");

/* -------- 16.9 領収書ファイル名の採番 -------- */
// 月フォルダの全ファイルを走査すると、その月の申請が増えるほど保存が遅くなる。
// ドライブ側で「同じ日・同じ申請者」に絞ってから数えていることを確認する。
function fakeFolder(names) {
  const queries = [];
  return {
    queries: queries,
    getFiles() {
      throw new Error("フォルダ全体の走査は行わない（searchFiles で絞ること）");
    },
    searchFiles(q) {
      queries.push(q);
      // DriveApp の `title contains 'x'` を再現する（部分一致）
      const m = /^title contains '(.*)'$/.exec(q);
      const needle = m ? m[1].replace(/\\'/g, "'") : "";
      const hits = names.filter((n) => n.indexOf(needle) >= 0);
      let i = 0;
      return {
        hasNext: () => i < hits.length,
        next: () => ({ getName: () => hits[i++] }),
      };
    },
  };
}

let folder = fakeFolder([
  "2026-08-14_山田太郎_001.jpg",
  "2026-08-14_山田太郎_002.jpg",
  "2026-08-14_鈴木花子_001.jpg", // 別の申請者
  "2026-08-13_山田太郎_001.jpg", // 別の日
]);
assert.strictEqual(
  g.buildReceiptFileName_(folder, "2026-08-14", "山田太郎", "image/jpeg"),
  "2026-08-14_山田太郎_003.jpg",
  "同じ日・同じ申請者の続きから採番する"
);
assert.strictEqual(
  folder.queries[0],
  "title contains '2026-08-14_山田太郎_'",
  "ドライブ側で絞り込んでから数える"
);

folder = fakeFolder([]);
assert.strictEqual(
  g.buildReceiptFileName_(folder, "2026-08-14", "山田太郎", "image/png"),
  "2026-08-14_山田太郎_001.png",
  "1件目は 001・拡張子は mime に従う"
);

// 検索語に使えない文字が名前に入っていても、クエリが壊れない
folder = fakeFolder([]);
g.buildReceiptFileName_(folder, "2026-08-14", "O'Brien 太郎", "image/jpeg");
assert.ok(
  folder.queries[0].indexOf("\\'") > 0,
  "アポストロフィはエスケープする"
);
console.log("✓ buildReceiptFileName_: 同じ日・同じ申請者だけを絞って採番する");

/* -------- 18. モデル候補の組み立てと、全滅時のエラー内容 -------- */
assert.strictEqual(
  g.buildModelCandidates_("").join(","),
  val("GEMINI_FALLBACK_MODELS").join(","),
  "未設定なら現行の flash 系を新しい順に試す"
);
assert.strictEqual(
  g.buildModelCandidates_("gemini-3.6-flash")[0],
  "gemini-3.6-flash",
  "設定値が最優先"
);
assert.strictEqual(
  g.buildModelCandidates_("gemini-3.6-flash").filter((m) => m === "gemini-3.6-flash").length,
  1,
  "設定値が候補と重複しても1回だけ"
);
assert.ok(
  val("GEMINI_FALLBACK_MODELS").indexOf("gemini-2.5-flash") < 0,
  "新しいAPIキーで404になる旧モデルは候補に含めない"
);
assert.ok(
  /-latest$/.test(val("GEMINI_FALLBACK_MODELS")[0]),
  "モデル名の変更に強い別名（-latest）を最初に試す"
);

/* -------- 19. 使えるモデルの選別と優先順位 -------- */
// 実際のAPIキーが返した一覧（バージョン固定名が使えないキーの例）
const REAL_LIST = [
  "gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.5-flash-preview-tts",
  "gemini-flash-latest", "gemini-flash-lite-latest", "gemini-pro-latest",
  "gemini-2.5-flash-lite", "gemini-2.5-flash-image", "gemini-3-flash-preview",
  "gemini-3.1-pro-preview", "gemini-3.1-pro-preview-customtools", "embedding-001",
];
const picked = g.pickUsableGeminiModels_(REAL_LIST);
assert.strictEqual(picked[0], "gemini-flash-latest", "別名のflashを最優先");
assert.ok(picked.indexOf("gemini-flash-lite-latest") < picked.indexOf("gemini-2.5-flash"),
  "別名は個別バージョンより優先");
["gemini-2.5-flash-preview-tts", "gemini-2.5-flash-image",
 "gemini-3.1-pro-preview-customtools", "embedding-001"].forEach((n) =>
  assert.ok(picked.indexOf(n) < 0, `${n} は文章生成用ではないので除外`)
);
console.log("✓ pickUsableGeminiModels_: 別名を優先し、読み上げ・画像用モデルは除外する");

/* -------- 20. 候補が全滅しても、使えるモデルを調べて自動で復旧する -------- */
sandbox.UrlFetchApp = {
  fetch: () => ({
    getResponseCode: () => 200,
    getContentText: () =>
      JSON.stringify({
        models: REAL_LIST.map((n) => ({
          name: "models/" + n,
          supportedGenerationMethods: n === "embedding-001" ? ["embedContent"] : ["generateContent"],
        })),
      }),
  }),
};
// 既定の候補（-latest 等）はすべて 429 で、一覧から拾ったモデルだけ成功する状況
let attempted = [];
const recovered = g.tryGeminiModels_("運賃照合", "dummy", "", function (model) {
  attempted.push(model);
  if (model === "gemini-2.5-flash") return { ok: true, model };
  throw new Error("運賃照合エラー(" + model + " / HTTP 429): You exceeded your current quota");
});
assert.strictEqual(recovered.model, "gemini-2.5-flash", "候補外のモデルで復旧できる");
assert.ok(
  attempted.slice(0, 3).join(",") === val("GEMINI_FALLBACK_MODELS").join(","),
  "まず既定の候補を順に試している"
);
assert.ok(attempted.length > 3, "全滅後に一覧から拾い直して追い試ししている");
console.log("✓ tryGeminiModels_: 候補が全滅しても、使えるモデルを調べて自動で復旧する");

/* -------- 21. それでも駄目なら、全モデルの失敗理由と使えるモデルを返す -------- */
attempted = [];
let thrown = "";
try {
  g.tryGeminiModels_("運賃照合", "dummy", "", function (model) {
    attempted.push(model);
    throw new Error("運賃照合エラー(" + model + " / HTTP 429): You exceeded your current quota");
  });
} catch (err) {
  thrown = String(err.message);
}
assert.ok(thrown.indexOf("gemini-flash-latest → ") > 0, "各モデルの失敗理由を含む");
assert.ok(thrown.indexOf("gemini-3-flash-preview → ") > 0, "2つ目以降の失敗理由も含む");
assert.ok(thrown.indexOf("無料枠の上限") > 0, "クォータ超過時は時間をおく／手動登録を案内する");
assert.ok(attempted.length <= 6, "追い試しは上限3件までで、無限に試さない");

// limit: 0（無料枠の割当が最初から無い）は、モデルを変えても解決しないと伝える
const zeroLimit = g.buildModelFailureMessage_("運賃照合", REAL_LIST, [
  "gemini-flash-latest → HTTP 429: Quota exceeded for metric: ... limit: 0, model: gemini-3.1-pro",
]);
assert.ok(zeroLimit.indexOf("モデルを変えても解決しません") > 0, "原因を明示する");
assert.ok(zeroLimit.indexOf("課金を有効に") > 0, "課金の有効化を案内する");
assert.ok(zeroLimit.indexOf("運賃マスタに区間") > 0, "無料で確実な代替手段を案内する");
assert.ok(
  zeroLimit.indexOf("使えるモデル") < 0,
  "モデル変更では解決しないので、モデル一覧は出さない"
);

// APIキー自体が無効な場合は、他のモデルを試さず即座に止める
attempted = [];
try {
  g.tryGeminiModels_("AI解析", "dummy", "", function (model) {
    attempted.push(model);
    throw new Error("AI解析エラー: API_KEY_INVALID");
  });
} catch (err) {
  thrown = String(err.message);
}
assert.strictEqual(attempted.length, 1, "キーが無効ならモデルを試し続けない");
assert.ok(thrown.indexOf("API_KEY_INVALID") >= 0);
console.log("✓ 全滅時の案内と、APIキー無効時の即時中断");

/* -------- 利用コードでのログイン（軽量版） -------- */
let bossPassword = "adminpass";
{
  const nodeCrypto = require("crypto");
  // 認証まわりで使う Utilities を node の crypto で再現する
  sandbox.Utilities.getUuid = () => nodeCrypto.randomUUID();
  sandbox.Utilities.DigestAlgorithm = { SHA_256: "sha256" };
  sandbox.Utilities.Charset = { UTF_8: "utf8" };
  sandbox.Utilities.computeDigest = (alg, text) =>
    Array.from(nodeCrypto.createHash("sha256").update(String(text), "utf8").digest()).map((b) => (b > 127 ? b - 256 : b));
  sandbox.Utilities.computeHmacSha256Signature = (text, key) =>
    nodeCrypto.createHmac("sha256", key).update(text).digest();
  sandbox.Utilities.base64EncodeWebSafe = (data) => Buffer.from(data).toString("base64url");
  sandbox.Utilities.base64DecodeWebSafe = (s) => Buffer.from(s, "base64url");
  sandbox.Utilities.newBlob = (bytes) => ({ getDataAsString: () => Buffer.from(bytes).toString("utf8") });
  let slept = 0;
  sandbox.Utilities.sleep = () => { slept++; };

  const usersSheet = sheets["ユーザー"];
  usersSheet.rows.length = 1; // 見出しだけにする
  const salt0 = "s0";
  usersSheet.appendRow(["boss", "管理者", g.hashPassword_("adminpass", salt0), salt0, "admin", true, "", "本部"]);
  const adminToken = g.actionLogin_({ username: "boss", password: "adminpass" }).token;

  // コードの形: 8桁・紛らわしい文字なし
  for (let i = 0; i < 50; i++) {
    assert.ok(/^[2-9A-HJ-NP-Z]{8}$/.test(g.generateAccessCode_()), "コードの文字種と桁数");
  }
  assert.strictEqual(g.normalizeAccessCode_(" abcd-efgh "), "ABCDEFGH", "小文字・ハイフン・空白を吸収");

  // 一般ユーザーは発行できない
  const issued = g.actionIssueAccessCode_({ token: adminToken, user: { displayName: "山田", department: "人材" } });
  assert.ok(/^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/.test(issued.code), "表示用は ABCD-EFGH: " + issued.code);
  const row = usersSheet.rows[usersSheet.rows.length - 1];
  assert.strictEqual(row[0], issued.username, "ユーザーIDは自動で振られる");
  assert.ok(/^u[2-9a-hj-np-z]{6}$/.test(row[0]), "ユーザーIDの形: " + row[0]);
  assert.strictEqual(row[1], "山田");
  assert.strictEqual(row[4], "user");
  assert.strictEqual(row[7], "人材");
  assert.ok(String(row[2]).indexOf(issued.code.replace("-", "")) < 0, "コードはそのまま保存しない");
  const userToken = g.actionLoginCode_({ code: issued.code.replace("-", "") }).token;
  assert.throws(
    () => g.actionIssueAccessCode_({ token: userToken, user: { displayName: "勝手に" } }),
    /forbidden/,
    "一般ユーザーは発行できない"
  );

  // コードだけでログインでき、入力のゆれを吸収する
  const login = g.actionLoginCode_({ code: issued.code.toLowerCase() });
  assert.strictEqual(login.user.username, issued.username);
  assert.strictEqual(login.user.displayName, "山田");
  assert.ok(login.token, "トークンが出る");
  // 通常版の ID+パスワードでも、コードがパスワードとして通る
  assert.ok(g.actionLogin_({ username: issued.username, password: issued.code.replace("-", "") }).token);

  // 違うコードは弾き、遅らせる
  assert.throws(() => g.actionLoginCode_({ code: "2222-2222" }), /利用コードが違います/);
  assert.throws(() => g.actionLoginCode_({ code: "adminpass" }), /利用コードが違います/, "コードの形でない入力は照合しない");
  assert.strictEqual(slept, 2, "失敗のたびに待つ");

  // 再発行すると前のコードは使えない
  const again = g.actionIssueAccessCode_({ token: adminToken, user: { username: issued.username } });
  assert.notStrictEqual(again.code, issued.code);
  assert.throws(() => g.actionLoginCode_({ code: issued.code }), /利用コードが違います/, "古いコードは無効");
  assert.strictEqual(g.actionLoginCode_({ code: again.code }).user.username, issued.username);
  assert.throws(
    () => g.actionIssueAccessCode_({ token: adminToken, user: { username: "nobody" } }),
    /見つかりません/
  );

  // 無効化した利用者はコードが合っていても入れない
  g.actionUpsertUser_({ token: adminToken, user: { username: issued.username, active: false } });
  assert.throws(() => g.actionLoginCode_({ code: again.code }), /無効化/);

  // 管理者は自分も含めて発行でき、名前なしの新規作成は弾く
  assert.throws(() => g.actionIssueAccessCode_({ token: adminToken, user: {} }), /名前/);
  const adminCode = g.actionIssueAccessCode_({ token: adminToken, user: { username: "boss" } });
  bossPassword = adminCode.code.replace("-", ""); // 自分に発行したのでパスワードはコードに変わる
  assert.strictEqual(g.actionLoginCode_({ code: adminCode.code }).user.role, "admin");
}
console.log("✓ 利用コード: 管理者が発行・再発行し、コードだけでログインでき、無効化・古いコードは弾く");

/* -------- 利用者の事業部は複数持てる -------- */
{
  assert.deepStrictEqual(Array.from(g.splitDepartments_("人材, BAR、人材,")), ["人材", "BAR"], "区切り・空白・重複を吸収");
  assert.deepStrictEqual(Array.from(g.splitDepartments_(["BAR", " 本部 ", ""])), ["BAR", "本部"], "配列も受け取る");
  assert.strictEqual(g.joinDepartments_(""), "");
  const adminToken = g.actionLogin_({ username: "boss", password: bossPassword }).token;
  const r = g.actionIssueAccessCode_({ token: adminToken, user: { displayName: "兼務", department: ["人材", "BAR"] } });
  const usersSheet = sheets["ユーザー"];
  const row = usersSheet.rows.find((x) => x[0] === r.username);
  assert.strictEqual(row[7], "人材,BAR", "シートにはカンマ区切りで入る");
  g.actionUpsertUser_({ token: adminToken, user: { username: r.username, department: ["BAR", "本部"] } });
  assert.strictEqual(row[7], "BAR,本部", "管理者が事業部を変えられる");
}
console.log("✓ 利用者の事業部: 複数を正規の形で保存し、管理者が変えられる");

/* -------- ログインの有効期間・失効・更新、月ごとの一覧 -------- */
{
  const DAY = 24 * 3600 * 1000;
  const decode = (t) => JSON.parse(Buffer.from(t.split(".")[0], "base64url").toString("utf8"));
  // 時刻を進められるようにする（トークンの期限は Date.now() で判定している）
  sandbox.__offset = 0;
  vm.runInContext("(function(){var o=Date.now;Date.now=function(){return o.call(Date)+__offset;};})()", sandbox);

  const adminToken = g.actionLogin_({ username: "boss", password: bossPassword }).token;
  const issuedLeft = decode(adminToken).e - Date.now();
  assert.ok(Math.abs(issuedLeft - 30 * DAY) < 60000, "有効期間は30日");

  // 利用コードを再発行すると、古いログインは使えなくなる
  const a = g.actionIssueAccessCode_({ token: adminToken, user: { displayName: "期限テスト" } });
  const first = g.actionLoginCode_({ code: a.code }).token;
  assert.strictEqual(g.requireUser_(first, false).username, a.username);
  const b = g.actionIssueAccessCode_({ token: adminToken, user: { username: a.username } });
  assert.strictEqual(b.token, undefined, "他人に発行したときはトークンを返さない");
  assert.throws(() => g.requireUser_(first, false), /unauthorized/, "再発行で古いログインが切れる");
  const second = g.actionLoginCode_({ code: b.code }).token;
  assert.strictEqual(g.requireUser_(second, false).username, a.username, "新しいコードのログインは通る");

  // 管理者がパスワードを設定し直すと、その人の古いトークンは切れる
  const reset = g.actionUpsertUser_({ token: adminToken, user: { username: a.username, password: "newpass123" } });
  assert.strictEqual(reset.token, undefined, "他人のパスワード変更ではトークンを返さない");
  assert.throws(() => g.requireUser_(second, false), /unauthorized/, "変更前のトークンは切れる");
  const pwRes = g.actionLogin_({ username: a.username, password: "newpass123" });
  assert.strictEqual(g.requireUser_(pwRes.token, false).username, a.username, "新しいパスワードでログインできる");

  // 自分自身のコードを発行し直したときは、新しいトークンが返って締め出されない
  const adm2 = g.actionIssueAccessCode_({ token: adminToken, user: { displayName: "管理者2", role: "admin" } });
  const adm2Token = g.actionLoginCode_({ code: adm2.code }).token;
  const self = g.actionIssueAccessCode_({ token: adm2Token, user: { username: adm2.username } });
  assert.ok(self.token, "自分への発行ではトークンを返す");
  assert.throws(() => g.requireUser_(adm2Token, false), /unauthorized/);
  assert.strictEqual(g.requireUser_(self.token, true).role, "admin", "返ったトークンで管理者のまま");

  // 管理者が自分のパスワードを upsertUser で変えたときも、新しいトークンが返る
  const up = g.actionUpsertUser_({ token: self.token, user: { username: adm2.username, password: "selfpass123" } });
  assert.ok(up.token, "自分のパスワード変更ではトークンを返す");
  assert.throws(() => g.requireUser_(self.token, false), /unauthorized/);
  assert.strictEqual(g.requireUser_(up.token, true).role, "admin");
  const other = g.actionUpsertUser_({ token: up.token, user: { username: a.username, displayName: "名前だけ変更" } });
  assert.strictEqual(other.token, undefined, "他人の更新ではトークンを返さない");

  // 世代を持たない旧トークンは、期限まで受け付ける
  const legacy = g.issueToken_({ username: a.username, displayName: "旧", role: "user" }, undefined);
  assert.strictEqual(g.requireUser_(legacy, false).username, a.username, "旧形式のトークンも通る");

  // 起動（bootstrap）で、残りが半分を切っていれば新しいトークンが返る
  const fresh = g.actionLogin_({ username: a.username, password: "newpass123" }).token;
  assert.strictEqual(g.actionBootstrap_({ token: fresh }).token, undefined, "発行直後は更新しない");
  sandbox.__offset = 20 * DAY;
  const renewed = g.actionBootstrap_({ token: fresh }).token;
  assert.ok(renewed, "残り10日（半分未満）なら更新する");
  // （テスト側の Date.now() は進めていないので、進めた20日ぶんを足して比べる）
  assert.ok(Math.abs(decode(renewed).e - (Date.now() + 20 * DAY) - 30 * DAY) < 60000, "更新後はまた30日");
  sandbox.__offset = 31 * DAY;
  assert.throws(() => g.requireUser_(fresh, false), /unauthorized/, "元のトークンは31日目に期限切れ");
  assert.strictEqual(g.requireUser_(renewed, false).username, a.username, "更新したトークンは31日目も有効");
  sandbox.__offset = 0;

  // 月ごとの一覧: その月の分だけ返す。一般ユーザーは自分の分だけ、管理者は全員分
  const H = val("HEADERS");
  const exp = sheets["経費データ"];
  const mk = (id, date, applicantId) => {
    const r = { id: id, date: date, applicantId: applicantId, applicant: applicantId, amount: 100 };
    exp.appendRow(H.map((h) => (r[h] === undefined ? "" : r[h])));
  };
  mk("m1", "2026-10-31", a.username);
  mk("m2", "2026-11-01", a.username);
  mk("m3", "2026-11-30", "other");
  mk("m4", "2026-12-01", a.username);
  const ids = (recs) => recs.map((r) => r.id).filter((i) => /^m\d$/.test(i)).sort().join(",");
  const userU = g.requireUser_(pwRes.token, false);
  const adminU = g.requireUser_(adminToken, true);
  assert.strictEqual(ids(g.recordsForUser_(userU, "2026-11")), "m2", "一般ユーザーは自分のその月だけ");
  assert.strictEqual(ids(g.recordsForUser_(adminU, "2026-11")), "m2,m3", "管理者は全員のその月");
  assert.strictEqual(ids(g.recordsForUser_(userU, "2026-10")), "m1", "月の境目（月末）を落とさない");
  assert.strictEqual(ids(g.recordsForUser_(userU, "")), "m1,m2,m4", "月の指定なしは全期間（従来の動作）");
  assert.strictEqual(ids(g.recordsForUser_(userU, "2026-13")), "m1,m2,m4", "不正な月は全期間として扱う");
  const boot = g.actionBootstrap_({ token: pwRes.token, month: "2026-11" });
  assert.strictEqual(ids(boot.records), "m2", "bootstrap も月で絞る");
  assert.strictEqual(boot.month, "2026-11", "返した範囲を伝える");
  assert.strictEqual(ids(g.actionBootstrap_({ token: pwRes.token }).records), "m1,m2,m4", "month なしの bootstrap は従来どおり");
}
console.log("✓ ログイン30日・失効（再発行/パスワード変更）・更新・月ごとの一覧");

/* -------- 申請の保存・削除と、画面が使うアクション -------- */
{
  const adminToken = g.actionLogin_({ username: "boss", password: bossPassword }).token;
  const admin = g.requireUser_(adminToken, true);
  const exp = sheets["経費データ"];
  const H = val("HEADERS");

  // 複数の事業部を持つ利用者を作る
  const m = g.actionIssueAccessCode_({ token: adminToken, user: { displayName: "兼務の人", department: ["人材", "BAR"] } });
  const mToken = g.actionLoginCode_({ code: m.code }).token;
  const mUser = g.requireUser_(mToken, false);
  const before = exp.rows.length;
  const r1 = g.createExpense_({ id: "x1", date: "2026-11-03", category: "会議費", vendor: "店", amount: 1200, description: "打合せ" }, mUser);
  assert.strictEqual(r1.record.department, "人材", "事業部を選ばなければ割り当ての先頭（「人材,BAR」をそのまま入れない）");
  assert.strictEqual(r1.record.status, "approved", "承認の手続きは無く、申請は計上される");
  assert.strictEqual(r1.record.applicantId, m.username, "申請者はサーバー側で強制する");
  const row = exp.rows[exp.rows.length - 1];
  assert.strictEqual(exp.rows.length, before + 1);
  assert.strictEqual(row.length, H.length, "列の数は変えない（過去の行と位置をそろえる）");
  assert.ok(row.every((v) => v !== undefined), "undefined をシートへ書かない");
  H.filter((h) => /^fare/.test(h)).forEach((h) => assert.strictEqual(row[H.indexOf(h)], "", h + " は空"));
  const r2 = g.createExpense_({ id: "x2", date: "2026-11-04", category: "交通費", vendor: "駅", amount: 300, department: "BAR" }, mUser);
  assert.strictEqual(r2.record.department, "BAR", "選んだ事業部を優先する");

  // 削除: 自分の分だけ。管理者は全件
  const other = g.actionIssueAccessCode_({ token: adminToken, user: { displayName: "別の人" } });
  const otherUser = g.requireUser_(g.actionLoginCode_({ code: other.code }).token, false);
  assert.throws(() => g.deleteExpense_("x1", otherUser), /forbidden/, "他人の申請は消せない");
  assert.strictEqual(g.deleteExpense_("x1", mUser).ok, true, "自分の申請は消せる");
  assert.strictEqual(g.deleteExpense_("x2", admin).ok, true, "管理者は他人の申請も消せる");
  assert.strictEqual(g.deleteExpense_("x1", admin).ok, false, "無い申請は not found");
  assert.ok(!exp.rows.some((r) => r[0] === "x1" || r[0] === "x2"), "行が消えている");

  // doPost: 画面が使うアクションは残り、削除した機能のアクションは unknown action になる
  sandbox.ContentService = {
    createTextOutput: (t) => ({ setMimeType: () => ({ text: t }) }),
    MimeType: { JSON: "JSON" },
  };
  const post = (body) => JSON.parse(g.doPost({ postData: { contents: JSON.stringify(body) } }).text);
  const known = (action) => post({ action: action, token: "" }).error !== "unknown action";
  [
    "status", "bootstrap", "list", "setup", "login", "loginCode", "listUsers", "upsertUser",
    "issueAccessCode", "addDepartment", "deleteDepartment", "analyzeReceipt", "create", "delete",
  ].forEach((a) => assert.ok(known(a), `画面が使う ${a} が残っている`));
  [
    "me", "changePassword", "listDepartments", "lookupFare", "listFares", "upsertFare", "deleteFare",
    "receiptImage", "listVendorMemory", "deleteVendorMemory", "update", "syncPl",
  ].forEach((a) => assert.ok(!known(a), `削除した ${a} は unknown action になる`));
  const st = post({ action: "status" });
  assert.strictEqual(st.ok, true);
  assert.ok(st.features && st.features.bootstrap && st.features.list, "疎通確認が features を読める");
  assert.strictEqual(st.autoApprove, undefined, "承認の設定は返さない");
}
console.log("✓ 申請の保存（事業部の既定・列の位置）・削除の権限・画面が使うアクションの一覧");

console.log("\nすべて成功");
