/**
 * スワイプの認識。
 *
 * DOM もゲームのルールも知らない純粋な計算だけを置く。
 * ポインタの座標を流し込むと「どちらへ、どれだけ弾いたか」が返るだけなので、
 * ブラウザ無しでテストできる（tools/simtest.mjs を参照）。
 *
 * 見ているのは **向きと距離だけで、速さは見ていない**。
 * ゆっくり指を滑らせても素早く弾いても同じ扱いになる。
 * 速さを条件にすると「強く弾いたつもりが出ない」が起きやすく、
 * 一撃で決まるこのゲームでは取りこぼしの方が痛いため。
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
   * 横スワイプがこれ以上伸びたら「走る」。
   * 小さく弾けば歩き、大きく弾けば走りになる。
   * 弾いた指をそのまま引き伸ばしても走りに切り替わるよう、
   * 認識後も同じ向きへの伸びを追い続ける。
   */
  RUN: 68,
  /** 同じ向きへ伸びたことを報告し直す最小の増分（報告が細かくなりすぎないように）。 */
  PROGRESS: 8,
  /**
   * 認識した後、直前のスワイプと逆向きにこれだけ戻したら次を受け付ける。
   * 「弾く → 指を戻す → また弾く」を1タッチで続けるための仕掛け。
   */
  REARM: 13,
  /**
   * 「戻し」と見なす角度の許容（直前に弾いた向きの真逆からのずれ、tan で指定）。
   *
   * これが無いと、横に弾いた直後の**斜め上への弾きが戻しとして食われて**
   * ジャンプが出ない。真逆に近い動きだけを戻しとして扱い、
   * 横にずれた動きは新しいスワイプとして拾う。
   */
  RETRACT_SLOPE: 0.58, // tan(30°)
};

const DEG = 180 / Math.PI;

/**
 * 移動量を8方向ではなく「意味のある6通り」へ畳む。
 *
 * 横を広く（各90°）、真上と真下を狭く（各60°）取ってある。
 * 横に大きく弾くと指は弧を描いて上下に流れるので、横を狭くすると
 * 走ったつもりがジャンプになる。逆に斜め上を残さないと斜めジャンプが出せない。
 *
 * @param {number} dx 右が正
 * @param {number} dy **画面座標**なので下が正
 */
export function classifySwipe(dx, dy) {
  const deg = Math.atan2(-dy, dx) * DEG; // 上が +90 になる
  if (deg >= 60 && deg < 120) return GESTURE.UP;
  if (deg >= 30 && deg < 60) return GESTURE.UP_RIGHT;
  if (deg >= 120 && deg < 150) return GESTURE.UP_LEFT;
  if (deg >= -120 && deg < -60) return GESTURE.DOWN;
  if (deg >= 150 || deg < -120) return GESTURE.LEFT;
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
    /** 直前のサンプル。折り返し点を拾うのに使う。 */
    this.px = x;
    this.py = y;
    this.hasPrev = false;
    this.last = null;
    /** 直近のスワイプの向き（単位ベクトル）。戻しと切り返しの判定に使う。 */
    this.lx = 0;
    this.ly = 0;
    /**
     * 認識してからこの向きへ進んだ合計距離と、最後に報告した距離。
     * 基準点は指に追従して動かすので、走りの判定用に別途積んでいる。
     */
    this.travel = 0;
    this.reported = 0;
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
   * @returns {{gesture: string, dist: number, fresh: boolean} | null}
   *   dist は弾いた向きへの合計距離。横スワイプではこれで歩き／走りが決まる。
   *   fresh は「指を戻して構え直したところから弾いた」＝新しい弾きかどうか。
   *   false は同じ弾きの続き（切り返しや引き伸ばし）で、1回の弾きに
   *   1回きりの入力（ジャンプ）を何度も出さないための目印になる。
   */
  move(x, y, now) {
    if (!this.active) return null;
    const dx = x - this.ax;
    const dy = y - this.ay;
    const dist = Math.hypot(dx, dy);

    if (this.armed) {
      if (dist >= this.cfg.THRESHOLD) {
        return this._fire(classifySwipe(dx, dy), dist, x, y, dx, dy, true);
      }
      // まだ届いていない。ここで指が向きを変えたら、**折り返した点**を起点に置き直す。
      // 戻している途中の点を起点にすると、そこから引き返して弾いたぶんが
      // 目減りして、次のスワイプが届かなくなる。
      if (this.hasPrev && (x - this.px) * dx + (y - this.py) * dy < 0) {
        this.ax = this.px;
        this.ay = this.py;
      }
      this._mark(x, y);
      return null;
    }

    // 直前のスワイプ方向を軸に、進んだ量（along）と横へのずれ（perp）に分ける
    const along = dx * this.lx + dy * this.ly;
    const perp = Math.hypot(dx - along * this.lx, dy - along * this.ly);

    // 真逆に近い方向へ戻した ＝ 次のスワイプの構え。ここでは何も出さない。
    // 横へずれている動きは戻しではないので、下の分岐に落として拾う。
    if (along <= -this.cfg.REARM && perp <= Math.abs(along) * this.cfg.RETRACT_SLOPE) {
      this.ax = x;
      this.ay = y;
      this.armed = true;
      this._mark(x, y);
      return null;
    }

    // 別の向きへ切り返した。直前の向きとの直交成分ではなく合計距離で見るので、
    // 斜めに弾いても取りこぼさない。
    const gesture = classifySwipe(dx, dy);
    if (gesture !== this.last && dist >= this.cfg.THRESHOLD) {
      return this._fire(gesture, dist, x, y, dx, dy, false);
    }

    // 同じ向きへ引き伸ばした。
    //
    // ここで基準点を指に追従させるのが要点。置いていかれた基準点から向きを
    // 測ると、さっきの弾きの分が混ざって次の弾きが化ける
    // （左へ歩いた後の斜め右上が真上ジャンプになる、など）。
    // 走りに使う距離は基準点とは別に積む。
    if (along > 0 && perp <= along * this.cfg.RETRACT_SLOPE) {
      this.travel += along;
      this.ax = x;
      this.ay = y;
      this._mark(x, y);
      // 伸びを報告し直すのは横だけ。歩き → 走りに上げるための仕組みなので、
      // ジャンプのような一度きりの入力に出すと、1回の弾きで何度も跳んでしまう。
      const continuous = this.last === GESTURE.LEFT || this.last === GESTURE.RIGHT;
      if (continuous && this.travel >= this.reported + this.cfg.PROGRESS) {
        this.reported = this.travel;
        return { gesture: this.last, dist: this.travel, fresh: false };
      }
    }
    return null;
  }

  /** @param {boolean} fresh 構え直してから弾いたか（＝1回の弾きの1発目か） */
  _fire(gesture, dist, x, y, dx, dy, fresh) {
    const len = dist || 1;
    this.lx = dx / len;
    this.ly = dy / len;
    this.last = gesture;
    this.ax = x;
    this.ay = y;
    this.armed = false;
    this.travel = dist;
    this.reported = dist;
    this._mark(x, y);
    return { gesture, dist, fresh };
  }

  /** 折り返し検出のために直前位置を覚えておく。 */
  _mark(x, y) {
    this.px = x;
    this.py = y;
    this.hasPrev = true;
  }
}
