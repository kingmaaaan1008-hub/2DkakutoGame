# オンライン対戦用 中継サーバ

ゲーム本体（`index.html` 以下）は静的ファイルだけなので **GitHub Pages で完結** します。
オンライン対戦をするときだけ、この中継サーバをどこかで動かしてください。

## これは何をするのか

- 同じ合言葉（ルーム名）で来た 2 人を組ませる
- 試合開始時に「乱数シード・双方のキャラ・自分がどちら側か」を配る
- あとは入力メッセージをもう一方へ横流しする

**当たり判定やダメージ計算はサーバでは行いません。** 2 台のブラウザが同じ入力から
まったく同じシミュレーションを走らせて同じ結果に到達します（決定的シミュレーション）。
そのためサーバの負荷はほぼ通信だけで、安いレンタルサーバや無料枠でも足ります。

## 動かす

```bash
cd server
npm install
npm start          # 既定では ws://localhost:8787
```

環境変数:

| 変数 | 既定 | 説明 |
| --- | --- | --- |
| `PORT` | `8787` | 待ち受けポート |
| `INPUT_DELAY` | `3` | 入力遅延フレーム。回線が不安定なら 4〜6 に増やす |

## 本番に置くときの注意

GitHub Pages は **https** で配信されます。https のページからは `ws://` に接続できないため、
**`wss://`（TLS）が必須** です。素の Node をそのまま公開せず、
nginx / Caddy などでリバースプロキシして TLS を終端してください。

nginx の例:

```nginx
location /relay {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 600s;
}
```

この場合、ゲーム側の「サーバ URL」には `wss://あなたのドメイン/relay` を入れます。

systemd で常駐させる例:

```ini
[Unit]
Description=kakuto relay
After=network.target

[Service]
WorkingDirectory=/opt/kakuto/server
ExecStart=/usr/bin/node relay.js
Restart=always
Environment=PORT=8787

[Install]
WantedBy=multi-user.target
```

## 通信の中身

```
クライアント → { t:"join",  room, character }
サーバ      → { t:"waiting" }                       相手待ち
サーバ      → { t:"start",  slot, seed, characters, delay }   2人揃った
双方        ⇄ { t:"input",  frame, bits }           毎フレーム
サーバ      → { t:"peerLeft" }                      相手が切断
```

`bits` は 1 フレーム分の入力ビットマスク（`src/game/constants.js` の `BTN`）です。
1 フレームあたり数十バイトしか流れません。

## 通信方式について

現在の実装は **入力遅延ロックステップ**（`src/net/session.js` の `LockstepSession`）です。
実装が小さく確実に同期しますが、回線遅延がそのまま操作感に出ます。

体感を詰めたくなったら **ロールバック** に移行できます。足場はすでにあります:

- `Simulation.save()` / `load()` … 状態の巻き戻し
- `Fighter.save()` / `load()` … 素の値だけのスナップショット
- シミュレーションが実時間・`Math.random` に依存していないこと

`LockstepSession` を差し替えるだけで済み、ゲームのルール側には手を入れません。
