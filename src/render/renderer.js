/**
 * 試合画面の描画。
 *
 * シミュレーションの状態を読むだけで、書き換えは一切しない。
 * （描画がゲーム進行に影響しないので、フレームを落としても試合結果は変わらない）
 */
import { STAGE_WIDTH, STATE } from '../game/constants.js';
import { toWorldBox } from '../game/moves.js';
import { getProjectileDef } from '../game/projectiles.js';
import { drawFighterSprite, drawStillFrame } from './spritebank.js';
import { drawStage } from './stage.js';

/** '#rrggbb' を 'r,g,b' にする。rgba() の中で透明度だけ差し替えたいときに使う。 */
function hexToRgb(hex) {
  const v = parseInt(hex.replace('#', ''), 16);
  return `${(v >> 16) & 255},${(v >> 8) & 255},${v & 255}`;
}

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
/**
 * 跳んでいるキャラの足元から上に確保したい余白。
 * 身長ぶん跳べるようになったので、2段ジャンプまで重ねると
 * VIEW_ABOVE では頭が画面から出る。横方向と同じ考え方で、
 * 出そうなときだけ引くようにしてある（普段のズームは変わらない）。
 */
const JUMP_HEADROOM = 280;

/** キャラより先（下）に描く演出。足元に敷くもの。 */
const GROUND_EFFECTS = new Set(['magicCircle', 'bloodPool']);

/**
 * 血の色。安っぽく見える一番の原因は「明るい赤」と「加算合成で光ること」なので、
 * 暗い静脈血を基準にして、薄く伸びた部分だけ少し明るくする。
 * 合成は必ず source-over（血は光らない）。
 */
const BLOOD_DARK = [58, 5, 10];
const BLOOD_MID = [122, 11, 20];
const BLOOD_LIT = [170, 30, 34];
const bloodColor = (tone, alpha) => {
  const [a, b] = tone < 0.5 ? [BLOOD_DARK, BLOOD_MID] : [BLOOD_MID, BLOOD_LIT];
  const k = tone < 0.5 ? tone * 2 : (tone - 0.5) * 2;
  return `rgba(${Math.round(a[0] + (b[0] - a[0]) * k)}, ${Math.round(
    a[1] + (b[1] - a[1]) * k
  )}, ${Math.round(a[2] + (b[2] - a[2]) * k)}, ${alpha})`;
};

/** 血しぶきに掛ける重力（ワールド単位/ティック^2）。キャラと同じ値。 */
const BLOOD_G = 0.72;

/**
 * 描画専用の疑似乱数。血しぶきの1粒ずつの向きや速さに使う。
 * シミュレーションには一切触らないので Math.sin を使ってよい
 * （effect の seed から作るので、同じリプレイなら同じ絵になる）。
 */
const frand = (n) => {
  const s = Math.sin(n * 12.9898) * 43758.5453;
  return s - Math.floor(s);
};

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
    /**
     * 血しぶき1粒ずつの初期値。エフェクトごとに1回だけ計算して覚えておく。
     * 描画側だけの持ち物なので、シミュレーションの状態は汚さない
     * （エフェクトが消えれば WeakMap から自然に落ちる）。
     */
    this._bloodCache = new WeakMap();
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

    // 上に飛び出したときも同じように引く。地上に居るあいだは
    // needTop < VIEW_ABOVE なので、この項は効かない（普段の絵は変わらない）。
    const needTop = Math.max(a.y, b.y) + JUMP_HEADROOM;

    // 縦長画面では地面を上げて、無駄な空を減らし戦闘を中央に寄せる
    const groundFor = (zoom) => Math.min(h * GROUND_RATIO, h * 0.5 + VIEW_ABOVE * zoom * 0.45);
    const zoomFor = (groundY) =>
      Math.max(base * MIN_ZOOM_RATIO, Math.min(base, fit, groundY / needTop));

    // ズームと地面の高さは互いに依存する（引くと地面が上がり、地面が上がると
    // 上に見える範囲も減る）。一度仮決めしてから measure し直して詰める。
    // 1回で十分収束する（2回目の変化は 1px 未満）。
    cam.zoom = zoomFor(groundFor(zoomFor(h * GROUND_RATIO)));
    cam.groundY = groundFor(cam.zoom);

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

    // 影 → 地面の演出 → キャラ → 弾 → その他の演出 の順で重ねる。
    // 魔法陣は足元に敷くものなので、キャラより先に描いて下に潜らせる。
    for (const f of sim.fighters) this._drawShadow(f);
    for (const fx of sim.effects) if (GROUND_EFFECTS.has(fx.type)) this._drawEffect(fx, sim);
    const order = sim.fighters.slice().sort((p, q) => p.y - q.y);
    for (const f of order) this._drawFighter(f);
    for (const p of sim.projectiles) this._drawProjectile(p, sim);
    for (const fx of sim.effects) if (!GROUND_EFFECTS.has(fx.type)) this._drawEffect(fx, sim);

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

    // キャラ定義に guardWall があれば、ガード中だけ前に張る
    if (f.def.guardWall && (f.state === STATE.GUARD || f.state === STATE.BLOCK)) {
      this._drawGuardWall(f);
    }
  }

  /**
   * ガード中に前へ張る光の壁。魔法使いのように、腕で受けるのではなく
   * 魔力で防いでいるキャラ用。キャラ定義の guardWall で位置と大きさを決める。
   */
  _drawGuardWall(f) {
    const cam = this.cam;
    const ctx = this.ctx;
    const w = f.def.guardWall;
    const cx = cam.toScreenX(f.x + f.facing * w.x);
    const cy = cam.toScreenY(f.y + w.y);
    const halfW = (w.w / 2) * cam.zoom;
    const halfH = (w.h / 2) * cam.zoom;

    // 受けた瞬間だけ強く光る
    const impact = f.state === STATE.BLOCK ? 1 : 0;
    // ゆらぎ。stateTimer はシミュレーション側の値なのでリプレイでも同じ揺れになる
    const wave = Math.sin(f.stateTimer * 0.22) * 0.5 + 0.5;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.45 + wave * 0.15 + impact * 0.35;

    const grad = ctx.createLinearGradient(cx - halfW, 0, cx + halfW, 0);
    grad.addColorStop(0, 'rgba(90, 160, 255, 0)');
    grad.addColorStop(0.5, w.color ?? 'rgba(150, 215, 255, 0.85)');
    grad.addColorStop(1, 'rgba(90, 160, 255, 0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.ellipse(cx, cy, halfW, halfH, 0, 0, Math.PI * 2);
    ctx.fill();

    // 輪郭の線。壁として見えるように芯を 1 本入れる
    ctx.globalAlpha = 0.5 + wave * 0.2 + impact * 0.4;
    ctx.strokeStyle = w.color ?? 'rgba(200, 235, 255, 0.9)';
    ctx.lineWidth = (1.6 + impact * 1.6) * cam.zoom;
    ctx.beginPath();
    ctx.ellipse(cx, cy, halfW * 0.72, halfH * 0.94, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  _drawProjectile(p, sim) {
    const def = getProjectileDef(p.type);
    if (def.style === 'sprite') {
      this._drawSpriteProjectile(p, def, sim);
      return;
    }
    if (def.style === 'beam') {
      this._drawLaser(p, def);
      return;
    }
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

  /**
   * スプライトで描く飛び道具（女子高生の彼氏）。
   *
   * 走ってきて、相手に届く間合いに入ったらタックルの絵に変わり、
   * 出し切ったらまた走りに戻って走り抜けていく。
   *
   * **タックルは繰り返さない。** 突進のシートは 1 回ぶんの動きなので、
   * 突進に入ってからの経過フレーム（sim が数えている lungeAge）で
   * 頭から 1 回だけ再生する。相手との距離でコマを決めると、
   * 追い越したあとに距離が開いてコマが逆戻りし、2 周したように見えてしまう。
   */
  _drawSpriteProjectile(p, def, sim) {
    const sprite = this.sprites[def.sheet];
    if (!sprite) return;
    const cam = this.cam;
    const tackle = sprite.animations[def.anims.hit];
    const tackleFrame =
      p.lungeAge >= 0 && tackle
        ? Math.floor((p.lungeAge * (def.tackleFps ?? def.animFps ?? 14)) / 60)
        : -1;
    // 出し切ったら走りに戻る（そのまま走り抜けていく）
    const lunging = tackleFrame >= 0 && tackleFrame < (tackle?.frames ?? 0);

    const animName = lunging ? def.anims.hit : def.anims.run;
    const cell = sprite.animations[animName];
    if (!cell) return;
    const index = lunging
      ? tackleFrame
      : Math.floor((p.age * (def.animFps ?? 14)) / 60) % cell.frames;
    drawStillFrame(
      this.ctx,
      sprite,
      animName,
      index,
      cam.toScreenX(p.x),
      cam.toScreenY(p.y),
      cam.zoom,
      p.facing
    );
  }

  /**
   * スマホカメラのレーザー。
   *
   * 血しぶきとは逆に、**ここは加算合成が正しい**。血は光らないので
   * source-over で描いているが、レーザーは光そのものなので、
   * 背景に足し合わさらないと嘘になる。
   *
   * 実物のビームに寄せるために効いているのは次の 4 つ。
   *
   * | | やっていること | これが無いと |
   * |---|---|---|
   * | 断面を楕円の放射グラデーションに | 光を長円へ引き伸ばして減衰させる | 帯を重ねると段が見えて「板」になる |
   * | 芯を丸端の線で描く | lineCap: round の 1 本線 | 端が角ばって、切り落とした棒に見える |
   * | 芯だけ白く飛ばす | 中心の彩度を捨てる | 明るいだけの色帯になる。強い光は白飛びする |
   * | 進行方向へ伸ばして向ける | 1 フレーム進む距離ぶん尾を引き、速度の角度に回す | 止まって見える／斜めに撃っても光は水平のまま |
   */
  _drawLaser(p, def) {
    const cam = this.cam;
    const ctx = this.ctx;
    const speed = Math.hypot(p.vx, p.vy) || 1;
    // 進行方向。画面の y は世界と上下が逆なので符号を返す
    const angle = Math.atan2(-p.vy, p.vx);
    // 芯の太さ。判定の高さより細く見せる（判定は当たり方の都合で少し太い）
    const core = Math.max(1, def.box.h * 0.26 * cam.zoom);
    const head = (def.box.w / 2) * cam.zoom;
    // 尾は**発射点より後ろへは伸ばさない**。
    // 光は出た場所より手前には存在しないので、撃った直後に長い尾を描くと
    // スマホや手に光が被って、そこから出ているように見えなくなる。
    const travelled = p.age * speed * cam.zoom;
    const tail = Math.min(head + speed * 2.1 * cam.zoom, Math.max(0, travelled - head));
    // わずかな明滅。完全に一定だと CG くさくなる
    const flicker = 0.86 + 0.14 * Math.sin(p.age * 1.7);
    const rgb = hexToRgb(def.color);

    ctx.save();
    ctx.translate(cam.toScreenX(p.x), cam.toScreenY(p.y));
    ctx.rotate(angle);
    ctx.globalCompositeOperation = 'lighter';

    // 外側の光。単位円の放射グラデーションを長円へ引き伸ばすことで、
    // 縦にも横にも段の出ない減衰になる
    const halo = (rx, ry, alpha) => {
      ctx.save();
      ctx.translate((head - tail) / 2, 0);
      ctx.scale(rx, ry);
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
      g.addColorStop(0, `rgba(${rgb},0.85)`);
      g.addColorStop(0.45, `rgba(${rgb},0.3)`);
      g.addColorStop(1, `rgba(${rgb},0)`);
      ctx.globalAlpha = alpha * flicker;
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(0, 0, 1, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    };
    halo((tail + head) / 2, core * 4.2, 0.5);
    halo((tail + head) / 2, core * 1.9, 0.65);

    // 芯。丸端の線なので、端が角ばらない。強い光は白く飛ぶので色を捨てる
    const hot = ctx.createLinearGradient(-tail, 0, head, 0);
    hot.addColorStop(0, 'rgba(255,255,255,0)');
    hot.addColorStop(0.55, 'rgba(255,255,255,0.75)');
    hot.addColorStop(1, '#ffffff');
    ctx.globalAlpha = flicker;
    ctx.strokeStyle = hot;
    ctx.lineWidth = core;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-tail, 0);
    ctx.lineTo(head, 0);
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

    if (fx.type === 'slash') {
      this._drawSlash(fx, t);
      return;
    }

    if (fx.type === 'magicCircle') {
      this._drawMagicCircle(fx, t);
      return;
    }

    if (fx.type === 'blood') {
      this._drawBlood(fx, t);
      return;
    }

    if (fx.type === 'bloodPool') {
      this._drawBloodPool(fx, t);
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
   * 斬撃。刃の届く先へ弧を描いて、剣そのものより先まで刃圏があることを見せる。
   * 剣士の剣は短く（実測で前方 148）、判定はそれより先まで出ているので、
   * この弧が無いと空振りに見える。原点・長さ・太さは技データ側の値に従う。
   */
  _drawSlash(fx, t) {
    const cam = this.cam;
    const ctx = this.ctx;
    const originX = fx.x + fx.facing * fx.ox;
    const originY = fx.y + fx.oy;

    // 出た瞬間が一番濃く、すぐ薄れて消える
    const alpha = (1 - t) * (1 - t);
    if (alpha <= 0.02) return;

    const x = cam.toScreenX(originX);
    const y = cam.toScreenY(originY);
    // 出た時点でほぼ伸びきっている。判定が出ている間に短いと空振りに見えるため
    const r = fx.length * (0.86 + 0.14 * t) * cam.zoom;
    const half = fx.halfHeight * cam.zoom;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = alpha;
    ctx.translate(x, y);
    ctx.scale(fx.facing, 1);

    // 弧そのもの。太い光の帯の上に細い芯を重ねる
    for (const [w, col] of [[9, 'rgba(130, 190, 255, 0.5)'], [3.5, 'rgba(255, 255, 255, 0.95)']]) {
      ctx.beginPath();
      ctx.lineWidth = w * cam.zoom;
      ctx.lineCap = 'round';
      ctx.strokeStyle = col;
      ctx.ellipse(0, 0, r, half, 0, -Math.PI * 0.44, Math.PI * 0.44);
      ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * 溜め中に足元へ敷く魔法陣。
   *
   * 「これから撃つぞ」を相手に見せるのが仕事なので、
   * 出た瞬間に一気に開いて、あとは撃つまでずっと回り続ける。
   * 地面に置いた円に見えるよう、縦に潰した楕円で描いている。
   * 空中で撃つとそのまま宙に浮くが、それはそれで浮遊詠唱に見えるのでよしとする。
   */
  _drawMagicCircle(fx, t) {
    const cam = this.cam;
    const ctx = this.ctx;
    const cx = cam.toScreenX(fx.x + fx.facing * fx.ox);
    const cy = cam.toScreenY(fx.y + fx.oy);

    // 開く(0〜0.12) → 保つ → 撃つ直前に一瞬強く光る(0.9〜)
    const open = Math.min(1, t / 0.12);
    const flare = t > 0.88 ? (t - 0.88) / 0.12 : 0;
    const r = fx.radius * cam.zoom * (0.35 + 0.65 * open) * (1 + flare * 0.18);
    const ry = r * 0.34; // 地面に寝かせるための縦つぶし
    if (r < 1) return;

    const spin = t * 4.2 + fx.seed * 0.01;
    const alpha = (0.55 + flare * 0.45) * Math.min(1, open * 1.4);
    const INK = 'rgba(190, 130, 255,';
    const GLOW = 'rgba(150, 225, 255,';

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.translate(cx, cy);
    ctx.scale(1, 0.34); // 以降は真円で考えられる

    // 地面のにじみ
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
    g.addColorStop(0, `${GLOW}${0.16 * alpha})`);
    g.addColorStop(0.7, `${INK}${0.22 * alpha})`);
    g.addColorStop(1, 'rgba(120, 80, 255, 0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();

    ctx.lineWidth = 2 * cam.zoom;

    // 外周の二重丸
    ctx.strokeStyle = `${INK}${0.9 * alpha})`;
    for (const k of [1, 0.9]) {
      ctx.beginPath();
      ctx.arc(0, 0, r * k, 0, Math.PI * 2);
      ctx.stroke();
    }

    // 外周に刻む目盛り。これが回ると詠唱している感じが出る
    ctx.strokeStyle = `${GLOW}${0.85 * alpha})`;
    for (let i = 0; i < 24; i += 1) {
      const a = spin + (i / 24) * Math.PI * 2;
      const long = i % 3 === 0;
      const r0 = r * (long ? 0.78 : 0.85);
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * r0, Math.sin(a) * r0);
      ctx.lineTo(Math.cos(a) * r * 0.9, Math.sin(a) * r * 0.9);
      ctx.stroke();
    }

    // 内側は逆回り。二重に回すと機械仕掛けっぽく見える
    ctx.strokeStyle = `${INK}${0.8 * alpha})`;
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.52, 0, Math.PI * 2);
    ctx.stroke();
    for (let i = 0; i < 3; i += 1) {
      const a = -spin * 1.6 + (i / 3) * Math.PI * 2;
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.66, a, a + 0.9);
      ctx.stroke();
    }

    // 中心の魔法陣らしい三角形（内側の円に内接）
    ctx.strokeStyle = `${GLOW}${0.75 * alpha})`;
    ctx.beginPath();
    for (let i = 0; i <= 3; i += 1) {
      const a = -spin * 1.6 + (i / 3) * Math.PI * 2;
      const x = Math.cos(a) * r * 0.52;
      const y = Math.sin(a) * r * 0.52;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.restore();

    // 立ち上がる光。溜まってきたことを横から見て分かるようにする。
    // 四角く塗ると縁が直線で出てしまうので、放射グラデーションの楕円でぼかす。
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const colH = fx.radius * cam.zoom * (0.75 + flare * 0.9) * open;
    if (colH > 1) {
      ctx.translate(cx, cy - colH * 0.45);
      ctx.scale(1, (colH * 0.75) / (r * 0.5));
      const col = ctx.createRadialGradient(0, 0, 0, 0, 0, r * 0.5);
      col.addColorStop(0, `${INK}${0.4 * alpha})`);
      col.addColorStop(0.55, `${INK}${0.16 * alpha})`);
      col.addColorStop(1, 'rgba(150, 100, 255, 0)');
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  /**
   * 血しぶき1粒ずつの初期値を用意する（エフェクト1個につき1回だけ）。
   *
   * 見た目を作り込むうえで効いているのは次の3つ:
   *
   *  - **粒の大きさをべき分布にする**。小さい粒が大量、大きい粒はごく少数。
   *    均一な丸が並ぶと途端に嘘くさくなる。
   *  - **空気抵抗を入れる**。dv/dt = -k・v - g の解析解で飛ばしている。
   *    放物線だと全部が同じ形の弧を描いてしまうが、抵抗を入れると
   *    小さい粒はすぐ失速してその場に落ち、大きい粒だけが遠くまで届く。
   *    k は粒の大きさに反比例させてある（小さいほど失速が速い）。
   *  - **着地時刻を先に求めておく**。着地後は飛沫ではなく「床の染み」に
   *    描き替えるので、落ちた血がそのまま残る。
   *
   * 計算結果は描画側の WeakMap に持つ。エフェクト自体（＝シミュレーション側の
   * データ）には一切書き戻さないので、ロールバックしても壊れない。
   */
  _bloodParticles(fx) {
    const cached = this._bloodCache.get(fx);
    if (cached) return cached;

    const dirX = fx.facing >= 0 ? 1 : -1;
    const power = fx.power || 1;
    const count = Math.round(220 * power);
    const floorDy = -fx.y; // 原点から見た地面の高さ
    const parts = [];

    for (let i = 0; i < count; i += 1) {
      const u1 = frand(fx.seed + i * 1.37);
      const u2 = frand(fx.seed * 1.7 + i * 2.91);
      const u3 = frand(fx.seed * 2.3 + i * 4.13);
      const u4 = frand(fx.seed * 3.1 + i * 5.77);

      // 大きさはべき分布。指数を強くして、ほとんどを微細な粒にする。
      // 同じくらいの大きさの粒が並んだ瞬間に嘘くさくなるので、ここが一番効く。
      const size = (0.32 + Math.pow(u1, 4.6) * 3.1) * power;
      // 大きい粒ほど運動量があって遠くへ飛ぶ。ばらつきも持たせる
      const speed = (2.2 + Math.pow(u2, 1.6) * 13) * (0.6 + size * 0.2) * power;
      // 斬られた向きを中心に、上向き寄りの円錐で散らす
      const angle = -0.5 + u3 * 1.95;
      // 空気抵抗。小さい粒ほど大きい（＝すぐ止まる）
      const k = 0.115 / (0.32 + size * 0.4);

      const vx0 = Math.cos(angle) * speed * dirX;
      const vy0 = Math.sin(angle) * speed;

      // 着地時刻を粗く前進 → 二分法で詰める（1粒につき1回だけ）
      const yAt = (tt) =>
        ((vy0 + BLOOD_G / k) / k) * (1 - Math.exp(-k * tt)) - (BLOOD_G / k) * tt;
      let lo = 0;
      let hi = 0;
      for (let s = 2; s <= 240; s += 2) {
        if (yAt(s) <= floorDy) { hi = s; break; }
        lo = s;
        hi = s;
      }
      for (let b = 0; b < 18; b += 1) {
        const mid = (lo + hi) / 2;
        if (yAt(mid) <= floorDy) hi = mid;
        else lo = mid;
      }
      const tLand = hi;
      const lx = (vx0 / k) * (1 - Math.exp(-k * tLand));

      parts.push({
        vx0, vy0, k, size, tLand, lx,
        // 色は暗い側へ寄せる。明るい赤が多いと一気に安っぽくなる
        tone: u4 * u4,
        // 床の染みの形（着地の勢いで伸びる向きと長さ）
        splatStretch: 1 + Math.min(1.9, Math.abs(vx0) * 0.18),
        splatSeed: u3,
        /**
         * 着地点の奥行きのばらつき（画面では上下方向のずれ）。
         * 横から見た2Dなので、これが無いと全部が地面の線上にぴったり並び、
         * 隣どうしが繋がって一本の赤い帯になってしまう。
         */
        splatDy: (u2 - 0.5) * 30,
      });
    }

    this._bloodCache.set(fx, parts);
    return parts;
  }

  /**
   * 血しぶき。決着（コンボが途切れて崩れ落ちる瞬間）だけに出る。
   *
   * 層は 4 つ:
   *   1. 噴出（動脈血の筋）— 出た直後だけ、根元から伸びて途中で粒に分かれる
   *   2. 飛沫（空中）— 空気抵抗つきの弾道。速い粒は進行方向に伸びて見える
   *   3. 染み（着地後）— 落ちた場所に残る。進行方向へ伸びた楕円＋衛星滴
   *   4. 霧（エアロゾル）— 出た瞬間の細かい霧。すぐ消える
   *
   * 加算合成は使わない。血は光らないので、光らせた時点で嘘になる。
   */
  _drawBlood(fx, t) {
    const cam = this.cam;
    const ctx = this.ctx;
    const z = cam.zoom;
    const age = t * fx.maxLife; // ティック
    const power = fx.power || 1;
    const dirX = fx.facing >= 0 ? 1 : -1;
    const ox = cam.toScreenX(fx.x);
    const oy = cam.toScreenY(fx.y);
    // 最後のほうだけ薄れる。飛んでいる間はしっかり残す
    const globalFade = t > 0.82 ? 1 - (t - 0.82) / 0.18 : 1;

    ctx.save();
    ctx.globalCompositeOperation = 'source-over';

    // ── 4. 霧。傷口まわりに一瞬だけ出る細かいエアロゾル ──────────
    if (age < 14) {
      const k = 1 - age / 14;
      const r = (16 + age * 3.4) * power * z;
      const g = ctx.createRadialGradient(ox, oy, 0, ox, oy, r);
      g.addColorStop(0, `rgba(96, 8, 14, ${0.5 * k})`);
      g.addColorStop(0.6, `rgba(74, 6, 11, ${0.22 * k})`);
      g.addColorStop(1, 'rgba(60, 4, 9, 0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(ox, oy, r, 0, Math.PI * 2);
      ctx.fill();
    }

    // ── 1. 噴出。根元は繋がった筋、先へ行くほど粒に分かれる ──────
    if (age < 20) {
      const fade = 1 - age / 20;
      const grow = Math.min(1, age / 5);
      const jetLen = 132 * power * grow;
      const jetA = 0.52; // やや上向き
      const segs = 18;
      for (let i = 0; i < segs; i += 1) {
        const s = i / (segs - 1);
        // 先へ行くほど間引く＝ちぎれて粒になる
        if (s > 0.45 && frand(fx.seed + i * 9.13) > 1.25 - s) continue;
        const wob = Math.sin(s * 7 + fx.seed * 0.1) * 5 * s;
        const px = ox + dirX * Math.cos(jetA) * jetLen * s * z;
        const py = oy - (Math.sin(jetA) * jetLen * s - 52 * s * s - wob) * z;
        const r = (7.5 * power * (1 - s * 0.72) + 0.6) * z;
        ctx.fillStyle = bloodColor(0.18 + s * 0.3, fade * 0.95 * globalFade);
        ctx.beginPath();
        ctx.ellipse(px, py, r * 1.25, r, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // ── 2 / 3. 飛沫と染み ────────────────────────────────────────
    for (const p of this._bloodParticles(fx)) {
      if (age >= p.tLand) {
        // ---- 床の染み。着地からの経過で少しだけ広がって留まる ----
        const since = age - p.tLand;
        const spread = Math.min(1, since / 9);
        const sx = ox + p.lx * z;
        const sy = cam.toScreenY(0) + p.splatDy * 0.34 * z;
        const rx = p.size * (0.9 + spread * 0.7) * p.splatStretch * z;
        const ry = p.size * (0.42 + spread * 0.3) * z;
        if (rx < 0.3) continue;
        ctx.fillStyle = bloodColor(p.tone * 0.35, 0.8 * globalFade);
        ctx.beginPath();
        ctx.ellipse(sx, sy, rx, ry, 0, 0, Math.PI * 2);
        ctx.fill();
        // 勢いよく落ちた大粒は、周りに小さな衛星滴を飛ばす
        if (p.size > 2 && spread > 0.25) {
          for (let s = 0; s < 3; s += 1) {
            const a = p.splatSeed * 6.28 + s * 2.1;
            const d = rx * (1.25 + s * 0.42);
            ctx.beginPath();
            ctx.ellipse(
              sx + Math.cos(a) * d * dirX,
              sy + Math.sin(a) * ry * 0.9,
              p.size * 0.3 * z,
              p.size * 0.22 * z,
              0, 0, Math.PI * 2
            );
            ctx.fill();
          }
        }
        continue;
      }

      // ---- 空中。空気抵抗つきの弾道 ----
      const e = Math.exp(-p.k * age);
      const dx = (p.vx0 / p.k) * (1 - e);
      const dy = ((p.vy0 + BLOOD_G / p.k) / p.k) * (1 - e) - (BLOOD_G / p.k) * age;
      const vx = p.vx0 * e;
      const vy = (p.vy0 + BLOOD_G / p.k) * e - BLOOD_G / p.k;
      const px = ox + dx * z;
      const py = oy - dy * z;

      // 速い粒は進行方向へ伸びて見える（実際の変形＋動きのブレ）
      const sp = Math.sqrt(vx * vx + vy * vy);
      const stretch = 1 + Math.min(2, sp * 0.17);
      const rr = p.size * z;
      if (rr < 0.25) continue;

      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(Math.atan2(-vy, vx));
      ctx.fillStyle = bloodColor(p.tone, 0.94 * globalFade);
      ctx.beginPath();
      ctx.ellipse(0, 0, rr * stretch, rr, 0, 0, Math.PI * 2);
      ctx.fill();
      // 大粒だけ、濡れて見えるように小さなハイライトを載せる
      if (p.size > 2) {
        ctx.fillStyle = `rgba(214, 96, 96, ${0.3 * globalFade})`;
        ctx.beginPath();
        ctx.ellipse(-rr * stretch * 0.2, -rr * 0.3, rr * 0.3, rr * 0.22, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
    ctx.restore();
  }

  /**
   * 足元に広がる血溜まり。倒れたことを一番強く伝える層なので、
   * 少し遅れて滲み出し、じわじわ広がって最後まで残る。
   * 真円だと嘘くさいので、seed から決まる小さな楕円を重ねて形を崩している。
   */
  _drawBloodPool(fx, t) {
    const cam = this.cam;
    const ctx = this.ctx;
    const z = cam.zoom;
    if (t < 0.16) return;

    // 広がりは頭打ちする曲線で。最後にほんの少しだけ薄れる
    const grow = Math.min(1, Math.sqrt((t - 0.16) / 0.55));
    const fade = t > 0.9 ? 1 - (t - 0.9) / 0.1 : 1;
    const cx = cam.toScreenX(fx.x);
    const cy = cam.toScreenY(0);
    const dirX = fx.facing >= 0 ? 1 : -1;
    const R = 34 * grow * z * (fx.power || 1);
    if (R < 1) return;

    ctx.save();
    ctx.globalCompositeOperation = 'source-over';

    // 本体 ＋ 縁を崩すための重ね塗り。ずらし幅を抑えないと
    // 溜まりではなく横一文字の筋に見えてしまう
    ctx.fillStyle = bloodColor(0.05, 0.9 * fade);
    for (let i = 0; i < 7; i += 1) {
      const a = frand(fx.seed + i * 3.7) * Math.PI * 2;
      const d = i === 0 ? 0 : R * (0.1 + frand(fx.seed + i * 8.1) * 0.32);
      const rx = R * (i === 0 ? 1 : 0.4 + frand(fx.seed + i * 5.3) * 0.36);
      ctx.beginPath();
      ctx.ellipse(
        cx + Math.cos(a) * d * dirX,
        cy + Math.sin(a) * d * 0.34,
        rx,
        rx * 0.34,
        0, 0, Math.PI * 2
      );
      ctx.fill();
    }

    // 濡れた反射。上側にだけ薄く入れると液面に見える
    const sheen = ctx.createLinearGradient(0, cy - R * 0.34, 0, cy + R * 0.34);
    sheen.addColorStop(0, `rgba(186, 72, 72, ${0.14 * fade})`);
    sheen.addColorStop(0.5, 'rgba(150, 40, 40, 0)');
    ctx.fillStyle = sheen;
    ctx.beginPath();
    ctx.ellipse(cx, cy - R * 0.06, R * 0.72, R * 0.2, 0, 0, Math.PI * 2);
    ctx.fill();
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
