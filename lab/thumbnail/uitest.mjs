/**
 * 表紙の画面を通して確かめる。
 *
 *   npm run lab:thumb:uitest
 *
 * selftest（ブラウザ不要）が「計算が合っているか」を見るのに対して、
 * こちらは **「本物の動画を読む → 点を付ける → 候補を出す → 絵として書き出す」が
 * 繋がっているか**を見る。計算が正しくても配線が切れていれば使えないので、両方要る。
 *
 * ## 素材は、その場で**本物の動画に焼いて**渡す
 *
 * シーン検出の `uitest.mjs` と同じ手（焼く側も読む側も WebCodecs なので、
 * ブラウザの中で焼いてから同じページへ食わせる）。違うのは **4 倍に拡大して焼く**ことで、
 * 理由は `testkit/encode.ts` の頭に書いた——等倍だと「測るコマ」と「書き出す絵」が
 * 同じ大きさになり、この画面でいちばん確かめたい所が区別できなくなる。
 *
 * ## 数字がコマンドラインと合うかどうかは、圧縮が決める
 *
 * 合成したコマをそのまま測るコマンドラインと違い、画面は一度 WebM に焼いてから読む。
 * 量子化の粒が乗るので、選ぶ秒がコマンドラインとぴったり同じにはならない。
 * そこで突き合わせるのは秒そのものではなく、**`bench.mjs` と同じ物差しで採点した
 * 「駄目なコマを選んだか / 良い所から選べたか / 場面の網羅」**にしてある。
 * ここが揃わなければ、配線か、圧縮への弱さのどちらか。
 *
 * playwright が無い環境では、その旨を出して成功扱いで終わる（作業を止めないため）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderSpec } from '../fixtures/make-frames.mjs';
import { inRanges, thumbFixture } from '../fixtures/thumbs.mjs';
import { launch, loadPlaywright, serve } from '../browser.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

const playwright = loadPlaywright();
if (!playwright) {
  console.log('playwright が見つからないので画面の確認は飛ばします（計算は npm run lab:test で確認できます）。');
  process.exit(0);
}

const { summarizeThumbs } = await import('./src/thumb.ts');
const { summarizeFrames } = await import('../scene-cut/src/frames.ts');
const { pickThumbnails } = await import('./src/pick.ts');

let failed = 0;
const ok = (label, condition, detail = '') => {
  if (!condition) failed += 1;
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? `  :: ${detail}` : ''}`);
};

/** `bench.mjs` と同じ採点。ここを揃えておかないと、画面とコマンドラインを並べる意味が無い。 */
function score(picks, spec) {
  let bad = 0;
  let good = 0;
  for (const p of picks) {
    if (inRanges(p.time, spec.bad)) bad += 1;
    if (spec.good.length > 0 && inRanges(p.time, spec.good)) good += 1;
  }
  let shots = 0;
  if (spec.shots) {
    const of = (time) => {
      let index = 0;
      for (let i = 0; i < spec.shots.length; i += 1) if (time >= spec.shots[i] - 1e-9) index = i;
      return index;
    };
    shots = new Set(picks.map((p) => of(p.time))).size;
  }
  return { bad, good, shots, picks: picks.length };
}

/** コマンドライン側の答え（合成したコマをそのまま測る）。 */
function commandLine(name, { aspect = 'landscape', options } = {}) {
  const spec = thumbFixture(name);
  const clip = renderSpec(spec, { aspect });
  const stats = summarizeThumbs(clip.frames, clip.times);
  const frameStats = summarizeFrames(clip.frames, clip.times);
  const picks = pickThumbnails(stats, frameStats, options ?? {});
  return { spec, picks, score: score(picks, spec) };
}

/** 素材を本物の動画に焼いて、画面へ読ませ、候補と書き出しが揃うまで待つ。 */
async function feed(page, name, { aspect = 'landscape' } = {}) {
  const encoded = await page.evaluate(
    ([n, a]) =>
      window.__labThumbEncode(n, { aspect: a }).then((r) => ({
        bytes: [...r.bytes],
        width: r.width,
        height: r.height,
        fps: r.fps,
        frames: r.frames,
        codec: r.codec,
      })),
    [name, aspect],
  );
  await page.locator('#thumb-file').setInputFiles({
    name: `${name}.webm`,
    mimeType: 'video/webm',
    buffer: Buffer.from(encoded.bytes),
  });
  // **尺ではなくコマの数で待つ**（`duration` は最初のコマを読む前に決まる）。
  // 書き出しの読み直しも同じ列に並ぶので、そこが下りるまで併せて待つ。
  await page.waitForFunction(
    () => {
      const s = window.__labThumb.state();
      return s.frames > 0 && !s.loading && !s.exporting;
    },
    null,
    { timeout: 120000 },
  );
  await page.waitForTimeout(300);
  return { encoded, state: await page.evaluate(() => window.__labThumb.state()) };
}

/** つまみを動かして、選び直しが回りきるまで待つ。 */
async function setRange(page, selector, value, settle = 500) {
  await page.locator(selector).evaluate((el, v) => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
  await page.waitForFunction(() => !window.__labThumb.state().exporting, null, { timeout: 60000 });
  await page.waitForTimeout(settle);
}

const server = await serve(here);
const browser = await launch(playwright);
try {
  const page = await (await browser.newContext({ viewport: { width: 1000, height: 1700 }, deviceScaleFactor: 2 })).newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await page.goto(server.url, { waitUntil: 'networkidle' });
  // 焼く部品は画面には入っていないので、確かめるときだけ差し込む。
  await page.addScriptTag({ type: 'module', url: './testkit/encode.ts' });
  await page.waitForFunction(() => typeof window.__labThumbEncode === 'function', null, { timeout: 30000 });

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
  const defaults = await page.evaluate(() => window.__labThumb.defaults);
  ok(
    '画面の既定が判定の側から来ている',
    defaults.pick.sharpness === 'grad' &&
      defaults.pick.count === 3 &&
      defaults.pick.qualityFloor === 0.7 &&
      defaults.pick.floorBase === 'median' &&
      defaults.pick.minDistance === 0.15 &&
      defaults.pick.flashHigh === 1.4 &&
      defaults.analysisFps === 15 &&
      defaults.exportLongSide === 1920,
    `${JSON.stringify(defaults.pick)} / ${defaults.analysisFps}fps / 書き出し ${defaults.exportLongSide}`,
  );

  // --- 焼く → 読む → 点を付ける → 候補を出す ---
  const whip = await feed(page, 'whip-still');
  ok(
    '焼いた動画が本物として読めている',
    whip.state.frames > 180 && whip.state.duration > 12.5 && Math.abs(whip.state.sourceFps - 15) < 1.5,
    `${whip.encoded.codec} ・ ${whip.encoded.width}×${whip.encoded.height} で焼いた ・ ` +
      `${whip.state.frames} コマ ・ ${whip.state.duration?.toFixed(2)}s ・ 素材 ${whip.state.sourceFps?.toFixed(1)}fps`,
  );
  ok(
    '測るコマは長辺 128 まで縮めて読んでいる',
    whip.state.width === 128 && whip.state.height === 72,
    `${whip.state.width}×${whip.state.height}`,
  );
  ok('コマの欠けが無い', whip.state.missing === 0, `${whip.state.missing} 枚`);
  ok('統計が画面に出る', (await page.locator('#thumb-stats div').count()) === 8);
  ok('点の列と選んだコマが描かれている', await hasInk(page, 'thumb-canvas'));
  ok(
    '候補が絵として並ぶ',
    (await page.locator('#thumb-picks figure').count()) === whip.state.picks.length && whip.state.picks.length === 3,
    `${await page.locator('#thumb-picks figure').count()} 枚`,
  );

  // --- ここがこの画面を作った理由: 書き出しは「測ったコマ」ではない ---
  //
  // 素材は 4 倍（512×288）で焼いてある。測るのは長辺 128 まで縮めた 128×72。
  // **書き出しが 128×72 で出てきたら、測るコマをそのまま出している**ことになる。
  ok(
    '書き出す絵は、測るコマではなく素材の大きさで読み直している',
    whip.state.exportSizes.length === 3 &&
      whip.state.exportSizes.every((s) => s.width === 512 && s.height === 288),
    `測る ${whip.state.width}×${whip.state.height} → 書き出し ` +
      `${whip.state.exportSizes.map((s) => `${s.width}×${s.height}`).join(' ') || 'なし'}`,
  );

  const png = await page.evaluate(async () => {
    const blob = await window.__labThumb.png(0);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return { type: blob.type, size: blob.size, head: [...bytes.slice(0, 8)] };
  });
  ok(
    '書き出した絵は本物の PNG',
    png.type === 'image/png' && png.head.join(',') === '137,80,78,71,13,10,26,10' && png.size > 1000,
    `${png.type} ・ ${png.size} バイト`,
  );

  // 名前に秒が入っているか（3 枚まとめて落として混ざらないため）。
  const name = await page.evaluate(async () => {
    const seen = [];
    const original = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function patched() {
      seen.push(this.download);
    };
    document.querySelectorAll('#thumb-picks button')[0].click();
    await new Promise((r) => setTimeout(r, 800));
    HTMLAnchorElement.prototype.click = original;
    return seen;
  });
  ok(
    '保存の名前に素材と秒が入る',
    name.length === 1 && /whip-still_\d+p\d+s\.png$/.test(name[0]),
    name.join(' / ') || '押せていない',
  );

  // --- **この画面のいちばん静かな壊れ方**: 選んだ秒と書き出す秒が 1 コマずれる ---
  //
  // 絵は出るし、大きさも合うし、点も出る。違うのは「写っているもの」だけなので、
  // ここを測らないと誰も気づけない。
  //
  // **測る相手は `cuts-plain`（場面が 4 つ切り替わる素材）でないといけない。**
  // 最初は `whip-still` で測って素通りした——止まった場面では候補 3 枚が
  // どれも同じ絵なので、**書き出しが別の候補とすり替わっても分布が変わらない**
  // （自分と 0.0191 対 ほかと 0.0194・0.0221 で、差が 2% しか無い）。
  // 検査が「壊れていないこと」ではなく「壊れても同じに見えること」を確かめていた。
  await feed(page, 'cuts-plain');
  const cmp = await page.evaluate(() => window.__labThumbCompare(0));
  ok(
    '書き出した絵は、選んだコマと同じ絵（別の候補とは桁が違う）',
    cmp.self < 0.05 && cmp.others.every((d) => d > cmp.self * 3),
    `自分と ${cmp.self.toFixed(4)} ・ ほかの候補と ${cmp.others.map((d) => d.toFixed(4)).join(' ')}`,
  );

  // --- 画面とコマンドラインを、同じ物差しで突き合わせる ---
  for (const fixture of ['whip-still', 'whip-captions', 'whip-grain', 'flash', 'fade-black', 'dissolve', 'cuts-plain']) {
    const { state } = fixture === 'whip-still' ? whip : await feed(page, fixture);
    const cli = commandLine(fixture);
    const screen = score(state.picks, cli.spec);
    ok(
      `${fixture}: 画面とコマンドラインで、駄目・良い所・場面の数が揃う`,
      screen.bad === cli.score.bad && screen.good === cli.score.good && screen.shots === cli.score.shots,
      `コマンドライン ${cli.score.bad}/${cli.score.good}/${cli.score.shots} ・ 画面 ${screen.bad}/${screen.good}/${screen.shots}` +
        `（${state.picks.map((p) => p.time.toFixed(2)).join(' ')}）`,
    );
  }

  // --- 自分の手を潰す ---
  //
  // (1) 振り切ってから止まるカメラ。**ボケた前半（0〜5.4 秒）を 1 枚も選ばない**。
  //     圧縮の粒はボケたコマにも鮮明なコマにも乗るので、ここは粒に耐えるかの確認でもある。
  await feed(page, 'whip-still');
  const whipAgain = await page.evaluate(() => window.__labThumb.state());
  ok(
    'ボケている前半からは 1 枚も選ばない（焼いた動画でも）',
    whipAgain.picks.every((p) => p.time > 5.4),
    whipAgain.picks.map((p) => p.time.toFixed(2)).join(' '),
  );

  // (2) 出来の下限を切る。**線が画面から効いていることは、
  //     数字が動くことではなく「守っていたものが壊れること」で見る。**
  const flash = await feed(page, 'flash');
  const flashSpec = thumbFixture('flash');
  ok(
    'フラッシュで白く飛んだコマを、既定は 1 枚も選ばない',
    flash.state.picks.every((p) => !inRanges(p.time, flashSpec.bad)),
    flash.state.picks.map((p) => p.time.toFixed(2)).join(' '),
  );
  await setRange(page, '#quality-floor', '0');
  const noFloor = await page.evaluate(() => window.__labThumb.state());
  ok(
    '下限を切ると、いちばん壊れたコマを進んで選ぶ（9/23 に踏んだ穴）',
    noFloor.picks.some((p) => inRanges(p.time, flashSpec.bad)),
    `${noFloor.picks.map((p) => p.time.toFixed(2)).join(' ')}（白く飛ぶのは ${flashSpec.bad.map((r) => `${r.from.toFixed(2)}〜${r.to.toFixed(2)}`).join(' ')}）`,
  );
  await setRange(page, '#quality-floor', '0.7');

  // (3) 枚数を増やすと、条件を緩めて入る枚数が増える。**それを画面が黙らない**こと。
  await setRange(page, '#count', '6');
  const many = await page.evaluate(() => window.__labThumb.state());
  ok(
    '枚数を増やすと、条件を緩めた 1 枚が出て、画面がそれを知らせる',
    many.picks.length === 6 && many.picks.some((p) => p.relaxed) && (await page.locator('#thumb-warning').isVisible()),
    `${many.picks.filter((p) => p.relaxed).length} 枚が緩め（${many.picks.map((p) => p.relaxed ?? '—').join(' ')}）`,
  );
  ok(
    '緩めた 1 枚には、絵の下に理由が付く',
    (await page.locator('#thumb-picks .relaxed').count()) === many.picks.filter((p) => p.relaxed).length,
    `${await page.locator('#thumb-picks .relaxed').count()} 件`,
  );
  await setRange(page, '#count', '3');

  // --- 画面の記録 ---
  await feed(page, 'cuts-plain');
  const shot = path.join(here, '../fixtures/out/uitest-thumb.png');
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
