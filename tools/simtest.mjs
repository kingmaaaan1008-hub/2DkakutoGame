/**
 * シミュレーションの動作確認。
 *
 * ブラウザも描画も使わず、Simulation に入力ビットマスクを流し込んで
 * 結果を検証する。技を追加・調整したあとにこれを回せば、
 * 判定やキャンセルが壊れていないかがすぐ分かる。
 *
 *   npm test
 */
import { Simulation } from '../src/game/sim.js';
import {
  BTN,
  STATE,
  ROUND_INTRO_TICKS,
  CROUCH_TICKS,
  STAGE_MARGIN,
  STAGE_WIDTH,
  GRAVITY,
} from '../src/game/constants.js';
import { getProjectileDef, lungeSlideTick } from '../src/game/projectiles.js';
import { getCharacter } from '../src/game/characters/index.js';
// スワイプ操作は DOM を触らない部分だけ切り出してあるので、ここで検証できる
import { GESTURE, SWIPE, SwipeTracker, classifySwipe } from '../src/core/gestures.js';
import { InputManager } from '../src/core/input.js';

let passed = 0;
let failed = 0;

function check(name, cond, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${detail ? `  — ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n■ ${title}`);
}

/** 新しい試合を作り、開始演出を飛ばして操作できる状態にする。 */
function newSim(characters = ['swordsman', 'berserker'], seed = 1) {
  const sim = new Simulation({ characters, seed });
  for (let i = 0; i <= ROUND_INTRO_TICKS; i += 1) sim.step([0, 0]);
  return sim;
}

/** n ティック分、同じ入力を流す。 */
function run(sim, ticks, p1 = 0, p2 = 0) {
  for (let i = 0; i < ticks; i += 1) sim.step([p1, p2]);
}

/** 立ち位置を決め打ちして間合いを作る。 */
function place(sim, x0, x1) {
  sim.fighters[0].x = x0;
  sim.fighters[1].x = x1;
}

// ── 移動 ────────────────────────────────────────────────────
section('移動');
{
  const sim = newSim();
  const p1 = sim.fighters[0];
  const startX = p1.x;

  run(sim, 20, BTN.RIGHT);
  check('右入力で前進する', p1.x > startX + 40, `x=${p1.x.toFixed(1)}`);
  check('歩き状態になる', p1.state === STATE.WALK);
  check('歩き中は相手を向く', p1.facing === 1);
  check('前進中は順再生', p1.anim.reverse === false);

  run(sim, 20, BTN.LEFT);
  check('後退できる', p1.state === STATE.WALK && p1.vx < 0);
  check('後退中も相手を向いたまま', p1.facing === 1);
  check('後退中は walk シートを逆再生', p1.anim.reverse === true, `reverse=${p1.anim.reverse}`);
}

{
  // 同方向 2 度押しでダッシュ
  const sim = newSim();
  const p1 = sim.fighters[0];
  run(sim, 1, BTN.RIGHT); // 1度目
  run(sim, 2, 0); // いったん離す
  run(sim, 6, BTN.RIGHT); // 2度目を押しっぱなし
  check('2度押しでダッシュに入る', p1.state === STATE.DASH, `state=${p1.state}`);
  check('ダッシュは歩きより速い', Math.abs(p1.vx) > sim.fighters[0].def.walkSpeed);

  // 相手より左にいる状態で左ダッシュ → 進行方向を向く
  const sim2 = newSim();
  const q = sim2.fighters[0];
  run(sim2, 1, BTN.LEFT);
  run(sim2, 2, 0);
  run(sim2, 6, BTN.LEFT);
  check('ダッシュ中は進んでいる方を向く', q.state === STATE.DASH && q.facing === -1,
    `state=${q.state} facing=${q.facing}`);
}

{
  const sim = newSim();
  const p1 = sim.fighters[0];
  run(sim, 4, BTN.UP);
  check('ジャンプで浮く', p1.y > 0, `y=${p1.y.toFixed(1)}`);
  run(sim, 90, 0);
  check('着地して地面に戻る', p1.y === 0);
}

{
  // 1段目のジャンプで自分の身長ぶん跳べる
  // （身長はアトラスの targetHeight ＝ 剣士215 / 狂戦士225 / 魔法使い212）
  for (const [id, height] of [['swordsman', 215], ['berserker', 225], ['mage', 212]]) {
    const sim = newSim([id, 'swordsman']);
    const p1 = sim.fighters[0];
    let peak = 0;
    run(sim, 1, BTN.UP);
    for (let i = 0; i < 120 && (p1.y > 0 || i < 3); i += 1) {
      run(sim, 1, 0);
      peak = Math.max(peak, p1.y);
    }
    check(`${id}: 身長(${height})ぶん跳べる`, peak >= height && peak < height * 1.12,
      `peak=${peak.toFixed(1)}`);
  }
}

// ── 攻撃と連携 ──────────────────────────────────────────────
section('剣士の攻撃と連携');
{
  const sim = newSim();
  place(sim, 800, 940);
  const [p1, p2] = sim.fighters;

  run(sim, 1, BTN.ATTACK);
  check('攻撃で1段目「横切り」が出る', p1.moveId === 'slash1', `move=${p1.moveId}`);

  // 判定が出るのは剣を伸ばしきったあたり。当たるまで進める
  for (let i = 0; i < 40 && p1.comboDisplay < 1; i += 1) run(sim, 1, 0);
  check('1段目が当たる', p1.comboDisplay === 1, `hits=${p1.comboDisplay}`);

  // 連携の受付は 1段目を振り切ったあと。当ててすぐ押しても繋がらない。
  run(sim, 1, BTN.ATTACK);
  run(sim, 4, 0);
  check('当てた直後に押しても2段目は出ない', p1.moveId === 'slash1', `move=${p1.moveId}`);

  // 受付が開くまで待ってから入れ直す
  const chain = p1.def.moves.slash1.chains[0];
  for (let i = 0; i < 60 && p1.moveFrame < chain.from; i += 1) run(sim, 1, 0);
  run(sim, 1, BTN.ATTACK);
  run(sim, 4, 0);
  check('連携受付で2段目「盾切り」に繋がる', p1.moveId === 'slash2', `move=${p1.moveId}`);

  // 2段目が当たるまで、相手が硬直から抜けていないか（＝連続技として繋がるか）を見る
  let recovered = false;
  for (let i = 0; i < 30 && p1.comboDisplay < 2; i += 1) {
    run(sim, 1, 0);
    if (p2.isFree) recovered = true;
  }
  check('2段目も当たる', p1.comboDisplay === 2, `hits=${p1.comboDisplay}`);
  check('1段目からの連続技として繋がる', !recovered);
}

// ── ガード ──────────────────────────────────────────────────
section('ガード');
{
  const sim = newSim();
  place(sim, 800, 930);
  const [p1, p2] = sim.fighters;
  const hp0 = p2.health;

  // P2 はガードを押しっぱなし
  run(sim, 1, BTN.ATTACK, BTN.GUARD);
  for (let i = 0; i < 40 && p2.state !== STATE.BLOCK; i += 1) run(sim, 1, 0, BTN.GUARD);

  check('ガード硬直状態になる', p2.state === STATE.BLOCK || p2.state === STATE.GUARD,
    `state=${p2.state}`);
  check('ガードするとダメージを受けない', p2.health === hp0, `hp ${hp0} -> ${p2.health}`);
  // 技を最後まで流しても 0 のまま（削りが復活したら気づける）
  run(sim, 40, 0, BTN.GUARD);
  check('技を受け切ってもダメージ0', p2.health === hp0, `hp ${hp0} -> ${p2.health}`);
}

{
  // 走っている最中でもガードは出る（攻撃・スキルと同じ扱い）
  const sim = newSim();
  const p1 = sim.fighters[0];
  run(sim, 6, BTN.RIGHT);
  run(sim, 2, 0);
  run(sim, 10, BTN.RIGHT);
  check('2度押しでダッシュになる', p1.state === STATE.DASH, `state=${p1.state}`);
  run(sim, 8, BTN.RIGHT | BTN.GUARD);
  check('ダッシュ中でもガードできる', p1.state === STATE.GUARD, `state=${p1.state}`);
}

{
  // スキルはガードを崩す
  const sim = newSim();
  place(sim, 800, 930);
  const [p1, p2] = sim.fighters;
  const hp0 = p2.health;

  run(sim, 1, BTN.SKILL, BTN.GUARD);
  check('スキルでタックルの溜めが出る', p1.moveId === 'tackleCharge', `move=${p1.moveId}`);

  // 溜めの間は無防備。判定も移動も無い
  const chargeX = p1.x;
  run(sim, p1.def.moves.tackleCharge.total - 2, 0, BTN.GUARD);
  check('溜めの間は動かない', p1.x === chargeX, `x ${chargeX} -> ${p1.x}`);
  check('溜めの間は当たり判定が出ない', p2.health === hp0, `hp ${hp0} -> ${p2.health}`);

  // 溜めきると入力無しで突進へ移る
  run(sim, 3, 0, BTN.GUARD);
  check('溜めきると突進に移る', p1.moveId === 'tackle', `move=${p1.moveId}`);

  run(sim, 30, 0, BTN.GUARD);
  check('ガードしていても大ダメージを受ける', hp0 - p2.health > 100, `hp ${hp0} -> ${p2.health}`);
  // ガードを崩したうえでダウンまで奪う技なので、行き着く先は DOWN
  check('ガードごと崩してダウンさせる', p2.state === STATE.DOWN, `state=${p2.state}`);
}

// ── ダウン ──────────────────────────────────────────────────
section('ダウン');
{
  // 剣士のスキル（タックル）でダウンを奪う
  const sim = newSim();
  place(sim, 800, 930);
  const [p1, p2] = sim.fighters;

  run(sim, 1, BTN.SKILL);
  run(sim, p1.def.moves.tackleCharge.total + 25, 0);
  check('スキルヒットでダウンする', p2.state === STATE.DOWN, `state=${p2.state}`);
  check('打ち上がって浮く', p2.y > 0, `y=${p2.y.toFixed(1)}`);

  // ダウン中は無敵。追撃を入れても体力が減らない。
  const hpDown = p2.health;
  run(sim, 20, 0);
  run(sim, 1, BTN.ATTACK);
  run(sim, 25, 0);
  check('ダウン中は追撃が当たらない', p2.health === hpDown, `hp ${hpDown} -> ${p2.health}`);
  check('ダウン中は操作できない', p2.isFree === false, `state=${p2.state}`);

  // 起き上がるまで待つ
  run(sim, 90, 0, BTN.RIGHT);
  check('やがて起き上がって動けるようになる', p2.state !== STATE.DOWN, `state=${p2.state}`);
  check('起き上がったら地面に戻っている', p2.y === 0, `y=${p2.y}`);
}

{
  // 狂戦士のスキル（突き）
  const sim = newSim(['berserker', 'swordsman']);
  place(sim, 800, 950);
  const p2 = sim.fighters[1];
  run(sim, 1, BTN.SKILL);
  run(sim, 30, 0);
  check('狂戦士の突きでダウンする', p2.state === STATE.DOWN, `state=${p2.state}`);
}

{
  // 魔法使いのビームは 1 秒溜めてから撃ち、最終打だけダウン
  const sim = newSim(['mage', 'swordsman']);
  place(sim, 700, 1000);
  const [p1, p2] = sim.fighters;

  run(sim, 1, BTN.SKILL);
  check('スキルでビームの溜めに入る', p1.moveId === 'beamCharge', `move=${p1.moveId}`);
  run(sim, 40, 0);
  check('溜めている間は何も起きない', p2.health === p2.maxHealth && p1.moveId === 'beamCharge',
    `hp=${p2.health} move=${p1.moveId}`);

  // 溜めきると入力無しで照射へ移る
  run(sim, 25, 0);
  check('1秒溜めきると照射に移る', p1.moveId === 'beam', `move=${p1.moveId}`);

  for (let i = 0; i < 30 && p2.health === p2.maxHealth; i += 1) run(sim, 1, 0);
  check('照射が当たる', p2.health === 0, `hp=${p2.health}`);
  check('ビーム途中の打ではダウンしない', p2.state !== STATE.DOWN, `state=${p2.state}`);

  for (let i = 0; i < 60 && p2.state !== STATE.DOWN; i += 1) run(sim, 1, 0);
  check('ビーム最終打でダウンする', p2.state === STATE.DOWN, `state=${p2.state}`);
}

{
  // 溜め中は足元に魔法陣が出る（＝撃つ合図が相手に見える）
  const sim = newSim(['mage', 'swordsman']);
  place(sim, 700, 1000);
  const p1 = sim.fighters[0];
  run(sim, 2, BTN.SKILL);
  const circle = sim.effects.find((e) => e.type === 'magicCircle');
  check('溜めと同時に魔法陣が出る', !!circle);
  check('魔法陣は術者の足元に追従する', circle.follow === p1.index, `follow=${circle?.follow}`);
  run(sim, 55, 0);
  check('照射を始めるまで魔法陣が残っている',
    sim.effects.some((e) => e.type === 'magicCircle'), `n=${sim.effects.length}`);
}

{
  // スキルは外すと隙が大きい
  const sim = newSim();
  place(sim, 500, 1300); // 遠く離して空振りさせる
  const p1 = sim.fighters[0];
  run(sim, 1, BTN.SKILL);
  // 溜め → 突進で 1 つの技。硬直は両方を足した長さになる
  const total = p1.def.moves.tackleCharge.total + p1.def.moves.tackle.total;
  run(sim, total - 20, 0);
  check('空振り後もしばらく動けない', p1.state === STATE.MOVE, `state=${p1.state}`);
  run(sim, 25, 0);
  check('全体フレーム後に硬直が解ける', p1.state !== STATE.MOVE, `state=${p1.state}`);
}

// ── 狂戦士 ──────────────────────────────────────────────────
section('狂戦士');
{
  const sim = newSim(['berserker', 'swordsman']);
  place(sim, 800, 920);
  const [p1, p2] = sim.fighters;

  run(sim, 1, BTN.ATTACK);
  check('攻撃で乱舞が出る', p1.moveId === 'rampage');
  run(sim, 40, 0);
  check('乱舞は多段ヒットする', p1.usedGroups.length >= 2 || p2.comboDisplay >= 2,
    `hits=${p1.usedGroups.length}`);
}

// ── 魔法使い ────────────────────────────────────────────────
section('魔法使い');
{
  const sim = newSim(['mage', 'swordsman']);
  place(sim, 600, 1100);
  const [p1, p2] = sim.fighters;

  run(sim, 1, BTN.ATTACK);
  check('攻撃でホーミング弾が出る', p1.moveId === 'bolt');
  run(sim, 13, 0);
  check('弾が生成される', sim.projectiles.length === 1, `n=${sim.projectiles.length}`);

  const hp0 = p2.health;
  run(sim, 90, 0);
  check('弾が相手に届く', p2.health < hp0, `hp ${hp0} -> ${p2.health}`);
}

{
  // 連射できる。ただし画面に出せる数には上限があり、撃ち切ると間が空く
  const sim = newSim(['mage', 'swordsman']);
  place(sim, 600, 1400);
  const p1 = sim.fighters[0];
  const cap = getProjectileDef('bolt').maxAlive;
  let fired = 0;
  let maxAlive = 0;
  // 攻撃ボタンを叩き続ける
  for (let i = 0; i < 600; i += 1) {
    const before = sim.projectiles.length;
    sim.step([i % 6 === 0 ? BTN.ATTACK : 0, 0]);
    if (sim.projectiles.length > before) fired += 1;
    maxAlive = Math.max(maxAlive, sim.projectiles.length);
  }
  check('連打で複数発撃てる', fired >= 3, `${fired} 発`);
  check('同時に出る弾は上限まで', maxAlive === cap, `最大 ${maxAlive} 発 / 上限 ${cap}`);
  check('場に出せる弾は1発だけ', cap === 1, `上限 ${cap} 発`);
}

{
  // ビームを構えると、場に出ている自分の弾は消える。
  // 弾で足止めしてから照射、という重ねがけを封じるための弱体化。
  const sim = newSim(['mage', 'swordsman']);
  place(sim, 600, 1400);
  const p1 = sim.fighters[0];

  run(sim, 1, BTN.ATTACK);
  run(sim, 14, 0);
  check('先に弾を撒いておく', sim.projectiles.length === 1, `n=${sim.projectiles.length}`);

  run(sim, 16, 0); // 弾を撃つモーションを終えてから構える
  run(sim, 1, BTN.SKILL);
  run(sim, 3, 0);
  check('ビームを構えると自分の弾が消える', sim.projectiles.length === 0,
    `n=${sim.projectiles.length} move=${p1.moveId}`);
  check('消えるときに演出が出る', sim.effects.some((e) => e.type === 'pop'));

  // 溜めている間も撃ち足せない（技中なので当然だが、念のため）
  run(sim, 1, BTN.ATTACK);
  run(sim, 20, 0);
  check('溜め中に弾を撒き直せない', sim.projectiles.length === 0, `n=${sim.projectiles.length}`);
}

{
  // 相手の弾は消さない
  const sim = newSim(['mage', 'mage']);
  place(sim, 600, 1400);

  run(sim, 1, 0, BTN.ATTACK);   // 2P だけが弾を撃つ
  run(sim, 14, 0, 0);
  check('2P の弾が場に出ている', sim.projectiles.length === 1, `n=${sim.projectiles.length}`);

  run(sim, 1, BTN.SKILL, 0);    // 1P がビームを構える
  run(sim, 3, 0, 0);
  check('消えるのは自分の弾だけ', sim.projectiles.length === 1 && sim.projectiles[0].owner === 1,
    `n=${sim.projectiles.length}`);
}

{
  // 空中の浮遊照射も同じ。地上で撒いてから跳んで構えても消える
  const sim = newSim(['mage', 'swordsman']);
  place(sim, 600, 1400);
  run(sim, 1, BTN.ATTACK);
  run(sim, 30, 0);
  check('地上で弾を撒いておく', sim.projectiles.length === 1, `n=${sim.projectiles.length}`);

  run(sim, 1, BTN.UP);
  run(sim, 4, 0);
  run(sim, 1, BTN.SKILL);
  run(sim, 3, 0);
  check('浮遊照射を構えても弾は消える', sim.projectiles.length === 0, `n=${sim.projectiles.length}`);
}

{
  // 極太ビームはガードを貫く
  const sim = newSim(['mage', 'swordsman']);
  place(sim, 600, 900);
  const [p1, p2] = sim.fighters;
  const hp0 = p2.health;

  run(sim, 1, BTN.SKILL);
  check('スキルでビームが出る', p1.moveId === 'beamCharge', `move=${p1.moveId}`);
  let beamSeen = false;
  for (let i = 0; i < 120 && p2.health === hp0; i += 1) {
    run(sim, 1, 0, BTN.GUARD);
    if (sim.effects.some((e) => e.type === 'beam')) beamSeen = true;
  }
  check('ビームのエフェクトが出る', beamSeen);
  check('ビームはガードごと削る', p2.health === 0, `hp ${hp0} -> ${p2.health}`);
}

// ── 一発必殺 ────────────────────────────────────────────────
section('一発必殺');
{
  // 一番軽い技（狂戦士の乱舞 1 段目）でも即死する
  const sim = newSim(['berserker', 'swordsman']);
  place(sim, 800, 920);
  const [p1, p2] = sim.fighters;

  run(sim, 1, BTN.ATTACK);
  for (let i = 0; i < 30 && p1.comboDisplay < 1; i += 1) run(sim, 1, 0);
  check('多段技の1打目でも体力が全部消える', p2.health === 0, `hp=${p2.health}`);
  check('当たった瞬間はまだ倒れず、食らい状態のまま', !p2.isKO && p2.doomed,
    `state=${p2.state} doomed=${p2.doomed}`);

  // 残りの段も当たり続けて、ヒット数が伸びる
  for (let i = 0; i < 120 && !p2.isKO; i += 1) run(sim, 1, 0);
  check('コンボが途切れるまで被弾演出が続く', p1.comboDisplay >= 3, `hits=${p1.comboDisplay}`);
  check('コンボが途切れたら倒れる', p2.isKO, `state=${p2.state}`);
}

{
  // ガードは通す。当たらなければ死なない、が原則
  const sim = newSim();
  place(sim, 800, 930);
  const p2 = sim.fighters[1];
  run(sim, 1, BTN.ATTACK, BTN.GUARD);
  run(sim, 60, 0, BTN.GUARD);
  check('ガードできれば即死しない', p2.health === p2.maxHealth && !p2.doomed,
    `hp=${p2.health} doomed=${p2.doomed}`);
}

{
  // ダウンを奪う技は、叩きつけたところで決着する
  const sim = newSim();
  place(sim, 800, 930);
  const p2 = sim.fighters[1];
  run(sim, 1, BTN.SKILL);
  run(sim, p2.def.moves ? 60 : 60, 0);
  check('ガード崩しスキルも即死', p2.health === 0, `hp=${p2.health}`);
  for (let i = 0; i < 120 && !p2.isKO; i += 1) run(sim, 1, 0);
  check('打ち上げられて落ちたら倒れる', p2.isKO, `state=${p2.state}`);
  check('起き上がっては来ない', p2.state === STATE.KO, `state=${p2.state}`);
}

// ── 2段ジャンプ ─────────────────────────────────────────────
section('2段ジャンプ');
{
  const sim = newSim();
  const p1 = sim.fighters[0];

  run(sim, 1, BTN.UP);
  run(sim, 24, 0); // 落ち始めるまで待つ
  const yBefore = p1.y;
  const vyBefore = p1.vy;
  check('1段目で浮いて落下に入る', yBefore > 0 && vyBefore < 0,
    `y=${yBefore.toFixed(1)} vy=${vyBefore.toFixed(2)}`);

  run(sim, 1, BTN.UP);
  check('空中でもう一度跳べる', p1.vy > 0, `vy=${p1.vy.toFixed(2)}`);
  const peak = p1.y;

  // 3回目は跳べない
  run(sim, 30, 0);
  const yFalling = p1.y;
  run(sim, 1, BTN.UP);
  check('3回目は跳べない', p1.vy < 0, `vy=${p1.vy.toFixed(2)}`);
  check('2段目で高度を稼げている', peak > 0 && yFalling >= 0);

  // 着地すれば回数は戻る
  for (let i = 0; i < 120 && p1.y > 0; i += 1) run(sim, 1, 0);
  run(sim, 12, 0);
  run(sim, 1, BTN.UP);
  run(sim, 20, 0);
  run(sim, 1, BTN.UP);
  check('着地すると2段ジャンプの回数が戻る', p1.airJumps === 0 && p1.y > 0,
    `airJumps=${p1.airJumps} y=${p1.y.toFixed(1)}`);
}

// ── しゃがみ ────────────────────────────────────────────────
section('しゃがみ');
{
  const sim = newSim();
  const p1 = sim.fighters[0];
  const standH = p1.hurtBox().h;

  run(sim, 1, BTN.DOWN);
  check('下入力でしゃがみ状態になる', p1.state === STATE.CROUCH, `state=${p1.state}`);
  check('押した直後はまだ縮み切っていない', p1.hurtBox().h > standH * 0.9,
    `h=${p1.hurtBox().h.toFixed(0)} / ${standH}`);

  run(sim, CROUCH_TICKS, BTN.DOWN);
  check('しゃがみ切るとやられ判定が縮む', p1.hurtBox().h < standH * 0.6,
    `h=${p1.hurtBox().h.toFixed(0)} / ${standH}`);
  check('絵も最後のコマまで進んでいる', p1.anim.name === 'crouch' && p1.crouchDepth === 1,
    `anim=${p1.anim.name} depth=${p1.crouchDepth}`);
  check('しゃがみ中は動けない', p1.vx === 0);

  // 離すと同じ時間をかけて立ち上がる
  run(sim, 2, 0);
  check('離した直後はまだ立ち上がり途中', p1.state === STATE.CROUCH && p1.crouchDepth < 1,
    `depth=${p1.crouchDepth}`);
  run(sim, CROUCH_TICKS, 0);
  check('立ち上がると通常状態に戻る', p1.state === STATE.IDLE, `state=${p1.state}`);
  check('やられ判定も元に戻る', p1.hurtBox().h === standH, `h=${p1.hurtBox().h}`);
}

{
  // しゃがみからは技もジャンプも出せる（そのぶん判定は立ちに戻る）
  const sim = newSim();
  const p1 = sim.fighters[0];
  run(sim, CROUCH_TICKS + 2, BTN.DOWN);
  run(sim, 1, BTN.DOWN | BTN.ATTACK);
  run(sim, 2, BTN.DOWN);
  check('しゃがみから攻撃が出る', p1.moveId === 'slash1', `move=${p1.moveId}`);
  check('技を出したら判定は立ち姿勢に戻る', p1.crouchDepth === 0, `depth=${p1.crouchDepth}`);

  const sim2 = newSim();
  const q = sim2.fighters[0];
  run(sim2, CROUCH_TICKS + 2, BTN.DOWN);
  run(sim2, 1, BTN.DOWN | BTN.UP);
  run(sim2, 4, 0);
  check('しゃがみからジャンプできる', q.y > 0, `y=${q.y.toFixed(1)}`);
}

{
  // 本題: しゃがめば魔法使いのビームをくぐれる
  const sim = newSim(['mage', 'swordsman']);
  place(sim, 600, 900);
  const [p1, p2] = sim.fighters;

  run(sim, 1, BTN.SKILL, BTN.DOWN);   // 撃つと同時にしゃがみ始める
  let beamFired = false;
  for (let i = 0; i < 90; i += 1) {
    run(sim, 1, 0, BTN.DOWN);         // 照射を最後まで受け切る
    if (sim.effects.some((e) => e.type === 'beam')) beamFired = true;
  }
  check('ビーム自体はちゃんと撃たれている', beamFired);
  check('しゃがめばビームをくぐれる', !p2.doomed && !p2.isKO && p2.health === p2.maxHealth,
    `hp=${p2.health} state=${p2.state}`);
  check('くぐっている間もしゃがみ切っている', p2.crouchDepth === 1, `depth=${p2.crouchDepth}`);
}

{
  // 立っていれば当たる（＝上のテストがしゃがみの効果であることの裏取り）
  const sim = newSim(['mage', 'swordsman']);
  place(sim, 600, 900);
  const p2 = sim.fighters[1];
  run(sim, 1, BTN.SKILL);
  run(sim, 90, 0);
  check('立っているとビームに当たる', p2.isKO || p2.doomed, `hp=${p2.health} state=${p2.state}`);
}

{
  // 空中からの浮遊照射も、しゃがみでくぐれる（判定はさらに高いので当然）
  const sim = newSim(['mage', 'swordsman']);
  place(sim, 600, 900);
  const p2 = sim.fighters[1];
  run(sim, 1, BTN.UP);
  run(sim, 3, 0, BTN.DOWN);
  run(sim, 1, BTN.SKILL, BTN.DOWN);
  run(sim, 90, 0, BTN.DOWN);
  check('低空の浮遊照射もしゃがみでくぐれる', p2.health === p2.maxHealth,
    `hp=${p2.health} state=${p2.state}`);
}

{
  // しゃがんでも打撃は当たる。「しゃがめば全部avoidできる」にはしない
  const sim = newSim();
  place(sim, 800, 940);
  const p2 = sim.fighters[1];
  run(sim, 1, BTN.ATTACK, BTN.DOWN);
  run(sim, 40, 0, BTN.DOWN);
  check('しゃがんでも打撃は当たる', p2.doomed || p2.isKO, `state=${p2.state}`);
}

{
  // 追尾弾はしゃがんだ相手を狙い直す
  const sim = newSim(['mage', 'swordsman']);
  place(sim, 600, 1000);
  const p2 = sim.fighters[1];
  run(sim, 1, BTN.ATTACK, BTN.DOWN);
  run(sim, 120, 0, BTN.DOWN);
  check('追尾弾はしゃがんだ相手にも届く', p2.doomed || p2.isKO,
    `state=${p2.state} n=${sim.projectiles.length}`);
}

{
  // CPU はビームをしゃがんでくぐろうとする
  const sim = newSim(['mage', 'swordsman']);
  place(sim, 600, 900);
  const foe = sim.fighters[0];
  const me = sim.fighters[1];
  // ビームのモーション中であることを CPU に見せる
  run(sim, 1, BTN.SKILL);
  const CpuMod = await import('../src/game/ai.js');
  const cpu = new CpuMod.CpuController(1, 'hard');
  let ducked = false;
  for (let i = 0; i < 40 && !ducked; i += 1) {
    const bits = cpu.think(sim);
    if (bits & BTN.DOWN) ducked = true;
    sim.step([0, bits]);
  }
  check('CPU はビームをしゃがんで避けようとする', ducked,
    `foe.move=${foe.moveId} me.state=${me.state}`);
}

// ── 女子高生 ────────────────────────────────────────────────
// 自分の技には打撃判定がひとつも無く、当てるのはレーザーと彼氏だけ。
// 「技を出す」と「当たる」が離れているのが特徴なので、そこを確かめる。
section('女子高生');
{
  const sim = newSim(['schoolgirl', 'swordsman']);
  place(sim, 500, 1100);
  const [p1, p2] = sim.fighters;

  run(sim, 1, BTN.ATTACK);
  check('攻撃でカメラを構える', p1.moveId === 'photoLaser', `move=${p1.moveId}`);
  check('構えた時点では判定を持たない', p1.def.moves.photoLaser.hits.length === 0);

  for (let i = 0; i < 30 && sim.projectiles.length === 0; i += 1) run(sim, 1, 0);
  const laser = sim.projectiles[0];
  check('スマホからレーザーが出る', laser?.type === 'laser', `proj=${laser?.type}`);
  check('レーザーは真っ直ぐ前へ飛ぶ', laser.vx > 0 && laser.vy === 0,
    `vx=${laser?.vx.toFixed(1)} vy=${laser?.vy.toFixed(1)}`);
  // 発射位置は掲げたスマホの高さ（実測 167）。胸の高さから出ていると
  // 手ではなく体から出ているように見えてしまう
  check('掲げたスマホの高さから出る', laser.y - p1.y > 150 && laser.y - p1.y < 185,
    `高さ=${(laser.y - p1.y).toFixed(0)}`);
  // スマホ本体は前端が 52 あたり。そこより前から出さないと光が本体に被る
  check('発射位置はスマホの前端より先', laser.x - p1.x > 52,
    `前方=${(laser.x - p1.x).toFixed(0)}`);

  const y0 = laser.y;
  run(sim, 10, 0);
  const still = sim.projectiles[0];
  check('飛んでいる間も高さが変わらない（追尾しない）', !still || still.y === y0,
    `y ${y0} -> ${still?.y}`);

  for (let i = 0; i < 90 && p2.health > 0; i += 1) run(sim, 1, 0);
  check('レーザーが相手に当たる', p2.health === 0, `hp=${p2.health}`);
}

{
  // レーザーはしゃがめばくぐれる高さに置いてある（スマホを構えた高さ）
  const sim = newSim(['schoolgirl', 'swordsman']);
  place(sim, 500, 900);
  const p2 = sim.fighters[1];
  run(sim, 1, BTN.ATTACK);
  // 沈み切ってから通す
  run(sim, CROUCH_TICKS + 2, 0, BTN.DOWN);
  for (let i = 0; i < 90 && sim.projectiles.length > 0; i += 1) run(sim, 1, 0, BTN.DOWN);
  check('しゃがめばレーザーをくぐれる', p2.health > 0, `hp=${p2.health}`);
}

{
  // スキルは指をさすだけ。当てるのは後ろから走ってくる彼氏
  const sim = newSim(['schoolgirl', 'swordsman']);
  place(sim, 500, 1100);
  const [p1, p2] = sim.fighters;

  run(sim, 1, BTN.SKILL);
  check('スキルで指をさす', p1.moveId === 'callBoyfriend', `move=${p1.moveId}`);
  check('指さし自体は判定を持たない', p1.def.moves.callBoyfriend.hits.length === 0);

  for (let i = 0; i < 30 && sim.projectiles.length === 0; i += 1) run(sim, 1, 0);
  const bf = sim.projectiles[0];
  check('彼氏が出てくる', bf?.type === 'boyfriend', `proj=${bf?.type}`);
  check('彼氏は女子高生の後ろから走ってくる', bf.x < p1.x, `彼氏=${bf.x.toFixed(0)} 本人=${p1.x}`);
  check('彼氏は相手の方へ走る', bf.vx > 0, `vx=${bf.vx}`);

  // 追い越して当たるまで
  let passed = false;
  for (let i = 0; i < 120 && p2.health > 0; i += 1) {
    run(sim, 1, 0);
    const cur = sim.projectiles.find((p) => p.type === 'boyfriend');
    if (cur && cur.x > p1.x) passed = true;
  }
  check('彼氏が本人を追い越していく', passed);
  check('彼氏の突進が当たる', p2.health === 0, `hp=${p2.health}`);
  check('彼氏の突進はダウンを奪う', p2.state === STATE.DOWN, `state=${p2.state}`);
}

{
  // 彼氏はガードごと崩す（スキルはガードを崩せる、の枠）
  const sim = newSim(['schoolgirl', 'swordsman']);
  place(sim, 500, 1100);
  const p2 = sim.fighters[1];
  run(sim, 1, BTN.SKILL);
  for (let i = 0; i < 140 && p2.health > 0; i += 1) run(sim, 1, 0, BTN.GUARD);
  check('彼氏はガードしていても当たる', p2.health === 0, `hp=${p2.health}`);
}

{
  // 彼氏は当てても消えず、そのまま走り抜ける。
  // ぶつかった瞬間に消えると「弾が当たった」ようにしか見えない。
  const sim = newSim(['schoolgirl', 'swordsman']);
  place(sim, 400, 1000);
  const p2 = sim.fighters[1];
  run(sim, 1, BTN.SKILL);
  let hitAt = -1;
  let xAtHit = 0;
  for (let i = 0; i < 220 && hitAt < 0; i += 1) {
    run(sim, 1, 0);
    if (p2.health === 0) {
      hitAt = i;
      xAtHit = sim.projectiles.find((p) => p.type === 'boyfriend')?.x ?? -1;
    }
  }
  check('当てた時点でも彼氏はまだ場にいる', xAtHit > 0, `x=${xAtHit}`);
  run(sim, 90, 0);
  const after = sim.projectiles.find((p) => p.type === 'boyfriend');
  check('当てたあとも走り続ける', after && after.x > xAtHit + 200,
    `${xAtHit.toFixed(0)} → ${after ? after.x.toFixed(0) : '消滅'}`);
  check('当てたあとは判定が切れている', after?.spent === true);
}

{
  // 突進を出し切ったら、最終コマのまま慣性で滑って止まる。
  // 止まりきってから走り出し、そのまま走り抜けていく。
  const sim = newSim(['schoolgirl', 'swordsman']);
  place(sim, 400, 1000);
  const def = getProjectileDef('boyfriend');
  const slideAt = lungeSlideTick(def);
  run(sim, 1, BTN.SKILL);

  const find = () => sim.projectiles.find((p) => p.type === 'boyfriend');
  for (let i = 0; i < 220 && (find()?.lungeAge ?? -1) < 0; i += 1) run(sim, 1, 0);
  const bf = find();
  check('間合いに入ると突進に入る', bf?.lungeAge === 0, `lungeAge=${bf?.lungeAge}`);
  check('突進の踏み込みは速さが落ちない', Math.abs(bf.vx) === def.speed, `vx=${bf?.vx}`);

  // 最終コマの手前まで踏み込む（滑り出すのは最終コマに入ったティックから）
  run(sim, slideAt - 1, 0);
  check('最終コマまでは全速のまま', Math.abs(find().vx) === def.speed, `vx=${find()?.vx}`);

  // そこから滑って止まるまで
  let slid = 0;
  const xSlideStart = find().x;
  for (let i = 0; i < 60 && find() && find().vx !== 0; i += 1) {
    run(sim, 1, 0);
    slid += 1;
  }
  const stopped = find();
  check('最終コマから滑って止まる', stopped && stopped.vx === 0, `vx=${stopped?.vx}`);
  check('滑るのは一瞬ではない', slid > 8 && slid < 45, `${slid}F`);
  check('滑った距離はひと足ぶん', stopped.x - xSlideStart > 40, `${(stopped.x - xSlideStart).toFixed(0)}px`);
  check('止まっている間はまだ突進の絵', stopped.lungeDone === false);
  check('止まっても向きは変わらない', stopped.facing === 1, `facing=${stopped.facing}`);

  // 止まったら走り出す
  const xStop = stopped.x;
  run(sim, def.stopTicks, 0);
  check('一拍おいて走り出す', find()?.lungeDone === true);
  run(sim, 20, 0);
  const running = find();
  check('走り出したら元の速さまで戻る', Math.abs(running.vx - def.speed) < 0.001, `vx=${running?.vx}`);
  check('止まった位置から走り抜けていく', running.x > xStop + 100,
    `${xStop.toFixed(0)} → ${running.x.toFixed(0)}`);

  // 最後は画面外まで走り抜けて消える
  run(sim, 200, 0);
  check('走り抜けて消える', !find());
}

{
  // 壁際で呼んでも彼氏は出る。
  // 彼氏は 300 後ろから走ってくるので、壁を背負っていると出現位置が画面外になる。
  // 弾と同じに画面外で消していた頃は、ここでスキルがまるごと空振りになっていた。
  const sim = newSim(['schoolgirl', 'swordsman']);
  place(sim, STAGE_MARGIN, STAGE_WIDTH - STAGE_MARGIN);
  const p2 = sim.fighters[1];
  run(sim, 1, BTN.SKILL);

  const find = () => sim.projectiles.find((p) => p.type === 'boyfriend');
  for (let i = 0; i < 30 && !find(); i += 1) run(sim, 1, 0);
  const bf = find();
  check('壁際だと彼氏は画面外に出てくる', bf && bf.x < -60, `x=${bf?.x.toFixed(0)}`);
  run(sim, 10, 0);
  check('出てきた側の画面外では消えない', !!find(), `n=${sim.projectiles.length}`);

  for (let i = 0; i < 330 && p2.health > 0; i += 1) run(sim, 1, 0);
  check('壁際で呼んでも端の相手まで届く', p2.health === 0, `hp=${p2.health}`);
}

{
  // 走り抜けた先の画面外まで行ったら、そこで消える（寿命を待たずに次を呼べる）
  const sim = newSim(['schoolgirl', 'berserker']);
  place(sim, 400, 700);
  const def = getProjectileDef('boyfriend');
  run(sim, 1, BTN.SKILL);
  const find = () => sim.projectiles.find((p) => p.type === 'boyfriend');
  for (let i = 0; i < 30 && !find(); i += 1) run(sim, 1, 0);

  let last = null;
  for (let i = 0; i < def.lifetime && find(); i += 1) {
    last = find().x;
    run(sim, 1, 0);
  }
  check('走り抜けた先の画面外で消える', last > STAGE_WIDTH, `最後のx=${last?.toFixed(0)}`);
}

{
  // 走り抜ける間に何度も当たらない
  const sim = newSim(['schoolgirl', 'berserker']);
  place(sim, 400, 900);
  const p2 = sim.fighters[1];
  run(sim, 1, BTN.SKILL);
  let hits = 0;
  let prev = p2.health;
  for (let i = 0; i < 220; i += 1) {
    run(sim, 1, 0);
    if (p2.health < prev) {
      hits += 1;
      prev = p2.health;
    }
  }
  check('走り抜けても当たるのは一度だけ', hits === 1, `ヒット回数=${hits}`);
}

{
  // 空中で呼んでも彼氏は地面を走る（空を走らない）
  const sim = newSim(['schoolgirl', 'swordsman']);
  place(sim, 500, 1100);
  const p1 = sim.fighters[0];
  run(sim, 1, BTN.UP);
  run(sim, 10, 0);
  check('女子高生は浮いている', p1.y > 100, `y=${p1.y.toFixed(0)}`);
  run(sim, 1, BTN.SKILL);
  for (let i = 0; i < 25 && sim.projectiles.length === 0; i += 1) run(sim, 1, 0);
  const bf = sim.projectiles.find((p) => p.type === 'boyfriend');
  check('空中で呼んでも彼氏は地面から走る', bf && bf.y === 0, `y=${bf?.y}`);
  check('空中で呼んでも横に走る（落ちてこない）', bf && bf.vy === 0, `vy=${bf?.vy}`);
}

{
  // 彼氏は同時に 1 人まで。連呼できない
  const sim = newSim(['schoolgirl', 'berserker']);
  place(sim, 500, 1400);
  run(sim, 1, BTN.SKILL);
  for (let i = 0; i < 20 && sim.projectiles.length === 0; i += 1) run(sim, 1, 0);
  const first = sim.projectiles.length;
  run(sim, 40, BTN.SKILL);
  const bfCount = sim.projectiles.filter((p) => p.type === 'boyfriend').length;
  check('彼氏は場に1人まで', first === 1 && bfCount <= 1, `${first} → ${bfCount}`);
}

{
  // 空中でも両方出せる
  const sim = newSim(['schoolgirl', 'swordsman']);
  place(sim, 500, 1100);
  const p1 = sim.fighters[0];
  run(sim, 1, BTN.UP);
  run(sim, 6, 0);
  run(sim, 1, BTN.ATTACK);
  check('空中攻撃が出る', p1.moveId === 'airLaser', `move=${p1.moveId}`);
  for (let i = 0; i < 20 && sim.projectiles.length === 0; i += 1) run(sim, 1, 0);
  const shot = sim.projectiles[0];
  check('空中レーザーは斜め下へ飛ぶ', shot && shot.vx > 0 && shot.vy < 0,
    `vx=${shot?.vx.toFixed(1)} vy=${shot?.vy.toFixed(1)}`);
  check('空中でもスマホの高さから出る', shot.y - p1.y > 150 && shot.y - p1.y < 185,
    `高さ=${(shot.y - p1.y).toFixed(0)}`);
}

{
  // 彼氏の絵の切り替えは「相手との距離」で決めている。
  // 経過フレームで切り替えると、呼んだ位置によって突進の見た目がずれる。
  const { PROJECTILES } = await import('../src/game/projectiles.js');
  const bf = PROJECTILES.boyfriend;
  check('彼氏は距離で走り→突進に切り替える', bf.tackleRange > 0, `range=${bf.tackleRange}`);
  check('切り替えは判定が届く手前で起きる', bf.tackleRange > bf.box.w / 2,
    `range=${bf.tackleRange} 判定幅の半分=${bf.box.w / 2}`);
  check('走りと突進の両方の絵を持つ', !!bf.anims.run && !!bf.anims.hit);
  // 突進のシートは 1 回ぶんの動き。**踏み込みの絵が出ている間に触っていないと**、
  // 走りの絵のまま体当たりしたように見える。触るのは間合いを判定の半幅ぶん詰めたところ。
  const touchFrames = (bf.tackleRange - bf.box.w / 2) / bf.speed;
  const playFrames = (bf.tackleFrames * 60) / bf.tackleFps;
  check('ぶつかるのは突進を出し切る前',
    playFrames > touchFrames,
    `出し切り=${playFrames.toFixed(0)}F 触るまで=${touchFrames.toFixed(0)}F`);
  // 逆に長すぎると、当たったあともいつまでも踏み込みの絵が残る
  check('突進の絵が余りすぎない', playFrames < touchFrames * 2,
    `出し切り=${playFrames.toFixed(0)}F 触るまで=${touchFrames.toFixed(0)}F`);
}

{
  // 突進の絵は**頭から 1 回だけ**再生する。
  // 相手との距離からコマを決めると、追い越したあとに距離が開いて
  // コマが逆戻りし、2 周したように見えてしまう。
  const sim = newSim(['schoolgirl', 'swordsman']);
  place(sim, 400, 1100);
  run(sim, 1, BTN.SKILL);
  for (let i = 0; i < 25 && sim.projectiles.length === 0; i += 1) run(sim, 1, 0);
  const bf = sim.projectiles.find((p) => p.type === 'boyfriend');
  check('走っている間は突進を数え始めない', bf?.lungeAge === -1, `lungeAge=${bf?.lungeAge}`);

  const ages = [];
  for (let i = 0; i < 200; i += 1) {
    run(sim, 1, 0);
    const cur = sim.projectiles.find((p) => p.type === 'boyfriend');
    if (cur && cur.lungeAge >= 0) ages.push(cur.lungeAge);
  }
  check('突進に入ったら数え始める', ages.length > 0);
  let monotone = true;
  for (let i = 1; i < ages.length; i += 1) if (ages[i] <= ages[i - 1]) monotone = false;
  check('追い越しても突進のコマが巻き戻らない', monotone,
    `並び=${ages.slice(0, 6).join(',')}…`);
  check('突進を出し切るだけ数えている', ages[ages.length - 1] >= 22,
    `最終=${ages[ages.length - 1]}`);
}

// ── 淫魔（飛行） ────────────────────────────────────────────
section('淫魔の飛行');
{
  // 1・2段目は他のキャラと同じ跳び上がり。3段目から先が滞空になる。
  const sim = newSim(['succubus', 'swordsman']);
  const p1 = sim.fighters[0];
  const { flight } = p1.def;

  run(sim, 1, BTN.UP);
  check('1段目は普通に跳び上がる', p1.vy > 0, `vy=${p1.vy.toFixed(2)}`);

  run(sim, 24, 0);
  run(sim, 1, BTN.UP);
  check('2段目も跳び上がる', p1.vy > 0, `vy=${p1.vy.toFixed(2)}`);

  // 3段目 = 滞空。高度は上がらない
  run(sim, 24, 0);
  const yBefore = p1.y;
  run(sim, 1, BTN.UP);
  // 滞空は毎ティック vy を 0 に戻して重力を打ち消す作りなので、
  // ティックの終わりに残る vy は 1 ティックぶんの重力（負）になる。
  // 見るべきは「上向きの初速が付いていないこと」。
  check('3段目は跳び上がらない', p1.vy <= 0, `vy=${p1.vy.toFixed(2)}`);
  check('3段目は滞空に入る', p1.hoverTicks > 0, `hover=${p1.hoverTicks}`);

  run(sim, 20, 0);
  check('滞空中は高度が変わらない', Math.abs(p1.y - yBefore) < 0.001,
    `y ${yBefore.toFixed(2)} -> ${p1.y.toFixed(2)}`);
  check('滞空中の絵は fly', p1.anim.name === 'fly', `anim=${p1.anim.name}`);

  // 滞空中は左右に動ける
  const xBefore = p1.x;
  run(sim, 10, BTN.LEFT);
  check('滞空中は左右に動ける', p1.x < xBefore - 20, `x ${xBefore.toFixed(1)} -> ${p1.x.toFixed(1)}`);
  check('滞空中に横移動しても高度は変わらない', Math.abs(p1.y - yBefore) < 0.001,
    `y=${p1.y.toFixed(2)}`);

  // 滞空は時間切れで落下に戻る（30ティックぶん浮いたので残りはこれだけ）
  run(sim, flight.ticks - 30, 0);
  check('滞空の残りが尽きる', p1.hoverTicks === 0, `hover=${p1.hoverTicks}`);
  run(sim, 4, 0);
  check('滞空が切れると落ち始める', p1.vy < -GRAVITY && p1.y < yBefore,
    `vy=${p1.vy.toFixed(2)} y ${yBefore.toFixed(2)} -> ${p1.y.toFixed(2)}`);
}

{
  // 合計 5 段まで。6 段目は受け付けない。
  const sim = newSim(['succubus', 'swordsman']);
  const p1 = sim.fighters[0];

  run(sim, 1, BTN.UP);
  for (let n = 2; n <= 5; n += 1) {
    run(sim, 6, 0);
    run(sim, 1, BTN.UP);
    check(`${n}段目まで跳べる`, p1.y > 0 && (p1.vy > 0 || p1.hoverTicks > 0),
      `vy=${p1.vy.toFixed(2)} hover=${p1.hoverTicks}`);
  }
  check('5段使い切ると残りが 0', p1.airJumps === 0, `airJumps=${p1.airJumps}`);

  // 6段目は出ない（滞空も跳び上がりも起きない）
  run(sim, 50, 0);
  const hoverBefore = p1.hoverTicks;
  run(sim, 1, BTN.UP);
  check('6段目は受け付けない', p1.vy < 0 && p1.hoverTicks === hoverBefore,
    `vy=${p1.vy.toFixed(2)} hover=${p1.hoverTicks}`);

  // 着地すれば戻る
  for (let i = 0; i < 200 && p1.y > 0; i += 1) run(sim, 1, 0);
  run(sim, 12, 0);
  check('着地で飛行の回数が戻る', p1.airJumps === 0 && p1.state !== STATE.JUMP,
    `airJumps=${p1.airJumps} state=${p1.state}`);
  run(sim, 1, BTN.UP);
  check('着地後にまた跳べる', p1.airJumps === p1.def.airJumps,
    `airJumps=${p1.airJumps}`);
}

{
  // 滞空から急降下へ繋げられる（技を出すと滞空は終わる）
  const sim = newSim(['succubus', 'swordsman']);
  const p1 = sim.fighters[0];
  run(sim, 1, BTN.UP);
  run(sim, 20, 0);
  run(sim, 1, BTN.UP);
  run(sim, 20, 0);
  run(sim, 1, BTN.UP);
  check('滞空している', p1.hoverTicks > 0, `hover=${p1.hoverTicks}`);
  run(sim, 1, BTN.SKILL);
  check('滞空から急降下を出せる', p1.moveId === 'diveKick', `move=${p1.moveId}`);
  check('技を出すと滞空は終わる', p1.hoverTicks === 0, `hover=${p1.hoverTicks}`);

  // divekick シートは脚を引く順で撮れているので逆再生で出す。
  // 出だしは脚を畳んだ最終コマ、蹴り足が伸びた先頭コマで終わる。
  const { resolveFrame } = await import('../src/render/spritebank.js');
  const { readFileSync: readSheet } = await import('node:fs');
  const succubusSheet = JSON.parse(
    readSheet(new URL('../assets/characters/succubus.json', import.meta.url), 'utf8'));
  const kickFrame = () => resolveFrame(p1.anim, succubusSheet).index;
  check('急降下は逆再生で出す', p1.anim.reverse === true, `reverse=${p1.anim.reverse}`);
  check('出だしは脚を畳んだコマ', kickFrame() === 7, `frame=${kickFrame()}`);
  run(sim, 8, 0);
  check('急降下は落ちていく', p1.vy < 0, `vy=${p1.vy.toFixed(2)}`);
  run(sim, 10, 0);
  // 抜き残りのある先頭コマは使わないので、伸び切りは 1 コマ目で止まる
  check('落ちきる前に蹴り足が伸び切る', kickFrame() === 1, `frame=${kickFrame()}`);
  check('伸ばしたまま落ちていく', p1.moveId === 'diveKick' && p1.vy < 0, `move=${p1.moveId}`);
}

// ── 淫魔（掴み） ────────────────────────────────────────────
section('淫魔の吸血');
{
  // ガードしていても掴まれる
  const sim = newSim(['succubus', 'swordsman']);
  place(sim, 800, 890);
  const [p1, p2] = sim.fighters;

  run(sim, 1, BTN.SKILL, BTN.GUARD);
  check('スキルで掴みが出る', p1.moveId === 'drainCatch', `move=${p1.moveId}`);

  for (let i = 0; i < 30 && !p2.isGrabbed; i += 1) run(sim, 1, 0, BTN.GUARD);
  check('ガードしていても掴まれる', p2.isGrabbed, `state=${p2.state}`);
  check('掴んだ側は保持の技へ移る', p1.moveId === 'drainHold', `move=${p1.moveId}`);
  check('掴まれた時点で致命傷', p2.doomed && p2.health === 0,
    `doomed=${p2.doomed} hp=${p2.health}`);

  // 保持位置に固定される
  const hold = p1.def.moves.drainHold.grabHold;
  run(sim, 10, 0, BTN.GUARD);
  check('掴まれた相手は宙に浮く', p2.y === hold.y && hold.y > 0, `y=${p2.y}`);
  check('掴まれた相手は目の前に固定される',
    Math.abs(p2.x - (p1.x + p1.facing * hold.x)) < 0.001,
    `x=${p2.x.toFixed(1)} 期待=${(p1.x + p1.facing * hold.x).toFixed(1)}`);
  // 吸っている口元（drain シートで実測した足元からの位置）が相手の体に届くこと。
  // 保持位置を動かすとまず最初にここが外れる。
  const MOUTH = { x: 38, y: 160 };
  const mouthX = p1.x + p1.facing * MOUTH.x;
  const hb = p2.hurtBox();
  check('口元が相手の体に重なる',
    mouthX > hb.x && mouthX < hb.x + hb.w && MOUTH.y > hb.y && MOUTH.y < hb.y + hb.h,
    `口元=(${(mouthX - p1.x).toFixed(0)},${MOUTH.y}) 相手=${(hb.x - p1.x).toFixed(0)}〜${(hb.x + hb.w - p1.x).toFixed(0)} / ${hb.y}〜${(hb.y + hb.h).toFixed(0)}`);
  check('掴まれた相手は掴んだ側を向く', p2.facing === -p1.facing,
    `p1=${p1.facing} p2=${p2.facing}`);
  check('掴まれている間の絵は grabbed', p2.anim.name === 'grabbed', `anim=${p2.anim.name}`);

  const heldX = p2.x;
  run(sim, 10, 0, BTN.LEFT | BTN.GUARD);
  check('掴まれている間は逃げられない', Math.abs(p2.x - heldX) < 0.001,
    `x ${heldX.toFixed(1)} -> ${p2.x.toFixed(1)}`);

  // 吸い切ると投げ捨てられて決着
  for (let i = 0; i < 200 && !p2.isKO; i += 1) run(sim, 1, 0, BTN.GUARD);
  check('吸い切ると倒れる', p2.isKO, `state=${p2.state}`);
  check('掴みは解けている', p2.grabbedBy === -1, `grabbedBy=${p2.grabbedBy}`);
}

{
  // 跳ばれると掴めない ＝ ジャンプが掴みへの答え
  const sim = newSim(['succubus', 'swordsman']);
  place(sim, 800, 890);
  const [p1, p2] = sim.fighters;

  // 相手を先に跳ばせてから掴みにいく
  run(sim, 1, 0, BTN.UP);
  run(sim, 6, 0, 0);
  check('相手は空中にいる', p2.airborne, `y=${p2.y.toFixed(1)}`);

  run(sim, 1, BTN.SKILL);
  run(sim, 24, 0);
  check('跳んでいる相手は掴めない', !p2.isGrabbed && !p2.doomed,
    `state=${p2.state} doomed=${p2.doomed}`);
  check('掴みは空振りして終わる', p1.moveId === 'drainCatch' || p1.state !== STATE.MOVE,
    `move=${p1.moveId} state=${p1.state}`);
}

{
  // 外したら硬直が残る（振り切るまで動けない）
  const sim = newSim(['succubus', 'swordsman']);
  place(sim, 600, 1100); // 届かない間合い
  const [p1] = sim.fighters;
  const total = p1.def.moves.drainCatch.total;

  run(sim, 1, BTN.SKILL);
  run(sim, total - 4, BTN.RIGHT);
  check('掴みを外すと技が最後まで残る', p1.state === STATE.MOVE && p1.moveId === 'drainCatch',
    `state=${p1.state} move=${p1.moveId}`);
  run(sim, 8, 0);
  check('振り切れば動けるようになる', p1.state !== STATE.MOVE, `state=${p1.state}`);
}

{
  // 掴んでいる最中に掴んだ側が倒されたら、掴まれた側は落とされる
  const sim = newSim(['succubus', 'swordsman']);
  place(sim, 800, 890);
  const [p1, p2] = sim.fighters;

  run(sim, 1, BTN.SKILL);
  for (let i = 0; i < 30 && !p2.isGrabbed; i += 1) run(sim, 1, 0);
  check('掴めている（前提）', p2.isGrabbed, `state=${p2.state}`);

  // 掴んでいる側を強制的に技から降ろす。
  // 掴んだ瞬間はヒットストップが入っているので、明けるまで数ティック待つ。
  p1._toIdle();
  for (let i = 0; i < 20 && p2.isGrabbed; i += 1) run(sim, 1, 0);
  check('掴みが中断されると落とされる', !p2.isGrabbed && p2.grabbedBy === -1,
    `state=${p2.state} grabbedBy=${p2.grabbedBy}`);
  // 致命傷は負ったままなので、落ちきれば決着する
  for (let i = 0; i < 200 && !p2.isKO; i += 1) run(sim, 1, 0);
  check('落とされた相手はそのまま倒れる', p2.isKO, `state=${p2.state}`);
}

{
  // 引っ掻きは 2 段に繋がる。
  // 当ててしまうとヒットストップで技が止まって窓の検証にならないので、
  // わざと届かない間合いから振る。
  const sim = newSim(['succubus', 'swordsman']);
  place(sim, 700, 1150);
  const [p1] = sim.fighters;

  run(sim, 1, BTN.ATTACK);
  check('攻撃で引っ掻きが出る', p1.moveId === 'claw1', `move=${p1.moveId}`);
  run(sim, 9, 0);
  run(sim, 1, BTN.ATTACK);
  // atEnd の連携なので、押した時点では 1 段目は切れない（受付だけ済ませる）
  check('押した時点では1段目は切れない', p1.moveId === 'claw1', `move=${p1.moveId}`);
  check('2段目を予約している', p1.chainQueued === 'claw2', `queued=${p1.chainQueued}`);
  run(sim, 16, 0);
  check('出し切るまで1段目のまま', p1.moveId === 'claw1' && p1.moveFrame === 25,
    `move=${p1.moveId} frame=${p1.moveFrame}`);
  run(sim, 1, 0);
  check('引っ掻きは2段目に繋がる', p1.moveId === 'claw2', `move=${p1.moveId}`);
  check('2段目は先頭から始まる', p1.moveFrame === 0, `frame=${p1.moveFrame}`);
}

{
  // 段ごとに使うシートを入れ替えてある（1段目=claw2 の絵 / 2段目=claw1 の絵）
  const def = getCharacter('succubus');
  check('1段目はその場で振る絵', def.moves.claw1.anim === 'claw2', def.moves.claw1.anim);
  check('2段目は踏み込む絵', def.moves.claw2.anim === 'claw1', def.moves.claw2.anim);
}

{
  // ロスター全員をちゃんと掴めること。掴まれ用の絵が無いキャラがいると
  // ここで落ちる（同キャラ戦があるので淫魔自身も対象）。
  const { CHARACTER_IDS } = await import('../src/game/characters/index.js');
  for (const id of CHARACTER_IDS) {
    const sim = newSim(['succubus', id]);
    place(sim, 800, 890);
    const [p1, p2] = sim.fighters;

    run(sim, 1, BTN.SKILL, BTN.GUARD);
    for (let i = 0; i < 40 && !p2.isGrabbed; i += 1) run(sim, 1, 0, BTN.GUARD);
    check(`${p2.def.name}を掴める`, p2.isGrabbed, `state=${p2.state}`);

    for (let i = 0; i < 250 && !p2.isKO; i += 1) run(sim, 1, 0, BTN.GUARD);
    check(`${p2.def.name}を吸い切って倒せる`, p2.isKO, `state=${p2.state}`);
  }
}

// ── キャヴァリア ────────────────────────────────────────────
// 「攻撃そのものが踏み込み」「空中は高度を保って横へ抜ける」という
// このキャラの前提が崩れていないかを見る。
section('キャヴァリアの切り抜け');
{
  const sim = newSim(['cavalier', 'swordsman']);
  place(sim, 600, 1400);
  const p1 = sim.fighters[0];
  const x0 = p1.x;
  run(sim, 1, BTN.ATTACK);
  run(sim, 1, 0);
  check('攻撃で切り抜けが出る', p1.moveId === 'boostSlash', `move=${p1.moveId}`);
  run(sim, 40, 0);
  check('振るとそのまま踏み込む', p1.x - x0 > 120, `travel=${(p1.x - x0).toFixed(0)}`);
  check('地上で出しても浮かない', p1.y === 0, `y=${p1.y}`);
}

{
  // 踏み込みぶん、判定リーチ(156)より遠くから届く
  const sim = newSim(['cavalier', 'swordsman']);
  place(sim, 820, 1080);
  const p2 = sim.fighters[1];
  run(sim, 1, BTN.ATTACK);
  for (let i = 0; i < 40 && !p2.doomed; i += 1) run(sim, 1, 0);
  check('離れていても切り抜けが届く', p2.doomed, `state=${p2.state}`);
}

{
  // 切り抜けは打撃。スキルと違ってガードは通る
  const sim = newSim(['cavalier', 'swordsman']);
  place(sim, 820, 980);
  const p2 = sim.fighters[1];
  run(sim, 1, BTN.ATTACK, BTN.GUARD);
  run(sim, 40, 0, BTN.GUARD);
  check('切り抜けはガードできる', !p2.doomed, `state=${p2.state}`);
}

{
  // 2 段目は斬らずに後ろへ跳び退く。攻撃判定は持たない。
  // 連打で入力しても 1 段目の判定が切れないこと（受付は判定が終わってから開く）も見る。
  const sim = newSim(['cavalier', 'swordsman']);
  place(sim, 500, 1500);
  const p1 = sim.fighters[0];
  const seen = [];
  const track = [];
  let stage2Hits = 0;
  for (let i = 0; i < 120; i += 1) {
    // 連打（5 ティックごと）。人が押すより速いので、早すぎる連携の検出になる
    run(sim, 1, i % 5 === 0 ? BTN.ATTACK : 0);
    if (p1.moveId && seen.at(-1) !== p1.moveId) seen.push(p1.moveId);
    if (p1.moveId === 'backBoost') stage2Hits += p1.activeHits().length;
    track.push({ move: p1.moveId, x: p1.x, y: p1.y });
  }
  check('攻撃の押し直しで後退ブーストへ繋がる',
    seen.slice(0, 2).join('>') === 'boostSlash>backBoost', seen.join('>'));

  const span = (id) => {
    const f = track.filter((t) => t.move === id);
    return { dx: f.at(-1).x - f[0].x, dy: f.at(-1).y - f[0].y };
  };
  check('1段目は前へ出る', span('boostSlash').dx > 60, `dx=${span('boostSlash').dx.toFixed(0)}`);
  check('2段目は後ろへ抜ける', span('backBoost').dx < -60, `dx=${span('backBoost').dx.toFixed(0)}`);
  check('2段目に攻撃判定は無い', stage2Hits === 0, `hits=${stage2Hits}`);
  check('2段目はジャンプの絵を使う',
    getCharacter('cavalier').moves.backBoost.anim === getCharacter('cavalier').anims.jump,
    getCharacter('cavalier').moves.backBoost.anim);
}

{
  // 2 段目は斜め上へ跳ぶので、跳んでから落ちるまでが 1 セット。
  // 跳び上がったところで技が終わると、そこからまた攻撃 → 後退で上がれてしまう。
  const sim = newSim(['cavalier', 'swordsman']);
  place(sim, 500, 1500);
  const p1 = sim.fighters[0];
  run(sim, 1, BTN.ATTACK);
  while (p1.moveFrame < 24) run(sim, 1, 0);
  run(sim, 1, BTN.ATTACK);
  run(sim, 1, 0);
  let peak = 0;
  while (p1.moveId === 'backBoost') {
    peak = Math.max(peak, p1.y);
    run(sim, 1, 0);
  }
  check('2段目は斜め上へ跳ぶ', peak > 60, `peak=${peak.toFixed(0)}`);
  check('2段目は落ち切ってから終わる', p1.y === 0, `y=${p1.y.toFixed(1)}`);
}

{
  // 刻み 4 発 → 締めの 1 発。締めは斬り抜けた勢いで相手を浮かせる
  const sim = newSim(['cavalier', 'swordsman']);
  place(sim, 800, 980);
  const [p1, p2] = sim.fighters;
  run(sim, 1, BTN.ATTACK);
  let peak = 0;
  // 刻みごとにヒットストップが挟まるので、実時間では総フレームより長くかかる
  for (let i = 0; i < 80; i += 1) {
    run(sim, 1, 0);
    peak = Math.max(peak, p2.y);
  }
  check('切り抜けは多段ヒットする', p1.comboDisplay === 5, `hits=${p1.comboDisplay}`);
  check('締めで相手を打ち上げる', peak > 40, `peak=${peak.toFixed(0)}`);
}

{
  // 空中スキルも多段。回っている刃で削ってから弾き飛ばす
  const sim = newSim(['cavalier', 'swordsman']);
  place(sim, 650, 770);
  const [p1, p2] = sim.fighters;
  run(sim, 1, BTN.UP);
  run(sim, 1, 0);
  run(sim, 1, BTN.SKILL);
  for (let i = 0; i < 120; i += 1) run(sim, 1, 0, BTN.GUARD);
  check('錐揉み突進は多段ヒットする', p1.comboDisplay === 6, `hits=${p1.comboDisplay}`);
  check('締めでダウンを奪う', p2.isKO, `state=${p2.state}`);
}

{
  // 掴みも締めが多段。掴んだ 1 回とあわせて 5 ヒットになる
  const sim = newSim(['cavalier', 'swordsman']);
  place(sim, 800, 940);
  const [p1, p2] = sim.fighters;
  run(sim, 1, BTN.SKILL, BTN.GUARD);
  for (let i = 0; i < 240 && !p2.isKO; i += 1) run(sim, 1, 0, BTN.GUARD);
  check('串刺しは締めが多段ヒットする', p1.comboDisplay === 5, `hits=${p1.comboDisplay}`);
}

{
  // 通常攻撃 2 段目からスキルで空中スキルへ繋がる。
  // 跳び退いた高さがそのまま突進の高さになる。
  const sim = newSim(['cavalier', 'swordsman']);
  place(sim, 500, 1500);
  const p1 = sim.fighters[0];
  run(sim, 1, BTN.ATTACK);
  while (p1.moveFrame < 28) run(sim, 1, 0);
  run(sim, 1, BTN.ATTACK);
  run(sim, 1, 0);
  check('2段目が出ている', p1.moveId === 'backBoost', `move=${p1.moveId}`);
  run(sim, 12, 0);
  run(sim, 1, BTN.SKILL);
  run(sim, 1, 0);
  check('2段目からスキルで錐揉み突進へ繋がる', p1.moveId === 'drillDash', `move=${p1.moveId}`);
  check('跳び退いた高さのまま突進に入る', p1.y > 40, `y=${p1.y.toFixed(0)}`);
}

{
  // 1 段目の絵は「構えたまま踏み込んで、判定が切れるあたりで振り抜く」。
  // animDelay がゼロに戻ると、突っ込む前に振り終わってしまう。
  const { resolveFrame } = await import('../src/render/spritebank.js');
  const { readFileSync: readSheet } = await import('node:fs');
  const sheet = JSON.parse(
    readSheet(new URL('../assets/characters/cavalier.json', import.meta.url), 'utf8'));

  const sim = newSim(['cavalier', 'swordsman']);
  place(sim, 500, 1500);
  const p1 = sim.fighters[0];
  run(sim, 1, BTN.ATTACK);
  const frames = [];
  for (let i = 0; i < 34; i += 1) {
    frames.push(resolveFrame(p1.anim, sheet).index);
    run(sim, 1, 0);
  }
  const hit = getCharacter('cavalier').moves.boostSlash.hits[0];
  check('判定が出ている間は1枚目のまま',
    frames.slice(0, hit.end).every((f) => f === frames[0]),
    frames.join(''));
  check('判定が切れたら残りのコマが流れる', frames.at(-1) > frames[0] + 4, frames.join(''));
}

{
  // 2 段目は斜め上へ抜けるので、空中で連打すると上がり続けかねない。
  // 跳んだぶんを落ち切らせる長さにして、1 巡すると必ず落ちるようにしてある。
  // 2 段目からスキルで突進へ繋がるので、両方のボタンを混ぜて叩く。
  const sim = newSim(['cavalier', 'swordsman']);
  place(sim, 400, 1700);
  const p1 = sim.fighters[0];
  let maxY = 0;
  let landed = 0;
  for (let i = 0; i < 600; i += 1) {
    run(sim, 1, (i % 5 === 0 ? BTN.ATTACK : 0) | (i % 7 === 0 ? BTN.SKILL : 0));
    maxY = Math.max(maxY, p1.y);
    if (p1.y === 0) landed += 1;
  }
  check('空中で連打しても上がり続けない', maxY < 400 && landed > 0,
    `maxY=${maxY.toFixed(0)} landed=${landed}`);
}

{
  // 空中攻撃は地上とまったく同じ技を指している
  const def = getCharacter('cavalier');
  check('空中攻撃は地上と同じ技', def.airAttackMove === def.attackMove,
    `${def.attackMove} / ${def.airAttackMove}`);

  // 上昇中に出しても、その場で高度が止まって横へ抜ける
  const sim = newSim(['cavalier', 'swordsman']);
  place(sim, 600, 1400);
  const p1 = sim.fighters[0];
  run(sim, 1, BTN.UP);
  run(sim, 6, 0);
  run(sim, 1, BTN.ATTACK);
  check('空中でも切り抜けが出る', p1.moveId === 'boostSlash', `move=${p1.moveId}`);
  const y0 = p1.y;
  const x0 = p1.x;
  let drift = 0;
  for (let i = 0; i < 20; i += 1) {
    run(sim, 1, 0);
    drift = Math.max(drift, Math.abs(p1.y - y0));
  }
  check('空中では高度を保ったまま抜ける', drift < 2 && p1.x - x0 > 90,
    `drift=${drift.toFixed(1)} dx=${(p1.x - x0).toFixed(0)}`);
}

section('キャヴァリアの串刺し');
{
  const sim = newSim(['cavalier', 'swordsman']);
  place(sim, 800, 940);
  const [p1, p2] = sim.fighters;
  run(sim, 1, BTN.SKILL, BTN.GUARD);
  for (let i = 0; i < 40 && !p2.isGrabbed; i += 1) run(sim, 1, 0, BTN.GUARD);
  check('ガードごと貫いて掴む', p2.isGrabbed, `state=${p2.state}`);

  // 掴んだ瞬間はヒットストップで両者止まっている。位置が決まるのはそのあと
  run(sim, 10, 0, BTN.GUARD);
  const hold = getCharacter('cavalier').moves.pierceHold.grabHold;
  check('刃の先に吊るされる', Math.abs(p2.x - (p1.x + p1.facing * hold.x)) < 0.01,
    `dx=${(p2.x - p1.x).toFixed(1)} hold=${hold.x}`);
  check('地面から持ち上がる', p2.y === hold.y, `y=${p2.y}`);

  for (let i = 0; i < 200 && !p2.isKO; i += 1) run(sim, 1, 0, BTN.GUARD);
  check('刃から蹴り飛ばして倒し切る', p2.isKO, `state=${p2.state}`);
}

{
  // 掴みなので跳ばれると当たらない（淫魔の吸血と同じ択）
  const sim = newSim(['cavalier', 'swordsman']);
  place(sim, 800, 940);
  const p2 = sim.fighters[1];
  run(sim, 1, BTN.SKILL, BTN.UP);
  run(sim, 40, 0, 0);
  check('串刺しは跳んで避けられる', !p2.isGrabbed && !p2.doomed, `state=${p2.state}`);
}

section('キャヴァリアの錐揉み突進');
{
  const sim = newSim(['cavalier', 'swordsman']);
  place(sim, 400, 1600);
  const p1 = sim.fighters[0];
  run(sim, 1, BTN.UP);
  run(sim, 10, 0);
  run(sim, 1, BTN.SKILL);
  check('空中スキルで突進が出る', p1.moveId === 'drillDash', `move=${p1.moveId}`);

  const x0 = p1.x;
  const y0 = p1.y;
  run(sim, 30, 0);
  const dx = p1.x - x0;
  const dy = y0 - p1.y;
  check('横に長く突っ込む', dx > 200, `dx=${dx.toFixed(0)}`);
  // 沈むには沈むが、進む距離に対しては水平と言える範囲に収める
  check('沈み方は水平に見える範囲', dy > 0 && dy < dx * 0.4, `dx=${dx.toFixed(0)} dy=${dy.toFixed(0)}`);
}

{
  // 錐揉みは 6 コマで 1 回転する閉じたループ。技の全体フレームより速く回すため、
  // animLoop で繰り返している。ここが false に戻ると、回り切ったあと最後のコマで
  // 固まったまま飛ぶ（絵は出ているのでシミュレーションのテストでは気づけない）。
  const { resolveFrame } = await import('../src/render/spritebank.js');
  const { readFileSync: readSheet } = await import('node:fs');
  const sheet = JSON.parse(
    readSheet(new URL('../assets/characters/cavalier.json', import.meta.url), 'utf8'));

  const sim = newSim(['cavalier', 'swordsman']);
  place(sim, 400, 1600);
  const p1 = sim.fighters[0];
  run(sim, 1, BTN.UP);
  run(sim, 10, 0);
  run(sim, 1, BTN.SKILL);
  let turns = 0;
  let prev = resolveFrame(p1.anim, sheet).index;
  for (let i = 0; i < 36; i += 1) {
    run(sim, 1, 0);
    const f = resolveFrame(p1.anim, sheet).index;
    // コマ番号が戻ったら 1 回転ぶん回り切ったということ
    if (f < prev) turns += 1;
    prev = f;
  }
  check('錐揉みは突進中に何回も回る', turns >= 2, `turns=${turns}`);
  check('錐揉みは繰り返し再生になっている', getCharacter('cavalier').moves.drillDash.animLoop === true);
}

{
  // 体が胸の高さに浮いている姿勢なので、沈まないと相手の頭上を通ってしまう。
  // ジャンプのどの高さから出しても当たることを確かめる。
  for (const wait of [1, 8, 16]) {
    const sim = newSim(['cavalier', 'swordsman']);
    place(sim, 650, 1000);
    const [p1, p2] = sim.fighters;
    run(sim, 1, BTN.UP);
    run(sim, wait, 0);
    const alt = p1.y;
    run(sim, 1, BTN.SKILL);
    for (let i = 0; i < 60 && !p2.doomed; i += 1) run(sim, 1, 0, BTN.GUARD);
    check(`高度${alt.toFixed(0)}から出しても当たる`, p2.doomed, `state=${p2.state}`);
  }
}

{
  // もう一度スキルを押すと宙返りに切り替えて降りる。判定は持たない
  const sim = newSim(['cavalier', 'swordsman']);
  place(sim, 400, 1600);
  const p1 = sim.fighters[0];
  run(sim, 1, BTN.UP);
  run(sim, 12, 0);
  run(sim, 1, BTN.SKILL);
  run(sim, 10, 0);
  const y0 = p1.y;
  run(sim, 1, BTN.SKILL);
  run(sim, 1, 0);
  check('突進中にスキルで降下へ切り替わる', p1.moveId === 'boostDrop', `move=${p1.moveId}`);

  let hits = 0;
  let ticks = 0;
  while (ticks < 60 && p1.moveId === 'boostDrop') {
    hits += p1.activeHits().length;
    run(sim, 1, 0);
    ticks += 1;
  }
  check('降下に攻撃判定は無い', hits === 0, `hits=${hits}`);
  check('降下は落下より速く地面に着く', p1.y === 0 && ticks < y0 / 10,
    `y=${p1.y.toFixed(1)} ticks=${ticks} from=${y0.toFixed(0)}`);
  check('降下の着地硬直は軽い', p1.landLag === getCharacter('cavalier').moves.boostDrop.landLag,
    `landLag=${p1.landLag}`);
}

// ── キャヴァリアの演出 ──────────────────────────────────────
// 絵そのものは目で見るしかないが、「どこに何を出すか」はデータなので確かめられる。
section('キャヴァリアの演出');
{
  const def = getCharacter('cavalier');

  // 光の弧は「ここに攻撃判定がある」という合図でもある。
  // 判定を持たない技（後退ブースト・宙返り降下）に付くと嘘になる。
  const lying = Object.values(def.moves)
    .filter((m) => m.spawns.some((s) => s.type === 'slash') && m.hits.length === 0)
    .map((m) => m.id);
  check('光の弧は判定のある技にだけ付く', lying.length === 0, lying.join(' '));

  // 鋼の刃の色のままだとビームに見えない。技側で色を差し替えている
  const arcs = Object.values(def.moves).flatMap((m) => m.spawns.filter((s) => s.type === 'slash'));
  check('弧はビームの色になっている', arcs.length >= 8 && arcs.every((s) => s.tint),
    `n=${arcs.length}`);

  // 一番よく振る技に弧を付けると、白い帯のほうが攻撃の絵に見えてしまう。
  // 薄いコマの穴埋めは発光層（beamGlow）の担当で、弧の仕事ではない
  check('切り抜けに弧は付かない',
    def.moves.boostSlash.spawns.every((s) => s.type !== 'slash'),
    def.moves.boostSlash.spawns.map((s) => s.type).join(' '));

  // 弧が残るのは「絵の刃より判定が先まで出ている技」だけ。
  // 出しっぱなしにせず、判定の出ている間を覆えているかを見る
  for (const id of ['pierce', 'pierceHold', 'drillDash']) {
    const m = def.moves[id];
    const covered = m.hits.every((h) =>
      m.spawns.some((s) => s.frame <= h.start && s.frame + s.duration >= h.start));
    check(`${id}: 弧は判定の出ている間を覆う`, covered,
      m.spawns.map((s) => `${s.frame}+${s.duration}`).join(' '));
  }
}

{
  // スラスターの粒（描画専用）。湧かせ方の判断は純粋な計算なので、
  // ブラウザを出さずにそのまま叩ける。
  const { SparkleField } = await import('../src/render/sparkles.js');
  const def = getCharacter('cavalier');
  const th = def.thruster;
  check('湧き始める速さは最大より遅い', th.idle < th.full, `${th.idle} / ${th.full}`);
  check('歩きでは湧かない速さになっている', th.idle >= def.walkSpeed - 0.5,
    `idle=${th.idle} walk=${def.walkSpeed}`);

  const field = new SparkleField();
  const fake = (vx, vy, extra = {}) => ({
    def, index: 0, x: 900, y: 0, facing: 1, vx, vy, hitstop: 0, isKO: false, ...extra,
  });
  // 常時漏れるぶんには濃さ（dim）が付いている。排気と見分けるのに使う
  const ambient = () => field.parts.filter((p) => p.dim != null);
  const exhaust = () => field.parts.filter((p) => p.dim == null);

  // 止まっていても背中から漏れ続ける
  for (let i = 0; i < 30; i += 1) field.emit(fake(0, 0));
  check('止まっていても粒が出る', ambient().length > 5, `n=${ambient().length}`);
  check('止まっているぶんは背中側から出る', ambient().every((p) => p.x < 900),
    `x=${ambient().map((p) => (p.x - 900).toFixed(0)).join(' ').slice(0, 40)}`);
  check('止まっているぶんは排気ではない', exhaust().length === 0, `n=${exhaust().length}`);

  field.clear();
  for (let i = 0; i < 20; i += 1) field.emit(fake(1.5, 0));
  check('歩く速さでは排気が出ない', exhaust().length === 0, `n=${exhaust().length}`);

  field.clear();
  for (let i = 0; i < 20; i += 1) field.emit(fake(9.2, 0));
  check('ブーストすると排気が出る', exhaust().length >= 20, `n=${exhaust().length}`);
  // 進行方向の逆へ流れること（右へ進んでいるなら粒は左へ）
  check('排気は進行方向の逆へ流れる', exhaust().every((p) => p.vx < 0),
    exhaust().map((p) => p.vx.toFixed(1)).join(' ').slice(0, 60));
  check('排気は体の後ろから湧く', exhaust().every((p) => p.x < 900), 'x');

  const before = field.parts.length;
  for (let i = 0; i < 120; i += 1) field.step();
  check('粒は寿命で消える', field.parts.length === 0, `${before} → ${field.parts.length}`);

  // ヒットストップ中は本人が止まっているので、湧かせると 1 か所に溜まる
  field.clear();
  for (let i = 0; i < 20; i += 1) field.emit(fake(9.2, 0, { hitstop: 4 }));
  check('ヒットストップ中は湧かない', field.parts.length === 0, `n=${field.parts.length}`);

  // 他のキャラは thruster を持たないので、まかり間違っても撒かない
  for (let i = 0; i < 20; i += 1) {
    field.emit({
      def: getCharacter('swordsman'), index: 1,
      x: 0, y: 0, facing: 1, vx: 9, vy: 0, hitstop: 0, isKO: false,
    });
  }
  check('スラスターを持たないキャラは撒かない', field.parts.length === 0, `n=${field.parts.length}`);
}

{
  // ダッシュの絵（move シート）は閉じたループではないので、繰り返さず
  // 最後のコマで止める。ここが loop に戻ると、走っている最中に一度巻き戻る。
  const { resolveFrame } = await import('../src/render/spritebank.js');
  const { readFileSync: readSheet } = await import('node:fs');
  const sheet = JSON.parse(
    readSheet(new URL('../assets/characters/cavalier.json', import.meta.url), 'utf8'));

  const sim = newSim(['cavalier', 'swordsman']);
  place(sim, 400, 1500);
  const p1 = sim.fighters[0];
  // 同方向 2 度押しでダッシュに入る
  run(sim, 1, BTN.RIGHT);
  run(sim, 2, 0);
  run(sim, 60, BTN.RIGHT);
  check('ダッシュしている', p1.state === STATE.DASH, `state=${p1.state}`);
  check('ダッシュの絵は繰り返さない', p1.anim.loop === false, `loop=${p1.anim.loop}`);

  const last = sheet.animations[getCharacter('cavalier').anims.dash].frames - 1;
  check('最後のコマで止まっている', resolveFrame(p1.anim, sheet).index === last,
    `frame=${resolveFrame(p1.anim, sheet).index} / last=${last}`);

  // 走りが閉じたループになっている他のキャラは、今までどおり繰り返す
  const sim2 = newSim(['swordsman', 'berserker']);
  place(sim2, 400, 1500);
  const q = sim2.fighters[0];
  run(sim2, 1, BTN.RIGHT);
  run(sim2, 2, 0);
  run(sim2, 60, BTN.RIGHT);
  check('走りが閉じているキャラは繰り返す', q.state === STATE.DASH && q.anim.loop === true,
    `state=${q.state} loop=${q.anim.loop}`);
}

{
  // ビームの発光層。抜き出す条件がこのキャラのビームの色に合っているか。
  // ここが緩むと白い装甲まで光り、きつくすると薄いコマを拾えなくなる。
  const bg = getCharacter('cavalier').beamGlow;
  const beamish = (r, g, b) =>
    g >= bg.minG && b >= bg.minB && Math.min(g - r, b - r) >= bg.lead;
  check('ビームの色は拾う', beamish(120, 240, 255));
  check('白い装甲は拾わない', !beamish(238, 244, 250));
  check('濃紺の翼は拾わない', !beamish(34, 46, 92));
  check('金髪は拾わない', !beamish(240, 214, 150));
  check('芯を持ち上げる倍率がある', bg.boost > 1, `boost=${bg.boost}`);

  // 画素の量が足りないコマを埋めるのがこの 2 つ。
  // 実測の振れ幅は一番濃いコマの 40〜47% なので、2 倍あれば埋まる
  check('薄いコマを正規化する倍率がある', bg.maxGain >= 2, `maxGain=${bg.maxGain}`);
  check('刃のまわりに暈を焼く', bg.halo?.radius > 0 && bg.halo?.gain > 0,
    `halo=${JSON.stringify(bg.halo)}`);
  // 上げすぎると刃を出していないコマの拾いこぼしまで光って装甲の縁がにじむ
  check('正規化の倍率は青にじみが出るほど高くない', bg.maxGain <= 3, `maxGain=${bg.maxGain}`);

  // 刃が半透明なコマ（実測で下位 1/4 が alpha 152）は、量の話とは別の問題。
  // 直しているのは裏当てで、renderer.js が本体より先に source-over で敷く。
  // 加算合成は背景に光を足すだけで背景を隠さないので、ここが 0 だと必ず透ける
  check('刃の裏当てがある', bg.backing > 0, `backing=${bg.backing}`);
  // 裏当てで不透明になっているので、加算は艶を足すだけでいい。
  // ここを上げると刃が白飛びして色が飛ぶ（透けは直らないまま眩しくなる）
  check('加算より裏当てで見せている', bg.backing > bg.alpha,
    `backing=${bg.backing} alpha=${bg.alpha}`);
}

// ── 空中攻撃 ────────────────────────────────────────────────
section('空中攻撃');
for (const [id, attack, skill] of [
  ['swordsman', 'airSlash', 'diveSlash'],
  ['berserker', 'airRampage', 'axeKick'],
  ['mage', 'meteorShot', 'hoverBeamCharge'],
  ['cavalier', 'boostSlash', 'drillDash'],
]) {
  const sim = newSim([id, 'swordsman']);
  const p1 = sim.fighters[0];
  run(sim, 1, BTN.UP);
  run(sim, 6, 0);
  run(sim, 1, BTN.ATTACK);
  run(sim, 2, 0);
  check(`${id}: 空中で攻撃が出る`, p1.moveId === attack, `move=${p1.moveId}`);

  const sim2 = newSim([id, 'swordsman']);
  const q = sim2.fighters[0];
  run(sim2, 1, BTN.UP);
  run(sim2, 6, 0);
  run(sim2, 1, BTN.SKILL);
  run(sim2, 2, 0);
  check(`${id}: 空中でスキルが出る`, q.moveId === skill, `move=${q.moveId}`);
}

{
  // 空中技は着地で打ち切られ、着地硬直に入る
  const sim = newSim();
  const p1 = sim.fighters[0];
  run(sim, 1, BTN.UP);
  run(sim, 6, 0);
  run(sim, 1, BTN.SKILL);
  check('急降下斬りが出る', p1.moveId === 'diveSlash', `move=${p1.moveId}`);
  for (let i = 0; i < 60 && p1.y > 0; i += 1) run(sim, 1, 0);
  check('急降下で素早く着地する', p1.y === 0, `y=${p1.y.toFixed(1)}`);
  check('着地で技が打ち切られる', p1.state === STATE.LAND, `state=${p1.state}`);
  check('外すと着地硬直が長い', p1.landLag === p1.def.moves.diveSlash.landLag,
    `landLag=${p1.landLag}`);
  run(sim, 10, BTN.RIGHT);
  check('着地硬直中は動けない', p1.state === STATE.LAND, `state=${p1.state}`);
}

{
  // 飛び込みの空中攻撃が地上の相手に当たる
  const sim = newSim();
  place(sim, 760, 940);
  const [p1, p2] = sim.fighters;
  run(sim, 1, BTN.UP | BTN.RIGHT);
  run(sim, 16, BTN.RIGHT);
  run(sim, 1, BTN.ATTACK | BTN.RIGHT);
  for (let i = 0; i < 40 && p1.comboDisplay < 1; i += 1) run(sim, 1, BTN.RIGHT);
  check('飛び斬りが地上の相手に当たる', p2.doomed || p2.isKO,
    `hits=${p1.comboDisplay} state=${p2.state}`);
}

{
  // 急降下は判定を真下に絞ってあるので、前に置いておく技としては使えない。
  // 相手の上まで運んでから落とせば当たる。
  const sim = newSim(['succubus', 'swordsman']);
  place(sim, 760, 940);
  const [p1, p2] = sim.fighters;
  run(sim, 1, BTN.UP | BTN.RIGHT);
  run(sim, 16, BTN.RIGHT);
  run(sim, 1, BTN.SKILL | BTN.RIGHT);
  check('急降下が出る', p1.moveId === 'diveKick', `move=${p1.moveId}`);
  for (let i = 0; i < 60 && p1.comboDisplay < 1; i += 1) run(sim, 1, BTN.RIGHT);
  check('急降下が地上の相手に当たる', p2.doomed || p2.isKO,
    `hits=${p1.comboDisplay} state=${p2.state}`);

  // 判定そのものの形。前へ伸ばす技ではなく、足元を踏み抜く技になっていること
  const box = getCharacter('succubus').moves.diveKick.hits[0].box;
  const { HURTBOX, PUSHBOX_W } = await import('../src/game/fighter.js');
  const front = HURTBOX.x + HURTBOX.w;
  check('自分のやられ判定より少しだけ前に出る', box.x + box.w > front && box.x + box.w <= front + 20,
    `前端=${box.x + box.w} やられ判定の前端=${front}`);
  check('後ろは自分の幅から出ない', box.x >= HURTBOX.x, `後端=${box.x}`);
  // 密着時の中心間距離は PUSHBOX_W。そこから相手のやられ判定の手前端までは届くこと
  check('密着でも届く前端はある', box.x + box.w > PUSHBOX_W + HURTBOX.x,
    `前端=${box.x + box.w} 密着時の相手の手前端=${PUSHBOX_W + HURTBOX.x}`);
  check('足元より下から判定が出る', box.y < 0, `下端=${box.y}`);
  check('腰より上には判定が無い', box.y + box.h <= 110, `上端=${box.y + box.h}`);
}

{
  // 魔法使いの空中攻撃は斜め下へ弾を落とす
  const sim = newSim(['mage', 'swordsman']);
  place(sim, 700, 1000);
  const p1 = sim.fighters[0];
  run(sim, 1, BTN.UP);
  run(sim, 8, 0);
  run(sim, 1, BTN.ATTACK);
  run(sim, 14, 0);
  check('降魔弾が出る', sim.projectiles.some((p) => p.type === 'meteor'),
    `n=${sim.projectiles.length}`);
  const m = sim.projectiles.find((p) => p.type === 'meteor');
  check('弾は斜め下へ飛ぶ', m.vy < 0 && m.vx > 0, `v=(${m.vx.toFixed(1)}, ${m.vy.toFixed(1)})`);

  // 地面に届いたら消える（撃ちっぱなしが床下に残らない）
  run(sim, 60, 0);
  check('弾は地面で消える', !sim.projectiles.includes(m), `n=${sim.projectiles.length}`);
}

{
  // 魔法使いの空中スキルは、その場に浮き止まったまま照射する
  const sim = newSim(['mage', 'swordsman']);
  place(sim, 700, 1100);
  const p1 = sim.fighters[0];
  run(sim, 1, BTN.UP);
  run(sim, 8, 0);
  run(sim, 1, BTN.SKILL);
  const yCast = p1.y;
  const xCast = p1.x;
  run(sim, 30, BTN.RIGHT);
  check('浮遊照射の溜めに入る', p1.moveId === 'hoverBeamCharge', `move=${p1.moveId}`);
  check('溜め中も空中で止まっている', p1.y === yCast && p1.x === xCast,
    `(${xCast.toFixed(1)}, ${yCast.toFixed(1)}) -> (${p1.x.toFixed(1)}, ${p1.y.toFixed(1)})`);
  check('空中の魔法陣も術者に追従する',
    sim.effects.some((e) => e.type === 'magicCircle' && e.follow === p1.index));

  // 1秒後に照射へ移る。撃っている間も浮いたまま
  run(sim, 34, BTN.RIGHT);
  check('溜めきると照射に移る', p1.moveId === 'hoverBeam', `move=${p1.moveId}`);
  check('ビームのエフェクトが出る', sim.effects.some((e) => e.type === 'beam'));
  check('照射中もその場に浮き止まる', p1.y === yCast && p1.x === xCast,
    `-> (${p1.x.toFixed(1)}, ${p1.y.toFixed(1)})`);

  // 照射が終われば重力が戻り、落ちて着地する
  for (let i = 0; i < 260 && p1.y > 0; i += 1) run(sim, 1, 0);
  check('撃ち終わると落ちてくる', p1.y === 0, `y=${p1.y.toFixed(1)}`);
}

{
  // 低空で撃てば地上の相手に当たる（＝撃つ高さを選ぶ技になっている）
  const sim = newSim(['mage', 'swordsman']);
  place(sim, 700, 1000);
  const [p1, p2] = sim.fighters;
  run(sim, 1, BTN.UP);
  run(sim, 2, 0); // 跳んだ直後＝まだ低い
  run(sim, 1, BTN.SKILL);
  for (let i = 0; i < 160 && !p2.doomed; i += 1) run(sim, 1, 0, BTN.GUARD);
  check('低空からの照射は地上の相手に届く', p2.doomed || p2.isKO,
    `y=${p1.y.toFixed(1)} state=${p2.state}`);
  check('照射はガードごと崩す', p2.health === 0, `hp=${p2.health}`);
}

// ── 試合進行 ────────────────────────────────────────────────
section('試合進行');
{
  const sim = newSim();
  const [p1, p2] = sim.fighters;
  place(sim, 800, 930);

  run(sim, 1, BTN.ATTACK);
  for (let i = 0; i < 90 && !p2.isKO; i += 1) run(sim, 1, 0);
  check('一撃でKOになる', p2.isKO, `state=${p2.state}`);
  check('ラウンド終了フェーズに移る', sim.phase === 'roundEnd', `phase=${sim.phase}`);
  check('勝者にラウンドが加算される', sim.wins[0] === 1, `wins=${sim.wins}`);

  run(sim, 160, 0);
  check('次のラウンドが始まる', sim.round === 2 && sim.phase === 'intro',
    `round=${sim.round} phase=${sim.phase}`);
  check('次のラウンドでは体力が満タンに戻る',
    sim.fighters[1].health === sim.fighters[1].maxHealth && !sim.fighters[1].doomed,
    `hp=${sim.fighters[1].health}`);
}

{
  // 時間切れは残り体力で判定
  const sim = newSim();
  sim.timeLeft = 2;
  sim.fighters[1].health = 100;
  run(sim, 4, 0, 0);
  check('時間切れは体力の多い方が勝ち', sim.roundWinner === 0, `winner=${sim.roundWinner}`);
}

// ── 決定性（オンライン対戦の前提） ──────────────────────────
section('決定性');
{
  // 同じ入力列を2回流して、状態が1ビットも違わないことを確かめる
  const script = [];
  for (let i = 0; i < 600; i += 1) {
    script.push([
      (i % 17 === 0 ? BTN.ATTACK : 0) | (i % 43 === 0 ? BTN.SKILL : 0) | (i % 7 < 3 ? BTN.RIGHT : 0),
      (i % 23 === 0 ? BTN.ATTACK : 0) | (i % 11 < 4 ? BTN.LEFT : 0) | (i % 31 === 0 ? BTN.UP : 0),
    ]);
  }
  const play = () => {
    const sim = new Simulation({ characters: ['mage', 'berserker'], seed: 99 });
    for (const inputs of script) sim.step(inputs);
    return JSON.stringify(sim.save());
  };
  check('同じ入力からは同じ試合になる', play() === play());
}

{
  // save/load で巻き戻せる（ロールバックの前提）
  const sim = new Simulation({ characters: ['swordsman', 'mage'], seed: 5 });
  for (let i = 0; i < 200; i += 1) sim.step([BTN.RIGHT, BTN.ATTACK]);
  const snapshot = sim.save();
  const expected = JSON.stringify(snapshot);

  for (let i = 0; i < 60; i += 1) sim.step([BTN.SKILL, BTN.LEFT]);
  sim.load(snapshot);
  check('save/load で状態を巻き戻せる', JSON.stringify(sim.save()) === expected);

  // 巻き戻したあと同じ入力を流せば同じ結果になる
  const a = (() => {
    sim.load(snapshot);
    for (let i = 0; i < 60; i += 1) sim.step([BTN.ATTACK, BTN.RIGHT]);
    return JSON.stringify(sim.save());
  })();
  const b = (() => {
    sim.load(snapshot);
    for (let i = 0; i < 60; i += 1) sim.step([BTN.ATTACK, BTN.RIGHT]);
    return JSON.stringify(sim.save());
  })();
  check('巻き戻し後の再実行が一致する', a === b);
}

{
  // 飛行と掴みも巻き戻せる（hoverTicks / grabbedBy が save に乗っているか）。
  // ここが抜けていると、オンライン対戦で滞空中や掴み中に巻き戻したときだけ
  // 状態がずれる、という見つけにくい壊れ方をする。
  const sim = new Simulation({ characters: ['succubus', 'schoolgirl'], seed: 7 });
  const script = [];
  for (let i = 0; i < 500; i += 1) {
    script.push([
      (i % 13 === 0 ? BTN.UP : 0) | (i % 37 === 0 ? BTN.SKILL : 0) | (i % 5 < 2 ? BTN.RIGHT : 0),
      (i % 19 === 0 ? BTN.ATTACK : 0) | (i % 9 < 3 ? BTN.LEFT : 0),
    ]);
  }
  for (const inputs of script.slice(0, 200)) sim.step(inputs);
  const snapshot = sim.save();
  const expected = JSON.stringify(snapshot);
  for (const inputs of script.slice(200, 300)) sim.step(inputs);
  sim.load(snapshot);
  check('淫魔でも save/load で巻き戻せる', JSON.stringify(sim.save()) === expected);

  const replay = () => {
    sim.load(snapshot);
    for (const inputs of script.slice(200)) sim.step(inputs);
    return JSON.stringify(sim.save());
  };
  check('淫魔の巻き戻し後の再実行が一致する', replay() === replay());
}

// ── ダッシュビット ──────────────────────────────────────────
// スワイプ操作は「離して押し直す」が作れないので、2度押しの代わりに
// BTN.DASH で走る意図を直接渡す。
section('ダッシュビット');
{
  const sim = newSim();
  const p1 = sim.fighters[0];
  run(sim, 6, BTN.RIGHT | BTN.DASH);
  check('方向＋DASH で即ダッシュに入る', p1.state === STATE.DASH, `state=${p1.state}`);
  check('ダッシュ速度が出る', Math.abs(p1.vx) === p1.def.dashSpeed,
    `vx=${p1.vx} dashSpeed=${p1.def.dashSpeed}`);

  // 方向を離せば止まる（押しっぱなしでも方向が無ければ走らない）
  run(sim, 2, BTN.DASH);
  check('方向を離すとダッシュが切れる', p1.state !== STATE.DASH, `state=${p1.state}`);
}

{
  const sim = newSim();
  const p1 = sim.fighters[0];
  run(sim, 6, BTN.DASH);
  check('DASH だけでは何も起きない', p1.state === STATE.IDLE && p1.vx === 0, `state=${p1.state}`);
}

{
  // 立ち上がりではなく押されている間ずっと見るので、硬直明けに走りへ戻る
  const sim = newSim();
  const p1 = sim.fighters[0];
  const hold = BTN.RIGHT | BTN.DASH;
  run(sim, 4, hold);
  check('走り出している', p1.state === STATE.DASH);
  run(sim, 1, hold | BTN.ATTACK);
  check('走りから技が出る', p1.state === STATE.MOVE, `state=${p1.state}`);
  run(sim, p1.def.moves[p1.def.attackMove].total + 2, hold);
  check('技が終わると押しっぱなしのまま走りに戻る', p1.state === STATE.DASH, `state=${p1.state}`);
}

{
  // ガードは走りより優先（既存の優先順位を壊していないこと）
  const sim = newSim();
  const p1 = sim.fighters[0];
  run(sim, 6, BTN.RIGHT | BTN.DASH | BTN.GUARD);
  check('ガードはダッシュより優先される', p1.state === STATE.GUARD, `state=${p1.state}`);
}

// ── 斜めジャンプ ────────────────────────────────────────────
// スワイプの向きをそのまま軌道にするため、跳んだフレームに方向が
// 入っていることが要件になる。
section('斜めジャンプ');
{
  const sim = newSim();
  const p1 = sim.fighters[0];
  run(sim, 1, BTN.UP | BTN.RIGHT);
  check('上＋方向を同じフレームで押すと斜めに跳ぶ', p1.y > 0 && p1.vx > 0,
    `y=${p1.y.toFixed(1)} vx=${p1.vx}`);
  check('横速度は jumpVx になる', Math.abs(p1.vx) === p1.def.jumpVx, `vx=${p1.vx}`);

  // 空中でもう一度 上＋方向 → 斜めの2段ジャンプ
  run(sim, 10, 0);
  run(sim, 1, BTN.UP | BTN.LEFT);
  check('2段ジャンプも斜めに跳べる', p1.vx < 0, `vx=${p1.vx}`);
}

{
  const sim = newSim();
  const p1 = sim.fighters[0];
  run(sim, 1, BTN.UP);
  check('上だけなら真上に跳ぶ', p1.y > 0 && p1.vx === 0, `vx=${p1.vx}`);

  // 走っている途中に方向を落として上だけ入れれば、その場で真上へ
  const sim2 = newSim();
  const q = sim2.fighters[0];
  run(sim2, 6, BTN.RIGHT | BTN.DASH);
  run(sim2, 1, BTN.UP);
  check('走りから方向を抜いて跳ぶと真上に上がる', q.y > 0 && q.vx === 0, `vx=${q.vx}`);
}

// ── スワイプの認識 ──────────────────────────────────────────
// gestures.js は DOM もゲームも知らない純粋な計算なので、ここで直接叩ける。
section('スワイプの向きの判定');
{
  // dy は画面座標なので下が正
  check('左へ引いたら左', classifySwipe(-40, 0) === GESTURE.LEFT);
  check('右へ引いたら右', classifySwipe(40, 0) === GESTURE.RIGHT);
  check('上へ引いたら上', classifySwipe(0, -40) === GESTURE.UP);
  check('下へ引いたら下', classifySwipe(0, 40) === GESTURE.DOWN);
  check('右上は斜め右', classifySwipe(30, -30) === GESTURE.UP_RIGHT);
  check('左上は斜め左', classifySwipe(-30, -30) === GESTURE.UP_LEFT);
  // 横に弾くと指は下に流れるので、斜め下は横として扱う
  check('左下は左として扱う', classifySwipe(-40, 22) === GESTURE.LEFT,
    `=${classifySwipe(-40, 22)}`);
  check('右下は右として扱う', classifySwipe(40, 22) === GESTURE.RIGHT,
    `=${classifySwipe(40, 22)}`);
  // 真下は狭い（±30°）
  check('ほぼ真下は下', classifySwipe(12, 40) === GESTURE.DOWN, `=${classifySwipe(12, 40)}`);
}

/** 画面に置いた指1本。drag() で動かすと、認識されたスワイプが返る。 */
function finger(x0 = 200, y0 = 400) {
  const tracker = new SwipeTracker();
  tracker.start(x0, y0);
  let x = x0;
  let y = y0;
  let t = 0;
  return {
    drag(dx, dy, ms = 60, steps = 6) {
      const hits = [];
      for (let i = 1; i <= steps; i += 1) {
        const hit = tracker.move(x + (dx * i) / steps, y + (dy * i) / steps, t + (ms * i) / steps);
        if (hit) hits.push(hit);
      }
      x += dx;
      y += dy;
      t += ms;
      return hits;
    },
    /**
     * 弧を描いて弾く。実際の指はまっすぐ動かず、弾いた向きから流れていく。
     * @param {number} len 弾く長さ
     * @param {number} fromDeg 弾き始めの向き（右が 0、上が +90 の度）
     * @param {number} toDeg 弾き終わりの向き
     */
    arc(len, fromDeg, toDeg, steps = 12) {
      const hits = [];
      for (let i = 1; i <= steps; i += 1) {
        const p = i / steps;
        const deg = ((fromDeg + (toDeg - fromDeg) * p) * Math.PI) / 180;
        const nx = x + Math.cos(deg) * len * p;
        const ny = y - Math.sin(deg) * len * p;
        const hit = tracker.move(nx, ny, t + p * 80);
        if (hit) hits.push(hit);
        if (i === steps) {
          x = nx;
          y = ny;
        }
      }
      t += 80;
      return hits;
    },
    wait(ms) {
      t += ms;
    },
  };
}

/** 一連の drag で認識されたうち、最後の1件（＝いまの状態）。 */
const latest = (hits) => hits[hits.length - 1];

section('弾いた距離で歩きと走りを分ける');
{
  const f = finger();
  check('しきい値未満では何も出ない', f.drag(-14, 0).length === 0);
  const hits = f.drag(-30, 0);
  check('少し引けば左スワイプになる', hits.length >= 1 && hits[0].gesture === GESTURE.LEFT,
    JSON.stringify(hits));
  check('少しの距離は走りに届かない', latest(hits).dist < SWIPE.RUN, `dist=${latest(hits).dist}`);
}

{
  // 一気に大きく弾けば、その一回で走りの距離に届く
  const f = finger();
  const hits = f.drag(-90, 0);
  check('大きく引くと走りの距離に届く', latest(hits).dist >= SWIPE.RUN,
    `dist=${latest(hits).dist.toFixed(1)}`);
  check('向きは左のまま', latest(hits).gesture === GESTURE.LEFT);
}

{
  // 弾いた指をそのまま引き伸ばすと、歩きから走りへ上がる
  const f = finger();
  const walk = f.drag(-34, 0);
  check('まず歩きの距離', latest(walk).dist < SWIPE.RUN, `dist=${latest(walk).dist.toFixed(1)}`);
  const run = f.drag(-45, 0);
  check('引き伸ばすと走りの距離になる', latest(run).dist >= SWIPE.RUN,
    `dist=${latest(run).dist.toFixed(1)}`);
  check('伸ばしている間も向きは変わらない', latest(run).gesture === GESTURE.LEFT);
}

{
  // 戻しを逆向きのスワイプと誤認しないこと
  const f = finger();
  f.drag(-40, 0);
  const back = f.drag(30, 0);
  check('指を戻しただけでは逆向きのスワイプにならない', back.length === 0, JSON.stringify(back));
  const again = f.drag(-30, 0);
  check('戻してもう一度引けば拾い直す', latest(again).gesture === GESTURE.LEFT,
    JSON.stringify(again));
  check('戻した後の小さい弾きは歩き', latest(again).dist < SWIPE.RUN,
    `dist=${latest(again).dist.toFixed(1)}`);
}

{
  // 横に動かしたまま上へ切り返す。
  // 指の動きそのものの向きで判定されること（直前の横移動が混ざらないこと）を見る。
  const f = finger();
  f.drag(40, 0);
  const up = f.drag(6, -34); // ほぼ真上
  check('横から真上へ切り返すと垂直ジャンプ', latest(up).gesture === GESTURE.UP, JSON.stringify(up));

  const g = finger();
  g.drag(40, 0);
  const diag = g.drag(26, -34); // はっきり斜め
  check('横から斜め上へ切り返すと斜めジャンプ', latest(diag).gesture === GESTURE.UP_RIGHT,
    JSON.stringify(diag));
}

{
  // しゃがみから横へ切り返す
  const f = finger();
  const down = f.drag(0, 36);
  check('下へ引くとしゃがみ', down[0].gesture === GESTURE.DOWN);
  const side = f.drag(-32, 4);
  check('しゃがみから横へ切り返せる', latest(side).gesture === GESTURE.LEFT, JSON.stringify(side));
}

section('横に弾いた直後でもジャンプが出る');
{
  // 左へ弾いて歩いた指を離さず、斜め上へ弾く。
  // 戻しの判定に食われてジャンプが消えないこと、
  // 置いていかれた基準点のせいで斜めが真上に化けないこと。
  const cases = [
    ['真上', 0, -40, GESTURE.UP],
    ['やや右上', 10, -40, GESTURE.UP],
    ['斜め右上', 30, -40, GESTURE.UP_RIGHT],
    ['浅い右上', 40, -25, GESTURE.UP_RIGHT],
    ['斜め左上', -30, -40, GESTURE.UP_LEFT],
    ['やや左上', -10, -40, GESTURE.UP],
  ];
  for (const [label, dx, dy, want] of cases) {
    const f = finger();
    f.drag(-45, 0);
    const up = f.drag(dx, dy);
    check(`左へ歩いた直後の${label}スワイプでジャンプ`, up.length > 0 && up[0].gesture === want,
      up.length ? `=${up[0].gesture} 期待=${want}` : '何も出なかった');
  }
}

{
  // 1回の弾きでジャンプが2回入らないこと。
  // 横の「歩き→走り」は伸びを報告し直して上げるが、それをジャンプにも出すと
  // 一度弾いただけで2段ジャンプまで消費してしまう。
  const f = finger();
  const up = f.drag(20, -60, 60, 8); // 長めに、細かく刻んで弾く
  check('長く弾いてもジャンプの報告は1回だけ', up.length === 1, JSON.stringify(up));

  const g = finger();
  const side = g.drag(-90, 0, 60, 8);
  check('横は伸ばすぶんだけ報告し直す（歩き→走り）', side.length > 1, JSON.stringify(side));
}

{
  // 跳んだあと指を下ろすのを、しゃがみと取り違えないこと
  const f = finger();
  const up = f.drag(0, -40);
  check('上へ引くとジャンプ', up[0].gesture === GESTURE.UP);
  const back = f.drag(0, 30);
  check('跳んだ後に指を下ろしてもしゃがまない', back.length === 0, JSON.stringify(back));
}

{
  const t = new SwipeTracker();
  check('触っていなければ動かしても無反応', t.move(0, 0, 0) === null);
}

section('1回の弾きで跳ぶのは1回だけ');
{
  // 指はまっすぐ動かない。斜めに弾くと弧を描いて後半が別の向きへ流れ、
  // そこが新しいスワイプとして拾われる。空中では横スワイプもジャンプなので、
  // 拾ったぶんまで跳んでいると、斜めジャンプのつもりで2段ジャンプまで消える。
  const cases = [
    ['右上に弾いて右へ流れる', 60, 20],
    ['右上に弾いて上へ流れる', 45, 85],
    ['左上に弾いて左へ流れる', 120, 160],
    ['左上に弾いて上へ流れる', 135, 95],
  ];
  for (const [label, from, to] of cases) {
    const im = new InputManager();
    const flick = { jumped: false };
    const f = finger();
    const hits = f.arc(90, from, to);
    let jumps = 0;
    for (const hit of hits) {
      im.latch[0] = 0;
      im._applySwipe(flick, 0, 'move', hit);
      // 跳んだら以降は空中。空中では横スワイプもジャンプになる
      if (im.latch[0] & BTN.UP) {
        jumps += 1;
        im.airborne[0] = true;
      }
    }
    check(`${label}: 途中で別の向きとして拾われる`, hits.length > 1,
      hits.map((h) => h.gesture).join(','));
    check(`${label}: それでもジャンプは1回だけ`, jumps === 1, `${jumps}回`);
  }
}

{
  // 塞ぐのは同じ弾きの続きだけ。指を戻して弾き直せば2段ジャンプは出る。
  const im = new InputManager();
  const flick = { jumped: false };
  const f = finger();
  const jumped = () => {
    const v = (im.latch[0] & BTN.UP) !== 0;
    im.latch[0] = 0;
    return v;
  };
  const feed = (hits) => hits.forEach((h) => im._applySwipe(flick, 0, 'move', h));

  feed(f.drag(20, -50));
  check('1回目の弾きで跳ぶ', jumped());
  im.airborne[0] = true;
  feed(f.drag(-14, 34)); // 指を戻して構え直す
  check('戻している間は跳ばない', !jumped());
  feed(f.drag(20, -50)); // 弾き直す
  check('弾き直せば空中でもう一度跳べる', jumped());
}

{
  // 走り出した指をそのまま斜め上へ弾くのは「1発目のジャンプ」なので塞がない
  const im = new InputManager();
  const flick = { jumped: false };
  const f = finger();
  const feed = (hits) => hits.forEach((h) => im._applySwipe(flick, 0, 'move', h));

  feed(f.drag(-45, 0));
  check('左へ弾くと歩き出す', (im.touchBits[0] & BTN.LEFT) !== 0, `bits=${im.touchBits[0]}`);
  im.latch[0] = 0;
  feed(f.drag(-30, -40));
  check('指を離さず斜め上へ弾けば跳べる', (im.latch[0] & BTN.UP) !== 0, `latch=${im.latch[0]}`);
}

// ── スワイプ → 入力ビット ───────────────────────────────────
// InputManager の振り分けは DOM を触らないので、そのまま呼べる。
section('スワイプから入力ビットへの振り分け');
{
  const im = new InputManager();
  const bits = () => im.touchBits[0];
  const latched = () => {
    const v = im.latch[0];
    im.latch[0] = 0;
    return v;
  };

  const small = SWIPE.THRESHOLD + 2;
  const big = SWIPE.RUN + 2;

  im._applyMoveSwipe(0, { gesture: GESTURE.LEFT, dist: small });
  check('小さく左へ弾くと歩き', bits() === BTN.LEFT, `bits=${bits()}`);

  im._applyMoveSwipe(0, { gesture: GESTURE.LEFT, dist: big });
  check('大きく左へ弾くと走り', bits() === (BTN.LEFT | BTN.DASH), `bits=${bits()}`);

  im._applyMoveSwipe(0, { gesture: GESTURE.LEFT, dist: small });
  check('また小さく弾けば歩きに戻る', bits() === BTN.LEFT, `bits=${bits()}`);

  im._applyMoveSwipe(0, { gesture: GESTURE.RIGHT, dist: big });
  check('逆へ大きく弾けば逆へ走る', bits() === (BTN.RIGHT | BTN.DASH), `bits=${bits()}`);

  // 跳ぶための弾きの長さで地上の速さが変わらないこと
  im._applyMoveSwipe(0, { gesture: GESTURE.UP_RIGHT, dist: small });
  check('走ったまま斜めジャンプしても走りは保つ', bits() === (BTN.RIGHT | BTN.DASH),
    `bits=${bits()}`);
  check('斜め上でジャンプが1フレーム入る', latched() === BTN.UP);

  im._applyMoveSwipe(0, { gesture: GESTURE.LEFT, dist: small });
  im._applyMoveSwipe(0, { gesture: GESTURE.UP_LEFT, dist: big });
  check('歩きから斜めジャンプしても走りにはならない', bits() === BTN.LEFT, `bits=${bits()}`);
  check('斜め上でジャンプが1フレーム入る（歩きから）', latched() === BTN.UP);

  im._applyMoveSwipe(0, { gesture: GESTURE.UP, dist: small });
  check('真上スワイプは方向を落とす', bits() === 0, `bits=${bits()}`);
  check('真上スワイプでもジャンプは入る', latched() === BTN.UP);

  im._applyMoveSwipe(0, { gesture: GESTURE.DOWN, dist: small });
  check('下スワイプでしゃがみが押しっぱなしになる', bits() === BTN.DOWN, `bits=${bits()}`);

  im._applyMoveSwipe(0, { gesture: GESTURE.RIGHT, dist: small });
  check('しゃがみから横へ弾くとしゃがみが解ける', bits() === BTN.RIGHT, `bits=${bits()}`);
}

{
  // 空中では横スワイプもその向きへのジャンプになる（空中の移動手段はジャンプだけ）
  const im = new InputManager();
  const latched = () => {
    const v = im.latch[0];
    im.latch[0] = 0;
    return v;
  };
  const small = SWIPE.THRESHOLD + 2;
  const big = SWIPE.RUN + 2;

  im.airborne[0] = true;
  im._applyMoveSwipe(0, { gesture: GESTURE.RIGHT, dist: small });
  check('空中の右スワイプでジャンプが入る', latched() === BTN.UP);
  check('空中の右スワイプは右を押しっぱなしにする', im.touchBits[0] === BTN.RIGHT,
    `bits=${im.touchBits[0]}`);

  im._applyMoveSwipe(0, { gesture: GESTURE.LEFT, dist: big });
  check('空中の左スワイプでもジャンプが入る', latched() === BTN.UP);
  check('空中では大きく弾いても走りにはならない', im.touchBits[0] === BTN.LEFT,
    `bits=${im.touchBits[0]}`);

  // 地上に戻れば同じ操作が歩き・走りに戻る
  im.airborne[0] = false;
  im._applyMoveSwipe(0, { gesture: GESTURE.LEFT, dist: big });
  check('着地すれば横スワイプは走りに戻る', im.touchBits[0] === (BTN.LEFT | BTN.DASH),
    `bits=${im.touchBits[0]}`);
  check('着地後の横スワイプではジャンプは入らない', latched() === 0);

  // 走ったまま跳んで、空中で横に弾いても走りは保つ（着地してまた走れる）
  im.airborne[0] = true;
  im._applyMoveSwipe(0, { gesture: GESTURE.LEFT, dist: small });
  check('空中で同じ向きへ弾いても走りは保つ', im.touchBits[0] === (BTN.LEFT | BTN.DASH),
    `bits=${im.touchBits[0]}`);
  check('そのときもジャンプは入る', latched() === BTN.UP);

  // 空中の下スワイプは今までどおりしゃがみ入力（着地後に効く）
  im._applyMoveSwipe(0, { gesture: GESTURE.DOWN, dist: small });
  check('空中の下スワイプではジャンプしない', latched() === 0);
  check('空中の下スワイプはしゃがみのまま', im.touchBits[0] === BTN.DOWN,
    `bits=${im.touchBits[0]}`);
}

{
  // 飛行（淫魔の滞空）中だけは、空中でも横スワイプがジャンプにならない。
  // 滞空は横入力がそのまま速度になるので、ジャンプに変えると
  // 横へ動くたびに飛行の残り回数を食い潰して、動かせなくなってしまう。
  const im = new InputManager();
  const latched = () => {
    const v = im.latch[0];
    im.latch[0] = 0;
    return v;
  };
  const small = SWIPE.THRESHOLD + 2;

  im.airborne[0] = true;
  im.hovering[0] = true;

  im._applyMoveSwipe(0, { gesture: GESTURE.RIGHT, dist: small });
  check('滞空中の横スワイプはジャンプにならない', latched() === 0);
  check('滞空中の横スワイプは向きを押しっぱなしにする', im.touchBits[0] === BTN.RIGHT,
    `bits=${im.touchBits[0]}`);

  im._applyMoveSwipe(0, { gesture: GESTURE.LEFT, dist: SWIPE.RUN + 2 });
  check('滞空中は大きく弾いても走りにならない', im.touchBits[0] === BTN.LEFT,
    `bits=${im.touchBits[0]}`);

  // 高さを取り直す操作は残す
  im._applyMoveSwipe(0, { gesture: GESTURE.UP_RIGHT, dist: small });
  check('滞空中でも斜め上スワイプは跳ぶ', latched() === BTN.UP);
  im._applyMoveSwipe(0, { gesture: GESTURE.UP, dist: small });
  check('滞空中でも真上スワイプは跳ぶ', latched() === BTN.UP);

  // 滞空が切れれば今までどおり
  im.hovering[0] = false;
  im._applyMoveSwipe(0, { gesture: GESTURE.RIGHT, dist: small });
  check('滞空が切れれば横スワイプはジャンプに戻る', latched() === BTN.UP);
}

{
  // 実際の試合で確かめる。上スワイプ3回で滞空に入り、そのまま横へ弾く。
  const sim = newSim(['succubus', 'swordsman']);
  const p1 = sim.fighters[0];
  const im = new InputManager();
  const sync = () => {
    im.airborne[0] = p1.airborne;
    im.hovering[0] = p1.hoverTicks > 0;
  };
  const tick = (n = 1) => {
    for (let i = 0; i < n; i += 1) {
      sync();
      sim.step(im.poll());
    }
  };
  const swipe = (gesture) => {
    sync();
    im._applyMoveSwipe(0, { gesture, dist: SWIPE.THRESHOLD + 2 });
  };
  const lift = () => {
    im.touchBits[0] = 0;
  };

  // 1・2段目は跳び上がり。3段目から滞空に変わる
  swipe(GESTURE.UP); tick(1); lift(); tick(14);
  swipe(GESTURE.UP); tick(1); lift(); tick(14);
  swipe(GESTURE.UP); tick(1); lift(); tick(1);
  check('上スワイプ3回で滞空に入る', p1.hoverTicks > 0, `hover=${p1.hoverTicks}`);

  const left = p1.airJumps;
  const x0 = p1.x;
  const y0 = p1.y;
  swipe(GESTURE.RIGHT); // 弾いたまま指を置いておく
  tick(20);
  check('滞空中に横へ弾けば横に動く', p1.x > x0 + 50,
    `x ${x0.toFixed(0)} -> ${p1.x.toFixed(0)}`);
  check('横へ動いても飛行の残り回数は減らない', p1.airJumps === left,
    `${left} -> ${p1.airJumps}`);
  check('横へ動いても高度は変わらない', Math.abs(p1.y - y0) < 0.001,
    `y ${y0.toFixed(2)} -> ${p1.y.toFixed(2)}`);
  check('横へ動いている間も滞空したまま', p1.hoverTicks > 0, `hover=${p1.hoverTicks}`);
}

{
  const im = new InputManager();
  const latched = () => {
    const v = im.latch[0];
    im.latch[0] = 0;
    return v;
  };

  // 攻撃は向きの要らないタップ
  im.aimDir[0] = 1;
  check('タップで攻撃', im._applyActionTap(0) && latched() === BTN.ATTACK);
  check('タップは押しっぱなしのビットを作らない', im.touchBits[0] === 0, `bits=${im.touchBits[0]}`);

  // スキルは相手の方へフリック
  im._applyActionSwipe(0, { gesture: GESTURE.RIGHT });
  check('相手の方へフリックでスキル', latched() === BTN.SKILL);
  im._applyActionSwipe(0, { gesture: GESTURE.LEFT });
  check('背を向ける方向は割り当てなし', latched() === 0);

  // 相手が左に回り込んだら、フリックの向きも入れ替わる
  im.aimDir[0] = -1;
  im._applyActionSwipe(0, { gesture: GESTURE.LEFT });
  check('相手が左なら左フリックがスキル', latched() === BTN.SKILL);
  im._applyActionSwipe(0, { gesture: GESTURE.RIGHT });
  check('相手が左なら右フリックは割り当てなし', latched() === 0);

  // 斜め上は横に丸める（上に流れても技は出る）
  im.aimDir[0] = 1;
  im._applyActionSwipe(0, { gesture: GESTURE.UP_RIGHT });
  check('斜め上へのフリックもスキルになる', latched() === BTN.SKILL);

  im._applyActionSwipe(0, { gesture: GESTURE.DOWN });
  check('下フリックでガードが押しっぱなしになる', im.touchBits[0] === BTN.GUARD,
    `bits=${im.touchBits[0]}`);
  im._applyActionSwipe(0, { gesture: GESTURE.RIGHT });
  check('スキルを出すとガードは解ける', im.touchBits[0] === 0, `bits=${im.touchBits[0]}`);
  check('ガードを解いて出したのはスキル', latched() === BTN.SKILL);

  im._applyActionSwipe(0, { gesture: GESTURE.UP });
  check('攻撃エリアの真上は割り当てなし', im.touchBits[0] === 0 && latched() === 0);
}

// ── CPU の判断材料 ──────────────────────────────────────────
// CPU は技の間合いと発生を技データから割り出して使う。数値を手で持たない
// 代わりに、ここが狂うと「届かない間合いで振る」「密着で溜め技を出す」に直結する。
section('CPU が技データから読む性能');
{
  const { profileOf, CpuController, DIFFICULTY } = await import('../src/game/ai.js');

  const sword = profileOf(getCharacter('swordsman'));
  const berserk = profileOf(getCharacter('berserker'));
  const mage = profileOf(getCharacter('mage'));

  // 踏み込む技は移動ぶんだけ遠くまで届く。判定リーチだけ見ると使えなくなる
  check('剣士のタックルは前進ぶんを含めた射程になる', sword.skill.range > 300,
    `range=${sword.skill.range}`);
  // 横切りも少し踏み込む（30）が、タックルの 182 とは桁が違う。
  // 射程が判定リーチ（205）＋やられ判定（38）＋わずかな踏み込みに収まっていること
  check('踏み込みの小さい技は射程が伸びない', sword.attack.range < 290,
    `range=${sword.attack.range}`);
  check('タックルの射程は横切りよりはっきり長い', sword.skill.range > sword.attack.range + 60,
    `${sword.skill.range} vs ${sword.attack.range}`);
  check('剣士のタックルの発生は溜めを含む', sword.skill.startup === 33,
    `startup=${sword.skill.startup}`);

  // 魔法使いの照射は「溜め 1 秒 → 本体」。溜めが出す魔法陣は演出でしかないので、
  // これを発生と取り違えると密着で溜め始めて的になる（実際にそうなっていた）
  check('照射の発生は溜めぶん遅い（魔法陣を発生と誤読しない）', mage.skill.startup >= 60,
    `startup=${mage.skill.startup}`);
  check('ホーミング弾の発生は弾を撃つフレーム', mage.attack.startup === 11,
    `startup=${mage.attack.startup}`);
  check('飛び道具は遠くまで届く扱いになる', mage.attack.range > 900, `range=${mage.attack.range}`);
  check('狂戦士の突きは前進しないので射程が短い', berserk.skill.range < sword.skill.range,
    `${berserk.skill.range} < ${sword.skill.range}`);

  check('難易度は easy / normal / hard の3段', Object.keys(DIFFICULTY).join(',') === 'easy,normal,hard');
  check('難易度が上がるほど反応が速い',
    DIFFICULTY.easy.react > DIFFICULTY.normal.react &&
      DIFFICULTY.normal.react > DIFFICULTY.hard.react);
  check('CpuController は既定で normal', new CpuController(1).cfg === DIFFICULTY.normal);
}

section('CPU の立ち回り');
{
  /** CPU を 1 体だけ動かして、n ティックの間に出た入力を集める。 */
  const observe = async (sim, ticks, { level = 'hard', foeBits = 0 } = {}) => {
    const { CpuController } = await import('../src/game/ai.js');
    const cpu = new CpuController(1, level);
    let seen = 0;
    for (let i = 0; i < ticks; i += 1) {
      const bits = cpu.think(sim);
      seen |= bits;
      sim.step([typeof foeBits === 'function' ? foeBits(i) : foeBits, bits]);
    }
    return seen;
  };

  {
    // 届かない間合いでは振らない
    const sim = newSim(['swordsman', 'swordsman']);
    place(sim, 200, 1000);
    const seen = await observe(sim, 120);
    check('届かない間合いでは技を振らない', (seen & (BTN.ATTACK | BTN.SKILL)) === 0,
      `bits=${seen}`);
    check('遠いときは間合いを詰めに行く', (seen & (BTN.LEFT | BTN.RIGHT)) !== 0);
  }

  {
    // 走って詰める（2度押しの再現ではなく DASH ビットを使う）。
    // 詰め方は歩き・走り・飛び込みを混ぜるので、何度か決め直す長さで見る。
    const sim = newSim(['swordsman', 'swordsman']);
    place(sim, 200, 1200);
    const seen = await observe(sim, 400);
    check('間合いを詰めるときは走る', (seen & BTN.DASH) !== 0, `bits=${seen}`);
    check('詰め方は走りだけではない', (seen & (BTN.LEFT | BTN.RIGHT)) !== 0, `bits=${seen}`);
  }

  {
    // ガードを固める相手はスキルで崩しに来る（打撃は通らないため）
    const sim = newSim(['swordsman', 'berserker']);
    place(sim, 800, 950);
    // 気分が数秒ごとに切り替わるので、複数の気分をまたぐ長さで見る
    const seen = await observe(sim, 400, { foeBits: BTN.GUARD });
    check('固める相手にはスキルで崩しに来る', (seen & BTN.SKILL) !== 0, `bits=${seen}`);
  }

  {
    // 空振りの戻りには差し込む。相手に長い技を繰り返し振らせる
    const sim = newSim(['berserker', 'berserker']);
    place(sim, 800, 990);
    const total = sim.fighters[0].def.moves[sim.fighters[0].def.attackMove].total;
    const seen = await observe(sim, 400, { foeBits: (i) => (i % (total + 4) === 0 ? BTN.ATTACK : 0) });
    check('相手の空振りの戻りに技を差し込む', (seen & BTN.ATTACK) !== 0, `bits=${seen}`);
  }

  {
    // 密着では照射の溜めを始めない（溜め 1 秒がそのまま的になる）
    const sim = newSim(['swordsman', 'mage']);
    place(sim, 800, 880);
    const seen = await observe(sim, 400);
    check('密着では溜めの長いスキルを出さない', (seen & BTN.SKILL) === 0, `bits=${seen}`);
  }
}

// 飛び道具は撃った本人と切り離して飛ぶので、技のモーションを見ているだけでは
// 気づけない。ここを見落とすと、CPU は弾に向かって歩いて当たりに行く。
section('CPU の掴みへの対応');
{
  const { profileOf, CpuController } = await import('../src/game/ai.js');

  const succ = profileOf(getCharacter('succubus'));
  const sword = profileOf(getCharacter('swordsman'));
  check('淫魔のスキルは掴みだと読める', succ.skill.grab === true);
  check('打撃系のスキルは掴み扱いにならない', sword.skill.grab === false);
  check('引っ掻きは掴みではない', succ.attack.grab === false);

  // 掴みは「跳べば避けられる技」として読めていること。
  // 判定の高さで測ると吸血の箱は高いので、ここを分けていないと false になる。
  {
    const sim = newSim(['succubus', 'swordsman']);
    place(sim, 800, 890);
    const cpu = new CpuController(1, 'hard');
    run(sim, 1, BTN.SKILL);
    run(sim, 4, 0);
    check('掴みは跳んで避けられる技だと分かる', cpu._isJumpable(sim.fighters[0]),
      `move=${sim.fighters[0].moveId}`);
    check('掴みが来ていると分かる', cpu._incomingGrab(sim.fighters[0]));
  }

  // ガードで固めている最中に掴みが来たら、固めたままにせず考え直すこと。
  // ここが無いと「守っているから大丈夫」で流して毎回捕まる。
  {
    const sim = newSim(['succubus', 'swordsman']);
    place(sim, 800, 890);
    const cpu = new CpuController(1, 'hard');
    cpu.plan = { bits: BTN.GUARD, ticks: 30 };
    run(sim, 1, BTN.SKILL);
    run(sim, 3, 0);
    check('ガード中でも掴みが来たら考え直す',
      cpu._mustRethink(sim, sim.fighters[1], sim.fighters[0]));
  }

  // 逆側。跳んでいる相手に掴みを振らない（外すと長い硬直だけが残る）
  {
    const sim = newSim(['succubus', 'swordsman']);
    place(sim, 800, 880);
    const cpu = new CpuController(0, 'hard');
    // 相手を跳ばせた状態で 200 ティック思考させ、掴みを振るか見る
    let grabbed = 0;
    for (let i = 0; i < 200; i += 1) {
      const foe = sim.fighters[1];
      if (!foe.airborne) sim.step([0, BTN.UP]);
      else sim.step([cpu.think(sim), 0]);
      if (sim.fighters[0].moveId === 'drainCatch' && foe.airborne) grabbed += 1;
    }
    check('跳んでいる相手には掴みを振らない', grabbed === 0, `振った回数=${grabbed}`);
  }

  // ガードで固める相手には掴みに行く
  {
    let used = 0;
    for (let seed = 1; seed <= 12; seed += 1) {
      const sim = newSim(['succubus', 'swordsman'], seed);
      place(sim, 820, 900);
      const cpu = new CpuController(0, 'hard');
      for (let i = 0; i < 200; i += 1) {
        sim.step([cpu.think(sim), BTN.GUARD]);
        if (sim.fighters[0].moveId === 'drainCatch') { used += 1; break; }
      }
    }
    check('固める相手には掴みに行く', used >= 9, `${used}/12 試行で掴みを選んだ`);
  }
}

section('CPU の飛び道具への対応');
{
  const { CpuController } = await import('../src/game/ai.js');

  /** 魔法使いに弾を撃たせて、CPU（剣士）がどう捌くかを見る。 */
  const zone = async (ticks) => {
    const sim = newSim(['mage', 'swordsman']);
    place(sim, 1300, 700);
    const cpu = new CpuController(1, 'hard');
    const me = sim.fighters[1];
    let guardedShot = 0;
    let hitByShot = 0;
    let airborneWithShot = 0;
    for (let i = 0; i < ticks; i += 1) {
      const before = sim.projectiles.length;
      const hp = me.health;
      const boltAlive = sim.projectiles.some((p) => p.owner === 0);
      // 魔法使いは間合いを保ちつつ撃ち続ける
      const foeBits = i % 34 === 0 ? BTN.ATTACK : BTN.LEFT;
      sim.step([foeBits, cpu.think(sim)]);
      if (boltAlive && me.airborne) airborneWithShot += 1;
      if (sim.projectiles.length < before) {
        if (me.state === STATE.BLOCK) guardedShot += 1;
        else if (me.health < hp) hitByShot += 1;
      }
      if (me.health === 0) {
        me.health = 1000; // 続けて観測したいので生かす
        me.doomed = false;
      }
    }
    return { guardedShot, hitByShot, airborneWithShot };
  };

  const r = await zone(900);
  check('飛んできた弾をガードする', r.guardedShot > 0,
    `ガード=${r.guardedShot} 被弾=${r.hitByShot}`);
  check('弾に当たるより受ける方が多い', r.guardedShot > r.hitByShot,
    `ガード=${r.guardedShot} 被弾=${r.hitByShot}`);
  // 空中はガードできないので、弾が出ている間に跳んでいると受ける手が無くなる
  check('相手の弾が出ている間はほとんど空中に居ない', r.airborneWithShot < 40,
    `空中フレーム=${r.airborneWithShot}`);
}

{
  // 到達時間は相対速度で見る。弾に向かって走っているぶんを勘定しないと、
  // 「気づいたつもりで間に合わない」が起きる（実測で被弾の主因だった）
  const { CpuController } = await import('../src/game/ai.js');
  const sim = newSim(['mage', 'swordsman']);
  place(sim, 1300, 700);
  const cpu = new CpuController(1, 'hard');
  run(sim, 1, BTN.ATTACK); // 弾を撃たせる
  for (let i = 0; i < 20 && sim.projectiles.length === 0; i += 1) run(sim, 1, 0);
  check('弾が出ている', sim.projectiles.length > 0);

  const me = sim.fighters[1];
  me.vx = 0;
  const still = cpu._incomingProjectile(sim, me);
  me.vx = 6.9; // 弾へ向かって走っている状態
  const running = cpu._incomingProjectile(sim, me);
  check('弾へ向かって走っていると到達が早いと見積もる',
    running && still && running.frames < still.frames,
    `止=${still?.frames.toFixed(1)} 走=${running?.frames.toFixed(1)}`);

  me.vx = 0;
  me.x = sim.projectiles[0].x - 300; // 弾の手前（弾は右へ飛んでいる想定）
  const away = cpu._incomingProjectile(sim, me);
  check('通り過ぎた弾には反応しない', away === null || away.frames > 0);
}

{
  // ホーミング弾は 2段ジャンプで避けられる。
  // 要点は 2段目で、弾が間近まで来たところで前へ跳び直すと
  // 曲がりきれない弾を置いていける（探索では 7 割成功）。
  // 1段目だけでは避けられないので、2段目が出ることを確かめる。
  const { CpuController } = await import('../src/game/ai.js');
  const sim = newSim(['mage', 'swordsman']);
  place(sim, 700, 1150);
  const cpu = new CpuController(1, 'hard');
  const me = sim.fighters[1];

  run(sim, 1, BTN.ATTACK);
  for (let i = 0; i < 20 && sim.projectiles.length === 0; i += 1) run(sim, 1, 0);
  check('弾が出ている（2段ジャンプ回避の前提）', sim.projectiles.length > 0);

  // 跳ばせてから、弾を間近まで寄せた状態で何を選ぶか見る
  run(sim, 1, 0, BTN.UP);
  for (let i = 0; i < 6; i += 1) run(sim, 1, 0);
  check('1段目で浮いている', me.airborne && me.airJumps > 0,
    `y=${me.y.toFixed(0)} airJumps=${me.airJumps}`);

  const bolt = sim.projectiles[0];
  bolt.x = me.x + 100; // 弾を間近（DODGE_AIR_DIST の内側）へ置く
  bolt.y = me.y + 90;
  const dist = cpu._nearestShotDist(sim, me);
  check('弾との距離を測れる', dist < 150, `dist=${dist.toFixed(0)}`);

  // 何度か決め直させて、2段目が出るかを見る（手は混ぜているので一発では出ない）
  let airJumped = false;
  for (let i = 0; i < 40 && !airJumped; i += 1) {
    const bits = cpu.think(sim);
    if (cpu.lastAct === 'dodge' && bits & BTN.UP) airJumped = true;
    // 弾を間近に保ったまま観測する
    sim.projectiles[0] && Object.assign(sim.projectiles[0], { x: me.x + 100, y: me.y + 90 });
    sim.step([0, bits]);
  }
  check('弾が間近なら2段目を出して避けようとする', airJumped, `lastAct=${cpu.lastAct}`);
}

// ── 技データとアトラスの噛み合わせ ──────────────────────────
// キャラ定義が指しているアニメ名が、実際に配られているアトラスに載っているか。
// シートを差し替えたときにここがずれると、絵が出ないか一枚も描かれないまま
// 試合が進む（sim は絵を見ないので、他のテストでは気づけない）。
section('絵の対応');
{
  const { readFileSync } = await import('node:fs');
  const { CHARACTER_IDS, EXTRA_SPRITE_IDS } = await import('../src/game/characters/index.js');
  const { PROJECTILES } = await import('../src/game/projectiles.js');

  const atlas = (id) =>
    JSON.parse(readFileSync(new URL(`../assets/characters/${id}.json`, import.meta.url), 'utf8'));

  for (const id of CHARACTER_IDS) {
    const def = getCharacter(id);
    const anims = atlas(id).animations;
    const missing = Object.entries(def.anims)
      .filter(([, name]) => !anims[name])
      .map(([key, name]) => `${key}:${name}`);
    check(`${def.name}の立ち回りの絵が揃っている`, missing.length === 0, missing.join(' '));

    const moveAnims = Object.values(def.moves)
      .map((m) => m.anim)
      .filter((name) => name && !anims[name]);
    check(`${def.name}の技の絵が揃っている`, moveAnims.length === 0, moveAnims.join(' '));
  }

  for (const id of EXTRA_SPRITE_IDS) {
    const anims = atlas(id).animations;
    const used = Object.values(PROJECTILES)
      .filter((p) => p.sheet === id)
      .flatMap((p) => Object.values(p.anims ?? {}));
    const missing = used.filter((name) => !anims[name]);
    check(`${id} の絵が揃っている`, used.length > 0 && missing.length === 0, missing.join(' '));
  }
}

console.log(`\n合計 ${passed + failed} 件: 成功 ${passed} / 失敗 ${failed}`);
process.exit(failed === 0 ? 0 : 1);
