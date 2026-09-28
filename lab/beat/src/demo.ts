/**
 * 拍の検出の画面。
 *
 * ここは「見せる・鳴らす」だけを受け持ち、判断はすべて純粋な関数
 * （`beats.ts` / `tempo.ts` / `onset.ts`）に任せている。
 * 本体へ持っていくときに要るのはそちらだけで、このファイルは捨ててよい。
 *
 * **画面で判定をやり直さない。** `auto-cut` の画面では、同じ計画を 2 か所で作って
 * 片方にだけ列を渡し忘れかけたことがある（`demo.ts` の `cutOf` の注）。
 * こちらでは `detectBeats` を呼ぶ所を 1 つに絞り、描画も再生も吸い付きも、
 * その 1 回の結果（`result`）だけを見る。**画面とコマンドラインで数字が食い違わない**のは
 * この形のおかげで、`uitest.mjs` はそこを突き合わせて確かめている。
 */

import { buildPeaks, type Peaks } from '../../auto-cut/src/peaks.ts';
import { DEFAULT_BEATS, detectBeats, snapToBeat, subdivide, type BeatResult } from './beats.ts';
import { DEFAULT_ONSET, type OnsetOptions } from './onset.ts';
import { clarityLine, DEFAULT_TEMPO } from './tempo.ts';
import { runSelfTest } from './selftest.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let audio: AudioContext | null = null;
const ensureAudio = () => {
  if (!audio) audio = new AudioContext();
  if (audio.state === 'suspended') void audio.resume();
  return audio;
};

/** いま鳴らしている音。新しく鳴らす前に必ず止める。 */
let playing: AudioBufferSourceNode[] = [];
function stopAll() {
  for (const node of playing) {
    try {
      node.stop();
    } catch {
      /* もう止まっている */
    }
  }
  playing = [];
}

interface Loaded {
  name: string;
  buffer: AudioBuffer;
  peaks: Peaks;
}

let loaded: Loaded | null = null;
/** いまの設定で出した拍。**この 1 つだけを全部が見る。** */
let result: BeatResult | null = null;
/** 吸い付き先（拍を等分したもの）。拍そのものと分けて持つのは、描き分けたいため。 */
let targets: number[] = [];

// ---------- 読み込み ----------

async function load(file: File, canvas: HTMLCanvasElement): Promise<Loaded> {
  const bytes = await file.arrayBuffer();
  // decodeAudioData は音声トラックだけを取り出すので、動画ファイルをそのまま渡してよい。
  const buffer = await ensureAudio().decodeAudioData(bytes);
  return { name: file.name, buffer, peaks: buildPeaks(buffer, Math.max(200, canvas.clientWidth || 800)) };
}

$<HTMLInputElement>('beat-file').addEventListener('change', async (event) => {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  const status = $<HTMLParagraphElement>('beat-status');
  status.className = 'status';
  status.textContent = `${file.name} を読み込んでいます…`;
  try {
    loaded = await load(file, $<HTMLCanvasElement>('beat-canvas'));
    status.textContent = `${loaded.name} ・ ${loaded.buffer.duration.toFixed(2)} 秒 ・ ${loaded.buffer.numberOfChannels}ch ・ ${loaded.buffer.sampleRate}Hz`;
    // 吸い付きを試すつまみは、素材の尺の中しか意味が無い。
    const at = $<HTMLInputElement>('snap-at');
    at.max = loaded.buffer.duration.toFixed(2);
    if (Number(at.value) > loaded.buffer.duration) at.value = (loaded.buffer.duration / 2).toFixed(2);
    for (const id of ['play-original', 'play-clicks', 'stop-beat']) $<HTMLButtonElement>(id).disabled = false;
    refresh();
  } catch (e) {
    status.className = 'status error';
    status.textContent = `この形式の音は、このブラウザでは読めませんでした（${e instanceof Error ? e.message : e}）`;
  }
});

// ---------- 判定（呼ぶのはここ 1 か所だけ） ----------

function currentMethod(id: string): OnsetOptions['method'] {
  const value = $<HTMLSelectElement>(id).value;
  return value === 'flux' || value === 'logFlux' ? value : 'energy';
}

function refresh() {
  if (!loaded) return;
  result = detectBeats(loaded.buffer, {
    tempoMethod: currentMethod('tempo-method'),
    phaseMethod: currentMethod('phase-method'),
    followTempo: $<HTMLInputElement>('follow-tempo').checked,
    priorBpm: Number($<HTMLInputElement>('prior-bpm').value),
    priorOctaves: Number($<HTMLInputElement>('prior-octaves').value),
    minClarity: Number($<HTMLInputElement>('min-clarity').value),
  });
  targets = subdivide(result.beats, Number($<HTMLInputElement>('subdivide').value));
  draw();
  showStats();
  showSnap();
}

// ---------- 描画 ----------

/**
 * キャンバスを画面の実寸に合わせる（ぼやけ防止）。
 * 見た目の高さは style で固定する。width / height 属性だけを書き換えると、
 * それが要素の高さにもなってしまい、描くたびに縦へ伸び続ける。
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
 * 波形・立ち上がりの列・拍の線を 1 枚に重ねる。
 *
 * **3 つを並べずに重ねているのは、縦に並べると目が行き来するから。**
 * 見たいのは「その打点の所に線が立っているか」で、それは重ねないと分からない。
 * 上 3 分の 2 が波形、下 3 分の 1 が立ち上がりの列（判定が実際に見ている列）。
 */
function draw() {
  const canvas = $<HTMLCanvasElement>('beat-canvas');
  const ctx = fit(canvas);
  if (!ctx) return;
  const width = canvas.clientWidth || 800;
  const height = Number(canvas.dataset.height) || 160;
  ctx.clearRect(0, 0, width, height);
  if (!loaded) return;

  const duration = loaded.buffer.duration;
  const toX = (t: number) => (t / duration) * width;
  const waveBottom = height * 0.66;

  // --- 波形 ---
  const mid = waveBottom / 2;
  ctx.fillStyle = '#cfd6cb';
  for (let x = 0; x < width; x += 1) {
    const i = Math.min(loaded.peaks.max.length - 1, Math.floor((x / width) * loaded.peaks.max.length));
    const top = mid - loaded.peaks.max[i] * mid * 0.92;
    const bottom = mid - loaded.peaks.min[i] * mid * 0.92;
    ctx.fillRect(x, top, 1, Math.max(1, bottom - top));
  }

  // --- 立ち上がりの列（位相に使っているほう） ---
  //
  // 判定が実際に見ているのは `detrended`（移動平均を引いて 0 以上に切ったもの）。
  // 生の `strength` を出すと「鳴っている所は全部高い」だけの絵になり、
  // **なぜそこに拍が立ったのかが読めない。**
  if (result) {
    const track = result.phaseTrack;
    let peak = 0;
    for (let i = 0; i < track.detrended.length; i += 1) peak = Math.max(peak, track.detrended[i]);
    if (peak > 0) {
      ctx.fillStyle = 'rgba(154, 183, 216, 0.55)';
      for (let x = 0; x < width; x += 1) {
        const i = Math.min(track.detrended.length - 1, Math.floor((x / width) * track.detrended.length));
        const h = (track.detrended[i] / peak) * (height - waveBottom - 2);
        ctx.fillRect(x, height - h, 1, h);
      }
    }
  }

  // --- 等分した吸い付き先（拍そのものより薄く） ---
  if (result) {
    ctx.strokeStyle = 'rgba(183, 208, 168, 0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const beats = new Set(result.beats);
    for (const t of targets) {
      if (beats.has(t)) continue;
      const x = Math.round(toX(t)) + 0.5;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
    }
    ctx.stroke();

    // --- 拍 ---
    ctx.strokeStyle = '#b7d0a8';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (const t of result.beats) {
      const x = Math.round(toX(t)) + 0.5;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
    }
    ctx.stroke();

    // --- 窓ごとのテンポ（追っているときだけ） ---
    //
    // 縦は「そのときの BPM」。**目盛りは付けていない**が、平らかどうかだけ見れば足りる。
    // 一定の素材で波打っていたら、それは追いすぎている。
    if (result.tempoCurve) {
      const periods = result.tempoCurve.periods;
      let lo = Infinity;
      let hi = 0;
      for (let i = 0; i < periods.length; i += 1) {
        if (!(periods[i] > 0)) continue;
        lo = Math.min(lo, periods[i]);
        hi = Math.max(hi, periods[i]);
      }
      if (Number.isFinite(lo) && hi > 0) {
        // 一定の素材で線が上下に暴れて見えないよう、幅が無いときは真ん中に置く。
        const span = Math.max(hi - lo, lo * 0.05);
        ctx.strokeStyle = '#d8b87a';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        let started = false;
        for (let i = 0; i < periods.length; i += 1) {
          if (!(periods[i] > 0)) continue;
          const x = toX(result.tempoCurve.times[i]);
          // 速い（周期が短い）ほど上。
          const y = 6 + ((periods[i] - lo + span * 0.5) / (span * 2)) * (waveBottom - 12);
          if (!started) {
            ctx.moveTo(x, y);
            started = true;
          } else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
    }
  }
}

// ---------- 統計 ----------

function stat(term: string, value: string, none = false) {
  return `<div><dt>${term}</dt><dd${none ? ' class="none"' : ''}>${value}</dd></div>`;
}

function showStats() {
  const box = $<HTMLDListElement>('beat-stats');
  const warn = $<HTMLParagraphElement>('beat-warning');
  if (!loaded || !result) {
    box.innerHTML = '';
    warn.hidden = true;
    return;
  }

  const line = clarityLine(Number($<HTMLInputElement>('min-clarity').value), loaded.buffer.duration);
  const found = result.bpm != null;
  box.innerHTML = [
    stat('テンポ', found ? `${result.bpm!.toFixed(1)} BPM` : '見つからない', !found),
    stat('拍の間隔', found ? `${(result.period! * 1000).toFixed(0)} ms` : '—', !found),
    stat('拍の本数', `${result.beats.length}`),
    stat('吸い付き先', `${targets.length}`),
    stat('はっきりさ', `${result.clarity.toFixed(2)}`),
    stat('効いている線', `${line.toFixed(2)}`),
    stat('最初の拍', found ? `${result.phase.toFixed(3)} 秒` : '—', !found),
    stat('テンポの振れ', `${result.tempoSpread.toFixed(3)}`),
  ].join('');

  if (!found) {
    warn.hidden = false;
    warn.innerHTML =
      `<strong>拍が見つかりませんでした。</strong>はっきりさ ${result.clarity.toFixed(2)} が、` +
      `この尺（${loaded.buffer.duration.toFixed(1)} 秒）での線 ${line.toFixed(2)} に届いていません。` +
      'ここで適当な 120 を埋めないのがこの試作の決め事です。吸い付き先も空のままにしてあります。';
  } else if (result.tempoSpread > 1.05) {
    warn.hidden = false;
    warn.innerHTML =
      `<strong>テンポが素材の中で ${result.tempoSpread.toFixed(2)} 倍ぶん動いています。</strong>` +
      `表示している ${result.bpm!.toFixed(1)} BPM は素材ぜんたいの見出しでしかなく、拍の位置は窓ごとの周期から出ています。`;
  } else {
    warn.hidden = true;
  }
}

function showSnap() {
  const box = $<HTMLDListElement>('snap-stats');
  const at = Number($<HTMLInputElement>('snap-at').value);
  const maxShift = Number($<HTMLInputElement>('max-shift').value);
  const to = snapToBeat(at, targets, maxShift);
  const moved = Math.abs(to - at) > 1e-9;
  box.innerHTML = [
    stat('入れた秒', `${at.toFixed(3)} 秒`),
    stat('返った秒', `${to.toFixed(3)} 秒`),
    stat('動いた量', moved ? `${((to - at) * 1000).toFixed(0)} ms` : '動かさない', !moved),
    stat('寄せ先', targets.length > 0 ? `${targets.length} 点のうち` : '吸い付き先が無い', targets.length === 0),
  ].join('');
}

// ---------- 再生 ----------

/**
 * 拍の所にクリック音を重ねた音を作る。
 *
 * **判定とは関係が無い**ので、ここ（画面の側）に置いてある。
 * 減衰を 25ms と短くしてあるのは、拍そのものより長く鳴ると
 * 「どこが頭か」が耳で取れなくなるため。
 */
function withClicks(source: AudioBuffer, beats: number[]): AudioBuffer {
  const ctx = ensureAudio();
  // 長さ 0 の音を作ろうとすると createBuffer が投げる。読み込みに失敗していなくても、
  // 中身の無いファイルならここへ来られるので、その場で引き返す。
  if (source.length === 0) return source;
  const out = ctx.createBuffer(source.numberOfChannels, source.length, source.sampleRate);
  for (let c = 0; c < source.numberOfChannels; c += 1) {
    const from = source.getChannelData(c);
    const to = out.getChannelData(c);
    to.set(from);
    for (const t of beats) {
      const start = Math.round(t * source.sampleRate);
      const length = Math.round(0.025 * source.sampleRate);
      for (let i = 0; i < length; i += 1) {
        const s = start + i;
        if (s < 0 || s >= to.length) continue;
        const u = i / source.sampleRate;
        to[s] += 0.35 * Math.exp(-u / 0.006) * Math.sin(2 * Math.PI * 1760 * u);
      }
    }
  }
  return out;
}

function play(buffer: AudioBuffer) {
  stopAll();
  const ctx = ensureAudio();
  const node = ctx.createBufferSource();
  node.buffer = buffer;
  node.connect(ctx.destination);
  node.start();
  playing.push(node);
}

$<HTMLButtonElement>('play-original').addEventListener('click', () => {
  if (loaded) play(loaded.buffer);
});
$<HTMLButtonElement>('play-clicks').addEventListener('click', () => {
  if (loaded) play(withClicks(loaded.buffer, result?.beats ?? []));
});
$<HTMLButtonElement>('stop-beat').addEventListener('click', stopAll);

// ---------- つまみの配線 ----------

/** つまみの値を横の文字へ写す。単位はここで足す。 */
function showValue(id: string, outId: string, format: (v: number) => string) {
  $<HTMLOutputElement>(outId).textContent = format(Number($<HTMLInputElement>(id).value));
}

function showAllValues() {
  showValue('prior-bpm', 'out-prior-bpm', (v) => `${v} BPM`);
  showValue('prior-octaves', 'out-prior-octaves', (v) => `±${v.toFixed(1)} オクターブ`);
  showValue('min-clarity', 'out-min-clarity', (v) => v.toFixed(2));
  showValue('subdivide', 'out-subdivide', (v) => (v <= 1 ? '拍だけ' : `${v} 等分`));
  showValue('snap-at', 'out-snap-at', (v) => `${v.toFixed(2)} 秒`);
  showValue('max-shift', 'out-max-shift', (v) => `${(v * 1000).toFixed(0)} ms`);
}

// 判定をやり直すつまみと、吸い付きの表示だけを直すつまみを分けてある
// （素材が 16 秒あると `detectBeats` は一瞬では終わらないので、
//  吸い付きのつまみを動かすたびに測り直すと、目に見えて重くなる）。
//
// **聞く出来事は種類ごとに 1 つだけ**にしてある。`select` と `checkbox` は
// `input` も `change` も両方投げるので、まとめて両方を聞くと
// **1 回動かすたびに `detectBeats` が 2 度走る**（画面は同じに見えるので気づけない）。
for (const id of ['prior-bpm', 'prior-octaves', 'min-clarity', 'subdivide']) {
  $<HTMLElement>(id).addEventListener('input', () => {
    showAllValues();
    refresh();
  });
}
for (const id of ['tempo-method', 'phase-method', 'follow-tempo']) {
  $<HTMLElement>(id).addEventListener('change', refresh);
}
for (const id of ['snap-at', 'max-shift']) {
  $<HTMLElement>(id).addEventListener('input', () => {
    showAllValues();
    showSnap();
  });
}

$<HTMLButtonElement>('run-tests').addEventListener('click', () => {
  const results = runSelfTest();
  $<HTMLUListElement>('test-results').innerHTML = results
    .map((r) => `<li class="${r.ok ? 'pass' : 'fail'}"><b>${r.ok ? 'PASS' : 'FAIL'}</b><span>${r.name}</span><span>${r.detail}</span></li>`)
    .join('');
});

window.addEventListener('resize', draw);

// 既定は判定の側（`beats.ts` / `tempo.ts`）が持っている。**画面に直書きしたままにすると黙って食い違う**ので、
// 起動時にそちらから写す（HTML に書いてある値は、この行が動く前の見た目のため）。
$<HTMLSelectElement>('tempo-method').value = DEFAULT_BEATS.tempoMethod;
$<HTMLSelectElement>('phase-method').value = DEFAULT_BEATS.phaseMethod;
$<HTMLInputElement>('follow-tempo').checked = DEFAULT_BEATS.followTempo;
$<HTMLInputElement>('prior-bpm').value = String(DEFAULT_TEMPO.priorBpm);
$<HTMLInputElement>('prior-octaves').value = String(DEFAULT_TEMPO.priorOctaves);
$<HTMLInputElement>('min-clarity').value = String(DEFAULT_TEMPO.minClarity);
showAllValues();
showSnap();

// Playwright から呼べるようにしておく（画面を触らずに中身を確かめるため）。
declare global {
  interface Window {
    __labBeat: {
      selfTest: typeof runSelfTest;
      /** 画面が使っている既定（コマンドラインと同じ所から来ているかの確認用）。 */
      defaults: { onset: OnsetOptions; beats: typeof DEFAULT_BEATS };
      state: () => {
        duration: number | null;
        sampleRate: number | null;
        bpm: number | null;
        period: number | null;
        beats: number[];
        targets: number[];
        clarity: number;
        phase: number;
        tempoSpread: number;
        following: boolean;
      };
    };
  }
}
window.__labBeat = {
  selfTest: runSelfTest,
  defaults: { onset: DEFAULT_ONSET, beats: DEFAULT_BEATS },
  state: () => ({
    duration: loaded?.buffer.duration ?? null,
    // **画面が実際に見ている標本化周波数。** `decodeAudioData` は音を AudioContext の
    // 周波数へ揃えるので、素材の 44.1kHz のままとは限らない。ここが素材と違っていれば、
    // 画面はコマンドラインと**別の音**を測っていることになる（数字は出たままなので気づけない）。
    sampleRate: loaded?.buffer.sampleRate ?? null,
    bpm: result?.bpm ?? null,
    period: result?.period ?? null,
    beats: result?.beats ?? [],
    targets,
    clarity: result?.clarity ?? 0,
    phase: result?.phase ?? 0,
    tempoSpread: result?.tempoSpread ?? 1,
    following: result?.tempoCurve != null,
  }),
};
