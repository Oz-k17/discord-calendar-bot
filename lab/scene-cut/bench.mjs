/**
 * シーン検出が「実際どれくらい効くか」を、正解の分かっている素材で測る。
 *
 *   npm run lab:scene
 *   npm run lab:scene:portrait          # 縦型（9:16 の切り出し）で測る
 *   npm run lab:scene:native            # 縦型（最初から縦で撮った）で測る
 *   LAB_CAPTIONS=0.26 npm run lab:scene # 全素材へ焼き込みの文字帯を乗せて測る
 *   LAB_FPS=30 npm run lab:scene      # コマの速さを変えて測る（つまみはコマ数で効く）
 *   LAB_NOGATE=1 npm run lab:scene   # またいだ距離の門を外す（入れる前の振る舞い）
 *   LAB_METRIC=grid npm run lab:scene
 *   LAB_LOCAL=off npm run lab:scene   # その場と比べる線を外す（入れる前の振る舞い）
 *
 * **見つけた本数だけを見ないこと。** 全部のコマを境界にすれば正解は全部見つかるが、
 * それは素材を 1 コマずつに割っているだけ。「見つけた率」と「当てた率」を必ず併せて見る。
 */

import { SCENE_FIXTURES, SCENE_FPS, sceneAspect } from '../fixtures/scenes.mjs';
import { renderFixture } from '../fixtures/make-frames.mjs';
// 採点は画面の確認（`uitest.mjs`）と同じものを使う。分けて持つと、
// 数字が食い違ったときに判定のせいか数え方のせいかが分からなくなる。
import { scoreBoundaries, toleranceFor } from './score.mjs';

const { summarizeFrames } = await import('./src/frames.ts');
const { DEFAULT_SCENE_CUT, planSceneCut } = await import('./src/scene.ts');
const { toClipEdits } = await import('../auto-cut/src/edits.ts');

// 向きとコマの速さは素材の側の話なので、判定の設定（`options`）とは分けて持つ。
const aspect = process.env.LAB_ASPECT ?? 'landscape';
const view = sceneAspect(aspect);
const fps = Number(process.env.LAB_FPS ?? SCENE_FPS);
// 焼き込みの文字帯を**全素材に**乗せて測る口（画面の高さの何割を覆うか）。
// 短尺の実素材はたいてい字幕が焼かれているので、そのときの効きが既定の数字と別に要る。
const captionCover = Number(process.env.LAB_CAPTIONS ?? 0);
// 読めない値を黙って 0 にすると、「帯を乗せたつもりで乗っていない表」が出てしまう。
if (!Number.isFinite(captionCover) || captionCover < 0 || captionCover >= 1) {
  throw new Error(`LAB_CAPTIONS は 0 以上 1 未満です（${process.env.LAB_CAPTIONS}）`);
}

const options = {
  ...(process.env.LAB_NOGATE ? { straddleThreshold: 0 } : {}),
  ...(process.env.LAB_METRIC ? { metric: process.env.LAB_METRIC } : {}),
  ...(process.env.LAB_THRESHOLD ? { threshold: Number(process.env.LAB_THRESHOLD) } : {}),
  ...(process.env.LAB_LOCAL ? { localRatio: process.env.LAB_LOCAL === 'off' ? null : Number(process.env.LAB_LOCAL) } : {}),
  ...(process.env.LAB_LOCAL_W ? { localWindow: Number(process.env.LAB_LOCAL_W) } : {}),
};

const pad = (s, n) => String(s).padEnd(n, ' ');
const right = (s, n) => String(s).padStart(n, ' ');

console.log(
  `シーン検出の効き（正解と突き合わせ／向き ${aspect} ${view.label} ${view.width}×${view.height} ・ ${fps}fps` +
    `${captionCover > 0 ? ` ・ 文字帯 ${(captionCover * 100).toFixed(0)}%` : ''}）\n`,
);
console.log(
  `${pad('素材', 20)}${right('正解', 5)}${right('見つけた', 9)}${right('当たり', 7)}` +
    `${right('見逃し', 7)}${right('空振り', 7)}${right('ずれ(s)', 9)}  ${'落とした候補'}`,
);
console.log('-'.repeat(96));

let totalTruth = 0;
let totalFound = 0;
let totalHit = 0;
const offsets = [];
const details = [];

for (const fixture of SCENE_FIXTURES) {
  const clip = renderFixture(fixture.name, { aspect, fps, captionCover });
  const stats = summarizeFrames(clip.frames, clip.times);
  const plan = planSceneCut(stats, options);

  const tol = toleranceFor(fixture.name);
  const truth = clip.cuts.slice();
  const score = scoreBoundaries(
    plan.boundaries.map((b) => b.time),
    truth,
    tol,
  );
  const { hit, missed, spurious, meanOffset } = score;

  totalTruth += truth.length;
  totalFound += plan.boundaries.length;
  totalHit += hit;
  offsets.push(...score.offsets);

  const byReason = {};
  for (const r of plan.rejected) byReason[r.reason] = (byReason[r.reason] ?? 0) + 1;
  const reasons = Object.entries(byReason)
    .map(([k, v]) => `${k} ${v}`)
    .join(' / ');

  console.log(
    `${pad((fixture.hard ? '※ ' : '  ') + fixture.name, 20)}${right(truth.length, 5)}` +
      `${right(plan.boundaries.length, 9)}${right(hit, 7)}${right(missed, 7)}${right(spurious, 7)}` +
      `${right(meanOffset === null ? '—' : meanOffset.toFixed(3), 9)}  ${reasons}`,
  );

  details.push({ fixture, plan, truth, tol, spurious, missed });
}

console.log('-'.repeat(96));
const recall = totalTruth ? (totalHit / totalTruth) * 100 : 0;
const precision = totalFound ? (totalHit / totalFound) * 100 : 0;
const meanOffset = offsets.length ? offsets.reduce((a, b) => a + b, 0) / offsets.length : 0;
console.log(
  `${pad('  ぜんぶ', 20)}${right(totalTruth, 5)}${right(totalFound, 9)}${right(totalHit, 7)}` +
    `${right(totalTruth - totalHit, 7)}${right(totalFound - totalHit, 7)}${right(meanOffset.toFixed(3), 9)}`,
);
console.log(
  `\n  見つけた率（正解のうち見つけた割合） ${recall.toFixed(1)}%` +
    `   ／   当てた率（見つけたうち正解だった割合） ${precision.toFixed(1)}%`,
);
console.log(`  設定: ${JSON.stringify({ ...DEFAULT_SCENE_CUT, ...options })}`);

// --- 外した所の中身 ---
console.log('\n\n外した所の中身（空振りと見逃しだけ）\n');
let printed = 0;
for (const d of details) {
  if (!d.spurious && !d.missed) continue;
  printed += 1;
  const hitTimes = new Set();
  for (const b of d.plan.boundaries) {
    if (d.truth.some((c) => Math.abs(c - b.time) <= d.tol)) hitTimes.add(b.time);
  }
  const spurious = d.plan.boundaries.filter((b) => !hitTimes.has(b.time));
  const missed = d.truth.filter((c) => !d.plan.boundaries.some((b) => Math.abs(c - b.time) <= d.tol));
  console.log(`※ ${d.fixture.name}  — ${d.fixture.note}`);
  if (spurious.length) {
    console.log(
      `    空振り ${spurious.length} 本: ` +
        spurious
          .map(
            (b) =>
              `${b.time.toFixed(2)}s(距離 ${b.distance.toFixed(3)} / 門 ${b.straddle.toFixed(3)} / ` +
              `比 ${Number.isFinite(b.local) ? b.local.toFixed(1) : '∞'})`,
          )
          .join(', '),
    );
  }
  if (missed.length) console.log(`    見逃し ${missed.length} 本: ${missed.map((c) => `${c.toFixed(2)}s`).join(', ')}`);
}
if (!printed) console.log('  ありません。');

// --- 切ったあとのクリップ ---
//
// 本体へ持っていくときの継ぎ目を、数字で 1 度だけ通しておく。
// 場面は隙間なく並ぶので、`toClipEdits` に渡すと尺が 1 秒も減らないはず。
console.log('\n\n切ったあとのクリップ（auto-cut の edits.ts へそのまま渡した）\n');
{
  const clip = renderFixture('cuts-plain', { aspect, fps, captionCover });
  const stats = summarizeFrames(clip.frames, clip.times);
  const plan = planSceneCut(stats, options);
  const placement = { start: 10, duration: 13, sourceIn: 0 };
  const edits = toClipEdits(plan.scenes, placement);
  const total = edits.reduce((s, e) => s + e.duration, 0);
  console.log(`  cuts-plain: ${edits.length} 本へ割れた（尺の合計 ${total.toFixed(2)}s / もと ${placement.duration}s）`);
  for (const e of edits) {
    console.log(
      `    タイムライン ${e.start.toFixed(2)}s から ${e.duration.toFixed(2)}s（素材の ${e.from.start.toFixed(2)}〜${e.from.end.toFixed(2)}s）`,
    );
  }
}
