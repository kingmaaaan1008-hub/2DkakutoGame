/**
 * 入力の集約。
 *
 * キーボード / 画面ボタン / ゲームパッドという別々の入力源を、
 * 「プレイヤーごとに整数 1 個のビットマスク」へ畳み込む。
 * シミュレーションが受け取るのはこのビットマスクだけなので、
 * 入力源を増やしてもゲームロジックには一切影響しない。
 * （オンライン対戦のときは、相手のビットマスクが通信で届くだけ）
 */
import { BTN } from '../game/constants.js';
import { GESTURE, SWIPE, SwipeTracker } from './gestures.js';

/** キーボード配列。1台で2人対戦できるように左右で分けてある。 */
const KEYMAP = [
  // プレイヤー1: 移動は左手(A/D)・ジャンプはその上(W)、アクションは右手(J/K/L)
  {
    KeyA: BTN.LEFT,
    KeyD: BTN.RIGHT,
    KeyW: BTN.UP,
    KeyS: BTN.DOWN,
    KeyJ: BTN.ATTACK,
    KeyK: BTN.SKILL,
    KeyL: BTN.GUARD,
  },
  // プレイヤー2: 右手
  {
    ArrowLeft: BTN.LEFT,
    ArrowRight: BTN.RIGHT,
    ArrowUp: BTN.UP,
    ArrowDown: BTN.DOWN,
    Comma: BTN.ATTACK,
    Period: BTN.SKILL,
    Slash: BTN.GUARD,
  },
];

/** ゲームパッドのボタン番号 → ビット。標準配列(Xbox系)を想定。 */
const PAD_BUTTONS = {
  0: BTN.ATTACK, // A
  2: BTN.SKILL, // X
  1: BTN.GUARD, // B
  3: BTN.UP, // Y
  4: BTN.GUARD, // L1
  5: BTN.SKILL, // R1
  12: BTN.UP, // D-pad 上
  13: BTN.DOWN, // D-pad 下
  14: BTN.LEFT, // D-pad 左
  15: BTN.RIGHT, // D-pad 右
};

const STICK_DEADZONE = 0.4;

/** タッチのエリアごとに「押しっぱなし」になりうるビット。指を離すとここを落とす。 */
const HELD_BY_ZONE = {
  move: BTN.LEFT | BTN.RIGHT | BTN.DOWN | BTN.DASH,
  action: BTN.GUARD,
};

/** 押した瞬間だけ意味を持つ入力を出しておく猶予（ミリ秒）。表示を戻すのに使う。 */
const CUE_PULSE_MS = 320;

/**
 * タップと見なす最長の接触時間（ミリ秒）。
 *
 * 攻撃は指を離した時点で出る。押した瞬間に出せればその方が速いが、
 * それだとスキルやガードのスワイプも「まず押す」ので、毎回攻撃が
 * 暴発してしまう。一撃で決まるゲームなので、暴発の方が遅延より痛い。
 * 上限を置いているのは、置きっぱなしの指を離しただけで技が出ないようにするため。
 */
const TAP_MAX_MS = 500;

export class InputManager {
  constructor() {
    this.keyBits = [0, 0];
    this.touchBits = [0, 0];
    /**
     * 「相手がどちら側にいるか」（+1 = 右）。攻撃エリアのフリックを
     * 攻撃（相手方向）とスキル（逆方向）に振り分けるのに使う。
     * 画面を見ている人にとっては前後であって左右ではないので、
     * 毎フレーム試合の状況から入れ直してもらう。
     */
    this.aimDir = [1, 1];
    /**
     * 自分が空中にいるか。これも毎フレーム試合の状況から入れ直してもらう。
     *
     * 空中では横入力で速度が変わらない（跳んだ瞬間の向きで軌道が決まる）ので、
     * 横スワイプをそのままにしておくと空振りになる。
     * 空中の移動手段はジャンプしかないので、横スワイプもその向きへの
     * ジャンプとして扱う。2段ジャンプを出すのに真上を狙う必要がなくなる。
     */
    this.airborne = [false, false];
    /**
     * 前回の poll 以降に「押された」ビット。
     * 1/60 秒より短いタップは押下と解放が同じフレームの隙間に収まってしまい、
     * そのままだとシミュレーションが一度も押下を観測できない。
     * ここに残しておいて poll で1回だけ必ず反映させる。
     */
    this.latch = [0, 0];
    /** 1人プレイのときは両方のキー配列で P1 を動かせるようにする。 */
    this.solo = true;
    this._onKeyDown = null;
    this._onKeyUp = null;
    this._touchCleanup = [];
    this._zones = [];
  }

  attachKeyboard(target = window) {
    // スペースやキーで操作される UI にフォーカスがあるときは横取りしない
    // （タイトルのボタンや「操作方法」がスペースで開けなくなるため）
    const isUiFocused = (event) => {
      const el = event.target;
      return el instanceof Element && el.closest('button, summary, a, input, select, textarea');
    };

    const apply = (event, pressed) => {
      if (isUiFocused(event)) return;
      let handled = false;
      for (let p = 0; p < KEYMAP.length; p += 1) {
        const bit = KEYMAP[p][event.code];
        if (!bit) continue;
        // ソロ時はどちらの配列も P1 に流す
        const slot = this.solo ? 0 : p;
        if (pressed) {
          this.keyBits[slot] |= bit;
          this.latch[slot] |= bit;
        } else {
          this.keyBits[slot] &= ~bit;
        }
        handled = true;
      }
      // 矢印キーやスペースでページがスクロールしないように
      if (handled) event.preventDefault();
    };

    this._onKeyDown = (e) => {
      if (e.repeat) return;
      apply(e, true);
    };
    this._onKeyUp = (e) => apply(e, false);
    target.addEventListener('keydown', this._onKeyDown);
    target.addEventListener('keyup', this._onKeyUp);
    // ウィンドウが非アクティブになったときに押しっぱなしが残らないように
    window.addEventListener('blur', () => {
      this.keyBits[0] = 0;
      this.keyBits[1] = 0;
    });
  }

  /**
   * スワイプ操作のエリアを繋ぐ。`data-zone="move|action"` を持つ要素を拾う。
   *
   * ボタンを並べる代わりに画面を左右に割って、指を弾いた向きで操作する。
   * ボタンだと「押す場所を見る」必要があるが、この形なら画面のどこを触っても
   * よくなるので、目をキャラから離さずに操作できる。
   *
   * エリアごとに指1本ぶんの状態を持つので、左右のエリアは同時に使える
   * （左親指で走りながら右親指で攻撃、ができる）。
   */
  attachTouchZones(root) {
    for (const el of root.querySelectorAll('[data-zone]')) {
      const kind = el.dataset.zone;
      if (!HELD_BY_ZONE[kind]) continue;
      const slot = Number(el.dataset.player || 0);
      const tracker = new SwipeTracker();
      const cue = { rest: '', timer: 0 };
      let pointerId = null;
      /** この指で一度でもスワイプを認識したか。タップの判定に使う。 */
      let swiped = false;
      let downAt = 0;

      this._zones.push({ el, cue });

      const down = (e) => {
        e.preventDefault();
        if (pointerId !== null) return; // 同じエリアに置かれた2本目は無視する
        pointerId = e.pointerId;
        // 指がエリアの外へ流れても、離すまでは同じエリアの操作として扱う。
        // 掴めなくても操作自体は続けられる（エリア内にいる限り move は届く）ので、
        // ここで例外を上げて以降の処理を落とさないようにする。
        try {
          el.setPointerCapture?.(e.pointerId);
        } catch {
          /* 既に離された指などは掴めない。無視して続行する */
        }
        tracker.start(e.clientX, e.clientY);
        swiped = false;
        downAt = e.timeStamp;
        el.classList.add('is-touched');
      };

      const move = (e) => {
        if (e.pointerId !== pointerId) return;
        e.preventDefault();
        const hit = tracker.move(e.clientX, e.clientY, e.timeStamp);
        if (!hit) return;
        swiped = true;
        this._showCue(
          el,
          cue,
          kind === 'move' ? this._applyMoveSwipe(slot, hit) : this._applyActionSwipe(slot, hit)
        );
      };

      /** @param {boolean} tappable pointerup か（pointercancel では技を出さない） */
      const finish = (e, tappable) => {
        if (e.pointerId !== pointerId) return;
        e.preventDefault();
        pointerId = null;
        tracker.end();
        this.touchBits[slot] &= ~HELD_BY_ZONE[kind];
        el.classList.remove('is-touched');

        // 攻撃エリアで「弾かずに離した」＝タップ。攻撃はこれで出す。
        const tapped =
          tappable && kind === 'action' && !swiped && e.timeStamp - downAt <= TAP_MAX_MS;
        this._showCue(el, cue, tapped ? this._applyActionTap(slot) : { cue: '', rest: '' });
      };

      const up = (e) => finish(e, true);
      const cancel = (e) => finish(e, false);

      el.addEventListener('pointerdown', down);
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', cancel);
      this._touchCleanup.push(() => {
        el.removeEventListener('pointerdown', down);
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', cancel);
        clearTimeout(cue.timer);
      });
    }
  }

  /**
   * 移動エリアのスワイプをビットに落とす。
   *
   * 横と下は「触っている間ずっと」なので押しっぱなしのビットにする。
   * ジャンプだけは押した瞬間しか意味が無い（押しっぱなしにすると
   * 立ち上がりが二度と来ず、2段ジャンプが出せなくなる）ので、
   * latch に置いて1フレームだけ押されたことにする。
   *
   * @param {{gesture: string, dist: number}} swipe dist は弾いた距離。
   *   横は小さく弾けば歩き、大きく弾けば走りになる。
   * @returns {{cue: string, rest: string}} 出す表示と、それが消えた後に戻る表示
   */
  _applyMoveSwipe(slot, { gesture, dist }) {
    const held = BTN.LEFT | BTN.RIGHT | BTN.DOWN | BTN.DASH;
    const bits = this.touchBits[slot];

    if (gesture === GESTURE.UP) {
      // 方向を落として真上に跳ぶ
      this.touchBits[slot] = bits & ~held;
      this.latch[slot] |= BTN.UP;
      return { cue: 'jumpUp', rest: '' };
    }
    if (gesture === GESTURE.DOWN) {
      this.touchBits[slot] = (bits & ~held) | BTN.DOWN;
      return { cue: 'crouch', rest: 'crouch' };
    }

    const dirBit =
      gesture === GESTURE.LEFT || gesture === GESTURE.UP_LEFT
        ? BTN.LEFT
        : gesture === GESTURE.RIGHT || gesture === GESTURE.UP_RIGHT
          ? BTN.RIGHT
          : 0;
    if (dirBit === 0) return { cue: '', rest: '' };
    const side = dirBit === BTN.LEFT ? 'Left' : 'Right';

    // 斜め上は跳ぶ。横も、空中なら跳ぶ
    // （空中では横入力で速度が変わらないので、そのままでは空振りになる。
    //  空中の移動手段はジャンプだけなので、横スワイプもジャンプとして扱う）
    const diagonal = gesture === GESTURE.UP_LEFT || gesture === GESTURE.UP_RIGHT;
    if (diagonal || this.airborne[slot]) {
      // 跳ぶための弾きの長さで地上の速さまで変わると分かりづらいので、
      // 同じ向きへ走っていたならそのまま走りを保つ（着地してまた走れる）
      const running = (bits & BTN.DASH) !== 0 && (bits & dirBit) !== 0;
      // ジャンプと同じフレームに方向が要る（跳んだ瞬間の向きで軌道が決まる）
      this.touchBits[slot] = (bits & ~held) | dirBit | (running ? BTN.DASH : 0);
      this.latch[slot] |= BTN.UP;
      return { cue: 'jump' + side, rest: (running ? 'dash' : 'walk') + side };
    }

    // 地上の横スワイプ。弾いた距離だけで決める
    // （弾いた指をそのまま引き伸ばせば歩き → 走りに上がる）
    const dashing = dist >= SWIPE.RUN;
    const ground = (dashing ? 'dash' : 'walk') + side;
    this.touchBits[slot] = (bits & ~held) | dirBit | (dashing ? BTN.DASH : 0);
    return { cue: ground, rest: ground };
  }

  /**
   * 攻撃エリアのスワイプをビットに落とす。
   * 相手のいる方へ弾けばスキル、下へ弾けばガード。
   *
   * スキルを「相手の方へ」にしているのは、踏み込んで出す技の向きと
   * 指の動きを一致させるため。左右ではなく前後で決めるので、
   * 相手が回り込んでも弾いた向きと出る技が食い違わない。
   * 斜め上は横に丸めるので、上へ流れても技は出る。
   */
  _applyActionSwipe(slot, { gesture }) {
    if (gesture === GESTURE.DOWN) {
      this.touchBits[slot] |= BTN.GUARD;
      return { cue: 'guard', rest: 'guard' };
    }
    const dir =
      gesture === GESTURE.LEFT || gesture === GESTURE.UP_LEFT
        ? -1
        : gesture === GESTURE.RIGHT || gesture === GESTURE.UP_RIGHT
          ? 1
          : 0;
    // 真上と、相手に背を向ける方向は割り当てなし
    if (dir !== this.aimDir[slot]) return { cue: '', rest: '' };
    // 技を出したらガードは解ける
    this.touchBits[slot] &= ~BTN.GUARD;
    this.latch[slot] |= BTN.SKILL;
    return { cue: 'skill', rest: '' };
  }

  /**
   * 攻撃エリアのタップ。
   * 攻撃は一番よく使うので、向きも狙いも要らないタップに置いてある。
   */
  _applyActionTap(slot) {
    this.latch[slot] |= BTN.ATTACK;
    return { cue: 'attack', rest: '' };
  }

  /**
   * いま何を入力したかをエリア自身に出す。
   * 表示する文字は CSS 側に持たせてあるので、ここでは状態名だけ渡す。
   * 押した瞬間だけの入力（ジャンプ・攻撃・スキル）は少し見せてから、
   * 押しっぱなしの状態（歩き・走り・しゃがみ・ガード）の表示に戻す。
   */
  _showCue(el, cue, { cue: name, rest }) {
    cue.rest = rest;
    // 押しっぱなしの状態が続いているだけなら触らない。
    // 指を滑らせている間は同じ状態が何度も届くので、毎回出し直すとちらつく。
    if (name === rest && el.dataset.cue === name) return;
    clearTimeout(cue.timer);
    this._setCue(el, name);
    if (name === rest) return;
    cue.timer = setTimeout(() => this._setCue(el, cue.rest), CUE_PULSE_MS);
  }

  _setCue(el, name) {
    // 同じ状態が続くときもアニメーションを出し直したいので、いったん外す
    el.removeAttribute('data-cue');
    void el.offsetWidth;
    if (name) el.dataset.cue = name;
  }

  /** 接続済みゲームパッドを読む。1本目を P1、2本目を P2 に割り当てる。 */
  _padBits() {
    const out = [0, 0];
    const pads = navigator.getGamepads?.() ?? [];
    let slot = 0;
    for (const pad of pads) {
      if (!pad || slot > 1) continue;
      let bits = 0;
      pad.buttons.forEach((b, i) => {
        if (b.pressed && PAD_BUTTONS[i]) bits |= PAD_BUTTONS[i];
      });
      const ax = pad.axes[0] ?? 0;
      const ay = pad.axes[1] ?? 0;
      if (ax < -STICK_DEADZONE) bits |= BTN.LEFT;
      if (ax > STICK_DEADZONE) bits |= BTN.RIGHT;
      if (ay < -STICK_DEADZONE) bits |= BTN.UP;
      if (ay > STICK_DEADZONE) bits |= BTN.DOWN;
      out[this.solo ? 0 : slot] |= bits;
      slot += 1;
    }
    return out;
  }

  /** そのフレームの [P1, P2] ビットマスクを返す。 */
  poll() {
    const pad = this._padBits();
    const out = [
      this.keyBits[0] | this.touchBits[0] | this.latch[0] | pad[0],
      this.keyBits[1] | this.touchBits[1] | this.latch[1] | pad[1],
    ];
    // 取りこぼし防止の押下は1フレームだけ反映すれば足りる
    this.latch[0] = 0;
    this.latch[1] = 0;
    return out;
  }

  reset() {
    this.keyBits = [0, 0];
    this.touchBits = [0, 0];
    this.latch = [0, 0];
    // ポーズや試合開始をまたいで表示だけ残らないようにする
    for (const zone of this._zones) {
      clearTimeout(zone.cue.timer);
      zone.cue.rest = '';
      zone.el.classList.remove('is-touched');
      zone.el.removeAttribute('data-cue');
    }
  }
}
