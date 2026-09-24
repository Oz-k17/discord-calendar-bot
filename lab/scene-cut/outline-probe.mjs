/**
 * **字の縁取り**（字の周りの暗い輪郭）が、線の上（本物のカット）と
 * 下（字幕の書き換え）をどう動かすか測る。
 *
 *   npm run lab:scene:outline-probe
 *   LAB_ASPECT=native npm run lab:scene:outline-probe   # 向きを変えて測る
 *
 * 9/24（1 回目）に測ったのは**板の透け方**で、そのとき残した積み残しがこれ。
 * 板と縁取りは、見た目が近いのに**性質がまるで違う**:
 *
 *   - 板は**動かない**（場面が切り替わっても字幕が書き換わっても同じ所にある）
 *   - 縁取りは**字と一緒に動く**（書き換わるたびに位置と面積が変わる）
 *
 * なので効く先も違うはずで、板が薄めていたのは「上」、縁取りが押し上げるのは「下」——
 * それをここで measure する。
 *
 * ## 点では測れない相手（この回のいちばんの落とし穴）
 *
 * 現実の縁取りは 1080p で 3〜4 画素なので、**測るコマ（128×72）では 0.3 画素**しかない。
 * 画素の中心で色を引く描き方（9/24・1 回目までの帯）では、
 * **中心に当たれば 1 画素ぶん真っ黒・外れれば丸ごと消える**という当たり外れになる。
 * 本物の映像は実寸で焼いてから縮むので、細い線は消えずに**薄まって**残る。
 * なので素材の側に「画素の中を割って面積で混ぜる」道（`samples`）を足してから測る。
 * 1 段目でその当たり外れを数字にしてある。
 *
 * 出すのは 4 つ:
 *   1. 縁取りが面積として残るか（点 ／ 分割数を上げていったときの収束）
 *   2. 書き換えの山（＝線の下）。**相殺の条件が増える**のはここ
 *   3. 本物のカットの薄まり（＝線の上）。板が透けているときだけ効くはず
 *   4. 線の上下と余裕
 */

import { SCENE_FIXTURES, sceneAspect } from '../fixtures/scenes.mjs';
import { renderFixture } from '../fixtures/make-frames.mjs';

const { DISTANCES, summarizeFrames } = await import('./src/frames.ts');

const aspect = process.env.LAB_ASPECT ?? 'landscape';
const view = sceneAspect(aspect);
const METRIC = process.env.LAB_METRIC ?? 'combined';

/**
 * 縁取りの太さの並び（画面の高さに対する割合）。
 *
 * 0.0037 が**現実の値**（1080p で 4 画素）。太い側を並べているのは、
 * 効きが太さで動くかを見るため——動かないなら、見ているのは縁取りではなく別のものになる。
 */
const WIDTHS = [0, 0.0037, 0.0074, 0.015];
/**
 * 面積で混ぜるときの分割数。
 *
 * 表では 4 を使う。8・16 と比べて縁の面積が 6〜8% 違うが、
 * **ここで見たいのは桁と向き**で、1 本あたり 0.8 秒（4）と 6.5 秒（16）の差は
 * 全素材 × 4 通りの表では 10 分の違いになる。収束のぐあいは 1 段目に出す。
 */
const SAMPLES = 4;
/** 板の不透明度。縁取りの効きが板の透け方で変わるかを見るために 2 通り並べる。 */
const ALPHAS = [1, 0.5];

/** 渡りが瞬間ではない素材。正解のコマが 1 枚に決まらないので上下の表から外す。 */
const GRADUAL = new Set(['dissolve', 'fade-black']);

const pad = (s, n) => String(s).padEnd(n, ' ');
const right = (s, n) => String(s).padStart(n, ' ');

console.log(`向き ${aspect}（${view.label} ${view.width}×${view.height}）・ 量 ${METRIC}\n`);

/** 素材 1 本を測って、コマごとの距離と正解ラベルを返す。 */
function measure(name, opts) {
  const clip = renderFixture(name, { aspect, ...opts });
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

/**
 * 縁取りが覆っている面積（画素）を数える。
 *
 * **数えるのは「黒い画素の数」ではない。** 部分的にしか覆っていない画素が
 * 数のうちに入らないので、薄い縁取りはそれでは 0 になってしまう
 * （実際に 0.27 画素の縁取りを分割 8 で描くと、真っ黒な画素は 1 つも出ない）。
 * 縁取りの無い同じコマからの**寄り**を板と黒の差（22）で割ると、
 * 部分被覆も足し合わさった「画素いくつぶん」が出る。
 */
function outlineArea(name, opts, frameIndex = 1) {
  const off = renderFixture(name, { aspect, ...opts, captionOutline: 0 }).frames[frameIndex].data;
  const on = renderFixture(name, { aspect, ...opts }).frames[frameIndex].data;
  let sum = 0;
  for (let p = 0; p < off.length; p += 4) sum += off[p] - on[p];
  return sum / 22;
}

// --- 1. 縁取りは面積として残るか ---
{
  console.log('縁取りの面積（画素いくつぶん・captions-only の 2 コマ目）\n');
  console.log(`${pad('太さ', 22)}${[1, 2, 4, 8, 16].map((n) => right(`分割 ${n}`, 11)).join('')}`);
  console.log('-'.repeat(22 + 5 * 11));
  for (const w of WIDTHS.slice(1)) {
    const cells = [1, 2, 4, 8, 16].map((n) =>
      outlineArea('captions-only', { captionOutline: w, captionSamples: n }).toFixed(1),
    );
    console.log(
      `${pad(`${w}（${(w * view.height).toFixed(2)} 画素）`, 22)}${cells.map((c) => right(c, 11)).join('')}`,
    );
  }
  console.log('\n分割 1 は画素の中心で引く道（＝9/24・1 回目までの帯）。太さと面積が比例しないなら、');
  console.log('その道では縁取りを「太さ」として扱えていない。分割を上げた先の数が本当の面積。');
}

// --- 2. 書き換えの山（線の下） ---
//
// 9/24（1 回目）に分かったのは「不透明な板では、点いた升目と消えた升目が同じ 2 つの升目の
// 間を行き来するだけなので、**出入りの数が釣り合ったコマでは分布が 1 段も動かない**」。
// 縁取りは字と一緒に動くので、その相殺に条件が 1 つ増えるはず——
// **縁の面積まで釣り合っていないと消えない。**
{
  console.log('\n\n書き換えの山（captions-only・帯 26%）と、そのコマで縁の面積がどれだけ動いたか\n');
  const rewrites = [];
  for (let k = 1; k * 1.5 < 13; k += 1) rewrites.push(Number((k * 1.5).toFixed(2)));
  for (const alpha of ALPHAS) {
    console.log(`  板の不透明度 ${alpha === 1 ? '1（不透明）' : alpha}`);
    console.log(`  ${pad('太さ', 16)}${rewrites.map((t) => right(`${t}s`, 9)).join('')}${right('最大', 9)}`);
    console.log(`  ${'-'.repeat(16 + (rewrites.length + 1) * 9)}`);
    for (const w of WIDTHS) {
      const opts = { captionAlpha: alpha, captionOutline: w, captionSamples: w > 0 ? SAMPLES : 1 };
      const rows = measure('captions-only', opts);
      // 書き換わるのは「その秒をまたいだ次のコマ」なので、前後 1 コマぶんの窓で山を取る。
      const vals = rewrites.map((t) =>
        Math.max(...rows.filter((r) => Math.abs(r.time - t) <= 0.08).map((r) => r.value)),
      );
      console.log(
        `  ${pad(w === 0 ? '縁なし' : String(w), 16)}${vals.map((v) => right(v.toFixed(4), 9)).join('')}` +
          `${right(Math.max(...vals).toFixed(4), 9)}`,
      );
    }
    // **面積で混ぜただけの列**を必ず並べる。縁取りを足すと同時に描き方も変えているので、
    // これが無いと「縁取りが効いた」と「混ぜ方を変えたから動いた」を分けられない。
    const aa = measure('captions-only', { captionAlpha: alpha, captionOutline: 0, captionSamples: SAMPLES });
    const aaVals = rewrites.map((t) => Math.max(...aa.filter((r) => Math.abs(r.time - t) <= 0.08).map((r) => r.value)));
    console.log(
      `  ${pad('縁なし・面積で混ぜ', 16)}${aaVals.map((v) => right(v.toFixed(4), 9)).join('')}` +
        `${right(Math.max(...aaVals).toFixed(4), 9)}`,
    );
    console.log('');
  }

  // 縁の面積の動きと、山の上がり方を並べる。**同じコマで並べないと因果が読めない。**
  const w = 0.0037;
  const base = measure('captions-only', { captionOutline: 0, captionSamples: SAMPLES });
  const with_ = measure('captions-only', { captionOutline: w, captionSamples: SAMPLES });
  const clip = renderFixture('captions-only', { aspect });
  console.log(`  縁の面積の動き と 山の上がり（太さ ${w}・板は不透明）\n`);
  console.log(`  ${pad('書き換え', 10)}${right('縁の面積の差', 14)}${right('縁なし', 10)}${right('縁あり', 10)}${right('倍', 8)}`);
  console.log(`  ${'-'.repeat(10 + 14 + 10 + 10 + 8)}`);
  for (const t of rewrites) {
    const i = Math.round(t * clip.fps);
    const a0 = outlineArea('captions-only', { captionOutline: w, captionSamples: SAMPLES }, i - 1);
    const a1 = outlineArea('captions-only', { captionOutline: w, captionSamples: SAMPLES }, i);
    const near = (rows) => Math.max(...rows.filter((r) => Math.abs(r.time - t) <= 0.08).map((r) => r.value));
    const b = near(base);
    const c = near(with_);
    console.log(
      `  ${pad(`${t.toFixed(2)}s`, 10)}${right(`${(a1 - a0).toFixed(1)}px`, 14)}` +
        `${right(b.toFixed(4), 10)}${right(c.toFixed(4), 10)}${right(`${(c / b).toFixed(2)}x`, 8)}`,
    );
  }
  console.log('\n  面積が動かなかったコマだけ 1.00 倍で残るなら、上がりの正体は縁の面積そのもの。');
}

// --- 3. 本物のカットの薄まり（線の上） ---
//
// 不透明な板では帯の中はもともと 1 画素も動かないので、**縁取りを足しても上は動かないはず**
// （動かない領域の中で色が入れ替わるだけ）。板が透けているときだけ、
// 縁取りのぶんが「不透明に戻る」ので薄まりが増える——向きが分かれるかを見る。
{
  console.log('\n\n本物のカットの薄まり: cuts-captions の切り所 ÷ cuts-plain の同じ切り所（帯 26%）\n');
  const plain = measure('cuts-plain', {});
  const truth = SCENE_FIXTURES.find((f) => f.name === 'cuts-captions').cuts;
  for (const alpha of ALPHAS) {
    console.log(`  板の不透明度 ${alpha === 1 ? '1（不透明）' : alpha}`);
    console.log(`  ${pad('太さ', 16)}${truth.map((c) => right(`${c}s`, 11)).join('')}${right('平均', 11)}`);
    console.log(`  ${'-'.repeat(16 + (truth.length + 1) * 11)}`);
    for (const w of WIDTHS) {
      const capped = measure('cuts-captions', {
        captionAlpha: alpha,
        captionOutline: w,
        captionSamples: w > 0 ? SAMPLES : 1,
      });
      const ratios = truth.map((c) => {
        const near = (rows) => rows.reduce((best, r) => (Math.abs(r.time - c) < Math.abs(best.time - c) ? r : best));
        return near(capped).value / near(plain).value;
      });
      const mean = ratios.reduce((s, v) => s + v, 0) / ratios.length;
      console.log(
        `  ${pad(w === 0 ? '縁なし' : String(w), 16)}${ratios.map((r) => right(r.toFixed(3), 11)).join('')}` +
          `${right(mean.toFixed(3), 11)}`,
      );
    }
    console.log('');
  }
  console.log('  1.000 なら帯が何も薄めていない。不透明な板で動かないなら、縁取りは「上」には効かない。');
}

// --- 4. 線の上下と余裕を、帯の厚みで振る ---
//
// 26% だけを見ていては既定の線（0.05）が危ないかどうかは分からない。
// 9/22（3 回目）の表では、不透明な帯は **70% で余裕が 1.0 倍**まで落ちていた
// ——つまり**もともと余裕を使い切っている所がある**ので、
// 縁取りが「下」を押し上げるなら、先に破れるのはそこになる。
{
  const COVERS = [0.26, 0.4, 0.55, 0.7];
  /** 列は「縁なし ／ 現実の太さ」×「不透明な板 ／ 透ける板」の 4 つ。 */
  const COLUMNS = [];
  for (const alpha of ALPHAS) for (const w of [0, 0.0037]) COLUMNS.push({ alpha, w });

  console.log('\n\n線の上下（全素材の本物のカットの最小 ／ captions-only の書き換えの最大）\n');
  console.log(
    `${pad('帯', 8)}${COLUMNS.map((c) => right(`${c.alpha === 1 ? '不透明' : `板 ${c.alpha}`}・${c.w === 0 ? '縁なし' : `縁 ${c.w}`}`, 22)).join('')}`,
  );
  console.log(`${pad('', 8)}${COLUMNS.map(() => right('上 / 下 (余裕)', 22)).join('')}`);
  console.log('-'.repeat(8 + COLUMNS.length * 22));
  for (const cover of COVERS) {
    const cells = COLUMNS.map(({ alpha, w }) => {
      const opts = {
        captionCover: cover,
        captionAlpha: alpha,
        captionOutline: w,
        captionSamples: w > 0 ? SAMPLES : 1,
      };
      let lo = Infinity;
      let who = '';
      for (const f of SCENE_FIXTURES) {
        if (GRADUAL.has(f.name) || !f.cuts.length) continue;
        // `quick-insert` は門で落とすと決めてある素材なので、線の話からは外す。
        if (f.name === 'quick-insert') continue;
        for (const r of measure(f.name, opts)) {
          if (r.isCut && r.value < lo) {
            lo = r.value;
            who = f.name;
          }
        }
      }
      const hi = Math.max(...measure('captions-only', opts).map((r) => r.value));
      return { lo, hi, who };
    });
    console.log(
      `${pad(`${(cover * 100).toFixed(0)}%`, 8)}` +
        `${cells.map((c) => right(`${c.lo.toFixed(3)} / ${c.hi.toFixed(3)} (${(c.lo / c.hi).toFixed(1)}x)`, 22)).join('')}`,
    );
    console.log(`${pad('', 8)}${cells.map((c) => right(c.who, 22)).join('')}`);
  }
  console.log('\n余裕が 1.0 倍を割ると、その帯では固定の線が引けない。既定の線は 0.05——');
  console.log('「下」がそこを越えた所からは、空振りが出る（線を越えるものは全部切り所になる）。');
}
