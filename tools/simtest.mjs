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
import { BTN, STATE, ROUND_INTRO_TICKS, CROUCH_TICKS } from '../src/game/constants.js';
import { getProjectileDef } from '../src/game/projectiles.js';
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

// ── 空中攻撃 ────────────────────────────────────────────────
section('空中攻撃');
for (const [id, attack, skill] of [
  ['swordsman', 'airSlash', 'diveSlash'],
  ['berserker', 'airRampage', 'axeKick'],
  ['mage', 'meteorShot', 'hoverBeamCharge'],
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

console.log(`\n合計 ${passed + failed} 件: 成功 ${passed} / 失敗 ${failed}`);
process.exit(failed === 0 ? 0 : 1);
