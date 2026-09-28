/**
 * **枠の置き所が、同じ動画を焼き直しただけで振れる。その根を門の側で下げられるか。**
 *
 *   npm run lab:reframe:gate
 *
 * ## なぜこれが要るのか（2026-09-25・2 回目の積み残しの筆頭）
 *
 * 2 回目に、中身も速さも変えずに**焼くビットレートだけ振る**と入れた率が
 * 15fps 読みで 4.1pt 動くと分かり、読む速さを 30fps へ上げて 0.4pt まで落とした。
 * ただしあれは**蓋**で、根は門の側にある——`planReframe` の貯め（`outside`）は
 * **1 コマでも `deadband` の内側に入った瞬間に 0 へ捨てられる**ので、
 * 縁のあたりに居るコマが 1 枚裏返るだけで「動き出す / 動かない」が入れ替わる。
 * 標本を増やすとその化け方が減るだけで、化ける作りそのものは残っている。
 *
 * **振れ幅を物差しに使えるようになった**（同じ素材を焼き直して比べる）ので、
 * ここではそれを直接下げにいく。
 *
 * ## 測るもの
 *
 *   1. **根の名指し**——いまの門が、どの素材で何回貯めを捨てているか
 *   2. **門の形を並べる**——`step` / `release` / `ramp`（＋ `ramp` の目盛り 3 通り）
 *   3. **失っていないか**——被写体の居ない素材の泳ぎと、`subject-dart` の寄り道
 *
 * **2 だけを見ないこと。** 門を鈍くすれば振れ幅はいくらでも下がる（動かなければ 0pt）。
 * 1 で「捨てる作りが本当に犯人か」を先に確かめ、3 で「鈍くしただけではないか」を押さえる。
 *
 * ## 物差し
 *
 * 入れた率の**振れ幅**（5 通りの焼き上がりでの最大 − 最小）に加えて、
 * **枠の開き**を見る。同じ時刻のコマで、5 通りの焼き上がりの枠の中心が
 * どれだけばらけたか（最大 − 最小）の中央値。
 *
 * **入れた率の振れ幅だけでは足りない。** 入れた率は「窓に入ったか」の数え上げなので、
 * 枠が窓の幅（31.6%）の中で動く限り 1 ポイントも動かない一方、
 * **正解が窓の縁に沿って進む素材ではその逆**——枠が 1.4% ずれただけで
 * 何十コマもまとめて裏返る（`motion` の 5.7pt がこれ）。
 * 出来上がりの絵が焼き直しで変わったかどうかは、枠の開きでしか読めない。
 *
 * **枠の開きは素材ごとに出す。** 素材をまたいで中央値を取ると、
 * 開いている 2 本が、開いていない 5 本の中に沈む（最初はそれで見落とした）。
 *
 * 採点は `score.mjs`（`bench.mjs` / `decimate-probe.mjs` と同じ関数）。物差しは変えていない。
 *
 * playwright が無い環境では、その旨を出して成功扱いで終わる（作業を止めないため）。
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { sceneFixture, leadSubjectAt } from '../fixtures/scenes.mjs';
import { launch, loadPlaywright, serve } from '../browser.mjs';
import { median, scoreFollow, scoreSwim } from './score.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

const playwright = loadPlaywright();
if (!playwright) {
  console.log('playwright が見つからないので、この測定は飛ばします（本物の動画を焼く所が要ります）。');
  process.exit(0);
}

const { DEFAULT_REFRAME } = await import('./src/reframe.ts');

/** 焼くときのコマの速さ。素材は 15fps で作ってあるので、30fps は「速い素材」の代わり。 */
const BAKE_FPS = 30;
/**
 * 焼くビットレート。**中身を変えずに、同じ動画の「別の焼き上がり」を作るため**。
 * `decimate-probe.mjs` と同じ 5 通りにしてある（振れ幅の数字を並べられるように）。
 */
const BITRATES = [4_000_000, 400_000, 150_000, 80_000, 40_000];
const READ_FPS = [15, 30];

/**
 * 並べる門。**`step` が現状**（2026-09-25・2 回目まで）。
 *
 * `soft` だけ死に帯（`deadband`）を 3 通り置いてある。**`soft` の死に帯は、
 * そのまま「止まるときの残りのずれ」になる**（貯めて動き出す形と違って、
 * 縁の内側では 1 コマも動かないので、縁の手前で止まったらそこが終点）。
 * なので `soft` では死に帯が「動かさない幅」ではなく**「常に遅れる幅」**を決める。
 *
 * **鈍さと振れ幅の交換になっていないか**は、3 で押さえる。
 * 振れ幅だけが下がって入れた率も落ちるなら、それは「直した」ではなく「鈍らせた」。
 */
const GATES = [
  { label: 'step（現状）', options: { gate: 'step' } },
  { label: 'release 0.3', options: { gate: 'release', gateRelease: 0.3 } },
  { label: 'ramp 0.5', options: { gate: 'ramp', gateRamp: 0.5 } },
  { label: 'soft 帯 0.06', options: { gate: 'soft' } },
  { label: 'soft 帯 0.03', options: { gate: 'soft', deadband: 0.03 } },
  { label: 'soft 帯 0.02', options: { gate: 'soft', deadband: 0.02 } },
];

const WITH_SUBJECT = ['motion', 'subject-pan', 'subject-pause', 'subject-cuts', 'subject-static', 'subject-dart', 'subject-decoy'];
// 泳ぎの側は、いちばん泳ぐ 2 本（パン）と、字幕だけの 1 本と、静かな 1 本。
const WITHOUT_SUBJECT = ['pan', 'pan-reveal', 'captions-only', 'cuts-plain'];

const pad = (s, n) => String(s).padEnd(n, ' ');
const right = (s, n) => String(s).padStart(n, ' ');
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

/**
 * 同じ時刻のコマで、焼き上がりごとの枠がどれだけばらけたか。
 *
 * **入れた率では見えない振れを見るための量。** 枠が窓の幅（31.6%）の中で動く限り
 * 入れた率は 1 ポイントも動かないが、出来上がりの絵は別物になる。
 * 長さが揃わない焼き上がりが混じったら、短いほうに合わせて切る
 * （合わせずに数えると、末尾の欠けが「ばらけた」に化ける）。
 */
function frameSpread(runs) {
  if (runs.length < 2) return { mid: 0, max: 0 };
  const n = Math.min(...runs.map((r) => r.length));
  const spreads = [];
  for (let i = 0; i < n; i += 1) {
    const vs = runs.map((r) => r[i]);
    spreads.push(Math.max(...vs) - Math.min(...vs));
  }
  return { mid: median(spreads), max: spreads.length ? Math.max(...spreads) : 0 };
}

const server = await serve(here);
const browser = await launch(playwright);
try {
  const page = await (await browser.newContext({ viewport: { width: 800, height: 600 } })).newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(server.url, { waitUntil: 'networkidle' });
  await page.addScriptTag({ type: 'module', url: './testkit/decimate.ts' });
  await page.waitForFunction(() => !!window.__labReframeDecimate, null, { timeout: 30000 });

  const run = (name, readFps, bitrate) =>
    page.evaluate(
      ([n, fps, bake, plans, rate]) =>
        window.__labReframeDecimate(n, { bakeFps: bake, readFps: fps, plans, bitrate: rate }),
      [name, readFps, BAKE_FPS, GATES, bitrate],
    );

  /**
   * 素材 1 本を、ある速さで、5 通りの焼き上がりで通す。
   *
   * **焼き上がり 5 通りを 1 か所で回して、門の形ごとに畳む。**
   * 門ごとに焼き直すと、比べている 2 つに焼き直しのばらつきまで混ざる。
   */
  async function sweep(name, readFps) {
    const byGate = GATES.map(() => ({ scores: [], centers: [], resets: [], nearResets: [] }));
    let times = [];
    let fps = readFps;
    for (const bitrate of BITRATES) {
      const r = await run(name, readFps, bitrate);
      times = r.times;
      fps = r.fps;
      for (let g = 0; g < GATES.length; g += 1) {
        const plan = r.plans[g];
        const score = scoreFollow(sceneFixture(name), r.times, plan.centers, DEFAULT_REFRAME.cropWidth);
        byGate[g].scores.push(score.inside);
        byGate[g].centers.push(plan.centers);
        byGate[g].resets.push(plan.gate.resets);
        byGate[g].nearResets.push(plan.gate.nearResets);
      }
    }
    return byGate.map((g) => ({
      lo: Math.min(...g.scores),
      hi: Math.max(...g.scores),
      spread: Math.max(...g.scores) - Math.min(...g.scores),
      inside: mean(g.scores),
      resets: median(g.resets),
      nearResets: median(g.nearResets),
      open: frameSpread(g.centers),
      centers: g.centers,
      times,
      fps,
    }));
  }

  console.log(`門の出入りを 1 コマで決めない（${BAKE_FPS}fps で焼いた本物の動画 ・ 焼き上がり 5 通り）\n`);

  // ---------- 1. 根の名指し ----------
  //
  // **直す前に、その作りが本当に犯人かを見る。** 貯めを捨てた回数そのものより、
  // 「あと半分で動き出すところまで貯まっていたのに捨てた」の回数が効く。
  // そこが出ていない素材で振れているなら、犯人は門ではない。
  console.log('1. いまの門（step）は、どこで貯めを捨てているか\n');
  console.log(
    `${pad('素材', 16)}${right('読み', 7)}${right('捨てた', 8)}${right('うち惜しい', 12)}` +
      `${right('入れた率', 20)}${right('振れ幅', 9)}${right('枠の開き', 10)}`,
  );
  console.log('-'.repeat(82));
  const baseline = new Map();
  for (const name of WITH_SUBJECT) {
    for (const fps of READ_FPS) {
      const rows = await sweep(name, fps);
      baseline.set(`${name}@${fps}`, rows);
      const r = rows[0];
      console.log(
        `${pad(name, 16)}${right(`${fps}fps`, 7)}${right(r.resets, 8)}${right(r.nearResets, 12)}` +
          `${right(`${r.lo.toFixed(1)}〜${r.hi.toFixed(1)}%`, 20)}${right(`${r.spread.toFixed(1)}pt`, 9)}` +
          `${right(r.open.mid.toFixed(4), 10)}`,
      );
    }
  }

  // ---------- 2. 門の形を並べる ----------
  //
  // **枠の開きは素材ごとに出す。** 7 本をまたいで中央値を取ると、
  // 開いている 2 本（`motion` と `subject-decoy`）が残り 5 本の中に沈んで、
  // 門を替えても数字が動かないように見える。
  for (const fps of READ_FPS) {
    console.log(`\n\n2. 門の形ごと ・ 枠の開き（中央値 ・ ${fps}fps 読み ・ 小さいほど再現する）\n`);
    console.log(`${pad('  門', 18)}${WITH_SUBJECT.map((n) => right(n.replace('subject-', 's-'), 11)).join('')}${right('いちばん開いた', 15)}`);
    console.log('-'.repeat(18 + WITH_SUBJECT.length * 11 + 15));
    for (let g = 0; g < GATES.length; g += 1) {
      const rows = WITH_SUBJECT.map((name) => baseline.get(`${name}@${fps}`)[g]);
      console.log(
        `${pad('  ' + GATES[g].label, 18)}${rows.map((r) => right(r.open.mid.toFixed(4), 11)).join('')}` +
          `${right(Math.max(...rows.map((r) => r.open.mid)).toFixed(4), 15)}`,
      );
    }

    console.log(`\n   まとめ（${fps}fps 読み）\n`);
    console.log(
      `${pad('  門', 18)}${right('入れた率', 10)}${right('振れ幅(最大)', 14)}` +
        `${right('枠の開き(最悪)', 16)}${right('1 コマの最大', 14)}${right('惜しい捨て', 12)}`,
    );
    console.log('-'.repeat(84));
    for (let g = 0; g < GATES.length; g += 1) {
      const rows = WITH_SUBJECT.map((name) => baseline.get(`${name}@${fps}`)[g]);
      console.log(
        `${pad('  ' + GATES[g].label, 18)}${right(`${mean(rows.map((r) => r.inside)).toFixed(1)}%`, 10)}` +
          `${right(`${Math.max(...rows.map((r) => r.spread)).toFixed(1)}pt`, 14)}` +
          `${right(Math.max(...rows.map((r) => r.open.mid)).toFixed(4), 16)}` +
          `${right(Math.max(...rows.map((r) => r.open.max)).toFixed(4), 14)}` +
          `${right(rows.reduce((a, r) => a + r.nearResets, 0), 12)}`,
      );
    }
  }

  // ---------- 3. 鈍らせただけではないか ----------
  //
  // 門を鈍くすれば振れ幅は下がる。**下がった代わりに何を失ったか**を 2 つで見る:
  // 被写体の居ない素材で泳ぎが増えていないか（増えるなら門が緩んだ）と、
  // `subject-dart` の**寄り道**に付いていけているか（落ちるなら門が重い）。
  console.log('\n3. 失っていないか ・ 被写体の居ない素材の泳ぎ / 秒（30fps 読み ・ 0.000 が正解）\n');
  console.log(`${pad('門', 18)}${WITHOUT_SUBJECT.map((n) => right(n, 15)).join('')}${right('中央値', 10)}`);
  console.log('-'.repeat(18 + WITHOUT_SUBJECT.length * 15 + 10));
  const swimByGate = GATES.map(() => []);
  for (const name of WITHOUT_SUBJECT) {
    const r = await run(name, 30, BITRATES[0]);
    for (let g = 0; g < GATES.length; g += 1) {
      const { swim } = scoreSwim(r.times, r.plans[g].centers, sceneFixture(name).cuts, r.fps);
      swimByGate[g].push(swim);
    }
  }
  for (let g = 0; g < GATES.length; g += 1) {
    console.log(
      `${pad(GATES[g].label, 18)}${swimByGate[g].map((s) => right(s.toFixed(3), 15)).join('')}` +
        `${right(median(swimByGate[g]).toFixed(3), 10)}`,
    );
  }

  console.log('\n\n   `subject-dart` の寄り道（2 回 × 0.8 秒）だけを切り出して ・ 30fps 読み\n');
  console.log(`${pad('門', 18)}${right('枠のずれ', 12)}${right('入れた率', 11)}`);
  console.log('-'.repeat(41));
  {
    const r = await run('subject-dart', 30, BITRATES[0]);
    for (let g = 0; g < GATES.length; g += 1) {
      const e = excursion(sceneFixture('subject-dart'), r.times, r.plans[g]);
      console.log(`${pad(GATES[g].label, 18)}${right(e.centerError.toFixed(3), 12)}${right(`${e.inside.toFixed(1)}%`, 11)}`);
    }
  }

  if (errors.length) console.log(`\nページ例外: ${errors.join(' / ')}`);
} finally {
  await browser.close();
  server.stop();
}

/**
 * **「寄り道」と呼ぶ幅**。正解の位置が素材の中央値からこれ以上離れたコマを寄り道とみなす。
 *
 * `DEFAULT_REFRAME.deadband` を使っていたが、2026-09-25（3 回目）に既定が
 * 0.06 → 0.03 へ動いた。**つまみに繋いだままだと、つまみを回すたびに
 * 「何を寄り道と呼ぶか」まで変わって、前の日の数字と並べられなくなる。**
 * これは素材の折れ線の話なので、判定のつまみからは切り離して固定する
 * （この値で測った 9/25 の 1〜3 回目の表と、そのまま並べられる）。
 */
const EXCURSION_BAND = 0.06;

/**
 * **寄り道のあいだだけ**を切り出して採点する（`decimate-probe.mjs` と同じ切り出し方）。
 *
 * 「寄り道」は素材の折れ線を読んで決める——正解の位置が、その素材の中央値から
 * `deadband` 以上離れているコマ。秒を直に書かないのは、
 * **素材の折れ線を直したときに、ここだけ古い秒を見続けるのを避ける**ため。
 */
function excursion(fixture, times, plan) {
  const truths = times.map((t) => leadSubjectAt(fixture, t)?.u ?? NaN);
  const home = median(truths.filter((u) => Number.isFinite(u)));
  const center = [];
  let inside = 0;
  for (let i = 0; i < times.length; i += 1) {
    if (!Number.isFinite(truths[i]) || Math.abs(truths[i] - home) < EXCURSION_BAND) continue;
    const err = Math.abs(truths[i] - plan.centers[i]);
    center.push(err);
    if (err < DEFAULT_REFRAME.cropWidth / 2) inside += 1;
  }
  return { centerError: median(center), inside: center.length ? (inside / center.length) * 100 : NaN };
}
