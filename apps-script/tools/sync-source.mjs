#!/usr/bin/env node
/**
 * clasp で取得した Apps Script プロジェクトへ、リポジトリ側のソースを反映する。
 *
 *   使い方: node apps-script/tools/sync-source.mjs <取得先ディレクトリ> <ソース.gs>
 *
 * Apps Script プロジェクトはリポジトリと直接つながっていないため、自動デプロイは
 *   1. clasp pull  … 現在のプロジェクト（appsscript.json を含む）を丸ごと取得
 *   2. このスクリプト … ソースだけを差し替え
 *   3. clasp push  … プロジェクトへ戻す
 * の順で行う。マニフェスト（appsscript.json）は取得したものをそのまま押し戻すので、
 * ウェブアプリの公開設定・タイムゾーン・OAuthスコープをCIが書き換えることはない。
 *
 * 反映先のファイル名はプロジェクト側の名前に合わせる。日本語ロケールで作成した
 * プロジェクトの既定ファイル名は `コード.gs` で、そこへ `Code.gs` を新規追加すると
 * 同じ関数が二重定義になって全体が動かなくなるため。
 */

import fs from "node:fs";
import path from "node:path";

/**
 * スクリプトファイルの拡張子。
 *
 * clasp は Apps Script の SERVER_JS ファイルを **`.js`** として取得する
 * （v2 の既定は `.gs` だった）。`.gs` だけを見ていると「ファイルが無い」と
 * 誤判定して新規ファイルを作ってしまい、プロジェクト内に同じコードが2つ並んで
 * 全体が二重宣言のSyntaxErrorになる。両方を見る。
 */
const SCRIPT_EXTENSIONS = [".js", ".gs"];

/** プロジェクトが空だったときに作るファイル名（clasp の取得形式に合わせる） */
const DEFAULT_TARGET = "Code.js";

function fail(message) {
  // GitHub Actions のログでエラーとして目立たせる（ローカル実行でも読める）
  console.error(`::error::${message}`);
  process.exit(1);
}

const [projectDir, sourcePath] = process.argv.slice(2);

if (!projectDir || !sourcePath) {
  fail("使い方: node apps-script/tools/sync-source.mjs <取得先ディレクトリ> <ソース.gs>");
}
if (!fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) {
  fail(`取得先ディレクトリが見つかりません: ${projectDir}`);
}
if (!fs.existsSync(sourcePath)) {
  fail(`ソースファイルが見つかりません: ${sourcePath}`);
}

// マニフェストが無い状態で push すると Apps Script 側のマニフェストを消してしまう
if (!fs.existsSync(path.join(projectDir, "appsscript.json"))) {
  fail(
    "取得先に appsscript.json がありません。clasp pull が成功しているか、" +
      "スクリプトIDが正しいかを確認してください。",
  );
}

const next = fs.readFileSync(sourcePath, "utf8");

const scripts = fs
  .readdirSync(projectDir)
  .filter((name) => SCRIPT_EXTENSIONS.includes(path.extname(name)))
  .sort();

// Apps Script は全スクリプトファイルを同じスコープに結合するため、プロジェクトが
// 持つスクリプトファイルは1つ（＝リポジトリの Code.gs）でなければならない。
// 内容が一致するファイルは過去の実行がこのリポジトリから作ったものなので、
// 反映先の候補は「内容が違うファイル」に絞る。
const others = scripts.filter(
  (name) => fs.readFileSync(path.join(projectDir, name), "utf8") !== next,
);

if (others.length > 1) {
  fail(
    `プロジェクトに内容の異なるスクリプトファイルが複数あります: ${others.join(", ")}。` +
      "どれを更新すべきか判断できないため中止しました。" +
      "Apps Script エディタで1つに統合してから再実行してください。",
  );
}

const target = others[0] || scripts[0] || DEFAULT_TARGET;
const targetPath = path.join(projectDir, target);
const prev = fs.existsSync(targetPath) ? fs.readFileSync(targetPath, "utf8") : null;

if (!scripts.length) {
  console.log(`プロジェクトにスクリプトファイルがないため新規作成します: ${target}`);
}

// 反映先以外のスクリプトファイルは重複なので取り除く（push でプロジェクトからも消える）。
// HTML や appsscript.json は対象外なので触らない。
scripts
  .filter((name) => name !== target)
  .forEach((name) => {
    fs.unlinkSync(path.join(projectDir, name));
    console.log(`重複していたスクリプトファイルを取り除きました: ${name}`);
  });

fs.writeFileSync(targetPath, next);

const changed = prev !== next;
console.log(
  changed
    ? `反映しました: ${path.basename(sourcePath)} → ${target}（内容が変わりました）`
    : `反映しました: ${path.basename(sourcePath)} → ${target}（内容は同一）`,
);

// 後続ステップが判断に使えるよう、変更有無を出力する（デプロイ自体は毎回行う）
if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(
    process.env.GITHUB_OUTPUT,
    `changed=${changed}\ntarget=${target}\n`,
  );
}
