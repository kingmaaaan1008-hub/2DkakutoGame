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
import {
  getProjectileDef,
  isProjectile,
  homeToward,
  popEffectOf,
  stepLunge,
} from './projectiles.js';
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
    // 掴んでいる間は密着したままにする。ここで押し離すと、
    // 掴まれた側の固定位置が毎ティック引き剥がされて絵が震える。
    if (a.isGrabbed || b.isGrabbed) return;
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
    // ダウン中は無敵。追撃で起き上がりを潰し続けられないようにする。
    // 例外は「自分が掴んでいる相手」で、掴んだ本人だけは判定を通せる
    // （吸い終わりの一撃を当てるため。横槍は入らないままになる）。
    const heldByMe = defender.grabbedBy === ai;
    if (defender.isKO || (defender.invulnerable && !heldByMe) || attacker.hitstop > 0) return;

    const hits = attacker.activeHits();
    if (hits.length === 0) return;

    const hurt = defender.hurtBox();
    for (const hit of hits) {
      const box = toWorldBox(hit.box, attacker.x, attacker.y, attacker.facing);
      if (!boxesOverlap(box, hurt)) continue;
      // 掴みは跳んでいる相手には当たらない。
      // ガードには勝つが跳ばれると負ける、という択にするための一行。
      if (hit.grab && defender.airborne) continue;

      // 結界がスキルを弾く。当たらなかったことになるので moveHitLanded は立てない
      // （踏み込みを止める stopOnHit も、当てた側から見れば何も起きていない）。
      // group だけは使ったことにして、同じ判定で弾き直さないようにする。
      if (defender.wardRepels(hit)) {
        attacker.usedGroups.push(hit.group);
        defender.repelWithWard(hit, attacker, this);
        break;
      }

      // 同じ group は 1回の技中に 1度だけ当たる
      attacker.usedGroups.push(hit.group);
      attacker.moveHitLanded = true;
      if (hit.grab) defender.receiveGrab(attacker, hit, this);
      else defender.receiveHit(hit, attacker.x, attacker.facing, attacker, this);

      // 当たったときだけ切り替わる技（掴み → 保持）
      const move = attacker.currentMove();
      if (move?.onHit) attacker.startMove(move.onHit, defender);
      break; // 1ティックに1発まで
    }
  }

  // ── 飛び道具 ────────────────────────────────────────────────

  /** 技データの spawns から呼ばれる。飛び道具でなければ見た目エフェクト扱い。 */
  spawnFromMove(fighter, spawn) {
    if (!isProjectile(spawn.type)) {
      this.addEffect(spawn.type, fighter.x, fighter.y, {
        life: spawn.duration ?? 40,
        // 既定はキャラに追従する（斬撃の弧のように体と一緒に動くもの）。
        // `follow: false` を書いたものは出た場所に置き去りになる
        // ＝ 煙玉のように「そこに残るもの」用。
        follow: spawn.follow === false ? null : fighter.index,
        facing: fighter.facing,
        // 判定と同じ原点・太さ・長さ。描画側はこれを見て描く
        ox: spawn.origin?.x ?? 0,
        oy: spawn.origin?.y ?? 0,
        halfHeight: spawn.halfHeight ?? 0,
        length: spawn.length ?? 0,
        radius: spawn.radius ?? 0,
        tint: spawn.tint ?? null,
        power: spawn.power ?? 1,
      });
      if (spawn.shake) this.shake = Math.max(this.shake, spawn.shake);
      return;
    }

    const def = getProjectileDef(spawn.type);

    // 出せる数に上限があるなら、超えている間は出ない（技のモーションだけ出る）
    if (def.maxAlive > 0) {
      let alive = 0;
      for (const p of this.projectiles) {
        if (p.owner === fighter.index && p.type === spawn.type) alive += 1;
      }
      if (alive >= def.maxAlive) return;
    }

    // 発生位置は技側で上書きできる。
    const origin = spawn.origin ?? def.origin;
    const x = fighter.x + fighter.facing * origin.x;
    // groundBound のものは呼んだ高さに関係なく地面から出る
    // （空中で呼んだ彼氏が空を走らないように）
    const y = (def.groundBound ? 0 : fighter.y) + origin.y;
    const [ux, uy] = this._launchDir(spawn, fighter, x, y);

    this.projectiles.push({
      type: spawn.type,
      owner: fighter.index,
      x,
      y,
      vx: def.speed * ux,
      vy: def.speed * uy,
      facing: fighter.facing,
      life: def.lifetime,
      age: 0,
      /**
       * 当てたあとも残るもの（彼氏）用。true になると判定が切れる。
       * 走り抜ける間に何度も当たらないようにするため。
       */
      spent: false,
      /**
       * 突進に入ってからの経過フレーム。まだなら -1。
       * 描画側はこれを見て突進の絵を**頭から 1 回だけ**再生する。
       * 相手との距離からコマを決めると、追い越したあとに距離が開いて
       * コマが逆戻りし、2 周したように見えてしまう。
       */
      lungeAge: -1,
      /**
       * 突進を出し切って滑り、止まってから走り出したか。
       * true になると絵が走りに戻り、また元の速さまで加速する。
       */
      lungeDone: false,
      /** 滑り終えて止まってからの経過フレーム。 */
      stopAge: 0,
      /**
       * 地面に着いて居座っているか（まきびし）。
       * 立った時点で速度も重力も切れ、寿命が restTicks に貼り替わる。
       */
      resting: false,
    });
  }

  /**
   * 弾が飛び出す向き（長さ 1・世界座標）。
   *
   * 既定は技データの `dir` を「前方向が正・上が正」で読む。
   * `aim` が立っているものは**その瞬間の相手**を狙い、`spread` があれば
   * そこから回した向きになる。扇に開いて飛ぶ弾を作るためのもので、
   * 開き具合の cos/sin は技データが定数として持つ
   * （実行時に三角関数を呼ばないため。projectiles.js の冒頭を参照）。
   *
   * @returns {[number, number]} [x成分, y成分]
   */
  _launchDir(spawn, fighter, x, y) {
    let dx;
    let dy;
    if (spawn.aim) {
      const target = this.fighters[1 - fighter.index];
      const hurt = target.hurtBox();
      dx = hurt.x + hurt.w / 2 - x;
      // 胴の中ほどを狙う。足元を狙うと、跳んでいる相手の下を抜けていく
      dy = hurt.y + hurt.h * 0.55 - y;
    } else {
      const dir = spawn.dir ?? { x: 1, y: 0 };
      dx = fighter.facing * dir.x;
      dy = dir.y;
    }
    let len = Math.sqrt(dx * dx + dy * dy);
    // 狙い先と発射点がぴたり重なると向きが決まらない。前へ出しておく
    if (len < 0.001) {
      dx = fighter.facing;
      dy = 0;
      len = 1;
    }
    dx /= len;
    dy /= len;

    const sp = spawn.spread;
    if (!sp) return [dx, dy];
    return [dx * sp.c - dy * sp.s, dx * sp.s + dy * sp.c];
  }

  /**
   * 指定プレイヤーが出した飛び道具を全部消す。
   * 技データの clearsOwnProjectiles から呼ばれる。
   */
  clearProjectilesOf(owner) {
    for (let i = this.projectiles.length - 1; i >= 0; i -= 1) {
      const p = this.projectiles[i];
      if (p.owner !== owner) continue;
      const pop = popEffectOf(getProjectileDef(p.type));
      if (pop) this.addEffect(pop, p.x, p.y, { life: 14 });
      this.projectiles.splice(i, 1);
    }
  }

  _stepProjectiles() {
    for (let i = this.projectiles.length - 1; i >= 0; i -= 1) {
      const p = this.projectiles[i];
      const def = getProjectileDef(p.type);
      const target = this.fighters[1 - p.owner];

      // 突進に入る間合いに届いたら、そこからのフレーム数を数え始める。
      // 一度入ったら戻さない（離れても突進の絵を巻き戻さないため）。
      if (def.tackleRange > 0) {
        if (p.lungeAge < 0 && Math.abs(target.x - p.x) <= def.tackleRange) p.lungeAge = 0;
        else if (p.lungeAge >= 0) p.lungeAge += 1;
      }

      // 突進 → 滑って止まる → 走り出す。速さだけここで決まる
      stepLunge(p, def);

      if (def.turnRate > 0 && !target.isKO) {
        // 胴体の中心あたりを狙う。しゃがまれたらそのぶん低く狙い直す
        // （固定値だと、しゃがんだ相手の頭上を素通りしてしまう）
        const hurt = target.hurtBox();
        homeToward(p, target.x, hurt.y + hurt.h * 0.55, def);
      }
      // 落ちる飛び道具（まきびし）。置いたあとは重力も速度も切れる
      if (def.gravity > 0 && !p.resting) p.vy -= def.gravity;

      p.x += p.vx;
      p.y += p.vy;
      p.age += 1;
      p.life -= 1;

      // 地面に着いたらそこに居座る。寿命はここから数え直す。
      // 落下時間は撒いた高さで変わるので、着地から数えないと
      // 「置いた罠が何秒もつか」が撒いた高さで変わってしまう。
      if (def.restOnGround && !p.resting && p.y <= 0) {
        p.y = 0;
        p.vx = 0;
        p.vy = 0;
        p.resting = true;
        p.age = 0;
        p.life = def.restTicks;
      }
      // 止まっている間（彼氏が滑り終えたところ）は向きを据え置く。
      // 0 を右向き扱いにすると、左へ走っていた彼氏が止まった瞬間に振り返る。
      if (p.vx !== 0) p.facing = p.vx > 0 ? 1 : -1;

      // 画面外へ出たら消す。ただし彼氏のように画面外から走り込んでくるものは、
      // **進む先の画面外**でだけ消す。出てきた側の外でも消すと、壁際で呼んだ彼氏が
      // 出た瞬間に消えて、スキルがまるごと空振りになってしまう。
      const offStage = def.entersOffStage
        ? p.vx < 0
          ? p.x < -60
          : p.x > STAGE_WIDTH + 60
        : p.x < -60 || p.x > STAGE_WIDTH + 60;
      let remove = p.life <= 0 || p.y < (def.floorY ?? -40) || offStage;

      // ダウン中の相手は弾もすり抜ける（消えずに通過する）
      if (!remove && !p.spent && !target.isKO && !target.invulnerable && target.hitstop === 0) {
        // 既定は radius の正方形。box を持つものはその寸法で当てる
        // （レーザーのように細長いもの、彼氏のように人ひとりぶんのもの用）。
        // box.y は箱の下端を p.y からどれだけ上に置くか。省略すると中央になる。
        const box = def.box
          ? {
              x: p.x - def.box.w / 2,
              y: p.y + (def.box.y ?? -def.box.h / 2),
              w: def.box.w,
              h: def.box.h,
            }
          : { x: p.x - def.radius, y: p.y - def.radius, w: def.radius * 2, h: def.radius * 2 };
        if (boxesOverlap(box, target.hurtBox())) {
          if (target.wardRepels(def)) {
            // 結界がスキルの弾を弾いた。**当たらなかったことになる**ので
            // 走り抜ける弾（彼氏）もここで砕けて消える
            target.repelWithWard(def, this.fighters[p.owner], this);
            remove = true;
          } else {
            target.receiveHit(def, p.x, p.facing, this.fighters[p.owner], this);
            if (def.destroyOnHit) remove = true;
            // 消えないものは、そのまま走り抜けられるように判定だけ切る
            else p.spent = true;
          }
        }
      }

      if (remove) {
        // 消えるときの演出。飛び道具側で差し替えられる（null なら何も出さない）
        const pop = popEffectOf(def);
        if (pop) this.addEffect(pop, p.x, p.y, { life: 14 });
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
      // ビームなど、原点と大きさを技データから受け取る演出用
      ox: opts.ox ?? 0,
      oy: opts.oy ?? 0,
      halfHeight: opts.halfHeight ?? 0,
      length: opts.length ?? 0,
      radius: opts.radius ?? 0,
      /**
       * 光の色の差し替え（'r,g,b' 形式）。省略すると演出ごとの既定色。
       * 同じ斬撃でも、鋼の刃とビームサーベルでは色が違うので技側から指定できる。
       */
      tint: opts.tint ?? null,
      /** 演出の強さ。血しぶきの量などに掛かる。 */
      power: opts.power ?? 1,
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
