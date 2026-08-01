/**
 * 魔法使い — 距離を取って弾で削る遠距離型。
 *
 *   攻撃: 「ホーミング弾」(castシート) 相手を追尾する弾。押すたびに連射できる。
 *   スキル: 「極太照射ビーム」(beamシート) 画面端まで届く極太の光線。
 *           ガードを崩すが、撃ち始めから終わりまで非常に長く動けない。
 *   空中攻撃: 「降魔弾」(castシート) 斜め下へ撃ち落とす弾。
 *   空中スキル: 「浮遊照射」(beamシート) その場に浮き止まったまま極太ビームを撃つ。
 *
 * 走りモーションが無いシートなので、ダッシュには浮遊(fly)を割り当てている。
 */
import { defineMoves } from '../moves.js';
import { jumpVyForHeight } from '../constants.js';

/** 見た目の身長（ワールド単位）。ジャンプ高もここから決める。 */
const HEIGHT = 212;

/**
 * 杖の先端（足元原点・前方向が正）。beam シートで水晶が来る位置の実測値で、
 * 照射中の 5〜8 コマ目はほぼここに収まっている。
 * ビームは判定も見た目もこの点を中心に出す。
 */
const STAFF_TIP = { x: 93, y: 156 };

/** ビームの太さ（中心から上下それぞれ）。 */
const BEAM_HALF_HEIGHT = 49;

/** ビームの長さ。ステージ端まで届く。 */
const BEAM_LENGTH = 1000;

/**
 * ビームの持続判定。長い矩形を一定間隔で当て直して「照射され続けている」感を出す。
 * 最終打だけ knockdown を持たせ、照射しきったところで倒す。
 * （途中の打でダウンさせると無敵になって残りが当たらないため、最後の1打だけ）
 */
function beamTick(start, group, knockdown = false) {
  return {
    start,
    end: start + 4,
    box: {
      x: STAFF_TIP.x,
      y: STAFF_TIP.y - BEAM_HALF_HEIGHT,
      w: BEAM_LENGTH,
      h: BEAM_HALF_HEIGHT * 2,
    },
    damage: 32,
    hitstun: 12,
    hitstop: knockdown ? 8 : 3,
    pushHit: knockdown ? 7 : 2.2,
    guardBreak: true,
    knockdown,
    group,
  };
}

export default {
  id: 'mage',
  name: '魔法使い',
  subtitle: '遠距離型 / 弾幕と極太ビーム',
  themeColor: '#b070ff',

  health: 900,
  // 移動は他の 2 人の 3 分の 2。剣士と狂戦士の平均（歩き 3.25 / ダッシュ 7.25 /
  // ジャンプ 4.6）に 2/3 を掛けた値。距離を取る側なので足の遅さが弱点になる。
  walkSpeed: 2.2,
  dashSpeed: 4.8,
  /** 自分の身長ぶん跳べる初速。2段目は AIR_JUMP_VY_SCALE 倍。 */
  jumpVy: jumpVyForHeight(HEIGHT),
  jumpVx: 3.1,
  weight: 0.9,

  anims: {
    idle: 'idle',
    walk: 'walk',
    dash: 'fly', // 走りが無いので浮遊で代用
    jump: 'jump',
    fall: 'fall',
    land: 'land',
    guard: 'guard',
    crouch: 'crouch',
    hurt: 'hurt',
    death: 'death',
    /** 掴まれている姿。淫魔の吸血に捕らえられたときに使う。 */
    grabbed: 'grabbed',
  },

  /**
   * ガード中に前へ張る光の壁（見た目だけ。判定・ダメージには影響しない）。
   * 足元原点・前方向が正で、中心と大きさを指定する。
   */
  guardWall: { x: 80, y: 108, w: 48, h: 212, color: 'rgba(165, 220, 255, 0.9)' },

  attackMove: 'bolt',
  skillMove: 'beamCharge',
  airAttackMove: 'meteorShot',
  airSkillMove: 'hoverBeamCharge',

  moves: defineMoves({
    // 追尾弾。撃ち終わり際にもう一度攻撃を押すと繋がるので連射になる。
    bolt: {
      label: 'ホーミング弾',
      anim: 'cast',
      total: 26,
      animFps: 20,
      spawns: [{ frame: 11, type: 'bolt' }],
      chains: [{ from: 15, to: 25, button: 'attack', move: 'bolt' }],
    },

    // スキル: 溜めてから長時間照射する。撃つ前に潰されると何もできない。
    //
    // 「溜め」と「照射」で 2 つに分けてある。beam シートの前半 4 コマ（構え → 溜め）を
    // まるまる 1 秒かけて見せてから、後半 4 コマの照射へ移る。
    // 1 秒という長さは、相手が魔法陣を見てからしゃがみ（CROUCH_TICKS）や
    // 移動で逃げるのに十分な時間として取ってある。ビームはガード不能なので、
    // 「見てから避けられる」ことがこの技の成立条件になる。
    beamCharge: {
      label: '極太照射ビーム',
      anim: 'beam',
      animRange: [0, 3],
      // 4コマを 4fps ＝ ちょうど 60 フレーム（1秒）。判定も移動も無い丸腰。
      total: 60,
      animFps: 4,
      // 足元の魔法陣。これが撃つ合図になる
      spawns: [{ frame: 0, type: 'magicCircle', duration: 62, radius: 104 }],
      // 構えた時点で場の追尾弾は霧散する。弾で足止めしてから照射、が通らない
      clearsOwnProjectiles: true,
      onEnd: 'beam',
    },

    beam: {
      label: '極太照射ビーム（照射）',
      anim: 'beam',
      // 溜めで構えは終わっているので、ここは照射のコマだけ
      animRange: [4, 7],
      total: 50,
      animFps: 7,
      // 見た目のビームにも判定と同じ原点・太さ・長さを渡す。
      // 描画側が別に数値を持つと、判定と光線がずれていくため
      spawns: [
        {
          frame: 0,
          type: 'beam',
          // 判定は 34 フレーム目まで出るが、ヒットのたびにヒットストップで
          // 技のフレームが止まる（3×4 + 8 ＝ 20）。光線はその止まった時間も
          // 含めて出しておかないと、当てている最中に消えてしまう。
          duration: 58,
          origin: STAFF_TIP,
          halfHeight: BEAM_HALF_HEIGHT,
          length: BEAM_LENGTH,
          shake: 6,
        },
      ],
      hits: [
        beamTick(2, 0),
        beamTick(9, 1),
        beamTick(16, 2),
        beamTick(23, 3),
        beamTick(30, 4, true), // 最終打でダウン
      ],
      // 撃っている間は踏ん張って動かない
      motion: [],
    },

    // 空中攻撃: 斜め下へ撃ち落とす弾。跳んだ勢いはそのままなので、
    // 飛び越しざまに置いていける。地上の弾と違って追尾はしない。
    meteorShot: {
      label: '降魔弾',
      anim: 'cast',
      total: 30,
      animFps: 18,
      spawns: [{ frame: 11, type: 'meteor', dir: { x: 0.6, y: -1 } }],
    },

    // 空中スキル: 空中でぴたりと止まり、そこから極太ビームを撃つ。
    //
    // 撃っている間は落下も横移動も止まる（motion の vy: 0 が重力を打ち消す）。
    // 止まる高さは「ジャンプしてから何フレーム目に押したか」でそのまま決まるので、
    //   低空で撃つ → 地上の相手を薙ぎ払う
    //   高めで撃つ → 飛んできた相手を撃ち落とす
    // という撃ち分けになる。そのぶん、外すと空中に静止した的になる。
    // 地上版と同じく、溜め（1秒）と照射で 2 つに分けてある。
    // 溜めている間から浮き止まるので、魔法陣が空中に浮かんだまま静止する。
    hoverBeamCharge: {
      label: '浮遊照射',
      anim: 'beam',
      animRange: [0, 3],
      total: 60,
      animFps: 4,
      landLag: 20,
      spawns: [{ frame: 0, type: 'magicCircle', duration: 62, radius: 92 }],
      // 地上版と同じく、構えた時点で場の弾は霧散する
      clearsOwnProjectiles: true,
      // vy: 0 で重力を打ち消し、溜めているあいだその場に浮き止まる
      motion: [{ start: 0, end: 59, vx: 0, vy: 0 }],
      onEnd: 'hoverBeam',
    },

    hoverBeam: {
      label: '浮遊照射（照射）',
      anim: 'beam',
      animRange: [4, 7],
      total: 46,
      animFps: 8,
      landLag: 20,
      spawns: [
        {
          frame: 0,
          type: 'beam',
          // 地上版と同じく、ヒットストップぶん（3×3 + 8 ＝ 17）を足した長さ
          duration: 46,
          origin: STAFF_TIP,
          halfHeight: BEAM_HALF_HEIGHT,
          length: BEAM_LENGTH,
          shake: 5,
        },
      ],
      hits: [
        beamTick(2, 0),
        beamTick(9, 1),
        beamTick(16, 2),
        beamTick(23, 3, true), // 最終打でダウン
      ],
      // 撃ち終わるまで浮き止まったまま。終わると重力が戻って落ちる
      motion: [{ start: 0, end: 34, vx: 0, vy: 0 }],
    },
  }),
};
