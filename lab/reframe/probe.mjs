/**
 * 「どの手なら**被写体が横のどこに居るか**を指せるか」を、正解の分かっている素材で測る。
 *
 *   npm run lab:reframe:probe
 *
 * **実装する前に**ここで並べて比べる。思いつきで 1 つ選んで実装すると、
 * たまたま手元の素材で効いただけのものを掴む（音の側で 9 回やった）。
 *
 * 出す数字は 3 つ:
 *   1. **ずれの中央値**（画面の幅に対する割合）— 小さいほど正しく指している
 *   2. **枠に入る率** — その手が返す位置をそのまま枠の中心にしたとき、被写体が枠に収まる割合
 *      （9:16 の窓は画面の 31.6% なので、ずれが 15.8% 未満なら中心が枠に入る）
 *   3. **尖り**（いちばん強い列 − 真ん中の列）— 「見えていない」を見分けられるかの目安
 *
 * **被写体の居ない素材も一緒に測る。** 指す手はどんな重みからでも必ず答えを返すので、
 * 何も居ないところで何を答えるかを見ておかないと、「追う」と「泳ぐ」を取り違える。
 */

import { REFRAME_FIXTURES, SCENE_FIXTURES, leadSubjectAt } from '../fixtures/scenes.mjs';
import { renderFixture } from '../fixtures/make-frames.mjs';

const {
  backgroundOdds,
  contrast,
  diffLuma,
  diffRgb,
  diffShifted,
  readCentroid,
  readPeak,
  spatialOdds,
  summarizeAllColumns,
} = await import('./src/columns.ts');

/**
 * 列ごとの重みを、そのコマの中の最大で割って 0〜1 へ揃える。
 *
 * 揃えずに混ぜると、**桁の大きいほうがいつも勝つ**（背景と比べる手と
 * コマの中を見る手では、そもそも測っているものの大きさが違う）。
 * 最大が 0 のとき（真っ暗・完全な静止）は 0 のまま返す——
 * そこで割ると、無いものを全画面の模様に化けさせてしまう。
 */
function normalize(w) {
  let max = 0;
  for (let c = 0; c < w.length; c += 1) if (w[c] > max) max = w[c];
  if (max <= 0) return w;
  const out = new Float64Array(w.length);
  for (let c = 0; c < w.length; c += 1) out[c] = w[c] / max;
  return out;
}

/** 9:16 の窓の幅（画面の何割か）。`scenes.mjs` の `PORTRAIT_CROP_U` と同じ数。 */
const CROP_U = 81 / 256;
const HALF = CROP_U / 2;

/** 測る手の一覧。`cols` を受けて「コマ番号 → 列ごとの重み」を返す形へ揃える。 */
const CUES = {
  diff: (cols) => (i) => diffLuma(cols, i),
  diffRgb: (cols) => (i) => diffRgb(cols, i),
  diffShift: (cols) => (i) => diffShifted(cols, i),
  bg: (cols) => backgroundOdds(cols),
  spatial: (cols) => (i) => spatialOdds(cols, i),
  // **2 つの手の大きいほう**（それぞれ自分の最大で割ってから比べる）。
  // 掛け算と違って**片方が 0 でも生き残る**ので、
  // 一方が原理的に見えない素材（背景の手は動かない被写体を、
  // そのコマの中を見る手は画面いっぱいの被写体を見られない）でも落ちないはず。
  either: (cols) => {
    const bg = backgroundOdds(cols);
    return (i) => {
      const a = normalize(bg(i));
      const b = normalize(spatialOdds(cols, i));
      const w = new Float64Array(a.length);
      for (let c = 0; c < a.length; c += 1) w[c] = Math.max(a[c], b[c]);
      return w;
    };
  },
  // **2 つの手の掛け算**。片方だけが立っている列は消えるので、
  // 「時間から見ても浮いていて、そのコマの中でも浮いている」列だけが残るはず。
  both: (cols) => {
    const bg = backgroundOdds(cols);
    return (i) => {
      const a = bg(i);
      const b = spatialOdds(cols, i);
      const w = new Float64Array(a.length);
      for (let c = 0; c < a.length; c += 1) w[c] = a[c] * b[c];
      return w;
    };
  },
};

/** 重みを 1 つの位置へ読む手。 */
const READS = {
  centroid: readCentroid,
  peak: readPeak,
};

const pad = (s, n) => String(s).padEnd(n, ' ');
const right = (s, n) => String(s).padStart(n, ' ');
const median = (xs) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
};

/** 素材 1 本を測る。被写体が画面の中に居るコマだけを数える。 */
function measure(fixture) {
  const clip = renderFixture(fixture.name);
  const cols = summarizeAllColumns(clip.frames, clip.times);
  const out = {};
  for (const [cueName, build] of Object.entries(CUES)) {
    const weightsAt = build(cols);
    for (const [readName, read] of Object.entries(READS)) {
      const errors = [];
      const sharp = [];
      let inside = 0;
      let counted = 0;
      // 1 コマ目は引き算の手が答えを持たないので、どの手も 1 から数える（列を揃えるため）。
      for (let i = 1; i < cols.length; i += 1) {
        const truth = leadSubjectAt(fixture, clip.times[i]);
        // 被写体が画面の外に居るコマは、追いようが無いので数えない。
        if (truth && (truth.u < 0 || truth.u > 1)) continue;
        const w = weightsAt(i);
        const u = read(w);
        sharp.push(contrast(w));
        if (!truth) continue;
        counted += 1;
        if (Number.isNaN(u)) continue;
        const err = Math.abs(u - truth.u);
        errors.push(err);
        if (err < HALF) inside += 1;
      }
      out[`${cueName}/${readName}`] = {
        error: median(errors),
        inside: counted ? (inside / counted) * 100 : null,
        contrast: median(sharp),
      };
    }
  }
  return out;
}

const withSubject = [...SCENE_FIXTURES, ...REFRAME_FIXTURES].filter((f) => leadSubjectAt(f, 6.5));
const without = SCENE_FIXTURES.filter((f) => !leadSubjectAt(f, 6.5));

const keys = Object.keys(CUES).flatMap((c) => Object.keys(READS).map((r) => `${c}/${r}`));

console.log('被写体を指せるか（正解と突き合わせ・横型 16:9 ・ 15fps）\n');
console.log('ずれの中央値（画面の幅に対する割合。0.158 を超えると枠から出る）\n');
console.log(`${pad('素材', 20)}${keys.map((k) => right(k, 16)).join('')}`);
console.log('-'.repeat(20 + keys.length * 16));

const rows = [];
for (const f of withSubject) {
  const m = measure(f);
  rows.push({ f, m });
  console.log(
    `${pad(f.name, 20)}${keys.map((k) => right(Number.isNaN(m[k].error) ? '—' : m[k].error.toFixed(3), 16)).join('')}`,
  );
}
console.log('-'.repeat(20 + keys.length * 16));
console.log(
  `${pad('  中央値', 20)}` +
    keys.map((k) => right(median(rows.map((r) => r.m[k].error).filter((v) => !Number.isNaN(v))).toFixed(3), 16)).join(''),
);

console.log('\n\n枠に入る率（その位置をそのまま枠の中心にしたとき、被写体の中心が枠に収まる割合）\n');
console.log(`${pad('素材', 20)}${keys.map((k) => right(k, 16)).join('')}`);
console.log('-'.repeat(20 + keys.length * 16));
for (const { f, m } of rows) {
  console.log(`${pad(f.name, 20)}${keys.map((k) => right(`${m[k].inside.toFixed(1)}%`, 16)).join('')}`);
}
console.log('-'.repeat(20 + keys.length * 16));
console.log(
  `${pad('  ぜんぶ', 20)}` +
    keys
      .map((k) => right(`${(rows.reduce((s, r) => s + r.m[k].inside, 0) / rows.length).toFixed(1)}%`, 16))
      .join(''),
);

// --- 2 つの手が同じ所を指すか ---
//
// 尖りで「居る / 居ない」を分けられなかったとき（実際に分けられない）、次に見るのはここ。
// **別の理屈で作った 2 つの手が同じ列を指すなら、そこには本当に何かある**はず。
// 片方だけが立つ所（カメラが動いた・明るさが動いた）では、指す所がそろう理由が無い。
console.log('\n\n2 つの手（bg / spatial）が指す所の隔たりの中央値。◎ が小さく × が大きければ門になる\n');
{
  const rowsOf = (fixture) => {
    const clip = renderFixture(fixture.name);
    const cols = summarizeAllColumns(clip.frames, clip.times);
    const bg = backgroundOdds(cols);
    const gaps = [];
    for (let i = 1; i < cols.length; i += 1) {
      const truth = leadSubjectAt(fixture, clip.times[i]);
      if (truth && (truth.u < 0 || truth.u > 1)) continue;
      const a = readPeak(bg(i));
      const b = readPeak(spatialOdds(cols, i));
      if (!Number.isNaN(a) && !Number.isNaN(b)) gaps.push(Math.abs(a - b));
    }
    return median(gaps);
  };
  const yes = [];
  const no = [];
  for (const f of withSubject) {
    const g = rowsOf(f);
    yes.push(g);
    console.log(`${pad('◎ ' + f.name, 24)}${right(g.toFixed(3), 8)}`);
  }
  for (const f of without) {
    const g = rowsOf(f);
    no.push(g);
    console.log(`${pad('× ' + f.name, 24)}${right(g.toFixed(3), 8)}`);
  }
  console.log('-'.repeat(32));
  console.log(`${pad('  ◎ の最大', 24)}${right(Math.max(...yes).toFixed(3), 8)}`);
  console.log(`${pad('  × の最小', 24)}${right(Math.min(...no).toFixed(3), 8)}`);
}

// --- 被写体の居ない素材で、指す手が何を答えるか ---
//
// ここが平らなら「追う手」は要らない。実際には答えを返してしまうので、
// **尖りで止める**ことになる。その線がどこに引けるかを見るための表。
console.log('\n\n尖り（いちばん強い列 − 真ん中の列）の中央値。被写体が居るときと居ないときで分かれるか\n');
console.log(`${pad('素材', 20)}${keys.map((k) => right(k, 16)).join('')}`);
console.log('-'.repeat(20 + keys.length * 16));
for (const { f, m } of rows) {
  console.log(`${pad('◎ ' + f.name, 20)}${keys.map((k) => right(m[k].contrast.toFixed(4), 16)).join('')}`);
}
const noneRows = [];
for (const f of without) {
  const m = measure(f);
  noneRows.push({ f, m });
  console.log(`${pad('× ' + f.name, 20)}${keys.map((k) => right(m[k].contrast.toFixed(4), 16)).join('')}`);
}
console.log('-'.repeat(20 + keys.length * 16));
console.log(
  `${pad('  ◎ の最小', 20)}` +
    keys.map((k) => right(Math.min(...rows.map((r) => r.m[k].contrast)).toFixed(4), 16)).join(''),
);
console.log(
  `${pad('  × の最大', 20)}` +
    keys.map((k) => right(Math.max(...noneRows.map((r) => r.m[k].contrast)).toFixed(4), 16)).join(''),
);
