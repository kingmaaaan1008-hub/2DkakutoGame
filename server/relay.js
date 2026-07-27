/**
 * オンライン対戦用の中継サーバ（WebSocket リレー）。
 *
 * 役割は3つだけ:
 *   1. 同じ合言葉(room)で来た2人を組ませる
 *   2. 試合開始時に「乱数シード・双方のキャラ・自分がどちら側か」を配る
 *   3. あとは入力メッセージをもう一方へ横流しする
 *
 * ゲームのルールはサーバ側に一切無い。判定はクライアント2台が
 * まったく同じシミュレーションを走らせて出す（決定的シミュレーション）ので、
 * サーバは非力なレンタルサーバでも十分に足りる。
 *
 * 使い方:
 *   cd server && npm install && npm start
 *   （既定ポート 8787 / 環境変数 PORT で変更可）
 *
 * 本番では TLS 終端したリバースプロキシ (nginx / Caddy) の後ろに置き、
 * クライアントからは wss:// で繋ぐこと。ws:// は https のページから接続できない。
 */
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT || 8787);
/** 入力遅延フレーム。回線が悪い相手が多いなら増やす。 */
const INPUT_DELAY = Number(process.env.INPUT_DELAY || 3);

const wss = new WebSocketServer({ port: PORT });
/** room 名 → 待機中/対戦中のクライアント配列 */
const rooms = new Map();

function send(socket, msg) {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
}

wss.on('connection', (socket) => {
  socket.room = null;

  socket.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.t === 'join') {
      joinRoom(socket, msg);
      return;
    }

    // それ以外は相手へそのまま転送する
    const peer = socket.peer;
    if (peer) send(peer, msg);
  });

  socket.on('close', () => {
    const peer = socket.peer;
    if (peer) {
      send(peer, { t: 'peerLeft' });
      peer.peer = null;
    }
    const list = rooms.get(socket.room);
    if (list) {
      const next = list.filter((s) => s !== socket);
      if (next.length === 0) rooms.delete(socket.room);
      else rooms.set(socket.room, next);
    }
  });
});

function joinRoom(socket, msg) {
  const room = String(msg.room || 'default').slice(0, 64);
  socket.room = room;
  socket.character = String(msg.character || 'swordsman');

  const waiting = rooms.get(room) ?? [];
  // 既に2人埋まっている部屋なら断る
  if (waiting.length >= 2) {
    send(socket, { t: 'roomFull' });
    socket.close();
    return;
  }
  waiting.push(socket);
  rooms.set(room, waiting);

  if (waiting.length < 2) {
    send(socket, { t: 'waiting' });
    return;
  }

  const [a, b] = waiting;
  a.peer = b;
  b.peer = a;

  // 両者が同じ乱数で始まるようにシードはサーバが決めて配る
  const seed = (Math.random() * 0xffffffff) >>> 0;
  const characters = [a.character, b.character];
  send(a, { t: 'start', slot: 0, seed, characters, delay: INPUT_DELAY });
  send(b, { t: 'start', slot: 1, seed, characters, delay: INPUT_DELAY });
  console.log(`[room ${room}] 対戦開始 ${characters.join(' vs ')}`);
}

console.log(`中継サーバ起動: ws://localhost:${PORT} (入力遅延 ${INPUT_DELAY}F)`);
