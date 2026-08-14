# 経費申請アプリ

レシート画像のAI読み取りと承認ダッシュボードを備えた経費申請アプリ。
フロントエンドは GitHub Pages の静的サイト、バックエンドは Google Apps Script
Web App で、データはスプレッドシート、領収書画像は Google ドライブに入る。

公開URL: <https://km1121-design.github.io/expense-app/>

## 構成

```
expense-app/     アプリ本体（index.html / script.js / style.css。バニラJS・ビルドなし）
apps-script/
  Code.gs        バックエンド全体（doGet / doPost。これ1ファイル）
  tests/         Code.gs の回帰テスト（Google のサービスをスタブして実行）
  tools/         自動デプロイ用のスクリプト
  README.md      セットアップ・運用手順（利用者向け）
docs/
  expense-app-spec.md   仕様書
```

## 開発の進め方

- `main` へ直接 push しない。作業ブランチで進めて PR を作る。
- コード・コメント・ドキュメント・コミットメッセージは**日本語**で書く。
  スプレッドシートの見出しやUI文言も日本語。内部キーとJSON APIのキー名は英語で固定。
- 変更したら必ず回帰テストを流す。UIを変えたときはブラウザでも確認する。

## 確認コマンド

```bash
# 回帰テスト（依存なし。Google のサービスはスタブ済み）
node apps-script/tests/memory.test.js

# Code.gs の構文チェック。.gs は node --check にそのまま渡せないので拡張子を変える
cp apps-script/Code.gs /tmp/Code.js && node --check /tmp/Code.js
```

フロントエンドの確認は Playwright + プリインストールの Chromium
（`PLAYWRIGHT_BROWSERS_PATH` を使う。`playwright install` は実行しない）。
`file://` で `expense-app/index.html` を開き、`localStorage` に設定とセッションを
書き込み、`script.google.test` へのリクエストを `page.route` で差し替えれば、
バックエンドなしで一通り動かせる。

## デプロイ

画面とバックエンドは別の場所で動くので、経路が2つある。どちらも `main` への
push で自動実行される。

| 対象 | ワークフロー | 内容 |
| --- | --- | --- |
| `expense-app/` | `deploy-pages.yml` | GitHub Pages へ公開 |
| `apps-script/Code.gs` | `deploy-apps-script.yml` | clasp で Apps Script プロジェクトへ反映し、既存デプロイを新バージョンへ更新 |

バックエンド側の流れ:

1. 構文チェックと回帰テスト（失敗したらデプロイしない）
2. `clasp pull` で現在のプロジェクトを丸ごと取得
3. `tools/sync-source.mjs` でソースだけ差し替え（`appsscript.json` は取得したものを
   そのまま押し戻すので、公開設定がCIで書き換わらない）
4. `clasp push` → `clasp redeploy <既存デプロイID>`（ウェブアプリURLは変わらない）
5. `tools/smoke-test.mjs` で公開されたウェブアプリに `status` を投げて疎通確認。
   **失敗したら直前のバージョンへ自動でロールバックする**

必要なシークレットは登録済み（`CLASPRC_JSON` / `APPS_SCRIPT_ID` /
`APPS_SCRIPT_DEPLOYMENT_ID`）。認証が切れたら `clasp login` をやり直して
`CLASPRC_JSON` を更新する。手順は `apps-script/README.md` の「自動デプロイ」。

**スクリプトプロパティ（APIキー等）はCIから操作できない。** Apps Script API に
プロパティを触る口がないため、エディタの「プロジェクトの設定」で設定する。
CIで変えたい既定値はコード側に置く。

## 落とし穴

実際に事故になった項目。作業前に目を通すこと。

### Apps Script プロジェクトのスクリプトファイルは常に1つ

Apps Script は全スクリプトファイルを**同じスコープへ結合する**ため、同じコードが
2ファイルあると `const` の二重宣言でプロジェクト全体が SyntaxError になり、
全リクエストが落ちる（`Failed to fetch` になる）。

- **clasp はスクリプトを `.js` として取得する**（clasp v2 の既定は `.gs` だった）。
  このプロジェクトのファイル名は `コード` なので、ローカルには `コード.js` で降りてくる。
  `.gs` だけを探すと「ファイルなし」と誤判定して新規ファイルを作ってしまう。
- `tools/sync-source.mjs` が「スクリプトファイルは1つ」を保つ。反映先以外の
  スクリプトファイルは取り除き、内容の異なるファイルが複数あるときは中止する。
- **単体の構文チェックではこの不具合を検出できない**（結合して初めて壊れる）。
  デプロイ後の疎通確認が唯一の検出手段。

### スプレッドシートの列は「位置」で読み書きする

見出しは日本語の表示専用ラベル。列定義は `[内部キー, 日本語ラベル]` の組で、
読み書きは定義順の位置で行う。`headerKeys_` は日本語ラベルと旧英語名の
どちらからでも内部キーへ解決する。

タブ名・見出しの定義を変えたら `SCHEMA_VERSION` を更新する。次のリクエストで
全シートをまとめて移行する（`migrateSheets` はエディタから手動実行もできる）。
移行は `safeMigrateSheets_` で包まれており、失敗してもリクエストは落とさない。

### フロントの `normalizeRecord` はホワイトリスト

`script.js` の `normalizeRecord` に無いフィールドは**黙って捨てられる**。
サーバーに項目を追加したら必ずここにも追加する。

### `style.css` の `[hidden]`

`.btn { display: inline-flex }` が `hidden` 属性を打ち消すため、
`[hidden] { display: none !important; }` を全体に効かせている。消さないこと。

### 通信は `text/plain` の POST

CORS のプリフライトを避けるため、JSON を `text/plain` で送っている。
`Content-Type: application/json` にすると動かなくなる。
サーバーがHTMLを返した場合（ログイン画面・エラー画面）は `readJsonResponse` が
読める日本語のエラーに変換する。

### 運賃のWeb照合と Gemini の無料枠

- **Google検索グラウンディングは無料枠では使えない。** 割当が0で、
  HTTP 429 に `limit: 0` が入って返る。モデルを変えても解決しない。
- そのため `FARE_WEB_LOOKUP` は**既定で無効**。`"true"` を設定したときだけ有効
  （課金が必要）。有効な状態で `limit: 0` を検知すると自動で `"false"` を保存する。
- `gemini-2.5-flash` は新規ユーザーには 404 を返す。モデルは `-latest` の別名を
  優先し、全滅したら `tryGeminiModels_` がそのキーで使えるモデルを調べて再試行する。
  エディタで `showGeminiModels` を実行すると一覧が出る。
- **路線検索サイト（Google / Yahoo!路線情報 / ジョルダン / NAVITIME）の自動読み取りは
  各社の規約で禁止されている。実装しない。** 人がクリックして開くリンクだけを提供する。

## 未完了の作業

- **運賃マスタへの区間登録**: Web照合が使えないため、よく使う区間の片道運賃を
  管理者ダッシュボードの「まとめて登録」から入れる運用が本線。
  1行 `出発駅, 到着駅, 片道運賃[, 経路]`。まだ登録されていない。
- ワークフローの `node-version: "20"` は Node 20 の非推奨警告が出る。22 へ上げてよい。

## ドキュメント

- 仕様: `docs/expense-app-spec.md`
- バックエンドの構築・運用: `apps-script/README.md`
- 利用者向けの概要: `README.md`
