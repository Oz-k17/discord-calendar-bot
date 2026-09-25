/**
 * **読むコマを間引くか、ならしの窓を広げるか**を決めるために測る。
 *
 *   npm run lab:reframe:decimate
 *
 * ## なぜこれが要るのか（2026-09-25・1 回目の積み残し）
 *
 * つまみは全部「秒」で書いてあるので、コマを間引いても数字は動かないはずだった。
 * 合成コマではそのとおりなのに、**圧縮を通すと動く**——1 回目に `motion` 1 本で
 * 15fps 読み 92.6% / 30fps 読み 97.9% と出た。塞ぎ方は 2 つ（間引かない / 窓を広げる）あり、
 * どちらが安いかを測っていなかったので、ここで測る。
 *
 * ## 測って分かったのは「どちらが安いか」ではなかった（2 回目）
 *
 * **その 5.3 ポイントは、差ではなく振れ幅だった。** 7 本並べると入れた率の平均は
 * 15fps 読みも 30fps 読みも 96.5% で同じで、代わりに**当たり外れの幅**が
 * 15fps 読み 4.1pt / 30fps 読み 0.4pt と 10 倍違う（下の 5 の表）。
 * 既定を 30fps にしたのは**再現性を買うため**で、精度のためではない。
 * 詳しくは `src/reframe.ts` の `REFRAME_ANALYSIS_FPS` の注。
 *
 * ## 合成コマでは測れない
 *
 * `lab:reframe` の表は合成したコマなので、**この選択には使えない**（粒が乗らない）。
 * なので焼く・読む・畳む・枠を決めるの 4 つをブラウザの中で通す。
 * 採点は `score.mjs`（`bench.mjs` と同じ関数）で、**物差しは変えていない。**
 *
 * ## 出す表
 *
 *   1. 追えているか（入れた率）——被写体の居る素材
 *   2. 泳いでいないか——被写体の居ない素材
 *   3. ならしが消した動き——`subject-dart` の寄り道だけを切り出して
 *   4. どこまで読むと頭打ちか、いくら払うか
 *   5. **その差は読み方の差か、当たり外れか**——焼くビットレートだけ振って振れ幅を見る
 *
 * **1 だけを見ないこと。** 読むコマを増やせば 1 は良くなる（ように見える）が、
 * それは 4 を払って買っているうえ、5 を見ないと**買えたのかどうかも分からない。**
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
const BAKE_FPS = Number(process.env.LAB_RF_BAKE ?? 30);
/** 時間を測るときに回す回数。いちばん短いものを採る（長いほうは他の仕事が混ざった回）。 */
const REPEATS = Number(process.env.LAB_RF_REPEATS ?? 3);

/**
 * 比べる読み方。**ならしの窓は「読んだコマの数」に効く**ので、
 * 15fps × 2.0 秒 と 30fps × 1.0 秒 は同じ 30 コマになる。そこを並べたい。
 */
const PLANS = [
  { label: 'ならし 1.0', options: { smooth: 1.0 } },
  { label: 'ならし 1.5', options: { smooth: 1.5 } },
  { label: 'ならし 2.0', options: { smooth: 2.0 } },
];
const READ_FPS = [15, 30];
/**
 * 焼くビットレート。**中身を変えずに、同じ動画の「別の焼き上がり」を作るため**。
 * これで振れる幅が、読み方を変えて動く幅より大きければ、読み方の差は読み取れない。
 */
const BITRATES = [4_000_000, 400_000, 150_000, 80_000, 40_000];

const WITH_SUBJECT = ['motion', 'subject-pan', 'subject-pause', 'subject-cuts', 'subject-static', 'subject-dart', 'subject-decoy'];
// 泳ぎの側は、いちばん泳ぐ 2 本（パン）と、字幕だけの 1 本と、静かな 1 本。
const WITHOUT_SUBJECT = ['pan', 'pan-reveal', 'captions-only', 'cuts-plain'];

const pad = (s, n) => String(s).padEnd(n, ' ');
const right = (s, n) => String(s).padStart(n, ' ');

const server = await serve(here);
const browser = await launch(playwright);
try {
  const page = await (await browser.newContext({ viewport: { width: 800, height: 600 } })).newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(server.url, { waitUntil: 'networkidle' });
  await page.addScriptTag({ type: 'module', url: './testkit/decimate.ts' });
  await page.waitForFunction(() => !!window.__labReframeDecimate, null, { timeout: 30000 });

  const run = (name, readFps, { bakeFps = BAKE_FPS, repeats = 1, bitrate = 4_000_000 } = {}) =>
    page.evaluate(
      ([n, fps, bake, plans, reps, rate]) =>
        window.__labReframeDecimate(n, { bakeFps: bake, readFps: fps, plans, repeats: reps, bitrate: rate }),
      [name, readFps, bakeFps, PLANS, repeats, bitrate],
    );

  /**
   * 生の位置に乗っている**粒**の大きさ。前後の真ん中からどれだけ外れているかで見る。
   *
   * **隣り合うコマの差では駄目**（2026-09-25・2 回目に気づいた）。それだと
   * 被写体が動いた量そのものを測ることになり、**間引けば必ず倍になる**——
   * 9/25 の 1 回目に「生の位置の荒れ 0.0105 → 0.0065」と書いた数字がこれで、
   * 粒ではなく標本の間隔を見ていた。等速で動く被写体は前後の真ん中に乗るので、
   * 2 階差を取れば動きは消えて粒だけが残る。
   */
  const grain = (xs) => {
    if (xs.length < 3) return 0;
    const d = [];
    for (let i = 1; i < xs.length - 1; i += 1) d.push(Math.abs(xs[i] - (xs[i - 1] + xs[i + 1]) / 2));
    return median(d);
  };

  console.log(`間引くか、ならしを広げるか（${BAKE_FPS}fps で焼いた本物の動画を、15fps / 30fps で読む）\n`);

  // ---------- 1. 追えているか ----------
  console.log('被写体の居る素材 ・ 入れた率\n');
  const head = [];
  for (const fps of READ_FPS) for (const p of PLANS) head.push(`${fps}fps/${p.options.smooth.toFixed(1)}`);
  console.log(`${pad('素材', 16)}${head.map((h) => right(h, 12)).join('')}`);
  console.log('-'.repeat(16 + head.length * 12));

  const totals = new Map(head.map((h) => [h, []]));
  const dartRows = [];
  for (const name of WITH_SUBJECT) {
    const fixture = sceneFixture(name);
    const cells = [];
    for (const fps of READ_FPS) {
      const r = await run(name, fps);
      for (let i = 0; i < PLANS.length; i += 1) {
        const key = `${fps}fps/${PLANS[i].options.smooth.toFixed(1)}`;
        const score = scoreFollow(fixture, r.times, r.plans[i].centers, DEFAULT_REFRAME.cropWidth);
        totals.get(key).push(score.inside);
        cells.push(`${score.inside.toFixed(1)}%`);
        if (name === 'subject-dart') {
          dartRows.push({ key, ...excursion(fixture, r.times, r.plans[i]) });
        }
      }
    }
    console.log(`${pad(name, 16)}${cells.map((c) => right(c, 12)).join('')}`);
  }
  console.log('-'.repeat(16 + head.length * 12));
  console.log(
    `${pad('  ならした平均', 16)}` +
      head.map((h) => right(`${(totals.get(h).reduce((a, b) => a + b, 0) / totals.get(h).length).toFixed(1)}%`, 12)).join(''),
  );

  // ---------- 2. 泳いでいないか ----------
  console.log('\n\n被写体の居ない素材 ・ 泳ぎ / 秒（0.000 が正解）\n');
  console.log(`${pad('素材', 16)}${head.map((h) => right(h, 12)).join('')}`);
  console.log('-'.repeat(16 + head.length * 12));
  const swimTotals = new Map(head.map((h) => [h, []]));
  for (const name of WITHOUT_SUBJECT) {
    const fixture = sceneFixture(name);
    const cells = [];
    for (const fps of READ_FPS) {
      const r = await run(name, fps);
      for (let i = 0; i < PLANS.length; i += 1) {
        const key = `${fps}fps/${PLANS[i].options.smooth.toFixed(1)}`;
        const { swim } = scoreSwim(r.times, r.plans[i].centers, fixture.cuts, r.fps);
        swimTotals.get(key).push(swim);
        cells.push(swim.toFixed(3));
      }
    }
    console.log(`${pad(name, 16)}${cells.map((c) => right(c, 12)).join('')}`);
  }
  console.log('-'.repeat(16 + head.length * 12));
  console.log(`${pad('  中央値', 16)}${head.map((h) => right(median(swimTotals.get(h)).toFixed(3), 12)).join('')}`);

  // ---------- 3. ならしが消した動き ----------
  //
  // **入れた率の平均は、まれにしか起きない動きを見ない。** `subject-dart` の寄り道は
  // 尺の 13% しかないので、そこを丸ごと落としても平均は数ポイントしか動かない。
  // ここだけは「寄り道のあいだ」を切り出して、ならす前（生）とならしたあとを並べる。
  console.log('\n\n`subject-dart` の寄り道（2 回 × 0.8 秒）だけを切り出して\n');
  console.log(
    `${pad('読み方', 14)}${right('生の位置のずれ', 16)}${right('ならしたあと', 14)}${right('枠のずれ', 12)}${right('入れた率', 11)}`,
  );
  console.log('-'.repeat(67));
  for (const row of dartRows) {
    console.log(
      `${pad(row.key, 14)}${right(row.rawError.toFixed(3), 16)}${right(row.targetError.toFixed(3), 14)}` +
        `${right(row.centerError.toFixed(3), 12)}${right(`${row.inside.toFixed(1)}%`, 11)}`,
    );
  }

  // ---------- 4. どこまで読むと頭打ちになるか、いくら払うか ----------
  //
  // **効きと値段を 1 つの表に並べる。** 別々の表にすると「良くなった」だけを読んで
  // 値段のほうを見ないので、どちらも同じ行に置く。ならしは既定（1.0）に固定する
  // ——上の表で、広げる側は寄り道を消すと分かったため。
  console.log('\n\n速い素材を、どこまで読むか（ならしは既定の 1.0 に固定 ・ 13 秒の素材）\n');
  console.log(
    `${pad('焼き方 → 読み方', 24)}${right('motion', 9)}${right('dart', 8)}${right('読む', 8)}${right('畳む', 8)}` +
      `${right('コマ', 7)}${right('メモリ', 9)}${right('10 分だと', 11)}`,
  );
  console.log('-'.repeat(84));
  for (const [bakeFps, readFps] of [
    [30, 15],
    [30, 30],
    [60, 15],
    [60, 30],
    [60, 60],
  ]) {
    const cells = [];
    let cost = null;
    for (const name of ['motion', 'subject-dart']) {
      const r = await run(name, readFps, { bakeFps, repeats: name === 'motion' ? REPEATS : 1 });
      cells.push(scoreFollow(sceneFixture(name), r.times, r.plans[0].centers, DEFAULT_REFRAME.cropWidth).inside);
      if (name === 'motion') {
        const seconds = r.times.length > 1 ? r.times[r.times.length - 1] - r.times[0] : 13;
        cost = {
          dec: Math.min(...r.decodeMs),
          sum: Math.min(...r.summarizeMs),
          frames: r.frames,
          mb: r.frameMb,
          seconds,
        };
      }
    }
    console.log(
      `${pad(`${bakeFps}fps を ${readFps}fps で`, 24)}${right(`${cells[0].toFixed(1)}%`, 9)}${right(`${cells[1].toFixed(1)}%`, 8)}` +
        `${right(`${cost.dec.toFixed(0)}ms`, 8)}${right(`${cost.sum.toFixed(0)}ms`, 8)}${right(cost.frames, 7)}` +
        `${right(`${cost.mb.toFixed(1)}MB`, 9)}${right(`${(((cost.dec + cost.sum) / cost.seconds) * 600 / 1000).toFixed(1)}s`, 11)}`,
    );
  }

  // ---------- 5. その 5 ポイントは、読み方の差か、当たり外れか ----------
  //
  // 4 の表は「30fps を 15fps へ間引いても落ちない（98.4% 対 97.9%）」のに
  // 「60fps を 15fps へだと落ちる（92.6% 対 97.5%）」と言っている。
  // **これを読み方の差と読む前に、同じ読み方の中でどれだけ振れるかを見る。**
  //
  // 振らせるのは**焼くビットレートだけ**。中身も速さも同じで、粒もほとんど動かない
  // （下の表の「粒」を見ること）。それでも数字が振れるなら、
  // その幅は**この判定の当たり外れ**であって、読み方の差ではない。
  console.log('\n\n同じ素材・同じ速さで、焼くビットレートだけ 5 通り（振れ幅は読み方の差か）\n');
  console.log(
    `${pad('素材', 16)}${right('15fps 読み', 20)}${right('振れ幅', 9)}${right('30fps 読み', 20)}${right('振れ幅', 9)}${right('粒（15/30）', 20)}`,
  );
  console.log('-'.repeat(94));
  const spreads = { 15: [], 30: [] };
  for (const name of ['motion', 'subject-pan', 'subject-decoy', 'subject-dart']) {
    const cells = [];
    for (const fps of READ_FPS) {
      const scores = [];
      const grains = [];
      for (const bitrate of BITRATES) {
        const r = await run(name, fps, { bakeFps: 30, bitrate });
        scores.push(scoreFollow(sceneFixture(name), r.times, r.plans[0].centers, DEFAULT_REFRAME.cropWidth).inside);
        grains.push(grain(r.plans[0].raws));
      }
      const lo = Math.min(...scores);
      const hi = Math.max(...scores);
      spreads[fps].push(hi - lo);
      cells.push({ lo, hi, spread: hi - lo, grain: median(grains) });
    }
    console.log(
      `${pad(name, 16)}${right(`${cells[0].lo.toFixed(1)}〜${cells[0].hi.toFixed(1)}%`, 20)}` +
        `${right(`${cells[0].spread.toFixed(1)}pt`, 9)}` +
        `${right(`${cells[1].lo.toFixed(1)}〜${cells[1].hi.toFixed(1)}%`, 20)}${right(`${cells[1].spread.toFixed(1)}pt`, 9)}` +
        `${right(`${cells[0].grain.toFixed(5)} / ${cells[1].grain.toFixed(5)}`, 20)}`,
    );
  }
  console.log('-'.repeat(94));
  console.log(
    `${pad('  振れ幅の中央値', 16)}${right('', 20)}${right(`${median(spreads[15]).toFixed(1)}pt`, 9)}` +
      `${right('', 20)}${right(`${median(spreads[30]).toFixed(1)}pt`, 9)}`,
  );

  if (errors.length) console.log(`\nページ例外: ${errors.join(' / ')}`);
} finally {
  await browser.close();
  server.stop();
}

/**
 * **寄り道のあいだだけ**を切り出して採点する。
 *
 * 「寄り道」は素材の折れ線を読んで決める——正解の位置が、その素材の中央値から
 * `deadband` 以上離れているコマ。秒を直に書かないのは、
 * **素材の折れ線を直したときに、ここだけ古い秒を見続けるのを避ける**ため。
 */
function excursion(fixture, times, plan) {
  const truths = times.map((t) => leadSubjectAt(fixture, t)?.u ?? NaN);
  const home = median(truths.filter((u) => Number.isFinite(u)));
  const raw = [];
  const target = [];
  const center = [];
  let inside = 0;
  for (let i = 0; i < times.length; i += 1) {
    if (!Number.isFinite(truths[i]) || Math.abs(truths[i] - home) < DEFAULT_REFRAME.deadband) continue;
    raw.push(Math.abs(truths[i] - plan.raws[i]));
    target.push(Math.abs(truths[i] - plan.targets[i]));
    const err = Math.abs(truths[i] - plan.centers[i]);
    center.push(err);
    if (err < DEFAULT_REFRAME.cropWidth / 2) inside += 1;
  }
  return {
    rawError: median(raw),
    targetError: median(target),
    centerError: median(center),
    inside: center.length ? (inside / center.length) * 100 : NaN,
  };
}
