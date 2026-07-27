/**
 * 通信層の抽象化。
 *
 * ゲーム側は「Transport にメッセージを投げると相手に届く」としか知らない。
 * そのため、
 *   - レンタルサーバに置いた WebSocket 中継 → WebSocketTransport
 *   - 将来 P2P (WebRTC DataChannel) にする → 同じ形のクラスを足すだけ
 *   - 通信なしの動作確認 → LoopbackTransport
 * のどれでも、session.js から先は 1 行も変えずに差し替えられる。
 */

/**
 * @typedef {object} Transport
 * @property {(msg:object)=>void} send
 * @property {(handler:(msg:object)=>void)=>void} onMessage
 * @property {()=>Promise<void>} connect
 * @property {()=>void} close
 */

/** 通信せず自分に返すだけ。開発時の動作確認用。 */
export class LoopbackTransport {
  constructor() {
    this.handler = null;
  }

  async connect() {}

  onMessage(handler) {
    this.handler = handler;
  }

  send(msg) {
    // 実際の遅延を模したいときはここに setTimeout を挟む
    this.handler?.(msg);
  }

  close() {}
}

/**
 * WebSocket 中継サーバ経由の通信。
 * サーバ実装は server/relay.js にある（レンタルサーバや Render 等に置く想定）。
 *
 * やり取りするメッセージ:
 *   → { t:'join', room, character }
 *   ← { t:'start', slot, seed, characters }   両者が揃ったら送られてくる
 *   ⇄ { t:'input', frame, bits }
 *   ← { t:'peerLeft' }
 */
export class WebSocketTransport {
  /**
   * @param {string} url  例: wss://example.com/relay
   * @param {string} room 合言葉。同じ文字列を入れた2人がマッチングする。
   * @param {object} payload join に添えて送る情報（選んだキャラなど）
   */
  constructor(url, room, payload = {}) {
    this.url = url;
    this.room = room;
    this.payload = payload;
    this.socket = null;
    this.handler = null;
    /** ハンドラ登録前に届いたメッセージを取りこぼさないための控え。 */
    this.pending = [];
  }

  connect() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const socket = new WebSocket(this.url);
      this.socket = socket;

      socket.addEventListener('open', () => {
        settled = true;
        socket.send(JSON.stringify({ t: 'join', room: this.room, ...this.payload }));
        resolve();
      });
      socket.addEventListener('message', (ev) => {
        let msg;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        this._deliver(msg);
      });
      socket.addEventListener('error', () => {
        if (!settled) reject(new Error('接続に失敗しました'));
      });
      socket.addEventListener('close', () => {
        this._deliver({ t: 'closed' });
      });
    });
  }

  _deliver(msg) {
    if (this.handler) this.handler(msg);
    else this.pending.push(msg);
  }

  /**
   * ハンドラを差し替える。session.js が後から自分のハンドラを付けるので、
   * それまでに溜まったメッセージをここで流し込む。
   */
  onMessage(handler) {
    this.handler = handler;
    const queued = this.pending;
    this.pending = [];
    for (const msg of queued) handler(msg);
  }

  send(msg) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(msg));
    }
  }

  close() {
    this.socket?.close();
    this.socket = null;
  }
}
