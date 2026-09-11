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
   * 既定の 0.2 は勘ではなく、正解の分かっている素材で取りこぼしと誤検出の
   * 釣り合いがいちばん良くなる値を探して決めた（probe.mjs）。
   * 2026-09-11 の 2 回目に素材の声を作り直して測り直したところ、
   * 7331 コマで最良は 0.250（声を拾えた率 95% / 声でないのに拾った率 27%）。
   * 0.2 のままにしてあるのは、**取りこぼす側に倒れないほうを選んでいる**ため。
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
   * 既定が 0.05 と低いのは、**包絡の門を入れる前はこの割合で音楽と声を分けられなかった**ため。
   * 当時の実測は 音楽だけ 28% / BGM の上でたまにしゃべる（20%）43% / よくしゃべる 63〜100% で、
   * 線を引けば必ずどちらかを壊した。そこで誰が見ても声の無い場合（打楽器だけ = 0%）だけを拾い、
   * 判断に迷う範囲は `speechRatio` として返して呼ぶ側に任せている。
   *
   * 門（`minEnvelopeChange`）を入れて割合は大きく動いたが、**線を引けないことは変わらなかった**:
   *   音楽だけ 0% / 震える楽器 0% / 和音が 1.5 秒ごとに変わる音楽 7%
   *   → ここまでは下がったが、
   *   **和音が 0.4 秒ごとに変わる音楽 51% / たまにしゃべる声 29% / `music-wah` 100%**
   * **声の無い素材が、声のある素材を追い越す。** 締めれば本物の声を弾く、緩めれば音楽を通す。
   * 2026-09-11 の 3 回目に `music-chords-fast.wav` を作って確かめた（作る前は
   * 「門を入れたから 9% 以下と 29% 以上で切れる」と思っていた）。0.05 のままにしてある。
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
   * そこは偶然ではなく効いていて、和音が変わる音楽は切り替わりの生の値が 0.337 まで跳ね、
   * これは BGM 込みで録った声のどのコマ（最大 0.371）とほぼ並ぶ。
   * 生の値で「一度でも動いたか」を見ていたら、この素材で破れていた。
   * 均すと 0.09 を 0.04 秒しか超えない。
   */
  minShapeChange: number;
  /**
   * 形が動いた時間がこれに満たなければ、声の入っていない素材とみなす（秒）。
   *
   * **素材の中の最大値ではなく「長さ」で見る**のは、1 コマの外れ値で決めないため。
   * 素材のどこかに動く瞬間があるかを問うなら、そこには十分な開きがある。
   *
   * 実測（鳴っているコマで `shapeChange` が 0.09 以上だった秒数。13 秒の素材）:
   *   音楽だけ 0.00 秒 / 震える楽器 0.00 秒 / 和音が 1.5 秒ごとに変わる音楽 0.04 秒
   *   **和音が 0.4 秒ごとに変わる音楽 0.30 秒**（2026-09-11 の 3 回目に足した素材）
   *   声のある素材は、いちばん少ない「BGM の上でたまにしゃべる」でも 2.76 秒
   * **開きは 9 倍。** 以前ここには「60 倍以上あり、しきい値をどこに置いても結論は変わらない」と
   * 書いてあったが、和音の変化を速くしただけで 0.04 → 0.30 秒に上がった。0.5 秒との差は 1.7 倍しか
   * 無いので、**もう少し速い曲を持ってくれば破れる**。いまここを締められないのは、
   * 下限をこれ以上上げると短い素材で本物の声を弾くため（下の `SHAPE_SECONDS_OF_DURATION`）。
   *
   * ここは**声のある素材を弾かない**ことだけを見ればよい。声の無い素材を通しても
   * 害は無い（そのあとの声らしさで弾かれる）が、声のある素材を弾くと
   * その素材では機能そのものが働かなくなる。
   *
   * ただしこれは**尺の長い素材での話**なので、短い素材では
   * `SHAPE_SECONDS_OF_DURATION` のぶんまで引き下げる（下の定数を参照）。
   */
  minShapeSeconds: number;
  /**
   * コマ単位の門。包絡（フォルマントの居場所）がこれだけ動いたコマだけを声とみなす
   * （`FeatureTrack.envelopeChange` の値）。0 にすると門を開けっぱなしにできる。
   *
   * 素材単位の `minShapeChange` との違いは、**そのコマを残すかどうかを直に決める**こと。
   * 素材単位の判定は「この素材に声があるか」しか言えないので、`music-wah` のように
   * 声が無いのに声らしく見える素材を通してしまうと、そこから先は何も守れない。
   *
   * 値が 0.09 なのは、2026-09-11 の 2 回目に測った分かれ目から採った
   * （鳴っているコマの中央値で、乾いた声 0.270 に対し震える楽器 0.009・音楽だけ 0.003）。
   * ただし**この門だけでは母音を伸ばす声を切る**（残せた率 41%）。下の保持と必ず対で使う。
   */
  minEnvelopeChange: number;
  /**
   * 包絡の門がいったん開いたら、そのあと何秒は開けたままにするか（秒）。
   *
   * **母音を伸ばしている間は口が動かないので、包絡も動かない。** 門だけを置くと
   * 「あー」と伸ばした所で声を切る。ところが**伸ばした母音の前には必ず声の立ち上がりがある**
   * ので、いったん開いたら少し開けておけば、伸ばしている間も通る。
   *
   * 長くするほど声を取りこぼさなくなるが、余計なものも残るようになる。素直な交換。
   * 実測（余白と「短い無音は残す」を外し、門の効きだけを裸で見たもの）:
   *   保持                 0 秒  0.2  0.3  0.4  **0.5**  0.6  0.8
   *   母音を伸ばす声の残せた率  56%  80%  85%  92%  **97%**  97%  97%
   *   たまにしゃべる素材の精度  84%  76%  74%  72%  **70%**  68%  68%
   * **0.5 秒で残せた率が頭打ちになる。** そこから先は精度が落ちるだけなので 0.5 を採った。
   *
   * なお JOURNAL の 2026-09-11（2 回目）に「0.6 秒」と見積もってあったが、
   * それはコマ単位で数えた値で、**実際の切り口はそこまで悪くならない**
   * （区間をまとめる工程が短い穴を埋めるため。既定の設定なら 0.2 秒で 100% に届く）。
   * 裸で測り直して、頭打ちの位置を採り直した。
   *
   * **この保持には、鎖のように繋がる弱点がある。** 保持より短い間隔で音色が動き続けると、
   * 門は一度も閉まらない。`music-chords-fast.wav`（和音が 0.4 秒ごとに変わる音楽・声なし）が
   * まさにそれで、声だと判断されるコマの割合が 保持 0 秒で 23% → 0.5 秒で 51% まで伸びる。
   * ただし**保持を 0 にしても 23% で、たまにしゃべる声（24%）と並ぶ**ので、
   * これは保持のせいではなく門そのものの限界。保持を短くしても解決しない。
   */
  envelopeHold: number;
}

/**
 * 形が動いた時間の下限を、尺に対する割合としても持つ。
 *
 * `minShapeSeconds` を固定値だけにすると、**短い素材で本物の声を弾いてしまう**。
 * 2026-09-10 の時点では、3 秒に切り詰めた `speech-dry.wav` が、声が入っているのに
 * 形が動いた時間が 0.40 秒しかなく、0.5 秒に届かなかった（ショート動画では
 * 3 秒の素材は普通にある）。
 *
 * **2026-09-11 の 2 回目に素材の声を作り直したら、同じ 3 秒で 1.30 秒動くようになった**
 * ので、いまの素材だけを見るならこの安全弁は要らない。それでも残してあるのは、
 * 当時弾かれたのが「平板な合成音だったから」なのか「尺が短いから」なのかを
 * 切り分けられていないため。落として困るのは声のある素材だけで、
 * 鳴りっぱなしの音楽は尺に関わらず 0 秒なので、下げておいても音楽は通らない。
 *
 * 声のある素材で形が動く時間は、いまは尺の 21〜81% ある
 * （いちばん少ないのは「BGM の上でたまにしゃべる」の 21%）。5% はそこから 4 倍の余裕。
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
  minEnvelopeChange: 0.09,
  envelopeHold: 0.5,
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
   * - `ratio`: 声だと判断できたコマがほとんど無かった（打楽器だけなど）。
   *   包絡の門も判断の一部なので、**「音色がどこでも動かない」もここに入る**。
   *   門を入れてから、鳴りっぱなしの音楽と震える楽器はこちらで落ちるようになった
   *   （以前は下の `shape` で落ちていた）。
   * - `shape`: 声だと判断できたコマはあるが、素材のどこでもスペクトルの形が続けて動かなかった
   *
   * 分けて返すのは、同じ「何もしない」でも次にすべきことが違うため。
   */
  noSpeechReason: 'ratio' | 'shape' | null;
  /** スペクトルの形が動いていた秒数。`shape` の判断の根拠を見せるため。 */
  shapeSeconds: number;
  /**
   * 包絡の門が開いていた秒数（鳴っているコマのうち）。
   *
   * 保持のぶんも含む。**保持が音楽の一瞬の動きを引き伸ばしていないか**を
   * 外から確かめるために出している。声の無い素材でここが伸びていたら、
   * 保持が長すぎるということ。
   */
  envelopeSeconds: number;
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
 * @param envelopeChange コマごとの包絡の動き。渡さなければ包絡の門は置かない。
 *   `shapeChange` と同じ理由で、**渡されないものを「動いていない」と読まない**
 *   （読んでしまうと、列を渡し忘れただけで声が 1 コマも残らなくなる）。
 */
export function planJetCut(
  track: LoudnessTrack,
  options: Partial<JetCutOptions> = {},
  speechScore?: Float32Array,
  shapeChange?: Float32Array,
  envelopeChange?: Float32Array,
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
  // 包絡の門。開いたコマの番号を覚えておき、そこから holdFrames コマ先までは開けたままにする。
  const useEnvelope = !!envelopeChange && envelopeChange.length === track.db.length && opts.minEnvelopeChange > 0;
  const holdFrames = Math.max(0, Math.round(opts.envelopeHold / track.hop));
  let envelopeOpenUntil = -1;
  let envelopeFrames = 0;

  const loud: Range[] = [];
  for (let i = 0; i < track.db.length; i += 1) {
    if (track.db[i] <= thresholdDb || track.db[i] <= SILENCE_DB) {
      inSpeech = false;
      // 無音を挟んだら保持も切る。前の発話の余韻で、そのあとに来た音楽まで通してしまわないため。
      // 保持が守りたいのは「ひと続きの声の中で伸ばした母音」だけで、無音をまたぐ必要は無い。
      envelopeOpenUntil = -1;
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
      // 包絡の門。声らしさ（揺れ × 音程）は「音色が動いているか」を見ていないので、
      // ここで口の動きを要求して、鳴りっぱなしの音を落とす。
      // inSpeech（声らしさ側の状態）はここでは触らない。門で閉めたことを
      // 「声でなくなった」と読むと、ヒステリシスが毎回入り直しになってしまう。
      if (useEnvelope) {
        if ((envelopeChange as Float32Array)[i] >= opts.minEnvelopeChange) envelopeOpenUntil = i + holdFrames;
        if (i > envelopeOpenUntil) continue;
        envelopeFrames += 1;
      }
      speechFrames += 1;
    }
    loud.push({
      start: Math.max(0, i * track.hop - opts.padding),
      end: Math.min(duration, (i + 1) * track.hop + opts.padding),
    });
  }

  const speechRatio = usedMode === 'speech' ? (soundingFrames > 0 ? speechFrames / soundingFrames : 0) : 1;
  const shapeSeconds = shapeFrames * track.hop;
  const envelopeSeconds = envelopeFrames * track.hop;

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
      envelopeSeconds,
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
    envelopeSeconds,
  };
}
