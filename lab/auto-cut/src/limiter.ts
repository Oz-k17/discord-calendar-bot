/**
 * 真のピークを天井の下に抑えるリミッタ（山を均す処理）。
 *
 * これが要る理由は 2026-09-19（3 回目）に測って出ている。倍率を 1 つ掛けるだけでは、
 * **声のある素材の 3 分の 1（41 本中 14 本）が目標のラウドネスへ届かない。**
 * 届かないのは全部ピークの天井で止まったからで、声は波高率が高いので
 * 「-14 LUFS」と「-1 dBTP」は倍率ひとつでは両立しない。
 * 届かせたければ、高いところだけを下げるしかない。
 *
 * ## どこまで潰してよいか（先に決めたこと）
 *
 * 「揃える」と「歪ませる」は同じつまみなので、**入れる前に上限を決めた。**
 * 決めるために測ったのは「目標まで上げたとき、天井をどれだけの時間超えるか」で、
 * 答えは **14 本すべてで 0.04% 以下**（いちばん長い一続きでも 0.29ms）だった。
 * つまり**均す相手は極めて短く、まばら**で、深さも 1 本を除いて 2dB 以下。
 * 手を出す時間が短いので、ここは素直に効く。
 *
 * 上限（`maxReductionDb`）を置いているのは、それでも深く潰しにいく素材があるため。
 * 深く潰すのは「小さくして済ませた」のと変わらないので、そこは届かないままにして
 * `limitedBy: 'limiter'` で外へ出す。判断は呼ぶ側に返す。
 *
 * ## なぜ先読みが要るか
 *
 * 天井を超えた瞬間に倍率を落とすと、波形の角を削ることになる（それは歪み）。
 * 先に超えるところを見つけて、**手前からなめらかに下げておく**ので先読みが要る。
 * 先読みの長さは歪みと直結していて、**その半周期より低い音は歪む**
 * （倍率がその音の 1 周期の中で動くと、削っているのは音そのものになる）。
 * 実際に測った表は下の `DEFAULT_LIMITER` の注にある。
 *
 * ## 分かっている限界
 *
 * **尺に比例してメモリを食う。** 倍率の列を 4 本（いずれも倍精度）と、
 * 真のピークの列（チャンネルごとに 1 本、そのつど捨てる）を持つので、
 * 標本 1 つあたり 40 バイト ＋ 8 バイトかかる。13 秒 1ch で 26MB、10 分なら 1.2GB になる。
 * 13 秒の試し素材では問題にならないが、**長尺に当てるなら区間ごとに流す形へ直すこと**
 * （倍率の作り方は先読みの窓 L しか先を見ないので、L ぶん重ねて繋げば分割できる）。
 *
 * **通したあとに真のピークを測り直すぶん、倍率を当てるより 2 倍以上重い**（13 秒 1ch で 150ms）。
 * 守れていることを毎回確かめるための代価で、外していない。
 *
 * DOM にも WebAudio にも依存しない（`lufs.ts` と同じ方針）。Node でそのまま検算できる。
 */

import { SILENCE_DB, type AudioLike } from './loudness.ts';
import { truePeakEnvelope } from './lufs.ts';

export interface LimiterOptions {
  /** 真のピークの上限（dBTP）。ここを超えさせない。 */
  ceilingDb?: number;
  /** 先読み（ミリ秒）。下げ始めてから下げ終わるまでの時間でもある。 */
  lookAheadMs?: number;
  /** 戻り（ミリ秒）。下げた倍率が 1 倍へ戻るまでの時定数。 */
  releaseMs?: number;
  /**
   * 下げてよい深さの上限（dB）。ここより深くは下げない。
   *
   * **超えるぶんは天井を超えたまま出る**（`clamped` が立つ）。呼ぶ側が先に倍率を抑えておくのが本来で
   * （`planLoudnessNormalization` の `limiterHeadroomDb` がそれ）、ここはあくまで最後の歯止め。
   * **0 を渡すと歯止め無し**（天井を守るために必要なだけ、どこまでも深く下げる）。
   */
  maxReductionDb?: number;
}

/**
 * 既定値。**振って測って決めた**ので、動かすなら同じ表を作り直すこと。
 *
 * ### 先読み 10ms — 低い音が歪まない下限
 *
 * 正弦波を 6dB ぶん潰し続けたときの全高調波歪み（dB）:
 *
 * | 先読み | 30Hz | 40Hz | 50Hz | 60Hz | 100Hz | 250Hz |
 * | --- | --- | --- | --- | --- | --- | --- |
 * | 1ms | -25 | -27 | -29 | -31 | -36 | -54 |
 * | 2ms | -26 | -29 | -32 | -34 | -43 | 無し |
 * | 5ms | -32 | -37 | -42 | -47 | 無し | 無し |
 * | 10ms | -42 | -60 | **無し** | 無し | 無し | 無し |
 * | 20ms | 無し | 無し | 無し | 無し | 無し | 無し |
 *
 * 「無し」は -160dB 以下（倍率が動かなくなる＝ただ小さくしているだけになる）。
 * **消える位置は、その音の半周期とぴたり一致する**（50Hz なら 10ms、30Hz なら 16.7ms）。
 * 倍率が 1 周期の中で動けば、それは音そのものを削っているのと同じなので、当然そうなる。
 * 10ms を選んだのは、**50Hz から上が丸ごと「無し」に入る**いちばん短い位置だから。
 * 人の声の基本波は 85Hz より上、音楽の最低音も 40Hz 前後なので、ここで足りる。
 *
 * 先読みを伸ばす代価はほとんど無い（素材 41 本で手を出した時間の平均は
 * 5ms で 0.80%・10ms で 0.85%・20ms で 0.95%）。**歪みは 1 オクターブで 12dB 減り、
 * 代価は比例でしか増えない**ので、迷ったら長いほうでよい。
 *
 * ### 戻り 5ms — 歪みには効かない。効くのは「下げている時間」だけ
 *
 * 普通のリミッタで戻りを長く取るのは、速く戻すと波形が削れる（歪む）からだが、
 * **ここではその理屈が要らない。** 倍率の動く速さを決めているのは移動平均（＝先読み）で、
 * 戻りではないため。実際、天井の下で鳴る 60Hz の上に打点を 5 回/秒だけ乗せた形で測ると:
 *
 * | 戻り | 60Hz の歪み | 倍率の平均 | 倍率のばらつき | 手を出した割合 |
 * | --- | --- | --- | --- | --- |
 * | 2ms | -43.0dB | -0.15dB | 0.51dB | 10.3% |
 * | 5ms | -43.4dB | -0.18dB | 0.56dB | 14.2% |
 * | 20ms | -43.5dB | -0.36dB | 0.69dB | 35.4% |
 * | 50ms | -43.2dB | -0.70dB | 0.78dB | 78.5% |
 * | 200ms | -42.2dB | -1.61dB | 0.73dB | 90.5% |
 *
 * **歪みは動かない。** 長くすると下げている時間だけが伸びる（＝余計に音が小さくなる）。
 * それなら短いほうがよい。2ms ではなく 5ms にしたのは、
 * 移動平均が 10ms あるので**これより短くしても平均のほうで鈍る**（差が出ない）から。
 *
 * ### 深さの上限 6dB — 「均した」と「消した」の境目
 *
 * `speech-click.wav`（13 秒のうち 0.25 秒だけ机を叩く音）が要求するのは 6.67dB。
 * **あの 1 本を届かせるために打撃を 7dB 潰すのは、均したのではなく消したのと同じ**なので、
 * わざと外した位置に置いてある。残る 13 本は 0.16〜2.05dB なので、全部この内側に入る。
 */
export const DEFAULT_LIMITER: Required<LimiterOptions> = {
  ceilingDb: -1,
  lookAheadMs: 10,
  releaseMs: 5,
  maxReductionDb: 6,
};

export interface LimiterReport {
  /** いちばん深く下げた量（dB。下げていなければ 0）。 */
  maxReductionDb: number;
  /** 倍率を 0.1dB 以上下げていた時間（秒）。**「どれだけ手を出したか」はここで読む。** */
  activeSeconds: number;
  /** 上と同じものを素材の長さに対する割合で（0〜1）。 */
  activeRatio: number;
  /** 下げた量の、下げていた間での平均（dB）。 */
  meanReductionDb: number;
  /** 深さの上限に当たったか。**立っていたら天井を超えたまま出ている。** */
  clamped: boolean;
  /** 処理後の真のピーク（dBTP）。天井を守れているかはここで確かめる。 */
  truePeakDb: number;
}

export interface LimiterResult {
  buffer: AudioLike;
  report: LimiterReport;
}

/** 0.1dB 未満の上げ下げは「手を出した」と数えない（読みの端数と区別が付かないため）。 */
const ACTIVE_DB = 0.1;

/**
 * 天井を超えるところだけを下げる。**元の音は壊さない**（新しい列を返す）。
 *
 * 倍率の作り方は 3 段:
 *
 *   1. `need[j]` = その標本で許される倍率（真のピークの列から作る）
 *   2. `min[j]`  = 先読みの窓 L の中の最小（＝**超える手前から下がり始める**）
 *   3. `smooth`  = 長さ L の移動平均（＝角を取る）。あいだに戻りの制限を挟む
 *
 * **2 と 3 の窓を同じ長さにしてあるのが肝。** そうすると、山の位置 p では
 * 平均に入る L 個がどれも「p を含む窓の最小」なので、**どれも `need[p]` 以下**になる。
 * つまり平均も `need[p]` 以下で、天井を超えないことが計算せずに言える。
 * 移動平均のほうを先読みより長くすると、この理屈が崩れる（山より前の、まだ下がる前の
 * 値が平均に混ざる）。**戻りを遅くしたいときは、平均の長さではなく 2 と 3 のあいだで行う**
 * ＝ 倍率が 1 倍へ戻る速さだけを縛る。下げる側は縛らないので保証はそのまま。
 */
export function limitTruePeak(buffer: AudioLike, options: LimiterOptions = {}): LimiterResult {
  const { ceilingDb, lookAheadMs, releaseMs, maxReductionDb } = { ...DEFAULT_LIMITER, ...options };
  const { sampleRate, numberOfChannels, length } = buffer;
  const ceiling = Math.pow(10, ceilingDb / 20);
  const floor = maxReductionDb > 0 ? Math.pow(10, -maxReductionDb / 20) : 0;

  // 先読みは最低 1 標本。0ms を渡されても「角をそのまま削る」形へは落とさない。
  const look = Math.max(1, Math.round((lookAheadMs / 1000) * sampleRate));
  // 戻りは時定数。1 標本あたりどれだけ 1 倍へ近づいてよいか。
  const releaseSamples = Math.max(1, Math.round((releaseMs / 1000) * sampleRate));
  const releaseAlpha = Math.exp(-1 / releaseSamples);

  // --- 1. 標本ごとに許される倍率 ---
  // **チャンネルをまたいで同じ倍率を当てる。** 片側だけ下げると定位が動く
  // （音が左右にふらつく）ので、いちばん厳しいチャンネルに合わせる。
  const need = new Float64Array(length);
  need.fill(1);
  for (let c = 0; c < numberOfChannels; c += 1) {
    const env = truePeakEnvelope(buffer.getChannelData(c));
    for (let i = 0; i < length; i += 1) {
      if (env[i] > ceiling) {
        const g = ceiling / env[i];
        if (g < need[i]) need[i] = g;
      }
    }
  }
  let clamped = false;
  if (floor > 0) {
    for (let i = 0; i < length; i += 1) {
      if (need[i] < floor) {
        need[i] = floor;
        clamped = true;
      }
    }
  }

  // --- 2. 先読みの窓の最小 ---
  // 単調な両端キュー（deque）で走らせる。窓ごとに数え直すと L 倍になる。
  const minAhead = new Float64Array(length);
  {
    const idx = new Int32Array(length);
    let head = 0;
    let tail = 0; // [head, tail) が候補
    let next = 0;
    for (let i = 0; i < length; i += 1) {
      const until = Math.min(length - 1, i + look);
      while (next <= until) {
        while (tail > head && need[idx[tail - 1]] >= need[next]) tail -= 1;
        idx[tail] = next;
        tail += 1;
        next += 1;
      }
      while (idx[head] < i) head += 1;
      minAhead[i] = need[idx[head]];
    }
  }

  // --- 3. 戻りの制限 → 移動平均 ---
  // 戻りは「1 倍へ近づく速さ」だけを縛る。下げる側は縛らないので、先読みで見つけた山には
  // 必ず間に合う（間に合わなければ天井を超える）。
  const held = new Float64Array(length);
  {
    let g = 1;
    for (let i = 0; i < length; i += 1) {
      // 下げるのは即座、戻るのは時定数ぶん。**どちらの場合も窓の最小を超えさせない**
      // （超えさせると、下の移動平均を通したあとに天井を超えうる）。
      g = Math.min(minAhead[i], 1 - (1 - g) * releaseAlpha);
      held[i] = g;
    }
  }

  const window = look; // 2 と同じ長さ。ここを変えると天井の保証が壊れる。
  const gain = new Float64Array(length);
  {
    let acc = 0;
    for (let i = 0; i < length; i += 1) {
      acc += held[i];
      if (i >= window) acc -= held[i - window];
      const n = Math.min(i + 1, window);
      gain[i] = acc / n;
    }
  }

  // --- 当てる ---
  const channels: Float32Array[] = [];
  for (let c = 0; c < numberOfChannels; c += 1) {
    const src = buffer.getChannelData(c);
    const out = new Float32Array(length);
    for (let i = 0; i < length; i += 1) out[i] = src[i] * gain[i];
    channels.push(out);
  }
  const result: AudioLike = {
    sampleRate,
    numberOfChannels,
    length,
    getChannelData: (c: number) => channels[c],
  };

  // --- どれだけ手を出したか ---
  const activeGain = Math.pow(10, -ACTIVE_DB / 20);
  let activeSamples = 0;
  let minGain = 1;
  let sumDb = 0;
  for (let i = 0; i < length; i += 1) {
    if (gain[i] < activeGain) {
      activeSamples += 1;
      sumDb += -20 * Math.log10(gain[i]);
    }
    if (gain[i] < minGain) minGain = gain[i];
  }
  let after = 0;
  for (let c = 0; c < numberOfChannels; c += 1) {
    const env = truePeakEnvelope(channels[c]);
    for (let i = 0; i < length; i += 1) if (env[i] > after) after = env[i];
  }

  return {
    buffer: result,
    report: {
      maxReductionDb: minGain < 1 ? -20 * Math.log10(minGain) : 0,
      activeSeconds: activeSamples / sampleRate,
      activeRatio: length > 0 ? activeSamples / length : 0,
      meanReductionDb: activeSamples > 0 ? sumDb / activeSamples : 0,
      clamped,
      truePeakDb: after > 0 ? Math.max(SILENCE_DB, 20 * Math.log10(after)) : SILENCE_DB,
    },
  };
}
