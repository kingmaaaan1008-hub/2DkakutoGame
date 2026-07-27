/**
 * 「誰の入力で、いつシミュレーションを進めるか」を決める層。
 *
 * ゲームループはセッションに `advance(localBits)` を呼ぶだけでよく、
 * 相手が CPU なのか、隣に座った人間なのか、回線の向こうの誰かなのかを
 * 意識しない。オンライン対応はここに実装を1つ足すだけで済む。
 */
import { Simulation } from '../game/sim.js';

/** ローカル（CPU戦・同一端末での2人対戦）。入力が揃っているので毎ティック進む。 */
export class LocalSession {
  /**
   * @param {Simulation} sim
   * @param {(sim:Simulation)=>number|null} secondInput
   *        2P の入力を作る関数。CPU なら ai.think、人間なら null。
   */
  constructor(sim, secondInput = null) {
    this.sim = sim;
    this.secondInput = secondInput;
    this.ready = true;
    this.status = '';
  }

  /**
   * @param {number[]} localBits [P1の入力, P2の入力]
   * @returns {boolean} 実際に1ティック進んだか
   */
  advance(localBits) {
    const p2 = this.secondInput ? this.secondInput(this.sim) : localBits[1];
    this.sim.step([localBits[0], p2]);
    return true;
  }

  dispose() {}
}

/**
 * オンライン対戦（入力遅延ロックステップ）。
 *
 * 仕組み:
 *   - 自分の入力は「今のフレーム + DELAY」のものとして即送信する
 *   - 両者の入力が揃ったフレームだけシミュレーションを進める
 *   - 相手の入力が届いていなければ、その場で待つ（画面は止まる）
 *
 * 入力遅延方式なので実装は小さいが、遅延がそのまま操作感に出る。
 * 体感を詰めるならロールバックにするが、その足場（Simulation.save/load）は
 * すでに用意してあるので、このクラスを差し替えるだけで移行できる。
 */
export class LockstepSession {
  /**
   * @param {Simulation} sim
   * @param {import('./transport.js').Transport} transport
   * @param {number} slot 自分が 0(1P) か 1(2P) か
   * @param {number} delay 入力遅延フレーム数
   */
  constructor(sim, transport, slot, delay = 3) {
    this.sim = sim;
    this.transport = transport;
    this.slot = slot;
    this.delay = delay;
    this.frame = 0;
    /** frame → [P1の入力, P2の入力]（届いた分だけ埋まる） */
    this.inputs = new Map();
    this.connected = true;
    this.status = '';

    // 最初の delay フレーム分は「何も押していない」で埋めておく。
    // こうしないと開始直後に相手の入力待ちで固まる。
    for (let f = 0; f < delay; f += 1) {
      this._store(f, 0, 0);
      this._store(f, 1, 0);
    }

    transport.onMessage((msg) => {
      if (msg.t === 'input') this._store(msg.frame, 1 - this.slot, msg.bits);
      else if (msg.t === 'peerLeft' || msg.t === 'closed') this.connected = false;
    });
  }

  _store(frame, slot, bits) {
    let pair = this.inputs.get(frame);
    if (!pair) {
      pair = [null, null];
      this.inputs.set(frame, pair);
    }
    pair[slot] = bits;
  }

  advance(localBits) {
    if (!this.connected) {
      this.status = '相手との接続が切れました';
      return false;
    }

    // 自分の入力を先の帯に予約して送る
    const sendFrame = this.frame + this.delay;
    const bits = localBits[0];
    this._store(sendFrame, this.slot, bits);
    this.transport.send({ t: 'input', frame: sendFrame, bits });

    const pair = this.inputs.get(this.frame);
    if (!pair || pair[0] == null || pair[1] == null) {
      // 相手の入力待ち。ここで止めることで両者の進行を揃える。
      this.status = '同期待ち…';
      return false;
    }

    this.status = '';
    this.sim.step(pair);
    this.inputs.delete(this.frame);
    this.frame += 1;
    return true;
  }

  dispose() {
    this.transport.close();
  }
}
