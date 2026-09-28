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
export interface RenderedClip {
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
 * 描いたコマの列を WebM に焼く。**素材の一覧に依らない**ので、
 * シーン検出の素材（`scenes.mjs`）でも表紙の素材（`thumbs.mjs`）でも同じものを通せる。
 *
 * ビットレートの既定を素材の大きさのわりに高く取ってあるのは、
 * **確かめたいのが圧縮の限界ではなく配線だから**。それでも粒は乗るので、
 * `uitest.mjs` の突き合わせには幅を持たせてある。
 *
 * `bitrate` を開けてあるのは、**「同じ中身の、別の焼き上がり」を作るため**（2026-09-25・2 回目）。
 * 速さを上げると、同じビットレートでは 1 枚あたりの取り分が減るので
 * **速さと粒が一緒に動いてしまう。** 速さを止めて粒だけ動かせば、その 2 つを分けられる。
 * 実際にそうして分かったのは、**粒はほとんど動かないのに答えのほうが数ポイント動く**
 * ということだった（`lab/reframe/README.md` の「読むコマの速さ」）。
 * 焼き直しただけで動く幅は、**その判定の当たり外れを測る物差し**として使える。
 *
 * `scale` は焼くときの拡大率。**表紙の側が要る**つまみで、
 * 「測るコマ（長辺 128 へ縮める）」と「書き出すコマ（素材の大きさ）」が
 * 別物であることを確かめるには、素材が 128 より大きくないと差が出ない。
 * 拡大は補間で引き伸ばすだけなので、どの秒に何が写っているかは 1 つも動かない。
 */
export async function encodeClip(
  clip: RenderedClip,
  { scale = 1, bitrate = 4_000_000 }: { scale?: number; bitrate?: number } = {},
): Promise<EncodedFixture> {
  const width = Math.round(clip.width * scale);
  const height = Math.round(clip.height * scale);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('キャンバスを初期化できませんでした');

  // 拡大するときだけ、いったん等倍へ描いてから引き伸ばす受け皿を作る
  // （`putImageData` は拡大しないので、`drawImage` を挟まないと左上に貼られるだけになる）。
  const source2d = scale === 1 ? null : document.createElement('canvas');
  if (source2d) {
    source2d.width = clip.width;
    source2d.height = clip.height;
  }
  const sourceCtx = source2d?.getContext('2d', { alpha: false }) ?? null;

  const codec = await getFirstEncodableVideoCodec(['vp9', 'vp8'], { width, height });
  if (!codec) throw new Error('この環境では映像を焼けるコーデックが見つかりませんでした');

  const output = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() });
  const source = new CanvasSource(canvas, {
    codec,
    quality: new Quality({ bitrate }),
    // 全コマを鍵コマにしない。**鍵コマだらけにすると圧縮の粒がほとんど乗らず、
    // 「本物の動画を読んだ」の中身が合成コマを読んだのと変わらなくなる。**
    keyFrameInterval: 2,
  });
  output.addVideoTrack(source, { frameRate: clip.fps });

  await output.start();
  for (let i = 0; i < clip.frames.length; i += 1) {
    const frame = clip.frames[i];
    const image = new ImageData(new Uint8ClampedArray(frame.data), frame.width, frame.height);
    if (sourceCtx && source2d) {
      sourceCtx.putImageData(image, 0, 0);
      ctx.drawImage(source2d, 0, 0, width, height);
    } else {
      ctx.putImageData(image, 0, 0);
    }
    await source.add(i / clip.fps, 1 / clip.fps);
  }
  await output.finalize();

  const buffer = (output.target as InstanceType<typeof BufferTarget>).buffer;
  if (!buffer) throw new Error('焼いた動画を取り出せませんでした');

  return {
    bytes: new Uint8Array(buffer),
    cuts: clip.cuts,
    width,
    height,
    fps: clip.fps,
    frames: clip.frames.length,
    codec,
  };
}

/** シーン検出の素材 1 本を WebM に焼く。 */
export async function encodeFixture(
  name: string,
  { aspect = 'landscape', fps, bitrate }: { aspect?: string; fps?: number; bitrate?: number } = {},
): Promise<EncodedFixture> {
  return encodeClip(renderFixture(name, { aspect, ...(fps ? { fps } : {}) }) as RenderedClip, {
    ...(bitrate ? { bitrate } : {}),
  });
}

declare global {
  interface Window {
    __labSceneEncode: typeof encodeFixture;
  }
}
window.__labSceneEncode = encodeFixture;
