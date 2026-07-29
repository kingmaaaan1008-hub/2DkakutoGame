/**
 * CPU の思考ルーチン。
 *
 * 出力は人間と同じ「入力ビットマスク」なので、シミュレーションから見ると
 * プレイヤーと区別がつかない。乱数は sim.rng を通しているため、
 * CPU 戦もリプレイ・ロールバックがそのまま成立する。
 */
import { BTN, STATE } from './constants.js';
import { CROUCH_CLEAR_Y } from './fighter.js';

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

  /**
   * これから出てくる攻撃判定を全部集める。
   *
   * 溜め技（ビームの溜め・タックルの溜め）は、その段階では判定を 1 つも
   * 持っていない。onEnd の先まで辿らないと「何が来るのか」が分からないので、
   * ここで繋ぎ先も一緒に見ている。溜めを見てから避ける／しゃがむ、が
   * 成立するのはこれのおかげ。
   */
  _upcomingHits(opponent) {
    const hits = [];
    let move = opponent.currentMove();
    for (let guard = 0; move && guard < 4; guard += 1) {
      hits.push(...move.hits);
      move = move.onEnd ? opponent.def.moves[move.onEnd] : null;
    }
    return hits;
  }

  /** 相手が攻撃モーション中で、まだ判定が出ていない（＝これから来る）か。 */
  _incomingAttack(opponent) {
    if (opponent.state !== STATE.MOVE) return false;
    const move = opponent.currentMove();
    if (!move) return false;
    // 溜めの段階。判定はまだ無いが、確実にこれから来る
    if (move.onEnd) return true;
    if (move.hits.length === 0) return false;
    const last = move.hits[move.hits.length - 1];
    return opponent.moveFrame <= last.end;
  }

  /**
   * しゃがめば下をくぐれる攻撃か。
   * 判定がひとつでも低いところに出るなら、しゃがんでも当たるので false。
   * 魔法使いのビーム（地上から 107〜205 を薙ぐ）がこれに当たる。
   */
  _isDuckable(opponent) {
    if (opponent.state !== STATE.MOVE) return false;
    const hits = this._upcomingHits(opponent);
    if (hits.length === 0) return false;
    // 空中から撃たれていれば判定はさらに高いので、そのぶん下駄を履かせる
    const lift = opponent.y;
    return hits.every((h) => h.box.y + lift >= CROUCH_CLEAR_Y);
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

    // 0. 空中に居るときは空中技と2段ジャンプしか選べないので、先に分けて考える。
    //    降り際（vy < 0）に振ると地上の相手に当たりやすい。
    if (me.airborne && me.state === STATE.JUMP) {
      let air = 0;
      if (dist < 220 && me.vy < 0 && !foe.invulnerable && rng.chance(this.cfg.aggression)) {
        air = rng.chance(this.cfg.skillChance * 2) ? BTN.SKILL : BTN.ATTACK;
      } else if (me.airJumps > 0 && this._incomingAttack(foe) && rng.chance(this.cfg.guardChance)) {
        // 一発が致命傷なので、跳び直して軌道をずらす
        air = BTN.UP;
      } else if (dist > 200) {
        air = toFoe;
      }
      this.plan = { bits: air, ticks: 5 };
      return air;
    }

    let bits = 0;
    let ticks = this.cfg.react;

    // 1. ビームのように高いところだけを薙ぐ攻撃は、しゃがんでくぐる。
    //    ガードより先に見るのは、ビームがガード不能だから。
    //    ビームは画面端まで届くので、間合いは見ずに構える。
    if (this._incomingAttack(foe) && this._isDuckable(foe) && rng.chance(this.cfg.guardChance)) {
      // 溜めが 1 秒あるので、構えたら撃ち終わるまで下を押しっぱなしにする
      this.plan = { bits: BTN.DOWN, ticks: 50 };
      return BTN.DOWN;
    }

    // 2. 相手の攻撃が来ているならガードを優先
    if (this._incomingAttack(foe) && dist < 260 && rng.chance(this.cfg.guardChance)) {
      bits = BTN.GUARD;
      ticks = 14;
    }
    // 3. 間合いに入っていれば攻撃（ダウン中の相手には当たらないので振らない）
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
    // 4. 近すぎるので下がる（歩き後退は相手を向いたままになる）
    else if (dist < idealRange * 0.55) {
      bits = away;
      ticks = 16;
    }
    // 5. 遠いので詰める。たまにダッシュや飛び込みを混ぜる
    else if (dist > idealRange) {
      bits = toFoe;
      if (rng.chance(this.cfg.dashChance)) {
        // 2度押しでダッシュ扱いになるよう、1フレーム離してから入れ直す
        this.plan = { bits: toFoe, ticks: 2 };
        return 0;
      }
      // 飛び込みは有効な間合いの詰め方なので、遠いときは混ぜる
      if (dist > 300 && rng.chance(0.16)) bits |= BTN.UP;
      ticks = 12;
    }
    // 6. 手持ち無沙汰。少し揺さぶる
    else {
      bits = rng.chance(0.5) ? toFoe : away;
      ticks = 10;
    }

    this.plan = { bits, ticks };
    return bits;
  }
}
