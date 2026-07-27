/**
 * ゲーム全体で共有する定数。
 *
 * 単位系:
 *   - 座標は「ワールド単位」。地面が y = 0 で、上が正。
 *   - キャラの身長がおよそ 215 単位なので、数値は「身長比」で読むと分かりやすい。
 *   - 時間は 60fps 固定のティック数。シミュレーションは可変フレームレートに
 *     一切依存しない（オンライン対戦で同じ結果を再現するため）。
 */

export const TICK_RATE = 60;
export const TICK_MS = 1000 / TICK_RATE;

/** 1ティックで落下速度に加算される量。ジャンプ高はこれと JUMP_VY で決まる。 */
export const GRAVITY = 0.72;

export const STAGE_WIDTH = 1800;
/** 端に寄りすぎないように、左右この分だけ内側を歩ける範囲とする。 */
export const STAGE_MARGIN = 90;

export const ROUND_TIME = 60;
export const ROUNDS_TO_WIN = 2;
export const MAX_HEALTH = 1000;

/**
 * 入力は 1 プレイヤーにつき整数 1 個のビットマスク。
 * 「押されているか」だけを持ち、二度押しダッシュのような解釈は
 * すべてシミュレーション側で行う。こうしておくと入力をそのまま
 * ネットワークに流せる（1 フレーム 1 バイト）。
 */
export const BTN = {
  LEFT: 1 << 0,
  RIGHT: 1 << 1,
  UP: 1 << 2,
  ATTACK: 1 << 3,
  SKILL: 1 << 4,
  GUARD: 1 << 5,
};

/** 押しっぱなしではなく「押した瞬間」を拾いたい技のための先行入力猶予（ティック）。 */
export const INPUT_BUFFER = 6;

/** 同方向を2回押してダッシュと判定する猶予（ティック）。 */
export const DASH_TAP_WINDOW = 14;

/** ヒット時に攻撃側・被弾側の時間を止めるフレーム数。手応えを出すための演出。 */
export const DEFAULT_HITSTOP = 7;

/** ラウンド開始の「READY」演出と、決着後に結果へ移るまでの待ち時間。 */
export const ROUND_INTRO_TICKS = 90;
export const ROUND_OUTRO_TICKS = 150;

/** 各種状態名。文字列を直接書かずここを参照する。 */
export const STATE = {
  IDLE: 'idle',
  WALK: 'walk',
  DASH: 'dash',
  JUMP: 'jump',
  LAND: 'land',
  GUARD: 'guard',
  MOVE: 'move',
  HIT: 'hit',
  BLOCK: 'block',
  GUARD_BREAK: 'guardBreak',
  DOWN: 'down',
  KO: 'ko',
};
