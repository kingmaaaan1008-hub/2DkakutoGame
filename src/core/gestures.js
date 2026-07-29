/**
 * スワイプの認識。
 *
 * DOM もゲームのルールも知らない純粋な計算だけを置く。
 * ポインタの座標を流し込むと「どちらへ弾いたか」が返るだけなので、
 * ブラウザ無しでテストできる（tools/simtest.mjs を参照）。
 *
 * 指を画面から離さずに続けて操作できることが要件なので、
 * 「1タッチ = 1スワイプ」ではなく、**触っている間に何度でも**
 * スワイプを拾える形にしてある。そのために基準点を持ち回し、
 * 認識するたびに現在位置へ置き直す。
 */

export const GESTURE = {
  UP: 'up',
  UP_LEFT: 'upLeft',
  UP_RIGHT: 'upRight',
  LEFT: 'left',
  RIGHT: 'right',
  DOWN: 'down',
};

/** 判定に使う距離は CSS px。指の太さと、狙って弾ける最小の距離から決めている。 */
export const SWIPE = {
  /** 基準点からこれだけ動いたらスワイプ1回とみなす。 */
  THRESHOLD: 26,
  /**
   * 認識した後、直前のスワイプと逆向きにこれだけ戻したら次を受け付ける。
   * 「左に弾く → 指を戻す → また左に弾く」でダッシュに入れるための仕掛けで、
   * この戻しを右スワイプと誤認しないよう、戻しは常に「再武装」として扱う。
   */
  REARM: 13,
  /** 戻さずに同じ向きへさらに引いたとき、2回目とみなす距離。 */
  CONTINUE: 52,
  /**
   * 同じ向きへ2回で「ダッシュ」と見なす間隔（ミリ秒）。
   *
   * ボタンの2度押しより長めに取ってある。スワイプ2回は
   * 「弾く → 指を戻す → また弾く」の3動作で、指が物理的に往復する分だけ
   * どうしても時間がかかる。短すぎると走りたいのに歩きしか出ない。
   * 逆に長くしても困らない（同じ向きへ2回弾く操作に、走る以外の意味が無い）。
   */
  DOUBLE_MS: 600,
};

const DEG = 180 / Math.PI;

/**
 * 移動量を8方向ではなく「意味のある6通り」へ畳む。
 *
 * 真上と真下は狭く（±22.5° / ±30°）、横は広く取ってある。
 * 横に弾くとき指はどうしても下に流れるので、斜め下は横スワイプとして扱う。
 * 逆に斜め上は独立させないと、斜めジャンプが出せない。
 *
 * @param {number} dx 右が正
 * @param {number} dy **画面座標**なので下が正
 */
export function classifySwipe(dx, dy) {
  const deg = Math.atan2(-dy, dx) * DEG; // 上が +90 になる
  if (deg >= 67.5 && deg < 112.5) return GESTURE.UP;
  if (deg >= 22.5 && deg < 67.5) return GESTURE.UP_RIGHT;
  if (deg >= 112.5 && deg < 157.5) return GESTURE.UP_LEFT;
  if (deg >= -120 && deg < -60) return GESTURE.DOWN;
  if (deg >= 157.5 || deg < -120) return GESTURE.LEFT;
  return GESTURE.RIGHT;
}

/** 指1本ぶんの状態。エリアごとに1個持つ。 */
export class SwipeTracker {
  constructor(cfg = SWIPE) {
    this.cfg = cfg;
    this.active = false;
    this._reset(0, 0);
  }

  _reset(x, y) {
    /** 次のスワイプを測る基準点。 */
    this.ax = x;
    this.ay = y;
    /** true なら THRESHOLD 動いた時点で認識する。 */
    this.armed = true;
    this.last = null;
    this.lastAt = -Infinity;
    /** 直近のスワイプの向き（単位ベクトル）。戻しと切り返しの判定に使う。 */
    this.lx = 0;
    this.ly = 0;
  }

  start(x, y) {
    this.active = true;
    this._reset(x, y);
  }

  end() {
    this.active = false;
  }

  /**
   * 指が動いたことを伝える。認識できたときだけ結果を返す。
   * @returns {{gesture: string, repeat: boolean} | null}
   *   repeat は「同じ向きへ続けて2回」＝ダッシュ要求。
   */
  move(x, y, now) {
    if (!this.active) return null;
    const dx = x - this.ax;
    const dy = y - this.ay;

    if (this.armed) {
      if (Math.hypot(dx, dy) < this.cfg.THRESHOLD) return null;
      return this._fire(classifySwipe(dx, dy), x, y, dx, dy, now);
    }

    // 直前のスワイプ方向を軸に、成分を分けて見る
    const along = dx * this.lx + dy * this.ly;
    const perp = Math.hypot(dx - along * this.lx, dy - along * this.ly);

    // 別の向きへ切り返した（横 → 上、しゃがみ → 横 など）
    if (perp >= this.cfg.THRESHOLD) {
      return this._fire(classifySwipe(dx, dy), x, y, dx, dy, now);
    }
    // 戻さずに同じ向きへ引き続けた
    if (along >= this.cfg.CONTINUE) {
      return this._fire(this.last, x, y, dx, dy, now);
    }
    // 指を戻した。ここでは何も出さず、次のスワイプを受け付ける状態に戻すだけ
    if (along <= -this.cfg.REARM) {
      this.ax = x;
      this.ay = y;
      this.armed = true;
    }
    return null;
  }

  _fire(gesture, x, y, dx, dy, now) {
    const repeat = gesture === this.last && now - this.lastAt <= this.cfg.DOUBLE_MS;
    const len = Math.hypot(dx, dy) || 1;
    this.lx = dx / len;
    this.ly = dy / len;
    this.last = gesture;
    this.lastAt = now;
    this.ax = x;
    this.ay = y;
    this.armed = false;
    return { gesture, repeat };
  }
}
