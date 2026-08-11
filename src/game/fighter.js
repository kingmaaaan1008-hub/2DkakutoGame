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
  AIR_JUMPS,
  AIR_JUMP_VY_SCALE,
  CROUCH_TICKS,
} from './constants.js';

/** 押し合い判定の幅。相手とめり込まないための箱。見た目の重なり具合はここで決まる。 */
export const PUSHBOX_W = 86;
/** やられ判定の既定値（足元原点・上が正）。 */
export const HURTBOX = { x: -38, y: 0, w: 76, h: 198 };
/**
 * しゃがみ切ったときのやられ判定。低く・少し広くなる。
 *
 * 高さ 100 という数字には意味がある。魔法使いのビームは杖の先
 * （足元から 156）を中心に上下 49 ＝ 地上から 107〜205 を薙ぐので、
 * **100 まで縮めばビームの下をくぐれる**。
 * ここを 107 以上にするとしゃがんでもビームに当たるようになるので、
 * ビーム側（mage.js の STAFF_TIP / BEAM_HALF_HEIGHT）と一緒に見ること。
 */
export const CROUCH_HURTBOX = { w: 84, h: 100 };
/** しゃがめばくぐれる高さ。技データの検算や CPU の判断に使う。 */
export const CROUCH_CLEAR_Y = CROUCH_HURTBOX.h;

/** 着地硬直。ジャンプ攻撃を作るときはここを技側から上書きできるようにする。 */
const LAND_LAG = 7;
/** ガードを崩されたときの追加硬直。スキル技のリターンはここで決まる。 */
const GUARD_BREAK_EXTRA = 16;

/**
 * ダウン（knockdown 指定の技を食らったとき）。
 * 打ち上げ → 落下 → 倒れる（DOWN_LIE_TICKS）→ 起き上がり（DOWN_GETUP_TICKS）。
 * 倒れている間は無敵なので、ダウンを取った側は追撃ではなく起き攻めを狙う形になる。
 */
const DOWN_LIE_TICKS = 32;
const DOWN_GETUP_TICKS = 28;
/** knockdown の hit に launch 指定が無いときの打ち上げ速度（重いキャラほど浮かない）。 */
const KNOCKDOWN_LAUNCH_VY = 9.5;
/** ダウンの各段階。 */
const DOWN_PHASE = { AIR: 0, LIE: 1, GETUP: 2 };

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
    /** いま出している技が空中技か（着地で中断されるのはこれだけ）。 */
    this.moveAir = false;
    this.usedGroups = [];
    /**
     * atEnd 指定の連携で予約された次の技。技を出し切った時点で出る。
     * 読むのは _stepMove の終端だけで、技を出すたびに消えるので、
     * 中断された技の予約が後から生き返ることはない。
     */
    this.chainQueued = null;

    this.hitstop = 0;
    this.landLag = LAND_LAG;
    this.downPhase = DOWN_PHASE.AIR;
    this.guardHeld = false;
    this.walkDir = 0;
    this.dashDir = 0;
    /** 残りの空中ジャンプ回数。 */
    this.airJumps = 0;
    /**
     * 滞空の残りティック（飛行を持つキャラだけ 0 より大きくなる）。
     * この間は落下が止まり、左右入力でその高さのまま移動できる。
     */
    this.hoverTicks = 0;
    /**
     * 自分を掴んでいる相手の index。掴まれていなければ -1。
     * 掴んだ本人だけがこちらに判定を通せる、という判断にも使う。
     */
    this.grabbedBy = -1;
    /**
     * しゃがみの深さ（0 = 立ち, CROUCH_TICKS = しゃがみ切り）。
     * 絵のコマもやられ判定の高さもこの 1 個の値から作るので、
     * 「絵はまだ立っているのに判定だけ縮んでいる」が起きない。
     */
    this.crouchTimer = 0;
    /**
     * 致命傷を負っているか。
     * このゲームは一発が即死なので、当たった時点でここが true になる。
     * ただしその場では倒れず、コンボが途切れた瞬間に崩れ落ちる（_collapse）。
     */
    this.doomed = false;

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
      range: null,
      delay: 0,
    };
  }

  // ── 問い合わせ ──────────────────────────────────────────────

  get airborne() {
    return this.y > 0.0001;
  }

  get isKO() {
    return this.state === STATE.KO;
  }

  /**
   * 無敵か。ダウン中（浮いてから起き上がり切るまで）は攻撃を受け付けない。
   * 掴まれている間も、掴んだ本人以外からは無敵（sim 側が例外を通す）。
   * ここを見て判定を飛ばすのは sim 側。
   */
  get invulnerable() {
    return this.state === STATE.DOWN || this.state === STATE.GRABBED;
  }

  /** 掴まれているか。 */
  get isGrabbed() {
    return this.state === STATE.GRABBED;
  }

  /** いま掴んでいる技を出している最中か（相手を保持できる状態か）。 */
  get isHolding() {
    return this.state === STATE.MOVE && this.currentMove()?.grabHold != null;
  }

  /** 自由に動ける状態か（技・硬直・空中を除く）。 */
  get isFree() {
    return (
      !this.airborne &&
      (this.state === STATE.IDLE ||
        this.state === STATE.WALK ||
        this.state === STATE.DASH ||
        this.state === STATE.CROUCH ||
        this.state === STATE.GUARD)
    );
  }

  /** しゃがみ具合 0〜1。0 が立ち、1 がしゃがみ切り。 */
  get crouchDepth() {
    return this.crouchTimer / CROUCH_TICKS;
  }

  /**
   * やられ判定。しゃがんでいる途中は、その深さぶんだけ低く・広くなる。
   * 補間しているので、しゃがみ始めた瞬間にビームをくぐれるわけではなく、
   * 「しゃがみ切るまでの CROUCH_TICKS を先に払う」必要がある。
   */
  hurtBox() {
    const t = this.crouchDepth;
    const w = HURTBOX.w + (CROUCH_HURTBOX.w - HURTBOX.w) * t;
    const h = HURTBOX.h + (CROUCH_HURTBOX.h - HURTBOX.h) * t;
    return { x: this.x - w / 2, y: this.y + HURTBOX.y, w, h };
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
   * そのアニメを繰り返すか。
   *
   * 待機・歩き・ダッシュのような「続いている状態」の絵は普通ループさせるが、
   * 素材によっては閉じたループになっていないことがある（撮っている間に
   * キャラが動いてしまう飛行クリップなど）。そういうアニメは
   * キャラ定義の `animOnce` に載せておくと、**最後のコマで止まる**。
   */
  _loops(name) {
    return !this.def.animOnce?.[name];
  }

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
      /** [開始,終了] を指定すると、そのコマ範囲だけを使う。null なら全コマ。 */
      range: opts.range ?? null,
      /** 先頭のコマを据え置くティック数。明けてから再生が始まる。 */
      delay: opts.delay ?? 0,
    };
    // 名前が同じでも、引き伸ばし方やコマ範囲が違えば別のアニメとして作り直す
    const sameRange =
      this.anim.range === next.range ||
      (this.anim.range != null &&
        next.range != null &&
        this.anim.range[0] === next.range[0] &&
        this.anim.range[1] === next.range[1]);
    if (
      this.anim.name === name &&
      this.anim.stretch === next.stretch &&
      this.anim.delay === next.delay &&
      sameRange &&
      !opts.restart
    ) {
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
    const down = (input & BTN.DOWN) !== 0;

    // ダッシュビットは押されている間ずっと有効。2度押しと違って
    // 立ち上がりを見ないので、硬直で走りが途切れても押しっぱなしなら走りに戻る。
    if (dir !== 0 && input & BTN.DASH) dashRequest = dir;

    return { dir, dashRequest, down };
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
    this.moveAir = this.airborne;
    this.usedGroups = [];
    this.chainQueued = null;
    // 技を出したら滞空は終わり（滞空から急降下、という繋ぎを作るため）
    this.hoverTicks = 0;
    // 空中技は跳んだ勢いを残す（地上技はその場で止まる）
    if (!this.moveAir) this.vx = 0;
    this.setAnim(move.anim, {
      fps: move.animFps ?? 0,
      stretch: move.animFps ? 0 : move.total,
      range: move.animRange,
      reverse: move.animReverse,
      // 先頭のコマを据え置いてから振る技（据え置き 0 なら普通に頭から流れる）
      delay: move.animDelay,
      // 既定は最後のコマで止める。閉じたループのシートだけ回し続ける
      loop: move.animLoop,
      hold: true,
      restart: true,
    });
  }

  _toIdle() {
    this.moveId = null;
    this.moveFrame = -1;
    this.moveAir = false;
    this.usedGroups = [];
    this.comboCount = 0;
    this.crouchTimer = 0;
    this.hoverTicks = 0;
    // 空中で技や硬直が明けたときは、地面に立たせるのではなく落下に戻す
    if (this.airborne) {
      this.state = STATE.JUMP;
      this.setAnim(this.def.anims.fall, { fps: 11, hold: true });
      return;
    }
    this.state = STATE.IDLE;
    this.vx = 0;
  }

  _jump(dir) {
    this.state = STATE.JUMP;
    this.vy = this.def.jumpVy;
    this.vx = dir * this.def.jumpVx;
    this.airJumps = this.def.airJumps ?? AIR_JUMPS;
    this.hoverTicks = 0;
    this.setAnim(this.def.anims.jump, { fps: 11, hold: true, restart: true });
  }

  /**
   * いま空中で跳ぼうとしているのが何段目か（地上ジャンプを 1 段目と数える）。
   * airJumps は残り回数なので、上限から引いて段数に直す。
   */
  get _jumpIndex() {
    return (this.def.airJumps ?? AIR_JUMPS) - this.airJumps + 2;
  }

  /**
   * 空中ジャンプ（2段ジャンプ）。
   * 方向を入れていればその方向へ、入れていなければ横の勢いを殺して真上へ跳ぶ。
   * 後者があるので「飛び込みを空中で止めて技を透かす」動きができる。
   *
   * 飛行を持つキャラ（def.flight）は、flight.fromJump 段目から先が跳び上がりではなく
   * **滞空**になる。高度は上げずにその場へ留まり、左右入力があればその高さのまま動ける。
   */
  _airJump(dir, sim) {
    const flight = this.def.flight;
    const hovering = flight && this._jumpIndex >= flight.fromJump;
    this.airJumps -= 1;

    if (hovering) {
      this.hoverTicks = flight.ticks;
      this.vy = 0;
      this.vx = dir * flight.speed;
      this.setAnim(this.def.anims.fly, { fps: 12, loop: this._loops(this.def.anims.fly) });
      sim?.addEffect('pop', this.x, this.y + 20, { life: 12 });
      return;
    }

    this.hoverTicks = 0;
    this.vy = this.def.jumpVy * AIR_JUMP_VY_SCALE;
    if (dir !== 0) this.vx = dir * this.def.jumpVx;
    else this.vx *= 0.35;
    this.setAnim(this.def.anims.jump, { fps: 11, hold: true, restart: true });
    sim?.addEffect('pop', this.x, this.y + 20, { life: 16 });
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
    const { dir, dashRequest, down } = this._readInput(controllable ? input : 0);

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
        this._stepFree(dir, dashRequest, down, opponent, sim);
        break;
      case STATE.CROUCH:
        this._stepCrouch(down, opponent);
        break;
      case STATE.JUMP:
        this._stepAir(dir, opponent, sim);
        break;
      case STATE.LAND:
        this.vx *= 0.7;
        if (this.stateTimer >= this.landLag) this._toIdle();
        break;
      case STATE.MOVE:
        this._stepMove(opponent, sim);
        break;
      case STATE.HIT:
      case STATE.BLOCK:
      case STATE.GUARD_BREAK:
        this._stepStun(sim);
        break;
      case STATE.GRABBED:
        this._stepGrabbed(opponent, sim);
        break;
      case STATE.DOWN:
        this._stepDown(sim);
        break;
      case STATE.KO:
        this.vx *= 0.9;
        break;
      default:
        break;
    }

    this._integrate(sim);
  }

  _stepFree(dir, dashRequest, down, opponent, sim) {
    // 歩き・待機・ガード中は常に相手の方を向く。
    // ダッシュだけは進行方向を向くので、下の分岐で上書きする。
    if (this.state !== STATE.DASH) {
      this.facing = opponent.x >= this.x ? 1 : -1;
    }

    // 行動の優先順位: 技 > ジャンプ > ガード > ダッシュ > 歩き
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

    // ダッシュより先に見る。走っている最中でもガードは利く
    // （技は下の分岐より前で拾っているので、ガードだけ利かないと操作感がちぐはぐになる）
    if (this.guardHeld) {
      this.state = STATE.GUARD;
      this.vx = 0;
      this.setAnim(this.def.anims.guard, { fps: 14, hold: true });
      return;
    }

    // ガードの次。走っている途中でもしゃがめる（＝急にビームの下へ潜れる）
    if (down) {
      this.state = STATE.CROUCH;
      this.stateTimer = 0;
      this.vx = 0;
      this._syncCrouchAnim();
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
      this.setAnim(this.def.anims.dash, { fps: 15, loop: this._loops(this.def.anims.dash) });
      // 方向を離す / 逆を入れると走りを止める
      if (dir !== this.dashDir) {
        this._toIdle();
      }
      return;
    }

    if (dir !== 0) {
      this.state = STATE.WALK;
      this.walkDir = dir;
      this.vx = dir * this.def.walkSpeed;
      // 後ろに下がるときは歩きシートを逆再生する
      this.setAnim(this.def.anims.walk, {
        fps: 12,
        loop: this._loops(this.def.anims.walk),
        reverse: dir !== this.facing,
      });
    } else {
      this.state = STATE.IDLE;
      this.vx = 0;
      this.setAnim(this.def.anims.idle, { fps: 9, loop: this._loops(this.def.anims.idle) });
    }
  }

  /**
   * しゃがみ。
   *
   * 下を押している間は深くなり、離すと同じ速さで立ち上がる。
   * 立ち上がり切って初めて IDLE に戻るので、「しゃがんで避けて即反撃」には
   * 沈む時間と起き上がる時間の両方がかかる。これがしゃがみのコスト。
   *
   * 技とジャンプは待たずに出せる（そのぶんやられ判定はすぐ立ち姿勢に戻る）。
   * しゃがみ専用の技はまだ無いので、地上技がそのまま出る。
   */
  _stepCrouch(down, opponent) {
    this.facing = opponent.x >= this.x ? 1 : -1;
    this.vx = 0;

    // 技・ジャンプ・ガードで立つ。立った時点で判定も立ち姿勢に戻す
    if (this._takeBuffered('skill')) {
      this.crouchTimer = 0;
      this.startMove(this.def.skillMove, opponent);
      return;
    }
    if (this._takeBuffered('attack')) {
      this.crouchTimer = 0;
      this.startMove(this.def.attackMove, opponent);
      return;
    }
    if (this._takeBuffered('jump')) {
      this.crouchTimer = 0;
      this._jump(0);
      return;
    }
    if (this.guardHeld) {
      this.crouchTimer = 0;
      this.state = STATE.GUARD;
      this.stateTimer = 0;
      this.setAnim(this.def.anims.guard, { fps: 14, hold: true });
      return;
    }

    if (down) {
      if (this.crouchTimer < CROUCH_TICKS) this.crouchTimer += 1;
    } else {
      this.crouchTimer -= 1;
      if (this.crouchTimer <= 0) {
        this.crouchTimer = 0;
        this._toIdle();
        return;
      }
    }
    this._syncCrouchAnim();
  }

  /**
   * しゃがみの絵を crouch シートの「立ち → しゃがみ」8コマに合わせる。
   *
   * anim.time を crouchTimer で上書きしているのがこの関数の肝。
   * 通常のアニメは経過ティックで進むが、しゃがみは押し戻しで往復するので、
   * 時間ではなく「いまの深さ」からコマを決める必要がある。
   * こうしておくと、立ち上がりは何もしなくても逆再生になる。
   */
  _syncCrouchAnim() {
    this.setAnim(this.def.anims.crouch, { stretch: CROUCH_TICKS + 1, hold: true });
    this.anim.time = this.crouchTimer;
  }

  /**
   * 空中。地上と同じ優先順位（技 > ジャンプ）で入力を拾う。
   * 空中技を持たないキャラは技の分岐を素通りするだけで済む。
   */
  _stepAir(dir, opponent, sim) {
    if (this.def.airSkillMove && this._takeBuffered('skill')) {
      this.startMove(this.def.airSkillMove, opponent);
      return;
    }
    if (this.def.airAttackMove && this._takeBuffered('attack')) {
      this.startMove(this.def.airAttackMove, opponent);
      return;
    }
    if (this.airJumps > 0 && this._takeBuffered('jump')) {
      this._airJump(dir, sim);
      return;
    }

    // 滞空中。毎ティック vy を 0 に戻すことで重力を打ち消している
    // （_integrate はこのあとに走るので、落下ぶんが積もらない）。
    if (this.hoverTicks > 0) {
      this.hoverTicks -= 1;
      this.vy = 0;
      this.vx = dir * this.def.flight.speed;
      this.setAnim(this.def.anims.fly, { fps: 12, loop: this._loops(this.def.anims.fly) });
      return;
    }

    // 上昇中と落下中でアニメを切り替える
    if (this.vy > 0) this.setAnim(this.def.anims.jump, { fps: 11, hold: true });
    else this.setAnim(this.def.anims.fall, { fps: 11, hold: true });
  }

  /**
   * 掴まれている間。位置も向きも掴んだ側に完全に固定される。
   * 掴んだ側が技を終える／中断されると落とされる。
   */
  _stepGrabbed(opponent, sim) {
    // 2人しかいないので、掴んでいるのは必ず相手
    if (!opponent.isHolding || opponent.index !== this.grabbedBy) {
      this._releaseFromGrab();
      return;
    }
    const hold = opponent.currentMove().grabHold;
    this.vx = 0;
    this.vy = 0;
    this.facing = -opponent.facing;
    this.x = opponent.x + opponent.facing * hold.x;
    this.y = hold.y;
    this.setAnim(this.def.anims.grabbed, { fps: 9, loop: this._loops(this.def.anims.grabbed) });
  }

  /**
   * 掴みが解けて落とされる。
   * ダウンの落下段階に流し込むので、地面に叩きつけられたところで
   * 通常のダウン（致命傷を負っていれば _collapse）と同じ扱いになる。
   */
  _releaseFromGrab() {
    this.grabbedBy = -1;
    this.state = STATE.DOWN;
    this.downPhase = DOWN_PHASE.AIR;
    this.stateTimer = 0;
    this.vy = 0;
    this.setAnim(this.def.anims.hurt, { fps: 14, hold: true, restart: true });
  }

  _stepMove(opponent, sim) {
    let move = this.currentMove();
    this.moveFrame += 1;

    // 繋ぎ先があれば入力を待たずに続ける（溜め → 突進 のような 2 段構えの技）。
    // 繋いだ先の 0 フレーム目は、繋いだのと同じティックで処理する。
    // ここで 1 ティック空けると、その間だけ技の移動指定が効かず、
    // 重力だけが掛かってしまう（浮遊照射が繋ぎ目でカクッと落ちる）。
    // ループ回数の上限は onEnd を辿れる深さの保険（万一循環していても止まる）。
    // 予約済みの連携（atEnd）は onEnd より優先する。押した側の意思なので。
    for (let guard = 0; this.moveFrame >= move.total; guard += 1) {
      const next = this.chainQueued ?? move.onEnd;
      if (!next || guard >= 4) {
        this._toIdle();
        return;
      }
      this.startMove(next, opponent);
      move = this.currentMove();
      this.moveFrame = 0;
    }

    // 出し始めに自分の弾を引き上げる技（照射の溜めなど）
    if (this.moveFrame === 0 && move.clearsOwnProjectiles) {
      sim.clearProjectilesOf(this.index);
    }

    // 自身の移動成分（前方向が正）
    for (const m of move.motion) {
      if (this.moveFrame < m.start || this.moveFrame > m.end) continue;
      if (m.stopOnHit && this.moveHitLanded) continue;
      this.vx = this.facing * (m.vx ?? 0);
      // vy: 0 は「重力を打ち消してその場に留まる」という指定なので、
      // 0 かどうかではなく「書かれているか」で見る
      if (m.vy != null) this.vy = m.vy;
    }

    // 弾・持続判定などの発生
    for (const s of move.spawns) {
      if (s.frame === this.moveFrame) sim.spawnFromMove(this, s);
    }

    // 連携（キャンセル）入力
    for (const c of move.chains) {
      if (this.moveFrame < c.from || this.moveFrame > c.to) continue;
      if (this._takeBuffered(c.button)) {
        // atEnd は技を途中で切らず、出し切ってから次へ移る
        if (c.atEnd) {
          this.chainQueued = c.move;
          break;
        }
        this.startMove(c.move, opponent);
        return;
      }
    }

    // 移動指定の無い区間では自然に止まる
    const moving = move.motion.some((m) => this.moveFrame >= m.start && this.moveFrame <= m.end);
    if (!moving && !this.airborne) this.vx *= 0.82;
  }

  /**
   * ダウン中。着地の検出は _integrate 側で行い、ここは倒れてからの時間を進める。
   * 倒れる／起き上がるモーションは death シートを流用している
   * （専用シートが無いため。起き上がりはそれを逆再生する）。
   */
  _stepDown(sim) {
    if (this.downPhase === DOWN_PHASE.AIR) {
      // 落ちている間はのけぞりのまま
      this.setAnim(this.def.anims.hurt, { fps: 14, hold: true });
      return;
    }

    if (this.downPhase === DOWN_PHASE.LIE) {
      this.vx *= 0.86;
      if (this.stateTimer >= DOWN_LIE_TICKS) {
        this.downPhase = DOWN_PHASE.GETUP;
        this.stateTimer = 0;
        this.setAnim(this.def.anims.death, { fps: 17, hold: true, reverse: true, restart: true });
      }
      return;
    }

    this.vx = 0;
    if (this.stateTimer >= DOWN_GETUP_TICKS) this._toIdle();
  }

  _stepStun(sim) {
    this.vx *= 0.9;
    if (this.stateTimer < this.stunTicks) return;

    // のけぞりが解けた ＝ コンボが途切れた。致命傷を負っていたならここで倒れる。
    // 連続ヒット中は毎回のけぞりが上書きされるので、その間は立ったまま食らい続ける。
    if (this.doomed) {
      this._collapse(sim);
      return;
    }

    if (this.state === STATE.BLOCK && this.guardHeld) {
      this.state = STATE.GUARD;
      this.stateTimer = 0;
    } else {
      this._toIdle();
    }
  }

  /** 速度を位置に反映し、床と壁で止める。 */
  _integrate(sim) {
    this.x += this.vx;
    if (this.airborne || this.vy !== 0) {
      this.y += this.vy;
      this.vy -= GRAVITY;
    }

    if (this.y <= 0) {
      // 空中技は着地で打ち切られる。硬直は技ごとに指定できる
      // （急降下技のように、外したら大きな隙になるものを作れるように）
      const airMoveLanded = this.state === STATE.MOVE && this.moveAir;
      const wasAir = this.state === STATE.JUMP || airMoveLanded;
      const crashed = this.state === STATE.DOWN && this.downPhase === DOWN_PHASE.AIR;
      this.y = 0;
      this.vy = 0;
      if (wasAir) {
        this.landLag = airMoveLanded ? this.currentMove().landLag ?? LAND_LAG : LAND_LAG;
        this.state = STATE.LAND;
        this.stateTimer = 0;
        this.moveId = null;
        this.moveFrame = -1;
        this.moveAir = false;
        this.usedGroups = [];
        this.hoverTicks = 0;
        this.vx *= 0.4;
        this.setAnim(this.def.anims.land, { fps: 20, hold: true, restart: true });
      } else if (crashed) {
        this.vx *= 0.35;
        if (this.doomed) {
          // 打ち上げられて叩きつけられたら、そこで決着
          this._collapse(sim);
        } else {
          // 叩きつけられて倒れる。ここからが「ダウンしている時間」。
          this.downPhase = DOWN_PHASE.LIE;
          this.stateTimer = 0;
          this.setAnim(this.def.anims.death, { fps: 20, hold: true, restart: true });
          if (sim) sim.shake = Math.max(sim.shake, 10);
        }
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
   * 攻撃を受ける。ガード判定・のけぞりまでここで完結させる。
   *
   * ── 一発必殺のルール ───────────────────────────────────────
   * ガードできなかった打撃は、どんな技のどの段でも致命傷になる。
   * 多段技の 1 打目でも最終打でも、かすった時点で勝負は決まる。
   *
   * ただしその場で倒すと、連続ヒット技が 1 打目で消えてしまって
   * 何が起きたのか分からない。そこで
   *
   *   1. 体力を 0 にして `doomed` を立てる（この時点で勝敗は確定）
   *   2. のけぞりは普通に取る ＝ 残りの段もそのまま当たり、ヒット数が伸びる
   *   3. のけぞりが解けた瞬間（コンボが途切れた瞬間）に崩れ落ちる
   *
   * という順にして、決まり手の演出だけを最後まで見せている。
   *
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

    // のけぞりもガードも立ち姿勢の絵なので、やられ判定も立ちに戻す
    this.crouchTimer = 0;
    this.hoverTicks = 0;
    // 掴まれた状態から打たれた（＝掴んだ側が最後の一撃を入れた）ら、そこで手が離れる
    this.grabbedBy = -1;
    this.hitstop = hit.hitstop;
    if (attacker) attacker.hitstop = hit.hitstop;

    const pushDir = sourceFacing || (this.x >= sourceX ? 1 : -1);

    if (blocked) {
      // ガードが成立した打撃はダメージ 0。削りは無い。
      // 体力を減らせるのは guardBreak を持つ技（＝スキル）だけ、という切り分け。
      this.state = STATE.BLOCK;
      this.stateTimer = 0;
      this.stunTicks = hit.blockstun;
      this.vx = pushDir * hit.pushBlock;
      this.setAnim(this.def.anims.guard, { fps: 14, hold: true, restart: true });
      sim.addEffect('block', this.x + pushDir * -30, this.y + 120);
      return 'block';
    }

    // 当たった時点で致命傷。ダメージ量は見ない（技の damage は残してあるが未使用）。
    this.health = 0;
    this.doomed = true;

    const breaking = wasBlocking && hit.guardBreak;
    // ダウン技はのけぞりではなく、打ち上げてダウンさせる（hitstun は使わない）
    const knocked = hit.knockdown === true;
    this.state = knocked ? STATE.DOWN : breaking ? STATE.GUARD_BREAK : STATE.HIT;
    this.stateTimer = 0;
    this.stunTicks = hit.hitstun + (breaking ? GUARD_BREAK_EXTRA : 0);
    this.vx = (pushDir * hit.pushHit) / this.def.weight;
    if (knocked) {
      this.downPhase = DOWN_PHASE.AIR;
      this.moveId = null;
      this.usedGroups = [];
      this.comboCount = 0;
    }
    if (hit.launch) {
      this.vy = hit.launch.y;
      this.y = Math.max(this.y, 0.01);
    } else if (knocked) {
      this.vy = KNOCKDOWN_LAUNCH_VY / this.def.weight;
      this.y = Math.max(this.y, 0.01);
    }
    this.setAnim(this.def.anims.hurt, { fps: 14, hold: true, restart: true });

    if (attacker) {
      attacker.comboCount += 1;
      attacker.comboDisplay = attacker.comboCount;
      attacker.comboDisplayTimer = 90;
    }

    // ヒットの手応えは火花で出す。血しぶきは決着（_collapse）のときだけ。
    sim.addEffect(breaking ? 'break' : 'spark', this.x + pushDir * -34, this.y + 118);
    sim.shake = Math.max(sim.shake, breaking ? 14 : 7);

    // ここでは倒さない。倒れるのは _stepStun / _integrate がコンボの途切れを
    // 見てから（_collapse）。
    return breaking ? 'break' : 'hit';
  }

  /**
   * 掴まれる。打撃と違ってのけぞらせず、掴んだ側に位置ごと拘束する。
   *
   * 掴みも「当たった」ことに変わりはないので、この時点で致命傷（doomed）になる。
   * ただし倒れるのは掴みが解けたあと ＝ 吸い終わって投げ捨てられたときなので、
   * ここでは倒さず _stepGrabbed に任せる。
   *
   * @param {Fighter} grabber 掴んだ側
   * @param {object} hit 掴み判定
   * @param {import('./sim.js').Simulation} sim
   */
  receiveGrab(grabber, hit, sim) {
    this.crouchTimer = 0;
    this.hoverTicks = 0;
    this.hitstop = hit.hitstop;
    grabber.hitstop = hit.hitstop;

    this.health = 0;
    this.doomed = true;

    this.state = STATE.GRABBED;
    this.stateTimer = 0;
    this.grabbedBy = grabber.index;
    this.moveId = null;
    this.moveFrame = -1;
    this.moveAir = false;
    this.usedGroups = [];
    this.comboCount = 0;
    this.vx = 0;
    this.vy = 0;
    // 掴まれた側は掴んだ相手の方を向かされる
    this.facing = -grabber.facing;
    this.setAnim(this.def.anims.grabbed, {
      fps: 9,
      loop: this._loops(this.def.anims.grabbed),
      restart: true,
    });

    grabber.comboCount += 1;
    grabber.comboDisplay = grabber.comboCount;
    grabber.comboDisplayTimer = 90;

    sim.addEffect('break', this.x, this.y + 118);
    sim.shake = Math.max(sim.shake, 12);
  }

  /** 致命傷を負ったキャラが、コンボが途切れて崩れ落ちる。 */
  _collapse(sim) {
    this.health = 0;
    this.doomed = false;
    this.state = STATE.KO;
    this.stateTimer = 0;
    this.moveId = null;
    this.moveFrame = -1;
    this.moveAir = false;
    this.usedGroups = [];
    this.vx *= 0.4;
    this.setAnim(this.def.anims.death, { fps: 10, hold: true, restart: true });
    if (sim) {
      // 決着の瞬間だけ血が噴き出す。倒れた向き（背中側）へ飛ばす。
      // 血溜まりは足元に敷くので、キャラの下に潜らせるため別のエフェクトにしてある。
      // 血溜まりと同じ寿命にしておく。飛沫だけ先に消えると、
      // 溜まりだけが残って不自然に見えるため
      sim.addEffect('blood', this.x, this.y + 106, { life: 150, facing: -this.facing });
      sim.addEffect('bloodPool', this.x, 0, { life: 150, facing: -this.facing });
      sim.shake = Math.max(sim.shake, 18);
    }
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
      this.moveHitLanded, this.moveAir, this.usedGroups.slice(), this.chainQueued,
      this.hitstop, this.landLag, this.downPhase, this.airJumps, this.doomed,
      this.crouchTimer, this.hoverTicks, this.grabbedBy,
      this.guardHeld, this.walkDir, this.dashDir, this.prevInput,
      this.tapDir, this.tapTimer, this.bufAttack, this.bufSkill, this.bufJump,
      this.comboCount, this.comboDisplay, this.comboDisplayTimer,
      this.stunTicks ?? 0,
      this.anim.name, this.anim.time, this.anim.fps, this.anim.loop,
      this.anim.hold, this.anim.reverse, this.anim.stretch, this.anim.delay,
      this.anim.range ? this.anim.range.slice() : null,
    ];
  }

  load(s) {
    let i = 0;
    this.x = s[i++]; this.y = s[i++]; this.vx = s[i++]; this.vy = s[i++];
    this.facing = s[i++]; this.health = s[i++];
    this.state = s[i++]; this.stateTimer = s[i++]; this.moveId = s[i++]; this.moveFrame = s[i++];
    this.moveHitLanded = s[i++]; this.moveAir = s[i++]; this.usedGroups = s[i++].slice();
    this.chainQueued = s[i++];
    this.hitstop = s[i++]; this.landLag = s[i++]; this.downPhase = s[i++];
    this.airJumps = s[i++]; this.doomed = s[i++]; this.crouchTimer = s[i++];
    this.hoverTicks = s[i++]; this.grabbedBy = s[i++];
    this.guardHeld = s[i++]; this.walkDir = s[i++]; this.dashDir = s[i++]; this.prevInput = s[i++];
    this.tapDir = s[i++]; this.tapTimer = s[i++];
    this.bufAttack = s[i++]; this.bufSkill = s[i++]; this.bufJump = s[i++];
    this.comboCount = s[i++]; this.comboDisplay = s[i++]; this.comboDisplayTimer = s[i++];
    this.stunTicks = s[i++];
    this.anim = {
      name: s[i++], time: s[i++], fps: s[i++], loop: s[i++],
      hold: s[i++], reverse: s[i++], stretch: s[i++], delay: s[i++], range: null,
    };
    const range = s[i++];
    this.anim.range = range ? range.slice() : null;
  }
}
