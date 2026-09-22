/**
 * 試し素材（合成したコマの列）を、**本物の動画ファイルに焼く**。
 *
 * ## これは画面の一部ではない
 *
 * `index.html` からは読み込んでいない。`uitest.mjs` が playwright 越しに
 * `<script type="module">` として差し込むためだけに置いてある。
 * **確かめるためだけの部品を、配るものの中へ入れない**ためにフォルダごと分けてある。
 *
 * ## なぜブラウザで焼くのか
 *
 * 画面の確認でいちばん見たいのは「**本物の動画を読む所**が繋がっているか」で、
 * それには本物の動画ファイルが要る。ところがラボには外部ライブラリを足さない方針なので、
 * Node 側にエンコーダが無い（音の側は WAV が無圧縮なので自前で書けた。映像は書けない）。
 *
 * 焼く側も読む側も同じ WebCodecs なので、ブラウザの中でなら焼ける。
 * 使っているのは本体がすでに依存している mediabunny だけで、新しい依存は増えていない。
 *
 * **圧縮を通すことそのものが確認になる。** 合成したコマをそのまま渡すのと違い、
 * ここを通ると量子化の粒が乗る。画面の数字がコマンドラインとどこまで揃うかは、
 * 「配線が正しいか」だけでなく「この判定が圧縮の粒に耐えるか」も一緒に測っている。
 */

import {
  BufferTarget,
  CanvasSource,
  Output,
  Quality,
  WebMOutputFormat,
  getFirstEncodableVideoCodec,
} from 'mediabunny';
import { renderFixture } from '../../fixtures/make-frames.mjs';

/** `make-frames.mjs` が返すもの（.mjs なので型は無い。ここで最小限だけ名前を付ける）。 */
interface RenderedClip {
  width: number;
  height: number;
  fps: number;
  frames: { width: number; height: number; data: Uint8ClampedArray }[];
  cuts: number[];
}

export interface EncodedFixture {
  bytes: Uint8Array;
  cuts: number[];
  width: number;
  height: number;
  fps: number;
  frames: number;
  codec: string;
}

/**
 * 素材 1 本を WebM に焼く。
 *
 * ビットレートを素材の大きさのわりに高く取ってあるのは、
 * **確かめたいのが圧縮の限界ではなく配線だから**。それでも粒は乗るので、
 * `uitest.mjs` の突き合わせには幅を持たせてある。
 */
export async function encodeFixture(
  name: string,
  { aspect = 'landscape', fps }: { aspect?: string; fps?: number } = {},
): Promise<EncodedFixture> {
  const clip = renderFixture(name, { aspect, ...(fps ? { fps } : {}) }) as RenderedClip;

  const canvas = document.createElement('canvas');
  canvas.width = clip.width;
  canvas.height = clip.height;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('キャンバスを初期化できませんでした');

  const codec = await getFirstEncodableVideoCodec(['vp9', 'vp8'], {
    width: clip.width,
    height: clip.height,
  });
  if (!codec) throw new Error('この環境では映像を焼けるコーデックが見つかりませんでした');

  const output = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() });
  const source = new CanvasSource(canvas, {
    codec,
    quality: new Quality({ bitrate: 4_000_000 }),
    // 全コマを鍵コマにしない。**鍵コマだらけにすると圧縮の粒がほとんど乗らず、
    // 「本物の動画を読んだ」の中身が合成コマを読んだのと変わらなくなる。**
    keyFrameInterval: 2,
  });
  output.addVideoTrack(source, { frameRate: clip.fps });

  await output.start();
  for (let i = 0; i < clip.frames.length; i += 1) {
    const frame = clip.frames[i];
    ctx.putImageData(new ImageData(new Uint8ClampedArray(frame.data), frame.width, frame.height), 0, 0);
    await source.add(i / clip.fps, 1 / clip.fps);
  }
  await output.finalize();

  const buffer = (output.target as InstanceType<typeof BufferTarget>).buffer;
  if (!buffer) throw new Error('焼いた動画を取り出せませんでした');

  return {
    bytes: new Uint8Array(buffer),
    cuts: clip.cuts,
    width: clip.width,
    height: clip.height,
    fps: clip.fps,
    frames: clip.frames.length,
    codec,
  };
}

declare global {
  interface Window {
    __labSceneEncode: typeof encodeFixture;
  }
}
window.__labSceneEncode = encodeFixture;
