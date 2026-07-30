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

  /**
   * 女子高生のスマホカメラから出るレーザー。
   * 追尾せず、撃った向きへ一直線に飛ぶ。曲がらないぶん速く、判定も細長い。
   */
  laser: {
    radius: 16,
    speed: 13.5,
    turnRate: 0,
    lifetime: 130,
    /** 場に 2 本まで。真っ直ぐで避けやすいので、弾より少し多く出せる。 */
    maxAlive: 2,
    /**
     * 発射位置（足元原点・前方向が正）。**スマホのカメラのレンズ**に合わせてある。
     * photo シートの発射コマ（コマ4）で、掲げたスマホは足元から
     * およそ x=42〜52 / y=152〜180。その前端やや上がレンズなので、
     * そこから少し前に出した位置を発射点にしている
     * （スマホの中心に置くと、光が本体に被って手元が潰れる）。
     */
    origin: { x: 58, y: 170 },
    /** 細い判定。頭の高さを薙ぐので、しゃがめば下をくぐれる。 */
    box: { w: 104, h: 13 },
    damage: 52,
    hitstun: 18,
    blockstun: 11,
    hitstop: 5,
    pushHit: 4,
    pushBlock: 2.4,
    guardBreak: false,
    destroyOnHit: true,
    style: 'beam',
    color: '#ff6fd0',
  },

  /**
   * 女子高生のスキルで走ってくる彼氏。
   *
   * 見た目も判定も人ひとりぶんなので、飛び道具の枠で扱いつつ
   * 専用のスプライトで描く（style: 'sprite'）。後ろから走ってきて、
   * 相手に当たるかステージ端まで走り抜けたら消える。
   */
  boyfriend: {
    radius: 46,
    speed: 11.5,
    turnRate: 0,
    lifetime: 150,
    /** 同時に 1 人まで。走っている間は次を呼べない。 */
    maxAlive: 1,
    /** 画面外の後ろから走り込んでくる。 */
    origin: { x: -300, y: 0 },
    /** 人ひとりぶんの判定。足元原点で、腰から頭までを覆う。 */
    box: { w: 110, h: 190, y: 8 },
    /** 描画に使うアトラスと、走り／タックルのアニメ名。 */
    style: 'sprite',
    sheet: 'boyfriend',
    anims: { run: 'run', hit: 'tackle' },
    /**
     * 相手までこの距離に入ったらタックルの構えに切り替える。
     * 経過フレームではなく**相手との距離**で切り替えるので、
     * どこで呼んでも「走ってきて、届く直前に跳び込む」形になる。
     */
    tackleRange: 190,
    animFps: 16,
    damage: 150,
    hitstun: 34,
    blockstun: 16,
    hitstop: 12,
    pushHit: 12,
    pushBlock: 6,
    /** 体当たりなのでガードごと持っていく（スキルはガードを崩せる、の枠）。 */
    guardBreak: true,
    knockdown: true,
    /**
     * 当たっても消えずに走り抜ける。
     * ぶつかった瞬間に消えると「弾が当たった」ようにしか見えないので、
     * 体当たりしてそのまま走り去る形にしてある。
     * 判定は一度当てたところで切れる（走り抜けながら何度も当たらない）。
     */
    destroyOnHit: false,
    /**
     * 呼んだ位置に関係なく、必ず地面を走る。
     * 空中で呼んでも彼氏は空を走らない。
     */
    groundBound: true,
    color: '#7ea6ff',
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
