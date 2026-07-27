/**
 * ファイター（操作キャラ）1体分の状態機械。
 *
 * ここは「決定的シミュレーション」の一部なので、以下を守っている:
 *   - 実時間 (Date.now / performance.now) を見ない
 *   - Math.random を使わない（必要なら sim.rng を通す）
 *   - 描画用のデータ（画像サイズなど）に依存しない
 * この3点を守っている限り、同じ初期状態と同じ入力列からは必ず同じ試合になる。
 * オンライン対戦（ロックステップ／ロールバック）はこの性質の上に載る。
 */
import {
  BTN,
  GRAVITY,
  STATE,
  INPUT_BUFFER,
  DASH_TAP_WINDOW,
  STAGE_WIDTH,
  STAGE_MARGIN,
} from './constants.js';

/** 押し合い判定の幅。相手とめり込まないための箱。見た目の重なり具合はここで決まる。 */
export const PUSHBOX_W = 86;
/** やられ判定の既定値（足元原点・上が正）。 */
export const HURTBOX = { x: -38, y: 0, w: 76, h: 198 };

/** 着地硬直。ジャンプ攻撃を作るときはここを技側から上書きできるようにする。 */
const LAND_LAG = 7;
/** ガードを崩されたときの追加硬直。スキル技のリターンはここで決まる。 */
const GUARD_BREAK_EXTRA = 16;
/** コンボ補正。段数が増えるほどダメージを減らし、永久コンボを防ぐ。 */
const COMBO_SCALE_STEP = 0.1;
const COMBO_SCALE_MIN = 0.4;

export class Fighter {
  /**
   * @param {object} def キャラ定義（characters/*.js）
   * @param {number} index 0 = 1P, 1 = 2P
   */
  constructor(def, index) {
    this.def = def;
    this.index = index;
    this.maxHealth = def.health;
    this.reset(0, 1);
  }

  reset(x, facing) {
    this.x = x;
    this.y = 0;
    this.vx = 0;
    this.vy = 0;
    this.facing = facing;
    this.health = this.maxHealth;

    this.state = STATE.IDLE;
    this.stateTimer = 0;
    this.moveId = null;
    this.moveFrame = -1;
    this.moveHitLanded = false;
    this.usedGroups = [];

    this.hitstop = 0;
    this.guardHeld = false;
    this.walkDir = 0;
    this.dashDir = 0;

    this.prevInput = 0;
    this.tapDir = 0;
    this.tapTimer = 0;
    this.bufAttack = 0;
    this.bufSkill = 0;
    this.bufJump = 0;

    this.comboCount = 0;
    /** 直近に当てたコンボ数。HUD 表示用。 */
    this.comboDisplay = 0;
    this.comboDisplayTimer = 0;

    this.anim = {
      name: this.def.anims.idle,
      time: 0,
      fps: 10,
      loop: true,
      hold: false,
      reverse: false,
      stretch: 0,
    };
  }

  // ── 問い合わせ ──────────────────────────────────────────────

  get airborne() {
    return this.y > 0.0001;
  }

  get isKO() {
    return this.state === STATE.KO;
  }

  /** 自由に動ける状態か（技・硬直・空中を除く）。 */
  get isFree() {
    return (
      !this.airborne &&
      (this.state === STATE.IDLE ||
        this.state === STATE.WALK ||
        this.state === STATE.DASH ||
        this.state === STATE.GUARD)
    );
  }

  hurtBox() {
    return {
      x: this.x + HURTBOX.x,
      y: this.y + HURTBOX.y,
      w: HURTBOX.w,
      h: HURTBOX.h,
    };
  }

  currentMove() {
    return this.moveId ? this.def.moves[this.moveId] : null;
  }

  /** そのフレームに出ている攻撃判定（未使用の group のみ）。 */
  activeHits() {
    const move = this.currentMove();
    if (!move || this.state !== STATE.MOVE) return [];
    return move.hits.filter(
      (h) =>
        this.moveFrame >= h.start &&
        this.moveFrame <= h.end &&
        !this.usedGroups.includes(h.group)
    );
  }

  /** その攻撃をガードできるか。ガード不能技はここより前で弾かれる。 */
  canBlockFrom(attackerX) {
    if (this.airborne || this.isKO) return false;
    if (!this.guardHeld) return false;
    // 技を出している最中・食らい中は割り込んでガードできない
    if (this.state === STATE.MOVE || this.state === STATE.HIT || this.state === STATE.GUARD_BREAK) {
      return false;
    }
    if (this.state === STATE.LAND) return false;
    // 背後からの攻撃はガードできない（飛び道具で背中を取られたとき用）
    const side = attackerX >= this.x ? 1 : -1;
    return side === this.facing;
  }

  // ── アニメーション ──────────────────────────────────────────

  /**
   * 表示アニメを切り替える。同じアニメを指定した場合は再生位置を保つ
   * （歩き continuation など、切り替えのたびに先頭へ戻らないように）。
   */
  setAnim(name, opts = {}) {
    const next = {
      name,
      time: 0,
      fps: opts.fps ?? 12,
      loop: opts.loop ?? false,
      hold: opts.hold ?? true,
      reverse: opts.reverse ?? false,
      /** 指定するとアニメ全体をこのティック数に引き伸ばす。 */
      stretch: opts.stretch ?? 0,
    };
    if (this.anim.name === name && this.anim.stretch === next.stretch && !opts.restart) {
      // 逆再生フラグだけは毎フレーム変わりうる（後退歩き）
      this.anim.reverse = next.reverse;
      this.anim.fps = next.fps;
      this.anim.loop = next.loop;
      return;
    }
    this.anim = next;
  }

  // ── 入力の解釈 ──────────────────────────────────────────────

  _readInput(input) {
    const pressed = input & ~this.prevInput;
    this.prevInput = input;
    this.guardHeld = (input & BTN.GUARD) !== 0;

    // 先行入力バッファ。硬直明けに技が出るようにするための猶予。
    if (pressed & BTN.ATTACK) this.bufAttack = INPUT_BUFFER;
    if (pressed & BTN.SKILL) this.bufSkill = INPUT_BUFFER;
    if (pressed & BTN.UP) this.bufJump = INPUT_BUFFER;
    if (this.bufAttack > 0) this.bufAttack -= 1;
    if (this.bufSkill > 0) this.bufSkill -= 1;
    if (this.bufJump > 0) this.bufJump -= 1;

    // 同方向の2度押しでダッシュ
    let dashRequest = 0;
    if (pressed & BTN.LEFT) {
      if (this.tapDir === -1 && this.tapTimer > 0) dashRequest = -1;
      this.tapDir = -1;
      this.tapTimer = DASH_TAP_WINDOW;
    } else if (pressed & BTN.RIGHT) {
      if (this.tapDir === 1 && this.tapTimer > 0) dashRequest = 1;
      this.tapDir = 1;
      this.tapTimer = DASH_TAP_WINDOW;
    }
    if (this.tapTimer > 0) this.tapTimer -= 1;

    const left = (input & BTN.LEFT) !== 0;
    const right = (input & BTN.RIGHT) !== 0;
    const dir = left && right ? 0 : left ? -1 : right ? 1 : 0;

    return { dir, dashRequest };
  }

  _takeBuffered(name) {
    if (name === 'attack' && this.bufAttack > 0) {
      this.bufAttack = 0;
      return true;
    }
    if (name === 'skill' && this.bufSkill > 0) {
      this.bufSkill = 0;
      return true;
    }
    if (name === 'jump' && this.bufJump > 0) {
      this.bufJump = 0;
      return true;
    }
    return false;
  }

  // ── 状態遷移 ────────────────────────────────────────────────

  startMove(id, opponent) {
    const move = this.def.moves[id];
    if (!move) throw new Error(`${this.def.id}: 未定義の技 "${id}"`);
    if (move.turnOnStart && opponent && !this.airborne) {
      this.facing = opponent.x >= this.x ? 1 : -1;
    }
    this.state = STATE.MOVE;
    this.moveId = id;
    this.moveFrame = -1;
    this.moveHitLanded = false;
    this.usedGroups = [];
    this.vx = 0;
    this.setAnim(move.anim, {
      fps: move.animFps ?? 0,
      stretch: move.animFps ? 0 : move.total,
      hold: true,
      restart: true,
    });
  }

  _toIdle() {
    this.state = STATE.IDLE;
    this.moveId = null;
    this.moveFrame = -1;
    this.usedGroups = [];
    this.comboCount = 0;
    this.vx = 0;
  }

  _jump(dir) {
    this.state = STATE.JUMP;
    this.vy = this.def.jumpVy;
    this.vx = dir * this.def.jumpVx;
    this.setAnim(this.def.anims.jump, { fps: 11, hold: true, restart: true });
  }

  // ── 1ティック進める ─────────────────────────────────────────

  /**
   * @param {number} input ビットマスク
   * @param {Fighter} opponent
   * @param {import('./sim.js').Simulation} sim
   * @param {boolean} controllable ラウンド開始演出中などは false
   */
  step(input, opponent, sim, controllable) {
    // 入力の読み取りはヒットストップ中も行う。
    // ここを止めると、硬直明けに技を出すための先行入力が効かなくなる。
    const { dir, dashRequest } = this._readInput(controllable ? input : 0);

    if (this.comboDisplayTimer > 0) this.comboDisplayTimer -= 1;

    if (this.hitstop > 0) {
      this.hitstop -= 1;
      return;
    }

    this.anim.time += 1;
    this.stateTimer += 1;

    switch (this.state) {
      case STATE.IDLE:
      case STATE.WALK:
      case STATE.DASH:
      case STATE.GUARD:
        this._stepFree(dir, dashRequest, opponent, sim);
        break;
      case STATE.JUMP:
        this._stepAir(sim);
        break;
      case STATE.LAND:
        this.vx *= 0.7;
        if (this.stateTimer >= LAND_LAG) this._toIdle();
        break;
      case STATE.MOVE:
        this._stepMove(opponent, sim);
        break;
      case STATE.HIT:
      case STATE.BLOCK:
      case STATE.GUARD_BREAK:
        this._stepStun();
        break;
      case STATE.KO:
        this.vx *= 0.9;
        break;
      default:
        break;
    }

    this._integrate();
  }

  _stepFree(dir, dashRequest, opponent, sim) {
    // 歩き・待機・ガード中は常に相手の方を向く。
    // ダッシュだけは進行方向を向くので、下の分岐で上書きする。
    if (this.state !== STATE.DASH) {
      this.facing = opponent.x >= this.x ? 1 : -1;
    }

    // 行動の優先順位: 技 > ジャンプ > ダッシュ > ガード > 歩き
    if (this._takeBuffered('skill')) {
      this.startMove(this.def.skillMove, opponent);
      return;
    }
    if (this._takeBuffered('attack')) {
      this.startMove(this.def.attackMove, opponent);
      return;
    }
    if (this._takeBuffered('jump')) {
      this._jump(dir);
      return;
    }

    if (dashRequest !== 0) {
      this.state = STATE.DASH;
      this.dashDir = dashRequest;
      this.stateTimer = 0;
    }

    if (this.state === STATE.DASH) {
      // ダッシュ中は進んでいる方を向く
      this.facing = this.dashDir;
      this.vx = this.dashDir * this.def.dashSpeed;
      this.setAnim(this.def.anims.dash, { fps: 15, loop: true });
      // 方向を離す / 逆を入れると走りを止める
      if (dir !== this.dashDir) {
        this._toIdle();
      }
      return;
    }

    if (this.guardHeld) {
      this.state = STATE.GUARD;
      this.vx = 0;
      this.setAnim(this.def.anims.guard, { fps: 14, hold: true });
      return;
    }

    if (dir !== 0) {
      this.state = STATE.WALK;
      this.walkDir = dir;
      this.vx = dir * this.def.walkSpeed;
      // 後ろに下がるときは歩きシートを逆再生する
      this.setAnim(this.def.anims.walk, { fps: 12, loop: true, reverse: dir !== this.facing });
    } else {
      this.state = STATE.IDLE;
      this.vx = 0;
      this.setAnim(this.def.anims.idle, { fps: 9, loop: true });
    }
  }

  _stepAir(sim) {
    // 上昇中と落下中でアニメを切り替える
    if (this.vy > 0) this.setAnim(this.def.anims.jump, { fps: 11, hold: true });
    else this.setAnim(this.def.anims.fall, { fps: 11, hold: true });
  }

  _stepMove(opponent, sim) {
    const move = this.currentMove();
    this.moveFrame += 1;
    if (this.moveFrame >= move.total) {
      this._toIdle();
      return;
    }

    // 自身の移動成分（前方向が正）
    for (const m of move.motion) {
      if (this.moveFrame < m.start || this.moveFrame > m.end) continue;
      if (m.stopOnHit && this.moveHitLanded) continue;
      this.vx = this.facing * (m.vx ?? 0);
      if (m.vy) this.vy = m.vy;
    }

    // 弾・持続判定などの発生
    for (const s of move.spawns) {
      if (s.frame === this.moveFrame) sim.spawnFromMove(this, s);
    }

    // 連携（キャンセル）入力
    for (const c of move.chains) {
      if (this.moveFrame < c.from || this.moveFrame > c.to) continue;
      if (this._takeBuffered(c.button)) {
        this.startMove(c.move, opponent);
        return;
      }
    }

    // 移動指定の無い区間では自然に止まる
    const moving = move.motion.some((m) => this.moveFrame >= m.start && this.moveFrame <= m.end);
    if (!moving && !this.airborne) this.vx *= 0.82;
  }

  _stepStun() {
    this.vx *= 0.9;
    if (this.stateTimer >= this.stunTicks) {
      if (this.state === STATE.BLOCK && this.guardHeld) {
        this.state = STATE.GUARD;
        this.stateTimer = 0;
      } else {
        this._toIdle();
      }
    }
  }

  /** 速度を位置に反映し、床と壁で止める。 */
  _integrate() {
    this.x += this.vx;
    if (this.airborne || this.vy !== 0) {
      this.y += this.vy;
      this.vy -= GRAVITY;
    }

    if (this.y <= 0) {
      const wasAir = this.state === STATE.JUMP;
      this.y = 0;
      this.vy = 0;
      if (wasAir) {
        this.state = STATE.LAND;
        this.stateTimer = 0;
        this.vx *= 0.4;
        this.setAnim(this.def.anims.land, { fps: 20, hold: true, restart: true });
      }
    }

    const min = STAGE_MARGIN;
    const max = STAGE_WIDTH - STAGE_MARGIN;
    if (this.x < min) {
      this.x = min;
      if (this.vx < 0) this.vx = 0;
    } else if (this.x > max) {
      this.x = max;
      if (this.vx > 0) this.vx = 0;
    }
  }

  // ── 被弾 ────────────────────────────────────────────────────

  /**
   * 攻撃を受ける。ガード判定・ダメージ計算・のけぞりまでここで完結させる。
   * @param {object} hit 判定データ
   * @param {number} sourceX 攻撃の発生源X（前後判定に使う）
   * @param {number} sourceFacing 押し出し方向
   * @param {Fighter|null} attacker コンボ表示の更新用
   * @param {import('./sim.js').Simulation} sim
   * @returns {'hit'|'block'|'break'}
   */
  receiveHit(hit, sourceX, sourceFacing, attacker, sim) {
    const wasBlocking = this.canBlockFrom(sourceX);
    const blocked = wasBlocking && !hit.guardBreak;

    this.hitstop = hit.hitstop;
    if (attacker) attacker.hitstop = hit.hitstop;

    const pushDir = sourceFacing || (this.x >= sourceX ? 1 : -1);

    if (blocked) {
      this.health -= hit.chip;
      this.state = STATE.BLOCK;
      this.stateTimer = 0;
      this.stunTicks = hit.blockstun;
      this.vx = pushDir * hit.pushBlock;
      this.setAnim(this.def.anims.guard, { fps: 14, hold: true, restart: true });
      sim.addEffect('block', this.x + pushDir * -30, this.y + 120);
      if (this.health <= 0) this._die(sim);
      return 'block';
    }

    // コンボ補正: 段数が増えるほどダメージを落とす
    const attackerCombo = attacker ? attacker.comboCount : 0;
    const scale = Math.max(COMBO_SCALE_MIN, 1 - COMBO_SCALE_STEP * attackerCombo);
    this.health -= Math.round(hit.damage * scale);

    const breaking = wasBlocking && hit.guardBreak;
    this.state = breaking ? STATE.GUARD_BREAK : STATE.HIT;
    this.stateTimer = 0;
    this.stunTicks = hit.hitstun + (breaking ? GUARD_BREAK_EXTRA : 0);
    this.vx = (pushDir * hit.pushHit) / this.def.weight;
    if (hit.launch) {
      this.vy = hit.launch.y;
      this.y = Math.max(this.y, 0.01);
    }
    this.setAnim(this.def.anims.hurt, { fps: 14, hold: true, restart: true });

    if (attacker) {
      attacker.comboCount += 1;
      attacker.comboDisplay = attacker.comboCount;
      attacker.comboDisplayTimer = 90;
    }

    sim.addEffect(breaking ? 'break' : 'spark', this.x + pushDir * -34, this.y + 118);
    sim.shake = Math.max(sim.shake, breaking ? 14 : 7);

    if (this.health <= 0) this._die(sim);
    return breaking ? 'break' : 'hit';
  }

  _die(sim) {
    this.health = 0;
    this.state = STATE.KO;
    this.stateTimer = 0;
    this.moveId = null;
    this.setAnim(this.def.anims.death, { fps: 10, hold: true, restart: true });
    sim.shake = Math.max(sim.shake, 18);
  }

  // ── セーブ / ロード（ロールバック用） ───────────────────────

  /**
   * 状態を素の値だけの配列にする。ネットコードで巻き戻すときに使う。
   * 関数や定義への参照は含めない。
   */
  save() {
    return [
      this.x, this.y, this.vx, this.vy, this.facing, this.health,
      this.state, this.stateTimer, this.moveId, this.moveFrame,
      this.moveHitLanded, this.usedGroups.slice(), this.hitstop,
      this.guardHeld, this.walkDir, this.dashDir, this.prevInput,
      this.tapDir, this.tapTimer, this.bufAttack, this.bufSkill, this.bufJump,
      this.comboCount, this.comboDisplay, this.comboDisplayTimer,
      this.stunTicks ?? 0,
      this.anim.name, this.anim.time, this.anim.fps, this.anim.loop,
      this.anim.hold, this.anim.reverse, this.anim.stretch,
    ];
  }

  load(s) {
    let i = 0;
    this.x = s[i++]; this.y = s[i++]; this.vx = s[i++]; this.vy = s[i++];
    this.facing = s[i++]; this.health = s[i++];
    this.state = s[i++]; this.stateTimer = s[i++]; this.moveId = s[i++]; this.moveFrame = s[i++];
    this.moveHitLanded = s[i++]; this.usedGroups = s[i++].slice(); this.hitstop = s[i++];
    this.guardHeld = s[i++]; this.walkDir = s[i++]; this.dashDir = s[i++]; this.prevInput = s[i++];
    this.tapDir = s[i++]; this.tapTimer = s[i++];
    this.bufAttack = s[i++]; this.bufSkill = s[i++]; this.bufJump = s[i++];
    this.comboCount = s[i++]; this.comboDisplay = s[i++]; this.comboDisplayTimer = s[i++];
    this.stunTicks = s[i++];
    this.anim = {
      name: s[i++], time: s[i++], fps: s[i++], loop: s[i++],
      hold: s[i++], reverse: s[i++], stretch: s[i++],
    };
  }
}
