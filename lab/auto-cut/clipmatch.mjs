/**
 * クリップごとの音量合わせ（`src/clip-match.ts`）を、試し用の素材で測る。
 *
 *   npm run lab:fixtures     # 先に素材を作る
 *   npm run lab:clipmatch
 *   LAB_REF=mean npm run lab:clipmatch      # 基準の決め方を振る（median / mean / loudest / 数値）
 *   LAB_BOOST=6 LAB_CUT=24 npm run lab:clipmatch   # 上限を振る
 *   LAB_RAW=1 npm run lab:clipmatch         # 1ch を 1ch のまま測る（既定は 2ch 扱い）
 *
 * `lab:loudness` とは見ているものが違う。あちらは**タイムライン全体**を目標の大きさへ
 * 合わせる話で、こちらは**その中のクリップどうし**を揃える話。順番は
 * 「クリップごとに揃える（ここ）→ 繋ぐ → 全体を目標へ → 均す」。
 *
 * **ここでいちばん大事なのは、いちばん下に出る「声の開き」のほう。**
 * クリップの開きは測った値をそのまま引き算しただけなので、必ず縮む（当たり前）。
 * 知りたいのは「クリップの大きさで揃えて、**声**が揃ったのか」で、
 * そこは `spec.mjs` の発話区間の正解と突き合わせないと出ない。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readWav } from '../fixtures/wav.mjs';
import { SHORT_FIXTURES, utterancesOf } from '../fixtures/spec.mjs';

const { measureLoudness, planLoudnessNormalization, applyGain, DEFAULT_NORMALIZATION } = await import('./src/lufs.ts');
const { limitTruePeak, DEFAULT_LIMITER } = await import('./src/limiter.ts');
const { measureClips, planClipMatch, applyClipGains, concatRanges, DEFAULT_CLIP_MATCH } = await import(
  './src/clip-match.ts'
);
const { analyzeLoudness } = await import('./src/loudness.ts');
const { analyzeFeatures } = await import('./src/features.ts');
const { planJetCut } = await import('./src/silence.ts');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dir = path.join(root, 'lab/fixtures/out');
if (!fs.existsSync(dir)) {
  console.error('試し用の素材がありません。先に `npm run lab:fixtures` を実行してください。');
  process.exit(1);
}

const dualMono = process.env.LAB_RAW !== '1';
const loudnessOptions = { monoAsDualMono: dualMono, skipTruePeak: true };
const refOption = process.env.LAB_REF
  ? Number.isNaN(Number(process.env.LAB_REF))
    ? process.env.LAB_REF
    : Number(process.env.LAB_REF)
  : DEFAULT_CLIP_MATCH.reference;
const maxBoostDb = Number(process.env.LAB_BOOST ?? DEFAULT_CLIP_MATCH.maxBoostDb);
const maxCutDb = Number(process.env.LAB_CUT ?? DEFAULT_CLIP_MATCH.maxCutDb);

const pad = (s, n) => String(s).padEnd(n, ' ');
const num = (s, n) => String(s).padStart(n, ' ');
const dec = (v, n = 2) => (v === null || v === undefined || Number.isNaN(v) ? '—' : v.toFixed(n));
const spread = (xs) => (xs.length > 0 ? Math.max(...xs) - Math.min(...xs) : 0);

// --- 素材を 1 本 1 クリップとして読み込む ---
const clips = [];
for (const f of SHORT_FIXTURES) {
  const file = path.join(dir, f.name);
  if (!fs.existsSync(file)) continue;
  clips.push({ id: f.name.replace('.wav', ''), buffer: readWav(file), fixture: f });
}
if (clips.length === 0) {
  console.error('素材が 1 本も読めませんでした。');
  process.exit(1);
}

// 発話区間の正解で測った「声そのものの大きさ」。揃ったかどうかはここで判定する。
const truthLufs = new Map();
for (const c of clips) {
  const utt = utterancesOf(c.fixture).map(([start, end]) => ({ start, end }));
  if (utt.length === 0) continue;
  const only = concatRanges(c.buffer, utt);
  if (!only) continue;
  truthLufs.set(c.id, measureLoudness(only, loudnessOptions).integratedLufs);
}

console.log(
  `素材 ${clips.length} 本を 1 本 1 クリップとして並べた。` +
    `基準 ${typeof refOption === 'number' ? `${refOption} LUFS（直指定）` : refOption} ／ ` +
    `上限 上げ ${maxBoostDb}dB・下げ ${maxCutDb}dB ／ ` +
    `1ch の素材は ${dualMono ? '2ch 扱い' : '1ch のまま'}で測る\n`,
);

// ============================================================
// 1. クリップごとに倍率を決める
// ============================================================
const measured = measureClips(clips, loudnessOptions);
const plan = planClipMatch(measured, { reference: refOption, maxBoostDb, maxCutDb });

console.log('## 1. クリップごとの倍率\n');
console.log(
  `${pad('クリップ', 30)}${num('LUFS', 8)}${num('倍率dB', 8)}${num('後LUFS', 8)}${num('欲しかったdB', 13)}  ${pad('止めたもの', 12)}声の正解`,
);
console.log('-'.repeat(96));
for (const g of plan.gains) {
  const t = truthLufs.get(g.id);
  console.log(
    `${pad(g.id, 30)}${num(dec(g.lufs), 8)}${num(dec(g.gainDb), 8)}${num(dec(g.resultLufs), 8)}` +
      `${num(dec(g.wantedDb), 13)}  ${pad(g.limitedBy === 'none' ? '' : g.limitedBy, 12)}` +
      `${t === undefined ? '（声なし）' : dec(t)}`,
  );
}
console.log(
  `\n基準 ${dec(plan.referenceLufs)} LUFS ／ ` +
    `クリップどうしの開き ${dec(plan.spreadBefore)} LU → ${dec(plan.spreadAfter)} LU`,
);
const capped = plan.gains.filter((g) => g.limitedBy === 'cap');
if (capped.length > 0) {
  console.log(
    `上限に当たったクリップ（中身を確かめたほうがよい）: ` +
      capped.map((g) => `${g.id}（${dec(g.wantedDb)} → ${dec(g.gainDb)}dB）`).join(' / '),
  );
}

// **揃えたかったのは声のほう。** 正解で測り直す。
const speechIds = plan.gains.filter((g) => truthLufs.has(g.id));
const speechBefore = speechIds.map((g) => truthLufs.get(g.id));
const speechAfter = speechIds.map((g) => truthLufs.get(g.id) + g.gainDb);
// **上限に当たったクリップを混ぜたままだと、上限の話と測り方の話が混ざる。** 分けて出す。
const freeIds = speechIds.filter((g) => g.limitedBy === 'none');
const freeAfter = freeIds.map((g) => truthLufs.get(g.id) + g.gainDb);
console.log(
  `**声の開き（正解で測った）: ${dec(spread(speechBefore))} LU → ${dec(spread(speechAfter))} LU**` +
    `（声のある ${speechIds.length} 本）\n` +
    `  うち上限に当たらなかった ${freeIds.length} 本だけで見ると ${dec(spread(freeAfter))} LU。` +
    `**残りは測り方の限界で、上限を緩めても縮まない**（2 の段を参照）。`,
);

// ============================================================
// 2. 測る場所を変えたら良くなるか（クリップ全体 / 自動カットが残した区間 / 正解）
// ============================================================
console.log('\n## 2. どこを測れば声が揃うか（正解つき）\n');
console.log('自動カットの結果を持ってくると `clip-match` が `silence.ts` に依存する。その代価に見合うかを見る。');

const byWhere = { whole: [], kept: [], truth: [] };
for (const c of clips) {
  const t = truthLufs.get(c.id);
  if (t === undefined || t === null) continue;
  const track = analyzeLoudness(c.buffer, 0.02);
  const feat = analyzeFeatures(c.buffer, track);
  const cut = planJetCut(
    track,
    { mode: 'speech' },
    feat.speechScore,
    feat.shapeChange,
    feat.envelopeChange,
    feat.envelopeFlux,
    feat.lowLevel,
    feat.lowModulationDepth,
    feat.lowLevelSkew,
    feat.lowEnergyDepth,
  );
  const keptBuffer = concatRanges(c.buffer, cut.keep);
  const whole = measureLoudness(c.buffer, loudnessOptions).integratedLufs;
  const kept = keptBuffer ? measureLoudness(keptBuffer, loudnessOptions).integratedLufs : null;
  // 揃えたあとの声 = 正解 + (基準 - 測った値)。基準は定数なので、ずれ幅だけ見ればよい。
  byWhere.whole.push(t - whole);
  byWhere.kept.push(kept === null ? t - whole : t - kept);
  byWhere.truth.push(0);
}
for (const [label, key] of [
  ['クリップ全体で測る（いまの既定）', 'whole'],
  ['自動カットが残した区間で測る', 'kept'],
  ['発話の正解で測る（届く上限）', 'truth'],
]) {
  console.log(
    `  ${pad(label, 34)} 揃えたあとの声の開き ${num(dec(spread(byWhere[key])), 6)} LU` +
      `（ずれ ${dec(Math.min(...byWhere[key]))}〜${dec(Math.max(...byWhere[key]))}）`,
  );
}

// ============================================================
// 3. 群（同じ撮影のかけらを 1 つの倍率でまとめる）
// ============================================================
console.log('\n## 3. 自動カットが刻んだ「かけら」を、ばらばらに揃えるとどうなるか\n');
for (const name of ['speech', 'speech-bgm', 'speech-noisy', 'speech-sparse-bgm']) {
  const c = clips.find((x) => x.id === name);
  if (!c) continue;
  const track = analyzeLoudness(c.buffer, 0.02);
  const feat = analyzeFeatures(c.buffer, track);
  const cut = planJetCut(
    track,
    { mode: 'speech' },
    feat.speechScore,
    feat.shapeChange,
    feat.envelopeChange,
    feat.envelopeFlux,
    feat.lowLevel,
    feat.lowModulationDepth,
    feat.lowLevelSkew,
    feat.lowEnergyDepth,
  );
  const pieces = cut.keep
    .map((r, i) => {
      const buffer = concatRanges(c.buffer, [r]);
      return buffer ? { id: `${name}#${i}`, buffer, group: name } : null;
    })
    .filter(Boolean);
  if (pieces.length === 0) continue;

  // ①かけらごとに別の群（＝ばらばらに揃える） ②ひとまとめ（＝いまの既定の使い方）
  const apart = planClipMatch(
    measureClips(
      pieces.map((p) => ({ ...p, group: p.id })),
      loudnessOptions,
    ),
    { reference: refOption, maxBoostDb, maxCutDb },
  );
  const together = planClipMatch(measureClips(pieces, loudnessOptions), {
    reference: refOption,
    maxBoostDb,
    maxCutDb,
  });
  // 隣り合うかけらの倍率の差 ＝ 切れ目で部屋の音が跳ぶ幅。
  let step = 0;
  for (let i = 1; i < apart.gains.length; i += 1) {
    step = Math.max(step, Math.abs(apart.gains[i].gainDb - apart.gains[i - 1].gainDb));
  }
  console.log(
    `  ${pad(name, 22)} かけら ${num(pieces.length, 2)} 個 ／ ` +
      `ばらばらに揃えると 切れ目でいちばん跳ぶ幅 ${dec(step)}dB` +
      `（倍率 ${apart.gains.map((g) => dec(g.gainDb, 1)).join(' / ')}）` +
      ` ／ ひとまとめなら全部 ${dec(together.gains[0].gainDb)}dB`,
  );
}
console.log('  **跳ぶ幅は「切れ目で部屋の音が段になる幅」そのもの。** 揃えて得られるものと引き比べること。');

// ============================================================
// 4. 上限の振り方（守るものと壊すもののつり合い）
// ============================================================
console.log('\n## 4. 上げる側の上限を振る\n');
console.log(
  `${pad('上限dB', 8)}${num('声の開き', 10)}${num('上限に当たった本数', 20)}  ${pad('当たったクリップ', 40)}`,
);
console.log('-'.repeat(82));
for (const cap of [3, 6, 9, 12, 18, 24, 48]) {
  const p = planClipMatch(measured, { reference: refOption, maxBoostDb: cap, maxCutDb });
  const ids = p.gains.filter((g) => g.limitedBy === 'cap' && g.wantedDb > 0);
  const after = speechIds.map((g) => truthLufs.get(g.id) + p.gains.find((x) => x.id === g.id).gainDb);
  console.log(
    `${pad(cap, 8)}${num(dec(spread(after)), 10)}${num(ids.length, 20)}  ` +
      `${pad(ids.map((g) => g.id).join(' / ') || '—', 40)}`,
  );
}

// ============================================================
// 5. 基準の決め方（声の無いクリップが混じったとき）
// ============================================================
console.log('\n## 5. 基準の決め方（声の無いクリップに引きずられないか）\n');
// **抜くのは静かな外れ値だけではいけない。** パワーで平均する以上、和を持っていくのは大きいほう。
const ref = (set, mode) => planClipMatch(set, { reference: mode, maxBoostDb, maxCutDb }).referenceLufs;
const without = (...ids) => measured.filter((m) => !ids.includes(m.id));
const cases = [
  ['ぜんぶ', measured],
  ['room-tone 抜き（静かな外れ値）', without('room-tone')],
  ['speech-loud-clipped 抜き（大きい外れ値）', without('speech-loud-clipped')],
];
const base = ['median', 'mean', 'loudest'].map((m) => ref(measured, m));
console.log(`${pad('抜いたもの', 40)}${num('median', 10)}${num('mean', 10)}${num('loudest', 10)}   ぜんぶとの差`);
console.log('-'.repeat(84));
for (const [label, set] of cases) {
  const row = ['median', 'mean', 'loudest'].map((m) => ref(set, m));
  console.log(
    `${pad(label, 40)}${row.map((v) => num(dec(v), 10)).join('')}   ` +
      row.map((v, i) => dec(v - base[i])).join(' / '),
  );
}
console.log('  **引きずるのは静かな外れ値ではなく、大きいほう。** 30dB 下の 1 本はパワーの和に 0.1% も足さない。');

// ============================================================
// 6. 繋いで、全体を目標へ揃えるところまで通す
// ============================================================
console.log('\n## 6. 揃えたあと、繋いで全体を目標へ（`lufs.ts` → `limiter.ts`）\n');
function concatBuffers(buffers) {
  const sampleRate = buffers[0].sampleRate;
  const channels = Math.max(...buffers.map((b) => b.numberOfChannels));
  const total = buffers.reduce((sum, b) => sum + b.length, 0);
  const planes = [];
  for (let c = 0; c < channels; c += 1) {
    const out = new Float32Array(total);
    let k = 0;
    for (const b of buffers) {
      const src = b.getChannelData(Math.min(c, b.numberOfChannels - 1));
      for (let i = 0; i < b.length; i += 1) out[k++] = src[i];
    }
    planes.push(out);
  }
  return { sampleRate, numberOfChannels: channels, length: total, getChannelData: (c) => planes[c] };
}

for (const [label, gains] of [
  ['揃えずに繋ぐ', null],
  ['クリップごとに揃えてから繋ぐ', plan],
]) {
  const buffers = gains ? applyClipGains(clips, gains) : clips.map((c) => c.buffer);
  const timeline = concatBuffers(buffers);
  const m = measureLoudness(timeline, { monoAsDualMono: dualMono });
  const p = planLoudnessNormalization(m, { limiterHeadroomDb: DEFAULT_LIMITER.maxReductionDb });
  let out = applyGain(timeline, p.gain);
  let report = null;
  if (p.neededReductionDb > 0) {
    const limited = limitTruePeak(out, { ceilingDb: DEFAULT_NORMALIZATION.truePeakCeilingDb });
    out = limited.buffer;
    report = limited.report;
  }
  const after = measureLoudness(out, { monoAsDualMono: dualMono });
  // どのクリップがピークを押し上げているか。**そこが「全体の倍率を決めている 1 本」**。
  const worst = buffers
    .map((b, i) => ({ id: clips[i].id, tp: measureLoudness(b, { monoAsDualMono: dualMono }).truePeakDb }))
    .reduce((a, b) => (b.tp > a.tp ? b : a));
  console.log(
    `  ${pad(label, 28)} 繋いだ直後 ${num(dec(m.integratedLufs), 8)} LUFS ／ ` +
      `全体の倍率 ${num(dec(p.gainDb), 7)}dB（${pad(p.limitedBy, 9)}）／ 出来上がり ${num(dec(after.integratedLufs), 8)} LUFS ` +
      `／ 真のピーク ${num(dec(after.truePeakDb), 7)} dBTP` +
      `／ 均した時間 ${num(report ? (report.activeRatio * 100).toFixed(2) + '%' : '—', 7)}` +
      `／ ピークを決めている 1 本 ${worst.id}（${dec(worst.tp)} dBTP）`,
  );
}

console.log(
  '\n**クリップの開きが縮むのは当たり前（測った値を引き算しただけ）。** 見るべきは 1 の「声の開き」と、' +
    '\n4 で上限に当たったクリップ（そこは声の入っていないクリップかもしれない）。',
);
