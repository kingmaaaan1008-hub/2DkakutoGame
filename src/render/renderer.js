/**
 * 試合画面の描画。
 *
 * シミュレーションの状態を読むだけで、書き換えは一切しない。
 * （描画がゲーム進行に影響しないので、フレームを落としても試合結果は変わらない）
 */
import { STAGE_WIDTH, STATE } from '../game/constants.js';
import { toWorldBox } from '../game/moves.js';
import { getProjectileDef } from '../game/projectiles.js';
import { drawFighterSprite } from './spritebank.js';
import { drawStage } from './stage.js';

/** 地面から画面上端までに見えるワールド単位。キャラの画面占有率を決める。 */
const VIEW_ABOVE = 440;
/**
 * 横方向に最低限見せたいワールド単位。
 * 縦長の画面（スマホ縦持ち）では高さ基準だけで倍率を決めると
 * 2人が画面に収まらなくなるので、幅からも上限をかける。
 */
const VIEW_WIDTH = 900;
/** 地面の画面内での位置（横長画面での基準）。 */
const GROUND_RATIO = 0.86;
/** 2人が離れたときにどこまで引くか（基準ズームに対する下限）。 */
const MIN_ZOOM_RATIO = 0.62;
/** 2人の間に確保したい余白。 */
const FRAME_PADDING = 460;

export class Renderer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {Record<string, object>} sprites キャラid → スプライト
   */
  constructor(canvas, sprites) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.sprites = sprites;
    /** true にすると判定ボックスを可視化する。技の調整用。 */
    this.debug = false;
    this.cam = { x: STAGE_WIDTH / 2, zoom: 1, groundY: 0, canvasW: 0, canvasH: 0 };
  }

  _updateCamera(sim) {
    const w = this.canvas.width / this.dpr;
    const h = this.canvas.height / this.dpr;
    const cam = this.cam;
    cam.canvasW = w;
    cam.canvasH = h;

    // 高さと幅の両方から基準倍率を決める。縦長画面では幅側が効く。
    const base = Math.min((h * GROUND_RATIO) / VIEW_ABOVE, w / VIEW_WIDTH);
    const [a, b] = sim.fighters;
    const need = Math.abs(a.x - b.x) + FRAME_PADDING;
    // 2人が画面に収まらないときだけ引く
    const fit = w / need;
    cam.zoom = Math.max(base * MIN_ZOOM_RATIO, Math.min(base, fit));

    // 縦長画面では地面を上げて、無駄な空を減らし戦闘を中央に寄せる
    cam.groundY = Math.min(h * GROUND_RATIO, h * 0.5 + VIEW_ABOVE * cam.zoom * 0.45);

    const viewW = w / cam.zoom;
    const mid = (a.x + b.x) / 2;
    if (viewW >= STAGE_WIDTH) {
      cam.x = STAGE_WIDTH / 2;
    } else {
      cam.x = Math.min(STAGE_WIDTH - viewW / 2, Math.max(viewW / 2, mid));
    }

    cam.toScreenX = (wx) => (wx - cam.x) * cam.zoom + w / 2;
    cam.toScreenY = (wy) => cam.groundY - wy * cam.zoom;
  }

  /**
   * @param {import('../game/sim.js').Simulation} sim
   * @param {number} dpr デバイスピクセル比
   */
  render(sim, dpr) {
    this.dpr = dpr;
    const ctx = this.ctx;
    const w = this.canvas.width / dpr;
    const h = this.canvas.height / dpr;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    this._updateCamera(sim);
    const cam = this.cam;

    // 画面揺れ。決定的な値なのでリプレイでも同じ揺れになる。
    let shakeX = 0;
    let shakeY = 0;
    if (sim.shake > 0.2) {
      const t = sim.tick;
      shakeX = Math.sin(t * 2.7) * sim.shake;
      shakeY = Math.cos(t * 3.9) * sim.shake * 0.5;
      ctx.translate(shakeX, shakeY);
    }

    drawStage(ctx, cam, w, h);

    // 影 → キャラ → 弾 → エフェクト の順で重ねる
    for (const f of sim.fighters) this._drawShadow(f);
    const order = sim.fighters.slice().sort((p, q) => p.y - q.y);
    for (const f of order) this._drawFighter(f);
    for (const p of sim.projectiles) this._drawProjectile(p);
    for (const fx of sim.effects) this._drawEffect(fx, sim);

    if (this.debug) this._drawDebug(sim);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  _drawShadow(f) {
    const ctx = this.ctx;
    const cam = this.cam;
    // 高く飛ぶほど小さく薄くする
    const lift = Math.min(1, f.y / 190);
    const rx = (44 - lift * 16) * cam.zoom;
    const ry = rx * 0.3;
    ctx.save();
    ctx.globalAlpha = 0.4 - lift * 0.22;
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.ellipse(cam.toScreenX(f.x), cam.groundY, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  _drawFighter(f) {
    const sprite = this.sprites[f.def.id];
    if (!sprite) return;
    const cam = this.cam;
    const ctx = this.ctx;

    // 被弾直後は白く光らせる
    const flashing = f.hitstop > 0 && (f.state === STATE.HIT || f.state === STATE.GUARD_BREAK);
    if (flashing) ctx.filter = 'brightness(1.9) saturate(0.4)';

    drawFighterSprite(
      ctx,
      sprite,
      f.anim,
      cam.toScreenX(f.x),
      cam.toScreenY(f.y),
      f.facing,
      cam.zoom,
      f.def.animScale?.[f.anim.name] ?? 1
    );

    if (flashing) ctx.filter = 'none';
  }

  _drawProjectile(p) {
    const def = getProjectileDef(p.type);
    const cam = this.cam;
    const ctx = this.ctx;
    const sx = cam.toScreenX(p.x);
    const sy = cam.toScreenY(p.y);
    const r = def.radius * cam.zoom;
    // 軽い脈動
    const pulse = 1 + Math.sin(p.age * 0.4) * 0.12;

    ctx.save();
    const glow = ctx.createRadialGradient(sx, sy, 0, sx, sy, r * 2.6 * pulse);
    glow.addColorStop(0, 'rgba(255,255,255,0.95)');
    glow.addColorStop(0.35, def.color);
    glow.addColorStop(1, 'rgba(120,200,255,0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(sx, sy, r * 2.6 * pulse, 0, Math.PI * 2);
    ctx.fill();

    // 尾を引かせる
    ctx.globalAlpha = 0.5;
    ctx.strokeStyle = def.color;
    ctx.lineWidth = r * 0.8;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(sx - p.vx * 2.6 * cam.zoom, sy + p.vy * 2.6 * cam.zoom);
    ctx.stroke();
    ctx.restore();
  }

  _drawEffect(fx, sim) {
    const cam = this.cam;
    const ctx = this.ctx;
    const t = 1 - fx.life / fx.maxLife; // 0 → 1

    if (fx.type === 'beam') {
      this._drawBeam(fx, t);
      return;
    }

    const sx = cam.toScreenX(fx.x);
    const sy = cam.toScreenY(fx.y);

    if (fx.type === 'pop') {
      ctx.save();
      ctx.globalAlpha = 1 - t;
      ctx.strokeStyle = '#9fe8ff';
      ctx.lineWidth = 3 * cam.zoom;
      ctx.beginPath();
      ctx.arc(sx, sy, (10 + t * 34) * cam.zoom, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
      return;
    }

    const palette = {
      spark: ['#fff6c8', '#ffb545'],
      block: ['#dff1ff', '#5fa8ff'],
      break: ['#ffe8c0', '#ff5a2b'],
    }[fx.type] ?? ['#ffffff', '#ffaa44'];

    const size = (fx.type === 'break' ? 74 : 48) * cam.zoom;
    ctx.save();
    ctx.globalAlpha = 1 - t;

    // 中心の閃光
    const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, size * (0.4 + t));
    g.addColorStop(0, palette[0]);
    g.addColorStop(0.5, palette[1]);
    g.addColorStop(1, 'rgba(255,120,40,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(sx, sy, size * (0.4 + t), 0, Math.PI * 2);
    ctx.fill();

    // 放射状の破片
    const spokes = fx.type === 'break' ? 10 : 6;
    ctx.strokeStyle = palette[0];
    ctx.lineWidth = 2.5 * cam.zoom;
    ctx.lineCap = 'round';
    for (let i = 0; i < spokes; i += 1) {
      const a = (i / spokes) * Math.PI * 2 + fx.seed;
      const r0 = size * (0.3 + t * 0.7);
      const r1 = r0 + size * 0.55 * (1 - t);
      ctx.beginPath();
      ctx.moveTo(sx + Math.cos(a) * r0, sy + Math.sin(a) * r0);
      ctx.lineTo(sx + Math.cos(a) * r1, sy + Math.sin(a) * r1);
      ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * 極太照射ビーム。杖の先からステージ端まで伸ばす。
   * 原点・太さ・長さは技データ側（sim が渡してくる値）に従う。
   * ここで数値を持つと判定と光線がずれるため。
   */
  _drawBeam(fx, t) {
    const cam = this.cam;
    const ctx = this.ctx;
    const originX = fx.x + fx.facing * fx.ox;
    const originY = fx.y + fx.oy;
    const length = fx.length;

    // 撃ち始めに一気に太くなり、終わり際に細く消える
    const envelope = t < 0.12 ? t / 0.12 : t > 0.82 ? (1 - t) / 0.18 : 1;
    const halfH = fx.halfHeight * envelope * cam.zoom;
    if (halfH <= 0.5) return;

    const x0 = cam.toScreenX(originX);
    const x1 = cam.toScreenX(originX + fx.facing * length);
    const y = cam.toScreenY(originY);

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    const grad = ctx.createLinearGradient(0, y - halfH, 0, y + halfH);
    grad.addColorStop(0, 'rgba(90,200,255,0)');
    grad.addColorStop(0.28, 'rgba(120,225,255,0.75)');
    grad.addColorStop(0.5, 'rgba(255,255,255,0.98)');
    grad.addColorStop(0.72, 'rgba(120,225,255,0.75)');
    grad.addColorStop(1, 'rgba(90,200,255,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(Math.min(x0, x1), y - halfH, Math.abs(x1 - x0), halfH * 2);

    // 発射口の閃光
    const flash = ctx.createRadialGradient(x0, y, 0, x0, y, halfH * 2.2);
    flash.addColorStop(0, 'rgba(255,255,255,0.9)');
    flash.addColorStop(1, 'rgba(120,220,255,0)');
    ctx.fillStyle = flash;
    ctx.beginPath();
    ctx.arc(x0, y, halfH * 2.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  /** 判定ボックスの可視化。技データを調整するときに使う。 */
  _drawDebug(sim) {
    const ctx = this.ctx;
    const cam = this.cam;
    const rect = (box, color) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.strokeRect(
        cam.toScreenX(box.x),
        cam.toScreenY(box.y + box.h),
        box.w * cam.zoom,
        box.h * cam.zoom
      );
    };

    for (const f of sim.fighters) {
      rect(f.hurtBox(), 'rgba(90,220,120,0.9)');
      const move = f.currentMove();
      if (!move || f.state !== STATE.MOVE) continue;
      for (const hit of move.hits) {
        if (f.moveFrame < hit.start || f.moveFrame > hit.end) continue;
        rect(toWorldBox(hit.box, f.x, f.y, f.facing), 'rgba(255,80,80,0.95)');
      }
    }

    ctx.fillStyle = '#fff';
    ctx.font = '12px monospace';
    for (let i = 0; i < 2; i += 1) {
      const f = sim.fighters[i];
      ctx.fillText(
        `P${i + 1} ${f.state} move=${f.moveId ?? '-'} f=${f.moveFrame} hp=${Math.round(f.health)}`,
        12,
        cam.canvasH - 40 + i * 16
      );
    }
  }
}
