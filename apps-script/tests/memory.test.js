/**
 * Code.gs のAI解析学習ロジック（店舗別の補正記憶）の回帰テスト。
 *
 *   node apps-script/tests/memory.test.js
 *
 * Apps Script のサービスを最小限スタブして Code.gs を読み込み、学習の記録・
 * 辞書補正・誤読事例のフィードバックが期待どおり動くかを確認する。
 * 依存ライブラリなし・Google への接続なしで実行できる。
 */
const fs = require("fs");
const vm = require("vm");
const assert = require("assert");

// ---- 最小限の GAS スタブ ----
/**
 * タイムゾーンの再現。スプレッドシートは「シートのTZで見た日時」を保存し、
 * Apps Script が読み出すときは「スクリプトのTZ」で解釈される。この往復で
 * 日付が1日ずれる事故が実際に起きたため、テストでも往復を再現する。
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
/** シートへ日付を保存 → 読み出す、の往復 */
const roundTripDate = (d, sheetTz) => instantFor(shownParts(d, sheetTz), SCRIPT_TZ);

/**
 * シート上での表示（検証用）。
 * シートから読み出した値は「表示どおりの日時をスクリプトTZで解釈した瞬間」なので、
 * 表示を知りたいときはスクリプトTZで見る。
 */
const displayed = (v) => shownIn(v, SCRIPT_TZ);
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
  /** 日付を書くと、シートのTZを経由した値になって読み戻される */
  store(v) {
    // vm の中と外で Date が別物なので instanceof は使えない
    const isDateLike = !!v && typeof v.getTime === "function";
    return this.tz && isDateLike ? roundTripDate(v, this.tz) : v;
  }
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
            target[col - 1 + j] = self.store(v);
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
        target[col - 1] = self.store(v);
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
// 使われていないタブ（corrections）も含め、全シートがまとめて移行される
g.migrateSheetsIfNeeded_();
["経費データ", "ユーザー", "事業部マスタ", "AI学習ログ", "運賃マスタ"].forEach((n) =>
  assert.ok(sheets[n], `${n} タブが用意される`)
);
["expenses", "users", "departments", "corrections"].forEach((n) =>
  assert.strictEqual(sheets[n], undefined, `旧名 ${n} のタブは残らない`)
);
assert.strictEqual(
  sheets["AI学習ログ"].rows[0][0],
  "記録日時",
  "AI解析を使っていなくても学習ログの見出しが日本語化される"
);
// 移行前に入っていた学習ログもそのまま読める
const oldMemory = g.buildVendorMemory_(g.vendorKey_("旧店舗"));
assert.ok(oldMemory, "移行前の学習データが引き続き使える");
assert.strictEqual(oldMemory.category.value, "消耗品費");
// 2回目は版が一致するので何もしない（毎リクエストの負荷を増やさない）
assert.strictEqual(props.SCHEMA_VERSION, val("SCHEMA_VERSION"));
g.migrateSheetsIfNeeded_();
assert.strictEqual(sheets["AI学習ログ"].getLastRow(), 2, "重複して行が増えない");
console.log("✓ migrateSheetsIfNeeded_: 使われていないタブも含め全シートを一度で移行する");

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

/* ---------------- 1. 店名キーの表記ゆれ吸収 ---------------- */
assert.strictEqual(g.vendorKey_("株式会社ローソン 渋谷店"), g.vendorKey_("ローソン渋谷店"));
assert.strictEqual(g.vendorKey_("ＳＥＶＥＮ－ＥＬＥＶＥＮ"), g.vendorKey_("seven eleven"));
assert.strictEqual(g.vendorKey_("  "), "");
assert.notStrictEqual(g.vendorKey_("ローソン渋谷店"), g.vendorKey_("ローソン新宿店"));
console.log("✓ vendorKey_: 法人格・全半角・空白・記号を吸収し、別店舗は区別する");

/* ---------------- 2. 学習ログの記録 ---------------- */
// AIが科目と金額を間違え、利用者が修正した申請
g.logCorrection_(
  { vendor: "カフェベローチェ 渋谷店", date: "2026-07-01", amount: 1320, category: "会議費", description: "打合せ" },
  { vendor: "カフェヘローチェ渋谷店", date: "2026-07-01", amount: 1200, category: "交際費", description: "飲食", rawText: "小計 1200\n合計 1320" },
  "yamada"
);
// 2回目: 同じ店・同じ修正（摘要の学習に必要な2回目）
g.logCorrection_(
  { vendor: "カフェベローチェ 渋谷店", date: "2026-07-05", amount: 880, category: "会議費", description: "打合せ" },
  { vendor: "カフェベローチェ渋谷店", date: "2026-07-05", amount: 880, category: "交際費", description: "飲食", rawText: "合計 880" },
  "yamada"
);
assert.strictEqual(sheets["AI学習ログ"].getLastRow(), 4); // ヘッダー + 移行前1件 + 2件
console.log("✓ logCorrection_: 申請ごとに1行、ヘッダー付きで記録される");

/* ---------------- 3. 誤読した店名でも過去の学習を引ける ---------------- */
const memory = g.buildVendorMemory_(g.vendorKey_("カフェヘローチェ渋谷店"));
assert.ok(memory, "AIの誤った店名表記でも aiVendorKey で履歴に届く");
assert.strictEqual(memory.count, 2);
assert.strictEqual(memory.vendor.value, "カフェベローチェ 渋谷店");
assert.strictEqual(memory.category.value, "会議費");
assert.strictEqual(memory.description.count, 2);
console.log("✓ buildVendorMemory_: 誤読した店名からでも確定値の辞書を引ける");

/* ---------------- 4. ①辞書補正 ---------------- */
const fields = { date: "2026-07-20", amount: 700, vendor: "カフェヘローチェ渋谷店", category: "交際費", description: "飲食" };
const applied = g.applyVendorMemory_(fields, memory);
assert.strictEqual(applied.join(","), "店名,科目,摘要");
assert.strictEqual(fields.vendor, "カフェベローチェ 渋谷店");
assert.strictEqual(fields.category, "会議費");
assert.strictEqual(fields.description, "打合せ");
assert.strictEqual(fields.amount, 700, "金額は毎回変わるので辞書では触らない");
assert.strictEqual(fields.date, "2026-07-20", "日付も辞書では触らない");
console.log("✓ applyVendorMemory_: 店名・科目・摘要のみ補正し、金額と日付は温存する");

/* ---------------- 5. 摘要は1回だけの履歴では学習しない ---------------- */
g.logCorrection_(
  { vendor: "はじめての店", date: "2026-07-10", amount: 500, category: "消耗品費", description: "付箋を購入" },
  { vendor: "はじめての店", date: "2026-07-10", amount: 500, category: "その他", description: "物品購入" },
  "yamada"
);
const once = g.buildVendorMemory_(g.vendorKey_("はじめての店"));
const f2 = { date: "2026-07-22", amount: 300, vendor: "はじめての店", category: "その他", description: "物品購入" };
assert.strictEqual(g.applyVendorMemory_(f2, once).join(","), "科目");
assert.strictEqual(f2.description, "物品購入", "1回だけの摘要は使い回さない");
console.log("✓ 摘要は2回以上一致した場合のみ学習（単発の摘要を使い回さない）");

/* ---------------- 6. ②誤読事例のヒント生成 ---------------- */
const hint = g.buildCorrectionHint_(memory);
assert.ok(hint.includes("金額を 1200 と読んだが、正しくは 1320 だった"));
assert.ok(hint.includes("店名を「カフェヘローチェ渋谷店」と読んだが"));
assert.ok(hint.includes("小計 1200 合計 1320"), "根拠の書き起こしも添える");
assert.ok(g.buildReceiptPrompt_(hint).endsWith(hint), "プロンプト末尾にヒントが付く");
assert.ok(!g.buildReceiptPrompt_().includes("過去に実際にあった誤読"), "履歴が無ければ素のプロンプト");
console.log("✓ buildCorrectionHint_: 誤読事例をプロンプト末尾へ添付できる");

/* ---------------- 7. 誤読が無い店舗では読み直しを起こさない ---------------- */
g.logCorrection_(
  { vendor: "正確な店", date: "2026-07-11", amount: 1000, category: "消耗品費", description: "備品" },
  { vendor: "正確な店", date: "2026-07-11", amount: 1000, category: "消耗品費", description: "備品" },
  "yamada"
);
assert.strictEqual(g.buildVendorMemory_(g.vendorKey_("正確な店")).mistakes.length, 0);
console.log("✓ 誤読の無い店舗は mistakes 0 件（＝2回目のAI呼び出しをしない）");

/* ---------------- 8. 管理者向け一覧と削除 ---------------- */
const list = g.actionListVendorMemory_({ token: "" });
const cafe = list.items.find((i) => i.vendor === "カフェベローチェ 渋谷店");
assert.strictEqual(cafe.count, 2);
assert.strictEqual(cafe.category, "会議費");
assert.strictEqual(cafe.mistakes, 1);
assert.strictEqual(list.items.find((i) => i.vendor === "はじめての店").description, "", "単発の摘要は一覧にも出さない");

const before = sheets["AI学習ログ"].getLastRow();
const del = g.actionDeleteVendorMemory_({ token: "", key: cafe.key });
assert.strictEqual(del.deleted, 2);
assert.strictEqual(sheets["AI学習ログ"].getLastRow(), before - 2);
assert.strictEqual(g.buildVendorMemory_(cafe.key), null, "削除後は学習が初期状態に戻る");
assert.ok(g.buildVendorMemory_(g.vendorKey_("正確な店")), "他店舗の学習は残る");
console.log("✓ listVendorMemory / deleteVendorMemory: 店舗単位で確認・リセットできる");

/* ---------------- 9. 店名が無い申請は学習しない ---------------- */
const n = sheets["AI学習ログ"].getLastRow();
g.logCorrection_(
  { vendor: "", date: "2026-07-12", amount: 300, category: "その他", description: "" },
  { vendor: "", date: "2026-07-12", amount: 300, category: "その他", description: "" },
  "yamada"
);
assert.strictEqual(sheets["AI学習ログ"].getLastRow(), n, "店名なしは次回の手がかりが無いので記録しない");
console.log("✓ 店名が取れない申請は学習ログに残さない");

/* -------- 10. actionAnalyzeReceipt_: 読み直し＋辞書補正の一連の流れ -------- */
props.GEMINI_API_KEY = "dummy";
const calls = [];
const stubAnalyze = (fields) => (body, hint) => {
  calls.push(String(hint || ""));
  return { fields: Object.assign({}, fields), model: "stub" };
};

// (a) 学習が無い店舗 → 1回だけ呼ばれ、補正もされない
calls.length = 0;
g.analyzeWithGemini_ = stubAnalyze({
  date: "2026-07-25", amount: 1500, vendor: "初見の店", category: "その他", description: "支払い",
});
let res = g.actionAnalyzeReceipt_({ token: "", imageBase64: "x" });
assert.strictEqual(calls.length, 1, "学習が無ければAI呼び出しは1回");
assert.strictEqual(calls[0], "", "ヒント無しで呼ばれる");
assert.strictEqual(res.learned.applied.length, 0);
assert.strictEqual(res.learned.retried, false);
assert.strictEqual(res.fields.vendor, "初見の店");

// (b) 過去の誤読を再現した場合のみ、ヒント付きで読み直し、さらに辞書補正が乗る
g.logCorrection_(
  { vendor: "そば処ふじ", date: "2026-07-02", amount: 1100, category: "会議費", description: "打合せ昼食" },
  { vendor: "そば処ふじ", date: "2026-07-02", amount: 1000, category: "その他", description: "飲食", rawText: "小計 1000 合計 1100" },
  "yamada"
);
g.logCorrection_(
  { vendor: "そば処ふじ", date: "2026-07-09", amount: 990, category: "会議費", description: "打合せ昼食" },
  { vendor: "そば処ふじ", date: "2026-07-09", amount: 990, category: "その他", description: "飲食" },
  "yamada"
);
calls.length = 0;
// ヒント無しでは過去と同じ誤読（1000）を再現し、ヒント付きなら正しく読めるモデル
g.analyzeWithGemini_ = (body, hint) => {
  calls.push(String(hint || ""));
  return {
    fields: {
      date: "2026-07-26", vendor: "そば処ふじ", category: "その他", description: "飲食",
      amount: hint ? 1100 : 1000,
    },
    model: "stub",
  };
};
res = g.actionAnalyzeReceipt_({ token: "", imageBase64: "x" });
assert.strictEqual(calls.length, 2, "過去と同じ誤読を再現したので1回だけ読み直す");
assert.strictEqual(calls[0], "");
assert.ok(calls[1].includes("正しくは 1100 だった"), "2回目は誤読事例つき");
assert.strictEqual(res.learned.retried, true);
assert.strictEqual(res.learned.applied.join(","), "科目,摘要");
assert.strictEqual(res.fields.category, "会議費");
assert.strictEqual(res.fields.description, "打合せ昼食");
assert.strictEqual(res.fields.amount, 1100, "読み直しで金額が直る");
console.log("✓ actionAnalyzeReceipt_: 過去の誤読を再現したときだけ読み直し、辞書補正を適用する");

// (c) 誤読履歴のある店舗でも、その誤読を再現していなければ読み直さない
//     （履歴があるだけで毎回2回呼ぶと、よく使う店舗ほど解析が遅くなるため）
calls.length = 0;
g.analyzeWithGemini_ = stubAnalyze({
  date: "2026-07-26", amount: 1200, vendor: "そば処ふじ", category: "その他", description: "飲食",
});
res = g.actionAnalyzeReceipt_({ token: "", imageBase64: "x" });
assert.strictEqual(calls.length, 1, "既知の誤読と違う金額ならAI呼び出しは1回");
assert.strictEqual(res.learned.retried, false);
assert.strictEqual(res.fields.amount, 1200, "今回の金額はそのまま");
assert.strictEqual(res.fields.category, "会議費", "辞書補正は読み直し無しでも効く");
assert.strictEqual(
  g.repeatsKnownMistake_({ amount: 1000 }, [{ amountWrong: true, aiAmount: 1000 }]),
  true,
  "同じ誤読金額なら再現とみなす"
);
assert.strictEqual(
  g.repeatsKnownMistake_({ amount: 1200 }, [{ amountWrong: true, aiAmount: 1000 }]),
  false
);
assert.strictEqual(
  g.repeatsKnownMistake_({ vendor: "株式会社そば処ふじ" }, [
    { vendorWrong: true, aiVendor: "そば処ふじ" },
  ]),
  true,
  "店名の再現は表記ゆれを吸収して判定する"
);
console.log("✓ 既知の誤読を再現していなければ読み直さない（AI呼び出しは1回）");

/* -------- 11. 読み直しが失敗しても初回結果で応答する -------- */
calls.length = 0;
let n2 = 0;
g.analyzeWithGemini_ = function (body, hint) {
  calls.push(String(hint || ""));
  if (n2++ > 0) throw new Error("503 overloaded");
  // 過去と同じ誤読（1000）を再現するので読み直しに進み、その読み直しが失敗する
  return { fields: { date: "2026-07-27", amount: 1000, vendor: "そば処ふじ", category: "その他", description: "飲食" }, model: "stub" };
};
res = g.actionAnalyzeReceipt_({ token: "", imageBase64: "x" });
assert.strictEqual(calls.length, 2);
assert.strictEqual(res.learned.retried, false);
assert.strictEqual(res.fields.amount, 1000, "初回結果を採用");
assert.strictEqual(res.fields.category, "会議費", "辞書補正は効いたまま");
console.log("✓ 読み直しが失敗しても初回結果＋辞書補正で応答する");

/* ================= 交通費の運賃照合（電車賃） ================= */

/* -------- 12. 駅名・区間キーの正規化 -------- */
assert.strictEqual(g.stationKey_("新井薬師前駅"), g.stationKey_("新井薬師前"));
assert.strictEqual(g.stationKey_("ＪＲ 武蔵浦和"), g.stationKey_("jr武蔵浦和"));
// 上りと下りは同じ運賃なので同じキーに寄せる
assert.strictEqual(
  g.fareKey_("新井薬師前", "武蔵浦和"),
  g.fareKey_("武蔵浦和駅", "新井薬師前駅")
);
assert.strictEqual(g.fareKey_("新宿", "新宿"), "", "同じ駅は区間にならない");
assert.strictEqual(g.fareKey_("新宿", ""), "", "片方が空なら区間にならない");
console.log("✓ stationKey_/fareKey_: 「駅」の有無・全半角を吸収し、逆方向も同一区間として扱う");

/* -------- 13. 想定金額 = 片道 × 往復 × 回数 -------- */
assert.strictEqual(g.fareTotal_(220, false, 1), 220);
assert.strictEqual(g.fareTotal_(220, true, 1), 440, "往復は2倍");
assert.strictEqual(g.fareTotal_(220, true, 10), 4400, "回数分を掛ける");
assert.strictEqual(g.fareTotal_(220, false, 0), 220, "回数0は1回として扱う");
assert.strictEqual(g.fareTotal_(100, false, 999), 100 * val("FARE_TRIPS_MAX"), "回数は上限で止める");
console.log("✓ fareTotal_: 往復と回数を掛けた想定金額を出し、回数は1〜上限に収める");

/* -------- 14. Webで調べた運賃が運賃マスタへ蓄積され、2回目は検索しない -------- */
props.GEMINI_API_KEY = "dummy";
props.FARE_WEB_LOOKUP = "true"; // Web照合の既定は無効なので、この節では明示的に有効化する
let searchCalls = 0;
g.searchFareOnWeb_ = function (from, to) {
  searchCalls++;
  return { fare: 510, route: "西武新宿線→JR埼京線 池袋乗換", source: "https://example.test/fare" };
};
const first = g.actionLookupFare_({ token: "", from: "新井薬師前", to: "武蔵浦和", round: true, trips: 2 });
assert.strictEqual(searchCalls, 1);
assert.strictEqual(first.cached, false);
assert.strictEqual(first.unit, 510);
assert.strictEqual(first.expected, 510 * 2 * 2, "往復×2回");
assert.strictEqual(first.source, "https://example.test/fare");

// 2回目は同じ区間（しかも逆方向・「駅」付き）でもマスタから即答する
const second = g.actionLookupFare_({ token: "", from: "武蔵浦和駅", to: "新井薬師前駅", round: false, trips: 1 });
assert.strictEqual(searchCalls, 1, "2回目はWeb検索しない");
assert.strictEqual(second.cached, true);
assert.strictEqual(second.unit, 510);
assert.strictEqual(second.expected, 510);
assert.strictEqual(sheets["運賃マスタ"].getLastRow(), 2, "同じ区間は1行にまとまる");
console.log("✓ actionLookupFare_: 初回はWebで照合し、以降は運賃マスタから即答（逆方向も同一視）");

/* -------- 15. 申請時の照合判定はサーバー側で計算する -------- */
// 申請額が想定と一致
const okRec = g.resolveFareForRecord_(
  { fareFrom: "新井薬師前", fareTo: "武蔵浦和", fareRound: true, fareTrips: 2 }, 2040);
assert.strictEqual(okRec.check, "match");
assert.strictEqual(okRec.unit, 510);
assert.strictEqual(okRec.expected, 2040);
// 申請額が想定と違う
const ngRec = g.resolveFareForRecord_(
  { fareFrom: "新井薬師前", fareTo: "武蔵浦和", fareRound: true, fareTrips: 2 }, 3000);
assert.strictEqual(ngRec.check, "diff");
assert.strictEqual(ngRec.expected, 2040, "想定金額はマスタの運賃から計算する");
// クライアントが片道運賃を偽っても、マスタの値で上書きされる
const spoofed = g.resolveFareForRecord_(
  { fareFrom: "新井薬師前", fareTo: "武蔵浦和", fareRound: false, fareTrips: 1, fareUnit: 99999 }, 510);
assert.strictEqual(spoofed.unit, 510, "申請側の片道運賃は信用しない");
assert.strictEqual(spoofed.check, "match");
// マスタに無く、申請額からも片道運賃を割り出せない区間は「未照合」
// （往復×2回＝4で割り切れない＝運賃以外が混ざっているとみなす）
const unknown = g.resolveFareForRecord_(
  { fareFrom: "知らない駅A", fareTo: "知らない駅B", fareRound: true, fareTrips: 2 }, 301);
assert.strictEqual(unknown.check, "unchecked");
assert.strictEqual(unknown.expected, 0);
assert.strictEqual(
  g.actionListFares_({ token: "" }).items.filter((f) => f.to === "知らない駅B").length,
  0,
  "割り切れない申請は運賃マスタへ登録しない"
);
// 区間の指定が無ければ照合対象外
assert.strictEqual(g.resolveFareForRecord_({}, 300).check, "");
console.log("✓ resolveFareForRecord_: 想定金額をマスタから再計算し、申請額との一致/相違を判定する");

/* -------- 16. 管理者による運賃の手修正・削除 -------- */
g.actionUpsertFare_({ token: "", from: "新井薬師前", to: "武蔵浦和", fare: 560 });
assert.strictEqual(
  g.resolveFareForRecord_(
    { fareFrom: "新井薬師前", fareTo: "武蔵浦和", fareRound: false, fareTrips: 1 }, 560).check,
  "match",
  "運賃改定を手修正すると以降の照合に反映される"
);
assert.strictEqual(sheets["運賃マスタ"].getLastRow(), 2, "手修正は行を増やさず上書きする");
const listed = g.actionListFares_({ token: "" }).items;
assert.strictEqual(listed.length, 1);
assert.strictEqual(listed[0].fare, 560);
assert.ok(listed[0].checkedBy.indexOf("手動") === 0);

let threw = "";
try {
  g.actionUpsertFare_({ token: "", from: "新宿", to: "新宿", fare: 200 });
} catch (err) {
  threw = String(err.message);
}
assert.ok(threw.indexOf("別々の駅名") > 0, "同一駅の登録は弾く");

g.actionDeleteFare_({ token: "", key: listed[0].key });
assert.strictEqual(g.actionListFares_({ token: "" }).items.length, 0);
searchCalls = 0;
g.actionLookupFare_({ token: "", from: "新井薬師前", to: "武蔵浦和", round: false, trips: 1 });
assert.strictEqual(searchCalls, 1, "削除後は再びWebで調べ直す");
console.log("✓ 運賃マスタ: 管理者が上書き・削除でき、削除後は再照合される");

/* -------- 16.5 運賃マスタのみの運用（Web照合を使わない） -------- */
props.FARE_WEB_LOOKUP = "false";
let webCalls = 0;
g.searchFareOnWeb_ = function () {
  webCalls++;
  throw new Error("呼ばれてはいけない");
};
// 未登録の区間はエラーにせず、次の行動を伝える応答を返す
const notRegistered = g.actionLookupFare_({
  token: "", from: "池袋", to: "大宮", round: true, trips: 1,
});
assert.strictEqual(notRegistered.ok, true, "未登録でもエラーにしない");
assert.strictEqual(notRegistered.registered, false);
assert.strictEqual(notRegistered.expected, 0);
assert.ok(notRegistered.message.indexOf("路線検索") > 0, "調べ方を案内する");
assert.strictEqual(webCalls, 0, "Web照合は呼ばない");

// 手で登録すれば、以降はマスタの値で照合できる
g.actionUpsertFare_({ token: "", from: "池袋", to: "大宮", fare: 480 });
const registered = g.actionLookupFare_({
  token: "", from: "大宮駅", to: "池袋駅", round: true, trips: 2,
});
assert.strictEqual(registered.registered, true);
assert.strictEqual(registered.unit, 480);
assert.strictEqual(registered.expected, 480 * 2 * 2, "往復×2回");
assert.strictEqual(webCalls, 0, "登録済みならWeb照合は不要");
console.log("✓ 運賃マスタのみの運用: 未登録は案内を返し、手登録すれば以降は照合できる");

/* -------- 16.6 区間のまとめて登録 -------- */
const bulk = g.actionBulkUpsertFares_({
  token: "",
  text: [
    "新宿, 渋谷, 170, JR山手線",
    "\t品川\t東京\t180", // タブ区切りも受ける
    "上野，秋葉原，150", // 全角カンマも受ける
    "", // 空行は無視
    "駅名だけ", // 到着駅が無い
    "浜松町, 浜松町, 150", // 同じ駅
    "新橋, 有楽町, 0", // 運賃が0
  ].join("\n"),
});
assert.strictEqual(bulk.added, 3, "読めた行だけ登録する");
assert.strictEqual(bulk.errors.length, 3, "読めない行は理由を返す");
assert.ok(bulk.errors[0].indexOf("5行目") === 0, "何行目かを示す");
assert.ok(bulk.errors[2].indexOf("1円以上") > 0, "運賃が0の行は理由が分かる");
assert.strictEqual(
  g.actionLookupFare_({ token: "", from: "品川", to: "東京", round: false, trips: 1 }).unit,
  180,
  "タブ区切りの行も登録されている"
);
assert.strictEqual(
  g.actionLookupFare_({ token: "", from: "上野", to: "秋葉原", round: false, trips: 1 }).unit,
  150,
  "全角カンマの行も登録されている"
);
const listed2 = g.actionListFares_({ token: "" }).items;
const bulkAdded = listed2.filter((f) => ["渋谷", "東京", "秋葉原"].indexOf(f.to) >= 0);
assert.strictEqual(bulkAdded.length, 3);
assert.ok(
  bulkAdded.every((f) => f.checkedBy.indexOf("手動") === 0),
  "一括登録も手動として記録される"
);
delete props.FARE_WEB_LOOKUP;
console.log("✓ actionBulkUpsertFares_: カンマ/タブ/全角に対応し、読めない行は理由を返す");

/* -------- 16.7 Web照合は既定で無効（無料枠では割当が無いため） -------- */
assert.strictEqual(
  g.isFareWebEnabled_(),
  false,
  "プロパティ未設定なら無効（無料枠で必ず失敗する経路に入らない）"
);
props.FARE_WEB_LOOKUP = "false";
assert.strictEqual(g.isFareWebEnabled_(), false, "false でも無効");
props.FARE_WEB_LOOKUP = "true";
assert.strictEqual(g.isFareWebEnabled_(), true, "true のときだけ有効");
delete props.FARE_WEB_LOOKUP;

// 未設定のまま未登録区間を引いても、Web照合は呼ばれず案内だけを返す
let webCallsDefault = 0;
g.searchFareOnWeb_ = function () {
  webCallsDefault++;
  throw new Error("既定では呼ばれてはいけない");
};
const defaultLookup = g.actionLookupFare_({
  token: "", from: "横浜", to: "川崎", round: false, trips: 1,
});
assert.strictEqual(webCallsDefault, 0, "既定ではWeb照合を呼ばない");
assert.strictEqual(defaultLookup.ok, true);
assert.strictEqual(defaultLookup.registered, false);
assert.strictEqual(defaultLookup.webDisabled, true, "運賃マスタのみの運用として応答する");
console.log("✓ Web照合は既定で無効で、未登録区間は案内だけを返す");

/* -------- 16.8 申請した区間が運賃マスタへ自動登録される -------- */
// 未登録の区間で申請すると、申請額から片道運賃を割り戻してマスタへ入る。
// 登録の元になった申請は「一致」ではなく「新規登録」（確認はまだ）。
const firstClaim = g.resolveFareForRecord_(
  { fareFrom: "門前仲町", fareTo: "九段下", fareRound: true, fareTrips: 3 },
  1200,
  "山田太郎"
);
assert.strictEqual(firstClaim.check, "registered");
assert.strictEqual(firstClaim.unit, 200, "往復×3回＝6で割り戻す");
assert.strictEqual(firstClaim.expected, 1200);
const autoAdded = g
  .actionListFares_({ token: "" })
  .items.filter((f) => f.to === "九段下" || f.from === "九段下");
assert.strictEqual(autoAdded.length, 1, "運賃マスタへ1行だけ入る");
assert.strictEqual(autoAdded[0].fare, 200);
assert.strictEqual(
  autoAdded[0].checkedBy,
  "申請（山田太郎）",
  "誰の申請から入った運賃かを残す"
);

// 2回目以降は登録済みの運賃で照合する（逆方向でも同じ区間として扱う）
const secondClaim = g.resolveFareForRecord_(
  { fareFrom: "九段下駅", fareTo: "門前仲町駅", fareRound: false, fareTrips: 1 },
  200,
  "鈴木花子"
);
assert.strictEqual(secondClaim.check, "match", "2回目からは自動で照合される");
assert.strictEqual(
  g.resolveFareForRecord_(
    { fareFrom: "門前仲町", fareTo: "九段下", fareRound: false, fareTrips: 1 }, 900, "鈴木花子"
  ).check,
  "diff",
  "登録済みの区間は申請額を上書きせず差額として出す"
);
assert.strictEqual(
  g.actionListFares_({ token: "" }).items.filter((f) => f.to === "九段下" || f.from === "九段下")[0]
    .fare,
  200,
  "後からの申請でマスタの運賃は書き換わらない"
);

// 桁の打ち間違いを疑う高額と、金額が無い申請は登録しない
assert.strictEqual(
  g.resolveFareForRecord_(
    { fareFrom: "沖縄A", fareTo: "沖縄B", fareRound: false, fareTrips: 1 }, 9999999, "山田太郎"
  ).check,
  "unchecked",
  "上限を超える額は運賃マスタへ入れない"
);
assert.strictEqual(
  g.resolveFareForRecord_(
    { fareFrom: "無料A", fareTo: "無料B", fareRound: false, fareTrips: 1 }, 0, "山田太郎"
  ).check,
  "unchecked",
  "金額0の申請は運賃マスタへ入れない"
);
assert.strictEqual(
  g.actionListFares_({ token: "" }).items.filter(
    (f) => f.from.indexOf("沖縄") === 0 || f.from.indexOf("無料") === 0
  ).length,
  0
);
console.log("✓ 申請した区間が運賃マスタへ自動登録され、2回目以降は自動で照合される");

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

/* -------- 17. AIの応答から運賃JSONを取り出す -------- */
assert.strictEqual(
  g.parseJsonLoosely_('```json\n{"fare": 480, "route": "JR中央線"}\n```').fare,
  480,
  "コードフェンス付きでも読める"
);
assert.strictEqual(
  g.parseJsonLoosely_('調べました。{"fare": 300, "route": "都営大江戸線"} 以上です').fare,
  300,
  "前後に説明が付いていても読める"
);
assert.strictEqual(g.parseJsonLoosely_("運賃は分かりませんでした"), null);
assert.strictEqual(
  g.groundingSource_({ groundingMetadata: { groundingChunks: [
    { web: { uri: "https://transit.example.test/1", title: "運賃案内" } }] } }),
  "https://transit.example.test/1",
  "検索の出典URLを拾える"
);
assert.strictEqual(g.groundingSource_({}), "", "出典が無ければ空文字");
console.log("✓ AI応答のJSON抽出と出典URLの取得");

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

/* -------- PL管理モデルへの連携 -------- */

// 連携先の『経費入力テーブル』を実物と同じ形で用意する。
// 1行目がタイトル・4行目が見出し・データは5行目から。手動入力行が1件ある。
plSheets["経費入力テーブル"] = plSheet("経費入力テーブル", [
  ["経費入力テーブル（経費精算アプリ等から自動連携・手動入力）"],
  [],
  [],
  ["日付", "担当者名", "所属事業部", "経費項目", "金額", "備考"],
  [instantFor([2026, 7, 15, 0, 0], SCRIPT_TZ), "中原聖人", "人材", "広告費", 1200000,
   "人材広告費(8月分)"],
]);
const plRows = plSheets["経費入力テーブル"].rows;

// 連携が無効なうちは、PL側を一切触らない
assert.strictEqual(g.isPlSyncEnabled_(), false, "PL_SPREADSHEET_ID 未設定なら無効");
assert.strictEqual(
  g.safeSyncExpenseToPl_({ id: "x", status: "approved" }).reason,
  "disabled",
  "未設定なら何もしない（従来どおりの動作）"
);
assert.strictEqual(plRows.length, 5, "無効なうちはPL側の行が増えない");

props["PL_SPREADSHEET_ID"] = "pl-model";
assert.strictEqual(g.isPlSyncEnabled_(), true);
assert.ok(
  g.statusPayload_().features.plSync,
  "features.plSync で連携の有無をアプリへ伝える"
);
console.log("✓ PL_SPREADSHEET_ID 未設定なら連携は完全に無効");

// 対応表は初回に既定値がシードされ、運用側で直せる
const maps = g.loadPlMappings_();
assert.strictEqual(maps.department["本部"], "イベント営業", "人材以外はイベント営業へ");
assert.strictEqual(maps.department["人材"], "人材");
assert.strictEqual(maps.category["交通費"], "雑費交通費", "PL側の語彙へ変換する");
assert.strictEqual(maps.category["交際費"], "接待交際費");
assert.ok(sheets["PL連携マッピング"], "対応表タブが作られる");

// 承認済みの申請が、対応表どおり変換されて追記される
const rec = {
  id: "p1", status: "approved", applicant: "入舩雄志", department: "本部",
  date: "2026-08-05", category: "交通費", vendor: "JR東日本", description: "現場往復",
  amount: 1200,
};
assert.strictEqual(g.syncExpenseToPl_(rec).posted, true);
const added = plRows[5];
// vm の中と外では Date のコンストラクタが別なので instanceof では判定できない
const isDate = (v) => !!v && typeof v.getMonth === "function";
assert.ok(isDate(added[0]), "日付は文字列ではなく実日付で書く（SUMIFSの条件が日付比較）");
assert.strictEqual(
  displayed(added[0]),
  "2026-08-05 00:00",
  "シート上で申請どおりの日付・0:00 になる（スクリプトのTZで書くと1日前になる）"
);
assert.strictEqual(added[2], "イベント営業", "事業部がPL側の語彙になる");
assert.strictEqual(added[3], "雑費交通費", "科目がPL側の語彙になる");
assert.strictEqual(added[4], 1200);
assert.strictEqual(added[5], "JR東日本 / 現場往復", "支払先と摘要を備考にまとめる");
assert.strictEqual(added[6], "p1", "申請IDを残して以降の更新に備える");
console.log("✓ 承認済みの申請が対応表どおり変換されてPLへ追記される");

// 同じ申請を何度流しても重複しない（申請IDで upsert する）
rec.amount = 1600;
g.syncExpenseToPl_(rec);
g.syncExpenseToPl_(rec);
assert.strictEqual(plRows.length, 6, "申請IDが一致する行を書き換えるので増えない");
assert.strictEqual(plRows[5][4], 1600, "金額の修正が反映される");
console.log("✓ 同じ申請を何度同期しても重複せず、金額の修正が追随する");

// 手動入力行（申請IDなし）は読み取りも書き換えもしない
assert.strictEqual(plRows[4][1], "中原聖人", "手動入力行はそのまま残る");
assert.strictEqual(plRows[4][4], 1200000);

// 対応先の無い科目は「その他経費」へ集めて、PLから漏らさない
g.syncExpenseToPl_({
  id: "p2", status: "approved", applicant: "入舩雄志", department: "BAR",
  date: "2026-08-09", category: "宿泊費", vendor: "ホテル", description: "出張",
  amount: 9000,
});
assert.strictEqual(plRows[6][3], "その他経費", "対応先が無い科目は受け皿へ寄せる");
console.log("✓ PLに行が無い科目は「その他経費」へ集めて取りこぼさない");

// 対応先の無い事業部は、金額の行き先を決められないので書かずに記録へ残す
const unmapped = g.syncExpenseToPl_({
  id: "p3", status: "approved", applicant: "新人", department: "新規事業",
  date: "2026-08-10", category: "交通費", amount: 500,
});
assert.strictEqual(unmapped.posted, false);
assert.strictEqual(unmapped.reason, "unmapped department");
assert.strictEqual(plRows.length, 7, "PLには書かない（別事業部のPLを汚さない）");
assert.strictEqual(g.countPlSkipped_(), 1, "スキップ記録に残して管理画面で警告する");
assert.ok(
  String(sheets["PL連携スキップ"].rows[1][6]).indexOf("新規事業") >= 0,
  "理由に事業部名を入れる"
);
console.log("✓ 対応先の無い事業部は黙って捨てず、スキップ記録に残す");

// 却下・差戻しはPLから取り下げる（承認済みだけが利益計算に載る）
rec.status = "rejected";
assert.strictEqual(g.syncExpenseToPl_(rec).posted, false);
assert.strictEqual(g.findPlRow_(plSheets["経費入力テーブル"], "p1"), -1, "行が消える");
rec.status = "approved";
g.syncExpenseToPl_(rec);
assert.ok(g.findPlRow_(plSheets["経費入力テーブル"], "p1") > 0, "再承認で戻る");
console.log("✓ 却下・差戻しでPLから取り下げ、再承認で戻る");

// 対応表を直せば、以降の同期はその設定に従う
sheets["PL連携マッピング"].appendRow(["事業部", "新規事業", "人材"]);
assert.strictEqual(g.syncExpenseToPl_({
  id: "p3", status: "approved", applicant: "新人", department: "新規事業",
  date: "2026-08-10", category: "交通費", amount: 500,
}).posted, true, "対応表に足せば反映される");
assert.strictEqual(g.countPlSkipped_(), 0, "解消したスキップ記録は消える");
console.log("✓ 対応表を直せば以降の同期に反映され、警告も解消する");

// 一括同期：アプリ由来の行だけを作り直し、手動入力行は残す
const manualBefore = plRows.filter((r) => !String(r[6] || "").trim()).length;
g.syncAllToPl();
const manualAfter = plRows.filter((r) => !String(r[6] || "").trim());
assert.strictEqual(manualAfter.length, manualBefore, "手動入力行の数は変わらない");
assert.ok(
  manualAfter.some((r) => r[1] === "中原聖人" && r[4] === 1200000),
  "手動入力の内容も保たれる"
);
const ids = plRows.map((r) => String(r[6] || "")).filter((v) => v);
assert.strictEqual(new Set(ids).size, ids.length, "一括同期しても申請IDは重複しない");
assert.ok(ids.indexOf("e1") >= 0, "既存の承認済み申請も取り込まれる");
console.log("✓ 一括同期はアプリ由来の行だけを作り直し、手動入力行に触らない");

// 日付・数式まわりの補助関数（PL側の初期設定で使う正規表現の確認）
assert.strictEqual(g.toPlDate_("2026-08-05").getDate(), 5);
assert.strictEqual(g.toPlDate_("なし"), null, "読めない日付は null（誤った月へ集計しない）");
assert.strictEqual(g.columnLetter_(1), "A");
assert.strictEqual(g.columnLetter_(14), "N", "合計列まで数えられる");
const parsed = g.parsePlSumifsArgs_(
  "SUMIFS('経費入力テーブル'!$E$5:$E$100, '経費入力テーブル'!$C$5:$C$100, \"イベント営業\", " +
    "'経費入力テーブル'!$D$5:$D$100, \"広告費\", '経費入力テーブル'!$A$5:$A$100, \">=2026-08-01\", " +
    "'経費入力テーブル'!$A$5:$A$100, \"<=2026-08-31\")"
);
// 既存の数式から事業部と期間を取り出し、その他経費行へそのまま引き継ぐ
assert.strictEqual(parsed.department, "イベント営業");
assert.strictEqual(parsed.from, ">=2026-08-01");
assert.strictEqual(parsed.to, "<=2026-08-31");
assert.strictEqual(g.parsePlSumifsArgs_("SUM(B12:B15)"), null, "SUMIFS以外は対象外");
assert.strictEqual(
  g.shiftPlSumRange_("SUM(B12:B15)", 16),
  "SUM(B12:B16)",
  "直後に挿入した行を経費合計へ含める"
);
assert.strictEqual(
  g.shiftPlSumRange_("SUM(B12:B15)", 20),
  "SUM(B12:B15)",
  "離れた位置の挿入では範囲を動かさない"
);
console.log("✓ PL側の初期設定で使う日付変換・数式の書き換えが正しい");

/* -------- PL計算シートへの「その他経費」行の追加 -------- */

// 営業部PLと同じ構造を用意する（12〜15行が経費、16行が経費合計）。
// 固定人件費のように『経費入力テーブル』を参照しない行は差から引いてはいけない。
const sumifs = (dept, item, from, to) =>
  "=SUMIFS('経費入力テーブル'!$E$5:$E$100, '経費入力テーブル'!$C$5:$C$100, \"" + dept +
  "\", '経費入力テーブル'!$D$5:$D$100, \"" + item +
  "\", '経費入力テーブル'!$A$5:$A$100, \">=" + from +
  "\", '経費入力テーブル'!$A$5:$A$100, \"<=" + to + "\")";
const plCalc = plSheet("営業部PL計算シート");
plSheets["営業部PL計算シート"] = plCalc;
plCalc.getRange(1, 1, 1, 1).setValues([["イベント営業事業部 PL & インセンティブ計算シート"]]);
plCalc.getRange(3, 2, 1, 3).setValues([["8月", "9月", "合計"]]);
plCalc.getRange(11, 1, 1, 1).setValues([["II. 経費"]]);
plCalc.getRange(12, 1, 1, 4).setValues([
  ["  固定人件費（入舩雄志）", 320000, 320000, "=SUM(B12:C12)"],
]);
plCalc.getRange(13, 1, 1, 4).setValues([
  ["  広告費（バイトル等）",
   sumifs("イベント営業", "広告費", "2026-08-01", "2026-08-31"),
   sumifs("イベント営業", "広告費", "2026-09-01", "2026-09-30"),
   "=SUM(B13:C13)"],
]);
plCalc.getRange(14, 1, 1, 4).setValues([
  ["  雑費交通費（実費）",
   sumifs("イベント営業", "雑費交通費", "2026-08-01", "2026-08-31"),
   sumifs("イベント営業", "雑費交通費", "2026-09-01", "2026-09-30"),
   "=SUM(B14:C14)"],
]);
plCalc.getRange(15, 1, 1, 4).setValues([
  ["  接待交際費（実費）",
   sumifs("イベント営業", "接待交際費", "2026-08-01", "2026-08-31"),
   sumifs("イベント営業", "接待交際費", "2026-09-01", "2026-09-30"),
   "=SUM(B15:C15)"],
]);
plCalc.getRange(16, 1, 1, 4).setValues([
  ["  経費合計", "=SUM(B12:B15)", "=SUM(C12:C15)", "=SUM(B16:C16)"],
]);

const label = g.addPlOtherExpenseRow_(plCalc);
assert.strictEqual(label, "その他経費（実費）", "追加した行の名前を返す");
assert.strictEqual(
  String(plCalc.rows[15][0]).trim(),
  "その他経費（実費）",
  "経費合計の直前（16行目）に入る"
);

const other = plCalc.getRange(16, 2).getFormula();
assert.ok(
  other.indexOf('$C$5:$C$2000, "イベント営業"') > 0,
  "事業部の条件は既存の数式から引き継ぐ: " + other
);
assert.ok(other.indexOf('">=2026-08-01"') > 0 && other.indexOf('"<=2026-08-31"') > 0,
  "その列の月の期間を引き継ぐ");
assert.ok(other.indexOf('$D$') < 0, "経費項目では絞らない（総額から引く方式）");
assert.ok(
  /- B13 - B14 - B15\s*$/.test(other),
  "個別計上済みの3行だけを引く（固定人件費B12は引かない）: " + other
);
assert.ok(
  other.indexOf("B12") < 0,
  "『経費入力テーブル』を参照しない固定人件費を引くと、その分が二重に消える"
);
const sep = plCalc.getRange(16, 3).getFormula();
assert.ok(
  /- C13 - C14 - C15\s*$/.test(sep) && sep.indexOf('">=2026-09-01"') > 0,
  "9月の列も同じ形で作る: " + sep
);
assert.strictEqual(
  plCalc.getRange(16, 4).getFormula(),
  "=SUM(B16:C16)",
  "合計列はその行の月を足す"
);
assert.strictEqual(
  plCalc.getRange(17, 2).getFormula(),
  "=SUM(B12:B16)",
  "経費合計が追加した行まで広がる（挿入だけでは広がらない）"
);
assert.strictEqual(
  g.addPlOtherExpenseRow_(plCalc),
  "",
  "二重に実行しても行は増えない（冪等）"
);
assert.strictEqual(plCalc.rows.length, 17, "行数が変わらない");

// 経費を集計していないシート（ダッシュボード等）は対象外
const dash = plSheet("ダッシュボード");
dash.getRange(1, 1, 2, 1).setValues([["個人ダッシュボード"], ["基本給"]]);
assert.strictEqual(g.addPlOtherExpenseRow_(dash), "", "経費合計が無いシートは触らない");
console.log("✓ 「その他経費（実費）」行は総額との差で作り、固定費は引かず、冪等");

// 日付列の移行: 文字列の日付だけを実日付へ置き換える（PLが全月 ¥0 だった原因への対処）
plSheets["経費入力テーブル"].rows.push(
  ["2026-09-03", "手動太郎", "人材", "広告費", 80000, "文字列で入力された行", ""]
);
plSheets["経費入力テーブル"].rows.push(["", "", "", "", "", "", ""]);
const converted = g.fixPlDateColumn_(FAKE_PL_SS, "経費入力テーブル");
assert.strictEqual(converted, 1, "文字列の日付1件だけを移行する（空行と実日付は数えない）");
const migratedRow = plRows.find((r) => r[5] === "文字列で入力された行");
assert.ok(isDate(migratedRow[0]), "文字列の日付が実日付になる");
assert.strictEqual(migratedRow[0].getMonth(), 8, "2026-09-03 の月");
// 直す必要のないセルを書き戻さないこと。読んだ日付をそのまま書き戻すと
// （読みはスクリプトTZ基準・書きはシートTZ基準なので）日付が1日ずれる。
const keptManual = plRows.find((r) => r[5] === "人材広告費(8月分)");
assert.strictEqual(
  displayed(keptManual[0]),
  "2026-08-15 00:00",
  "移行の対象外だった手動入力の日付が動かない"
);
assert.strictEqual(
  g.fixPlDateColumn_(FAKE_PL_SS, "経費入力テーブル"),
  0,
  "2回目は移行するものが無い（冪等）"
);
assert.strictEqual(
  displayed(keptManual[0]),
  "2026-08-15 00:00",
  "何度流しても手動入力の日付は動かない"
);
assert.strictEqual(
  g.fixPlDateColumn_(FAKE_PL_SS, "存在しないシート"),
  0,
  "シートが無くても落ちない"
);

// SUMIFS の範囲拡張: 元は 100 行（実質96件）で打ち止めだった
const widened = g.widenPlSumifsRanges_(FAKE_PL_SS);
assert.ok(widened >= 3, "『経費入力テーブル』を参照する数式を広げる: " + widened + "式");
const adv = plCalc.getRange(13, 2).getFormula();
assert.ok(adv.indexOf("$E$5:$E$2000") > 0, "範囲が2000行まで広がる: " + adv);
assert.ok(adv.indexOf("$100") < 0, "100行の指定が残らない");
assert.ok(adv.indexOf('"広告費"') > 0, "条件そのものは変えない");
assert.strictEqual(
  plCalc.getRange(12, 2).getFormula(),
  "",
  "『経費入力テーブル』を参照しない行（固定人件費）は触らない"
);
assert.strictEqual(g.widenPlSumifsRanges_(FAKE_PL_SS), 0, "2回目は変更なし（冪等）");
// 数式でないセルを消さないこと。範囲まとめての setFormulas は空文字でセルを
// クリアするため、見出しや固定費の実数値がPLモデルから消えてしまう。
assert.strictEqual(
  plCalc.getRange(12, 2).getValue(),
  320000,
  "固定人件費の実数値が残る（数式でないセルを消さない）"
);
assert.strictEqual(String(plCalc.getRange(3, 2).getValue()), "8月", "月の見出しが残る");
assert.strictEqual(
  String(plCalc.getRange(12, 1).getValue()).trim(),
  "固定人件費（入舩雄志）",
  "行の名前が残る"
);
assert.strictEqual(
  plCalc.getRange(17, 3).getFormula(),
  "=SUM(C12:C16)",
  "経費合計は全ての月の列で追加行まで広がる"
);
console.log("✓ 日付列の実日付への移行とSUMIFSの範囲拡張が、既存の値を壊さず冪等に動く");

/* -------- タイムゾーンのずれ（日付が1日前になる事故）-------- */
const LA = "America/Los_Angeles";

// 月末の申請が、シート上でも月末のままであること。
// スクリプトのTZ（+9）で 0:00 を作るとシート（-7）では前日 8:00 になり、
// 8月にも9月にも入らずPLから消えてしまう。
g.syncExpenseToPl_({
  id: "p9", status: "approved", applicant: "月末太郎", department: "本部",
  date: "2026-08-31", category: "交通費", vendor: "月末", amount: 300,
});
const monthEnd = plRows[g.findPlRow_(plSheets["経費入力テーブル"], "p9") - 1];
assert.strictEqual(
  displayed(monthEnd[0]),
  "2026-08-31 00:00",
  "月末の日付が前日にずれない"
);
console.log("✓ 月末の申請がシート上でも月末に入る（1日前へずれない）");

// 旧コードが書いた「ずれた日付」を復元できること。
// Apps Script が読み戻す値は「シート上の表示日時をスクリプトTZで解釈したもの」。
// 旧コードは Asia/Tokyo の 0:00 を書いていたため、シートには前日 8:00 と表示され、
// 読み戻すと「前日 8:00（Tokyo）」の瞬間になる。
const shifted = plSheet("ずれ確認", [
  [], [], [],
  ["日付"],
  [instantFor([2026, 7, 4, 8, 0], SCRIPT_TZ), "旧コードが書いた行（前日 8:00 と表示される）"],
  [instantFor([2026, 7, 20, 0, 0], SCRIPT_TZ), "人が入力した行（0:00）"],
  ["", ""],
]);
plSheets["ずれ確認"] = shifted;
assert.strictEqual(
  g.repairPlShiftedDates_(FAKE_PL_SS, "ずれ確認"),
  1,
  "ずれた1件だけを直す（人が入れた行は触らない）"
);
assert.strictEqual(
  displayed(shifted.rows[4][0]),
  "2026-08-05 00:00",
  "1日前になっていた 2026-08-04 08:00 が 2026-08-05 へ戻る"
);
assert.strictEqual(
  displayed(shifted.rows[5][0]),
  "2026-08-20 00:00",
  "人が入力した日付はそのまま"
);
assert.strictEqual(
  g.repairPlShiftedDates_(FAKE_PL_SS, "ずれ確認"),
  0,
  "2回目は対象なし（冪等）"
);
console.log("✓ ずれた日付を復元し、人が入力した日付には触らない");

// 月末の条件を半開区間へ変換する（時刻が残っていても取りこぼさないための保険）
const halfOpenBefore = plCalc.getRange(13, 2).getFormula();
assert.ok(halfOpenBefore.indexOf('"<=2026-08-31"') > 0, "変換前は <= 月末");
const halfOpenCount = g.usePlHalfOpenRanges_(FAKE_PL_SS);
assert.ok(halfOpenCount >= 1, "変換した数式がある: " + halfOpenCount);
const halfOpenAfter = plCalc.getRange(13, 2).getFormula();
assert.ok(halfOpenAfter.indexOf('"<2026-09-01"') > 0, "翌月1日未満になる: " + halfOpenAfter);
assert.ok(halfOpenAfter.indexOf("<=") < 0, "<= が残らない");
assert.ok(halfOpenAfter.indexOf('">=2026-08-01"') > 0, "月初の条件は変えない");
assert.strictEqual(
  plCalc.getRange(14, 3).getFormula().indexOf('"<2026-10-01"') > 0,
  true,
  "9月の列は 10月1日未満になる（月をまたぐ繰り上げ）"
);
assert.strictEqual(g.usePlHalfOpenRanges_(FAKE_PL_SS), 0, "2回目は変更なし（冪等）");
console.log("✓ 月末の条件が「<翌月1日」になり、月をまたぐ繰り上げも正しい");

console.log("\nすべて成功");
