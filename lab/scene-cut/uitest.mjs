/**
 * シーン検出の画面を通して確かめる。
 *
 *   npm run lab:scene:uitest
 *
 * selftest（ブラウザ不要）が「計算が合っているか」を見るのに対して、
 * こちらは **「本物の動画を読む → 描く → 切り所を出す」が繋がっているか**を見る。
 * 計算が正しくても配線が切れていれば使えないので、両方要る。
 *
 * ## 素材は、その場で**本物の動画に焼いて**渡す
 *
 * 音の側（`beat/uitest.mjs`）は WAV が無圧縮なので Node で書けたが、映像はそうはいかない。
 * ラボに外部ライブラリを足さない方針なので、Node 側にエンコーダが無い。
 * 焼く側も読む側も WebCodecs なので、**ブラウザの中で焼いてから同じページへ食わせる**。
 * 焼く部品（`testkit/encode.ts`）は画面からは読み込んでいない。
 *
 * この形にすると、確かめているのが「合成したコマを渡したら動くか」ではなく
 * **「本物の動画ファイルを読んだら動くか」**になる。デコード・縮小・`getImageData` まで
 * 通るし、圧縮の粒が乗った状態での効きも一緒に出る。
 *
 * ## 数字がコマンドラインと合うかどうかは、圧縮が決める
 *
 * 合成したコマをそのまま測るコマンドラインと違い、画面は**一度 WebM に焼いてから**読む。
 * 量子化の粒が乗るので、隣り合うコマの距離はコマンドラインとぴったりは揃わない。
 * そこで突き合わせるのは距離そのものではなく、**同じ物差し（`score.mjs`）で採点した
 * 当たり・見逃し・空振り**にしてある。ここが揃わなければ、配線か、圧縮への弱さのどちらか。
 *
 * playwright が無い環境では、その旨を出して成功扱いで終わる（作業を止めないため）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderFixture } from '../fixtures/make-frames.mjs';
import { launch, loadPlaywright, serve } from '../browser.mjs';
import { scoreBoundaries, toleranceFor } from './score.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

const playwright = loadPlaywright();
if (!playwright) {
  console.log('playwright が見つからないので画面の確認は飛ばします（計算は npm run lab:test で確認できます）。');
  process.exit(0);
}

const { summarizeFrames } = await import('./src/frames.ts');
const { planSceneCut } = await import('./src/scene.ts');

let failed = 0;
const ok = (label, condition, detail = '') => {
  if (!condition) failed += 1;
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? `  :: ${detail}` : ''}`);
};

/** コマンドライン側の答え（合成したコマをそのまま測る）。 */
function commandLine(name, { aspect = 'landscape', fps, options } = {}) {
  const clip = renderFixture(name, { aspect, ...(fps ? { fps } : {}) });
  const plan = planSceneCut(summarizeFrames(clip.frames, clip.times), options ?? {});
  return { cuts: clip.cuts, boundaries: plan.boundaries.map((b) => b.time) };
}

/**
 * 素材を本物の動画に焼いて、画面へ読ませ、判定が終わるまで待つ。
 *
 * 待ち方を「コマが揃ったか」にしてあるのは、**尺だけ見ると読み込み途中で通ってしまう**ため
 * （`duration` は最初のコマを読む前に決まる）。
 */
async function feed(page, name, { aspect = 'landscape', fps } = {}) {
  const encoded = await page.evaluate(
    ([n, a, f]) => window.__labSceneEncode(n, { aspect: a, ...(f ? { fps: f } : {}) }).then((r) => ({
      bytes: [...r.bytes],
      cuts: r.cuts,
      width: r.width,
      height: r.height,
      fps: r.fps,
      frames: r.frames,
      codec: r.codec,
    })),
    [name, aspect, fps ?? null],
  );
  await page.locator('#scene-file').setInputFiles({
    name: `${name}.webm`,
    mimeType: 'video/webm',
    buffer: Buffer.from(encoded.bytes),
  });
  // **尺ではなくコマの数で待つ。** `duration` は最初のコマを読む前に決まるので、
  // そこで待つと読み込み途中の数字を読んでしまう。`loading` が下りるまで併せて待つ。
  await page.waitForFunction(() => window.__labScene.state().frames > 0 && !window.__labScene.state().loading, null, {
    timeout: 90000,
  });
  await page.waitForTimeout(300);
  return { encoded, state: await page.evaluate(() => window.__labScene.state()) };
}

/** つまみを動かして、判定が回りきるまで待つ。 */
async function setRange(page, selector, value, settle = 400) {
  await page.locator(selector).evaluate((el, v) => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
  await page.waitForTimeout(settle);
}

const server = await serve(here);
const browser = await launch(playwright);
try {
  const page = await (await browser.newContext({ viewport: { width: 1000, height: 1500 }, deviceScaleFactor: 2 })).newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await page.goto(server.url, { waitUntil: 'networkidle' });
  // 焼く部品は画面には入っていないので、確かめるときだけ差し込む。
  await page.addScriptTag({ type: 'module', url: './testkit/encode.ts' });
  await page.waitForFunction(() => typeof window.__labSceneEncode === 'function', null, { timeout: 30000 });

  // --- 画面から回すセルフテスト（コマンドライン版と同じものを見ている） ---
  await page.getByRole('button', { name: 'テストを実行' }).click();
  await page.waitForSelector('#test-results li');
  const tests = await page.evaluate(() =>
    [...document.querySelectorAll('#test-results li')].map((li) => ({
      ok: li.classList.contains('pass'),
      name: li.children[1].textContent,
    })),
  );
  ok(
    `画面からもセルフテストが通る（${tests.length} 件）`,
    tests.length > 0 && tests.every((t) => t.ok),
    tests.filter((t) => !t.ok).map((t) => t.name).join(' / ') || `${tests.length}/${tests.length}`,
  );

  // **既定は画面に直書きせず、判定の側から写している。** ここが落ちたら、
  // 画面だけが別の設定で動いていることになる（数字は出たままなので気づけない）。
  const defaults = await page.evaluate(() => window.__labScene.defaults);
  ok(
    '画面の既定が判定の側から来ている',
    defaults.scene.metric === 'combined' &&
      defaults.scene.threshold === 0.05 &&
      defaults.scene.straddleFrames === 6 &&
      defaults.scene.localRatio === 4 &&
      defaults.scene.minScene === 0.4 &&
      defaults.analysisFps === 15,
    `${JSON.stringify(defaults.scene)} / ${defaults.analysisFps}fps`,
  );

  // --- 素直な素材: 焼く → 読む → 描く → 切り所を出す ---
  const plain = await feed(page, 'cuts-plain');
  ok(
    '焼いた動画が本物として読めている',
    plain.state.frames > 180 && plain.state.duration > 12.5 && Math.abs(plain.state.sourceFps - 15) < 1.5,
    `${plain.encoded.codec} ・ ${plain.state.frames} コマ ・ ${plain.state.duration?.toFixed(2)}s ・ 素材 ${plain.state.sourceFps?.toFixed(1)}fps`,
  );
  ok(
    'コマは長辺 128 まで縮めて読んでいる',
    plain.state.width === 128 && plain.state.height === 72,
    `${plain.state.width}×${plain.state.height}`,
  );
  ok('コマの欠けが無い', plain.state.missing === 0, `${plain.state.missing} 枚`);
  ok('統計が画面に出る', (await page.locator('#scene-stats div').count()) === 8);
  ok('距離の列と切り所が描かれている', await hasInk(page, 'scene-canvas'));
  ok(
    '場面のサムネイルが並ぶ',
    (await page.locator('#scene-shots figure').count()) === plain.state.scenes.length && plain.state.scenes.length > 1,
    `${await page.locator('#scene-shots figure').count()} 枚 / 場面 ${plain.state.scenes.length} 本`,
  );
  // 区間は隙間なく並ぶ（`toClipEdits` へそのまま渡せることの中身）。
  const gaps = plain.state.scenes.slice(1).map((s, i) => Math.abs(s.start - plain.state.scenes[i].end));
  ok(
    '場面は隙間なく並ぶ（尺が減らない）',
    gaps.every((g) => g < 1e-9) &&
      Math.abs(plain.state.scenes[plain.state.scenes.length - 1].end - plain.state.scenes[0].start - plain.state.duration) < 0.15,
    `隙間の最大 ${Math.max(0, ...gaps).toFixed(6)}s / 合計 ${(plain.state.scenes[plain.state.scenes.length - 1].end - plain.state.scenes[0].start).toFixed(2)}s`,
  );

  // **ここがこの確認のいちばんの目的。** 画面で出た切り所を、コマンドラインと同じ物差しで
  // 採点し、コマンドラインの数字と突き合わせる。判定を画面でやり直していたらここでずれる。
  for (const name of ['cuts-plain', 'cuts-rapid', 'dissolve', 'flash-cuts', 'quick-insert', 'pan', 'cuts-captions']) {
    const { state } = name === 'cuts-plain' ? plain : await feed(page, name);
    const cli = commandLine(name);
    const tol = toleranceFor(name);
    const screen = scoreBoundaries(state.boundaries, cli.cuts, tol);
    const command = scoreBoundaries(cli.boundaries, cli.cuts, tol);
    ok(
      `${name}: 画面とコマンドラインで、当たり・見逃し・空振りが揃う`,
      screen.hit === command.hit && screen.missed === command.missed && screen.spurious === command.spurious,
      `コマンドライン ${command.hit}/${command.missed}/${command.spurious} ・ 画面 ${screen.hit}/${screen.missed}/${screen.spurious}（正解 ${cli.cuts.length} 本）`,
    );
  }

  // --- 焼き込みの文字帯（2026-09-22・3 回目） ---
  //
  // ここを画面で通す理由は 1 つで、**圧縮の粒が字幕の書き換えを押し上げないか**を見るため。
  // 9/22（2 回目）に「圧縮の粒は小さい距離ほど押し上げる」と測ってあるので、
  // 字幕の山（合成コマで 0.019）は**いちばん押し上げられやすい側**に居る。
  // 固定の線を 0.10 → 0.05 へ下げた以上、ここは焼いた動画で確かめないと意味がない。
  const capsCuts = await feed(page, 'cuts-captions');
  ok(
    '焼き込みの帯は、本物のカットの距離も薄める（焼いた動画でも）',
    capsCuts.state.peak < plain.state.peak * 0.85 && capsCuts.state.boundaries.length === 3,
    `帯なし ${plain.state.peak.toFixed(3)} → 帯あり ${capsCuts.state.peak.toFixed(3)}（切り所 ${capsCuts.state.boundaries.length} 本）`,
  );
  const capsOnly = await feed(page, 'captions-only');
  ok(
    '字幕だけが書き換わる素材は、圧縮を通しても 1 本も切らない',
    capsOnly.state.boundaries.length === 0,
    `${capsOnly.state.boundaries.length} 本（距離の最大 ${capsOnly.state.peak.toFixed(3)} / 線 0.05）`,
  );

  // --- 自分の手を潰す素材 ---
  //
  // (1) 縦型のパン。**ここが `localRatio` の仕事**（2026-09-22 に足した線）。
  //     既定なら 1 本も切らないのに、比を切ると切り刻む。
  //     「線が画面から効いている」は、数字が動くことではなく**守っていたものが壊れること**で見る。
  const panPortrait = await feed(page, 'pan', { aspect: 'portrait' });
  ok(
    '縦型のパンを、既定は 1 本も切らない',
    panPortrait.state.boundaries.length === 0,
    `${panPortrait.state.boundaries.length} 本（距離の最大 ${panPortrait.state.peak.toFixed(3)}）`,
  );
  ok('切り所が無いことを画面で知らせる', await page.locator('#scene-warning').isVisible());
  ok(
    'そのとき、固定の線は越えている（落としているのは比のほう）',
    panPortrait.state.peak > 0.1 && (panPortrait.state.rejected.local ?? 0) > 0,
    `距離の最大 ${panPortrait.state.peak.toFixed(3)} / 比で落とした候補 ${panPortrait.state.rejected.local ?? 0} 本`,
  );
  await setRange(page, '#local-ratio', '0');
  const withoutLocal = await page.evaluate(() => window.__labScene.state());
  ok(
    '比を切ると、同じ縦型のパンを切り刻んでしまう',
    withoutLocal.boundaries.length > 0,
    `0 本 → ${withoutLocal.boundaries.length} 本`,
  );
  await setRange(page, '#local-ratio', '4');

  // (2) コマの速さ。**今回の測定がそのまま画面に出るか。**
  //     60fps で焼いた素材を、既定（15fps へ間引く）と 60fps のまま読むので比べる。
  //
  //     合成コマでは 60fps にすると距離が 0.243 → 0.086 まで薄まって**線を割り、丸ごと消える**。
  //     ところが**本物の動画では消えない**（0.354 → 0.136 で、線 0.10 の上に残る）。
  //     圧縮の粒が距離を押し上げるためで、代わりに **1 本が 2 本へ割れる**。
  //     壊れ方は違うが、どちらも「間引かずに読むと渡りが壊れる」。ここで見るのはそこ。
  const fast = await feed(page, 'dissolve', { fps: 60 });
  ok(
    '60fps の素材でも、既定なら 15fps へ間引いて読む',
    Math.abs(fast.state.sourceFps - 60) < 5 && Math.abs(fast.state.fps - 15) < 0.5,
    `素材 ${fast.state.sourceFps?.toFixed(1)}fps → 解析 ${fast.state.fps?.toFixed(1)}fps（${fast.state.frames} コマ）`,
  );
  ok(
    '間引いて読めば、1 秒かけて渡るディゾルブが見つかる',
    fast.state.boundaries.length === 1,
    `${fast.state.boundaries.length} 本（距離の最大 ${fast.state.peak.toFixed(3)}）`,
  );
  await setRange(page, '#fps', '60', 100);
  await page.locator('#fps').dispatchEvent('change');
  await page.waitForFunction(() => !window.__labScene.state().loading && (window.__labScene.state().fps ?? 0) > 50, null, {
    timeout: 120000,
  });
  await page.waitForTimeout(300);
  const dense = await page.evaluate(() => window.__labScene.state());
  ok(
    '間引かずに全コマ読むと、距離が半分以下に薄まる',
    dense.fps > 50 && dense.peak < fast.state.peak * 0.6,
    `${fast.state.frames} コマ ${fast.state.peak.toFixed(3)} → ${dense.frames} コマ ${dense.peak.toFixed(3)}`,
  );
  // **1 本だったものが 1 本でなくなる**のが壊れ方。合成コマなら 0 本（見逃し）、
  // 圧縮を通した本物なら 2 本（渡りの中で 2 回立つ）で、どちらも 1 本ではない。
  ok(
    '間引かずに全コマ読むと、1 本だったディゾルブが 1 本でなくなる',
    dense.boundaries.length !== 1,
    `1 本 → ${dense.boundaries.length} 本（${dense.boundaries.map((t) => t.toFixed(2)).join(', ') || 'なし'}）`,
  );
  ok('そのことを画面で知らせる', await page.locator('#scene-warning').isVisible(),
    (await page.locator('#scene-warning').textContent())?.slice(0, 24));
  await setRange(page, '#fps', '15', 100);
  await page.locator('#fps').dispatchEvent('change');
  await page.waitForFunction(() => !window.__labScene.state().loading && (window.__labScene.state().fps ?? 99) < 20, null, {
    timeout: 120000,
  });

  // (3) 見る量を替える。**`grid` はパンに破れる**というのが既定を選んだ理由なので、
  //     そこが画面からも見えるか（横型のパンで空振りが出る）。
  await feed(page, 'pan');
  const panCombined = await page.evaluate(() => window.__labScene.state());
  await page.locator('#metric').selectOption('grid');
  await page.waitForTimeout(500);
  const panGrid = await page.evaluate(() => window.__labScene.state());
  ok(
    'パンの素材で、画素の引き算にすると距離が上がる（既定を選んだ理由）',
    panGrid.peak > panCombined.peak,
    `combined ${panCombined.peak.toFixed(3)} → grid ${panGrid.peak.toFixed(3)}`,
  );
  await page.locator('#metric').selectOption('combined');
  await page.waitForTimeout(400);

  // --- 画面の記録 ---
  await feed(page, 'cuts-plain');
  const shot = path.join(here, '../fixtures/out/uitest-scene.png');
  fs.mkdirSync(path.dirname(shot), { recursive: true });
  await page.screenshot({ path: shot, fullPage: true });
  console.log(`\n画面の記録: ${shot}`);

  ok('ページ例外なし', errors.length === 0, errors.slice(0, 3).join(' / '));
} finally {
  await browser.close();
  server.stop();
}

if (failed > 0) {
  console.error(`\n${failed} 件が失敗しています。`);
  process.exit(1);
}
console.log('\nすべて通りました。');

/** キャンバスに何か描かれているか（真っ黒・真っ白のままでないか）。 */
function hasInk(page, id) {
  return page.evaluate((canvasId) => {
    const canvas = document.getElementById(canvasId);
    const ctx = canvas.getContext('2d');
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const seen = new Set();
    for (let i = 0; i < data.length; i += 4 * 97) seen.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
    return seen.size > 3;
  }, id);
}
