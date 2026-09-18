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

const { analyzeLoudness, SILENCE_DB } = await import('./src/loudness.ts');
const { analyzeFeatures, energyModulationDepthDb, FEATURE_NAMES, MOD_SPLIT_HZ, modulationDepthDb, modulationWindowFrames } =
  await import('./src/features.ts');

const { autoThresholdDb, cutSoundingSeconds, DEFAULT_JET_CUT, envelopeGateFrames, lowBandDepthSeconds, lowBandReadable, planJetCut } =
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
