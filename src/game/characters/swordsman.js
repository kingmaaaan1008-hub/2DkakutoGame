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

  /**
   * アニメごとの表示倍率（見た目だけ。判定・移動には影響しない）。
   * run シートは素材の時点で他より 2 割ほど小さく描かれていて、
   * 歩き → ダッシュで急に縮んで見えるので、ここで補正している。
   */
  animScale: {
    run: 1.18,
  },

  /** 攻撃ボタン・スキルボタンで出る技。 */
  attackMove: 'slash1',
  skillMove: 'tackleCharge',

  moves: defineMoves({
    // 1段目。振りかぶってから斬る。ここから盾切りへ繋ぐ。
    slash1: {
      label: '横切り',
      anim: 'attack2',
      // 8コマを 19fps で振り切ると約 25 フレーム。そこから total まではその姿勢の
      // まま構え直す時間で、連携の受付はこの区間に置いてある。
      // （animFps を指定せず total だけ伸ばすと、振り自体が間延びしてしまう）
      total: 41,
      animFps: 19,
      hits: [
        {
          // 剣を横に伸ばしきる 6〜7 コマ目（19fps なので 15〜21 フレーム）に合わせてある。
          // ここを動かすときは下の hitstun / chains も一緒に見直すこと
          start: 16,
          end: 20,
          // 前方 205 まで。剣自体は 148 までしか届かないので、足りない分は
          // 踏み込み(下の motion で 30)と斬撃エフェクトで見せている
          box: { x: 34, y: 74, w: 171, h: 92 },
          damage: 62,
          // 連携の受付を遅らせたぶん、繋がるようにのけぞりも伸ばしてある。
          // blockstun も揃えて、ヒット +3 / ガード -7 は従来どおりにしている
          hitstun: 28,
          blockstun: 18,
          hitstop: 7,
          pushHit: 5.5,
          pushBlock: 3.4,
        },
      ],
      // 踏み込みは振り抜く動きに乗せる。前に出た分だけ間合いが伸びる
      motion: [{ start: 14, end: 19, vx: 5.0 }],
      // 剣先(148)から判定の先端(205)までを埋める斬撃
      spawns: [{ frame: 16, type: 'slash', duration: 9, origin: { x: 34, y: 120 }, length: 171, halfHeight: 52 }],
      // 受付は「1段目のモーションを出し切ったあと」。当ててすぐ押しても出ないので、
      // 斬ってから繋ぐ間があり、連打ではなくタイミングで繋ぐ形になる。
      chains: [{ from: 26, to: 39, button: 'attack', move: 'slash2' }],
    },

    // 2段目。踏み込みが深く、ガードさせても有利。
    slash2: {
      label: '盾切り',
      anim: 'attack',
      // attack シートは 0-3 で下から刀を担ぎ上げ、4-7 で振り下ろす。
      // 1段目から繋ぐ技なので担ぎ上げは要らない。振り下ろす側だけを使う。
      animRange: [4, 7],
      // 4コマを 9fps ＝ 約27フレーム。振り下ろすコマ(6枚目)が判定の出る
      // 15〜20 に重なり、残りは最後のコマを保持したまま硬直になる。
      animFps: 9,
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
          pushHit: 8,
          pushBlock: 5,
        },
      ],
      motion: [{ start: 12, end: 17, vx: 3.4 }],
      // 振り下ろしは剣が下を向くぶん横に届かないので、こちらも斬撃で見せる
      spawns: [{ frame: 15, type: 'slash', duration: 11, origin: { x: 30, y: 115 }, length: 158, halfHeight: 63 }],
    },

    // スキル: ガード不能の突進。当たれば吹き飛ばしてダウンを奪う。
    //
    // 溜めと突進で 2 つに分けてある。tackle シートの前半 2 コマ（構え → 沈み込み）を
    // ゆっくり見せてから、後半の走りに切り替える。1 枚のアニメでは
    // この 2 段階の速さを出せないため（前半に合わせると走りが鈍る）。
    tackleCharge: {
      label: 'タックル（溜め）',
      anim: 'tackle',
      animRange: [0, 1],
      // 2コマを 4fps ＝ ちょうど 30 フレーム。この間は判定も移動も無い丸腰
      total: 30,
      animFps: 4,
      onEnd: 'tackle',
    },

    tackle: {
      label: 'タックル',
      anim: 'tackle',
      // 走り出しのコマから。溜めで向きは決まっているので、ここでは向き直らない
      animRange: [2, 7],
      turnOnStart: false,
      total: 42,
      animFps: 14,
      hits: [
        {
          start: 3,
          end: 19,
          box: { x: 14, y: 34, w: 128, h: 150 },
          damage: 138,
          hitstun: 34,
          hitstop: 11,
          pushHit: 11,
          guardBreak: true,
          knockdown: true,
        },
      ],
      // 当てたらそこで止まる。空振りすると走り抜けて大きな隙になる。
      motion: [{ start: 1, end: 19, vx: 9.6, stopOnHit: true }],
    },
  }),
};
