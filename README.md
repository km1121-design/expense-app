# 経費申請アプリ

レシートの写真をAIが読み取って経費を申請し、スプレッドシートに溜めていくアプリです。
申請データは **Google スプレッドシート**、領収書の画像は **Google ドライブ** に入ります。
サーバー不要・ビルド不要で、スマホでもPCでも使えます。

公開URL: <https://km1121-design.github.io/expense-app/>

```
expense-app/    アプリ本体（index.html / app.js / app.css。バニラJS）
apps-script/    Google Apps Script バックエンド（スプレッドシート＋ドライブ連携）
docs/           仕様書
```

## できること

- **申請**: レシートを撮る（選ぶ）と、AIが日付・金額・費目・支払先・摘要を入力します。
  確認して「申請する」を押すだけ。読み取れなかった項目は手で入力できます。
- **一覧**: 月ごとに表示します。申請者は自分の分、管理者は全員分を見られます。
  事業部ごと・人ごと・費目ごとの並べ替えと小計つき。
- **ログイン**: 管理者が発行する8桁の**利用コード**だけでログインできます
  （案内文のリンクを開けば、コードの入力も不要）。ログインは30日続きます。
- **管理（管理者のみ）**: 利用者の追加・コードの再発行・無効化、事業部の追加・削除、
  利用者への事業部の割り当て（複数可）。

承認の手続きはありません。申請はそのまま計上されます。間違えたときは、削除して
申請し直します（本人と管理者が削除できます）。

## 使い始める

1. [`apps-script/README.md`](apps-script/README.md) の手順で、バックエンド（Apps Script）を作ります。
2. 公開URLを開くと、最初の管理者を作る画面になります（表示名・ユーザーID・パスワード）。
3. 「アカウント」タブで利用者を追加すると、利用コードが出ます。「案内文をコピー」して
   本人に送ってください。本人は、リンクを開くだけでログインできます。

## ドキュメント

- 仕様: [`docs/expense-app-spec.md`](docs/expense-app-spec.md)
- バックエンド構築: [`apps-script/README.md`](apps-script/README.md)
- 変更履歴: [`CHANGELOG.md`](CHANGELOG.md)
- 開発メモ（落とし穴・確認コマンド）: [`CLAUDE.md`](CLAUDE.md)

## デプロイ

画面とバックエンドは別々の場所で動くため、デプロイ経路も2つあります。
どちらも `main` への push で自動実行されます。

- **画面（GitHub Pages）**: `.github/workflows/deploy-pages.yml`。`expense-app/` を
  サイトルートとして配信します。
- **バックエンド（Apps Script）**: `.github/workflows/deploy-apps-script.yml`。
  シークレット3つの設定が必要です。手順は [`apps-script/README.md`](apps-script/README.md)
  の「自動デプロイ」を参照してください。
