/**
 * キャラクター登録簿。
 *
 * キャラを増やすときはここに import して ROSTER へ足すだけ。
 * スプライトは assets/characters/<id>.webp / .json を読むので、
 * tools/build-assets.ps1 の CONFIG にも同じ id を追加しておくこと。
 */
import swordsman from './swordsman.js';
import berserker from './berserker.js';
import mage from './mage.js';
import schoolgirl from './schoolgirl.js';
import succubus from './succubus.js';
import cavalier from './cavalier.js';

export const ROSTER = [swordsman, berserker, mage, schoolgirl, succubus, cavalier];

/**
 * キャラではないが読み込みが要るスプライト。
 * 女子高生のスキルで走ってくる彼氏は、プレイヤーが選ぶ相手ではないので
 * ROSTER には入れず、描画用のアトラスだけ用意する。
 */
export const EXTRA_SPRITE_IDS = ['boyfriend'];

/** id → キャラ定義 */
export const CHARACTERS = Object.fromEntries(ROSTER.map((c) => [c.id, c]));

export const CHARACTER_IDS = ROSTER.map((c) => c.id);

export function getCharacter(id) {
  const c = CHARACTERS[id];
  if (!c) throw new Error(`未登録のキャラクターです: ${id}`);
  return c;
}
