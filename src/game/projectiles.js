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
   * 忍者の空中攻撃で落とすまきびし。
   *
   * **飛ばない飛び道具**。撃つのではなく落として置くもので、
   * 落ちて地面に刺さったらそこに居座り、踏んだ相手に当たる。
   * 「当たるまで飛んでいく」他の弾と違い、当たるかどうかを決めるのは
   * 撒いた側ではなく**踏むかどうか**なので、間合いそのものを狭める技になる。
   *
   * 場に 3 つまで（＝1 回ぶん）。魔法使いのホーミング弾と同じ考え方で、
   * 撒いたものが消えるか踏まれるまで次が出ない。これが無いと跳ぶたびに
   * 撒けて、5 秒ぶんが積み上がって地面が埋まる。
   */
  caltrop: {
    /** 見た目の大きさ。判定は box で別に持つ。 */
    radius: 16,
    /** 初速は 0。真下に落とすだけなので、速度は gravity だけが作る。 */
    speed: 0,
    turnRate: 0,
    /**
     * 落下加速度。キャラの GRAVITY(0.72) より軽くしてあるのは、
     * ばら撒いた粒がふわりと散って落ちる画にしたいため。
     * 判定には影響しない（着いた場所は origin.x で決まる）。
     */
    gravity: 0.5,
    /**
     * 空中を落ちている間の寿命。**着地した時点で restTicks に貼り替わる**ので、
     * これは「地面に着かないまま消える」保険でしかない
     * （空中で撒いてそのまま踏み合いになる、という状況を作らないため）。
     */
    lifetime: 300,
    /** 地面に着いたら止まって居座る。 */
    restOnGround: true,
    /**
     * 地面に着いてから消えるまで。5 秒。
     * 落ちるのに掛かる時間は撒いた高さで変わるので、**着地から**数える。
     * 「置いた罠が 5 秒もつ」の方が、撒く側にとっても踏む側にとっても読みやすい。
     */
    restTicks: 300,
    /** 場に 3 つまで ＝ ちょうど 1 回ぶん。 */
    maxAlive: 3,
    /** 落とし始める高さ（腰のあたり）。x は技側の spawns で 3 つに散らす。 */
    origin: { x: 0, y: 120 },
    /**
     * 踏んだと見なす範囲。**低く平たい**のが肝で、地面に接している相手にしか
     * 当たらない（やられ判定は足元 y=0 から始まるので、跳んでいれば上を越える）。
     * 横幅は相手のやられ判定（±38）と合わせて、またぐと引っかかる程度にしてある。
     */
    box: { w: 52, h: 34 },
    damage: 40,
    hitstun: 20,
    blockstun: 10,
    hitstop: 6,
    pushHit: 4,
    pushBlock: 2,
    /** 打撃扱い。スキルではないのでガードは通る。 */
    guardBreak: false,
    destroyOnHit: true,
    /**
     * 消えるときに何も出さない。
     *
     * 既定の `pop`（青い輪が広がる）は「弾が弾けた」ための演出で、
     * 5 秒経って引き上げるまきびしに出すと、**3 つ同時に大きな輪が開いて
     * 何かが起きたように見える**。切れることは消える手前の明滅で伝えてある。
     */
    popEffect: null,
    style: 'caltrop',
    /** 鉄の色。真っ白にすると紙細工に見えるので、少し曇らせてある。 */
    color: '#aab6cc',
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
    /**
     * 走る速さ。
     *
     * これが彼氏の強さそのもの。ダメージ 150・ガード不能・ダウン付きと
     * 当たったときの見返りが大きいぶん、**避ける時間が要る**。
     * 速いと呼ばれた時点で詰みになるので、
     * 見てから跳べる／しゃがめる速さまで落としてある。
     */
    speed: 7.5,
    turnRate: 0,
    /**
     * 寿命。実際は走り抜けた先の画面外で消えるので、これは保険。
     * 足が遅く、途中で滑って止まる間もあるぶん、
     * ステージを渡り切る前に消えないよう長めに取ってある
     * （壁際から反対の端まで、滑り込みを入れて約 315 フレーム）。
     */
    lifetime: 360,
    /** 同時に 1 人まで。走っている間は次を呼べない。 */
    maxAlive: 1,
    /** 画面外の後ろから走り込んでくる。 */
    origin: { x: -300, y: 0 },
    /**
     * **彼氏は画面外から来る。** 弾と同じに画面外で消すと、壁際
     * （端から 300 以内）で呼んだ彼氏は出た瞬間に消えて、
     * スキルがまるごと空振りになる。
     * これを立てると、消えるのは走っていく先の画面外に出たときだけになる。
     */
    entersOffStage: true,
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
    /**
     * 走りの再生速度。**進む速さと釣り合っていないと地面を滑って見える。**
     * 速度 7.5 に合わせて 13fps（8 コマ ≒ 37px/歩）。
     */
    animFps: 13,
    /**
     * 突進シートのコマ数と再生速度。8 コマを 22fps ＝ 約 22 フレームで出し切る。
     * 相手に触るのは間合い 190 から 90 ほど詰めたところ＝速度 7.5 で約 13 フレーム。
     * 踏み込みの途中で当たり、当たらなければ最終コマまで踏み込んでから滑る。
     *
     * コマ数をアトラスから読まずここに持っているのは、
     * **滑り出すタイミングを sim が決めるから**。描画の都合で
     * アセットを差し替えたら当たり方まで変わる、という繋がりを作りたくない。
     */
    tackleFrames: 8,
    tackleFps: 22,
    /**
     * 突進の最終コマまで来たら、そのコマのまま慣性で地面を滑る。
     * 1ティックごとに速さへ掛ける係数と、これを下回ったら止まったとみなす速さ。
     * 0.9 だと止まるまで約 23 フレーム・約 85px 滑る。
     */
    slideFriction: 0.9,
    slideStopSpeed: 0.8,
    /** 止まってから走り出すまでの間。一拍置くと「止まった」ことが見て取れる。 */
    stopTicks: 8,
    /** 走り出しの加速。元の速さに戻るまで約 10 フレーム。 */
    runAccel: 0.9,
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
     * 体当たりして、滑って止まって、また走り去る形にしてある。
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

/**
 * 消えるときに出す演出の type。既定は弾けたことを見せる `pop`。
 * `popEffect: null` と書いた飛び道具は何も出さない（まきびし）。
 */
export function popEffectOf(def) {
  return def.popEffect === undefined ? 'pop' : def.popEffect;
}

export function getProjectileDef(type) {
  const def = PROJECTILES[type];
  if (!def) throw new Error(`未登録の飛び道具です: ${type}`);
  return def;
}

/**
 * 突進の最終コマに入るティック。彼氏はここから慣性で滑り始める。
 * コマ index は floor(経過 × fps / 60) なので、最終コマ（frames-1）の頭はこれ。
 */
export function lungeSlideTick(def) {
  return Math.ceil(((def.tackleFrames - 1) * 60) / def.tackleFps);
}

/**
 * 走ってくる彼氏の足取り。突進に入ってからの 3 段階を進める。
 *
 * | 段階 | 動き | 絵 |
 * |---|---|---|
 * | 突進 | 速さそのまま踏み込む | 突進シートを頭から 1 回 |
 * | 滑り | 最終コマのまま慣性で滑って止まる | 突進シートの最終コマで固定 |
 * | 走り抜け | 一拍おいて加速し、走り去る | 走りシートに戻る |
 *
 * 滑りの間も判定は生きている（`spent` が立つまで）。踏み込みで空振っても、
 * 滑り込んだ先で当たることがある。
 *
 * 速さを直に減衰させているだけで、位置の更新は呼び出し側（sim）に任せている。
 */
export function stepLunge(p, def) {
  // まだ走ってくる途中、あるいは突進を持たない飛び道具
  if (p.lungeAge < 0 || !(def.tackleFrames > 0)) return;

  if (p.lungeDone) {
    // 走り出し。元の速さまで戻したら、あとは等速で走り抜ける
    const goal = p.facing * def.speed;
    if (p.vx < goal) p.vx = Math.min(goal, p.vx + def.runAccel);
    else if (p.vx > goal) p.vx = Math.max(goal, p.vx - def.runAccel);
    return;
  }

  // 突進の踏み込み中は速さを落とさない
  if (p.lungeAge < lungeSlideTick(def)) return;

  if (p.vx !== 0) {
    // 最終コマ。地面を慣性で滑る
    p.vx *= def.slideFriction;
    if (Math.abs(p.vx) < def.slideStopSpeed) {
      p.vx = 0;
      p.stopAge = 0;
    }
    return;
  }

  // 止まっている間。一拍おいてから走り出す
  p.stopAge += 1;
  if (p.stopAge >= def.stopTicks) p.lungeDone = true;
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
