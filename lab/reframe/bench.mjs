/**
 * 自動リフレームが「実際どれくらい効くか」を、正解の分かっている素材で測る。
 *
 *   npm run lab:reframe
 *   LAB_RF_DEAD=0.06 LAB_RF_SPEED=0.22 LAB_RF_SETTLE=0.3 LAB_RF_SMOOTH=0.33 npm run lab:reframe
 *   LAB_RF_LEADIN=off npm run lab:reframe   # 頭を真ん中から始める（入れる前の振る舞い）
 *   LAB_FPS=30 npm run lab:reframe          # コマの速さを変えて測る（つまみは秒で書いてある）
 *
 * **入れた率だけを見ないこと。** 枠を毎コマ被写体へ貼り付ければ 100% になるが、
 * それは出来上がりが手ぶれ映像になっているだけ。
 * **被写体の居ない素材で枠がどれだけ泳いだか**（下の表）を必ず併せて見る。
 * 比べる相手は「ずっと真ん中」で、そちらは泳ぎ 0.000 ・入れた率だけが落ちる。
 */

import { REFRAME_FIXTURES, SCENE_FIXTURES, SCENE_FPS, leadSubjectAt } from '../fixtures/scenes.mjs';
import { renderFixture } from '../fixtures/make-frames.mjs';

const { FULL_BAND } = await import('./src/columns.ts');
const { DEFAULT_REFRAME, planReframe, summarizeForReframe } = await import('./src/reframe.ts');

const fps = Number(process.env.LAB_FPS ?? SCENE_FPS);
const options = {
  ...(process.env.LAB_RF_DEAD ? { deadband: Number(process.env.LAB_RF_DEAD) } : {}),
  ...(process.env.LAB_RF_SPEED ? { maxSpeed: Number(process.env.LAB_RF_SPEED) } : {}),
  ...(process.env.LAB_RF_SETTLE ? { settle: Number(process.env.LAB_RF_SETTLE) } : {}),
  ...(process.env.LAB_RF_SMOOTH ? { smooth: Number(process.env.LAB_RF_SMOOTH) } : {}),
  ...(process.env.LAB_RF_LEADIN ? { leadIn: process.env.LAB_RF_LEADIN !== 'off' } : {}),
};
// 列へ畳むときに見る縦の範囲。既定は上下 15% を落とす（`LAB_RF_BAND=0,1` で全部に戻せる）。
if (process.env.LAB_RF_BAND) {
  const [from, to] = process.env.LAB_RF_BAND.split(',').map(Number);
  options.rowBand = from === 0 && to === 1 ? FULL_BAND : { from, to };
}
// **つまみを足したあとに読む。** 先に読むと、表の頭に書く設定だけが古いままになる。
const opt = { ...DEFAULT_REFRAME, ...options };
const half = opt.cropWidth / 2;

const pad = (s, n) => String(s).padEnd(n, ' ');
const right = (s, n) => String(s).padStart(n, ' ');
const median = (xs) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
};

/** 素材 1 本を測る。`center` は枠の中心を返す関数（比べる相手を差し替えるため）。 */
function measure(fixture, centersOf) {
  const clip = renderFixture(fixture.name, { fps });
  const cols = summarizeForReframe(clip.frames, clip.times, options);
  const { centers, travel } = centersOf(cols);
  const errors = [];
  let inside = 0;
  let counted = 0;
  for (let i = 0; i < cols.length; i += 1) {
    const truth = leadSubjectAt(fixture, clip.times[i]);
    if (!truth) continue;
    // 画面の外に居るコマは追いようが無いので数えない。
    if (truth.u < 0 || truth.u > 1) continue;
    counted += 1;
    const err = Math.abs(truth.u - centers[i]);
    errors.push(err);
    if (err < half) inside += 1;
  }
  const seconds = clip.times[clip.times.length - 1] - clip.times[0];
  return {
    inside: counted ? (inside / counted) * 100 : null,
    error: median(errors),
    swim: seconds > 0 ? travel / seconds : 0,
    counted,
  };
}

const planned = (cols) => {
  const plan = planReframe(cols, options);
  return { centers: plan.frames.map((f) => f.center), travel: plan.travel };
};
// 比べる相手: **何もしない**（ずっと真ん中を切る）。
// これが置いてないと「入れた率 80%」が良いのか悪いのかが分からない。
const fixed = (cols) => ({ centers: cols.map(() => 0.5), travel: 0 });

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

/**
 * **カットの直後に枠を置き直すのは正しい振る舞い**なので、泳ぎから外す。
 *
 * 場面が変われば構図も変わるから、そこで枠が動くのは「泳いだ」ではなく「組み直した」。
 * 外さずに数えると、カットの多い素材ほど悪く見えて、
 * **直すべきでない所を直しにいく**ことになる。
 *
 * ただし**「カットから 0.6 秒のあいだのコマを外す」では足りない**（測って分かった）。
 * 寄せの上限は 0.22/s なので、端から端まで組み直すのに 3 秒以上かかる。
 * コマで外すと、組み直しの**大半が窓の外に落ちて泳ぎに数えられる**。
 * なので外すのは**寄せ直しのひと続き（run）ごと**で、
 * **その始まりがカットから 0.6 秒以内なら、その run は丸ごと組み直し**とみなす。
 */
const AFTER_CUT = 0.6;

/** 枠が動いたひと続きを、始まった時刻つきで取り出す。 */
function movingRuns(plan, times) {
  const runs = [];
  let open = null;
  for (let i = 1; i < plan.frames.length; i += 1) {
    const moved = Math.abs(plan.frames[i].center - plan.frames[i - 1].center);
    if (moved > 0) {
      if (!open) open = { start: times[i - 1], travel: 0 };
      open.travel += moved;
    } else if (open) {
      runs.push(open);
      open = null;
    }
  }
  if (open) runs.push(open);
  return runs;
}

console.log('\n\n被写体の居ない素材（泳いでいないか。0.000 が正解）\n');
console.log(`${pad('素材', 22)}${right('泳ぎ/s', 9)}${right('回数', 7)}${right('組み直し/s', 11)}${right('振れ幅', 9)}`);
console.log('-'.repeat(58));
const idleSwims = [];
let worst = null;
for (const f of without) {
  const clip = renderFixture(f.name, { fps });
  const cols = summarizeForReframe(clip.frames, clip.times, options);
  const plan = planReframe(cols, options);
  const centers = plan.frames.map((p) => p.center);
  const seconds = clip.times[clip.times.length - 1] - clip.times[0];
  // カット由来の組み直しを除いた泳ぎ。素材の頭（leadIn の置き所）は動きに数えていない。
  const runs = movingRuns(plan, clip.times);
  const isRecompose = (r) => clip.cuts.some((c) => r.start >= c - 1 / fps && r.start < c + AFTER_CUT);
  const wander = runs.filter((r) => !isRecompose(r));
  const swim = seconds > 0 ? wander.reduce((a, r) => a + r.travel, 0) / seconds : 0;
  const recompose = seconds > 0 ? runs.filter(isRecompose).reduce((a, r) => a + r.travel, 0) / seconds : 0;
  const range = Math.max(...centers) - Math.min(...centers);
  idleSwims.push(swim);
  if (!worst || swim > worst.swim) worst = { name: f.name, swim, range };
  console.log(
    `${pad('  ' + f.name, 22)}${right(swim.toFixed(3), 9)}${right(wander.length, 7)}` +
      `${right(recompose.toFixed(3), 11)}${right(range.toFixed(3), 9)}`,
  );
}
console.log('-'.repeat(58));
console.log(
  `${pad('  中央値', 22)}${right(median(idleSwims).toFixed(3), 9)}\n` +
    `${pad('  いちばん泳いだ素材', 22)}${right(worst.swim.toFixed(3), 9)}${right('', 18)}${right(worst.range.toFixed(3), 9)}  ${worst.name}`,
);
