/**
 * CPU の思考ルーチン。
 *
 * 出力は人間と同じ「入力ビットマスク」なので、シミュレーションから見ると
 * プレイヤーと区別がつかない。乱数は sim.rng を通しているため、
 * CPU 戦もリプレイ・ロールバックがそのまま成立する。
 */
import { BTN, STATE } from './constants.js';

/** 難易度プリセット。反応の速さと手の出し方の荒さを変える。 */
export const DIFFICULTY = {
  easy: { react: 22, aggression: 0.35, guardChance: 0.3, skillChance: 0.06, dashChance: 0.1 },
  normal: { react: 12, aggression: 0.55, guardChance: 0.55, skillChance: 0.12, dashChance: 0.25 },
  hard: { react: 6, aggression: 0.75, guardChance: 0.8, skillChance: 0.2, dashChance: 0.4 },
};

export class CpuController {
  /**
   * @param {number} index 操作する側（0 or 1）
   * @param {keyof DIFFICULTY} level
   */
  constructor(index, level = 'normal') {
    this.index = index;
    this.cfg = DIFFICULTY[level] ?? DIFFICULTY.normal;
    this.plan = { bits: 0, ticks: 0 };
    this.cooldown = 0;
  }

  /** 相手が攻撃モーション中で、まだ判定が出ていない（＝これから来る）か。 */
  _incomingAttack(opponent) {
    if (opponent.state !== STATE.MOVE) return false;
    const move = opponent.currentMove();
    if (!move || move.hits.length === 0) return false;
    const last = move.hits[move.hits.length - 1];
    return opponent.moveFrame <= last.end;
  }

  /**
   * そのティックの入力を返す。
   * @param {import('./sim.js').Simulation} sim
   */
  think(sim) {
    const me = sim.fighters[this.index];
    const foe = sim.fighters[1 - this.index];
    if (!sim.isRunning || me.isKO) return 0;

    if (this.cooldown > 0) this.cooldown -= 1;

    // 決めた行動は数ティック維持する。毎フレーム考え直すと
    // 入力が細切れになってダッシュもガードも成立しないため。
    if (this.plan.ticks > 0) {
      this.plan.ticks -= 1;
      return this.plan.bits;
    }

    const rng = sim.rng;
    const dist = Math.abs(foe.x - me.x);
    const toFoe = foe.x >= me.x ? BTN.RIGHT : BTN.LEFT;
    const away = foe.x >= me.x ? BTN.LEFT : BTN.RIGHT;

    // 得意距離。遠距離キャラは離れて弾を撒く。
    const ranged = me.def.id === 'mage';
    const idealRange = ranged ? 430 : 150;
    const strikeRange = ranged ? 620 : 175;

    let bits = 0;
    let ticks = this.cfg.react;

    // 1. 相手の攻撃が来ているならガードを優先
    if (this._incomingAttack(foe) && dist < 260 && rng.chance(this.cfg.guardChance)) {
      bits = BTN.GUARD;
      ticks = 14;
    }
    // 2. 間合いに入っていれば攻撃（ダウン中の相手には当たらないので振らない）
    else if (
      dist < strikeRange &&
      !foe.invulnerable &&
      this.cooldown === 0 &&
      rng.chance(this.cfg.aggression)
    ) {
      if (rng.chance(this.cfg.skillChance)) {
        bits = BTN.SKILL;
        this.cooldown = 90;
      } else {
        bits = BTN.ATTACK;
        this.cooldown = ranged ? 10 : 24;
      }
      ticks = 6;
    }
    // 3. 近すぎるので下がる（歩き後退は相手を向いたままになる）
    else if (dist < idealRange * 0.55) {
      bits = away;
      ticks = 16;
    }
    // 4. 遠いので詰める。たまにダッシュや飛び込みを混ぜる
    else if (dist > idealRange) {
      bits = toFoe;
      if (rng.chance(this.cfg.dashChance)) {
        // 2度押しでダッシュ扱いになるよう、1フレーム離してから入れ直す
        this.plan = { bits: toFoe, ticks: 2 };
        return 0;
      }
      if (dist > 320 && rng.chance(0.08)) bits |= BTN.UP;
      ticks = 12;
    }
    // 5. 手持ち無沙汰。少し揺さぶる
    else {
      bits = rng.chance(0.5) ? toFoe : away;
      ticks = 10;
    }

    this.plan = { bits, ticks };
    return bits;
  }
}
