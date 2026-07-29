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

export class InputManager {
  constructor() {
    this.keyBits = [0, 0];
    this.touchBits = [0, 0];
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
   * 画面上の仮想パッドを繋ぐ。
   * `data-btn="left|right|up|down|attack|skill|guard"` を持つ要素を拾う。
   */
  attachTouch(root) {
    const NAMES = {
      left: BTN.LEFT,
      right: BTN.RIGHT,
      up: BTN.UP,
      down: BTN.DOWN,
      attack: BTN.ATTACK,
      skill: BTN.SKILL,
      guard: BTN.GUARD,
    };

    for (const el of root.querySelectorAll('[data-btn]')) {
      const bit = NAMES[el.dataset.btn];
      if (!bit) continue;
      const slot = Number(el.dataset.player || 0);

      const press = (e) => {
        e.preventDefault();
        // 指がボタンから少しずれても押しっぱなし扱いにする
        el.setPointerCapture?.(e.pointerId);
        this.touchBits[slot] |= bit;
        this.latch[slot] |= bit;
        el.classList.add('is-pressed');
      };
      const release = (e) => {
        e.preventDefault();
        this.touchBits[slot] &= ~bit;
        el.classList.remove('is-pressed');
      };

      el.addEventListener('pointerdown', press);
      el.addEventListener('pointerup', release);
      el.addEventListener('pointercancel', release);
      this._touchCleanup.push(() => {
        el.removeEventListener('pointerdown', press);
        el.removeEventListener('pointerup', release);
        el.removeEventListener('pointercancel', release);
      });
    }
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
  }
}
