/**
 * 合成した波形で、計算そのものが正しいかを確かめる。
 * 素材を用意しなくても壊れていないことが分かるように、画面から実行できるようにしてある。
 */

import { analyzeLoudness, toDb, type AudioLike } from './loudness.ts';
import { autoThresholdDb, planJetCut } from './silence.ts';
import { gainAt, planDucking } from './ducking.ts';
import { toClipEdits } from './edits.ts';
import { buildPeaks } from './peaks.ts';
import { analyzeFeatures, modulationRatio } from './features.ts';
import { fftScratch, magnitudes } from './fft.ts';

export interface TestResult {
  name: string;
  ok: boolean;
  detail: string;
}

/**
 * 音量だけが指定の速さで揺れる、単一の音程の音。
 *
 * もとは「声の音節らしさを模したもの」として置いていたが、**それは間違いだった**。
 * 中身は音程が変わらないままトレモロがかかった楽器で、声ではない。
 * いまは「音量は声のように揺れるが、声ではないもの」の代表として使っている。
 */
function makeModulated(seconds: number, sampleRate: number, hz: number, amp = 0.5): AudioLike {
  const length = Math.round(seconds * sampleRate);
  const data = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    const t = i / sampleRate;
    const env = 0.55 + 0.45 * Math.sin(2 * Math.PI * hz * t);
    data[i] = amp * env * Math.sin(2 * Math.PI * 200 * t);
  }
  return { sampleRate, numberOfChannels: 1, length, getChannelData: () => data };
}

/**
 * 声らしい音。音節の速さで揺れ、**かつ音色が移り変わる**。
 *
 * 母音が移ると倍音の並び方が変わる、というところまで模している。
 * ここを模さないと「震える楽器」と区別が付かない
 * （実際、区別できないまま `music-tremolo.wav` に満点を出していた）。
 */
function makeSpeechLike(seconds: number, sampleRate: number, hz = 4, amp = 0.5): AudioLike {
  const length = Math.round(seconds * sampleRate);
  const data = new Float32Array(length);
  // 「あ」と「い」のつもりの倍音の重みを、音節と同じ速さで行き来させる。
  //
  // 速さも差の大きさも、両方いる。跳ばして切り替えると形の変化がその瞬間だけの棘になり、
  // ゆっくり移すと 1 コマあたりの差が小さくなって、どちらも「動いていない」に見える。
  // 差が小さいときも同じで、4 倍音で 0.7→0.15 程度だと形の変化が 0.057 までしか
  // 上がらず、震える楽器（0.026）と見分けられる域に届かなかった。
  const vowels = [
    [1, 0.8, 0.3, 0.1, 0.05, 0.02],
    [0.2, 0.1, 0.4, 0.8, 0.7, 0.4],
  ];
  for (let i = 0; i < length; i += 1) {
    const t = i / sampleRate;
    const env = 0.55 + 0.45 * Math.sin(2 * Math.PI * hz * t);
    // 母音は音節と同じ速さで移る。ここを遅くすると 1 コマあたりの形の差が
    // 小さくなり、「連続して動いているのに動いていないように見える」ことになる。
    const blend = 0.5 + 0.5 * Math.sin(2 * Math.PI * hz * t + Math.PI / 2);
    let v = 0;
    for (let h = 0; h < vowels[0].length; h += 1) {
      const weight = vowels[0][h] * (1 - blend) + vowels[1][h] * blend;
      v += weight * Math.sin(2 * Math.PI * 200 * (h + 1) * t);
    }
    data[i] = (amp * env * v) / 2;
  }
  return { sampleRate, numberOfChannels: 1, length, getChannelData: () => data };
}

/**
 * 倍音列に、対数周波数上のガウス共鳴（フォルマント）を掛けた音。
 *
 * 「口の形（共鳴の居場所）」と「音程（f0）」を**別々に動かせる**ようにしてある。
 * 包絡の動きを測る量が、そのどちらに反応しているのかを切り分けるために要る。
 * 声らしい音（makeSpeechLike）はこの 2 つが一緒に動いてしまうので、それでは分からない。
 */
function makeFormantTone(
  seconds: number,
  sampleRate: number,
  { f0 = 200, glide = 0, formant = 800, sweep = 0, rate = 4, amp = 0.5, tremolo = false } = {},
): AudioLike {
  const length = Math.round(seconds * sampleRate);
  const data = new Float32Array(length);
  let phase = 0;
  for (let i = 0; i < length; i += 1) {
    const t = i / sampleRate;
    const f = f0 * (1 + glide * (0.5 + 0.5 * Math.sin(2 * Math.PI * rate * t)));
    // 音程を動かすので、位相は積み上げる（周波数をそのまま時刻に掛けると跳ぶ）。
    phase += (2 * Math.PI * f) / sampleRate;
    const center = formant * Math.exp(sweep * Math.sin(2 * Math.PI * rate * t));
    const env = tremolo ? 0.55 + 0.45 * Math.sin(2 * Math.PI * rate * t) : 1;
    let v = 0;
    let norm = 0;
    for (let h = 1; h <= 20; h += 1) {
      if (f * h > sampleRate / 2) break;
      const d = Math.log((f * h) / center) / 0.7;
      const gain = Math.exp(-d * d) / h;
      v += gain * Math.sin(phase * h);
      norm += gain;
    }
    data[i] = norm > 0 ? (amp * env * v) / norm : 0;
  }
  return { sampleRate, numberOfChannels: 1, length, getChannelData: () => data };
}

/** 白色雑音。音色が平坦な音の代表として使う。 */
function makeNoise(seconds: number, sampleRate: number, amp = 0.3): AudioLike {
  const length = Math.round(seconds * sampleRate);
  const data = new Float32Array(length);
  let seed = 12345;
  for (let i = 0; i < length; i += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    data[i] = ((seed / 0x7fffffff) * 2 - 1) * amp;
  }
  return { sampleRate, numberOfChannels: 1, length, getChannelData: () => data };
}

/** 指定した区間だけサイン波が鳴る、1ch の合成音を作る。 */
function makeTone(seconds: number, sampleRate: number, tones: { from: number; to: number; amp?: number }[]): AudioLike {
  const length = Math.round(seconds * sampleRate);
  const data = new Float32Array(length);
  for (const tone of tones) {
    const from = Math.round(tone.from * sampleRate);
    const to = Math.min(length, Math.round(tone.to * sampleRate));
    const amp = tone.amp ?? 0.5;
    for (let i = from; i < to; i += 1) data[i] = amp * Math.sin((2 * Math.PI * 440 * i) / sampleRate);
  }
  return { sampleRate, numberOfChannels: 1, length, getChannelData: () => data };
}

const near = (a: number, b: number, tolerance: number) => Math.abs(a - b) <= tolerance;

export function runSelfTest(): TestResult[] {
  const results: TestResult[] = [];
  const check = (name: string, ok: boolean, detail: string) => results.push({ name, ok, detail });

  // --- 音量の測定 ---
  {
    const sr = 8000;
    const buffer = makeTone(1, sr, [{ from: 0, to: 1, amp: 0.5 }]);
    const track = analyzeLoudness(buffer, 0.02);
    // 振幅 0.5 のサイン波の RMS は 0.5/√2 ≒ 0.354 → 約 -9dB
    const middle = track.db[Math.floor(track.db.length / 2)];
    check('サイン波の音量が理論値と一致する', near(middle, toDb(0.5 / Math.SQRT2), 0.5), `${middle.toFixed(2)} dB`);
    check('コマ数が尺 ÷ hop と一致する', near(track.db.length, 1 / 0.02, 1), `${track.db.length} コマ`);
  }

  // --- 無音カット ---
  {
    const sr = 8000;
    // 無音 1s / 声 1s / 無音 0.5s / 声 1s / 無音 1s
    const buffer = makeTone(4.5, sr, [
      { from: 1, to: 2 },
      { from: 2.5, to: 3.5 },
    ]);
    const track = analyzeLoudness(buffer, 0.02);
    const threshold = autoThresholdDb(track, 0.25);
    check('自動しきい値が無音と声の間に来る', threshold > -100 && threshold < -12, `${threshold.toFixed(1)} dB`);

    // 0.5 秒の切れ目は minSilence(0.35) より長いので、2 本に分かれるはず。
    const split = planJetCut(track, { minSilence: 0.35, padding: 0.05 });
    check('切れ目が長ければ 2 本に分かれる', split.keep.length === 2, `${split.keep.length} 本`);
    check('前後の無音が落ちる', near(split.removed, 2.4, 0.2), `${split.removed.toFixed(2)} 秒を削減`);
    check(
      '残す区間が声の位置と合っている',
      near(split.keep[0].start, 0.95, 0.08) && near(split.keep[1].end, 3.55, 0.08),
      `${split.keep.map((r) => `${r.start.toFixed(2)}〜${r.end.toFixed(2)}`).join(' / ')}`,
    );

    // minSilence を 0.6 に上げると、0.5 秒の切れ目は繋がったままになるはず。
    const joined = planJetCut(track, { minSilence: 0.6, padding: 0.05 });
    check('切れ目が短ければ繋がったまま', joined.keep.length === 1, `${joined.keep.length} 本`);

    // 余白は語頭・語尾を食わないための保険。増やせば残る尺も増える。
    const padded = planJetCut(track, { minSilence: 0.35, padding: 0.2 });
    check('余白を増やすと残る尺が伸びる', padded.resultDuration > split.resultDuration, `${split.resultDuration.toFixed(2)} → ${padded.resultDuration.toFixed(2)} 秒`);

    // 全編無音なら 1 本も残らない。
    const quiet = planJetCut(analyzeLoudness(makeTone(2, sr, []), 0.02));
    check('全編無音なら何も残らない', quiet.keep.length === 0, `${quiet.keep.length} 本`);

    // --- 計画 → クリップ ---
    const edits = toClipEdits(split.keep, { start: 10, duration: 4.5, sourceIn: 0 });
    check('分割後もタイムライン上で隙間なく並ぶ', edits.length === 2 && near(edits[1].start, edits[0].start + edits[0].duration, 1e-6), edits.map((e) => `${e.start.toFixed(2)}+${e.duration.toFixed(2)}`).join(' / '));
    check('置いた位置（10 秒）から始まる', near(edits[0].start, 10, 1e-6), `${edits[0].start} 秒`);

    // クリップが素材の一部しか使っていない場合は、その外は無視される。
    const trimmed = toClipEdits(split.keep, { start: 0, duration: 1.5, sourceIn: 2.5 });
    check('トリム済みクリップでは使っている範囲だけ切る', trimmed.length === 1 && trimmed[0].sourceIn >= 2.5, `${trimmed.length} 本 / sourceIn=${trimmed[0]?.sourceIn.toFixed(2)}`);
  }

  // --- ダッキング ---
  {
    const sr = 8000;
    const voice = analyzeLoudness(makeTone(4, sr, [{ from: 1, to: 2 }]), 0.02);
    const points = planDucking(voice, { duckDb: -12, attack: 0.1, release: 0.4, hold: 0.2, thresholdDb: -45 });
    check('声の前は下がっていない', near(gainAt(points, 0.5), 1, 0.02), gainAt(points, 0.5).toFixed(3));
    check('声のあいだは約 -12dB', near(gainAt(points, 1.5), 0.251, 0.02), gainAt(points, 1.5).toFixed(3));
    check('声のあとで戻る', near(gainAt(points, 3.5), 1, 0.02), gainAt(points, 3.5).toFixed(3));
    check('音量が 0〜1 に収まっている', points.every((p) => p.gain >= 0 && p.gain <= 1), `${points.length} 点`);
    check('時刻が昇順に並んでいる', points.every((p, i) => i === 0 || p.time >= points[i - 1].time), 'ok');

    const silent = planDucking(analyzeLoudness(makeTone(2, sr, []), 0.02));
    check('声が無ければ下げない', silent.length === 1 && silent[0].gain === 1, `${silent.length} 点`);
  }

  // --- 波形 ---
  {
    const peaks = buildPeaks(makeTone(1, 8000, [{ from: 0, to: 1, amp: 0.8 }]), 100);
    check('波形の山が振幅と一致する', near(Math.max(...peaks.max), 0.8, 0.02), Math.max(...peaks.max).toFixed(3));
    check('波形のバケット数が指定どおり', peaks.max.length === 100, `${peaks.max.length}`);
  }

  // --- FFT ---
  {
    // 8 周期ぶんちょうど入るサイン波を入れたら、その山だけが立つはず。
    const n = 256;
    const input = new Float32Array(n);
    for (let i = 0; i < n; i += 1) input[i] = Math.sin((2 * Math.PI * 8 * i) / n);
    const scratch = fftScratch(n);
    magnitudes(input, scratch.re, scratch.im, scratch.mag);
    let peak = 0;
    for (let b = 1; b < scratch.mag.length; b += 1) if (scratch.mag[b] > scratch.mag[peak]) peak = b;
    check('FFT の山が入れた周波数と一致する', peak === 8, `bin ${peak}`);
    // 直流だけを入れたら、0 番以外は立たない。
    const flat = new Float32Array(n).fill(1);
    magnitudes(flat, scratch.re, scratch.im, scratch.mag);
    let others = 0;
    for (let b = 2; b < scratch.mag.length; b += 1) others = Math.max(others, scratch.mag[b]);
    check('直流だけなら他の周波数は立たない', others < 1e-6, others.toExponential(1));
  }

  // --- 声らしさ ---
  {
    const sr = 16000;
    // 4Hz で揺れる音は「音節らしい」、まったく揺れない音はそうではない。
    const modulated = analyzeLoudness(makeModulated(3, sr, 4), 0.02);
    const steady = analyzeLoudness(makeTone(3, sr, [{ from: 0, to: 3 }]), 0.02);
    const mid = (a: Float32Array) => a[Math.floor(a.length / 2)];
    const modOn = mid(modulationRatio(modulated));
    const modOff = mid(modulationRatio(steady));
    check('4Hz で揺れる音は揺れが検出される', modOn > 0.5, modOn.toFixed(3));
    check('揺れない音では検出されない', modOff < 0.2, modOff.toFixed(3));

    // 音色: 音程のある音は尖っていて、雑音は平坦。
    const toneBuffer = makeModulated(2, sr, 4);
    const noiseBuffer = makeNoise(2, sr);
    const toneFeatures = analyzeFeatures(toneBuffer, analyzeLoudness(toneBuffer, 0.02));
    const noiseFeatures = analyzeFeatures(noiseBuffer, analyzeLoudness(noiseBuffer, 0.02));
    check('音程のある音は尖っている', mid(toneFeatures.tone) > 0.9, mid(toneFeatures.tone).toFixed(3));
    check('雑音は平坦', mid(noiseFeatures.tone) < mid(toneFeatures.tone) - 0.1, mid(noiseFeatures.tone).toFixed(3));

    // 形の変化は行ったり来たりする量なので、1 コマだけで比べると
    // たまたま折り返し点（変化がいちばん小さい所）を掴んで結論が変わる。
    // 真ん中あたりを均して見る。
    const midMean = (a: Float32Array) => {
      const from = Math.floor(a.length * 0.25);
      const to = Math.max(from + 1, Math.ceil(a.length * 0.75));
      let sum = 0;
      for (let i = from; i < to; i += 1) sum += a[i];
      return sum / (to - from);
    };

    // --- 形の変化（音量倍率に不変であること） ---
    // ここが不変でないと、音量が揺れているだけの音を「中身が動いている」と誤る。
    const loud = makeSpeechLike(2, sr, 4, 0.5);
    const soft = makeSpeechLike(2, sr, 4, 0.125);
    const loudShape = midMean(analyzeFeatures(loud, analyzeLoudness(loud, 0.02)).shapeFlux);
    const softShape = midMean(analyzeFeatures(soft, analyzeLoudness(soft, 0.02)).shapeFlux);
    check(
      '形の変化は音量を 1/4 にしても変わらない',
      Math.abs(loudShape - softShape) < 0.01,
      `${loudShape.toFixed(4)} vs ${softShape.toFixed(4)}`,
    );
    // 音程が変わらないままトレモロがかかった音は、音量が揺れていても形は（ほとんど）動かない。
    // ぴったり 0 にならないのは、窓の中で包絡が動くぶんの側帯波が出るため。
    check(
      '音量だけ揺れる音では形がほとんど動かない',
      midMean(toneFeatures.shapeFlux) < 0.04,
      midMean(toneFeatures.shapeFlux).toFixed(4),
    );
    const speechBuffer = makeSpeechLike(2, sr, 4);
    const speechFeatures = analyzeFeatures(speechBuffer, analyzeLoudness(speechBuffer, 0.02));
    check(
      '音色が移り変わる音では形が動く',
      midMean(speechFeatures.shapeFlux) > midMean(toneFeatures.shapeFlux) + 0.02,
      `${midMean(speechFeatures.shapeFlux).toFixed(4)} > ${midMean(toneFeatures.shapeFlux).toFixed(4)}`,
    );

    // --- 包絡（フォルマントの居場所）の動き ---
    // 形の変化（shapeFlux）は、声と背景の混ざり方が変わることで動いていた。
    // 背景の無い素材では声でも動かないので、そこを分けられるかを確かめる。
    // 同じ音を何度も測るので、一度出した値は覚えておく（解析は毎回そこそこ重い）。
    const envCache = new Map<AudioLike, number>();
    const envMean = (b: AudioLike) => {
      const found = envCache.get(b);
      if (found !== undefined) return found;
      const value = midMean(analyzeFeatures(b, analyzeLoudness(b, 0.02)).envelopeFlux);
      envCache.set(b, value);
      return value;
    };

    check(
      '包絡の動きは音量を 1/4 にしても変わらない',
      Math.abs(envMean(loud) - envMean(soft)) < 0.001,
      `${envMean(loud).toFixed(4)} vs ${envMean(soft).toFixed(4)}`,
    );
    // ここが今回の要。震える楽器は音量しか動いていないので、包絡は動かない。
    check(
      '音量だけ揺れる音では包絡がほとんど動かない',
      envMean(toneBuffer) < 0.05,
      envMean(toneBuffer).toFixed(4),
    );
    check(
      '音色が移り変わる音では包絡が大きく動く',
      envMean(speechBuffer) > envMean(toneBuffer) * 10,
      `${envMean(speechBuffer).toFixed(4)} > ${envMean(toneBuffer).toFixed(4)} の 10 倍`,
    );
    // 形の変化では、この 2 つがここまで開かない（実素材では並んでしまう）。
    check(
      '同じ 2 つを形の変化で見ると、開きはずっと小さい',
      midMean(speechFeatures.shapeFlux) < midMean(toneFeatures.shapeFlux) * 10,
      `${midMean(speechFeatures.shapeFlux).toFixed(4)} / ${midMean(toneFeatures.shapeFlux).toFixed(4)}`,
    );

    // 共鳴の居場所だけを動かす（＝口の形だけが動く）と、包絡は動く。
    const sweeping = makeFormantTone(2, sr, { sweep: Math.log(2) / 2 });
    check('共鳴の居場所が動くと包絡が動く', envMean(sweeping) > 0.2, envMean(sweeping).toFixed(4));
    // **ここは「できないこと」を固定しておくための検算。**
    // 口の形を止めたまま音程だけを動かしても、この量は同じくらい動いてしまう。
    // 「口の動きだけを見ている」と思い込むと、ビブラートのかかった楽器で足をすくわれる。
    const gliding = makeFormantTone(2, sr, { glide: 1 });
    check(
      '音程だけ動かしても包絡は動く（音程には不変ではない）',
      envMean(gliding) > envMean(sweeping) * 0.3,
      `音程 ${envMean(gliding).toFixed(4)} / 共鳴 ${envMean(sweeping).toFixed(4)}`,
    );

    // --- 声らしさ ---
    check(
      '声らしさは「揺れる音程のある音」で高い',
      mid(toneFeatures.speechScore) > mid(noiseFeatures.speechScore),
      `${mid(toneFeatures.speechScore).toFixed(3)} > ${mid(noiseFeatures.speechScore).toFixed(3)}`,
    );
    // **ここが今回いちばん大事な検算。**
    // 震える楽器は声ではないのに、声らしさ（揺れの速さ × 音色の尖り）では
    // 本物の声と同じかそれ以上に見える。だから声らしさだけでは弾けない。
    check(
      '震える楽器は、声らしさだけでは声と見分けられない',
      mid(toneFeatures.speechScore) >= mid(speechFeatures.speechScore) * 0.9,
      `震える楽器 ${mid(toneFeatures.speechScore).toFixed(3)} / 声 ${mid(speechFeatures.speechScore).toFixed(3)}`,
    );

    // --- 素材単位で「形がどこでも動かないもの」を弾く ---
    {
      // 震える楽器だけの素材。声らしさは満点に近いが、形はどこでも動かない。
      const tremoloTrack = analyzeLoudness(toneBuffer, 0.02);
      const tremoloPlan = planJetCut(
        tremoloTrack,
        { mode: 'speech' },
        toneFeatures.speechScore,
        toneFeatures.shapeChange,
      );
      check('震える楽器だけの素材では何もしない', tremoloPlan.noSpeechFound, `削った ${tremoloPlan.removed.toFixed(2)} 秒`);
      check('その理由が「形が動かない」と分かる', tremoloPlan.noSpeechReason === 'shape', String(tremoloPlan.noSpeechReason));
      check(
        'そのとき声らしさ自体は高いままである（割合では弾けていない）',
        tremoloPlan.speechRatio > 0.5,
        tremoloPlan.speechRatio.toFixed(3),
      );
      // 形の列を渡さなければ、形では判断しない。渡されないものを
      // 「動いていない」と読むと、既存の呼び出しが軒並み何もしなくなる。
      const withoutShape = planJetCut(tremoloTrack, { mode: 'speech' }, toneFeatures.speechScore);
      check('形の列を渡さなければ形では判断しない', !withoutShape.noSpeechFound, '');

      // 短い素材でも音楽は弾く（必要量を尺に比例させたせいで通ってしまわないこと）。
      const shortTone = makeModulated(1, sr, 4);
      const shortTrack = analyzeLoudness(shortTone, 0.02);
      const shortFeatures = analyzeFeatures(shortTone, shortTrack);
      const shortPlan = planJetCut(
        shortTrack,
        { mode: 'speech' },
        shortFeatures.speechScore,
        shortFeatures.shapeChange,
      );
      check('1 秒の震える楽器でも何もしない', shortPlan.noSpeechFound, String(shortPlan.noSpeechReason));

      // 逆に、短い素材で声を弾かないこと。固定の 0.5 秒だけで見ていたときは、
      // 3 秒に切り詰めた乾いた録音で声を弾いてしまっていた。
      const shortSpeech = makeSpeechLike(3, sr, 4);
      const shortSpeechTrack = analyzeLoudness(shortSpeech, 0.02);
      const shortSpeechFeatures = analyzeFeatures(shortSpeech, shortSpeechTrack);
      const shortSpeechPlan = planJetCut(
        shortSpeechTrack,
        { mode: 'speech' },
        shortSpeechFeatures.speechScore,
        shortSpeechFeatures.shapeChange,
      );
      check(
        '3 秒の声では弾かない',
        !shortSpeechPlan.noSpeechFound,
        `形が動いた ${shortSpeechPlan.shapeSeconds.toFixed(2)} 秒`,
      );
    }

    // speech モードは、声らしさの列を渡さなければ level へ落ちる。黙って落ちないこと。
    const plain = analyzeLoudness(makeTone(3, sr, [{ from: 1, to: 2 }]), 0.02);
    check('声らしさを渡さなければ level に落ちる', planJetCut(plain, { mode: 'speech' }).usedMode === 'level', '');
    const withScore = analyzeFeatures(makeModulated(3, sr, 4), plain);
    check(
      '渡せば speech モードで動く',
      planJetCut(plain, { mode: 'speech' }, withScore.speechScore).usedMode === 'speech',
      '',
    );
    // 既定は level のまま。既存の結果を勝手に変えない。
    check('既定は level のまま', planJetCut(plain).usedMode === 'level', '');
  }

  // --- ヒステリシスと「声が見つからない」 ---
  {
    // 声らしさの列を直接組み立てて、判定の道筋だけを確かめる。
    const sr = 8000;
    const sounding = analyzeLoudness(makeTone(4, sr, [{ from: 0, to: 4 }]), 0.02);
    const frames = sounding.db.length;
    const fill = (fn: (t: number) => number) => {
      const out = new Float32Array(frames);
      for (let i = 0; i < frames; i += 1) out[i] = fn(i * sounding.hop);
      return out;
    };

    // 1〜3 秒が声。ただし 2.00〜2.25 秒だけ声らしさがへこむ（言い淀み）。
    // 余白と「短い無音は残す」で埋まってしまわないよう、どちらも切って裸で見る。
    const dipped = fill((t) => {
      if (t < 1 || t >= 3) return 0.02;
      return t >= 2.0 && t < 2.25 ? 0.14 : 0.5;
    });
    const bare = { mode: 'speech' as const, minSilence: 0.05, padding: 0 };
    const single = planJetCut(sounding, { ...bare, speechExit: 0.2 }, dipped);
    const hyst = planJetCut(sounding, { ...bare, speechExit: 0.1 }, dipped);
    check('一瞬のへこみは、入る値だけだと切れ目になる', single.keep.length === 2, `${single.keep.length} 本`);
    check('ヒステリシスなら切れ目にならない', hyst.keep.length === 1, `${hyst.keep.length} 本`);
    check(
      'それでも声の外までは広がらない',
      hyst.keep[0].start > 0.9 && hyst.keep[0].end < 3.1,
      `${hyst.keep[0].start.toFixed(2)}〜${hyst.keep[0].end.toFixed(2)}`,
    );

    // 声らしさがどこにも無ければ、削らずに何もしない。
    const none = planJetCut(sounding, { mode: 'speech' }, fill(() => 0.01));
    check('声が見つからなければ何もしない', none.noSpeechFound && none.removed === 0, `削った ${none.removed.toFixed(2)} 秒`);
    check('そのとき全部残っている', near(none.resultDuration, none.originalDuration, 1e-6), '');

    // 割合は結果に出る（呼ぶ側が「声の少ない素材では」と判断できるように）。
    const half = planJetCut(sounding, { mode: 'speech' }, fill((t) => (t < 2 ? 0.5 : 0.01)));
    check('声らしいコマの割合が返る', near(half.speechRatio, 0.5, 0.05), half.speechRatio.toFixed(3));
    check('level のときは割合を 1 とする', planJetCut(sounding).speechRatio === 1, '');
  }

  return results;
}
