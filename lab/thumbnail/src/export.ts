/**
 * 選んだ秒のコマを、**素材の大きさのまま**取り出して絵のファイルにする。
 *
 * ここには判断を置かない。`scene-cut/src/decode.ts` と同じ立場の部品で、
 * 違うのは「測るために読む」のではなく「**出すために読む**」ことだけ。
 *
 * ## なぜ読み込みをもう一度やるのか（この画面を作って初めて出てきた話）
 *
 * 判定のための読み込み（`decode.ts`）は、コマを**長辺 128 画素へ縮めて**読む。
 * 分布しか見ないので、それで足りるし、そのほうが速いからだ。
 * ところが表紙は**人が見る絵**なので、128 画素では使い物にならない。
 * つまり「測るコマ」と「書き出すコマ」は、そもそも別物だった。
 *
 * 全コマを大きいまま持つ手は取らない。13 秒・195 コマを 1920×1080 の RGBA で持つと
 * 1.6GB になる。**選んだ数枚だけを、選んでから読み直す**ほうが素直で、
 * 3 枚なら 3 回のシークで済む（リミッタを長尺へ当てるときと同じで、
 * 要るのは「全部を持たない形」のほう）。
 *
 * ## 秒はずれないのか
 *
 * ずれない。`decode.ts` は `i / fps` の秒を読み、`canvasesAtTimestamps` は
 * **その秒かその手前のコマ**を返す。ここでも同じ秒を同じ関数へ渡すので、
 * 返ってくるのは同じ素材のコマになる。ここが食い違うと
 * 「選んだ絵」と「出てきた絵」が別物になるので、`uitest.mjs` で
 * 書き出した絵と測ったコマの分布を突き合わせて確かめている。
 */

import type { FrameLike } from '../../scene-cut/src/frames.ts';

/**
 * 書き出す絵の長辺の上限（画素）。
 *
 * 表紙の置き場（配信サイトの一覧）が求めるのはせいぜい 1280×720 なので、
 * 4K 素材をそのまま出しても行き先が無い。**上限が無いと、
 * 選んだ枚数ぶんだけ素材の解像度で RGBA を持つ**ことになるのが本当の理由で、
 * 4K なら 1 枚 33MB。素材がこれより小さければ拡大はしない（無い細かさは作れない）。
 */
export const EXPORT_LONG_SIDE = 1920;

export interface ExportedFrame extends FrameLike {
  time: number;
  /** 素材そのものの大きさ（上限で縮めたかどうかを読むため）。 */
  sourceWidth: number;
  sourceHeight: number;
}

/** 長辺を上限まで縮めた大きさ。**素材より大きくはしない。** */
export function exportSize(
  width: number,
  height: number,
  longSide: number,
): { width: number; height: number } {
  if (!(width > 0) || !(height > 0)) return { width: 1, height: 1 };
  const scale = Math.min(1, longSide / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * 秒の列を渡して、その秒のコマを素材の大きさで取り出す。
 *
 * 秒は**昇順で渡すこと**。`canvasesAtTimestamps` は前へ戻らない作りなので、
 * 順番が入れ替わっていると取れないコマが出る。選んだ候補は時間順に返るので、
 * ふつうに渡せばそうなっているが、呼ぶ側の都合で並べ替えたときのために並べ直す。
 */
export async function decodeFramesAt(
  file: Blob,
  times: number[],
  { longSide = EXPORT_LONG_SIDE }: { longSide?: number } = {},
): Promise<(ExportedFrame | null)[]> {
  if (!times.length) return [];
  const { BlobSource, CanvasSink, Input, MATROSKA, MP4, QTFF, WEBM } = await import('mediabunny');

  const input = new Input({ source: new BlobSource(file), formats: [MP4, QTFF, MATROSKA, WEBM] });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error('この素材に映像トラックがありません');

    const sourceWidth = track.displayWidth;
    const sourceHeight = track.displayHeight;
    const size = exportSize(sourceWidth, sourceHeight, longSide);

    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('キャンバスを初期化できませんでした');

    // 渡された順を覚えたまま昇順で読む（返すのは渡された順）。
    const order = times.map((time, i) => ({ time, i })).sort((a, b) => a.time - b.time);
    const sink = new CanvasSink(track, { width: size.width, height: size.height, fit: 'fill' });
    const out: (ExportedFrame | null)[] = times.map(() => null);
    let k = 0;
    for await (const wrapped of sink.canvasesAtTimestamps(order.map((o) => o.time))) {
      const slot = order[k];
      k += 1;
      if (!wrapped || !slot) continue;
      ctx.drawImage(wrapped.canvas as CanvasImageSource, 0, 0, size.width, size.height);
      const image = ctx.getImageData(0, 0, size.width, size.height);
      out[slot.i] = {
        time: slot.time,
        width: image.width,
        height: image.height,
        data: image.data,
        sourceWidth,
        sourceHeight,
      };
    }
    // 返ってこなかった秒は**黙って詰めない**。渡した秒と同じ長さのまま、
    // 取れなかった所を `null` で返す。詰めて返すと、呼ぶ側が i 番目を i 番目の候補だと
    // 思って割り当てるので、**1 枚欠けただけで以降が丸ごと 1 つずれる**
    // （絵は出るし大きさも合うので、ずれたことは数字のどこにも出ない）。
    return out;
  } finally {
    // 開いたら必ず閉じる（同時に持てるデコーダの数は端末ごとに決まっている）。
    input.dispose();
  }
}

/** コマ 1 枚を PNG にする。表紙は文字や線が乗る前提なので、非可逆では出さない。 */
export async function frameToPng(frame: FrameLike): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = frame.width;
  canvas.height = frame.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('キャンバスを初期化できませんでした');
  ctx.putImageData(new ImageData(new Uint8ClampedArray(frame.data), frame.width, frame.height), 0, 0);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('絵を書き出せませんでした'))), 'image/png');
  });
}

/** 絵をファイルとして保存させる。`URL` は必ず捨てる（貼りっぱなしだと絵が居座る）。 */
export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  // 押した直後に捨てると保存が始まらない端末があるので、1 回ぶん遅らせる。
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * 書き出す絵の名前。**秒を名前に入れる**。
 *
 * 3 枚まとめて落とすと、名前が同じだと `(1)` `(2)` が付いて
 * どれがどの秒か分からなくなる。素材の名前も残しておけば、
 * 別の素材の候補と同じフォルダへ落としても混ざらない。
 */
export function exportName(source: string, time: number): string {
  const base = source.replace(/\.[^.]+$/, '').replace(/[^\w\-一-龠ぁ-んァ-ヶ]+/g, '_') || 'thumb';
  return `${base}_${time.toFixed(2).replace('.', 'p')}s.png`;
}
