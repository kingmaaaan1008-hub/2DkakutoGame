/**
 * 狂戦士 — 手数と圧力で押し切るインファイター。
 *
 *   攻撃: 「乱舞」(rampage3シート) 4段の連続斬り。前進しながら暴れる。
 *   スキル: 「突き」(attackシート) 長い踏み込みからの一撃。ガードを崩す。
 */
import { defineMoves } from '../moves.js';

/** 乱舞の中段。同じ形の判定を group だけ変えて並べる。 */
function flurryHit(start, group) {
  return {
    start,
    end: start + 3,
    box: { x: 26, y: 66, w: 136, h: 92 },
    damage: 30,
    hitstun: 14,
    blockstun: 9,
    hitstop: 4,
    chip: 2,
    pushHit: 1.4,
    pushBlock: 1.1,
    group,
  };
}

export default {
  id: 'berserker',
  name: '狂戦士',
  subtitle: '突撃型 / 多段攻撃',
  themeColor: '#ff7043',

  health: 1050,
  walkSpeed: 3.4,
  dashSpeed: 7.6,
  jumpVy: 13.2,
  jumpVx: 4.8,
  weight: 1.1,

  anims: {
    idle: 'idle',
    walk: 'walk',
    dash: 'run',
    jump: 'jump',
    fall: 'fall',
    land: 'land',
    guard: 'guard',
    hurt: 'hurt',
    death: 'death',
  },

  attackMove: 'rampage',
  skillMove: 'thrust',

  moves: defineMoves({
    // 4段。前3段は削り重視、最後の1段でまとめて吹き飛ばす。
    rampage: {
      label: '乱舞',
      anim: 'rampage3',
      total: 54,
      animFps: 13,
      hits: [
        flurryHit(10, 0),
        flurryHit(17, 1),
        flurryHit(24, 2),
        {
          start: 32,
          end: 37,
          box: { x: 30, y: 54, w: 168, h: 116 },
          damage: 56,
          hitstun: 26,
          blockstun: 14,
          hitstop: 9,
          chip: 5,
          pushHit: 8.5,
          pushBlock: 5,
          group: 3,
        },
      ],
      // じりじり前に出ながら振り回す
      motion: [{ start: 8, end: 32, vx: 1.5 }],
    },

    // スキル: 深く踏み込む刺突。リーチが長い代わりに戻りが遅い。
    thrust: {
      label: '突き',
      anim: 'attack',
      total: 52,
      animFps: 12,
      hits: [
        {
          start: 18,
          end: 27,
          box: { x: 36, y: 72, w: 196, h: 74 },
          damage: 146,
          hitstun: 34,
          hitstop: 12,
          pushHit: 10,
          guardBreak: true,
        },
      ],
      motion: [{ start: 16, end: 27, vx: 6.6, stopOnHit: true }],
    },
  }),
};
