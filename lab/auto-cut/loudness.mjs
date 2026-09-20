/**
 * 試し用の素材のラウドネス（LUFS）を測り、目標へ揃えたらどうなるかを並べる。
 *
 *   npm run lab:fixtures    # 先に素材を作る
 *   npm run lab:loudness
 *   npm run lab:loudness -- lab/fixtures/out/speech.wav   # ファイルを指定してもよい
 *   LAB_TARGET=-16 npm run lab:loudness   # 目標を変えて振る
 *   LAB_CEILING=-2 npm run lab:loudness   # ピークの天井を変えて振る
 *   LAB_RAW=1 npm run lab:loudness        # 1ch を 1ch のまま測る（規格どおり。既定は 2ch 扱い）
 *   LAB_LIMIT=0 npm run lab:loudness      # リミッタを通さない（2026-09-19 3 回目までの形）
 *   LAB_LOOKAHEAD=2 LAB_RELEASE=50 LAB_MAXGR=12 npm run lab:loudness  # リミッタのつまみを振る
 *
 * `lab:bench` とは見ているものが違う。あちらは「どこを切るか」の出来を測るもので、
 * こちらは「どれくらいの大きさで出すか」を測る。切る処理には一切触らない。
 *
 * **1ch の素材を 2ch 扱いで測っているのは、本体の書き出しが 2ch だから**
 * （`src/engine/offline-export.ts` の `CHANNELS = 2`）。規格はチャンネルのパワーを足すので、
 * 1ch のまま測ると、書き出して耳に届くときより 3.01 LU 小さく出る。
 * そこを合わせずに倍率を決めると、**全部の素材が 3dB 大きく書き出される。**
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readWav } from '../fixtures/wav.mjs';
import { SHORT_FIXTURES } from '../fixtures/spec.mjs';

const { measureLoudness, planLoudnessNormalization, applyGain, DEFAULT_NORMALIZATION } = await import('./src/lufs.ts');
const { limitTruePeak, DEFAULT_LIMITER } = await import('./src/limiter.ts');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixtures = path.join(root, 'lab/fixtures/out');

const files = process.argv.slice(2).filter((a) => a.endsWith('.wav'));
if (files.length === 0) {
  if (!fs.existsSync(fixtures)) {
    console.error('試し用の素材がありません。先に `npm run lab:fixtures` を実行してください。');
    process.exit(1);
  }
  files.push(...fs.readdirSync(fixtures).filter((f) => f.endsWith('.wav')).map((f) => path.join(fixtures, f)));
}

const target = Number(process.env.LAB_TARGET ?? DEFAULT_NORMALIZATION.targetLufs);
const ceiling = Number(process.env.LAB_CEILING ?? DEFAULT_NORMALIZATION.truePeakCeilingDb);
const dualMono = process.env.LAB_RAW !== '1';
// リミッタを通すかどうか。**通さない側が 2026-09-19（3 回目）までの形**なので、
// 前後を並べたいときは `LAB_LIMIT=0` を付けたものと突き合わせる。
const useLimiter = process.env.LAB_LIMIT !== '0';
const limiter = {
  ceilingDb: ceiling,
  lookAheadMs: Number(process.env.LAB_LOOKAHEAD ?? DEFAULT_LIMITER.lookAheadMs),
  releaseMs: Number(process.env.LAB_RELEASE ?? DEFAULT_LIMITER.releaseMs),
  maxReductionDb: Number(process.env.LAB_MAXGR ?? DEFAULT_LIMITER.maxReductionDb),
};

const pad = (s, n) => String(s).padEnd(n, ' ');
const num = (s, n) => String(s).padStart(n, ' ');
const dec = (v, n = 1) => (v === null || v === undefined ? '—' : v.toFixed(n));
const noteOf = (name) => SHORT_FIXTURES.find((f) => f.name === name)?.note ?? '';

console.log(
  `目標 ${target} LUFS ／ 真のピークの天井 ${ceiling} dBTP ／ ` +
    `1ch の素材は ${dualMono ? '2ch 扱いで測る（書き出しに合わせる）' : '1ch のまま測る（規格どおり）'}\n` +
    (useLimiter
      ? `リミッタ: 先読み ${limiter.lookAheadMs}ms ／ 戻り ${limiter.releaseMs}ms ／ 深さの上限 ${limiter.maxReductionDb}dB\n`
      : 'リミッタ: 通さない（倍率ひとつだけ）\n'),
);
console.log(
  `${pad('素材', 30)}${num('LUFS', 8)}${num('標本', 7)}${num('真', 7)}  |` +
    `${num('倍率dB', 8)}${num('後LUFS', 8)}${num('後真', 7)}${num('均しdB', 8)}${num('作動%', 7)}  ${pad('止めたもの', 10)}`,
);
console.log('-'.repeat(112));

const rows = [];
for (const file of files.sort()) {
  const buffer = readWav(file);
  // 素材は 1ch で作ってある。2ch のものを渡されたらそのまま規格どおりに測る
  // （そのときは足すだけでよいので、2ch 扱いへ直す必要が無い）。
  const m = measureLoudness(buffer, { monoAsDualMono: dualMono });
  const plan = planLoudnessNormalization(m, {
    targetLufs: target,
    truePeakCeilingDb: ceiling,
    // リミッタを通す前提なら、その深さだけ天井を超える倍率まで許す。
    limiterHeadroomDb: useLimiter ? limiter.maxReductionDb : 0,
  });

  // **倍率を当ててからリミッタに通し、その結果を測り直す。**
  // 計画の値をそのまま並べると、リミッタが削ったぶんが見えない。
  let out = applyGain(buffer, plan.gain);
  let report = null;
  if (useLimiter && plan.neededReductionDb > 0) {
    const limited = limitTruePeak(out, limiter);
    out = limited.buffer;
    report = limited.report;
  }
  const after = measureLoudness(out, { monoAsDualMono: dualMono });
  rows.push({ name: path.basename(file), m, plan, buffer, report, after });
  console.log(
    `${pad(path.basename(file, '.wav'), 30)}${num(dec(m.integratedLufs), 8)}` +
      `${num(dec(m.samplePeakDb), 7)}${num(dec(m.truePeakDb), 7)}  |` +
      `${num(dec(plan.gainDb), 8)}${num(dec(after.integratedLufs), 8)}${num(dec(after.truePeakDb), 7)}` +
      `${num(report ? dec(report.maxReductionDb, 2) : '—', 8)}${num(report ? (report.activeRatio * 100).toFixed(2) : '—', 7)}  ` +
      `${pad(plan.limitedBy === 'none' ? '' : plan.limitedBy, 10)}`,
  );
}

// --- まとめ ---
const measured = rows.filter((r) => r.m.integratedLufs !== null);
const stopped = rows.filter((r) => r.plan.limitedBy === 'peak' || r.plan.limitedBy === 'limiter');
console.log(
  `\n${rows.length} 本中 ${measured.length} 本が測れた。` +
    `目標ちょうどに揃ったのは ${rows.length - stopped.length} 本、` +
    `途中で止まったのは ${stopped.length} 本。`,
);
if (stopped.length > 0) {
  console.log('止まった素材（目標に届いていない）:');
  for (const r of stopped) {
    console.log(
      `  ${pad(path.basename(r.name, '.wav'), 30)} ${pad(r.plan.limitedBy, 8)} ` +
        `届かなかったぶん ${dec(r.plan.shortfallDb, 2)}dB  ${noteOf(r.name)}`,
    );
  }
}

// ばらつき。**計画の値ではなく、出来上がった音を測り直した値**で見る。
// リミッタは山を削るのでラウドネスも少し下がる。そこを計画の値で書くと、
// 「揃った」と言いながら実際には揃っていないということが起こりうる。
const before = measured.map((r) => r.m.integratedLufs);
const after = measured.map((r) => r.after.integratedLufs);
const spread = (xs) => Math.max(...xs) - Math.min(...xs);
console.log(
  `\n素材どうしの開き: 揃える前 ${spread(before).toFixed(2)} LU（${Math.min(...before).toFixed(1)}〜${Math.max(...before).toFixed(1)}）` +
    ` → 揃えたあと ${spread(after).toFixed(2)} LU（${Math.min(...after).toFixed(1)}〜${Math.max(...after).toFixed(1)}）`,
);

// **リミッタが削ったぶん。** 計画では目標ちょうどのはずが、均したせいで下がる。
// ここが大きいと「均して届かせた」つもりが届いていないので、必ず出す。
const dropped = rows
  .filter((r) => r.report && r.after.integratedLufs !== null && r.plan.resultLufs !== null)
  .map((r) => ({ name: path.basename(r.name, '.wav'), v: r.plan.resultLufs - r.after.integratedLufs }))
  .sort((a, b) => b.v - a.v);
if (dropped.length > 0) {
  console.log(
    `均したことで下がったラウドネス: 最大 ${dropped[0].v.toFixed(2)} LU（${dropped[0].name}）／ ` +
      `平均 ${(dropped.reduce((a, b) => a + b.v, 0) / dropped.length).toFixed(3)} LU`,
  );
}

// 天井を守れているか。**リミッタの値ではなく、出来上がった音を測り直した値で見る。**
// 倍率をなめらかに動かしているので、当てたあとの真のピークは理屈どおりとは限らない。
const over = rows.filter((r) => r.after.truePeakDb > ceiling + 0.01);
console.log(
  over.length === 0
    ? `天井（${ceiling} dBTP）を超えた素材: なし`
    : `天井を超えた素材: ${over.length} 本 ${over
        .map((r) => `${path.basename(r.name, '.wav')} ${r.after.truePeakDb.toFixed(2)}`)
        .join(' / ')}`,
);

if (useLimiter) {
  const active = rows.filter((r) => r.report);
  if (active.length > 0) {
    const ratios = active.map((r) => r.report.activeRatio);
    const worstActive = active.reduce((a, b) => (b.report.activeRatio > a.report.activeRatio ? b : a));
    console.log(
      `リミッタが働いた素材: ${active.length} 本 ／ ` +
        `手を出した時間の平均 ${((ratios.reduce((a, b) => a + b, 0) / rows.length) * 100).toFixed(3)}%（${rows.length} 本ぜんたいで）／ ` +
        `いちばん長いのは ${path.basename(worstActive.name, '.wav')} の ${(worstActive.report.activeRatio * 100).toFixed(2)}%`,
    );
    const clampedRows = active.filter((r) => r.report.clamped);
    if (clampedRows.length > 0) {
      console.log(
        `深さの上限（${limiter.maxReductionDb}dB）に当たった素材: ${clampedRows
          .map((r) => path.basename(r.name, '.wav'))
          .join(' / ')}`,
      );
    }
  }
}

console.log(
  '\n**ラウドネスだけを見ないこと。** 均せば届くが、均した時間と深さは上の「均しdB / 作動%」に出る。' +
    'そこが伸びているなら、揃えたのではなく潰しただけかもしれない。',
);
