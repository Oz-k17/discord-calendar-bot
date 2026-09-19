/**
 * 試し用の素材のラウドネス（LUFS）を測り、目標へ揃えたらどうなるかを並べる。
 *
 *   npm run lab:fixtures    # 先に素材を作る
 *   npm run lab:loudness
 *   npm run lab:loudness -- lab/fixtures/out/speech.wav   # ファイルを指定してもよい
 *   LAB_TARGET=-16 npm run lab:loudness   # 目標を変えて振る
 *   LAB_CEILING=-2 npm run lab:loudness   # ピークの天井を変えて振る
 *   LAB_RAW=1 npm run lab:loudness        # 1ch を 1ch のまま測る（規格どおり。既定は 2ch 扱い）
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

const pad = (s, n) => String(s).padEnd(n, ' ');
const num = (s, n) => String(s).padStart(n, ' ');
const dec = (v, n = 1) => (v === null || v === undefined ? '—' : v.toFixed(n));
const noteOf = (name) => SHORT_FIXTURES.find((f) => f.name === name)?.note ?? '';

console.log(
  `目標 ${target} LUFS ／ 真のピークの天井 ${ceiling} dBTP ／ ` +
    `1ch の素材は ${dualMono ? '2ch 扱いで測る（書き出しに合わせる）' : '1ch のまま測る（規格どおり）'}\n`,
);
console.log(
  `${pad('素材', 30)}${num('LUFS', 8)}${num('静窓', 8)}${num('標本', 8)}${num('真', 8)}  |` +
    `${num('倍率dB', 8)}${num('後LUFS', 8)}${num('後真', 7)}  ${pad('止めたもの', 10)}`,
);
console.log('-'.repeat(104));

const rows = [];
for (const file of files.sort()) {
  const buffer = readWav(file);
  // 素材は 1ch で作ってある。2ch のものを渡されたらそのまま規格どおりに測る
  // （そのときは足すだけでよいので、2ch 扱いへ直す必要が無い）。
  const m = measureLoudness(buffer, { monoAsDualMono: dualMono });
  const plan = planLoudnessNormalization(m, { targetLufs: target, truePeakCeilingDb: ceiling });
  rows.push({ name: path.basename(file), m, plan, buffer });
  console.log(
    `${pad(path.basename(file, '.wav'), 30)}${num(dec(m.integratedLufs), 8)}${num(dec(m.quietBlockLufs), 8)}` +
      `${num(dec(m.samplePeakDb), 8)}${num(dec(m.truePeakDb), 8)}  |` +
      `${num(dec(plan.gainDb), 8)}${num(dec(plan.resultLufs), 8)}${num(dec(plan.resultTruePeakDb), 7)}  ` +
      `${pad(plan.limitedBy === 'none' ? '' : plan.limitedBy, 10)}`,
  );
}

// --- まとめ ---
const measured = rows.filter((r) => r.m.integratedLufs !== null);
const limited = rows.filter((r) => r.plan.limitedBy === 'peak');
console.log(
  `\n${rows.length} 本中 ${measured.length} 本が測れた。` +
    `目標ちょうどに揃ったのは ${rows.length - limited.length} 本、` +
    `途中で止まったのは ${limited.length} 本。`,
);
if (limited.length > 0) {
  console.log('止まった素材（目標に届いていない）:');
  for (const r of limited) {
    console.log(
      `  ${pad(path.basename(r.name, '.wav'), 30)} ${r.plan.limitedBy}  ` +
        `届かなかったぶん ${dec(r.plan.shortfallDb, 2)}dB  ${noteOf(r.name)}`,
    );
  }
}

// ばらつき。揃える前と後で、素材どうしの差がどれだけ縮んだか。
const before = measured.map((r) => r.m.integratedLufs);
const after = measured.map((r) => r.plan.resultLufs);
const spread = (xs) => Math.max(...xs) - Math.min(...xs);
console.log(
  `\n素材どうしの開き: 揃える前 ${spread(before).toFixed(2)} LU（${Math.min(...before).toFixed(1)}〜${Math.max(...before).toFixed(1)}）` +
    ` → 揃えたあと ${spread(after).toFixed(2)} LU（${Math.min(...after).toFixed(1)}〜${Math.max(...after).toFixed(1)}）`,
);

// 当てたあとに測り直す。**計算どおりになっているか**を、実際に倍率を掛けて確かめる。
// 倍率を 1 つ掛けるだけなので理屈では必ず一致するが、
// ここが合わないなら測り方か当て方のどちらかが壊れている。
let worst = 0;
let worstName = '';
for (const r of rows) {
  if (r.plan.resultLufs === null) continue;
  const again = measureLoudness(applyGain(r.buffer, r.plan.gain), {
    monoAsDualMono: dualMono,
    skipTruePeak: true,
  });
  const diff = Math.abs(again.integratedLufs - r.plan.resultLufs);
  if (diff > worst) {
    worst = diff;
    worstName = r.name;
  }
}
console.log(`当てて測り直したときの読みのずれ: 最大 ${worst.toFixed(4)} LU（${path.basename(worstName, '.wav')}）`);

// 静かなほうの窓が、揃えたあとどこへ行くか。
// **「持ち上げすぎていないか」をここで見ようとして失敗した**（2026-09-19・3 回目）。
// 鳴りっぱなしの素材ではこの値が音楽そのものなので、上位には音楽が並ぶ。出すだけに留めてある。
const quiet = rows.filter((r) => r.m.quietBlockLufs !== null);
const afterQuiet = quiet
  .map((r) => ({ name: path.basename(r.name, '.wav'), v: r.m.quietBlockLufs + r.plan.gainDb }))
  .sort((a, b) => b.v - a.v);
console.log(
  `揃えたあとの静かな窓: 上から 5 本 ${afterQuiet.slice(0, 5).map((r) => `${r.name} ${r.v.toFixed(1)}`).join(' / ')}`,
);

console.log(
  '\n**ラウドネスだけを見ないこと。** 目標へ上げるとピークが天井を超える素材があり、' +
    'そこは上の「止めたもの」に peak と出る。無理に上げれば歪むので、ここでは上げない。',
);
