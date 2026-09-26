/**
 * 拍の検出が「実際どれくらい効くか」を、正解の分かっている素材で測る。
 *
 *   npm run lab:beat
 *   LAB_ONSET=logFlux npm run lab:beat        # 列を 1 本にして揃える（energy / flux / logFlux）
 *   LAB_TEMPO_ONSET=flux npm run lab:beat     # テンポに使う列だけ替える
 *   LAB_PHASE_ONSET=energy npm run lab:beat   # 位相に使う列だけ替える
 *   LAB_TEMPO=acf npm run lab:beat            # テンポの選び方を替える（comb / acfPrior / acf）
 *   LAB_SNAP=1 npm run lab:beat               # 拍を近くの山へ寄せる（既定は寄せない）
 *   LAB_CLARITY=0 npm run lab:beat            # 「拍は無い」の線を外す
 *   LAB_FOLLOW=0 npm run lab:beat             # 途中で変わるテンポを追わない（9/21・1 回目までの作り）
 *   LAB_WINDOW=8 npm run lab:beat             # 窓の長さ（秒）を替える
 *   LAB_WINRATIO=0 npm run lab:beat           # 当てにならない窓を捨てる線を外す
 *   LAB_TRACKGAIN=0 npm run lab:beat          # 歩きながらの引き戻しを外す
 *   LAB_TRACKWINDOW=4 npm run lab:beat        # 引き戻し先を探す幅（拍の何分の 1）
 *   LAB_SMOOTH=0 npm run lab:beat             # 窓ごとのテンポを均さない
 *
 * A/B を同じコマンドで出せるようにしてあるのは、**手を入れたあとに
 * 「入れる前」を記録から拾い直さなくて済む**ようにするため（`lab:bench` と同じ作り）。
 *
 * **BPM の当たりだけを見ないこと。** テンポが合っていても拍が半拍ずれていれば、
 * そこで切ったカットは曲に合わない。BPM の当たりと**拍の F 値**を必ず併せて見る。
 */

import { BEAT_FIXTURES, truthBpm } from '../fixtures/beats.mjs';
import { renderBeatFixture } from '../fixtures/make-beats.mjs';
// 物差しは画面の確認（`uitest.mjs`）と分け合っている。理由は score.mjs の頭に書いた。
import { scoreBeats, TOLERANCE } from './score.mjs';

const { DEFAULT_TEMPO, DEFAULT_TEMPO_CURVE } = await import('./src/tempo.ts');
const { detectBeats, DEFAULT_BEATS } = await import('./src/beats.ts');

const options = {
  ...(process.env.LAB_ONSET ? { tempoMethod: process.env.LAB_ONSET, phaseMethod: process.env.LAB_ONSET } : {}),
  ...(process.env.LAB_TEMPO_ONSET ? { tempoMethod: process.env.LAB_TEMPO_ONSET } : {}),
  ...(process.env.LAB_PHASE_ONSET ? { phaseMethod: process.env.LAB_PHASE_ONSET } : {}),
  ...(process.env.LAB_TEMPO ? { method: process.env.LAB_TEMPO } : {}),
  ...(process.env.LAB_SNAP ? { snapToPeak: true } : {}),
  ...(process.env.LAB_CLARITY != null ? { minClarity: Number(process.env.LAB_CLARITY) } : {}),
  ...(process.env.LAB_FOLLOW != null ? { followTempo: process.env.LAB_FOLLOW !== '0' } : {}),
  ...(process.env.LAB_WINDOW ? { windowSeconds: Number(process.env.LAB_WINDOW) } : {}),
  ...(process.env.LAB_WINRATIO != null ? { minWindowClarityRatio: Number(process.env.LAB_WINRATIO) } : {}),
  ...(process.env.LAB_TRACKGAIN != null ? { trackGain: Number(process.env.LAB_TRACKGAIN) } : {}),
  ...(process.env.LAB_TRACKWINDOW ? { trackWindow: Number(process.env.LAB_TRACKWINDOW) } : {}),
  ...(process.env.LAB_SMOOTH != null ? { smoothWindows: Number(process.env.LAB_SMOOTH) } : {}),
};

/** BPM が当たったと見なす幅。 */
const BPM_TOLERANCE = 0.04;

const pad = (s, n) => String(s).padEnd(n, ' ');
const right = (s, n) => String(s).padStart(n, ' ');

/**
 * BPM の当たり方。倍・半分に取っていたらそこまで分かるようにする。
 *
 * **倍・半分は「外れ」に数える。** 曲に合わせてカットを置く用途では、
 * 倍のテンポで切ると刻みすぎ、半分だと足りない。どちらも使えない。
 * ただし**どう外したか**は次の手を決める材料なので、印だけ残す。
 */
function bpmVerdict(got, want) {
  if (want == null) return { text: got == null ? '—' : got.toFixed(1), hit: null };
  if (got == null) return { text: '無し', hit: false };
  const ratio = got / want;
  if (Math.abs(ratio - 1) < BPM_TOLERANCE) return { text: got.toFixed(1), hit: true };
  for (const [r, label] of [[2, '×2'], [0.5, '÷2'], [3, '×3'], [1 / 3, '÷3'], [1.5, '×1.5'], [2 / 3, '÷1.5']]) {
    if (Math.abs(ratio / r - 1) < BPM_TOLERANCE) return { text: `${got.toFixed(1)}${label}`, hit: false };
  }
  return { text: `${got.toFixed(1)}×`, hit: false };
}

console.log('拍の検出の効き（正解と突き合わせ）');
console.log(
  `列（テンポ）: ${options.tempoMethod ?? DEFAULT_BEATS.tempoMethod} / ` +
    `列（位相）: ${options.phaseMethod ?? DEFAULT_BEATS.phaseMethod} / ` +
    `テンポ: ${options.method ?? DEFAULT_TEMPO.method} / ` +
    `寄せ: ${(options.snapToPeak ?? DEFAULT_TEMPO.snapToPeak) ? `1/${DEFAULT_TEMPO.snapWindow}` : 'しない'} / ` +
    `線: ${options.minClarity ?? DEFAULT_TEMPO.minClarity} / ` +
    `テンポ追従: ${(options.followTempo ?? DEFAULT_BEATS.followTempo)
      ? `窓 ${options.windowSeconds ?? DEFAULT_TEMPO_CURVE.windowSeconds}s`
      : 'しない'}\n`,
);
console.log(
  `${pad('素材', 22)}${right('正解', 7)}${right('出た BPM', 11)}${right('拍', 5)}${right('当たり', 7)}` +
    `${right('F 値', 7)}${right('ずれ(ms)', 10)}${right('はっきりさ', 11)}${right('振れ', 7)}`,
);
console.log('-'.repeat(89));

let bpmHits = 0;
let bpmTotal = 0;
const fScores = [];
const offsets = [];
let noBeatOk = 0;
let noBeatTotal = 0;

for (const fixture of BEAT_FIXTURES) {
  const clip = renderBeatFixture(fixture.name);
  const result = detectBeats(clip.audio, options);

  const want = truthBpm(fixture);
  const verdict = bpmVerdict(result.bpm, want);
  // **テンポが一定でない素材は BPM の勘定から外す**（2026-09-21・2 回目）。
  // 90 → 120 の素材の中央値はたまたま 120 なので、後半だけに合わせた手が
  // 「BPM は当たり・拍は 3 分の 1」という読み方で当たりに数えられていた。
  if (verdict.hit != null && !fixture.varying) {
    bpmTotal += 1;
    if (verdict.hit) bpmHits += 1;
  }

  const score = scoreBeats(result.beats, clip.beats);
  if (clip.beats.length > 0) {
    fScores.push(score.f);
    if (score.offset != null) offsets.push(score.offset);
  } else {
    noBeatTotal += 1;
    if (result.beats.length === 0) noBeatOk += 1;
  }

  console.log(
    `${pad((fixture.hard ? '※ ' : '') + fixture.name, 22)}` +
      `${right(want ? want.toFixed(1) : '—', 7)}` +
      `${right(fixture.varying ? `~${verdict.text}` : verdict.text, 11)}` +
      `${right(result.beats.length, 5)}` +
      `${right(score.hit || (clip.beats.length === 0 ? '—' : 0), 7)}` +
      `${right(score.f.toFixed(3), 7)}` +
      `${right(score.offset != null ? (score.offset * 1000).toFixed(1) : '—', 10)}` +
      `${right(result.clarity.toFixed(2), 11)}` +
      `${right(result.tempoSpread.toFixed(2), 7)}`,
  );
}

console.log('-'.repeat(89));
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
console.log(`BPM の当たり      : ${bpmHits}/${bpmTotal}（${((bpmHits / bpmTotal) * 100).toFixed(1)}%。倍・半分は外れに数えた）`);
console.log(`                  （~ の素材はテンポが一定でないので、BPM の勘定から外してある）`);
console.log(`拍の F 値（平均） : ${mean(fScores).toFixed(3)}（${fScores.length} 本・±${TOLERANCE * 1000}ms）`);
console.log(`当たった拍のずれ  : ${(mean(offsets) * 1000).toFixed(1)}ms`);
console.log(`「拍は無い」      : ${noBeatOk}/${noBeatTotal} 本で正しく黙った`);

console.log(
  '\n**BPM の当たりだけを見ないこと。** テンポが合っていても拍が半拍ずれていれば、' +
    'そこで切ったカットは曲に合わない（`syncopated-128` がその形）。\n' +
    '「振れ」は窓ごとのテンポがどれだけ動いたか（速いほう ÷ 遅いほう）。' +
    '一定の素材で 1.00 から離れていたら、それは追いすぎている。',
);
