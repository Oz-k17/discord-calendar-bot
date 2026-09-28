/**
 * 合成した音で、計算そのものが正しいかを確かめる。
 *
 * 素材（`make-beats.mjs`）は使わない。あちらは 16 秒ぶんの波形を毎回その場で作るので、
 * **手を入れるたびに走らせるもの**の中に置くと重い。
 * ここで見るのは「計算が合っているか」だけで、効きは `npm run lab:beat` が見る。
 *
 * ここで作る音は、**答えが手で分かるもの**に限ってある
 * （0.5 秒ごとのクリックなら BPM 120、ちょうど 2 倍にした音なら値は動かない、など）。
 */

import { analyzeOnset, DEFAULT_ONSET, detrend } from './onset.ts';
import {
  autocorrelation,
  CLARITY_REFERENCE_SECONDS,
  clarityLine,
  DEFAULT_TEMPO,
  DEFAULT_TEMPO_CURVE,
  estimateTempo,
  estimateTempoCurve,
  fillGaps,
  foldOctave,
  medianSmooth,
  periodAt,
  placeBeats,
  placeBeatsVarying,
  refineLag,
  sliceTrack,
  tempoPrior,
} from './tempo.ts';
import { DEFAULT_BEATS, detectBeats, snapToBeat, subdivide } from './beats.ts';
import type { AudioLike } from '../../auto-cut/src/loudness.ts';

export interface TestResult {
  name: string;
  ok: boolean;
  detail: string;
}

const SR = 22050;

/**
 * 種を固定した擬似乱数（mulberry32）。素材（`make-beats.mjs`）と同じものを使う。
 *
 * **ここを自前の線形合同法で済ませようとして、検算のほうが壊れた**（2026-09-21）。
 * `seed * 1103515245` は seed が 2^31 に近づくと 2^53 を超えるので、
 * JavaScript の数値では下の桁が落ちる。落ちた列は雑音ではなく**規則正しい列**になり、
 * 「雑音だけなら拍を返さない」という検算が、雑音でないもので判定を責めていた
 * （はっきりさ 1.3 で通るはずの所が 3.4 と出る）。
 * **検算が落ちたら、まず検算が何を置いているかを疑うこと。**
 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Float32Array を AudioLike に包む。 */
function asAudio(data: Float32Array, sampleRate = SR): AudioLike {
  return { sampleRate, numberOfChannels: 1, length: data.length, getChannelData: () => data };
}

/**
 * 等間隔にクリックを置いた音。
 *
 * クリックは短い減衰つきの雑音。正弦波 1 発にしないのは、
 * **窓の中に入る波の数で大きさが変わってしまう**ため（周期を変えて測ると量も動く）。
 */
function clicks(period: number, seconds: number, phase = 0, level = 0.5, gap = 1): Float32Array {
  const data = new Float32Array(Math.round(seconds * SR));
  const rnd = rng(12345);
  // **床の雑音を必ず入れる。** 完全な無音の上に小さな音を置くと、
  // 減衰の尾が float32 の下限で 0 に潰れ、**同じ音を 8 倍にしたものと形が変わる**。
  // 現実の録音にも床はあるので、素材としてもこちらが素直。
  for (let i = 0; i < data.length; i += 1) data[i] = (rnd() - 0.5) * 2 * level * 0.002;
  let index = 0;
  for (let t = phase; t < seconds; t += period) {
    // `gap` は「何個に 1 個だけ鳴らすか」。拍を抜く素材のため。
    if (index % gap === 0) {
      const from = Math.round(t * SR);
      for (let i = 0; i < Math.round(0.03 * SR); i += 1) {
        const s = from + i;
        if (s >= data.length) break;
        data[s] += level * (rnd() - 0.5) * 2 * Math.exp(-i / (0.006 * SR));
      }
    }
    index += 1;
  }
  return data;
}

export function runSelfTest(): TestResult[] {
  const results: TestResult[] = [];
  const check = (name: string, ok: boolean, detail = '') => {
    results.push({ name, ok, detail });
  };
  const near = (a: number, b: number, tolerance: number) => Math.abs(a - b) <= tolerance;

  // --- 立ち上がりの列 ---

  {
    const track = analyzeOnset(asAudio(clicks(0.5, 4)));
    // **刻みはサンプル 1 つぶんまでしか合わない。** 22050Hz では 0.01 秒が 220.5 サンプルで、
    // 丸めて 221 サンプル＝10.02ms になる。ここを 1e-6 で見ると、レートによって落ちる。
    check(
      'コマの刻みは 10ms（サンプル 1 つぶんの丸めまで）',
      near(track.hop, 0.01, 1 / SR),
      `${(track.hop * 1000).toFixed(2)}ms`,
    );
    check('尺はもとの音と同じ', near(track.duration, 4, 0.02), `${track.duration.toFixed(3)}s`);
    check('コマ数は尺 ÷ 刻み', Math.abs(track.strength.length - 400) <= 1, `${track.strength.length} コマ`);
  }

  {
    // 音が鳴った所で列が立つ。0.5 秒ごとのクリックなら、その近くに山が来る。
    const track = analyzeOnset(asAudio(clicks(0.5, 4, 0.25)));
    const peaks: number[] = [];
    for (let i = 1; i < track.detrended.length - 1; i += 1) {
      if (track.detrended[i] > 1 && track.detrended[i] >= track.detrended[i - 1] && track.detrended[i] > track.detrended[i + 1]) {
        peaks.push(i * track.hop);
      }
    }
    const expected = [0.25, 0.75, 1.25, 1.75, 2.25, 2.75, 3.25, 3.75];
    const matched = expected.filter((t) => peaks.some((p) => Math.abs(p - t) <= 0.03));
    check('鳴った所に山が立つ', matched.length === expected.length, `${matched.length}/${expected.length} 個`);
  }

  {
    // **音量を 2 倍にしても列は動かない。** 全体の大きさで割ってあるため。
    // ここが守られていないと、録音レベルの違いがそのまま判定の違いになる。
    const quiet = clicks(0.5, 4, 0.25, 0.05);
    // 8 倍は 2 の冪なので、float32 でも 1 ビットも丸め損なわない（倍率だけを変えられる）。
    const loud = Float32Array.from(quiet, (v) => v * 8);
    const a = analyzeOnset(asAudio(quiet));
    const b = analyzeOnset(asAudio(loud));
    let worst = 0;
    for (let i = 0; i < a.detrended.length; i += 1) worst = Math.max(worst, Math.abs(a.detrended[i] - b.detrended[i]));
    check('音量を 8 倍にしても列は動かない（energy）', worst < 1e-6, `最大の差 ${worst.toExponential(1)}`);
  }

  {
    // `flux` はそのままの振幅を引き算するので、**倍率を掛ければ値も倍になる**。
    // それでも `detrended` は割って揃えるので、そこは動かない。
    const quiet = clicks(0.5, 4, 0.25, 0.05);
    const loud = Float32Array.from(quiet, (v) => v * 8);
    const a = analyzeOnset(asAudio(quiet), { method: 'flux' });
    const b = analyzeOnset(asAudio(loud), { method: 'flux' });
    let rawRatio = 0;
    let worst = 0;
    for (let i = 0; i < a.strength.length; i += 1) {
      if (a.strength[i] > 1e-9) rawRatio = Math.max(rawRatio, b.strength[i] / a.strength[i]);
      worst = Math.max(worst, Math.abs(a.detrended[i] - b.detrended[i]));
    }
    check('flux の生の値は倍率に比例する', near(rawRatio, 8, 0.2), `${rawRatio.toFixed(2)} 倍`);
    check('揃えたあとは倍率で動かない（flux）', worst < 1e-5, `最大の差 ${worst.toExponential(1)}`);
  }

  {
    // 音が鳴っていなければ、列はまるごと 0。0 で割って NaN を出さないこと。
    const track = analyzeOnset(asAudio(new Float32Array(SR)));
    let sum = 0;
    let finite = true;
    for (const v of track.detrended) {
      sum += v;
      if (!Number.isFinite(v)) finite = false;
    }
    check('無音では列が 0 のまま（NaN を出さない）', finite && sum === 0, `合計 ${sum}`);
  }

  {
    // 移動平均を引かないと直流が残る。引くと 0 の周りに散る。
    const raw = Float64Array.from({ length: 300 }, (_, i) => 1 + (i % 50 === 0 ? 5 : 0));
    const without = detrend(raw, 0, 0.01);
    const withIt = detrend(raw, 1.5, 0.01);
    const minWithout = Math.min(...without);
    const minWith = Math.min(...withIt);
    check(
      '移動平均を引くと、鳴っていない所が 0 になる',
      minWithout > 0 && minWith === 0,
      `引かない ${minWithout.toFixed(3)} / 引く ${minWith.toFixed(3)}`,
    );
  }

  // --- 自己相関とテンポ ---

  {
    // 周期 20 の列なら、自己相関は 20・40・60 で山になる。
    const values = Float64Array.from({ length: 400 }, (_, i) => (i % 20 === 0 ? 1 : 0));
    const acf = autocorrelation(values, 80);
    const isPeak = (lag: number) => acf[lag] > acf[lag - 1] && acf[lag] > acf[lag + 1];
    check('自己相関は周期の倍数で山になる', isPeak(20) && isPeak(40) && isPeak(60), `20:${acf[20].toFixed(4)} 40:${acf[40].toFixed(4)}`);
  }

  {
    // 割り方で長い周期の扱いが変わる（`acfNorm` の注）。
    //
    // **「足した回数で割ると長い周期のほうが大きく出る」と書いて、検算に落とされた。**
    // 完全に周期的な列では、回数で割った値は周期の倍数でぴったり同じになる（0.0500 のまま）。
    // 実際に言えるのは**列の長さで割ると長い周期ほど小さくなる**ことのほうで、
    // 遅い側が暴れるのは「回数で割ると大きくなる」からではなく、
    // **回数で割ると遠い所まで同じ高さのまま雑音だけが増える**から。
    const values = Float64Array.from({ length: 400 }, (_, i) => (i % 20 === 0 ? 1 : 0));
    const total = autocorrelation(values, 300, 'total');
    const count = autocorrelation(values, 300, 'count');
    check(
      '列の長さで割ると、長い周期ほど小さくなる',
      total[280] < total[20] * 0.5,
      `total ${total[20].toFixed(4)} → ${total[280].toFixed(4)}`,
    );
    check(
      '足した回数で割ると、周期の倍数はどこでも同じ高さになる',
      near(count[280], count[20], 1e-9),
      `count ${count[20].toFixed(4)} → ${count[280].toFixed(4)}`,
    );
  }

  {
    check('重みは中心で 1、1 オクターブ離れると落ちる', near(tempoPrior(120, 120, 0.9), 1, 1e-9) && tempoPrior(240, 120, 0.9) < 0.6, `${tempoPrior(240, 120, 0.9).toFixed(3)}`);
    check('重みの幅を 0 にすると掛からない', tempoPrior(240, 120, 0) === 1, `${tempoPrior(240, 120, 0)}`);
  }

  {
    // 山のてっぺんはコマの間にある。左右が対称なら動かない。
    const acf = Float64Array.of(0, 0, 1, 2, 1, 0);
    check('左右が同じなら山は動かない', near(refineLag(acf, 3), 3, 1e-9), `${refineLag(acf, 3)}`);
    const skewed = Float64Array.of(0, 0, 1.5, 2, 1, 0);
    check('右より左が高ければ、山は左へ寄る', refineLag(skewed, 3) < 3, `${refineLag(skewed, 3).toFixed(3)}`);
  }

  {
    // 0.5 秒ごとのクリックは BPM 120。
    const track = analyzeOnset(asAudio(clicks(0.5, 8, 0.2)));
    const result = estimateTempo(track);
    check('0.5 秒ごとのクリックは BPM 120', result.bpm != null && near(result.bpm, 120, 2), `${result.bpm?.toFixed(1)}`);
    check('最初の拍は鳴った所にある', near(result.phase, 0.2, 0.03), `${result.phase.toFixed(3)}s`);
  }

  {
    // 範囲の外のテンポは返さない（上限 200 / 下限 60）。
    // 0.2 秒ごと = BPM 300 は、範囲の中の 150 として返るはず。
    const track = analyzeOnset(asAudio(clicks(0.2, 8, 0.1)));
    const result = estimateTempo(track);
    check(
      '範囲の外のテンポは返さない',
      result.bpm != null && result.bpm >= DEFAULT_TEMPO.minBpm && result.bpm <= DEFAULT_TEMPO.maxBpm,
      `${result.bpm?.toFixed(1)}`,
    );
  }

  {
    // 拍が無ければ「無い」と言う。
    const noise = new Float32Array(8 * SR);
    const rnd = rng(999);
    for (let i = 0; i < noise.length; i += 1) noise[i] = (rnd() - 0.5) * 0.2;
    const result = estimateTempo(analyzeOnset(asAudio(noise)));
    check('雑音だけなら拍を返さない', result.bpm === null && result.beats.length === 0, `はっきりさ ${result.clarity.toFixed(2)}`);
  }

  {
    // 線は尺で動く。短いほど高い。
    check(
      '線は基準の尺でそのままの値になる',
      near(clarityLine(1.9, CLARITY_REFERENCE_SECONDS), 1.9, 1e-9),
      `${clarityLine(1.9, CLARITY_REFERENCE_SECONDS).toFixed(3)}`,
    );
    check(
      '尺が 4 分の 1 なら、線の余りは 2 倍になる',
      near(clarityLine(1.9, CLARITY_REFERENCE_SECONDS / 4), 1 + 0.9 * 2, 1e-9),
      `${clarityLine(1.9, CLARITY_REFERENCE_SECONDS / 4).toFixed(3)}`,
    );
    check('線に 0 を渡すと外れる', clarityLine(0, 16) === 0);
    check('尺が 0 なら、どんな山も通さない', clarityLine(1.9, 0) === Infinity);
  }

  {
    // 短すぎる音でも落ちない。
    const tiny = estimateTempo(analyzeOnset(asAudio(new Float32Array(100))));
    check('短すぎる音でも落ちない', tiny.bpm === null && tiny.beats.length === 0, `拍 ${tiny.beats.length} 本`);
    const one = estimateTempo(analyzeOnset(asAudio(new Float32Array(1))));
    check('1 サンプルでも落ちない', one.bpm === null, `${one.bpm}`);
  }

  // --- 拍の位置 ---

  {
    const track = analyzeOnset(asAudio(clicks(0.5, 6, 0.3)));
    const { beats } = placeBeats(track, 0.5);
    const spacing: number[] = [];
    for (let i = 1; i < beats.length; i += 1) spacing.push(beats[i] - beats[i - 1]);
    const even = spacing.every((s) => near(s, 0.5, 0.011));
    check('拍は等間隔に並ぶ', even && beats.length >= 10, `${beats.length} 本・間隔 ${spacing[0]?.toFixed(3)}`);
    check('拍は鳴った所に合う', near(beats[0] % 0.5, 0.3, 0.02), `最初の拍 ${beats[0]?.toFixed(3)}`);
  }

  {
    // **拍が 1 つ抜けていても、位相は残りに合う。** 抜けた所にも拍は立つ（格子なので）。
    const track = analyzeOnset(asAudio(clicks(0.5, 8, 0.25, 0.5, 4)));
    const { beats } = placeBeats(track, 2.0);
    check('抜けた拍があっても位相は合う', beats.length > 0 && near(beats[0] % 2.0, 0.25, 0.03), `最初の拍 ${beats[0]?.toFixed(3)}`);
  }

  {
    // 拍は素材の外へはみ出さない。
    const track = analyzeOnset(asAudio(clicks(0.5, 3, 0.2)));
    const { beats } = placeBeats(track, 0.5);
    check('拍は素材の外へ出ない', beats.every((b) => b >= 0 && b <= track.duration + 1e-9), `最後の拍 ${beats[beats.length - 1]?.toFixed(3)} / 尺 ${track.duration.toFixed(3)}`);
  }

  {
    // 周期が 0 や負でも落ちない。
    const track = analyzeOnset(asAudio(clicks(0.5, 2)));
    check('周期が 0 なら拍を返さない', placeBeats(track, 0).beats.length === 0);
    check('周期が負でも拍を返さない', placeBeats(track, -1).beats.length === 0);
  }

  // --- 2 本の列を繋ぐ所 ---

  {
    const audio = asAudio(clicks(0.5, 8, 0.2));
    const result = detectBeats(audio);
    check('入口からでも BPM 120 が出る', result.bpm != null && near(result.bpm, 120, 2), `${result.bpm?.toFixed(1)}`);
    check(
      '既定ではテンポと位相で別の列を使う',
      result.tempoTrack !== result.phaseTrack && DEFAULT_BEATS.tempoMethod !== DEFAULT_BEATS.phaseMethod,
      `${DEFAULT_BEATS.tempoMethod} / ${DEFAULT_BEATS.phaseMethod}`,
    );
    const same = detectBeats(audio, { tempoMethod: 'energy', phaseMethod: 'energy' });
    check('同じ手なら列は作り直さない', same.tempoTrack === same.phaseTrack);
  }

  {
    // 拍が無ければ、入口からでも「無い」が返る。
    const result = detectBeats(asAudio(new Float32Array(2 * SR)));
    check('無音なら入口からでも拍を返さない', result.bpm === null && result.beats.length === 0, `拍 ${result.beats.length} 本`);
  }

  // --- 窓ごとのテンポ（2026-09-21・2 回目） ---
  //
  // **既定では使わない**（測って決めた。`beats.ts` の `followTempo` の注）。
  // それでも検算を置いてあるのは、**次の回が同じ穴を掘らずに済むように残す**と決めたから。
  // 計算が壊れたまま残しておくと、読み返したときに数字のほうを疑ってしまう。

  {
    const track = analyzeOnset(asAudio(clicks(0.5, 8)));
    const part = sliceTrack(track, 2, 5);
    check('切り出した窓の尺は、切り出した長さになる', near(part.duration, 3, 0.05), `${part.duration.toFixed(3)}s`);
    check('切り出した窓は元の列を指す', part.times.length > 0 && near(part.times[0], 2, 0.05), `${part.times[0]?.toFixed(3)}`);
    // **尺が素材ぜんたいのままだと、「拍は無い」の線が甘くなる**（そこが切り出しの肝）。
    check('切り出した窓の線は、元より高い', clarityLine(1.9, part.duration) > clarityLine(1.9, track.duration));
  }

  {
    // 端の外・範囲が逆・素材の外。**どれも落ちずに空で返る**こと。
    check('窓が範囲の外なら空で返る', sliceTrack(analyzeOnset(asAudio(clicks(0.5, 2))), 10, 12).detrended.length === 0);
    check('窓の前後が逆でも落ちない', sliceTrack(analyzeOnset(asAudio(clicks(0.5, 2))), 1.5, 0.5).detrended.length === 0);
  }

  {
    check('近いオクターブへ畳む', near(foldOctave(240, 120), 120, 1e-9), `${foldOctave(240, 120)}`);
    check('遅い側も畳む', near(foldOctave(60, 120), 120, 1e-9), `${foldOctave(60, 120)}`);
    // **1.33 倍は畳まない。** 90 → 120 の変化を「倍に取った」と間違えないため。
    check('1.4 倍までは畳まない', near(foldOctave(90, 120), 90, 1e-9), `${foldOctave(90, 120)}`);
    check('0 や負でも落ちない', foldOctave(0, 120) === 0 && foldOctave(120, 0) === 120);
  }

  {
    const periods = Float64Array.from([0.5, 0, 0, 0.8, 0]);
    const filled = fillGaps(periods, 0.6);
    check('空きは前後から線で埋まる', filled === 3 && near(periods[1], 0.6, 1e-9) && near(periods[2], 0.7, 1e-9), periods.join(','));
    check('端の空きは隣を伸ばす', near(periods[4], 0.8, 1e-9), `${periods[4]}`);
  }

  {
    const empty = Float64Array.from([0, 0, 0]);
    check('どこにも値が無ければ、素材ぜんたいの答えで埋める', fillGaps(empty, 0.5) === 3 && empty.every((v) => v === 0.5), empty.join(','));
    check('空の並びでも落ちない', fillGaps(new Float64Array(0), 0.5) === 0);
  }

  {
    const values = Float64Array.from([1, 1, 9, 1, 1]);
    medianSmooth(values, 3);
    check('中央値で均すと、飛び出た 1 つが消える', values.every((v) => v === 1), values.join(','));
    const kept = Float64Array.from([1, 2, 3]);
    medianSmooth(kept, 1);
    check('幅 1 なら均さない', kept.join(',') === '1,2,3', kept.join(','));
  }

  {
    const track = analyzeOnset(asAudio(clicks(0.5, 12)));
    const curve = estimateTempoCurve(track, { windowSeconds: 5 });
    check('窓ごとのテンポが並ぶ', curve.periods.length > 1 && curve.times.length === curve.periods.length, `${curve.periods.length} 窓`);
    check(
      '一定の素材なら、どの窓も同じテンポ',
      Array.from(curve.periods).every((p) => near(60 / p, 120, 2)),
      Array.from(curve.periods).map((p) => (60 / p).toFixed(1)).join(' '),
    );
    // 窓の中心のちょうど間でも、端の外でも、同じ値が読めること。
    check('窓の間の秒でも周期が読める', near(periodAt(curve, 4.2), 0.5, 0.02), `${periodAt(curve, 4.2).toFixed(3)}`);
    check('窓の外（手前）は端の値', near(periodAt(curve, -5), curve.periods[0], 1e-9));
    check('窓の外（後ろ）は端の値', near(periodAt(curve, 999), curve.periods[curve.periods.length - 1], 1e-9));
  }

  {
    // 拍が無ければ窓も立たない（0 で割る所が無いこと）。
    const curve = estimateTempoCurve(analyzeOnset(asAudio(new Float32Array(4 * SR))));
    check('拍が無ければ窓は立たない', curve.periods.length === 0 && curve.global.bpm === null);
    check('窓が無くても周期は読める（素材ぜんたいの答え）', Number.isFinite(periodAt(curve, 1)));
  }

  {
    // **素材より窓が長いときは、素材まるごとを 1 つの窓にする。** 追う意味が無いため。
    const track = analyzeOnset(asAudio(clicks(0.5, 3)));
    const curve = estimateTempoCurve(track, { windowSeconds: 10 });
    check('窓が素材より長ければ、窓は 1 つ', curve.periods.length === 1, `${curve.periods.length} 窓`);
  }

  {
    const track = analyzeOnset(asAudio(clicks(0.5, 10, 0.25)));
    const curve = estimateTempoCurve(track, { windowSeconds: 5 });
    const { beats } = placeBeatsVarying(track, curve);
    check('追う形でも拍が並ぶ', beats.length > 15, `${beats.length} 本`);
    check('追う形でも拍は素材の外へ出ない', beats.every((b) => b >= 0 && b <= track.duration), `${beats[beats.length - 1]}`);
    // 一定の素材では、追っても間隔が動かないこと（**追いすぎていないか**の検算）。
    const gaps = beats.slice(1).map((b, i) => b - beats[i]);
    check(
      '一定の素材では、追っても間隔が動かない',
      gaps.every((g) => near(g, 0.5, 0.03)),
      `${Math.min(...gaps).toFixed(3)}〜${Math.max(...gaps).toFixed(3)}`,
    );
  }

  {
    const track = analyzeOnset(asAudio(clicks(0.5, 6)));
    const curve = estimateTempoCurve(track, { windowSeconds: 5 });
    // 引き戻しの幅が 0 でも、周期が 0 でも、落ちずに何かを返すこと。
    check('引き戻しを切っても拍は並ぶ', placeBeatsVarying(track, curve, { trackGain: 0 }).beats.length > 5);
    const broken = { ...curve, periods: Float64Array.from([0, 0]), times: Float64Array.from([1, 2]) };
    check('周期が 0 なら拍を返さない', placeBeatsVarying(track, { ...broken, global: { ...curve.global, period: 0 } }).beats.length === 0);
  }

  {
    // **入口からも切り替えられること。** 既定は追わない側。
    const audio = asAudio(clicks(0.5, 8));
    check('既定ではテンポを追わない', detectBeats(audio).tempoCurve === null);
    const followed = detectBeats(audio, { followTempo: true, windowSeconds: 5 });
    check('追う側にすると窓が付いてくる', followed.tempoCurve !== null && followed.beats.length > 10);
    check('一定の素材なら振れは 1.0 のまま', near(followed.tempoSpread, 1, 0.05), `${followed.tempoSpread.toFixed(3)}`);
  }

  // --- 使う側の道具 ---

  {
    const beats = [1, 2, 3];
    check('2 等分すると拍の間が 1 つ増える', subdivide(beats, 2).join(',') === '1,1.5,2,2.5,3', subdivide(beats, 2).join(','));
    check('1 等分は元のまま', subdivide(beats, 1).join(',') === '1,2,3');
    check('拍が 1 本以下なら等分しない', subdivide([1], 4).join(',') === '1' && subdivide([], 4).length === 0);
    // 間隔が一定でなくても、その間だけを等分する（テンポが動く素材のため）。
    check('間隔が違っても、その間だけを等分する', subdivide([0, 1, 3], 2).join(',') === '0,0.5,1,2,3', subdivide([0, 1, 3], 2).join(','));
  }

  {
    const beats = [1.0, 1.5, 2.0];
    check('近い拍へ寄る', snapToBeat(1.45, beats) === 1.5, `${snapToBeat(1.45, beats)}`);
    check('遠ければ動かさない', snapToBeat(1.75, beats, 0.12) === 1.75, `${snapToBeat(1.75, beats, 0.12)}`);
    check('拍が無ければ動かさない', snapToBeat(1.45, []) === 1.45);
  }

  // --- 既定を固定する ---

  {
    check(
      '既定は、テンポに energy・位相に flux・comb・寄せない・線 1.9',
      DEFAULT_BEATS.tempoMethod === 'energy' &&
        DEFAULT_BEATS.phaseMethod === 'flux' &&
        DEFAULT_TEMPO.method === 'comb' &&
        DEFAULT_TEMPO.snapToPeak === false &&
        DEFAULT_TEMPO.minClarity === 1.9,
      `${JSON.stringify(DEFAULT_BEATS)} ${DEFAULT_TEMPO.method}/${DEFAULT_TEMPO.minClarity}`,
    );
    check(
      '既定ではテンポを追わない（測って決めた。beats.ts の注）',
      DEFAULT_BEATS.followTempo === false,
      `${DEFAULT_BEATS.followTempo}`,
    );
    check(
      '追う側の既定は、窓 5 秒・引き戻し 0.5・均さない',
      DEFAULT_TEMPO_CURVE.windowSeconds === 5 &&
        DEFAULT_TEMPO_CURVE.trackGain === 0.5 &&
        DEFAULT_TEMPO_CURVE.smoothWindows === 0,
      `${DEFAULT_TEMPO_CURVE.windowSeconds}s/${DEFAULT_TEMPO_CURVE.trackGain}/${DEFAULT_TEMPO_CURVE.smoothWindows}`,
    );
    check(
      '刻みは 10ms、窓は 1024',
      DEFAULT_ONSET.hop === 0.01 && DEFAULT_ONSET.window === 1024,
      JSON.stringify({ hop: DEFAULT_ONSET.hop, window: DEFAULT_ONSET.window }),
    );
  }

  return results;
}
