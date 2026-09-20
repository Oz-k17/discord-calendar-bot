/**
 * 「どの量ならカットの切り替わりを見分けられるか」を、正解の分かっている素材で測る。
 *
 *   npm run lab:scene:probe
 *
 * **実装する前に**ここで並べて比べる。思いつきで 1 つ選んで実装すると、
 * たまたま手元の素材で効いただけのものを掴む（音の側で 9 回やった）。
 *
 * 出す数字は 3 つ:
 *   1. AUC（0.5 = まったく分けられない、1.0 = 完全に分けられる）
 *   2. **素材ごとの「正解の最小」と「それ以外の最大」** — 線が引けるかはこちらで決まる
 *   3. またいだ距離との比（フラッシュのような「戻ってくる」変化を見分けられるか）
 */

import { SCENE_FIXTURES } from '../fixtures/scenes.mjs';
import { renderFixture } from '../fixtures/make-frames.mjs';

const { DISTANCES, summarizeFrames } = await import('./src/frames.ts');

const NAMES = Object.keys(DISTANCES);
/** またぎを何コマ先まで見るか。1 コマ（＝隣の隣）と 3 コマ（＝0.2 秒先）。 */
const STRADDLE = [1, 3];

/** 渡りが瞬間ではない素材。正解のコマが 1 枚に決まらないので AUC からは外す。 */
const GRADUAL = new Set(['dissolve', 'fade-black']);

const pad = (s, n) => String(s).padEnd(n, ' ');
const num = (v, d = 3) => (v === null || v === undefined || Number.isNaN(v) ? '—' : v.toFixed(d)).padStart(9) + '   ';

/** 素材 1 本を測って、コマごとの距離と正解ラベルを返す。 */
function measure(fixture) {
  const clip = renderFixture(fixture.name);
  const stats = summarizeFrames(clip.frames, clip.times);
  const half = 0.5 / clip.fps;

  const rows = [];
  for (let i = 1; i < stats.length; i += 1) {
    const values = {};
    for (const name of NAMES) values[name] = DISTANCES[name](stats[i - 1], stats[i]);
    // またいだ距離: 1 つ前と、K コマ後ろを直に比べる。
    // カットなら新しい場面が残り続けるので縮まない。フラッシュのように戻る変化なら消える。
    const across = {};
    for (const k of STRADDLE) {
      across[k] = {};
      if (i + k < stats.length) {
        for (const name of NAMES) across[k][name] = DISTANCES[name](stats[i - 1], stats[i + k]);
      }
    }
    const t = stats[i].time;
    const isCut = clip.cuts.some((c) => Math.abs(c - t) <= half);
    rows.push({ index: i, time: t, values, across, isCut });
  }
  return { clip, stats, rows };
}

/** AUC（順位で数える。同値は 0.5 と数える）。 */
function auc(positive, negative) {
  if (!positive.length || !negative.length) return null;
  let wins = 0;
  for (const p of positive) for (const n of negative) wins += p > n ? 1 : p === n ? 0.5 : 0;
  return wins / (positive.length * negative.length);
}

const measured = SCENE_FIXTURES.map((f) => ({ fixture: f, ...measure(f) }));

// --- 1. 素材ごとの AUC ---
console.log('カットのコマとそれ以外のコマを、どれくらい分けられるか（AUC / 0.5 = 分けられない）\n');
console.log(`${pad('素材', 18)}${NAMES.map((n) => pad(n, 12)).join('')}`);
console.log('-'.repeat(18 + NAMES.length * 12));

const pooled = Object.fromEntries(NAMES.map((n) => [n, { positive: [], negative: [] }]));
for (const m of measured) {
  if (GRADUAL.has(m.fixture.name)) continue;
  const row = NAMES.map((name) => {
    const positive = m.rows.filter((r) => r.isCut).map((r) => r.values[name]);
    const negative = m.rows.filter((r) => !r.isCut).map((r) => r.values[name]);
    pooled[name].positive.push(...positive);
    pooled[name].negative.push(...negative);
    const v = auc(positive, negative);
    return (v === null ? '—' : v.toFixed(3)).padStart(9) + '   ';
  }).join('');
  console.log(`${pad((m.fixture.hard ? '※ ' : '  ') + m.fixture.name, 18)}${row}`);
}
console.log('-'.repeat(18 + NAMES.length * 12));
console.log(
  `${pad('  まとめて', 18)}${NAMES.map((n) => num(auc(pooled[n].positive, pooled[n].negative))).join('')}`,
);
console.log('\n※ = 意地悪な素材。カットの無い素材は正解が 0 本なので「—」になる（負の側にだけ効く）。');
console.log('   ディゾルブとフェードは渡りが瞬間ではないので、この表からは外してある。');

// --- 2. 線が引けるか（素材ごとの最小と最大） ---
console.log('\n\n線が引けるか: 正解のコマの最小 ／ カットでないコマの最大\n');
console.log(`${pad('素材', 18)}${NAMES.map((n) => pad(n, 20)).join('')}`);
console.log('-'.repeat(18 + NAMES.length * 20));
for (const m of measured) {
  if (GRADUAL.has(m.fixture.name)) continue;
  const row = NAMES.map((name) => {
    const positive = m.rows.filter((r) => r.isCut).map((r) => r.values[name]);
    const negative = m.rows.filter((r) => !r.isCut).map((r) => r.values[name]);
    const lo = positive.length ? Math.min(...positive).toFixed(3) : '—';
    const hi = negative.length ? Math.max(...negative).toFixed(3) : '—';
    return pad(`${lo} / ${hi}`, 20);
  }).join('');
  console.log(`${pad((m.fixture.hard ? '※ ' : '  ') + m.fixture.name, 18)}${row}`);
}
console.log('-'.repeat(18 + NAMES.length * 20));
{
  const row = NAMES.map((name) => {
    const lo = Math.min(...pooled[name].positive).toFixed(3);
    const hi = Math.max(...pooled[name].negative).toFixed(3);
    return pad(`${lo} / ${hi}`, 20);
  }).join('');
  console.log(`${pad('  ぜんぶ', 18)}${row}`);
}
console.log('\n左が右より大きければ、その量ひとつで線が引ける。');

// --- 3. 前後をまたいで比べると、門になるか ---
//
// 隣どうしの距離（`adj`）は、カットでもフラッシュでも同じだけ立つ。
// カットなら**前と後ろが別の場面**、フラッシュなら**前と後ろは同じ場面**なので、
// 1 コマだけ飛ばすのではなく、変化そのものをまたいで前後を比べる。
console.log('\n\nまたいで比べると門になるか（K コマ前と K コマ後ろを直に比べる）\n');
console.log('adj = 隣どうしの距離（lumaHist）。これを 0.10 で切ったものを候補とする。');
console.log('gate = またいだ距離。カットなら残り、戻ってくる変化なら消える。\n');
console.log(`${pad('素材', 18)}${[2, 3, 4, 5, 6].map((k) => pad(`K=${k}`, 18)).join('')}`);
console.log(`${pad('', 18)}${[2, 3, 4, 5, 6].map(() => pad('正解の最小/誤りの最大', 18)).join('')}`);
console.log('-'.repeat(18 + 5 * 18));

const CANDIDATE_LINE = 0.1;
const gatePooled = {};
for (const k of [2, 3, 4, 5, 6]) gatePooled[k] = { hit: [], miss: [] };

for (const m of measured) {
  const row = [2, 3, 4, 5, 6].map((k) => {
    const hit = [];
    const miss = [];
    for (const r of m.rows) {
      if (r.values.lumaHist < CANDIDATE_LINE) continue;
      const g = straddle(m.stats, r.index, k);
      (r.isCut ? hit : miss).push(g);
      (r.isCut ? gatePooled[k].hit : gatePooled[k].miss).push(g);
    }
    const lo = hit.length ? Math.min(...hit).toFixed(3) : '—';
    const hi = miss.length ? Math.max(...miss).toFixed(3) : '—';
    return pad(`${lo} / ${hi}`, 18);
  }).join('');
  console.log(`${pad((m.fixture.hard ? '※ ' : '  ') + m.fixture.name, 18)}${row}`);
}
console.log('-'.repeat(18 + 5 * 18));
{
  const row = [2, 3, 4, 5, 6].map((k) => {
    const lo = gatePooled[k].hit.length ? Math.min(...gatePooled[k].hit).toFixed(3) : '—';
    const hi = gatePooled[k].miss.length ? Math.max(...gatePooled[k].miss).toFixed(3) : '—';
    return pad(`${lo} / ${hi}`, 18);
  }).join('');
  console.log(`${pad('  ぜんぶ', 18)}${row}`);
}
console.log('\n左が右より大きい K があれば、その幅の門で「戻ってくる変化」を落とせる。');
console.log('ディゾルブとフェードは、渡っている間のコマが全部「正解でない」と数えられているので');
console.log('右の側に混ざる。そこは渡りの扱いを決めてから読み直すこと。');

/** i 番のコマの変化をまたいで、K コマ前と K コマ後ろを比べる。端は詰める。 */
function straddle(stats, i, k) {
  const before = stats[Math.max(0, i - k)];
  const after = stats[Math.min(stats.length - 1, i + k)];
  return DISTANCES.lumaHist(before, after);
}

// --- 4. 渡りが瞬間ではない素材 ---
console.log('\n\n渡りが瞬間ではない素材で、隣どうしの距離がどこまで立つか\n');
console.log(`${pad('素材', 18)}${pad('正解の秒', 12)}${NAMES.map((n) => pad(n, 12)).join('')}`);
console.log('-'.repeat(30 + NAMES.length * 12));
for (const m of measured) {
  if (!GRADUAL.has(m.fixture.name)) continue;
  const row = NAMES.map((name) => {
    const peak = Math.max(...m.rows.map((r) => r.values[name]));
    return num(peak);
  }).join('');
  console.log(`${pad('※ ' + m.fixture.name, 18)}${pad(m.clip.cuts.join(' / '), 12)}${row}`);
  const where = NAMES.map((name) => {
    let best = m.rows[0];
    for (const r of m.rows) if (r.values[name] > best.values[name]) best = r;
    return num(best.time, 2);
  }).join('');
  console.log(`${pad('', 18)}${pad('  山の位置(秒)', 12)}${where}`);
}
console.log('\n山が正解の秒の近くに立っていなければ、線を下げても正しい所では切れない。');
