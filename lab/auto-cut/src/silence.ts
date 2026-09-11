/**
 * 無音カット（ジェットカット）の計画を立てる。
 *
 * やることは 4 段だけ:
 *   1. しきい値を決める（自動なら音量の分布から）
 *   2. しきい値を超えたコマを「鳴っている」とする
 *   3. 前後に余白を足し、短い切れ目は繋いで、鳴っている区間をまとめる
 *   4. 残りを「削る区間」とする
 *
 * 実際に切るのは呼び出し側（edits.ts）。ここは秒の並びを返すだけなので、
 * タイムラインの実装が変わっても使い回せる。
 */

import { percentileDb, SILENCE_DB, type LoudnessTrack } from './loudness.ts';

export interface Range {
  start: number;
  end: number;
}

export interface JetCutOptions {
  /** しきい値（dBFS）。null なら音量の分布から自動で決める。 */
  thresholdDb: number | null;
  /** 自動しきい値の位置。0 = 無音の底ぎりぎり、1 = 声と同じ大きさ。 */
  sensitivity: number;
  /** これより短い無音は繋いだままにする（秒）。息継ぎで切らないため。 */
  minSilence: number;
  /** 声の前後に残す余白（秒）。0 だと語頭・語尾が食われて不自然になる。 */
  padding: number;
  /** これより短くなった残し区間は捨てる（秒）。物音 1 発で 1 カットできるのを防ぐ。 */
  minKeep: number;
  /**
   * 何を見て「鳴っている」と決めるか。
   * - `level`（既定）: 音量だけ。素材が声だけなら、これがいちばん素直で速い
   * - `speech`: 音量に加えて「声らしさ」も見る。BGM や環境音が乗った素材で効く
   */
  mode: 'level' | 'speech';
  /**
   * `speech` のとき、声らしさをどこで切るか（0〜1）。
   * 既定の 0.2 は勘ではなく、正解の分かっている素材 4240 コマで
   * 取りこぼしと誤検出の釣り合いがいちばん良くなる値を探して決めた（probe.mjs）。
   */
  speechThreshold: number;
  /**
   * いったん声だと判断したあと、どこまで下がったら声でないとするか（0〜1）。
   *
   * 入る値と出る値を分けるのは、しゃべっている最中に声らしさが一瞬へこんでも
   * そこで切らないため。1 つのしきい値だけだと、へこむたびに切れ目ができる。
   * `speechThreshold` より大きい値を渡しても、入る値まで引き下げて扱う。
   */
  speechExit: number;
  /**
   * 「声が 1 つも見つからなかった」とみなす下限（0〜1）。
   *
   * 鳴っているコマのうち、声らしいと判断できたものがこの割合に満たなければ、
   * 声の入っていない素材とみなして**何もしない**（丸ごと消してしまうより安全）。
   *
   * 既定が 0.05 と低いのには理由がある。測ったところ:
   *   音楽だけ 28% / BGM の上でたまにしゃべる（20%）46% / よくしゃべる 66〜100%
   * つまり**この割合では「声が無い」と「たまにしか声が無い」を安全に分けられない**。
   * 高くすると、本当に声の入っている素材で何もしなくなる。
   * ここでは誰が見ても声の無い場合（打楽器だけ = 0%）だけを拾い、
   * 判断に迷う範囲は `speechRatio` として返して呼ぶ側に任せる。
   *
   * この割合で拾えない代表が「鳴りっぱなしの音楽」で、そちらは
   * 下の `minShapeChange` / `minShapeSeconds` で見る。
   */
  minSpeechRatio: number;
  /**
   * 「スペクトルの形が動いた」とみなす下限（`FeatureTrack.shapeChange` の値）。
   *
   * 声らしさ（modulation × tone）は「音程のある音が音節の速さで揺れている」だけを見るので、
   * 音程のある楽器を同じ速さで震わせると、声が 1 つも無いのに満点が出る。
   * 割合でも弾けない（`music-tremolo.wav` は 100%）。
   *
   * そこで**別の性質**を見る。形の変化はスペクトルを自分の合計で割ってから比べるので、
   * **音量が何倍になっても動かない**。トレモロは音量が変わっているだけなので反応しない。
   * 一方、声のある素材はどこかで必ず形が動く（語頭・語尾・母音の移り変わり）。
   *
   * なお見ているのは 0.15 秒で均したあとの値なので、**一瞬の棘は数えない**。
   * そこは偶然ではなく効いていて、和音が変わる音楽は切り替わりの生の値が 0.337 まで跳ねる
   * （乾いた声のどのコマよりも大きい）が、均すと 0.09 を 0.04 秒しか超えない。
   */
  minShapeChange: number;
  /**
   * 形が動いた時間がこれに満たなければ、声の入っていない素材とみなす（秒）。
   *
   * **素材の中の最大値ではなく「長さ」で見る**のは、1 コマの外れ値で決めないため。
   * コマごとに掛ける門にはできなかった（乾いた録音では発話中の形の変化が
   * 0.011〜0.046 までしか上がらず、震える楽器の 0.071 より下に来てしまう）。
   * 素材のどこかに動く瞬間があるかを問うなら、そこには十分な開きがある。
   *
   * 実測（鳴っているコマで `shapeChange` が 0.09 以上だった秒数）:
   *   音楽だけ 0.00 秒 / 震える楽器 0.00 秒
   *   声のある素材は、いちばん少ない乾いた録音でも 1.78 秒
   * しきい値 0.075〜0.120・長さ 0.1〜1.0 秒のどこを取っても結論は変わらない。
   *
   * ただしこれは**尺の長い素材での話**なので、短い素材では
   * `SHAPE_SECONDS_OF_DURATION` のぶんまで引き下げる（下の定数を参照）。
   */
  minShapeSeconds: number;
}

/**
 * 形が動いた時間の下限を、尺に対する割合としても持つ。
 *
 * `minShapeSeconds` を固定値だけにすると、**短い素材で本物の声を弾いてしまう**。
 * 3 秒に切り詰めた `speech-dry.wav` は、声が入っているのに形が動いた時間が
 * 0.40 秒しかなく、0.5 秒に届かなかった（ショート動画では 3 秒の素材は普通にある）。
 *
 * 声のある素材で形が動く時間は、尺の 14〜20% だった（いちばん少ない乾いた録音で 14%）。
 * 5% はそこから 3 倍近い余裕を取った値。鳴りっぱなしの音楽は尺に関わらず 0 秒なので、
 * ここを下げても音楽を通すことにはならない。
 */
const SHAPE_SECONDS_OF_DURATION = 0.05;

export const DEFAULT_JET_CUT: JetCutOptions = {
  thresholdDb: null,
  sensitivity: 0.25,
  minSilence: 0.35,
  padding: 0.08,
  minKeep: 0.15,
  mode: 'level',
  speechThreshold: 0.2,
  speechExit: 0.1,
  minSpeechRatio: 0.05,
  minShapeChange: 0.09,
  minShapeSeconds: 0.5,
};

export interface JetCutPlan {
  /** 実際に使ったしきい値（自動決定の結果を見せるため）。 */
  thresholdDb: number;
  /** 残す区間。 */
  keep: Range[];
  /** 削る区間。 */
  cut: Range[];
  originalDuration: number;
  /** 削ったあとの尺。 */
  resultDuration: number;
  /** 削った秒数。 */
  removed: number;
  /**
   * 実際に使った判定のしかた。
   * `speech` を指定しても声らしさの列が渡されていなければ `level` に落ちる。
   * 黙って落ちると「効かないのはなぜか」が分からなくなるので、結果に残す。
   */
  usedMode: 'level' | 'speech';
  /**
   * `speech` で見たが、声らしいところが見つからなかった。
   * このとき keep は「全部残す」になっている（削らない）。
   * 音楽だけの素材を掛け違えて丸ごと消してしまうより、何もしないほうがよい。
   */
  noSpeechFound: boolean;
  /**
   * `noSpeechFound` になった理由。
   * - `ratio`: 声らしいコマがほとんど無かった（打楽器だけなど）
   * - `shape`: 声らしくは見えるが、素材のどこでもスペクトルの形が動かなかった
   *   （鳴りっぱなしの音楽・震える楽器）
   *
   * 分けて返すのは、同じ「何もしない」でも次にすべきことが違うため。
   */
  noSpeechReason: 'ratio' | 'shape' | null;
  /** スペクトルの形が動いていた秒数。`shape` の判断の根拠を見せるため。 */
  shapeSeconds: number;
  /**
   * 鳴っているコマのうち、声らしいと判断できたものの割合（0〜1）。
   * `level` のときは 1。低いときは「声の少ない素材に掛けていないか」を疑う手がかりになる。
   */
  speechRatio: number;
}

/**
 * 音量の分布からしきい値を決める。
 * 下位 10% を「その素材の無音の底（部屋のノイズ）」、上位 10% を「声の大きさ」とみなし、
 * その間を sensitivity で内分する。録音レベルがバラバラな素材でも同じ感覚で効く。
 */
export function autoThresholdDb(track: LoudnessTrack, sensitivity: number): number {
  const floor = percentileDb(track, 0.1);
  const voice = percentileDb(track, 0.9);
  // ほぼ全編が同じ音量（無音だけ・BGM だけなど）のときは、分けようがないので底に張り付ける。
  if (voice - floor < 6) return floor - 1;
  const ratio = Math.max(0, Math.min(1, sensitivity));
  return floor + (voice - floor) * ratio;
}

/** 区間を繋いだり広げたりする小道具。start 昇順で重なりのない列を返す。 */
function mergeRanges(ranges: Range[], gap: number): Range[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const out: Range[] = [];
  for (const range of sorted) {
    const last = out[out.length - 1];
    if (last && range.start - last.end <= gap) {
      last.end = Math.max(last.end, range.end);
    } else {
      out.push({ ...range });
    }
  }
  return out;
}

/** keep の隙間を埋めるかたちで「削る区間」を作る。 */
function complement(keep: Range[], duration: number): Range[] {
  const cut: Range[] = [];
  let cursor = 0;
  for (const range of keep) {
    if (range.start > cursor) cut.push({ start: cursor, end: range.start });
    cursor = Math.max(cursor, range.end);
  }
  if (cursor < duration) cut.push({ start: cursor, end: duration });
  return cut;
}

/**
 * @param speechScore コマごとの声らしさ（0〜1）。`mode: 'speech'` のときだけ使う。
 *   音そのものを見ないと出せない値なので、features.ts で作って渡してもらう。
 * @param shapeChange コマごとのスペクトルの形の変化。渡さなければ形での判断はしない
 *   （渡されないものを「動いていない」と読むと、丸ごと何もしなくなってしまう）。
 */
export function planJetCut(
  track: LoudnessTrack,
  options: Partial<JetCutOptions> = {},
  speechScore?: Float32Array,
  shapeChange?: Float32Array,
): JetCutPlan {
  const opts = { ...DEFAULT_JET_CUT, ...options };
  const thresholdDb = opts.thresholdDb ?? autoThresholdDb(track, opts.sensitivity);
  const duration = track.duration;
  const usedMode = opts.mode === 'speech' && speechScore && speechScore.length === track.db.length ? 'speech' : 'level';

  // 2. しきい値を超えたコマを拾い、そのまま 3. の余白を足す。
  const enter = opts.speechThreshold;
  const exit = Math.min(opts.speechExit, enter);
  let inSpeech = false;
  let soundingFrames = 0;
  let speechFrames = 0;
  const useShape = !!shapeChange && shapeChange.length === track.db.length;
  let shapeFrames = 0;

  const loud: Range[] = [];
  for (let i = 0; i < track.db.length; i += 1) {
    if (track.db[i] <= thresholdDb || track.db[i] <= SILENCE_DB) {
      inSpeech = false;
      continue;
    }
    soundingFrames += 1;
    // 形が動いたかは、声らしさの判定とは独立に数える。
    // 声らしさで絞ってから数えると、震える楽器では「声らしいコマ」が
    // 全編になるので、動かないことを見つけられなくなる。
    if (useShape && (shapeChange as Float32Array)[i] >= opts.minShapeChange) shapeFrames += 1;
    if (usedMode === 'speech') {
      // 入る値と出る値を分ける（ヒステリシス）。しゃべっている最中の
      // 一瞬のへこみで切れ目を作らないため。
      const score = (speechScore as Float32Array)[i];
      inSpeech = inSpeech ? score >= exit : score >= enter;
      if (!inSpeech) continue;
      speechFrames += 1;
    }
    loud.push({
      start: Math.max(0, i * track.hop - opts.padding),
      end: Math.min(duration, (i + 1) * track.hop + opts.padding),
    });
  }

  const speechRatio = usedMode === 'speech' ? (soundingFrames > 0 ? speechFrames / soundingFrames : 0) : 1;
  const shapeSeconds = shapeFrames * track.hop;

  // 声が 1 つも見つからなかったら、何もしない。理由は 2 通りあり、どちらも
  // 単独では取りこぼす（割合は音楽を、形は打楽器を見逃す）ので、両方を見る。
  const lowRatio = soundingFrames > 0 && speechRatio < opts.minSpeechRatio;
  const needShapeSeconds = Math.min(opts.minShapeSeconds, duration * SHAPE_SECONDS_OF_DURATION);
  const noShape = useShape && soundingFrames > 0 && shapeSeconds < needShapeSeconds;
  if (usedMode === 'speech' && (lowRatio || noShape)) {
    const whole = duration > 0 ? [{ start: 0, end: duration }] : [];
    return {
      thresholdDb,
      keep: whole,
      cut: [],
      originalDuration: duration,
      resultDuration: duration,
      removed: 0,
      usedMode,
      noSpeechFound: true,
      noSpeechReason: lowRatio ? 'ratio' : 'shape',
      speechRatio,
      shapeSeconds,
    };
  }

  // 3. 隣り合うものと、minSilence より短い切れ目しかないものを繋ぐ。
  const keep = mergeRanges(loud, opts.minSilence).filter((r) => r.end - r.start >= opts.minKeep);
  const cut = complement(keep, duration);

  const kept = keep.reduce((sum, r) => sum + (r.end - r.start), 0);
  return {
    thresholdDb,
    keep,
    cut,
    originalDuration: duration,
    resultDuration: kept,
    removed: Math.max(0, duration - kept),
    usedMode,
    noSpeechFound: false,
    noSpeechReason: null,
    speechRatio,
    shapeSeconds,
  };
}
