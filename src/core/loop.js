/**
 * 固定ステップのゲームループ。
 *
 * 描画は画面のリフレッシュレート任せ（60Hz でも 120Hz でも 144Hz でも）だが、
 * シミュレーションは必ず 1/60 秒刻みで進める。これを守らないと、
 * 環境によって技の発生フレームが変わってしまうし、
 * オンライン対戦で両者の結果が食い違う。
 */
import { TICK_MS } from '../game/constants.js';

/** 一度に処理する最大ティック数。タブ復帰直後の暴走を防ぐ。 */
const MAX_CATCHUP = 5;

export class GameLoop {
  /**
   * @param {(tick:number)=>void} update 1ティック進める
   * @param {(alpha:number)=>void} render alpha は次ティックまでの補間係数 0..1
   */
  constructor(update, render) {
    this.update = update;
    this.render = render;
    this.running = false;
    this.accumulator = 0;
    this.lastTime = 0;
    this.tick = 0;
    this._frame = this._frame.bind(this);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    this.accumulator = 0;
    requestAnimationFrame(this._frame);
  }

  stop() {
    this.running = false;
  }

  _frame(now) {
    if (!this.running) return;
    requestAnimationFrame(this._frame);

    const elapsed = now - this.lastTime;
    this.lastTime = now;
    // 大きく飛んだとき（タブ非表示など）は捨てる
    this.accumulator = Math.min(this.accumulator + elapsed, TICK_MS * MAX_CATCHUP);

    while (this.accumulator >= TICK_MS) {
      this.accumulator -= TICK_MS;
      this.tick += 1;
      this.update(this.tick);
    }

    this.render(this.accumulator / TICK_MS);
  }
}
