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

  const count = cell.frames;
  let index;
  if (anim.stretch > 0) {
    // 技全体にアニメを引き伸ばす
    index = Math.floor((anim.time / anim.stretch) * count);
  } else {
    index = Math.floor((anim.time * anim.fps) / 60);
  }

  if (anim.loop) index = ((index % count) + count) % count;
  else index = Math.min(count - 1, Math.max(0, index));

  // 後退歩きなどの逆再生
  if (anim.reverse) index = count - 1 - index;

  return { cell, index };
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
 */
export function drawFighterSprite(ctx, sprite, anim, screenX, screenY, facing, zoom) {
  const resolved = resolveFrame(anim, sprite);
  if (!resolved) return;
  const { cell, index } = resolved;

  ctx.save();
  ctx.translate(screenX, screenY);
  ctx.scale(facing < 0 ? -zoom : zoom, zoom);
  ctx.drawImage(
    sprite.image,
    cell.x + index * cell.cw,
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

/**
 * キャラ選択画面などで 1 コマだけ静止表示する用。
 */
export function drawStillFrame(ctx, sprite, animName, index, screenX, screenY, scale, facing = 1) {
  const cell = sprite.animations[animName];
  if (!cell) return;
  const i = Math.min(cell.frames - 1, Math.max(0, index));
  ctx.save();
  ctx.translate(screenX, screenY);
  ctx.scale(facing < 0 ? -scale : scale, scale);
  ctx.drawImage(
    sprite.image,
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
