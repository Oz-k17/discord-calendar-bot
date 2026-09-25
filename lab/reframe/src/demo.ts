/**
 * 自動リフレームの画面。
 *
 * ここは「読む・見せる」だけを受け持ち、判断はすべて純粋な関数
 * （`columns.ts` / `reframe.ts`）に任せている。本体へ持っていくときに要るのはそちらだけで、
 * このファイルは捨ててよい。
 *
 * **画面で判定をやり直さない。** シーン検出・拍の画面と同じ決め事で、`planReframe` を呼ぶ所を
 * 1 つに絞り、描画もプレビューも統計も、その 1 回の結果だけを見る。こうしておくと
 * `uitest.mjs` が「画面の枠」と「コマンドラインの枠」を同じ物差しで突き合わせられる。
 *
 * ## 読み込みは `scene-cut` のものを借りている
 *
 * `scene-cut/src/decode.ts` は**判断を置かない部品**（本物の動画 → `ImageData` の列）で、
 * 判定の側には何も混ざらない。リフレーム用にもう 1 本書くと、
 * 直すときに 2 か所直すことになるだけなので借りている。
 * `FrameLike` は両方とも `{ width, height, data }` なので、そのまま渡せる。
 *
 * ## 絵のほうは読み直さない（2026-09-25 に画面を作って分かったこと）
 *
 * 表紙の画面（`thumbnail`）では「測るコマ（長辺 128）」と「出す絵（実寸）」で
 * **読み込みが 2 本要った**。こちらは要らない——出口が 1 枚の絵ではなく
 * **枠の列**（`toCropRects`）なので、絵は元の動画を横へずらして覗くだけで足りる。
 * つまり縮めたコマは測るためだけに使い、人が見るほうは `<video>` がそのまま持っている。
 * **出口が「値」なのか「絵」なのかで、画面に要る読み込みの数が変わる。**
 */

import { decodeVideoFrames, type DecodedClip } from '../../scene-cut/src/decode.ts';
import type { ColumnStat } from './columns.ts';
import {
  DEFAULT_REFRAME,
  REFRAME_ANALYSIS_FPS,
  planReframe,
  summarizeForReframe,
  toCropRects,
  type ReframeOptions,
  type ReframePlan,
} from './reframe.ts';
import { runSelfTest } from './selftest.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

interface Loaded {
  name: string;
  clip: DecodedClip;
  /** 列へ畳んだもの。**畳み方（`rowBand`）はつまみなので、そこが動いたら畳み直す。** */
  cols: ColumnStat[];
  band: number;
  /** プレビュー用に持っておく元のファイル（`<video>` へ渡す）。 */
  url: string;
}

let loaded: Loaded | null = null;
/** いまの設定で出した計画。**この 1 つだけを全部が見る。** */
let plan: ReframePlan | null = null;
/** 読み込みの順番待ち。シーン検出の画面と同じ理由（途中でつまみを回しても取りこぼさない）。 */
let chain: Promise<void> = Promise.resolve();
let loading = false;

function queueLoad(file: Blob & { name?: string }) {
  chain = chain.then(() => load(file)).catch(() => undefined);
}

// ---------- 読み込み ----------

$<HTMLInputElement>('rf-file').addEventListener('change', (event) => {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (file) queueLoad(file);
});

async function load(file: Blob & { name?: string }) {
  const status = $<HTMLParagraphElement>('rf-status');
  loading = true;
  status.className = 'status';
  status.textContent = `${file.name ?? '素材'} を読み込んでいます…`;
  try {
    const clip = await decodeVideoFrames(file, {
      fps: Number($<HTMLInputElement>('fps').value),
      onProgress: (ratio) => {
        status.textContent = `${file.name ?? '素材'} を読み込んでいます… ${Math.round(ratio * 100)}%`;
      },
    });
    if (loaded) URL.revokeObjectURL(loaded.url);
    const band = Number($<HTMLInputElement>('row-band').value);
    loaded = {
      name: file.name ?? '素材',
      clip,
      cols: summarizeForReframe(clip.frames, clip.times, bandOption(band)),
      band,
      url: URL.createObjectURL(file),
    };
    status.textContent =
      `${loaded.name} ・ ${clip.duration.toFixed(2)} 秒 ・ ${clip.width}×${clip.height} ・ ` +
      `素材 ${clip.sourceFps.toFixed(1)}fps → 解析 ${clip.fps.toFixed(1)}fps（${clip.frames.length} コマ）`;
    attachPreview(loaded);
    refresh();
  } catch (e) {
    loaded = null;
    plan = null;
    status.className = 'status error';
    status.textContent = `この動画は、このブラウザでは読めませんでした（${e instanceof Error ? e.message : e}）`;
    draw();
    showStats();
  } finally {
    loading = false;
  }
}

// ---------- 判定（呼ぶのはここ 1 か所だけ） ----------

function bandOption(half: number): Partial<ReframeOptions> {
  // 0 は「上下を落とさない」。`{ from: 0, to: 1 }` がそのまま全部を見る形なので、
  // ここで場合分けは要らない（潰れた帯にならないよう 0.45 で頭打ちにしてある）。
  const h = Math.min(0.45, Math.max(0, half));
  return { rowBand: { from: h, to: 1 - h } };
}

function currentOptions(): Partial<ReframeOptions> {
  return {
    cropWidth: Number($<HTMLInputElement>('crop-width').value),
    deadband: Number($<HTMLInputElement>('deadband').value),
    settle: Number($<HTMLInputElement>('settle').value),
    maxSpeed: Number($<HTMLInputElement>('max-speed').value),
    smooth: Number($<HTMLInputElement>('smooth').value),
    leadIn: $<HTMLInputElement>('lead-in').checked,
    ...bandOption(Number($<HTMLInputElement>('row-band').value)),
  };
}

/**
 * 畳み方が変わったときだけ畳み直す。
 *
 * 列へ畳むのはコマ 1 枚ずつ全画素を舐めるので、195 コマでも目に見えて重い。
 * **`rowBand` 以外のつまみは畳んだあとの話**なので、そこでは畳み直さない。
 */
function refresh() {
  if (!loaded) return;
  const band = Number($<HTMLInputElement>('row-band').value);
  if (band !== loaded.band) {
    loaded.cols = summarizeForReframe(loaded.clip.frames, loaded.clip.times, bandOption(band));
    loaded.band = band;
  }
  plan = planReframe(loaded.cols, currentOptions());
  draw();
  showStats();
  layoutPreview();
  syncPreview();
}

// ---------- 描画 ----------

/** キャンバスを画面の実寸に合わせる（ぼやけ防止）。他の画面と同じ形。 */
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

/**
 * 時間 × 画面の横位置で、枠の動きを描く。
 *
 * **縦を「画面の横位置」にしてあるのは、見たいものが位置そのものだから。**
 * 距離や点数のグラフにすると、「枠がどこに居たか」を数字から思い描く手間が要る。
 * 生の位置・ならしたあと・枠の帯を同じ面に重ねると、
 * **どこで遅れ、どこで置いていかれたか**がそのまま形に出る。
 */
function draw() {
  const canvas = $<HTMLCanvasElement>('rf-canvas');
  const ctx = fit(canvas);
  if (!ctx) return;
  const width = canvas.clientWidth || 800;
  const height = Number(canvas.dataset.height) || 160;
  ctx.clearRect(0, 0, width, height);
  if (!loaded || !plan || !plan.frames.length) return;

  const duration = loaded.clip.duration || loaded.clip.frames.length / loaded.clip.fps;
  const toX = (t: number) => (t / Math.max(duration, 1e-6)) * width;
  const pad = 8;
  const toY = (u: number) => pad + u * (height - pad * 2);
  const half = plan.options.cropWidth / 2;

  // --- 枠の帯（窓の左端〜右端）。いちばん下に敷く ---
  ctx.fillStyle = 'rgba(183, 208, 168, 0.22)';
  ctx.beginPath();
  ctx.moveTo(toX(plan.frames[0].time), toY(plan.frames[0].center - half));
  for (const f of plan.frames) ctx.lineTo(toX(f.time), toY(f.center - half));
  for (let i = plan.frames.length - 1; i >= 0; i -= 1) {
    ctx.lineTo(toX(plan.frames[i].time), toY(plan.frames[i].center + half));
  }
  ctx.closePath();
  ctx.fill();

  // --- 枠が動いている区間。床に帯で出す（「いつ動いたか」は数より形で読みたい） ---
  ctx.fillStyle = 'rgba(164, 112, 122, 0.85)';
  for (let i = 1; i < plan.frames.length; i += 1) {
    if (Math.abs(plan.frames[i].center - plan.frames[i - 1].center) <= 0) continue;
    const x = toX(plan.frames[i - 1].time);
    ctx.fillRect(x, height - 5, Math.max(1, toX(plan.frames[i].time) - x), 4);
  }

  // --- 生の位置（その手が指した所）。点で出す ---
  //
  // **生の位置とならしたあとを両方描くのがこの画面の肝。** 枠が遅れているとき、
  // 原因が「生の位置が荒れている」のか「ならしが追い付いていない」のかは、
  // 片方だけ描いても読めない（それに気づいて `ReframeFrame.raw` を足した）。
  ctx.fillStyle = 'rgba(154, 183, 216, 0.5)';
  for (const f of plan.frames) ctx.fillRect(toX(f.time) - 1, toY(f.raw) - 1, 2, 2);

  // --- ならしたあと（中央値） ---
  ctx.strokeStyle = 'rgba(216, 184, 122, 0.45)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  plan.frames.forEach((f, i) => {
    const x = toX(f.time);
    const y = toY(f.target);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  // --- 枠の中心 ---
  ctx.strokeStyle = '#d8b87a';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  plan.frames.forEach((f, i) => {
    const x = toX(f.time);
    const y = toY(f.center);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  // --- いま見ている時刻 ---
  const video = $<HTMLVideoElement>('rf-video');
  if (video.readyState > 0) {
    ctx.strokeStyle = 'rgba(232, 233, 234, 0.5)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.round(toX(video.currentTime)) + 0.5, 0);
    ctx.lineTo(Math.round(toX(video.currentTime)) + 0.5, height);
    ctx.stroke();
  }
}

// ---------- 出来上がりのプレビュー ----------

/**
 * 枠の列から、その秒の中心を読む。
 *
 * コマの間は**線で繋ぐ**。15fps で測って 30fps の動画を見せると、繋がないと
 * 枠が 2 コマに 1 回だけ動いて見える（実際には 0.0147 ずつ滑らかに寄っている）。
 */
export function centerAt(frames: { time: number; center: number }[], t: number): number {
  if (!frames.length) return 0.5;
  if (t <= frames[0].time) return frames[0].center;
  const last = frames[frames.length - 1];
  if (t >= last.time) return last.center;
  // 時刻は等間隔なので、割り算で当たりを付けてから 1 つずつ確かめる
  // （素材の速さの見積もりが甘い入れ物では、等間隔が崩れることがある）。
  let i = Math.min(frames.length - 2, Math.max(0, Math.floor((t - frames[0].time) / Math.max(1e-9, frames[1].time - frames[0].time))));
  while (i > 0 && frames[i].time > t) i -= 1;
  while (i < frames.length - 2 && frames[i + 1].time <= t) i += 1;
  const a = frames[i];
  const b = frames[i + 1];
  const k = (t - a.time) / Math.max(1e-9, b.time - a.time);
  return a.center + (b.center - a.center) * k;
}

function attachPreview(l: Loaded) {
  for (const id of ['rf-video', 'rf-video-out']) {
    const v = $<HTMLVideoElement>(id);
    v.src = l.url;
    v.load();
  }
  const seek = $<HTMLInputElement>('rf-seek');
  seek.max = String(l.clip.duration || 1);
  seek.value = '0';
  seek.disabled = false;
  $<HTMLButtonElement>('rf-play').disabled = false;
}

/** 覗き窓の大きさを、いまの窓の幅から決める。 */
function layoutPreview() {
  if (!loaded || !plan) return;
  const crop = $<HTMLDivElement>('rf-crop');
  const out = $<HTMLVideoElement>('rf-video-out');
  const aspect = loaded.clip.width / Math.max(1, loaded.clip.height);
  const height = crop.clientHeight || 320;
  // 出来上がりの形は「もとの形 × 窓の幅」。16:9 を 31.6% で切ると 9:16 になる。
  crop.style.width = `${height * aspect * plan.options.cropWidth}px`;
  out.style.width = `${height * aspect}px`;
  out.style.height = `${height}px`;
}

/** いまの時刻の枠を、元の画の上と出来上がりの側の両方へ反映する。 */
function syncPreview() {
  if (!loaded || !plan) return;
  const video = $<HTMLVideoElement>('rf-video');
  const t = video.currentTime;
  const center = centerAt(plan.frames, t);
  const w = plan.options.cropWidth;

  // 元の画に重ねる窓は、割合のまま置ける。
  const win = $<HTMLDivElement>('rf-window');
  win.style.left = `${(center - w / 2) * 100}%`;
  win.style.width = `${w * 100}%`;

  // 出来上がりの側は、動画そのものを横へずらす。
  const out = $<HTMLVideoElement>('rf-video-out');
  out.style.transform = `translateX(${-(center - w / 2) * (out.clientWidth || 0)}px)`;
  $<HTMLOutputElement>('out-time').textContent = `${t.toFixed(2)}s`;
}

/**
 * 2 本の `<video>` の時刻を揃える。
 *
 * **1 本にして左右へ 2 回描く**手もあるが、それには毎コマ canvas へ写す必要がある。
 * `<video>` を 2 本置いて片方を親にするほうが、ブラウザの再生に任せられて軽い。
 * ずれるのは再生の頭くらいなので、そこだけ合わせ直す。
 */
let shownTime = -1;
function followMaster() {
  const master = $<HTMLVideoElement>('rf-video');
  const slave = $<HTMLVideoElement>('rf-video-out');
  if (Math.abs(slave.currentTime - master.currentTime) > 0.08) slave.currentTime = master.currentTime;
  if (master.paused !== slave.paused) {
    if (master.paused) slave.pause();
    else void slave.play();
  }
  // **時刻が動いたときだけ描き直す。** 毎コマ描き直すと、止めているあいだも
  // 195 コマぶんの線を引き続けることになる（画は 1 ミリも変わらないのに）。
  if (master.currentTime !== shownTime) {
    shownTime = master.currentTime;
    syncPreview();
    $<HTMLInputElement>('rf-seek').value = String(master.currentTime);
    draw();
  }
  requestAnimationFrame(followMaster);
}
requestAnimationFrame(followMaster);

$<HTMLButtonElement>('rf-play').addEventListener('click', () => {
  const video = $<HTMLVideoElement>('rf-video');
  if (video.paused) void video.play();
  else video.pause();
  $<HTMLButtonElement>('rf-play').textContent = video.paused ? '再生' : '一時停止';
});

$<HTMLInputElement>('rf-seek').addEventListener('input', () => {
  const t = Number($<HTMLInputElement>('rf-seek').value);
  $<HTMLVideoElement>('rf-video').currentTime = t;
  $<HTMLVideoElement>('rf-video-out').currentTime = t;
});

// ---------- 統計 ----------

function stat(term: string, value: string, none = false) {
  return `<div><dt>${term}</dt><dd${none ? ' class="none"' : ''}>${value}</dd></div>`;
}

function showStats() {
  const box = $<HTMLDListElement>('rf-stats');
  const warn = $<HTMLParagraphElement>('rf-warning');
  if (!loaded || !plan || !plan.frames.length) {
    box.innerHTML = '';
    warn.hidden = true;
    return;
  }

  const seconds = plan.frames[plan.frames.length - 1].time - plan.frames[0].time;
  const centers = plan.frames.map((f) => f.center);
  let runs = 0;
  let open = false;
  for (let i = 1; i < centers.length; i += 1) {
    const moved = Math.abs(centers[i] - centers[i - 1]) > 0;
    if (moved && !open) runs += 1;
    open = moved;
  }
  const rect = toCropRects(plan)[0];

  box.innerHTML = [
    stat('読んだコマ', `${loaded.clip.frames.length} 枚`),
    stat('解析の速さ', `${loaded.clip.fps.toFixed(1)} fps`),
    stat('素材の速さ', `${loaded.clip.sourceFps.toFixed(1)} fps`),
    stat('窓の幅', `${(plan.options.cropWidth * 100).toFixed(1)}%`),
    stat('泳いだ量', `${(seconds > 0 ? plan.travel / seconds : 0).toFixed(3)} / 秒`),
    stat('動いた回数', `${runs} 回`, runs === 0),
    stat('枠の振れ幅', `${(Math.max(...centers) - Math.min(...centers)).toFixed(3)}`),
    stat('頭の置き所', `x ${rect.x.toFixed(3)}`),
  ].join('');

  // 知らせるのは「そのまま読むと数字が変わる」ときだけ。
  const messages: string[] = [];
  if (loaded.clip.truncated) {
    messages.push(
      `<strong>尺が長いので途中まで（${loaded.clip.frames.length} コマ）で切りました。</strong>` +
        'この先の枠は出てきません。',
    );
  }
  if (plan.options.cropWidth >= 1) {
    messages.push('<strong>窓が画面と同じ幅です。</strong>切る余りが無いので、枠は真ん中で止まります。');
  }
  // **泳ぎは「多い」ではなく「動く理由が無いのに動いた」が問題。** 数だけ出すと読めないので、
  // 測った台（被写体の居ない素材の中央値 0.006 / 秒）と並べて出す。
  const swim = seconds > 0 ? plan.travel / seconds : 0;
  if (swim > 0.1) {
    messages.push(
      `<strong>枠が 1 秒あたり ${swim.toFixed(3)} 泳いでいます。</strong>` +
        '被写体の居ない素材で測った中央値は 0.006 / 秒で、0.1 を超えるのは' +
        '<strong>カメラが動いている素材</strong>（パン・チルト）です。そこはまだ空いている穴です。',
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
  showValue('fps', 'out-fps', (v) => `${v} fps`);
  showValue('crop-width', 'out-crop', (v) => `${(v * 100).toFixed(1)}%`);
  showValue('deadband', 'out-dead', (v) => `${(v * 100).toFixed(1)}%`);
  showValue('settle', 'out-settle', (v) => `${v.toFixed(2)} 秒`);
  showValue('max-speed', 'out-speed', (v) => `${(v * 100).toFixed(0)}% / 秒`);
  showValue('smooth', 'out-smooth', (v) => `${v.toFixed(2)} 秒（${Math.max(1, Math.round(v * currentFps()))} コマ）`);
  showValue('row-band', 'out-band', (v) => (v > 0 ? `上下 ${(v * 100).toFixed(0)}% を見ない` : '全部見る'));
}

/** いま何 fps で測っているか。**コマ数を秒でも見せる**ために要る（シーン検出の画面と同じ）。 */
function currentFps(): number {
  return loaded?.clip.fps ?? Number($<HTMLInputElement>('fps').value) ?? REFRAME_ANALYSIS_FPS;
}

for (const id of ['crop-width', 'deadband', 'settle', 'max-speed', 'smooth', 'row-band']) {
  $<HTMLElement>(id).addEventListener('input', () => {
    showAllValues();
    refresh();
  });
}
$<HTMLElement>('lead-in').addEventListener('change', refresh);

// コマの速さは**何を読むか**の話なので、こちらだけは読み直しになる。
$<HTMLElement>('fps').addEventListener('change', () => {
  showAllValues();
  const file = $<HTMLInputElement>('rf-file').files?.[0];
  if (file) queueLoad(file);
});
$<HTMLElement>('fps').addEventListener('input', showAllValues);

$<HTMLButtonElement>('run-tests').addEventListener('click', () => {
  const results = runSelfTest();
  $<HTMLUListElement>('test-results').innerHTML = results
    .map(
      (r) =>
        `<li class="${r.ok ? 'pass' : 'fail'}"><b>${r.ok ? 'PASS' : 'FAIL'}</b><span>${r.name}</span><span>${r.detail}</span></li>`,
    )
    .join('');
});

window.addEventListener('resize', () => {
  draw();
  layoutPreview();
  syncPreview();
});

// 既定は判定の側（`reframe.ts` / `decode.ts`）が持っている。**画面に直書きしたままにすると黙って食い違う**ので、
// 起動時にそちらから写す（HTML に書いてある値は、この行が動く前の見た目のため）。
$<HTMLInputElement>('crop-width').value = String(DEFAULT_REFRAME.cropWidth);
$<HTMLInputElement>('deadband').value = String(DEFAULT_REFRAME.deadband);
$<HTMLInputElement>('settle').value = String(DEFAULT_REFRAME.settle);
$<HTMLInputElement>('max-speed').value = String(DEFAULT_REFRAME.maxSpeed);
$<HTMLInputElement>('smooth').value = String(DEFAULT_REFRAME.smooth);
$<HTMLInputElement>('row-band').value = String(DEFAULT_REFRAME.rowBand.from);
$<HTMLInputElement>('lead-in').checked = DEFAULT_REFRAME.leadIn;
$<HTMLInputElement>('fps').value = String(REFRAME_ANALYSIS_FPS);
showAllValues();

// Playwright から呼べるようにしておく（画面を触らずに中身を確かめるため）。
declare global {
  interface Window {
    __labReframe: {
      selfTest: typeof runSelfTest;
      /** 画面が使っている既定（コマンドラインと同じ所から来ているかの確認用）。 */
      defaults: { reframe: ReframeOptions; analysisFps: number };
      /** その秒の中心（プレビューが見ているのと同じ値）。 */
      centerAt: (t: number) => number;
      /**
       * その秒のコマの、列ごとの明るさ（32 列）。
       *
       * **画面に映っている絵が本当に枠の所か**を確かめるために置いてある。
       * 枠の数字が合っていても、ずらす向きを間違えていれば人が見る絵は別の所になる。
       */
      columnLuma: (t: number) => number[];
      state: () => {
        /** 読み込みの最中か。**数字を読む前にこれが false であることを確かめる。** */
        loading: boolean;
        duration: number | null;
        frames: number;
        width: number | null;
        height: number | null;
        sourceFps: number | null;
        fps: number | null;
        missing: number;
        truncated: boolean;
        /** コマごとの時刻と枠の中心。`bench.mjs` と同じ物差しに載せるため。 */
        times: number[];
        centers: number[];
        /** 生の位置（ならす前）。画面が「荒れ」を測るのに使う。 */
        raws: number[];
        /** ならしたあと。 */
        targets: number[];
        cropWidth: number;
        travel: number;
      };
    };
  }
}
window.__labReframe = {
  selfTest: runSelfTest,
  defaults: { reframe: DEFAULT_REFRAME, analysisFps: REFRAME_ANALYSIS_FPS },
  centerAt: (t: number) => centerAt(plan?.frames ?? [], t),
  columnLuma: (t: number) => {
    if (!loaded || !loaded.cols.length) return [];
    let best = 0;
    for (let i = 1; i < loaded.cols.length; i += 1) {
      if (Math.abs(loaded.cols[i].time - t) < Math.abs(loaded.cols[best].time - t)) best = i;
    }
    return [...loaded.cols[best].luma];
  },
  state: () => ({
    loading,
    duration: loaded?.clip.duration ?? null,
    frames: loaded?.clip.frames.length ?? 0,
    width: loaded?.clip.width ?? null,
    height: loaded?.clip.height ?? null,
    sourceFps: loaded?.clip.sourceFps ?? null,
    fps: loaded?.clip.fps ?? null,
    missing: loaded?.clip.missing ?? 0,
    truncated: loaded?.clip.truncated ?? false,
    times: plan?.frames.map((f) => f.time) ?? [],
    centers: plan?.frames.map((f) => f.center) ?? [],
    raws: plan?.frames.map((f) => f.raw) ?? [],
    targets: plan?.frames.map((f) => f.target) ?? [],
    cropWidth: plan?.options.cropWidth ?? DEFAULT_REFRAME.cropWidth,
    travel: plan?.travel ?? 0,
  }),
};
