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

/**
 * 1ラウンドは「先に技を通した方が勝ち」なので、当たらないまま睨み合う時間が
 * そのままラウンド時間になる。決着は一瞬なので短めにしてある。
 */
export const ROUND_TIME = 45;
/** 一発で終わるぶん、取り返しがきくように取得ラウンド数を増やしてある。 */
export const ROUNDS_TO_WIN = 3;
export const MAX_HEALTH = 1000;

/**
 * ジャンプ後に空中でさらに跳べる回数（2段ジャンプ）。
 * このゲームは一発が致命傷なので、避ける手段を厚くするためのもの。
 */
export const AIR_JUMPS = 1;
/**
 * 空中ジャンプの初速。地上ジャンプ比。
 * 1段目を「身長ぶん跳べる」高さまで上げたので、2段目までそのまま伸びると
 * 高く飛びすぎる。2段目の跳び上がりが以前と同じくらいになる比率にしてある
 * （2段ジャンプは高さを稼ぐためではなく、軌道をずらすための手段なので）。
 */
export const AIR_JUMP_VY_SCALE = 0.68;

/**
 * ジャンプ初速の目安を「跳びたい高さ」から逆算する。
 *
 * 1ティックごとに y += vy; vy -= GRAVITY と積分するので、
 * 到達高度はおよそ vy^2 / (2 * GRAVITY)（離散なので実際はもう少し上まで行く）。
 * キャラ定義の jumpVy は、この式に自分の身長を入れた値にしてある
 * ＝ **どのキャラも自分の身長ぶんだけ跳べる**。
 */
export const jumpVyForHeight = (height) => Math.sqrt(2 * GRAVITY * height);

/**
 * しゃがみ切る（また立ち上がり切る）までのティック数。
 * この間は姿勢に合わせてやられ判定も少しずつ縮む。
 * 押した瞬間に judgement box が縮むと見た目と食い違うので、
 * 絵の進み具合とやられ判定を同じ値から作っている。
 */
export const CROUCH_TICKS = 10;

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
  DOWN: 1 << 6,
  /**
   * 「走れ」を直接伝えるビット。方向ビットと同時に押されているときだけ効く。
   *
   * キーボードとパッドは同方向の2度押しでダッシュに入るが、スワイプ操作では
   * 「離して押し直す」という形が作れない（指は画面に付いたままなので、
   * 押下の立ち上がりを人工的に作るしかなくなる）。
   * ダッシュしたいという意図を素直に1ビットで渡せるようにしてある。
   * ビット7までなので、入力は今も1フレーム1バイトに収まる。
   */
  DASH: 1 << 7,
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
  CROUCH: 'crouch',
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
