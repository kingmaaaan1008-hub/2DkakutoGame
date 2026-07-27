/**
 * 剣士 — バランス型。リーチと連携で戦う。
 *
 *   攻撃: 1段目「横切り」(attack2シート)、続けて攻撃ボタンで「盾切り」(attackシート)
 *   スキル: 「タックル」(tackleシート) 突進してガードを崩す。外すと隙が大きい。
 */
import { defineMoves } from '../moves.js';

export default {
  id: 'swordsman',
  name: '剣士',
  subtitle: 'バランス型 / 二段斬り',
  themeColor: '#4f9bff',

  health: 1000,
  walkSpeed: 3.1,
  dashSpeed: 6.9,
  jumpVy: 13.6,
  jumpVx: 4.4,
  /** 大きいほど吹き飛びにくい。 */
  weight: 1.0,

  /** 状態 → アトラスのアニメ名。シートに無い動きは近いもので代用する。 */
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

  /** 攻撃ボタン・スキルボタンで出る技。 */
  attackMove: 'slash1',
  skillMove: 'tackle',

  moves: defineMoves({
    // 1段目。発生が早く、ここから盾切りへ繋ぐ。
    slash1: {
      label: '横切り',
      anim: 'attack2',
      total: 30,
      hits: [
        {
          start: 11,
          end: 15,
          box: { x: 34, y: 74, w: 140, h: 92 },
          damage: 62,
          hitstun: 19,
          blockstun: 12,
          hitstop: 7,
          chip: 3,
          pushHit: 5.5,
          pushBlock: 3.4,
        },
      ],
      motion: [{ start: 9, end: 13, vx: 2.4 }],
      // ヒットしてもガードされても繋がる。空振りからも繋がるが隙は残る。
      chains: [{ from: 12, to: 27, button: 'attack', move: 'slash2' }],
    },

    // 2段目。踏み込みが深く、ガードさせても有利。
    slash2: {
      label: '盾切り',
      anim: 'attack',
      total: 38,
      hits: [
        {
          start: 15,
          end: 20,
          box: { x: 30, y: 52, w: 158, h: 126 },
          damage: 98,
          hitstun: 25,
          blockstun: 15,
          hitstop: 9,
          chip: 6,
          pushHit: 8,
          pushBlock: 5,
        },
      ],
      motion: [{ start: 12, end: 17, vx: 3.4 }],
    },

    // スキル: ガード不能の突進。当たれば大きく吹き飛ばす。
    tackle: {
      label: 'タックル',
      anim: 'tackle',
      total: 54,
      animFps: 14,
      hits: [
        {
          start: 16,
          end: 32,
          box: { x: 14, y: 34, w: 128, h: 150 },
          damage: 138,
          hitstun: 34,
          hitstop: 11,
          pushHit: 11,
          guardBreak: true,
        },
      ],
      // 当てたらそこで止まる。空振りすると走り抜けて大きな隙になる。
      motion: [{ start: 14, end: 32, vx: 9.6, stopOnHit: true }],
    },
  }),
};
