/**
 * 対戦中の UI（体力ゲージ・タイマー・ラウンド表示など）。
 *
 * 体力バーの「遅れて減る赤いバー」だけは描画側で補間しているので、
 * ここに表示専用の状態を持っている。試合結果には影響しない。
 */
import { PHASE } from '../game/sim.js';
import { ROUND_INTRO_TICKS } from '../game/constants.js';

const FONT = '"Segoe UI", "Hiragino Sans", "Noto Sans JP", sans-serif';

export class Hud {
  constructor() {
    /** 遅れて追従する体力（演出用）。 */
    this.ghost = [1, 1];
  }

  /**
   * @param {CanvasRenderingContext2D} ctx
   * @param {import('../game/sim.js').Simulation} sim
   * @param {number} w CSS ピクセル幅
   * @param {number} h CSS ピクセル高
   * @param {string[]} labels プレイヤー名
   */
  draw(ctx, sim, w, h, labels) {
    // 画面が小さいほど UI も縮める。
    // 幅も見ているのは、縦長画面で体力ゲージとタイマーが重なるのを防ぐため。
    const s = Math.max(0.55, Math.min(1.25, Math.min(h / 620, w / 980)));

    for (let i = 0; i < 2; i += 1) {
      const f = sim.fighters[i];
      const ratio = Math.max(0, f.health / f.maxHealth);
      // 実体力より遅れて追いつくバー
      this.ghost[i] += (ratio - this.ghost[i]) * (ratio > this.ghost[i] ? 0.25 : 0.06);
      this._drawHealthBar(ctx, sim, i, ratio, this.ghost[i], w, s, labels[i]);
    }

    this._drawTimer(ctx, sim, w, s);
    this._drawCombo(ctx, sim, w, h, s);
    this._drawBanner(ctx, sim, w, h, s, labels);
  }

  _drawHealthBar(ctx, sim, index, ratio, ghost, w, s, label) {
    const f = sim.fighters[index];
    const barW = Math.min(w * 0.4, 430 * s);
    const barH = 22 * s;
    const margin = 16 * s;
    const top = 20 * s;
    const left = index === 0 ? margin : w - margin - barW;
    // 1P は右から、2P は左から減る（内側から削れる見せ方）
    const fillFromLeft = index === 0;

    ctx.save();
    // 枠
    ctx.fillStyle = 'rgba(6,8,16,0.72)';
    ctx.fillRect(left - 3 * s, top - 3 * s, barW + 6 * s, barH + 6 * s);

    // 遅れバー
    const drawSeg = (frac, style) => {
      const segW = barW * frac;
      ctx.fillStyle = style;
      ctx.fillRect(fillFromLeft ? left : left + barW - segW, top, segW, barH);
    };
    drawSeg(1, 'rgba(255,255,255,0.08)');
    drawSeg(Math.max(ghost, ratio), '#c8323c');

    const grad = ctx.createLinearGradient(0, top, 0, top + barH);
    grad.addColorStop(0, '#ffe27a');
    grad.addColorStop(0.5, f.def.themeColor);
    grad.addColorStop(1, '#2b5fb0');
    drawSeg(ratio, grad);

    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1;
    ctx.strokeRect(left, top, barW, barH);

    // 名前
    ctx.font = `600 ${Math.round(15 * s)}px ${FONT}`;
    ctx.fillStyle = '#e9edf7';
    ctx.textBaseline = 'top';
    ctx.textAlign = index === 0 ? 'left' : 'right';
    ctx.fillText(`${f.def.name}  ${label}`, index === 0 ? left : left + barW, top + barH + 6 * s);

    // ラウンド取得数
    const pipR = 6 * s;
    const pipGap = 18 * s;
    for (let r = 0; r < sim.roundsToWin; r += 1) {
      const cx = index === 0 ? left + pipR + r * pipGap : left + barW - pipR - r * pipGap;
      ctx.beginPath();
      ctx.arc(cx, top - 12 * s, pipR, 0, Math.PI * 2);
      ctx.fillStyle = r < sim.wins[index] ? '#ffd45e' : 'rgba(255,255,255,0.2)';
      ctx.fill();
    }
    ctx.restore();
  }

  _drawTimer(ctx, sim, w, s) {
    const cx = w / 2;
    const cy = 40 * s;
    const r = 34 * s;

    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(6,8,16,0.75)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx.lineWidth = 2;
    ctx.stroke();

    const sec = Math.max(0, sim.secondsLeft);
    ctx.font = `700 ${Math.round(34 * s)}px ${FONT}`;
    ctx.fillStyle = sec <= 10 ? '#ff6b6b' : '#f4f7ff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(sec), cx, cy + 1);

    ctx.font = `600 ${Math.round(12 * s)}px ${FONT}`;
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.fillText(`ROUND ${sim.round}`, cx, cy + r + 12 * s);
    ctx.restore();
  }

  _drawCombo(ctx, sim, w, h, s) {
    for (let i = 0; i < 2; i += 1) {
      const f = sim.fighters[i];
      if (f.comboDisplayTimer <= 0 || f.comboDisplay < 2) continue;
      const x = i === 0 ? w * 0.16 : w * 0.84;
      const y = h * 0.34;
      const fade = Math.min(1, f.comboDisplayTimer / 20);

      ctx.save();
      ctx.globalAlpha = fade;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `800 ${Math.round(52 * s)}px ${FONT}`;
      ctx.fillStyle = '#ffd45e';
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.lineWidth = 5 * s;
      ctx.strokeText(String(f.comboDisplay), x, y);
      ctx.fillText(String(f.comboDisplay), x, y);
      ctx.font = `700 ${Math.round(18 * s)}px ${FONT}`;
      ctx.fillStyle = '#fff';
      ctx.strokeText('HITS', x, y + 34 * s);
      ctx.fillText('HITS', x, y + 34 * s);
      ctx.restore();
    }
  }

  /** ラウンド開始・決着の大きな文字。 */
  _drawBanner(ctx, sim, w, h, s, labels) {
    let text = null;
    let sub = null;

    if (sim.phase === PHASE.INTRO) {
      // 前半は「ROUND n」、後半は「FIGHT!」
      if (sim.phaseTimer < ROUND_INTRO_TICKS * 0.62) text = `ROUND ${sim.round}`;
      else text = 'FIGHT!';
    } else if (sim.phase === PHASE.ROUND_END) {
      const [a, b] = sim.fighters;
      if (a.isKO || b.isKO) text = 'K.O.';
      else text = 'TIME UP';
      if (sim.roundWinner >= 0) sub = `${labels[sim.roundWinner]} WIN`;
      else sub = 'DRAW';
    } else if (sim.phase === PHASE.MATCH_END) {
      text = sim.matchWinner >= 0 ? `${labels[sim.matchWinner]} WIN` : 'DRAW';
    }

    if (!text) return;
    const cx = w / 2;
    const cy = h * 0.42;

    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `800 ${Math.round(64 * s)}px ${FONT}`;
    ctx.lineWidth = 8 * s;
    ctx.strokeStyle = 'rgba(0,0,0,0.65)';
    ctx.fillStyle = '#fff2c4';
    ctx.strokeText(text, cx, cy);
    ctx.fillText(text, cx, cy);
    if (sub) {
      ctx.font = `700 ${Math.round(26 * s)}px ${FONT}`;
      ctx.strokeText(sub, cx, cy + 52 * s);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(sub, cx, cy + 52 * s);
    }
    ctx.restore();
  }
}
