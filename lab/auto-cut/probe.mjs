/**
 * 「どの特徴量なら声とそれ以外を分けられるか」を、正解の分かっている素材で測る。
 *
 *   npm run lab:fixtures
 *   npm run lab:probe
 *   LAB_FULLBAND=1 npm run lab:probe  # 揺れを全域で見る（2026-09-16・2 回目より前の振る舞い）
 *
 * `lowLevelSkew` は**向きが逆**の量（大きいほど打点＝声でない）。表の下の注を参照。
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
import { renderShort } from '../fixtures/make-audio.mjs';
import { isSpeechAt, SHORT_FIXTURES, UTTERANCES } from '../fixtures/spec.mjs';

const { analyzeLoudness, percentileDb, SILENCE_DB } = await import('./src/loudness.ts');
const { analyzeFeatures, energyModulationDepthDb, FEATURE_NAMES, MOD_SPLIT_HZ, modulationDepthDb, modulationWindowFrames } =
  await import('./src/features.ts');

const { autoThresholdDb, cutSoundingSeconds, DEFAULT_JET_CUT, envelopeGateFrames, lowBandDepthSeconds, lowBandLineDb, lowBandReadable, planJetCut } =
  await import('./src/silence.ts');
/**
 * 特徴量の出し方。既定は**出荷されている側**（全域）に揃える。
 *
 * `LAB_FULLBAND=1 npm run lab:probe` で「揺れを全域で見る」（2026-09-16・2 回目より前の）側に戻る。
 * `LAB_LOWBAND=4000` のように境目そのものも渡せる。
 * 既定を研究側に寄せると、この表が**いま動いていないもの**を測り始めるので分けてある。
 * 既定のままだと `lowModulation` は `modulation` と同じ列になる。それが正しい見え方。
 */
const lowband = Number(process.env.LAB_LOWBAND ?? 0);
const featureOptions = {
  ...(process.env.LAB_FULLBAND ? { modSplitHz: 0 } : {}),
  ...(lowband ? { modSplitHz: lowband === 1 ? MOD_SPLIT_HZ : lowband } : {}),
};


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

/** 重心の下降率で門を置くとしたらどこか（下の段で使う。勘で置かず表を見て決め直せるように定数にしておく）。 */
const DESCENT_GATE = 0.65;
/** 「高い帯域だけが動いた割合」で門を置くとしたらどこか。同じく表を見て決め直せるように。 */
const HIGH_ALONE_GATE = 0.5;
/** 向きの門の保持を「素材単位の数え方」にだけ効かせるとしたら何秒か（2026-09-17 の段で使う）。 */
const STRICT_HOLD_SECONDS = 0.5;

const pad = (s, n) => String(s).padEnd(n, ' ');
const num = (v, n) => (v === null ? pad('—', n) : String(v.toFixed(3)).padStart(n, ' '));

console.log('声のコマとそれ以外のコマを、どれくらい分けられるか（AUC / 0.5 = 分けられない）\n');
console.log(`${pad('素材', 22)}${FEATURE_NAMES.map((f) => num(null, 0) && pad(f, 14)).join('')}`);
console.log('-'.repeat(22 + FEATURE_NAMES.length * 14));

const totals = new Map(FEATURE_NAMES.map((f) => [f, []]));

for (const fixture of SHORT_FIXTURES) {
  const file = path.join(out, fixture.name);
  if (!fs.existsSync(file)) continue;
  const buffer = readWav(file);
  const track = analyzeLoudness(buffer, 0.02);
  const features = analyzeFeatures(buffer, track, featureOptions);

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
    return pad(num(value, 6), 14);
  }).join('');
  console.log(`${pad((fixture.hard ? '※ ' : '  ') + fixture.name, 22)}${row}`);
}

console.log('-'.repeat(22 + FEATURE_NAMES.length * 14));
const average = FEATURE_NAMES.map((name) => {
  const values = totals.get(name);
  const mean = values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  return pad(num(mean, 6), 14);
}).join('');
console.log(`${pad('  平均', 22)}${average}`);
// **`lowLevelSkew` だけは向きが逆。** 大きいほど「打点」＝声でない側なので、
// 0 に近いほどよく分けている（0.5 が分けられない）。平均 0.135 は 1 - 0.135 = 0.865 と読む。
// `speech-sparse-thump` は 0.000（声と打点が完全に割れる）、
// **`speech-clipped-bgm` は 0.985 と逆向きに振り切れている**（短く区切った声が打点の側へ落ちる）。
// この 1 行を読み飛ばすと、平均 0.135 を「まったく分けられない量」と読むことになる。
console.log(
  '\n※ lowLevelSkew は向きが逆（大きいほど打点＝声でない）。0 に近いほど分けている。' +
    '\n  speech-clipped-bgm の 0.985 は、短く区切った声が打点の側へ落ちるということ（この手の破れ方）。',
);

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
    const features = analyzeFeatures(buffer, track, featureOptions);
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
  console.log(`${pad('素材', 22)}${pad('声らしいコマの割合', 20)}${pad('形が動いた秒数', 16)}${pad('包絡が動いた秒数', 18)}`);
  console.log('-'.repeat(76));
  for (const fixture of SHORT_FIXTURES) {
    if (fixture.speech) continue;
    const file = path.join(out, fixture.name);
    if (!fs.existsSync(file)) continue;
    const buffer = readWav(file);
    const track = analyzeLoudness(buffer, 0.02);
    const features = analyzeFeatures(buffer, track, featureOptions);
    const threshold = autoThresholdDb(track, 0.25);
    let sounding = 0;
    let speechLike = 0;
    let moving = 0;
    let envMoving = 0;
    for (let i = 0; i < track.db.length; i += 1) {
      if (track.db[i] <= threshold) continue;
      sounding += 1;
      if (features.speechScore[i] >= 0.2) speechLike += 1;
      if (features.shapeChange[i] >= 0.09) moving += 1;
      // 2026-09-11 の 3 回目からは、これがそのままコマ単位の門になっている。
      // ここで手打ちにすると判定とずれるので、判定側の既定値をそのまま使う。
      if (features.envelopeChange[i] >= DEFAULT_JET_CUT.minEnvelopeChange) envMoving += 1;
    }
    const ratio = sounding > 0 ? speechLike / sounding : 0;
    console.log(
      `${pad('※ ' + fixture.name, 22)}${pad(`${(ratio * 100).toFixed(0)}%`, 20)}${pad(`${(moving * track.hop).toFixed(2)} 秒`, 16)}${pad(`${(envMoving * track.hop).toFixed(2)} 秒`, 18)}`,
    );
  }
  console.log('割合が高いのに形が動かない素材は、声らしさだけでは弾けない（震える楽器がそれ）。');
}

// --- AUC では見えない比べ方 ---
// 上の AUC は「声のコマ」と「それ以外のコマ（無音を含む）」を比べている。
// ところが無音のコマは、乾いた素材ではほぼ雑音なので、形も包絡も毎コマ暴れる。
// そのせいで「声かどうか」ではなく「鳴っているかどうか」を測ってしまい、
// 形や包絡の良し悪しがまったく見えない（乾いた素材の AUC は shapeFlux 0.189 /
// envelopeFlux 0.289。0.5 を下回る＝声のほうが小さい、という意味になってしまう）。
//
// 判定が本当に見たいのは「鳴っているコマの中で、声と音楽を分けられるか」なので、
// そちらを直に並べる。
{
  console.log('\n鳴っているコマだけで、声と音楽を直に比べる（中央値）\n');
  console.log(`${pad('素材', 24)}${pad('区分', 6)}${pad('shapeChange', 14)}${pad('envelopeChange', 14)}`);
  console.log('-'.repeat(58));
  const median = (values) => {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  };
  for (const fixture of SHORT_FIXTURES) {
    const file = path.join(out, fixture.name);
    if (!fs.existsSync(file)) continue;
    const buffer = readWav(file);
    const track = analyzeLoudness(buffer, 0.02);
    const features = analyzeFeatures(buffer, track, featureOptions);
    const threshold = autoThresholdDb(track, 0.25);
    const groups = { 声: { shape: [], env: [] }, 他: { shape: [], env: [] } };
    for (let i = 0; i < track.db.length; i += 1) {
      if (track.db[i] <= threshold) continue;
      const t = i * track.hop;
      // 境目のコマはどちらとも言えないので外す（上の AUC と同じ扱い）。
      if (isSpeechAt(fixture, t - 0.15) !== isSpeechAt(fixture, t + 0.15)) continue;
      const group = groups[isSpeechAt(fixture, t) ? '声' : '他'];
      group.shape.push(features.shapeChange[i]);
      group.env.push(features.envelopeChange[i]);
    }
    for (const [label, group] of Object.entries(groups)) {
      if (group.shape.length === 0) continue;
      console.log(
        `${pad((fixture.hard ? '※ ' : '  ') + fixture.name, 24)}${pad(label, 6)}` +
          `${pad(num(median(group.shape), 6), 14)}${pad(num(median(group.env), 6), 14)}`,
      );
    }
  }
  console.log('\n「乾いた声」と「震える楽器」を見比べること。');
  console.log('形では 3.8 倍しか開かない（0.188 と 0.050）が、包絡なら 30 倍開く（0.270 と 0.009）。');
  console.log('ただし ※ speech-sustained（母音を伸ばす声）は 0.037 まで落ちる。');
  console.log('本物の声にある性質なので、門だけを置くとここで声を切る。');
  console.log('（2026-09-11 の 3 回目に 0.5 秒の保持を足して、ここは戻した）');
  console.log('music-wah（フォルマントが動く楽器）と music-chords-fast / faster（和音が速く変わる音楽）は、');
  console.log('声がゼロなのに包絡が動く。門を置いても、この 3 本は通り抜ける。');
  console.log('とくに music-chords-faster（0.2 秒ごとに和音）は shapeChange の中央値が 0.093 で、');
  console.log('しきい値 0.09 をすでに上回っている。素材単位の形の判定も、ここは支えられない。');
}

// --- 子音の痕跡（広帯域の雑音の粒）を測る ---
// 2026-09-12 の 2 回目に `speak()` へ子音と息を足したので、ここを初めて測れるようになった。
// 上の AUC の表では `zcr` が 0.000〜0.007 と出るが、あれは「声のコマ」を
// **無音のコマと**比べているせい（乾いた素材の無音はほぼ雑音なので zcr が最も高い）。
// 判定が見たいのは「鳴っているコマの中で、声と音楽を分けられるか」なので、そちらを出す。
//
// 子音は音節の 1〜3 割しか占めないので、**中央値では出ない**。
// 「その素材に雑音の粒が混じっているか」を見るには上側の分位が要る。
{
  console.log('\n鳴っているコマの zcr と flux（子音は少数なので、中央値ではなく上位 10% を見る）\n');
  console.log(
    `${pad('素材', 24)}${pad('区分', 6)}${pad('zcr 中央', 11)}${pad('zcr 上位10%', 13)}` +
      `${pad('flux 中央', 11)}${pad('flux 上位10%', 13)}${pad('平坦さ 上位10%', 15)}`,
  );
  console.log('-'.repeat(93));
  const quantile = (values, p) => {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
  };
  for (const fixture of SHORT_FIXTURES) {
    const file = path.join(out, fixture.name);
    if (!fs.existsSync(file)) continue;
    const buffer = readWav(file);
    const track = analyzeLoudness(buffer, 0.02);
    const features = analyzeFeatures(buffer, track, featureOptions);
    const threshold = autoThresholdDb(track, 0.25);
    const groups = { 声: { zcr: [], flux: [], flat: [] }, 他: { zcr: [], flux: [], flat: [] } };
    for (let i = 0; i < track.db.length; i += 1) {
      if (track.db[i] <= threshold) continue;
      const t = i * track.hop;
      if (isSpeechAt(fixture, t - 0.15) !== isSpeechAt(fixture, t + 0.15)) continue;
      const group = groups[isSpeechAt(fixture, t) ? '声' : '他'];
      group.zcr.push(features.zcr[i]);
      group.flux.push(features.flux[i]);
      group.flat.push(features.flatness[i]);
    }
    for (const [label, group] of Object.entries(groups)) {
      if (group.zcr.length === 0) continue;
      console.log(
        `${pad((fixture.hard ? '※ ' : '  ') + fixture.name, 24)}${pad(label, 6)}` +
          `${pad(num(quantile(group.zcr, 0.5), 6), 11)}${pad(num(quantile(group.zcr, 0.9), 6), 13)}` +
          `${pad(num(quantile(group.flux, 0.5), 6), 11)}${pad(num(quantile(group.flux, 0.9), 6), 13)}` +
          `${pad(num(quantile(group.flat, 0.9), 6), 15)}`,
      );
    }
  }
  console.log('\n※ speech-vowels-only（子音も息も無い声）を必ず併せて見ること。');
  console.log('ここで声と音楽が分かれても、その素材が音楽の側に落ちるなら、');
  console.log('その手がかりは「声があるか」ではなく「子音があるか」を見ているだけ。');
}

// --- 「音程のある粒と雑音の粒が隣り合っているか」 ---
// 上の分位で分かるのは「雑音の粒があるか」だけで、それだけなら打楽器にも雑音はある。
// 声に固有なのは **2 種類の粒が短い間に混じること**（子音の雑音 → 母音の音程）で、
// 正弦波を足して作った楽器（和音・wah・トレモロ）には音程の粒しか無く、
// 打楽器には雑音の粒しか無い。これが、子音を足して初めて測れるようになった手がかり。
{
  console.log('\n短い窓（0.3 秒）の中に「雑音の粒」と「音程の粒」が両方あるか\n');
  console.log(`${pad('素材', 24)}${pad('声', 6)}${pad('雑音の粒', 11)}${pad('音程の粒', 11)}${pad('両方あった秒数', 16)}`);
  console.log('-'.repeat(68));
  // しきい値は勘で置かず、下の表を見て決め直せるように定数として出しておく。
  const NOISY_FLATNESS = 0.18;
  const TONAL_HARMONICITY = 0.3;
  const WINDOW_SECONDS = 0.3;
  for (const fixture of SHORT_FIXTURES) {
    const file = path.join(out, fixture.name);
    if (!fs.existsSync(file)) continue;
    const buffer = readWav(file);
    const track = analyzeLoudness(buffer, 0.02);
    const features = analyzeFeatures(buffer, track, featureOptions);
    const threshold = autoThresholdDb(track, 0.25);
    const noisy = [];
    const tonal = [];
    for (let i = 0; i < track.db.length; i += 1) {
      const sounding = track.db[i] > threshold;
      noisy.push(sounding && features.flatness[i] >= NOISY_FLATNESS);
      tonal.push(sounding && features.harmonicity[i] >= TONAL_HARMONICITY);
    }
    const half = Math.round(WINDOW_SECONDS / 2 / track.hop);
    let both = 0;
    for (let i = 0; i < noisy.length; i += 1) {
      let n = false;
      let t = false;
      for (let k = -half; k <= half; k += 1) {
        const j = i + k;
        if (j < 0 || j >= noisy.length) continue;
        if (noisy[j]) n = true;
        if (tonal[j]) t = true;
      }
      if (n && t) both += 1;
    }
    const count = (list) => list.filter(Boolean).length * track.hop;
    console.log(
      `${pad((fixture.hard ? '※ ' : '  ') + fixture.name, 24)}${pad(fixture.speech ? 'あり' : 'なし', 6)}` +
        `${pad(`${count(noisy).toFixed(2)} 秒`, 11)}${pad(`${count(tonal).toFixed(2)} 秒`, 11)}` +
        `${pad(`${(both * track.hop).toFixed(2)} 秒`, 16)}`,
    );
  }
  console.log(`\n判定に使ったしきい値: 平坦さ >= ${NOISY_FLATNESS} / 倍音らしさ >= ${TONAL_HARMONICITY}`);
}

// --- 打点の減衰と、口の動きを分ける ---
// 2026-09-13 の 1 回目に、`envelopeChange`（包絡の動き）が「口が動いたか」ではなく
// **打点の減衰にも同じだけ反応する**ことが分かった（`music-hats` で 1.44 → 12.98 秒）。
// そのとき記録に書いた見立てが「違いは動き方の**向き**にあるはず」。
// 打点は立ち上がりで重心が一気に上がり、減衰のあいだ単調に下がり続ける。
// 口の動きは向きがばらばらなので、下がった歩みと上がった歩みがほぼ半々になる。
//
// 0.3 秒の窓で「重心が下がった歩み」の割合を数えて、そこを直に見る。
// **見るのは中央値だけでは足りない。** 門にするなら「声のコマが何割ひっかかるか」が要る。
{
  console.log('\n重心が下がり続けている割合（0.3 秒の窓。打点の減衰なら高い）\n');
  console.log(
    `${pad('素材', 24)}${pad('区分', 6)}${pad('中央', 8)}${pad('下位10%', 10)}${pad('上位10%', 10)}` +
      `${pad(`${DESCENT_GATE} 超えのコマ`, 16)}`,
  );
  console.log('-'.repeat(74));
  const quantile = (values, p) => {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
  };
  for (const fixture of SHORT_FIXTURES) {
    const file = path.join(out, fixture.name);
    if (!fs.existsSync(file)) continue;
    const buffer = readWav(file);
    const track = analyzeLoudness(buffer, 0.02);
    const features = analyzeFeatures(buffer, track, featureOptions);
    const threshold = autoThresholdDb(track, 0.25);
    const groups = { 声: [], 他: [] };
    for (let i = 0; i < track.db.length; i += 1) {
      if (track.db[i] <= threshold) continue;
      const t = i * track.hop;
      if (isSpeechAt(fixture, t - 0.15) !== isSpeechAt(fixture, t + 0.15)) continue;
      groups[isSpeechAt(fixture, t) ? '声' : '他'].push(features.centroidDescent[i]);
    }
    for (const [label, values] of Object.entries(groups)) {
      if (values.length < 5) continue;
      const over = values.filter((v) => v >= DESCENT_GATE).length / values.length;
      console.log(
        `${pad((fixture.hard ? '※ ' : '  ') + fixture.name, 24)}${pad(label, 6)}` +
          `${pad(num(quantile(values, 0.5), 6), 8)}${pad(num(quantile(values, 0.1), 6), 10)}` +
          `${pad(num(quantile(values, 0.9), 6), 10)}${pad(`${(over * 100).toFixed(0)}%`, 16)}`,
      );
    }
  }
  console.log(`\n門にするなら ${DESCENT_GATE} のあたり（music-hats の下位 10% と、素の声の上位 10% の間）。`);
  console.log('**それでも判定には入れなかった**（2026-09-13・2 回目に測って捨てた）。');
  console.log('music-hats 97% に対し、同じハイハットの上でしゃべる speech-hats は 29% まで落ちるので、');
  console.log('「ハイハットがあるか」を見ているだけではない。ところが下の 2 本で破れる:');
  console.log('  ※ speech-vowels-hats（子音も息も無い声＋ハイハット）… 声のコマの 83% が超える');
  console.log('  ※ speech-sparse-hats（音楽の上でまばらにしゃべる）… 素材全体の 99% が超える');
  console.log('重心はいちばん高い所にある弱い音に引きずられるので、声が高い帯域を覆っていないと');
  console.log('打点の減衰だけが残る。つまりこの量は「口が動いたか」ではなく');
  console.log('「高い帯域が何かで覆われているか」を見ている。');
}


// --- 帯域ごとの時間の形（高い帯域だけが動いていないか） ---
// 2026-09-13 の 2 回目に「重心・平坦さ系は打ち止め」と決めた。どちらも
// **スペクトルを 1 つの数へ潰してから**時間で見る量で、倍音の上に何かあるかしか見ていない。
// 残っていた方向が「潰さずに、どの帯域がどう動いたかを見る」。3 回目にそれを測った。
//
// ハイハットは下の和音を動かさずに高い帯域だけを叩いて減衰する。
// 人がしゃべると音節の切れ目で帯域をまたいで一緒に動く。そこを直に数える。
{
  console.log('\n高い帯域だけが動いた歩みの割合（0.3 秒の窓。打点なら高い）\n');
  console.log(
    `${pad('素材', 26)}${pad('区分', 6)}${pad('中央', 8)}${pad('上位10%', 10)}` +
      `${pad(`${HIGH_ALONE_GATE} 超えのコマ`, 16)}${pad('歩みを数えた率', 16)}`,
  );
  console.log('-'.repeat(82));
  const quantile = (values, p) => {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
  };
  for (const fixture of SHORT_FIXTURES) {
    const file = path.join(out, fixture.name);
    if (!fs.existsSync(file)) continue;
    const buffer = readWav(file);
    const track = analyzeLoudness(buffer, 0.02);
    const features = analyzeFeatures(buffer, track, featureOptions);
    const threshold = autoThresholdDb(track, 0.25);
    const groups = { 声: [], 他: [] };
    // 「どちらの帯域も動かなかった」歩みは分母に入れていないので、
    // 値が 0 でも「打点が無い」とは限らない（そもそも何も起きていないだけかもしれない）。
    // その 2 つを取り違えないように、歩みを数えられた割合も並べる。
    // 判定と同じ式なので、features.ts の中身を変えたらここも合わなくなる。
    const bands = features.bandCount;
    const split = features.bandSplit;
    let counted = 0;
    let steps = 0;
    for (let i = 1; i < track.db.length; i += 1) {
      if (track.db[i] <= threshold || track.db[i - 1] <= threshold) continue;
      steps += 1;
      let low = 0;
      for (let b = 0; b < split; b += 1) low += features.bandLog[i * bands + b] - features.bandLog[(i - 1) * bands + b];
      let high = 0;
      for (let b = split; b < bands; b += 1) high += features.bandLog[i * bands + b] - features.bandLog[(i - 1) * bands + b];
      if (Math.abs(low / split) >= 0.1 || Math.abs(high / (bands - split)) >= 0.1) counted += 1;
    }
    for (let i = 0; i < track.db.length; i += 1) {
      if (track.db[i] <= threshold) continue;
      const t = i * track.hop;
      if (isSpeechAt(fixture, t - 0.15) !== isSpeechAt(fixture, t + 0.15)) continue;
      groups[isSpeechAt(fixture, t) ? '声' : '他'].push(features.highBandAlone[i]);
    }
    for (const [label, values] of Object.entries(groups)) {
      if (values.length < 5) continue;
      const over = values.filter((v) => v >= HIGH_ALONE_GATE).length / values.length;
      console.log(
        `${pad((fixture.hard ? '※ ' : '  ') + fixture.name, 26)}${pad(label, 6)}` +
          `${pad(num(quantile(values, 0.5), 6), 8)}${pad(num(quantile(values, 0.9), 6), 10)}` +
          `${pad(`${(over * 100).toFixed(0)}%`, 16)}${pad(`${((counted / Math.max(1, steps)) * 100).toFixed(0)}%`, 16)}`,
      );
    }
  }
  console.log('\n**当ては当たった。** music-hats は 72% のコマが門を超えるのに、');
  console.log('同じハイハットの上で子音のある声がしゃべる speech-hats は声のコマの 1% しか超えない。');
  console.log('しかも speech-sparse-hats は素材の**中で** 声 0% 対 他 64% と割れる。');
  console.log('素材単位でしか使えなかった centroidDescent（同じ素材で全体の 99% が超える）とはそこが違う。');
  console.log('\n**それでも判定には入れなかった**（2026-09-13・3 回目に測って捨てた）。');
  console.log('入れると失うものが 1 本あり、その 1 本を守る置き方だと効きが丸ごと消えるため:');
  console.log('  ※ speech-sustained-hats（ハイハットの上で母音を伸ばす声。この日に足した）');
  console.log('    伸ばした母音は低い帯域を動かさないので、声のコマが打点と同じ顔になる');
  console.log('    （中央 0.571 / 61% 超え。music-hats の 0.571 / 72% とほぼ並ぶ）。');
  console.log('  門を 0.5 に置くと music-hats の削減 0% → 35% と引き換えに、この素材の');
  console.log('  声を残せた率が 100% → 73% に落ちる。0.7 まで緩めると効きだけが先に消える');
  console.log('  （music-hats の削減は 0% に戻り、残せた率は 83% までしか戻らない）。');
  console.log('  包絡の門と同じ 0.5 秒の保持を足すと残せた率は 100% に戻るが、');
  console.log('  そのとき speech-sparse-hats の削減が 13% → 0% になり、得たものが残らない。');
  console.log('\n「歩みを数えた率」が低い素材（鳴りっぱなしの音楽）は、値が 0 でも');
  console.log('「打点が無い」ではなく「そもそも何も動いていない」だけ。取り違えないこと。');
}

// --- 捨てた量を「置き場所を変えて」測り直す（2026-09-14・2 回目）---
//
// 前の回に分かったこと: **同じ量でも、要求を厳しくしてよい場所とそうでない場所がある。**
// コマ単位の門は 1 コマ落とせばそこで声が切れるが、素材単位の判定は
// 「声が 5% 残っていればよい」ので、取りこぼしても結論が変わらない——はずだった。
// `minEnvelopeRun` は実際そうなり、門では交換だったものが素材単位では片側だけの前進になった。
//
// そこで、コマ単位の門で捨てた `highBandAlone` を素材単位に置き直して測る段。
// **次に量を捨てるときも、捨てる前にここへ通すこと。**
{
  console.log('\n同じ量を「素材単位の判定」に置いたらどうなるか（声らしいコマの割合）\n');
  const GATES = [0.3, 0.4, 0.5];
  console.log(
    `${pad('素材', 36)}${pad('声', 4)}${pad('いま', 7)}${GATES.map((g) => pad(`門 ${g}`, 7)).join('')}` +
      '  そのうち声のコマ（いま → 門 0.3）',
  );
  console.log('-'.repeat(36 + 4 + 7 + GATES.length * 7 + 30));
  const opts = DEFAULT_JET_CUT;
  for (const fixture of SHORT_FIXTURES) {
    const file = path.join(out, fixture.name);
    if (!fs.existsSync(file)) continue;
    const buffer = readWav(file);
    const track = analyzeLoudness(buffer, 0.02);
    const features = analyzeFeatures(buffer, track, featureOptions);
    const thresholdDb = autoThresholdDb(track, opts.sensitivity);
    const holdFrames = Math.max(0, Math.round(opts.envelopeHold / track.hop));
    // 判定と同じ道筋をそのままなぞる。ここがずれると、測った数字が判定の出来と噛み合わない。
    // 鳴っているかの判定も、silence.ts の `sounding` と同じ 2 条件で見る
    // （自動しきい値が無音の底より下に来た素材で、ここだけずれるのを防ぐ）。
    const sounding = (i) => track.db[i] > thresholdDb && track.db[i] > SILENCE_DB;
    const runGate = envelopeGateFrames(
      features.envelopeFlux,
      sounding,
      opts.minEnvelopeChange,
      Math.max(1, Math.round(opts.minEnvelopeRun / track.hop)),
      holdFrames,
    );
    let inSpeech = false;
    let soundingFrames = 0;
    let strict = 0;
    let voiceSounding = 0;
    let voiceStrict = 0;
    let openUntil = -1;
    const gated = GATES.map(() => 0);
    const voiceGated = GATES.map(() => 0);
    for (let i = 0; i < track.db.length; i += 1) {
      if (!sounding(i)) {
        inSpeech = false;
        openUntil = -1;
        continue;
      }
      soundingFrames += 1;
      const voice = isSpeechAt(fixture, i * track.hop);
      if (voice) voiceSounding += 1;
      const score = features.speechScore[i];
      inSpeech = inSpeech ? score >= Math.min(opts.speechExit, opts.speechThreshold) : score >= opts.speechThreshold;
      if (!inSpeech) continue;
      if (features.envelopeChange[i] >= opts.minEnvelopeChange) openUntil = i + holdFrames;
      if (i > openUntil) continue;
      if (!runGate[i]) continue;
      strict += 1;
      if (voice) voiceStrict += 1;
      for (let g = 0; g < GATES.length; g += 1) {
        if (features.highBandAlone[i] < GATES[g]) {
          gated[g] += 1;
          if (voice) voiceGated[g] += 1;
        }
      }
    }
    const pc = (a, b) => (b > 0 ? `${Math.round((a / b) * 100)}%` : '—');
    console.log(
      `${pad((fixture.hard ? '※ ' : '  ') + fixture.name, 36)}${pad(fixture.speech ? '有' : '無', 4)}` +
        `${pad(pc(strict, soundingFrames), 7)}${GATES.map((g, gi) => pad(pc(gated[gi], soundingFrames), 7)).join('')}` +
        `${fixture.speech ? `  ${pc(voiceStrict, voiceSounding)} → ${pc(voiceGated[0], voiceSounding)}` : ''}`,
    );
  }
  console.log(`\n線は ${DEFAULT_JET_CUT.minSpeechRatio * 100}%。ここを下回ると「声が見つからない」で何もしない。`);
  console.log('\n**当て（置き場所を変えれば通る）は、半分だけ当たって外れた**（2026-09-14・2 回目）。');
  console.log('門 0.3 で music-hats は 99% → 4% と線の下へ落ちる。声のある 15 本もどれも線の上に残る。');
  console.log('ここで止めれば「片側だけの前進」と書けた。潰し素材を 2 本足したらそうではなかった:');
  console.log('  ※ music-hats-break（和音が 2 回休む・声なし）  93% → 9%  … 落ちない');
  console.log('  ※ speech-sparse-sustained-hats（声あり 20%）   98% → 9%  … 同じ所に並ぶ');
  console.log('**実害が出ているほうの音楽（削減 3%）が落ちず、声のある素材と 1 ポイントも違わない。**');
  console.log('理由は右端の列に出ている。声のコマが 100% → 17% まで落ちるので、');
  console.log('残った 9% は声の証拠ではなく、落としきれなかった打点のコマのほう。');
  console.log('\n素材単位の余裕は「13 秒のうち 5%」ではなく、');
  console.log('**（声が尺に占める割合）×（その声を数えられた割合）**。声が薄い素材では前の項が先に効く。');
}

// --- 声の無い素材の「削減 %」を、実害と無害に分ける（2026-09-14・3 回目）---
//
// ここまでの記録はずっと、声の無い素材の削減率をそのまま実害として読んでいた
// （「music-wah は声がゼロなのに 7 本に切り刻む」）。そして その素材を弾く手がかりを
// 7 通り試して 7 回とも落ちた。**読み方のほうが間違っていた。**
//
// 無音カットが無音を切るのは正しい振る舞いで、曲は壊れない。壊れるのは
// **鳴っているところを切ったとき**だけ。分けて数えれば、追うべき相手が変わる。
{
  console.log('\n声の無い素材で、削減のうち何秒が「鳴っているところ」だったか\n');
  console.log(`${pad('素材', 30)}${pad('削減', 9)}${pad('うち鳴', 9)}${pad('素材の無音', 11)}${pad('level でも', 10)}割合`);
  console.log('-'.repeat(30 + 9 + 9 + 11 + 10 + 6));
  for (const fixture of SHORT_FIXTURES) {
    if (fixture.speech) continue;
    const file = path.join(out, fixture.name);
    if (!fs.existsSync(file)) continue;
    const buffer = readWav(file);
    const track = analyzeLoudness(buffer, 0.02);
    const features = analyzeFeatures(buffer, track, featureOptions);
    const level = planJetCut(track, { mode: 'level' });
    const plan = planJetCut(
      track,
      { mode: 'speech' },
      features.speechScore,
      features.shapeChange,
      features.envelopeChange,
      features.envelopeFlux,
      features.lowLevel,
      features.lowModulationDepth,
      features.lowLevelSkew,
    );
    let silent = 0;
    for (let i = 0; i < track.db.length; i += 1) {
      if (!(track.db[i] > plan.thresholdDb && track.db[i] > SILENCE_DB)) silent += 1;
    }
    const sec = (v) => `${v.toFixed(2)}s`;
    console.log(
      `${pad((fixture.hard ? '※ ' : '  ') + fixture.name, 30)}${pad(sec(plan.removed), 9)}` +
        `${pad(sec(cutSoundingSeconds(track, plan)), 9)}${pad(sec(silent * track.hop), 11)}` +
        `${pad(sec(level.removed), 10)}${Math.round(plan.speechRatio * 100)}%`,
    );
  }
  console.log('\n**music-wah の 21% は、鳴っているコマを 1 つも切っていない。**');
  console.log('この素材には 5.32 秒の無音が開いていて、削減はそれを切っただけ。');
  console.log('level（音量だけ）でも同じ 2.72 秒を切るので、**声らしさの判定は 1 コマも足していない**。');
  console.log('7 本に分かれるのも「無音で 7 本に分かれた」であって、切り刻んだのではない。');
  console.log('\n声がゼロの素材で本当に壊しているのは 2 本・合わせて 1 秒弱だけ:');
  console.log('  ※ music-flute       0.78s … 素材の両端（0.00〜0.54 と 12.68〜13.00）');
  console.log('  ※ music-hats-break  0.20s … ブレイク中、ハイハットの打点と打点の間');
  console.log('\n**「誤認」と「実害」は別の話だった。** music-wah は声らしいコマの割合 98% で');
  console.log('完全に誤認しているのに、壊した秒数はゼロ。誤認していても、切る場所が');
  console.log('もともと無音なら曲は壊れない。逆に music-flute は割合 66% と誤認が浅いほうなのに、');
  console.log('線をまたいで出入りするぶん実害が出る。**浅い誤認のほうが害が大きい。**');
  console.log('\n※ 声のある素材にこの数え方を当ててはいけない。あちらは「鳴っている BGM を切る」のが');
  console.log('仕事なので、同じ数が大きいほど良い（speech-sparse-bgm は 9.02 秒ある）。');

  // 「線の近くを漂っているか」を量にできないか測った段。**駄目だった。**
  console.log('\n線の近く（0.1〜0.3）に居るコマの割合 — 実害の予報に使えるか\n');
  const drift = [];
  for (const fixture of SHORT_FIXTURES) {
    const file = path.join(out, fixture.name);
    if (!fs.existsSync(file)) continue;
    const buffer = readWav(file);
    const track = analyzeLoudness(buffer, 0.02);
    const features = analyzeFeatures(buffer, track, featureOptions);
    const plan = planJetCut(
      track,
      { mode: 'speech' },
      features.speechScore,
      features.shapeChange,
      features.envelopeChange,
      features.envelopeFlux,
      features.lowLevel,
      features.lowModulationDepth,
      features.lowLevelSkew,
    );
    const vals = [];
    for (let i = 0; i < track.db.length; i += 1) {
      if (track.db[i] > plan.thresholdDb && track.db[i] > SILENCE_DB) vals.push(features.speechScore[i]);
    }
    const near = vals.filter((v) => v >= DEFAULT_JET_CUT.speechExit && v <= DEFAULT_JET_CUT.speechThreshold * 1.5);
    drift.push([fixture, vals.length ? near.length / vals.length : 0, cutSoundingSeconds(track, plan)]);
  }
  drift.sort((a, b) => b[1] - a[1]);
  for (const [fixture, ratio, harm] of drift.slice(0, 8)) {
    console.log(
      `${pad((fixture.hard ? '※ ' : '  ') + fixture.name, 34)}${pad(fixture.speech ? '声あり' : '声なし', 8)}` +
        `${pad(`${Math.round(ratio * 100)}%`, 6)}${fixture.speech ? '' : `壊した ${harm.toFixed(2)}s`}`,
    );
  }
  console.log('\n**分けられない。** 上位は drums 100% / bgm 95% / music-chords-faster 83% と、');
  console.log('**壊していない素材**が占める（どれも声らしさが低いまま線の下に居るので出入りしない）。');
  console.log('music-flute は 81% で 4 番目だが、声のある speech-sustained-hats が 76% で並ぶ。');
  console.log('「線の近くに居る割合」は、線の下にべったり居るのと、線をまたぐのを区別できない。');
  console.log('またぐ回数を数える方向はまだ試していないが、実害が 1 秒弱しかないので後回しでよい。');
}

// --- 向きの門を入れた先で、素材単位に止められるか（2026-09-17）---
//
// 9/16 の 3 回目に、向きの門（`maxLowSkew`）で `speech-sparse-thump` の 5.60 秒が閉まった。
// ところが同じ門が声ゼロの `music-thump` を 5.94 秒切る。割合が 99% → 25% と**半端に**落ち、
// 5% の線を割らないので素材単位で止まらないため。9/16 の 2 回目は `music-hats` で
// 同じ形を「深さ（dB）」で止めて既定にできたので、ここでも別の量を探した。
//
// **7 通り測って、全部駄目だった。** 下の表がその中身で、footer に理由を書いてある。
// 次の回がここへ戻ってきたとき、同じ穴を掘り直さずに済むように測り方ごと残す。
{
  console.log('\n向きの門（0.4）を入れた先で、素材単位に止められるか\n');
  console.log(
    `${pad('素材', 34)}${pad('声', 4)}${pad('いま', 7)}${pad('読+向<0', 9)}${pad('保持.5', 8)}` +
      `${pad('打点外の深さ', 14)}${pad('読めた', 8)}`,
  );
  console.log('-'.repeat(34 + 4 + 7 + 9 + 8 + 14 + 8));
  const opts = { ...DEFAULT_JET_CUT, maxLowSkew: 0.4 };
  for (const fixture of SHORT_FIXTURES) {
    const file = path.join(out, fixture.name);
    if (!fs.existsSync(file)) continue;
    const buffer = readWav(file);
    const track = analyzeLoudness(buffer, 0.02);
    const features = analyzeFeatures(buffer, track, featureOptions);
    const thresholdDb = autoThresholdDb(track, opts.sensitivity);
    // 判定と同じ道筋をなぞる。ここがずれると、測った数字が判定の出来と噛み合わない。
    const sounding = (i) => track.db[i] > thresholdDb && track.db[i] > SILENCE_DB;
    const holdFrames = Math.max(0, Math.round(opts.envelopeHold / track.hop));
    const runGate = envelopeGateFrames(
      features.envelopeFlux,
      sounding,
      opts.minEnvelopeChange,
      Math.max(1, Math.round(opts.minEnvelopeRun / track.hop)),
      holdFrames,
    );
    const readable = lowBandReadable(features.lowLevel, thresholdDb, modulationWindowFrames(track.hop));
    // 素材単位の数え方にだけ効かせる保持。値は `envelopeHold` と揃えてあるが、
    // ここは判定ではなく測る側なので、判定の既定に引きずられないよう別に置く。
    const strictHold = Math.round(STRICT_HOLD_SECONDS / track.hop);
    let inSpeech = false;
    let openUntil = -1;
    let closeUntil = -1;
    let closeUntilHeld = -1;
    let soundingFrames = 0;
    let now = 0;
    let negative = 0;
    let held = 0;
    // 「打点でないコマ」だけで読んだ深さ。向きで読む場所を選び、深さで判断する組み合わせ。
    let depthOffBeat = 0;
    let readableFrames = 0;
    for (let i = 0; i < track.db.length; i += 1) {
      if (readable[i]) {
        readableFrames += 1;
        if (features.lowLevelSkew[i] < opts.maxLowSkew && features.lowModulationDepth[i] > depthOffBeat) {
          depthOffBeat = features.lowModulationDepth[i];
        }
      }
      if (!sounding(i)) {
        inSpeech = false;
        openUntil = -1;
        closeUntil = -1;
        closeUntilHeld = -1;
        continue;
      }
      soundingFrames += 1;
      const score = features.speechScore[i];
      inSpeech = inSpeech ? score >= Math.min(opts.speechExit, opts.speechThreshold) : score >= opts.speechThreshold;
      if (!inSpeech) continue;
      if (readable[i] && features.lowLevelSkew[i] >= opts.maxLowSkew) {
        closeUntil = i;
        closeUntilHeld = i + strictHold;
      }
      if (i <= closeUntil) continue;
      if (features.envelopeChange[i] >= opts.minEnvelopeChange) openUntil = i + holdFrames;
      if (i > openUntil) continue;
      if (!runGate[i]) continue;
      now += 1;
      // ① 読めるコマで、向きが 0 より下のものだけを声の証拠として数える
      if (readable[i] && features.lowLevelSkew[i] < 0) negative += 1;
      // ② 門の保持（0.5 秒）を、コマ単位の切り口ではなく素材単位の数え方にだけ効かせる
      if (i > closeUntilHeld) held += 1;
    }
    const pc = (a) => (soundingFrames > 0 ? `${Math.round((a / soundingFrames) * 100)}%` : '—');
    console.log(
      `${pad((fixture.hard ? '※ ' : '  ') + fixture.name, 34)}${pad(fixture.speech ? '有' : '無', 4)}` +
        `${pad(pc(now), 7)}${pad(pc(negative), 9)}${pad(pc(held), 8)}` +
        `${pad(`${depthOffBeat.toFixed(2)}dB`, 14)}${pad(`${(readableFrames * track.hop).toFixed(2)}s`, 8)}`,
    );
  }
  console.log(`\n線は ${DEFAULT_JET_CUT.minSpeechRatio * 100}%（割合）と ${DEFAULT_JET_CUT.minModulationDepth}dB（深さ）。`);
  console.log('「読+向<0」= 読めるコマで向きが 0 より下のものだけを声の証拠として数える。');
  console.log('「保持.5」= 門の保持 0.5 秒を、コマ単位の切り口ではなく素材単位の数え方にだけ効かせる。');
  console.log('「打点外の深さ」= 向きが線より下のコマだけで読んだ深さの最大。');
  console.log('\n**3 通りとも線が引けない。止めたい 2 本と、守りたい声の薄い素材が同じ所に並ぶ:**');
  console.log('  読+向<0   ※ music-thump-break 10% 対 ※ speech-sparse-bgm 5% / speech-sparse-hats 6%');
  console.log('  保持.5    ※ music-thump 10% 対 ※ speech-sparse-bgm 7% / speech-sparse-hats 7%');
  console.log('  打点外深さ ※ music-thump 1.18dB 対 ※ speech-bgm-loud 1.59dB（判断される素材の中で声側の最小）');
  console.log('\n「読めた」が短い素材の 0.00dB は「動かなかった」ではなく「判断していない」。');
  console.log(`深さの判定は読めた秒数が ${DEFAULT_JET_CUT.minDepthSeconds}s に満たなければ黙って通す（乾いた声はここに落ちる）。`);
  console.log('\n**厳しくすると、音楽の取りこぼしと声の証拠が同じだけ減る。** 声が尺の 2 割しか無い素材では');
  console.log('5% までの余裕が（声の割合 0.2）×（数えられた割合）しかないので、先にこちらが線を割る。');
  console.log('\n**同じ日に、ほかに 4 通り測って捨てた**（数字は JOURNAL の 2026-09-17 を参照）:');
  console.log('  ・向きが負へ届いた秒数 … ※ music-thump-break 1.16s 対 ※ speech-sparse-thump 1.66s。');
  console.log('    しかも ※ speech-clipped-bgm では負の秒の 0% しか声でない（声を見ていない）。');
  console.log('  ・生き延びたコマの続きの長さ … 0.5 秒以上で ※ music-thump 9% 対 ※ speech-sparse-bgm 15%。');
  console.log('  ・低い側の音量が等間隔に繰り返しているか（自己相関の山の立ち方）…');
  console.log('    ※ music-thump 0.243 対 ※ speech-sparse-thump の声 0.197。打点のほうが規則正しく見えない。');
  console.log('    減衰 0.035 秒はコマ幅 0.02 秒で 1〜2 コマなので、繰り返しの形がコマに残らない。');
  console.log('  ・打点（700Hz 以下）を外した「間の帯」(700〜2000Hz) … 読めたコマが 0.00s になる。');
  console.log('    `lowBandReadable` は**全域のしきい値**を当てるので、帯を狭めると一度も鳴っている扱いにならない。');
}

console.log('\n※ は意地悪な素材（BGM が大きい / 刻む打楽器 / 震える楽器 / 母音を伸ばす声 など）。');
console.log('声の無い素材（bgm・drums・music-tremolo）は「声のコマ」が無いので AUC では測れない（—）。');
console.log('0.5 を下回るのは「逆向きに効いている」という意味で、それはそれで使える。');

// --- 向きの門は、どの素材なら素材単位に止められるのか（2026-09-17・2 回目）---
//
// 前の回（同じ日の 1 回目）は「どの量なら `music-thump` を素材単位で止められるか」を
// 7 通り探して全部駄目だった。**探す前に決まっていた**、というのがここで分かったこと。
//
// この門は低い側が読めるコマにしか触れない（`lowBandReadable`）。
// 読めないコマは門をどれだけ厳しくしても声の証拠として残るので、
// **その割合が「割合をどこまで落とせるか」の下限**になる。下限が 5% の線より上なら、
// どんな量を持ってきてもその素材は素材単位に止まらない。
//
// 測ると、止めたい側の下限が線の上（`music-thump` 8.9%）で、
// 守りたい側の下限が線の下（`speech-clipped-bgm` 0.0%）だった。**向きが逆である。**
{
  console.log('\n向きの門で素材単位に止められるのは、どの素材か（下限 = 門が触れないコマ）\n');
  console.log(
    `${pad('素材', 34)}${pad('声', 4)}${pad('門なし', 8)}${pad('下限', 8)}${pad('止まりうる', 12)}${pad('線 0.01', 9)}${pad('線 0.4', 8)}`,
  );
  console.log('-'.repeat(34 + 4 + 8 + 8 + 12 + 9 + 8));
  const line = DEFAULT_JET_CUT.minSpeechRatio;
  for (const fixture of SHORT_FIXTURES) {
    const file = path.join(out, fixture.name);
    if (!fs.existsSync(file)) continue;
    const buffer = readWav(file);
    const track = analyzeLoudness(buffer, 0.02);
    const features = analyzeFeatures(buffer, track, featureOptions);
    const opts = { ...DEFAULT_JET_CUT, mode: 'speech' };
    const thresholdDb = autoThresholdDb(track, opts.sensitivity);
    const sounding = (i) => track.db[i] > thresholdDb && track.db[i] > SILENCE_DB;
    const holdFrames = Math.max(0, Math.round(opts.envelopeHold / track.hop));
    const runGate = envelopeGateFrames(
      features.envelopeFlux,
      sounding,
      opts.minEnvelopeChange,
      Math.max(1, Math.round(opts.minEnvelopeRun / track.hop)),
      holdFrames,
    );
    const readable = lowBandReadable(features.lowLevel, thresholdDb, modulationWindowFrames(track.hop));
    // 判定と同じ数え方で「声の候補」を作り、そのうち門が触れないコマを下限として数える。
    let soundingFrames = 0;
    let strict = 0;
    let floor = 0;
    let inSpeech = false;
    let openUntil = -1;
    for (let i = 0; i < track.db.length; i += 1) {
      if (!sounding(i)) {
        inSpeech = false;
        openUntil = -1;
        continue;
      }
      soundingFrames += 1;
      const score = features.speechScore[i];
      inSpeech = inSpeech ? score >= Math.min(opts.speechExit, opts.speechThreshold) : score >= opts.speechThreshold;
      if (!inSpeech) continue;
      if (features.envelopeChange[i] >= opts.minEnvelopeChange) openUntil = i + holdFrames;
      if (i > openUntil) continue;
      if (!runGate[i]) continue;
      strict += 1;
      if (!readable[i]) floor += 1;
    }
    // 実際に線を振って、下限より下へ行かないことを確かめる。
    // `skewDropped` が立つ素材は門を外した後の割合が出るので、そこは「外した」と書く。
    const at = (maxLowSkew) => {
      const p = planJetCut(
        track,
        { ...opts, maxLowSkew },
        features.speechScore,
        features.shapeChange,
        features.envelopeChange,
        features.envelopeFlux,
        features.lowLevel,
        features.lowModulationDepth,
        features.lowLevelSkew,
      );
      return p.skewDropped ? '外した' : `${(p.speechRatio * 100).toFixed(1)}%`;
    };
    const pc = (a) => (soundingFrames > 0 ? `${((a / soundingFrames) * 100).toFixed(1)}%` : '—');
    const canStop = soundingFrames > 0 && floor / soundingFrames < line ? '止まりうる' : '止まらない';
    console.log(
      `${pad((fixture.hard ? '※ ' : '  ') + fixture.name.replace('.wav', ''), 34)}${pad(fixture.speech ? '有' : '無', 4)}` +
        `${pad(pc(strict), 8)}${pad(pc(floor), 8)}${pad(canStop, 12)}${pad(at(0.01), 9)}${pad(at(0.4), 8)}`,
    );
  }
  console.log(`\n線は ${line * 100}%。「下限」= 声の候補として数えられたのに、低い側が読めず門が触れないコマ。`);
  console.log('「止まりうる」= 下限が線より下。門を厳しくすれば素材単位に止められてしまう素材。');
  console.log('\n**この表は 2026-09-17（2 回目）に「止めたい側は線に届かず、守りたい声の側が先に割る」と読んだもの。**');
  console.log('同じ日の 3 回目に `music-thump-drop`（声なし・下限 4.6%）が入って、その読みは**一般には誤り**だと分かった。');
  console.log('下限は「窓 ÷ 尺」でしかなく、声の有無とは関係が無い。下の段を参照。\n');
  console.log('  ※ music-thump        下限 8.9%  … 線 0.01 まで下げても 14.3% 止まり');
  console.log('  ※ music-thump-break  下限 19.1% … 同じく 29.5% 止まり');
  console.log('  ※ speech-sparse-bgm  下限 0.0%  … 線 0.01 で 4.8%（**声のある素材が線を割る**）');
  console.log('  ※ speech-clipped-bgm 下限 0.0%  … 線 0.4 でも 1.5%（既定では門を外して救う）');
  console.log('\n7 通り測って全部駄目だったのは、量の選び方ではなく**線より下へ行けなかった**から。');
  console.log('だから `planJetCut` は、割合だけが線を割っていてそれを立てたのが門なら、その素材では門を外す。');
  console.log('\n**次にコマ単位の門を素材単位の数え方へ効かせるときは、まずこの「下限」を出すこと。**');
  console.log('そこが線より上なら、どんな量を持ってきてもその素材は素材単位には止まらない。');
}

// --- 門を外す手（`skewDropped`）は、門が正しく止めた素材まで救ってしまう（2026-09-17・3 回目）---
//
// 前の回（同じ日の 2 回目）に入れた外し方の根拠は、
// 「門が触れないコマの割合（下限）が線より上なので、この門で素材単位に止まるのは声のある素材だけ」。
// つまり**門が立てる「声が見つからない」は構造上どれも誤り**、という読みだった。
//
// その下限は「窓 ÷ 尺」でしかない（検算 ⑥''''）。**声の有無とは何の関係も無い。**
// 13 秒の素材では 0.64 / 13 = 4.6% で線（5%）のすぐ下なので、
// **低い側がへこまない声ゼロの素材**を置けば、そのまま線を割る。
// `music-thump-drop.wav`（うねらない伴奏＋低い打点＋打点だけの休符）がそれで、
// 門は**読めるコマを 1 つ残らず捕まえて**正しく止めるのに、外し方がその結論を捨てる。
{
  console.log('\n門を外す手は、門が正しく止めた素材まで救っていないか（線 0.4）\n');
  console.log(`${pad('素材', 26)}${pad('声', 4)}${pad('門なし', 8)}${pad('下限', 8)}${pad('外さない割合', 14)}${pad('門の結論', 12)}${pad('外したあと', 16)}`);
  console.log('-'.repeat(26 + 4 + 8 + 8 + 14 + 12 + 16));
  const line = DEFAULT_JET_CUT.minSpeechRatio;
  const gateLine = 0.4;
  for (const fixture of SHORT_FIXTURES) {
    const file = path.join(out, fixture.name);
    if (!fs.existsSync(file)) continue;
    const buffer = readWav(file);
    const track = analyzeLoudness(buffer, 0.02);
    const features = analyzeFeatures(buffer, track, featureOptions);
    const opts = { ...DEFAULT_JET_CUT, mode: 'speech' };
    const thresholdDb = autoThresholdDb(track, opts.sensitivity);
    const sounding = (i) => track.db[i] > thresholdDb && track.db[i] > SILENCE_DB;
    const holdFrames = Math.max(0, Math.round(opts.envelopeHold / track.hop));
    const runGate = envelopeGateFrames(
      features.envelopeFlux,
      sounding,
      opts.minEnvelopeChange,
      Math.max(1, Math.round(opts.minEnvelopeRun / track.hop)),
      holdFrames,
    );
    const readable = lowBandReadable(features.lowLevel, thresholdDb, modulationWindowFrames(track.hop));
    // `planJetCut` は門だけで止まると自動で外してしまうので、外す前の割合はここで数え直す。
    // 数え方は planJetCut の本体と 1 つも変えない（門 → 包絡 → 厳しいほうの順）。
    // 門ありと門なしは**別の状態機械として回す**。planJetCut は門で落としたコマで
    // 包絡の保持（`envelopeOpenUntil`）を更新しないので、1 本の走りで両方を数えると
    // 保持の伸び方がずれる。ここが合っていないと「外さない割合」が実物と違う数になる。
    let soundingFrames = 0;
    let strict = 0;
    let floor = 0;
    let bare = 0;
    const count = (withGate) => {
      let hits = 0;
      let unreadable = 0;
      let inSpeech = false;
      let openUntil = -1;
      let closeUntil = -1;
      for (let i = 0; i < track.db.length; i += 1) {
        if (!sounding(i)) {
          inSpeech = false;
          openUntil = -1;
          closeUntil = -1;
          continue;
        }
        if (withGate) soundingFrames += 1;
        const score = features.speechScore[i];
        inSpeech = inSpeech ? score >= Math.min(opts.speechExit, opts.speechThreshold) : score >= opts.speechThreshold;
        if (!inSpeech) continue;
        if (withGate) {
          if (readable[i] && features.lowLevelSkew[i] >= gateLine) closeUntil = i;
          if (i <= closeUntil) continue;
        }
        if (features.envelopeChange[i] >= opts.minEnvelopeChange) openUntil = i + holdFrames;
        if (i > openUntil) continue;
        if (!runGate[i]) continue;
        hits += 1;
        if (!readable[i]) unreadable += 1;
      }
      return { hits, unreadable };
    };
    strict = count(true).hits;
    const without = count(false);
    bare = without.hits;
    floor = without.unreadable;
    const ratio = soundingFrames > 0 ? strict / soundingFrames : 0;
    const stops = soundingFrames > 0 && ratio < line;
    const plan = planJetCut(
      track,
      { ...opts, maxLowSkew: gateLine },
      features.speechScore,
      features.shapeChange,
      features.envelopeChange,
      features.envelopeFlux,
      features.lowLevel,
      features.lowModulationDepth,
      features.lowLevelSkew,
    );
    // 外していない素材はここで何も言うことが無いので、表からは落とす（33 本ぜんぶは長い）。
    if (!plan.skewDropped) continue;
    const harm = plan.noSpeechFound ? 0 : cutSoundingSeconds(track, plan);
    const pc = (a) => (soundingFrames > 0 ? `${((a / soundingFrames) * 100).toFixed(1)}%` : '—');
    console.log(
      `${pad((fixture.hard ? '※ ' : '  ') + fixture.name.replace('.wav', ''), 26)}${pad(fixture.speech ? '有' : '無', 4)}` +
        `${pad(pc(bare), 8)}${pad(pc(floor), 8)}${pad(`${(ratio * 100).toFixed(1)}%`, 14)}` +
        `${pad(stops ? '止める' : '通す', 12)}${pad(`削${((plan.removed / plan.originalDuration) * 100).toFixed(0)}% 実害${harm.toFixed(2)}s`, 16)}`,
    );
  }
  console.log(`\n線は ${line * 100}%。「外さない割合」= 門を外さなかったときの割合（planJetCut は自動で外すので数え直している）。`);
  console.log('\n**外れる 2 本は、正しさが逆を向いている。**');
  console.log('  ※ speech-clipped-bgm  声あり … 門が誤って止める。外すのが正しい（救われるのはこちら）');
  console.log('  ※ music-thump-drop    声なし … 門が正しく止める。外すと声ゼロの曲を 1.60s 切る');
  console.log('\n`music-thump-drop` の外さない割合 4.6% は**下限そのもの**＝門は読めるコマを 1 つ残らず捕まえている。');
  console.log('**外し方が働くのは、門がいちばんよく効いたときである。**');
  console.log('\n下限は「窓 ÷ 尺」なので、尺を伸ばすほど外れやすくなる（同じ素材をつないで実測）:');
  console.log('  13s 下限 4.6% → 実害 1.60s ／ 26s 2.3% → 3.20s ／ 39s 1.5% → 4.80s ／ 65s 0.9% → 8.00s');
  console.log('**13 秒で線のすぐ下だったのは素材の都合で、現実の尺ではもっと外れる。**');
}

// --- 深さ（dB）の線は、群を分けていない（2026-09-18）---
//
// 深さは 2026-09-16（2 回目）に「割合では線を引けない」を解いた量として既定になった。
// ところが深さも**比**である。dB の列の揺れ幅なので、線形に直せば
// 「窓の中の最大と最小の比」でしかなく、**一定の伴奏を下に敷くと縮む**。
// 声が動かした絶対量は変わらないのに、伴奏が大きいほど値が下がる（検算 ⑥）。
//
// だから声のある素材が、伴奏を上げるだけで音楽の側へ滑っていく。
// この段は**線の上下に誰が居るか**を出す。素材が増えたら線を置き直すための表。
{
  console.log('\n低い側の揺れの深さ（dB）— 線の上下に誰が居るか\n');
  console.log(`${pad('素材', 30)}${pad('声', 4)}${pad('深さ最大', 10)}${pad('読めた', 10)}線との関係`);
  console.log('-'.repeat(30 + 4 + 10 + 10 + 12));
  const line = DEFAULT_JET_CUT.minModulationDepth;
  const rows = [];
  for (const fixture of SHORT_FIXTURES) {
    const file = path.join(out, fixture.name);
    if (!fs.existsSync(file)) continue;
    const buffer = readWav(file);
    const track = analyzeLoudness(buffer, 0.02);
    const features = analyzeFeatures(buffer, track, featureOptions);
    const thresholdDb = autoThresholdDb(track, DEFAULT_JET_CUT.sensitivity);
    const depth = lowBandDepthSeconds(
      features.lowLevel,
      features.lowModulationDepth,
      track.hop,
      thresholdDb,
      modulationWindowFrames(track.hop),
      line,
    );
    // 読めたコマが足りない素材は、そもそも深さでは判断していない（黙って通す側）。
    const judged = depth.judged >= DEFAULT_JET_CUT.minDepthSeconds;
    rows.push({ fixture, max: depth.max, judged: depth.judged, decides: judged });
  }
  rows.sort((a, b) => a.max - b.max);
  for (const r of rows) {
    const stops = r.decides && r.max < line;
    // 声があるのに止まる／声が無いのに通る、が実害の出る側。
    // ここで言えるのは**深さの判定だけ**の結論。`music-swell` のように
    // 割合や形で止まる素材も「通る」に出るので、素材の最終的な扱いと混ぜて読まないこと。
    const mark = !r.decides
      ? '判断しない'
      : stops
        ? r.fixture.speech
          ? '止まる ← 声があるのに'
          : '止まる'
        : r.fixture.speech
          ? '通る'
          : '通る（深さでは止まらない）';
    console.log(
      `${pad((r.fixture.hard ? '※ ' : '  ') + r.fixture.name.replace('.wav', ''), 30)}${pad(r.fixture.speech ? '有' : '無', 4)}` +
        `${pad(r.max.toFixed(3), 10)}${pad(r.judged.toFixed(2) + 's', 10)}${mark}`,
    );
  }
  console.log(`\n線は ${line}dB（silence.ts の \`minModulationDepth\`）。\`LAB_DEPTH=0.42 npm run lab:bench\` で振り直せる。`);
  console.log('「判断しない」= 読めたコマが 1.28 秒に足りない素材（深さでは何も言わない）。');
  console.log('**この段の結論は深さの判定だけのもの。** 割合や形で止まる素材も「通る」に出る。');
  console.log('\n**この量は群を分けていない。** 伴奏を上げるだけで、声のある素材が音楽の側へ滑る');
  console.log('（`speech-flat-bgm*.wav` は `speech-bgm-loud` からうねりを外しただけの素材）:');
  console.log('\n  伴奏の大きさ  0.4    0.5    0.6    0.7    0.8    1.0    1.2');
  console.log('  深さ最大      1.09   0.85   0.69   0.58   0.50   0.39   0.34   ← すべて声あり');
  console.log('  （声は 0.5。1.2 は声より 7.6dB 大きい）');
  console.log('\n声ゼロの ※ music-chords-faster が 0.361 なので、**伴奏が声より 7.6dB 大きくなると**');
  console.log('**声のある素材のほうが下に来る。** 線をどこに置いても、その 2 本は分けられない。');
  console.log('いまの 0.5 は「止めたい最大 0.361」と「守ると決めた下限 0.688」の間を比で等しく取っただけで、');
  console.log('**群の切れ目ではない。素材が増えたらまた動く線である。**');
}

// --- 「比」の棚卸し：何が量を潰しているのかを、底と倍率に分けて測る（2026-09-18・2 回目）---
//
// 9/16 の 2 回目に「割合は揺れの大きさを捨てた比だった」と直し、9/18 の 1 回目に
// 「移した先の深さも比だった」と分かった。**同じ形の見落としがほかにも残っていないか**を
// 一度に見るための段。いま使っている量を全部並べて、2 通りの触り方で揺さぶる。
//
//   (A) 全体を k 倍する         … 「音量に依らない」と書いてきたのはこちら
//   (B) 一定の伴奏を下に敷く    … 声は 1 ビットも変えずに底だけを上げる
//
// **(A) はこの表のどの量も完全に不変で、(B) はどの量も不変でない。**
// 「音量に依らない」は掛け算に対しての話で、足し算に対しては誰も守られていなかった。
{
  const NAMES = [
    'modulation',
    'lowModulationDepth',
    'tone',
    'shapeChange',
    'envelopeChange',
    'speechScore',
    'harmonicity',
    'flux',
    'lowLevelSkew',
  ];
  const median = (a) => {
    const s = [...a].sort((x, y) => x - y);
    return s.length ? s[Math.floor(s.length / 2)] : NaN;
  };
  // 声のコマだけを見る。**声の証拠がどれだけ縮むか**が知りたいので、間のコマは混ぜない。
  const speechFrames = (i, hop) => {
    const t = i * hop;
    return (
      UTTERANCES.some(([from, to]) => t >= from && t < to) &&
      UTTERANCES.some(([from, to]) => t - 0.15 >= from && t - 0.15 < to) ===
        UTTERANCES.some(([from, to]) => t + 0.15 >= from && t + 0.15 < to)
    );
  };
  const measure = (data, gain = 1) => {
    const d = gain === 1 ? data : Float32Array.from(data, (v) => v * gain);
    const buffer = { sampleRate: 44100, numberOfChannels: 1, length: d.length, getChannelData: () => d };
    const track = analyzeLoudness(buffer, 0.02);
    const features = analyzeFeatures(buffer, track, featureOptions);
    const energy = energyModulationDepthDb({ hop: track.hop, db: features.lowLevel, duration: track.duration });
    const rows = Object.fromEntries(NAMES.map((n) => [n, []]));
    const extra = { level: [], energyDepth: [] };
    for (let i = 0; i < track.db.length; i += 1) {
      if (!speechFrames(i, track.hop)) continue;
      for (const n of NAMES) rows[n].push(features[n][i]);
      extra.level.push(track.db[i]);
      extra.energyDepth.push(energy[i]);
    }
    const out = { level: median(extra.level), energyDepth: median(extra.energyDepth) };
    for (const n of NAMES) out[n] = median(rows[n]);
    return out;
  };

  // `speech-flat-bgm.wav` と同じ作り。伴奏は乱数を引かないので、
  // どの行でも**声は 1 ビット同じ**（作りの詳細は make-audio.mjs の `renderShort` を参照）。
  const base = { bgm: true, bgmSwellDepth: 0, noiseLevel: 0.0005, seed: 6 };
  const levels = [0, 0.2, 0.4, 0.8, 1.2];

  console.log('\n\n(B) 一定の伴奏を下に敷くと、声の証拠はどれだけ縮むか（声は 1 ビット同じ・声のコマの中央値）\n');
  console.log(`${pad('伴奏', 6)}${pad('音量dB', 8)}${NAMES.map((n) => pad(n, 20)).join('')}${pad('ｴﾈﾙｷﾞｰの深さ', 14)}`);
  console.log('-'.repeat(14 + NAMES.length * 20 + 14));
  const first = {};
  for (const level of levels) {
    const m = measure(renderShort({ ...base, bgm: level > 0, bgmLevel: level }));
    if (level === 0) Object.assign(first, m);
    const cells = NAMES.map((n) => pad(`${m[n].toFixed(4)} (${(m[n] / first[n]).toFixed(2)})`, 20)).join('');
    // 最後の列だけは dB なので、比ではなく「何 dB 上がったか」を添える
    // （ここが「伴奏自身の揺れ」ぶん。対数のぶんと分けて読むための列）。
    const drift = m.energyDepth - first.energyDepth;
    console.log(`${pad(level, 6)}${pad(m.level.toFixed(1), 8)}${cells}${pad(`${m.energyDepth.toFixed(2)} (+${drift.toFixed(2)})`, 14)}`);
  }
  console.log('\n括弧は伴奏なしを 1.00 としたときの比。**声は 1 ビットも変えていない。**');
  console.log('`lowModulationDepth`（＝いま素材単位の判定に使っている深さ）が飛び抜けて弱い。');
  console.log('次に弱い `modulation` / `envelopeChange` でも 0.30 なのに、こちらは **0.02（45 分の 1）**。');
  console.log('`tone` と `harmonicity` だけは上がるが、**上がる向きが音楽らしさのほう**なので救いにならない');
  console.log('（伴奏そのものが音程を持つため）。`lowLevelSkew` は -1.09 → +0.25 と**符号ごと裏返る**。');
  console.log('\n右端は同じ揺れを**エネルギーの列で**測ったもの（dBFS）。伴奏を 1.2 まで上げても');
  console.log('**2.9dB（1.9 倍）しか動かない。** 深さの 45 分の 1 のうち、本当に証拠が薄まったのは');
  console.log('この 1.9 倍ぶんだけで、**残る 23 倍は対数のせい**。次の段でそこを切り分ける。');

  console.log('\n(A) 全体を k 倍する（伴奏 0.4 の同じ素材）\n');
  console.log(`${pad('倍率', 6)}${pad('音量dB', 8)}${NAMES.map((n) => pad(n, 20)).join('')}`);
  console.log('-'.repeat(14 + NAMES.length * 20));
  const rendered = renderShort({ ...base, bgmLevel: 0.4 });
  const unity = measure(rendered, 1);
  for (const k of [0.25, 1, 4]) {
    const m = measure(rendered, k);
    const cells = NAMES.map((n) => pad(`${m[n].toFixed(4)} (${(m[n] / unity[n]).toFixed(2)})`, 20)).join('');
    console.log(`${pad(k, 6)}${pad(m.level.toFixed(1), 8)}${cells}`);
  }
  console.log('\n**16 倍ぶん振っても、どの量も 1 ビット動かない。** ここだけを見て');
  console.log('「この量は音量に依らない」と書いてきたのが、3 日ぶんの取り違えのもと。');

  // --- 犯人は「比」ではなく対数だった ---
  //
  // (B) には原因が 2 つ混ざっている。**底そのもの**と、**伴奏自身の揺れ**。
  // 無相関の音を混ぜるとエネルギーの列には定数が足されるだけなので、
  // 定数は窓の平均を引く工程で消える ＝ 本来 3〜6Hz には 1 ビットも残らないはず。
  // そこで、実際の伴奏の代わりに**エネルギーの列へ直に定数を足して**切り分ける。
  console.log('\n\nエネルギーの列に「理想の一定の伴奏」（定数）を足すと、どちらが動くか\n');
  {
    const data = renderShort({ bgm: false, noiseLevel: 0.0005, seed: 6 });
    const buffer = { sampleRate: 44100, numberOfChannels: 1, length: data.length, getChannelData: () => data };
    const track = analyzeLoudness(buffer, 0.02);
    const features = analyzeFeatures(buffer, track, featureOptions);
    const power = Float64Array.from(features.lowLevel, (db) => 10 ** (Math.max(SILENCE_DB + 40, db) / 10));
    const speechIdx = [...power.keys()].filter((i) => speechFrames(i, track.hop));
    const voice = median(speechIdx.map((i) => power[i]));
    console.log(`${pad('足した定数', 12)}${pad('dB の列で測る（いま）', 24)}エネルギーの列で測る`);
    console.log('-'.repeat(58));
    for (const mult of [0, 0.25, 1, 4, 16]) {
      const db = Float32Array.from(power, (v) => 10 * Math.log10(v + voice * mult));
      const t = { hop: track.hop, db, duration: track.duration };
      const asDbTrack = modulationDepthDb(t);
      const asEnergyTrack = energyModulationDepthDb(t);
      const asDb = median(speechIdx.map((i) => asDbTrack[i]));
      const asEnergy = median(speechIdx.map((i) => asEnergyTrack[i]));
      console.log(`${pad(`×${mult}`, 12)}${pad(asDb.toFixed(3), 24)}${asEnergy.toFixed(3)}`);
    }
    console.log('\n**エネルギーの列で測ると、小数 3 桁まで 1 ビットも動かない。**');
    console.log('同じ列を dB へ直してから測ると 63 分の 1 に潰れる。**縮ませているのは対数。**');
    console.log('本物の伴奏では原因が 2 つ重なる（伴奏は一定ではないので自分の揺れも持ち込む）。');
    console.log('切り分けると、前の段の 45 分の 1 のうち**対数が 23 倍ぶん・伴奏自身の揺れが 1.9 倍ぶん**。');
    console.log('後者は本当に証拠が薄まっているので避けられないが、**前者は列の取り方の話**である。');
  }
}

// --- では対数を外せばよいのか（2026-09-18・2 回目）---
//
// 上で「潰しているのは対数」と分かったので、外した量（`energyModulationDepthDb`）で
// 素材 26 本を測り直す。**割れる。既定の深さのほうは逆転している。**
// それでも入れない理由が下の 2 行で、そこがこの回のいちばんの収穫。
{
  console.log('\n\n対数を外した深さで、素材単位の線は引けるか\n');
  console.log(`${pad('素材', 30)}${pad('声', 4)}${pad('ｴﾈﾙｷﾞｰの深さ', 14)}${pad('dB の深さ', 12)}素材の音量`);
  console.log('-'.repeat(72));
  const rows = [];
  for (const fixture of SHORT_FIXTURES) {
    const file = path.join(out, fixture.name);
    if (!fs.existsSync(file)) continue;
    const buffer = readWav(file);
    const track = analyzeLoudness(buffer, 0.02);
    const features = analyzeFeatures(buffer, track, featureOptions);
    const threshold = autoThresholdDb(track, DEFAULT_JET_CUT.sensitivity);
    const readable = lowBandReadable(features.lowLevel, threshold, modulationWindowFrames(track.hop));
    const energy = energyModulationDepthDb({ hop: track.hop, db: features.lowLevel, duration: track.duration });
    let judged = 0;
    let energyMax = -Infinity;
    let depthMax = 0;
    let sum = 0;
    for (let i = 0; i < track.db.length; i += 1) {
      sum += 10 ** (track.db[i] / 10);
      if (!readable[i]) continue;
      judged += 1;
      if (energy[i] > energyMax) energyMax = energy[i];
      if (features.lowModulationDepth[i] > depthMax) depthMax = features.lowModulationDepth[i];
    }
    // 読めたコマが足りない素材は深さでは何も言わないので、線の話からも外す。
    if (judged * track.hop < DEFAULT_JET_CUT.minDepthSeconds) continue;
    rows.push({ fixture, energyMax, depthMax, level: 10 * Math.log10(sum / track.db.length) });
  }
  rows.sort((a, b) => a.energyMax - b.energyMax);
  for (const r of rows) {
    console.log(
      `${pad((r.fixture.hard ? '※ ' : '  ') + r.fixture.name.replace('.wav', ''), 30)}${pad(r.fixture.speech ? '有' : '無', 4)}` +
        `${pad(r.energyMax.toFixed(2), 14)}${pad(r.depthMax.toFixed(3), 12)}${r.level.toFixed(1)}`,
    );
  }
  const speech = rows.filter((r) => r.fixture.speech);
  const music = rows.filter((r) => !r.fixture.speech);
  // 素材が一式そろっていないときは、片側が空のまま Math.min(...[]) が ∞ を返して
  // 「隙間 Infinity dB・重なりなし」という嘘の行が出る。そこで止める。
  if (speech.length === 0 || music.length === 0) {
    console.log(`\n声あり ${speech.length} 本 / 声なし ${music.length} 本では線の話ができない。`);
    console.log('`npm run lab:fixtures` で素材を作り直してから読むこと。');
  } else {
    const gap = Math.min(...speech.map((r) => r.energyMax)) - Math.max(...music.map((r) => r.energyMax));
    console.log(
      `\nエネルギーの深さ: 声あり最小 ${Math.min(...speech.map((r) => r.energyMax)).toFixed(2)} / ` +
        `声なし最大 ${Math.max(...music.map((r) => r.energyMax)).toFixed(2)}（隙間 ${gap.toFixed(2)}dB・**重なりなし**）`,
    );
    console.log(
      `dB の深さ（既定）: 声あり最小 ${Math.min(...speech.map((r) => r.depthMax)).toFixed(3)} / ` +
        `声なし最大 ${Math.max(...music.map((r) => r.depthMax)).toFixed(3)}（**逆転している**）`,
    );
    const normalized = rows.map((r) => r.energyMax - r.level);
    console.log(
      `素材の音量で割り戻すと: 声あり最小 ${Math.min(...rows.filter((r) => r.fixture.speech).map((r) => r.energyMax - r.level)).toFixed(2)} / ` +
        `声なし最大 ${Math.max(...rows.filter((r) => !r.fixture.speech).map((r) => r.energyMax - r.level)).toFixed(2)}（**声のほうが下**）`,
    );
    console.log(`（割り戻した列の幅は ${(Math.max(...normalized) - Math.min(...normalized)).toFixed(1)}dB）`);
    console.log('\n**それでも入れていない。** この量は素材を 2 倍すれば 6dB 上がる（検算 ⑥"）。');
    console.log(`上の隙間は ${gap.toFixed(2)}dB しかないので、**素材 1 本を ${(gap + 0.25).toFixed(2)}dB 下げれば`);
    console.log('声のある素材が音楽の側へ落ちる**（`speech-vowels-hats` を 0.5dB 下げて確かめた）。');
    console.log('手元の素材が同じ音量に揃えて作ってあるから割れて見えているだけで、');
    console.log('録音レベルの揃っていない本物の素材には使えない。**9/18 の 1 回目と同じ取り違え**');
    console.log('（最小値を「下限」と呼ぶ前に、それが何で決まっているかを見ること）を、');
    console.log('今度は**隙間の側**でやらないための行がこれ。');
    console.log('\n3 つのうち 2 つしか取れない（測って確かめた・features.ts の注に表がある）:');
    console.log('  割合   … 倍率に不変 ○ / 底に不変 ○ / 大きさを持つ ×');
    console.log('  深さ   … 倍率に不変 ○ / 底に不変 × / 大きさを持つ ○  ← いま既定');
    console.log('  ｴﾈﾙｷﾞｰ … 倍率に不変 × / 底に不変 ○ / 大きさを持つ ○');
    console.log('残っているのは**倍率の基準を窓の外から持ってくる**手だけ（素材の音量は伴奏込みなので使えない）。');
  }
}

// --- 倍率の基準を窓の外から持ってくる手は、そもそも成り立つか（2026-09-18・3 回目）---
//
// 前の回の積み残しの第一候補。`energyModulationDepthDb`（対数を外した深さ）は
// **底に不変・大きさを持つ**が、**倍率に不変でない**（素材を 2 倍すれば 6dB 上がる）。
// 残っていた道は「倍率の基準を素材の中から持ってくる」＝ 2 段階にする形だけだった。
//
// この段は、その道が**塞がっている**ことを 3 通りの基準で示す。
// 結論を先に書くと、**どの基準も、声の無い素材では背景から作られる。**
// 素材の中に「声ならこれくらいの大きさだ」と言うものが無い。
{
  const median = (a) => {
    const s = [...a].sort((x, y) => x - y);
    return s.length ? s[Math.floor(s.length / 2)] : NaN;
  };
  const dB = (v) => (v > 0 ? 10 * Math.log10(v) : NaN);

  // 素材を 1 回だけ読んで、以下の 3 つの段で使い回す（26 本 × 3 回読むと分待たされる）。
  const measured = [];
  for (const fixture of SHORT_FIXTURES) {
    const file = path.join(out, fixture.name);
    if (!fs.existsSync(file)) continue;
    const buffer = readWav(file);
    const track = analyzeLoudness(buffer, 0.02);
    const features = analyzeFeatures(buffer, track, featureOptions);
    const thresholdDb = autoThresholdDb(track, DEFAULT_JET_CUT.sensitivity);
    const readable = lowBandReadable(features.lowLevel, thresholdDb, modulationWindowFrames(track.hop));
    const energy = energyModulationDepthDb({ hop: track.hop, db: features.lowLevel, duration: track.duration });
    // 分子と同じ土俵（低い側のエネルギーの列）で基準を作る。ここを track.db で作ると
    // 「低い側の揺れを、全域の音量で割る」ことになって、何を測ったのか読めなくなる。
    const power = Float64Array.from(features.lowLevel, (db) => 10 ** (Math.max(SILENCE_DB + 40, db) / 10));

    let judged = 0;
    let energyMax = -Infinity;
    const readableEnergy = [];
    for (let i = 0; i < track.db.length; i += 1) {
      if (!readable[i]) continue;
      judged += 1;
      readableEnergy.push(energy[i]);
      if (energy[i] > energyMax) energyMax = energy[i];
    }
    // 「最大を基準に取る」を素材単位で読むための量。**最大からどれだけ離れたコマが並んでいるか。**
    // 最大そのものを基準にすると定義から 0 にしかならないので、中央のコマで見る。
    const energyMedianRel = readableEnergy.length ? median(readableEnergy) - energyMax : NaN;

    // 正解の発話区間から作る「理想の基準」。**手では作れない量**で、
    // 実装の当てではなく「作れたとしても効くのか」を先に確かめるために置いている。
    const onIdx = [];
    const offIdx = [];
    for (let i = 0; i < track.db.length; i += 1) (isSpeechAt(fixture, i * track.hop) ? onIdx : offIdx).push(i);
    const oracle = onIdx.length && offIdx.length ? median(onIdx.map((i) => power[i])) - median(offIdx.map((i) => power[i])) : NaN;

    const plan = planJetCut(
      track,
      { mode: 'speech' },
      features.speechScore,
      features.shapeChange,
      features.envelopeChange,
      features.envelopeFlux,
      features.lowLevel,
      features.lowModulationDepth,
      features.lowLevelSkew,
    );
    const kept = new Uint8Array(track.db.length);
    for (const r of plan.keep) {
      const from = Math.max(0, Math.round(r.start / track.hop));
      const to = Math.min(track.db.length, Math.round(r.end / track.hop));
      for (let i = from; i < to; i += 1) kept[i] = 1;
    }
    const keepE = [...power.keys()].filter((i) => kept[i]).map((i) => power[i]);
    const cutE = [...power.keys()].filter((i) => !kept[i]).map((i) => power[i]);
    // 1 段目の結論から作る、実際に手の届く基準（＝ 2 段階）。
    const stage2 = keepE.length && cutE.length ? median(keepE) - median(cutE) : NaN;

    measured.push({
      fixture,
      track,
      features,
      thresholdDb,
      energy,
      energyMax,
      energyMedianRel,
      judged: judged * track.hop,
      oracle,
      stage2,
      level: power.reduce((a, b) => a + b, 0) / power.length,
      cutSeconds: plan.cut.reduce((a, r) => a + (r.end - r.start), 0),
    });
  }

  console.log('\n\n2 段階の基準（発話の区間の声の大きさ）は、どの素材で作れるか\n');
  console.log(`${pad('素材', 30)}${pad('声', 4)}${pad('ｵﾗｸﾙ基準', 12)}${pad('2段階の基準', 14)}1段目が落とした秒`);
  console.log('-'.repeat(74));
  for (const m of measured) {
    if (m.judged < DEFAULT_JET_CUT.minDepthSeconds) continue;
    console.log(
      `${pad((m.fixture.hard ? '※ ' : '  ') + m.fixture.name.replace('.wav', ''), 30)}${pad(m.fixture.speech ? '有' : '無', 4)}` +
        `${pad(Number.isFinite(dB(m.oracle)) ? dB(m.oracle).toFixed(2) : '作れない', 12)}` +
        `${pad(Number.isFinite(dB(m.stage2)) ? dB(m.stage2).toFixed(2) : '作れない', 14)}${m.cutSeconds.toFixed(2)}s`,
    );
  }
  {
    const judged = measured.filter((m) => m.judged >= DEFAULT_JET_CUT.minDepthSeconds);
    const ok = (g) => judged.filter((m) => m.fixture.speech === g && Number.isFinite(dB(m.oracle))).length;
    const all = (g) => judged.filter((m) => m.fixture.speech === g).length;
    console.log(`\nオラクル基準が作れた素材: 声あり ${ok(true)}/${all(true)} ・ **声なし ${ok(false)}/${all(false)}**`);
    console.log('\n**これが行き止まりの正体。** 基準は「発話の区間の声の大きさ」なので、');
    console.log('**声の無い素材では定義そのものが無い。** ところが素材単位の判定が答えを出したいのは');
    console.log('まさにその側で、**分母が要るのは声なしの側、分母が作れるのは声ありの側**という向きになっている。');
    console.log('正解を渡しても作れないので、1 段目の精度を上げても届かない。');
    console.log('\n「基準が作れなければ声なしと決める」という逃げ道も無い。1 段目が落とした秒が 0 の素材は');
    console.log('**すでに 1 コマも削っていない**ので、その門は全素材で何も変えない（上の右端の列）。');
  }

  console.log('\n\n基準で割ると、素材単位の群は分かれるか（分子＝ｴﾈﾙｷﾞｰの深さ）\n');
  const REFS = [
    ['素材の音量', (m) => m.level],
    ['2段階', (m) => m.stage2],
    ['ｵﾗｸﾙ', (m) => m.oracle],
  ];
  console.log(`${pad('基準', 14)}${pad('作れた本数', 12)}${pad('声あり最小', 12)}${pad('声なし最大', 12)}隙間`);
  console.log('-'.repeat(62));
  for (const [name, pick] of REFS) {
    const rows = measured
      .filter((m) => m.judged >= DEFAULT_JET_CUT.minDepthSeconds && Number.isFinite(dB(pick(m))))
      .map((m) => ({ speech: m.fixture.speech, v: m.energyMax - dB(pick(m)) }));
    const sp = rows.filter((r) => r.speech).map((r) => r.v);
    const mu = rows.filter((r) => !r.speech).map((r) => r.v);
    if (!sp.length || !mu.length) {
      console.log(`${pad(name, 14)}${pad(`${rows.length} 本`, 12)}片側が空なので線の話ができない`);
      continue;
    }
    const gap = Math.min(...sp) - Math.max(...mu);
    console.log(
      `${pad(name, 14)}${pad(`${rows.length} 本`, 12)}${pad(Math.min(...sp).toFixed(2), 12)}${pad(Math.max(...mu).toFixed(2), 12)}` +
        `${gap.toFixed(2)}dB ${gap > 0 ? '← 重なりなし' : '← 混ざる'}`,
    );
  }
  console.log('\n「素材の音量」は**低い側のエネルギーの平均**（分子と同じ土俵）。前の段は全域の音量で');
  console.log('割っていて -7.27 / -2.71 だが、0.02dB しか違わない。**帯を揃えても結論は動かない。**');
  console.log('\n割らない生の分子は、この素材の並びでは**重なりなく割れる**（前の段）。');
  console.log('**どちらの基準で割っても、割れていたものが混ざる。** 基準が素材ごとの散らばりを足しているだけ。');
  console.log('「ｵﾗｸﾙ」は声なしでは作れないので、そもそも線の話にならない（それが上の表の要点）。');

  // 3 つ目の基準（その素材の深さの最大）は、割ると定義から 0 にしかならない。
  // **最大そのものではなく、最大からどれだけ離れたコマが並んでいるか**で読む。
  console.log('\n\n基準を「その素材の深さの最大」に取ったとき、コマはどこに並ぶか\n');
  console.log(`${pad('素材', 30)}${pad('声', 4)}中央のコマは最大から`);
  console.log('-'.repeat(58));
  {
    const rows = measured
      .filter((m) => m.judged >= DEFAULT_JET_CUT.minDepthSeconds && Number.isFinite(m.energyMedianRel))
      .sort((a, b) => a.energyMedianRel - b.energyMedianRel);
    for (const m of rows) {
      console.log(
        `${pad((m.fixture.hard ? '※ ' : '  ') + m.fixture.name.replace('.wav', ''), 30)}${pad(m.fixture.speech ? '有' : '無', 4)}` +
          `${m.energyMedianRel.toFixed(2)}dB`,
      );
    }
    const sp = rows.filter((m) => m.fixture.speech).map((m) => m.energyMedianRel);
    const mu = rows.filter((m) => !m.fixture.speech).map((m) => m.energyMedianRel);
    if (sp.length && mu.length) {
      console.log(`\n声あり ${Math.min(...sp).toFixed(2)}〜${Math.max(...sp).toFixed(2)}dB / 声なし ${Math.min(...mu).toFixed(2)}〜${Math.max(...mu).toFixed(2)}dB`);
      console.log('**群を分けていない。しかも並んでいる順が「声があるか」ですらない。**');
      console.log('上から順に読むと、離れている側は**黙る時間のある素材**（疎な声 -13dB 台）、');
      console.log('近い側は**鳴りっぱなしの素材**（乾いた声 -0.5dB、`bgm` -1.3dB）で、');
      console.log('音楽はその間にまんべんなく散る。**測っているのは「鳴りっぱなしか」であって声ではない。**');
    }
  }
  console.log('\nこの基準は声なしでも作れて倍率にも底にも不変（検算 ⑨）だが、');
  console.log('**素材単位では上のとおり群を分けない。** コマ単位で声なしの素材まで混ぜると:');
  {
    // 記録に引用する数字なので、使い捨ての道具ではなくここから出す。
    // 声なしの素材の**鳴っているコマ**のうち、線を超えたものの割合。
    let over = 0;
    let all = 0;
    for (const m of measured) {
      if (m.fixture.speech || !Number.isFinite(m.energyMax)) continue;
      for (let i = 0; i < m.track.db.length; i += 1) {
        if (!(m.track.db[i] > m.thresholdDb)) continue;
        all += 1;
        if (m.energy[i] - m.energyMax >= -3) over += 1;
      }
    }
    if (all) console.log(`  線 -3dB で、**音楽のコマの ${((100 * over) / all).toFixed(1)}% が「声」の側に来る**`);
  }
  console.log('  （声の無い素材では、最大そのものが背景だから）。');
  console.log('3 通りとも外れ方は同じで、**素材の中から持ってきた基準は、声が無ければ背景から作られる。**');

  // --- 副産物：対数はもう一方向にも効いていた（2026-09-18・3 回目）---
  //
  // 9/18（2 回目）に見つけたのは「対数が**声の証拠を縮める**」ほう。
  // 同じ列をコマ単位で測り直すと、**逆向き**がもう 1 つ出る。
  // dB は**小さな打点の揺れを、大きな声の揺れと同じ重さで数える**（比だから）。
  // 打点の合間は底へ落ちるので、dB の列では打点のほうが「深く」揺れて見える。
  console.log('\n\nコマ単位で、声と背景を分ける力（AUC・鳴っているコマだけ）\n');
  console.log(`${pad('素材', 30)}${pad('深さ(dB・既定)', 18)}${pad('ｴﾈﾙｷﾞｰの深さ', 16)}声/背景の中央値（dB の深さ）`);
  console.log('-'.repeat(88));
  const pooled = { db: { p: [], n: [] }, energy: { p: [], n: [] } };
  for (const m of measured) {
    if (!m.fixture.speech) continue;
    const g = { dbP: [], dbN: [], eP: [], eN: [] };
    for (let i = 0; i < m.track.db.length; i += 1) {
      // 鳴っているコマだけ。無音を当てても「声を見分けた」ことにはならない。
      if (!(m.track.db[i] > m.thresholdDb)) continue;
      const speech = isSpeechAt(m.fixture, i * m.track.hop);
      (speech ? g.dbP : g.dbN).push(m.features.lowModulationDepth[i]);
      (speech ? g.eP : g.eN).push(m.energy[i]);
    }
    pooled.db.p.push(...g.dbP);
    pooled.db.n.push(...g.dbN);
    pooled.energy.p.push(...g.eP);
    pooled.energy.n.push(...g.eN);
    const a1 = auc(g.dbP, g.dbN);
    const a2 = auc(g.eP, g.eN);
    if (a1 === null) continue;
    // 既定の量が 0.5 を割る＝**偶然より悪い**素材に印を付ける。そこがこの段の眼目。
    const flag = a1 < 0.5 ? ' ← 偶然以下' : '';
    console.log(
      `${pad((m.fixture.hard ? '※ ' : '  ') + m.fixture.name.replace('.wav', ''), 30)}${pad(a1.toFixed(3) + flag, 18)}` +
        `${pad(a2 === null ? '—' : a2.toFixed(3), 16)}${median(g.dbP).toFixed(2)} / ${median(g.dbN).toFixed(2)}`,
    );
  }
  console.log('-'.repeat(88));
  {
    // 素材が一式そろっていないと片側が空になる。`auc` は null を返すので、
    // そのまま toFixed すると落ちる（数字が出ないのは構わないが、段ごと止まるのは困る）。
    const a1 = auc(pooled.db.p, pooled.db.n);
    const a2 = auc(pooled.energy.p, pooled.energy.n);
    console.log(
      `${pad('全部混ぜて 1 本の線', 30)}${pad(a1 === null ? '—' : a1.toFixed(3), 18)}${a2 === null ? '—' : a2.toFixed(3)}`,
    );
  }
  console.log('\n**既定の深さは、打楽器の上では偶然より悪い。** 声と背景の中央値が逆転している');
  console.log('（`speech-drums` は 声 5.52 に対して打点 6.14 で、**打点のほうが深く揺れて見える**）。');
  console.log('対数は比なので、**-30dB の打点の「10 倍」と、声の「10 倍」を同じ 10dB として数える。**');
  console.log('打点の合間は底へ落ちるので、小さい打点ほど dB の列では深く見える。');
  console.log('エネルギーの列で測ると向きが戻る（`speech-vowels-hats` は 2.60/2.35 が -25.27/-57.23 になる）。');
  console.log('\n9/18（2 回目）に見つけたのは「対数が**声の証拠を縮める**」ほうだった。');
  console.log('**同じ 1 行が、コマ単位では逆向きにも効いている。** 3 日追ってきた打点の問題と同じ根。');

  // --- では「深さの最大」を基準にコマ単位の門を置けるか ---
  //
  // 素材単位では上のとおり駄目だが、**コマ単位の門は素材単位の判定が通した先でしか働かない。**
  // ＝声ありと決まった素材の中だけで見れば、「最大は声である」が成り立つ余地がある。
  // 倍率にも底にも不変で、声なしでも作れる（作っても意味が無いだけ）ので、形としては筋がよい。
  console.log('\n\n声ありの素材だけで、コマ単位の線を振る（基準＝その素材の深さの最大）\n');
  console.log(`${pad('線', 10)}${pad('声を残せた率', 16)}${pad('残したうち声', 16)}落とした背景のコマ`);
  console.log('-'.repeat(62));
  const forSweep = measured.filter((m) => m.fixture.speech && Number.isFinite(m.energyMax));
  const sweep = (pick) => {
    let tp = 0;
    let fn = 0;
    let fp = 0;
    let tn = 0;
    for (const m of forSweep) {
      for (let i = 0; i < m.track.db.length; i += 1) {
        if (!(m.track.db[i] > m.thresholdDb)) continue;
        const speech = isSpeechAt(m.fixture, i * m.track.hop);
        const keep = pick(m, i);
        if (speech) keep ? (tp += 1) : (fn += 1);
        else keep ? (fp += 1) : (tn += 1);
      }
    }
    // 素材が欠けていると分母が 0 になる。NaN% を並べても読めないので「—」で出す。
    const rate = (a, b) => (a + b > 0 ? `${((100 * a) / (a + b)).toFixed(1)}%` : '—');
    return { recall: rate(tp, fn), precision: rate(tp, fp), rejected: rate(tn, fp) };
  };
  for (const x of [1, 2, 3, 4, 6, 8, 12]) {
    const r = sweep((m, i) => m.energy[i] - m.energyMax >= -x);
    console.log(`${pad(`-${x}dB`, 10)}${pad(r.recall, 16)}${pad(r.precision, 16)}${r.rejected}`);
  }
  {
    const now = sweep((m, i) => m.features.speechScore[i] >= DEFAULT_JET_CUT.speechThreshold);
    console.log(`\n${pad(`いまの声らしさ ${DEFAULT_JET_CUT.speechThreshold}`, 22)}${now.recall} / ${now.precision} / ${now.rejected}`);
  }
  console.log('\n**-6dB の線は、3 つの数字とも今のコマ単位の判定を上回る。** それでも入れていない。');
  console.log('理由は下の「読めた秒」で、`speech-sparse-thump-loud.wav`（打点だけを 2 倍にした素材）が出す:');
  console.log('');
  console.log(`${pad('素材', 32)}${pad('読めた秒', 12)}深さの最大`);
  console.log('-'.repeat(60));
  for (const name of ['speech-sparse-thump.wav', 'speech-sparse-thump-loud.wav']) {
    const m = measured.find((x) => x.fixture.name === name);
    if (!m) continue;
    console.log(
      `${pad('※ ' + name.replace('.wav', ''), 32)}${pad(m.judged.toFixed(2) + 's', 12)}` +
        `${Number.isFinite(m.energyMax) ? m.energyMax.toFixed(2) : '読めるコマなし'}`,
    );
  }
  console.log('\n**壊れるのではなく、消える。** 0.04s は**コマ 2 つ**なので、');
  console.log('基準（その素材の深さの最大）がコマ 2 つで決まっている＝もう何も測れていない。');
  console.log('打点が大きくなると低い側が打点の合間にへこみ、');
  console.log('`lowBandReadable`（窓が丸ごと鳴っているか）が読めるコマを返さなくなる。');
  console.log('門は誤るのではなく**自分から働かなくなる**ので、数字の上では何も悪くならない。');
  console.log('**いちばん要る素材でだけ、静かに居なくなる門**を入れることになる。');
  console.log('2026-09-17 の「門は読めるコマにしか触れない」が、別の場所でもう一度出た形。');
  console.log('\n次にここへ戻るなら、**`lowBandReadable` のしきい値**から。');
  console.log('いまは全域と同じ自動しきい値を低い側にも当てているので、低い側が大きい素材ほど読めなくなる。');
  console.log('（2026-09-17 の「狭めた帯で測るなら、しきい値も一緒に持ち直すこと」と同じ相手。）');
  console.log('→ **2026-09-19 に持ち直した。次の段を参照。**');
}

// --- 低い側の線を持ち直す（2026-09-19）---
//
// 前の回の積み残しの第一候補。上の段の最後で行き止まりになっていた相手。
//
// 直す前の形: 低い側を「鳴っている」とみなす線に、**全域の自動しきい値をそのまま当てていた。**
// 目盛りは合っている（低い側の音量は全域の音量に取り分を掛け戻して作ってある）が、
// **線の決め方が全域の分布に乗っている**（底から 25%）。低い側で鳴っているものを大きくすると
// 全域の分布が広がって線が上がり、低い側の谷はそこに置いたまま線の下へ落ちる。
//
// この段は 4 通りの置き方を並べる。結論を先に書くと、
// **「その場の低い側の大きさから 20dB 下」が要る 3 つを同時に満たした。**
{
  const LINES = [
    ['A 全域(旧)', (f, thr) => thr],
    ['B 低い側の自動', (f, thr) => autoThresholdDb({ hop: 1, db: f.lowLevel, duration: f.lowLevel.length }, DEFAULT_JET_CUT.sensitivity)],
    ['C 素材のp90-20', (f, thr) => percentileDb({ hop: 1, db: f.lowLevel, duration: f.lowLevel.length }, 0.9) - 20],
    ['D その場-20', (f, thr, hop) => lowBandLineDb(f.lowLevel, thr, 20, hop)],
  ];

  const measured = [];
  for (const fixture of SHORT_FIXTURES) {
    const file = path.join(out, fixture.name);
    if (!fs.existsSync(file)) continue;
    const buffer = readWav(file);
    const track = analyzeLoudness(buffer, 0.02);
    const features = analyzeFeatures(buffer, track, featureOptions);
    const thresholdDb = autoThresholdDb(track, DEFAULT_JET_CUT.sensitivity);
    const wf = modulationWindowFrames(track.hop);
    const energy = energyModulationDepthDb({ hop: track.hop, db: features.lowLevel, duration: track.duration });
    const marks = LINES.map(([, pick]) => lowBandReadable(features.lowLevel, pick(features, thresholdDb, track.hop), wf));
    measured.push({ fixture, track, features, thresholdDb, energy, marks });
  }

  /** 印の列から「読めた秒」と「そこで読める深さの最大」を出す。 */
  const readOf = (m, marks, depth) => {
    let judged = 0;
    let max = 0;
    for (let i = 0; i < marks.length; i += 1) {
      if (!marks[i]) continue;
      judged += 1;
      if (depth[i] > max) max = depth[i];
    }
    return { judged: judged * m.track.hop, max };
  };

  console.log('\n\n低い側の線をどこに置くか（読めた秒 / 深さの最大 dB）\n');
  console.log(`${pad('素材', 30)}${LINES.map(([name]) => pad(name, 18)).join('')}`);
  console.log('-'.repeat(30 + 18 * LINES.length));
  for (const m of measured) {
    const cells = m.marks.map((marks) => {
      const r = readOf(m, marks, m.features.lowModulationDepth);
      return pad(`${r.judged.toFixed(2)}s / ${r.max.toFixed(2)}`, 18);
    });
    console.log(`${pad((m.fixture.hard ? '※ ' : '  ') + m.fixture.name.replace('.wav', ''), 30)}${cells.join('')}`);
  }
  console.log('\n読みどころは 3 つある。**どれか 1 つを見て決めると、ほかの 2 つで外れる。**');
  console.log('  ① 直したい相手: `speech-sparse-thump-loud`（打点だけを 2 倍）。A では 0.04s ＝ コマ 2 つ。');
  console.log('     **B（低い側の分布に同じ規則を当てる）では直らない。** 底から 25% という決め方が');
  console.log('     揺れの中を通るので、揺れが大きくなるほど線が上がって同じことが起きる。');
  console.log('  ② 縁を外し続けているか: `music-hats-break` は縁を数えると 2.77dB、外すと 0.32dB。');
  console.log('     C も D も 0.32 のままで、**縁の段差は入っていない。**');
  console.log('  ③ 潰し素材でも消えないか: `speech-bgm-fade`（伴奏がフェードアウトする）。下の表。');

  console.log('\n\n潰し素材（伴奏が 13 秒で 24dB 下がる）を、前半と後半に割って読む\n');
  console.log(`${pad('線', 18)}${pad('前半', 10)}${pad('後半', 10)}後半で何が起きているか`);
  console.log('-'.repeat(70));
  {
    const m = measured.find((x) => x.fixture.name === 'speech-bgm-fade.wav');
    if (m) {
      const mid = Math.floor(m.track.db.length / 2);
      // C（素材ぜんたいの p90）は、大きかった頃の値が小さくなった側にも残る。
      // そこを見るために 14dB 下も並べる（20dB では素材が足りず、まだ届かないだけ）。
      const extra = [['C 素材のp90-14', percentileDb({ hop: 1, db: m.features.lowLevel, duration: m.features.lowLevel.length }, 0.9) - 14],
                     ['D その場-14', lowBandLineDb(m.features.lowLevel, m.thresholdDb, 14, m.track.hop)]];
      const rows = [
        ...LINES.map(([name, pick], k) => [name, m.marks[k]]),
        ...extra.map(([name, line]) => [name, lowBandReadable(m.features.lowLevel, line, modulationWindowFrames(m.track.hop))]),
      ];
      for (const [name, marks] of rows) {
        let first = 0;
        let second = 0;
        for (let i = 0; i < marks.length; i += 1) if (marks[i]) (i < mid ? (first += 1) : (second += 1));
        const note = second * m.track.hop < 1.28 ? '← 深さで判断できる秒数を割る' : '';
        console.log(`${pad(name, 18)}${pad(`${(first * m.track.hop).toFixed(2)}s`, 10)}${pad(`${(second * m.track.hop).toFixed(2)}s`, 10)}${note}`);
      }
      console.log('\n**素材ぜんたいの分位点（C）で取ると、後半が大きかった頃の線で測られる。**');
      console.log('この素材（24dB 下がる）の 20dB 下では C と D の差は 0.02s で、**まだ punisher になっていない。**');
      console.log('差が出るのは幅を狭めたとき（14dB 下で C 1.18s ＜ 全域の線 2.12s）と、');
      console.log('フェードをきつくしたとき（30dB 下がる素材で C は全域の線と同じ 1.92s まで落ち、D は 2.08s）。');
      console.log('**「素材の中で低い側の大きさが動く」は、フェード・ダッキング・盛り上がりでごく普通に起きる。**');
      console.log('その場の大きさから取れば線が一緒に下がるので、D はどの幅でも先に落ちない。');
      console.log('（素材は 24dB にしてある。それ以上は「フェードアウトして消える」ほうへ寄りすぎるので、');
      console.log('  きつい側は上の数字を記録に残すだけにした。）');
    }
  }

  // --- 筋が悪いと分かって引き返した手も残す ---
  //
  // 「線の高さ」ではなく「へこみが続いた長さ」で決める形も測った。
  // 打点の減衰は 1〜2 コマ、曲の切れ目は数十コマなので、**長さで割れるはず**という読み。
  console.log('\n\n引き返した手: 線は現行のまま「へこみが N コマ以上続いたら読めない」にする\n');
  console.log(`${pad('素材', 30)}${[1, 3, 5, 8].map((g) => pad(`${g}ｺﾏ`, 16)).join('')}`);
  console.log('-'.repeat(30 + 16 * 4));
  {
    const runReadable = (lowLevel, thresholdDb, windowFrames, gapFrames) => {
      const frames = lowLevel.length;
      const bad = new Uint8Array(frames);
      let run = 0;
      for (let i = 0; i <= frames; i += 1) {
        const quiet = i < frames && !(lowLevel[i] > thresholdDb && lowLevel[i] > SILENCE_DB);
        if (quiet) {
          run += 1;
          continue;
        }
        if (run >= Math.max(1, gapFrames)) for (let k = i - run; k < i; k += 1) bad[k] = 1;
        run = 0;
      }
      const pre = new Int32Array(frames + 1);
      for (let i = 0; i < frames; i += 1) pre[i + 1] = pre[i] + bad[i];
      const half = windowFrames >> 1;
      const marks = new Uint8Array(frames);
      for (let i = 0; i < frames; i += 1) {
        const from = i - half;
        const to = from + windowFrames - 1;
        if (from < 0 || to >= frames) continue;
        if (pre[to + 1] - pre[from] > 0) continue;
        marks[i] = 1;
      }
      return marks;
    };
    // 眼目が出る 3 本だけ。全 38 本を並べても読みどころは同じところにある。
    for (const name of ['speech-sparse-thump-loud.wav', 'music-thump-break.wav', 'music-flute.wav']) {
      const m = measured.find((x) => x.fixture.name === name);
      if (!m) continue;
      const cells = [1, 3, 5, 8].map((g) => {
        const r = readOf(m, runReadable(m.features.lowLevel, m.thresholdDb, modulationWindowFrames(m.track.hop), g), m.features.lowModulationDepth);
        return pad(`${r.judged.toFixed(2)}s / ${r.max.toFixed(2)}`, 16);
      });
      console.log(`${pad('※ ' + name.replace('.wav', ''), 30)}${cells.join('')}`);
    }
    console.log('\n**駄目だった。逃がした先で、縁が丸ごと入る。**');
    console.log('直したい素材が届くのは 8 コマ（0.16 秒）以上で、そこでは `music-thump-break` の深さが');
    console.log('1.79 → **15.64dB**、`music-flute` が 0.10 → **14.74dB** になる（縁の段差そのもの）。');
    console.log('**曲の切れ目は「低い側が無音になる」形ではない。** 伴奏は鳴り続けていて、');
    console.log('低い段のまま時々へこむだけなので、へこみの続きは短い。長さでは切れ目と打点が割れない。');
    console.log('**縁を外せているのは「1 コマでも線を割ったら窓ごと捨てる」厳しさのおかげだった。**');

  console.log('\n\n読めるコマが直ったので、コマ単位の -6dB の門を測り直す（前回は測れなかった）\n');
  console.log(`${pad('線', 10)}${pad('声を残せた率', 16)}${pad('残したうち声', 16)}落とした背景のコマ`);
  console.log('-'.repeat(62));
  {
    // 前の段とまったく同じ形の表。違うのは**基準（その素材の深さの最大）を、
    // 直した線で読めるコマから取っている**ところだけ。
    const forSweep = measured.filter((m) => m.fixture.speech);
    const maxOf = (m, which) => {
      let max = -Infinity;
      for (let i = 0; i < m.marks[which].length; i += 1) if (m.marks[which][i] && m.energy[i] > max) max = m.energy[i];
      return max;
    };
    const sweep = (pick, which) => {
      let tp = 0;
      let fn = 0;
      let fp = 0;
      let tn = 0;
      for (const m of forSweep) {
        const base = maxOf(m, which);
        if (!Number.isFinite(base)) continue;
        for (let i = 0; i < m.track.db.length; i += 1) {
          if (!(m.track.db[i] > m.thresholdDb)) continue;
          const speech = isSpeechAt(m.fixture, i * m.track.hop);
          const keep = pick(m, i, base);
          if (speech) keep ? (tp += 1) : (fn += 1);
          else keep ? (fp += 1) : (tn += 1);
        }
      }
      const rate = (a, b) => (a + b > 0 ? `${((100 * a) / (a + b)).toFixed(1)}%` : '—');
      return { recall: rate(tp, fn), precision: rate(tp, fp), rejected: rate(tn, fp) };
    };
    for (const x of [3, 4, 6, 8, 12]) {
      const r = sweep((m, i, base) => m.energy[i] - base >= -x, 3);
      console.log(`${pad(`-${x}dB`, 10)}${pad(r.recall, 16)}${pad(r.precision, 16)}${r.rejected}`);
    }
    const now = sweep((m, i) => m.features.speechScore[i] >= DEFAULT_JET_CUT.speechThreshold, 3);
    console.log(`\n${pad(`いまの声らしさ ${DEFAULT_JET_CUT.speechThreshold}`, 22)}${now.recall} / ${now.precision} / ${now.rejected}`);
    const old = sweep((m, i, base) => m.energy[i] - base >= -6, 0);
    console.log(`${pad('-6dB（直す前の線で）', 22)}${old.recall} / ${old.precision} / ${old.rejected}`);
    console.log('\n基準を取り直しても -6dB は今の判定を上回るが、**前回の数字とは違う。**');
    console.log('読めるコマが増えたぶん基準（最大）が上がるので、同じ -6dB でも線は下がる。');
    console.log('**「門の形は同じでも、上流が変われば線は引き直し」**ということ。');
  }
  }
}

// --- 2026-09-19（2 回目）: 入れた門を、素材ごとにどう当たっているかで読む ---
//
// 前の回の積み残しの第一候補（「エネルギーの深さをコマ単位の門に置く」）を既定にした。
// 線は「その素材の読めるコマでの最大から 6dB 下」。
//
// **入れる前のいちばんの心配は「基準（最大）が声だとは決まっていない」ところ**だった。
// ここはその心配を素材ごとに数字で潰す段で、見るのは 3 つ:
//   ① 基準を出すコマが、本当に声の区間に居るか（声のある素材で）
//   ② 門が落とすのは背景か、声か
//   ③ 潰しにいった素材で、どういう外れ方をするか
{
  console.log('\n\n入れた門（最大から -6dB）が、素材ごとにどう当たっているか\n');
  console.log(`${pad('素材', 30)}${pad('読めた秒', 10)}${pad('基準dB', 9)}${pad('基準は', 8)}${pad('落とす声%', 11)}落とす背景%`);
  console.log('-'.repeat(78));
  const DROP = DEFAULT_JET_CUT.minEnergyDepthDrop || 6;
  let baseFromSpeech = 0;
  let baseTotal = 0;
  for (const fixture of SHORT_FIXTURES) {
    const file = path.join(out, fixture.name);
    if (!fs.existsSync(file)) continue;
    const buffer = readWav(file);
    const track = analyzeLoudness(buffer, 0.02);
    const features = analyzeFeatures(buffer, track, featureOptions);
    const thresholdDb = autoThresholdDb(track, DEFAULT_JET_CUT.sensitivity);
    const line = lowBandLineDb(features.lowLevel, thresholdDb, DEFAULT_JET_CUT.lowBandRangeDb, track.hop);
    const readable = lowBandReadable(features.lowLevel, line, modulationWindowFrames(track.hop));
    const column = features.lowEnergyDepth;
    let base = -Infinity;
    let baseAt = -1;
    let readableFrames = 0;
    for (let i = 0; i < readable.length; i += 1) {
      if (!readable[i]) continue;
      readableFrames += 1;
      if (column[i] > base) {
        base = column[i];
        baseAt = i;
      }
    }
    // ① 基準のコマが声かどうか。**門そのものより先に、ここが崩れていないかを見る。**
    const baseIsSpeech = baseAt >= 0 && isSpeechAt(fixture, baseAt * track.hop);
    if (fixture.speech && baseAt >= 0) {
      baseTotal += 1;
      if (baseIsSpeech) baseFromSpeech += 1;
    }
    // ② 門が触れるのは読めるコマだけ。そこを声と背景に分けて数える。
    let sp = 0;
    let spDrop = 0;
    let bg = 0;
    let bgDrop = 0;
    for (let i = 0; i < track.db.length; i += 1) {
      if (!(track.db[i] > thresholdDb && track.db[i] > SILENCE_DB) || !readable[i]) continue;
      const speech = isSpeechAt(fixture, i * track.hop);
      const drop = Number.isFinite(base) && column[i] - base < -DROP;
      if (speech) {
        sp += 1;
        if (drop) spDrop += 1;
      } else {
        bg += 1;
        if (drop) bgDrop += 1;
      }
    }
    const rate = (a, b) => (b > 0 ? `${((100 * a) / b).toFixed(0)}%` : '—');
    console.log(
      `${pad((fixture.hard ? '※ ' : '  ') + fixture.name.replace('.wav', ''), 30)}` +
        `${pad((readableFrames * track.hop).toFixed(2) + 's', 10)}` +
        `${pad(Number.isFinite(base) ? base.toFixed(2) : '—', 9)}` +
        `${pad(baseAt < 0 ? '—' : baseIsSpeech ? '声' : '背景', 8)}` +
        `${pad(rate(spDrop, sp), 11)}${rate(bgDrop, bg)}`,
    );
  }
  console.log(`\n**基準が声の区間から取れている声のある素材: ${baseFromSpeech} / ${baseTotal} 本**（読めるコマを持つものだけ）。`);
  console.log('入れる前の心配（最大が声だとは決まっていない）は、**声のある素材では起きていない。**');
  console.log('理由は門の側ではなく読めるコマの条件にある。窓が丸ごと鳴っているコマしか読まないので、');
  console.log('**合間にへこむもの（打点・刻み）は、深く揺れていても基準を取りにいけない。**');
  console.log('\n声の無い素材では基準は背景から取れる。そこで門が落とすのは「その素材の中でいちばん');
  console.log('揺れていない背景」なので、**声ゼロの素材に対しては門が正しいほど切る秒が増える**。');
  console.log('実際 `music-thump-drop`（声ゼロなのに素材単位の判定を通る 1 本）は 1.60s → 2.96s。');
  console.log('**門は「ここは声でない」を正しく言っていて、それを受け止める素材単位の判定が無い**のが残っている穴。');

  console.log('\n\n潰しにいった素材 2 本の外れ方（どちらも「声を食う」ではなく「黙る」）\n');
  console.log('  ※ speech-sparse-thump-loud（打点が声より深い）: 基準 -19.74 と 3dB 以上高く、');
  console.log('     **基準を打点に奪われる**。落とす背景は 3%（ほかの素材は 55〜100%）で、門は誤らずに効かなくなる。');
  console.log('  ※ speech-sustained-thump（今回足した。伸ばした声＋低い側の打点）: 読めた秒が 2.56s しか無く、');
  console.log('     **基準は声から取れた**（打点のへこみが読めるコマから外れるため）。落とす声 14% で残せた率は動かない。');
  console.log('\n**2 通り試して 2 通りとも「黙る」だった。** 声を食う形で外せたのは');
  console.log('`speech-clipped-bgm`（短く区切る声）だけで、そこは残せた率 100% → 96% と引き換えに精度 20% → 88%。');
}
