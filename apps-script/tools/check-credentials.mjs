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

/** 英数字を伏せ、JSONの記号・空白・既知のキー名だけを残す */
function redact(text) {
  const safe = SAFE_WORDS.join("|");
  const re = new RegExp(`("(?:${safe})")|([{}\\[\\],:"])|(\\n)|(\\s)|([\\s\\S])`, "g");
  const out = text.replace(re, (m, word, punct, nl, ws) => {
    if (word) return word;
    if (punct) return punct;
    if (nl) return "⏎";
    if (ws) return " ";
    return "x";
  });
  // 長い伏せ字は桁数だけ示す（250文字の x の壁を出さない）
  return out.replace(/x{13,}/g, (m) => `x*${m.length}`);
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

const facts = [
  `文字数: ${normalized.length}`,
  `行数: ${normalized.split("\n").length}`,
  `先頭の文字: ${JSON.stringify(normalized.slice(0, 1))} / 末尾の文字: ${JSON.stringify(normalized.slice(-1))}`,
  hadBom ? "先頭にBOMがありました（除去しました）" : null,
].filter(Boolean);

let creds;
try {
  creds = JSON.parse(normalized);
} catch (err) {
  const message = String((err && err.message) || err);
  const at = /position (\d+)/.exec(message);
  const lines = ["::group::CLASPRC_JSON の診断（中身は伏せています）", ...facts, `エラー: ${message}`];
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
