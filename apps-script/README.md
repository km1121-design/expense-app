# 経費申請アプリ バックエンド（Google Apps Script）

`Code.gs` を Google Apps Script の Web アプリとして公開すると、経費申請アプリの
データを **Google スプレッドシート（データベース）** に、領収書画像を
**Google ドライブ** に保存できます。公開した URL を経費申請アプリの
「⚙️ クラウド連携設定」に貼り付けて連携します。

## セットアップ手順

1. **スプレッドシートを用意**（任意）
   - 保存先にしたいスプレッドシートを作成し、URL 中の `/d/【ここがID】/edit` の
     ID を控えます。省略した場合は初回実行時に「経費申請データ」という
     スプレッドシートが自動作成されます。

2. **Apps Script プロジェクトを作成**
   - <https://script.google.com> で新規プロジェクトを作成し、
     `Code.gs` の内容を貼り付けます（既定の `Code.gs` を置き換え）。

3. **スクリプトプロパティを設定**（任意）
   - プロジェクトの設定（歯車）> スクリプト プロパティ で以下を追加できます。
     すべて任意です。

     | プロパティ | 説明 |
     | --- | --- |
     | `SPREADSHEET_ID` | 保存先スプレッドシートID。未設定なら初回に「経費申請データ」を自動作成し、IDをこのプロパティへ自動保存して以降再利用 |
     | `DRIVE_FOLDER_ID` | 領収書画像の保存先フォルダID。未設定なら「経費領収書」を自動作成し、同様にIDを自動保存 |
     | `SHARED_TOKEN` | 分析ツール用の読み取りトークン。設定すると GET `?token=<この値>` で全件を読み取り専用取得できる（Looker Studio 等の定期取得用） |
     | `AUTH_SECRET` | セッショントークンの署名鍵（初回に自動生成・自動保存。手動設定不要） |
     | `ANTHROPIC_API_KEY` | 設定するとレシートの**AI解析**（高精度）が有効になる。下記「AIレシート解析」参照 |
     | `OCR_MODEL` | AI解析のモデルID。既定 `claude-opus-4-8`（最高精度）。コスト重視なら `claude-haiku-4-5` |

4. **Web アプリとしてデプロイ**
   - 右上「デプロイ」>「新しいデプロイ」>「種類：ウェブアプリ」
   - **次のユーザーとして実行**: 自分
   - **アクセスできるユーザー**: 全員（社内限定にする場合は「同じ組織内の全員」）
   - デプロイして表示される **ウェブアプリ URL**（`.../exec` で終わる）を控えます。
   - 初回は権限承認（スプレッドシート・ドライブへのアクセス）を求められます。

5. **アプリに接続して初期設定**
   - 経費申請アプリを開き、右上「⚙️」→ ウェブアプリ URL を入力して「保存して接続」。
   - 初回は「初期設定：管理者アカウントの作成」画面が表示されるので、
     最初の管理者（ユーザーID・表示名・パスワード）を作成します。
   - 以降は全員ログインが必要になります。ユーザーの追加は管理者ダッシュボードの
     「ユーザー管理」から行います。

## AIレシート解析（オプション・高精度）

スクリプトプロパティに `ANTHROPIC_API_KEY` を設定すると、レシート画像の読み取りが
端末内OCR（Tesseract）から **Claude API の画像解析** に切り替わり、精度が大幅に
向上します。金額・日付・店名に加えて**経費科目の自動判定・摘要の自動生成**も行います。
構造化出力（JSON Schema）を使うため、応答は常に機械可読なJSONです。

### セットアップ

1. <https://platform.claude.com> でAPIキーを発行（`sk-ant-...`）
2. Apps Script のスクリプトプロパティに `ANTHROPIC_API_KEY` として保存
3. （任意）`OCR_MODEL` でモデルを指定。未設定なら `claude-opus-4-8`

### 料金の目安（レシート1枚あたり）

| モデル | 精度 | 概算コスト |
| --- | --- | --- |
| `claude-opus-4-8`（既定） | 最高 | 約2〜3円 |
| `claude-haiku-4-5` | 高 | 約0.5円 |

※画像サイズにより変動。APIキー未設定の場合は従来どおり端末内OCRで動作します
（画像は外部送信されません）。AI解析失敗時も自動で端末内OCRにフォールバックします。

## 認証・権限

- パスワードは `users` シートにソルト付き SHA-256 ハッシュで保存されます（平文保存なし）。
- ログイン成功で HMAC 署名付きセッショントークン（12時間有効）を発行します。
- 権限は `user`（自分の申請のみ・申請/取消）と `admin`（全件閲覧・承認/却下/差戻・
  ユーザー管理）の2種類。申請者名・承認者名はサーバー側でセッションから強制されます。
- `users` シートが空の間は認証なしの互換モードで動作します（初期設定前の状態）。

## データ構造（スプレッドシート `expenses` シート）

1 申請 = 1 行。ヘッダー行の列は以下の通りです。分析ツールはこのシートを
そのまま読み込めます。

| 列 | 内容 |
| --- | --- |
| `id` | 申請ID（アプリが採番） |
| `createdAt` | 申請日時（ISO8601） |
| `applicant` | 申請者 |
| `date` | 経費発生日 |
| `category` | 科目 |
| `vendor` | 支払先 / 店名 |
| `amount` | 金額（円・数値） |
| `description` | 摘要 / 目的 |
| `status` | `pending` / `approved` / `rejected` |
| `reviewedAt` | 承認・却下日時 |
| `reviewer` | 承認者 |
| `reviewComment` | 却下理由など |
| `imageUrl` | 領収書画像の Google ドライブ URL |
| `imageFileId` | 同 ファイルID |
| `applicantId` | 申請者のユーザーID（権限フィルタに使用） |

このほか `users` シート（`username, displayName, passwordHash, salt, role, active,
createdAt`）が同じスプレッドシートに作成されます。

## API（分析ツール・他システム連携用）

- **GET** `?token=...` → `{ ok:true, records:[...] }`
  - セッショントークン: `user` は自分の申請のみ、`admin` は全件
  - `SHARED_TOKEN` の値: 全件（読み取り専用・分析ツールの定期取得向け）
- **POST**（`Content-Type: text/plain`、本文は JSON、認証系以外は `token` 必須）
  - `{action:"status"}` … 認証が有効か（初期設定済みか）
  - `{action:"setup", username, displayName, password}` … 最初の管理者作成（初回のみ）
  - `{action:"login", username, password}` … ログイン → `{token, user}`
  - `{action:"me", token}` … セッション検証
  - `{action:"changePassword", token, currentPassword, newPassword}`
  - `{action:"create", token, record:{...}}` … 申請作成（`record.imageBase64` が
    あればドライブへ画像保存。申請者はセッションから強制）
  - `{action:"update", token, id, fields:{...}}` … 承認・却下・差戻（admin のみ）
  - `{action:"delete", token, id}` … 取消（user は自分の申請中のみ。画像もゴミ箱へ）
  - `{action:"listUsers", token}` / `{action:"upsertUser", token, user:{...}}`
    … ユーザー管理（admin のみ）
  - `{action:"analyzeReceipt", token, imageBase64, imageMime}` … AIレシート解析
    （`ANTHROPIC_API_KEY` 設定時のみ。日付・金額・店名・科目・摘要をJSONで返却）

## 分析・実績管理への連携例

- **スプレッドシート直接**: `expenses` シートをそのままピボット/関数で集計。
- **Looker Studio**: データソースにこのスプレッドシートを指定してダッシュボード化。
- **JSON API**: 上記 GET を BI ツールや自作スクリプトから定期取得。
- **CSV**: アプリの管理者ダッシュボード「CSV書き出し」から出力して取り込み。
