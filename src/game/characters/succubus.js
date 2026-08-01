/**
 * 淫魔 — 掴み型。ガードごと捕らえて吸い尽くす。
 *
 *   攻撃: 「引っ掻き」(claw1 → claw2シート) 2段。リーチは短く、素の性能は低い
 *   スキル: 「吸血」(drainシート) 掴み。ガードは通用しないが、跳ばれると当たらない
 *   空中攻撃: 「翼叩き」(wingslapシート) 翼で横に薙ぐ
 *   空中スキル: 「急降下」(divekickシート) 斜め下へ突っ込む。外すと着地硬直が長い
 *
 * 特殊能力: **飛行**。ジャンプ 3 段目から先は跳び上がらずに滞空する。
 * 高度は上げないかわりに、その高さのまま左右へ動ける（合計 5 段まで）。
 *
 * ── 立ち位置 ───────────────────────────────────────────────────
 * 他の 4 キャラは「ガードは崩せるがジャンプには無力」で揃っている。
 * 淫魔だけが逆で、**ガードに勝ってジャンプに負ける**。
 * 相手の守りの選択肢そのものを咎める役として置いてある。
 */
import { defineMoves } from '../moves.js';
import { jumpVyForHeight } from '../constants.js';

/** 見た目の身長（ワールド単位）。ジャンプ高もここから決める。 */
const HEIGHT = 205;

/**
 * 掴んだ相手を保持する位置（自分の足元原点・前方向が正）。
 * 目の前に、地面から浮かせてぶら下げる。grabbed シートは足元を基準に
 * 描き出してあるので、y がそのまま「靴の裏と地面の隙間」になる。
 *
 * 値は実際に重ねて決めてある。y をこれより下げると背の低いキャラ
 * （女子高生）が浮いて見えず、上げると逆に離れすぎて宙ぶらりんになる。
 * x はこちらの姿が相手の陰に隠れない距離。
 */
const HOLD = { x: 112, y: 44 };

export default {
  id: 'succubus',
  name: '淫魔',
  subtitle: '掴み型 / 飛行と吸血',
  themeColor: '#e0407a',

  health: 1000,
  // 打撃が弱いぶん、動きの速さと空中での自由さで間合いを作る
  walkSpeed: 3.5,
  dashSpeed: 7.4,
  jumpVy: jumpVyForHeight(HEIGHT),
  jumpVx: 4.7,
  // 軽い。掴みを外して打たれると、他の誰よりも遠くまで吹き飛ぶ
  weight: 0.85,

  /**
   * 空中ジャンプの回数。1 段目（地上）と合わせて 5 段まで跳べる。
   * このうち 3 段目から先は flight の指定で滞空に置き換わる。
   */
  airJumps: 4,

  /**
   * 飛行。fromJump 段目以降のジャンプが「跳び上がり」から「滞空」に変わる。
   *
   * 滞空中は落下が止まってその高さに留まり、左右入力があれば speed で動ける。
   * 上へは伸びないので、飛行で高度を稼ぐことはできない
   * （高さを取るのはあくまで 1・2 段目のジャンプ）。
   * 1 回の滞空は ticks で切れ、残り回数があれば押し直してまた浮ける。
   */
  flight: {
    fromJump: 3,
    ticks: 42,
    speed: 3.8,
  },

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
    /** 滞空中。飛行を持つキャラだけが要る。 */
    fly: 'fly',
    /** 掴まれている姿。全キャラが持つ（同キャラ戦で自分も掴まれるため）。 */
    grabbed: 'grabbed',
  },

  attackMove: 'claw1',
  skillMove: 'drainCatch',
  airAttackMove: 'wingSlap',
  airSkillMove: 'diveKick',

  moves: defineMoves({
    // 引っ掻き 1 段目。発生は速いがリーチが無い。
    // 単体では読み合いに勝てないので、2 段目か掴みへの入り口として使う。
    claw1: {
      label: '引っ掻き',
      anim: 'claw1',
      total: 26,
      animFps: 16,
      hits: [
        {
          start: 7,
          end: 11,
          box: { x: 22, y: 74, w: 104, h: 84 },
          damage: 34,
          hitstun: 16,
          blockstun: 10,
          hitstop: 5,
          pushHit: 2.2,
          pushBlock: 1.5,
        },
      ],
      // 攻撃ボタンを押し直すと 2 段目へ繋がる
      chains: [{ from: 8, to: 22, button: 'attack', move: 'claw2' }],
    },

    // 引っ掻き 2 段目。振りが大きく、当たれば吹き飛ばす。
    claw2: {
      label: '引っ掻き二段',
      anim: 'claw2',
      total: 32,
      animFps: 15,
      hits: [
        {
          start: 9,
          end: 14,
          box: { x: 24, y: 66, w: 122, h: 96 },
          damage: 48,
          hitstun: 22,
          blockstun: 13,
          hitstop: 7,
          pushHit: 6,
          pushBlock: 3.4,
        },
      ],
      motion: [{ start: 6, end: 14, vx: 1.2 }],
    },

    // スキル: 掴み。捕らえにいく前半だけがこの技で、
    // 掴めたら onHit で drainHold（吸っている間）へ移る。
    //
    // ガード無視の代わりに、跳ばれると当たらない（判定側の grab が面倒を見る）。
    // 外したときは総フレームぶんそのまま硬直するので、読み間違えると手痛い。
    drainCatch: {
      label: '吸血',
      anim: 'drain',
      animRange: [0, 3],
      total: 38,
      animFps: 13,
      hits: [
        {
          start: 13,
          end: 18,
          // 密着からやや前まで。打撃より短い
          box: { x: 18, y: 36, w: 92, h: 150 },
          hitstop: 6,
          grab: true,
        },
      ],
      onHit: 'drainHold',
      motion: [{ start: 8, end: 16, vx: 1.6, stopOnHit: true }],
    },

    // 掴んだあと。相手を目の前に吊るしたまま吸う。
    //
    // grabHold がある間だけ相手は拘束される。判定は最後の 1 発だけで、
    // これは必ず当たる（相手が HOLD の位置に固定されているため）。
    // 吸い切った勢いで放り投げ、叩きつけたところで決着になる。
    //
    // animFps を書いていないので、drain シートの後半 4 コマが
    // total いっぱいに引き伸ばされてゆっくり流れる。
    drainHold: {
      label: '吸血',
      anim: 'drain',
      animRange: [3, 7],
      total: 84,
      grabHold: HOLD,
      // 掴んでいる間に向き直られると相手が背中側へ回ってしまう
      turnOnStart: false,
      hits: [
        {
          start: 72,
          end: 76,
          // HOLD の位置に吊るしてある相手を確実に捉える大きさ
          box: { x: 26, y: 56, w: 148, h: 168 },
          damage: 160,
          hitstun: 30,
          hitstop: 14,
          pushHit: 9,
          guardBreak: true,
          knockdown: true,
          // 吸い殻を放り上げてから落とす。既定より高く上げて、
          // 決まり手だとひと目で分かるようにしてある
          launch: { x: 0, y: 14 },
        },
      ],
    },

    // 空中攻撃: 翼で横に薙ぐ。judgement は横に広く、
    // 跳び込みながら置いておく使い方になる。
    wingSlap: {
      label: '翼叩き',
      anim: 'wingslap',
      total: 30,
      animFps: 15,
      hits: [
        {
          start: 8,
          end: 13,
          box: { x: -12, y: 24, w: 154, h: 148 },
          damage: 44,
          hitstun: 20,
          blockstun: 12,
          hitstop: 6,
          pushHit: 5,
          pushBlock: 3,
        },
      ],
    },

    // 空中スキル: 斜め下へ急降下。ガードごと崩してダウンを奪う。
    // 滞空から出せるので、高さと間合いを自由に選んでから落ちてこられる
    // ——のだが、外すと着地硬直が長く、そこを掴み返される。
    diveKick: {
      label: '急降下',
      anim: 'divekick',
      total: 46,
      animFps: 15,
      landLag: 22,
      hits: [
        {
          start: 6,
          end: 44,
          box: { x: -4, y: -12, w: 128, h: 164 },
          damage: 150,
          hitstun: 34,
          hitstop: 12,
          pushHit: 10,
          guardBreak: true,
          knockdown: true,
        },
      ],
      motion: [{ start: 4, end: 44, vx: 5.2, vy: -15 }],
    },
  }),
};
