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
    /**
     * 1ティックあたり、どれだけ相手方向へ向きを寄せるか。1.0 で即座に真っ直ぐ向く。
     * 曲がりが強いと避ける余地が無くなるので、ジャンプで抜けられる程度に抑えてある。
     */
    turnRate: 0.05,
    lifetime: 160,
    /**
     * 同時に出しておける数。連射そのものは残しつつ、撃ち切ると弾切れの間が空く。
     * これが無いと寿命 160F ÷ 連射間隔 16F で常時 10 発が浮き、
     * 相手に近づく隙間が無くなる。
     *
     * 1 発。撃った弾が消えるか当たるまで次が出ないので、
     * 弾幕を張って近づけないようにする戦い方はできない。
     */
    maxAlive: 1,
    /**
     * 発生位置（足元原点・前方向が正）。杖の先端。
     * cast シートで弾が出る 5 コマ目の水晶の位置の実測値。杖を頭上に掲げた形なので
     * 背丈(212)より高いところから出て、追尾しながら降りてくる。
     */
    origin: { x: 35, y: 248 },
    damage: 46,
    hitstun: 16,
    blockstun: 11,
    hitstop: 5,
    pushHit: 3.4,
    pushBlock: 2,
    guardBreak: false,
    /** 当たったら消える。貫通弾を作るならここを false に。 */
    destroyOnHit: true,
    /** 見た目のためのヒント。renderer が色と形を決める。 */
    style: 'orb',
    color: '#7fe4ff',
  },

  /**
   * 魔法使いの空中攻撃「降魔弾」。
   * 空中から斜め下へ撃ち落とす。追尾しないぶん速く、地面に届くと消える。
   * 空中攻撃なので、地上の弾と同じくガードは通る。
   */
  meteor: {
    radius: 24,
    speed: 10.5,
    turnRate: 0,
    lifetime: 90,
    /** 同時に出せる数。跳ぶたびに 1〜2 発、という手数に収める。 */
    maxAlive: 2,
    origin: { x: 30, y: 160 },
    /** この高さより下へ落ちたら消える（地面で弾ける）。 */
    floorY: 8,
    damage: 60,
    hitstun: 22,
    blockstun: 12,
    hitstop: 7,
    pushHit: 5,
    pushBlock: 3,
    guardBreak: false,
    destroyOnHit: true,
    style: 'orb',
    color: '#ff9a5a',
  },
};

/** 飛び道具として登録されている type か。外れたものは見た目エフェクト扱いになる。 */
export function isProjectile(type) {
  return Object.prototype.hasOwnProperty.call(PROJECTILES, type);
}

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
