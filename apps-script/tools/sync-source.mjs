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

/** 反映先の候補になる既定ファイル名（ロケール差） */
const DEFAULT_NAMES = ["Code.gs", "コード.gs"];

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

const gsFiles = fs
  .readdirSync(projectDir)
  .filter((name) => name.endsWith(".gs"))
  .sort();

let target;
if (gsFiles.length === 1) {
  target = gsFiles[0];
} else if (gsFiles.length === 0) {
  // 空のプロジェクトなら、リポジトリ側の名前でそのまま作る
  target = path.basename(sourcePath);
  console.log(`プロジェクトに .gs がないため新規作成します: ${target}`);
} else {
  // 複数ある場合は取り違えが致命的なので、確実に判断できるときだけ進む
  const byName = gsFiles.filter((name) => name === path.basename(sourcePath));
  const byDefault = gsFiles.filter((name) => DEFAULT_NAMES.includes(name));
  const picked = byName.length === 1 ? byName : byDefault;
  if (picked.length !== 1) {
    fail(
      `反映先を特定できません。プロジェクト側の .gs: ${gsFiles.join(", ")} / ` +
        `リポジトリ側: ${path.basename(sourcePath)}。` +
        "Apps Script エディタでファイル名を揃えてから再実行してください。",
    );
  }
  target = picked[0];
}

const targetPath = path.join(projectDir, target);
const next = fs.readFileSync(sourcePath, "utf8");
const prev = fs.existsSync(targetPath) ? fs.readFileSync(targetPath, "utf8") : null;

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
