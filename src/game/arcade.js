/**
 * アーケードモード（勝ち抜き）の進行。
 *
 * 「対戦相手の順番を最初に決めて、いま何戦目かを覚えている」だけの箱で、
 * 試合（Simulation）にも DOM にも触らない。だから
 *   - main.js は「次の相手は誰か」を聞くだけ
 *   - テストは試合を動かさずに順番の性質だけ検証できる
 * という切り分けになる。
 *
 * ルール:
 *   - 負けたらそこで終わり（ゲームオーバー）。取り返しはきかない
 *   - 相手は毎回ランダム。ただし**一度当たった相手とは二度と当たらない**
 *   - 最大 MAX_BATTLES 戦。全部倒せば全制覇
 *
 * 「二度と当たらない」は、始めるときに一度だけ並びをシャッフルして
 * それを最後まで使うことで保証している（毎回引き直して重複を弾く形だと、
 * 残りが少なくなるほど引き直しが増えるうえ、上限まで戦えるとは限らなくなる）。
 */
import { Rng } from '../core/rng.js';

/** 1回の勝ち抜きで戦える最大の試合数。 */
export const MAX_BATTLES = 10;

export class ArcadeRun {
  /**
   * @param {string} playerId プレイヤーが選んだキャラの id
   * @param {string[]} pool 相手候補の id（ふつうは CHARACTER_IDS）
   * @param {number} [seed] 並びの乱数シード。省略時は毎回変わる
   */
  constructor(playerId, pool, seed) {
    this.playerId = playerId;
    this.rng = new Rng(seed ?? ((Math.random() * 0xffffffff) >>> 0));

    // 自分と同じキャラも相手に入れる（同キャラ対決）。
    // 10 キャラで 10 戦するにはこれが要るし、鏡写しの相手は勝ち抜きの締めとして
    // ちょうどいい……のだが、順番はランダムなので何戦目に来るかは分からない。
    this.order = this._shuffle(pool).slice(0, MAX_BATTLES);

    /** いま何戦目か（0始まり）。倒すたびに 1 増える。 */
    this.index = 0;
  }

  /** Fisher-Yates。sim と同じ Rng を通すので、シードを固定すれば並びも再現できる。 */
  _shuffle(ids) {
    const a = ids.slice();
    for (let i = a.length - 1; i > 0; i -= 1) {
      const j = this.rng.int(0, i + 1);
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  /** 全部で何戦あるか。 */
  get total() {
    return this.order.length;
  }

  /** いま何戦目か（1始まり、表示用）。全制覇後は total + 1 になる。 */
  get battleNo() {
    return this.index + 1;
  }

  /** 次に戦う相手の id。全制覇後は null。 */
  get opponent() {
    return this.order[this.index] ?? null;
  }

  /** これまでに倒した相手の id。 */
  get defeated() {
    return this.order.slice(0, this.index);
  }

  /** 全部倒し切ったか。 */
  get isClear() {
    return this.index >= this.total;
  }

  /**
   * 1 戦勝った。
   * @returns {boolean} 全制覇したら true
   */
  win() {
    if (!this.isClear) this.index += 1;
    return this.isClear;
  }
}
