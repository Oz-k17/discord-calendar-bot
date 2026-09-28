/**
 * デコードとエンコードを**重ねて**回すための、待ち行列ひとつぶん。
 *
 * ## なぜこれが要るのか
 *
 * いまの書き出しの輪は 1 コマにつき
 * 「デコードを待つ → 描く → エンコードを待つ」を**足し算で**並べている。
 * 2026-09-26（1 回目）に測ったとおり、段ごとの時計が見ているのは
 * 「その段が重いか」ではなく**「そこで待たされたか」**なので、
 * 片方を速くしても待ちがもう片方へ移るだけで壁時計は縮まない。
 * 足し算を**最大値**へ変えるには、片方を待っている間にもう片方を進めるしかない。
 *
 * ## 「待たない」ではなく「N 枚まで待たない」
 *
 * `CanvasSource.add()` が返す約束は**詰まりの知らせ**（エンコーダと書き出し口の背圧）なので、
 * 一切待たない形にすると詰まりが見えなくなり、未完了のコマが尺のぶんだけ積み上がる。
 * 1 枚 1024×576 の生の絵は 2MB 前後あるので、390 コマ溜めれば 800MB になる。
 * **だから「いくつまで未完了を許すか」を数で持つ**。0 なら今までどおりの直列。
 *
 * ## 順番が狂わない根拠（mediabunny の中を読んで確かめた）
 *
 * `CanvasSource.add()` は**呼んだその場で** `new VideoFrame(canvas)` を作り
 * （絵はそこで捕まる）、変換も速さの正規化も透明度も使っていない今回の経路では、
 * `encoder.encode()` までを**同期で**通す。待ちが入るのはその後ろ
 * （`encodeQueueSize >= 4` の空き待ちと、書き出し口の `lastMuxerPromise`）だけ。
 * つまり**投げた順にエンコーダへ入る**ので、約束を後で待っても並びは動かない。
 *
 * ただしこれは**読んで確かめただけ**の話なので、`bench.mjs` は出来上がった WebM を
 * 読み直して突き合わせる（`measure.ts` の `verify`）。**中を読んだ根拠と、
 * 出口で測った根拠は別物**で、ここは後者が要るところ。
 */

/** 何枚まで未完了を許すか。0 は直列（いまの本体と同じ）。 */
export const SERIAL_DEPTH = 0;

/**
 * 既定の枚数。**1 で足りる**というのが 2026-09-26（2 回目）に測った結論で、
 * 2 段の流れ作業は定常状態で「遅いほうの段」に律速されるから、
 * 1 枚先行していれば足し算はもう最大値になっている。数字は README の表。
 */
export const DEFAULT_ENCODE_DEPTH = 1;

export interface InFlightStats {
  /** 投げた数。 */
  submitted: number;
  /** 実際に待たされた回数（＝枚数が上限に当たった回数）。 */
  waits: number;
  /** 同時に未完了だった最大枚数。上限を超えないことの確認に使う。 */
  maxInFlight: number;
}

/**
 * 未完了の約束を `depth` 枚まで抱えておく行列。
 *
 * **失敗は握り潰さない。** 約束が落ちたときに誰も待っていないと
 * 「拾われなかった拒否」になって画面側のエラーに化けるので、
 * 投げた時点で受け皿を付けておき、**次に `push` か `drain` を呼んだところで投げ直す**。
 * 遅れて出る代わりに、必ず輪の中の分かる場所で出る。
 */
export class InFlightQueue {
  private readonly pending: Promise<void>[] = [];
  private failure: unknown = null;
  private failed = false;
  private stats: InFlightStats = { submitted: 0, waits: 0, maxInFlight: 0 };
  // 引数をそのまま項目にする書き方（`constructor(private depth: number)`）は使えない。
  // Node は `.ts` を**型を剥がすだけ**で実行するので、剥がすと項目が消えてしまう
  // （`npm run lab:test` がその場で落ちる）。ラボの検算はブラウザ無しで回す決まりなので、
  // ここは素直に書き下す。
  private readonly depth: number;

  constructor(depth: number) {
    if (!Number.isInteger(depth) || depth < 0) throw new Error(`枚数は 0 以上の整数です（${depth}）`);
    this.depth = depth;
  }

  get size(): number {
    return this.pending.length;
  }

  get counters(): InFlightStats {
    return { ...this.stats };
  }

  /**
   * 1 枚投げる。上限を超えていたら**いちばん古いもの**を待つ。
   * 返り値は「待ったかどうか」で、呼ぶ側が時計を分けて付けられるようにしてある。
   */
  async push(promise: Promise<unknown>): Promise<boolean> {
    this.stats.submitted += 1;
    // 受け皿は投げた瞬間に付ける。`await` するまでの間に落ちても拾える。
    this.pending.push(
      Promise.resolve(promise).then(
        () => undefined,
        (error: unknown) => {
          if (!this.failed) {
            this.failed = true;
            this.failure = error;
          }
        },
      ),
    );
    if (this.pending.length > this.stats.maxInFlight) this.stats.maxInFlight = this.pending.length;
    if (this.pending.length <= this.depth) {
      this.throwIfFailed();
      return false;
    }
    this.stats.waits += 1;
    await this.pending.shift();
    this.throwIfFailed();
    return true;
  }

  /** 残りを全部待つ。輪を抜けたら**必ず**呼ぶこと（呼ばないと仕上げに紛れ込む）。 */
  async drain(): Promise<void> {
    while (this.pending.length > 0) await this.pending.shift();
    this.throwIfFailed();
  }

  private throwIfFailed(): void {
    if (!this.failed) return;
    const error = this.failure;
    this.failed = false;
    this.failure = null;
    throw error instanceof Error ? error : new Error(String(error));
  }
}

/**
 * 2 段を重ねたときの 1 コマあたりの時間（上限）。単位は呼ぶ側と同じ。
 *
 * 定常状態では**遅いほうの段**が律速するので `max(a, b)`。
 * `cost.ts` の `projectOverlap` は取り分（割合）から倍率を出すが、
 * こちらは**ミリ秒のまま**扱えるので、段の時計をそのまま入れて読める。
 *
 * `depth` を取るのは、**0 枚のときは重ならない**（足し算のまま）ことを
 * 式の側にも書いておきたいため。1 枚以上あれば上限は変わらない——
 * それが「1 で足りる」の根拠で、測った結果もそうなった。
 */
export function overlappedFrameMs(decodeMs: number, encodeMs: number, depth: number): number {
  if (decodeMs < 0 || encodeMs < 0) throw new Error('段の時間は 0 以上です');
  if (depth <= 0) return decodeMs + encodeMs;
  return Math.max(decodeMs, encodeMs);
}
