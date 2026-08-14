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
class FakeSheet {
  constructor(name, rows) {
    this.name = name;
    this.rows = rows || [];
  }
  getName() { return this.name; }
  setName(n) { renameSheet(this, n); }
  getLastRow() { return this.rows.length; }
  getLastColumn() { return this.rows[0] ? this.rows[0].length : 0; }
  appendRow(r) { this.rows.push(r.slice()); }
  setFrozenRows() {}
  getDataRange() {
    return this.getRange(1, 1, this.getLastRow(), this.getLastColumn());
  }
  deleteRow(n) { this.rows.splice(n - 1, 1); }
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
          line.forEach((v, j) => { target[col - 1 + j] = v; });
        });
      },
      setValue(v) { self.rows[row - 1][col - 1] = v; },
      getValue() { return self.rows[row - 1][col - 1]; },
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
    formatDate: (d, tz, fmt) => {
      const p = (n) => String(n).padStart(2, "0");
      const s = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
      return fmt === "yyyy-MM" ? s.slice(0, 7) : s;
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
sandbox.SpreadsheetApp.getActiveSpreadsheet = () => FAKE_SS;
sandbox.SpreadsheetApp.openById = () => FAKE_SS;
sandbox.SpreadsheetApp.create = () => FAKE_SS;

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

// (b) 誤読履歴のある店舗 → ヒント付きで読み直し、さらに辞書補正が乗る
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
g.analyzeWithGemini_ = stubAnalyze({
  date: "2026-07-26", amount: 1200, vendor: "そば処ふじ", category: "その他", description: "飲食",
});
res = g.actionAnalyzeReceipt_({ token: "", imageBase64: "x" });
assert.strictEqual(calls.length, 2, "誤読履歴があるので1回だけ読み直す");
assert.strictEqual(calls[0], "");
assert.ok(calls[1].includes("正しくは 1100 だった"), "2回目は誤読事例つき");
assert.strictEqual(res.learned.retried, true);
assert.strictEqual(res.learned.applied.join(","), "科目,摘要");
assert.strictEqual(res.fields.category, "会議費");
assert.strictEqual(res.fields.description, "打合せ昼食");
assert.strictEqual(res.fields.amount, 1200, "今回の金額はそのまま");
console.log("✓ actionAnalyzeReceipt_: 誤読履歴のある店舗のみ読み直し、辞書補正を適用する");

/* -------- 11. 読み直しが失敗しても初回結果で応答する -------- */
calls.length = 0;
let n2 = 0;
g.analyzeWithGemini_ = function (body, hint) {
  calls.push(String(hint || ""));
  if (n2++ > 0) throw new Error("503 overloaded");
  return { fields: { date: "2026-07-27", amount: 1300, vendor: "そば処ふじ", category: "その他", description: "飲食" }, model: "stub" };
};
res = g.actionAnalyzeReceipt_({ token: "", imageBase64: "x" });
assert.strictEqual(calls.length, 2);
assert.strictEqual(res.learned.retried, false);
assert.strictEqual(res.fields.amount, 1300, "初回結果を採用");
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

console.log("\nすべて成功");
