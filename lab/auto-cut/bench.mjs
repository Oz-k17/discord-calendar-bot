/**
 * 試し用の素材に対して、いまの無音カットがどう効くかを測る。
 *
 *   npm run lab:fixtures   # 先に素材を作る
 *   npm run lab:bench
 *   npm run lab:bench -- lab/fixtures/out/speech-long.wav   # ファイルを指定してもよい
 *
 * セルフテスト（合成波形での検算）は「壊れていないか」を見るもので、
 * こちらは「実際どれくらい効くか」を見るもの。数字を記録に残しておけば、
 * あとから手を入れたときに良くなったのか悪くなったのかが分かる。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readWav } from '../fixtures/wav.mjs';

const { analyzeLoudness, percentileDb } = await import('./src/loudness.ts');
const { planJetCut } = await import('./src/silence.ts');

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

const pad = (s, n) => String(s).padEnd(n, ' ');
const num = (s, n) => String(s).padStart(n, ' ');

console.log(
  `${pad('素材', 20)} ${num('尺', 7)} ${num('しきい値', 9)} ${num('底', 7)} ${num('声', 7)} ${num('本数', 5)} ${num('残る', 7)} ${num('削減', 7)} ${num('解析', 7)}`,
);
console.log('-'.repeat(90));

for (const file of files) {
  const buffer = readWav(file);
  const started = performance.now();
  const track = analyzeLoudness(buffer, 0.02);
  const plan = planJetCut(track);
  const elapsed = performance.now() - started;

  const floor = percentileDb(track, 0.1);
  const voice = percentileDb(track, 0.9);
  const ratio = plan.originalDuration > 0 ? 1 - plan.resultDuration / plan.originalDuration : 0;

  console.log(
    `${pad(path.basename(file), 20)} ${num(plan.originalDuration.toFixed(1) + 's', 7)} ${num(plan.thresholdDb.toFixed(1) + 'dB', 9)} ${num(floor.toFixed(0), 7)} ${num(voice.toFixed(0), 7)} ${num(plan.keep.length, 5)} ${num(plan.resultDuration.toFixed(1) + 's', 7)} ${num(Math.round(ratio * 100) + '%', 7)} ${num(elapsed.toFixed(0) + 'ms', 7)}`,
  );

  // 全編が「鳴っている」判定になっていたら、その素材では役に立っていない。
  if (plan.keep.length === 1 && plan.resultDuration > plan.originalDuration * 0.95) {
    console.log(`${' '.repeat(20)} └ 全編が鳴っている判定。この素材ではカットできていない。`);
  }
  if (plan.keep.length === 0) {
    console.log(`${' '.repeat(20)} └ 何も残らなかった。しきい値が高すぎる。`);
  }
}

console.log(
  '\n「底」「声」は音量の下位 10% / 上位 10%（dBFS）。この 2 つが近い素材ほど、しきい値では分けられない。',
);
