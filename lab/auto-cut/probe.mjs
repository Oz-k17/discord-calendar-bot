/**
 * 「どの特徴量なら声とそれ以外を分けられるか」を、正解の分かっている素材で測る。
 *
 *   npm run lab:fixtures
 *   npm run lab:probe
 *
 * 思いつきで 1 つ選んで実装すると、たまたま手元の素材で効いただけのものを掴む。
 * 先にここで並べて比べてから決める。
 *
 * 出す数字は AUC（0.5 = まったく分けられない、1.0 = 完全に分けられる）。
 * しきい値をどこに置くかに依存しないので、特徴量そのものの素性が見える。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readWav } from '../fixtures/wav.mjs';
import { isSpeechAt, SHORT_FIXTURES } from '../fixtures/spec.mjs';

const { analyzeLoudness } = await import('./src/loudness.ts');
const { analyzeFeatures, FEATURE_NAMES } = await import('./src/features.ts');
const { autoThresholdDb } = await import('./src/silence.ts');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const out = path.join(root, 'lab/fixtures/out');
if (!fs.existsSync(out)) {
  console.error('試し用の素材がありません。先に `npm run lab:fixtures` を実行してください。');
  process.exit(1);
}

/**
 * AUC（ROC 曲線の下の面積）を順位から求める。
 * 「声のコマからひとつ、それ以外からひとつ選んだとき、
 *   声のほうが値が大きい確率」と読める。
 */
function auc(positive, negative) {
  if (positive.length === 0 || negative.length === 0) return null;
  const all = [...positive.map((v) => [v, 1]), ...negative.map((v) => [v, 0])].sort((a, b) => a[0] - b[0]);
  // 同点は順位を平均する。
  let rankSum = 0;
  for (let i = 0; i < all.length; ) {
    let j = i;
    while (j + 1 < all.length && all[j + 1][0] === all[i][0]) j += 1;
    const rank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) if (all[k][1] === 1) rankSum += rank;
    i = j + 1;
  }
  const n1 = positive.length;
  const n0 = negative.length;
  return (rankSum - (n1 * (n1 + 1)) / 2) / (n1 * n0);
}

const pad = (s, n) => String(s).padEnd(n, ' ');
const num = (v, n) => (v === null ? pad('—', n) : String(v.toFixed(3)).padStart(n, ' '));

console.log('声のコマとそれ以外のコマを、どれくらい分けられるか（AUC / 0.5 = 分けられない）\n');
console.log(`${pad('素材', 22)}${FEATURE_NAMES.map((f) => num(null, 0) && pad(f, 12)).join('')}`);
console.log('-'.repeat(22 + FEATURE_NAMES.length * 12));

const totals = new Map(FEATURE_NAMES.map((f) => [f, []]));

for (const fixture of SHORT_FIXTURES) {
  const file = path.join(out, fixture.name);
  if (!fs.existsSync(file)) continue;
  const buffer = readWav(file);
  const track = analyzeLoudness(buffer, 0.02);
  const features = analyzeFeatures(buffer, track);

  // 正解のラベルを付ける。境目のコマは、どちらとも言えないので外す。
  const positive = new Map(FEATURE_NAMES.map((f) => [f, []]));
  const negative = new Map(FEATURE_NAMES.map((f) => [f, []]));
  for (let i = 0; i < track.db.length; i += 1) {
    const t = i * track.hop;
    const speech = isSpeechAt(fixture, t);
    const nearEdge = isSpeechAt(fixture, t - 0.15) !== isSpeechAt(fixture, t + 0.15);
    if (nearEdge) continue;
    for (const name of FEATURE_NAMES) {
      (speech ? positive : negative).get(name).push(features[name][i]);
    }
  }

  const row = FEATURE_NAMES.map((name) => {
    const value = auc(positive.get(name), negative.get(name));
    if (value !== null) totals.get(name).push(value);
    return pad(num(value, 6), 12);
  }).join('');
  console.log(`${pad((fixture.hard ? '※ ' : '  ') + fixture.name, 22)}${row}`);
}

console.log('-'.repeat(22 + FEATURE_NAMES.length * 12));
const average = FEATURE_NAMES.map((name) => {
  const values = totals.get(name);
  const mean = values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  return pad(num(mean, 6), 12);
}).join('');
console.log(`${pad('  平均', 22)}${average}`);

// --- しきい値も勘で決めない ---
// 声のコマを取りこぼす率と、それ以外を拾ってしまう率の釣り合いが
// いちばん良くなるところを、全素材をまたいで探す。
{
  const samples = { positive: [], negative: [] };
  for (const fixture of SHORT_FIXTURES) {
    const file = path.join(out, fixture.name);
    if (!fs.existsSync(file)) continue;
    const buffer = readWav(file);
    const track = analyzeLoudness(buffer, 0.02);
    const features = analyzeFeatures(buffer, track);
    for (let i = 0; i < track.db.length; i += 1) {
      const t = i * track.hop;
      if (isSpeechAt(fixture, t - 0.15) !== isSpeechAt(fixture, t + 0.15)) continue;
      // 音量で明らかに落ちるコマ（無音）は、声らしさを見るまでもないので外す。
      if (features.level[i] < -70) continue;
      (isSpeechAt(fixture, t) ? samples.positive : samples.negative).push(features.speechScore[i]);
    }
  }

  let best = { threshold: 0, score: -1, hit: 0, falseAlarm: 0 };
  for (let th = 0; th <= 0.6; th += 0.005) {
    const hit = samples.positive.filter((v) => v >= th).length / Math.max(1, samples.positive.length);
    const falseAlarm = samples.negative.filter((v) => v >= th).length / Math.max(1, samples.negative.length);
    const balanced = (hit + (1 - falseAlarm)) / 2;
    if (balanced > best.score) best = { threshold: th, score: balanced, hit, falseAlarm };
  }
  console.log(
    `\nspeechScore のしきい値を全素材で探した結果: ${best.threshold.toFixed(3)}` +
      `（声を拾えた率 ${(best.hit * 100).toFixed(0)}% / 声でないのに拾った率 ${(best.falseAlarm * 100).toFixed(0)}%）`,
  );
  console.log(`対象コマ: 声 ${samples.positive.length} / それ以外 ${samples.negative.length}（無音は除外）`);
}

// --- 声の無い素材は AUC では測れない ---
// AUC は「声のコマ」と「それ以外のコマ」を比べる指標なので、声が 1 つも無い素材は
// 上の表では — になる。**守りたいのはまさにそこ**（音楽だけの素材を切り刻まないこと）
// なので、別の見方で並べる。声らしさをそのまま信じるとどれだけ誤るか、と、
// 形の動きでそれを弾けるか。
{
  console.log('\n声の無い素材で、どれだけ誤って「声だ」と言うか\n');
  console.log(`${pad('素材', 22)}${pad('声らしいコマの割合', 20)}${pad('形が動いた秒数', 16)}`);
  console.log('-'.repeat(58));
  for (const fixture of SHORT_FIXTURES) {
    if (fixture.speech) continue;
    const file = path.join(out, fixture.name);
    if (!fs.existsSync(file)) continue;
    const buffer = readWav(file);
    const track = analyzeLoudness(buffer, 0.02);
    const features = analyzeFeatures(buffer, track);
    const threshold = autoThresholdDb(track, 0.25);
    let sounding = 0;
    let speechLike = 0;
    let moving = 0;
    for (let i = 0; i < track.db.length; i += 1) {
      if (track.db[i] <= threshold) continue;
      sounding += 1;
      if (features.speechScore[i] >= 0.2) speechLike += 1;
      if (features.shapeChange[i] >= 0.09) moving += 1;
    }
    const ratio = sounding > 0 ? speechLike / sounding : 0;
    console.log(
      `${pad('※ ' + fixture.name, 22)}${pad(`${(ratio * 100).toFixed(0)}%`, 20)}${pad(`${(moving * track.hop).toFixed(2)} 秒`, 16)}`,
    );
  }
  console.log('割合が高いのに形が動かない素材は、声らしさだけでは弾けない（震える楽器がそれ）。');
}

console.log('\n※ は意地悪な素材（BGM が大きい / 声と同じ速さで刻む打楽器 / 震える楽器）。');
console.log('声の無い素材（bgm・drums・music-tremolo）は「声のコマ」が無いので AUC では測れない（—）。');
console.log('0.5 を下回るのは「逆向きに効いている」という意味で、それはそれで使える。');
