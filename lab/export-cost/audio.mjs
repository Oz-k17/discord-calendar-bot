/**
 * 音の側の先払い（`renderAudioMix`）を実測する。
 *
 *   npm run lab:export:audio
 *   LAB_AU_SECONDS=13,26,52 npm run lab:export:audio   # 尺を振る（比例するかを見る）
 *   LAB_AU_WINDOW=1 npm run lab:export:audio           # 窓の幅（秒）
 *   LAB_AU_REPEAT=3 npm run lab:export:audio           # 繰り返す回数（中央値を取る）
 *
 * ## 2 段ある（`bench.mjs` と同じ形）
 *
 * 1. **数え上げ**（ブラウザ不要）。何バイト抱えるか・何回複製するか。
 *    音の先払いは**尺と素材の尺だけで決まる**ので、ここは端末に依らない。
 * 2. **実測**（ブラウザ）。起こす・混ぜる・切り出す・渡すに何ミリ秒かかるか。
 *
 * ## なぜ音を測るのか
 *
 * 9/26（1 回目・2 回目）に映像の側は測ったが、音は 1 秒も測っていなかった。
 * 本体は**映像の 1 コマ目を描く前に**タイムライン全体の音を 1 本に混ぜているので、
 * ここは丸ごと先払いで、しかも**その間ずっと進捗は 0%** のまま。
 * 尺に比例するなら、長尺ではここが効く。
 *
 * ## 比べる相手は「窓に割る」形
 *
 * 置き方は一括も窓割りも `src/audio-mix.ts` の同じ道から出している（`windowSounds`）。
 * 差は窓の切り方だけなので、**出てきた差は窓のせい**だと言える。
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { launch, loadPlaywright, serve } from '../browser.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

const { AUDIO_CHUNK_SECONDS, splitAudioSequence, summarizeAudioCost } = await import('./src/audio-mix.ts');

const windowSeconds = Number(process.env.LAB_AU_WINDOW ?? AUDIO_CHUNK_SECONDS);
// 1 回が 100ms 台なので、映像の側（3 回）より多く回す。
// 段ごとの時間が 10ms 台だと、ゴミ集めの波 1 つで順位がひっくり返る。
const repeat = Number(process.env.LAB_AU_REPEAT ?? 5);
const lengths = (process.env.LAB_AU_SECONDS ?? '13,26,52').split(',').map(Number);
for (const s of lengths) if (!(s > 0)) throw new Error(`LAB_AU_SECONDS は正の数の並びです（${s}）`);

/** 素材の尺（秒）。これを超える尺は、素材を頭から取り直すクリップに割って埋める。 */
const ASSET_SECONDS = 13;
/**
 * 尺を埋めるのに要るクリップの本数。
 *
 * **ここを 1 本のままにして 1 度踏んだ。** 素材 13 秒のまま尺だけ 52 秒に伸ばすと、
 * 13 秒より後ろの窓には置く音が無く（素材の端を越えるので）、**残り 39 秒は無音を混ぜていた。**
 * 尺を振ったつもりで「無音の割合」を振っていたことになる。
 */
const piecesFor = (seconds) => Math.max(1, Math.ceil(seconds / ASSET_SECONDS));

const pad = (s, n) => String(s).padEnd(n, ' ');
const right = (s, n) => String(s).padStart(n, ' ');
const mib = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)}MB`;
const mid = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];

// ---------- 1. 数え上げ（ブラウザ不要） ----------

console.log(`音の先払い ・ 窓 ${windowSeconds} 秒 ・ 48kHz 2ch\n`);
console.log('## 抱えるバイト（時計を使わない）\n');
console.log(
  `${pad('尺', 10)}${right('ミックス', 11)}${right('複製', 7)}${right('一括の山', 11)}${right('窓の山', 10)}${right('一括 ÷ 窓', 11)}`,
);
for (const seconds of [13, 60, 600, 3600]) {
  // 素材の尺は 13 秒のまま（起こす側は尺に依らないので、ミックスの伸びだけが出る）。
  const stats = summarizeAudioCost(splitAudioSequence({ seconds, assetSeconds: 13 }), { windowSeconds });
  console.log(
    `${pad(`${seconds} 秒`, 10)}${right(mib(stats.mixBytes), 11)}${right(`${stats.sliceCopies} 回`, 7)}${right(mib(stats.peakBytes), 11)}${right(mib(stats.windowPeakBytes), 10)}${right(`${stats.memoryRatio.toFixed(0)} 倍`, 11)}`,
  );
}
console.log(
  '\n**ミックスの入れ物は尺だけで決まる**（48000 × 2ch × 4 バイト ＝ 1 秒 384KB）。\n' +
    '窓に割った側は窓の幅で頭打ちになるので、尺が伸びても山は動かない。\n',
);

console.log('## 起こす素材は「使う秒」では決まらない\n');
console.log(`${pad('形', 26)}${right('使う秒', 9)}${right('起こす秒', 10)}${right('起こすバイト', 14)}`);
for (const [label, assetSeconds, seconds] of [
  ['13 秒の素材を丸ごと', 13, 13],
  ['10 分の素材から 10 秒', 600, 10],
  ['1 時間の素材から 10 秒', 3600, 10],
]) {
  const stats = summarizeAudioCost(splitAudioSequence({ seconds, assetSeconds }), { windowSeconds });
  console.log(
    `${pad(label, 26)}${right(`${stats.usedSeconds.toFixed(0)}s`, 9)}${right(`${stats.decodedSeconds.toFixed(0)}s`, 10)}${right(mib(stats.decodedBytes), 14)}`,
  );
}
console.log(
  '\n**`decodeAssetAudio` は素材まるごとを起こす。** クリップが 10 秒しか使っていなくても、\n' +
    '1 時間の素材なら 1 時間ぶんが乗る。窓に割ってもここは減らない（減るのはミックスの側だけ）。\n',
);

// ---------- 2. 実測（ブラウザ） ----------

const playwright = loadPlaywright();
if (!playwright) {
  console.log('playwright が見つからないので実測は飛ばします（数え上げは上に出ています）。');
  process.exit(0);
}

const server = await serve(here);
const browser = await launch(playwright);
let failed = 0;
const ok = (label, condition, detail = '') => {
  if (!condition) failed += 1;
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? `  :: ${detail}` : ''}`);
};

try {
  const page = await (await browser.newContext()).newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto(server.url, { waitUntil: 'networkidle' });
  await page.addScriptTag({ type: 'module', url: './testkit/audio.ts' });
  await page.waitForFunction(() => typeof window.__labAudioMeasure === 'function', null, { timeout: 60000 });

  const run = (options) => page.evaluate((o) => window.__labAudioMeasure(o), options);

  /**
   * 設定を**交互に**回して、それぞれの中央値を返す（`bench.mjs` の `runInterleaved` と同じ）。
   *
   * 9/26（2 回目）に、固めて測ると 5% 前後の差が振れ幅に化けると分かっている。
   * 音の側は 1 回が 100ms 台なので、なおさら塊を作らない。
   */
  const runInterleaved = async (cases, rounds = repeat) => {
    for (const c of cases) await run(c);
    const got = cases.map(() => []);
    for (let round = 0; round < rounds; round += 1) {
      const order = cases.map((_, i) => (round % 2 === 0 ? i : cases.length - 1 - i));
      for (const i of order) got[i].push(await run(cases[i]));
    }
    // **段ごとに中央値を取る。** 「合計が中央値だった回」を 1 回選ぶ形だと、
    // 段の数字はその 1 回の当たり外れをそのまま持ってくる（合計 10ms 台では順位が入れ替わる）。
    return got.map((runs) => {
      const totals = runs.map((r) => r.totalMs);
      const byStage = {};
      for (const key of ['decodeMs', 'mixMs', 'sliceMs', 'encodeMs', 'finalizeMs', 'totalMs']) {
        byStage[key] = mid(runs.map((r) => r[key]));
      }
      return { ...runs[0], ...byStage, spread: (Math.max(...totals) - Math.min(...totals)) / mid(totals), totals };
    });
  };

  // ページぜんたいの暖機。**設定ごとの 1 回捨てでは足りない**（`bench.mjs` の注）。
  for (let i = 0; i < 2; i += 1) await run({ seconds: 13, mode: 'one-shot', encode: true });

  // --- 段ごとの時間（一括 対 窓割り） ---
  // **「先払い」は起こす＋混ぜるだけ。** 本体は映像の 1 コマ目より先にそこまでを済ませ、
  // 切り出す・渡す・仕上げは映像の輪と一緒に進む（`pushAudioUpTo` がコマごとに呼ばれる）。
  // 段を全部足した数を「先払い」と書くと、映像と並んで進む仕事まで数えてしまう。
  console.log('## 段ごとの時間（出力まで渡す ・ 交互に回した中央値）\n');
  const stageCases = [];
  for (const seconds of [13, 52]) {
    const pieces = piecesFor(seconds);
    stageCases.push({ seconds, pieces, mode: 'one-shot', encode: true });
    stageCases.push({ seconds, pieces, mode: 'windowed', windowSeconds, encode: true });
  }
  const staged = await runInterleaved(stageCases);
  console.log(
    `${pad('尺', 8)}${pad('やり方', 12)}${right('起こす', 9)}${right('混ぜる', 9)}${right('切り出す', 10)}${right('渡す', 8)}${right('仕上げ', 8)}${right('合計 ms', 10)}${right('先払い ms', 11)}${right('山', 9)}${right('振れ幅', 9)}`,
  );
  for (const r of staged) {
    console.log(
      `${pad(`${r.seconds} 秒`, 8)}${pad(r.mode, 12)}${right(r.decodeMs.toFixed(0), 9)}${right(r.mixMs.toFixed(0), 9)}${right(r.sliceMs.toFixed(0), 10)}${right(r.encodeMs.toFixed(0), 8)}${right(r.finalizeMs.toFixed(0), 8)}${right(r.totalMs.toFixed(0), 10)}${right((r.decodeMs + r.mixMs).toFixed(0), 11)}${right(mib(r.peakMixBytes), 9)}${right(`${(r.spread * 100).toFixed(1)}%`, 9)}`,
    );
  }
  const long = staged[staged.length - 2];
  console.log(
    `\n渡した回数 ${staged[0].deliveries} / ${staged[1].deliveries} 回（13 秒）・ 標本 ${staged[0].deliveredSamples} / ${staged[1].deliveredSamples} 個 ・ ` +
      `音源を組んだ回数 ${staged[0].placements} / ${staged[1].placements} 回\n` +
      '**窓割りでは切り出しが 1 回も要らない**（混ざった窓をそのまま渡せる）。\n' +
      `**先払い（起こす＋混ぜる）は 1 秒あたり ${((long.decodeMs + long.mixMs) / long.seconds).toFixed(2)}ms** なので、` +
      `10 分で ${(((long.decodeMs + long.mixMs) / long.seconds) * 600 / 1000).toFixed(1)}s ・ ` +
      `1 時間で ${(((long.decodeMs + long.mixMs) / long.seconds) * 3600 / 1000).toFixed(1)}s。\n` +
      'その間ずっと**進捗は 0%** のまま（映像の 1 コマ目より先に音を作るので）。\n' +
      `仕上げが ${((long.finalizeMs / long.totalMs) * 100).toFixed(0)}% を占めているが、**そこは先払いではない**` +
      '（本体では映像と同じ 1 回の `finalize` に混ざる）。\n',
  );

  // --- 尺を振る（比例するか・窓の幅で混ぜる時間がどう動くか） ---
  // **ここは出力へ渡さない。** 渡す側（Opus）と仕上げが合計の 7 割を占めるので、
  // 混ぜるところの伸びがその振れに埋まる。先払いのうち「尺に比例する部分」を見たいので、
  // 起こす・混ぜる・切り出すだけで測る。
  console.log('## 尺を振る（混ぜるところだけ・出力へ渡さない）\n');
  console.log(
    `${pad('尺', 8)}${pad('やり方', 16)}${right('混ぜる ms', 11)}${right('切り出す ms', 13)}${right('1 秒あたり', 12)}${right('山', 9)}${right('音源を組む', 12)}`,
  );
  const scaleCases = [];
  for (const seconds of lengths) {
    const pieces = piecesFor(seconds);
    scaleCases.push({ seconds, pieces, mode: 'one-shot' });
    scaleCases.push({ seconds, pieces, mode: 'windowed', windowSeconds });
    scaleCases.push({ seconds, pieces, mode: 'windowed', windowSeconds: 5 });
  }
  const scaled = await runInterleaved(scaleCases, repeat);
  for (let i = 0; i < scaleCases.length; i += 1) {
    const r = scaled[i];
    const label = scaleCases[i].mode === 'one-shot' ? 'one-shot' : `windowed ${scaleCases[i].windowSeconds}s`;
    const scaling = r.mixMs + r.sliceMs;
    console.log(
      `${pad(`${r.seconds} 秒`, 8)}${pad(label, 16)}${right(r.mixMs.toFixed(0), 11)}${right(r.sliceMs.toFixed(0), 13)}${right((scaling / r.seconds).toFixed(2), 12)}${right(mib(r.peakMixBytes), 9)}${right(`${r.placements} 回`, 12)}`,
    );
  }
  const perSecond = scaled.map((r) => (r.mixMs + r.sliceMs) / r.seconds);
  console.log(
    `\n**1 秒あたりが尺で動かなければ、先払いは尺に比例している**（伸びるほど不利になる）。\n` +
      `1 秒あたりの振れ幅 ${(((Math.max(...perSecond) - Math.min(...perSecond)) / mid(perSecond)) * 100).toFixed(1)}%\n`,
  );

  // --- 出来上がりの照合（わざと壊した相手つき） ---
  console.log('## 渡した波の照合\n');
  /**
   * 指紋を区画ごとに突き合わせる。返すのは**開きがいちばん大きかった区画**の値。
   *
   * 平均へ畳まない。9/26（2 回目）に映像の側で、平均に畳むと 1 コマずれた相手が
   * 素通りすると 2 回踏んでいる（音は区画が 512 標本なので、なおさら埋まる）。
   */
  const compare = (a, b) => {
    if (a.length !== b.length || a.length === 0) return { blocks: 0, worst: Infinity, differing: Infinity };
    let worst = 0;
    let differing = 0;
    for (let i = 0; i < a.length; i += 2) {
      const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]));
      if (d > worst) worst = d;
      // 16bit の 1 段（1/32768 ≒ 3e-5）より大きい開きを「違う」と数える。
      if (d > 3e-5) differing += 1;
    }
    return { blocks: a.length / 2, worst, differing };
  };

  const truth = await run({ seconds: 13, mode: 'one-shot', verify: true });
  for (const [label, options] of [
    ['窓 1 秒', { seconds: 13, mode: 'windowed', windowSeconds: 1, verify: true }],
    ['窓 0.37 秒', { seconds: 13, mode: 'windowed', windowSeconds: 0.37, verify: true }],
    ['窓 5 秒', { seconds: 13, mode: 'windowed', windowSeconds: 5, verify: true }],
    ['5 つに割った素材・窓 1 秒', { seconds: 13, pieces: 5, mode: 'windowed', windowSeconds: 1, verify: true }],
  ]) {
    const reference = options.pieces
      ? await run({ seconds: 13, pieces: options.pieces, mode: 'one-shot', verify: true })
      : truth;
    const r = await run(options);
    const c = compare(reference.signature, r.signature);
    ok(
      `${label}に割っても、渡す波は一括と同じ`,
      c.differing === 0 && c.worst < 3e-5,
      `違う区画 ${c.differing} / ${c.blocks} ・ 最大の開き ${c.worst.toExponential(2)}`,
    );
  }

  // **わざと壊して落ちることまで確かめる。** 素材内の位置を進めない窓割り。
  const broken = await run({ seconds: 13, mode: 'windowed-broken', windowSeconds: 1, verify: true });
  const brokenGap = compare(truth.signature, broken.signature);
  ok(
    '照合は、素材内の位置を進めない窓割りでちゃんと落ちる',
    brokenGap.differing > brokenGap.blocks * 0.5,
    `違う区画 ${brokenGap.differing} / ${brokenGap.blocks} ・ 最大の開き ${brokenGap.worst.toExponential(2)}`,
  );

  // **本体と同じ書き方（利得の初期値を入れない）だと、クリップの頭で 1 標本漏れる。**
  // 窓割りとは関係なく一括のままでも出るので、同じ一括どうしで突き合わせて切り離す。
  // ここが PASS なのは「漏れを再現できている」という意味で、直すべきなのは本体の側。
  console.log('');
  const leaked = await run({ seconds: 13, pieces: 5, mode: 'one-shot', verify: true, leakDefaultGain: true });
  const fixed = await run({ seconds: 13, pieces: 5, mode: 'one-shot', verify: true });
  const leakGap = compare(fixed.signature, leaked.signature);
  ok(
    '本体と同じ書き方（利得の初期値を入れない）だと、クリップの頭で利得 1.0 が漏れる',
    leakGap.differing > 0,
    `違う区画 ${leakGap.differing} / ${leakGap.blocks} ・ 最大の開き ${leakGap.worst.toExponential(2)}`,
  );

  // 素材が 48kHz でないとき。混ぜる側で補間が入るので、**窓の境目で位相が揃わない恐れがある**。
  // ここは「揃わないはず」という見立てを測りにいく側で、壊れたら窓割りの前提が 1 つ崩れる。
  console.log('');
  const oddTruth = await run({ seconds: 13, assetSampleRate: 44100, mode: 'one-shot', verify: true });
  const oddSplit = await run({
    seconds: 13,
    assetSampleRate: 44100,
    mode: 'windowed',
    windowSeconds: 1,
    verify: true,
  });
  const oddGap = compare(oddTruth.signature, oddSplit.signature);
  ok(
    '44.1kHz の素材でも、窓に割って同じ波になる（補間の位相が窓で切れない）',
    oddGap.differing === 0 && oddGap.worst < 3e-5,
    `違う区画 ${oddGap.differing} / ${oddGap.blocks} ・ 最大の開き ${oddGap.worst.toExponential(2)}`,
  );

  ok('画面側でエラーが出ていない', errors.length === 0, errors.slice(0, 3).join(' / '));
} finally {
  await browser.close();
  server.stop();
}

console.log(failed > 0 ? `\n${failed} 件が失敗しています。` : '\n照合はすべて通りました。');
if (failed > 0) process.exit(1);
