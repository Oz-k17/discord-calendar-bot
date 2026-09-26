/**
 * 自動リフレームが「実際どれくらい効くか」を、正解の分かっている素材で測る。
 *
 *   npm run lab:reframe
 *   LAB_RF_DEAD=0.06 LAB_RF_SPEED=0.22 LAB_RF_SETTLE=0.3 LAB_RF_SMOOTH=0.33 npm run lab:reframe
 *   LAB_RF_LEADIN=off npm run lab:reframe   # 頭を真ん中から始める（入れる前の振る舞い）
 *   LAB_RF_GATE=step npm run lab:reframe    # 門の形を替える（step / release / ramp / soft）
 *   LAB_FPS=30 npm run lab:reframe          # コマの速さを変えて測る（つまみは秒で書いてある）
 *
 * **入れた率だけを見ないこと。** 枠を毎コマ被写体へ貼り付ければ 100% になるが、
 * それは出来上がりが手ぶれ映像になっているだけ。
 * **被写体の居ない素材で枠がどれだけ泳いだか**（下の表）を必ず併せて見る。
 * 比べる相手は「ずっと真ん中」で、そちらは泳ぎ 0.000 ・入れた率だけが落ちる。
 */

import { REFRAME_FIXTURES, SCENE_FIXTURES, SCENE_FPS, leadSubjectAt } from '../fixtures/scenes.mjs';
import { renderFixture } from '../fixtures/make-frames.mjs';
// 採点は `score.mjs` に置いてある。**画面の確認（`uitest.mjs`）と同じ関数を呼ぶ**ためで、
// ここに書き直すと、画面と食い違ったときに判定の違いか採点の違いかが読めなくなる。
import { median, scoreFollow, scoreSwim, totalSwim } from './score.mjs';

const { FULL_BAND } = await import('./src/columns.ts');
const { DEFAULT_REFRAME, planReframe, summarizeForReframe } = await import('./src/reframe.ts');

const fps = Number(process.env.LAB_FPS ?? SCENE_FPS);
const options = {
  ...(process.env.LAB_RF_DEAD ? { deadband: Number(process.env.LAB_RF_DEAD) } : {}),
  ...(process.env.LAB_RF_SPEED ? { maxSpeed: Number(process.env.LAB_RF_SPEED) } : {}),
  ...(process.env.LAB_RF_SETTLE ? { settle: Number(process.env.LAB_RF_SETTLE) } : {}),
  ...(process.env.LAB_RF_SMOOTH ? { smooth: Number(process.env.LAB_RF_SMOOTH) } : {}),
  ...(process.env.LAB_RF_LEADIN ? { leadIn: process.env.LAB_RF_LEADIN !== 'off' } : {}),
  // 門の形（`step` / `release` / `ramp` / `soft`）。**合成コマでは振れ幅は測れない**
  // （粒が乗らないので焼き直しの当たり外れが出ない）ので、ここで見るのは
  // 「追えているか・泳いでいないか」のほうだけ。振れ幅は `lab:reframe:gate`。
  ...(process.env.LAB_RF_GATE ? { gate: process.env.LAB_RF_GATE } : {}),
  ...(process.env.LAB_RF_RAMP ? { gateRamp: Number(process.env.LAB_RF_RAMP) } : {}),
};
// 列へ畳むときに見る縦の範囲。既定は上下 15% を落とす（`LAB_RF_BAND=0,1` で全部に戻せる）。
if (process.env.LAB_RF_BAND) {
  const [from, to] = process.env.LAB_RF_BAND.split(',').map(Number);
  options.rowBand = from === 0 && to === 1 ? FULL_BAND : { from, to };
}
// **つまみを足したあとに読む。** 先に読むと、表の頭に書く設定だけが古いままになる。
const opt = { ...DEFAULT_REFRAME, ...options };

const pad = (s, n) => String(s).padEnd(n, ' ');
const right = (s, n) => String(s).padStart(n, ' ');

/** 素材 1 本を測る。`centersOf` は枠の中心を返す関数（比べる相手を差し替えるため）。 */
function measure(fixture, centersOf) {
  const clip = renderFixture(fixture.name, { fps });
  const cols = summarizeForReframe(clip.frames, clip.times, options);
  const centers = centersOf(cols);
  const follow = scoreFollow(fixture, clip.times, centers, opt.cropWidth);
  return { ...follow, swim: totalSwim(clip.times, centers) };
}

const planned = (cols) => planReframe(cols, options).frames.map((f) => f.center);
// 比べる相手: **何もしない**（ずっと真ん中を切る）。
// これが置いてないと「入れた率 80%」が良いのか悪いのかが分からない。
const fixed = (cols) => cols.map(() => 0.5);

const withSubject = [...SCENE_FIXTURES, ...REFRAME_FIXTURES].filter((f) => leadSubjectAt(f, 6.5));
const without = SCENE_FIXTURES.filter((f) => !leadSubjectAt(f, 6.5));

console.log(`自動リフレームの効き（正解と突き合わせ・横型 16:9 から 9:16 を切る ・ ${fps}fps）\n`);
console.log(`  設定: ${JSON.stringify(opt)}\n`);

console.log('被写体の居る素材（追えているか）\n');
console.log(
  `${pad('素材', 20)}${right('コマ', 6)}${right('入れた率', 10)}${right('ずれ', 8)}${right('泳ぎ/s', 9)}` +
    `   ${right('真ん中の入れた率', 18)}${right('ずれ', 8)}`,
);
console.log('-'.repeat(84));

let sumIn = 0;
let sumFixedIn = 0;
const allErrors = [];
const swims = [];
for (const f of withSubject) {
  const a = measure(f, planned);
  const b = measure(f, fixed);
  sumIn += a.inside;
  sumFixedIn += b.inside;
  allErrors.push(a.error);
  swims.push(a.swim);
  console.log(
    `${pad((f.hard ? '※ ' : '  ') + f.name, 20)}${right(a.counted, 6)}${right(`${a.inside.toFixed(1)}%`, 10)}` +
      `${right(a.error.toFixed(3), 8)}${right(a.swim.toFixed(3), 9)}   ` +
      `${right(`${b.inside.toFixed(1)}%`, 18)}${right(b.error.toFixed(3), 8)}`,
  );
}
console.log('-'.repeat(84));
console.log(
  `${pad('  ぜんぶ', 20)}${right('', 6)}${right(`${(sumIn / withSubject.length).toFixed(1)}%`, 10)}` +
    `${right(median(allErrors).toFixed(3), 8)}${right(median(swims).toFixed(3), 9)}   ` +
    `${right(`${(sumFixedIn / withSubject.length).toFixed(1)}%`, 18)}`,
);

console.log('\n\n被写体の居ない素材（泳いでいないか。0.000 が正解）\n');
// **合計（泳ぎ＋組み直し）も出す。** 2026-09-25（3 回目）に足した。
// 泳ぎと組み直しの境目は「run がどこで始まったか」で決まるので、
// **枠の動き方が変わると、同じ動きが別の欄へ移る**（`cuts-plain` で 0.071 が丸ごと移った）。
// 合計を並べておけば、増えたのか付け替わっただけなのかがその場で読める。
console.log(`${pad('素材', 22)}${right('泳ぎ/s', 9)}${right('回数', 7)}${right('組み直し/s', 11)}${right('合計/s', 9)}${right('振れ幅', 9)}`);
console.log('-'.repeat(67));
const idleSwims = [];
const totals = [];
let worst = null;
for (const f of without) {
  const clip = renderFixture(f.name, { fps });
  const cols = summarizeForReframe(clip.frames, clip.times, options);
  const centers = planReframe(cols, options).frames.map((p) => p.center);
  // カット由来の組み直しを除いた泳ぎ。素材の頭（leadIn の置き所）は動きに数えていない。
  const { swim, wanders, recompose, range } = scoreSwim(clip.times, centers, clip.cuts, fps);
  idleSwims.push(swim);
  if (!worst || swim > worst.swim) worst = { name: f.name, swim, range };
  totals.push(swim + recompose);
  console.log(
    `${pad('  ' + f.name, 22)}${right(swim.toFixed(3), 9)}${right(wanders, 7)}` +
      `${right(recompose.toFixed(3), 11)}${right((swim + recompose).toFixed(3), 9)}${right(range.toFixed(3), 9)}`,
  );
}
console.log('-'.repeat(67));
console.log(
  `${pad('  中央値', 22)}${right(median(idleSwims).toFixed(3), 9)}${right('', 18)}${right(median(totals).toFixed(3), 9)}\n` +
    `${pad('  いちばん泳いだ素材', 22)}${right(worst.swim.toFixed(3), 9)}${right('', 18)}${right('', 9)}${right(worst.range.toFixed(3), 9)}  ${worst.name}`,
);
