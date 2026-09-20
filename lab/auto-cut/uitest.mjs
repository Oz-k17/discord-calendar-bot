/**
 * 画面まで通して確かめる。
 *
 *   npm run lab:fixtures   # 先に素材を作る
 *   npm run lab:uitest
 *
 * selftest（ブラウザ不要）が「計算が合っているか」を見るのに対して、
 * こちらは「読み込む → 描く → 鳴らす、が繋がっているか」を見る。
 * 計算が正しくても配線が切れていれば使えないので、両方要る。
 *
 * playwright が無い環境では、その旨を出して成功扱いで終わる（作業を止めないため）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, loadPlaywright, serve } from '../browser.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const fixtures = path.join(root, 'lab/fixtures/out');

const playwright = loadPlaywright();
if (!playwright) {
  console.log('playwright が見つからないので画面の確認は飛ばします（計算は npm run lab:test で確認できます）。');
  process.exit(0);
}
if (!fs.existsSync(path.join(fixtures, 'speech.wav'))) {
  console.error('試し用の素材がありません。先に `npm run lab:fixtures` を実行してください。');
  process.exit(1);
}

let failed = 0;
const ok = (label, condition, detail = '') => {
  if (!condition) failed += 1;
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? `  :: ${detail}` : ''}`);
};

const server = await serve(here);
const browser = await launch(playwright);
try {
  const page = await (await browser.newContext({ viewport: { width: 1000, height: 1200 }, deviceScaleFactor: 2 })).newPage();
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

  // --- 実際の素材を読ませる ---
  await page.locator('#voice-file').setInputFiles(path.join(fixtures, 'speech.wav'));
  await page.waitForFunction(() => window.__lab.state().voice !== null, { timeout: 30000 });
  await page.waitForTimeout(300);
  const { plan } = await page.evaluate(() => window.__lab.state());
  ok('読み込んだ素材から計画が出る', !!plan && plan.keep.length > 0, plan ? `${plan.keep.length} 本 / ${plan.removed.toFixed(2)} 秒削減` : 'なし');
  ok('統計が画面に出る', (await page.locator('#cut-stats div').count()) === 6, `${await page.locator('#cut-stats div').count()} 項目`);
  ok('波形が描かれている', await hasInk(page, 'voice-canvas'), '');

  // --- つまみを動かすと結果が変わる ---
  const before = (await page.evaluate(() => window.__lab.state())).plan.keep.length;
  await setRange(page, '#min-silence', '1.2');
  const after = (await page.evaluate(() => window.__lab.state())).plan.keep.length;
  ok('「短い無音は残す」を伸ばすと本数が減る', after < before, `${before} → ${after} 本`);
  await setRange(page, '#min-silence', '0.35');

  // --- 声らしさも見るモード ---
  await page.locator('input[name="mode"][value="speech"]').check();
  await page.waitForTimeout(400);
  const speechPlan = (await page.evaluate(() => window.__lab.state())).plan;
  ok('声らしさモードに切り替わる', speechPlan.usedMode === 'speech', speechPlan.usedMode);
  ok('声らしさのつまみが出る', await page.locator('.speech-only').first().isVisible());
  ok('音色の保持のつまみも出る', await page.locator('#envelope-hold').isVisible());
  ok('切り替えても計画が出る', speechPlan.keep.length > 0, `${speechPlan.keep.length} 本`);
  ok('声がよく入っている素材では注意書きを出さない', !(await page.locator('#cut-warning').isVisible()));

  // 声の無い素材では、削らずに知らせる。
  await page.locator('#voice-file').setInputFiles(path.join(fixtures, 'drums.wav'));
  await page.waitForFunction(() => window.__lab.state().plan?.usedMode === 'speech', { timeout: 30000 });
  await page.waitForTimeout(400);
  const drums = (await page.evaluate(() => window.__lab.state())).plan;
  ok('声が無ければ何もしない', drums.noSpeechFound && drums.removed === 0, `削った ${drums.removed.toFixed(2)} 秒`);
  ok('そのことを画面で知らせる', await page.locator('#cut-warning').isVisible(),
    (await page.locator('#cut-warning').textContent())?.slice(0, 24));

  // 声の少ない素材では、決めつけずに材料を出す。
  await page.locator('#voice-file').setInputFiles(path.join(fixtures, 'speech-sparse-bgm.wav'));
  await page.waitForFunction(() => window.__lab.state().plan?.noSpeechFound === false, { timeout: 30000 });
  await page.waitForTimeout(400);
  const sparse = (await page.evaluate(() => window.__lab.state())).plan;
  ok('声の少ない素材でも切れる', sparse.removed > 1, `${sparse.removed.toFixed(2)} 秒削減`);
  ok('割合が低ければ注意書きを出す', await page.locator('#cut-warning').isVisible(),
    `割合 ${(sparse.speechRatio * 100).toFixed(0)}%`);

  // 深さの門（`minEnergyDepthDrop`）が画面でも効いていること。**つまみは無いので、
  // ここが唯一の「列を渡し忘れていないか」の網。** 渡し忘れると画面だけ門の無い判定になり、
  // 数字は出たままなので気づけない。BGM の上でたまにしゃべる素材は門がいちばん働く相手で、
  // 既定で 2 秒以上を背景として落とす。
  ok('深さの門が画面でも効いている', sparse.energySeconds > 1,
    `門が落とした ${sparse.energySeconds.toFixed(2)} 秒`);

  // 包絡の門が画面からも効くこと。保持を伸ばすほど、音色が動いていない所まで残るようになる。
  //
  // **素材を `speech-sparse-bgm` から替えた**（2026-09-19・2 回目）。あちらで保持が伸ばしていた
  // 0.08 秒は「BGM だけの所まで残る」ぶんで、そこはいま深さの門が落とす。
  // **つまみが壊れたのではなく、同じ秒を別の門が先に落としている**（`lab:bench` では
  // あの素材の精度が 56% → 70% に上がっている）。保持の配線を見るには、
  // 門が触れない所で伸びる素材が要る。
  await page.locator('#voice-file').setInputFiles(path.join(fixtures, 'speech-bgm-loud.wav'));
  await page.waitForFunction(() => window.__lab.state().plan?.noSpeechFound === false, { timeout: 30000 });
  await page.waitForTimeout(400);
  const shortHold = (await page.evaluate(() => window.__lab.state())).plan;
  await setRange(page, '#envelope-hold', '1.2');
  await page.waitForTimeout(400);
  const longHold = (await page.evaluate(() => window.__lab.state())).plan;
  ok('保持を伸ばすと残る所が増える', longHold.resultDuration > shortHold.resultDuration,
    `${shortHold.resultDuration.toFixed(2)} → ${longHold.resultDuration.toFixed(2)} 秒`);
  ok('門が開いていた秒数も出る', longHold.envelopeSeconds > shortHold.envelopeSeconds,
    `${shortHold.envelopeSeconds.toFixed(2)} → ${longHold.envelopeSeconds.toFixed(2)} 秒`);
  await setRange(page, '#envelope-hold', '0.5');
  // 遡りの確認はもとの素材（BGM の上でたまにしゃべる）へ戻してから行う。
  await page.locator('#voice-file').setInputFiles(path.join(fixtures, 'speech-sparse-bgm.wav'));
  await page.waitForFunction(() => window.__lab.state().plan?.noSpeechFound === false, { timeout: 30000 });
  await page.waitForTimeout(400);

  // 発話の頭を遡るつまみも画面から効くこと。BGM の上でたまにしゃべる素材は、
  // 遡りを伸ばすほど発話の手前の BGM まで残るので、そこが動けば繋がっている。
  await setRange(page, '#speech-lead-in', '0');
  await page.waitForTimeout(400);
  const noLead = (await page.evaluate(() => window.__lab.state())).plan;
  await setRange(page, '#speech-lead-in', '1');
  await page.waitForTimeout(400);
  const longLead = (await page.evaluate(() => window.__lab.state())).plan;
  ok('遡りのつまみも出る', await page.locator('#speech-lead-in').isVisible());
  ok('遡りを伸ばすと発話の頭が戻る', longLead.resultDuration > noLead.resultDuration,
    `${noLead.resultDuration.toFixed(2)} → ${longLead.resultDuration.toFixed(2)} 秒`);
  ok('遡っても「声らしいコマの割合」は動かない', Math.abs(longLead.speechRatio - noLead.speechRatio) < 1e-6,
    `${noLead.speechRatio.toFixed(3)} → ${longLead.speechRatio.toFixed(3)}`);
  await setRange(page, '#speech-lead-in', '0.32');

  await page.locator('#voice-file').setInputFiles(path.join(fixtures, 'speech.wav'));
  await page.waitForFunction(() => window.__lab.state().voice !== null, { timeout: 30000 });
  await page.waitForTimeout(400);
  await page.locator('input[name="mode"][value="level"]').check();
  await page.waitForTimeout(300);
  ok('戻すと音量だけの判定に戻る', (await page.evaluate(() => window.__lab.state())).plan.usedMode === 'level');
  ok('戻すとつまみも隠れる', !(await page.locator('.speech-only').first().isVisible()));

  // --- ラウドネス（LUFS）---
  //
  // 計算そのものは selftest が規格の試験信号で押さえているので、ここで見るのは配線だけ。
  // **画面は「1ch を 2ch 扱いで測る」を自分で決めている**（本体の書き出しが 2ch のため）ので、
  // そこが落ちると数字は出たまま 3dB ずれる。素材を替えて読みが動くことで確かめる。
  await page.locator('#voice-file').setInputFiles(path.join(fixtures, 'speech.wav'));
  await page.waitForFunction(() => window.__lab.state().loudness !== null, { timeout: 30000 });
  await page.waitForTimeout(300);
  const loud = await page.evaluate(() => window.__lab.state());
  ok('ラウドネスが測れている', loud.loudness.integratedLufs !== null && loud.loudness.integratedLufs < 0,
    `${loud.loudness.integratedLufs.toFixed(1)} LUFS`);
  ok('1ch の素材を 2ch 扱いで測っている', Math.abs(loud.loudness.integratedLufs - -19.6) < 0.5,
    `${loud.loudness.integratedLufs.toFixed(1)} LUFS（1ch のまま測ると -22.6 付近になる）`);
  ok('倍率が出る', loud.loudnessPlan && Math.abs(loud.loudnessPlan.gainDb) > 0.1,
    `${loud.loudnessPlan.gainDb.toFixed(2)} dB`);
  // 7 つの測定値＋「均した量」で 8 つ（2026-09-20 にリミッタを足した）。
  ok('大きさの統計が画面に出る', (await page.locator('#loudness-stats div').count()) === 8,
    `${await page.locator('#loudness-stats div').count()} 項目`);

  // 目標を下げれば倍率も下がる（つまみが計算まで届いているか）。
  const targetBefore = (await page.evaluate(() => window.__lab.state())).loudnessPlan.gainDb;
  await setRange(page, '#target-lufs', '-20');
  await page.waitForTimeout(200);
  const targetAfter = (await page.evaluate(() => window.__lab.state())).loudnessPlan.gainDb;
  ok('目標を下げると倍率も下がる', targetAfter < targetBefore - 1, `${targetBefore.toFixed(2)} → ${targetAfter.toFixed(2)} dB`);
  await setRange(page, '#target-lufs', '-14');

  // 真のピークが標本のピークを超えている素材で、天井が効いていること。
  // **標本だけを見ていると「0dBFS ちょうどでまだ余裕がある」と読めてしまう**素材なので、
  // ここが落ちるなら 4 倍に打ち直す側の配線が切れている。
  await page.locator('#voice-file').setInputFiles(path.join(fixtures, 'speech-loud-clipped.wav'));
  await page.waitForFunction(() => window.__lab.state().loudness?.truePeakDb > 0, { timeout: 30000 });
  await page.waitForTimeout(300);
  const clipped = (await page.evaluate(() => window.__lab.state())).loudness;
  ok('叩き切った素材は真のピークが標本を超える', clipped.truePeakDb > clipped.samplePeakDb + 1,
    `標本 ${clipped.samplePeakDb.toFixed(2)} dBFS / 真 ${clipped.truePeakDb.toFixed(2)} dBTP`);

  // --- リミッタ（山を均す）---
  // ピークで止まっていた素材が、均すことで目標へ届くこと。
  // **画面まで通して確かめる意味があるのはここ**で、計算は合っているのに
  // 配線が切れていて「均していない音が鳴る」ということが起こりうる。
  await page.locator('#voice-file').setInputFiles(path.join(fixtures, 'speech-bgm.wav'));
  await page.waitForFunction(() => window.__lab.state().limiter !== null, { timeout: 30000 });
  await page.waitForTimeout(300);
  const limited = await page.evaluate(() => window.__lab.state());
  ok('ピークで止まっていた素材が、均すと目標へ届く', limited.loudnessPlan.limitedBy === 'none',
    `${limited.loudnessPlan.gainDb.toFixed(2)} dB まで上げられた`);
  ok('均した深さと時間が画面に出る', limited.limiter.maxReductionDb > 0 && limited.limiter.activeRatio > 0,
    `${limited.limiter.maxReductionDb.toFixed(2)} dB を ${(limited.limiter.activeRatio * 100).toFixed(2)}%`);
  ok('均したあとも天井を超えていない', limited.limiter.truePeakDb <= -1 + 0.01,
    `${limited.limiter.truePeakDb.toFixed(2)} dBTP`);

  // 切ると、同じ素材が天井で止まる側へ戻ること（つまみが効いている確認でもある）。
  await page.locator('#use-limiter').uncheck();
  await page.waitForTimeout(400);
  const noLimiter = (await page.evaluate(() => window.__lab.state()));
  ok('リミッタを切るとピークで止まる側へ戻る',
    noLimiter.loudnessPlan.limitedBy === 'peak' && noLimiter.limiter === null,
    `届かなかったぶん ${noLimiter.loudnessPlan.shortfallDb.toFixed(2)} dB`);
  await page.locator('#use-limiter').check();
  await page.waitForTimeout(400);

  // 一瞬の大きな音に倍率を人質に取られる素材は、**均してもなお届かない。**
  // そこは「均した」ではなく「消した」になるので、届かせないのが正しい振る舞い。
  await page.locator('#voice-file').setInputFiles(path.join(fixtures, 'speech-click.wav'));
  await page.waitForFunction(() => window.__lab.state().loudnessPlan?.limitedBy === 'limiter', { timeout: 30000 });
  await page.waitForTimeout(300);
  const clickPlan = (await page.evaluate(() => window.__lab.state())).loudnessPlan;
  ok('均せる深さを超える素材では、届かなかったことを画面で知らせる', await page.locator('#loudness-warning').isVisible(),
    `届かなかったぶん ${clickPlan.shortfallDb.toFixed(2)} dB`);

  await page.getByRole('button', { name: '揃えたあとを再生' }).click();
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: '停止' }).last().click();

  // 以降の段は声の入った素材を前提にしているので、読み直しておく。
  await page.locator('#voice-file').setInputFiles(path.join(fixtures, 'speech.wav'));
  await page.waitForFunction(() => window.__lab.state().plan?.noSpeechFound === false, { timeout: 30000 });
  await page.waitForTimeout(300);

  // --- ダッキング ---
  await page.locator('#bgm-file').setInputFiles(path.join(fixtures, 'bgm.wav'));
  await page.waitForFunction(() => window.__lab.state().bgm !== null, { timeout: 30000 });
  await page.waitForTimeout(300);
  const { duckPoints } = await page.evaluate(() => window.__lab.state());
  ok('音量カーブが出る', duckPoints.length > 2, `${duckPoints.length} 点`);
  ok('下げているところがある', duckPoints.some((p) => p.gain < 0.5), `最小 ${Math.min(...duckPoints.map((p) => p.gain)).toFixed(3)}`);
  ok('BGM の波形とカーブが描かれている', await hasInk(page, 'bgm-canvas'), '');

  // --- 再生の口が塞がっていないか（音そのものは確かめられないので、例外が出ないことだけ） ---
  await page.getByRole('button', { name: 'カット後を再生' }).click();
  await page.waitForTimeout(400);
  await page.getByRole('button', { name: '停止' }).first().click();

  const shot = path.join(fixtures, 'uitest.png');
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
