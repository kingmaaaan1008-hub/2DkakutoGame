/**
 * 飛び道具の定義。
 *
 * 技データの `spawns: [{ frame, type }]` から生成される。
 * 種類を増やしたいときはここに 1 エントリ足して、技側で type を指すだけでよい。
 *
 * 追尾の計算に三角関数を使っていないのは意図的。Math.sin/atan2 は
 * 実装ごとに最下位ビットがずれうるので、オンライン対戦で同じ結果を保証したい
 * シミュレーション内ではベクトル演算と Math.sqrt だけで完結させている。
 */

export const PROJECTILES = {
  /** 魔法使いのホーミング弾。ゆるやかに相手を追う。 */
  bolt: {
    radius: 20,
    speed: 7.2,
    /** 1ティックあたり、どれだけ相手方向へ向きを寄せるか。1.0 で即座に真っ直ぐ向く。 */
    turnRate: 0.075,
    lifetime: 160,
    /** 発生位置（足元原点・前方向が正）。杖の先あたり。 */
    origin: { x: 62, y: 132 },
    damage: 46,
    hitstun: 16,
    blockstun: 11,
    hitstop: 5,
    chip: 4,
    pushHit: 3.4,
    pushBlock: 2,
    guardBreak: false,
    /** 当たったら消える。貫通弾を作るならここを false に。 */
    destroyOnHit: true,
    /** 見た目のためのヒント。renderer が色と形を決める。 */
    style: 'orb',
    color: '#7fe4ff',
  },
};

export function getProjectileDef(type) {
  const def = PROJECTILES[type];
  if (!def) throw new Error(`未登録の飛び道具です: ${type}`);
  return def;
}

/**
 * 追尾処理。速度ベクトルを目標方向へ少しずつ寄せ、速さは一定に保つ。
 * @param {{vx:number,vy:number}} p
 * @param {number} tx 目標X
 * @param {number} ty 目標Y
 */
export function homeToward(p, tx, ty, def) {
  const dx = tx - p.x;
  const dy = ty - p.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist < 0.001) return;

  // 目標方向の単位ベクトルへ turnRate だけ補間する
  const nx = p.vx + (dx / dist) * def.speed * def.turnRate;
  const ny = p.vy + (dy / dist) * def.speed * def.turnRate;
  const len = Math.sqrt(nx * nx + ny * ny);
  if (len < 0.001) return;

  p.vx = (nx / len) * def.speed;
  p.vy = (ny / len) * def.speed;
}
