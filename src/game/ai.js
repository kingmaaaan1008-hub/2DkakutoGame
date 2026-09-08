/**
 * CPU の思考ルーチン。
 *
 * 出力は人間と同じ「入力ビットマスク」なので、シミュレーションから見ると
 * プレイヤーと区別がつかない。乱数は sim.rng を通しているため、
 * CPU 戦もリプレイ・ロールバックがそのまま成立する。
 *
 * ── 方針 ────────────────────────────────────────────────────
 * 一発当たったら即死なので、**振るか振らないか**の判断がほぼ全部を決める。
 * 手数を増やすより「当たる間合いでしか振らない」「相手の隙にだけ差し込む」
 * を守るほうが強い。そこで
 *
 *   1. 技の間合いと発生を技データから割り出し、届く距離でしか振らない
 *   2. 相手が手を出せない時間（空振りの戻り・着地・のけぞり・ガード硬直）を
 *      見つけて、そこにだけ差し込む
 *   3. 固められたらスキルで崩す。逆に自分が不利なら間合いを外す
 *
 * を土台にしている。難易度はこの判断をどれだけ拾えるかで変える。
 */
import { BTN, GRAVITY, STAGE_MARGIN, STAGE_WIDTH, STATE } from './constants.js';
import { CROUCH_CLEAR_Y, HURTBOX } from './fighter.js';
import { getProjectileDef, isProjectile } from './projectiles.js';

/**
 * 難易度プリセット。
 *
 * `hold` は決めた行動を維持する時間の倍率。大きいほど「読み直しが遅い」＝
 * 状況が変わっても前の判断を引きずるので、弱くなる。
 *
 * `read` は「ガードでは止まらない技（掴み・スキル）だと見抜ける割合」。
 * ここだけは重みではなく**気づけるかどうか**で、外すと一番確実に見える
 * ガードを固めて、そのまま割られる。スキルを連打されたときの強さは
 * ほぼこの値で決まるので、難易度差が一番はっきり出るのもここ。
 *
 * ほかは「その手をどれだけ重く見るか」。大きいほどその状況で正しく選べる。
 */
export const DIFFICULTY = {
  easy: {
    react: 20,
    hold: 1.9,
    guard: 0.3,
    read: 0.3,
    punish: 0.18,
    aggression: 0.4,
    crush: 0.25,
    dash: 0.1,
    spacing: 0.25,
  },
  normal: {
    react: 9,
    hold: 1.25,
    guard: 0.62,
    read: 0.75,
    punish: 0.55,
    aggression: 0.6,
    crush: 0.6,
    dash: 0.35,
    spacing: 0.55,
  },
  hard: {
    react: 3,
    hold: 0.8,
    guard: 0.94,
    read: 1,
    punish: 0.92,
    aggression: 0.8,
    crush: 0.92,
    dash: 0.7,
    spacing: 0.9,
  },
};

/** やられ判定の半幅。相手のこのぶんだけ、技は手前で当たり始める。 */
const HURT_HALF = HURTBOX.w / 2;

/** 飛び道具の技は画面の向こうまで届くものとして扱う。 */
const PROJECTILE_REACH = 900;

/** これより発生が遅い技は「振ったら戻れない大技」として扱う。 */
const SLOW_STARTUP = 20;

/** この高さより下に収まっている攻撃は、跳べば頭の上を通せる。 */
const JUMP_CLEAR_Y = 170;

/**
 * 逃げる手が間に合うのに必要な猶予（判定が出るまでのフレーム数）。
 * 跳ぶ・下がるは動き出しに時間がかかるので、
 * 残り時間を見ずに選ぶと「逃げようとして食らう」になる。
 */
const JUMP_ESCAPE_FRAMES = 9;
const RETREAT_ESCAPE_FRAMES = 7;

/**
 * ホーミング弾を 2段ジャンプで避けるための値。総当たりで探して決めた。
 *
 * 「真上に跳ぶ → 弾が近づいたら**前へ**跳び直す」で 7 割避けられる。
 * 1段目だけでは 0〜7% しか避けられず、2段目が本体。
 * 弾は turnRate が低く曲がりきれないので、間近で軌道を変えると置いていける。
 *
 * 2段目の合図に残りフレームではなく**弾との実距離**を使うのが要点。
 * 曲がる弾は到達時間の見積りが当てにならず、距離で見た方が素直だった
 * （残りフレームで合わせると成功率は 14% まで落ちる）。
 */
const DODGE_ARM_FRAMES = 34;
/**
 * 回避を始める窓の上限。早く跳びすぎると弾が来る前に着地してしまい、
 * 2段目を弾に合わせられない（探索で成功率が 7 割 → 2 割に落ちた）。
 */
const DODGE_ARM_MAX = 50;
const DODGE_AIR_DIST = 145;

/**
 * 弾を見て何か決め始める残りフレーム。
 *
 * ガードは間近で間に合うが、2段ジャンプ回避は跳ぶ時間が要るので、
 * ガードより早い段階から考え始めないと選べない。
 * 早めに見ておくと「弾を見ながら詰める」判断にも入れるので、
 * 実測では弾を撒く相手への勝率がここで 22% → 31% に伸びた。
 */
const PROJECTILE_REACT = 84;

/**
 * 飛んできている弾に反応し始める残りフレーム（相対速度で見た到達時間）。
 *
 * 実測で決めた値。短くすると足は止まらないが受け損なう（14 で勝率 0%）。
 * 長くしすぎると弾を見るたびに固まって近づけない（60 で 4%）。
 * 34 が一番勝てた（20.7%）。
 */
const PROJECTILE_WATCH = 34;

/**
 * 危険が目前と見なす残りフレーム。前の判断を引きずるのをやめて考え直す。
 * ガードの発生は 1F なので、これだけ残っていれば間に合う。
 */
const RETHINK_FRAMES = 12;

/**
 * 守りの構えを維持する上限（ティック）。
 *
 * 魔法使いの照射は溜め 60 ＋ 照射 34 ＝ 94 フレーム居座るので、
 * ここが短いと**照射の途中で立ち上がる**。しゃがみは立ち上がりの 1 ティックで
 * やられ判定が 110 まで戻り、ビームの下端 107 に届いてしまうため、
 * 「一瞬だけ早く立つ」がそのまま被弾になる。
 */
const HOLD_MAX = 120;

/**
 * ガード不能弾を跳び越すための踏み切り窓（ティック）。
 *
 * 跳ぶかどうかではなく「いつ踏み切るか」の問題なので、
 * 弾の到達フレームが頂点までのフレームと噛み合ったところだけで踏み切る。
 */
const HOP_WINDOW = 8;

/**
 * 跳んで越えたと言うのに要る余裕（弾の上端と跳べる高さの差）。
 *
 * 頂点で一瞬だけ上に出ても越えたことにはならない。弾の横幅を通り抜けるあいだ
 * ずっと上に居られて初めて越えられる。**越えられない弾に跳ぶのは、
 * 跳んだ姿勢のまま当たりに行くのと同じ**なので、ここで先に切り分ける。
 *
 * 40 は「踏み切りの猶予が 16 ティック残る差」。CPU は頂点の前後 HOP_WINDOW で
 * 踏み切るので、これだけ無いと自分の狙いが窓から外れる。
 * 一番跳べないキャラ（跳べる高さ 200）で総当たりして決めた値で、
 * 差が 22 まで詰まると猶予は 12 ティックまで落ちる。
 */
const HOP_CLEARANCE = 40;

/**
 * 降ってくる相手に答えを出し始める残りフレーム。
 *
 * 空中スキルは発生 4〜6 フレームしかない（メイドの天空斬り 4F・
 * 剣士の急降下斬り 5F・狂戦士の斧蹴り 6F）。技が出てから見ていたのでは、
 * 気づいた時点で残り 4 フレームしか無く、**ガード以外のどの手も間に合わない**。
 * しかもそれらは軒並みガードを崩すので、ガードも答えにならない。
 * 見るべき合図は技ではなく**跳ばれたこと**で、そちらは降りてくるまで
 * 30〜50 フレームある。
 *
 * とはいえ跳ばれた瞬間から身構えると、今度は跳ばれるたびに足が止まって
 * 攻めどころを丸ごと失う。**降りてくるのが見えてから**動き出すための線引き。
 */
const AIR_REACT = 34;

/** 落下の見通しを立てる上限（ティック）。跳んで降りるまでが 60 ほど。 */
const AIR_LOOKAHEAD = 72;

/**
 * ここより発生が遅い空中技は「見てから対応できる技」として扱い、
 * 普通の攻撃と同じ経路に流す。速い技だけを跳んだ時点で読む。
 */
const AIR_FAST = 14;

/**
 * 降ってきた判定が「自分に届いた」と数える高さ ＝ 立ちのやられ判定の上端。
 *
 * ここを胸の高さまで下げて甘く見ていた頃は、**横に伸びてくる空中技を
 * 見落としていた**。キャヴァリアのドリルは高さ 40〜200 をほぼ水平に走るので、
 * 「まだ高いから下をくぐれる」と読んで正面から突っ込むことになる。
 * 当たるかどうかは判定とやられ判定が重なるかどうかでしかない。
 */
const AIR_CONTACT_Y = HURTBOX.h;

/**
 * 対空を振る窓（ティック）。発生ぶん手前で振り始めて、落ちてくるところに
 * 判定を置く。早すぎると振り終わった上から刺され、遅いと出る前に潰される。
 *
 * 広げても得にならない。降り技を読んだ 3416 回のうち振れるのは 11.9% しか
 * 無いので**跳ばれたら足で外す**動きになりがちだが、窓を 10・16 と広げ、
 * 重みと射程も足して総当たりしたところ、どの組み合わせでも与ダメが落ちて
 * 被ダメが増えた（538.8/526.0 → 最良でも 533.8/531.0）。
 * 落ちてくる相手に振り勝てる形はもともと狭い。
 */
const AIR_SWING_WINDOW = 7;

/**
 * 背中にこれだけ無いと「詰められている」。
 *
 * 仕切り直しの下がりはダッシュで 12 ティック ＝ 90 ほど進むので、
 * 220 は**それが 2 回入らない**幅。ここを切ると、下がる手は距離を買う手ではなく
 * 「壁までの残りを使い切る手」に変わる。間合いは同じまま、逃げ道だけが減る。
 */
const CORNER_ROOM = 220;

/**
 * 壁を背負っても、下がる手を完全には捨てない下限。
 *
 * 0 にすると、来ている技を下がって空振らせる手まで消える。壁際でも
 * 「あと一歩下がれば先端が届かない」は成立するので、選べる形では残す。
 */
const CORNER_FLOOR = 0.25;

/**
 * 相手を壁に詰めているときの攻めの割り増し。
 *
 * 詰めた相手は下がって仕切り直せない ＝ こちらの技を受けるか手を出すかしか
 * 無くなる。攻めがいちばん通る場面。
 *
 * ただしこの倍率そのものの効きは小さい。振る手は同じ手の重みを落とす仕組みと
 * クールダウンで頭打ちになるので、掛けても実測で 46.3% → 46.4% しか動かない。
 * 詰めた状況で実際に効いているのは**離れ直す手を出さないこと**の方で
 * （下がりが 20% → 6%）、そちらは重みではなく候補そのものを消して作っている。
 */
const CORNER_PRESS = 1.6;

/**
 * 降り技持ちへ跳び込んでよいと言える、相手の硬直の長さ（フレーム）。
 *
 * 跳んでから着地するまでは、身長ぶんの跳躍で 50 フレーム前後。相手の硬直が
 * それより長く残っているなら、こちらが降りて動けるようになるまで相手は
 * 何も返せない。余裕を足して 56 で見る。
 */
const JUMP_IN_SAFE = 56;

/**
 * 置き技を読む先の長さ（ティック）。跳んで降りるまでが 60 ほどなので、
 * 昇りの途中で読み始めても着地までは追い切れる。
 */
const PLACE_LOOKAHEAD = 48;

/**
 * 置きが成立する窓（ティック）。
 *
 * 「相手が判定の中に入ってくるのが、自分の発生の何ティック後か」を見る。
 * 0 なら発生と同時に飛び込んでくる ＝ ぴったり置けている。
 * 広げすぎると**まだ来てもいない相手に振る**ただの空振りになる。
 */
const PLACE_WINDOW = 8;

/** 気分の持続（ティック）。数秒ごとに攻めっ気と守りっ気が入れ替わる。 */
const MOOD_MIN = 90;
const MOOD_MAX = 220;

/**
 * 手を出さずにいられる長さ（ティック）。
 *
 * 避ける手はどれも「当たらない」という一点では常に正しい。だから危ないものが
 * 次々に見えている限り、CPU はいつまでも正しく下がり続けられてしまう。
 * 一手ずつ見れば全部合っているのに、試合として見ると何もしていない。
 *
 * ここを超えても手が出ていないなら、多少割に合わなくても攻めへ寄せる。
 * 重みを足すだけなので、**ほかに手が無い場面（forced）までは崩さない**。
 */
const PATIENCE = 72;

/**
 * 攻めへの寄せの上限。
 *
 * 青天井にすると、待っていれば必ず突っ込んでくる CPU になって
 * 「下がって待つ」だけで勝てるようになる。攻め手が守り手と並ぶあたりで止める。
 */
const PATIENCE_MAX = 1.6;

/** キャラ定義ごとの技の性能。技データから割り出したものを覚えておく。 */
const PROFILES = new WeakMap();

/**
 * 技の間合い・発生・飛び道具かどうかを技データから割り出す。
 *
 * 数値を手で書くと技を調整したときに置いていかれるので、必ずデータから引く。
 * 溜め技は自分では判定を持たず `onEnd` の先に本体があるので、
 * 繋ぎ先まで辿り、発生フレームは前段の全体フレームを足して数える
 * （魔法使いの照射なら「1秒の溜め＋本体の発生」が発生フレームになる）。
 */
export function profileOf(def) {
  const cached = PROFILES.get(def);
  if (cached) return cached;

  const scan = (id) => {
    let move = id ? def.moves[id] : null;
    if (!move) return null;
    let reach = 0;
    let travel = 0;
    let startup = Infinity;
    let projectile = false;
    let grab = false;
    let guardBreak = false;
    let low = Infinity;
    let top = -Infinity;
    let drop = 0;
    let lunge = 0;
    let offset = 0;
    let total = 0;
    let wardFrame = Infinity;
    for (let guard = 0; move && guard < 4; guard += 1) {
      // 結界を張る技か。張れるまでのフレームが分からないと、間に合うか測れない
      if (move.ward) wardFrame = Math.min(wardFrame, offset + move.ward.frame);
      for (const h of move.hits) {
        reach = Math.max(reach, h.box.x + h.box.w);
        startup = Math.min(startup, offset + h.start);
        // 判定の上下端。対空で「そこまで手が届くか」を測るのに使う
        low = Math.min(low, h.box.y);
        top = Math.max(top, h.box.y + h.box.h);
        if (h.grab) grab = true;
        if (h.guardBreak === true) guardBreak = true;
      }
      // 踏み込む技は移動ぶんだけ遠くまで届く。
      // 剣士のタックルは判定リーチ 142 でも、182 前進するので実際は 324 届く。
      for (const m of move.motion) {
        if ((m.vx ?? 0) > 0) {
          travel += m.vx * (m.end - m.start + 1);
          lunge = Math.max(lunge, m.vx);
        }
        // 落ちる速さ。急降下技は重力ではなく技データが速さを決めていて、
        // メイドの天空斬りは 15／ティック ＝ 重力任せの落下の 5 倍で降りてくる。
        if ((m.vy ?? 0) < 0) drop = Math.max(drop, -m.vy);
      }
      // 飛び道具は自分では判定を持たないので、発生は弾を撃つフレームで数える。
      // spawns には演出も混ざる（照射の溜めが出す魔法陣など）ので、
      // 実弾として定義されている type だけを見る。
      // ここを取り違えると「溜め 1 秒の照射」を発生 0 の技だと思い込んで、
      // 密着で溜め始めてそのまま的になる。
      for (const sp of move.spawns) {
        if (!isProjectile(sp.type)) continue;
        projectile = true;
        startup = Math.min(startup, offset + (sp.frame ?? 0));
      }
      offset += move.total;
      total = offset;
      move = move.onEnd ? def.moves[move.onEnd] : null;
    }
    // 弾は画面の向こうまで届くものとして扱う。判定そのものの長さは
    // `hitbox` / `reachOnly` に残しておく（下駄を履かせた射程と混ぜない）。
    const hitbox = reach > 0;
    const reachOnly = reach + HURT_HALF;
    if (projectile) reach = Math.max(reach, PROJECTILE_REACH);
    return {
      /** 判定が届く距離（相手のやられ判定ぶんを含む実効射程）。 */
      range: reach + travel + HURT_HALF,
      startup: Number.isFinite(startup) ? startup : total,
      total,
      projectile,
      /**
       * 当てる手段をひとつも持たない技か（忍者の煙玉）。
       *
       * 判定も弾も無い技を「崩し」として振ると、隙を晒すだけで何も起きない。
       * 煙玉にいたっては出したあと 3 秒間こちらの攻撃が封じられるので、
       * **振るほど弱くなる**。振る候補から外すためにここで印を付ける。
       */
      harmless: !projectile && reach === 0,
      /**
       * 掴み技か。ガードされていても通る代わりに、
       * **相手が空中にいると絶対に当たらない**ので、振る条件が普通の技と違う。
       */
      grab,
      /** ガードを崩す技か。受けに回った時点で負けるので、答えが変わる。 */
      guardBreak,
      /**
       * 打撃判定を持つか（＝弾ではなく体で当てに来る技か）。
       *
       * 空中技を見るときにこれが要る。弾を撃つだけの空中技（魔法使いの流星・
       * 女子高生の空中レーザー）は弾として飛んでくるので `_incomingProjectile()` の
       * 担当で、降ってくる脅威と一緒に数えると「跳ばれるたびに下がる」だけになる。
       */
      hitbox,
      /**
       * 踏み込みぶんを足さない、判定そのものの射程。
       *
       * `range` は前進量を足した「最終的にどこまで届くか」なので、
       * **相手の移動を別に読んでいるときに使うと前進を二重に数える**。
       * 降ってくる相手の軌道を追うときはこちらを使う。
       */
      reachOnly,
      /** 判定の下端・上端（足元原点）。対空とくぐりの可否を測る。 */
      low: Number.isFinite(low) ? low : 0,
      top: Number.isFinite(top) ? top : 0,
      /** 技が決める落下速度（0 なら重力任せ）。急降下技を読むのに要る。 */
      drop,
      /** 技が決める前進速度。降りながら詰めてくるぶん。 */
      lunge,
      /**
       * 結界を張れる技か。張れるまでの frame（張れないなら Infinity）。
       *
       * 結界は打撃も普通の弾も素通しなので、判定の射程で測ると
       * 「何も起きない技」に見える（`harmless`）。実際に止めるのは
       * **ガード不能の技と掴みだけ**で、それはこちらが一番答えを持って
       * いない攻撃でもある。射程ではなく「何を無効にするか」で見ないと、
       * 巫女はスキルを一度も使わないまま終わる。
       */
      wardFrame,
    };
  };

  const profile = {
    attack: scan(def.attackMove),
    skill: scan(def.skillMove),
    /**
     * 空中で出る技。**発生が 4〜6 フレームしかないものが多い**ので、
     * 出てから見て選べる手は無い。跳ばれた時点で答えを決めるために、
     * 何が降ってくるのかを先に割り出しておく。
     */
    airAttack: scan(def.airAttackMove),
    airSkill: scan(def.airSkillMove),
  };
  PROFILES.set(def, profile);
  return profile;
}

/**
 * 相手が着地するまでの残りティック。
 *
 * 降り技への答えは**降り切るまで押し続けて**初めて成立するので、決めた手を
 * どれだけ維持するかはここで決まる。途中で持ち時間が切れると、下がり切る手前で
 * 判断を引き直して、**逃げている最中に突っ込みへ切り替わる**
 * （実測でも、下がって間合いを取り切ったところで走り出して刺されていた）。
 *
 * 上がっている最中なら昇り切ってから落ちるまでを数える。急降下技に入られると
 * これより早く着くが、そのぶん維持する時間が余るだけなので害は無い。
 */
function airTimeOf(foe) {
  let y = foe.y;
  let vy = foe.vy;
  for (let t = 1; t <= AIR_LOOKAHEAD; t += 1) {
    y += vy;
    vy -= GRAVITY;
    if (y <= 0) return t;
  }
  return AIR_LOOKAHEAD;
}

/**
 * 「見てから対応できない降り技」を持つキャラか。
 *
 * 発生 4〜6 フレームの空中スキルは、出てから見て選べる手が無い。
 * 相手がこれを持っているだけで**こちらは跳べなくなる**ので、
 * 技が出ているかどうかとは別に、持っているかどうかを見る場面がある。
 */
export function hasFastDive(def) {
  const prof = profileOf(def);
  return [prof.airAttack, prof.airSkill].some(
    (p) => p && p.hitbox && !p.projectile && p.startup <= AIR_FAST
  );
}

/**
 * その技が最終的に判定を持つか、そしてどこまで届くか。
 *
 * **直下の `hits` だけを見てはいけない。** 判定を `onEnd` の先に置いている技が
 * あって、格闘娘の回転かかと落とし（弧を描くだけで、蹴りは繋ぎ先の
 * かかと振り下ろし）とキャヴァリアの急降下ブーストがそれ。
 * 直下だけで数えると「当たらない技」に見えるので、繋ぐ候補から外れるうえ、
 * `_maskHitlessChains()` がボタンごと落としてしまう。実際この 2 つは、
 * 900 試合を通して一度も出ていなかった。
 */
function chainPayload(def, id) {
  let move = def.moves[id];
  let reach = 0;
  let hits = false;
  for (let guard = 0; move && guard < 4; guard += 1) {
    for (const h of move.hits) {
      hits = true;
      reach = Math.max(reach, h.box.x + h.box.w);
    }
    move = move.onEnd ? def.moves[move.onEnd] : null;
  }
  return { hits, reach };
}

/** 攻めの手か。気分と我慢切れ、どちらの寄せもこの区別で効く。 */
function isPush(act) {
  return act === 'attack' || act === 'skill' || act === 'rush' || act === 'jumpIn';
}

/** 守りの手か。 */
function isHold(act) {
  return act === 'guard' || act === 'retreat' || act === 'duck' || act === 'wait';
}

export class CpuController {
  /**
   * @param {number} index 操作する側（0 or 1）
   * @param {keyof DIFFICULTY} level
   */
  constructor(index, level = 'normal') {
    this.index = index;
    this.cfg = DIFFICULTY[level] ?? DIFFICULTY.normal;
    this.plan = { bits: 0, ticks: 0 };
    /**
     * 次に技を振れるようになるまで。振る手を散らすための間。
     *
     * **打撃とスキルで別々に持つ。** ひとつの数え上げで両方を止めていた頃は、
     * スキルを 1 回振っただけで、その長いクールダウン（照射なら 150 ティック
     * ＝ 2.5 秒）のあいだ**普通の打撃まで振れなく**なっていた。
     * 大技を出したあと数秒なにもしないように見えるのはこれが原因で、
     * 「攻めない」の正体の半分はここだった。
     */
    this.cooldown = 0;
    this.skillCd = 0;
    /**
     * 前のティックに実際に出した入力。
     *
     * 連携は**押した瞬間**（`input & ~prevInput`）しか拾われないので、
     * すでに押しっぱなしのボタンをもう一度「押す」ことはできない。
     * 繋ぐには一度離す必要があり、そのためには今なにを押しているかを
     * 覚えておくしかない。
     */
    this.lastBits = 0;
    /**
     * いま繋いでいる連携で、すでに通った技。
     *
     * 同じところをぐるぐる回らないために要る。格闘娘の 4 段目は攻撃で
     * 1 段目へ戻るので、**通った先を覚えていないと永久に殴り続けるか、
     * 毎回同じところで分岐する**かのどちらかになる。まだ通っていない方を
     * 選べば、4 段まで繋いでから締めのスキルへ自然に流れる。
     */
    this.chainSeen = [];
    /** 狙って押している「判定を持たない連携」。ボタン落としの例外にする。 */
    this.intentChain = null;
    /** 直前に選んだ手と、それが続いた回数。同じ答えの連続を避けるのに使う。 */
    this.lastAct = '';
    this.repeat = 0;
    /** いま走らせている判断が、降ってくる相手への答えか。 */
    this.answeringAir = false;
    /**
     * その降り技に対して選んだ手。相手が降り切るまでは変えない。
     *
     * 混ぜてよいのは「どちらでも助かる」ときだけで、降ってくる相手に対しては
     * **下がると詰めるが正反対の意味を持つ**。持ち時間が切れるたびに選び直すと、
     * 下がり切ったところで詰めに転じて自分から当たりに行くことになる。
     */
    this.airAct = null;
    /**
     * 気分。'push'（攻め） / 'hold'（守り） / 'even'（ふつう）を
     * 数秒ごとに切り替える。同じ状況でも局面によって答えが変わるので、
     * 「この距離ならこう来る」と読み切られにくくなる。
     */
    this.mood = 'even';
    this.moodTicks = 0;
    /**
     * 手を出さずに過ごしたティック数。攻めっ気の下限を作るのに使う（PATIENCE）。
     *
     * 気分（mood）とは別に要る。あちらは**何が起きても**数秒ごとに揺れるだけで、
     * 「守りが正しい状況が続いている」ことには気づけない。避け続けて手が出て
     * いないという事実を数えられるのはここだけ。
     */
    this.idle = 0;
    /**
     * 最後に相手の姿を見た X 座標。
     *
     * 忍者の煙玉で相手が消えている間は、**ここを相手だと思って動く**。
     * sim の中身は全部読めてしまうので、こうしないと CPU だけが
     * 透明な相手をぴったり追いかけ続けることになり、煙玉が
     * 「自分の攻撃を 3 秒封じるだけの技」に成り下がる。
     */
    this.seenX = null;
  }

  /**
   * これから出てくる攻撃判定を全部集める。
   *
   * 溜め技（ビームの溜め・タックルの溜め）は、その段階では判定を 1 つも
   * 持っていない。onEnd の先まで辿らないと「何が来るのか」が分からないので、
   * ここで繋ぎ先も一緒に見ている。溜めを見てから避ける／しゃがむ、が
   * 成立するのはこれのおかげ。
   */
  _upcomingHits(opponent) {
    const hits = [];
    let move = opponent.currentMove();
    for (let guard = 0; move && guard < 4; guard += 1) {
      hits.push(...move.hits);
      move = move.onEnd ? opponent.def.moves[move.onEnd] : null;
    }
    return hits;
  }

  /** 相手が攻撃モーション中で、まだ判定が出ていない（＝これから来る）か。 */
  _incomingAttack(opponent) {
    if (opponent.state !== STATE.MOVE) return false;
    const move = opponent.currentMove();
    if (!move) return false;
    // 溜めの段階。判定はまだ無いが、確実にこれから来る
    if (move.onEnd) return true;
    if (move.hits.length === 0) return false;
    const last = move.hits[move.hits.length - 1];
    return opponent.moveFrame <= last.end;
  }

  /**
   * 今出てきている技が、この間合いの自分まで届くか。
   *
   * 判定ボックスの長さだけでは足りない。タックルのように踏み込む技は
   * 移動ぶんだけ遠くまで届くので、判定が終わるまでの前進量も足して見る。
   * 届かない技にガードを固めるのは、そのまま差し込む機会を捨てることになる。
   */
  _threatRange(opponent) {
    const hits = this._upcomingHits(opponent);
    if (hits.length === 0) return 0;
    let move = opponent.currentMove();
    let travel = 0;
    for (let guard = 0; move && guard < 4; guard += 1) {
      for (const m of move.motion) {
        if ((m.vx ?? 0) > 0) travel += m.vx * (m.end - m.start + 1);
      }
      move = move.onEnd ? opponent.def.moves[move.onEnd] : null;
    }
    const reach = Math.max(...hits.map((h) => h.box.x + h.box.w));
    return reach + travel + HURT_HALF;
  }

  /**
   * しゃがめば下をくぐれる攻撃か。
   * 判定がひとつでも低いところに出るなら、しゃがんでも当たるので false。
   * 魔法使いのビーム（地上から 107〜205 を薙ぐ）がこれに当たる。
   */
  _isDuckable(opponent) {
    if (opponent.state !== STATE.MOVE) return false;
    const hits = this._upcomingHits(opponent);
    if (hits.length === 0) return false;
    /**
     * 高さの下駄は履かせない。
     *
     * 「今どれだけ浮いているか」で測ると、**落ちてくる技を見誤る**。
     * メイドの天空斬りは昇り切ったところから地面まで落ちてくるので、
     * 浮いている高さで見ると「はるか頭上を通る技」に見えて、
     * しゃがんだまま真上から刺される（実測でメイドに負けた 116 回のうち
     * 50 回がしゃがみ中の被弾だった）。
     * 落ち切ったところ＝地上に置いて測れば、この読み違えは起きない。
     * 浮いたまま撃つ技（魔法使いの浮遊照射）は元の判定が高いので、
     * 下駄が無くてもくぐれると分かる。
     */
    return hits.every((h) => h.box.y >= CROUCH_CLEAR_Y);
  }

  /**
   * 相手が「今は手を出せない」状態か。ここに差し込むのが一番安い。
   *
   * 振り切ったあとの戻り・着地硬直・のけぞり・ガード硬直がそれ。
   *
   * 連携（キャンセル）の受付が開いている区間は、続けて振られる可能性が
   * あるので隙とは見なさない。ここを隙として踏み込むと、繋がれた 2 段目に
   * そのまま刺されて損をする（実測でも突っ込む相手に対して勝率が 10 ポイント落ちた）。
   *
   * @returns {number} 差し込める猶予フレーム。0 なら隙ではない。
   */
  _openFrames(opponent) {
    if (opponent.invulnerable || opponent.isKO) return 0;

    // のけぞり・ガード硬直・ガードを崩された直後
    if (
      opponent.state === STATE.HIT ||
      opponent.state === STATE.BLOCK ||
      opponent.state === STATE.GUARD_BREAK
    ) {
      return Math.max(0, opponent.stunTicks - opponent.stateTimer);
    }
    // 着地硬直
    if (opponent.state === STATE.LAND) {
      return Math.max(0, opponent.landLag - opponent.stateTimer);
    }
    // 技の戻り。危ないところを出し切っていて、繋ぎ先も連携受付も無い区間
    if (opponent.state === STATE.MOVE) {
      const move = opponent.currentMove();
      if (!move || move.onEnd) return 0;
      /**
       * 危ないのはいつまでか。判定の終わりと**弾を撃つフレーム**の遅い方で決まる。
       *
       * 判定の有無だけで見ていると、自分では判定を持たない技
       * （女子高生の指さし 40F・魔法使いの詠唱 26F・忍者の煙玉）の戻りが
       * **まるごと隙として見えない**。弾を撃つ相手にだけ差し込めない CPU に
       * なっていたのはこれが原因で、指さしを連打されると、
       * 一番差し込みやすい 40 フレームを毎回見送っていた。
       */
      let last = -1;
      for (const h of move.hits) last = Math.max(last, h.end);
      for (const sp of move.spawns) {
        if (isProjectile(sp.type)) last = Math.max(last, sp.frame ?? 0);
      }
      if (opponent.moveFrame <= last) return 0;
      const chainOpen = move.chains.some(
        (c) => opponent.moveFrame >= c.from - 2 && opponent.moveFrame <= c.to
      );
      if (chainOpen) return 0;
      return move.total - opponent.moveFrame;
    }
    return 0;
  }

  /**
   * 自分に向かって飛んできている相手の弾のうち、いちばん早く届くもの。
   *
   * 弾は撃った本人の状態と切り離して飛ぶので、技のモーションを見ている
   * `_incomingAttack()` ではまったく見えない。ここを見ないと、
   * CPU は弾に対して何もせず歩いて当たりに行く。
   *
   * @returns {{p: object, def: object, frames: number, fromBehind: boolean} | null}
   */
  _incomingProjectile(sim, me) {
    let best = null;
    const hurt = me.hurtBox();
    const cy = hurt.y + hurt.h * 0.5;
    for (const p of sim.projectiles) {
      if (p.owner === this.index) continue;
      const dx = me.x - p.x;
      const dy = cy - p.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 0.001) continue;
      // 到達時間は**相対速度**で見る。弾の速さだけで割ると、
      // 弾に向かって走っているときに倍近く遅く見積もってしまい、
      // 気づいたつもりで間に合わなくなる（実測でこれが被弾の主因だった）。
      const closing = ((p.vx - me.vx) * dx + (p.vy - me.vy) * dy) / dist;
      if (closing <= 0) continue; // 近づいていないものは見ない
      const def = getProjectileDef(p.type);
      const frames = dist / closing;
      if (!best || frames < best.frames) {
        // 背中側から来ている弾はガードできない（canBlockFrom が弾く）
        const fromBehind = (p.x >= me.x ? 1 : -1) !== me.facing;
        best = { p, def, frames, fromBehind };
      }
    }
    return best;
  }

  /**
   * 頭上から降ってくる脅威。**技ではなく跳んだこと**を見る。
   *
   * 空中スキルは発生 4〜6 フレームなので、技が出てから測ったのでは
   * `_framesUntilHit()` が 4 を返すだけで、逃げるにも潰すにも足りない。
   * 一方、跳んで降りてくるまでは 30〜50 フレームあり、そこは重力に任せた
   * ただの放物線なので**先の位置が読める**。読んだ接触点までの時間を持ち時間にして、
   * 降ってくる前に答えを置いておく。
   *
   * 弾を撃つだけの空中技（魔法使いの流星・女子高生の空中レーザー）はここでは見ない。
   * あれは弾として飛んでくるので `_incomingProjectile()` の担当で、
   * ここで一緒に数えると「跳ばれるたびに下がる」だけの CPU になる。
   *
   * @returns {{frames:number, dist:number, y:number, reach:number,
   *            guardBreak:boolean, low:number} | null}
   */
  _airThreat(me, foe, myVx = 0) {
    if (!foe.airborne || foe.invulnerable || foe.isKO || foe.isVanished) return null;
    const prof = profileOf(foe.def);
    /**
     * 見るのは「出てからでは間に合わない速さの空中技」だけ。
     *
     * 溜めの長い空中技（忍者の竜巻 64F・魔法使いの浮遊照射 62F・
     * 挌闘家の踵落とし 36F）は、出てから見ても十分に手が打てるので
     * `_incomingAttack()` 側の担当。ここに混ぜると「跳ばれたら必ず下がる」
     * だけの CPU になり、詰めどころを丸ごと失う。
     */
    const air = [prof.airAttack, prof.airSkill].filter(
      (p) => p && p.hitbox && !p.projectile && p.startup <= AIR_FAST
    );
    if (air.length === 0) return null;
    const reach = Math.max(...air.map((p) => p.reachOnly));
    /**
     * 前進ぶんまで含めた「最終的にどこまで届くか」。
     *
     * 潜りに行ってよいかはこちらで測る。判定そのものの長さで測ると、
     * キャヴァリアのドリル（判定 208・突進を足すと 518）を
     * 「210 離れていれば外側」と読み違えて、**伸びてくる判定へ自分から
     * 走り込む**ことになる（実測でこれが被弾の最多形だった）。
     */
    const danger = Math.max(...air.map((p) => p.range));
    const low = Math.min(...air.map((p) => p.low));
    const top = Math.max(...air.map((p) => p.top));
    const drop = Math.max(...air.map((p) => p.drop));
    const lunge = Math.max(...air.map((p) => p.lunge));
    const guardBreak = air.some((p) => p.guardBreak);
    /**
     * 踏み切ってから判定が出るまで。まだ技を出していないなら、
     * **少なくともこれだけは落ちてこられない**。
     *
     * ここを 0 として「いつでも真下に落ちてくる」と読むと、天空斬りのように
     * 速く落ちる技に対しては常に「6 フレームで届く＝何をしても間に合わない」と
     * 出てしまい、実際には間に合う下がりまで捨てて壁に貼り付くことになる。
     */
    const lead = foe.state === STATE.MOVE ? 0 : Math.min(...air.map((p) => p.startup));

    /**
     * 「いま踏み切られたら、いつ届くか」を読む。
     *
     * 落ちる速さは重力ではなく**技データ**で決まる。天空斬りは 15／ティックで
     * 降りてきて、重力任せの落下より 5 倍速い。重力で見積もると
     * **一番速い技を一番遅く見積もる**ことになり、余裕があると思ったまま刺される。
     * 横も同じで、降りながら前進する技はその速さで詰めてくる。
     *
     * どちらも「相手がこれから選べる最悪の手」で見る。読み違えたときに
     * 早く下がりすぎるだけで済み、遅れて刺されることにはならない。
     *
     * ただし横は**跳んだ勢いの向きまで裏返さない**。速さの絶対値を取って
     * 必ずこちらへ向けていた頃は、後ろへ跳ばれても「突っ込んで来る」と読んで
     * いた。プレイヤーが跳ぶたびに CPU が下がり出すのはこれが原因で、
     * 相手が離れていく跳びまで降り技として数えていた。
     *
     * 見るべきなのは「技の踏み込みぶんは必ずこちらへ向く」ということだけ。
     * 跳んだ勢いは向いている向きのまま足し、そこに踏み込みを重ねる。
     * 後ろへ跳ばれたときは踏み込みぶん（＝0 なら止まっている扱い）で読むので、
     * 離れる跳びは降り技として数えなくなる。
     */
    const toward = Math.sign(me.x - foe.x) || 1;
    const vx = Math.max(foe.vx * toward, lunge) * toward;
    let x = foe.x;
    let y = foe.y;
    let vy = foe.vy;
    let mx = me.x;
    for (let t = 1; t <= AIR_LOOKAHEAD; t += 1) {
      x += vx;
      // 逃げ切れるかを試すときは、自分も動かしてみる。
      // 壁で止まるところまで入れないと、隅に詰まっているのに
      // 「下がれば外せる」と読んでしまう。
      mx = Math.min(STAGE_WIDTH - STAGE_MARGIN, Math.max(STAGE_MARGIN, mx + myVx));
      if (t <= lead) {
        // まだ技が出せない区間。跳んだ勢いのまま飛んでいる
        y = Math.max(0, y + vy);
        vy -= GRAVITY;
      } else if (drop > 0) {
        y = Math.max(0, y - drop);
      } else {
        y = Math.max(0, y + vy);
        vy -= GRAVITY;
      }
      const gap = Math.abs(x - mx);
      // 判定が自分の体の高さまで降りてきて、間合いにも入ったところが接触点。
      // 頭のてっぺんを掠める高さで数え始めると、跳んだ瞬間から「もう手遅れ」に
      // なってしまうので、胸の高さまで降りてきたところで見る。
      if (gap <= reach && y + low <= AIR_CONTACT_Y && y + top >= 0) {
        return { frames: t, dist: gap, y, reach, danger, guardBreak, low, landIn: airTimeOf(foe) };
      }
      if (y <= 0) break;
    }
    return null;
  }

  /**
   * その向きへ走れば、降り技を空振らせられるか。
   *
   * 「接触するフレームまでに間合いの外へ出られるか」で測ってはいけない。
   * 天空斬りは真上から 6 フレームで届くので、その測り方だとどんな距離でも
   * 「間に合わない」と出て、CPU は歩いて下がるだけになり結局刺される。
   * 実際に見るべきは**相手が降り切るまで捕まらずにいられるか**なので、
   * 自分が走っている前提でもう一度軌道を引き直して確かめる。
   *
   * 前へ走る場合もこれで測れる。相手が高いうちに下をくぐれば、判定が降りて
   * くる頃には背後にいて当たらない ＝ 軌道を引き直せば接触点が消える。
   * 壁での頭打ちも `_airThreat()` の中で見ているので、隅で「下がれば外せる」と
   * 読み違えることもない。
   *
   * 返すのは「外せる／外せない」ではなく**捕まるまでの時間**にしてある。
   * 軌道は「相手がいま最悪の手を選んだら」で引いているので、外せないと出ても
   * 実際には間に合うことが多い。二択で切ると、間に合う下がりまで
   * 「どうせ無理」と捨てて壁に貼り付くことになる。稼げる時間で比べれば、
   * 完全に外せなくても**いちばん長く逃げられる向き**を選べる。
   *
   * @param {1|-1} dir 走る向き（ワールド座標。+1 が右）
   * @returns {number} その向きへ走ったときに捕まるまでのフレーム数。
   *                   捕まらないなら Infinity。
   */
  _diveEscape(me, foe, dir) {
    const hit = this._airThreat(me, foe, dir * me.def.dashSpeed);
    return hit ? hit.frames : Infinity;
  }

  /**
   * いま押せば繋がる連携（コンボ）があるか。
   *
   * 技の最中は**どのみち動けない**ので、ここで押すかどうかは守りの判断と
   * competing しない。純粋に「もう一段入れて得か」だけの話になる。
   *
   * 技が当たったかどうかを sim は覚えていないので、繋いでよい形かは
   * 相手の様子で見る。のけぞり・ガード硬直に入っているなら当たっている ＝
   * 次も入る。そうでなくても、繋ぎ先の判定が届く距離にいるなら振る価値がある。
   * 遠くで空振っている最中に繋ぐのは、硬直を伸ばして差し返されるだけなので出さない。
   *
   * 判定を持たない連携先（キャヴァリアの後退ブースト）はここでは拾わない。
   * あれは `_maskHitlessChains()` が落とす担当で、押して得な手ではない。
   *
   * 繋ぎ先が複数開いているなら**全部返す**。1 つ目で打ち切っていた頃は、
   * 技の定義に書いてある順（たいてい攻撃が先）でいつも同じ側へ流れていて、
   * スキル側の繋ぎ（格闘娘の踵落とし・飛び蹴り）が一度も出なかった。
   *
   * @returns {{bits:number, move:string}[]}
   */
  _chainOptions(me, foe, dist) {
    if (me.state !== STATE.MOVE) return [];
    const move = me.currentMove();
    if (!move) return [];
    // 空中の連携回数を使い切っていると、窓が開いていても受け付けられない
    const airLimit = me.def.airChainLimit;
    if (me.airborne && airLimit != null && me.airChains >= airLimit) return [];

    const confirmed =
      foe.state === STATE.HIT || foe.state === STATE.BLOCK || foe.state === STATE.GUARD_BREAK;
    const out = [];
    for (const c of move.chains) {
      if (me.moveFrame < c.from || me.moveFrame > c.to) continue;
      const pay = chainPayload(me.def, c.move);
      if (!pay.hits) continue;
      if (!confirmed) {
        // 当たった手応えが無いなら、せめて届く位置にいること
        if (dist > pay.reach + HURT_HALF) continue;
      }
      out.push({ bits: c.button === 'skill' ? BTN.SKILL : BTN.ATTACK, move: c.move });
    }
    /**
     * 選ぶ順は「まだ通っていない先」→「攻撃側」。
     *
     * 連携はたいてい、攻撃ボタンで段を伸ばして、スキルで締める形に
     * なっている。毎回どちらかを等確率で選ぶと**半分は 1 段目で締めて**
     * しまい、格闘娘の 4 段目は 900 試合で 1 回しか出なかった。
     * 伸ばせるうちは伸ばして、行き止まり（通った先しか残っていない）に
     * なったら締めへ回す方が、素直に減る。
     */
    const fresh = out.filter((o) => !this.chainSeen.includes(o.move));
    const pool = fresh.length > 0 ? fresh : out;
    const push = pool.filter((o) => o.bits === BTN.ATTACK);
    return push.length > 0 ? push : pool;
  }

  /**
   * 判定は持たないが、**降りるために押す**連携。
   *
   * キャヴァリアの錐揉み突進は高度を保ったまま横へ抜けるので、放っておくと
   * 相手の向こう側で落下と着地硬直（20）を晒す。宙返り降下へ繋ぐと自分から
   * 斜め前へ降りられて、着地硬直も 14 で済む。判定が無いので攻めの手では
   * なく、**空振ったあとの帰り道**として押す手。
   *
   * 自分の判定がまだ残っているうちに切り上げるのは損なので、出し切ってから。
   *
   * @returns {{bits:number, move:string} | null}
   */
  _recoverChain(me) {
    if (!me.airborne || me.state !== STATE.MOVE) return null;
    const move = me.currentMove();
    if (!move) return null;
    let last = -1;
    for (const h of move.hits) last = Math.max(last, h.end);
    if (me.moveFrame <= last) return null;
    for (const c of move.chains) {
      if (me.moveFrame < c.from || me.moveFrame > c.to) continue;
      const next = me.def.moves[c.move];
      if (!next || chainPayload(me.def, c.move).hits) continue;
      if ((next.landLag ?? 0) < (move.landLag ?? 0)) {
        return { bits: c.button === 'skill' ? BTN.SKILL : BTN.ATTACK, move: c.move };
      }
    }
    return null;
  }

  /**
   * 置き技。相手が来るところへ、先に判定を出しておくための読み。
   *
   * 振る手を「届いてから」選んでいると、発生ぶんだけ必ず遅れる。降ってくる
   * 相手に対して対空が振れたのは読んだ 3416 回のうち 11.9% だけで、
   * いちばん多い不成立の理由（44.6%）が**気づいた時点でもう発生が
   * 間に合わない**だった。逆に言えば、遅れているのは判断ではなく振り始めで、
   * 相手が来る前に振っておけば同じ技がそのまま間に合う。
   *
   * 読むのは相手の**実際の軌道**。降り技の読み（`_airThreat`）が
   * 「相手が選べる最悪の手」で見るのと違って、こちらは当てに行く側なので
   * 外れても空振りで済む。最悪を仮定すると置ける場面がほとんど無くなる。
   *
   * @returns {number} 判定の中へ入ってくるまでのティック。届かないなら -1
   */
  _placeWindow(me, foe, atk) {
    if (atk.harmless || atk.range <= 0) return -1;
    let x = foe.x;
    let y = foe.y;
    let vy = foe.vy;
    for (let t = 1; t <= PLACE_LOOKAHEAD; t += 1) {
      x = Math.min(STAGE_WIDTH - STAGE_MARGIN, Math.max(STAGE_MARGIN, x + foe.vx));
      if (y > 0 || vy > 0) {
        y = Math.max(0, y + vy);
        vy -= GRAVITY;
      }
      // 判定とやられ判定が、横にも縦にも重なったところが当たるところ
      const gap = Math.abs(x - me.x);
      if (gap <= atk.range && y <= atk.top && y + HURTBOX.h >= atk.low) return t;
    }
    return -1;
  }

  /**
   * 背中側に残っている距離。壁までどれだけ下がれるか。
   *
   * 下がる手の値打ちはここで決まる。間合いだけを見ていると、壁を背負ってからも
   * 「離れれば安全」と読み続けてしまうが、**壁際の下がりは距離を買わない**。
   * 買えるのは壁までの残りぶんだけで、使い切ったあとは同じ間合いのまま
   * 選べる手だけが減っている。
   *
   * @param {number} foeX 相手の位置（煙玉で消えている間は最後に見た位置）
   */
  _backRoom(me, foeX) {
    return foeX >= me.x ? me.x - STAGE_MARGIN : STAGE_WIDTH - STAGE_MARGIN - me.x;
  }

  /** いちばん近い相手の弾との距離。2段ジャンプの 2段目の合図に使う。 */
  _nearestShotDist(sim, me) {
    let best = Infinity;
    const hurt = me.hurtBox();
    const cy = hurt.y + hurt.h * 0.5;
    for (const p of sim.projectiles) {
      if (p.owner === this.index) continue;
      const dx = me.x - p.x;
      const dy = cy - p.y;
      best = Math.min(best, Math.sqrt(dx * dx + dy * dy));
    }
    return best;
  }

  /** 相手がガードを固めているか（崩しに行く価値がある状態か）。 */
  _turtling(opponent) {
    return opponent.guardHeld && (opponent.state === STATE.GUARD || opponent.state === STATE.BLOCK);
  }

  /**
   * 跳べば頭の上を通せる攻撃か。しゃがみの逆で、判定が低いところに
   * 収まっているならジャンプで越えられる。ガード一択にしないための逃げ道。
   *
   * 掴みだけは判定の高さに関係なく、浮いてさえいれば当たらない。
   * 箱の高さで測るとサキュバスの吸血は「跳べない」と出てしまうので、先に分ける。
   */
  _isJumpable(opponent) {
    const hits = this._upcomingHits(opponent);
    if (hits.length === 0) return false;
    if (hits.every((h) => h.grab)) return true;
    const lift = opponent.y;
    return hits.every((h) => h.box.y + h.box.h + lift < JUMP_CLEAR_Y);
  }

  /**
   * これから来るのが掴みか。
   *
   * ガードは一切通らないので、この判断を持っていないと CPU は
   * 「一番確実な答え」としてガードを固め、そのまま毎回捕まる。
   * 判定が混在する技は普通の打撃として扱う（ガードする価値が残るため）。
   */
  _incomingGrab(opponent) {
    if (opponent.state !== STATE.MOVE) return false;
    const hits = this._upcomingHits(opponent);
    return hits.length > 0 && hits.every((h) => h.grab);
  }

  /**
   * これから来るのがガードを崩す技（＝スキル）か。
   *
   * このゲームのスキルは例外なく `guardBreak` を持つ。ガードは止められないうえ、
   * 割られたぶん硬直が伸びる（GUARD_BREAK_EXTRA）ので、**固めるのは
   * 何もしないより悪い**。
   *
   * これを見ていないと、CPU は「一番確実な手」としてガードを選び続ける。
   * スキルを連打されたときに一番効くのがこの判断で、実測では
   * ガードしたまま死んだ 184 回がここから出ていた。
   */
  _incomingBreak(opponent) {
    if (opponent.state !== STATE.MOVE) return false;
    return this._upcomingHits(opponent).some((h) => h.guardBreak === true);
  }

  /**
   * これから来る攻撃が出切るまでの残りフレーム。
   *
   * 守りを何ティック維持するかはこれで決める。固定値で持つと、
   * 溜めの長い技（照射は溜め 60 ＋ 照射 34）で途中から無防備になる。
   */
  _threatFrames(opponent) {
    let move = opponent.currentMove();
    if (!move) return 0;
    let offset = -opponent.moveFrame;
    let last = 0;
    for (let guard = 0; move && guard < 4; guard += 1) {
      for (const h of move.hits) last = Math.max(last, offset + h.end);
      offset += move.total;
      move = move.onEnd ? opponent.def.moves[move.onEnd] : null;
    }
    return Math.max(0, last);
  }

  /** 相手の判定が出るまでの残りフレーム。もう出ているなら 0。 */
  _framesUntilHit(opponent) {
    const move = opponent.currentMove();
    if (!move) return Infinity;
    let scan = move;
    let offset = -opponent.moveFrame;
    for (let guard = 0; scan && guard < 4; guard += 1) {
      for (const h of scan.hits) {
        const at = offset + h.start;
        if (at >= 0) return at;
      }
      offset += scan.total;
      scan = scan.onEnd ? opponent.def.moves[scan.onEnd] : null;
    }
    return 0;
  }

  /**
   * 決めた行動を途中で打ち切って考え直すべきか。
   *
   * すでに守りの手（ガード・ジャンプ）を選んでいるなら、そのまま続ける。
   * まだ何も守っていないのに危険が目前なら、考え直す方がよい。
   */
  _mustRethink(sim, me, foe) {
    // ガードでは止まらない技（掴み・スキル）だけは、
    // 「守りの手を選んであるから大丈夫」が成立しない。固めたまま維持すると
    // 毎回そのまま捕まる／割られる。
    // 逃げ道を選べているなら答えは合っているので、そのまま続けさせる。
    if (this._incomingGrab(foe) || this._incomingBreak(foe)) {
      const escaping =
        (this.plan.bits & BTN.UP) !== 0 ||
        ((this.plan.bits & BTN.DOWN) !== 0 && this._isDuckable(foe));
      const until = this._framesUntilHit(foe);
      if (
        !escaping &&
        until >= RETREAT_ESCAPE_FRAMES &&
        Math.abs(foe.x - me.x) <= this._threatRange(foe) + 40
      ) {
        return true;
      }
    }

    /**
     * 降ってくる相手。空中スキルは発生 4〜6 フレームなので、
     * 「判定が見えてから」では前の判断を引きずったまま刺される。
     * 跳ばれた時点で考え直させる。
     *
     * 逆に、**すでに降り技への答えを出してあるなら振り直さない**。
     * ここを毎ティック考え直すと、下がりかけては止まるを繰り返して
     * 結局その場から動けない（下がり切るには走り続ける必要がある）。
     */
    const air = this._airThreat(me, foe);
    /**
     * 降り切ったなら、下がるのをそこでやめる。
     *
     * 降り技の着地硬直は長い（天空斬り 24 ティック）。避けた見返りはそこなので、
     * 持ち時間が切れるまで下がり続けると、**毎回いちばんおいしい隙を見送って
     * 位置だけ失う**。それを繰り返した先が壁で、実測では被弾 312 回のうち
     * 199 回が「下がり切って背中が壁」だった。避けたら押し返す。
     */
    if (!air && this.answeringAir) return true;
    if (air) {
      if (!this.answeringAir) return true;
      // ガードで受けるつもりだったのに、崩す技を出されたときだけは選び直す
      if ((this.plan.bits & BTN.GUARD) !== 0 && this._incomingBreak(foe)) return true;
      return false;
    }

    const shot = this._incomingProjectile(sim, me);

    // 構えを解くのも判断のうち。危険が過ぎているのにガード／しゃがみを
    // 抱えたままだと、**相手の戻りをまるごと見送る**ことになる。
    // スキルは外したときの隙が大きいぶん、ここを拾えるかで差し返しの回数が変わる。
    if ((this.plan.bits & (BTN.GUARD | BTN.DOWN)) !== 0) {
      const watching = shot && shot.frames <= PROJECTILE_REACT;
      if (!this._incomingAttack(foe) && !watching) return true;
    }

    const defending = (this.plan.bits & (BTN.GUARD | BTN.UP | BTN.DOWN)) !== 0;
    if (defending) return false;
    if (shot && shot.frames <= RETHINK_FRAMES) return true;
    if (this._incomingAttack(foe) && this._framesUntilHit(foe) <= RETHINK_FRAMES) {
      return Math.abs(foe.x - me.x) <= this._threatRange(foe) + 40;
    }
    return false;
  }

  /**
   * 候補の中から 1 つ選ぶ。重みは「その状況でどれだけ有効か」。
   *
   * 一番良い手を毎回選ぶと、人間は数ラウンドで読んで対策してくる。
   * 有効な手が複数あるなら混ぜる。あわせて直前と同じ手は重みを落として、
   * 同じ状況で同じ答えを繰り返さないようにしている。
   *
   * `impatient` は「手が出ていない時間を重みに乗せてよい場面か」。
   * **飛んできている技への答えには乗せない**。焦れは間合い争いの話で、
   * 来ている技に対して焦れて踏み込むのは、避けられる技へ自分から
   * 当たりに行くのと同じ。実際、照射の溜めに乗せた版は、しゃがんで
   * くぐれる場面から踏み込みへ乗り換えて 399 ティック目に沈んだ。
   */
  _choose(rng, options, impatient = false) {
    let total = 0;
    for (const o of options) {
      // `forced` は「これしか正解が無い」手。混ぜる対象から外す。
      //
      // ここを外さないと、**同じ技を連打されたときに 2 回目から重みが 1/4 になる**。
      // 照射を 1 回しゃがんで避けると、次の照射では正解のしゃがみが軽くなって
      // ガードを選び直し、そのまま割られる。読まれないための仕組みが、
      // 答えがひとつしかない場面では自滅の仕組みになっていた。
      if (o.forced) {
        o.w = Math.max(0, o.weight);
        total += o.w;
        continue;
      }
      const patience = impatient ? this.patienceBias(o.act) : 0;
      o.w = Math.max(0, o.weight) * (1 + this.moodBias(o.act) + patience);
      if (o.act === this.lastAct) o.w *= this.repeat >= 2 ? 0.25 : 0.55;
      total += o.w;
    }
    if (total <= 0) return this._commit({ act: 'wait', bits: 0, ticks: this.cfg.react });
    let roll = rng.next() * total;
    for (const o of options) {
      roll -= o.w;
      if (roll <= 0) return this._commit(o);
    }
    return this._commit(options[options.length - 1]);
  }

  /** 気分による重みの偏り。攻めっ気・守りっ気を数秒単位で揺らす。 */
  moodBias(act) {
    if (this.mood === 'push') return isPush(act) ? 0.45 : isHold(act) ? -0.3 : 0;
    if (this.mood === 'hold') return isHold(act) ? 0.45 : isPush(act) ? -0.3 : 0;
    return 0;
  }

  /**
   * 手が出ていない時間ぶんの、攻めへの寄せ。
   *
   * **攻め手を重くするだけで、守り手を軽くはしない**。守りを削ると、
   * 降り技やガード不能技のように「これしか助からない」手まで薄くなって、
   * 攻めるようになった代わりに割られる CPU になる。攻め手を積み増して
   * 相対的に選ばれやすくするだけなら、助かる手は助かる手のまま残る。
   */
  patienceBias(act) {
    /**
     * 焦れたぶんは**足で運ぶ**。跳び込みには乗せない。
     *
     * 跳ぶ手はもともと「跳んでよい状況か」を先に見て重みを削ってある
     * （弾を持つ相手には 0.12 倍など）。そこへ我慢切れを掛けると、
     * わざわざ削った意味が消えて、待たされた末に一番刺されやすい手へ
     * 飛び出すことになる。実際、乗せた版は魔法使い相手に空中で撃たれる形が
     * 増えて、弾を受けに回れなくなっていた。
     */
    if (act === 'jumpIn' || !isPush(act) || this.idle <= PATIENCE) return 0;
    return Math.min(PATIENCE_MAX, (this.idle - PATIENCE) / PATIENCE);
  }

  /**
   * いま押すと「判定の無い連携」に化けるボタンを落とす。
   *
   * 連携先が必ず攻撃とは限らない。キャヴァリアの切り抜けは、押し直すと
   * 斬らずに後ろへ跳び退く技（後退ブースト）へ繋がる。CPU は連携を読まないので、
   * 技の最中にもう一度攻撃を選ぶと、そのつもりが無いまま間合いを捨てることになる
   * （実測で、振った 36 回のうち 15 回が離脱に化けて勝率が 15 ポイント落ちた）。
   *
   * 判定を持つ連携（剣士の 2 段斬りなど）はそのまま通す。あちらは押して得なので、
   * 偶然でも繋がってくれた方がいい。
   */
  _maskHitlessChains(me, bits) {
    if (me.state !== STATE.MOVE) return bits;
    const move = me.currentMove();
    if (!move || move.chains.length === 0) return bits;
    let out = bits;
    for (const c of move.chains) {
      if (me.moveFrame < c.from || me.moveFrame > c.to) continue;
      if (chainPayload(me.def, c.move).hits) continue;
      // 自分で選んで押している降り（`_recoverChain`）だけは落とさない。
      // ここで一緒に落とすと、狙って押した帰り道まで消える
      if (c.move === this.intentChain) continue;
      if (c.button === 'attack') out &= ~BTN.ATTACK;
      else if (c.button === 'skill') out &= ~BTN.SKILL;
    }
    return out;
  }

  _commit(option) {
    // 手を出したら我慢の数えをやり直す。振っただけで数え直すので、
    // 当たったかどうかは見ない（当たるまで積むと、ガードされ続けたときに
    // 際限なく突っ込む CPU になる）。
    if (option.act === 'attack' || option.act === 'skill') this.idle = 0;
    if (option.act === this.lastAct) this.repeat += 1;
    else {
      this.lastAct = option.act;
      this.repeat = 1;
    }
    // いま走らせている判断が「降り技への答え」かどうかを覚えておく。
    // 出した答えを毎ティック考え直させないための印（_mustRethink が見る）。
    this.answeringAir = option.air === true;
    if (this.answeringAir) this.airAct = option.act;
    // 決めた行動を維持する時間は難易度で伸縮させる。
    // 弱い設定ほど長く引きずり、状況の変化に置いていかれる。
    const base = option.ticks ?? this.cfg.react;
    this.plan = { bits: option.bits, ticks: Math.max(2, Math.round(base * this.cfg.hold)) };
    if (option.cooldown) this.cooldown = option.cooldown;
    if (option.skillCooldown) this.skillCd = option.skillCooldown;
    return option.bits;
  }

  /**
   * そのティックの入力を返す。
   *
   * 状況ごとに「有効な手」を重み付きで並べ、そこから選ぶ。
   * 最善手を毎回選ぶのが一番勝ちやすいが、それだと数ラウンドで読まれて
   * 対策される。読まれないことも強さの一部なので、有効な手が複数あるなら混ぜる。
   *
   * @param {import('./sim.js').Simulation} sim
   */
  think(sim) {
    // 決めた入力は最後にここで濾す。連携先が判定を持たない技のときだけ
    // ボタンを落とすので、選択そのものには手を入れなくて済む。
    const bits = this._maskHitlessChains(sim.fighters[this.index], this._plan(sim));
    this.lastBits = bits;
    return bits;
  }

  /** そのティックに出したい入力を決める（濾す前の生の判断）。 */
  _plan(sim) {
    const me = sim.fighters[this.index];
    const foe = sim.fighters[1 - this.index];
    if (!sim.isRunning || me.isKO) return 0;

    if (this.cooldown > 0) this.cooldown -= 1;
    if (this.skillCd > 0) this.skillCd -= 1;
    this.idle += 1;

    // 気分を数秒ごとに入れ替える
    if (this.moodTicks > 0) this.moodTicks -= 1;
    else {
      const roll = sim.rng.next();
      this.mood = roll < 0.34 ? 'push' : roll < 0.68 ? 'hold' : 'even';
      this.moodTicks = sim.rng.int(MOOD_MIN, MOOD_MAX);
    }

    /**
     * 連携が繋がる場面なら、持ち時間を待たずにここで拾う。
     *
     * **持ち時間の判定より先に見る。** 後ろに置いていた頃は、技を振った
     * ときの持ち時間（5 ティック前後）が切れるまでここへ来られず、
     * そのあいだに繋ぎの窓が閉じていた。連携はフレーム単位の話なので、
     * 「あとで考え直す」では間に合わない。
     *
     * 技の最中はどのみち動けないので、守りの手と取り合いにもならない。
     */
    // 技を出していないなら連携は途切れている。通った先の記録を捨てる
    if (me.state !== STATE.MOVE) this.chainSeen = [];
    /**
     * ただし**ガードされている連携は伸ばさない**。
     *
     * 繋ぐほど相手は固めたまま安全で、こちらの硬直だけが伸びていく。
     * 崩す手（掴み・ガード崩しのスキル）を持っているなら、そちらへ切り替えた
     * 方が減る。ここを見ていなかったせいで、サキュバスが固める相手に
     * 掴みへ行かず、当たらない連携を延々と重ねていた（12 試行中 9 → 6 に低下）。
     */
    const myProf = profileOf(me.def);
    const breaker =
      !myProf.skill.harmless && (myProf.skill.grab || myProf.skill.guardBreak);
    const stringBlocked = breaker && this.skillCd === 0 && this._turtling(foe);
    const chains = stringBlocked ? [] : this._chainOptions(me, foe, Math.abs(foe.x - me.x));
    if (chains.length > 0) {
      // int は上限を含まないので、そのまま長さを渡す
      const pick = chains[sim.rng.int(0, chains.length)];
      /**
       * 押しっぱなしでは繋がらない。ボタンは**押した瞬間**だけが入力として
       * 拾われるので、すでに握っているならまず離す。
       *
       * ここを見落としていた頃は、スキルから繋ぐ連携（格闘娘の踵落とし・
       * 飛び蹴り、キャヴァリアの急降下ブースト）が**一度も出せなかった**。
       * スキルを振った手がそのままボタンを握り続けていて、繋ぎ先に要る
       * 押し直しが起きないため。
       */
      if ((this.lastBits & pick.bits) !== 0) {
        return this._commit({ act: 'chain', bits: this.lastBits & ~pick.bits, ticks: 1 });
      }
      if (me.moveId && !this.chainSeen.includes(me.moveId)) this.chainSeen.push(me.moveId);
      this.chainSeen.push(pick.move);
      return this._commit({ act: 'chain', bits: pick.bits, ticks: 3 });
    }

    // 攻めの繋ぎが無いなら、降りるための繋ぎを見る
    const recover = this._recoverChain(me);
    this.intentChain = recover ? recover.move : null;
    if (recover) {
      if ((this.lastBits & recover.bits) !== 0) {
        return this._commit({ act: 'chain', bits: this.lastBits & ~recover.bits, ticks: 1 });
      }
      return this._commit({ act: 'chain', bits: recover.bits, ticks: 3 });
    }

    // 決めた行動は数ティック維持する。毎フレーム考え直すと
    // 入力が細切れになってダッシュもガードも成立しないため。
    // ただし危険が目前に迫ったら打ち切って考え直す。ここが無いと、
    // 走って詰めている最中に弾が届いて、そのまま当たるだけになる。
    if (this.plan.ticks > 0 && !this._mustRethink(sim, me, foe)) {
      this.plan.ticks -= 1;
      return this.plan.bits;
    }

    const rng = sim.rng;
    const cfg = this.cfg;

    /**
     * 相手が煙玉で消えているか。消えている間は見えていないものとして扱い、
     * **最後に見た位置**を相手だと思って動く。
     *
     * 消えている相手は攻撃を出せないので、技への反応（_incomingAttack 系）は
     * もともと空振りになる。効くのは位置と、隙を見て差し込む判断の 2 つで、
     * どちらも「見えていないと分からない」もの。
     */
    const blind = foe.isVanished;
    if (!blind) this.seenX = foe.x;
    const foeX = blind ? this.seenX ?? foe.x : foe.x;

    const dist = Math.abs(foeX - me.x);
    const toFoe = foeX >= me.x ? BTN.RIGHT : BTN.LEFT;
    const away = foeX >= me.x ? BTN.LEFT : BTN.RIGHT;

    /**
     * 壁までの余地。攻守どちらの向きにも効く。
     *
     * - 自分の背中が近い ＝ 下がる手が距離を買えない。値打ちを落とす
     * - 相手の背中が近い ＝ 相手は下がって仕切り直せない。攻めが通る
     *
     * 位置は見えている前提で測る。煙玉で消えている相手には最後に見た位置を
     * 使うので、詰めたつもりが外れていることはあるが、それは間合いの読みと同じ
     * 度合いの外れ方でしかない。
     */
    const room = this._backRoom(me, foeX);
    const foeRoom = this._backRoom(foe, me.x);
    const cornered = room < CORNER_ROOM;
    const foeCornered = foeRoom < CORNER_ROOM;
    /**
     * 下がる手の値打ち。壁が近いほど落とす。
     *
     * 消し切らないのは、壁際でも「あと一歩で先端を空振らせる」が成立するから
     * （CORNER_FLOOR）。落とすのは「仕切り直しのために下がる」種類の手で、
     * 来ている技を外すための下がりは別の重みで積んである。
     */
    const backW = (w) => w * Math.max(CORNER_FLOOR, Math.min(1, room / CORNER_ROOM));
    /** 相手を詰めているときの攻めの割り増し。 */
    const press = foeCornered ? CORNER_PRESS : 1;

    /**
     * 跳んでよい状況かを一度だけ決める。空中はガードできないので、
     * 跳ぶかどうかは弾の有無で意味が大きく変わる。
     *
     * - 相手の弾が場に出ているなら跳ばない。追尾するので跳んだ先で届く
     * - **飛び道具を持つ相手が自由に動けるなら跳ばない。** 跳んでいる時間
     *   （自分の身長ぶんの滞空 ≒ 50 フレーム超）は、弾の発生 11 フレームに対して
     *   ただの的でしかない。実測では、跳んで弾を食らった 36 回のうち 35 回が
     *   「跳んだ時点では弾が無かった」＝空中で撃たれたケースだった
     *
     * 飛び道具持ちに近づく手段は、跳ぶことではなく走って詰めることになる。
     */
    const foeShotAlive = sim.projectiles.some((p) => p.owner !== this.index);
    const foeRanged = profileOf(foe.def).attack.projectile;
    /**
     * 頭上から降ってくる脅威。跳ばれた時点で読んでおく（`_airThreat()` 参照）。
     * 空中スキルは発生 4〜6 フレームなので、判定が見えてからでは何も選べない。
     */
    const air = this._airThreat(me, foe);
    /** 相手が「見てから対応できない降り技」を持っているか。 */
    const foeDiver = hasFastDive(foe.def);
    const jumpW = (w, openFor = 0) => {
      if (foeShotAlive) return 0;
      /**
       * 降り技を持つ相手には跳ばない。
       *
       * 浮いている間はガードもダッシュも出せず、そのうえ着地硬直が付いてくる。
       * 相手の降り技は 4〜6 フレームで出るので、**こちらの着地に合わせて
       * 落としてくるだけで終わる**。総当たりでも「跳んで下がる」は
       * 降り技を持つ 4 キャラすべてに対して 0/15 で、ひとつも助からなかった。
       *
       * 「相手が硬直しているうちに跳べばいい」も通らない――**明ける時間を
       * 数えないなら**。硬直はこちらが浮いている間に明けて、明けた相手は
       * そのまま跳び返してくる。ただし着地まで明けないと分かっているなら
       * 話は別で、そのときは降り技も対空も返ってこない。
       * 数えずに一律で禁じていたせいで、大技を空振りした相手にすら
       * 跳び込まなくなっていた。
       */
      if ((air || foeDiver) && openFor < JUMP_IN_SAFE) return 0;
      if (foeRanged && foe.isFree) return w * 0.12;
      return w;
    };

    const prof = profileOf(me.def);
    const hitRange = prof.attack.range;
    const skillRange = prof.skill.range;
    /**
     * いまスキルを振ってよいか。
     *
     * 掴みは相手が空中にいると絶対に当たらないので、跳ばれている間に振るのは
     * 「外して長い硬直を晒す」だけになる。逆にガードは無視して通るので、
     * 固めている相手には打撃系の崩しより価値が高い。
     *
     * 判定を持たないスキル（忍者の煙玉）は、そもそも振っても何も起きない。
     *
     * 結界を張っている相手（巫女）に振るのはもっと悪い。**スキルだけ**が
     * 無効化されて欠片が返ってくるので、振った時点で負ける。
     * 結界は打撃には何もしないので、崩しは普通の攻撃に任せる。
     */
    const skillUsable =
      !prof.skill.harmless && !(prof.skill.grab && foe.airborne) && !foe.isWarding;
    /**
     * 置き技が成立するか。相手が判定の中へ入ってくるのが、ちょうど自分の
     * 発生ぶん先のとき ＝ いま振り始めれば、来たところに判定が出ている。
     *
     * **跳んでいる相手にだけ置く。** 置きは相手の軌道を当てにする手なので、
     * 途中で進路を変えられると空振りして、こちらが硬直を晒すだけになる。
     * 地上の相手にも置いていた版は、固定の相手 1500 試合で収支 699.5 → 684.5 と
     * 落ちた。跳んだあとは重力に従うしかなく軌道が確定しているので、
     * そこだけは読み切れる（同じ試行で 703.3）。
     */
    const placeIn = this._placeWindow(me, foe, prof.attack);
    const canPlace =
      foe.airborne &&
      this.cooldown === 0 &&
      !foe.invulnerable &&
      placeIn >= prof.attack.startup &&
      placeIn <= prof.attack.startup + PLACE_WINDOW;

    // 遠距離キャラは離れて弾を撒くのが仕事
    const ranged = prof.attack.projectile;
    const idealRange = ranged ? 430 : hitRange * 0.85;

    // ── 空中 ──────────────────────────────────────────────
    // 空中では空中技と2段ジャンプしか選べないので、先に分けて考える。
    if (me.airborne && me.state === STATE.JUMP) {
      const opts = [];
      const falling = me.vy < 0;
      /**
       * 相手も降り技を構えているなら、空中で振り合っても勝ち目が薄い。
       * こちらの空中技は発生 7〜8F、相手の降り技は 4〜6F で、しかも
       * 向こうはガードを崩す。**着地際を狙われる前に軌道を外す**方を選ぶ。
       */
      if (air) {
        if (me.airJumps > 0) {
          opts.push({ act: 'retreat', bits: BTN.UP | away, ticks: 8, weight: cfg.guard * 8, air: true });
        }
        opts.push({ act: 'retreat', bits: away, ticks: 8, weight: cfg.spacing * 5, air: true });
      }
      if (!air && dist < 240 && falling && !foe.invulnerable) {
        // 降り際に振ると地上の相手に当たりやすい
        opts.push({ act: 'attack', bits: BTN.ATTACK, ticks: 5, weight: cfg.aggression * 3 });
        opts.push({ act: 'skill', bits: BTN.SKILL, ticks: 5, weight: cfg.aggression });
      }
      if (me.airJumps > 0) {
        // 2段ジャンプ回避の 2段目。弾が間近まで来たところで前へ跳び直すと、
        // 曲がりきれない弾を置いていける（探索では 7 割成功）。
        // 前へ跳ぶので、避けながら間合いも詰まる。
        if (this._nearestShotDist(sim, me) <= DODGE_AIR_DIST) {
          opts.push({ act: 'dodge', bits: BTN.UP | toFoe, ticks: 5, weight: cfg.guard * 9 });
          opts.push({ act: 'retreat', bits: BTN.UP | away, ticks: 5, weight: cfg.guard * 1.5 });
        } else {
          // 一発が致命傷なので、危ないときは跳び直して軌道をずらす
          const danger = this._incomingAttack(foe) ? 3 : 0.6;
          opts.push({ act: 'jumpIn', bits: BTN.UP | toFoe, ticks: 5, weight: cfg.guard * danger });
          opts.push({ act: 'retreat', bits: BTN.UP | away, ticks: 5, weight: cfg.guard * danger * 0.6 });
        }
      }
      opts.push({ act: 'rush', bits: toFoe, ticks: 5, weight: dist > 200 ? 2 : 0.5 });
      opts.push({ act: 'wait', bits: 0, ticks: 5, weight: 0.6 });
      return this._choose(rng, opts);
    }

    // ── 弾が飛んできている ────────────────────────────────
    // 弾は撃った本人と切り離して飛ぶので、技のモーションを見ているだけでは
    // 気づけない。相手の技より先に見るのは、弾のほうが先に届くから。
    const shot = this._incomingProjectile(sim, me);
    if (shot && shot.frames <= PROJECTILE_REACT) {
      const opts = [];
      // 間近か。ガードは 1 フレームで出るので、受けるならここまで待てる
      const near = shot.frames <= PROJECTILE_WATCH;
      /**
       * ガードごと持っていく弾か（女子高生の彼氏・巫女の結界の欠片）。
       *
       * 「弾は guardBreak を持たない」は成り立たない。受けに回った時点で負ける弾が
       * あるので、ここを見ないとスキルを連打されるだけで詰む
       * （実測では、彼氏を呼ばれ続けた CPU の死因 209 回中 184 回がガード中だった）。
       *
       * 技のときと同じく、気づけるかどうかは難易度で変える。
       */
      const unblockable =
        (shot.def.guardBreak === true || shot.def.grab === true) && rng.next() < cfg.read;

      if (near && !unblockable) {
        // 普通の弾に対するいちばん確実な答えはガード。
        // しゃがみは効かない（弾はしゃがんだぶん狙いを下げ直してくる）。
        if (!shot.fromBehind) {
          opts.push({ act: 'guard', bits: BTN.GUARD, ticks: 14, weight: cfg.guard * 8 });
        } else {
          // 背中側へ回り込まれた弾は受けられないので、跳んで軌道をずらす
          opts.push({ act: 'dodge', bits: BTN.UP, ticks: 6, weight: cfg.guard * 4 });
          opts.push({ act: 'retreat', bits: away | BTN.DASH, ticks: 10, weight: cfg.guard * 2 });
        }
      }

      if (unblockable) {
        /**
         * 結界は弾もろとも弾く。彼氏も結界の欠片も、止めているのは
         * guardBreak / grab という同じ印なので、技のときと同じ手が通る。
         */
        if (Number.isFinite(prof.skill.wardFrame) && shot.frames >= prof.skill.wardFrame) {
          opts.push({
            act: 'skill',
            bits: BTN.SKILL,
            ticks: 8,
            weight: cfg.guard * 16,
            skillCooldown: 40,
            forced: true,
          });
        }
        // ガードが効かない以上、答えは「越える」か「くぐる」しかない。
        // どちらも弾の判定の高さで決まるので、まずそれを出す。
        const box = shot.def.box;
        const bottom = box ? shot.p.y + (box.y ?? -box.h / 2) : shot.p.y - shot.def.radius;
        const top = box ? bottom + box.h : shot.p.y + shot.def.radius;
        const apexFrames = me.def.jumpVy / GRAVITY;
        const apexHeight = (me.def.jumpVy * me.def.jumpVy) / (2 * GRAVITY);
        const canHop = top + HOP_CLEARANCE <= apexHeight;
        const canDuck = bottom >= CROUCH_CLEAR_Y;

        if (canHop && Math.abs(shot.frames - apexFrames) <= HOP_WINDOW) {
          // 頂点が弾の位置に重なる踏み切りどき。ここだけで跳ぶ
          opts.push({
            act: 'dodge',
            bits: BTN.UP,
            ticks: 8,
            weight: cfg.guard * 12,
            forced: true,
          });
        } else if (canDuck) {
          opts.push({
            act: 'duck',
            bits: BTN.DOWN,
            ticks: 16,
            weight: cfg.guard * 12,
            forced: true,
          });
        } else if (canHop && shot.frames > apexFrames) {
          // まだ遠い。踏み切りどきまでは足を止めない
          opts.push({ act: 'walkIn', bits: toFoe, ticks: 5, weight: 2 });
          opts.push({ act: 'wait', bits: 0, ticks: 5, weight: 1.5 });
        } else {
          /**
           * 越えることもくぐることもできない弾（女子高生の彼氏）。
           *
           * 受ける手が無いので、逃げ回っても壁際で同じことになる。
           * **呼んだ本人を先に倒しに行く**のが唯一の勝ち筋で、
           * 呼んでから届くまでが長いぶん、その間に差し込む時間はある。
           * 避けられない弾から目を逸らして相手だけを見る、という切り替え。
           */
          opts.push({
            act: 'rush',
            bits: toFoe | BTN.DASH,
            ticks: 8,
            weight: cfg.punish * 6,
            forced: true,
          });
          if (dist <= hitRange && !foe.invulnerable) {
            opts.push({
              act: 'attack',
              bits: BTN.ATTACK,
              ticks: 6,
              weight: cfg.punish * 10,
              forced: true,
            });
          }
        }
      } else if (
        // 2段ジャンプで避ける。1段目は**真上**に跳ぶだけで、避けるのは 2段目
        // （空中の分岐が弾との距離を見て前へ跳び直す）。
        // 跳ぶ時間が残っているうちにしか始められない。
        // 2段目が無いと跳んだだけの的になるので、残り回数も確認する。
        me.airJumps > 0 &&
        shot.frames >= DODGE_ARM_FRAMES &&
        shot.frames <= DODGE_ARM_MAX
      ) {
        opts.push({ act: 'dodge', bits: BTN.UP, ticks: 6, weight: cfg.guard * 4 });
      }

      // まだ間近でないなら、詰める足は止めない（弾を見るたび固まると近づけない）
      if (!near && !unblockable) {
        opts.push({ act: 'rush', bits: toFoe | BTN.DASH, ticks: 8, weight: cfg.dash * 3 });
        opts.push({ act: 'walkIn', bits: toFoe, ticks: 8, weight: 1.5 });
      }
      if (!unblockable) {
        opts.push({ act: 'wait', bits: 0, ticks: 6, weight: (1 - cfg.guard) * 2 });
      }
      return this._choose(rng, opts);
    }

    /**
     * ── 相手が降ってくる ──────────────────────────────────
     *
     * 空中スキルは発生 4〜6 フレーム。技が出てから選べる手は何も無いので、
     * ここは**跳ばれた時点**で答えを決める。落ちてくる軌道は技データで
     * 決まっているので、どこへいつ届くかは先に読める（`_airThreat()`）。
     *
     * どの手が本当に助かるのかは、降り技を持つ 5 キャラ × 間合い 5 通り ×
     * 踏み切り 15 通りを総当たりして確かめた。結果ははっきりしていて、
     *
     *   - **走って下がる**  … どの間合いでも 13〜15/15。いちばん外れが無い
     *   - **走って潜る**    … 相手の空中判定の外側からなら 15/15。
     *                        跳んだ相手の下をくぐると、着地したときには
     *                        こちらが背後にいて、長い着地硬直がまるごと隙になる
     *   - **跳んで下がる**  … 0/15。浮いた時点でガードもダッシュも出せず、
     *                        着地際を狙って降ってこられるだけ
     *   - ガード・しゃがみ  … 崩す技なので 0/15
     *
     * 要は**足で外す**しかない。そして外し切るには降り切るまで押し続ける
     * 必要があるので、ここで決めた手は着地まで維持する。
     */
    if (air && air.frames <= AIR_REACT) {
      // 気づけるかどうかは難易度で変える。弱い設定はここを取りこぼして
      // 地上の間合い争いを続け、降ってこられる ＝ 飛び込みがちゃんと通る。
      if (rng.next() < cfg.read) {
        const opts = [];
        const hold = Math.min(HOLD_MAX, air.landIn + 6);

        /**
         * どちらへ走れば外せるかは、実際に走らせて確かめる（`_diveEscape()`）。
         *
         * 相手ごとに「この間合いなら下がる／潜る」と決め打ちすると必ず外れる。
         * キャヴァリアのドリルは判定 208 でも突進を足すと 518 届くので、
         * 判定の長さで測ると内側から潜りに行って刺さる。逆にメイドの天空斬りは
         * ほぼ真下に落ちるので、遠ければ下をくぐれる。**同じ数字で両方は測れない**。
         *
         * 壁で頭打ちになるところまで `_airThreat()` の中で見ているので、
         * 背中が壁のときに「下がれば外せる」と読み違えることもない。
         */
        const awayDir = away === BTN.LEFT ? -1 : 1;
        // 何もしなければ捕まるまでの時間。走って稼げるかはこれと比べる。
        const stayT = air.frames;
        const backT = this._diveEscape(me, foe, awayDir);
        const underT = this._diveEscape(me, foe, -awayDir);
        const canBack = backT > stayT;
        const canUnder = underT > stayT;

        if (canBack) {
          // 走って下がる。外せるなら、これがいちばん外れの無い答え。
          opts.push({
            act: 'retreat',
            bits: away | BTN.DASH,
            ticks: hold,
            weight: cfg.spacing * (backT === Infinity ? 10 : 5),
            air: true,
          });
        }
        if (canUnder) {
          /**
           * 走って潜る。相手が高いうちに下をくぐると、判定が降りてくる頃には
           * こちらが背後にいる。そのうえ相手は長い着地硬直を晒すので、
           * 避けながらそのまま差し返しの間合いに入れる。
           */
          opts.push({
            act: 'rush',
            bits: toFoe | BTN.DASH,
            ticks: hold,
            weight: cfg.punish * (underT === Infinity ? (canBack ? 6 : 10) : 3),
            air: true,
          });
        }
        // どちらへ走っても時間を稼げない ＝ 壁を背負って降られた形。
        const trapped = !canBack && !canUnder;
        if (trapped && air.low >= 0) {
          /**
           * 走って外せないなら、姿勢を低くして通す。
           *
           * しゃがめばやられ判定は 198 → 100 まで縮む。総当たりでも、
           * 壁際でキャヴァリアのドリルを受けて助かったのはしゃがみだけだった
           * （12〜15/15。下がる・受ける・詰めるは軒並み 0〜3/15）。
           *
           * ただし**判定が相手の足元より下まで出る技**（天空斬り -16・
           * 急降下斬り -10・急降下 -34）は地面ごと薙いでくるので、縮んでも当たる。
           * そういう技にしゃがむのは何もしないより悪いので、ここで切り分ける。
           */
          opts.push({ act: 'duck', bits: BTN.DOWN, ticks: hold, weight: cfg.guard * 12, air: true });
        }
        if (trapped) {
          /**
           * しゃがんでも通せない技を、走って外せないところで受ける形。
           * ここまで来ると助かる手はほぼ残っていない。
           *
           * それでも下がり続ければ、相手の踏み込みを壁の手前で余らせられることがある。
           * ここから前へ走って抜けようとするのは、総当たりでも壁際では
           * 軒並み 0〜3/15 で、**降りてくる判定へ自分から入る**だけだった。
           */
          opts.push({
            act: 'retreat',
            bits: away | BTN.DASH,
            ticks: hold,
            weight: cfg.spacing * 4,
            air: true,
          });
        }

        /**
         * 対空。落ちてくるところへ判定を置く。
         *
         * 振り始めるのは**発生ぶん手前**で、そこを外すと当たらない。
         * 密着で降りられたときだけの手で、少しでも遠いと振り終わった頭の上から
         * 刺されるので、間合いも発生も揃ったときにしか候補に入れない。
         */
        if (
          this.cooldown === 0 &&
          !foe.invulnerable &&
          air.dist <= hitRange * 0.9 &&
          prof.attack.top >= air.y &&
          air.frames >= prof.attack.startup &&
          air.frames <= prof.attack.startup + AIR_SWING_WINDOW
        ) {
          opts.push({
            act: 'attack',
            bits: BTN.ATTACK,
            ticks: 6,
            weight: cfg.punish * 5,
            cooldown: 20,
            air: true,
          });
        }

        /**
         * ガード。空中**攻撃**は普通に止まるが、空中**スキル**は軒並み
         * ガードを崩す。崩す手を持っている相手に固めるのは、
         * 割られたぶん硬直が伸びる（GUARD_BREAK_EXTRA）ので何もしないより悪い。
         */
        if (!air.guardBreak) {
          opts.push({ act: 'guard', bits: BTN.GUARD, ticks: hold, weight: cfg.guard * 14, air: true });
        }

        /**
         * くぐる。判定が高いところに収まったまま通り過ぎる技だけ。
         *
         * 高さの下駄は履かせない（`_isDuckable()` と同じ理由）。**落ちてくる技を
         * 接触点の高さで測ると、そのあとも降り続けることを見落とす**。
         * 天空斬りは判定の下端が -16 ＝ 地面まで突き刺さってくるので、
         * 胸の高さで測れば「くぐれる」に見えてしまい、しゃがんだまま刺される。
         */
        if (air.low >= CROUCH_CLEAR_Y) {
          opts.push({ act: 'duck', bits: BTN.DOWN, ticks: hold, weight: cfg.guard * 7, air: true });
        }

        /**
         * すでにこの降り技への答えを選んであるなら、それを押し通す。
         *
         * ただし**走って外せなくなったら選び直す**。下がり切って壁に着いたあとも
         * 同じ「走って下がる」を押し続けるのは、下がっているつもりで
         * 動いていないだけになる（実測でキャヴァリアに負けた 86 回すべてが、
         * 40 ティック下がり切ったあと壁に貼り付いたままの被弾だった）。
         */
        const locked = !trapped && this.airAct && opts.find((o) => o.act === this.airAct);
        if (locked) return this._commit(locked);
        return this._choose(rng, opts);
      }
    }
    if (!air) this.airAct = null;

    // ── 相手の技が来ている ────────────────────────────────
    const incoming = this._incomingAttack(foe);
    const threat = incoming ? this._threatRange(foe) : 0;
    if (incoming && dist <= threat + 40) {
      const opts = [];
      // 判定が出るまでの残り。逃げる手はこれが足りていないと間に合わない
      const until = this._framesUntilHit(foe);
      // 掴みはガードで防げない。跳ぶのが唯一の答えになる
      const grabbing = this._incomingGrab(foe);
      // スキル（guardBreak）もガードでは止まらない。しかも割られたぶん硬直が伸びる。
      // 掴みと違って空中の相手にも当たるので、答えは「しゃがむ・潰す・離れる」になる。
      const breaking = !grabbing && this._incomingBreak(foe);
      // ただし、それに気づけるかは難易度で変える。弱い設定はここを取りこぼして
      // ガードを固め、そのまま割られる ＝ 連打がちゃんと通る
      const unblockable = (grabbing || breaking) && rng.next() < cfg.read;
      // 守りを維持する長さは、その技が出切るまでに合わせる。
      const holdFor = Math.min(HOLD_MAX, Math.max(12, this._threatFrames(foe)));

      /**
       * 結界を張って弾く（巫女）。
       *
       * 結界が無効にするのは**ガード不能技と掴みだけ**で、それはちょうど
       * こちらが答えを持っていない攻撃と重なる。しかも弾いた側は返し技
       * （結界の欠片）に移れるので、受けるだけで終わらない。
       *
       * 張り切るまでのフレームが要るので、間に合うときだけ。
       */
      if (unblockable && Number.isFinite(prof.skill.wardFrame) && until >= prof.skill.wardFrame) {
        opts.push({
          act: 'skill',
          bits: BTN.SKILL,
          ticks: 8,
          weight: cfg.guard * 16,
          skillCooldown: 40,
          forced: true,
        });
      }

      // ガードは一番確実。ただしこれ一択にすると、崩し技を置かれて終わる。
      // ガードで止まらない技に対してはまったくの無駄なので出さない。
      if (!unblockable) {
        opts.push({
          act: 'guard',
          bits: BTN.GUARD,
          ticks: Math.min(holdFor, 20),
          weight: cfg.guard * 5,
        });
      }

      // ビームのように高いところだけを薙ぐ攻撃は、しゃがめばくぐれる。
      // ガード不能なので、くぐれるなら最優先。
      // **しゃがみ切るまで、そして技が出切るまで**維持する。立ち上がりの 1 ティックで
      // やられ判定は 110 まで戻る＝ビームの下端 107 に届くので、早く立てば当たる。
      const duckable = this._isDuckable(foe);
      if (duckable) {
        opts.push({
          act: 'duck',
          bits: BTN.DOWN,
          ticks: holdFor,
          weight: cfg.guard * 14,
          forced: unblockable,
        });
      }
      // 判定が低いところに収まっているなら跳んで越える。
      // ただし跳び上がるまでに判定が来ると、そのまま食らうだけになる。
      // ガード不能技はこれが数少ない答えなので、ビームをしゃがむのと同じ重みで最優先する。
      if (this._isJumpable(foe) && until >= JUMP_ESCAPE_FRAMES) {
        const w = unblockable ? cfg.guard * 14 : cfg.guard * 1.6;
        opts.push({
          act: 'jumpIn',
          bits: BTN.UP | toFoe,
          ticks: 8,
          weight: jumpW(w),
          forced: unblockable && !duckable,
        });
        opts.push({ act: 'retreat', bits: BTN.UP | away, ticks: 8, weight: jumpW(w * 0.6) });
      }
      /**
       * 間合いの端で受けているなら、下がれば空振りにできる。
       * これも下がり切る時間が要る。
       * ガード不能技は受ける手が無いので、跳べないときはこれが次善の手になる。
       *
       * ただし**下がれる距離は時間だけでは決まらない**。壁までの残りで頭打ちに
       * なるので、そこまで含めて「本当に空振らせられるか」を見る。
       * 時間だけで測っていた頃は、背中が壁でも同じ重みで下がる手を選んでいて、
       * 動かないまま判定を受けていた。
       */
      const backOut = Math.min(room, me.def.dashSpeed * until);
      if (
        (unblockable || threat - dist < 70) &&
        until >= RETREAT_ESCAPE_FRAMES &&
        dist + backOut > threat
      ) {
        opts.push({
          act: 'retreat',
          bits: away | BTN.DASH,
          ticks: 12,
          weight: cfg.spacing * (unblockable ? 4 : 2.5),
        });
      }
      // 相手の発生より自分の発生が速いなら、割り込んだ方が勝つ。
      // **スキルは軒並み発生が遅い**ので、連打してくる相手にはこれが本命の答えになる。
      if (dist <= hitRange && until > prof.attack.startup + 3) {
        opts.push({
          act: 'attack',
          bits: BTN.ATTACK,
          ticks: 6,
          weight: cfg.punish * (unblockable ? 6 : 2.5),
        });
      }
      // 溜めの長い技は、出る前に踏み込んで潰すのが本筋。
      // 照射の溜め 1 秒は、間合いの外からでも走り込んで振り切れる時間がある。
      // 「見てから避ける」だけだと避け続けるだけで勝ちに行けない。
      if (until >= SLOW_STARTUP && dist > hitRange) {
        const closeIn = (dist - hitRange) / Math.max(1, me.def.dashSpeed);
        if (closeIn + prof.attack.startup + 4 <= until) {
          opts.push({ act: 'rush', bits: toFoe | BTN.DASH, ticks: 8, weight: cfg.punish * 4 });
        }
      }
      // ガード不能技に対して手が何も残らなかったとき。せめて間合いを外す
      if (unblockable && opts.length === 0) {
        opts.push({ act: 'retreat', bits: away | BTN.DASH, ticks: 10, weight: 1, forced: true });
      }
      return this._choose(rng, opts);
    }

    // ── 相手が手を出せない ────────────────────────────────
    // 見えていない相手の隙は分からない。消えている間に差し込めてしまうと、
    // 位置を見失っている意味が無くなる
    const open = blind ? 0 : this._openFrames(foe);
    if (open > 0) {
      const opts = [];
      if (dist <= hitRange && open >= prof.attack.startup) {
        opts.push({ act: 'attack', bits: BTN.ATTACK, ticks: 6, weight: cfg.punish * 5 });
      }
      if (dist <= skillRange && open >= prof.skill.startup + 4 && this.skillCd === 0 && skillUsable) {
        // 大技が確定で入る場面。一番おいしい
        opts.push({
          act: 'skill',
          bits: BTN.SKILL,
          ticks: 6,
          weight: cfg.punish * 4,
          skillCooldown: 60,
        });
      }
      // 届かないなら詰める。硬直が明ける前に間合いへ入れたい
      opts.push({ act: 'rush', bits: toFoe | BTN.DASH, ticks: 8, weight: dist > hitRange ? 4 : 0.8 });
      opts.push({
        act: 'jumpIn',
        bits: BTN.UP | toFoe,
        ticks: 8,
        weight: jumpW(dist > hitRange * 1.4 ? 1 : 0.2, open),
      });
      opts.push({ act: 'wait', bits: 0, ticks: cfg.react, weight: (1 - cfg.punish) * 3 });
      return this._choose(rng, opts, true);
    }

    // ── 通常の間合い争い ──────────────────────────────────
    const opts = [];
    // 固めているかどうかも、見えていなければ分からない
    const turtling = !blind && this._turtling(foe);

    /**
     * 届くなら振る。
     *
     * ただし降り技を持つ相手には、**間合いの先端で振らない**。
     * 空振った 41 フレームは跳んで降りてくるのにちょうど足りる時間で、
     * 発生 4〜6 フレームの降り技はそこへ落ちてくるだけでいい
     * （実測では、降り技で死んだ 335 回のうち 100 回が自分の空振り中だった）。
     * 当たる間合いまで入ってから振れば、外して差し返される形にはならない。
     */
    const pokeRange = foeDiver && foe.isFree ? hitRange * 0.85 : hitRange;
    const inPoke = dist <= pokeRange && !foe.invulnerable && this.cooldown === 0;

    // 置き技。まだ届いていないが、振り始めれば相手の入りに間に合う
    if (canPlace && !inPoke) {
      opts.push({
        act: 'attack',
        bits: BTN.ATTACK,
        ticks: 6,
        weight: cfg.aggression * 6 * press,
        cooldown: ranged ? 10 : 8,
      });
    }

    if (inPoke) {
      /**
       * 届いているなら振る手をいちばん重く見る。
       *
       * ここが軽かった頃は、間合いに入っていても下がる・待つの合計が攻めを
       * 上回っていた（密着で下がり 3.3 対 振り 2.4）。一手ずつは筋が通って
       * いても、足し合わせると**届く位置に来るたびに引き返す**動きになる。
       * 届く位置は待つための場所ではないので、そこでは振りを本命に置く。
       */
      opts.push({
        act: 'attack',
        bits: BTN.ATTACK,
        ticks: 6,
        weight: cfg.aggression * 6 * press,
        /**
         * 振ったあとの間。技そのものの戻り（20〜30 フレーム）に上乗せする
         * ぶんなので、ここを長く取ると**技の硬直が明けてもまだ振らない**
         * 時間ができる。散らすのが目的なら短くて足りる。
         */
        cooldown: ranged ? 10 : 8,
      });
    }
    // スキルはガードを崩せる代わりに発生が遅く、外すと大きな隙になる。
    // 固める相手か、出し切るまで踏み込まれない距離のときだけ。
    if (dist <= skillRange && this.skillCd === 0 && skillUsable) {
      const slow = prof.skill.startup > SLOW_STARTUP;
      if (turtling) {
        // 打撃が通らないので、崩すならこれしかない。
        // 掴みは相手が地上に居座っている限り必ず通るので、さらに重く見る。
        opts.push({
          act: 'skill',
          bits: BTN.SKILL,
          ticks: 6,
          weight: cfg.crush * (prof.skill.grab ? 10 : 6) * press,
          skillCooldown: slow ? 90 : 60,
        });
      } else if (dist > hitRange * 0.7) {
        opts.push({
          act: 'skill',
          bits: BTN.SKILL,
          ticks: 6,
          weight: cfg.aggression * (slow ? 0.5 : 1.2) * press,
          skillCooldown: slow ? 150 : 70,
        });
      }
    }
    // 固める相手には、いったん離れて仕切り直すのも手。
    // ただし下がりすぎると崩しの間合いから外れてしまうので、内側にいるときだけ。
    // 相手を壁に詰めているなら仕切り直さない。空けたぶんだけ相手が出てこられる。
    if (turtling && dist < skillRange * 0.8 && !foeCornered) {
      opts.push({ act: 'retreat', bits: away, ticks: 14, weight: backW(cfg.spacing * 0.8) });
    }
    /**
     * 近すぎる。相手の間合いの内側で殴り合うのは割が悪い……のだが、
     * **自分の技も届いている位置**なので、下がるのは手放しに正しくはない。
     *
     * ここを重く見ていた頃は、密着するたびに仕切り直して間合いを空け、
     * 空いたぶんをまた詰め直していた。近づいては離れるだけで手が出ない。
     * 振れる状況（inPoke）なら選択肢のひとつに留めて、
     * 振れないとき（硬直中・技の戻り）だけ本来の重さで下がる。
     */
    if (dist < hitRange * 0.5 && foe.isFree && !foeCornered) {
      const w = inPoke ? 0.45 : 1;
      opts.push({ act: 'retreat', bits: away, ticks: 14, weight: backW(cfg.spacing * 2.5 * w) });
      opts.push({
        act: 'retreat',
        bits: away | BTN.DASH,
        ticks: 12,
        weight: backW(cfg.spacing * 1.2 * w),
      });
    }
    // 遠いので詰める。歩き・走り・飛び込みを混ぜる。
    // ただし相手が下がり続けているなら歩いて追っても追いつけないので、
    // 走りと飛び込みに寄せる（離れて弾を撒く相手に対してこれが要る）。
    if (dist > idealRange) {
      const fleeing = foe.vx !== 0 && Math.sign(foe.x - me.x) === Math.sign(foe.vx);
      opts.push({ act: 'walkIn', bits: toFoe, ticks: 12, weight: fleeing ? 0.5 : 2.5 });
      opts.push({
        act: 'rush',
        bits: toFoe | BTN.DASH,
        ticks: 10,
        weight: cfg.dash * (fleeing ? 6 : 3) * press,
      });
      if (dist > 280) {
        opts.push({
          act: 'jumpIn',
          bits: BTN.UP | toFoe,
          ticks: 8,
          weight: jumpW(cfg.aggression * (fleeing ? 3 : 1.2)),
        });
      }
    }
    /**
     * 自分の間合いの先端で待つ。相手が入ってきたら差し返せる。
     *
     * ただし**もう届いているなら待つ意味は無い**。差し返しは相手を待たせる
     * 間合いで成立する手で、届く位置で同じ重さのまま置いておくと、
     * 攻め手と張り合って「入ったのに何もしない」時間を作るだけになる。
     */
    opts.push({ act: 'wait', bits: 0, ticks: 10, weight: cfg.spacing * (inPoke ? 0.4 : 1.5) });
    // 揺さぶり。前後に振って間合いを測る
    opts.push({ act: 'walkIn', bits: toFoe, ticks: 8, weight: 0.8 });
    opts.push({ act: 'retreat', bits: away, ticks: 8, weight: backW(inPoke ? 0.35 : 0.8) });
    if (ranged && dist < idealRange * 0.7) {
      /**
       * 遠距離キャラは離れ続けたい……が、**下がる先が無くなったらそれは仕事に
       * ならない**。壁を背負った弾撃ちは、間合いを保てないまま近い距離で
       * 撃ち続けることになり、いちばん苦手な形に自分から入る。
       * 余地があるうちだけ下がる手として重く見る。
       */
      opts.push({ act: 'retreat', bits: away | BTN.DASH, ticks: 14, weight: backW(3) });
    }

    /**
     * 壁を背負っている。抜けることそのものを手として選ぶ。
     *
     * ここが無いと、詰められた CPU は「下がる手が軽くなった」だけの状態で
     * 立ち回り続ける。軽くなった下がりの代わりに前へ出る手を積んでおかないと、
     * 待ちと振りだけが残って、結局その場で受け続けることになる。
     *
     * 相手も壁際（＝どちらも隅、押し合っているだけ）なら要らない。
     */
    if (cornered && !foeCornered) {
      // 走って正面から出る。相手をすり抜けられれば位置が入れ替わる
      opts.push({ act: 'rush', bits: toFoe | BTN.DASH, ticks: 10, weight: cfg.spacing * 3 });
      // 跳んで越える。跳んでよい状況かは jumpW がまとめて見ている
      opts.push({ act: 'jumpIn', bits: BTN.UP | toFoe, ticks: 8, weight: jumpW(cfg.spacing * 2) });
    }
    return this._choose(rng, opts, true);
  }
}
