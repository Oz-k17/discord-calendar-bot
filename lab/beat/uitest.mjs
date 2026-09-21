/**
 * 拍の画面を通して確かめる。
 *
 *   npm run lab:beat:uitest
 *
 * selftest（ブラウザ不要）が「計算が合っているか」を見るのに対して、
 * こちらは **「読み込む → 描く → 拍を出す → 鳴らす」が繋がっているか**を見る。
 * 計算が正しくても配線が切れていれば使えないので、両方要る。
 *
 * ## 素材はその場で作って、ファイルにせずに渡す
 *
 * 拍の素材（`make-beats.mjs`）は `lab/fixtures/out/` に書き出していない
 * （種を固定した生成なら毎回 1 ビットまで同じ音が出るので、置く意味が無い）。
 * ここでは `encodeWav` で WAV のバイト列だけ作り、playwright の
 * `setInputFiles({ buffer })` でそのまま `<input type=file>` へ渡している。
 * **確かめるためだけに生成物を増やさない。**
 *
 * ## 数字がコマンドラインと合うかどうかは、標本化周波数が決める
 *
 * ブラウザの `decodeAudioData` は音を **AudioContext の**標本化周波数へ揃える。
 * 素材は 44.1kHz で、そこが違えば画面はコマンドラインと**別の音**を測ることになり、
 * 拍の秒も少し動く。**ずれるのが普通だろうと身構えて書いたが、実際には
 * 手元の Chromium が 44.1kHz で開いたので F 値は 3 桁ぴったり一致した。**
 *
 * そこで「幅を持たせておく」で済ませずに、**標本化周波数そのものを確認項目にしてある**。
 * こうしておくと、いつか数字がずれたときに
 * 「ブラウザが変換した」のか「配線が切れた」のかが、その 1 行で分かれる。
 * 突き合わせ自体の幅（0.05）は、変換の入る環境でも走らせられるように残した。
 *
 * playwright が無い環境では、その旨を出して成功扱いで終わる（作業を止めないため）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderBeatFixture } from '../fixtures/make-beats.mjs';
import { encodeWav } from '../fixtures/wav.mjs';
import { launch, loadPlaywright, serve } from '../browser.mjs';
import { scoreBeats } from './score.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

const playwright = loadPlaywright();
if (!playwright) {
  console.log('playwright が見つからないので画面の確認は飛ばします（計算は npm run lab:test で確認できます）。');
  process.exit(0);
}

const { detectBeats } = await import('./src/beats.ts');

let failed = 0;
const ok = (label, condition, detail = '') => {
  if (!condition) failed += 1;
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? `  :: ${detail}` : ''}`);
};

/** 素材を 1 本その場で作り、WAV のバイト列と正解を返す。 */
function clipOf(name) {
  const clip = renderBeatFixture(name);
  return {
    name,
    truth: clip.beats,
    audio: clip.audio,
    file: { name: `${name}.wav`, mimeType: 'audio/wav', buffer: encodeWav(clip.audio.getChannelData(0), clip.audio.sampleRate) },
  };
}

/** 画面へ 1 本読ませて、判定が終わるまで待つ。 */
async function feed(page, clip) {
  await page.locator('#beat-file').setInputFiles(clip.file);
  await page.waitForFunction((d) => {
    const s = window.__labBeat.state();
    return s.duration !== null && Math.abs(s.duration - d) < 0.5;
  }, clip.audio.length / clip.audio.sampleRate, { timeout: 30000 });
  await page.waitForTimeout(300);
  return page.evaluate(() => window.__labBeat.state());
}

const server = await serve(here);
const browser = await launch(playwright);
try {
  const page = await (await browser.newContext({ viewport: { width: 1000, height: 1400 }, deviceScaleFactor: 2 })).newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await page.goto(server.url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);

  // --- 画面から回すセルフテスト（コマンドライン版と同じものを見ている） ---
  await page.getByRole('button', { name: 'テストを実行' }).click();
  await page.waitForSelector('#test-results li');
  const tests = await page.evaluate(() =>
    [...document.querySelectorAll('#test-results li')].map((li) => ({
      ok: li.classList.contains('pass'),
      name: li.children[1].textContent,
    })),
  );
  ok(`画面からもセルフテストが通る（${tests.length} 件）`, tests.length > 0 && tests.every((t) => t.ok),
    tests.filter((t) => !t.ok).map((t) => t.name).join(' / ') || `${tests.length}/${tests.length}`);

  // **既定は画面に直書きせず、判定の側から写している。** ここが落ちたら、
  // 画面だけが別の設定で動いていることになる（数字は出たままなので気づけない）。
  const defaults = await page.evaluate(() => window.__labBeat.defaults);
  ok('画面の既定が判定の側から来ている',
    defaults.beats.tempoMethod === 'energy' && defaults.beats.phaseMethod === 'flux' && defaults.beats.followTempo === false,
    JSON.stringify(defaults.beats));

  // --- 素直な素材: 読み込む → 描く → 拍を出す ---
  const kick = clipOf('kick-120');
  const kickState = await feed(page, kick);
  ok('画面が素材と同じ標本化周波数で見ている', kickState.sampleRate === kick.audio.sampleRate,
    `素材 ${kick.audio.sampleRate}Hz / 画面 ${kickState.sampleRate}Hz`);
  ok('読み込んだ素材から拍が出る', kickState.bpm !== null && kickState.beats.length > 20,
    `${kickState.bpm?.toFixed(1)} BPM ・ ${kickState.beats.length} 本`);
  ok('統計が画面に出る', (await page.locator('#beat-stats div').count()) === 8,
    `${await page.locator('#beat-stats div').count()} 項目`);
  ok('波形と拍が描かれている', await hasInk(page, 'beat-canvas'));
  ok('拍のある素材では注意書きを出さない', !(await page.locator('#beat-warning').isVisible()));

  // **ここがこの確認のいちばんの目的。** 画面で出た拍を、コマンドラインと同じ物差しで採点し、
  // コマンドラインの数字と突き合わせる。判定を画面でやり直していたら、ここでずれる。
  for (const name of ['kick-120', 'syncopated-128', 'pad-only-96', 'tempo-change-90-120']) {
    const clip = name === 'kick-120' ? kick : clipOf(name);
    const state = name === 'kick-120' ? kickState : await feed(page, clip);
    const cli = scoreBeats(detectBeats(clip.audio).beats, clip.truth);
    const screen = scoreBeats(state.beats, clip.truth);
    ok(`${name}: 画面とコマンドラインの F 値が揃う`, Math.abs(screen.f - cli.f) < 0.05,
      `コマンドライン ${cli.f.toFixed(3)} / 画面 ${screen.f.toFixed(3)}`);
  }

  // --- 等分した吸い付き先（`subdivide` が画面から効くか） ---
  await feed(page, kick);
  const beforeSub = await page.evaluate(() => window.__labBeat.state());
  await setRange(page, '#subdivide', '2');
  await page.waitForTimeout(400);
  const afterSub = await page.evaluate(() => window.__labBeat.state());
  ok('2 等分すると吸い付き先が拍の 2 倍近くになる',
    afterSub.targets.length === beforeSub.beats.length * 2 - 1,
    `${beforeSub.targets.length} → ${afterSub.targets.length} 点（拍 ${beforeSub.beats.length} 本）`);
  ok('等分しても拍そのものは動かない', afterSub.beats.length === beforeSub.beats.length);

  // --- 吸い付き（この試作の出口） ---
  await setRange(page, '#subdivide', '1');
  await page.waitForTimeout(300);
  const beats = (await page.evaluate(() => window.__labBeat.state())).beats;
  // 拍のすぐ横に置いたカットは寄る。**素材の頭の拍は選ばない**（そこは鳴る前で、
  // 吸い付きの話ではなく「端に拍が立つ」の話になる）。
  const near = beats[8] + 0.03;
  await setRange(page, '#snap-at', near.toFixed(2));
  await page.waitForTimeout(200);
  const snapped = await page.locator('#snap-stats div').nth(1).locator('dd').textContent();
  ok('拍の近くのカットは拍へ寄る', Math.abs(parseFloat(snapped) - beats[8]) < 0.02,
    `${near.toFixed(3)} 秒 → ${snapped}（拍は ${beats[8].toFixed(3)} 秒）`);
  // 動かしてよい幅を 0 にすれば、何も動かないのが正しい。
  await setRange(page, '#max-shift', '0');
  await page.waitForTimeout(200);
  const held = await page.locator('#snap-stats div').nth(1).locator('dd').textContent();
  ok('幅を 0 にすると動かさない', Math.abs(parseFloat(held) - near) < 0.011, `${near.toFixed(3)} 秒 → ${held}`);
  await setRange(page, '#max-shift', '0.12');

  // (0) 列の選び方が画面から効いているか。**`syncopated-128` は位相の列を替えると、
  //     BPM も拍の本数も同じまま F 値だけ 1.000 → 0.000 になる**（丸ごと半拍ずれる）。
  //     「BPM の当たりだけを見ないこと」が 1 本の素材にそのまま出る所で、
  //     配線の確認としてはいちばん強い（数字が動くのではなく、当たりが裏返る）。
  const sync = clipOf('syncopated-128');
  const withFlux = await feed(page, sync);
  await page.locator('#phase-method').selectOption('energy');
  await page.waitForTimeout(1200);
  const withEnergy = await page.evaluate(() => window.__labBeat.state());
  const fFlux = scoreBeats(withFlux.beats, sync.truth).f;
  const fEnergy = scoreBeats(withEnergy.beats, sync.truth).f;
  ok('位相の列を替えると、拍の本数はそのままで当たりが裏返る',
    withEnergy.beats.length === withFlux.beats.length && fFlux > 0.9 && fEnergy < 0.1,
    `flux ${fFlux.toFixed(3)} → energy ${fEnergy.toFixed(3)}（どちらも ${withEnergy.beats.length} 本・${withEnergy.bpm?.toFixed(1)} BPM）`);
  await page.locator('#phase-method').selectOption('flux');
  await page.waitForTimeout(1200);

  // --- 自分の手を潰す素材 ---
  //
  // (1) 拍の無い雑音。**適当な 120 を埋めないこと**がこの試作の決め事なので、
  //     画面もそれを守っているかを見る。ここが緩むと、使う側は嘘の拍に合わせてカットを置く。
  const noise = clipOf('noise-only');
  const noiseState = await feed(page, noise);
  ok('拍の無い素材では拍を並べない', noiseState.bpm === null && noiseState.beats.length === 0,
    `はっきりさ ${noiseState.clarity.toFixed(2)}`);
  ok('そのことを画面で知らせる', await page.locator('#beat-warning').isVisible(),
    (await page.locator('#beat-warning').textContent())?.slice(0, 22));
  ok('吸い付き先も空のまま', noiseState.targets.length === 0);
  ok('拍が無くても波形は描く', await hasInk(page, 'beat-canvas'));

  // (2) 線を下げれば、同じ素材でも拍が立つ。**線が画面から効いていることの確認**で、
  //     同時に「この素材に拍が無いのは線のおかげ」だと目で分かる形でもある。
  await setRange(page, '#min-clarity', '1.1');
  await page.waitForTimeout(600);
  const loosened = await page.evaluate(() => window.__labBeat.state());
  ok('線を下げると、雑音にも拍が立ってしまう', loosened.bpm !== null && loosened.beats.length > 0,
    `${loosened.bpm?.toFixed(1)} BPM ・ ${loosened.beats.length} 本`);
  await setRange(page, '#min-clarity', '1.9');
  await page.waitForTimeout(600);

  // (3) 8 分ハットが拍より目立つ素材。既定の重み（中心 120・幅 0.9 オクターブ）が
  //     当てている相手で、**幅を広げると半分のテンポへ落ちる**。
  //     重みが画面から効いているかは、この落ち方でしか見えない。
  const hats = clipOf('hats-8th-120');
  const hatsState = await feed(page, hats);
  ok('8 分ハットの素材でも、既定ならテンポを取り違えない', Math.abs((hatsState.bpm ?? 0) - 120) < 5,
    `${hatsState.bpm?.toFixed(1)} BPM`);
  await setRange(page, '#prior-octaves', '3');
  await page.waitForTimeout(800);
  const widened = await page.evaluate(() => window.__labBeat.state());
  ok('幅を広げると倍・半分へ落ちる（＝重みが画面から効いている）',
    widened.bpm !== null && Math.abs(widened.bpm - (hatsState.bpm ?? 0)) > 20,
    `${hatsState.bpm?.toFixed(1)} → ${widened.bpm?.toFixed(1)} BPM`);
  await setRange(page, '#prior-octaves', '0.9');
  await page.waitForTimeout(800);

  // (4) 途中でテンポが変わる素材。**「追う」は既定では切ってある**（測って決めた）。
  //     画面から入れたときに、窓ごとのテンポが実際に付いてくるかを見る。
  const changing = clipOf('tempo-change-90-120');
  const steadyView = await feed(page, changing);
  ok('追わないときは窓ごとのテンポを持たない', !steadyView.following && steadyView.tempoSpread === 1,
    `振れ ${steadyView.tempoSpread.toFixed(3)}`);
  await page.locator('#follow-tempo').check();
  await page.waitForTimeout(1200);
  const following = await page.evaluate(() => window.__labBeat.state());
  ok('追う側にすると窓ごとのテンポが付いてくる', following.following && following.tempoSpread > 1.05,
    `振れ ${following.tempoSpread.toFixed(3)}`);
  ok('テンポが動いていることを画面で知らせる', await page.locator('#beat-warning').isVisible(),
    (await page.locator('#beat-warning').textContent())?.slice(0, 20));
  ok('追う側でも拍は並ぶ', following.beats.length > 20, `${following.beats.length} 本`);
  await page.locator('#follow-tempo').uncheck();
  await page.waitForTimeout(1200);

  // --- 鳴らす（音そのものは確かめられないので、例外が出ないことだけ） ---
  await feed(page, kick);
  await page.getByRole('button', { name: '拍を重ねて再生' }).click();
  await page.waitForTimeout(400);
  await page.locator('#stop-beat').click();
  await page.getByRole('button', { name: '元のまま再生' }).click();
  await page.waitForTimeout(300);
  await page.locator('#stop-beat').click();

  // 画面の記録の置き場所。**この確認は素材を作らなくても走る**ので、
  // `lab:fixtures` をまだ一度も流していない環境ではこの入れ物ごと無い。
  const shot = path.join(here, '../fixtures/out/uitest-beat.png');
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

function setRange(page, selector, value) {
  return page.locator(selector).evaluate((el, v) => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}
