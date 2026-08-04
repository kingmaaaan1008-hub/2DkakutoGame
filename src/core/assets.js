/**
 * アセット読み込み。
 *
 * キャラ 1 体につき「アトラス画像 1 枚 + マニフェスト JSON 1 個」。
 * マニフェストは tools/build-assets.ps1 が生成したもので、アニメごとに
 * セル寸法とアンカー（足元の座標）が入っている。
 */

const CHARACTER_DIR = 'assets/characters';

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`画像を読み込めません: ${url}`));
    img.src = url;
  });
}

async function loadJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} の取得に失敗しました (${res.status})`);
  return res.json();
}

/**
 * 1 キャラ分のスプライトを読む。
 *
 * アトラスは複数ページに分かれている。1 枚にまとめると 1 画像あたり
 * 30Mpx を超えて iOS Safari がデコードを拒むため、ビルド側で 8Mpx ごとに
 * 割ってある。どのアニメがどのページに載っているかは animations[].page。
 *
 * @returns {{id:string, images:HTMLImageElement[], animations:object, height:number}}
 */
export async function loadCharacterSprites(id) {
  const manifest = await loadJson(`${CHARACTER_DIR}/${id}.json`);
  const images = await Promise.all(
    manifest.images.map((file) => loadImage(`${CHARACTER_DIR}/${file}`))
  );
  return { ...manifest, images };
}

/**
 * 複数キャラをまとめて読み、進捗を返す。
 * @param {string[]} ids
 * @param {(done:number, total:number)=>void} [onProgress]
 */
export async function loadAllCharacterSprites(ids, onProgress) {
  const out = {};
  let done = 0;
  await Promise.all(
    ids.map(async (id) => {
      out[id] = await loadCharacterSprites(id);
      done += 1;
      onProgress?.(done, ids.length);
    })
  );
  return out;
}
