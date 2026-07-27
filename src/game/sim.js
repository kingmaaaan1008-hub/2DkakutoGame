/**
 * 試合のシミュレーション本体。
 *
 * 「1ティック分の入力を渡すと 1ティック分だけ世界が進む」だけの純粋な箱にしてある。
 * 描画も入力デバイスも時計も知らないので、
 *   - ローカル対戦   … 毎フレーム自分で step する
 *   - CPU 戦        … 片方の入力を ai.js が作る
 *   - オンライン対戦 … 双方の入力が揃ったフレームだけ step する（ロックステップ）
 *   - リプレイ / ロールバック … 入力列を保存しておいて再実行する
 * を同じコードで扱える。
 */
import {
  ROUND_TIME,
  ROUNDS_TO_WIN,
  ROUND_INTRO_TICKS,
  ROUND_OUTRO_TICKS,
  STAGE_WIDTH,
  STATE,
} from './constants.js';
import { Fighter, PUSHBOX_W } from './fighter.js';
import { toWorldBox, boxesOverlap } from './moves.js';
import { getCharacter } from './characters/index.js';
import { getProjectileDef, homeToward } from './projectiles.js';
import { Rng } from '../core/rng.js';

/** ラウンド開始時の立ち位置（ステージ中央からの距離）。 */
const START_OFFSET = 265;

export const PHASE = {
  INTRO: 'intro',
  FIGHT: 'fight',
  ROUND_END: 'roundEnd',
  MATCH_END: 'matchEnd',
};

export class Simulation {
  /**
   * @param {{characters:[string,string], seed?:number, roundTime?:number, roundsToWin?:number}} opts
   */
  constructor(opts) {
    this.characterIds = opts.characters;
    this.roundTime = opts.roundTime ?? ROUND_TIME;
    this.roundsToWin = opts.roundsToWin ?? ROUNDS_TO_WIN;
    this.rng = new Rng(opts.seed ?? 12345);

    this.fighters = [
      new Fighter(getCharacter(this.characterIds[0]), 0),
      new Fighter(getCharacter(this.characterIds[1]), 1),
    ];

    this.tick = 0;
    this.round = 1;
    this.wins = [0, 0];
    this.matchWinner = -1;
    /** 直前のラウンドの勝者。-1 は引き分け。 */
    this.roundWinner = -1;
    /** 画面演出用。シミュレーション結果には影響しない。 */
    this.shake = 0;
    this.projectiles = [];
    this.effects = [];

    this._startRound(1);
  }

  // ── ラウンド進行 ────────────────────────────────────────────

  _startRound(round) {
    this.round = round;
    this.phase = PHASE.INTRO;
    this.phaseTimer = 0;
    this.timeLeft = this.roundTime * 60;
    this.roundWinner = -1;
    this.projectiles.length = 0;
    this.effects.length = 0;
    this.shake = 0;

    const center = STAGE_WIDTH / 2;
    this.fighters[0].reset(center - START_OFFSET, 1);
    this.fighters[1].reset(center + START_OFFSET, -1);
  }

  get isRunning() {
    return this.phase === PHASE.FIGHT;
  }

  get isOver() {
    return this.phase === PHASE.MATCH_END;
  }

  /** 残り時間（秒、切り上げ）。HUD 用。 */
  get secondsLeft() {
    return Math.ceil(this.timeLeft / 60);
  }

  // ── 1ティック ───────────────────────────────────────────────

  /**
   * @param {number[]} inputs [P1のビットマスク, P2のビットマスク]
   */
  step(inputs) {
    this.tick += 1;
    this.phaseTimer += 1;
    if (this.shake > 0) this.shake = Math.max(0, this.shake - 0.8);

    const controllable = this.phase === PHASE.FIGHT;

    // 1. 各キャラを進める
    for (let i = 0; i < 2; i += 1) {
      this.fighters[i].step(inputs[i] | 0, this.fighters[1 - i], this, controllable);
    }

    // 2. 押し合い（めり込み解消）
    this._separate();

    // 3. 攻撃判定
    this._resolveHits(0, 1);
    this._resolveHits(1, 0);

    // 4. 飛び道具
    this._stepProjectiles();

    // 5. エフェクト（見た目のみ）
    for (let i = this.effects.length - 1; i >= 0; i -= 1) {
      const fx = this.effects[i];
      fx.life -= 1;
      if (fx.follow != null) {
        const f = this.fighters[fx.follow];
        fx.x = f.x;
        fx.y = f.y;
        fx.facing = f.facing;
      }
      if (fx.life <= 0) this.effects.splice(i, 1);
    }

    // 6. 決着判定
    this._updatePhase();
  }

  _separate() {
    const [a, b] = this.fighters;
    if (a.isKO || b.isKO) return;
    const dx = b.x - a.x;
    const overlap = PUSHBOX_W - Math.abs(dx);
    if (overlap <= 0) return;
    // 高さが重なっていないなら（片方がジャンプ中など）すり抜けさせる
    if (a.y > b.y + 170 || b.y > a.y + 170) return;

    const dir = dx >= 0 ? 1 : -1;
    a.x -= (dir * overlap) / 2;
    b.x += (dir * overlap) / 2;
    this._clampToStage(a);
    this._clampToStage(b);
  }

  _clampToStage(f) {
    const min = 40;
    const max = STAGE_WIDTH - 40;
    if (f.x < min) f.x = min;
    else if (f.x > max) f.x = max;
  }

  _resolveHits(ai, di) {
    const attacker = this.fighters[ai];
    const defender = this.fighters[di];
    if (defender.isKO || attacker.hitstop > 0) return;

    const hits = attacker.activeHits();
    if (hits.length === 0) return;

    const hurt = defender.hurtBox();
    for (const hit of hits) {
      const box = toWorldBox(hit.box, attacker.x, attacker.y, attacker.facing);
      if (!boxesOverlap(box, hurt)) continue;
      // 同じ group は 1回の技中に 1度だけ当たる
      attacker.usedGroups.push(hit.group);
      attacker.moveHitLanded = true;
      defender.receiveHit(hit, attacker.x, attacker.facing, attacker, this);
      break; // 1ティックに1発まで
    }
  }

  // ── 飛び道具 ────────────────────────────────────────────────

  /** 技データの spawns から呼ばれる。飛び道具でなければ見た目エフェクト扱い。 */
  spawnFromMove(fighter, spawn) {
    if (spawn.type === 'beam') {
      this.addEffect('beam', fighter.x, fighter.y, {
        life: spawn.duration ?? 40,
        follow: fighter.index,
        facing: fighter.facing,
      });
      this.shake = Math.max(this.shake, 6);
      return;
    }

    const def = getProjectileDef(spawn.type);
    this.projectiles.push({
      type: spawn.type,
      owner: fighter.index,
      x: fighter.x + fighter.facing * def.origin.x,
      y: fighter.y + def.origin.y,
      vx: fighter.facing * def.speed,
      vy: 0,
      facing: fighter.facing,
      life: def.lifetime,
      age: 0,
    });
  }

  _stepProjectiles() {
    for (let i = this.projectiles.length - 1; i >= 0; i -= 1) {
      const p = this.projectiles[i];
      const def = getProjectileDef(p.type);
      const target = this.fighters[1 - p.owner];

      if (def.turnRate > 0 && !target.isKO) {
        // 胴体の中心あたりを狙う
        homeToward(p, target.x, target.y + 110, def);
      }
      p.x += p.vx;
      p.y += p.vy;
      p.age += 1;
      p.life -= 1;
      p.facing = p.vx >= 0 ? 1 : -1;

      let remove = p.life <= 0 || p.x < -60 || p.x > STAGE_WIDTH + 60 || p.y < -40;

      if (!remove && !target.isKO && target.hitstop === 0) {
        const box = { x: p.x - def.radius, y: p.y - def.radius, w: def.radius * 2, h: def.radius * 2 };
        if (boxesOverlap(box, target.hurtBox())) {
          target.receiveHit(def, p.x, p.facing, this.fighters[p.owner], this);
          if (def.destroyOnHit) remove = true;
        }
      }

      if (remove) {
        this.addEffect('pop', p.x, p.y, { life: 14 });
        this.projectiles.splice(i, 1);
      }
    }
  }

  // ── エフェクト ──────────────────────────────────────────────

  addEffect(type, x, y, opts = {}) {
    const life = opts.life ?? 18;
    this.effects.push({
      type,
      x,
      y,
      life,
      maxLife: life,
      follow: opts.follow ?? null,
      facing: opts.facing ?? 1,
      seed: this.rng.int(0, 1000),
    });
  }

  // ── 決着 ────────────────────────────────────────────────────

  _updatePhase() {
    const [a, b] = this.fighters;

    if (this.phase === PHASE.INTRO) {
      if (this.phaseTimer >= ROUND_INTRO_TICKS) {
        this.phase = PHASE.FIGHT;
        this.phaseTimer = 0;
      }
      return;
    }

    if (this.phase === PHASE.FIGHT) {
      this.timeLeft -= 1;
      const koA = a.isKO;
      const koB = b.isKO;
      const timeUp = this.timeLeft <= 0;

      if (koA || koB || timeUp) {
        if (koA && koB) this.roundWinner = -1;
        else if (koB) this.roundWinner = 0;
        else if (koA) this.roundWinner = 1;
        else {
          // 時間切れは残り体力の多い方
          const ra = a.health / a.maxHealth;
          const rb = b.health / b.maxHealth;
          this.roundWinner = ra === rb ? -1 : ra > rb ? 0 : 1;
        }
        if (this.roundWinner >= 0) this.wins[this.roundWinner] += 1;
        this.phase = PHASE.ROUND_END;
        this.phaseTimer = 0;
      }
      return;
    }

    if (this.phase === PHASE.ROUND_END) {
      if (this.phaseTimer < ROUND_OUTRO_TICKS) return;
      if (this.wins[0] >= this.roundsToWin || this.wins[1] >= this.roundsToWin) {
        this.matchWinner = this.wins[0] > this.wins[1] ? 0 : this.wins[1] > this.wins[0] ? 1 : -1;
        this.phase = PHASE.MATCH_END;
        this.phaseTimer = 0;
      } else {
        this._startRound(this.round + 1);
      }
    }
  }

  // ── セーブ / ロード（ロールバック用） ───────────────────────

  save() {
    return {
      tick: this.tick,
      round: this.round,
      wins: this.wins.slice(),
      phase: this.phase,
      phaseTimer: this.phaseTimer,
      timeLeft: this.timeLeft,
      roundWinner: this.roundWinner,
      matchWinner: this.matchWinner,
      rng: this.rng.save(),
      fighters: this.fighters.map((f) => f.save()),
      projectiles: this.projectiles.map((p) => ({ ...p })),
      effects: this.effects.map((e) => ({ ...e })),
      shake: this.shake,
    };
  }

  load(s) {
    this.tick = s.tick;
    this.round = s.round;
    this.wins = s.wins.slice();
    this.phase = s.phase;
    this.phaseTimer = s.phaseTimer;
    this.timeLeft = s.timeLeft;
    this.roundWinner = s.roundWinner;
    this.matchWinner = s.matchWinner;
    this.rng.restore(s.rng);
    this.fighters.forEach((f, i) => f.load(s.fighters[i]));
    this.projectiles = s.projectiles.map((p) => ({ ...p }));
    this.effects = s.effects.map((e) => ({ ...e }));
    this.shake = s.shake;
  }
}

export { STATE };
