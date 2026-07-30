/**
 * 女子高生 — 置いて戦う型。自分では殴らず、レーザーと彼氏を前に出す。
 *
 *   攻撃: 「カメラレーザー」(photoシート) スマホを構えて撃つ。真っ直ぐ飛ぶ
 *   スキル: 「彼氏突進」(pointシート) 指をさすと、後ろから彼氏が走ってきて突進する
 *   空中攻撃: 「空撮レーザー」(photoシート) 斜め下へ撃ち下ろす
 *   空中スキル: 「上から指さし」(pointシート) 空中からでも彼氏を呼べる
 *
 * 自分の技には打撃判定がひとつも無い。当てるのは全部レーザーか彼氏なので、
 * 「出してから当たるまでが遠い」のが持ち味であり弱点でもある。
 */
import { defineMoves } from '../moves.js';
import { jumpVyForHeight } from '../constants.js';

/** 見た目の身長（ワールド単位）。ジャンプ高もここから決める。 */
const HEIGHT = 200;

export default {
  id: 'schoolgirl',
  name: '女子高生',
  subtitle: '設置型 / レーザーと彼氏',
  themeColor: '#ff6fd0',

  health: 1000,
  // 体は小さく軽い。前に出るのは彼氏なので、本人は素早く動いて距離を作る
  walkSpeed: 3.4,
  dashSpeed: 7.2,
  jumpVy: jumpVyForHeight(HEIGHT),
  jumpVx: 4.6,
  weight: 0.9,

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
  },

  attackMove: 'photoLaser',
  skillMove: 'callBoyfriend',
  airAttackMove: 'airLaser',
  airSkillMove: 'airCall',

  moves: defineMoves({
    // 攻撃: スマホを構えてカメラからレーザー。真っ直ぐ飛ぶので、
    // 追尾する魔法使いの弾と違って「置く」使い方になる。
    photoLaser: {
      label: 'カメラレーザー',
      anim: 'photo',
      // 8コマを 15fps ＝ 約32フレーム。構え(0-3) → 発光(4) → 撃ち終わり(5-7)
      total: 34,
      animFps: 15,
      // 判定は自分では持たない。当てるのは飛んでいくレーザーだけ
      hits: [],
      // 5コマ目（15fps なので 16 フレーム目）でシャッターが光る
      spawns: [{ frame: 16, type: 'laser' }],
    },

    // スキル: 指をさすと彼氏が後ろから走ってくる。
    //
    // 指さし自体には判定が無く、走ってくる彼氏が当たる。
    // 呼んでから届くまでが長いぶん、当たればガードごと持っていってダウンを奪う。
    // 外すと彼氏が走り抜けるだけなので、その間こちらは丸腰になる。
    callBoyfriend: {
      label: '彼氏突進',
      anim: 'point',
      total: 40,
      animFps: 13,
      hits: [],
      // 指をさし切ったところで呼ぶ。彼氏は後ろ 300 から走ってくるので、
      // 相手に届くまでにさらに間がある
      spawns: [{ frame: 12, type: 'boyfriend' }],
    },

    // 空中攻撃: 斜め下へ撃ち下ろす。跳んだ高さで着弾点が変わる。
    airLaser: {
      label: '空撮レーザー',
      anim: 'photo',
      animRange: [3, 7],
      total: 28,
      animFps: 14,
      hits: [],
      spawns: [{ frame: 8, type: 'laser', dir: { x: 0.82, y: -0.57 }, origin: { x: 40, y: 96 } }],
    },

    // 空中スキル: 空中からでも彼氏を呼べる。跳び越えながら呼ぶと、
    // 着地とほぼ同時に彼氏が突っ込む形になる。
    airCall: {
      label: '上から指さし',
      anim: 'point',
      animRange: [2, 7],
      total: 34,
      animFps: 14,
      landLag: 20,
      hits: [],
      spawns: [{ frame: 10, type: 'boyfriend' }],
    },
  }),
};
