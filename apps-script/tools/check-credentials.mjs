#!/usr/bin/env node
/**
 * clasp の認証情報ファイル（.clasprc.json）を検査する。
 *
 *   使い方: node apps-script/tools/check-credentials.mjs <.clasprc.json のパス>
 *
 * シークレットへの貼り付けミス（末尾の欠落・二重貼り・行の折返しによる改行混入など）は
 * clasp のエラーからは原因が分からないため、ここで先に切り分ける。
 *
 * 診断は **中身を出さずに構造だけ** を表示する。英数字は `x` に置き換え、JSONの記号と
 * 既知のキー名だけを残すので、トークンそのものはログに出ない
 * （GitHub のマスクはシークレットと完全一致する文字列にしか効かないため、
 *   一部分を切り出して出すと素通りしてしまう。だから自分で伏せる）。
 */

import fs from "node:fs";

/** 表示してよいキー名（clasp v3 と旧形式の両方） */
const SAFE_WORDS = [
  "tokens",
  "default",
  "type",
  "authorized_user",
  "client_id",
  "client_secret",
  "refresh_token",
  "access_token",
  "expiry_date",
  "token_type",
  "scope",
  "id_token",
  "Bearer",
  "token",
  "oauth2ClientSettings",
  "isLocalCreds",
  "clientId",
  "clientSecret",
  "redirectUri",
];

/**
 * 英数字を伏せ、JSONの記号・空白・既知のキー名だけを残す。
 *
 * 括弧は全角（｛｝［］）で出す。GitHub Actions は複数行シークレットの各行を
 * それぞれマスク対象として登録するため、`{` だけの行を含むJSONを登録すると
 * ログ中のすべての半角括弧が `***` に置き換わり、構造が読めなくなる。
 */
function redact(text) {
  const safe = SAFE_WORDS.join("|");
  const re = new RegExp(`("(?:${safe})")|([{}\\[\\],:"])|(\\n)|(\\s)|([\\s\\S])`, "g");
  const wide = { "{": "｛", "}": "｝", "[": "［", "]": "］" };
  const out = text.replace(re, (m, word, punct, nl, ws) => {
    if (word) return word;
    if (punct) return wide[punct] || punct;
    if (nl) return "⏎";
    if (ws) return " ";
    return "x";
  });
  // 長い伏せ字は桁数だけ示す（250文字の x の壁を出さない）
  return out.replace(/x{13,}/g, (m) => `x*${m.length}`);
}

/** 文字列の中身を除いて括弧の対応を数える（貼り付けの途中・末尾の欠けを名指しするため） */
function braceBalance(text) {
  const outsideStrings = text.replace(/"(?:[^"\\]|\\.)*"/g, '""');
  const count = (ch) => (outsideStrings.split(ch).length - 1);
  return {
    curlyOpen: count("{"),
    curlyClose: count("}"),
    squareOpen: count("["),
    squareClose: count("]"),
  };
}

function fail(lines) {
  for (const line of lines) console.error(line);
  console.error(
    "::error::CLASPRC_JSON の内容が壊れています。上の診断を見て貼り直してください。",
  );
  process.exit(1);
}

const filePath = process.argv[2];
if (!filePath) {
  console.error("::error::使い方: node apps-script/tools/check-credentials.mjs <.clasprc.json>");
  process.exit(1);
}

let raw = fs.readFileSync(filePath, "utf8");

// BOM と前後の空白は取り除いてよい（貼り付け経路で付きやすく、意味を持たない）
const hadBom = raw.charCodeAt(0) === 0xfeff;
const normalized = (hadBom ? raw.slice(1) : raw).trim();
const changed = normalized !== raw;

const balance = braceBalance(normalized);
const missingCurly = balance.curlyOpen - balance.curlyClose;
const missingSquare = balance.squareOpen - balance.squareClose;

const facts = [
  `文字数: ${normalized.length}`,
  `行数: ${normalized.split("\n").length}`,
  `先頭の文字: ${redact(normalized.slice(0, 1))} / 末尾の文字: ${redact(normalized.slice(-1))}`,
  `括弧の数: ｛ ${balance.curlyOpen} 個 / ｝ ${balance.curlyClose} 個`,
  hadBom ? "先頭にBOMがありました（除去しました）" : null,
].filter(Boolean);

// 括弧の数が合わない＝貼り付けの一部が欠けている。パースエラーより直接的なので先に言う。
const truncationHint =
  missingCurly > 0
    ? `閉じ括弧 ｝ が ${missingCurly} 個足りません。貼り付けの末尾が欠けています（最後の行までコピーできていません）。`
    : missingCurly < 0
      ? `閉じ括弧 ｝ が ${-missingCurly} 個多いです。貼り付けが重複しているか、余分な文字が入っています。`
      : missingSquare !== 0
        ? `角括弧 ［］ の数が合っていません（${balance.squareOpen} 対 ${balance.squareClose}）。`
        : null;

let creds;
try {
  creds = JSON.parse(normalized);
} catch (err) {
  const message = String((err && err.message) || err);
  const at = /position (\d+)/.exec(message);
  const lines = ["::group::CLASPRC_JSON の診断（中身は伏せています）", ...facts];
  if (truncationHint) lines.push(`▶ ${truncationHint}`);
  lines.push(`エラー: ${message}`);
  if (at) {
    const pos = Number(at[1]);
    const from = Math.max(0, pos - 70);
    const to = Math.min(normalized.length, pos + 70);
    lines.push(
      `問題の位置 ${pos} の前後（英数字は x に置換、改行は ⏎）:`,
      `  ${redact(normalized.slice(from, pos))}  ◀ここ▶  ${redact(normalized.slice(pos, to))}`,
    );
  }
  lines.push(
    "::endgroup::",
    "端末からのコピーは折返しや選択ミスで壊れやすいので、ファイルから直接クリップボードへ入れてください:",
    "  macOS   : pbcopy < ~/.clasprc.json",
    "  Windows : Get-Content $HOME/.clasprc.json | Set-Clipboard",
    "  Linux   : xclip -selection clipboard < ~/.clasprc.json",
  );
  fail(lines);
}

// clasp が実際に使うのは refresh_token（＋クライアント情報）。access_token は失効していてよい。
const v3 = creds && creds.tokens && creds.tokens.default;
const v1Local = creds && creds.token;
const refreshToken =
  (v3 && v3.refresh_token) ||
  (v1Local && v1Local.refresh_token) ||
  (creds && creds.refresh_token) ||
  null;

if (!refreshToken) {
  fail([
    "::group::CLASPRC_JSON の診断（中身は伏せています）",
    ...facts,
    `JSONとしては読めましたが refresh_token が見つかりません。最上位のキー: ${Object.keys(creds || {}).join(", ") || "(なし)"}`,
    v3 ? `tokens.default のキー: ${Object.keys(v3).join(", ")}` : "tokens.default がありません",
    "::endgroup::",
    "`clasp login` が完了したあとの ~/.clasprc.json を貼り付けているか確認してください",
    "（別のファイルや、ログイン前の空ファイルを貼っている可能性があります）。",
  ]);
}

if (changed) fs.writeFileSync(filePath, normalized);

const shape = v3 ? "clasp v3 形式" : v1Local ? "旧 clasp（プロジェクト内）形式" : "旧 clasp（グローバル）形式";
console.log(`認証情報を確認しました（${shape}・refresh_token あり）`);
