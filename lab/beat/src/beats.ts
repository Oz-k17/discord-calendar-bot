/**
 * 音から拍を出す、ひとつの入口。
 *
 * `onset.ts`（立ち上がりの列）と `tempo.ts`（テンポと位相）を繋ぐだけの薄い層。
 * 呼ぶ側はここだけを見ればよく、中の 2 段がどう分かれているかは知らなくてよい。
 *
 * ## なぜ列を 2 本作るのか（2026-09-21 に測って決めた）
 *
 * **テンポを当てる仕事と、拍の位置を当てる仕事は、欲しい列が違う。**
 * 15 本の素材で組み合わせを並べるとこうなった（`lab:beat:probe` の 5 段目）:
 *
 * | テンポに使う列 | 位相に使う列 | BPM の当たり | 拍の F 値 |
 * | --- | --- | --- | --- |
 * | energy | energy | 13/13 | 0.875 |
 * | flux | flux | 12/13 | 0.922 |
 * | **energy** | **flux** | **13/13** | **0.968** |
 * | energy | logFlux | 13/13 | 0.806 |
 * | flux | energy | 12/13 | 0.838 |
 *
 * 理由は測って分かった。テンポに要るのは**列が周期的であること**で、
 * 帯ごとに見る手は鳴っていない帯の揺れまで数えるぶん周期が薄くなる（`onset.ts` の注）。
 * 位相に要るのは**打点どうしの大きさの釣り合いが正しいこと**で、
 * ここで音量を dB（比）で見ると**長く響く音の後ろに来た打点が小さく見える**。
 *
 * 後者は `syncopated-128` で出た。ウラのキック（減衰 0.10 秒）が鳴っている間に
 * オモテのスネアが来るので、dB で測るとスネアの立ち上がりがキックの尾に埋もれる。
 * **オモテの強さを 1.27 倍まで上げても位相は動かなかった**——つまみが的を外していて、
 * 効いていたのは強さではなく**何を基準に引き算しているか**だった。
 * そのまま（線形）のスペクトルで引き算すると、同じ素材で拍が 0 本 → 34 本になる。
 *
 * **これは 2026-09-18（2 回目）の「犯人は比ではなく対数だった」と同じ形の穴。**
 * あのときは 3〜6Hz の揺れが dB へ直した所で縮んでいた。今回は打点の大きさが
 * dB へ直した所で前の音の尾に潰されている。**対数は「前に何があったか」で値を変える。**
 */

import { analyzeOnset, DEFAULT_ONSET, type OnsetOptions, type OnsetTrack } from './onset.ts';
import {
  DEFAULT_TEMPO,
  DEFAULT_TEMPO_CURVE,
  estimateTempo,
  estimateTempoCurve,
  placeBeats,
  placeBeatsVarying,
  type TempoCurve,
  type TempoCurveOptions,
  type TempoResult,
} from './tempo.ts';
import type { AudioLike } from '../../auto-cut/src/loudness.ts';

export interface BeatOptions extends Partial<TempoCurveOptions> {
  /** 立ち上がりの列の作り方（刻み・窓など）。`method` は下の 2 つで上書きする。 */
  onset?: Partial<OnsetOptions>;
  /** テンポを出すのに使う列。既定は `energy`。 */
  tempoMethod?: OnsetOptions['method'];
  /**
   * 拍の位置を出すのに使う列。既定は `flux`。
   * `tempoMethod` と同じにすれば、列は 1 本しか作らない。
   */
  phaseMethod?: OnsetOptions['method'];
  /**
   * 途中で変わるテンポを追うか（2026-09-21・2 回目に足した。**既定は追わない**）。
   *
   * **作って、測って、既定にしなかった。** 窓ごとのテンポ自体はよく当たる
   * （局所の正解からのずれは中央値 0.0〜0.6%）のに、**その周期で拍を並べると平均で負ける**。
   *
   * | | 追わない | 窓 4s | 窓 5s | 窓 6s | 窓 8s |
   * | --- | --- | --- | --- | --- | --- |
   * | 拍の F 値（16 本） | **0.922** | 0.895 | 0.941 | 0.882 | 0.915 |
   *
   * 5s だけが勝つが、その得は `tempo-change-90-120` が 0.667 → 1.000 に裏返ったぶんで、
   * **鏡にした `tempo-change-120-90` は 0.607 のまま**。理由は下に書いた。
   * 窓の長さを 1 つ変えるだけで跳ねる並びは、「効いた」ではなく「1 本が裏返った」。
   *
   * 失うほうは `pad-only-96`（1.000 → 0.840）と `speech-over-110`（0.966 → 0.690）で、
   * どちらも**窓ごとのテンポが暴れる素材**。得るほうは `tempo-ramp-100-130`
   * （0.508 → 1.000）。**追えるようになる素材と、迷子になる素材が同じ数だけいる。**
   *
   * 残してあるのは、**窓ごとのテンポそのものは使える**から
   * （テンポの表示や、テンポが動いたことを知らせる用途ならこのままで足りる）。
   */
  followTempo?: boolean;
}

export interface BeatResult extends TempoResult {
  /** テンポを出すのに使った列。 */
  tempoTrack: OnsetTrack;
  /** 拍の位置を出すのに使った列（同じ手なら `tempoTrack` と同じもの）。 */
  phaseTrack: OnsetTrack;
  /**
   * 窓ごとのテンポ（追っていないときは null）。
   *
   * **`bpm` はこのとき「素材ぜんたいの見出し」でしかない。** テンポが動く素材で
   * 1 つの数字を表示したいときのためだけに残してあり、拍の位置はこちらから出ている。
   * 名前を `tempoCurve` にしてあるのは、`TempoResult.curve`
   * （BPM ごとの点数）と別物だから。**同じ「curve」で 2 つを指さない。**
   */
  tempoCurve: TempoCurve | null;
  /** 拍の間隔が素材の中でどれだけ動いたか（いちばん速い BPM ÷ いちばん遅い BPM）。1.0 なら一定。 */
  tempoSpread: number;
}

export const DEFAULT_BEATS: Required<Pick<BeatOptions, 'tempoMethod' | 'phaseMethod' | 'followTempo'>> = {
  tempoMethod: 'energy',
  phaseMethod: 'flux',
  followTempo: false,
};

/**
 * 音から拍を出す。
 *
 * 拍が見つからなければ `bpm: null` / `beats: []` を返す（投げない）。
 * 空の音・雑音だけ・尺が短すぎる、のいずれでも同じ。
 */
export function detectBeats(buffer: AudioLike, options: BeatOptions = {}): BeatResult {
  const { onset, tempoMethod, phaseMethod, followTempo, ...tempoOptions } = options;
  const tempoWith = tempoMethod ?? DEFAULT_BEATS.tempoMethod;
  const phaseWith = phaseMethod ?? DEFAULT_BEATS.phaseMethod;
  const follow = followTempo ?? DEFAULT_BEATS.followTempo;

  const shared: Partial<OnsetOptions> = { ...DEFAULT_ONSET, ...onset };
  const tempoTrack = analyzeOnset(buffer, { ...shared, method: tempoWith });
  // 同じ手なら作り直さない（FFT を 2 度回す意味が無い）。
  const phaseTrack = phaseWith === tempoWith ? tempoTrack : analyzeOnset(buffer, { ...shared, method: phaseWith });

  if (!follow) {
    const result = estimateTempo(tempoTrack, tempoOptions);
    if (result.period == null) return { ...result, tempoTrack, phaseTrack, tempoCurve: null, tempoSpread: 1 };
    // 周期はテンポの列から、位置は位相の列から。
    const { phase, beats } = placeBeats(phaseTrack, result.period, { ...DEFAULT_TEMPO, ...tempoOptions });
    return { ...result, phase, beats, tempoTrack, phaseTrack, tempoCurve: null, tempoSpread: 1 };
  }

  // **窓ごとのテンポはテンポの列から、拍の位置は位相の列から。**
  // 追う側でも 2 本に分ける形は変えていない（9/21・1 回目に測って決めた既定）。
  const tempoCurve = estimateTempoCurve(tempoTrack, { ...DEFAULT_TEMPO_CURVE, ...tempoOptions });
  const result = tempoCurve.global;
  if (result.period == null) return { ...result, tempoTrack, phaseTrack, tempoCurve: null, tempoSpread: 1 };

  const { phase, beats } = placeBeatsVarying(phaseTrack, tempoCurve, { ...DEFAULT_TEMPO, ...tempoOptions });
  return { ...result, phase, beats, tempoTrack, phaseTrack, tempoCurve, tempoSpread: spreadOf(tempoCurve) };
}

/** 拍の間隔が素材の中でどれだけ動いたか。1.0 なら一定。 */
function spreadOf(curve: TempoCurve): number {
  let min = Infinity;
  let max = 0;
  for (let i = 0; i < curve.periods.length; i += 1) {
    const p = curve.periods[i];
    if (!(p > 0)) continue;
    min = Math.min(min, p);
    max = Math.max(max, p);
  }
  return Number.isFinite(min) && max > 0 ? max / min : 1;
}

/**
 * 拍の秒の並びを、タイムラインが吸い付く先として使えるようにする。
 *
 * `n` を 2 にすれば 8 分、4 にすれば 16 分の位置も足す（拍の間を等分する）。
 * **拍そのものより細かい所に吸い付けたいときがある**（短い素材では 1 拍ごとだと粗い）。
 * 間を等分しているだけなので、ハネた曲では実際の音とずれる——そこは拍の列のほうを見ること。
 */
export function subdivide(beats: number[], n: number): number[] {
  if (n <= 1 || beats.length < 2) return beats.slice();
  const out: number[] = [];
  for (let i = 0; i < beats.length; i += 1) {
    out.push(beats[i]);
    if (i + 1 >= beats.length) break;
    const step = (beats[i + 1] - beats[i]) / n;
    for (let k = 1; k < n; k += 1) out.push(Math.round((beats[i] + step * k) * 1e6) / 1e6);
  }
  return out;
}

/**
 * いちばん近い拍へ寄せる。カットの秒を渡すと、拍に合った秒が返る。
 *
 * `maxShift` を超えて動かさないのは、**拍から遠いカットは動かさないほうがよい**から。
 * 曲に合わせたいのは「もともと拍の近くにあるカット」で、
 * 話の切れ目でたまたま拍から遠い所に来たカットまで引っ張ると、逆に言葉が切れる。
 */
export function snapToBeat(time: number, beats: number[], maxShift = 0.12): number {
  if (beats.length === 0) return time;
  let best = time;
  let bestGap = Infinity;
  for (const b of beats) {
    const gap = Math.abs(b - time);
    if (gap < bestGap) {
      bestGap = gap;
      best = b;
    }
  }
  return bestGap <= maxShift ? best : time;
}
