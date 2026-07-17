# 経費申請アプリ

レシート画像の自動読み取り（端末内OCR）と、個人／管理者向けの確認ダッシュボードを備えた
経費申請アプリです。申請データを **Google スプレッドシート（DB）** に、領収書画像を
**Google ドライブ** に保存し、実績管理・分析ツールと連携できます。

サーバー不要・ビルド不要で、`expense-app/index.html` を開くだけで動作します。

```
expense-app/    アプリ本体（HTML / CSS / JS、バニラ）
apps-script/    Google Apps Script バックエンド（スプレッドシート＋ドライブ連携）
docs/           仕様書
```

## 主な機能

- **画像解析**: レシート／領収書写真から金額・日付・店名を端末内OCR（Tesseract.js）で自動入力
- **経費申請**: 日付・科目・支払先・金額・摘要を入力して申請
- **個人ダッシュボード**: 自分の申請一覧・状況・金額集計
- **管理者ダッシュボード**: 全申請の承認／却下、承認待ち・科目別金額の集計、検索、CSV書き出し
- **クラウド連携**: Apps Script Web アプリ経由で、申請データをスプレッドシート（正本）、
  領収書画像をドライブへ保存。複数端末・分析ツールから同一データを参照可能
  （未設定時はこの端末の localStorage にのみ保存）

## 使い方

1. `expense-app/index.html` をブラウザで開く。
2. （任意）右上「⚙️」でクラウド連携を設定（手順は `apps-script/README.md`）。
3. 右上「ログインユーザー」に氏名を入力。
4. 「経費を申請」タブでレシート画像をアップロード → 自動入力を確認して申請。
5. 「個人ダッシュボード」で状況確認、承認担当者は「管理者モード」で承認／却下。

## ドキュメント

- 仕様: [`docs/expense-app-spec.md`](docs/expense-app-spec.md)
- バックエンド構築: [`apps-script/README.md`](apps-script/README.md)
- アプリ詳細: [`expense-app/README.md`](expense-app/README.md)

## デプロイ

`.github/workflows/deploy-pages.yml` により、`main` への push で GitHub Pages へ
自動デプロイされます（`expense-app/` 配下をサイトルートとして配信）。

- 公開URL: `https://km1121-design.github.io/expense-app/`
- Public リポジトリならそのまま利用できます。Private の場合は GitHub Pages が
  対応プランに限られるため、Public にするか対応プランで有効化してください。
- 静的サイトのため、任意の静的ホスティングや `expense-app/index.html` を直接開いても
  動作します。
