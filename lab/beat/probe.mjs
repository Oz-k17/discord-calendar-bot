/**
 * 「どの手なら拍を見分けられるか」を、正解の分かっている素材で測る。
 *
 *   npm run lab:beat:probe
 *
 * **実装を決める前にここを見る。** 思いつきで 1 つ選ぶと、
 * たまたま手元の素材で効いただけのものを掴む（`lab:probe` と同じ役割）。
 *
 * 5 段に分けてある。役割が違うので、どれか 1 つでは決められない:
 *   1. 立ち上がりの列そのもの（拍の上にどれだけ集まるか）
 *   2. テンポの選び方（倍・半分に取られないか）と、列の取り替え
 *   3. 拍を近くの山へ寄せる幅（寄せすぎると打点へ吸われる）
 *   4. 「拍は無い」と言うための線
 *   5. **テンポに使う列と位相に使う列を、別々に選ぶ**（ここが 2026-09-21 の収穫）
 */

import { BEAT_FIXTURES, BEAT_LENGTH, truthBpm } from '../fixtures/beats.mjs';
import { renderBeatFixture } from '../fixtures/make-beats.mjs';

const { analyzeOnset, DEFAULT_ONSET } = await import('./src/onset.ts');
const { estimateTempo, DEFAULT_TEMPO, placeBeats, clarityLine } = await import('./src/tempo.ts');
const { detectBeats, DEFAULT_BEATS } = await import('./src/beats.ts');

const pad = (s, n) => String(s).padEnd(n, ' ');
const right = (s, n) => String(s).padStart(n, ' ');

/** 正解の拍と突き合わせるときの許容幅（秒）。音楽の研究で使われる ±70ms に合わせた。 */
const TOLERANCE = 0.07;

const clips = BEAT_FIXTURES.map((f) => renderBeatFixture(f.name));

// ---------------------------------------------------------------------------
// 1 段目: 立ち上がりの列そのもの
//
// 拍の上の値と、拍から離れた所の値がどれだけ開くか。
// **ここが開いていない列は、2 段目で何を工夫しても拍を出せない。**
// ---------------------------------------------------------------------------

console.log('1 段目: 立ち上がりの列は、拍の上にどれだけ集まっているか');
console.log('（拍の前後 ±70ms に入った量の割合 ÷ その幅が尺に占める割合。1.00 なら当てずっぽうと同じ）\n');
console.log(`${pad('素材', 22)}${right('energy', 9)}${right('flux', 9)}${right('logFlux', 9)}`);
console.log('-'.repeat(49));

const METHODS = ['energy', 'flux', 'logFlux'];
const onsetCache = new Map();

function onsetOf(clip, method) {
  const key = `${clip.name}:${method}`;
  if (!onsetCache.has(key)) onsetCache.set(key, analyzeOnset(clip.audio, { method }));
  return onsetCache.get(key);
}

/**
 * 拍の周りにどれだけ集まっているか。
 *
 * **最初は「拍の上の中央値 ÷ それ以外の中央値」で測ろうとして、15 本とも ∞ になった**
 * （2026-09-21）。移動平均を引いて 0 で切った列は、鳴っていない所がぴったり 0 なので、
 * 拍から離れた所の中央値はどの素材でも 0 になる。**割る相手が 0 では何も比べられない。**
 * 量が「0 か、そうでないか」に寄っているときに中央値で割るのは、そもそも筋が悪かった。
 *
 * 代わりに**全体のうち何割が拍の周りに乗ったか**を見る。
 * 幅（±70ms）が尺に占める割合で割ってあるので、**当てずっぽうなら 1.00** になり、
 * テンポの速さが違う素材どうしでも並べられる。
 */
function beatShare(track, beats, tolerance) {
  let total = 0;
  let near = 0;
  let nearFrames = 0;
  for (let i = 0; i < track.detrended.length; i += 1) {
    const t = i * track.hop;
    const v = track.detrended[i];
    total += v;
    if (beats.some((b) => Math.abs(b - t) <= tolerance)) {
      near += v;
      nearFrames += 1;
    }
  }
  if (total <= 0 || nearFrames === 0) return null;
  const coverage = nearFrames / track.detrended.length;
  return near / total / coverage;
}

const stage1 = {};
for (const method of METHODS) stage1[method] = [];

for (const clip of clips) {
  const cells = [];
  for (const method of METHODS) {
    if (clip.beats.length === 0) {
      cells.push('—');
      continue;
    }
    const track = onsetOf(clip, method);
    const ratio = beatShare(track, clip.beats, TOLERANCE);
    if (ratio == null) {
      cells.push('—');
      continue;
    }
    stage1[method].push(ratio);
    cells.push(ratio.toFixed(2));
  }
  console.log(`${pad((clip.fixture.hard ? '※ ' : '') + clip.name, 22)}${cells.map((c) => right(c, 9)).join('')}`);
}

console.log('-'.repeat(49));
{
  const cells = METHODS.map((m) => {
    const xs = stage1[m];
    return right(xs.length ? (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2) : '—', 9);
  });
  console.log(`${pad('平均', 20)}${cells.join('')}`);
}

// ---------------------------------------------------------------------------
// 2 段目: テンポの選び方
// ---------------------------------------------------------------------------

console.log('\n\n2 段目: テンポの選び方（既定の立ち上がりの列で。× は正解から 4% 以上ずれたもの）\n');
console.log(
  `${pad('素材', 22)}${right('正解', 7)}${right('acf', 12)}${right('acfPrior', 12)}${right('comb', 12)}`,
);
console.log('-'.repeat(65));

const TEMPO_METHODS = ['acf', 'acfPrior', 'comb'];
const hits = {};
for (const m of TEMPO_METHODS) hits[m] = 0;
let tempoTotal = 0;

/** 正解からのずれ。倍・半分に取っていたらそれも分かるようにする。 */
function bpmMark(got, want) {
  if (got == null) return '無し';
  if (want == null) return `${got.toFixed(1)}`;
  const ratio = got / want;
  const off = Math.abs(ratio - 1);
  if (off < 0.04) return `${got.toFixed(1)}`;
  for (const [r, label] of [[2, '×2'], [0.5, '÷2'], [3, '×3'], [1 / 3, '÷3'], [1.5, '×1.5'], [2 / 3, '÷1.5']]) {
    if (Math.abs(ratio / r - 1) < 0.04) return `${got.toFixed(1)} ×${label.replace('×', '')}`;
  }
  return `${got.toFixed(1)} ×`;
}

for (const clip of clips) {
  const want = truthBpm(clip.fixture);
  const cells = [];
  if (want != null) tempoTotal += 1;
  for (const method of TEMPO_METHODS) {
    const track = onsetOf(clip, DEFAULT_ONSET.method);
    const result = estimateTempo(track, { method });
    if (want != null && result.bpm != null && Math.abs(result.bpm / want - 1) < 0.04) hits[method] += 1;
    cells.push(right(bpmMark(result.bpm, want), 12));
  }
  console.log(
    `${pad((clip.fixture.hard ? '※ ' : '') + clip.name, 22)}${right(want ? want.toFixed(1) : '—', 7)}${cells.join('')}`,
  );
}

console.log('-'.repeat(65));
console.log(
  `${pad('当たり（正解のある素材のみ）', 26)}` +
    TEMPO_METHODS.map((m) => right(`${hits[m]}/${tempoTotal}`, 12)).join(''),
);

// 2 段目のつづき: **立ち上がりの列を替えて**、同じ選び方（comb）で測る。
//
// テンポの選び方だけを並べても決められない。1 段目でいちばん開いた列が
// 2 段目でも勝つとは限らないので、**交差させて初めて既定が決まる。**
console.log('\n立ち上がりの列を替えて、同じ選び方（comb）で測る\n');
console.log(`${pad('素材', 22)}${right('正解', 7)}${METHODS.map((m) => right(m, 12)).join('')}`);
console.log('-'.repeat(65));

const onsetHits = {};
for (const m of METHODS) onsetHits[m] = 0;

for (const clip of clips) {
  const want = truthBpm(clip.fixture);
  const cells = [];
  for (const method of METHODS) {
    const result = estimateTempo(onsetOf(clip, method), { method: 'comb' });
    if (want != null && result.bpm != null && Math.abs(result.bpm / want - 1) < 0.04) onsetHits[method] += 1;
    cells.push(right(bpmMark(result.bpm, want), 12));
  }
  console.log(
    `${pad((clip.fixture.hard ? '※ ' : '') + clip.name, 22)}${right(want ? want.toFixed(1) : '—', 7)}${cells.join('')}`,
  );
}
console.log('-'.repeat(65));
console.log(
  `${pad('当たり（正解のある素材のみ）', 26)}` +
    METHODS.map((m) => right(`${onsetHits[m]}/${tempoTotal}`, 12)).join(''),
);

// ---------------------------------------------------------------------------
// 3 段目: 拍を近くの山へ寄せる幅
// ---------------------------------------------------------------------------

console.log('\n\n3 段目: 拍を近くの山へ寄せる幅（拍の何分の 1 まで動かすか）\n');
console.log('寄せすぎると拍が打点の列へ吸い寄せられる。F 値（±70ms）で見る。\n');

const SNAP = [
  ['寄せない', { snapToPeak: false }],
  ['1/16', { snapToPeak: true, snapWindow: 16 }],
  ['1/8', { snapToPeak: true, snapWindow: 8 }],
  ['1/4', { snapToPeak: true, snapWindow: 4 }],
  ['1/2', { snapToPeak: true, snapWindow: 2 }],
];

console.log(`${pad('素材', 22)}${SNAP.map(([label]) => right(label, 10)).join('')}`);
console.log('-'.repeat(72));

/** 正解の拍と突き合わせて F 値を出す。1 つの正解に 1 本だけ当てる。 */
export function scoreBeats(got, truth, tolerance = TOLERANCE) {
  if (truth.length === 0) return { f: got.length === 0 ? 1 : 0, hit: 0 };
  const taken = new Set();
  let hit = 0;
  for (const b of got) {
    let best = -1;
    let bestGap = Infinity;
    for (let i = 0; i < truth.length; i += 1) {
      if (taken.has(i)) continue;
      const gap = Math.abs(truth[i] - b);
      if (gap <= tolerance && gap < bestGap) {
        best = i;
        bestGap = gap;
      }
    }
    if (best >= 0) {
      taken.add(best);
      hit += 1;
    }
  }
  const precision = got.length > 0 ? hit / got.length : 0;
  const recall = hit / truth.length;
  return { f: precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0, hit };
}

const snapTotals = SNAP.map(() => []);
for (const clip of clips) {
  if (clip.beats.length === 0) continue;
  const track = onsetOf(clip, DEFAULT_ONSET.method);
  const base = estimateTempo(track, { ...DEFAULT_TEMPO });
  const cells = [];
  for (let i = 0; i < SNAP.length; i += 1) {
    if (base.period == null) {
      cells.push(right('—', 10));
      continue;
    }
    const { beats } = placeBeats(track, base.period, { ...DEFAULT_TEMPO, ...SNAP[i][1] });
    const { f } = scoreBeats(beats, clip.beats);
    snapTotals[i].push(f);
    cells.push(right(f.toFixed(3), 10));
  }
  console.log(`${pad((clip.fixture.hard ? '※ ' : '') + clip.name, 22)}${cells.join('')}`);
}

console.log('-'.repeat(72));
console.log(
  `${pad('平均', 20)}` +
    snapTotals
      .map((xs) => right(xs.length ? (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(3) : '—', 10))
      .join(''),
);


// ---------------------------------------------------------------------------
// 4 段目: 「拍は無い」と言うための線
// ---------------------------------------------------------------------------

console.log('\n\n4 段目: 「拍は無い」と言うための線（山の高さ ÷ 探した範囲の平均）\n');
console.log('拍のある素材の最小が、拍の無い素材の最大より上に来ていないと線が引けない。\n');
console.log(`${pad('素材', 22)}${right('拍', 5)}${METHODS.map((m) => right(m, 11)).join('')}`);
console.log('-'.repeat(60));

const clarityWith = {};
const clarityWithout = {};
for (const m of METHODS) {
  clarityWith[m] = [];
  clarityWithout[m] = [];
}

for (const clip of clips) {
  const hasBeat = clip.beats.length > 0;
  const cells = [];
  for (const method of METHODS) {
    // 線そのものを測りたいので、ここでは線を外して出させる。
    const result = estimateTempo(onsetOf(clip, method), { ...DEFAULT_TEMPO, minClarity: 0 });
    (hasBeat ? clarityWith : clarityWithout)[method].push(result.clarity);
    cells.push(right(result.clarity.toFixed(2), 11));
  }
  console.log(
    `${pad((clip.fixture.hard ? '※ ' : '') + clip.name, 22)}${right(hasBeat ? 'あり' : 'なし', 5)}${cells.join('')}`,
  );
}
console.log('-'.repeat(60));
console.log(
  `${pad('拍ありの最小', 20)}${METHODS.map((m) => right(Math.min(...clarityWith[m]).toFixed(2), 11)).join('')}`,
);
console.log(
  `${pad('拍なしの最大', 20)}${METHODS.map((m) => right(Math.max(...clarityWithout[m]).toFixed(2), 11)).join('')}`,
);
console.log(
  `${pad('開き（倍）', 20)}` +
    METHODS.map((m) => right((Math.min(...clarityWith[m]) / Math.max(...clarityWithout[m])).toFixed(2), 11)).join(''),
);
console.log(
  `\nいまの線: ${DEFAULT_TEMPO.minClarity}（16 秒での値。尺で動く——` +
    `この素材は ${BEAT_LENGTH} 秒なので ${clarityLine(DEFAULT_TEMPO.minClarity, BEAT_LENGTH).toFixed(2)}）`,
);
console.log('**この線は尺で動く。** 短い素材では雑音でも高い山が立つ（`tempo.ts` の `minClarity` の表）。');


// ---------------------------------------------------------------------------
// 5 段目: テンポに使う列と、位相に使う列を別々に選ぶ
//
// **1〜4 段目は「列を 1 本選ぶ」前提で測っていた。** その前提を外すと結果が変わる。
// ---------------------------------------------------------------------------

console.log('\n\n5 段目: テンポに使う列と位相に使う列を、別々に選ぶ\n');
console.log(`${pad('テンポに使う列', 18)}${pad('位相に使う列', 18)}${right('BPM の当たり', 14)}${right('拍の F 値', 12)}`);
console.log('-'.repeat(62));

for (const tempoMethod of METHODS) {
  for (const phaseMethod of METHODS) {
    let bpmHit = 0;
    let bpmTot = 0;
    const fs = [];
    for (const clip of clips) {
      const result = detectBeats(clip.audio, { tempoMethod, phaseMethod });
      const want = truthBpm(clip.fixture);
      if (want != null) {
        bpmTot += 1;
        if (result.bpm != null && Math.abs(result.bpm / want - 1) < 0.04) bpmHit += 1;
      }
      if (clip.beats.length > 0) fs.push(scoreBeats(result.beats, clip.beats).f);
    }
    const f = fs.reduce((a, b) => a + b, 0) / fs.length;
    const mark =
      tempoMethod === DEFAULT_BEATS.tempoMethod && phaseMethod === DEFAULT_BEATS.phaseMethod ? '  ← 既定' : '';
    console.log(
      `${pad(tempoMethod, 18)}${pad(phaseMethod, 18)}${right(`${bpmHit}/${bpmTot}`, 14)}${right(f.toFixed(3), 12)}${mark}`,
    );
  }
}

console.log(
  '\n**テンポと位相は、欲しい列が違う。** テンポに要るのは列が周期的であることで、' +
    '\n位相に要るのは打点どうしの大きさの釣り合いが正しいこと。' +
    '\n音量を dB（比）で見ると、長く響く音の後ろに来た打点が前の音の尾に埋もれる。',
);
