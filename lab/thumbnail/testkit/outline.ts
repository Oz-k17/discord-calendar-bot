/**
 * **実寸で描いたコマ**を書き出して、字の縁取り（細い線）がどれだけ荒れるかを測る
 * （2026-09-24・2 回目）。
 *
 * ## なぜ `formats.ts` の道では測れないのか
 *
 * `format-probe` は素材を **128×72 で描いてから 15 倍に引き伸ばして**焼いている
 * （`LAB_SCALE=15` で 1920×1080）。引き伸ばすのは `drawImage` なので滑らかに伸びる。
 * つまり**実寸の 4 画素の線を入力に持てない**——0.27 画素ぶんだけ暗くなった画素が、
 * 15 画素ぶんの緩い影に化ける。それでは「細い線が非可逆で荒れるか」は測れない。
 *
 * ここでは素材を**最初から 1920×1080 で描く**（`renderSpec` の `scale`）。
 * そうすれば縁取りは 4 画素の線として入り、点で引いても消えない。
 *
 * ## なぜ動画に焼かないのか
 *
 * `formats.ts` は「画面が通る道」（WebM へ焼く → デコードする → 書き出す）を
 * そのまま通すことを大事にしている。ここはあえて外した。理由は 2 つ:
 *
 *   - **WebM（VP9・4Mbps）も非可逆**なので、細い線は JPEG へ渡る前に鈍る。
 *     それでは「JPEG が細い線をどう壊すか」ではなく「VP9 が先に壊した残り」を測る。
 *   - 1920×1080 を 13 コマ焼くと、測りたいことに対して時間が釣り合わない。
 *
 * なので、ここで出る数は**上限**（本物の動画より鮮明な線を JPEG に渡したときの荒れ）。
 * 実際の素材はデコードを通るので、これより穏やかになる。そこは数字の読み方として添える。
 */

import { renderSpec } from '../../fixtures/make-frames.mjs';
import { thumbFixture } from '../../fixtures/thumbs.mjs';

interface FrameLike {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export interface OutlineFormatSample {
  label: string;
  type: string;
  quality: number | null;
  bytes: number;
  /** 画面ぜんたい ／ 帯の中 ／ 帯の外 ／ **縁取りの上**／ 帯の中で縁取り以外。 */
  rmse: number;
  rmseInBand: number;
  rmseOutBand: number;
  rmseOnOutline: number;
  rmseBandRest: number;
}

export interface OutlineFormatReport {
  fixture: string;
  width: number;
  height: number;
  time: number;
  /** 縁取りが乗っている画素の数（＝細い線の総面積）。 */
  outlinePixels: number;
  bands: { from: number; to: number }[];
  samples: OutlineFormatSample[];
}

function bandsOf(name: string): { from: number; to: number }[] {
  const caps = (thumbFixture(name) as { options?: { captions?: { top?: number; bottom?: number } } }).options?.captions;
  if (!caps) return [];
  const out: { from: number; to: number }[] = [];
  if (caps.top) out.push({ from: 0, to: caps.top });
  if (caps.bottom) out.push({ from: 1 - caps.bottom, to: 1 });
  return out;
}

function luma(d: Uint8ClampedArray, i: number): number {
  return 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
}

/**
 * 区分ごとの二乗平均誤差。
 *
 * **縁取りの上だけを別に数える**のがここの要点。帯の中でまとめて数えると、
 * 縁取りは帯の 1% ほどしか占めないので、平らな板の中に薄められて見えなくなる。
 * どの画素が縁取りかは「縁取りを外して同じコマを描いたときに色が違う画素」で決める
 * （素材の側で正解が作れるので、色で拾い直す必要が無い）。
 */
function errors(a: FrameLike, b: FrameLike, mask: Uint8Array, bands: { from: number; to: number }[]) {
  const acc = { all: [0, 0], inBand: [0, 0], outBand: [0, 0], onOutline: [0, 0], bandRest: [0, 0] };
  for (let y = 0; y < a.height; y += 1) {
    const v = (y + 0.5) / a.height;
    const inside = bands.some((r) => v >= r.from && v < r.to);
    for (let x = 0; x < a.width; x += 1) {
      const p = y * a.width + x;
      const i = p * 4;
      const d = (luma(a.data, i) - luma(b.data, i)) ** 2;
      acc.all[0] += d;
      acc.all[1] += 1;
      const target = inside ? acc.inBand : acc.outBand;
      target[0] += d;
      target[1] += 1;
      if (mask[p]) {
        acc.onOutline[0] += d;
        acc.onOutline[1] += 1;
      } else if (inside) {
        acc.bandRest[0] += d;
        acc.bandRest[1] += 1;
      }
    }
  }
  const rms = (pair: number[]) => (pair[1] ? Math.sqrt(pair[0] / pair[1]) : 0);
  return {
    all: rms(acc.all),
    inBand: rms(acc.inBand),
    outBand: rms(acc.outBand),
    onOutline: rms(acc.onOutline),
    bandRest: rms(acc.bandRest),
  };
}

async function toBlob(frame: FrameLike, type: string, quality?: number): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = frame.width;
  canvas.height = frame.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('キャンバスを初期化できませんでした');
  ctx.putImageData(new ImageData(new Uint8ClampedArray(frame.data), frame.width, frame.height), 0, 0);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
  if (!blob) throw new Error(`${type} を焼けませんでした`);
  return blob;
}

async function readBack(blob: Blob, width: number, height: number): Promise<FrameLike> {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('キャンバスを初期化できませんでした');
  ctx.drawImage(bitmap, 0, 0);
  const image = ctx.getImageData(0, 0, width, height);
  return { width, height, data: image.data };
}

export async function measureOutlineFormats(
  name: string,
  {
    qualities = [0.7, 0.85, 0.9, 0.95],
    // 15 倍で 1920×1080。**書き出しの上限そのもの**なので、ここで測れば掛け算が要らない。
    renderScale = 15,
    // 3 コマだけ描く（0 / 4 / 8 秒）。実寸の 1 本ぶん（195 コマ）は測りたいことに対して重すぎる。
    fps = 0.25,
    frameIndex = 1,
    outline = 0.0037,
    // 実寸では縁取りが 4 画素になるので、**点で引いても消えない**。
    // ここで面積で混ぜないのは、本物の焼き込みが実寸で置かれるのと同じ形にするため。
    samples = 1,
  } = {},
): Promise<OutlineFormatReport> {
  const spec = thumbFixture(name);
  const render = (w: number) =>
    renderSpec(spec, { fps, scale: renderScale, captionOutline: w, captionSamples: samples }) as {
      width: number;
      height: number;
      times: Float64Array;
      frames: FrameLike[];
    };
  const bare = render(0);
  const lined = render(outline);
  const frame = lined.frames[frameIndex];
  const before = bare.frames[frameIndex];

  // 縁取りの画素（＝細い線）を、縁取りを外したコマとの差で拾う。
  const mask = new Uint8Array(frame.width * frame.height);
  let outlinePixels = 0;
  if (outline > 0) {
    for (let p = 0; p < mask.length; p += 1) {
      const i = p * 4;
      if (before.data[i] !== frame.data[i] || before.data[i + 1] !== frame.data[i + 1]) {
        mask[p] = 1;
        outlinePixels += 1;
      }
    }
  }

  const bands = bandsOf(name);
  const variants: { label: string; type: string; quality: number | null }[] = [
    { label: 'png', type: 'image/png', quality: null },
    ...qualities.map((q) => ({ label: `jpeg q${q.toFixed(2)}`, type: 'image/jpeg', quality: q })),
  ];
  const samplesOut: OutlineFormatSample[] = [];
  for (const v of variants) {
    const blob = await toBlob(frame, v.type, v.quality ?? undefined);
    const back = await readBack(blob, frame.width, frame.height);
    const e = errors(frame, back, mask, bands);
    samplesOut.push({
      label: v.label,
      type: blob.type,
      quality: v.quality,
      bytes: blob.size,
      rmse: e.all,
      rmseInBand: e.inBand,
      rmseOutBand: e.outBand,
      rmseOnOutline: e.onOutline,
      rmseBandRest: e.bandRest,
    });
  }

  return {
    fixture: name,
    width: frame.width,
    height: frame.height,
    time: lined.times[frameIndex],
    outlinePixels,
    bands,
    samples: samplesOut,
  };
}

declare global {
  interface Window {
    __labOutlineFormats: typeof measureOutlineFormats;
  }
}
window.__labOutlineFormats = measureOutlineFormats;
