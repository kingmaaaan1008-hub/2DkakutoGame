/**
 * 起動と画面遷移の取りまとめ。
 *
 * ここが唯一「ブラウザの都合」（DOM・リサイズ・向き・タッチ）を知っている場所で、
 * ゲームのルールには一切踏み込まない。ルールは src/game/ 以下に閉じている。
 */
import { loadAllCharacterSprites } from './core/assets.js';
import { InputManager } from './core/input.js';
import { GameLoop } from './core/loop.js';
import {
  CHARACTER_IDS,
  EXTRA_SPRITE_IDS,
  ROSTER,
  getCharacter,
} from './game/characters/index.js';
import { Simulation } from './game/sim.js';
import { CpuController } from './game/ai.js';
import { ArcadeRun } from './game/arcade.js';
import { Renderer } from './render/renderer.js';
import { Hud } from './render/hud.js';
import { ScreenManager, CharacterSelect } from './ui/screens.js';
import { drawStillFrame } from './render/spritebank.js';
import { LocalSession, LockstepSession } from './net/session.js';
import { WebSocketTransport } from './net/transport.js';

const $ = (id) => document.getElementById(id);

const dom = {
  canvas: $('stage'),
  loadingText: $('loading-text'),
  loadingFill: $('loading-fill'),
  roster: $('roster'),
  selectTitle: $('select-title'),
  selectConfirm: $('select-confirm'),
  selectBack: $('select-back'),
  onlineUrl: $('online-url'),
  onlineRoom: $('online-room'),
  onlineStatus: $('online-status'),
  resultTitle: $('result-title'),
  resultScore: $('result-score'),
  arcadeStep: $('arcade-step'),
  arcadeHeadline: $('arcade-headline'),
  arcadePortrait: $('arcade-portrait'),
  arcadeName: $('arcade-name'),
  arcadeSub: $('arcade-sub'),
  arcadeTrack: $('arcade-track'),
  arcadeNext: $('arcade-next'),
  arcadeEndTitle: $('arcade-end-title'),
  arcadeEndScore: $('arcade-end-score'),
  arcadeEndTrack: $('arcade-end-track'),
  hudOverlay: $('hud-overlay'),
  netStatus: $('net-status'),
  touch: $('touch'),
  rotateHint: $('rotate-hint'),
  debugToggle: $('debug-toggle'),
};

const app = {
  sprites: null,
  screens: new ScreenManager(),
  input: new InputManager(),
  hud: new Hud(),
  renderer: null,
  loop: null,
  select: null,
  sim: null,
  session: null,
  cpu: null,
  /** アーケード中だけ入る ArcadeRun。それ以外は null。 */
  arcade: null,
  mode: 'cpu',
  characters: ['swordsman', 'berserker'],
  labels: ['1P', '2P'],
  paused: false,
  resultShown: false,
  dpr: 1,
};

// ── キャンバスのサイズ合わせ ───────────────────────────────

function resizeCanvas() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  app.dpr = dpr;
  const w = dom.canvas.clientWidth;
  const h = dom.canvas.clientHeight;
  const bw = Math.round(w * dpr);
  const bh = Math.round(h * dpr);
  if (dom.canvas.width !== bw || dom.canvas.height !== bh) {
    dom.canvas.width = bw;
    dom.canvas.height = bh;
  }
  updateRotateHint();
}

const isTouchDevice = () =>
  navigator.maxTouchPoints > 0 || window.matchMedia('(pointer: coarse)').matches;

function updateRotateHint() {
  const inGame = app.screens.current === 'screen-game';
  const portrait = window.innerHeight > window.innerWidth;
  dom.rotateHint.classList.toggle('hidden', !(inGame && portrait && isTouchDevice()));
}

// ── 起動 ───────────────────────────────────────────────────

async function boot() {
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);
  window.addEventListener('orientationchange', () => setTimeout(resizeCanvas, 120));

  // キャラ本体に加えて、技から出てくるスプライト（彼氏）も一緒に読む
  app.sprites = await loadAllCharacterSprites([...CHARACTER_IDS, ...EXTRA_SPRITE_IDS], (done, total) => {
    dom.loadingFill.style.width = `${Math.round((done / total) * 100)}%`;
    dom.loadingText.textContent = `キャラクター読み込み中… ${done}/${total}`;
  });

  app.renderer = new Renderer(dom.canvas, app.sprites);
  app.loop = new GameLoop(update, render);
  app.input.attachKeyboard(window);
  app.input.attachTouchZones(dom.touch);

  app.select = new CharacterSelect(
    {
      root: dom.roster,
      title: dom.selectTitle,
      confirm: dom.selectConfirm,
      back: dom.selectBack,
    },
    ROSTER,
    app.sprites
  );

  wireMenus();
  app.screens.show('screen-title');
}

// ── メニュー配線 ───────────────────────────────────────────

function wireMenus() {
  for (const btn of document.querySelectorAll('[data-mode]')) {
    btn.addEventListener('click', () => startModeSelect(btn.dataset.mode));
  }

  wireHowto();

  $('online-back').addEventListener('click', () => app.screens.show('screen-title'));
  $('online-connect').addEventListener('click', connectOnline);

  $('arcade-next').addEventListener('click', startArcadeBattle);
  $('arcade-quit').addEventListener('click', goTitle);
  // ゲームオーバーからは同じキャラで引き直す（相手の並びは新しく引き直される）
  $('arcade-again').addEventListener('click', () => startArcadeRun(app.arcade.playerId));
  $('arcade-end-select').addEventListener('click', () => startModeSelect('arcade'));
  $('arcade-end-title-btn').addEventListener('click', goTitle);

  $('result-rematch').addEventListener('click', () => startMatch());
  $('result-select').addEventListener('click', () => startModeSelect(app.mode));
  $('result-title-btn').addEventListener('click', goTitle);

  $('pause-btn').addEventListener('click', () => setPaused(true));
  $('pause-resume').addEventListener('click', () => setPaused(false));
  $('pause-restart').addEventListener('click', () => {
    setPaused(false);
    startMatch();
  });
  $('pause-quit').addEventListener('click', goTitle);
  dom.debugToggle.addEventListener('change', () => {
    app.renderer.debug = dom.debugToggle.checked;
  });

  // Esc でポーズ、F1 で判定表示（PC 向けの近道）
  window.addEventListener('keydown', (e) => {
    if (app.screens.current !== 'screen-game') return;
    if (e.code === 'Escape' && app.mode !== 'online') {
      setPaused(!app.paused);
      e.preventDefault();
    } else if (e.code === 'F1') {
      app.renderer.debug = !app.renderer.debug;
      dom.debugToggle.checked = app.renderer.debug;
      e.preventDefault();
    }
  });

  // 保存しておいた接続先を復元しておくと、再戦のたびに打ち直さずに済む
  dom.onlineUrl.value = localStorage.getItem('kakuto.url') ?? '';
  dom.onlineRoom.value = localStorage.getItem('kakuto.room') ?? '';
}

/**
 * 遊び方の画面。タイトルから細かい説明を追い出した先で、
 * 「ルール」と「操作方法」をタブで切り替えるだけの読み物。
 */
function wireHowto() {
  const tabs = [...document.querySelectorAll('[data-howto]')];
  const pages = [...document.querySelectorAll('[data-howto-page]')];

  const openPage = (name) => {
    for (const tab of tabs) tab.classList.toggle('is-active', tab.dataset.howto === name);
    for (const page of pages) page.hidden = page.dataset.howtoPage !== name;
    // タブを替えたら先頭から読ませる（前のタブのスクロール位置が残ると迷子になる）
    document.querySelector('.doc-scroll').scrollTop = 0;
  };

  for (const tab of tabs) tab.addEventListener('click', () => openPage(tab.dataset.howto));

  $('title-howto').addEventListener('click', () => {
    openPage('rule');
    app.screens.show('screen-howto');
  });
  $('howto-back').addEventListener('click', () => app.screens.show('screen-title'));
}

function startModeSelect(mode) {
  app.mode = mode;
  app.screens.show('screen-select');

  if (mode === 'arcade') {
    app.select.start(1, ['あなた'], (picks) => startArcadeRun(picks[0]), goTitle);
    return;
  }

  if (mode === 'online') {
    app.select.start(
      1,
      ['あなた'],
      (picks) => {
        app.characters[0] = picks[0];
        app.screens.show('screen-online');
      },
      goTitle
    );
    return;
  }

  const labels = mode === 'cpu' ? ['あなた', 'CPU'] : ['1P', '2P'];
  app.select.start(
    2,
    labels,
    (picks) => {
      app.characters = picks;
      app.labels = mode === 'cpu' ? ['YOU', 'CPU'] : ['1P', '2P'];
      startMatch();
    },
    goTitle
  );
}

function goTitle() {
  app.loop?.stop();
  // 見えていないサムネイルを回し続けない
  app.select?.stop();
  app.session?.dispose();
  app.session = null;
  app.sim = null;
  app.arcade = null;
  setPaused(false);
  dom.hudOverlay.classList.add('hidden');
  dom.touch.classList.add('hidden');
  app.screens.show('screen-title');
  updateRotateHint();
}

// ── 試合の開始 ─────────────────────────────────────────────

/** ローカル（CPU戦 / 同一端末2人）の試合を始める。 */
function startMatch() {
  const seed = (Math.random() * 0xffffffff) >>> 0;
  app.sim = new Simulation({ characters: app.characters, seed });

  if (app.mode === 'cpu' || app.mode === 'arcade') {
    app.input.solo = true;
    // 難易度は ai.js の DIFFICULTY にある easy / normal / hard から選ぶ。
    // 手応えを出したいので、単発の CPU 戦もアーケードも hard で通す。
    app.cpu = new CpuController(1, 'hard');
    app.session = new LocalSession(app.sim, (sim) => app.cpu.think(sim));
  } else {
    // 2人対戦ではキー配列を左右で分ける
    app.input.solo = false;
    app.cpu = null;
    app.session = new LocalSession(app.sim, null);
  }
  enterGame();
}

function enterGame() {
  app.resultShown = false;
  app.hud.ghost = [1, 1];
  app.input.reset();
  app.screens.show('screen-game');
  dom.hudOverlay.classList.remove('hidden');
  dom.touch.classList.toggle('hidden', !isTouchDevice());
  dom.netStatus.textContent = '';
  resizeCanvas();
  app.loop.start();
}

// ── アーケード（勝ち抜き） ─────────────────────────────────

/**
 * 勝ち抜きを始める。相手の並びはここで一度だけ決まり、
 * 全制覇するかゲームオーバーになるまで引き直されない
 * （＝一度当たった相手とは二度と当たらない）。
 */
function startArcadeRun(playerId) {
  app.mode = 'arcade';
  app.arcade = new ArcadeRun(playerId, CHARACTER_IDS);
  showArcadeNext();
}

/** 「次の相手」画面のいまの相手と、そこから 1 戦始める。 */
function startArcadeBattle() {
  stopArcadeIntro();
  app.characters = [app.arcade.playerId, app.arcade.opponent];
  // 相手の名前をそのまま体力ゲージに出す（誰と戦っているかが試合中も分かる）
  app.labels = ['YOU', getCharacter(app.arcade.opponent).name];
  startMatch();
}

/** 1 戦の決着をアーケードの進行に反映する。 */
function resolveArcadeMatch() {
  // 引き分け（時間切れで取得ラウンドが並んだ場合）も勝ち抜けにはしない
  if (app.sim.matchWinner !== 0) {
    showArcadeEnd(false);
    return;
  }
  if (app.arcade.win()) showArcadeEnd(true);
  else showArcadeNext();
}

/** 次の相手の紹介画面。 */
function showArcadeNext() {
  const run = app.arcade;
  const foe = getCharacter(run.opponent);
  dom.arcadeStep.textContent = `${run.battleNo} 戦目 / 全 ${run.total} 戦`;
  dom.arcadeHeadline.textContent = run.index === 0 ? '最初の相手' : '次の相手';
  dom.arcadeName.textContent = foe.name;
  dom.arcadeSub.textContent =
    run.playerId === foe.id ? `${foe.subtitle} ── 同キャラ対決` : foe.subtitle;
  drawArcadeTrack(dom.arcadeTrack, run, -1);
  app.screens.show('screen-arcade');
  startArcadeIntro(foe.id, run.battleNo === run.total ? '最後の相手と戦う' : '戦う');
}

/** ゲームオーバー / 全制覇の画面。 */
function showArcadeEnd(cleared) {
  const run = app.arcade;
  const me = getCharacter(run.playerId).name;
  dom.arcadeEndTitle.textContent = cleared ? '全制覇！' : 'ゲームオーバー';
  dom.arcadeEndScore.textContent = cleared
    ? `${me} で全 ${run.total} 人を撃破`
    : `${me} で ${run.index} 人抜き（${run.battleNo} 戦目で敗退）`;
  drawArcadeTrack(dom.arcadeEndTrack, run, cleared ? -1 : run.index);
  app.screens.show('screen-arcade-end');
}

/**
 * 勝ち抜きの札を並べる。
 * 倒した相手だけ名前を出し、これから当たる相手は「？」のままにしておく
 * （並びがランダムなのが売りなので、先が見えると引きが弱くなる）。
 * @param {number} lostAt 敗れた相手の位置（0始まり）。なければ -1
 */
function drawArcadeTrack(root, run, lostAt) {
  root.innerHTML = '';
  run.order.forEach((id, i) => {
    const el = document.createElement('span');
    if (i < run.index) {
      el.className = 'is-done';
      el.textContent = getCharacter(id).name;
    } else if (i === lostAt) {
      el.className = 'is-lost';
      el.textContent = getCharacter(id).name;
    } else if (i === run.index) {
      el.className = 'is-now';
      el.textContent = getCharacter(id).name;
    } else {
      el.textContent = `${i + 1}`;
    }
    root.appendChild(el);
  });
}

/**
 * 相手の紹介。立ち絵の待機モーションと、自動で試合が始まるまでの秒読みを回す。
 *
 * 秒読みを setTimeout ではなく描画のフレームで数えているのは、
 * **裏に回っている間は進めたくない**から。ブラウザは見えていないタブの
 * requestAnimationFrame を止めるので、他の画面を見ている隙に試合が始まって
 * 1 戦目から死んでいた、が起きない。戻ってくれば続きから数え直す。
 */
const ARCADE_INTRO_SECONDS = 5;

let introRaf = 0;
let introId = null;
let introLabel = '戦う';
let introStart = 0;

function startArcadeIntro(id, label) {
  introId = id;
  introLabel = label;
  introStart = 0; // 最初のフレームで now を入れる（この時点の時計とはズレるため）
  // 1 フレーム目まで前の相手のときの秒数が残らないよう、先に書いておく
  dom.arcadeNext.textContent = `${label}（${ARCADE_INTRO_SECONDS}）`;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const canvas = dom.arcadePortrait;
  canvas.width = 128 * dpr;
  canvas.height = 150 * dpr;
  if (!introRaf) introRaf = requestAnimationFrame(tickArcadeIntro);
}

function stopArcadeIntro() {
  if (introRaf) cancelAnimationFrame(introRaf);
  introRaf = 0;
}

function tickArcadeIntro(now) {
  if (app.screens.current !== 'screen-arcade') {
    introRaf = 0;
    return;
  }
  introRaf = requestAnimationFrame(tickArcadeIntro);
  if (!introStart) introStart = now;

  drawArcadePortrait(now);

  const left = ARCADE_INTRO_SECONDS - (now - introStart) / 1000;
  if (left <= 0) {
    startArcadeBattle();
    return;
  }
  dom.arcadeNext.textContent = `${introLabel}（${Math.ceil(left)}）`;
}

/** 立ち絵。キャラ選択のサムネイルと同じで待機モーションを回す。 */
function drawArcadePortrait(now) {
  const sprite = app.sprites?.[introId];
  if (!sprite) return;
  const canvas = dom.arcadePortrait;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = canvas.width / dpr;
  const H = canvas.height / dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const cell = sprite.animations.idle;
  drawStillFrame(
    ctx,
    sprite,
    'idle',
    Math.floor(now / 110) % cell.frames,
    W / 2,
    H - 6,
    (H - 16) / sprite.height
  );
}

// ── オンライン ─────────────────────────────────────────────

async function connectOnline() {
  const url = dom.onlineUrl.value.trim();
  const room = dom.onlineRoom.value.trim() || 'default';
  if (!url) {
    dom.onlineStatus.textContent = 'サーバ URL を入力してください';
    return;
  }
  localStorage.setItem('kakuto.url', url);
  localStorage.setItem('kakuto.room', room);

  dom.onlineStatus.textContent = '接続中…';
  const transport = new WebSocketTransport(url, room, { character: app.characters[0] });

  try {
    await transport.connect();
  } catch {
    dom.onlineStatus.textContent = '接続できませんでした。URL を確認してください。';
    return;
  }

  dom.onlineStatus.textContent = '対戦相手を待っています…';
  transport.onMessage((msg) => {
    if (msg.t === 'closed') {
      dom.onlineStatus.textContent = '接続が切れました';
    } else if (msg.t === 'start') {
      // サーバが両者のキャラと乱数シードを揃えて配る
      app.input.solo = true;
      app.characters = msg.characters;
      app.labels = msg.slot === 0 ? ['あなた', '相手'] : ['相手', 'あなた'];
      app.sim = new Simulation({ characters: msg.characters, seed: msg.seed });
      app.session = new LockstepSession(app.sim, transport, msg.slot, msg.delay ?? 3);
      app.onlineSlot = msg.slot;
      enterGame();
    }
  });
}

// ── ループ ─────────────────────────────────────────────────

/**
 * スワイプの意味が試合の状況で変わるぶんを、入力側へ伝える。
 *
 * - `aimDir`: 相手がどちら側にいるか。右半分のフリックを
 *   「相手の方＝スキル」に振り分けるのに使う。キャラの `facing` ではなく
 *   実際の位置関係を見るのは、空中で相手に背を向けている間も
 *   弾いた向きと出る技が食い違わないようにするため。
 * - `airborne`: 空中かどうか。空中では横スワイプもジャンプになる。
 * - `hovering`: 飛行で滞空しているか。滞空だけは横入力がそのまま速度になるので、
 *   空中でも横スワイプをジャンプに変えない。
 */
function updateInputContext() {
  const me = app.mode === 'online' ? (app.onlineSlot ?? 0) : 0;
  const [a, b] = app.sim.fighters;
  const self = me === 0 ? a : b;
  const foe = me === 0 ? b : a;
  app.input.aimDir[0] = foe.x >= self.x ? 1 : -1;
  app.input.airborne[0] = self.airborne;
  app.input.hovering[0] = self.hoverTicks > 0;
}

function update() {
  if (!app.sim || app.paused) return;

  updateInputContext();
  const bits = app.input.poll();
  // オンラインでは自分の入力だけが意味を持つ（スロットは相手側で解決される）
  app.session.advance(bits);

  dom.netStatus.textContent = app.session.status ?? '';

  if (app.sim.isOver && !app.resultShown) showResult();
}

function render() {
  if (!app.sim || !app.renderer) return;
  app.renderer.render(app.sim, app.dpr);

  const ctx = dom.canvas.getContext('2d');
  const w = dom.canvas.width / app.dpr;
  const h = dom.canvas.height / app.dpr;
  ctx.setTransform(app.dpr, 0, 0, app.dpr, 0, 0);
  app.hud.draw(ctx, app.sim, w, h, app.labels);
}

function setPaused(on) {
  if (app.mode === 'online' && on) return; // オンラインは止められない
  // アーケードは負けたら終わりなので、やり直しで敗北をなかったことにはさせない
  $('pause-restart').hidden = app.mode === 'arcade';
  app.paused = on;
  app.screens.overlay('screen-pause', on);
  if (on) app.input.reset();
}

function showResult() {
  app.resultShown = true;
  app.loop.stop();
  dom.hudOverlay.classList.add('hidden');
  dom.touch.classList.add('hidden');

  if (app.mode === 'arcade') {
    resolveArcadeMatch();
    return;
  }

  const winner = app.sim.matchWinner;
  dom.resultTitle.textContent =
    winner >= 0 ? `${app.labels[winner]} の勝ち` : '引き分け';
  const [a, b] = app.sim.wins;
  dom.resultScore.textContent =
    `${getCharacter(app.characters[0]).name} ${a} - ${b} ${getCharacter(app.characters[1]).name}`;
  app.screens.show('screen-result');
  // オンラインは同じ相手との再戦に別途やり取りが要るので、いったん切る
  if (app.mode === 'online') {
    app.session?.dispose();
    app.session = null;
  }
}

// デバッグ用の覗き窓。DevTools から `__app.sim.fighters[0]` などを見られる。
window.__app = app;

boot().catch((err) => {
  console.error(err);
  dom.loadingText.textContent = `読み込みに失敗しました: ${err.message}`;
});
