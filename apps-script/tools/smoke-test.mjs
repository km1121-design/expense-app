#!/usr/bin/env node
/**
 * デプロイ直後のウェブアプリに疎通確認を行う。
 *
 *   使い方: WEB_APP_URL=https://script.google.com/macros/s/.../exec \
 *           node apps-script/tools/smoke-test.mjs
 *
 * `status` はトークン不要で、バックエンドの版と使える機能を返す。これが JSON で
 * 返れば、少なくともプロジェクトがコンパイルでき doPost に到達できている。
 *
 * 単体の構文チェックでは、Apps Script が全スクリプトファイルを同じスコープへ
 * 結合したときにだけ起きる不具合（同じ識別子の二重宣言など）を検出できない。
 * 実際に動いているデプロイを叩くことでそこまで含めて確かめる。
 *
 * URL は出力しない（デプロイIDを含むため）。
 */

const URL_ = process.env.WEB_APP_URL;
const ATTEMPT_DELAYS_MS = [0, 3000, 5000, 8000, 13000]; // デプロイ直後は反映待ちがある

if (!URL_) {
  console.error("::error::WEB_APP_URL が設定されていません");
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Googleのログイン画面・承認画面かどうか（＝壊れているのではなく、確認できない） */
function looksLikeGoogleSignIn(body) {
  return (
    /accounts\.google\.com/i.test(body) ||
    /ServiceLogin/i.test(body) ||
    /承認が必要|Authorization is required|使用する権限がありません/i.test(body)
  );
}

async function probe() {
  const res = await fetch(URL_, {
    method: "POST",
    // アプリと同じ形。text/plain にすることでプリフライトを避ける作りに合わせる。
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ action: "status" }),
    redirect: "follow",
  });
  const text = await res.text();
  return { status: res.status, text };
}

let lastProblem = "";

for (let i = 0; i < ATTEMPT_DELAYS_MS.length; i++) {
  if (ATTEMPT_DELAYS_MS[i]) await sleep(ATTEMPT_DELAYS_MS[i]);

  let result;
  try {
    result = await probe();
  } catch (err) {
    lastProblem = `接続できません: ${String((err && err.message) || err)}`;
    continue;
  }

  const { status, text } = result;

  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    // JSONでない＝HTML（エラー画面かログイン画面）が返っている
  }

  if (data && data.ok) {
    const features = data.features
      ? Object.keys(data.features)
          .filter((k) => data.features[k])
          .join(", ")
      : "(なし)";
    console.log(`疎通確認OK: HTTP ${status} / 版 ${data.version || "(不明)"}`);
    console.log(`有効な機能: ${features}`);
    if (!data.features) {
      console.log(
        "::warning::status が features を返していません。" +
          "古いコードが公開されている可能性があります。",
      );
    }
    process.exit(0);
  }

  if (data) {
    lastProblem = `JSONは返るが ok ではありません: ${JSON.stringify(data).slice(0, 200)}`;
    continue;
  }

  if (looksLikeGoogleSignIn(text)) {
    // アクセス権限が「全員」でない場合。壊れている証拠ではないので落とさない。
    console.log(
      "::warning::ウェブアプリがGoogleログインを要求しているため、疎通確認を行えませんでした。" +
        "「アクセスできるユーザー」が全員でない設定では、この確認は省略されます。",
    );
    process.exit(0);
  }

  lastProblem =
    `JSONが返りません（HTTP ${status}）。Apps Script のエラー画面が返っている可能性があります。` +
    `応答の先頭: ${text.replace(/\s+/g, " ").slice(0, 200)}`;
}

console.error("::error::疎通確認に失敗しました。" + lastProblem);
process.exit(1);
