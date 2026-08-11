/**
 * スプライトの描画。
 *
 * アトラスのマニフェスト（tools/build-assets.ps1 が生成）には、
 * アニメごとにセル寸法とアンカー (ax, ay) が入っている。
 * アンカーはキャラの足元の位置なので、ワールド座標の足元に
 * アンカーを合わせて描けば、どのアニメでも自然に繋がる。
 * ベースシートと *_extra シートでコマ寸法が違っていても揃うのはこのため。
 */

/**
 * アニメ記述子から、いま表示すべきコマ番号を解決する。
 * 記述子は Fighter が持つ素のデータ（画像を知らない）なので、
 * 実際のコマ数はここで初めて参照する。
 *
 * @param {{name:string,time:number,fps:number,loop:boolean,reverse:boolean,stretch:number}} anim
 * @param {object} sprite loadCharacterSprites の戻り値
 */
export function resolveFrame(anim, sprite) {
  const cell = sprite.animations[anim.name];
  if (!cell) return null;

  // 使う区間。技側は実際のコマ数を知らないので、はみ出す指定はここで丸める。
  // 以降の index は「区間の先頭から数えた番号」で、最後にシート上の番号へ戻す。
  const last = cell.frames - 1;
  const first = anim.range ? Math.min(Math.max(anim.range[0], 0), last) : 0;
  const stop = anim.range ? Math.min(Math.max(anim.range[1], first), last) : last;
  const count = stop - first + 1;

  // 先頭のコマを据え置く時間。0 でなければ、その間は 1 枚目のまま止まって見える
  // （溜めの絵を見せてから振る技用）。据え置きが明けてから再生が始まる。
  const delay = anim.delay ?? 0;
  const time = Math.max(0, anim.time - delay);

  let index;
  if (anim.stretch > 0) {
    // 技全体にアニメを引き伸ばす（据え置きぶんを除いた残りに収める）
    index = Math.floor((time / Math.max(1, anim.stretch - delay)) * count);
  } else {
    index = Math.floor((time * anim.fps) / 60);
  }

  if (anim.loop) index = ((index % count) + count) % count;
  else index = Math.min(count - 1, Math.max(0, index));

  // 後退歩きなどの逆再生
  if (anim.reverse) index = count - 1 - index;

  return { cell, index: first + index };
}

/**
 * キャラを 1 体描く。
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} sprite
 * @param {object} anim アニメ記述子
 * @param {number} screenX 足元の画面X
 * @param {number} screenY 足元の画面Y
 * @param {number} facing 1 = 右向き, -1 = 左向き
 * @param {number} zoom
 * @param {number} scale アニメ個別の表示倍率（素材ごとの大きさのばらつき補正）。
 *                       足元アンカーを原点に拡大するので、地面から浮くことはない。
 * @param {{images:CanvasImageSource[], div:number}|null} layer
 *        本体の代わりに重ねる別レイヤー（ビームの発光層など）。
 *        置き場所と大きさは本体とまったく同じで、**読み出す画像だけ**が変わる。
 *        レイヤーは 1/div に縮めてあるので、切り出し位置もそのぶん割る。
 */
export function drawFighterSprite(
  ctx, sprite, anim, screenX, screenY, facing, zoom, scale = 1, layer = null
) {
  const resolved = resolveFrame(anim, sprite);
  if (!resolved) return;
  const { cell, index } = resolved;

  // アトラスは 1 ワールド単位あたり texelsPerUnit テクセルで焼いてある。
  // 表示倍率はそのぶん割り戻す（見た目の大きさは焼き方に依存しない）。
  const z = (zoom * scale) / (sprite.texelsPerUnit || 1);
  const img = layer ? layer.images[cell.page] : sprite.images[cell.page];
  const div = layer ? layer.div : 1;
  ctx.save();
  ctx.translate(screenX, screenY);
  ctx.scale(facing < 0 ? -z : z, z);
  ctx.drawImage(
    img,
    (cell.x + index * cell.cw) / div,
    cell.y / div,
    cell.cw / div,
    cell.ch / div,
    -cell.ax,
    -cell.ay,
    cell.cw,
    cell.ch
  );
  ctx.restore();
}

/**
 * キャラ選択画面などで 1 コマだけ静止表示する用。
 */
export function drawStillFrame(ctx, sprite, animName, index, screenX, screenY, scale, facing = 1) {
  const cell = sprite.animations[animName];
  if (!cell) return;
  const i = Math.min(cell.frames - 1, Math.max(0, index));
  const z = scale / (sprite.texelsPerUnit || 1);
  ctx.save();
  ctx.translate(screenX, screenY);
  ctx.scale(facing < 0 ? -z : z, z);
  ctx.drawImage(
    sprite.images[cell.page],
    cell.x + i * cell.cw,
    cell.y,
    cell.cw,
    cell.ch,
    -cell.ax,
    -cell.ay,
    cell.cw,
    cell.ch
  );
  ctx.restore();
}
