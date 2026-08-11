/**
 * スラスターの粒子（キラキラ）。
 *
 * ── 描画専用 ────────────────────────────────────────────────
 * シミュレーションの状態は**読むだけ**で、粒はここだけが持つ。
 * 試合の結果に影響しないので、フレームを落としても（粒が減るだけで）
 * 勝敗もリプレイもずれない。sim.effects に載せていないのはこのため。
 * 演出の 1 個 1 個をロールバック対象にすると、巻き戻すたびに
 * 粒の配列まで保存・復元することになって割に合わない。
 *
 * ── 湧かせ方 ────────────────────────────────────────────────
 * 湧く位置も向きも**そのときの速度から決める**。技ごとに噴射口を書くと、
 * 立ち・ジャンプ・水平の錐揉みで姿勢が変わるたびに合わなくなるので、
 * 「体の中心から、進んでいる方向の逆へ少し離れたところ」から出している。
 * 排気は進行方向の逆へ流れるものなので、これだけでどの姿勢でも筋が通る。
 */

/** 同時に出せる粒の上限。超えたら古いものから上書きする。 */
const MAX = 180;

/** 粒の絵を焼くテクスチャの一辺（px）。実際の大きさは描くときに縮める。 */
const TEX = 64;

/**
 * 粒 1 個ぶんの絵を焼く。
 *
 * 中心の白い芯 → 色の滲み → 透明、の放射グラデーションに、
 * 十字の光条（グリント）を重ねる。ストライクフリーダムの粒のように
 * 「点が四方に尖って光る」形にするのが狙い。
 *
 * 毎フレーム作ると重いので 1 度だけ焼いて drawImage で使い回す。
 * 粒 1 個あたりの描画が drawImage 1 回で済むので、150 個出しても軽い。
 */
function bakeSparkle(color) {
  const c = document.createElement('canvas');
  c.width = TEX;
  c.height = TEX;
  const g = c.getContext('2d');
  const mid = TEX / 2;

  const glow = g.createRadialGradient(mid, mid, 0, mid, mid, mid);
  glow.addColorStop(0, 'rgba(255,255,255,1)');
  glow.addColorStop(0.18, color);
  glow.addColorStop(0.45, color.replace('rgb(', 'rgba(').replace(')', ',0.35)'));
  glow.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = glow;
  g.beginPath();
  g.arc(mid, mid, mid, 0, Math.PI * 2);
  g.fill();

  // 十字の光条。中心が一番太く、先へ行くほど細って消える
  g.strokeStyle = 'rgba(255,255,255,0.9)';
  g.lineCap = 'round';
  for (const [dx, dy] of [[1, 0], [0, 1]]) {
    for (const [len, w] of [[mid * 0.95, 1.6], [mid * 0.55, 3.4]]) {
      g.lineWidth = w;
      g.beginPath();
      g.moveTo(mid - dx * len, mid - dy * len);
      g.lineTo(mid + dx * len, mid + dy * len);
      g.stroke();
    }
  }
  return c;
}

export class SparkleField {
  constructor() {
    /** ワールド座標の粒。使い回すので長さは MAX で頭打ちになる。 */
    this.parts = [];
    this.next = 0;
    /** 1 ティックあたりの発生数は小数になるので、端数を持ち越す（index 別）。 */
    this.debt = [0, 0];
    /** 背中から漏れ続けるぶんの端数。 */
    this.ambDebt = [0, 0];
    /** 色ごとに焼いた粒の絵。最初に描くときに作る。 */
    this.tex = new Map();
  }

  clear() {
    this.parts.length = 0;
    this.next = 0;
    this.debt[0] = 0;
    this.debt[1] = 0;
    this.ambDebt[0] = 0;
    this.ambDebt[1] = 0;
  }

  /**
   * 1 体ぶんの排気を湧かせる。
   * @param {import('../game/fighter.js').Fighter} f
   */
  emit(f) {
    const th = f.def.thruster;
    if (!th) return;
    // ヒットストップ中は本人が止まっているので、湧かせると 1 か所に溜まる
    if (f.hitstop > 0 || f.isKO) return;

    if (th.ambient) this._emitAmbient(f, th.ambient);

    const speed = Math.hypot(f.vx, f.vy);
    const boost = Math.min(1, (speed - th.idle) / (th.full - th.idle));
    if (boost <= 0) return;

    this.debt[f.index] += boost * th.rate;
    const n = Math.floor(this.debt[f.index]);
    this.debt[f.index] -= n;

    // 進行方向の逆＝排気の向き
    const bx = -f.vx / speed;
    const by = -f.vy / speed;
    const cx = f.x + bx * th.offset;
    const cy = f.y + th.height + by * th.offset;

    for (let i = 0; i < n; i += 1) {
      const sp = th.speed * (0.4 + Math.random() * 1.1);
      this._push({
        x: cx + (Math.random() - 0.5) * th.spread,
        y: cy + (Math.random() - 0.5) * th.spread,
        vx: bx * sp + (Math.random() - 0.5) * 0.7,
        vy: by * sp + (Math.random() - 0.5) * 0.7,
        life: th.life * (0.55 + Math.random() * 0.7),
        age: 0,
        size: th.size * (0.45 + Math.random() * 0.85),
        // 差し色は少しだけ混ぜる。全部が金色だと火の粉に見える
        color: Math.random() < (th.accent ?? 0.25) ? th.colors[1] : th.colors[0],
        // 明滅の位相。粒ごとにずらさないと画面全体が同時に瞬く
        phase: Math.random() * Math.PI * 2,
      });
    }
  }

  /**
   * 止まっていても背中から漏れる粒。
   *
   * 排気（速度で湧くぶん）と違って、**向きだけ**で位置が決まる。
   * 速度を使うと止まった瞬間に湧かなくなり、待機中がいちばん寂しくなる。
   */
  _emitAmbient(f, am) {
    this.ambDebt[f.index] += am.rate;
    const n = Math.floor(this.ambDebt[f.index]);
    this.ambDebt[f.index] -= n;
    if (n <= 0) return;

    const th = f.def.thruster;
    const cx = f.x + f.facing * am.origin.x;
    const cy = f.y + am.origin.y;
    for (let i = 0; i < n; i += 1) {
      const sp = am.speed * (0.3 + Math.random());
      this._push({
        x: cx + (Math.random() - 0.5) * am.spread,
        y: cy + (Math.random() - 0.5) * am.spread,
        // 噴射口から下へこぼれて、背中側へゆるく流れる。
        // step() の浮力で落ちる勢いはすぐ相殺されるので、少し沈んで漂う形になる
        vx: -f.facing * sp,
        vy: -sp * (0.2 + Math.random() * 0.6),
        life: am.life * (0.6 + Math.random() * 0.7),
        age: 0,
        size: am.size * (0.5 + Math.random() * 0.8),
        color: Math.random() < (th.accent ?? 0.25) ? th.colors[1] : th.colors[0],
        phase: Math.random() * Math.PI * 2,
        dim: am.alpha ?? 1,
      });
    }
  }

  _push(p) {
    if (this.parts.length < MAX) this.parts.push(p);
    else {
      this.parts[this.next] = p;
      this.next = (this.next + 1) % MAX;
    }
  }

  /** 1 ティック進める。流れながら失速して、その場で瞬きながら消える。 */
  step() {
    for (let i = this.parts.length - 1; i >= 0; i -= 1) {
      const p = this.parts[i];
      p.x += p.vx;
      p.y += p.vy;
      p.vx *= 0.9;
      p.vy *= 0.9;
      // ほんの少しだけ浮く。真っ直ぐ落ちると火の粉に見えてしまう
      p.vy += 0.02;
      p.age += 1;
      if (p.age >= p.life) this.parts.splice(i, 1);
    }
  }

  /**
   * @param {CanvasRenderingContext2D} ctx
   * @param {object} cam
   * @param {boolean} front true ならキャラより手前に描くぶんだけを描く。
   *
   * 排気（進行方向の逆へ流れるぶん）は**奥**。後ろへ流れていくものなので、
   * 体に隠れる側が正しい。
   * 常時漏れるぶんは**手前**。噴射口が翼の分岐点にあるので、奥に描くと
   * 必ず翼の陰に入って一粒も見えない。
   */
  draw(ctx, cam, front = false) {
    if (this.parts.length === 0) return;
    ctx.save();
    // 光なので加算合成。背景に足し合わさらないと「粒が浮いている」ように見える
    ctx.globalCompositeOperation = 'lighter';
    for (const p of this.parts) {
      if ((p.dim != null) !== front) continue;
      let tex = this.tex.get(p.color);
      if (!tex) {
        tex = bakeSparkle(p.color);
        this.tex.set(p.color, tex);
      }
      const t = p.age / p.life;
      // 出た瞬間に一番大きく、あとは瞬きながら細っていく
      const twinkle = 0.72 + 0.28 * Math.sin(p.age * 0.55 + p.phase);
      const s = p.size * (1 - t * 0.65) * twinkle * cam.zoom;
      ctx.globalAlpha = (1 - t) * (1 - t) * twinkle * (p.dim ?? 1);
      ctx.drawImage(tex, cam.toScreenX(p.x) - s, cam.toScreenY(p.y) - s, s * 2, s * 2);
    }
    ctx.restore();
  }
}
