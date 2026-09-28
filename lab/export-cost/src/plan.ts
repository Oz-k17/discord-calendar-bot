/**
 * 書き出しの「仕事の並び」を組む。
 *
 * 本体（`src/engine/offline-export.ts`）は、書き出す前に
 * **どのコマでどのクリップの素材コマが要るか**を並べてから 1 コマずつ回している。
 * ここはその並べ方だけを写したもので、DOM も WebCodecs も要らない。
 *
 * ## なぜ「測る」より先にこれを書くのか
 *
 * 書き出しが遅いと言うとき、疑う先は 2 つある。
 * **1 コマあたりが重い**（デコード・描画・エンコードの中身）か、
 * **コマあたりの仕事が多い**（同じ素材を何度も開き直している、同じコマを 2 回デコードしている）か。
 * 後者は時計を持ち出さなくても数えられるし、**数えられるものを測るのは順番が逆**なので、
 * 先にここで数え切ってから、残ったぶんをブラウザで測る（`testkit/measure.ts`）。
 *
 * ## 本体から写した規則（2026-09-26 時点）
 *
 * - コマは `i / fps` の秒で、`totalFrames = ceil(duration * fps)`。
 * - その秒に映っているクリップ（`visibleVideoClips`）ぶんだけ素材コマを要求する。
 *   トランジションの最中は**前のクリップも一緒に映る**ので、そのコマだけ 2 本ぶん要る。
 * - 素材内の時刻は `sourceIn + (t - start) * speed`。ループは素材の残りで折り返す。
 * - デコーダは**クリップごと**に開き、そのクリップの最後のコマを取ったら閉じる。
 *
 * 最後の 1 行が、この試作でいちばん見たかったところ。**クリップごと**なので、
 * 1 本の動画を 5 つに割ったタイムラインでは同じファイルを 5 回開き直す。
 */

/** 書き出しの対象。本体の `Clip` から、コマの並びに効くものだけを抜いてある。 */
export interface LabClip {
  id: string;
  /** 素材の id。**同じ素材を複数のクリップが指すのがふつう**（1 本を割ったとき）。 */
  mediaId: string;
  kind: 'video' | 'image';
  /** タイムライン上の位置（秒）。 */
  start: number;
  duration: number;
  /** 素材内の開始位置（秒）。 */
  sourceIn: number;
  /** 再生速度。1 未満なら同じ素材コマを 2 回以上要求することがある。 */
  speed?: number;
  loop?: boolean;
  /** 素材の尺（秒）。ループの折り返しに要る。 */
  assetDuration: number;
  /** 頭のトランジション（秒）。0 なら無し。この間は前のクリップも映る。 */
  transitionIn?: number;
}

export interface LabSequence {
  clips: LabClip[];
  duration: number;
}

/** 1 クリップぶんのデコードの注文。本体の `ClipStream` と同じ形。 */
export interface ClipStream {
  clipId: string;
  mediaId: string;
  /** 何コマ目で要るか（昇順）。 */
  frames: number[];
  /** そのとき要る素材内の時刻（秒）。 */
  times: number[];
}

export interface FramePlan {
  frame: number;
  time: number;
  /** このコマでデコードが要るクリップ。 */
  decode: string[];
  /** このコマで描くクリップ（デコードが要らない静止画も入る）。 */
  draw: string[];
}

export interface ExportPlan {
  fps: number;
  totalFrames: number;
  streams: ClipStream[];
  perFrame: FramePlan[];
}

function clampSpeed(speed: number): number {
  return Math.max(0.0625, Math.min(16, speed || 1));
}

/** 素材内の再生位置（ループを考慮）。本体の `sourceTimeFor` と同じ計算。 */
export function sourceTimeFor(clip: LabClip, time: number): number {
  const raw = clip.sourceIn + Math.max(0, time - clip.start) * clampSpeed(clip.speed ?? 1);
  if (!clip.loop || clip.assetDuration <= 0) return raw;
  const span = Math.max(0.1, clip.assetDuration - clip.sourceIn);
  return clip.sourceIn + ((raw - clip.sourceIn) % span);
}

/** その秒に映っているクリップ。トランジションの最中は前のクリップも返す。 */
export function visibleAt(sequence: LabSequence, time: number): LabClip[] {
  return visibleIn([...sequence.clips].sort((a, b) => a.start - b.start), time);
}

/**
 * 上の中身。**並べ替えを外に出してある**のは、`planExportWork` がコマごとに呼ぶため。
 * 中で並べ替えると、費用を測る試作の並べ方そのものが `コマ数 × クリップ数 log クリップ数` になる。
 */
function visibleIn(ordered: LabClip[], time: number): LabClip[] {
  const out: LabClip[] = [];
  const index = ordered.findIndex((c) => time >= c.start && time < c.start + c.duration);
  if (index < 0) return out;
  const current = ordered[index];
  out.push(current);
  const fade = current.transitionIn ?? 0;
  if (fade > 0 && time < current.start + fade && index > 0) out.push(ordered[index - 1]);
  return out;
}

export function planExportWork(sequence: LabSequence, fps: number): ExportPlan {
  if (!(fps > 0)) throw new Error(`fps は正の数です（${fps}）`);
  const totalFrames = Math.max(0, Math.ceil(sequence.duration * fps));
  const streams = new Map<string, ClipStream>();
  const perFrame: FramePlan[] = [];
  const ordered = [...sequence.clips].sort((a, b) => a.start - b.start);

  for (let i = 0; i < totalFrames; i += 1) {
    const time = i / fps;
    const decode: string[] = [];
    const draw: string[] = [];
    for (const clip of visibleIn(ordered, time)) {
      draw.push(clip.id);
      // 静止画はデコーダを持たない（本体も `imageElement` を引くだけ）。
      if (clip.kind !== 'video') continue;
      let stream = streams.get(clip.id);
      if (!stream) {
        stream = { clipId: clip.id, mediaId: clip.mediaId, frames: [], times: [] };
        streams.set(clip.id, stream);
      }
      // 同じコマで同じクリップを 2 回は要求しない（本体と同じ間引き）。
      if (stream.frames[stream.frames.length - 1] === i) continue;
      stream.frames.push(i);
      stream.times.push(Math.max(0, sourceTimeFor(clip, time)));
      decode.push(clip.id);
    }
    perFrame.push({ frame: i, time, decode, draw });
  }

  return { fps, totalFrames, streams: [...streams.values()], perFrame };
}

export interface PlanStats {
  totalFrames: number;
  /** デコーダから 1 枚取り出す回数の合計。**出来上がりのコマ数とは一致しない。** */
  decodeCalls: number;
  /** 1 コマあたりのデコード枚数（平均）。トランジションがあると 1 を超える。 */
  decodesPerFrame: number;
  /** 2 本以上を同時にデコードするコマの数。 */
  framesWithMultipleDecodes: number;
  /** デコーダを開く回数（＝クリップの本数）。 */
  decoderOpens: number;
  /** そのうち「同じ素材を開き直した」回数。`decoderOpens - 素材の種類`。 */
  redundantOpens: number;
  /** 同時に開いているデコーダの最大数。端末の上限に当たるとここで落ちる。 */
  maxConcurrentDecoders: number;
  /** 素材内の時刻が単調非減少で並んでいるクリップの数（順に読めば足りる側）。 */
  monotonicStreams: number;
  /** 同じ素材コマを 2 回以上要求している回数の合計（スロー再生・高い書き出し fps で出る）。 */
  repeatedSourceFrames: number;
}

/**
 * 並びを数える。**時計を使わない**ので、素材も端末も要らない。
 *
 * `sourceFps` を外から渡すのは、`repeatedSourceFrames`（素材の同じコマを 2 回以上
 * 要求した回数）が**素材のコマ幅でしか決まらない**ため。並びの側には
 * 「素材内の何秒が要るか」しか無いので、ここだけは素材の性質を渡してもらうしかない。
 * 最初は「書き出しの 1 コマぶんより細かい差は同じコマ」という近似で書いたが、
 * **速度 0.5 のときに差がちょうどしきい値に乗り、浮動小数の丸めが答えを決めていた**
 * （119 回のはずが 81 回）。近似のほうを直すのではなく、根拠のある数を渡す形にした。
 */
export function summarizePlan(plan: ExportPlan, { sourceFps = 30 }: { sourceFps?: number } = {}): PlanStats {
  const decodeCalls = plan.streams.reduce((n, s) => n + s.frames.length, 0);
  const mediaIds = new Set(plan.streams.map((s) => s.mediaId));

  let framesWithMultipleDecodes = 0;
  for (const f of plan.perFrame) if (f.decode.length > 1) framesWithMultipleDecodes += 1;

  // 同時に開いている本数は「開く → 閉じる」を並べて数える。
  // 本体は「要るコマに当たったら開き、最後のコマを取ったら閉じる」ので、
  // クリップの最初のコマから最後のコマまでが開いている区間。
  const spans = plan.streams
    .filter((s) => s.frames.length > 0)
    .map((s) => ({ from: s.frames[0], to: s.frames[s.frames.length - 1] }));
  let maxConcurrentDecoders = 0;
  for (const probe of spans) {
    const n = spans.filter((s) => s.from <= probe.from && probe.from <= s.to).length;
    if (n > maxConcurrentDecoders) maxConcurrentDecoders = n;
  }

  let monotonicStreams = 0;
  let repeatedSourceFrames = 0;
  if (!(sourceFps > 0)) throw new Error(`sourceFps は正の数です（${sourceFps}）`);
  // 素材のコマ幅。これより細かい差は「同じ素材コマ」なので、デコーダは 1 枚しか作らない。
  const grain = 1 / sourceFps;
  for (const s of plan.streams) {
    if (s.times.every((t, i) => i === 0 || t >= s.times[i - 1] - 1e-9)) monotonicStreams += 1;
    for (let i = 1; i < s.times.length; i += 1) {
      // ちょうど 1 コマぶん進んだときを「同じコマ」に数えないよう、線の手前で切る。
      if (Math.abs(s.times[i] - s.times[i - 1]) < grain - 1e-9) repeatedSourceFrames += 1;
    }
  }

  return {
    totalFrames: plan.totalFrames,
    decodeCalls,
    decodesPerFrame: plan.totalFrames > 0 ? decodeCalls / plan.totalFrames : 0,
    framesWithMultipleDecodes,
    decoderOpens: plan.streams.length,
    redundantOpens: plan.streams.length - mediaIds.size,
    maxConcurrentDecoders,
    monotonicStreams,
    repeatedSourceFrames,
  };
}

/**
 * 「順に読む」形（`CanvasSink.canvases`）が得になる歩幅の線。単位は**素材のコマ**。
 *
 * 2026-09-26 に 1024×576 で測った。素材 15fps を 30fps へ書き出すとき、
 * 再生速度 1 / 2 / 3 / 4 倍の歩幅はそれぞれ 0.5 / 1.0 / 1.5 / 2.0 コマで、
 * 順に読む形が **1.76 / 1.28 / 1.01 / 0.84 倍**（等速で得、3 倍で互角、4 倍で損）。
 * 飛ばして読むぶんには、要らないコマを canvas へ起こす手間がそのまま無駄になる。
 *
 * **線は互角だった 1.5 ではなく、その手前の 1.25 に置いてある。** 理由は 2 つ。
 * 互角のところで乗り換えても得が無いこと。そして**境目ちょうどに線を置くと、
 * 浮動小数の丸めが答えを決める**こと（同じ日に `repeatedSourceFrames` で一度踏んだ。
 * 歩幅 1.5 は `1.4999999999999998` として出てくる）。
 */
export const SEQUENTIAL_STRIDE_LIMIT = 1.25;

export interface DecodeShape {
  /** 素材内の時刻が巻き戻らないか。巻き戻るなら順に読む形は使えない。 */
  monotonic: boolean;
  /** 1 コマ進むたびに素材内で何コマ進むか（中央値）。 */
  strideFrames: number;
  /** 順に読む形（`canvases`）が向いているか。向かないなら飛び石（`canvasesAtTimestamps`）。 */
  sequential: boolean;
}

/**
 * その注文が「順に読む」側か「飛ばして読む」側かを、**時計を使わずに**決める。
 *
 * 平均ではなく中央値を見るのは、クリップの切れ目やループの折り返しで
 * 歩幅が 1 か所だけ大きく飛ぶことがあるため。
 */
export function decodeShape(stream: ClipStream, { sourceFps = 30 }: { sourceFps?: number } = {}): DecodeShape {
  if (!(sourceFps > 0)) throw new Error(`sourceFps は正の数です（${sourceFps}）`);
  const steps: number[] = [];
  let monotonic = true;
  for (let i = 1; i < stream.times.length; i += 1) {
    const step = stream.times[i] - stream.times[i - 1];
    if (step < -1e-9) monotonic = false;
    steps.push(step * sourceFps);
  }
  steps.sort((a, b) => a - b);
  const strideFrames = steps.length === 0 ? 0 : steps[steps.length >> 1];
  return { monotonic, strideFrames, sequential: monotonic && strideFrames < SEQUENTIAL_STRIDE_LIMIT };
}

/**
 * 1 本の素材を等分に割っただけのタイムライン。「割ると何が増えるか」を測る比べる相手。
 *
 * `speed` を開けてあるのは**自分の手を潰すため**。素材を飛ばしながら読む再生では、
 * 「順に読む」形が全コマを取り出す羽目になるので、速いほど不利になるはず——
 * という見立てを測れるようにしてある（`bench.mjs` の「速い再生」の段）。
 * 尺は `assetDuration / speed` に畳むので、どの速さでも素材を端まで使い切る。
 */
export function splitSequence(
  { mediaId = 'asset', duration = 13, pieces = 1, assetDuration = 13, transition = 0, speed = 1 } = {},
): LabSequence {
  if (!(speed > 0)) throw new Error(`speed は正の数です（${speed}）`);
  const total = speed === 1 ? duration : duration / speed;
  const span = total / pieces;
  const clips: LabClip[] = [];
  for (let i = 0; i < pieces; i += 1) {
    clips.push({
      id: `clip-${i}`,
      mediaId,
      kind: 'video',
      start: i * span,
      duration: span,
      sourceIn: i * span * speed,
      assetDuration,
      ...(speed === 1 ? {} : { speed }),
      ...(transition > 0 && i > 0 ? { transitionIn: transition } : {}),
    });
  }
  return { clips, duration: total };
}
