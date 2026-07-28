/**
 * 魔法使い — 距離を取って弾で削る遠距離型。
 *
 *   攻撃: 「ホーミング弾」(castシート) 相手を追尾する弾。押すたびに連射できる。
 *   スキル: 「極太照射ビーム」(beamシート) 画面端まで届く極太の光線。
 *           ガードを崩すが、撃ち始めから終わりまで非常に長く動けない。
 *
 * 走りモーションが無いシートなので、ダッシュには浮遊(fly)を割り当てている。
 */
import { defineMoves } from '../moves.js';

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
  jumpVy: 13.0,
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
    hurt: 'hurt',
    death: 'death',
  },

  /**
   * ガード中に前へ張る光の壁（見た目だけ。判定・ダメージには影響しない）。
   * 足元原点・前方向が正で、中心と大きさを指定する。
   */
  guardWall: { x: 80, y: 108, w: 48, h: 212, color: 'rgba(165, 220, 255, 0.9)' },

  attackMove: 'bolt',
  skillMove: 'beam',

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
    beam: {
      label: '極太ビーム',
      anim: 'beam',
      total: 82,
      animFps: 9,
      // 見た目のビームにも判定と同じ原点・太さ・長さを渡す。
      // 描画側が別に数値を持つと、判定と光線がずれていくため
      spawns: [
        {
          frame: 24,
          type: 'beam',
          duration: 40,
          origin: STAFF_TIP,
          halfHeight: BEAM_HALF_HEIGHT,
          length: BEAM_LENGTH,
          shake: 6,
        },
      ],
      hits: [
        beamTick(26, 0),
        beamTick(33, 1),
        beamTick(40, 2),
        beamTick(47, 3),
        beamTick(54, 4, true), // 最終打でダウン
      ],
      // 撃っている間は踏ん張って動かない
      motion: [],
    },
  }),
};
