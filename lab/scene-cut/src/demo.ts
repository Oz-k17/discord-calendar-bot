/**
 * シーン検出の画面。
 *
 * ここは「読む・見せる」だけを受け持ち、判断はすべて純粋な関数
 * （`frames.ts` / `scene.ts`）に任せている。本体へ持っていくときに要るのはそちらだけで、
 * このファイルは捨ててよい。読み込み（`decode.ts`）だけは中間で、
 * **判断はしないがブラウザが要る**ので分けてある。
 *
 * **画面で判定をやり直さない。** 拍の画面（`beat/src/demo.ts`）と同じ決め事で、
 * `planSceneCut` を呼ぶ所を 1 つに絞り、描画も一覧も統計も、その 1 回の結果だけを見る。
 * こうしておくと `uitest.mjs` が「画面の切り所」と「コマンドラインの切り所」を
 * そのまま突き合わせられる（食い違ったら配線が切れている、と読める）。
 */

import { summarizeFrames, type FrameLike, type FrameStat } from './frames.ts';
import { ANALYSIS_FPS, decodeVideoFrames, type DecodedClip } from './decode.ts';
import { DEFAULT_SCENE_CUT, planSceneCut, type ScenePlan, type SceneCutOptions } from './scene.ts';
import { runSelfTest } from './selftest.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

interface Loaded {
  name: string;
  clip: DecodedClip;
  stats: FrameStat[];
}

let loaded: Loaded | null = null;
/** いまの設定で出した計画。**この 1 つだけを全部が見る。** */
let plan: ScenePlan | null = null;
/**
 * 読み込みの順番待ち。大きな動画では数秒かかるので、その間に来た注文を捨てない。
 *
 * **最初は「読み込み中なら無視する」にしていて、それが穴だった。**
 * コマの速さのつまみを回すと読み直しになるが、前の読み込みが終わる前に回すと
 * **黙って何も起きない**（画面は前の速さのままなのに、つまみだけが動いている）。
 * 順番に流す形なら、最後に回した所へ必ず追いつく。
 */
let chain: Promise<void> = Promise.resolve();
let loading = false;

function queueLoad(file: Blob & { name?: string }) {
  chain = chain.then(() => load(file)).catch(() => undefined);
}

// ---------- 読み込み ----------

$<HTMLInputElement>('scene-file').addEventListener('change', (event) => {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (file) queueLoad(file);
});

async function load(file: Blob & { name?: string }) {
  const status = $<HTMLParagraphElement>('scene-status');
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
    // コマを測る所（`summarizeFrames`）は読み込みと同じ 1 回だけ。
    // つまみを回すたびに測り直すと、195 コマでも目に見えて重くなる
    // （コマそのものは変わらないので、測り直す理由も無い）。
    loaded = { name: file.name ?? '素材', clip, stats: summarizeFrames(clip.frames, clip.times) };
    status.textContent =
      `${loaded.name} ・ ${clip.duration.toFixed(2)} 秒 ・ ${clip.width}×${clip.height} ・ ` +
      `素材 ${clip.sourceFps.toFixed(1)}fps → 解析 ${clip.fps.toFixed(1)}fps（${clip.frames.length} コマ）`;
    refresh();
  } catch (e) {
    loaded = null;
    plan = null;
    status.className = 'status error';
    status.textContent = `この動画は、このブラウザでは読めませんでした（${e instanceof Error ? e.message : e}）`;
    draw();
    showStats();
    showShots();
  } finally {
    loading = false;
  }
}

// ---------- 判定（呼ぶのはここ 1 か所だけ） ----------

function currentOptions(): Partial<SceneCutOptions> {
  const metric = $<HTMLSelectElement>('metric').value as SceneCutOptions['metric'];
  const localRatio = Number($<HTMLInputElement>('local-ratio').value);
  return {
    metric,
    threshold: Number($<HTMLInputElement>('threshold').value),
    // 0 は「切る」の意味。**`localRatio: 0` にすると全部通る**ので同じに見えるが、
    // 落とした理由が `local` として残らなくなるぶん、切ったことが読めなくなる。
    localRatio: localRatio > 0 ? localRatio : null,
    localWindow: Number($<HTMLInputElement>('local-window').value),
    straddleFrames: Number($<HTMLInputElement>('straddle').value),
    minScene: Number($<HTMLInputElement>('min-scene').value),
  };
}

function refresh() {
  if (!loaded) return;
  plan = planSceneCut(loaded.stats, currentOptions());
  draw();
  showStats();
  showShots();
}

// ---------- 描画 ----------

/**
 * キャンバスを画面の実寸に合わせる（ぼやけ防止）。
 * 拍の画面と同じ理由で、高さは style で固定してから width / height を書き換える。
 */
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
 * 隣り合うコマの距離を柱で描き、その上に線と候補を重ねる。
 *
 * **縦の上端は「固定の線の 3 倍」で頭打ちにしてある。** 最初は素材の最大に合わせて
 * 伸ばしていたが、それだと本物のカット（0.9〜1.0）が上端を決めてしまい、
 * **線の下で起きていること（パン 0.02・手ぶれ 0.005）が全部床に貼り付いて読めない。**
 * この画面で読みたいのは「なぜそこで切れた／切れなかった」なので、
 * 要るのは線のまわりの解像度のほう。上端を超えた柱は明るい帽子を付けて、
 * 「ここで切れている」と分かるようにしてある（超えている以上、高さの違いは意味を持たない）。
 */
function draw() {
  const canvas = $<HTMLCanvasElement>('scene-canvas');
  const ctx = fit(canvas);
  if (!ctx) return;
  const width = canvas.clientWidth || 800;
  const height = Number(canvas.dataset.height) || 160;
  ctx.clearRect(0, 0, width, height);
  if (!loaded || !plan) return;

  const duration = loaded.clip.duration || loaded.clip.frames.length / loaded.clip.fps;
  const toX = (t: number) => (t / Math.max(duration, 1e-6)) * width;
  const floor = height - 16;

  const options = { ...DEFAULT_SCENE_CUT, ...currentOptions() };
  const top = options.threshold * 3;
  const toY = (v: number) => floor - (Math.min(v, top) / top) * (floor - 10);
  const barWidth = Math.max(1, width / Math.max(1, plan.distances.length));

  // --- 隣り合うコマの距離 ---
  for (let i = 1; i < plan.distances.length; i += 1) {
    const x = toX(loaded.stats[i].time);
    const y = toY(plan.distances[i]);
    ctx.fillStyle = 'rgba(154, 183, 216, 0.55)';
    ctx.fillRect(x, y, barWidth, floor - y);
    // 上端で切った柱の帽子。切ったことを隠すと「線の 3 倍」と「線の 30 倍」が同じ絵になる。
    if (plan.distances[i] > top) {
      ctx.fillStyle = 'rgba(200, 216, 232, 0.95)';
      ctx.fillRect(x, y, barWidth, 3);
    }
  }

  // --- 固定の線 ---
  ctx.strokeStyle = '#d8b87a';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.moveTo(0, Math.round(toY(options.threshold)) + 0.5);
  ctx.lineTo(width, Math.round(toY(options.threshold)) + 0.5);
  ctx.stroke();
  ctx.setLineDash([]);

  // --- 落とした候補（線は超えたのに、門か比か長さで落ちたもの） ---
  //
  // **落ちたものを描いておくのがこの画面の肝。** 見つけた所だけ描くと、
  // 「切れなかった」ときに線が足りなかったのか門が閉じたのかが読めない。
  ctx.strokeStyle = 'rgba(164, 112, 122, 0.85)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const r of plan.rejected) {
    const x = Math.round(toX(r.time)) + 0.5;
    ctx.moveTo(x, toY(r.distance));
    ctx.lineTo(x, floor);
  }
  ctx.stroke();

  // --- 見つけた切り所 ---
  ctx.strokeStyle = '#b7d0a8';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (const b of plan.boundaries) {
    const x = Math.round(toX(b.time)) + 0.5;
    ctx.moveTo(x, 0);
    ctx.lineTo(x, floor);
  }
  ctx.stroke();

  // --- 床（素材の尺） ---
  ctx.strokeStyle = 'rgba(232, 233, 234, 0.25)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, floor + 0.5);
  ctx.lineTo(width, floor + 0.5);
  ctx.stroke();
}

/** `FrameLike` を canvas へ描く。サムネイルのためだけの変換。 */
function drawFrame(canvas: HTMLCanvasElement, frame: FrameLike) {
  canvas.width = frame.width;
  canvas.height = frame.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  // `decode.ts` が返す `data` は `ImageData` から取ったものなので、そのまま包み直せる。
  ctx.putImageData(new ImageData(new Uint8ClampedArray(frame.data), frame.width, frame.height), 0, 0);
}

/**
 * 割れた場面を並べる。
 *
 * 出すのは**その場面の頭のコマ**。真ん中を出すほうが「その場面らしい絵」にはなるが、
 * 見たいのは「隣どうしが別の場面か」なので、切り所のすぐ後ろのコマが要る。
 * 真ん中を出すと、切り損ねた 2 つの場面が別々の絵に見えて**間違いが隠れる。**
 */
function showShots() {
  const box = $<HTMLDivElement>('scene-shots');
  const note = $<HTMLParagraphElement>('scene-shots-note');
  box.innerHTML = '';
  if (!loaded || !plan) {
    note.textContent = 'まだ何も読み込んでいません。';
    return;
  }

  const total = plan.scenes.reduce((s, r) => s + (r.end - r.start), 0);
  note.textContent =
    `${plan.scenes.length} 本へ割れました（尺の合計 ${total.toFixed(2)} 秒 / もと ${loaded.clip.duration.toFixed(2)} 秒）。` +
    '区間は隙間なく並ぶので、合計は素材の尺と同じになります。';

  for (let i = 0; i < plan.scenes.length; i += 1) {
    const scene = plan.scenes[i];
    // その場面の頭にいちばん近いコマ。時刻は等間隔なので割り算で足りる。
    const index = Math.min(
      loaded.clip.frames.length - 1,
      Math.max(0, Math.round(scene.start * loaded.clip.fps)),
    );
    const figure = document.createElement('figure');
    const canvas = document.createElement('canvas');
    drawFrame(canvas, loaded.clip.frames[index]);
    const caption = document.createElement('figcaption');
    caption.innerHTML =
      `<b>${i + 1}.</b> ${scene.start.toFixed(2)} 〜 ${scene.end.toFixed(2)} 秒<br>${(scene.end - scene.start).toFixed(2)} 秒`;
    figure.append(canvas, caption);
    box.append(figure);
  }
}

// ---------- 統計 ----------

function stat(term: string, value: string, none = false) {
  return `<div><dt>${term}</dt><dd${none ? ' class="none"' : ''}>${value}</dd></div>`;
}

function showStats() {
  const box = $<HTMLDListElement>('scene-stats');
  const warn = $<HTMLParagraphElement>('scene-warning');
  if (!loaded || !plan) {
    box.innerHTML = '';
    warn.hidden = true;
    return;
  }

  const byReason: Record<string, number> = {};
  for (const r of plan.rejected) byReason[r.reason] = (byReason[r.reason] ?? 0) + 1;
  const reasons = Object.entries(byReason)
    .map(([k, v]) => `${k} ${v}`)
    .join(' / ');
  let peak = 0;
  for (let i = 1; i < plan.distances.length; i += 1) peak = Math.max(peak, plan.distances[i]);
  const found = plan.boundaries.length > 0;

  box.innerHTML = [
    stat('切り所', found ? `${plan.boundaries.length} 本` : '見つからない', !found),
    stat('場面', `${plan.scenes.length} 本`),
    stat('読んだコマ', `${loaded.clip.frames.length} 枚`),
    stat('解析の速さ', `${loaded.clip.fps.toFixed(1)} fps`),
    stat('素材の速さ', `${loaded.clip.sourceFps.toFixed(1)} fps`),
    stat('距離の最大', peak.toFixed(3)),
    stat('落とした候補', reasons || 'なし', !reasons),
    stat('コマの欠け', loaded.clip.missing ? `${loaded.clip.missing} 枚` : 'なし', !loaded.clip.missing),
  ].join('');

  // 知らせるのは「そのまま読むと数字が変わる」ときだけ。
  // 何でも出すと、読む側が warn を読まなくなる。
  const messages: string[] = [];
  if (loaded.clip.truncated) {
    messages.push(
      `<strong>尺が長いので途中まで（${loaded.clip.frames.length} コマ）で切りました。</strong>` +
        'この先に切り所があっても出てきません。',
    );
  }
  if (loaded.clip.fps > ANALYSIS_FPS) {
    messages.push(
      `<strong>解析の速さ（${loaded.clip.fps.toFixed(1)}fps）が既定の ${ANALYSIS_FPS}fps より速くなっています。</strong>` +
        'ディゾルブやフェードの 1 コマぶんの差が薄まるので、渡りを見逃しやすくなります。',
    );
  }
  if (!found && loaded.clip.frames.length > 1) {
    messages.push(
      '<strong>切り所が 1 つも見つかりませんでした。</strong>' +
        'カットの無い素材ならそれが正しい答えです。落とした候補の内訳（上の統計）を見ると、' +
        '線に届かなかったのか、門や比で落ちたのかが分かります。',
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
  showValue('threshold', 'out-threshold', (v) => v.toFixed(2));
  showValue('local-ratio', 'out-local-ratio', (v) => (v > 0 ? `${v.toFixed(1)} 倍` : '見ない'));
  showValue('local-window', 'out-local-window', (v) => `前後 ${v} コマ（${(v / currentFps()).toFixed(1)} 秒）`);
  showValue('straddle', 'out-straddle', (v) => (v > 0 ? `${v} コマ（${(v / currentFps()).toFixed(2)} 秒）` : '門を切る'));
  showValue('min-scene', 'out-min-scene', (v) => `${v.toFixed(2)} 秒`);
}

/**
 * いま何 fps で測っているか。**コマ数のつまみを秒でも見せる**ために要る。
 *
 * 読み込み済みならその値、まだならつまみの値。ここを「つまみの値」で固定すると、
 * 素材が遅くて speed が落ちたときに、画面の秒数だけが嘘になる。
 */
function currentFps(): number {
  return loaded?.clip.fps ?? Number($<HTMLInputElement>('fps').value) ?? ANALYSIS_FPS;
}

// 判定だけをやり直すつまみと、読み込みからやり直すつまみを分けてある。
// コマの速さは**何を読むか**の話なので、こちらだけは読み直しになる。
for (const id of ['threshold', 'local-ratio', 'local-window', 'straddle', 'min-scene']) {
  $<HTMLElement>(id).addEventListener('input', () => {
    showAllValues();
    refresh();
  });
}
$<HTMLElement>('metric').addEventListener('change', refresh);

$<HTMLElement>('fps').addEventListener('change', () => {
  showAllValues();
  const file = $<HTMLInputElement>('scene-file').files?.[0];
  if (file) queueLoad(file);
});
// 動かしている最中は目盛りだけ出す（離したときに読み直す）。
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

window.addEventListener('resize', draw);

// 既定は判定の側（`scene.ts` / `decode.ts`）が持っている。**画面に直書きしたままにすると黙って食い違う**ので、
// 起動時にそちらから写す（HTML に書いてある値は、この行が動く前の見た目のため）。
$<HTMLSelectElement>('metric').value = DEFAULT_SCENE_CUT.metric;
$<HTMLInputElement>('threshold').value = String(DEFAULT_SCENE_CUT.threshold);
$<HTMLInputElement>('local-ratio').value = String(DEFAULT_SCENE_CUT.localRatio ?? 0);
$<HTMLInputElement>('local-window').value = String(DEFAULT_SCENE_CUT.localWindow);
$<HTMLInputElement>('straddle').value = String(DEFAULT_SCENE_CUT.straddleFrames);
$<HTMLInputElement>('min-scene').value = String(DEFAULT_SCENE_CUT.minScene);
$<HTMLInputElement>('fps').value = String(ANALYSIS_FPS);
showAllValues();

// Playwright から呼べるようにしておく（画面を触らずに中身を確かめるため）。
declare global {
  interface Window {
    __labScene: {
      selfTest: typeof runSelfTest;
      /** 画面が使っている既定（コマンドラインと同じ所から来ているかの確認用）。 */
      defaults: { scene: SceneCutOptions; analysisFps: number };
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
        boundaries: number[];
        scenes: { start: number; end: number }[];
        rejected: Record<string, number>;
        peak: number;
      };
    };
  }
}
window.__labScene = {
  selfTest: runSelfTest,
  defaults: { scene: DEFAULT_SCENE_CUT, analysisFps: ANALYSIS_FPS },
  state: () => {
    const rejected: Record<string, number> = {};
    for (const r of plan?.rejected ?? []) rejected[r.reason] = (rejected[r.reason] ?? 0) + 1;
    let peak = 0;
    for (let i = 1; i < (plan?.distances.length ?? 0); i += 1) peak = Math.max(peak, plan!.distances[i]);
    return {
      loading,
      duration: loaded?.clip.duration ?? null,
      frames: loaded?.clip.frames.length ?? 0,
      width: loaded?.clip.width ?? null,
      height: loaded?.clip.height ?? null,
      // **画面が実際に見ている速さ。** ここが素材と違えば、画面はコマンドラインと
      // 別のコマを測っていることになる（数字は出たままなので気づけない）。
      sourceFps: loaded?.clip.sourceFps ?? null,
      fps: loaded?.clip.fps ?? null,
      missing: loaded?.clip.missing ?? 0,
      truncated: loaded?.clip.truncated ?? false,
      boundaries: plan?.boundaries.map((b) => b.time) ?? [],
      scenes: plan?.scenes.map((s) => ({ start: s.start, end: s.end })) ?? [],
      rejected,
      peak,
    };
  },
};
