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
import { BTN, STATE, ROUND_INTRO_TICKS } from '../src/game/constants.js';
import { getProjectileDef } from '../src/game/projectiles.js';

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
  run(sim, 60, 0);
  check('着地して地面に戻る', p1.y === 0);
}

// ── 攻撃と連携 ──────────────────────────────────────────────
section('剣士の攻撃と連携');
{
  const sim = newSim();
  place(sim, 800, 940);
  const [p1, p2] = sim.fighters;
  const hp0 = p2.health;

  run(sim, 1, BTN.ATTACK);
  check('攻撃で1段目「横切り」が出る', p1.moveId === 'slash1', `move=${p1.moveId}`);

  // 判定が出るのは剣を伸ばしきったあたり。当たるまで進める
  for (let i = 0; i < 40 && p2.health === hp0; i += 1) run(sim, 1, 0);
  check('1段目が当たる', p2.health < hp0, `hp ${hp0} -> ${p2.health}`);

  const hp1 = p2.health;
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
  for (let i = 0; i < 30 && p2.health === hp1; i += 1) {
    run(sim, 1, 0);
    if (p2.isFree) recovered = true;
  }
  check('2段目も当たる', p2.health < hp1, `hp ${hp1} -> ${p2.health}`);
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
  // 魔法使いのビームは最終打だけダウン
  const sim = newSim(['mage', 'swordsman']);
  place(sim, 700, 1000);
  const p2 = sim.fighters[1];

  run(sim, 1, BTN.SKILL);
  run(sim, 50, 0); // 途中の打が当たっているころ
  check('ビーム途中の打ではダウンしない', p2.state !== STATE.DOWN, `state=${p2.state}`);
  const mid = p2.health;
  check('途中の打はダメージが入っている', mid < p2.maxHealth, `hp=${mid}`);

  run(sim, 20, 0); // 最終打まで
  check('ビーム最終打でダウンする', p2.state === STATE.DOWN, `state=${p2.state}`);
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
}

{
  // 極太ビームはガードを貫く
  const sim = newSim(['mage', 'swordsman']);
  place(sim, 600, 900);
  const [p1, p2] = sim.fighters;
  const hp0 = p2.health;

  run(sim, 1, BTN.SKILL);
  check('スキルでビームが出る', p1.moveId === 'beam');
  run(sim, 60, 0, BTN.GUARD);
  check('ビームはガードごと削る', hp0 - p2.health > 80, `hp ${hp0} -> ${p2.health}`);
  check('ビームのエフェクトが出る', sim.effects.some((e) => e.type === 'beam') || sim.tick > 0);
}

// ── 試合進行 ────────────────────────────────────────────────
section('試合進行');
{
  const sim = newSim();
  const [p1, p2] = sim.fighters;
  p2.health = 1; // 次の一撃で決着
  place(sim, 800, 930);

  run(sim, 1, BTN.ATTACK);
  for (let i = 0; i < 40 && !p2.isKO; i += 1) run(sim, 1, 0);
  check('体力0でKOになる', p2.isKO, `state=${p2.state}`);
  check('ラウンド終了フェーズに移る', sim.phase === 'roundEnd', `phase=${sim.phase}`);
  check('勝者にラウンドが加算される', sim.wins[0] === 1, `wins=${sim.wins}`);

  run(sim, 160, 0);
  check('次のラウンドが始まる', sim.round === 2 && sim.phase === 'intro',
    `round=${sim.round} phase=${sim.phase}`);
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

console.log(`\n合計 ${passed + failed} 件: 成功 ${passed} / 失敗 ${failed}`);
process.exit(failed === 0 ? 0 : 1);
