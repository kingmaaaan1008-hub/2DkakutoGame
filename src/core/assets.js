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
 * @returns {{id:string, image:HTMLImageElement, animations:object, height:number}}
 */
export async function loadCharacterSprites(id) {
  const manifest = await loadJson(`${CHARACTER_DIR}/${id}.json`);
  const image = await loadImage(`${CHARACTER_DIR}/${manifest.image}`);
  return { ...manifest, image };
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
