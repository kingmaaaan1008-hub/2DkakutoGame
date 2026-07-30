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
import { Renderer } from './render/renderer.js';
import { Hud } from './render/hud.js';
import { ScreenManager, CharacterSelect } from './ui/screens.js';
import { LocalSession, LockstepSession } from './net/session.js';
import { WebSocketTransport } from './net/transport.js';

const $ = (id) => document.getElementById(id);

const dom = {
  canvas: $('stage'),
  loadingText: $('loading-text'),
  loadingFill: $('loading-fill'),
  roster: $('roster'),
  selectInfo: $('select-info'),
  selectTitle: $('select-title'),
  selectConfirm: $('select-confirm'),
  selectBack: $('select-back'),
  onlineUrl: $('online-url'),
  onlineRoom: $('online-room'),
  onlineStatus: $('online-status'),
  resultTitle: $('result-title'),
  resultScore: $('result-score'),
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
      info: dom.selectInfo,
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

  $('online-back').addEventListener('click', () => app.screens.show('screen-title'));
  $('online-connect').addEventListener('click', connectOnline);

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

function startModeSelect(mode) {
  app.mode = mode;
  app.screens.show('screen-select');

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
  app.session?.dispose();
  app.session = null;
  app.sim = null;
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

  if (app.mode === 'cpu') {
    app.input.solo = true;
    // 難易度は ai.js の DIFFICULTY にある easy / normal / hard から選ぶ。
    // 手応えを出したいので hard を既定にしている。
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
 */
function updateInputContext() {
  const me = app.mode === 'online' ? (app.onlineSlot ?? 0) : 0;
  const [a, b] = app.sim.fighters;
  const self = me === 0 ? a : b;
  const foe = me === 0 ? b : a;
  app.input.aimDir[0] = foe.x >= self.x ? 1 : -1;
  app.input.airborne[0] = self.airborne;
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
  app.paused = on;
  app.screens.overlay('screen-pause', on);
  if (on) app.input.reset();
}

function showResult() {
  app.resultShown = true;
  app.loop.stop();
  const winner = app.sim.matchWinner;
  dom.resultTitle.textContent =
    winner >= 0 ? `${app.labels[winner]} の勝ち` : '引き分け';
  const [a, b] = app.sim.wins;
  dom.resultScore.textContent =
    `${getCharacter(app.characters[0]).name} ${a} - ${b} ${getCharacter(app.characters[1]).name}`;
  dom.hudOverlay.classList.add('hidden');
  dom.touch.classList.add('hidden');
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
