/**
 * 「**読むコマを間引くか、ならしの窓を広げるか**」を、本物の動画の上で測るための口。
 *
 * ## これは画面の一部ではない
 *
 * `encode.ts` と同じ立場で、`index.html` からは読み込んでいない。
 * `decimate-probe.mjs` と `gate-probe.mjs` が playwright 越しに差し込むためだけに置いてある。
 * **焼く→読む→畳む→枠を決める、が要るのはどちらも同じ**なので、口は 1 つにしてある
 * （2 つ持つと、焼き方の違いが測りたいものに混ざる）。
 *
 * ## なぜブラウザの中で測るのか
 *
 * 測りたいものが**圧縮の粒**だから。合成したコマをそのまま渡すと粒が乗らず、
 * 間引いても数字が 1 桁も動かない（2026-09-25 に確かめた）。
 * 焼く・読む・畳む・枠を決める、の 4 つを**同じ場所で**通さないと、
 * 「読むのにかかった時間」と「その読み方で出た枠」が別々の話になってしまう。
 *
 * ## 焼いた動画は名前ごとに取っておく
 *
 * 1 本焼くのに数秒かかるので、読み方（15fps / 30fps）ごとに焼き直すと
 * **測っているものの大半が焼く時間**になる。焼くのは 1 回、読むのは何回でも。
 */

import { decodeVideoFrames } from '../../scene-cut/src/decode.ts';
import { encodeFixture } from '../../scene-cut/testkit/encode.ts';
import { planReframe, summarizeForReframe, type ReframeOptions } from '../src/reframe.ts';

interface PlanResult {
  label: string;
  centers: number[];
  raws: number[];
  targets: number[];
  /** そのコマで枠が動いていたか（`gate-probe.mjs` が「どこで食い違ったか」を読むのに使う）。 */
  movings: boolean[];
  /** 門が貯めを捨てた回数（`gate-probe.mjs` が読む）。 */
  gate: { resets: number; nearResets: number };
}

interface MeasureResult {
  times: number[];
  frames: number;
  sourceFps: number;
  fps: number;
  width: number;
  height: number;
  bytes: number;
  /** 読むのにかかった時間（ms）。何回か回した中のいちばん短いものを使う側で選ぶ。 */
  decodeMs: number[];
  /** 列へ畳むのにかかった時間（ms）。 */
  summarizeMs: number[];
  /** コマを持っているあいだのメモリ（MB）。長い素材で効くのはここ。 */
  frameMb: number;
  plans: PlanResult[];
}

const baked = new Map<string, Blob>();

/** 素材 1 本を WebM に焼く。同じ（名前・速さ・粒の粗さ）は焼き直さない。 */
async function bake(name: string, fps: number, bitrate: number): Promise<Blob> {
  const key = `${name}@${fps}@${bitrate}`;
  const found = baked.get(key);
  if (found) return found;
  const encoded = await encodeFixture(name, { fps, bitrate });
  // `bytes` は `Uint8Array` なので、そのまま Blob へ渡すとコピーが 1 回増えるだけ。
  const blob = new Blob([encoded.bytes as BlobPart], { type: 'video/webm' });
  baked.set(key, blob);
  return blob;
}

/**
 * 素材 1 本を、ある速さで読んで、いくつかのつまみで枠を決める。
 *
 * `plans` を配列で取るのは、**同じデコード結果を使い回すため**。
 * ならしの窓だけを変えて比べたいのに読み直すと、比べている 2 つに
 * 圧縮の粒の引き当てまで混ざる（同じ動画を読んでも、粒は同じなのだが、
 * 時間の測定だけは読み直すたびに揺れる）。
 */
async function measure(
  name: string,
  {
    bakeFps = 30,
    bitrate = 4_000_000,
    readFps = 15,
    plans = [{ label: '既定', options: {} }] as { label: string; options: Partial<ReframeOptions> }[],
    repeats = 1,
  } = {},
): Promise<MeasureResult> {
  const blob = await bake(name, bakeFps, bitrate);

  const decodeMs: number[] = [];
  const summarizeMs: number[] = [];
  let clip = await decodeVideoFrames(blob, { fps: readFps });
  let cols = summarizeForReframe(clip.frames, clip.times);
  // 1 回目は捨てる（デコーダの立ち上がりと JIT が乗る）。
  for (let i = 0; i < repeats; i += 1) {
    const t0 = performance.now();
    clip = await decodeVideoFrames(blob, { fps: readFps });
    const t1 = performance.now();
    cols = summarizeForReframe(clip.frames, clip.times);
    const t2 = performance.now();
    decodeMs.push(t1 - t0);
    summarizeMs.push(t2 - t1);
  }

  return {
    times: [...clip.times],
    frames: clip.frames.length,
    sourceFps: clip.sourceFps,
    fps: clip.fps,
    width: clip.width,
    height: clip.height,
    bytes: blob.size,
    decodeMs,
    summarizeMs,
    frameMb: (clip.frames.length * clip.width * clip.height * 4) / 1024 / 1024,
    plans: plans.map((p) => {
      const plan = planReframe(cols, p.options);
      return {
        label: p.label,
        centers: plan.frames.map((f) => f.center),
        raws: plan.frames.map((f) => f.raw),
        targets: plan.frames.map((f) => f.target),
        movings: plan.frames.map((f) => f.moving),
        gate: plan.gate,
      };
    }),
  };
}

declare global {
  interface Window {
    __labReframeDecimate: typeof measure;
  }
}
window.__labReframeDecimate = measure;
