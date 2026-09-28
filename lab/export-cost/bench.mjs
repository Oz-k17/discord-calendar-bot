/**
 * 書き出しが「どこで時間を使っているか」を実測する。
 *
 *   npm run lab:export
 *   LAB_EX_SCALE=4 npm run lab:export     # 小さい絵で測る（1024×576 → 512×288）
 *   LAB_EX_FPS=60 npm run lab:export      # 書き出しの速さを変える
 *   LAB_EX_PIECES=5 npm run lab:export    # 1 本の素材を 5 つに割ったタイムラインで測る
 *   LAB_EX_REPEAT=5 npm run lab:export    # 繰り返す回数（既定 3・中央値を取る）
 *   LAB_EX_DEPTHS=0,1 npm run lab:export  # 重ねる枚数を振る（0 は直列＝いまの本体）
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
const { projectOverlap, projectOverlapMs, projectSpeedup, summarizeRun } = await import('./src/cost.ts');

// 既定を 8（1024×576）にしてあるのは、**小さい絵では振れ幅が答えを隠す**から（2026-09-26）。
// 512×288 では 4 つのやり方が 1.17〜1.29 倍と団子になり、振れ幅（18〜30%）の中に埋まる。
// 1024×576 なら振れ幅 7〜13% に対して 1.00 / 1.29 / 1.53 / 1.69 と順に並ぶ。
// 本物の書き出しは 1080p なので、そちらに近いほうでもある。
const scale = Number(process.env.LAB_EX_SCALE ?? 8);
const fps = Number(process.env.LAB_EX_FPS ?? 30);
const pieces = Number(process.env.LAB_EX_PIECES ?? 1);
const fixture = process.env.LAB_EX_FIXTURE ?? 'cuts-plain';
const repeat = Number(process.env.LAB_EX_REPEAT ?? 3);
// 重ねる枚数。0 は直列（いまの本体）。既定で 0 / 1 / 2 / 4 を並べる。
// **0 は必ず入れる。** 比べる相手（直列）が無いと「前と比べ」の分母が作れない。
const depths = [
  ...new Set([0, ...(process.env.LAB_EX_DEPTHS ?? '0,1,2,4').split(',').map(Number)]),
].sort((a, b) => a - b);
for (const d of depths) {
  if (!Number.isInteger(d) || d < 0) throw new Error(`LAB_EX_DEPTHS は 0 以上の整数の並びです（${d}）`);
}

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
          encodeDepth: r.encodeDepth,
          frames: r.frames,
          wallMs: r.wallMs,
          finalizeMs: r.finalizeMs,
          submitMs: r.submitMs,
          waitMs: r.waitMs,
          drainMs: r.drainMs,
          inFlight: r.inFlight,
          signature: r.signature,
          signatureStride: r.signatureStride,
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

  /**
   * 捨てる 1 回 → 数える N 回。返すのは**壁時計が中央値だった回**と、その振れ幅。
   *
   * `totalMs`（輪＋仕上げ）を併せて返すのは、**重ねる形では仕上げへ仕事が逃げる**から。
   * 輪だけを見ていると「速くなった」が「あとで払う」に化ける。
   */
  const runRepeated = async (options) => {
    await run(options);
    const runs = [];
    for (let i = 0; i < repeat; i += 1) runs.push(await run(options));
    const walls = runs.map((r) => r.wallMs);
    const target = mid(walls);
    const picked = runs.find((r) => r.wallMs === target) ?? runs[0];
    const totals = runs.map((r) => r.wallMs + r.finalizeMs);
    return {
      ...picked,
      totalMs: picked.wallMs + picked.finalizeMs,
      spread: (Math.max(...walls) - Math.min(...walls)) / target,
      totalSpread: (Math.max(...totals) - Math.min(...totals)) / mid(totals),
      runs: walls,
    };
  };

  /**
   * 設定を**交互に**回して、それぞれの中央値を返す。
   *
   * `runRepeated` は 1 つの設定を固めて N 回回すが、**効きが 5% 前後のときはそれでは足りない**
   * （2026-09-26・2 回目）。同じ設定を続けて測ると、その間のページの温まり方・他のプロセス・
   * ゴミ集めの波が**そのまま設定の差に化ける**。実際、固めて測った表では
   * 「重ねると 1.55 倍」と出て、交互に回したら 1.02 倍になった。
   *
   * 1 周ごとに順番をひっくり返すのは、**並びの前後でも差が付く**ため
   * （先頭はいつも少し冷えている）。行き帰りで打ち消す。
   */
  const runInterleaved = async (cases, rounds = repeat) => {
    for (const c of cases) await run(c);
    const got = cases.map(() => []);
    for (let round = 0; round < rounds; round += 1) {
      const order = cases.map((_, i) => (round % 2 === 0 ? i : cases.length - 1 - i));
      for (const i of order) {
        const r = await run(cases[i]);
        got[i].push({ ...r, totalMs: r.wallMs + r.finalizeMs });
      }
    }
    return got.map((runs) => {
      const totals = runs.map((r) => r.totalMs);
      const target = mid(totals);
      const picked = runs.find((r) => r.totalMs === target) ?? runs[0];
      return {
        ...picked,
        totalSpread: (Math.max(...totals) - Math.min(...totals)) / target,
        totals,
      };
    });
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

  // --- デコードとエンコードを重ねる（2026-09-26・2 回目） ---
  console.log('\n## デコードとエンコードを重ねる\n');
  const autoSerial = rows.find(([name]) => name === 'auto');
  console.log(
    `${pad('やり方', 16)}${right('枚数', 6)}${right('輪 s', 8)}${right('仕上げ s', 10)}${right('合計 s', 9)}${right('decode ms', 11)}${right('投げ ms', 10)}${right('待ち ms', 10)}${right('振れ幅', 9)}${right('前と比べ', 10)}`,
  );
  // **交互に回す。** 固めて測ると、この節の差（数 %）は振れ幅に埋もれるどころか
  // 振れ幅のほうを差として読んでしまう（`runInterleaved` の注）。
  const overlapCases = [];
  for (const mode of ['at-timestamps', 'auto']) {
    for (const encodeDepth of depths) overlapCases.push({ fixture, scale, fps, pieces, mode, encodeDepth });
  }
  const overlapMeasured = await runInterleaved(overlapCases);
  const overlapRows = overlapCases.map((c, i) => [
    c.mode,
    c.encodeDepth,
    overlapMeasured[i],
    summarizeRun(overlapMeasured[i].samples, overlapMeasured[i].wallMs),
  ]);
  const overlapBase = overlapMeasured[0];
  for (const [mode, encodeDepth, r, sum] of overlapRows) {
    console.log(
      `${pad(mode, 16)}${right(encodeDepth, 6)}${right((r.wallMs / 1000).toFixed(2), 8)}${right((r.finalizeMs / 1000).toFixed(2), 10)}${right((r.totalMs / 1000).toFixed(2), 9)}${right(sum.stages.decode.sum.toFixed(0), 11)}${right(r.submitMs.toFixed(0), 10)}${right(r.waitMs.toFixed(0), 10)}${right(pct(r.totalSpread), 9)}${right(`${(overlapBase.totalMs / r.totalMs).toFixed(2)} 倍`, 10)}`,
    );
  }
  console.log(
    '\n**合計（輪＋仕上げ）で読むこと。** 重ねると未完了のコマが残るので、\n' +
      '輪だけを見ると仕上げへ逃げたぶんが「速くなった」に見える。\n' +
      'この表だけは設定を**交互に**回している（固めて測ると振れ幅を差として読む）。\n',
  );

  // 見積もりを 2 通り並べて、実測と突き合わせる。
  // `encode` の取り分をそのまま「重ねれば消える」と読むと大きく出るが、
  // 消えるのは**待っていた時間**だけで、同期で絵を捕まえる手間（投げ）は残る。
  const serialAuto = overlapRows.find(([m, d]) => m === 'auto' && d === 0);
  const bestAuto = overlapRows
    .filter(([m, d]) => m === 'auto' && d > 0)
    .reduce((best, row) => (best === null || row[2].totalMs < best[2].totalMs ? row : best), null);
  // 重ねる枚数を 0 だけに絞って走らせたときは、比べる相手が無いので表だけ出して抜ける。
  console.log('### 見積もりと実測\n');
  console.log(`${pad('読み方', 34)}${right('倍率', 8)}`);
  console.log(
    `${pad('取り分をそのまま重ねる（素朴）', 30)}${right(`${projectOverlap(autoSerial[2], 'decode', 'encode').toFixed(2)} 倍`, 10)}`,
  );
  console.log(
    `${pad('待っていた時間だけ重なる', 32)}${right(`${projectOverlapMs(serialAuto[2].totalMs, serialAuto[3].stages.decode.sum, serialAuto[2].waitMs).toFixed(2)} 倍`, 10)}`,
  );
  console.log(
    bestAuto
      ? `${pad(`実測（いちばん良かった ${bestAuto[1]} 枚）`, 32)}${right(`${(serialAuto[2].totalMs / bestAuto[2].totalMs).toFixed(2)} 倍`, 10)}`
      : `${pad('実測', 34)}${right('—（0 枚しか測っていません）', 10)}`,
  );
  console.log(
    '\n**`encode` の取り分の半分以上は「待ち」ではなく「投げ」だった。**\n' +
      '`add()` は呼んだその場で `new VideoFrame(canvas)` を作って符号化器へ渡す。\n' +
      'その同期の手間は、約束を後ろへ回しても 1 ミリ秒も減らない。',
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
  // 重ねる形は、ここまでの照合では確かめられない。**`digests` はエンコードへ渡す前の
  // canvas を見ている**ので、約束を後ろへ回したせいで絵が入れ替わっても同じ値が並ぶ。
  // なので出来上がった WebM を読み直して、出口の側で突き合わせる。
  console.log('');
  const verifySmall = { fixture, scale: 2, fps: 15, pieces: 1, verify: true };
  const serialOut = await run({ ...verifySmall, mode: 'auto', encodeDepth: 0 });
  /**
   * 指紋を**コマごと・升目ごと**に突き合わせて、違ったコマの枚数を返す。
   *
   * **畳み方を 2 回間違えた**（2026-09-26・2 回目）。
   * 1 つ目は全コマを 1 つの平均にしたこと（わざと 1 コマずらした相手が 0.71 / 255 で素通り）。
   * 2 つ目はコマごとに分けたあとも**升目の平均**を見たことで、こちらも 3 / 195 コマしか立たない。
   * 場面の中の動きは画面のごく一部なので、升目 256 個で割ると平均の中に消える。
   * **升目ごとの最大**で見ると 128 / 195 コマが立ち、canvas 側の指紋（129 / 195）とほぼ並ぶ。
   * 線の 2 / 255 は、同じ入力なら開きがぴったり 0 だと測れているので余裕を取っただけ。
   */
  const compare = (a, b, stride) => {
    if (a.length !== b.length || a.length === 0) return { frames: 0, differing: Infinity, worst: Infinity };
    const frames = a.length / stride;
    let differing = 0;
    let worst = 0;
    for (let f = 0; f < frames; f += 1) {
      let cell = 0;
      for (let i = f * stride; i < (f + 1) * stride; i += 1) {
        const d = Math.abs(a[i] - b[i]);
        if (d > cell) cell = d;
      }
      if (cell > 2) differing += 1;
      if (cell > worst) worst = cell;
    }
    return { frames, differing, worst };
  };
  const stride = serialOut.signatureStride;
  for (const encodeDepth of depths.filter((d) => d > 0)) {
    const r = await run({ ...verifySmall, mode: 'auto', encodeDepth });
    const c = compare(serialOut.signature, r.signature, stride);
    ok(
      `${encodeDepth} 枚重ねても、出来上がった WebM は直列と 1 コマも違わない`,
      c.differing === 0 && c.worst < 2,
      `違い ${c.differing} / ${c.frames} コマ ・ 升目の開きの最大 ${c.worst.toFixed(4)} / 255`,
    );
  }
  // **わざと壊して落ちることまで確かめる。** 2026-09-23（2 回目）に、止まった素材では
  // 取り違えが素通りすると分かっている。ここは `cuts-plain`（場面が変わる素材）で測る。
  const brokenOut = await run({ ...verifySmall, mode: 'broken', encodeDepth: 1 });
  const brokenGap = compare(serialOut.signature, brokenOut.signature, stride);
  ok(
    '出口の照合は、わざと 1 コマずらした相手でちゃんと落ちる',
    brokenGap.differing > brokenGap.frames * 0.5,
    `違い ${brokenGap.differing} / ${brokenGap.frames} コマ ・ 升目の開きの最大 ${brokenGap.worst.toFixed(4)} / 255`,
  );
  // 重ねても投げた枚数と出来上がったコマ数が合うこと（1 枚も落としていない）。
  const overlapped = await run({ ...verifySmall, mode: 'auto', encodeDepth: 2 });
  ok(
    '重ねてもコマを落としていない',
    overlapped.signature.length === serialOut.signature.length && overlapped.inFlight.submitted === overlapped.frames,
    `出口 ${overlapped.signature.length / stride} コマ / 投げた ${overlapped.inFlight.submitted} 枚 / 輪 ${overlapped.frames} コマ`,
  );
  console.log('');

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
