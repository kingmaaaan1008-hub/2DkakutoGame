/**
 * ビームサーベルの発光レイヤー。
 *
 * ── なぜ要るか ──────────────────────────────────────────────
 * 元シートは**コマによってビームの量が倍近く違う**。アトラスを実測すると、
 * 「ビームらしい色の画素」の総量が同じアニメの中で
 *
 *   attack5（切り抜け）  f0 3651 → f7 1733（47%）
 *   attack3（串刺し）    f0 2569 → f3 1030（40%）
 *
 * と振れる。振りの速いコマほど刃が細く短く描かれていて、とくに二刀のうち
 * 奥の 1 本が消えかける。素材の作り直しでも直らなかった
 * （`cavalier_rows.txt` の beamfix の項）。AI で描いた絵なので、
 * 描き直しても同じ癖が出ないという保証が無い。
 *
 * ── どう直すか ──────────────────────────────────────────────
 * 薄さには**別々の原因が 2 つ**ある。片方だけ直しても直らない。
 *
 * | | 症状 | 実測 |
 * |---|---|---|
 * | 画素の量 | 振りの速いコマほど刃が細く短い | 一番濃いコマの 40〜47% |
 * | 画素の透明度 | 刃そのものが半透明で**背景が透ける** | attack3 f2 は 34% が alpha 200 未満、下位 1/4 は alpha 152 |
 *
 * 透ける側は**加算合成では絶対に直らない**。加算は背景に光を足すだけで、
 * 背景を隠さないからで、いくら強くしても「明るいが透けている」にしかならない
 * （そして光だけが強くなって白飛びする）。
 *
 * だからこのレイヤーは**本体の下に敷く**。不透明な光を先に置いてから
 * 半透明の刃を上に重ねると、透けた先に出るのが背景ではなく光になる。
 * 敷くほうが 1/DIV でぼけていても構わない。**上に本物の刃が乗るので、
 * 見えるのは輪郭からはみ出したぶんだけ**で、それは暈として正しく見える。
 *
 * 効いているのは次の 3 つ。
 *
 * | | やっていること | これが無いと |
 * |---|---|---|
 * | 下に敷く（backing） | 本体より先に、不透明な光として描く | 刃から背景が透ける |
 * | コマごとの正規化 | コマの持つビーム量を測り、少ないコマほど強く光らせる | 振るたびに明滅する |
 * | 焼き込んだ暈（halo） | 刃のまわりへ光をぼかして広げる | 細いコマが線に見える |
 *
 * 加算合成のぶんは**添えるだけ**に落としてある。明るさの頭打ちが
 * 「ビームの色」で止まるので、白飛びしない。
 *
 * ── 作り方 ──────────────────────────────────────────────────
 * アトラスと同じ解像度で持つとテクスチャが倍になるので **1/DIV に縮めてから**
 * 抜き出す。重ねるのはぼやけた光なので、縮んでいて困らない
 * （むしろ滲んでビームらしくなる）。読み込み時に 1 回だけ焼いて使い回す。
 *
 * 縮めてから抜き出しても取りこぼしはほとんど無い。等倍で判定してから
 * 縮めた場合と比べて 95〜107%（実測）で、7 倍の読み出し費用に見合わない。
 *
 * 描画専用。シミュレーションには一切関わらない。
 */

/**
 * レイヤーの縮小率。
 *
 * 3 で 1 キャラ 16MB 程度。等倍で持つとアトラスぶんまるごと倍になり、
 * ページを 8Mpx で割っている意味（iOS のデコード上限）が薄れる。
 * 4 まで落とすと刃が 1 画素を割って途切れるコマが出た。
 */
const DIV = 3;

/**
 * 正規化の基準にするコマ。
 *
 * 一番濃いコマに揃えると、たまたま刃が大写しになった 1 コマに全体が
 * 引きずられて全部が白飛びする。上から 1/4 のあたりを「本来の濃さ」と見なす。
 */
const REF_PERCENTILE = 0.75;

/**
 * 分離型のぼかし 1 回ぶん（横 → 縦の箱ぼかし）。
 *
 * 端は複製で埋める。コマの矩形の縁はたいてい空なので、これで困らない。
 * 呼ぶ側が 2 回通して三角形の重みにしている（1 回だと段が見える）。
 */
function blurPass(src, dst, tmp, w, h, r) {
  const n = 2 * r + 1;
  const cx = (x) => (x < 0 ? 0 : x > w - 1 ? w - 1 : x);
  const cy = (y) => (y < 0 ? 0 : y > h - 1 ? h - 1 : y);

  for (let y = 0; y < h; y += 1) {
    const row = y * w;
    let sum = 0;
    for (let x = -r; x <= r; x += 1) sum += src[row + cx(x)];
    for (let x = 0; x < w; x += 1) {
      tmp[row + x] = sum / n;
      sum -= src[row + cx(x - r)];
      sum += src[row + cx(x + r + 1)];
    }
  }

  for (let x = 0; x < w; x += 1) {
    let sum = 0;
    for (let y = -r; y <= r; y += 1) sum += tmp[cy(y) * w + x];
    for (let y = 0; y < h; y += 1) {
      dst[y * w + x] = sum / n;
      sum -= tmp[cy(y - r) * w + x];
      sum += tmp[cy(y + r + 1) * w + x];
    }
  }
}

/**
 * コマ 1 枚を焼く。芯（拾った画素そのもの）に暈を足して、コマの倍率を掛ける。
 *
 * **ぼかしはコマの矩形の中で閉じる。** アトラスはコマが横に並んでいるので、
 * ページ全体でぼかすと隣のコマの刃が滲み出して二重に見える。
 */
function bakeFrame(page, rect, gain, cfg, halo) {
  const w = rect.x1 - rect.x0;
  const h = rect.y1 - rect.y0;
  if (w <= 0 || h <= 0) return;

  const local = new Float32Array(w * h);
  for (let y = 0; y < h; y += 1) {
    const src = (rect.y0 + y) * page.w + rect.x0;
    local.set(page.cov.subarray(src, src + w), y * w);
  }

  let glow = null;
  if (halo.radius > 0 && halo.gain > 0) {
    const tmp = new Float32Array(w * h);
    const ping = new Float32Array(w * h);
    glow = new Float32Array(w * h);
    // 箱ぼかしは 3 回でほぼガウス。**2 回では足りない。**
    // 下に敷くようになってから、暈は背景を隠すので四角い段が目に見える
    // （加算で足していた頃は背景に紛れて分からなかった）
    blurPass(local, glow, tmp, w, h, halo.radius);
    blurPass(glow, ping, tmp, w, h, halo.radius);
    blurPass(ping, glow, tmp, w, h, halo.radius);
  }

  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = y * w + x;
      let a = local[i] * cfg.boost;
      if (glow) a += glow[i] * halo.gain;
      if (a <= 0) continue;
      a = Math.min(1, a * gain);
      // コマの矩形は端で 1 画素ぶん隣と重なりうる（コマ幅が DIV の倍数とは
      // 限らない）。濃い方を残せば、どちらのコマから見ても欠けない
      const o = (rect.y0 + y) * page.w + rect.x0 + x;
      if (a > page.alpha[o]) page.alpha[o] = a;
    }
  }
}

/**
 * 1 キャラぶんの発光レイヤーを焼く。
 *
 * @param {object} sprite loadCharacterSprites が返すもの（images / pages / animations）
 * @param {object} cfg キャラ定義の beamGlow
 * @returns {{images: HTMLCanvasElement[], div: number}}
 */
export function buildBeamGlow(sprite, cfg) {
  const [cr, cg, cb] = cfg.color;
  const halo = cfg.halo ?? { radius: 0, gain: 0 };
  const maxGain = cfg.maxGain ?? 1;

  // ページごとに、縮めてから「ビームらしい画素」を 0〜1 の被覆率として抜き出す。
  // ビームらしさ＝緑と青が揃って高く、赤からはっきり離れている画素。
  // 白い装甲は r≈g≈b なので lead が伸びず、濃紺の翼は g が足りない。
  const pages = sprite.images.map((img, i) => {
    const src = sprite.pages?.[i] ?? { w: img.width, h: img.height };
    const w = Math.max(1, Math.ceil(src.w / DIV));
    const h = Math.max(1, Math.ceil(src.h / DIV));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);

    const data = ctx.getImageData(0, 0, w, h);
    const px = data.data;
    const cov = new Float32Array(w * h);
    for (let p = 0, o = 0; p < px.length; p += 4, o += 1) {
      const a = px[p + 3];
      if (a < 12) continue;
      const r = px[p];
      const gr = px[p + 1];
      const b = px[p + 2];
      const lead = Math.min(gr - r, b - r);
      if (gr < cfg.minG || b < cfg.minB || lead < cfg.lead) continue;
      cov[o] = Math.min(1, (lead - cfg.lead + 8) / cfg.span) * (a / 255);
    }
    return { canvas, ctx, data, w, h, cov, alpha: new Float32Array(w * h) };
  });

  // アニメごとに、コマの持つビーム量を測って倍率を決めてから焼く。
  // ここが「振るたびに明滅する」を潰しているところ。
  for (const cell of Object.values(sprite.animations)) {
    const page = pages[cell.page];
    if (!page) continue;

    const rects = [];
    for (let f = 0; f < cell.frames; f += 1) {
      const sx = cell.x + f * cell.cw;
      const rect = {
        x0: Math.max(0, Math.floor(sx / DIV)),
        y0: Math.max(0, Math.floor(cell.y / DIV)),
        x1: Math.min(page.w, Math.ceil((sx + cell.cw) / DIV)),
        y1: Math.min(page.h, Math.ceil((cell.y + cell.ch) / DIV)),
        mass: 0,
      };
      for (let y = rect.y0; y < rect.y1; y += 1) {
        const row = y * page.w;
        for (let x = rect.x0; x < rect.x1; x += 1) rect.mass += page.cov[row + x];
      }
      rects.push(rect);
    }

    // ビームを持たないアニメ（立ち以外にも刃を出さない絵がある）は素通し
    const masses = rects.map((r) => r.mass).filter((m) => m > 0).sort((a, b) => a - b);
    if (masses.length === 0) continue;
    const ref = masses[Math.min(masses.length - 1, Math.floor(masses.length * REF_PERCENTILE))];

    for (const rect of rects) {
      // 濃いコマは触らない（1 未満にはしない）。薄いコマだけを引き上げる
      const gain = rect.mass > 0 ? Math.min(maxGain, Math.max(1, ref / rect.mass)) : 1;
      bakeFrame(page, rect, gain, cfg, halo);
    }
  }

  return {
    images: pages.map((page) => {
      const px = page.data.data;
      for (let o = 0, p = 0; o < page.alpha.length; o += 1, p += 4) {
        const a = page.alpha[o];
        if (a <= 0) {
          px[p + 3] = 0;
          continue;
        }
        px[p] = cr;
        px[p + 1] = cg;
        px[p + 2] = cb;
        px[p + 3] = Math.round(a * 255);
      }
      page.ctx.putImageData(page.data, 0, 0);
      return page.canvas;
    }),
    div: DIV,
  };
}
