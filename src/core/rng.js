/**
 * 決定的な擬似乱数。
 *
 * Math.random() はシード指定ができず、同じ入力から同じ試合を再現できない。
 * オンライン対戦（ロックステップ／ロールバック）では両者のシミュレーションが
 * 1 ビットも違ってはいけないので、乱数はすべてこれを通す。
 * mulberry32: 状態が 32bit 整数ひとつだけなので、セーブ/ロードも簡単。
 */
export class Rng {
  constructor(seed = 1) {
    this.state = seed >>> 0;
  }

  /** [0, 1) の実数。 */
  next() {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** min 以上 max 未満の整数。 */
  int(min, max) {
    return min + Math.floor(this.next() * (max - min));
  }

  /** 確率 p で true。 */
  chance(p) {
    return this.next() < p;
  }

  save() {
    return this.state;
  }

  restore(state) {
    this.state = state >>> 0;
  }
}
