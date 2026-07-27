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

/** ビームの持続判定。長い矩形を一定間隔で当て直して「照射され続けている」感を出す。 */
function beamTick(start, group) {
  return {
    start,
    end: start + 4,
    box: { x: 52, y: 74, w: 1000, h: 98 },
    damage: 32,
    hitstun: 12,
    hitstop: 3,
    pushHit: 2.2,
    guardBreak: true,
    group,
  };
}

export default {
  id: 'mage',
  name: '魔法使い',
  subtitle: '遠距離型 / 弾幕と極太ビーム',
  themeColor: '#b070ff',

  health: 900,
  walkSpeed: 2.8,
  dashSpeed: 6.4,
  jumpVy: 13.0,
  jumpVx: 4.2,
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
      spawns: [{ frame: 24, type: 'beam', duration: 40 }],
      hits: [beamTick(26, 0), beamTick(33, 1), beamTick(40, 2), beamTick(47, 3), beamTick(54, 4)],
      // 撃っている間は踏ん張って動かない
      motion: [],
    },
  }),
};
