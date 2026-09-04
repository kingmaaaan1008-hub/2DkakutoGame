/**
 * 狂戦士 — 手数と圧力で押し切るインファイター。
 *
 *   攻撃: 「乱舞」(rampage3シート) 4段の連続斬り。前進しながら暴れる。
 *   スキル: 「突き」(attackシート) 長い踏み込みからの一撃。ガードを崩す。
 *   空中攻撃: 「空中乱舞」(rampage1シート) 2段。
 *   空中スキル: 「かかと落とし」(rampage2シート) 斜め下へ落ちる。外すと着地硬直が長い。
 */
import { defineMoves } from '../moves.js';
import { jumpVyForHeight } from '../constants.js';

/** 見た目の身長（ワールド単位）。ジャンプ高もここから決める。 */
const HEIGHT = 225;

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
    pushHit: 1.4,
    pushBlock: 1.1,
    group,
  };
}

export default {
  id: 'berserker',
  name: '狂戦士',
  subtitle: '乱舞',
  themeColor: '#ff7043',

  health: 1050,
  walkSpeed: 3.4,
  dashSpeed: 7.6,
  /** 自分の身長ぶん跳べる初速。2段目は AIR_JUMP_VY_SCALE 倍。 */
  jumpVy: jumpVyForHeight(HEIGHT),
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
    crouch: 'crouch',
    hurt: 'hurt',
    death: 'death',
    /** 掴まれている姿。サキュバスの吸血に捕らえられたときに使う。 */
    grabbed: 'grabbed',
  },

  attackMove: 'rampage',
  skillMove: 'thrust',
  airAttackMove: 'airRampage',
  airSkillMove: 'axeKick',

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
          pushHit: 8.5,
          pushBlock: 5,
          group: 3,
        },
      ],
      // じりじり前に出ながら振り回す
      motion: [{ start: 8, end: 32, vx: 1.5 }],
    },

    // スキル: その場からの刺突。当たればダウンを奪えるが、戻りが遅い。
    // 前には出ない。間合いは踏み込みではなく判定の長さで取る。
    thrust: {
      label: '突き',
      anim: 'attack',
      total: 52,
      animFps: 12,
      hits: [
        {
          start: 18,
          end: 27,
          // 前方 166 まで。刃先が一番伸びる 6 コマ目の実測値に合わせてある
          // （判定が出ている 18〜27F は 4〜6 コマ目にあたる）
          box: { x: 36, y: 72, w: 130, h: 74 },
          damage: 146,
          hitstun: 34,
          hitstop: 12,
          pushHit: 10,
          guardBreak: true,
          knockdown: true,
        },
      ],
    },

    // 空中攻撃: 落ちながら 2 回振る。地上の乱舞と同じく、当たれば連続ヒットになる。
    airRampage: {
      label: '空中乱舞',
      anim: 'rampage1',
      total: 34,
      animFps: 16,
      hits: [
        {
          start: 8,
          end: 12,
          box: { x: 20, y: -14, w: 142, h: 178 },
          damage: 40,
          hitstun: 18,
          blockstun: 11,
          hitstop: 5,
          pushHit: 2.2,
          pushBlock: 1.6,
          group: 0,
        },
        {
          start: 16,
          end: 21,
          box: { x: 24, y: -14, w: 150, h: 178 },
          damage: 62,
          hitstun: 24,
          blockstun: 13,
          hitstop: 8,
          pushHit: 6,
          pushBlock: 4,
          group: 1,
        },
      ],
    },

    // 空中スキル: 踵から斜め下へ落ちる。ガードごと崩してダウンを奪う。
    axeKick: {
      label: 'かかと落とし',
      anim: 'rampage2',
      total: 46,
      animFps: 15,
      landLag: 24,
      hits: [
        {
          start: 6,
          end: 44,
          box: { x: -6, y: -14, w: 132, h: 170 },
          damage: 150,
          hitstun: 34,
          hitstop: 12,
          pushHit: 11,
          guardBreak: true,
          knockdown: true,
        },
      ],
      motion: [{ start: 4, end: 44, vx: 5.5, vy: -16 }],
    },
  }),
};
