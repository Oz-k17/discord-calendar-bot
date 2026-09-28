/**
 * 書き出しを**本物の部品で**回して、段ごとに時計を当てる。
 *
 * ## これは画面の一部ではない
 *
 * `index.html` からは読み込んでいない。`bench.mjs` が playwright 越しに差し込むためだけに置いてある
 * （`scene-cut/testkit/encode.ts` と同じ理由・同じ置き方）。
 *
 * ## 何を回しているか
 *
 * `src/engine/offline-export.ts` の**コマの輪だけ**を写した。音・トランジション・
 * テロップ・エフェクトは入れていない。
 *
 * 振れる軸は 2 つ。**デコーダの開き方**（`mode`）と、
 * **エンコードの約束を何枚まで未完了のまま先へ進むか**（`encodeDepth`・`src/pipeline.ts`）。
 * どちらも出来上がりを 1 ビットも変えない（`verify` で出口から確かめてある）。
 *入れないのは手を抜いたからではなく、
 * **段の取り分を読むのに、足せば足すほど「描く」に全部寄る**から。
 * ここで見たいのは「デコードとエンコードが 1 コマの中で足し算に並んでいる」という骨で、
 * 描く中身が増えたときにどう動くかは `share` から読める（`cost.ts` の `projectSpeedup`）。
 *
 * ## 読むときの注意（大事）
 *
 * ここで出る**絶対値は、この端末のこのコーデックの話でしかない**。
 * 確認用のブラウザは GPU の無い環境で動かすので（`browser.mjs` の swiftshader）、
 * VP8/VP9 は丸ごとソフトウェアで回る。本物の端末ではハードウェアのエンコーダが付く。
 * **持ち越せるのは段の取り分と、手を替えたときの前後比**のほうで、ミリ秒そのものではない。
 */

import {
  BlobSource,
  BufferTarget,
  CanvasSink,
  CanvasSource,
  Input,
  MATROSKA,
  MP4,
  Output,
  QTFF,
  Quality,
  WEBM,
  WebMOutputFormat,
  getFirstEncodableVideoCodec,
  type WrappedCanvas,
} from 'mediabunny';
import { encodeClip } from '../../scene-cut/testkit/encode.ts';
import { renderFixture } from '../../fixtures/make-frames.mjs';
import { decodeShape, planExportWork, splitSequence, type ClipStream } from '../src/plan.ts';
import { InFlightQueue, SERIAL_DEPTH, type InFlightStats } from '../src/pipeline.ts';
import type { FrameSample } from '../src/cost.ts';

/** 素材を 1 回だけ焼いて使い回す。焼き直すと粒が変わって前後が比べられなくなる。 */
const baked = new Map<string, { bytes: Uint8Array; width: number; height: number; fps: number; seconds: number }>();

export async function bake(fixture: string, scale: number, bitrate: number) {
  const key = `${fixture}/${scale}/${bitrate}`;
  const hit = baked.get(key);
  if (hit) return hit;
  const clip = renderFixture(fixture, {}) as Parameters<typeof encodeClip>[0];
  const encoded = await encodeClip(clip, { scale, bitrate });
  const made = {
    bytes: encoded.bytes,
    width: encoded.width,
    height: encoded.height,
    fps: encoded.fps,
    seconds: encoded.frames / encoded.fps,
  };
  baked.set(key, made);
  return made;
}

/** デコーダの開き方。**ここが今回の比べる相手**。 */
export type DecodeMode =
  /** いまの本体。クリップごとに開き、要る時刻だけを飛び石で取る。 */
  | 'at-timestamps'
  /** 上に canvas の使い回し（`poolSize`）を足しただけ。 */
  | 'pool'
  /** mediabunny が「順に読むならこちら」と言っている形。先読みが効く。 */
  | 'sequential'
  /** 上の 2 つを重ねる（順に読む＋canvas の使い回し）。 */
  | 'sequential-pool'
  /** クリップごとではなく**素材ごと**に 1 本だけ開く。開き直しが消える。 */
  | 'shared'
  /**
   * 上の 3 つを、注文の形を見て組み合わせる（この試作の出口）。
   * 素材ごとに 1 本開き、canvas を使い回し、**歩幅が狭ければ順に読む**。
   */
  | 'auto'
  /** わざと別のコマを描く。**検査がちゃんと落ちること**を確かめるための相手。 */
  | 'broken';

export interface MeasureOptions {
  fixture?: string;
  /** 焼く大きさ（128×72 の何倍か）。4 で 512×288、8 で 1024×576。 */
  scale?: number;
  bitrate?: number;
  /** 書き出す速さ。 */
  fps?: number;
  /** 素材を何本のクリップに割るか。**割っても出来上がりは 1 ビットも変わらない。** */
  pieces?: number;
  /** 再生速度。2 なら素材のコマを 1 つ飛ばしに読む（尺は半分になる）。 */
  speed?: number;
  mode?: DecodeMode;
  /**
   * エンコードの約束を何枚まで未完了のまま先へ進むか（`src/pipeline.ts`）。
   * **0 はいまの本体と同じ直列**で、1 以上でデコードとエンコードが重なる。
   */
  encodeDepth?: number;
  /** 出来上がりのコマを照合する（時計は当てにならなくなるので、計測とは別に回す）。 */
  digest?: boolean;
  /**
   * 出来上がった WebM を**読み直して**指紋を取る（`signature`）。
   *
   * `digest` のほうは**エンコードへ渡す前の canvas** を見ているので、
   * 重ねたせいで絵が入れ替わったり順番が狂ったりしても捕まえられない。
   * 出口の側で確かめるにはこちらが要る。時計は当てにならなくなるので計測とは別に回す。
   */
  verify?: boolean;
}

export interface MeasureResult {
  mode: DecodeMode;
  encodeDepth: number;
  frames: number;
  /** 輪に居た時間（残りを待ち切るところまで含む）。**仕上げは入っていない。** */
  wallMs: number;
  /** 仕上げ（`output.finalize()`）。重ねると**ここへ仕事が逃げる**ので必ず併せて読む。 */
  finalizeMs: number;
  /** `add()` を呼んで戻ってくるまで（絵を捕まえる同期の手間）。 */
  submitMs: number;
  /** 未完了が上限に当たって待たされた時間。重ねる形ではここが `encode` の中身になる。 */
  waitMs: number;
  /** 輪を抜けたあと、残りを待ち切るのにかかった時間（`wallMs` の中）。 */
  drainMs: number;
  inFlight: InFlightStats;
  /** 出来上がりを読み直した指紋（`verify` のときだけ）。1 コマぶんが `signatureStride` 個。 */
  signature: number[];
  /** 指紋 1 コマぶんの長さ。コマごとに切って読むのに要る。 */
  signatureStride: number;
  /** デコーダを開くのにかかった時間（`decode` には含めない）。 */
  openMs: number;
  opens: number;
  samples: FrameSample[];
  digests: number[];
  width: number;
  height: number;
  bytes: number;
}

/** 順に読む形（`canvases()`）を、飛び石の注文に合わせて使うための小さな受け口。 */
class SequentialPicker {
  private iterator: AsyncGenerator<WrappedCanvas, void, unknown>;
  private current: WrappedCanvas | null = null;
  private next: WrappedCanvas | null = null;
  private done = false;

  constructor(sink: CanvasSink, from: number, to: number) {
    this.iterator = sink.canvases(from, to);
  }

  /** `wanted` 以下でいちばん新しいコマ。`canvasesAtTimestamps` と同じ決まり。 */
  async at(wanted: number): Promise<WrappedCanvas['canvas'] | null> {
    for (;;) {
      if (!this.next && !this.done) {
        const step = await this.iterator.next();
        if (step.done) this.done = true;
        else this.next = step.value;
      }
      if (this.next && this.next.timestamp <= wanted + 1e-9) {
        this.current = this.next;
        this.next = null;
        continue;
      }
      return this.current?.canvas ?? null;
    }
  }

  close() {
    void this.iterator.return(undefined);
  }
}

interface OpenStream {
  stream: ClipStream;
  cursor: number;
  input?: Input;
  iterator?: AsyncGenerator<WrappedCanvas | null, void, unknown>;
  picker?: SequentialPicker;
  opened?: boolean;
}

/** 出来上がったコマの指紋。**中身が同じかどうかだけ**が要るので、粗くてよい。 */
function digestOf(ctx: CanvasRenderingContext2D, width: number, height: number): number {
  const data = ctx.getImageData(0, 0, width, height).data;
  let hash = 2166136261;
  // 全画素を舐めると測定より重くなるので、間引いて拾う（ずれれば必ず変わる粗さ）。
  const step = Math.max(4, Math.floor(data.length / 4096 / 4) * 4);
  for (let i = 0; i < data.length; i += step) {
    hash = Math.imul(hash ^ data[i], 16777619);
  }
  return hash >>> 0;
}

export async function measureExport(options: MeasureOptions = {}): Promise<MeasureResult> {
  const {
    fixture = 'cuts-plain',
    scale = 4,
    bitrate = 4_000_000,
    fps = 30,
    pieces = 1,
    speed = 1,
    mode = 'at-timestamps',
    encodeDepth = SERIAL_DEPTH,
    digest = false,
    verify = false,
  } = options;

  const source = await bake(fixture, scale, bitrate);
  const sequence = splitSequence({
    mediaId: fixture,
    duration: source.seconds,
    pieces,
    speed,
    assetDuration: source.seconds,
  });
  const plan = planExportWork(sequence, fps);

  const width = source.width;
  const height = source.height;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: digest });
  if (!ctx) throw new Error('キャンバスを初期化できませんでした');

  const codec = await getFirstEncodableVideoCodec(['vp9', 'vp8'], { width, height });
  if (!codec) throw new Error('この環境では映像を焼けるコーデックが見つかりませんでした');

  const output = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() });
  const videoSource = new CanvasSource(canvas, {
    codec,
    quality: new Quality({ bitrate }),
    keyFrameInterval: 2,
  });
  output.addVideoTrack(videoSource, { frameRate: fps });

  const blob = new Blob([source.bytes as BlobPart]);
  // `shared` だけは、同じ素材を指すクリップの注文を 1 本にまとめてから開く。
  // まとめられるのは**素材内の時刻が全体として単調**なときだけ（割っただけなら必ず単調）。
  const streams: ClipStream[] = mode === 'shared' || mode === 'auto' ? mergeByMedia(plan.streams) : plan.streams;
  const open: OpenStream[] = streams.map((stream) => ({ stream, cursor: 0 }));
  const byClip = new Map<string, OpenStream>();
  for (const entry of open) {
    for (const clipId of entry.stream.clipId.split('+')) byClip.set(clipId, entry);
  }

  let openMs = 0;
  let opens = 0;
  const openStream = async (entry: OpenStream) => {
    if (entry.opened) return;
    entry.opened = true;
    const t0 = performance.now();
    // 読める入れ物は本体（`src/engine/formats.ts`）と同じ 4 つ。`scene-cut/src/decode.ts` に合わせてある。
    const input = new Input({ source: new BlobSource(blob), formats: [MP4, QTFF, MATROSKA, WEBM] });
    const track = await input.getPrimaryVideoTrack();
    if (!track) {
      input.dispose();
      openMs += performance.now() - t0;
      return;
    }
    entry.input = input;
    // `sequential-pool` の枠を 4 にしてあるのは、順に読む受け口が
    // **いつも 2 枚（いま描く分と、次の候補）を握っている**ため。
    // 枠がそれと同じ 2 枚だと、握っている絵を先読みが上書きしうる。
    // 上書きされれば `bench.mjs` の照合が落ちるので、黙って壊れることはない。
    const pooled = mode === 'pool' ? 2 : mode === 'sequential-pool' || mode === 'auto' ? 4 : 0;
    const sink = new CanvasSink(track, pooled ? { poolSize: pooled } : {});
    // `auto` だけは、**注文の形を見てから**読み方を決める（`decodeShape`）。
    // 素材のコマの速さが要るので、焼いたときの値をそのまま渡している。
    const readsInOrder =
      mode === 'sequential' ||
      mode === 'sequential-pool' ||
      (mode === 'auto' && decodeShape(entry.stream, { sourceFps: source.fps }).sequential);
    if (readsInOrder) {
      const times = entry.stream.times;
      entry.picker = new SequentialPicker(sink, times[0], times[times.length - 1] + 1 / fps);
    } else {
      entry.iterator = sink.canvasesAtTimestamps(entry.stream.times);
    }
    opens += 1;
    openMs += performance.now() - t0;
  };

  const closeStream = (entry: OpenStream) => {
    void entry.iterator?.return(undefined);
    entry.picker?.close();
    entry.iterator = undefined;
    entry.picker = undefined;
    entry.input?.dispose();
    entry.input = undefined;
  };

  const samples: FrameSample[] = [];
  const digests: number[] = [];
  const frames = new Map<string, WrappedCanvas['canvas'] | null>();
  // `broken` 用の 1 コマ遅れの控え。`pool` では使い回されるので中身が同じになることがあるが、
  // 壊れていることを見せたいのは `at-timestamps` の側なので、そこは気にしない。
  const held = new Map<string, WrappedCanvas['canvas'] | null>();

  const inFlight = new InFlightQueue(encodeDepth);
  let submitMs = 0;
  let waitMs = 0;

  await output.start();
  const wallStart = performance.now();

  for (const framePlan of plan.perFrame) {
    // --- デコード ---
    const d0 = performance.now();
    for (const clipId of framePlan.decode) {
      const entry = byClip.get(clipId);
      if (!entry) continue;
      await openStream(entry);
      const wanted = entry.stream.times[entry.cursor];
      entry.cursor += 1;
      if (entry.picker) {
        frames.set(clipId, await entry.picker.at(wanted));
      } else if (entry.iterator) {
        const step = await entry.iterator.next();
        frames.set(clipId, step.done ? null : (step.value?.canvas ?? null));
      } else {
        frames.set(clipId, null);
      }
      if (entry.cursor >= entry.stream.frames.length) closeStream(entry);
    }
    const d1 = performance.now();

    // --- 描く ---
    ctx.clearRect(0, 0, width, height);
    for (const clipId of framePlan.draw) {
      // `broken` は**1 コマ前を描く**。デコードは正しく回したまま出来上がりだけをずらすので、
      // 「検査が本当に落ちるか」を、時計をほとんど動かさずに確かめられる。
      const decoded = mode === 'broken' ? (held.get(clipId) ?? frames.get(clipId)) : frames.get(clipId);
      if (decoded) ctx.drawImage(decoded, 0, 0, width, height);
      held.set(clipId, frames.get(clipId) ?? null);
    }
    const d2 = performance.now();

    // --- エンコード ---
    // `add()` は**呼んだその場で**絵を捕まえて（`new VideoFrame(canvas)`）、
    // 返ってくる約束は「詰まりが解けたか」のほう。だから約束を後ろへ回しても
    // 次のコマで canvas を描き替えてよい（根拠は `src/pipeline.ts` の注）。
    const submitted = videoSource.add(framePlan.time, 1 / fps);
    const d3 = performance.now();
    await inFlight.push(submitted);
    const d4 = performance.now();

    submitMs += d3 - d2;
    waitMs += d4 - d3;
    // `encode` の取り分は**そこで待たされた時間**なので、投げる手間と待ちを合わせて 1 つに数える。
    // 重ねる形ではここが薄くなるが、**消えたぶんは仕上げ（`finalizeMs`）へ移るだけ**だった
    // （2026-09-26・2 回目に測った。だから合計で読む）。内訳は `submitMs` / `waitMs` で分かれる。
    samples.push({ decode: d1 - d0, draw: d2 - d1, encode: d4 - d2 });
    // 指紋は時計の外。取ると `getImageData` のぶん重くなるので、計測の回では取らない。
    if (digest) digests.push(digestOf(ctx, width, height));
  }

  // 残りを待ち切るところまでが「輪」。ここを仕上げへ預けると、
  // **重ねた形だけ壁時計が短く見える**（仕事が消えたわけではないのに）。
  const drainStart = performance.now();
  await inFlight.drain();
  const drainMs = performance.now() - drainStart;
  const wallMs = performance.now() - wallStart;

  const finalizeStart = performance.now();
  await output.finalize();
  const finalizeMs = performance.now() - finalizeStart;
  open.forEach(closeStream);

  const buffer = (output.target as InstanceType<typeof BufferTarget>).buffer;
  const signature = verify && buffer ? await signOutput(buffer) : [];

  return {
    mode,
    encodeDepth,
    frames: plan.perFrame.length,
    wallMs,
    finalizeMs,
    submitMs,
    waitMs,
    drainMs,
    inFlight: inFlight.counters,
    signature,
    signatureStride: SIGNATURE_GRID * SIGNATURE_GRID,
    openMs,
    opens,
    samples,
    digests,
    width,
    height,
    bytes: buffer?.byteLength ?? 0,
  };
}

/**
 * 指紋を取る格子。
 *
 * **最初 8×8 で書いて、わざと 1 コマずらした相手に素通りされた**（2026-09-26・2 回目）。
 * 潰す粗さそのものより効いたのは**読み方**のほうで、詳しくは `bench.mjs` の `compare` の注。
 * ここでは 16×16（＝ 256 個）に取ってある。場面の中の動きは画面のごく一部なので、
 * これ以上粗くすると升目ごとに見ても動きが均されて消える。
 */
const SIGNATURE_GRID = 16;

/**
 * 出来上がった WebM を**読み直して**、1 コマにつき `SIGNATURE_GRID` の格子ぶんの平均輝度を並べる。
 *
 * 縮めるのはブラウザの `drawImage` に任せている。自前で平均を取るより速く、
 * **ここで見たいのは「別の絵になっていないか」だけ**なので粗くてよい。
 * 逆に全画素を突き合わせると、非可逆の符号化で毎回ぶれる量まで拾ってしまう。
 */
async function signOutput(buffer: ArrayBuffer): Promise<number[]> {
  const input = new Input({ source: new BlobSource(new Blob([buffer])), formats: [MATROSKA, WEBM] });
  const values: number[] = [];
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) return values;
    const small = document.createElement('canvas');
    small.width = SIGNATURE_GRID;
    small.height = SIGNATURE_GRID;
    const ctx = small.getContext('2d', { alpha: false, willReadFrequently: true });
    if (!ctx) throw new Error('指紋用のキャンバスを初期化できませんでした');
    const sink = new CanvasSink(track);
    for await (const wrapped of sink.canvases()) {
      ctx.drawImage(wrapped.canvas, 0, 0, SIGNATURE_GRID, SIGNATURE_GRID);
      const data = ctx.getImageData(0, 0, SIGNATURE_GRID, SIGNATURE_GRID).data;
      for (let i = 0; i < data.length; i += 4) {
        values.push((data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000);
      }
    }
  } finally {
    input.dispose();
  }
  return values;
}

/**
 * 同じ素材を指すクリップの注文を 1 本にまとめる。
 *
 * まとめた `clipId` は `a+b+c` の形にしてある（引くときに割って使う）。
 * **並べ直しはしない。** 時刻が単調でなければ `canvasesAtTimestamps` の
 * 速い道から外れるだけなので、そのときは素直に諦めるほうが読みやすい。
 */
function mergeByMedia(streams: ClipStream[]): ClipStream[] {
  const byMedia = new Map<string, ClipStream>();
  for (const stream of streams) {
    const hit = byMedia.get(stream.mediaId);
    if (!hit) {
      byMedia.set(stream.mediaId, { ...stream, frames: [...stream.frames], times: [...stream.times] });
      continue;
    }
    hit.clipId = `${hit.clipId}+${stream.clipId}`;
    hit.frames.push(...stream.frames);
    hit.times.push(...stream.times);
  }
  return [...byMedia.values()];
}

declare global {
  interface Window {
    __labExportMeasure: typeof measureExport;
  }
}
window.__labExportMeasure = measureExport;
