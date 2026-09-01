/**
 * 試合画面の描画。
 *
 * シミュレーションの状態を読むだけで、書き換えは一切しない。
 * （描画がゲーム進行に影響しないので、フレームを落としても試合結果は変わらない）
 */
import { STAGE_WIDTH, STATE } from '../game/constants.js';
import { PHASE } from '../game/sim.js';
import { CHARACTERS } from '../game/characters/index.js';
import { toWorldBox } from '../game/moves.js';
import { getProjectileDef } from '../game/projectiles.js';
import { drawFighterSprite, drawStillFrame } from './spritebank.js';
import { drawStage } from './stage.js';
import { SparkleField } from './sparkles.js';
import { buildBeamGlow } from './beamglow.js';

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
 * 竜巻の色（`Renderer._drawTornado`）。'r,g,b' 形式で、透明度だけ使う側で足す。
 *
 * 気象の竜巻（灰色の土埃）ではなく、**魔力の渦**として描くための紫。
 * 忍者のテーマ色 #9d7bd8 を基準に、
 *
 *   もや／覆い ＝ 濃い紫（暗く沈める。**ここが体を隠す層**）
 *   帯／筋     ＝ 明るい藤色（加算合成で光らせる。渦の模様そのもの）
 *   粒         ＝ ほぼ白の藤色（いちばん明るい点）
 *   影         ＝ 地の色より暗い紫（明るい線ばかりだと紙吹雪に見える）
 *
 * と役割ごとに離してある。**明るさの段が近いと、重ねても模様が出ない。**
 */
const TORNADO = {
  hazeOuter: '110, 84, 186',
  hazeMid: '84, 62, 156',
  hazeCore: '62, 44, 122',
  veilOuter: '104, 78, 178',
  veilMid: '84, 60, 150',
  veilCore: '62, 44, 120',
  band: '226, 206, 255',
  streak: '238, 230, 255',
  spark: '250, 246, 255',
  shade: '46, 30, 88',
  rim: '216, 198, 255',
  ground: '150, 120, 226',
};

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
    /**
     * スラスターの粒。キャラ定義に `thruster` があるキャラだけが撒く。
     * 描画側だけの持ち物で、シミュレーションには載せていない（sparkles.js 参照）。
     */
    this.sparkles = new SparkleField();
    /**
     * ビームの発光レイヤー（キャラ定義に `beamGlow` があるキャラだけ）。
     *
     * アトラスから焼くのに 40ms ほど掛かるので、**読み込みが済んだこの時点で**
     * 作っておく。最初に描くときに焼くと、ラウンドの頭で 1 フレーム落ちる。
     */
    this._beamGlow = new Map();
    for (const [id, sprite] of Object.entries(sprites)) {
      const bg = CHARACTERS[id]?.beamGlow;
      if (bg) this._beamGlow.set(sprite, buildBeamGlow(sprite, bg));
    }
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
    // 演出の位相に使う。シミュレーション側の値なので、リプレイでも同じ絵になる
    this._tick = sim.tick;

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

    // スラスターの粒。ラウンドの頭で撒き直す（前のラウンドの残りを持ち越さない）
    if (sim.phase === PHASE.INTRO) this.sparkles.clear();
    for (const f of sim.fighters) this.sparkles.emit(f);
    this.sparkles.step();

    // 影 → 地面の演出 → 粒 → キャラ → 弾 → その他の演出 の順で重ねる。
    // 魔法陣は足元に敷くものなので、キャラより先に描いて下に潜らせる。
    for (const f of sim.fighters) this._drawShadow(f);
    for (const fx of sim.effects) if (GROUND_EFFECTS.has(fx.type)) this._drawEffect(fx, sim);
    // 排気の粒はキャラより先。後ろへ流れるものなので、体に隠れる側が正しい
    this.sparkles.draw(ctx, cam, false);
    // 低い方から重ねる。ただし掴まれている側は必ず最後に（＝手前に）描く。
    // 吸血は相手に顔を埋めて吸う画なので、掴んだ淫魔の顔は相手の陰に
    // 入るのが正しい。掴まれた相手は宙に浮くため y 順でもたいてい手前に
    // 来るが、保持位置の高さに依存させたくないので明示的に並べている。
    const order = sim.fighters
      .slice()
      .sort((p, q) => (p.isGrabbed ? 1 : 0) - (q.isGrabbed ? 1 : 0) || p.y - q.y);
    for (const f of order) this._drawFighter(f);
    // 常時漏れる粒はキャラより後。噴射口が翼の分岐点にあるので、
    // 奥に描くと翼の陰に入って一粒も見えない
    this.sparkles.draw(ctx, cam, true);
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
    // 消えている間は影も消す。姿だけ消して影が残ると、
    // そこに居ることが影で丸分かりになる
    ctx.globalAlpha = (0.4 - lift * 0.22) * this._veil(f);
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.ellipse(cam.toScreenX(f.x), cam.groundY, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  /**
   * 姿の濃さ（1 = そのまま、0 = 完全に見えない）。
   * 煙玉で消えている間だけ 1 を下回る。忍者は 0 ＝ 本当に何も残らない
   * （キャラ定義の vanishAlpha）。
   */
  _veil(f) {
    if (!f.isVanished) return 1;
    return f.def.vanishAlpha ?? 0.13;
  }

  /**
   * 竜巻の渦の強さ。技データの vfx を、その技の進み具合で補間する。
   * 立ち上がりが 3 つの技に分かれていても、遊ぶ側からは
   * 1 本の渦が育っていくように見える。
   */
  _tornadoPower(f) {
    if (f.state !== STATE.MOVE) return 0;
    const vfx = f.currentMove()?.vfx;
    if (vfx?.type !== 'tornado') return 0;
    const t = Math.min(1, Math.max(0, f.moveFrame / Math.max(1, f.currentMove().total)));
    return vfx.power + ((vfx.powerTo ?? vfx.power) - vfx.power) * t;
  }

  _drawFighter(f) {
    const sprite = this.sprites[f.def.id];
    if (!sprite) return;
    const cam = this.cam;
    const ctx = this.ctx;

    // 煙玉で消えている間。濃さ 0 なら本体も渦も何ひとつ描かない
    // （消えている間は技を出せないので、渦だけが残ることはない）
    const veil = this._veil(f);
    if (veil <= 0) return;

    // 竜巻の渦。キャラを包むものなので、奥側を先に・手前側を後に描く
    const twist = this._tornadoPower(f);
    if (twist > 0.02) this._drawTornado(f, twist, false);

    // 半透明で消すキャラ用。ここから下の描画を全部薄くする
    if (veil < 1) {
      ctx.save();
      ctx.globalAlpha = veil;
    }

    // 被弾直後は白く光らせる
    const flashing = f.hitstop > 0 && (f.state === STATE.HIT || f.state === STATE.GUARD_BREAK);

    // animFlip に載っているアニメだけ左右を裏返す（素材が逆向きに描かれている場合）
    const facing = f.def.animFlip?.[f.anim.name] ? -f.facing : f.facing;

    const sx = cam.toScreenX(f.x);
    const sy = cam.toScreenY(f.y);
    const scale = f.def.animScale?.[f.anim.name] ?? 1;
    // ビームの発光層。本体と同じ位置・同じ大きさで、読み出す画像だけが違う（beamglow.js）
    const bg = f.def.beamGlow;
    const layer = bg && this._beamGlow.get(sprite);

    // 刃の裏当て。**本体より先に**描くのが肝で、素材の刃には半透明のコマが
    // あるので（実測で下位 1/4 が alpha 152）、先に不透明な光を敷いておかないと
    // 透けた先に背景が出る。加算合成では背景を隠せないので、ここは source-over。
    // 敷くほうがぼけていても、上に本物の刃が乗るので輪郭は本体が決める
    if (layer && bg.backing > 0) {
      ctx.save();
      ctx.globalAlpha = bg.backing;
      drawFighterSprite(ctx, sprite, f.anim, sx, sy, facing, cam.zoom, scale, layer);
      ctx.restore();
    }

    if (flashing) ctx.filter = 'brightness(1.9) saturate(0.4)';
    drawFighterSprite(ctx, sprite, f.anim, sx, sy, facing, cam.zoom, scale);
    if (flashing) ctx.filter = 'none';

    // 仕上げの加算。**添えるだけ**。ここを強くすると刃が白飛びして色が飛ぶ
    if (layer && bg.alpha > 0) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = bg.alpha;
      drawFighterSprite(ctx, sprite, f.anim, sx, sy, facing, cam.zoom, scale, layer);
      ctx.restore();
    }

    // キャラ定義に guardWall があれば、ガード中だけ前に張る
    if (f.def.guardWall && (f.state === STATE.GUARD || f.state === STATE.BLOCK)) {
      this._drawGuardWall(f);
    }

    // 結界。張っている間だけ体を包む（巫女のスキル）
    if (f.isWarding) this._drawWard(f);

    if (veil < 1) ctx.restore();

    if (twist > 0.02) this._drawTornado(f, twist, true);
  }

  /**
   * 竜巻。忍者の空中スキルが回っている間だけ出る。
   *
   * 演出そのものは `sim.effects` に載せていない。技を出している間ずっと
   * 続くものなので、寿命を持たせると技が中断されたとき（着地で打ち切られる）に
   * 渦だけが残ってしまう。**技データを直接読んで描く**ことで、
   * 技が終われば必ず消える。
   *
   * ── どう見せたいか ──────────────────────────────────────────
   * 気象の竜巻（土埃の柱）ではなく、**魔力の渦**として描く。
   * 色は忍者のテーマ色に寄せた紫（`TORNADO`）で、渦に巻き付く
   * **太い帯**が模様としてはっきり読めることを最優先にしてある。
   *
   * 光らせるのは帯と粒だけで、体を隠す層は普通に重ねる。
   * **加算合成は下を明るくするだけで、何も隠せない**ので、
   * 覆いまで光らせると「明るいのに向こうが透けて見える」ことになる。
   *
   * ── 濃さ ────────────────────────────────────────────────────
   * **最高速では本人が見えなくなる。** ただし飲み込むのは回り切ってからで、
   * 立ち上がりの 1 秒はキャラが見えている（`hide` の項を参照）。
   *
   * ── 「安っぽい渦」にしないために効いていること ──────────────
   * | | やっていること | これが無いと |
   * |---|---|---|
   * | 芯を蛇行させる | 高さごとに中心を横へずらし、周期の違う波で揺らす | まっすぐな円錐＝置物に見える |
   * | 輪ではなく帯を巻く | 高さと角度が同時に進む螺旋を引く（太い帯 11 本＋細い筋 40〜60 本） | 輪が縦に積まれて「輪投げ」に見える |
   * | 帯を下から上へ流す | 各帯の開始高さを時間で送る | 回ってはいるが吸い上げていない |
   * | 縁を毛羽立たせる | 半径に高さ方向の波を乗せ、層ごとに位相を変える | 輪郭が平行に並んで等高線に見える |
   * | 明暗を混ぜる | 3 本に 1 本を地の色より暗く引く（暗い筋だけ加算にしない） | 光った線の集合＝紙吹雪に見える |
   * | 粒を線で描く | 進む向きの後ろへ伸ばした短い線にする | 粒だけ止まって見え、渦から浮く |
   * | 奥半分と手前半分を分けて描く | sin>0 の側だけを手前パスで描く | 前後関係が出ず、板が貼ってあるように見える |
   * | 地面が近いと風が散る | 足元の高さで濃さを決める | 地面すれすれでも空中と同じ絵になる |
   *
   * @param {boolean} front true でキャラより手前側（sin>0）の半分だけを描く
   */
  _drawTornado(f, power, front) {
    const cam = this.cam;
    const ctx = this.ctx;
    const z = cam.zoom;
    const bx = cam.toScreenX(f.x);
    const gy = cam.toScreenY(f.y);
    const now = this._tick;
    // 回る速さは渦の強さそのもの。立ち上がりの遅さが見て取れる
    const spin = now * (0.05 + 0.28 * power);
    const height = 285 * power;

    /**
     * 高さ t(0..1) での芯の横位置。**まっすぐ立てない。**
     * 周期の違う波を 2 本足しているのは、1 本だと行って戻るだけの
     * 往復になり、揺れの周期が読めてしまうため。
     */
    const axis = (t) =>
      bx +
      (Math.sin(now * 0.038 + t * 2.6) * 26 + Math.sin(now * 0.021 + t * 5.1) * 11) *
        t * power * z;
    /**
     * 高さ t での半径。上ほど開かせると円柱ではなく漏斗になる。
     *
     * 指数を 2 ではなく 1.5 にしてあるのは、二乗だと上端だけが急に開いて
     * ワイングラスの形になるため。上端の直径（220 前後）は
     * **判定の横幅 240 に合わせてある**。ここを広げると、
     * 見えている渦の外側が当たらない範囲になって嘘になる。
     *
     * 揺らぎを高さ方向にも波として持たせて、縁を毛羽立たせる。
     */
    const rad = (t) =>
      (16 + (24 + 86 * t ** 1.5) * power) *
      // 足元へ向けてすぼめる。ここを効かせないと底が平らに閉じて、
      // 漏斗ではなく「筒を切った断面」に見える
      Math.min(1, 0.22 + t * 6.5) *
      (1 + Math.sin(now * 0.10 + t * 8.4) * 0.09 + Math.sin(now * 0.07 - t * 15.3) * 0.05) * z;
    /** 高さ t の画面 Y。 */
    const yAt = (t) => gy - height * t * z;
    /**
     * 輪郭の左右。**左右で違う揺れ方をさせる**のが肝で、
     * 半径をそのまま左右に振ると、どれだけ揺らしても
     * 左右対称の＝定規で引いた輪郭のままになる。
     * 第 2 引数は位相で、層ごとに変えると輪郭が平行に並ばない。
     */
    const edge = (t, side) =>
      rad(t) * (1 + Math.sin(now * 0.075 + t * 11.2 + side * 3.1) * 0.08
        + Math.sin(now * 0.13 - t * 6.4 + side * 1.7) * 0.05);

    /**
     * 塗りの形をどこまで伸ばすか（t の上限）。
     *
     * **1 で止めてはいけない。** 上下の縁は左右の輪郭が水平に繋がって
     * 閉じるので、そこにまだ濃さが残っていると、渦の頭を横切る直線が出る。
     * 濃さが 0 になる高さより上まで形を伸ばしておけば、
     * 閉じる線は完全に透明なところで引かれて見えない。
     */
    const TOP = 1.35;
    /**
     * 漏斗の塗り。濃さは **t（渦の高さ）で指定して** ここで
     * グラデーションの位置へ直す。TOP を変えても濃さの配りが動かない。
     *
     * @param {[number, number][]} stops [高さ t, 濃さ] の並び
     */
    const funnelFill = (spread, phase, tint, stops, SEG = 40) => {
      const g = ctx.createLinearGradient(0, gy, 0, yAt(TOP));
      for (const [t, a] of stops) g.addColorStop(t / TOP, `rgba(${tint}, ${a})`);
      ctx.fillStyle = g;
      ctx.beginPath();
      for (let i = 0; i <= SEG; i += 1) {
        const t = (i / SEG) * TOP;
        const px = axis(t) - edge(t, phase) * spread;
        if (i === 0) ctx.moveTo(px, yAt(t));
        else ctx.lineTo(px, yAt(t));
      }
      for (let i = SEG; i >= 0; i -= 1) {
        const t = (i / SEG) * TOP;
        ctx.lineTo(axis(t) + edge(t, phase + 1) * spread, yAt(t));
      }
      ctx.closePath();
      ctx.fill();
    };

    /**
     * 手前をどれだけ塗り潰すか。**回り切ったときだけ 1 になる。**
     *
     * 立ち上がりの 1 秒（power 0.12〜0.72）は判定をひとつも持たない
     * 無防備な時間で、「これから来る」と相手に見せるためにある。
     * そこで姿まで隠すと、相手からは何をしているのか分からないまま
     * 当たらない技になり、見せるための 1 秒が意味を失う。
     * **隠すのは最高速に届いてから。**
     *
     * 0.55 までは 0 で、そこから 1.6 乗で立ち上がる。
     * 立ち上がり 3 段目（0.72→1）の途中から一気に飲み込まれていく。
     */
    const hide = Math.max(0, (power - 0.55) / 0.45) ** 1.6;

    /**
     * 点の並びを線でなぞる（細い筋用）。点は [x, y, 太さ, 濃さ]。
     * 線分ごとに太さと濃さを変えられるので、1 本の中で溶けていく筋が描ける。
     */
    const polyline = (run, tint) => {
      for (let i = 1; i < run.length; i += 1) {
        ctx.strokeStyle = `rgba(${tint}, ${run[i][3]})`;
        ctx.lineWidth = run[i][2];
        ctx.beginPath();
        ctx.moveTo(run[i - 1][0], run[i - 1][1]);
        ctx.lineTo(run[i][0], run[i][1]);
        ctx.stroke();
      }
    };

    /** 中心線の点 i から、線の向きに直交する方向へ太さのぶんだけ振った座標。 */
    const offset = (run, i, wk, side) => {
      const p = run[Math.max(0, i - 1)];
      const q = run[Math.min(run.length - 1, i + 1)];
      const tx = q[0] - p[0];
      const ty = q[1] - p[1];
      const len = Math.hypot(tx, ty) || 1;
      const half = run[i][2] * wk * 0.5 * side;
      return [run[i][0] - (ty / len) * half, run[i][1] + (tx / len) * half];
    };

    /**
     * 点の並びを**面**で描く（太い帯用）。
     *
     * 太い帯を線分の連なりで引いてはいけない。太さが線分の長さより
     * 大きくなるので、線分ごとの丸い端が重なって**数珠**に見える
     * （分割を細かくするほどひどくなる）。中心線の左右へ太さのぶんだけ
     * 振った多角形として塗れば、継ぎ目そのものが無くなる。
     *
     * 太く薄い下敷きと細く濃い芯の 2 枚を重ねるのは、1 枚だと縁が立って
     * テープを貼ったように見えるため。
     */
    const ribbon = (run, tint) => {
      const lead = run[run.length >> 1][3];
      for (const [wk, ak] of [[1.8, 0.4], [0.8, 1]]) {
        ctx.fillStyle = `rgba(${tint}, ${lead * ak})`;
        ctx.beginPath();
        for (let i = 0; i < run.length; i += 1) {
          const [x, y] = offset(run, i, wk, 1);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        for (let i = run.length - 1; i >= 0; i -= 1) {
          const [x, y] = offset(run, i, wk, -1);
          ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.fill();
      }
    };

    /**
     * 渦に巻き付く帯を 1 種類ぶん引く。
     *
     * 太い帯（渦そのものの模様）も細い筋（風）も、**同じ螺旋の式**から作る。
     * 違うのは太さ・長さ・本数・ねじれの強さだけで、別々に書くと
     * 2 つの渦が別々に回っているように見えてしまう。
     *
     * 1 本は手前側と奥側をまたぐので、**見えている側だけを取り出して
     * 切れ目ごとに描く**（`run` が 1 つながりぶん）。
     *
     * @param {object} o 帯の性格
     * @param {number} o.count   本数
     * @param {number} o.seed    乱数の系列（種類ごとに変える）
     * @param {number} o.span    1 本が受け持つ高さ
     * @param {number} o.width   太さ
     * @param {number} o.lead    濃さ
     * @param {number} o.twist   上へ行くほど遅れて回る強さ。
     *                           小さいと横倒しになり、湯気と区別が付かない
     * @param {number} o.climb   下から上へ流れる速さ
     * @param {string} o.tint    色
     * @param {number} o.dark    何本に 1 本を暗い帯にするか（0 で混ぜない）
     * @param {number} o.steps   1 本を何点でなぞるか
     * @param {boolean} o.ribbon true なら面で描く（太い帯）
     */
    const wrap = (o) => {
      for (let i = 0; i < o.count; i += 1) {
        const s = o.seed + i * 3.77;
        const base = (frand(s) + now * o.climb * (0.6 + frand(s + 1))) % 1;
        const span = o.span * (0.6 + frand(s + 2) * 0.8);
        const phase = frand(s + 3) * Math.PI * 2;
        const rate = 0.9 + frand(s + 4) * 0.55;
        // 暗い帯は加算にしない。加算合成では暗い色を足しても何も暗くならない
        const dark = o.dark > 0 && i % o.dark === 0;
        ctx.globalCompositeOperation = dark ? 'source-over' : 'lighter';
        const tint = dark ? TORNADO.shade : o.tint;
        const lead = o.lead * (0.7 + frand(s + 5) * 0.6) * (dark ? 1.15 : 1);
        const wide = o.width * (0.6 + frand(s + 6) * 0.8) * z;

        let run = [];
        const flush = () => {
          if (run.length > 1) (o.ribbon ? ribbon : polyline)(run, tint);
          run = [];
        };
        for (let k = 0; k <= o.steps; k += 1) {
          const kk = k / o.steps;
          const t = base + span * kk;
          if (t > 1) break;
          const a = phase + spin * rate - t * o.twist;
          if (Math.sin(a) > 0 !== front) {
            flush();
            continue;
          }
          // 帯の真ん中がいちばん濃く太く、両端は空気に溶ける。
          // 上ほど薄くするのは、渦が高いところでほどけるため。
          // ここを効かせないと、もやが抜けた上端で線だけが黒地に浮いて
          // 「針金」に見える
          const taper = Math.sin(kk * Math.PI);
          const fade = 1 - t * 0.82;
          const rr = rad(t);
          run.push([
            axis(t) + Math.cos(a) * rr,
            yAt(t) + Math.sin(a) * rr * 0.3,
            Math.max(0.4, wide * (0.25 + taper * 0.75) * fade),
            lead * taper * fade,
          ]);
        }
        flush();
      }
      ctx.globalCompositeOperation = 'source-over';
    };

    ctx.save();
    ctx.lineCap = 'round';

    // ── 本体のもや（奥側）──────────────────────────────────────
    // 広さの違う層を重ねると、外へ行くほど薄い「魔力の壁」になる
    if (!front && power > 0.2) {
      for (const [spread, tint, a, phase] of [
        [1.30, TORNADO.hazeOuter, 0.10, 0],
        [0.94, TORNADO.hazeMid, 0.15, 6],
        [0.58, TORNADO.hazeCore, 0.19, 12],
      ]) {
        // いちばん濃いのは**漏斗の腹**。足元を濃くすると層が細い先端で
        // 重なって溜まり、渦ではなく懐中電灯の光に見える。
        // 上は 1 を越えたところで抜く。いちばん広いところが濃いままだと
        // 輪郭が水平に伸びてキノコの傘に見える
        funnelFill(spread, phase, tint, [
          [0, a * 0.5 * power], [0.4, a * power], [0.8, a * 0.28 * power], [1.06, 0],
        ]);
      }
    }

    /**
     * ── 手前を覆う渦（最高速だけ）────────────────────────────
     *
     * 覆いは**漏斗の形をした層 3 枚 ＋ にじんだ塊**で作る。
     *
     * 層だけで濃さを稼ごうとすると、同じ形の輪郭が何本も揃って見えて
     * 切り絵を貼ったようになる。逆に塊だけにすると境目は消えるが、
     * 漏斗の輪郭まで溶けて、渦ではなく湯気の塊になる。
     * **形は層が持ち、境目は塊が壊す。**
     *
     * 塊は渦の中を昇り、体の高さ（t ≦ 0.86）から出ないようにしてある。
     * 上まで散らすと、いちばん半径の大きいところに大きな塊が溜まって、
     * 渦の頭に雲が乗っているように見える。
     */
    if (front && hide > 0.01) {
      for (const [spread, tint, a, phase] of [
        [1.02, TORNADO.veilOuter, 0.62 * hide, 2],
        [0.64, TORNADO.veilMid, 0.60 * hide, 8],
        [0.36, TORNADO.veilCore, 0.55 * hide, 14],
      ]) {
        // 手前は**体の高さいっぱい**（頭 ＝ t 0.74 あたりまで）を濃くする。
        // 腹だけ濃いと、隠したいはずの足と頭だけが渦から出て見えてしまう
        funnelFill(spread, phase, tint, [
          [0, a * 0.95], [0.5, a], [0.78, a * 0.85], [1.1, 0],
        ], 34);
      }

      const BLOBS = 24;
      for (let i = 0; i < BLOBS; i += 1) {
        const s = i * 4.13;
        const t = ((frand(s) + now * (0.0035 + frand(s + 1) * 0.006)) % 1) * 0.86;
        const a = frand(s + 2) * Math.PI * 2 + spin * (0.75 + frand(s + 3) * 0.6);
        const rr = rad(t);
        const px = axis(t) + Math.cos(a) * rr * 0.3;
        const py = yAt(t) + Math.sin(a) * rr * 0.12;
        const R = rr * (0.4 + frand(s + 4) * 0.34);
        const alpha = hide * (0.24 + frand(s + 5) * 0.18);
        const g = ctx.createRadialGradient(px, py, 0, px, py, R);
        g.addColorStop(0, `rgba(${TORNADO.veilMid}, ${alpha})`);
        g.addColorStop(0.5, `rgba(${TORNADO.veilCore}, ${alpha * 0.66})`);
        g.addColorStop(1, `rgba(${TORNADO.veilCore}, 0)`);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.ellipse(px, py, R, R * 0.82, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // ── 渦を巻く帯 ─────────────────────────────────────────────
    // 太い帯が渦の模様そのもの。ねじれを弱めにして 1 本を長く取り、
    // 「巻き付いている」と読めるようにする
    wrap({
      count: 11, seed: 101, span: 0.42, width: 14, lead: 0.5 * power,
      twist: 3.4, climb: 0.005, tint: TORNADO.band, dark: 0, steps: 16, ribbon: true,
    });
    // 細い筋は風。数を多く・1 本を短く・強くねじる。
    // 最高速では手前が濃く塗り潰されるので、その上を流れる筋も濃くしないと埋もれる
    wrap({
      count: Math.round(40 * (1 + hide * 0.5)), seed: 7, span: 0.2, width: 1.8,
      lead: 0.34 * power * (1 + hide), twist: 7, climb: 0.007,
      tint: TORNADO.streak, dark: 3, steps: 10, ribbon: false,
    });

    // ── 縁の光 ─────────────────────────────────────────────────
    // 輪郭を 1 本なぞると、もやの塊だったものが**形のあるもの**になる。
    // 手前のパスで引くのは、最高速では覆いが奥の縁まで隠してしまうため。
    //
    // **左右を別々に、上端は閉じずに引く。** 閉じたパスをそのまま
    // なぞると、上端を横切る 1 本の直線が出て、切り口が見えてしまう。
    // 上へ向かって薄れさせるのも同じ理由（もやは上端で抜けるので、
    // 縁だけが残ると輪郭線を描いたように見える）
    if (front && power > 0.3) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.lineWidth = 2.2 * z;
      const SEG = 24;
      for (const [dir, phase] of [[-1, 4], [1, 5]]) {
        let prev = null;
        for (let i = 0; i <= SEG; i += 1) {
          const t = i / SEG;
          const px = axis(t) + dir * edge(t, phase) * 0.98;
          const py = yAt(t);
          if (prev) {
            ctx.strokeStyle = `rgba(${TORNADO.rim}, ${0.2 * power * (1 - t) ** 1.2})`;
            ctx.beginPath();
            ctx.moveTo(prev[0], prev[1]);
            ctx.lineTo(px, py);
            ctx.stroke();
          }
          prev = [px, py];
        }
      }
      ctx.restore();
    }

    // ── 巻き込まれた粒 ─────────────────────────────────────────
    // 点ではなく**進む向きの後ろへ伸ばした短い線**で描く。
    // 丸で描くと粒だけが止まって見えて、渦から浮いてしまう
    const motes = Math.round(26 * power * (1 + hide));
    ctx.save();
    for (let i = 0; i < motes; i += 1) {
      const s = i * 7.31;
      // 位相をずらしたのこぎり波で、粒ごとに違う速さで昇らせる
      const t = (now * (0.008 + frand(s) * 0.017) + frand(s + 1)) % 1;
      const a = spin * (1.15 + frand(s + 2) * 0.8) + i * 1.97;
      if (Math.sin(a) > 0 !== front) continue;
      const rr = rad(t) * (0.72 + frand(s + 3) * 0.44);
      const px = axis(t) + Math.cos(a) * rr;
      const py = yAt(t) + Math.sin(a) * rr * 0.3;
      const len = (2 + frand(s + 4) * 7) * power * z;
      // 3 割は暗い欠片。光る粒だけだと、渦ではなく火花の輪に見える
      const grit = frand(s + 5) < 0.34;
      // 濃さは**足元でも 0 に戻す**。上へ薄れるだけにすると、
      // 半径のいちばん細い足元に全部の粒が溜まって、そこだけ光る点になる
      const solid = Math.min(1, t * 5) * (1 - t);
      ctx.globalCompositeOperation = grit ? 'source-over' : 'lighter';
      ctx.strokeStyle = grit
        ? `rgba(${TORNADO.shade}, ${solid * 0.8 * power})`
        : `rgba(${TORNADO.spark}, ${solid * 0.72 * power})`;
      ctx.lineWidth = (grit ? 1.9 : 1.2) * z;
      ctx.beginPath();
      ctx.moveTo(px, py);
      // 接線の逆向き（＝通ってきた側）へ引き、昇ったぶんだけ下へも垂らす
      ctx.lineTo(px + Math.sin(a) * len, py - Math.cos(a) * len * 0.3 + len * 0.5);
      ctx.stroke();
    }
    ctx.restore();

    // ── 芯の吸い込み ───────────────────────────────────────────
    // 漏斗のいちばん細いところに光を溜めると、帯が「そこから伸びている」
    // ように見えて 1 本の渦にまとまる
    if (!front) {
      const r = (16 + 20 * power) * z;
      const g = ctx.createRadialGradient(bx, gy, 0, bx, gy, r);
      g.addColorStop(0, `rgba(${TORNADO.band}, ${0.16 * power})`);
      g.addColorStop(1, `rgba(${TORNADO.band}, 0)`);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(bx, gy, r, r * 0.34, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // ── 地面が近いときに散る風 ─────────────────────────────────
    // 竜巻は空中技だが、低く飛べば足元は地面すれすれになる。
    // そこで何も起きないと、渦が地面に触れていないことがはっきり見えてしまう。
    // 濃さは足元の高さだけで決めるので、降りるほど自然に立ち上がる
    const reach = Math.max(0, 1 - f.y / 110) * power;
    if (reach > 0.02) {
      const g0 = cam.groundY;
      const spanX = (80 + 90 * power) * z;
      if (!front) {
        // **平たく潰した座標系で、丸として描く。** 楕円に丸いグラデーションを
        // 敷くと、濃さが丸く薄れるのに形は平たいので、上下だけが
        // 薄れきる前に切れて縁が立つ
        ctx.save();
        ctx.translate(bx, g0);
        ctx.scale(1, 0.26);
        const g = ctx.createRadialGradient(0, 0, 0, 0, 0, spanX);
        g.addColorStop(0, `rgba(${TORNADO.ground}, ${0.26 * reach})`);
        g.addColorStop(0.5, `rgba(${TORNADO.ground}, ${0.12 * reach})`);
        g.addColorStop(1, `rgba(${TORNADO.ground}, 0)`);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(0, 0, spanX, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
      // 外へ逃げていく風。のこぎり波なので、広がりながら薄れて消える
      for (let i = 0; i < 14; i += 1) {
        const s = i * 5.13;
        const k = (now * (0.012 + frand(s) * 0.014) + frand(s + 1)) % 1;
        const a = frand(s + 2) * Math.PI * 2 + spin * 0.4;
        if (Math.sin(a) > 0 !== front) continue;
        const d = spanX * (0.25 + k * 0.9);
        const px = bx + Math.cos(a) * d;
        const py = g0 - k * 26 * z + Math.sin(a) * d * 0.24;
        const size = (0.5 + k) * z;
        const rx = (7 + frand(s + 3) * 15) * size;
        const ry = (5 + frand(s + 4) * 9) * size;
        // **縁を立てない。** 塗り潰しの楕円で描くと、風ではなく
        // 紫の小石が転がっているように見える
        const g = ctx.createRadialGradient(px, py, 0, px, py, rx);
        g.addColorStop(0, `rgba(${TORNADO.ground}, ${(1 - k) * 0.3 * reach})`);
        g.addColorStop(1, `rgba(${TORNADO.ground}, 0)`);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.ellipse(px, py, rx, ry, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
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

  /**
   * 結界。巫女がスキルを張っている間、体を包む球として出る。
   *
   * ── 何を伝えたいか ──────────────────────────────────────────
   * この技は**相手のスキルにしか効かない**。つまり相手にとっては
   * 「今スキルを振ってはいけない」という合図そのものなので、
   * 張られていることと、**いつ切れるか**が離れていても読めなければならない。
   *
   * | | やっていること | これが無いと |
   * |---|---|---|
   * | 球として描く | 体を包む円を 1 つ。前だけの壁にしない | ガードの光壁と見分けが付かない |
   * | 御札を回す | 8 枚を円周に立てて、ゆっくり回す | ただの光の輪＝何の技か伝わらない |
   * | 消える手前で薄れる | 残り 14 ティックから薄くする | 切れた瞬間が分からず、振り得になる |
   * | 位相を残りティックから作る | `wardTicks` を角度に使う | リプレイのたびに違う絵になる |
   *
   * 描画専用なので、判定はいっさいここを見ない
   * （結界が弾くかどうかは fighter.js の wardRepels が決める）。
   */
  _drawWard(f) {
    const cam = this.cam;
    const ctx = this.ctx;
    const aura = f.def.wardAura ?? { y: 108, radius: 130, color: '#ff6a86' };
    const z = cam.zoom;
    const cx = cam.toScreenX(f.x);
    const cy = cam.toScreenY(f.y + aura.y);
    const rgb = hexToRgb(aura.color);

    // 息づかい。完全に静止した円は板に見える
    const pulse = 1 + Math.sin(f.wardTicks * 0.24) * 0.028;
    const r = aura.radius * z * pulse;
    // 切れる手前は薄れていく。相手に「もうすぐ振れる」を見せるための猶予
    const fade = Math.min(1, f.wardTicks / 14);
    // 回転の位相はシミュレーション側の残りティックから作る（リプレイ再現のため）
    const spin = -f.wardTicks * 0.026;

    ctx.save();

    // 1) 中身の光。中心は空けて、縁へ向かって濃くする。
    //    中心まで塗ると本人が霞んで、何をしているのか見えなくなる
    ctx.globalCompositeOperation = 'lighter';
    const glow = ctx.createRadialGradient(cx, cy, r * 0.35, cx, cy, r);
    glow.addColorStop(0, `rgba(${rgb},0)`);
    glow.addColorStop(0.72, `rgba(${rgb},0.10)`);
    glow.addColorStop(0.97, `rgba(${rgb},0.34)`);
    glow.addColorStop(1, `rgba(${rgb},0)`);
    ctx.globalAlpha = fade;
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();

    // 2) 外周。結界の面がどこにあるかはこの 1 本で決まる
    ctx.globalAlpha = fade * 0.85;
    ctx.strokeStyle = `rgba(${rgb},0.95)`;
    ctx.lineWidth = 2.4 * z;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();

    // 3) 内側の輪。逆向きに回して、球が回っていることを見せる
    ctx.globalAlpha = fade * 0.4;
    ctx.lineWidth = 1.2 * z;
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.84, 0, Math.PI * 2);
    ctx.stroke();

    // 4) 円周に立てた御札。**この技が結界だと分かるのはここだけ**なので、
    //    加算ではなく普通に重ねて、紙として白く出す
    ctx.globalCompositeOperation = 'source-over';
    const paperL = 26 * z;
    const paperW = 9 * z;
    for (let i = 0; i < 8; i += 1) {
      const a = spin + (i / 8) * Math.PI * 2;
      // 奥側（上半分）は少し薄く。球に貼り付いていることが出る
      const depth = 0.55 + 0.45 * (Math.sin(a) * 0.5 + 0.5);
      ctx.save();
      ctx.translate(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
      ctx.rotate(a + Math.PI / 2);
      ctx.globalAlpha = fade * depth;
      ctx.fillStyle = '#fff6f4';
      ctx.fillRect(-paperW / 2, -paperL / 2, paperW, paperL);
      ctx.fillStyle = `rgba(${rgb},0.9)`;
      ctx.fillRect(-paperW / 2, -paperL / 2, paperW, 2 * z);
      ctx.fillRect(-paperW * 0.18, -paperL * 0.28, paperW * 0.36, paperL * 0.5);
      ctx.restore();
    }

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
    if (def.style === 'caltrop') {
      this._drawCaltrop(p, def);
      return;
    }
    if (def.style === 'ofuda') {
      this._drawOfuda(p, def);
      return;
    }
    if (def.style === 'shard') {
      this._drawShard(p, def);
      return;
    }
    if (def.style === 'wave') {
      this._drawWave(p, def);
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
   * まきびし。落ちている間は回りながら、地面に着いたら刺さって止まる。
   *
   * **踏むまで何も起きない技**なので、描き方が判断材料そのものになる。
   *
   * | | やっていること | これが無いと |
   * |---|---|---|
   * | 落下中は回してぶらす | 角度を進め、通ってきた位置に残像を 2 枚置く | 落としたのか置いてあるのか分からない |
   * | 3 つの形を変える | 落ちた x から大きさ・回る速さ・傾きを引く | 同じ絵が 3 つ並んで、判子を押したように見える |
   * | 鉄に見せる | 棘 1 本を「暗い地 → 鉄の面 → 光の当たる稜線」の 3 枚で描く | 単色の三角形＝紙細工に見える |
   * | 刺さった足を埋める | 地面の線から下を切り落とし、根元に土を盛る | 地面に**置いた**だけに見える |
   * | 影をぼかす | 濃さの違う楕円を 3 枚重ね、高さで薄くする | 影が輪郭を持って切り絵に見える／浮いて見える |
   * | 消える手前で点滅させる | 残り 54 フレームから明滅 | いつ切れるか分からず、踏む側も撒く側も読めない |
   *
   * 形は四方に棘の出た撒菱そのもの。真上を向いた 1 本を長く描くと、
   * 「踏んだら刺さる」が横から見て伝わる。
   */
  _drawCaltrop(p, def) {
    const cam = this.cam;
    const ctx = this.ctx;
    const z = cam.zoom;
    const sx = cam.toScreenX(p.x);
    const sy = cam.toScreenY(p.y);
    const ground = cam.toScreenY(0);

    /**
     * 個体差の種。**落とした x から引く**ので、同じ 1 つは毎フレーム同じ形になり、
     * 3 つは互いに違う形になる。描画専用で、判定は 3 つとも同じ
     * （見た目の違いが当たり判定の違いに見えない範囲に収めてある）。
     */
    const seed = Math.abs(p.x) * 0.137;
    const r = def.radius * (0.86 + frand(seed) * 0.3) * z;
    /** 刺さったときの傾き。全部が直立していると並べて置いたように見える。 */
    const tilt = (frand(seed + 1) - 0.5) * 0.32;
    /** 落ちている間だけ回る。着いたら 1 本が真上を向いた姿勢で止まる。 */
    const rate = 0.2 + frand(seed + 2) * 0.16;
    const spin = p.age * rate;
    // 残りが少なくなったら明滅。切れる直前だけ速くする
    const left = p.resting ? p.life : Infinity;
    const blink =
      left < 54 ? 0.45 + 0.55 * Math.abs(Math.sin(this._tick * (left < 20 ? 0.5 : 0.22))) : 1;

    // 鉄の色。地・面・稜線の 3 段。def.color は真ん中の「面」として使う
    const IRON_DARK = 'rgba(14, 17, 25, 0.94)';
    const IRON_LIT = '#e9eef8';

    ctx.save();

    /**
     * 接地の影。**落ちている間も出す。** どこに着くかが先に見えていないと、
     * 撒かれた側は落ちてくる粒を目で追うしかなくなる。
     * 高いほど小さく薄くするのは、キャラの影と同じ理屈。
     */
    const lift = Math.min(1, p.y / 240);
    for (const [k, a] of [[1.8, 0.10], [1.3, 0.15], [0.85, 0.22]]) {
      ctx.globalAlpha = blink * a * (1 - lift * 0.62);
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.ellipse(sx, ground + r * 0.06, r * k * (1 - lift * 0.4), r * k * 0.3 * (1 - lift * 0.4),
        0, 0, Math.PI * 2);
      ctx.fill();
    }

    /** 棘 1 本ぶんの三角形の頂点。先の尖った形なので、線ではなく面で描く。 */
    const spike = (a, len, w) => [
      [Math.cos(a) * len, Math.sin(a) * len],
      [Math.cos(a + Math.PI / 2) * w, Math.sin(a + Math.PI / 2) * w],
      [Math.cos(a - Math.PI / 2) * w, Math.sin(a - Math.PI / 2) * w],
    ];
    const tri = (pts) => {
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      ctx.lineTo(pts[1][0], pts[1][1]);
      ctx.lineTo(pts[2][0], pts[2][1]);
      ctx.closePath();
      ctx.fill();
    };

    /**
     * 撒菱 1 個ぶん。原点は中心で、呼ぶ側が translate してから使う。
     * 残像も同じものを薄く呼んで作る（別に描き分けると形がずれる）。
     *
     * @param {[number,number][]} angles [向き, 長さの倍率] の 4 本
     */
    const body = (angles, alpha) => {
      ctx.globalAlpha = blink * alpha;

      // 1) 暗い地。輪郭も兼ねる。暗い地面の上では、これが無いと沈んで消える。
      //    **棘は細く。** 太いと 4 本が根元で繋がって、三角形の塊にしか見えない
      ctx.fillStyle = IRON_DARK;
      for (const [a, k] of angles) tri(spike(a, r * k * 1.14, r * 0.29));
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.4, 0, Math.PI * 2);
      ctx.fill();

      // 2) 鉄の面
      ctx.fillStyle = def.color;
      for (const [a, k] of angles) tri(spike(a, r * k, r * 0.17));
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.25, 0, Math.PI * 2);
      ctx.fill();

      // 3) 光の当たる側の稜線。**ここで初めて鉄に見える。**
      //    棘は四角柱ではなく稜のある形なので、明るいのは片側だけになる。
      //    画面で上に来ている根元と先を結んだ三角形がその面
      ctx.fillStyle = IRON_LIT;
      for (const [a, k] of angles) {
        const w = r * 0.17;
        const c1 = [Math.cos(a + Math.PI / 2) * w, Math.sin(a + Math.PI / 2) * w];
        const c2 = [Math.cos(a - Math.PI / 2) * w, Math.sin(a - Math.PI / 2) * w];
        tri([[Math.cos(a) * r * k, Math.sin(a) * r * k], c1[1] < c2[1] ? c1 : c2, [0, 0]]);
      }

      // 4) 中心の玉。丸いものが 1 つ挟まっていると、
      //    4 本の棘が同じ 1 個の鉄から生えているように見える
      const g = ctx.createRadialGradient(-r * 0.08, -r * 0.1, 0, 0, 0, r * 0.26);
      g.addColorStop(0, IRON_LIT);
      g.addColorStop(1, '#1e2430');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.19, 0, Math.PI * 2);
      ctx.fill();
    };

    if (p.resting) {
      /**
       * 刺さっている姿は**上に 1 本・下に 2 本・手前に 1 本**（手前のは短く見える）。
       * 撒菱はどう転がっても必ず 1 本が上を向く道具なので、止まったところで
       * その形になっていないと「刺さっている」と読めない。
       */
      // 下の 2 本は**斜め下へ**向ける（0.45rad）。真横に近いと足が地面を
      // なぞるだけになって、刺さらず横たわっているように見える
      const angles = [
        [-Math.PI / 2 + tilt, 1.28],
        [Math.PI - 0.45 + tilt, 0.95],
        [0.45 + tilt, 0.95],
        [Math.PI / 2 + tilt, 0.4],
      ];
      // 地面の線から下は切り落とす。足が土に埋まって見えるのはこれのおかげで、
      // 切らずに全部描くと、地面の上にそっと置いてあるようにしか見えない。
      // 中心を地面より上げたぶんだけ、下向きの足の先が土に入る
      ctx.save();
      ctx.beginPath();
      ctx.rect(sx - r * 3, sy - r * 4, r * 6, r * 4 + r * 0.06);
      ctx.clip();
      ctx.translate(sx, sy - r * 0.2);
      body(angles, 1);
      ctx.restore();

      // 根元に寄った土。埋まった足の境目を隠すと、刺さり方が生々しくなる
      ctx.globalAlpha = blink * 0.55;
      ctx.fillStyle = '#2c2721';
      ctx.beginPath();
      ctx.ellipse(sx, ground + r * 0.02, r * 0.7, r * 0.22, 0, 0, Math.PI * 2);
      ctx.fill();

      // 上を向いた棘の先の光り。踏んだらどこが刺さるかが分かる。
      // 玉ではなく**尖ったまま光らせる**ので、先端に寄せた小さな三角で描く
      ctx.globalAlpha = blink * 0.9;
      ctx.fillStyle = '#ffffff';
      const up = -Math.PI / 2 + tilt;
      ctx.save();
      ctx.translate(sx, sy - r * 0.2);
      ctx.beginPath();
      ctx.moveTo(Math.cos(up) * r * 1.26, Math.sin(up) * r * 1.26);
      ctx.lineTo(Math.cos(up + Math.PI / 2) * r * 0.06 + Math.cos(up) * r * 0.98,
        Math.sin(up + Math.PI / 2) * r * 0.06 + Math.sin(up) * r * 0.98);
      ctx.lineTo(Math.cos(up - Math.PI / 2) * r * 0.06 + Math.cos(up) * r * 0.98,
        Math.sin(up - Math.PI / 2) * r * 0.06 + Math.sin(up) * r * 0.98);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    } else {
      // 落ちている間は向きに意味が無いので、等間隔で回すだけにしてある。
      // 長さだけ 4 本ばらけさせておくと、回っても十字に見えない
      const angles = (a) =>
        [0, 1, 2, 3].map((i) => [a + (i * Math.PI) / 2, 0.92 + frand(seed + i * 1.7) * 0.2]);
      /**
       * 通ってきた位置に置く残像 2 枚。**落ちている速さそのもの**を
       * `p.vy` から引いているので、加速したぶんだけ尾が伸びる。
       * これが無いと、回ってはいるがその場に浮いているように見える。
       */
      for (const k of [2.4, 1.2]) {
        ctx.save();
        ctx.translate(sx, sy + p.vy * k * z);
        body(angles(spin - k * rate), 0.15);
        ctx.restore();
      }
      ctx.save();
      ctx.translate(sx, sy);
      body(angles(spin), 1);
      ctx.restore();
    }
    ctx.restore();
  }

  /**
   * 御札。飛ぶ向きへ紙を寝かせて、少しはためかせながら走らせる。
   *
   * | | やっていること | これが無いと |
   * |---|---|---|
   * | 進む向きに合わせる | 速度から角度を出して回す | 斜めに飛んでいるのに札は水平のまま |
   * | 紙をはためかせる | 経過フレームで縦の縮尺を波打たせる | 板が滑っているように見える |
   * | 赤い印を入れる | 白い紙に縁と朱印を 3 枚重ねる | ただの白い長方形＝弾に見えない |
   * | 光の尾を引く | 後ろへ伸ばした加算のグラデーション | 止まって見え、速さが伝わらない |
   *
   * 紙そのものは光らないので、**尾だけ加算・本体は普通に重ねる**。
   * 全部光らせると白飛びして朱印が消え、御札に見えなくなる。
   */
  _drawOfuda(p, def) {
    const cam = this.cam;
    const ctx = this.ctx;
    const z = cam.zoom;
    const angle = Math.atan2(-p.vy, p.vx);
    const rgb = hexToRgb('#e8425e');

    // 紙の寸法。判定（54x26）より一回り小さい
    const L = 44 * z;
    const W = 16 * z;
    // はためき。縦だけ縮めるので、紙が翻って見える
    const flap = 0.72 + 0.28 * Math.abs(Math.sin(p.age * 0.42));

    ctx.save();
    ctx.translate(cam.toScreenX(p.x), cam.toScreenY(p.y));
    ctx.rotate(angle);

    // 尾。出た直後は短く、走るほど伸びる（発射点より後ろへは伸ばさない）
    const speed = Math.hypot(p.vx, p.vy) || 1;
    const tail = Math.min(speed * 4.6 * z, Math.max(0, p.age * speed * z - L * 0.5));
    if (tail > 1) {
      ctx.globalCompositeOperation = 'lighter';
      const g = ctx.createLinearGradient(-tail, 0, 0, 0);
      g.addColorStop(0, `rgba(${rgb},0)`);
      g.addColorStop(1, `rgba(255,236,238,0.55)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(-tail, 0);
      ctx.lineTo(0, -W * 0.42);
      ctx.lineTo(0, W * 0.42);
      ctx.closePath();
      ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
    }

    // 紙本体
    const w = W * flap;
    ctx.fillStyle = '#fffaf7';
    ctx.fillRect(-L / 2, -w / 2, L, w);
    // 縁と朱印。前後の端に帯、真ん中に印
    ctx.fillStyle = `rgba(${rgb},0.92)`;
    ctx.fillRect(L / 2 - 3 * z, -w / 2, 3 * z, w);
    ctx.fillRect(-L / 2, -w / 2, 2 * z, w);
    ctx.fillRect(-L * 0.1, -w * 0.3, L * 0.24, w * 0.6);
    // 走っている先の縁だけ光らせて、進行方向を出す
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = '#ffd9de';
    ctx.fillRect(L / 2 - 2 * z, -w / 2, 2 * z, w);

    ctx.restore();
  }

  /**
   * 結界の欠片。割れた結界がそのまま飛んでいくものなので、
   * **結界と同じ色・同じ質感**で描く（別物に見えると返し技だと伝わらない）。
   *
   * 尖った四角錐を回しながら飛ばし、後ろに残像を 2 枚置く。
   * 欠片は光っているものなので、こちらは本体ごと加算で描く。
   */
  _drawShard(p, def) {
    const cam = this.cam;
    const ctx = this.ctx;
    const z = cam.zoom;
    const rgb = hexToRgb(def.color);
    const sx = cam.toScreenX(p.x);
    const sy = cam.toScreenY(p.y);
    const angle = Math.atan2(-p.vy, p.vx);
    const r = def.radius * z;

    /** 欠片ひとつ。原点は中心で、進む向きへ尖らせてある。 */
    const piece = (alpha, scale, spin) => {
      ctx.save();
      ctx.rotate(spin);
      ctx.globalAlpha = alpha;
      const g = ctx.createLinearGradient(-r * scale, 0, r * 1.5 * scale, 0);
      g.addColorStop(0, `rgba(${rgb},0.15)`);
      g.addColorStop(0.5, `rgba(${rgb},0.85)`);
      g.addColorStop(1, 'rgba(255,255,255,0.95)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(r * 1.5 * scale, 0);
      ctx.lineTo(0, -r * 0.62 * scale);
      ctx.lineTo(-r * 0.9 * scale, 0);
      ctx.lineTo(0, r * 0.62 * scale);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    };

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    // 周りの光。欠片そのものは細いので、これが無いと画面で見失う
    const halo = ctx.createRadialGradient(sx, sy, 0, sx, sy, r * 2.2);
    halo.addColorStop(0, `rgba(${rgb},0.55)`);
    halo.addColorStop(1, `rgba(${rgb},0)`);
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(sx, sy, r * 2.2, 0, Math.PI * 2);
    ctx.fill();

    // 通ってきた位置の残像。速さがそのまま尾の長さになる
    for (const k of [2.2, 1.1]) {
      ctx.save();
      ctx.translate(sx - p.vx * k * z, sy + p.vy * k * z);
      ctx.rotate(angle);
      piece(0.18, 0.85, p.age * 0.3 - k * 0.3);
      ctx.restore();
    }

    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(angle);
    piece(0.95, 1, p.age * 0.3);
    ctx.restore();

    ctx.restore();
  }

  /**
   * 波動弾。格闘娘が連打の 4 打目で撃つ、素手から出る気の塊。
   *
   * 魔法使いのホーミング弾（既定の `orb`）と同じ「光る球」だが、
   * **別のものに見えないと困る**。あちらは杖から出る魔法で、こちらは
   * 拳から出る気なので、球そのものより**押し出された空気**を描く。
   *
   * | | やっていること | これが無いと |
   * |---|---|---|
   * | 進む向きへ引き伸ばす | 進行方向に 1.5 倍、直交方向に 0.8 倍へ潰す | 真円＝ただの光の玉に見える |
   * | 芯を白く飛ばす | 中心 3 割を白、外を色、縁を透明にした放射グラデ | 塗り潰した円＝平らに見える |
   * | 輪を 2 枚回す | 球を巻く楕円を、位相をずらして回す | 気が渦を巻いている感じが出ない |
   * | 後ろへ尾を引く | 速度の後方へ細くなる三角の尾 | 止まって見える（速度が絵に出ない） |
   * | 気の筋を散らす | 尾の中に短い線を 3 本、age で位相を送る | 尾がのっぺりして煙に見える |
   *
   * 光っているものなので全部加算合成で描く。血しぶきや煙とは逆の判断
   * （あちらは光らないので `source-over`）。
   */
  _drawWave(p, def) {
    const cam = this.cam;
    const ctx = this.ctx;
    const z = cam.zoom;
    const rgb = hexToRgb(def.color);
    const sx = cam.toScreenX(p.x);
    const sy = cam.toScreenY(p.y);
    const r = def.radius * z;
    // 撃った直後だけ一回り大きく出て、すぐ落ち着く（拳から生まれた感じ）
    const born = Math.min(1, p.age / 6);
    const pulse = 1 + Math.sin(p.age * 0.45) * 0.08;
    const scale = (0.6 + 0.4 * born) * pulse;
    const angle = Math.atan2(-p.vy, p.vx);

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.translate(sx, sy);
    ctx.rotate(angle);

    // 尾。速さがそのまま長さになる。中に気の筋を 3 本走らせる
    const speed = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
    const tail = speed * 3.4 * z * born;
    if (tail > 1) {
      const g = ctx.createLinearGradient(0, 0, -tail, 0);
      g.addColorStop(0, `rgba(${rgb},0.5)`);
      g.addColorStop(1, `rgba(${rgb},0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(0, -r * 0.62 * scale);
      ctx.lineTo(-tail, 0);
      ctx.lineTo(0, r * 0.62 * scale);
      ctx.closePath();
      ctx.fill();

      ctx.strokeStyle = `rgba(255,255,255,0.28)`;
      ctx.lineWidth = 1.6 * z;
      ctx.lineCap = 'round';
      for (let i = 0; i < 3; i += 1) {
        // 筋は毎フレーム後ろへ送る。止めると尾が板に見える
        const t = ((p.age * 0.09 + i * 0.33) % 1);
        const x0 = -tail * t;
        const y0 = Math.sin(i * 2.1 + p.age * 0.3) * r * 0.34 * (1 - t);
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x0 - tail * 0.18, y0 * 0.6);
        ctx.stroke();
      }
    }

    // 本体。進む向きへ伸ばした球
    ctx.save();
    ctx.scale(1.5 * scale, 0.8 * scale);
    const core = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
    core.addColorStop(0, 'rgba(255,255,255,0.98)');
    core.addColorStop(0.3, 'rgba(255,255,255,0.85)');
    core.addColorStop(0.62, `rgba(${rgb},0.8)`);
    core.addColorStop(1, `rgba(${rgb},0)`);
    ctx.fillStyle = core;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // 巻き付く輪。潰した楕円を 2 枚、位相をずらして回す
    ctx.strokeStyle = `rgba(${rgb},0.55)`;
    ctx.lineWidth = 2.2 * z;
    for (let i = 0; i < 2; i += 1) {
      const phase = p.age * 0.26 + i * Math.PI * 0.5;
      // 輪の縦幅を sin で往復させると、球を回り込んでいるように見える
      const ry = Math.abs(Math.sin(phase)) * r * 0.86 * scale + r * 0.1;
      ctx.beginPath();
      ctx.ellipse(0, 0, r * 1.32 * scale, ry, 0, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.restore();
  }

  /**
   * 煙玉の白煙。
   *
   * 加算合成は使わない。煙は光らないので、光らせた時点で嘘になる
   * （血しぶきと同じ判断）。膨らみながら薄れて、ゆっくり昇る。
   * 丸を 1 個で描くと球にしか見えないので、seed からずらした塊を重ねている。
   */
  _drawSmoke(fx, t) {
    const cam = this.cam;
    const ctx = this.ctx;
    const z = cam.zoom;
    // 一気に膨らんでから、じわじわ広がって薄れる
    const grow = Math.min(1, Math.sqrt(t * 3.4));
    const fade = t < 0.15 ? t / 0.15 : 1 - (t - 0.15) / 0.85;
    if (fade <= 0.01) return;
    const R = fx.radius * (0.3 + 0.7 * grow) * z;
    const cx = cam.toScreenX(fx.x);
    /**
     * 塊の中心は**体の真ん中あたり**に置く。地面すれすれに出すと、
     * 姿を消した本人が煙の上に立っているのが見えてしまい、
     * 「煙に紛れて消えた」ではなく「薄くなった」に見える。
     */
    const cy = cam.toScreenY(fx.y + 96 + t * 54);

    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    for (let i = 0; i < 11; i += 1) {
      const a = frand(fx.seed + i * 4.7) * Math.PI * 2;
      const d = i === 0 ? 0 : R * (0.2 + frand(fx.seed + i * 2.3) * 0.62) * grow;
      const rr = R * (i === 0 ? 0.72 : 0.34 + frand(fx.seed + i * 6.1) * 0.34);
      const px = cx + Math.cos(a) * d;
      const py = cy + Math.sin(a) * d * 0.78;
      const g = ctx.createRadialGradient(px, py, 0, px, py, rr);
      g.addColorStop(0, `rgba(238, 242, 250, ${0.72 * fade})`);
      g.addColorStop(0.55, `rgba(206, 214, 230, ${0.4 * fade})`);
      g.addColorStop(1, 'rgba(186, 196, 216, 0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(px, py, rr, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  /**
   * 着地の砂埃（叩きつけて降りる技の `landImpact`）。
   *
   * 煙玉の煙（`_drawSmoke`）とは別物として描く。あちらは体を隠すための
   * 丸い塊で、その場に湧いて留まる。こちらは踏み抜かれた地面から
   * **舞い上がる砂**なので、
   *
   *   1. **左右へ逃げてから、上へ巻き上がる。** 出た瞬間は地面を這い、
   *      時間が経つほど高く昇る。這ったまま消える塊は「砂埃」ではなく「泥」に見える
   *   2. **昇るほど膨らんで、丸くなる。** 地面すれすれでは横に潰れているが
   *      （空気が横へ逃げるため）、離れるにつれ形が崩れて丸に近づく
   *   3. **砂粒が混じる。** 塊だけだと湯気で、粒だけだと火花になる。
   *      粒は放物線で飛んで落ち、進む向きへ伸ばした短い線で描く
   *
   * 粒の位置は経過時間から毎回計算し直す（弾道式）。粒ごとの状態を持たないので、
   * 巻き戻しても・描画を飛ばしても、同じ `seed` と `t` なら必ず同じ絵になる。
   *
   * 色は月明かりを受けた砂。白い煙にすると、同じ画面に出る煙玉と見分けが付かない。
   */
  _drawDust(fx, t) {
    const cam = this.cam;
    const ctx = this.ctx;
    const z = cam.zoom;
    const R = fx.radius * z;
    const cx = cam.toScreenX(fx.x);
    const ground = cam.toScreenY(fx.y);

    ctx.save();
    ctx.globalCompositeOperation = 'source-over';

    // ── 舞い上がる塊 ──────────────────────────────────────────
    // 横へ逃げるのは頭打ちする曲線（すぐ止まる）、上へ昇るのは時間に比例
    // （止まらない）。この差が「広がってから立ち昇る」動きになる。
    const spread = Math.min(1, Math.sqrt(t * 3.6));
    // 立ち上がりはほぼ即座に。ここを緩めると、踏み抜いた最初の 2〜3 コマが
    // 薄いままになって、いちばん見せたい瞬間に何も出ていないことになる。
    // 引きは 1.7 乗。真っ直ぐ薄くすると、最後まで灰色の靄が残って霧に見える
    const fade = t < 0.03 ? t / 0.03 : (1 - (t - 0.03) / 0.97) ** 1.7;
    if (fade > 0.01) {
      // 数を多く・1 つを小さくしてある。大きな塊を数個置くと綿になるので、
      // 小さいものを重ねて、粒の集まりとして見せる
      for (let i = 0; i < 20; i += 1) {
        const side = i % 2 === 0 ? 1 : -1;
        const r0 = frand(fx.seed + i * 3.1);
        const r1 = frand(fx.seed + i * 5.7);
        const r2 = frand(fx.seed + i * 8.3);
        const r3 = frand(fx.seed + i * 11.9);
        /**
         * 横へ逃げる距離。**縦より狭くする**のが肝で、横に広げるほど
         * 「舞い上がった砂」ではなく「地を這う霧」に近づく。
         * 遠くまで逃げた塊ほど薄くして、裾を引かせる。
         */
        const reach = 0.08 + r0 * 0.62;
        const d = R * reach * spread;
        // 昇る速さは塊ごとに 5 倍近く違う。揃えると板が持ち上がるように見える。
        // 横（最大 0.7R）より縦（最大 1.2R）を大きく取って、立ち上がる形にする
        const rise = R * (0.16 + r1 * 1.04) * t;
        // 育ちながら薄れる。膨らませないと、ただ上へ動いただけに見える
        const rr = R * (0.09 + r2 * 0.15) * (0.45 + spread * 0.55) * (1 + t * 1.5);
        const px = cx + side * d + (r3 - 0.5) * R * 0.2;
        const py = ground - rise - rr * 0.25;
        // 地面すれすれは横へ潰れ、昇るほど丸くなる
        const flat = 0.34 + Math.min(1, rise / (R * 0.45)) * 0.5;
        // 遠くの塊ほど薄い。濃さを揃えると輪郭の揃った 1 枚の雲に見える
        const a = fade * (0.56 - 0.24 * t) * (1 - reach * 0.5);
        const g = ctx.createRadialGradient(px, py, 0, px, py, rr);
        g.addColorStop(0, `rgba(226, 208, 176, ${a})`);
        g.addColorStop(0.5, `rgba(190, 170, 150, ${a * 0.5})`);
        g.addColorStop(1, 'rgba(152, 134, 128, 0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.ellipse(px, py, rr, rr * flat, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // ── 踏み抜いた瞬間の裾 ────────────────────────────────────
    // 足元から左右へ一気に逃げる、**低くて薄い**空気。
    // 上の塊が立ち上がるのを待たずに広がるので、着いた最初の数コマが
    // 「ドン」と見える。t の 1/3 で消えるので、あとには残らない。
    const skirtT = Math.min(1, t / 0.34);
    if (skirtT < 1) {
      const a = (1 - skirtT) ** 1.5 * 0.4;
      for (let i = 0; i < 4; i += 1) {
        const side = i % 2 === 0 ? 1 : -1;
        const r0 = frand(fx.seed + i * 4.9 + 91);
        const w = R * (0.5 + r0 * 0.5) * (0.35 + skirtT * 0.9);
        const px = cx + side * w * 0.55;
        const py = ground - R * 0.06;
        const g = ctx.createRadialGradient(px, py, 0, px, py, w);
        g.addColorStop(0, `rgba(226, 208, 176, ${a})`);
        g.addColorStop(0.6, `rgba(186, 168, 152, ${a * 0.4})`);
        g.addColorStop(1, 'rgba(152, 134, 128, 0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.ellipse(px, py, w, w * 0.22, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // ── 砂粒 ──────────────────────────────────────────────────
    // 弾き飛ばされた粒。上と横へ散って、重力で落ちてくる。
    // 落ちきった（地面より下へ行った）粒はそこで消す。
    const grainFade = 1 - t * t;
    if (grainFade > 0.02) {
      ctx.lineCap = 'round';
      for (let i = 0; i < 38; i += 1) {
        const r0 = frand(fx.seed + i * 2.7 + 41);
        const r1 = frand(fx.seed + i * 6.3 + 41);
        const r2 = frand(fx.seed + i * 9.1 + 41);
        const side = i % 2 === 0 ? 1 : -1;
        // 斜め上へ。真上へ飛ばすと噴水になるので、横成分を必ず残す
        const ang = (0.12 + r0 * 0.66) * Math.PI * 0.5;
        /**
         * 速さは 3 粒に 1 粒だけ速い。全部同じ勢いで飛ばすと、
         * きれいな弧が揃って**花火**に見える。
         * 遅い粒は足元に残って、跳ね上がった砂が落ちてくる時間差を作る。
         */
        const fast = i % 3 === 0;
        const sp = R * (fast ? 1.3 + r1 * 1.5 : 0.35 + r1 * 0.7);
        const vx = side * Math.cos(ang) * sp;
        const vy = Math.sin(ang) * sp;
        const gAcc = R * 3.4;
        const px = cx + vx * t;
        const py = ground - (vy * t - gAcc * t * t * 0.5);
        // 落ちきった粒はそこで消す（地面にめり込ませない）
        if (py > ground) continue;
        /**
         * 進む向きへ**わずかに**伸ばす。長く引くと砂ではなく火花の尾になり、
         * 逆に点で置くと止まって見える。速い粒だけ少し伸びる長さにしてある。
         */
        const dx = vx;
        const dy = -(vy - gAcc * t);
        const len = Math.max(0.0001, Math.hypot(dx, dy));
        const tail = Math.min(R * 0.045, len * 0.022);
        const w = (0.7 + r2 * 1.2) * z;
        ctx.strokeStyle = r2 > 0.42
          ? `rgba(238, 220, 184, ${0.85 * grainFade})`
          : `rgba(184, 164, 152, ${0.7 * grainFade})`;
        ctx.lineWidth = w;
        ctx.beginPath();
        ctx.moveTo(px - (dx / len) * tail, py - (dy / len) * tail);
        ctx.lineTo(px, py);
        ctx.stroke();
      }
    }

    ctx.restore();
  }

  /**
   * スプライトで描く飛び道具（女子高生の彼氏）。
   *
   * 走ってきて、相手に届く間合いに入ったらタックルの絵に変わり、
   * 最終コマまで来たらそのコマのまま滑って止まり、また走り出して走り抜けていく。
   *
   * **タックルは繰り返さない。** 突進のシートは 1 回ぶんの動きなので、
   * 突進に入ってからの経過フレーム（sim が数えている lungeAge）で
   * 頭から 1 回だけ再生する。相手との距離でコマを決めると、
   * 追い越したあとに距離が開いてコマが逆戻りし、2 周したように見えてしまう。
   *
   * 走りに戻る合図は sim 側の lungeDone。「滑って止まりきったか」は
   * 速さの話なので、コマ数からは決められない。
   */
  _drawSpriteProjectile(p, def, sim) {
    const sprite = this.sprites[def.sheet];
    if (!sprite) return;
    const cam = this.cam;
    const tackle = sprite.animations[def.anims.hit];
    // 滑っている間は最終コマで止める（コマ送りだけ先に進めない）
    const tackleFrame =
      p.lungeAge >= 0 && tackle?.frames > 0
        ? Math.min(
            Math.floor((p.lungeAge * (def.tackleFps ?? def.animFps ?? 14)) / 60),
            tackle.frames - 1
          )
        : -1;
    const lunging = tackleFrame >= 0 && !p.lungeDone;

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

    if (fx.type === 'smoke') {
      this._drawSmoke(fx, t);
      return;
    }

    if (fx.type === 'dust') {
      this._drawDust(fx, t);
      return;
    }

    if (fx.type === 'wardUp' || fx.type === 'wardBreak') {
      this._drawWardBurst(fx, t, fx.type === 'wardBreak');
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
   * 結界が張られた瞬間（wardUp）と、割れた瞬間（wardBreak）。
   *
   * 同じ 1 つの関数で描き分けているのは、**どちらも同じ球の出来事**だから。
   * 別々に描くと、張ったときと割れたときで結界の大きさが食い違って見える。
   *
   *   張る  … 外から輪が締まって、球の面が現れる
   *   割れる… 輪が外へ弾け、破片が同じ向きへ散る
   *
   * 弾いた側の見返り（返し技）はこのあと必ず飛ぶので、
   * ここは「弾いた」ことだけを短く伝えて、欠片の邪魔をしない。
   *
   * @param {boolean} breaking 割れた側か
   */
  _drawWardBurst(fx, t, breaking) {
    const cam = this.cam;
    const ctx = this.ctx;
    const z = cam.zoom;
    const sx = cam.toScreenX(fx.x);
    const sy = cam.toScreenY(fx.y);
    const base = (fx.radius || 130) * z;
    const rgb = '255, 106, 134';
    // 張るときは外から内へ、割れるときは内から外へ
    const r = breaking ? base * (0.9 + t * 0.7) : base * (1.55 - t * 0.55);
    const alpha = (1 - t) * (1 - t);

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    // 輪
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = `rgba(${rgb},0.95)`;
    ctx.lineWidth = (breaking ? 4.5 : 3) * z * (1 - t * 0.6);
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.stroke();

    // 中心の閃光。割れた瞬間だけ強く出す
    if (breaking) {
      const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, base * (0.4 + t));
      g.addColorStop(0, `rgba(255,255,255,${0.7 * alpha})`);
      g.addColorStop(0.4, `rgba(${rgb},${0.4 * alpha})`);
      g.addColorStop(1, `rgba(${rgb},0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(sx, sy, base * (0.4 + t), 0, Math.PI * 2);
      ctx.fill();

      // 破片。輪と同じ球から、外へ飛び散る
      ctx.fillStyle = `rgba(255,235,240,${alpha})`;
      for (let i = 0; i < 12; i += 1) {
        const a = (i / 12) * Math.PI * 2 + fx.seed;
        const d = base * (0.7 + t * 1.25) * (0.8 + frand(fx.seed + i) * 0.5);
        const len = base * 0.22 * (1 - t);
        ctx.save();
        ctx.translate(sx + Math.cos(a) * d, sy + Math.sin(a) * d);
        ctx.rotate(a);
        ctx.beginPath();
        ctx.moveTo(len, 0);
        ctx.lineTo(-len * 0.6, -len * 0.32);
        ctx.lineTo(-len * 0.6, len * 0.32);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
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

    // 弧そのもの。太い光の帯の上に細い芯を重ねる。
    // 帯の色は技データの tint で差し替えられる（ビームサーベルは水色）
    const glow = fx.tint ?? '130, 190, 255';
    for (const [w, col] of [[9, `rgba(${glow}, 0.5)`], [3.5, 'rgba(255, 255, 255, 0.95)']]) {
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
