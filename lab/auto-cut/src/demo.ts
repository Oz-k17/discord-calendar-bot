/**
 * 試作の画面。
 * ここは「見せる・鳴らす」だけを受け持ち、判断はすべて純粋な関数（silence / ducking）に任せている。
 * 本体へ持っていくときに要るのはそちらだけで、このファイルは捨ててよい。
 */

import { analyzeLoudness, type AudioLike, type LoudnessTrack } from './loudness.ts';
import { buildPeaks, type Peaks } from './peaks.ts';
import { analyzeFeatures, type FeatureTrack } from './features.ts';
import { planJetCut, type JetCutPlan } from './silence.ts';
import { applyDucking, gainAt, planDucking, type GainPoint } from './ducking.ts';
import { summarize, toClipEdits } from './edits.ts';
import {
  attachClipGains,
  clipLoudnessFrom,
  DEFAULT_CLIP_MATCH,
  planClipMatch,
  type ClipMatchOptions,
  type ClipMatchPlan,
  type MatchedClipEdit,
} from './clip-match.ts';
import {
  applyGain,
  measureLoudness,
  planLoudnessNormalization,
  type LoudnessMeasurement,
  type NormalizationPlan,
} from './lufs.ts';
import { DEFAULT_LIMITER, limitTruePeak, type LimiterReport } from './limiter.ts';
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
  track: LoudnessTrack;
  peaks: Peaks;
  /** 声らしさなど。重いので、読み込んだときに一度だけ作る。 */
  features: FeatureTrack;
  /**
   * ラウドネス（LUFS）と真のピーク。目標の値には依らないので、ここで一度だけ測る。
   * つまみを回したときに作り直すのは「倍率をどう決めるか」だけ。
   */
  loudness: LoudnessMeasurement;
}

let voice: Loaded | null = null;
let bgm: Loaded | null = null;
let plan: JetCutPlan | null = null;
let duckPoints: GainPoint[] = [];
let loudnessPlan: NormalizationPlan | null = null;
/** リミッタを通した音。**通さないときは null** で、そのときは倍率だけを当てて鳴らす。 */
let limited: { buffer: AudioLike; report: LimiterReport } | null = null;

/** 「4. クリップごとの音量を揃える」で並べている素材。1 本 1 クリップ。 */
let clips: Loaded[] = [];
let clipPlan: ClipMatchPlan | null = null;
/** 揃えたあとのタイムライン。かけらごとに「どの素材のどこを、どの倍率で」鳴らすか。 */
let clipTimeline: { clip: Loaded; edit: MatchedClipEdit }[] = [];

// ---------- 読み込み ----------

async function load(file: File, canvas: HTMLCanvasElement): Promise<Loaded> {
  const bytes = await file.arrayBuffer();
  // decodeAudioData は音声トラックだけを取り出すので、動画ファイルをそのまま渡してよい。
  const buffer = await ensureAudio().decodeAudioData(bytes);
  const track = analyzeLoudness(buffer, 0.02);
  return {
    name: file.name,
    buffer,
    track,
    peaks: buildPeaks(buffer, Math.max(200, canvas.clientWidth || 800)),
    features: analyzeFeatures(buffer, track),
    // **1ch の素材は 2ch 扱いで測る。** 本体の書き出しが 2ch なので、
    // 1ch のまま測ると耳に届くときより 3.01 LU 小さく読み、そのぶん大きく書き出してしまう
    // （`src/engine/offline-export.ts` の CHANNELS = 2）。
    loudness: measureLoudness(buffer, { monoAsDualMono: buffer.numberOfChannels === 1 }),
  };
}

function bindFile(inputId: string, statusId: string, canvas: HTMLCanvasElement, onLoad: (loaded: Loaded) => void) {
  const status = $<HTMLParagraphElement>(statusId);
  $<HTMLInputElement>(inputId).addEventListener('change', async (event) => {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    status.className = 'status';
    status.textContent = `${file.name} を読み込んでいます…`;
    try {
      const loaded = await load(file, canvas);
      status.textContent = `${loaded.name} ・ ${loaded.buffer.duration.toFixed(2)} 秒 ・ ${loaded.buffer.numberOfChannels}ch ・ ${loaded.buffer.sampleRate}Hz`;
      onLoad(loaded);
    } catch (e) {
      status.className = 'status error';
      status.textContent = `この形式の音は、このブラウザでは読めませんでした（${e instanceof Error ? e.message : e}）`;
    }
  });
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
  const height = displayHeight(canvas);
  canvas.style.height = `${height}px`;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  const ctx = canvas.getContext('2d');
  if (ctx) ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  return ctx;
}

/** CSS 上の高さ。data-height に書いた値を正とする。 */
function displayHeight(canvas: HTMLCanvasElement): number {
  return Number(canvas.dataset.height) || 160;
}

function drawWave(ctx: CanvasRenderingContext2D, peaks: Peaks, width: number, height: number, color: string) {
  const mid = height / 2;
  ctx.fillStyle = color;
  for (let x = 0; x < width; x += 1) {
    const i = Math.min(peaks.max.length - 1, Math.floor((x / width) * peaks.max.length));
    const top = mid - peaks.max[i] * mid * 0.92;
    const bottom = mid - peaks.min[i] * mid * 0.92;
    ctx.fillRect(x, top, 1, Math.max(1, bottom - top));
  }
}

function drawVoice() {
  const canvas = $<HTMLCanvasElement>('voice-canvas');
  const ctx = fit(canvas);
  if (!ctx) return;
  const width = canvas.clientWidth || 800;
  const height = displayHeight(canvas);
  ctx.clearRect(0, 0, width, height);
  if (!voice || !plan) return;

  const toX = (t: number) => (t / voice!.buffer.duration) * width;

  // 削る区間を先に敷く。
  ctx.fillStyle = 'rgba(138, 91, 91, 0.35)';
  for (const range of plan.cut) ctx.fillRect(toX(range.start), 0, Math.max(1, toX(range.end) - toX(range.start)), height);
  ctx.fillStyle = 'rgba(111, 154, 91, 0.16)';
  for (const range of plan.keep) ctx.fillRect(toX(range.start), 0, Math.max(1, toX(range.end) - toX(range.start)), height);

  drawWave(ctx, voice.peaks, width, height, '#cfd6cb');

  // 声らしさの曲線（「声らしさも見る」のときだけ）。判定の理由が目で見えるように。
  if (plan.usedMode === 'speech') {
    const score = voice.features.speechScore;
    ctx.strokeStyle = '#9ab7d8';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let x = 0; x <= width; x += 1) {
      const i = Math.min(score.length - 1, Math.floor((x / width) * score.length));
      const y = height - Math.min(1, score[i] / 0.6) * (height - 4) - 2;
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    const threshold = Number($<HTMLInputElement>('speech-threshold').value);
    const y = height - Math.min(1, threshold / 0.6) * (height - 4) - 2;
    ctx.strokeStyle = 'rgba(154, 183, 216, 0.5)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // しきい値の線（dB を振幅に戻して描く）。
  const amp = Math.pow(10, plan.thresholdDb / 20);
  const mid = height / 2;
  ctx.strokeStyle = '#b7d0a8';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.moveTo(0, mid - amp * mid * 0.92);
  ctx.lineTo(width, mid - amp * mid * 0.92);
  ctx.moveTo(0, mid + amp * mid * 0.92);
  ctx.lineTo(width, mid + amp * mid * 0.92);
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawBgm() {
  const canvas = $<HTMLCanvasElement>('bgm-canvas');
  const ctx = fit(canvas);
  if (!ctx) return;
  const width = canvas.clientWidth || 800;
  const height = displayHeight(canvas);
  ctx.clearRect(0, 0, width, height);
  if (!bgm) return;

  drawWave(ctx, bgm.peaks, width, height, '#8d93a0');
  if (duckPoints.length === 0) return;

  // 音量カーブ。BGM の尺いっぱいに引く（声が短ければ以降は 1 のまま）。
  ctx.strokeStyle = '#b7d0a8';
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let x = 0; x <= width; x += 1) {
    const t = (x / width) * bgm.buffer.duration;
    const y = height - gainAt(duckPoints, t) * (height - 6) - 3;
    if (x === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

// ---------- 無音カット ----------

/** いま選ばれている判定のしかた。 */
function currentMode(): 'level' | 'speech' {
  const checked = document.querySelector<HTMLInputElement>('input[name="mode"]:checked');
  return checked?.value === 'speech' ? 'speech' : 'level';
}

/**
 * いまの画面の設定で 1 本ぶんのカットを計画する。
 *
 * **「4.」で並べた素材にも同じものを掛ける**ので、呼び出しをここに 1 本化してある。
 * 2 か所に書くと、片方にだけ列を渡し忘れて**画面の中で判定が食い違う**（実際に危なかった）。
 */
function cutOf(loaded: Loaded): JetCutPlan {
  return planJetCut(
    loaded.track,
    {
      mode: currentMode(),
      speechThreshold: Number($<HTMLInputElement>('speech-threshold').value),
      sensitivity: Number($<HTMLInputElement>('sensitivity').value),
      minSilence: Number($<HTMLInputElement>('min-silence').value),
      padding: Number($<HTMLInputElement>('padding').value),
      envelopeHold: Number($<HTMLInputElement>('envelope-hold').value),
      speechLeadIn: Number($<HTMLInputElement>('speech-lead-in').value),
    },
    loaded.features.speechScore,
    loaded.features.shapeChange,
    loaded.features.envelopeChange,
    // 均す前の列。「この素材に声があるか」を決めるときだけ使う（silence.ts の注を参照）。
    loaded.features.envelopeFlux,
    // 低い帯域の揺れの深さ。これも素材単位の判定だけで使う。
    loaded.features.lowLevel,
    loaded.features.lowModulationDepth,
    // 低い帯域の音量の向き。こちらはコマ単位の門で、声の帯域に居座る打点を落とす。
    loaded.features.lowLevelSkew,
    // 対数を外した深さ。コマ単位の門（既定で入っている。silence.ts の `minEnergyDepthDrop`）。
    // **渡し忘れると画面だけ門の無い判定になる**ので、列はここでも必ず渡す。
    loaded.features.lowEnergyDepth,
  );
}

function refreshCut() {
  const mode = currentMode();
  document.body.classList.toggle('mode-speech', mode === 'speech');
  $<HTMLOutputElement>('out-speech').textContent = Number($<HTMLInputElement>('speech-threshold').value).toFixed(2);
  $<HTMLOutputElement>('out-envelope-hold').textContent = `${Number($<HTMLInputElement>('envelope-hold').value).toFixed(2)} 秒`;
  $<HTMLOutputElement>('out-speech-lead-in').textContent = `${Number($<HTMLInputElement>('speech-lead-in').value).toFixed(2)} 秒`;
  // **「4.」はここより先に返さない。** 声の素材が無くても、並べたクリップだけで揃えられる。
  refreshClips();
  if (!voice) return;
  plan = cutOf(voice);

  $<HTMLOutputElement>('out-sensitivity').textContent = Number($<HTMLInputElement>('sensitivity').value).toFixed(2);
  $<HTMLOutputElement>('out-min-silence').textContent = `${Number($<HTMLInputElement>('min-silence').value).toFixed(2)} 秒`;
  $<HTMLOutputElement>('out-padding').textContent = `${Number($<HTMLInputElement>('padding').value).toFixed(2)} 秒`;

  const ratio = plan.originalDuration > 0 ? plan.resultDuration / plan.originalDuration : 1;
  $<HTMLDListElement>('cut-stats').innerHTML = [
    ['元の尺', `${plan.originalDuration.toFixed(2)} 秒`],
    ['カット後', `${plan.resultDuration.toFixed(2)} 秒`],
    ['削減', `${plan.removed.toFixed(2)} 秒（${Math.round((1 - ratio) * 100)}%）`],
    ['クリップ数', `${plan.keep.length} 本`],
    ['しきい値', `${plan.thresholdDb.toFixed(1)} dB`],
    ['判定', plan.usedMode === 'speech' ? '声らしさも見た' : '音量だけ'],
    ...(plan.usedMode === 'speech'
      ? [['音色が動いていた', `${plan.envelopeSeconds.toFixed(2)} 秒`] as [string, string]]
      : []),
  ]
    .map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`)
    .join('');

  // 声が少ないときは、黙って判断せず知らせる。
  // 割合だけでは「声が無い」と「たまにしか声が無い」を分けられないため、
  // 決めるのは人に任せて、材料を出すだけにしている。
  const warning = $<HTMLParagraphElement>('cut-warning');
  if (plan.noSpeechFound) {
    // 同じ「何もしない」でも、理由によって次にすべきことが違う。
    const why =
      plan.noSpeechReason === 'shape'
        ? '音の中身が最初から最後まで変わりません。鳴りっぱなしの音楽ではありませんか？'
        : plan.noSpeechReason === 'depth'
          ? // 深さで止めたときは、何を見て止めたのかが人にも分かる形で言える
            // （割合や形と違って、この理由は 1 つの数で説明できる）。
            `低い音の大きさが、最初から最後まで変わりません（${plan.depthMax.toFixed(2)}dB）。` +
            '持続する和音やパッドではありませんか？'
          : '声だと判断できるところが見つかりませんでした。' +
            '音楽だけの素材か、音色の動かない音（鳴りっぱなしの楽器）ではありませんか？';
    warning.textContent = `${why} 何もしていません。（切りたいなら「音量だけ」で試してください）`;
    warning.hidden = false;
  } else if (plan.usedMode === 'speech' && plan.speechRatio < 0.5) {
    warning.textContent =
      `鳴っているところのうち、声らしいと判断できたのは ${Math.round(plan.speechRatio * 100)}% です。` +
      '声の少ない素材か、声として拾えていないかのどちらかです。結果を必ず耳で確かめてください。';
    warning.hidden = false;
  } else {
    warning.hidden = true;
  }

  const clip = { start: 0, duration: voice.buffer.duration, sourceIn: 0 };
  const edits = toClipEdits(plan.keep, clip);
  const stats = summarize(edits, clip);
  $<HTMLPreElement>('edit-list').textContent = edits.length
    ? [
        `${stats.pieces} 本 / ${stats.before.toFixed(2)} 秒 → ${stats.after.toFixed(2)} 秒`,
        '',
        ...edits.map(
          (e, i) =>
            `${String(i + 1).padStart(2, ' ')}. タイムライン ${e.start.toFixed(2)}〜${(e.start + e.duration).toFixed(2)} 秒` +
            `　←　素材 ${e.from.start.toFixed(2)}〜${e.from.end.toFixed(2)} 秒`,
        ),
      ].join('\n')
    : '残る区間がありません（感度を下げてみてください）';

  drawVoice();
  refreshDuck();
  refreshLoudness();
}

/** 残す区間だけを順に鳴らす。詰めた結果がそのまま耳で確かめられる。 */
function playRanges(loaded: Loaded, ranges: { start: number; end: number }[]) {
  stopAll();
  const ctx = ensureAudio();
  let at = ctx.currentTime + 0.05;
  for (const range of ranges) {
    const length = range.end - range.start;
    if (length <= 0.01) continue;
    const node = ctx.createBufferSource();
    node.buffer = loaded.buffer;
    node.connect(ctx.destination);
    node.start(at, range.start, length);
    playing.push(node);
    at += length;
  }
}

// ---------- ラウドネス ----------

/**
 * 測った結果から倍率を決め直して、画面へ出す。
 *
 * **測り直さない**のがここの肝で、ラウドネスも真のピークも目標には依らない。
 * つまみが動かすのは「その値をどう使うか」だけなので、読み込みのときの 1 回で足りる。
 */
function refreshLoudness() {
  const target = Number($<HTMLInputElement>('target-lufs').value);
  const ceiling = Number($<HTMLInputElement>('ceiling-db').value);
  const useLimiter = $<HTMLInputElement>('use-limiter').checked;
  const lookAheadMs = Number($<HTMLInputElement>('lookahead-ms').value);
  $<HTMLOutputElement>('out-target').textContent = `${target.toFixed(1)} LUFS`;
  $<HTMLOutputElement>('out-ceiling').textContent = `${ceiling.toFixed(1)} dBTP`;
  // 守れる下限の周波数も併せて出す。**つまみの意味が「何 Hz まで歪まないか」**なので、
  // ミリ秒だけ見せても何を選んでいるのか分からない。
  $<HTMLOutputElement>('out-lookahead').textContent = `${lookAheadMs} ms（${Math.round(500 / lookAheadMs)} Hz まで）`;

  const stats = $<HTMLDListElement>('loudness-stats');
  const warning = $<HTMLParagraphElement>('loudness-warning');
  if (!voice) {
    stats.innerHTML = '';
    warning.hidden = true;
    loudnessPlan = null;
    limited = null;
    return;
  }

  const m = voice.loudness;
  loudnessPlan = planLoudnessNormalization(m, {
    targetLufs: target,
    truePeakCeilingDb: ceiling,
    limiterHeadroomDb: useLimiter ? DEFAULT_LIMITER.maxReductionDb : 0,
  });

  // 倍率を当ててからリミッタに通す。13 秒で 150ms ほどかかるので、
  // **通す必要があるときだけ**作る（天井を超えないなら倍率だけで済む）。
  limited =
    useLimiter && loudnessPlan.neededReductionDb > 0
      ? limitTruePeak(applyGain(voice.buffer, loudnessPlan.gain), {
          ceilingDb: ceiling,
          lookAheadMs,
        })
      : null;

  const lufs = (v: number | null) => (v === null ? '測れません' : `${v.toFixed(1)} LUFS`);
  stats.innerHTML = [
    ['いまの大きさ', lufs(m.integratedLufs)],
    ['短期の最大', lufs(m.shortTermMaxLufs)],
    // 判断には使っていない。素材にどれだけ「黙っている所」があるかの目安として出すだけ。
    ['静かな窓', lufs(m.quietBlockLufs)],
    ['標本のピーク', `${m.samplePeakDb.toFixed(1)} dBFS`],
    // 標本と真の差は「叩き切ってあるか」の目安になるので、並べて出す。
    ['真のピーク', `${m.truePeakDb.toFixed(1)} dBTP`],
    ['当てる倍率', `${loudnessPlan.gainDb >= 0 ? '+' : ''}${loudnessPlan.gainDb.toFixed(1)} dB`],
    ['揃えたあと', `${lufs(loudnessPlan.resultLufs)} / ${(limited ? limited.report.truePeakDb : loudnessPlan.resultTruePeakDb).toFixed(1)} dBTP`],
    // **均した深さと時間を並べて出す。** 深さだけ見せると「効いた」としか読めないが、
    // 長く働いているなら、それは揃えたのではなく潰しただけかもしれない。
    [
      '均した量',
      limited
        ? `${limited.report.maxReductionDb.toFixed(1)} dB を ${(limited.report.activeSeconds * 1000).toFixed(0)} ms（${(limited.report.activeRatio * 100).toFixed(2)}%）`
        : useLimiter
          ? '均す必要なし'
          : '使っていません',
    ],
  ]
    .map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`)
    .join('');

  // 目標へ届かなかったときは、**なぜ届かなかったか**まで出す。
  // 倍率だけ見せると「効いていない」と読まれるが、ここは効かせないのが正しい振る舞い。
  if (loudnessPlan.limitedBy === 'peak') {
    warning.textContent =
      `目標まで上げるとピークが天井（${ceiling.toFixed(1)} dBTP）を超えるので、` +
      `${Math.abs(loudnessPlan.shortfallDb).toFixed(1)} dB 手前で止めました。` +
      '一瞬の大きな音が倍率を決めています。「リミッタで山を均す」を入れると届きます。';
    warning.hidden = false;
  } else if (loudnessPlan.limitedBy === 'limiter') {
    warning.textContent =
      `均してよい深さ（${DEFAULT_LIMITER.maxReductionDb} dB）では足りないので、` +
      `${Math.abs(loudnessPlan.shortfallDb).toFixed(1)} dB 手前で止めました。` +
      'ここから先は均したのではなく、その音を消したことになります。';
    warning.hidden = false;
  } else if (loudnessPlan.limitedBy === 'unmeasurable') {
    warning.textContent =
      '鳴っているところが見つからないので、大きさを測れませんでした。何もしていません（倍率は 1 倍）。';
    warning.hidden = false;
  } else {
    warning.hidden = true;
  }

  const ready = !!voice;
  $<HTMLButtonElement>('play-loud-before').disabled = !ready;
  $<HTMLButtonElement>('play-loud-after').disabled = !ready;
  $<HTMLButtonElement>('stop-loud').disabled = !ready;
}

/**
 * 揃える前と後を聴き比べる。
 *
 * 倍率だけなら `GainNode` で当てる。配列を作り直して当てても同じだが、
 * **耳で比べるのに「押した瞬間に鳴る」ほうが大事**で、13 秒ぶんを作り直すと待たされる。
 * リミッタを通したときだけは、倍率が標本ごとに動くので作り直したものを鳴らす
 * （そちらは `refreshLoudness` の時点で作ってある）。
 */
function playLoudness(normalized: boolean) {
  if (!voice) return;
  stopAll();
  const ctx = ensureAudio();
  const node = ctx.createBufferSource();
  if (normalized && limited) {
    const rendered = ctx.createBuffer(voice.buffer.numberOfChannels, voice.buffer.length, voice.buffer.sampleRate);
    // `copyToChannel` ではなく `set` を使う（Float32Array の裏の型が合わないため）。
    for (let c = 0; c < rendered.numberOfChannels; c += 1) rendered.getChannelData(c).set(limited.buffer.getChannelData(c));
    node.buffer = rendered;
    node.connect(ctx.destination);
  } else {
    node.buffer = voice.buffer;
    const gain = ctx.createGain();
    gain.gain.value = normalized && loudnessPlan ? loudnessPlan.gain : 1;
    node.connect(gain).connect(ctx.destination);
  }
  node.start(ctx.currentTime + 0.05);
  playing.push(node);
}

// ---------- クリップごとの音量合わせ ----------

/**
 * 並べたクリップの倍率を決め直して、画面へ出す。
 *
 * **測り直さない**のは「3.」と同じ理由で、ラウドネスは基準にも上限にも依らない
 * （読み込んだときの 1 回で足りる。13 秒で 1 秒近くかかるので、つまみのたびに測ると固まる）。
 * つまみが動かすのは「測った値をどう使うか」だけ。
 */
function refreshClips() {
  const boost = Number($<HTMLInputElement>('clip-boost').value);
  const cut = Number($<HTMLInputElement>('clip-cut').value);
  const useCut = $<HTMLInputElement>('clip-use-cut').checked;
  $<HTMLOutputElement>('out-clip-boost').textContent = `${boost} dB`;
  $<HTMLOutputElement>('out-clip-cut').textContent = `${cut} dB`;

  const stats = $<HTMLDListElement>('clip-stats');
  const warning = $<HTMLParagraphElement>('clip-warning');
  const list = $<HTMLPreElement>('clip-list');
  const ready = clips.length >= 1;
  $<HTMLButtonElement>('play-clips-before').disabled = !ready;
  $<HTMLButtonElement>('play-clips-after').disabled = !ready;
  $<HTMLButtonElement>('stop-clips').disabled = !ready;

  if (!ready) {
    clipPlan = null;
    clipTimeline = [];
    stats.innerHTML = '';
    warning.hidden = true;
    list.textContent = '—';
    return;
  }

  clipPlan = planClipMatch(
    // **読み込んだときの測定を使い回す。** 同じ素材を 2 回測らない。
    clips.map((c) => clipLoudnessFrom(c.name, c.loudness)),
    {
      reference: $<HTMLSelectElement>('clip-reference').value as ClipMatchOptions['reference'],
      maxBoostDb: boost,
      maxCutDb: cut,
    },
  );

  // **ここが `edits.ts` との継ぎ目。** カットした「かけら」に、その素材ぶんの倍率を配る。
  // かけらごとに測り直さないので、同じ素材から出たかけらは必ず同じ倍率になる。
  clipTimeline = [];
  let at = 0;
  for (const clip of clips) {
    const keep = useCut ? cutOf(clip).keep : [{ start: 0, end: clip.buffer.duration }];
    const edits = toClipEdits(keep, { start: at, duration: clip.buffer.duration, sourceIn: 0 });
    for (const edit of attachClipGains(edits, clip.name, clipPlan)) clipTimeline.push({ clip, edit });
    at += edits.reduce((sum, e) => sum + e.duration, 0);
  }

  const lufs = (v: number | null) => (v === null ? '測れません' : `${v.toFixed(1)} LUFS`);
  const capped = clipPlan.gains.filter((g) => g.limitedBy === 'cap');
  const skipped = clipPlan.gains.filter((g) => g.limitedBy === 'tooShort' || g.limitedBy === 'unmeasurable');
  stats.innerHTML = [
    ['クリップ', `${clips.length} 本`],
    ['合わせにいった値', lufs(clipPlan.referenceLufs)],
    // **開きは「揃える前 → 揃えたあと」で並べる。** 片方だけでは良くなったと言えない。
    ['クリップの開き', `${clipPlan.spreadBefore.toFixed(1)} → ${clipPlan.spreadAfter.toFixed(1)} LU`],
    ['タイムライン', `${clipTimeline.length} 本 / ${at.toFixed(2)} 秒`],
    ['上限に当たった', `${capped.length} 本`],
    ['触らなかった', `${skipped.length} 本`],
  ]
    .map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`)
    .join('');

  // 上限に当たったクリップは**そこだけ揃っていない**ので、黙って出さない。
  // 「声の入っていないクリップか」を機械で分ける手は無いので、材料を出して人に決めてもらう。
  if (capped.length * 2 >= clipPlan.gains.length && capped.length > 0) {
    // **半分以上が上限に当たったら、疑うのは個々のクリップではなく基準のほう。**
    // 中央値が守ってくれるのは「まともなクリップが過半数」のときだけで、
    // 外れ値が過半数を占めると**中央値そのものが外れ値に乗る**（画面の検算で踏んだ）。
    warning.textContent =
      `並べた ${clipPlan.gains.length} 本のうち ${capped.length} 本が上限で止まりました。` +
      '**合わせにいった値のほうがずれている可能性があります。**' +
      '声の入っていないクリップや、録音の失敗した 1 本が過半数を占めていませんか？' +
      'そういう並びでは、中央値も平均もそちらに乗ります。';
    warning.hidden = false;
  } else if (capped.length > 0) {
    warning.textContent =
      `${capped.map((g) => `${g.id}（${g.wantedDb > 0 ? '+' : ''}${g.wantedDb.toFixed(1)} dB 欲しかったところを ${g.gainDb > 0 ? '+' : ''}${g.gainDb.toFixed(1)} dB）`).join(' / ')}` +
      ' が上限で止まりました。ほかと 1 桁違う大きさなので、' +
      '**声の入っていないクリップ（部屋の音だけ・b-roll）ではないか**を確かめてください。' +
      '上限を緩めれば揃いますが、声の入っていないクリップも同じだけ持ち上がります。';
    warning.hidden = false;
  } else if (skipped.length > 0) {
    warning.textContent =
      `${skipped.map((g) => `${g.id}（${g.limitedBy === 'tooShort' ? '短すぎる' : '測れない'}）`).join(' / ')}` +
      ' には触っていません（倍率は 1 倍）。短いクリップの値は素材の大きさを表さないためです。';
    warning.hidden = false;
  } else {
    warning.hidden = true;
  }

  list.textContent = [
    ...clipPlan.gains.map(
      (g) =>
        `${g.id}　${lufs(g.lufs)}　→　${g.gainDb >= 0 ? '+' : ''}${g.gainDb.toFixed(2)} dB` +
        `${g.limitedBy === 'none' ? '' : `　［${g.limitedBy}］`}`,
    ),
    '',
    `タイムライン（${useCut ? '自動カットを通した' : 'カットせず並べた'}）`,
    ...clipTimeline.map(
      ({ edit }, i) =>
        `${String(i + 1).padStart(2, ' ')}. ${edit.start.toFixed(2)}〜${(edit.start + edit.duration).toFixed(2)} 秒` +
        `　←　${edit.group} の ${edit.from.start.toFixed(2)}〜${edit.from.end.toFixed(2)} 秒` +
        `　${edit.gainDb >= 0 ? '+' : ''}${edit.gainDb.toFixed(2)} dB`,
    ),
  ].join('\n');
}

/**
 * 並べたクリップを通しで鳴らす。
 *
 * 倍率は `GainNode` で当てる（配列を作り直すと待たされる。「3.」と同じ理由）。
 * **鳴らしているのはタイムラインそのもの**なので、切れ目で段になっていれば耳で分かる。
 */
function playClips(matched: boolean) {
  stopAll();
  const ctx = ensureAudio();
  let at = ctx.currentTime + 0.05;
  for (const { clip, edit } of clipTimeline) {
    if (edit.duration <= 0.01) continue;
    const node = ctx.createBufferSource();
    node.buffer = clip.buffer;
    if (matched && edit.gain !== 1) {
      const gain = ctx.createGain();
      gain.gain.value = edit.gain;
      node.connect(gain).connect(ctx.destination);
    } else {
      node.connect(ctx.destination);
    }
    node.start(at, edit.from.start, edit.from.end - edit.from.start);
    playing.push(node);
    at += edit.duration;
  }
}

// ---------- ダッキング ----------

function refreshDuck() {
  $<HTMLOutputElement>('out-duck').textContent = `${$<HTMLInputElement>('duck-db').value} dB`;
  $<HTMLOutputElement>('out-hold').textContent = `${Number($<HTMLInputElement>('hold').value).toFixed(2)} 秒`;
  $<HTMLOutputElement>('out-release').textContent = `${Number($<HTMLInputElement>('release').value).toFixed(2)} 秒`;

  duckPoints = voice
    ? planDucking(voice.track, {
        duckDb: Number($<HTMLInputElement>('duck-db').value),
        hold: Number($<HTMLInputElement>('hold').value),
        release: Number($<HTMLInputElement>('release').value),
      })
    : [];
  drawBgm();

  const ready = !!(voice && bgm);
  $<HTMLButtonElement>('play-mix').disabled = !ready;
  $<HTMLButtonElement>('play-flat').disabled = !ready;
}

function playMix(ducked: boolean) {
  if (!bgm) return;
  stopAll();
  const ctx = ensureAudio();
  const at = ctx.currentTime + 0.05;

  const bgmNode = ctx.createBufferSource();
  bgmNode.buffer = bgm.buffer;
  const gain = ctx.createGain();
  // BGM は元から少し下げておく（下げないと声より大きくて比べにくい）。
  gain.gain.value = 0.6;
  bgmNode.connect(gain).connect(ctx.destination);
  if (ducked && duckPoints.length) {
    gain.gain.setValueAtTime(0.6, at);
    // planDucking は 0〜1 を返すので、BGM の基準音量を掛けてから流す。
    applyDucking(
      gain.gain,
      duckPoints.map((p) => ({ time: p.time, gain: p.gain * 0.6 })),
      at,
    );
  }
  bgmNode.start(at);
  playing.push(bgmNode);

  if (voice) {
    const voiceNode = ctx.createBufferSource();
    voiceNode.buffer = voice.buffer;
    voiceNode.connect(ctx.destination);
    voiceNode.start(at);
    playing.push(voiceNode);
  }
}

// ---------- 配線 ----------

bindFile('voice-file', 'voice-status', $<HTMLCanvasElement>('voice-canvas'), (loaded) => {
  voice = loaded;
  $<HTMLButtonElement>('play-original').disabled = false;
  $<HTMLButtonElement>('play-cut').disabled = false;
  $<HTMLButtonElement>('stop-voice').disabled = false;
  refreshCut();
});

bindFile('bgm-file', 'bgm-status', $<HTMLCanvasElement>('bgm-canvas'), (loaded) => {
  bgm = loaded;
  $<HTMLButtonElement>('play-bgm').disabled = false;
  $<HTMLButtonElement>('stop-mix').disabled = false;
  refreshDuck();
});

/**
 * 「4.」は**複数まとめて**読み込む。1 本 1 クリップとして並べる。
 *
 * 1 本ずつ読むので、途中で読めないものがあっても残りは並ぶ
 * （まとめて失敗させると、どれが悪いのか分からなくなる）。
 */
$<HTMLInputElement>('clip-files').addEventListener('change', async (event) => {
  const files = Array.from((event.target as HTMLInputElement).files ?? []);
  if (files.length === 0) return;
  const status = $<HTMLParagraphElement>('clip-status');
  status.className = 'status';
  status.textContent = `${files.length} 本を読み込んでいます…`;
  const loaded: Loaded[] = [];
  const failed: string[] = [];
  for (const file of files) {
    try {
      loaded.push(await load(file, $<HTMLCanvasElement>('voice-canvas')));
    } catch {
      failed.push(file.name);
    }
  }
  clips = loaded;
  status.className = failed.length > 0 ? 'status error' : 'status';
  status.textContent =
    `${loaded.length} 本を読み込みました（合計 ${loaded.reduce((sum, c) => sum + c.buffer.duration, 0).toFixed(2)} 秒）` +
    (failed.length > 0 ? ` ／ 読めなかった: ${failed.join(' / ')}` : '');
  refreshClips();
});

for (const id of ['sensitivity', 'min-silence', 'padding', 'speech-threshold', 'envelope-hold', 'speech-lead-in']) {
  $<HTMLInputElement>(id).addEventListener('input', refreshCut);
}
// 「4.」のつまみは、カットには関係しないので `refreshClips` だけを呼ぶ。
for (const id of ['clip-boost', 'clip-cut', 'clip-use-cut', 'clip-reference']) {
  $<HTMLElement>(id).addEventListener(id === 'clip-reference' ? 'change' : 'input', refreshClips);
}
for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="mode"]')) {
  radio.addEventListener('change', refreshCut);
}
for (const id of ['duck-db', 'hold', 'release']) {
  $<HTMLInputElement>(id).addEventListener('input', refreshDuck);
}
for (const id of ['target-lufs', 'ceiling-db', 'use-limiter', 'lookahead-ms']) {
  $<HTMLInputElement>(id).addEventListener('input', refreshLoudness);
}

$<HTMLButtonElement>('play-original').addEventListener('click', () => {
  if (voice) playRanges(voice, [{ start: 0, end: voice.buffer.duration }]);
});
$<HTMLButtonElement>('play-cut').addEventListener('click', () => {
  if (voice && plan) playRanges(voice, plan.keep);
});
$<HTMLButtonElement>('stop-voice').addEventListener('click', stopAll);
$<HTMLButtonElement>('stop-mix').addEventListener('click', stopAll);
$<HTMLButtonElement>('play-bgm').addEventListener('click', () => {
  if (bgm) playRanges(bgm, [{ start: 0, end: bgm.buffer.duration }]);
});
$<HTMLButtonElement>('play-mix').addEventListener('click', () => playMix(true));
$<HTMLButtonElement>('play-flat').addEventListener('click', () => playMix(false));
$<HTMLButtonElement>('play-loud-before').addEventListener('click', () => playLoudness(false));
$<HTMLButtonElement>('play-loud-after').addEventListener('click', () => playLoudness(true));
$<HTMLButtonElement>('stop-loud').addEventListener('click', stopAll);
$<HTMLButtonElement>('play-clips-before').addEventListener('click', () => playClips(false));
$<HTMLButtonElement>('play-clips-after').addEventListener('click', () => playClips(true));
$<HTMLButtonElement>('stop-clips').addEventListener('click', stopAll);

$<HTMLButtonElement>('run-tests').addEventListener('click', () => {
  const results = runSelfTest();
  $<HTMLUListElement>('test-results').innerHTML = results
    .map((r) => `<li class="${r.ok ? 'pass' : 'fail'}"><b>${r.ok ? 'PASS' : 'FAIL'}</b><span>${r.name}</span><span>${r.detail}</span></li>`)
    .join('');
});

window.addEventListener('resize', () => {
  drawVoice();
  drawBgm();
});

// 「4.」の既定は `clip-match.ts` が持っている。**画面に直書きしたままにすると黙って食い違う**ので、
// 起動時にそちらから写す（HTML に書いてある値は、この行が動く前の見た目のため）。
$<HTMLInputElement>('clip-boost').value = String(DEFAULT_CLIP_MATCH.maxBoostDb);
$<HTMLInputElement>('clip-cut').value = String(DEFAULT_CLIP_MATCH.maxCutDb);
if (typeof DEFAULT_CLIP_MATCH.reference === 'string') {
  $<HTMLSelectElement>('clip-reference').value = DEFAULT_CLIP_MATCH.reference;
}

refreshCut();
refreshDuck();
refreshLoudness();
refreshClips();

// Playwright から呼べるようにしておく（画面を触らずに中身を確かめるため）。
declare global {
  interface Window {
    __lab: {
      selfTest: typeof runSelfTest;
      state: () => {
        voice: number | null;
        bgm: number | null;
        plan: JetCutPlan | null;
        duckPoints: GainPoint[];
        loudness: LoudnessMeasurement | null;
        loudnessPlan: NormalizationPlan | null;
        limiter: LimiterReport | null;
        clipPlan: ClipMatchPlan | null;
        clipTimeline: MatchedClipEdit[];
      };
    };
  }
}
window.__lab = {
  selfTest: runSelfTest,
  state: () => ({
    voice: voice?.buffer.duration ?? null,
    bgm: bgm?.buffer.duration ?? null,
    plan,
    duckPoints,
    loudness: voice?.loudness ?? null,
    loudnessPlan,
    limiter: limited?.report ?? null,
    clipPlan,
    // `Loaded`（AudioBuffer 込み）は JSON にできないので、かけらだけを出す。
    clipTimeline: clipTimeline.map(({ edit }) => edit),
  }),
};
