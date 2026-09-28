/**
 * 表紙の候補選びが「実際どれくらい効くか」を、正解の分かっている素材で測る。
 *
 *   npm run lab:thumb
 *   LAB_ASPECT=portrait npm run lab:thumb   # 縦型（9:16 の切り出し）で測る
 *   LAB_COUNT=5 npm run lab:thumb           # 何枚選ぶかを変える
 *   LAB_NODIV=1 npm run lab:thumb           # 似た絵を避ける条件を外す（入れる前の振る舞い）
 *   LAB_GAP=0 npm run lab:thumb             # 時間で離す条件を外す
 *   LAB_SHARP=grad npm run lab:thumb        # 細かさの測り方を変える（cellRatio / grad / gradNet）
 *
 * **「駄目なコマを選ばなかった」だけを見ないこと。** 1 か所から 3 枚まとめて取れば
 * 駄目は避けられるが、それは表紙 3 枚ではなく同じ絵 3 枚。
 * 「良い所から選べた率」と「何場面に散ったか」を必ず併せて見る。
 *
 * 比べる相手（何も考えない選び方）も一緒に出す。**それに勝てないなら入れる意味が無い。**
 */

import { renderSpec } from '../fixtures/make-frames.mjs';
import { inRanges, thumbFixtures } from '../fixtures/thumbs.mjs';
import { sceneAspect } from '../fixtures/scenes.mjs';

const { summarizeThumbs } = await import('./src/thumb.ts');
const { summarizeFrames } = await import('../scene-cut/src/frames.ts');
const { DEFAULT_PICK, pickThumbnails } = await import('./src/pick.ts');

const aspect = process.env.LAB_ASPECT ?? 'landscape';
const view = sceneAspect(aspect);
const count = Number(process.env.LAB_COUNT ?? DEFAULT_PICK.count);
const options = {
  count,
  ...(process.env.LAB_NODIV ? { minDistance: 0 } : {}),
  ...(process.env.LAB_GAP ? { minGap: Number(process.env.LAB_GAP) } : {}),
  ...(process.env.LAB_DIST ? { minDistance: Number(process.env.LAB_DIST) } : {}),
  ...(process.env.LAB_SHARP ? { sharpness: process.env.LAB_SHARP } : {}),
  ...(process.env.LAB_BASE ? { floorBase: process.env.LAB_BASE } : {}),
  ...(process.env.LAB_FLOOR ? { qualityFloor: Number(process.env.LAB_FLOOR) } : {}),
};

const pad = (s, n) => String(s).padEnd(n, ' ');
const right = (s, n) => String(s).padStart(n, ' ');
const pct = (n, d) => (d > 0 ? `${((100 * n) / d).toFixed(1)}%` : '—');

/** その秒がどの場面に属するか（場面の切り所を書いた素材だけ）。 */
function shotOf(time, shots) {
  if (!shots) return null;
  let index = 0;
  for (let i = 0; i < shots.length; i += 1) if (time >= shots[i] - 1e-9) index = i;
  return index;
}

/**
 * 何も考えない選び方 2 つ。
 *   - `even`: 尺を等分して並べるだけ（いまの本体が「表紙」と言えばこれ）
 *   - `first`: 頭から順に count 枚（いちばん素朴）
 */
function evenPicks(times, n) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const t = ((i + 1) * times[times.length - 1]) / (n + 1);
    let best = 0;
    for (let k = 0; k < times.length; k += 1) if (Math.abs(times[k] - t) < Math.abs(times[best] - t)) best = k;
    out.push({ time: times[best], index: best });
  }
  return out;
}

function firstPicks(times, n) {
  return Array.from({ length: Math.min(n, times.length) }, (_, i) => ({ time: times[i], index: i }));
}

console.log(
  `表紙の候補選びの効き（正解と突き合わせ／向き ${aspect} ${view.label} ${view.width}×${view.height} ・ ${count} 枚）\n`,
);
console.log(
  `${pad('素材', 16)}${right('選んだ秒', 26)}${right('駄目', 6)}${right('良い所', 8)}` +
    `${right('場面', 6)}${right('ふつうの何倍', 14)}  ${'注'}`,
);
console.log('-'.repeat(104));

const totals = {
  ours: { picks: 0, bad: 0, good: 0, goodTotal: 0, shots: 0, shotsTotal: 0 },
  even: { picks: 0, bad: 0, good: 0, goodTotal: 0, shots: 0, shotsTotal: 0 },
  first: { picks: 0, bad: 0, good: 0, goodTotal: 0, shots: 0, shotsTotal: 0 },
};

function tally(name, fixture, picks) {
  const t = totals[name];
  t.picks += picks.length;
  let bad = 0;
  let good = 0;
  for (const p of picks) {
    if (inRanges(p.time, fixture.bad)) bad += 1;
    if (fixture.good.length > 0 && inRanges(p.time, fixture.good)) good += 1;
  }
  t.bad += bad;
  if (fixture.good.length > 0) {
    t.good += good;
    t.goodTotal += picks.length;
  }
  let shots = 0;
  if (fixture.shots) {
    shots = new Set(picks.map((p) => shotOf(p.time, fixture.shots))).size;
    t.shots += shots;
    t.shotsTotal += Math.min(picks.length, fixture.shots.length);
  }
  return { bad, good, shots };
}

// 素材を描くのがいちばん重い（1 本 0.4〜2.5 秒）ので、測った結果を取っておいて
// つまみを振る段で使い回す。
const cached = [];

for (const fixture of thumbFixtures()) {
  const clip = renderSpec(fixture, { aspect });
  const stats = summarizeThumbs(clip.frames, clip.times);
  const frameStats = summarizeFrames(clip.frames, clip.times);
  cached.push({ spec: fixture, stats, frameStats });
  const picks = pickThumbnails(stats, options.minDistance === 0 ? null : frameStats, options);

  const ours = tally('ours', fixture, picks);
  tally('even', fixture, evenPicks(clip.times, count));
  tally('first', fixture, firstPicks(clip.times, count));

  const notes = [];
  if (fixture.bad.length && ours.bad > 0) {
    const why = fixture.bad.find((r) => picks.some((p) => p.time >= r.from && p.time <= r.to));
    notes.push(`駄目 ${ours.bad} 枚（${why?.why ?? ''}）`);
  }
  const relaxed = picks.filter((p) => p.relaxed);
  if (relaxed.length) notes.push(`${relaxed.length} 枚は条件を緩めて（${relaxed.map((p) => p.relaxed).join('・')}）`);
  if (fixture.hard) notes.unshift('※');

  console.log(
    pad(fixture.name, 16) +
      right(picks.map((p) => p.time.toFixed(2)).join(' '), 26) +
      right(fixture.bad.length ? String(ours.bad) : '—', 6) +
      right(fixture.good.length ? `${ours.good}/${picks.length}` : '—', 8) +
      right(fixture.shots ? `${ours.shots}/${Math.min(picks.length, fixture.shots.length)}` : '—', 6) +
      right(picks.map((p) => p.relative.toFixed(2)).join(' '), 14) +
      '  ' +
      notes.join(' / '),
  );
}

console.log('-'.repeat(104));
console.log('\n全体（選んだ枚数のうち）\n');
console.log(`${pad('選び方', 20)}${right('駄目なコマ', 12)}${right('良い所から', 12)}${right('場面の網羅', 12)}`);
console.log('-'.repeat(56));
for (const [name, label] of [
  ['ours', '点で選ぶ（いま）'],
  ['even', '等間隔に選ぶ'],
  ['first', '頭から選ぶ'],
]) {
  const t = totals[name];
  console.log(
    pad(label, 20) +
      right(`${t.bad} / ${t.picks}（${pct(t.bad, t.picks)}）`, 12) +
      right(`${pct(t.good, t.goodTotal)}`, 12) +
      right(`${pct(t.shots, t.shotsTotal)}`, 12),
  );
}

// --- つまみを振る ---
//
// 既定の値が「測って取った台の真ん中」なのか、「たまたま当たった 1 点」なのかを出す。
// 1 点しか通らないつまみは、素材が 1 本増えれば外れる。
console.log('\nつまみを振る（駄目なコマ / 良い所から / 場面の網羅）\n');

function summarize(opts) {
  const t = { picks: 0, bad: 0, good: 0, goodTotal: 0, shots: 0, shotsTotal: 0 };
  for (const fixture of cached) {
    const picks = pickThumbnails(fixture.stats, opts.minDistance === 0 ? null : fixture.frameStats, opts);
    t.picks += picks.length;
    for (const p of picks) {
      if (inRanges(p.time, fixture.spec.bad)) t.bad += 1;
      if (fixture.spec.good.length > 0 && inRanges(p.time, fixture.spec.good)) t.good += 1;
    }
    if (fixture.spec.good.length > 0) t.goodTotal += picks.length;
    if (fixture.spec.shots) {
      t.shots += new Set(picks.map((p) => shotOf(p.time, fixture.spec.shots))).size;
      t.shotsTotal += Math.min(picks.length, fixture.spec.shots.length);
    }
  }
  return `${pct(t.bad, t.picks)} / ${pct(t.good, t.goodTotal)} / ${pct(t.shots, t.shotsTotal)}`;
}

for (const [label, key, values] of [
  ['出来の下限（qualityFloor）', 'qualityFloor', [0, 0.25, 0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95]],
  ['似すぎの線（minDistance）', 'minDistance', [0, 0.02, 0.05, 0.08, 0.1, 0.15, 0.2, 0.3, 0.5]],
  ['時間で離す（minGap 秒）', 'minGap', [0, 0.25, 0.5, 1.0, 1.5, 2.0, 3.0]],
  ['明るすぎの線（flashHigh）', 'flashHigh', [1.15, 1.2, 1.3, 1.4, 1.6, 2.0, 99]],
  ['周りを見る幅（flashWindow 秒）', 'flashWindow', [0.2, 0.3, 0.5, 0.8, 1.2, 2.0]],
  ['細かさの測り方（sharpness）', 'sharpness', ['cellRatio', 'cellMoving', 'grad', 'gradNet']],
  ['下限を何と比べるか（floorBase）', 'floorBase', ['top', 'median']],
]) {
  console.log(pad(label, 32) + values.map((v) => pad(v, 22)).join(''));
  console.log(pad('', 32) + values.map((v) => pad(summarize({ ...options, [key]: v }), 22)).join(''));
  console.log('');
}
