# Think BS

株式会社BSサービスのアイデアメモアプリ(メモ+画像、PC・スマホ両対応のWebアプリ)。

- 公開URL:https://bs-service-ai.github.io/think-bs/
- データ保存先:利用者のGoogleドライブ「Think BS」フォルダ(このリポジトリにはメモや画像は入りません)
- 設定:`config.js` の `clientId` に Google Cloud の OAuth クライアントID を入れる

## ファイル
| ファイル | 役割 |
|---|---|
| index.html / style.css / app.js | アプリ本体 |
| config.js | GoogleのクライアントID |
| sw.js | オフラインでも開けるようにする仕組み |
| manifest.webmanifest・icon-*.png | ホーム画面に追加したときの名前とアイコン |
