/**
 * 書き出しが「どこで時間を使っているか」を実測する。
 *
 *   npm run lab:export
 *   LAB_EX_SCALE=4 npm run lab:export     # 小さい絵で測る（1024×576 → 512×288）
 *   LAB_EX_FPS=60 npm run lab:export      # 書き出しの速さを変える
 *   LAB_EX_PIECES=5 npm run lab:export    # 1 本の素材を 5 つに割ったタイムラインで測る
 *   LAB_EX_REPEAT=5 npm run lab:export    # 繰り返す回数（既定 3・中央値を取る）
 *
 * ## 2 段ある
 *
 * 1. **数え上げ**（ブラウザ不要）。何枚デコードして、デコーダを何回開き直すか。
 *    ここは時計を持ち出さずに分かるので、先に出す。
 * 2. **実測**（ブラウザ）。デコード・描画・エンコードの段ごとに時計を当てる。
 *
 * ## 1 回目は捨てる（2026-09-26 に踏んだ）
 *
 * 同じ設定でも**1 回目だけ 1.8 倍遅い**（1.97s 対 1.08s）。コーデックの初期化と JIT が
 * 最初の回に乗るため。ここを捨てずに並べると、**やり方の差**のつもりで
 * **暖機の差**を読むことになる（9/25・2 回目に同じ穴を踏んでいる）。
 * なので、どの回も「捨てる 1 回 → 数える N 回」で回し、中央値と振れ幅を並べて出す。
 *
 * **捨てる 1 回では足りなかった。** 設定ごとに 1 回捨てても、ページが冷えている
 * いちばん最初の塊だけは 1.78 / 1.24 / 0.85s と振れ幅 75% で出る（同じ設定を
 * 後ろで測ると 0.88s・18%）。暖機はデコーダごとではなくページ全体に効くので、
 * **測り始める前に丸ごと 2 回空回し**してから入る。
 *
 * ## ミリ秒そのものを持ち越さないこと
 *
 * 確認用のブラウザには GPU が無い（`browser.mjs` の swiftshader）ので、
 * VP8/VP9 は丸ごとソフトウェアで回る。**絶対値は端末とコーデックの話**でしかない。
 * 記録に残して意味があるのは**段の取り分**と、**手を替えたときの前後比**。
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { launch, loadPlaywright, serve } from '../browser.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

const { planExportWork, splitSequence, summarizePlan } = await import('./src/plan.ts');
const { projectOverlap, projectSpeedup, summarizeRun } = await import('./src/cost.ts');

// 既定を 8（1024×576）にしてあるのは、**小さい絵では振れ幅が答えを隠す**から（2026-09-26）。
// 512×288 では 4 つのやり方が 1.17〜1.29 倍と団子になり、振れ幅（18〜30%）の中に埋まる。
// 1024×576 なら振れ幅 7〜13% に対して 1.00 / 1.29 / 1.53 / 1.69 と順に並ぶ。
// 本物の書き出しは 1080p なので、そちらに近いほうでもある。
const scale = Number(process.env.LAB_EX_SCALE ?? 8);
const fps = Number(process.env.LAB_EX_FPS ?? 30);
const pieces = Number(process.env.LAB_EX_PIECES ?? 1);
const fixture = process.env.LAB_EX_FIXTURE ?? 'cuts-plain';
const repeat = Number(process.env.LAB_EX_REPEAT ?? 3);

const pad = (s, n) => String(s).padEnd(n, ' ');
const right = (s, n) => String(s).padStart(n, ' ');
const pct = (x) => `${(x * 100).toFixed(1)}%`;
const mid = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];

// ---------- 1. 数え上げ（ブラウザ不要） ----------

console.log(`素材 ${fixture} ・ 書き出し ${fps}fps ・ 割る本数を振る\n`);
console.log('## 仕事の数え上げ（時計を使わない）\n');
console.log(
  `${pad('割る本数', 10)}${right('コマ', 6)}${right('デコード', 10)}${right('開く', 6)}${right('開き直し', 10)}${right('同時', 6)}${right('重複コマ', 10)}`,
);
for (const n of [1, 2, 5, 20]) {
  const seq = splitSequence({ mediaId: fixture, duration: 13, pieces: n, assetDuration: 13 });
  const stats = summarizePlan(planExportWork(seq, fps), { sourceFps: 15 });
  console.log(
    `${pad(`${n} 本`, 10)}${right(stats.totalFrames, 6)}${right(stats.decodeCalls, 10)}${right(stats.decoderOpens, 6)}${right(stats.redundantOpens, 10)}${right(stats.maxConcurrentDecoders, 6)}${right(stats.repeatedSourceFrames, 10)}`,
  );
}
console.log(
  '\n**割っても出来上がりは 1 ビットも変わらない。増えるのは「開き直し」だけ。**\n' +
    '「重複コマ」は素材 15fps に対して 30fps で書き出しているぶん（同じ素材コマを 2 回要求している）。\n',
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
  await page.addScriptTag({ type: 'module', url: './testkit/measure.ts' });
  await page.waitForFunction(() => typeof window.__labExportMeasure === 'function', null, { timeout: 60000 });

  const run = (options) =>
    page.evaluate(
      (o) =>
        window.__labExportMeasure(o).then((r) => ({
          mode: r.mode,
          frames: r.frames,
          wallMs: r.wallMs,
          openMs: r.openMs,
          opens: r.opens,
          samples: r.samples,
          digests: r.digests,
          width: r.width,
          height: r.height,
          bytes: r.bytes,
        })),
      options,
    );

  /** 捨てる 1 回 → 数える N 回。返すのは**壁時計が中央値だった回**と、その振れ幅。 */
  const runRepeated = async (options) => {
    await run(options);
    const runs = [];
    for (let i = 0; i < repeat; i += 1) runs.push(await run(options));
    const walls = runs.map((r) => r.wallMs);
    const target = mid(walls);
    const picked = runs.find((r) => r.wallMs === target) ?? runs[0];
    return { ...picked, spread: (Math.max(...walls) - Math.min(...walls)) / target, runs: walls };
  };

  // ページぜんたいの暖機。**設定ごとの 1 回捨てでは足りない**（上の注を参照）。
  for (let i = 0; i < 2; i += 1) await run({ fixture, scale, fps, pieces, mode: 'at-timestamps' });

  // --- 段ごとの取り分（いまの本体と同じ形） ---
  const base = await runRepeated({ fixture, scale, fps, pieces, mode: 'at-timestamps' });
  const baseSummary = summarizeRun(base.samples, base.wallMs);

  console.log(`## 段ごとの取り分（${base.width}×${base.height} ・ ${base.frames} コマ ・ ${repeat} 回の中央値）\n`);
  console.log(`${pad('段', 10)}${right('合計 ms', 10)}${right('1 コマ ms', 12)}${right('中央値 ms', 12)}${right('取り分', 10)}`);
  for (const stage of ['decode', 'draw', 'encode']) {
    const s = baseSummary.stages[stage];
    console.log(
      `${pad(stage, 10)}${right(s.sum.toFixed(0), 10)}${right(s.mean.toFixed(2), 12)}${right(s.median.toFixed(2), 12)}${right(pct(s.share), 10)}`,
    );
  }
  console.log(
    `${pad('other', 10)}${right(baseSummary.other.sum.toFixed(0), 10)}${right(baseSummary.other.mean.toFixed(2), 12)}${right('—', 12)}${right(pct(baseSummary.other.share), 10)}`,
  );
  console.log(
    `\n壁時計 ${(base.wallMs / 1000).toFixed(2)}s ・ ${baseSummary.fps.toFixed(1)} コマ/秒 ・ ` +
      `実時間の ${(base.frames / fps / (base.wallMs / 1000)).toFixed(2)} 倍速 ・ ` +
      `デコーダを開くのに ${base.openMs.toFixed(0)}ms（${base.opens} 回）\n` +
      `振れ幅 ${pct(base.spread)}（${base.runs.map((w) => (w / 1000).toFixed(2)).join(' / ')}s）\n`,
  );

  // --- 手を入れる前に、上限を出す ---
  console.log('## その段に手を入れて得られる上限（直列のまま）\n');
  console.log(`${pad('段', 10)}${right('タダにしたら', 14)}${right('2 倍にしたら', 14)}`);
  for (const stage of ['decode', 'draw', 'encode']) {
    console.log(
      `${pad(stage, 10)}${right(`${projectSpeedup(baseSummary, stage, Infinity).toFixed(2)} 倍`, 14)}${right(`${projectSpeedup(baseSummary, stage, 2).toFixed(2)} 倍`, 14)}`,
    );
  }
  console.log(
    `\nデコードとエンコードを重ねられたら ${projectOverlap(baseSummary, 'decode', 'encode').toFixed(2)} 倍（上限）。\n`,
  );

  // --- デコーダの開き方を替えて並べる ---
  console.log('## デコーダの開き方を替える\n');
  console.log(
    `${pad('やり方', 16)}${right('壁時計 s', 10)}${right('コマ/秒', 10)}${right('decode ms', 11)}${right('encode ms', 11)}${right('振れ幅', 10)}${right('前と比べ', 10)}`,
  );
  const rows = [['at-timestamps', base, baseSummary]];
  for (const mode of ['pool', 'sequential', 'sequential-pool', 'auto']) {
    const r = await runRepeated({ fixture, scale, fps, pieces, mode });
    rows.push([mode, r, summarizeRun(r.samples, r.wallMs)]);
  }
  for (const [name, r, s] of rows) {
    console.log(
      `${pad(name, 16)}${right((r.wallMs / 1000).toFixed(2), 10)}${right(s.fps.toFixed(1), 10)}${right(s.stages.decode.sum.toFixed(0), 11)}${right(s.stages.encode.sum.toFixed(0), 11)}${right(pct(r.spread), 10)}${right(`${(base.wallMs / r.wallMs).toFixed(2)} 倍`, 10)}`,
    );
  }

  console.log(
    '\n**取り分は「その段が重い」ではなく「そこで待たされた」を測っている。**\n' +
      'デコードを速くしても壁時計が同じだけ縮まないときは、待ちがエンコードの側へ移っている\n' +
      '（`videoSource.add()` はエンコーダが詰まっていれば返ってこない）。',
  );

  // --- 割ったときの開き直しを、素材ごとにまとめたら ---
  console.log('\n## 1 本の素材を割ったとき（開き直しの代価）\n');
  console.log(
    `${pad('割る本数', 10)}${pad('やり方', 16)}${right('壁時計 s', 10)}${right('開く回数', 10)}${right('開く ms', 10)}${right('decode ms', 11)}${right('振れ幅', 10)}`,
  );
  for (const n of [1, 5, 20]) {
    for (const mode of ['at-timestamps', 'shared', 'auto']) {
      if (n === 1 && mode === 'shared') continue;
      const r = await runRepeated({ fixture, scale, fps, pieces: n, mode });
      const s = summarizeRun(r.samples, r.wallMs);
      console.log(
        `${pad(`${n} 本`, 10)}${pad(mode, 16)}${right((r.wallMs / 1000).toFixed(2), 10)}${right(r.opens, 10)}${right(r.openMs.toFixed(0), 10)}${right(s.stages.decode.sum.toFixed(0), 11)}${right(pct(r.spread), 10)}`,
      );
    }
  }
  console.log(
    '\n**開き直しの代価は「開く時間」には出ない。** 開いた直後のデコードのほうが重くなる\n' +
      '（鍵コマから読み直すので）。`開く ms` だけを見ると小さく見えるのが落とし穴。',
  );

  // --- 自分の手を潰す: 速い再生（素材のコマを飛ばしながら読む） ---
  console.log('\n## 速い再生（飛ばして読む側）\n');
  console.log(
    `${pad('速さ', 8)}${pad('やり方', 16)}${right('コマ', 6)}${right('壁時計 s', 10)}${right('decode ms', 11)}${right('振れ幅', 10)}${right('前と比べ', 10)}`,
  );
  for (const speed of [1, 2, 3, 4]) {
    let reference = null;
    for (const mode of ['at-timestamps', 'sequential-pool', 'auto']) {
      const r = await runRepeated({ fixture, scale, fps, pieces, speed, mode });
      const s = summarizeRun(r.samples, r.wallMs);
      if (!reference) reference = r;
      console.log(
        `${pad(`${speed} 倍`, 8)}${pad(mode, 16)}${right(r.frames, 6)}${right((r.wallMs / 1000).toFixed(2), 10)}${right(s.stages.decode.sum.toFixed(0), 11)}${right(pct(r.spread), 10)}${right(`${(reference.wallMs / r.wallMs).toFixed(2)} 倍`, 10)}`,
      );
    }
  }

  // --- 検査: 出来上がりのコマは、やり方を替えても同じか ---
  console.log('\n## 出来上がりの照合（わざと壊した相手つき）\n');
  const small = { fixture, scale: 2, fps: 15, pieces: 1, digest: true };
  const truth = await run({ ...small, mode: 'at-timestamps' });
  for (const mode of ['pool', 'sequential', 'sequential-pool', 'shared', 'auto']) {
    const r = await run({ ...small, pieces: mode === 'shared' || mode === 'auto' ? 5 : 1, mode });
    const same = r.digests.length === truth.digests.length && r.digests.every((d, i) => d === truth.digests[i]);
    const diff = r.digests.filter((d, i) => d !== truth.digests[i]).length;
    ok(`${mode} は、いまのやり方と 1 コマも違わない`, same, `違い ${diff} / ${truth.digests.length} コマ`);
  }
  // 速い再生でも中身が同じであること。**速さを替えるとコマの拾い方が変わる**ので、
  // 照合を等速だけで済ませると「速くしたら別の絵になる」を見落とす。
  const fastTruth = await run({ ...small, speed: 4, mode: 'at-timestamps' });
  const fast = await run({ ...small, speed: 4, mode: 'auto' });
  const fastDiff = fast.digests.filter((d, i) => d !== fastTruth.digests[i]).length;
  ok(
    '4 倍速でも、自動で選ぶ形といまのやり方は 1 コマも違わない',
    fast.digests.length === fastTruth.digests.length && fastDiff === 0,
    `違い ${fastDiff} / ${fastTruth.digests.length} コマ`,
  );
  const broken = await run({ ...small, mode: 'broken' });
  const brokenDiff = broken.digests.filter((d, i) => d !== truth.digests[i]).length;
  ok(
    'わざと 1 コマずらした相手は、ちゃんと落ちる（検査が効いている証拠）',
    brokenDiff > truth.digests.length * 0.5,
    `違い ${brokenDiff} / ${truth.digests.length} コマ`,
  );

  ok('画面側でエラーが出ていない', errors.length === 0, errors.slice(0, 3).join(' / '));
} finally {
  await browser.close();
  server.stop();
}

console.log(failed > 0 ? `\n${failed} 件が失敗しています。` : '\n照合はすべて通りました。');
if (failed > 0) process.exit(1);
