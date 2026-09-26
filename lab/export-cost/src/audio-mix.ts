/**
 * 音の側の費用を数え、**窓に割って混ぜる**ための並べ方。
 *
 * 本体（`src/engine/offline-export.ts` の `renderAudioMix`）は、映像の 1 コマ目を描く前に
 * **タイムライン全体の音を 1 本の `AudioBuffer` へ一括ミックス**している。
 * 実時間で鳴らさないのでプチノイズが入りようがない、という良い作りだが、
 * その代わりに**尺に比例したメモリと時間を先払い**している。
 * 2026-09-26（1 回目・2 回目）に映像の側は測ったが、**音の側は 1 秒も測っていなかった**。
 *
 * ## なぜ「数える」ほうを先に書くのか
 *
 * 音の先払いは、**時計を当てる前に数えられる**（`plan.ts` と同じ理由）。
 *
 * - 一括ミックスの入れ物は `ceil(尺 × 48000) × 2ch × 4 バイト`。**尺だけで決まる。**
 * - 素材の音は `decodeAssetAudio` が**素材まるごと**を起こす。クリップが 3 秒しか
 *   使っていても、1 時間の素材なら 1 時間ぶんが乗る。**使う秒では決まらない。**
 * - `sliceAudio` は出力へ渡すたびに 1 秒ぶんを**もう 1 回複製**する。
 *
 * ここまでは端末にも素材にも依らないので、そのまま記録として持ち越せる。
 * 残った「実際どれくらいかかるか」だけを `testkit/audio.ts` がブラウザで測る。
 *
 * ## 窓に割る（比べる相手）
 *
 * 一括の代わりに、**窓 1 つぶんだけを混ぜて渡し、次の窓へ進む**形が取れるはず。
 * 入れ物は窓の長さで頭打ちになるので、尺が伸びてもメモリは増えない。
 * 窓を出力へ渡す単位（`AUDIO_CHUNK_SECONDS`）と同じにすれば、
 * **`sliceAudio` の複製がそもそも要らなくなる**（混ざった窓をそのまま渡せる）。
 *
 * 難しいのは置き方のほうで、窓の途中から始まる音には
 * **素材内の読み出し位置を進めておく**必要があり、フェードの途中で窓が切れたら
 * **その時点の音量から**折れ線を引き直さないといけない。ここがこの試作の本題で、
 * だから窓の割り当てだけを WebAudio から切り離して、合成データで検算できるようにしてある。
 */

/** 本体と同じ値（`src/engine/offline-export.ts`）。 */
export const SAMPLE_RATE = 48_000;
export const CHANNELS = 2;
/** 本体が出力へ音を流し込む単位（秒）。 */
export const AUDIO_CHUNK_SECONDS = 1;
/** `AudioBuffer` は 32bit 浮動小数で持つ。 */
export const BYTES_PER_SAMPLE = 4;

/** 音の鳴るクリップ。本体の `Clip` から、音に効くものだけを抜いてある。 */
export interface LabAudioClip {
  id: string;
  mediaId: string;
  kind: 'video' | 'audio';
  /** タイムライン上の位置（秒）。 */
  start: number;
  duration: number;
  /** 素材内の開始位置（秒）。 */
  sourceIn: number;
  /** 素材の尺（秒）。ループの折り返しと、素材の端を越えたかの判定に要る。 */
  assetDuration: number;
  speed?: number;
  volume?: number;
  fadeIn?: number;
  fadeOut?: number;
  loop?: boolean;
  muted?: boolean;
  /** 頭のトランジション（秒）。この間は**前のクリップの音も引き延ばして重ねる**。 */
  transitionIn?: number;
}

export interface LabAudioSequence {
  clips: LabAudioClip[];
  duration: number;
}

/** 音量の折れ線の節。時刻はタイムライン上の絶対秒。 */
export interface EnvelopePoint {
  time: number;
  gain: number;
}

/**
 * 「ここからここまで、素材のここを、この音量で鳴らす」1 本ぶん。
 *
 * クリップと 1 対 1 ではない。トランジションの引き延ばしは**同じクリップから 2 本目**が出る。
 * 窓に割る側から見れば区別は要らないので、そこを畳んでからが `windowSounds`。
 */
export interface Sound {
  /** どの置き方から来たか。トランジションの引き延ばしは `clip-1:tail` の形。 */
  id: string;
  mediaId: string;
  /** タイムライン上の [from, to)（秒）。 */
  from: number;
  to: number;
  /** `from` の時点で素材内のどこを読むか（秒）。 */
  sourceIn: number;
  speed: number;
  loop: boolean;
  assetDuration: number;
  /** 音量の折れ線。**必ず `from` に節を持ち、時刻は昇順**。 */
  envelope: EnvelopePoint[];
}

/** 窓 1 つの中での置き方。WebAudio の `source.start(startAt, offset, seconds * speed)` に渡す形。 */
export interface Placement {
  soundId: string;
  mediaId: string;
  /** 窓の頭からの開始（秒・0 以上）。 */
  startAt: number;
  /** 素材内の読み出し開始（秒）。ループは折り返した後の値。 */
  offset: number;
  /** 鳴らす長さ（壁時計の秒）。 */
  seconds: number;
  speed: number;
  loop: boolean;
  /** **窓の中の相対秒**での折れ線。先頭は必ず `startAt`。 */
  envelope: EnvelopePoint[];
}

export interface AudioWindow {
  /** タイムライン上の [from, to)（秒）。 */
  from: number;
  to: number;
  placements: Placement[];
}

export function clampSpeed(speed: number | undefined): number {
  return Math.max(0.0625, Math.min(16, speed || 1));
}

/**
 * ループの折り返し。**`plan.ts` の `sourceTimeFor` と同じ規則**にしてある
 * （素材の残りの長さで折り返す。0 秒にならないよう下限 0.1 秒）。
 *
 * 本体の `place` は WebAudio の `loopStart` / `loopEnd` に任せているので、
 * ここは「WebAudio が折り返した後どこを読んでいるか」を先に計算して追い付く形。
 * **窓の途中から鳴らすときは、この計算が無いと素材の頭から鳴り直してしまう。**
 *
 * 素材の端より後ろを指す位置が出ることもある（`sourceIn` が素材より後ろのクリップ）。
 * そこは WebAudio 側が `loopStart` / `loopEnd` で折り返すので、本体と同じ鳴り方になる。
 */
export function loopedOffset(sound: Sound, advance: number): number {
  const span = Math.max(0.1, sound.assetDuration - sound.sourceIn);
  return sound.sourceIn + (advance % span);
}

/** 折れ線のある時刻の音量。節の外側は端の値のまま（WebAudio の保持と同じ）。 */
export function gainAt(envelope: EnvelopePoint[], time: number): number {
  if (envelope.length === 0) return 0;
  if (time <= envelope[0].time) return envelope[0].gain;
  for (let i = 1; i < envelope.length; i += 1) {
    const a = envelope[i - 1];
    const b = envelope[i];
    if (time > b.time) continue;
    const span = b.time - a.time;
    if (span <= 0) return b.gain;
    return a.gain + ((b.gain - a.gain) * (time - a.time)) / span;
  }
  return envelope[envelope.length - 1].gain;
}

/**
 * クリップのフェードを折れ線にする。
 *
 * **本体と 1 か所だけ違う。** 本体は `fadeIn` と `fadeOut` を**それぞれ**尺で切るので、
 * 2 つの合計が尺を超えると節の時刻が前後し、どう鳴るかは WebAudio の並べ替え任せになる。
 * ここは**交差しないように切ってから**並べる。理由は、**窓に割った形と一括の形で
 * 同じ曲線を再現できないと、比べる相手が作れない**ため（並べ替え任せの曲線は、
 * 窓の途中から引き直せない）。実害が出るのは「フェードイン＋フェードアウト＞尺」の
 * クリップだけで、そこは本体の側を直すべきところ。
 */
function fadeEnvelope(from: number, to: number, volume: number, fadeIn: number, fadeOut: number): EnvelopePoint[] {
  const span = Math.max(0, to - from);
  const rise = Math.max(0, Math.min(fadeIn, span));
  const fall = Math.max(0, Math.min(fadeOut, span - rise));
  const points: EnvelopePoint[] = [{ time: from, gain: rise > 0 ? 0 : volume }];
  if (rise > 0) points.push({ time: from + rise, gain: volume });
  if (fall > 0) {
    points.push({ time: to - fall, gain: volume });
    points.push({ time: to, gain: 0 });
  }
  return points;
}

/** 直前に隣り合っているクリップ（本体の `previousAdjacent` と同じ「終わりが頭に触れている」）。 */
function previousAdjacent(sequence: LabAudioSequence, clip: LabAudioClip): LabAudioClip | null {
  let best: LabAudioClip | null = null;
  for (const other of sequence.clips) {
    if (other.id === clip.id) continue;
    if (Math.abs(other.start + other.duration - clip.start) > 1e-6) continue;
    if (!best || other.start > best.start) best = other;
  }
  return best;
}

/**
 * 並べる音を全部出す。本体の `renderAudioMix` が `place()` を呼ぶ順・条件をそのまま写した。
 *
 * トランジションの引き延ばし（前のカットの音を重ねる）まで入れてあるのは、
 * **窓の境目をまたぐ音を 2 種類作れる**ようにするため。1 種類しか無いと、
 * 「窓に割ると素材内の位置がずれる」穴を 1 通りしか試せない。
 */
export function soundsOf(sequence: LabAudioSequence): Sound[] {
  const out: Sound[] = [];
  const duration = Math.max(0, sequence.duration);

  for (const clip of sequence.clips) {
    if (clip.muted) continue;
    const from = Math.max(0, clip.start);
    const to = Math.min(duration, clip.start + clip.duration);
    if (to <= from) continue;
    const speed = clampSpeed(clip.speed);
    // 素材の端より後ろから読み始めるクリップは、本体も 1 サンプルも鳴らさない。
    if (clip.sourceIn >= clip.assetDuration && !clip.loop) continue;
    const volume = Math.max(0, clip.volume ?? 1);
    out.push({
      id: clip.id,
      mediaId: clip.mediaId,
      from,
      to,
      sourceIn: clip.sourceIn,
      speed,
      loop: Boolean(clip.loop),
      assetDuration: clip.assetDuration,
      envelope: fadeEnvelope(from, to, volume, clip.fadeIn ?? 0, clip.fadeOut ?? 0),
    });
  }

  for (const clip of sequence.clips) {
    const transition = clip.transitionIn ?? 0;
    if (clip.kind !== 'video' || transition <= 0) continue;
    const previous = previousAdjacent(sequence, clip);
    if (!previous || previous.muted) continue;
    // 本体と同じ: 前のクリップにフェードアウトがあるときは引き延ばさない
    // （プレビュー側が無音になるので、書き出しもそれに合わせている）。
    if ((previous.fadeOut ?? 0) > 0) continue;
    const from = Math.max(0, clip.start);
    const to = Math.min(duration, from + transition);
    if (to <= from) continue;
    const speed = clampSpeed(previous.speed);
    const volume = Math.max(0, previous.volume ?? 1);
    // 前のクリップが使い切った続きから読む（引き延ばしなので素材の先へ進む）。
    const sourceIn = previous.sourceIn + previous.duration * speed;
    if (sourceIn >= previous.assetDuration && !previous.loop) continue;
    out.push({
      id: `${clip.id}:tail`,
      mediaId: previous.mediaId,
      from,
      to,
      sourceIn,
      speed,
      loop: false,
      assetDuration: previous.assetDuration,
      envelope: [
        { time: from, gain: volume },
        { time: to, gain: 0 },
      ],
    });
  }

  return out;
}

/**
 * 窓 [from, to) の中で鳴る音を、その窓の座標で並べ直す。
 *
 * **窓を尺いっぱいに取れば、本体の一括ミックスと同じ置き方になる。**
 * つまり一括と窓割りは同じ 1 本の道で作れる（比べる相手を別に書くと、
 * 差が「窓のせい」か「書き写しのせい」か分からなくなる）。
 *
 * 気を付けたところ 3 つ:
 * - **素材内の位置を進める。** 窓の途中から始まる音は `(a - from) * speed` ぶん先を読む。
 *   ここを忘れると素材の頭から鳴り直す（`testkit/audio.ts` の `broken` がその形）。
 * - **フェードの途中で切れたら、その時点の音量から引き直す。** 窓の先頭は
 *   `setValueAtTime(gainAt(...))` で、残りの節だけを相対時刻へ移す。
 * - **素材の端を越えた窓は置かない。** 越えた側は WebAudio でも無音になるが、
 *   置けば音源を 1 本ぶん無駄に組むことになる（窓の数だけ積む）。
 */
export function windowSounds(sounds: Sound[], from: number, to: number): Placement[] {
  if (!(to > from)) return [];
  const out: Placement[] = [];
  for (const sound of sounds) {
    const a = Math.max(sound.from, from);
    const b = Math.min(sound.to, to);
    const seconds = b - a;
    if (seconds <= 0) continue;
    const advance = (a - sound.from) * sound.speed;
    const offset = sound.loop ? loopedOffset(sound, advance) : sound.sourceIn + advance;
    if (!sound.loop && offset >= sound.assetDuration) continue;
    const envelope: EnvelopePoint[] = [{ time: a - from, gain: gainAt(sound.envelope, a) }];
    for (const point of sound.envelope) {
      if (point.time <= a + 1e-9) continue;
      if (point.time > b + 1e-9) break;
      envelope.push({ time: point.time - from, gain: point.gain });
    }
    // **窓の出口にも節を打つ。** 折れ線を「窓の外の節を捨てる」だけで切ると、
    // 窓の中で坂が水平になる（最後の節から先は値が保持されるので）。
    // フェードアウトの途中で窓が切れると、そこから先が下がらないまま鳴り続ける形で出る。
    // 検算（`audio-selftest.ts`）がここを 0.53 の食い違いとして捕まえた。
    const last = envelope[envelope.length - 1];
    if (b - from > last.time + 1e-9) envelope.push({ time: b - from, gain: gainAt(sound.envelope, b) });
    out.push({
      soundId: sound.id,
      mediaId: sound.mediaId,
      startAt: a - from,
      offset,
      seconds,
      speed: sound.speed,
      loop: sound.loop,
      envelope,
    });
  }
  return out;
}

/**
 * 尺を窓に割って、窓ごとの置き方を返す。`windowSeconds` が尺以上なら窓は 1 つ（＝一括）。
 *
 * 最後の窓は尺で切る（伸ばさない）。伸ばすと出力へ渡すサンプル数が本体と変わってしまう。
 */
export function planAudioWindows(
  sequence: LabAudioSequence,
  { windowSeconds = AUDIO_CHUNK_SECONDS }: { windowSeconds?: number } = {},
): AudioWindow[] {
  if (!(windowSeconds > 0)) throw new Error(`windowSeconds は正の数です（${windowSeconds}）`);
  const duration = Math.max(0, sequence.duration);
  const sounds = soundsOf(sequence);
  const windows: AudioWindow[] = [];
  for (let at = 0; at < duration - 1e-9; at += windowSeconds) {
    const to = Math.min(duration, at + windowSeconds);
    windows.push({ from: at, to, placements: windowSounds(sounds, at, to) });
  }
  return windows;
}

export interface AudioCostStats {
  /** タイムラインの尺（秒）。 */
  seconds: number;
  /** 並べる音の本数（トランジションの引き延ばしも 1 本として数える）。 */
  sounds: number;
  /** デコードする素材の種類。 */
  assets: number;
  /**
   * デコードする秒の合計（**素材の尺の合計**）。
   * 本体は素材まるごとを起こすので、**使う秒とは一致しない。**
   */
  decodedSeconds: number;
  /** 実際に鳴らす秒の合計。 */
  usedSeconds: number;
  decodedBytes: number;
  /** 一括ミックスの入れ物（尺だけで決まる）。 */
  mixBytes: number;
  /** `sliceAudio` が複製を作る回数と、そのバイトの合計。 */
  sliceCopies: number;
  sliceBytes: number;
  /** 一括のときに同時に抱えるバイトの最大（素材 ＋ ミックス ＋ かけら 1 枚）。 */
  peakBytes: number;
  windowSeconds: number;
  windows: number;
  /** 窓に割ったときに同時に抱えるバイトの最大。 */
  windowPeakBytes: number;
  /** 窓ごとの置き直しの合計（音源を組む回数）。一括なら `sounds` と同じ。 */
  windowPlacements: number;
  /** 一括 ÷ 窓割り（メモリが何分の 1 になるか）。 */
  memoryRatio: number;
}

/**
 * 音の先払いを**時計を使わずに**数える。
 *
 * `decodedBytes` を素材の尺から出しているのは、本体の `decodeAssetAudio` が
 * **クリップの使う範囲ではなく素材まるごと**を起こすため。
 * ここは近似で、48kHz・2ch として数えている（本体のミックスがその形なので、
 * 起こした素材が何 Hz でも最後はこの形に化ける）。
 * 素材がモノラルなら実際の半分になるので、**上振れ側の見積もり**として読む。
 */
export function summarizeAudioCost(
  sequence: LabAudioSequence,
  { windowSeconds = AUDIO_CHUNK_SECONDS }: { windowSeconds?: number } = {},
): AudioCostStats {
  if (!(windowSeconds > 0)) throw new Error(`windowSeconds は正の数です（${windowSeconds}）`);
  const seconds = Math.max(0, sequence.duration);
  const sounds = soundsOf(sequence);
  const perSecond = SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE;

  const assetSeconds = new Map<string, number>();
  for (const clip of sequence.clips) {
    // **消したクリップの素材も数える。** 本体の `renderAudioMix` は
    // 「音のあるクリップ」を先に全部起こしてから、置く段で muted を落とす
    // （`decoded.set(mediaId, await decodeAssetAudio(mediaId))` のほうに muted の条件が無い）。
    // なので消しても起こすバイトは減らない。ここを `soundsOf` に合わせて数えると、
    // 数え上げだけが実際より軽く出る。
    if (clip.kind !== 'video' && clip.kind !== 'audio') continue;
    if (!assetSeconds.has(clip.mediaId)) assetSeconds.set(clip.mediaId, clip.assetDuration);
  }
  const decodedSeconds = [...assetSeconds.values()].reduce((a, b) => a + b, 0);
  const usedSeconds = sounds.reduce((a, s) => a + (s.to - s.from), 0);

  const decodedBytes = Math.ceil(decodedSeconds * SAMPLE_RATE) * CHANNELS * BYTES_PER_SAMPLE;
  const mixLength = Math.max(1, Math.ceil(seconds * SAMPLE_RATE));
  const mixBytes = mixLength * CHANNELS * BYTES_PER_SAMPLE;
  const sliceCopies = Math.ceil(mixLength / Math.round(AUDIO_CHUNK_SECONDS * SAMPLE_RATE));
  const sliceBytes = mixBytes;
  const chunkBytes = Math.round(AUDIO_CHUNK_SECONDS * perSecond);

  const windows = planAudioWindows(sequence, { windowSeconds });
  const windowBytes = Math.ceil(Math.min(seconds, windowSeconds) * SAMPLE_RATE) * CHANNELS * BYTES_PER_SAMPLE;
  // 窓のほうは、出力へ渡す単位と同じにすれば複製が要らない（混ざった窓をそのまま渡せる）。
  const windowExtra = windowSeconds <= AUDIO_CHUNK_SECONDS + 1e-9 ? 0 : chunkBytes;

  const peakBytes = decodedBytes + mixBytes + chunkBytes;
  const windowPeakBytes = decodedBytes + windowBytes + windowExtra;

  return {
    seconds,
    sounds: sounds.length,
    assets: assetSeconds.size,
    decodedSeconds,
    usedSeconds,
    decodedBytes,
    mixBytes,
    sliceCopies,
    sliceBytes,
    peakBytes,
    windowSeconds,
    windows: windows.length,
    windowPeakBytes,
    windowPlacements: windows.reduce((n, w) => n + w.placements.length, 0),
    memoryRatio: windowPeakBytes > 0 ? peakBytes / windowPeakBytes : 0,
  };
}

/**
 * 1 本の素材を等分に割っただけの、音のあるタイムライン。比べる相手を作るための道具。
 *
 * `fade` を開けてあるのは**自分の手を潰すため**。窓の境目がフェードの途中に来ると、
 * 「その時点の音量から引き直す」が要るかどうかがそこで初めて出る。
 * `assetSeconds` を別に持てるのは、**使う秒とデコードする秒がずれる形**
 * （長い素材から少しだけ切り出す）を作れるようにするため。
 */
export function splitAudioSequence({
  mediaId = 'asset',
  seconds = 13,
  pieces = 1,
  assetSeconds = 13,
  fade = 0,
  volume = 1,
  speed = 1,
  transition = 0,
  loop = false,
}: {
  mediaId?: string;
  seconds?: number;
  pieces?: number;
  assetSeconds?: number;
  fade?: number;
  volume?: number;
  speed?: number;
  transition?: number;
  loop?: boolean;
} = {}): LabAudioSequence {
  if (!(pieces >= 1)) throw new Error(`pieces は 1 以上です（${pieces}）`);
  if (!(speed > 0)) throw new Error(`speed は正の数です（${speed}）`);
  const span = seconds / pieces;
  const clips: LabAudioClip[] = [];
  for (let i = 0; i < pieces; i += 1) {
    clips.push({
      id: `clip-${i}`,
      mediaId,
      kind: 'video',
      start: i * span,
      duration: span,
      // ループしないなら素材の中を順に使う。素材が足りなければ頭から取り直す
      // （割った本数ぶん素材が要る形にすると、尺を振ったときに素材まで変わってしまう）。
      sourceIn: loop ? 0 : (i * span * speed) % Math.max(0.1, assetSeconds),
      assetDuration: assetSeconds,
      speed,
      volume,
      fadeIn: fade,
      fadeOut: fade,
      loop,
      ...(transition > 0 && i > 0 ? { transitionIn: transition } : {}),
    });
  }
  return { clips, duration: seconds };
}
