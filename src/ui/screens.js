/**
 * メニュー画面まわりの UI。
 * ゲーム本体（シミュレーション）とは完全に分離してあり、
 * ここは DOM の見せ方と選択結果を返すことだけを担当する。
 */
import { drawStillFrame } from '../render/spritebank.js';

export class ScreenManager {
  constructor() {
    this.screens = new Map();
    for (const el of document.querySelectorAll('.screen')) {
      this.screens.set(el.id, el);
    }
  }

  /** 指定画面だけを表示する（overlay 指定のものは対象外）。 */
  show(id) {
    for (const [key, el] of this.screens) {
      if (el.classList.contains('overlay')) continue;
      el.classList.toggle('is-active', key === id);
    }
    this.current = id;
  }

  /** ポーズなど、上に重ねる画面の表示切り替え。 */
  overlay(id, visible) {
    this.screens.get(id)?.classList.toggle('is-active', visible);
  }

  isOverlayOpen(id) {
    return this.screens.get(id)?.classList.contains('is-active') ?? false;
  }
}

/**
 * キャラクター選択。
 * カードのサムネイルは待機モーションをそのまま再生している。
 */
export class CharacterSelect {
  /**
   * @param {object} dom {root, info, title, confirm, back}
   * @param {Array} roster キャラ定義の配列
   * @param {Record<string,object>} sprites
   */
  constructor(dom, roster, sprites) {
    this.dom = dom;
    this.roster = roster;
    this.sprites = sprites;
    this.cards = [];
    this.active = false;
    this.picks = [];
    this.slot = 0;
    this.slotCount = 2;
    this.labels = ['1P', '2P'];
    this._build();

    dom.confirm.addEventListener('click', () => this._confirm());
    dom.back.addEventListener('click', () => this.onCancel?.());
    this._tick = this._tick.bind(this);
  }

  _build() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.dom.root.innerHTML = '';
    for (const def of this.roster) {
      const card = document.createElement('button');
      card.className = 'card';
      card.type = 'button';

      const canvas = document.createElement('canvas');
      const W = 150;
      const H = 168;
      canvas.width = W * dpr;
      canvas.height = H * dpr;
      canvas.style.aspectRatio = `${W} / ${H}`;

      const tag = document.createElement('span');
      tag.className = 'ctag';
      tag.hidden = true;

      const name = document.createElement('div');
      name.className = 'cname';
      name.textContent = def.name;

      const sub = document.createElement('div');
      sub.className = 'csub';
      sub.textContent = def.subtitle;

      card.append(tag, canvas, name, sub);
      card.addEventListener('click', () => this._pick(def.id));
      this.dom.root.appendChild(card);

      this.cards.push({ def, el: card, canvas, ctx: canvas.getContext('2d'), tag, dpr, W, H });
    }
  }

  /**
   * 選択を開始する。
   * @param {number} slotCount 選ぶ人数（オンラインは自分だけなので1）
   * @param {string[]} labels 表示名
   * @param {(picks:string[])=>void} onDone
   * @param {()=>void} onCancel
   */
  start(slotCount, labels, onDone, onCancel) {
    this.slotCount = slotCount;
    this.labels = labels;
    this.onDone = onDone;
    this.onCancel = onCancel;
    this.slot = 0;
    this.picks = new Array(slotCount).fill(this.roster[0].id);
    this.active = true;
    this._refresh();
    requestAnimationFrame(this._tick);
  }

  stop() {
    this.active = false;
  }

  _pick(id) {
    this.picks[this.slot] = id;
    this._refresh();
  }

  _confirm() {
    if (this.slot + 1 < this.slotCount) {
      this.slot += 1;
      this._refresh();
    } else {
      this.active = false;
      this.onDone?.(this.picks.slice());
    }
  }

  _refresh() {
    const label = this.labels[this.slot] ?? `${this.slot + 1}P`;
    this.dom.title.textContent = `${label} キャラクター選択`;
    this.dom.confirm.textContent = this.slot + 1 < this.slotCount ? '次へ' : '決定';

    const currentId = this.picks[this.slot];
    for (const card of this.cards) {
      const selected = card.def.id === currentId;
      card.el.classList.toggle('is-selected', selected);
      // 先に選び終わったプレイヤーの印を出す
      const owner = this.picks.findIndex((p, i) => p === card.def.id && i < this.slot);
      if (owner >= 0) {
        card.tag.hidden = false;
        card.tag.textContent = this.labels[owner] ?? `${owner + 1}P`;
      } else {
        card.tag.hidden = true;
      }
    }

    const def = this.roster.find((c) => c.id === currentId);
    const attack = def.moves[def.attackMove];
    const skill = def.moves[def.skillMove];
    const chain = attack.chains?.[0] ? def.moves[attack.chains[0].move] : null;
    this.dom.info.innerHTML =
      `<b>${def.name}</b> — ${def.subtitle}<br>` +
      `攻撃: ${attack.label}${chain ? `（続けて攻撃で「${chain.label}」）` : ''}<br>` +
      `スキル: ${skill.label}（ガードを崩す / 隙が大きい）`;
  }

  /** サムネイルの待機モーションを回す。 */
  _tick(now) {
    if (!this.active) return;
    requestAnimationFrame(this._tick);
    const frame = Math.floor(now / 110);
    for (const card of this.cards) {
      const sprite = this.sprites[card.def.id];
      if (!sprite) continue;
      const cell = sprite.animations.idle;
      const ctx = card.ctx;
      ctx.setTransform(card.dpr, 0, 0, card.dpr, 0, 0);
      ctx.clearRect(0, 0, card.W, card.H);
      // 足元を下端の少し上に置き、身長が枠に収まる倍率で描く
      const scale = (card.H - 26) / sprite.height;
      drawStillFrame(
        ctx,
        sprite,
        'idle',
        frame % cell.frames,
        card.W / 2,
        card.H - 8,
        scale
      );
    }
  }
}
