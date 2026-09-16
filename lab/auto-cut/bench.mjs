/**
 * 試し用の素材に対して、いまの無音カットがどう効くかを測る。
 *
 *   npm run lab:fixtures   # 先に素材を作る
 *   npm run lab:bench
 *   npm run lab:bench -- lab/fixtures/out/speech-long.wav   # ファイルを指定してもよい
 *   LAB_NO_RUN=1 npm run lab:bench   # 「動きが続いたか」を見ない（2026-09-14 以前の振る舞い）
 *   LAB_NO_LEAD=1 npm run lab:bench  # 発話の頭を遡らない（2026-09-15 以前の振る舞い）
 *   LAB_LOWBAND=1 npm run lab:bench    # 揺れを低い帯域だけで見る（2026-09-16。既定では入れていない）
 *   LAB_LOWBAND=4000 npm run lab:bench # その境目を変えて振る（Hz。1 なら既定の 2000Hz）
 *
 * `LAB_NO_RUN` は A/B を並べるためのもの。判定に手を入れたら、
 * **入れる前と入れたあとを同じコマンドで出せる**ようにしておかないと、
 * 「良くなった」が測れない（前の数字は記録から拾い直すことになる）。
 *
 * セルフテスト（合成波形での検算）は「壊れていないか」を見るもので、
 * こちらは「実際どれくらい効くか」を見るもの。数字を記録に残しておけば、
 * あとから手を入れたときに良くなったのか悪くなったのかが分かる。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readWav } from '../fixtures/wav.mjs';
import { SHORT_FIXTURES, utterancesOf } from '../fixtures/spec.mjs';

const { analyzeLoudness } = await import('./src/loudness.ts');
const { analyzeFeatures, MOD_SPLIT_HZ } = await import('./src/features.ts');
const { planJetCut, cutSoundingSeconds, keepEdgeSeconds, keepScoreSeconds, minimalKeepRanges, DEFAULT_JET_CUT } =
  await import('./src/silence.ts');

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

console.log('音量だけで判定（level）と、声らしさも見る（speech）を並べる。\n');
console.log(
  `${pad('素材', 22)}${num('尺', 7)}  |${num('本数', 5)}${num('残る', 7)}${num('削減', 6)}${num('時間', 7)}  |${num('本数', 5)}${num('残る', 7)}${num('削減', 6)}${num('時間', 7)}`,
);
console.log(`${' '.repeat(29)}  |${pad('  level（既定）', 25)}|${pad('  speech（新）', 25)}`);
console.log('-'.repeat(95));

/** 使い物になっていない結果には印を付ける。数字だけ見ても気づけないため。 */
function verdict(plan) {
  if (plan.keep.length === 0) return '何も残らない';
  if (plan.resultDuration > plan.originalDuration * 0.95) return '全編が鳴っている判定';
  return null;
}

/** 2 つの区間の重なりの長さ。 */
const overlap = (a, b) => Math.max(0, Math.min(a.end, b[1]) - Math.max(a.start, b[0]));

/**
 * 正解と突き合わせる。
 *
 * **削減率だけを見てはいけない。** 全部削れば削減 100% になるが、それは
 * 声ごと消しているだけ。「声をどれだけ残せたか」と「余計にどれだけ残したか」を
 * 並べて初めて、良くなったかどうかが言える。
 */
function scoreKeep(keep, truth) {
  const truthTotal = truth.reduce((sum, [a, b]) => sum + (b - a), 0);
  let hit = 0;
  for (const range of keep) for (const u of truth) hit += overlap(range, u);
  const keptTotal = keep.reduce((sum, r) => sum + (r.end - r.start), 0);
  return {
    // 声のうち、残せた割合。低いと「声を切ってしまっている」。
    recall: truthTotal > 0 ? hit / truthTotal : null,
    // 残したもののうち、声だった割合。低いと「余計なものを残している」。
    precision: keptTotal > 0 ? hit / keptTotal : truthTotal > 0 ? 0 : null,
  };
}

function accuracy(plan, fixture) {
  if (!fixture) return null;
  return scoreKeep(plan.keep, utterancesOf(fixture));
}

const percent = (v) => (v === null ? '—' : `${Math.round(v * 100)}%`);
/** 平均は記録へそのまま写す数なので、丸めすぎると前後の比較ができなくなる。 */
const percent1 = (v) => (v === null ? '—' : `${(v * 100).toFixed(1)}%`);

/**
 * 余計に残した秒の合計。素材ごとの数は小さいので、ここで足して最後に並べる。
 * **精度が低いのは分かっても、どこで落としているかは 1 つの数からは読めない**（2026-09-15・2 回目）。
 */
const extra = { head: 0, tail: 0, bridge: 0, stray: 0, above: 0, between: 0, below: 0 };
/**
 * 同じ内訳を、**声を落とさずに残せるいちばん狭い残し方**でも出す（`minimalKeepRanges`）。
 * **精度は 100% を目指す数ではない**（余白と繋ぎは設計どおり付く）ので、
 * 引き算できる相手が並んでいないと、取り返せない秒まで追いかけることになる。
 */
const unavoidable = { head: 0, tail: 0, bridge: 0, stray: 0 };
/** 記録に並べる 3 つの数。毎回手で平均を取り直さずに済むように、ここで集める。 */
const totals = { recall: 0, precision: 0, voiced: 0, harm: 0 };

for (const file of files) {
  const buffer = readWav(file);
  const track = analyzeLoudness(buffer, 0.02);

  const t0 = performance.now();
  const level = planJetCut(track, { mode: 'level' });
  const levelMs = performance.now() - t0;

  const t1 = performance.now();
  // 「揺れを低い帯域だけで見る」手は既定では入れていない（features.ts の `MOD_SPLIT_HZ`）。
  // 入れた側の数字をいつでも出せるようにしておかないと、次の回が記録から拾い直すことになる。
  const lowband = Number(process.env.LAB_LOWBAND ?? 0);
  const features = analyzeFeatures(buffer, track, lowband ? { modSplitHz: lowband === 1 ? MOD_SPLIT_HZ : lowband } : {});
  const speech = planJetCut(
    track,
    {
      mode: 'speech',
      ...(process.env.LAB_NO_RUN ? { minEnvelopeRun: 0 } : {}),
      ...(process.env.LAB_NO_LEAD ? { speechLeadIn: 0 } : {}),
    },
    features.speechScore,
    features.shapeChange,
    features.envelopeChange,
    features.envelopeFlux,
  );
  const speechMs = performance.now() - t1;

  const cut = (plan) => (plan.originalDuration > 0 ? Math.round((1 - plan.resultDuration / plan.originalDuration) * 100) : 0);
  const cell = (plan, ms) =>
    `${num(plan.keep.length, 5)}${num(plan.resultDuration.toFixed(1) + 's', 7)}${num(cut(plan) + '%', 6)}${num(ms.toFixed(0) + 'ms', 7)}`;

  console.log(
    `${pad(path.basename(file), 22)}${num(level.originalDuration.toFixed(1) + 's', 7)}  |${cell(level, levelMs)}  |${cell(speech, speechMs)}`,
  );

  const notes = [];
  if (verdict(level)) notes.push(`level: ${verdict(level)}`);
  if (speech.noSpeechFound) {
    const why = speech.noSpeechReason === 'shape' ? '形がどこでも動かない' : '声だと判断できたコマがほぼ無い';
    notes.push(`speech: 声が見つからないので何もしなかった（${why}）`);
  }
  else if (verdict(speech)) notes.push(`speech: ${verdict(speech)}`);
  notes.push(`声らしいコマの割合 ${(speech.speechRatio * 100).toFixed(0)}%`);
  notes.push(`形が動いた ${speech.shapeSeconds.toFixed(1)}s`);
  // 保持が音楽の一瞬の動きを引き伸ばしていないかは、ここを見る。
  notes.push(`音色が動いた ${speech.envelopeSeconds.toFixed(1)}s`);
  if (speech.usedMode !== 'speech') notes.push('speech モードに落ちられなかった');
  if (notes.length) console.log(`${' '.repeat(22)} └ ${notes.join(' / ')}`);

  // 正解の分かっている素材なら、削減率だけでなく中身の当たり具合も出す。
  const fixture = SHORT_FIXTURES.find((f) => f.name === path.basename(file));
  if (fixture && !fixture.speech) {
    // 声の無い素材では「声を残せた率」が常に — になって何も言わない。
    // 代わりに、削減のうち**鳴っているところを切ったぶん**を出す。
    // 素材にもともと開いている無音を切ったのなら曲は壊れていないので、
    // 削減率をそのまま実害として読むと、居ない相手を追いかけることになる
    // （実際 music-wah を 7 回追いかけた。2026-09-14・3 回目の記録を参照）。
    const harmLevel = cutSoundingSeconds(track, level);
    const harmSpeech = cutSoundingSeconds(track, speech);
    const note =
      speech.removed > 0 && harmSpeech < speech.removed * 0.05
        ? `（削減 ${speech.removed.toFixed(2)}s はほぼ素材の無音）`
        : '';
    totals.harm += harmSpeech;
    console.log(
      `${' '.repeat(22)} └ 鳴っているところを切った ${harmLevel.toFixed(2)}s → ${harmSpeech.toFixed(2)}s${note}`,
    );
  } else {
    const a = accuracy(level, fixture);
    const b = accuracy(speech, fixture);
    // 声を 1 コマも落とさずに残せる、いちばん狭い残し方。**判定の出来とは無関係**に、
    // 余白・繋ぎ・コマの粒でこれだけ余る。この線に届いているなら、
    // その素材で精度を追いかけても得るものは無い。**上回っていたら声を削っている。**
    const minimal = fixture
      ? minimalKeepRanges(utterancesOf(fixture).map(([s2, e2]) => ({ start: s2, end: e2 })), track.duration, track.hop)
      : [];
    const lowest = fixture ? scoreKeep(minimal, utterancesOf(fixture)) : null;
    if (a && b) {
      totals.recall += b.recall ?? 0;
      totals.precision += b.precision ?? 0;
      totals.voiced += 1;
      console.log(
        `${' '.repeat(22)} └ 声を残せた率 ${percent(a.recall)} → ${percent(b.recall)}` +
          ` / 残したうち声だった率 ${percent(a.precision)} → ${percent(b.precision)}` +
          `（下限 ${percent(lowest?.precision ?? null)}${b.precision > (lowest?.precision ?? 1) + 1e-9 ? '・声を削っている' : ''}）`,
      );
    }
    // 精度が低いとき、どこで・何が落としているか。直す手が別なので分けて出す。
    if (fixture && !speech.noSpeechFound) {
      const truth = utterancesOf(fixture).map(([start, end]) => ({ start, end }));
      const where = keepEdgeSeconds(speech.keep, truth);
      const what = keepScoreSeconds(
        track,
        speech.keep,
        truth,
        features.speechScore,
        DEFAULT_JET_CUT.speechThreshold,
        DEFAULT_JET_CUT.speechExit,
      );
      extra.head += where.head;
      extra.tail += where.tail;
      extra.bridge += where.bridge;
      extra.stray += where.stray;
      extra.above += what.above;
      extra.between += what.between;
      extra.below += what.below;
      const cannot = keepEdgeSeconds(minimal, truth);
      unavoidable.head += cannot.head;
      unavoidable.tail += cannot.tail;
      unavoidable.bridge += cannot.bridge;
      unavoidable.stray += cannot.stray;
      const total = where.head + where.tail + where.bridge + where.stray;
      console.log(
        `${' '.repeat(22)} └ 余計に残した ${total.toFixed(2)}s` +
          `（頭 ${where.head.toFixed(2)} / 尻 ${where.tail.toFixed(2)}` +
          ` / 発話の間を渡った ${where.bridge.toFixed(2)} / 無関係 ${where.stray.toFixed(2)}）` +
          ` ← 判定 ${what.above.toFixed(2)} / ヒステリシス ${what.between.toFixed(2)} / 余白と繋ぎ ${what.below.toFixed(2)}`,
      );
    }
  }
}

{
  const where = extra.head + extra.tail + extra.bridge + extra.stray;
  const what = extra.above + extra.between + extra.below;
  const share = (v, of) => (of > 0 ? `${Math.round((v / of) * 100)}%` : '—');
  console.log(
    `\n余計に残した秒の合計 ${where.toFixed(2)}s —` +
      ` 頭 ${extra.head.toFixed(2)}（${share(extra.head, where)}）` +
      ` / 尻 ${extra.tail.toFixed(2)}（${share(extra.tail, where)}）` +
      ` / 発話の間を渡った ${extra.bridge.toFixed(2)}（${share(extra.bridge, where)}）` +
      ` / 無関係 ${extra.stray.toFixed(2)}（${share(extra.stray, where)}）`,
  );
  console.log(
    `${' '.repeat(10)}同じ秒を値で ${what.toFixed(2)}s —` +
      ` 判定そのもの ${extra.above.toFixed(2)}（${share(extra.above, what)}）` +
      ` / ヒステリシス ${extra.between.toFixed(2)}（${share(extra.between, what)}）` +
      ` / 余白と繋ぎ ${extra.below.toFixed(2)}（${share(extra.below, what)}）`,
  );
  const cannot = unavoidable.head + unavoidable.tail + unavoidable.bridge + unavoidable.stray;
  console.log(
    `${' '.repeat(4)}どう判定しても残る ${cannot.toFixed(2)}s —` +
      ` 頭 ${unavoidable.head.toFixed(2)}` +
      ` / 尻 ${unavoidable.tail.toFixed(2)}` +
      ` / 発話の間を渡った ${unavoidable.bridge.toFixed(2)}` +
      ` / 無関係 ${unavoidable.stray.toFixed(2)}` +
      `　→ 判定の落ち度は ${(where - cannot).toFixed(2)}s（${share(where - cannot, where)}）`,
  );
  console.log(
    '**「発話の間を渡った」は、そのまま落ち度として読まないこと。** ' +
      `minSilence（${DEFAULT_JET_CUT.minSilence}s）より短い切れ目を繋ぐのは設計どおりで、` +
      'そのぶんは上の行に出ている。',
  );
  console.log(
    '**「判定そのもの」が大半を占めているうちは、端の扱い（余白・遡り・ヒステリシス）を' +
      'いじっても精度は動かない。** そこは声らしさの中身の問題。',
  );
  if (totals.voiced > 0) {
    // 記録に並べる 3 つの数。手で平均を取り直すと、そこで間違える。
    console.log(
      `\n声のある ${totals.voiced} 本の平均: 声を残せた率 ${percent1(totals.recall / totals.voiced)}` +
        ` / 残したうち声だった率 ${percent1(totals.precision / totals.voiced)}` +
        ` ／ 声の無い素材で鳴っているところを切った合計 ${totals.harm.toFixed(2)}s`,
    );
  }
}

console.log(
  '\nspeech は音そのものを見る（FFT）ぶん level より遅い。そのぶん、BGM や環境音が乗った素材で切れるようになる。',
);
console.log('削減率だけを見ないこと。全部削れば 100% になるが、それは声ごと消しているだけ。');
console.log(
  '声の無い素材は逆向きに読む。削減率ではなく「鳴っているところを切った」秒数を見ること。' +
    'そこがゼロなら、切ったのは素材にもともと開いていた無音なので曲は壊れていない。',
);
