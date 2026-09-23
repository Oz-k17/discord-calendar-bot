/**
 * 表紙の候補の画面。
 *
 * ここは「読む・見せる・書き出す」だけを受け持ち、判断はすべて純粋な関数
 * （`thumb.ts` / `pick.ts`）に任せている。本体へ持っていくときに要るのはそちらだけで、
 * このファイルは捨ててよい。読み込み（`scene-cut/src/decode.ts`）と
 * 書き出し（`export.ts`）だけは中間で、**判断はしないがブラウザが要る**ので分けてある。
 *
 * **画面で判定をやり直さない。** シーン検出・拍の画面と同じ決め事で、
 * `pickThumbnails` を呼ぶ所を 1 つに絞り、描画も一覧も統計も、その 1 回の結果だけを見る。
 * こうしておくと `uitest.mjs` が「画面の候補」と「コマンドラインの候補」を
 * そのまま突き合わせられる（食い違ったら配線が切れている、と読める）。
 *
 * ## 読み込みが 2 本あるのは、間違いではない
 *
 * 選ぶために読むコマ（長辺 128・15fps）と、書き出す絵（素材の大きさ・選んだ数枚だけ）は
 * **別物**。理由は `export.ts` の頭に書いた。画面を作るまで、この 2 本が要ることに
 * 気づいていなかった（コマンドラインの測定は絵を出さないので、ずっと 1 本で足りていた）。
 */

import { summarizeFrames, type FrameStat } from '../../scene-cut/src/frames.ts';
import { ANALYSIS_FPS, decodeVideoFrames, type DecodedClip } from '../../scene-cut/src/decode.ts';
import { summarizeThumbs, type ThumbStat } from './thumb.ts';
import { DEFAULT_PICK, exposureScore, flashScore, pickThumbnails, sharpnessSeries, type PickOptions, type ThumbPick } from './pick.ts';
import {
  DEFAULT_EXPORT_FORMAT,
  DEFAULT_JPEG_QUALITY,
  EXPORT_FORMATS,
  EXPORT_LONG_SIDE,
  JPEG_QUALITY_MAX,
  JPEG_QUALITY_MIN,
  clampQuality,
  decodeFramesAt,
  exportName,
  frameToImage,
  saveBlob,
  type ExportFormat,
  type ExportedFrame,
} from './export.ts';
import { runSelfTest } from './selftest.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

interface Loaded {
  name: string;
  file: Blob;
  clip: DecodedClip;
  stats: ThumbStat[];
  frameStats: FrameStat[];
}

let loaded: Loaded | null = null;
/** いまの設定で選んだ候補。**この 1 つだけを全部が見る。** */
let picks: ThumbPick[] = [];
/**
 * 描くための点の列と、そのときの下限。**選んだときに一度だけ作る。**
 *
 * 描くたびに作り直していたのを止めた。周りと比べた明るさは 1 コマごとに周りをなめるので
 * **コマ数の 2 乗で効く**（195 コマなら気にならないが、上限の 3000 コマでは 900 万回）。
 * 窓を変えるたびに描き直されるうえ、窓の大きさを変えると画面ごと描き直す。
 * それに、選ぶときと描くときで別々に作ると、**式を片方だけ直したときに黙って食い違う。**
 */
let series: { scores: number[]; mid: number; floor: number } | null = null;
/**
 * 書き出す大きさで読み直したコマ。鍵はコマ番号。
 *
 * つまみを回すたびに読み直すと、**デコーダを開いては閉じる**ことになって目に見えて重い
 * （端末ごとに同時に持てる数も決まっている）。選んだコマが変わったときだけ、
 * まだ持っていないぶんを読み足す。
 */
const exported = new Map<number, ExportedFrame>();
let exporting = false;

/**
 * 書き出したときの大きさ（バイト）。鍵は「コマ番号・形式・品質」。
 *
 * **押す前に見せる。** PNG は実寸（1920×1080）で 0.85〜1.5MB まで来るので、
 * 置き先の上限（配信サイトはだいたい 2MB）に当たるかどうかは**押したあとでは遅い**。
 * 形式を選ぶ画面で大きさが見えないと、選ぶ材料が画面に無いことになる。
 * 焼いて `size` だけ読んで捨てる（絵は保存のときに焼き直す。持っておくほうが高くつく）。
 */
const sizes = new Map<string, number>();
const sizeKey = (index: number, format: ExportFormat, quality: number) =>
  `${index}:${format}:${format === 'png' ? '—' : quality.toFixed(2)}`;
let measuringSizes = false;

/**
 * 読み込みと書き出しの順番待ち。
 *
 * シーン検出の画面と同じ作りだが、こちらは**書き出しの読み直しも同じ列に並べる**。
 * デコーダを 2 本同時に開くと、端末によっては後から開いたほうが静かに失敗する。
 */
let chain: Promise<void> = Promise.resolve();
let loading = false;

function queue(task: () => Promise<void>) {
  chain = chain.then(task).catch(() => undefined);
}

// ---------- 読み込み ----------

$<HTMLInputElement>('thumb-file').addEventListener('change', (event) => {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (file) queue(() => load(file));
});

async function load(file: Blob & { name?: string }) {
  const status = $<HTMLParagraphElement>('thumb-status');
  loading = true;
  exported.clear();
  sizes.clear();
  status.className = 'status';
  status.textContent = `${file.name ?? '素材'} を読み込んでいます…`;
  try {
    const clip = await decodeVideoFrames(file, {
      onProgress: (ratio) => {
        status.textContent = `${file.name ?? '素材'} を読み込んでいます… ${Math.round(ratio * 100)}%`;
      },
    });
    // コマを測る所は読み込みと同じ 1 回だけ。つまみを回しても**コマは変わらない**ので、
    // 測り直す理由も無い（195 コマでも `summarizeThumbs` は目に見えて重い）。
    loaded = {
      name: file.name ?? '素材',
      file,
      clip,
      stats: summarizeThumbs(clip.frames, clip.times),
      frameStats: summarizeFrames(clip.frames, clip.times),
    };
    status.textContent =
      `${loaded.name} ・ ${clip.duration.toFixed(2)} 秒 ・ ${clip.width}×${clip.height} ・ ` +
      `素材 ${clip.sourceFps.toFixed(1)}fps → 解析 ${clip.fps.toFixed(1)}fps（${clip.frames.length} コマ）`;
    refresh();
  } catch (e) {
    loaded = null;
    picks = [];
    series = null;
    status.className = 'status error';
    status.textContent = `この動画は、このブラウザでは読めませんでした（${e instanceof Error ? e.message : e}）`;
    draw();
    showStats();
    showPicks();
  } finally {
    loading = false;
  }
}

// ---------- 判定（呼ぶのはここ 1 か所だけ） ----------

function currentOptions(): Partial<PickOptions> {
  return {
    sharpness: $<HTMLSelectElement>('sharpness').value as PickOptions['sharpness'],
    count: Number($<HTMLInputElement>('count').value),
    minGap: Number($<HTMLInputElement>('min-gap').value),
    minDistance: Number($<HTMLInputElement>('min-distance').value),
    qualityFloor: Number($<HTMLInputElement>('quality-floor').value),
    floorBase: $<HTMLSelectElement>('floor-base').value as PickOptions['floorBase'],
    flashHigh: Number($<HTMLInputElement>('flash-high').value),
    flashWindow: Number($<HTMLInputElement>('flash-window').value),
    fill: $<HTMLInputElement>('fill').checked,
  };
}

/**
 * いまの書き出しの設定。**既定は `export.ts` が持っている**（画面に直書きしない）。
 */
function currentExport(): { format: ExportFormat; quality: number } {
  const format = ($<HTMLSelectElement>('export-format').value as ExportFormat) ?? DEFAULT_EXPORT_FORMAT;
  return {
    format: format in EXPORT_FORMATS ? format : DEFAULT_EXPORT_FORMAT,
    quality: clampQuality(Number($<HTMLInputElement>('jpeg-quality').value)),
  };
}

function refresh() {
  if (!loaded) return;
  const o = { ...DEFAULT_PICK, ...currentOptions() };
  // 似すぎの線を 0 にしたら、分布そのものを渡さない。**渡したうえで線を 0 にする**のと
  // 同じ答えになるが、測る手間を払わずに済む（コマンドライン側の `LAB_NODIV` と揃えてある）。
  picks = pickThumbnails(loaded.stats, o.minDistance === 0 ? null : loaded.frameStats, o);
  const scores = scoreSeries(loaded.stats, o);
  const mid = median(scores.filter((v) => v > 0)) || 1;
  let peak = 0;
  for (const v of scores) if (v > peak) peak = v;
  series = { scores, mid, floor: (o.floorBase === 'top' ? peak : mid) * o.qualityFloor };
  draw();
  showStats();
  showPicks();
  queueExports();
}

/** 選んだコマのうち、まだ大きい絵を持っていないぶんを読み足す。 */
function queueExports() {
  if (!loaded) return;
  const missing = picks.filter((p) => !exported.has(p.index));
  if (!missing.length) return;
  const file = loaded.file;
  queue(async () => {
    // 待っているあいだにつまみが動いていることがあるので、そのときの選び直しを読む。
    const want = picks.filter((p) => !exported.has(p.index));
    if (!want.length || !loaded || loaded.file !== file) return;
    exporting = true;
    showPicks();
    try {
      const frames = await decodeFramesAt(file, want.map((p) => p.time));
      // 返りは渡した秒と同じ長さ（取れなかった所は null）なので、番号で突き合わせてよい。
      for (let i = 0; i < want.length; i += 1) {
        const frame = frames[i];
        if (frame) exported.set(want[i].index, frame);
      }
    } catch {
      // 読み直せなくても画面は死なせない。測ったコマ（長辺 128）のまま見せて、
      // 「大きい絵は出せていない」と figcaption に出す。
    } finally {
      exporting = false;
      showPicks();
      showStats();
      measureSizes();
    }
  });
}

/**
 * いまの形式で、候補がそれぞれ何バイトになるかを測る。
 *
 * 読み直しと同じ列には並べない（デコーダを開かないので待たせる理由が無い）。
 * **測れたぶんから順に出す。** 3 枚ぜんぶ揃うまで黙っていると、
 * 重い素材で「大きさの欄がずっと空のまま」になり、壊れているのと区別が付かない。
 */
async function measureSizes() {
  if (!loaded || measuringSizes) return;
  const { format, quality } = currentExport();
  const want = picks.filter((p) => exported.has(p.index) && !sizes.has(sizeKey(p.index, format, quality)));
  if (!want.length) return;
  measuringSizes = true;
  try {
    for (const pick of want) {
      const frame = exported.get(pick.index);
      if (!frame) continue;
      const blob = await frameToImage(frame, { format, quality });
      sizes.set(sizeKey(pick.index, format, quality), blob.size);
      showPicks();
    }
  } catch {
    // 見積りが出せなくても画面は死なせない（保存そのものは別の道）。
  } finally {
    measuringSizes = false;
    showStats();
  }
  // 測っているあいだに形式を変えられていたら、**その形式ぶんが誰にも測られずに残る**
  // （入口で `measuringSizes` を見て帰っているので、変えた側の呼び出しは何もしていない）。
  // 絵の大きさの欄が「—」のまま固まるが、押せば出るので数字のどこにも出ない壊れ方。
  const now = currentExport();
  if (picks.some((p) => exported.has(p.index) && !sizes.has(sizeKey(p.index, now.format, now.quality)))) {
    void measureSizes();
  }
}

// ---------- 描画 ----------

function fit(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  const width = canvas.clientWidth || 800;
  const height = Number(canvas.dataset.height) || 160;
  canvas.style.height = `${height}px`;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  const ctx = canvas.getContext('2d');
  if (ctx) ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  return ctx;
}

/** 画面が描くための点の列。**`pick.ts` と同じ式**を同じ所から引いて作る。 */
function scoreSeries(stats: ThumbStat[], o: PickOptions): number[] {
  const sharp = sharpnessSeries(stats, o);
  return stats.map((s, i) => sharp[i] * exposureScore(s, o) * flashScore(stats, i, o));
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const v = values.slice().sort((a, b) => a - b);
  const half = v.length >> 1;
  return v.length % 2 ? v[half] : (v[half - 1] + v[half]) / 2;
}

/**
 * コマごとの点を柱で描き、その上に下限の線と、選んだ／飛ばしたコマを重ねる。
 *
 * **縦の上端は「ふつう（中央値）の 3 倍」で頭打ちにしてある。** シーン検出の画面と同じ理由で、
 * 素材の最大に合わせて伸ばすと、フラッシュの 1 コマが上端を決めてしまい、
 * **下限の線のまわり（ここで読みたい所）が全部つぶれる。**
 *
 * **飛ばしたコマを描いておくのがこの画面の肝。** 選んだ所だけ描くと、
 * 「なぜそこが選ばれなかったか」——出来が足りないのか、似すぎたのか——が読めない。
 */
function draw() {
  const canvas = $<HTMLCanvasElement>('thumb-canvas');
  const ctx = fit(canvas);
  if (!ctx) return;
  const width = canvas.clientWidth || 800;
  const height = Number(canvas.dataset.height) || 160;
  ctx.clearRect(0, 0, width, height);
  if (!loaded || !series) return;

  const { scores, mid, floor: floorValue } = series;

  const duration = loaded.clip.duration || loaded.clip.frames.length / loaded.clip.fps;
  const toX = (t: number) => (t / Math.max(duration, 1e-6)) * width;
  const base = height - 16;
  const top = mid * 3;
  const toY = (v: number) => base - (Math.min(v, top) / top) * (base - 10);
  const barWidth = Math.max(1, width / Math.max(1, scores.length));

  // --- コマごとの点 ---
  for (let i = 0; i < scores.length; i += 1) {
    const x = toX(loaded.stats[i].time);
    const y = toY(scores[i]);
    ctx.fillStyle = 'rgba(154, 183, 216, 0.55)';
    ctx.fillRect(x, y, barWidth, base - y);
    // 上端で切った柱の帽子。切ったことを隠すと「3 倍」と「30 倍」が同じ絵になる。
    if (scores[i] > top) {
      ctx.fillStyle = 'rgba(200, 216, 232, 0.95)';
      ctx.fillRect(x, y, barWidth, 3);
    }
  }

  // --- 出来の下限 ---
  ctx.strokeStyle = '#d8b87a';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.moveTo(0, Math.round(toY(floorValue)) + 0.5);
  ctx.lineTo(width, Math.round(toY(floorValue)) + 0.5);
  ctx.stroke();
  ctx.setLineDash([]);

  // --- 条件を緩めて入れた 1 枚（飛ばした理由が付いているもの） ---
  ctx.strokeStyle = 'rgba(164, 112, 122, 0.85)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const p of picks) {
    if (!p.relaxed) continue;
    const x = Math.round(toX(p.time)) + 0.5;
    ctx.moveTo(x, toY(scores[p.index]));
    ctx.lineTo(x, base);
  }
  ctx.stroke();

  // --- 選んだコマ ---
  ctx.strokeStyle = '#b7d0a8';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (const p of picks) {
    const x = Math.round(toX(p.time)) + 0.5;
    ctx.moveTo(x, 0);
    ctx.lineTo(x, base);
  }
  ctx.stroke();

  // --- 床（素材の尺） ---
  ctx.strokeStyle = 'rgba(232, 233, 234, 0.25)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, base + 0.5);
  ctx.lineTo(width, base + 0.5);
  ctx.stroke();
}

/** コマ 1 枚を canvas へ描く。 */
function drawFrame(canvas: HTMLCanvasElement, frame: { width: number; height: number; data: Uint8ClampedArray | Uint8Array }) {
  canvas.width = frame.width;
  canvas.height = frame.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.putImageData(new ImageData(new Uint8ClampedArray(frame.data), frame.width, frame.height), 0, 0);
}

/**
 * 置き先が受け取れる大きさの目安。
 *
 * **判定には使っていない**（画面で知らせるためだけの数）。本当の上限は置き先ごとに違うので、
 * 決め打ちの線として `export.ts` には置かない。ここに置いてあるのは、
 * 画面が知らせるときの根拠を 1 か所に集めるため。
 */
const DESTINATION_LIMIT_BYTES = 2 * 1024 * 1024;

/** バイト数を人の読む形へ。**KB / MB を混ぜない**（並べたときに大小が読めなくなる）。 */
function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(2)} MB` : `${Math.round(bytes / 1024)} KB`;
}

const WHY: Record<string, string> = {
  similar: '似た絵を避ける条件を緩めた',
  gap: '時間で離す条件を緩めた',
  quality: '出来の下限を緩めた',
};

/**
 * 選んだ候補を並べる。
 *
 * 絵は**大きいほうが読み直せていればそちら**、まだなら測ったコマ（長辺 128）を出す。
 * どちらを出しているかは必ず添える。**黙って小さい絵を出すと、
 * 「この試作は 128 画素の表紙を出す」と読まれてしまう。**
 */
function showPicks() {
  const box = $<HTMLDivElement>('thumb-picks');
  const note = $<HTMLParagraphElement>('thumb-picks-note');
  box.innerHTML = '';
  if (!loaded) {
    note.textContent = 'まだ何も読み込んでいません。';
    return;
  }
  if (!picks.length) {
    note.textContent = '条件を満たすコマがありませんでした（「条件を緩めてでも揃える」を入れると必ず何か返します）。';
    return;
  }

  const { format, quality } = currentExport();
  const relaxed = picks.filter((p) => p.relaxed).length;
  note.textContent =
    `${picks.length} 枚を選びました` +
    (relaxed ? `（うち ${relaxed} 枚は条件を緩めて入れたものです）。` : '。') +
    (exporting ? ' 素材の大きさで読み直しています…' : '');

  for (let i = 0; i < picks.length; i += 1) {
    const pick = picks[i];
    const full = exported.get(pick.index);
    const figure = document.createElement('figure');
    const canvas = document.createElement('canvas');
    drawFrame(canvas, full ?? loaded.clip.frames[pick.index]);

    const caption = document.createElement('figcaption');
    const size = full
      ? `${full.width}×${full.height}（素材の大きさ）`
      : exporting
        ? `${loaded.clip.width}×${loaded.clip.height}（測ったコマ・読み直し中）`
        : `${loaded.clip.width}×${loaded.clip.height}（測ったコマ）`;
    // **押す前に大きさを見せる。** 形式を選ばせておいて、選ぶ材料（何バイトになるか）を
    // 画面に出さないなら、選ばせている意味が無い。
    const bytes = sizes.get(sizeKey(pick.index, format, quality));
    caption.innerHTML =
      `<b>${i + 1}.</b> ${pick.time.toFixed(2)} 秒<br>` +
      `ふつうの <b>${pick.relative.toFixed(2)}</b> 倍 ・ 写り ${pick.exposure.toFixed(2)}<br>` +
      `${size}<br>` +
      `${EXPORT_FORMATS[format].ext.toUpperCase()} ${bytes === undefined ? (full ? '測っています…' : '—') : formatBytes(bytes)}` +
      (pick.relaxed ? `<br><span class="relaxed">※ ${WHY[pick.relaxed]}</span>` : '');

    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'この絵を保存';
    button.dataset.pick = String(i);
    button.addEventListener('click', () => savePick(i));
    figure.append(canvas, caption, button);
    box.append(figure);
  }
}

/**
 * 候補 1 枚を、いま選んでいる形式で保存する。
 *
 * まだ大きい絵を持っていなければ、その場で読む（つまみを回した直後に押されうる）。
 * **測ったコマで代用しない。** 長辺 128 の絵を「表紙」として渡すほうが、
 * 「まだ読めていません」と言うより害がある。
 *
 * 名前の拡張子は**形式から引く**（`exportName`）。ここを `.png` で固定したまま
 * JPEG を足すと、中身と名前が食い違った絵が落ちる——開けはするので、
 * 受け取る側が拡張子で弾くまで誰も気づかない。
 */
async function savePick(order: number) {
  const pick = picks[order];
  if (!loaded || !pick) return;
  const status = $<HTMLParagraphElement>('thumb-status');
  const { format, quality } = currentExport();
  try {
    const frame = (await fullFrame(pick)) ?? null;
    // **測ったコマで代用しない。** 長辺 128 の絵を「表紙」として渡すほうが、
    // 「出せませんでした」と言うより害がある。
    if (!frame) throw new Error('この秒のコマを読み直せませんでした');
    saveBlob(await frameToImage(frame, { format, quality }), exportName(loaded.name, pick.time, format));
  } catch (e) {
    status.className = 'status error';
    status.textContent = `絵を書き出せませんでした（${e instanceof Error ? e.message : e}）`;
  }
}

/** 候補 1 枚を、素材の大きさで取り出す（まだ持っていなければその場で読む）。 */
async function fullFrame(pick: ThumbPick): Promise<ExportedFrame | null> {
  if (!loaded) return null;
  const held = exported.get(pick.index);
  if (held) return held;
  const got = await decodeFramesAt(loaded.file, [pick.time]);
  const frame = got[0];
  if (frame) exported.set(pick.index, frame);
  return frame ?? null;
}

// ---------- 統計 ----------

function stat(term: string, value: string, none = false) {
  return `<div><dt>${term}</dt><dd${none ? ' class="none"' : ''}>${value}</dd></div>`;
}

function showStats() {
  const box = $<HTMLDListElement>('thumb-stats');
  const warn = $<HTMLParagraphElement>('thumb-warning');
  if (!loaded) {
    box.innerHTML = '';
    warn.hidden = true;
    return;
  }

  const o = { ...DEFAULT_PICK, ...currentOptions() };
  const { format: exportFormat, quality: exportQuality } = currentExport();
  const relaxed = picks.filter((p) => p.relaxed);
  const best = picks.length ? Math.max(...picks.map((p) => p.relative)) : 0;
  const full = picks.map((p) => exported.get(p.index)).find((f) => f);
  const measured = picks
    .map((p) => sizes.get(sizeKey(p.index, exportFormat, exportQuality)))
    .filter((v): v is number => v !== undefined);
  const heaviest = measured.length ? Math.max(...measured) : null;

  box.innerHTML = [
    stat('選んだ枚数', picks.length ? `${picks.length} / ${o.count} 枚` : '無し', !picks.length),
    stat('条件を緩めた枚数', relaxed.length ? `${relaxed.length} 枚` : 'なし', !relaxed.length),
    stat('いちばん良い候補', picks.length ? `ふつうの ${best.toFixed(2)} 倍` : '—', !picks.length),
    stat('読んだコマ', `${loaded.clip.frames.length} 枚`),
    stat('測る大きさ', `${loaded.clip.width}×${loaded.clip.height}`),
    stat('書き出す大きさ', full ? `${full.width}×${full.height}` : exporting ? '読み直し中' : '—', !full),
    stat('素材の速さ', `${loaded.clip.sourceFps.toFixed(1)} fps`),
    stat('コマの欠け', loaded.clip.missing ? `${loaded.clip.missing} 枚` : 'なし', !loaded.clip.missing),
    stat('書き出しの形式', exportFormat === 'png' ? 'PNG（可逆）' : `JPEG 品質 ${exportQuality.toFixed(2)}`),
    stat('いちばん重い 1 枚', heaviest === null ? '—' : formatBytes(heaviest), heaviest === null),
  ].join('');

  // 知らせるのは「そのまま読むと結果の意味が変わる」ときだけ。
  const messages: string[] = [];
  if (loaded.clip.truncated) {
    messages.push(
      `<strong>尺が長いので途中まで（${loaded.clip.frames.length} コマ）で読みました。</strong>` +
        'この先に良い絵があっても候補には出てきません。',
    );
  }
  if (relaxed.length) {
    messages.push(
      `<strong>${relaxed.length} 枚は条件を緩めて入れたものです。</strong>` +
        '素材の中に「別々の良い絵」がその枚数ぶん無かった、と読んでください（枚数を減らすと全部が本選びになります）。',
    );
  }
  if (best > 0 && best < 1.05) {
    messages.push(
      '<strong>いちばん良い候補が、ふつうのコマとほとんど変わりません。</strong>' +
        'この倍率は素材の中での順位なので、尺ぜんたいが同じ調子（ずっとボケている・ずっと暗い）だと 1 倍に張り付きます。' +
        '「選べた」ではなく「選ぶ相手が居なかった」ほうを疑ってください。',
    );
  }
  // 置き先の上限に当たりそうなら知らせる。**押したあとでは遅い**ので、ここで出す。
  // 実寸（1920×1080）の PNG は測ると 0.85〜1.5MB まで来る（`lab:thumb:format`）。
  if (heaviest !== null && heaviest > DESTINATION_LIMIT_BYTES * 0.5) {
    messages.push(
      `<strong>1 枚が ${formatBytes(heaviest)} あります。</strong>` +
        `配信サイトの一覧はだいたい ${formatBytes(DESTINATION_LIMIT_BYTES)} が上限なので、` +
        (exportFormat === 'png'
          ? 'JPEG にすると 1 割ほどの大きさになります（測った誤差は 0.2%）。'
          : '品質を下げるか、長辺の上限を下げてください。'),
    );
  }
  if (full && Math.max(full.sourceWidth, full.sourceHeight) > EXPORT_LONG_SIDE) {
    messages.push(
      `<strong>素材（${full.sourceWidth}×${full.sourceHeight}）より小さく書き出しています。</strong>` +
        `長辺 ${EXPORT_LONG_SIDE} 画素までに縮めています（表紙の行き先がそれ以上を求めないため）。`,
    );
  }
  warn.hidden = messages.length === 0;
  warn.innerHTML = messages.join('<br>');
}

// ---------- つまみの配線 ----------

function showValue(id: string, outId: string, format: (v: number) => string) {
  $<HTMLOutputElement>(outId).textContent = format(Number($<HTMLInputElement>(id).value));
}

function showAllValues() {
  showValue('count', 'out-count', (v) => `${v} 枚`);
  showValue('quality-floor', 'out-quality-floor', (v) => (v > 0 ? `${(v * 100).toFixed(0)}%` : '見ない'));
  showValue('min-distance', 'out-min-distance', (v) => (v > 0 ? v.toFixed(2) : '見ない'));
  showValue('min-gap', 'out-min-gap', (v) => (v > 0 ? `${v.toFixed(2)} 秒` : '離さない'));
  showValue('flash-high', 'out-flash-high', (v) => `${v.toFixed(2)} 倍`);
  showValue('flash-window', 'out-flash-window', (v) => `前後 ${v.toFixed(1)} 秒`);
}

for (const id of ['count', 'min-gap', 'min-distance', 'quality-floor', 'flash-high', 'flash-window']) {
  $<HTMLElement>(id).addEventListener('input', () => {
    showAllValues();
    refresh();
  });
}
for (const id of ['sharpness', 'floor-base']) $<HTMLElement>(id).addEventListener('change', refresh);
$<HTMLElement>('fill').addEventListener('change', refresh);

/**
 * 書き出しの設定は**選び直しを起こさない**。形式を変えても候補は同じコマで、
 * 変わるのは「それを何で焼くか」だけ。ここで `refresh()` を呼ぶと、
 * 形式を変えただけで読み直しの列が動き出す（重いうえに、動く理由が無い）。
 */
for (const id of ['export-format', 'jpeg-quality']) {
  $<HTMLElement>(id).addEventListener('input', () => {
    showExportValues();
    showPicks();
    showStats();
    measureSizes();
  });
}

/** JPEG のときだけ品質を触らせる。**PNG に品質のつまみがあると読まれないため。** */
function showExportValues() {
  const { format, quality } = currentExport();
  $<HTMLInputElement>('jpeg-quality').disabled = format === 'png';
  $<HTMLOutputElement>('out-jpeg-quality').textContent =
    format === 'png' ? '（可逆なので品質は無い）' : quality.toFixed(2);
}

$<HTMLButtonElement>('run-tests').addEventListener('click', () => {
  const results = runSelfTest();
  $<HTMLUListElement>('test-results').innerHTML = results
    .map(
      (r) =>
        `<li class="${r.ok ? 'pass' : 'fail'}"><b>${r.ok ? 'PASS' : 'FAIL'}</b><span>${r.name}</span><span>${r.detail}</span></li>`,
    )
    .join('');
});

window.addEventListener('resize', draw);

// 既定は判定の側（`pick.ts` / `decode.ts` / `export.ts`）が持っている。
// **画面に直書きしたままにすると黙って食い違う**ので、起動時にそちらから写す
// （HTML に書いてある値は、この行が動く前の見た目のため）。
$<HTMLSelectElement>('sharpness').value = DEFAULT_PICK.sharpness;
$<HTMLInputElement>('count').value = String(DEFAULT_PICK.count);
$<HTMLInputElement>('min-gap').value = String(DEFAULT_PICK.minGap);
$<HTMLInputElement>('min-distance').value = String(DEFAULT_PICK.minDistance);
$<HTMLInputElement>('quality-floor').value = String(DEFAULT_PICK.qualityFloor);
$<HTMLSelectElement>('floor-base').value = DEFAULT_PICK.floorBase;
$<HTMLInputElement>('flash-high').value = String(DEFAULT_PICK.flashHigh);
$<HTMLInputElement>('flash-window').value = String(DEFAULT_PICK.flashWindow);
$<HTMLInputElement>('fill').checked = DEFAULT_PICK.fill;
$<HTMLSelectElement>('export-format').value = DEFAULT_EXPORT_FORMAT;
$<HTMLInputElement>('jpeg-quality').value = String(DEFAULT_JPEG_QUALITY);
$<HTMLInputElement>('jpeg-quality').max = String(JPEG_QUALITY_MAX);
$<HTMLInputElement>('jpeg-quality').min = String(JPEG_QUALITY_MIN);
showAllValues();
showExportValues();

// Playwright から呼べるようにしておく（画面を触らずに中身を確かめるため）。
declare global {
  interface Window {
    __labThumb: {
      selfTest: typeof runSelfTest;
      /** 画面が使っている既定（コマンドラインと同じ所から来ているかの確認用）。 */
      defaults: {
        pick: PickOptions;
        analysisFps: number;
        exportLongSide: number;
        exportFormat: ExportFormat;
        jpegQuality: number;
        jpegQualityMax: number;
      };
      state: () => {
        /** 読み込みの最中か。**数字を読む前にこれが false であることを確かめる。** */
        loading: boolean;
        /** 大きい絵を読み直している最中か。 */
        exporting: boolean;
        duration: number | null;
        frames: number;
        width: number | null;
        height: number | null;
        sourceFps: number | null;
        fps: number | null;
        missing: number;
        truncated: boolean;
        picks: { time: number; index: number; relative: number; exposure: number; relaxed: string | null }[];
        /** 書き出す大きさ（読み直せた候補のぶん）。 */
        exportSizes: { width: number; height: number; sourceWidth: number; sourceHeight: number }[];
      };
      /** 選んだ候補 1 枚を PNG にして返す（保存はしない）。 */
      png: (order: number) => Promise<Blob>;
      /**
       * 選んだ候補 1 枚を、**画面がいま選んでいる形式**で返す（保存はしない）。
       *
       * `png` と分けてあるのは、書き出しの中身を確かめる検査（`compareExport`）が
       * 「どの形式でも同じ絵が出るか」を見るのに、形式を指定して呼べる口が要るため。
       */
      image: (order: number, options?: { format?: ExportFormat; quality?: number }) => Promise<Blob>;
      /** いま画面が選んでいる書き出しの設定。 */
      exportSettings: () => { format: ExportFormat; quality: number; name: string | null };
      /** 測るのに使ったコマ（長辺 128）。書き出した絵と突き合わせるために要る。 */
      analysisFrame: (order: number) => { width: number; height: number; data: Uint8ClampedArray } | null;
    };
  }
}
window.__labThumb = {
  selfTest: runSelfTest,
  defaults: {
    pick: DEFAULT_PICK,
    analysisFps: ANALYSIS_FPS,
    exportLongSide: EXPORT_LONG_SIDE,
    exportFormat: DEFAULT_EXPORT_FORMAT,
    jpegQuality: DEFAULT_JPEG_QUALITY,
    jpegQualityMax: JPEG_QUALITY_MAX,
  },
  state: () => ({
    loading,
    exporting,
    duration: loaded?.clip.duration ?? null,
    frames: loaded?.clip.frames.length ?? 0,
    width: loaded?.clip.width ?? null,
    height: loaded?.clip.height ?? null,
    sourceFps: loaded?.clip.sourceFps ?? null,
    fps: loaded?.clip.fps ?? null,
    missing: loaded?.clip.missing ?? 0,
    truncated: loaded?.clip.truncated ?? false,
    picks: picks.map((p) => ({
      time: p.time,
      index: p.index,
      relative: p.relative,
      exposure: p.exposure,
      relaxed: p.relaxed,
    })),
    exportSizes: picks
      .map((p) => exported.get(p.index))
      .filter((f): f is ExportedFrame => !!f)
      .map((f) => ({ width: f.width, height: f.height, sourceWidth: f.sourceWidth, sourceHeight: f.sourceHeight })),
  }),
  png: async (order: number) => {
    const pick = picks[order];
    if (!loaded || !pick) throw new Error(`候補 ${order} はありません`);
    const frame = await fullFrame(pick);
    if (!frame) throw new Error('絵を読み直せませんでした');
    return frameToImage(frame, { format: 'png' });
  },
  image: async (order: number, options = {}) => {
    const pick = picks[order];
    if (!loaded || !pick) throw new Error(`候補 ${order} はありません`);
    const frame = await fullFrame(pick);
    if (!frame) throw new Error('絵を読み直せませんでした');
    const current = currentExport();
    return frameToImage(frame, { format: options.format ?? current.format, quality: options.quality ?? current.quality });
  },
  exportSettings: () => {
    const { format, quality } = currentExport();
    return { format, quality, name: picks.length && loaded ? exportName(loaded.name, picks[0].time, format) : null };
  },
  analysisFrame: (order: number) => {
    const pick = picks[order];
    if (!loaded || !pick) return null;
    const frame = loaded.clip.frames[pick.index];
    return { width: frame.width, height: frame.height, data: new Uint8ClampedArray(frame.data) };
  },
};
