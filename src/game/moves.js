/**
 * 技（ムーブ）のデータ定義とその補助。
 *
 * ── 設計方針 ────────────────────────────────────────────────
 * 技はすべて「データ」として書く。攻撃判定の出るフレーム、移動、
 * 弾の発生、連携（キャンセル）先まで全部このオブジェクトに載るので、
 * 技を追加するときはキャラファイルに 1 エントリ足すだけでよく、
 * 状態遷移のコードには手を入れなくて済む。
 *
 * ── フレームについて ────────────────────────────────────────
 * すべて 60fps のティック単位。`start` と `end` は両端を含む。
 * 例) start:11, end:15 なら 11,12,13,14,15 の 5 フレーム攻撃判定が出る。
 *
 * ── 座標について ────────────────────────────────────────────
 * 判定ボックスはキャラの足元原点からの相対座標。
 * x は「前方向」が正（左を向いていれば自動で反転する）。
 * y は上が正。つまり y:78, h:88 なら地面から 78〜166 の高さ。
 */

/** @typedef {{x:number,y:number,w:number,h:number}} Box */

/**
 * @typedef {object} Hit 攻撃判定ひとつ分
 * @property {number} start        判定の出るフレーム
 * @property {number} end          判定の終わるフレーム（含む）
 * @property {Box} box             判定範囲
 * @property {number} damage       ダメージ
 * @property {number} hitstun      ヒット時に相手が硬直するフレーム
 * @property {number} blockstun    ガード時に相手が硬直するフレーム
 * @property {number} hitstop      ヒット時に両者の時間が止まるフレーム（手応え演出）
 * @property {number} chip         ガードされたときに与える削りダメージ
 * @property {number} pushHit      ヒット時に相手を押し出す速度
 * @property {number} pushBlock    ガード時に相手を押し出す速度
 * @property {boolean} guardBreak  true ならガードを無視して当たる（スキル技）
 * @property {boolean} knockdown   true ならヒット時にダウンさせる。
 *                                 打ち上げ → 落下 → 倒れる → 起き上がり、まで一続きで、
 *                                 倒れている間は無敵。hitstun は使われない。
 * @property {{x:number,y:number}|null} launch  指定すると相手を打ち上げる
 *                                 （knockdown 時は省略すると既定の打ち上げになる）
 * @property {number} group        同じ group の判定は 1 回の技中に 1 度しか当たらない。
 *                                 多段技は group を変えて並べる。
 */

const HIT_DEFAULTS = {
  damage: 50,
  hitstun: 18,
  blockstun: 12,
  hitstop: 7,
  chip: 0,
  pushHit: 5,
  pushBlock: 3,
  guardBreak: false,
  knockdown: false,
  launch: null,
  group: 0,
};

const MOVE_DEFAULTS = {
  label: '',
  anim: 'idle',
  /** アニメの再生速度(fps)。省略すると技の全体フレームに引き伸ばして再生する。 */
  animFps: null,
  /**
   * 使用するアニメのコマ範囲 [開始, 終了]（0始まり・両端を含む）。省略時は全コマ。
   * シートの一部だけを使いたいとき用（例: 振りかぶりを捨てて振り下ろしだけ見せる）。
   * 実際のコマ数は描画側しか知らないので、はみ出した指定は描画時に丸められる。
   */
  animRange: null,
  /** 空中でも出せるか。 */
  airOk: false,
  /** 出始めに相手の方を向き直すか。false だと出した瞬間の向きで固定。 */
  turnOnStart: true,
  hits: [],
  /** 自身の移動。{start,end,vx,vy,stopOnHit} vx は前方向が正。 */
  motion: [],
  /** 弾・持続判定などの発生。{frame, type, ...任意パラメータ} */
  spawns: [],
  /** 連携入力。{from,to,button,move} の窓の間にボタンを押すと move へ繋がる。 */
  chains: [],
  /**
   * 全体フレームを終えたあと、続けて出す技の id。省略すると idle に戻る。
   * 「溜めてから突進する」のように、途中で見た目も判定も切り替わる技を
   * 2 つに分けて書くためのもの。入力は要らず、必ず繋がる。
   */
  onEnd: null,
};

/**
 * 省略値を埋めて技定義を正規化する。あわせて簡単な妥当性検査もする。
 * @param {string} id
 * @param {object} raw
 */
export function defineMove(id, raw) {
  const move = { id, ...MOVE_DEFAULTS, ...raw };
  if (!Number.isFinite(move.total) || move.total <= 0) {
    throw new Error(`技 "${id}": total（全体フレーム）が必要です`);
  }
  if (move.animRange) {
    const [from, to] = move.animRange;
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || from > to) {
      throw new Error(`技 "${id}": animRange は [開始, 終了] の整数（開始 <= 終了）です`);
    }
  }
  move.hits = (raw.hits ?? []).map((h, i) => {
    const hit = { ...HIT_DEFAULTS, ...h };
    if (hit.start > hit.end) throw new Error(`技 "${id}" の hit[${i}]: start > end`);
    if (!hit.box) throw new Error(`技 "${id}" の hit[${i}]: box が必要です`);
    return hit;
  });
  move.motion = raw.motion ?? [];
  move.spawns = raw.spawns ?? [];
  move.chains = raw.chains ?? [];
  return move;
}

/** キャラ定義の moves をまとめて正規化する。 */
export function defineMoves(table) {
  const out = {};
  for (const [id, raw] of Object.entries(table)) out[id] = defineMove(id, raw);
  // 繋ぎ先の技名は、遊んでいる最中ではなく読み込み時に間違いに気づきたい
  for (const move of Object.values(out)) {
    if (move.onEnd && !out[move.onEnd]) {
      throw new Error(`技 "${move.id}": onEnd の繋ぎ先 "${move.onEnd}" がありません`);
    }
    for (const c of move.chains) {
      if (!out[c.move]) throw new Error(`技 "${move.id}": 連携先 "${c.move}" がありません`);
    }
  }
  return out;
}

/**
 * 判定ボックスをワールド座標の矩形へ変換する。
 * @param {Box} box 足元原点・前方向が正のローカル座標
 * @param {number} x キャラの足元 X
 * @param {number} y キャラの足元 Y（地上なら 0）
 * @param {number} facing 1 なら右向き、-1 なら左向き
 */
export function toWorldBox(box, x, y, facing) {
  const left = facing > 0 ? x + box.x : x - box.x - box.w;
  return { x: left, y: y + box.y, w: box.w, h: box.h };
}

/** 矩形どうしの重なり判定。 */
export function boxesOverlap(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}
