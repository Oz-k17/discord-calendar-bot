/**
 * 「どの量なら表紙に使えないコマを見分けられるか」を、正解の分かっている素材で測る。
 *
 *   npm run lab:thumb:probe
 *   LAB_ASPECT=portrait npm run lab:thumb:probe
 *
 * **実装する前に**ここで並べて比べる。思いつきで 1 つ選んで実装すると、
 * たまたま手元の素材で効いただけのものを掴む（音の側で 9 回やった）。
 *
 * 出す数字は 3 つ:
 *   1. AUC（0.5 = まったく分けられない、1.0 = 完全に分けられる）。
 *      **良いコマのほうが大きい向き**に揃えてあるので、0.5 未満は「逆向きに効いている」。
 *   2. 素材ごとの「良いコマの最小」と「駄目なコマの最大」——線が引けるかはこちらで決まる
 *   3. 素材をまたいで同じ線が引けるか（素材ごとに基準が動くなら、素材の外から線は引けない）
 */

import { renderSpec } from '../fixtures/make-frames.mjs';
import { inRanges, thumbFixtures } from '../fixtures/thumbs.mjs';
import { sceneAspect } from '../fixtures/scenes.mjs';

const { THUMB_METRICS, summarizeThumbs } = await import('./src/thumb.ts');

const aspect = process.env.LAB_ASPECT ?? 'landscape';
const view = sceneAspect(aspect);
const NAMES = Object.keys(THUMB_METRICS);

const pad = (s, n) => String(s).padEnd(n, ' ');
const num = (v, d = 3) => (v === null || v === undefined || Number.isNaN(v) ? '—' : v.toFixed(d)).padStart(8) + '  ';

/** AUC（順位で数える。同値は 0.5 と数える）。 */
function auc(positive, negative) {
  if (!positive.length || !negative.length) return null;
  let wins = 0;
  for (const p of positive) for (const n of negative) wins += p > n ? 1 : p === n ? 0.5 : 0;
  return wins / (positive.length * negative.length);
}

/** 素材 1 本を測って、コマごとの値と正解ラベルを返す。 */
function measure(fixture) {
  const clip = renderSpec(fixture, { aspect });
  const stats = summarizeThumbs(clip.frames, clip.times);
  const rows = stats.map((s) => ({
    time: s.time,
    values: Object.fromEntries(NAMES.map((n) => [n, THUMB_METRICS[n](s)])),
    bad: inRanges(s.time, fixture.bad),
    good: fixture.good.length > 0 ? inRanges(s.time, fixture.good) : !inRanges(s.time, fixture.bad),
  }));
  return { clip, rows };
}

const fixtures = thumbFixtures();
const measured = fixtures.map((f) => ({ fixture: f, ...measure(f) }));

console.log(`表紙に使えるコマを見分ける量（向き ${aspect} ${view.label} ${view.width}×${view.height}）\n`);

// --- 1. 素材ごとの AUC（良いコマ 対 駄目なコマ） ---
console.log('1. 良いコマと駄目なコマを分けられるか（AUC。良いほうが大きい向き。駄目な区間のある素材だけ）\n');
console.log(pad('素材', 16) + NAMES.map((n) => pad(n, 10)).join(''));
console.log('-'.repeat(16 + NAMES.length * 10));

const pooled = Object.fromEntries(NAMES.map((n) => [n, { good: [], bad: [] }]));
for (const m of measured) {
  const bad = m.rows.filter((r) => r.bad);
  if (!bad.length) continue;
  const good = m.rows.filter((r) => r.good);
  const cells = NAMES.map((n) => {
    const g = good.map((r) => r.values[n]);
    const b = bad.map((r) => r.values[n]);
    pooled[n].good.push(...g);
    pooled[n].bad.push(...b);
    const a = auc(g, b);
    return pad(a === null ? '—' : a.toFixed(3), 10);
  });
  console.log(pad(m.fixture.name, 16) + cells.join(''));
}
console.log('-'.repeat(16 + NAMES.length * 10));
console.log(
  pad('ぜんぶまとめて', 16) +
    NAMES.map((n) => pad((auc(pooled[n].good, pooled[n].bad) ?? 0).toFixed(3), 10)).join(''),
);

// --- 2. 線が引けるか（素材ごとの「良いコマの最小」対「駄目なコマの最大」） ---
//
// AUC が 1.0 でも、素材ごとに値の高さがばらばらなら**素材の外から線は引けない**。
// 音の側で「倍率の基準を素材の中から持ってこられない」と分かったのと同じ形なので、
// 群ごとの重なりではなく**素材をまたいだ重なり**を見る。
const TOP = ['gradNet', 'grad', 'gradDown', 'gradNetNorm', 'scaleRatio', 'detail', 'clipped', 'meanLuma'];
console.log('\n2. 素材ごとの「良いコマの最小」と「駄目なコマの最大」\n');
console.log(pad('素材', 16) + TOP.map((n) => pad(n, 20)).join(''));
console.log('-'.repeat(16 + TOP.length * 20));
for (const m of measured) {
  const bad = m.rows.filter((r) => r.bad);
  if (!bad.length) continue;
  const good = m.rows.filter((r) => r.good);
  const cells = TOP.map((n) => {
    const gmin = Math.min(...good.map((r) => r.values[n]));
    const bmax = Math.max(...bad.map((r) => r.values[n]));
    return pad(`${gmin.toFixed(3)} / ${bmax.toFixed(3)}`, 20);
  });
  console.log(pad(m.fixture.name, 16) + cells.join(''));
}

// --- 3. 素材ぜんたいの値の高さ（駄目な区間の無い素材も含めて並べる） ---
//
// ここが揃っていないほど、**固定の線ではなく素材の中で比べる**必要が強くなる。
console.log('\n3. 素材ごとの値の幅（中央値／最小〜最大。駄目な区間の無い素材も並べる）\n');
console.log(pad('素材', 16) + TOP.map((n) => pad(n, 22)).join(''));
console.log('-'.repeat(16 + TOP.length * 22));
for (const m of measured) {
  const cells = TOP.map((n) => {
    const v = m.rows.map((r) => r.values[n]).sort((a, b) => a - b);
    const mid = v[v.length >> 1];
    return pad(`${mid.toFixed(3)} (${v[0].toFixed(3)}〜${v[v.length - 1].toFixed(3)})`, 22);
  });
  console.log(pad(m.fixture.name, 16) + cells.join(''));
}

// --- 4. 粒ノイズの見積りが当たっているか ---
//
// `gradNet` は「粒の見積りを引いた細かさ」なので、見積りが外れていれば引き算も外れる。
// 素材の作り方から**本当の粒の大きさが分かっている**ので、そこだけは直に確かめられる。
console.log('\n4. 粒ノイズの見積り（素材に入れた粒の大きさと、コマから見積もった大きさ）\n');
console.log(pad('素材', 16) + pad('入れた粒 σ', 14) + pad('見積り σ（中央値）', 20) + pad('grad', 10) + pad('gradNet', 10));
console.log('-'.repeat(72));
for (const m of measured) {
  const o = m.fixture.options ?? {};
  // 一様乱数 ±grain/2（明るさ 0〜1 の目盛り）の標準偏差は grain/√12。
  // ただし粒は RGB へ**別々に**乗るので、明るさへ落ちるぶんは Rec.709 の重みの二乗和
  // （√(0.2126²+0.7152²+0.0722²) = 0.750）だけ小さくなる。ここを掛け忘れると
  // 「見積りが 2 割小さい」という無い問題が見えてしまう。
  const lumaScale = Math.sqrt(0.2126 ** 2 + 0.7152 ** 2 + 0.0722 ** 2);
  const real = o.grain ? (o.grain / Math.sqrt(12)) * lumaScale : 0;
  const noises = m.rows.map((r) => r.values.noise).sort((a, b) => a - b);
  const grads = m.rows.map((r) => r.values.grad).sort((a, b) => a - b);
  const nets = m.rows.map((r) => r.values.gradNet).sort((a, b) => a - b);
  console.log(
    pad(m.fixture.name, 16) +
      pad(real.toFixed(4), 14) +
      pad(noises[noises.length >> 1].toFixed(4), 20) +
      pad(grads[grads.length >> 1].toFixed(4), 10) +
      pad(nets[nets.length >> 1].toFixed(4), 10),
  );
}
