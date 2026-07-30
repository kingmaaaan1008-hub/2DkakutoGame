/**
 * CPU の思考ルーチン。
 *
 * 出力は人間と同じ「入力ビットマスク」なので、シミュレーションから見ると
 * プレイヤーと区別がつかない。乱数は sim.rng を通しているため、
 * CPU 戦もリプレイ・ロールバックがそのまま成立する。
 *
 * ── 方針 ────────────────────────────────────────────────────
 * 一発当たったら即死なので、**振るか振らないか**の判断がほぼ全部を決める。
 * 手数を増やすより「当たる間合いでしか振らない」「相手の隙にだけ差し込む」
 * を守るほうが強い。そこで
 *
 *   1. 技の間合いと発生を技データから割り出し、届く距離でしか振らない
 *   2. 相手が手を出せない時間（空振りの戻り・着地・のけぞり・ガード硬直）を
 *      見つけて、そこにだけ差し込む
 *   3. 固められたらスキルで崩す。逆に自分が不利なら間合いを外す
 *
 * を土台にしている。難易度はこの判断をどれだけ拾えるかで変える。
 */
import { BTN, STATE } from './constants.js';
import { CROUCH_CLEAR_Y, HURTBOX } from './fighter.js';
import { isProjectile } from './projectiles.js';

/**
 * 難易度プリセット。
 *
 * `hold` は決めた行動を維持する時間の倍率。大きいほど「読み直しが遅い」＝
 * 状況が変わっても前の判断を引きずるので、弱くなる。
 * ほかは「その手をどれだけ重く見るか」。大きいほどその状況で正しく選べる。
 */
export const DIFFICULTY = {
  easy: {
    react: 20,
    hold: 1.9,
    guard: 0.3,
    punish: 0.18,
    aggression: 0.4,
    crush: 0.25,
    dash: 0.1,
    spacing: 0.25,
  },
  normal: {
    react: 9,
    hold: 1.25,
    guard: 0.62,
    punish: 0.55,
    aggression: 0.6,
    crush: 0.6,
    dash: 0.35,
    spacing: 0.55,
  },
  hard: {
    react: 3,
    hold: 0.8,
    guard: 0.94,
    punish: 0.92,
    aggression: 0.8,
    crush: 0.92,
    dash: 0.7,
    spacing: 0.9,
  },
};

/** やられ判定の半幅。相手のこのぶんだけ、技は手前で当たり始める。 */
const HURT_HALF = HURTBOX.w / 2;

/** 飛び道具の技は画面の向こうまで届くものとして扱う。 */
const PROJECTILE_REACH = 900;

/** これより発生が遅い技は「振ったら戻れない大技」として扱う。 */
const SLOW_STARTUP = 20;

/** この高さより下に収まっている攻撃は、跳べば頭の上を通せる。 */
const JUMP_CLEAR_Y = 170;

/**
 * 逃げる手が間に合うのに必要な猶予（判定が出るまでのフレーム数）。
 * 跳ぶ・下がるは動き出しに時間がかかるので、
 * 残り時間を見ずに選ぶと「逃げようとして食らう」になる。
 */
const JUMP_ESCAPE_FRAMES = 9;
const RETREAT_ESCAPE_FRAMES = 7;

/** 気分の持続（ティック）。数秒ごとに攻めっ気と守りっ気が入れ替わる。 */
const MOOD_MIN = 90;
const MOOD_MAX = 220;

/** キャラ定義ごとの技の性能。技データから割り出したものを覚えておく。 */
const PROFILES = new WeakMap();

/**
 * 技の間合い・発生・飛び道具かどうかを技データから割り出す。
 *
 * 数値を手で書くと技を調整したときに置いていかれるので、必ずデータから引く。
 * 溜め技は自分では判定を持たず `onEnd` の先に本体があるので、
 * 繋ぎ先まで辿り、発生フレームは前段の全体フレームを足して数える
 * （魔法使いの照射なら「1秒の溜め＋本体の発生」が発生フレームになる）。
 */
export function profileOf(def) {
  const cached = PROFILES.get(def);
  if (cached) return cached;

  const scan = (id) => {
    let move = def.moves[id];
    let reach = 0;
    let travel = 0;
    let startup = Infinity;
    let projectile = false;
    let offset = 0;
    let total = 0;
    for (let guard = 0; move && guard < 4; guard += 1) {
      for (const h of move.hits) {
        reach = Math.max(reach, h.box.x + h.box.w);
        startup = Math.min(startup, offset + h.start);
      }
      // 踏み込む技は移動ぶんだけ遠くまで届く。
      // 剣士のタックルは判定リーチ 142 でも、182 前進するので実際は 324 届く。
      for (const m of move.motion) {
        if ((m.vx ?? 0) > 0) travel += m.vx * (m.end - m.start + 1);
      }
      // 飛び道具は自分では判定を持たないので、発生は弾を撃つフレームで数える。
      // spawns には演出も混ざる（照射の溜めが出す魔法陣など）ので、
      // 実弾として定義されている type だけを見る。
      // ここを取り違えると「溜め 1 秒の照射」を発生 0 の技だと思い込んで、
      // 密着で溜め始めてそのまま的になる。
      for (const sp of move.spawns) {
        if (!isProjectile(sp.type)) continue;
        projectile = true;
        startup = Math.min(startup, offset + (sp.frame ?? 0));
      }
      offset += move.total;
      total = offset;
      move = move.onEnd ? def.moves[move.onEnd] : null;
    }
    if (projectile) reach = Math.max(reach, PROJECTILE_REACH);
    return {
      /** 判定が届く距離（相手のやられ判定ぶんを含む実効射程）。 */
      range: reach + travel + HURT_HALF,
      startup: Number.isFinite(startup) ? startup : total,
      total,
      projectile,
    };
  };

  const profile = { attack: scan(def.attackMove), skill: scan(def.skillMove) };
  PROFILES.set(def, profile);
  return profile;
}

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
    /** 直前に選んだ手と、それが続いた回数。同じ答えの連続を避けるのに使う。 */
    this.lastAct = '';
    this.repeat = 0;
    /**
     * 気分。'push'（攻め） / 'hold'（守り） / 'even'（ふつう）を
     * 数秒ごとに切り替える。同じ状況でも局面によって答えが変わるので、
     * 「この距離ならこう来る」と読み切られにくくなる。
     */
    this.mood = 'even';
    this.moodTicks = 0;
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
   * 今出てきている技が、この間合いの自分まで届くか。
   *
   * 判定ボックスの長さだけでは足りない。タックルのように踏み込む技は
   * 移動ぶんだけ遠くまで届くので、判定が終わるまでの前進量も足して見る。
   * 届かない技にガードを固めるのは、そのまま差し込む機会を捨てることになる。
   */
  _threatRange(opponent) {
    const hits = this._upcomingHits(opponent);
    if (hits.length === 0) return 0;
    let move = opponent.currentMove();
    let travel = 0;
    for (let guard = 0; move && guard < 4; guard += 1) {
      for (const m of move.motion) {
        if ((m.vx ?? 0) > 0) travel += m.vx * (m.end - m.start + 1);
      }
      move = move.onEnd ? opponent.def.moves[move.onEnd] : null;
    }
    const reach = Math.max(...hits.map((h) => h.box.x + h.box.w));
    return reach + travel + HURT_HALF;
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
   * 相手が「今は手を出せない」状態か。ここに差し込むのが一番安い。
   *
   * 振り切ったあとの戻り・着地硬直・のけぞり・ガード硬直がそれ。
   *
   * 連携（キャンセル）の受付が開いている区間は、続けて振られる可能性が
   * あるので隙とは見なさない。ここを隙として踏み込むと、繋がれた 2 段目に
   * そのまま刺されて損をする（実測でも突っ込む相手に대して勝率が 10 ポイント落ちた）。
   *
   * @returns {number} 差し込める猶予フレーム。0 なら隙ではない。
   */
  _openFrames(opponent) {
    if (opponent.invulnerable || opponent.isKO) return 0;

    // のけぞり・ガード硬直・ガードを崩された直後
    if (
      opponent.state === STATE.HIT ||
      opponent.state === STATE.BLOCK ||
      opponent.state === STATE.GUARD_BREAK
    ) {
      return Math.max(0, opponent.stunTicks - opponent.stateTimer);
    }
    // 着地硬直
    if (opponent.state === STATE.LAND) {
      return Math.max(0, opponent.landLag - opponent.stateTimer);
    }
    // 技の戻り。判定を出し切っていて、繋ぎ先も連携受付も無い区間
    if (opponent.state === STATE.MOVE) {
      const move = opponent.currentMove();
      if (!move || move.onEnd || move.hits.length === 0) return 0;
      const last = Math.max(...move.hits.map((h) => h.end));
      if (opponent.moveFrame <= last) return 0;
      const chainOpen = move.chains.some(
        (c) => opponent.moveFrame >= c.from - 2 && opponent.moveFrame <= c.to
      );
      if (chainOpen) return 0;
      return move.total - opponent.moveFrame;
    }
    return 0;
  }

  /** 相手がガードを固めているか（崩しに行く価値がある状態か）。 */
  _turtling(opponent) {
    return opponent.guardHeld && (opponent.state === STATE.GUARD || opponent.state === STATE.BLOCK);
  }

  /**
   * 跳べば頭の上を通せる攻撃か。しゃがみの逆で、判定が低いところに
   * 収まっているならジャンプで越えられる。ガード一択にしないための逃げ道。
   */
  _isJumpable(opponent) {
    const hits = this._upcomingHits(opponent);
    if (hits.length === 0) return false;
    const lift = opponent.y;
    return hits.every((h) => h.box.y + h.box.h + lift < JUMP_CLEAR_Y);
  }

  /** 相手の判定が出るまでの残りフレーム。もう出ているなら 0。 */
  _framesUntilHit(opponent) {
    const move = opponent.currentMove();
    if (!move) return Infinity;
    let scan = move;
    let offset = -opponent.moveFrame;
    for (let guard = 0; scan && guard < 4; guard += 1) {
      for (const h of scan.hits) {
        const at = offset + h.start;
        if (at >= 0) return at;
      }
      offset += scan.total;
      scan = scan.onEnd ? opponent.def.moves[scan.onEnd] : null;
    }
    return 0;
  }

  /**
   * 候補の中から 1 つ選ぶ。重みは「その状況でどれだけ有効か」。
   *
   * 一番良い手を毎回選ぶと、人間は数ラウンドで読んで対策してくる。
   * 有効な手が複数あるなら混ぜる。あわせて直前と同じ手は重みを落として、
   * 同じ状況で同じ答えを繰り返さないようにしている。
   */
  _choose(rng, options) {
    let total = 0;
    for (const o of options) {
      o.w = Math.max(0, o.weight) * (1 + this.moodBias(o.act));
      if (o.act === this.lastAct) o.w *= this.repeat >= 2 ? 0.25 : 0.55;
      total += o.w;
    }
    if (total <= 0) return this._commit({ act: 'wait', bits: 0, ticks: this.cfg.react });
    let roll = rng.next() * total;
    for (const o of options) {
      roll -= o.w;
      if (roll <= 0) return this._commit(o);
    }
    return this._commit(options[options.length - 1]);
  }

  /** 気分による重みの偏り。攻めっ気・守りっ気を数秒単位で揺らす。 */
  moodBias(act) {
    const push = act === 'attack' || act === 'skill' || act === 'rush' || act === 'jumpIn';
    const hold = act === 'guard' || act === 'retreat' || act === 'duck' || act === 'wait';
    if (this.mood === 'push') return push ? 0.45 : hold ? -0.3 : 0;
    if (this.mood === 'hold') return hold ? 0.45 : push ? -0.3 : 0;
    return 0;
  }

  _commit(option) {
    if (option.act === this.lastAct) this.repeat += 1;
    else {
      this.lastAct = option.act;
      this.repeat = 1;
    }
    // 決めた行動を維持する時間は難易度で伸縮させる。
    // 弱い設定ほど長く引きずり、状況の変化に置いていかれる。
    const base = option.ticks ?? this.cfg.react;
    this.plan = { bits: option.bits, ticks: Math.max(2, Math.round(base * this.cfg.hold)) };
    if (option.cooldown) this.cooldown = option.cooldown;
    return option.bits;
  }

  /**
   * そのティックの入力を返す。
   *
   * 状況ごとに「有効な手」を重み付きで並べ、そこから選ぶ。
   * 最善手を毎回選ぶのが一番勝ちやすいが、それだと数ラウンドで読まれて
   * 対策される。読まれないことも強さの一部なので、有効な手が複数あるなら混ぜる。
   *
   * @param {import('./sim.js').Simulation} sim
   */
  think(sim) {
    const me = sim.fighters[this.index];
    const foe = sim.fighters[1 - this.index];
    if (!sim.isRunning || me.isKO) return 0;

    if (this.cooldown > 0) this.cooldown -= 1;

    // 気分を数秒ごとに入れ替える
    if (this.moodTicks > 0) this.moodTicks -= 1;
    else {
      const roll = sim.rng.next();
      this.mood = roll < 0.34 ? 'push' : roll < 0.68 ? 'hold' : 'even';
      this.moodTicks = sim.rng.int(MOOD_MIN, MOOD_MAX);
    }

    // 決めた行動は数ティック維持する。毎フレーム考え直すと
    // 入力が細切れになってダッシュもガードも成立しないため。
    if (this.plan.ticks > 0) {
      this.plan.ticks -= 1;
      return this.plan.bits;
    }

    const rng = sim.rng;
    const cfg = this.cfg;
    const dist = Math.abs(foe.x - me.x);
    const toFoe = foe.x >= me.x ? BTN.RIGHT : BTN.LEFT;
    const away = foe.x >= me.x ? BTN.LEFT : BTN.RIGHT;

    const prof = profileOf(me.def);
    const hitRange = prof.attack.range;
    const skillRange = prof.skill.range;
    // 遠距離キャラは離れて弾を撒くのが仕事
    const ranged = prof.attack.projectile;
    const idealRange = ranged ? 430 : hitRange * 0.85;

    // ── 空中 ──────────────────────────────────────────────
    // 空中では空中技と2段ジャンプしか選べないので、先に分けて考える。
    if (me.airborne && me.state === STATE.JUMP) {
      const opts = [];
      const falling = me.vy < 0;
      if (dist < 240 && falling && !foe.invulnerable) {
        // 降り際に振ると地上の相手に当たりやすい
        opts.push({ act: 'attack', bits: BTN.ATTACK, ticks: 5, weight: cfg.aggression * 3 });
        opts.push({ act: 'skill', bits: BTN.SKILL, ticks: 5, weight: cfg.aggression });
      }
      if (me.airJumps > 0) {
        // 一発が致命傷なので、跳び直して軌道をずらす。危ないときは特に
        const danger = this._incomingAttack(foe) ? 3 : 0.6;
        opts.push({ act: 'jumpIn', bits: BTN.UP | toFoe, ticks: 5, weight: cfg.guard * danger });
        opts.push({ act: 'retreat', bits: BTN.UP | away, ticks: 5, weight: cfg.guard * danger * 0.6 });
      }
      opts.push({ act: 'rush', bits: toFoe, ticks: 5, weight: dist > 200 ? 2 : 0.5 });
      opts.push({ act: 'wait', bits: 0, ticks: 5, weight: 0.6 });
      return this._choose(rng, opts);
    }

    // ── 相手の技が来ている ────────────────────────────────
    const incoming = this._incomingAttack(foe);
    const threat = incoming ? this._threatRange(foe) : 0;
    if (incoming && dist <= threat + 40) {
      const opts = [];
      // 判定が出るまでの残り。逃げる手はこれが足りていないと間に合わない
      const until = this._framesUntilHit(foe);

      // ガードは一番確実。ただしこれ一択にすると、崩し技を置かれて終わる
      opts.push({ act: 'guard', bits: BTN.GUARD, ticks: 12, weight: cfg.guard * 5 });

      // ビームのように高いところだけを薙ぐ攻撃は、しゃがめばくぐれる。
      // ガード不能なので、くぐれるなら最優先
      if (this._isDuckable(foe)) {
        opts.push({ act: 'duck', bits: BTN.DOWN, ticks: 50, weight: cfg.guard * 14 });
      }
      // 判定が低いところに収まっているなら跳んで越える。
      // ただし跳び上がるまでに判定が来ると、そのまま食らうだけになる
      if (this._isJumpable(foe) && until >= JUMP_ESCAPE_FRAMES) {
        opts.push({ act: 'jumpIn', bits: BTN.UP | toFoe, ticks: 8, weight: cfg.guard * 1.6 });
        opts.push({ act: 'retreat', bits: BTN.UP | away, ticks: 8, weight: cfg.guard * 1 });
      }
      // 間合いの端で受けているなら、下がれば空振りにできる。
      // これも下がり切る時間が要る
      if (threat - dist < 70 && until >= RETREAT_ESCAPE_FRAMES) {
        opts.push({ act: 'retreat', bits: away | BTN.DASH, ticks: 12, weight: cfg.spacing * 2.5 });
      }
      // 相手の発生より自分の発生が速いなら、割り込んだ方が勝つ
      if (dist <= hitRange && until > prof.attack.startup + 3) {
        opts.push({ act: 'attack', bits: BTN.ATTACK, ticks: 6, weight: cfg.punish * 2.5 });
      }
      return this._choose(rng, opts);
    }

    // ── 相手が手を出せない ────────────────────────────────
    const open = this._openFrames(foe);
    if (open > 0) {
      const opts = [];
      if (dist <= hitRange && open >= prof.attack.startup) {
        opts.push({ act: 'attack', bits: BTN.ATTACK, ticks: 6, weight: cfg.punish * 5 });
      }
      if (dist <= skillRange && open >= prof.skill.startup + 4 && this.cooldown === 0) {
        // 大技が確定で入る場面。一番おいしい
        opts.push({
          act: 'skill',
          bits: BTN.SKILL,
          ticks: 6,
          weight: cfg.punish * 4,
          cooldown: 60,
        });
      }
      // 届かないなら詰める。硬直が明ける前に間合いへ入れたい
      opts.push({ act: 'rush', bits: toFoe | BTN.DASH, ticks: 8, weight: dist > hitRange ? 4 : 0.8 });
      opts.push({ act: 'jumpIn', bits: BTN.UP | toFoe, ticks: 8, weight: dist > hitRange * 1.4 ? 1 : 0.2 });
      opts.push({ act: 'wait', bits: 0, ticks: cfg.react, weight: (1 - cfg.punish) * 3 });
      return this._choose(rng, opts);
    }

    // ── 通常の間合い争い ──────────────────────────────────
    const opts = [];

    // 届くなら振る
    if (dist <= hitRange && !foe.invulnerable && this.cooldown === 0) {
      opts.push({
        act: 'attack',
        bits: BTN.ATTACK,
        ticks: 6,
        weight: cfg.aggression * 3,
        cooldown: ranged ? 12 : 20,
      });
    }
    // スキルはガードを崩せる代わりに発生が遅く、外すと大きな隙になる。
    // 固める相手か、出し切るまで踏み込まれない距離のときだけ。
    if (dist <= skillRange && this.cooldown === 0) {
      const slow = prof.skill.startup > SLOW_STARTUP;
      if (this._turtling(foe)) {
        // 打撃が通らないので、崩すならこれしかない
        opts.push({
          act: 'skill',
          bits: BTN.SKILL,
          ticks: 6,
          weight: cfg.crush * 6,
          cooldown: slow ? 90 : 60,
        });
      } else if (dist > hitRange * 0.7) {
        opts.push({
          act: 'skill',
          bits: BTN.SKILL,
          ticks: 6,
          weight: cfg.aggression * (slow ? 0.5 : 1.2),
          cooldown: slow ? 150 : 70,
        });
      }
    }
    // 固める相手には、いったん離れて仕切り直すのも手。
    // ただし下がりすぎると崩しの間合いから外れてしまうので、内側にいるときだけ。
    if (this._turtling(foe) && dist < skillRange * 0.8) {
      opts.push({ act: 'retreat', bits: away, ticks: 14, weight: cfg.spacing * 0.8 });
    }
    // 近すぎる。相手の間合いの内側で殴り合うのは割が悪い
    if (dist < hitRange * 0.5 && foe.isFree) {
      opts.push({ act: 'retreat', bits: away, ticks: 14, weight: cfg.spacing * 2.5 });
      opts.push({ act: 'retreat', bits: away | BTN.DASH, ticks: 12, weight: cfg.spacing * 1.2 });
    }
    // 遠いので詰める。歩き・走り・飛び込みを混ぜる
    if (dist > idealRange) {
      opts.push({ act: 'walkIn', bits: toFoe, ticks: 12, weight: 2.5 });
      opts.push({ act: 'rush', bits: toFoe | BTN.DASH, ticks: 10, weight: cfg.dash * 3 });
      if (dist > 280) {
        opts.push({ act: 'jumpIn', bits: BTN.UP | toFoe, ticks: 8, weight: cfg.aggression * 1.2 });
      }
    }
    // 自分の間合いの先端で待つ。相手が入ってきたら差し返せる
    opts.push({ act: 'wait', bits: 0, ticks: 10, weight: cfg.spacing * 1.5 });
    // 揺さぶり。前後に振って間合いを測る
    opts.push({ act: 'walkIn', bits: toFoe, ticks: 8, weight: 0.8 });
    opts.push({ act: 'retreat', bits: away, ticks: 8, weight: 0.8 });
    if (ranged && dist < idealRange * 0.7) {
      // 遠距離キャラは離れ続けたい
      opts.push({ act: 'retreat', bits: away | BTN.DASH, ticks: 14, weight: 3 });
    }
    return this._choose(rng, opts);
  }
}
