/**
 * **透ける文字帯**が、線の上（本物のカット）と下（字幕の書き換え）をどう動かすか測る。
 *
 *   npm run lab:scene:caption
 *   LAB_ASPECT=native npm run lab:scene:caption   # 向きを変えて測る
 *
 * 9/22（3 回目）に足した帯は**不透明**で、そのときの結論は
 * 「1 つの帯が線を上からも下からも締める（70% で交わって引けなくなる）」だった。
 * ただしそれは**板が下の絵を完全に隠す**置き方での話で、実際の字幕は
 * たいてい半透明の板に不透明な字を載せる。透ければ板の下は動くので、
 * **上（薄まり）と下（書き換えの山）の両方が変わるはず**——それをここで測る。
 *
 * 出すのは 3 つ:
 *   1. 帯の中で「動かない画素」が実際どれだけあるか（透けたら何割戻るのか）
 *   2. `cuts-captions` の切り所ごとの距離を `cuts-plain`（帯なし・同じ種）で割った薄まり
 *   3. 線の上下（本物のカットの最小 ／ 字幕の書き換えの最大）と、その余裕
 */

import { SCENE_FIXTURES, sceneAspect } from '../fixtures/scenes.mjs';
import { renderFixture } from '../fixtures/make-frames.mjs';

const { DISTANCES, summarizeFrames } = await import('./src/frames.ts');

const aspect = process.env.LAB_ASPECT ?? 'landscape';
const view = sceneAspect(aspect);
/** 既定の量で測る（`scene.ts` の `metric` の既定と揃えてある）。 */
const METRIC = process.env.LAB_METRIC ?? 'combined';

/** 板の不透明度の並び。1 = いままでの帯（不透明）。 */
const ALPHAS = [1, 0.85, 0.7, 0.5, 0.3, 0];
/** 帯の厚みの並び。README の表と同じ所を取ってある。 */
const COVERS = [0.26, 0.4, 0.55, 0.7];

/** 渡りが瞬間ではない素材。正解のコマが 1 枚に決まらないので上下の表から外す。 */
const GRADUAL = new Set(['dissolve', 'fade-black']);

const pad = (s, n) => String(s).padEnd(n, ' ');
const right = (s, n) => String(s).padStart(n, ' ');

/** 素材 1 本を測って、コマごとの距離と正解ラベルを返す。 */
function measure(fixture, opts) {
  const clip = renderFixture(fixture.name, { aspect, ...opts });
  const stats = summarizeFrames(clip.frames, clip.times);
  const half = 0.5 / clip.fps;
  const rows = [];
  for (let i = 1; i < stats.length; i += 1) {
    const t = stats[i].time;
    rows.push({
      time: t,
      value: DISTANCES[METRIC](stats[i - 1], stats[i]),
      isCut: clip.cuts.some((c) => Math.abs(c - t) <= half),
    });
  }
  return rows;
}

console.log(`向き ${aspect}（${view.label} ${view.width}×${view.height}）・ 量 ${METRIC}\n`);

// --- 1. 帯の中で本当に動かないのはどれだけか ---
//
// 薄まりを「帯が覆う割合」で説明していたのは、**帯の下が 1 画素も動かない**という前提だった。
// 板が透ければその前提が崩れる。崩れ方は板と字の面積比で決まるので、まず数える。
{
  const a = renderFixture('cuts-captions', { aspect });
  const b = renderFixture('cuts-plain', { aspect });
  const f0 = a.frames[0].data;
  const g0 = b.frames[0].data;
  let band = 0;
  let ink = 0;
  // 帯の画素＝「帯あり」と「帯なし」で色が違う所。字は板より明るいので明るさで分ける。
  for (let p = 0; p < f0.length; p += 4) {
    const same = f0[p] === g0[p] && f0[p + 1] === g0[p + 1] && f0[p + 2] === g0[p + 2];
    if (same) continue;
    band += 1;
    if (f0[p] > 128) ink += 1;
  }
  const total = f0.length / 4;
  console.log('帯の中身（cuts-captions・帯 26%）');
  console.log(`  帯が覆う画素   ${((band / total) * 100).toFixed(1)}%（設計値 26%）`);
  console.log(`  うち字（不透明のまま）${((ink / band) * 100).toFixed(1)}%  ／  板（透ける側）${(((band - ink) / band) * 100).toFixed(1)}%`);
  console.log(
    `  → 板の不透明度 a のとき、動かない画素は 画面の ${((band / total) * 100).toFixed(1)}% ではなく ` +
      `${((ink / total) * 100).toFixed(1)}% + ${(((band - ink) / total) * 100).toFixed(1)}%×a\n`,
  );
}

// --- 2. 薄まりは、板を透かすとどれだけ戻るか ---
//
// `cuts-captions` と `cuts-plain` は**同じ種・同じ切り所**なので、割ればそのまま薄まりになる。
{
  const plain = measure({ name: 'cuts-plain' }, {});
  const truth = SCENE_FIXTURES.find((f) => f.name === 'cuts-captions').cuts;
  console.log('薄まり: cuts-captions の切り所の距離 ÷ cuts-plain の同じ切り所（帯 26%）\n');
  console.log(`${pad('板の不透明度', 14)}${truth.map((c) => right(`${c}s`, 11)).join('')}${right('平均', 11)}`);
  console.log('-'.repeat(14 + (truth.length + 1) * 11));
  for (const alpha of ALPHAS) {
    const capped = measure({ name: 'cuts-captions' }, { captionAlpha: alpha });
    const ratios = truth.map((c) => {
      const near = (rows) => rows.reduce((best, r) => (Math.abs(r.time - c) < Math.abs(best.time - c) ? r : best));
      return near(capped).value / near(plain).value;
    });
    const mean = ratios.reduce((s, v) => s + v, 0) / ratios.length;
    console.log(
      `${pad(alpha === 1 ? '1（不透明）' : String(alpha), 14)}` +
        `${ratios.map((r) => right(r.toFixed(3), 11)).join('')}${right(mean.toFixed(3), 11)}`,
    );
  }
  console.log('\n1.000 なら帯が何も薄めていない。面積だけで決まるなら、どの切り所も同じ数になるはず。');
}

// --- 3. 線の上下 ---
//
// 上＝本物のカットの最小（ここより下に線を置かないと見逃す）。
// 下＝字幕の書き換えの最大（ここより上に線を置かないと空振りする）。
// 両方に同じ帯が効くので、**片方だけ見ていると必ず読み違える**。
{
  console.log('\n\n線の上下（全素材の本物のカットの最小 ／ captions-only の書き換えの最大）\n');
  console.log(`${pad('帯', 8)}${ALPHAS.map((a) => right(a === 1 ? '不透明' : `板 ${a}`, 20)).join('')}`);
  console.log(`${pad('', 8)}${ALPHAS.map(() => right('上 / 下 (余裕)', 20)).join('')}`);
  console.log('-'.repeat(8 + ALPHAS.length * 20));
  for (const cover of COVERS) {
    const cells = ALPHAS.map((alpha) => {
      const opts = { captionCover: cover, captionAlpha: alpha };
      let lo = Infinity;
      let who = '';
      for (const f of SCENE_FIXTURES) {
        if (GRADUAL.has(f.name) || !f.cuts.length) continue;
        // `quick-insert` は門で落とすと決めてある素材なので、線の話からは外す。
        if (f.name === 'quick-insert') continue;
        for (const r of measure(f, opts)) {
          if (r.isCut && r.value < lo) {
            lo = r.value;
            who = f.name;
          }
        }
      }
      const hi = Math.max(...measure({ name: 'captions-only' }, opts).map((r) => r.value));
      return { lo, hi, who };
    });
    console.log(`${pad(`${(cover * 100).toFixed(0)}%`, 8)}${cells.map((c) => right(`${c.lo.toFixed(3)} / ${c.hi.toFixed(3)} (${(c.lo / c.hi).toFixed(1)}x)`, 20)).join('')}`);
    // **上を決めている素材まで出す。** 透かすと薄まりが戻るので、いちばん薄いカットが
    // 帯の素材から別の素材へ移る。名前を出さないと、その乗り換えが「値が揺れている」に見える。
    console.log(`${pad('', 8)}${cells.map((c) => right(c.who, 20)).join('')}`);
  }
  console.log('\n余裕が 1.0 倍を割ると、その帯では固定の線が引けない。既定の線は 0.05。');
}

// --- 4. 山が立つのはどこか（不透明な板の相殺） ---
//
// 上の表の「下」は書き換えの**最大**なので、透かしたときの増え方が 0.019 → 0.024 にしか見えない。
// コマごとに並べると、増えているのは最大ではなく**いちばん静かだったコマ**だと分かる。
{
  console.log('\n\n書き換えのコマごとの山（captions-only・帯 26%）\n');
  const rewrites = [];
  for (let k = 1; k * 1.5 < 13; k += 1) rewrites.push(Number((k * 1.5).toFixed(2)));
  console.log(`${pad('板の不透明度', 14)}${rewrites.map((t) => right(`${t}s`, 9)).join('')}`);
  console.log('-'.repeat(14 + rewrites.length * 9));
  for (const alpha of ALPHAS) {
    const rows = measure({ name: 'captions-only' }, { captionAlpha: alpha });
    // 書き換わるのは「その秒をまたいだ次のコマ」なので、秒ちょうどで引くと
    // 手前のコマ（何も起きていない）を掴む。前後 1 コマぶんの窓で山を取る。
    const vals = rewrites.map((t) => Math.max(...rows.filter((r) => Math.abs(r.time - t) <= 0.08).map((r) => r.value)));
    console.log(
      `${pad(alpha === 1 ? '1（不透明）' : String(alpha), 14)}${vals.map((v) => right(v.toFixed(4), 9)).join('')}`,
    );
  }
  console.log('\n不透明な板は、点いた升目と消えた升目が同じ 2 つの升目の間を行き来するだけなので、');
  console.log('**出入りの数が釣り合ったコマでは分布が 1 段も動かない**（相殺）。透けると下の絵の色へ散るので相殺が解ける。');
}
