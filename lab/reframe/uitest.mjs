/**
 * 自動リフレームの画面を通して確かめる。
 *
 *   npm run lab:reframe:uitest
 *
 * selftest（ブラウザ不要）が「計算が合っているか」を見るのに対して、
 * こちらは **「本物の動画を読む → 枠を決める → 切り出して見せる」が繋がっているか**を見る。
 * 計算が正しくても配線が切れていれば使えないので、両方要る。
 *
 * ## 素材は、その場で**本物の動画に焼いて**渡す
 *
 * シーン検出の確かめと同じ形（`scene-cut/uitest.mjs` の注に事情が書いてある）。
 * 焼く部品まで同じものを借りているので、**圧縮の粒が乗った状態**で測れる。
 * リフレームでは、これが効きの確認でもある——被写体を指す手（`spatial`）は
 * 「そのコマの中で色が浮いている列」を見るので、**量子化の粒は列の色を動かす側**に居る。
 *
 * ## 突き合わせるのは枠そのものではなく、採点
 *
 * 圧縮を通すと生の位置は 1 列ぶんくらい動くので、枠の中心はコマンドラインとぴったりは揃わない。
 * そこで見るのは `score.mjs`（`bench.mjs` と同じ関数）が出す**入れた率・ずれ・泳ぎ**。
 * ここが揃わなければ、配線か、圧縮への弱さのどちらか。
 *
 * playwright が無い環境では、その旨を出して成功扱いで終わる（作業を止めないため）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { REFRAME_FIXTURES, SCENE_FIXTURES, SCENE_FPS } from '../fixtures/scenes.mjs';
import { renderFixture } from '../fixtures/make-frames.mjs';
import { launch, loadPlaywright, serve } from '../browser.mjs';
import { scoreFollow, scoreSwim, totalSwim } from './score.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * 撮った絵から取る明るさの本数。元が 32 列なので、切り出した 31.6% には 10 本ぶんしか無い。
 *
 * **ここで宣言しているのは、下の `matchCrop` が本体の途中から呼ばれるため。**
 * 末尾に `const` で置くと、呼ぶほうが先に走って初期化前に触ることになる
 * （`function` なら巻き上がるので気づけない）。
 */
const CROP_SAMPLES = 10;

const playwright = loadPlaywright();
if (!playwright) {
  console.log('playwright が見つからないので画面の確認は飛ばします（計算は npm run lab:test で確認できます）。');
  process.exit(0);
}

const { DEFAULT_REFRAME, planReframe, summarizeForReframe } = await import('./src/reframe.ts');

let failed = 0;
const ok = (label, condition, detail = '') => {
  if (!condition) failed += 1;
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? `  :: ${detail}` : ''}`);
};

const fixtureOf = (name) =>
  [...SCENE_FIXTURES, ...REFRAME_FIXTURES].find((f) => f.name === name);

/** コマンドライン側の答え（合成したコマをそのまま測る）。 */
function commandLine(name, { fps = SCENE_FPS, options = {} } = {}) {
  const clip = renderFixture(name, { fps });
  const cols = summarizeForReframe(clip.frames, clip.times, options);
  const centers = planReframe(cols, options).frames.map((f) => f.center);
  return { times: [...clip.times], centers, cuts: clip.cuts, fps };
}

/**
 * 素材を本物の動画に焼いて、画面へ読ませ、判定が終わるまで待つ。
 *
 * 待ち方を「コマが揃ったか」にしてあるのは、**尺だけ見ると読み込み途中で通ってしまう**ため。
 */
async function feed(page, name, { fps } = {}) {
  const encoded = await page.evaluate(
    ([n, f]) =>
      window.__labReframeEncode(n, { ...(f ? { fps: f } : {}) }).then((r) => ({
        bytes: [...r.bytes],
        cuts: r.cuts,
        fps: r.fps,
        frames: r.frames,
        codec: r.codec,
      })),
    [name, fps ?? null],
  );
  await page.locator('#rf-file').setInputFiles({
    name: `${name}.webm`,
    mimeType: 'video/webm',
    buffer: Buffer.from(encoded.bytes),
  });
  await page.waitForFunction(
    () => window.__labReframe.state().frames > 0 && !window.__labReframe.state().loading,
    null,
    { timeout: 90000 },
  );
  await page.waitForTimeout(300);
  return { encoded, state: await page.evaluate(() => window.__labReframe.state()) };
}

/** つまみを動かして、判定が回りきるまで待つ。 */
async function setRange(page, selector, value, settle = 500) {
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
  const page = await (
    await browser.newContext({ viewport: { width: 1000, height: 1500 }, deviceScaleFactor: 2 })
  ).newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await page.goto(server.url, { waitUntil: 'networkidle' });
  // 焼く部品は画面には入っていないので、確かめるときだけ差し込む。
  await page.addScriptTag({ type: 'module', url: './testkit/encode.ts' });
  await page.waitForFunction(() => typeof window.__labReframeEncode === 'function', null, { timeout: 30000 });

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
  const defaults = await page.evaluate(() => window.__labReframe.defaults);
  ok(
    '画面の既定が判定の側から来ている',
    Math.abs(defaults.reframe.cropWidth - 81 / 256) < 1e-9 &&
      defaults.reframe.deadband === 0.06 &&
      defaults.reframe.maxSpeed === 0.22 &&
      defaults.reframe.settle === 0.3 &&
      defaults.reframe.smooth === 1 &&
      defaults.reframe.rowBand.from === 0.15 &&
      defaults.reframe.leadIn === true &&
      defaults.analysisFps === 15,
    `${JSON.stringify(defaults.reframe)} / ${defaults.analysisFps}fps`,
  );

  // --- 素直な素材: 焼く → 読む → 枠を決める ---
  const motion = await feed(page, 'motion');
  ok(
    '焼いた動画が本物として読めている',
    motion.state.frames > 180 && motion.state.duration > 12.5 && Math.abs(motion.state.sourceFps - 15) < 1.5,
    `${motion.encoded.codec} ・ ${motion.state.frames} コマ ・ ${motion.state.duration?.toFixed(2)}s ・ 素材 ${motion.state.sourceFps?.toFixed(1)}fps`,
  );
  ok(
    'コマは長辺 128 まで縮めて読んでいる',
    motion.state.width === 128 && motion.state.height === 72,
    `${motion.state.width}×${motion.state.height}`,
  );
  ok('コマの欠けが無い', motion.state.missing === 0, `${motion.state.missing} 枚`);
  ok('統計が画面に出る', (await page.locator('#rf-stats div').count()) === 8);
  // **既定が「写っている」だけでは足りない。つまみの目盛りが既定を表せるかまで見る。**
  // 目盛りが 0.005 きざみだったとき、画面は既定（81/256 = 0.31640625）を表せずに
  // 黙って 0.315 で動いていた。既定を写す行は通っているので、そこを見ても気づけない。
  ok(
    'つまみの目盛りが既定をちょうど表せている（画面が別の幅で動いていない）',
    Math.abs(motion.state.cropWidth - DEFAULT_REFRAME.cropWidth) < 1e-12,
    `画面 ${motion.state.cropWidth} / 判定 ${DEFAULT_REFRAME.cropWidth}`,
  );
  ok('枠の動きが描かれている', await hasInk(page, 'rf-canvas'));

  // **ここがこの確認のいちばんの目的。** 画面で出た枠を、コマンドラインと同じ物差しで
  // 採点して突き合わせる。判定を画面でやり直していたらここでずれる。
  console.log('\n画面（焼いた動画）とコマンドライン（合成コマ）の突き合わせ\n');
  console.log('素材                   入れた率（画面 / CLI）      ずれ（画面 / CLI）');
  console.log('-'.repeat(68));
  for (const name of ['motion', 'subject-pan', 'subject-pause', 'subject-cuts', 'subject-static', 'subject-decoy']) {
    const { state } = name === 'motion' ? motion : await feed(page, name);
    const cli = commandLine(name);
    const fixture = fixtureOf(name);
    const screen = scoreFollow(fixture, state.times, state.centers, state.cropWidth);
    const command = scoreFollow(fixture, cli.times, cli.centers, DEFAULT_REFRAME.cropWidth);
    console.log(
      `${name.padEnd(20)} ${`${screen.inside.toFixed(1)}%`.padStart(8)} / ${`${command.inside.toFixed(1)}%`.padStart(7)}` +
        `      ${screen.error.toFixed(3)} / ${command.error.toFixed(3)}`,
    );
    // 幅は 3 ポイント。圧縮の粒で生の位置が 1 列（3.1%）動くと、deadband の縁に居るコマの
    // 行き先が変わるので、ぴったり一致は求められない。**判定が別物なら 3 ポイントでは収まらない。**
    ok(
      `${name}: 画面とコマンドラインで、入れた率が揃う`,
      Math.abs(screen.inside - command.inside) <= 3,
      `コマンドライン ${command.inside.toFixed(1)}% ・ 画面 ${screen.inside.toFixed(1)}%（ずれ ${command.error.toFixed(3)} / ${screen.error.toFixed(3)}）`,
    );
  }

  // --- 自分の手を潰す素材（1）: 被写体が居ない ---
  //
  // **入れた率だけを見ると「ずっと貼り付ける」が満点になる**ので、居ない側を必ず併せて見る。
  // ここで圧縮が効くとしたら、**粒が列の色を動かして枠を泳がせる**向き。
  for (const name of ['captions-only', 'cuts-plain']) {
    const { state } = await feed(page, name);
    const cli = commandLine(name);
    const fixture = fixtureOf(name);
    const screen = scoreSwim(state.times, state.centers, fixture.cuts, SCENE_FPS);
    const command = scoreSwim(cli.times, cli.centers, fixture.cuts, SCENE_FPS);
    ok(
      `${name}: 被写体が居ないとき、画面でも枠が泳がない`,
      screen.swim <= Math.max(command.swim, 0.01) + 0.02,
      `コマンドライン ${command.swim.toFixed(3)} / 秒 ・ 画面 ${screen.swim.toFixed(3)} / 秒`,
    );
  }

  // --- 自分の手を潰す素材（2）: 上下の帯を外す ---
  //
  // 既定（上下 15% を見ない）を選んだ理由がここ。**数字が動くことではなく、
  // 守っていたものが壊れること**で「その線が画面から効いている」を見る。
  const caps = await feed(page, 'captions-only');
  const capsDefault = scoreSwim(caps.state.times, caps.state.centers, [], SCENE_FPS);
  await setRange(page, '#row-band', '0');
  const capsFull = await page.evaluate(() => window.__labReframe.state());
  const capsFullScore = scoreSwim(capsFull.times, capsFull.centers, [], SCENE_FPS);
  ok(
    '上下の帯を外すと、字幕だけの素材で枠が泳ぎ出す',
    capsFullScore.swim > capsDefault.swim * 3 && capsFullScore.range > capsDefault.range * 3,
    `泳ぎ ${capsDefault.swim.toFixed(3)} → ${capsFullScore.swim.toFixed(3)} / 振れ幅 ${capsDefault.range.toFixed(3)} → ${capsFullScore.range.toFixed(3)}`,
  );
  await setRange(page, '#row-band', String(DEFAULT_REFRAME.rowBand.from));

  // --- コマの速さ（シーン検出との違いを、画面から確かめる） ---
  //
  // シーン検出は既定のつまみが **15fps という単位を隠し持っていた**ので、速いまま渡すと壊れた。
  // リフレームのつまみは全部「秒」で書いてあるので、**間引いても数字は動かないはず**——
  // 実際、合成コマなら 30fps 素材を 15fps へ間引いても入れた率は 99.2% で 1 桁も動かない。
  // **動くのは圧縮を通したときだけ**なので、ここは画面でしか測れない。
  const fast = await feed(page, 'motion', { fps: 30 });
  ok(
    '30fps の素材でも、既定なら 15fps へ間引いて読む',
    Math.abs(fast.state.sourceFps - 30) < 3 && Math.abs(fast.state.fps - 15) < 0.5,
    `素材 ${fast.state.sourceFps?.toFixed(1)}fps → 解析 ${fast.state.fps?.toFixed(1)}fps（${fast.state.frames} コマ）`,
  );
  const decimated = scoreFollow(fixtureOf('motion'), fast.state.times, fast.state.centers, fast.state.cropWidth);
  const decimatedJitter = jitter(fast.state.raws);

  // ならしの窓を倍にすると、中央値に入る標本の数が 30fps 読みと同じになる。
  // **ここで戻るなら、効いていたのは「コマの速さ」ではなく「標本の数」。**
  await setRange(page, '#smooth', '2');
  const wider = await page.evaluate(() => window.__labReframe.state());
  const widerScore = scoreFollow(fixtureOf('motion'), wider.times, wider.centers, wider.cropWidth);
  await setRange(page, '#smooth', String(DEFAULT_REFRAME.smooth));

  await setRange(page, '#fps', '30', 100);
  await page.locator('#fps').dispatchEvent('change');
  await page.waitForFunction(() => !window.__labReframe.state().loading && (window.__labReframe.state().fps ?? 0) > 25, null, {
    timeout: 120000,
  });
  await page.waitForTimeout(300);
  const dense = await page.evaluate(() => window.__labReframe.state());
  const denseScore = scoreFollow(fixtureOf('motion'), dense.times, dense.centers, dense.cropWidth);

  // **合成コマでは間引いても動かない。圧縮を通すと動く。** つまみが秒で書いてあることは
  // 「fps に依らない」を意味しない——ならしは**コマの数**で効くので、
  // 間引くと中央値に入る標本が半分になり、圧縮の粒を落としきれなくなる。
  ok(
    '圧縮を通すと、間引いた側だけ入れた率が落ちる（合成コマでは 3 通りとも 99.2%）',
    dense.fps > 25 && denseScore.inside > decimated.inside + 2,
    `15fps へ間引いて ${decimated.inside.toFixed(1)}%（${fast.state.frames} コマ・生の位置の荒れ ${decimatedJitter.toFixed(4)}）` +
      ` → 30fps のまま ${denseScore.inside.toFixed(1)}%（${dense.frames} コマ・${jitter(dense.raws).toFixed(4)}）`,
  );
  // 落ちているのが「速さ」ではなく「標本の数」であることの裏取り。
  ok(
    'ならしの窓を倍にすると、間引いたままでも戻る（効いているのは標本の数）',
    widerScore.inside >= decimated.inside + 2,
    `間引き＋ならし 1.0 秒 ${decimated.inside.toFixed(1)}% → 間引き＋ならし 2.0 秒 ${widerScore.inside.toFixed(1)}%` +
      `（30fps のまま ${denseScore.inside.toFixed(1)}%）`,
  );

  await setRange(page, '#fps', '15', 100);
  await page.locator('#fps').dispatchEvent('change');
  await page.waitForFunction(() => !window.__labReframe.state().loading && (window.__labReframe.state().fps ?? 99) < 20, null, {
    timeout: 120000,
  });
  await page.waitForTimeout(300);

  // --- 出来上がりのプレビュー（枠の列 → 実際に見える絵） ---
  //
  // **ここが「絵は読み直していない」の中身。** 切り出した動画を作っていないので、
  // 確かめるのは「元の動画をどれだけ横へずらしているか」が枠と合っているか。
  await feed(page, 'subject-static');
  const shape = await page.evaluate(() => {
    const crop = document.getElementById('rf-crop');
    const out = document.getElementById('rf-video-out');
    return { cropW: crop.clientWidth, cropH: crop.clientHeight, videoW: out.clientWidth, videoH: out.clientHeight };
  });
  // 16:9 を 31.6% で切ると 9:16。切り出した先の形が縦型になっていなければ、
  // 出来上がりは「縦型」ではない（数字は正しくても使えない）。
  ok(
    '出来上がりの覗き窓が 9:16 になっている',
    Math.abs(shape.cropW / shape.cropH - 9 / 16) < 0.02 && Math.abs(shape.videoW / shape.videoH - 16 / 9) < 0.05,
    `窓 ${shape.cropW}×${shape.cropH}（${(shape.cropW / shape.cropH).toFixed(3)}）・ 中の動画 ${shape.videoW}×${shape.videoH}`,
  );

  // 秒を指して、そこの枠とずらし量が合っているか。**この素材は右寄りに居続ける**ので、
  // 真ん中を切っていたらここで落ちる。
  const at = await page.evaluate(async () => {
    const video = document.getElementById('rf-video');
    const out = document.getElementById('rf-video-out');
    video.currentTime = 6;
    out.currentTime = 6;
    await new Promise((r) => setTimeout(r, 500));
    const m = /translateX\((-?[\d.]+)px\)/.exec(out.style.transform || '');
    return {
      center: window.__labReframe.centerAt(video.currentTime),
      shift: m ? Number(m[1]) : NaN,
      videoW: out.clientWidth,
      windowLeft: document.getElementById('rf-window').style.left,
      cropWidth: window.__labReframe.state().cropWidth,
    };
  });
  const wantShift = -(at.center - at.cropWidth / 2) * at.videoW;
  ok(
    'ずらし量が、その秒の枠とぴったり合う',
    Math.abs(at.shift - wantShift) < 1,
    `枠の中心 ${at.center.toFixed(3)} → ずらし ${at.shift.toFixed(1)}px（枠から出すと ${wantShift.toFixed(1)}px）`,
  );
  ok(
    '右寄りに居続ける被写体を、真ん中では切っていない',
    at.center > 0.6,
    `枠の中心 ${at.center.toFixed(3)} ・ 元の画に重ねた窓の左端 ${at.windowLeft}`,
  );

  // 窓の幅を変えたら、覗き窓の形も一緒に変わる（画面だけ取り残されないか）。
  // **目盛りに乗る値で試す。** 1/256 きざみなので 0.6 は表せず、0.6015625 へ丸められる
  // （ここを 0.6 と書くと、丸めのぶんだけで落ちる検査になる）。
  const WIDE = 154 / 256;
  await setRange(page, '#crop-width', String(WIDE));
  const wide = await page.evaluate(() => ({
    cropW: document.getElementById('rf-crop').clientWidth,
    cropH: document.getElementById('rf-crop').clientHeight,
    cropWidth: window.__labReframe.state().cropWidth,
  }));
  ok(
    '窓の幅を変えると、出来上がりの形も一緒に変わる',
    Math.abs(wide.cropW / wide.cropH - (16 / 9) * WIDE) < 0.05 && Math.abs(wide.cropWidth - WIDE) < 1e-12,
    `31.6% で ${(shape.cropW / shape.cropH).toFixed(3)} → ${(WIDE * 100).toFixed(1)}% で ${(wide.cropW / wide.cropH).toFixed(3)}`,
  );
  await setRange(page, '#crop-width', String(DEFAULT_REFRAME.cropWidth));

  // --- 人が見る絵が、本当に枠の所か ---
  //
  // **数字が合っていても、ずらす向きを間違えれば人が見る絵は別の所になる。**
  // ここだけは画面を撮って中身を読む。撮った縦型の明るさの形を、
  // 元のコマの列（32 列）の上で滑らせて、いちばん合う位置を探す。
  // その位置が枠の左端と合っていれば、見せている絵は枠の所だと言える。
  await page.evaluate(async () => {
    const video = document.getElementById('rf-video');
    const out = document.getElementById('rf-video-out');
    video.currentTime = 6;
    out.currentTime = 6;
    await new Promise((r) => setTimeout(r, 600));
  });
  const shown = await matchCrop(page);
  ok(
    '出来上がりに映っているのが、枠の所の絵',
    Math.abs(shown.best - shown.want) < 0.06,
    `いちばん合う左端 ${shown.best.toFixed(3)}（枠の左端 ${shown.want.toFixed(3)} ・ 相関 ${shown.r.toFixed(3)}）`,
  );

  // **わざと壊して、同じ検査が落ちることまで確かめる**（2026-09-23・2 回目の教訓）。
  // ずらしを 0 に戻すと、映るのは画面の左端になる。
  await page.evaluate(() => {
    document.getElementById('rf-video-out').style.transform = 'translateX(0px)';
  });
  const broken = await matchCrop(page);
  ok(
    'ずらしを消すと、同じ検査が落ちる（検査が効いている）',
    Math.abs(broken.best - broken.want) > 0.06 && broken.best < 0.1,
    `いちばん合う左端 ${broken.best.toFixed(3)}（枠の左端 ${broken.want.toFixed(3)}）`,
  );

  // --- わざと壊して FAIL することを確かめる（2026-09-23・2 回目の教訓） ---
  //
  // 「検査を書いたら、わざと壊して FAIL することまで確かめること」。
  // ここでは枠を真ん中に固定した列を、上と同じ採点へ通す。
  const fixedCenters = motion.state.centers.map(() => 0.5);
  const fixedScore = scoreFollow(fixtureOf('motion'), motion.state.times, fixedCenters, motion.state.cropWidth);
  const movedScore = scoreFollow(fixtureOf('motion'), motion.state.times, motion.state.centers, motion.state.cropWidth);
  ok(
    '枠を真ん中に固定すると、同じ採点が落ちる（検査が効いている）',
    Math.abs(fixedScore.inside - movedScore.inside) > 3 && fixedScore.inside < movedScore.inside,
    `追う ${movedScore.inside.toFixed(1)}% 対 ずっと真ん中 ${fixedScore.inside.toFixed(1)}%（泳ぎ ${totalSwim(motion.state.times, motion.state.centers).toFixed(3)} 対 0.000）`,
  );

  // --- 画面の記録 ---
  await feed(page, 'subject-pause');
  const shot = path.join(here, '../fixtures/out/uitest-reframe.png');
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

/**
 * 画面に映っている縦型が、元のコマのどこを切ったものかを当てる。
 *
 * 撮った絵から明るさの形（10 本）を作り、元のコマの列（32 本）の上を
 * 1/256 きざみで滑らせて、いちばん相関の高い左端を返す。
 * **中身を見ずに「ずらし量が合っているか」だけを見ると、向きを間違えても通る。**
 */
async function matchCrop(page) {
  const png = await page.locator('#rf-crop').screenshot();
  return page.evaluate(async ([b64, samples]) => {
    const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    // 元の列（`columnLuma`）は上下 15% を落としてあるので、こちらも同じ所だけを見る。
    const y0 = Math.floor(canvas.height * 0.15);
    const y1 = Math.ceil(canvas.height * 0.85);
    const shot = [];
    for (let j = 0; j < samples; j += 1) {
      const x0 = Math.floor((j / samples) * canvas.width);
      const x1 = Math.max(x0 + 1, Math.floor(((j + 1) / samples) * canvas.width));
      let sum = 0;
      let n = 0;
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          const p = (y * canvas.width + x) * 4;
          sum += (0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2]) / 255;
          n += 1;
        }
      }
      shot.push(n ? sum / n : 0);
    }

    const video = document.getElementById('rf-video');
    const cols = window.__labReframe.columnLuma(video.currentTime);
    const state = window.__labReframe.state();
    const w = state.cropWidth;
    const corr = (a, b) => {
      const n = a.length;
      const ma = a.reduce((x, y) => x + y, 0) / n;
      const mb = b.reduce((x, y) => x + y, 0) / n;
      let num = 0;
      let da = 0;
      let db = 0;
      for (let i = 0; i < n; i += 1) {
        num += (a[i] - ma) * (b[i] - mb);
        da += (a[i] - ma) ** 2;
        db += (b[i] - mb) ** 2;
      }
      return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
    };
    // 元の列を、その左端から切り出したときの形に直して比べる。
    const at = (u) => {
      const t = u * cols.length - 0.5;
      const i = Math.max(0, Math.min(cols.length - 2, Math.floor(t)));
      const k = Math.max(0, Math.min(1, t - i));
      return cols[i] + (cols[i + 1] - cols[i]) * k;
    };
    let best = 0;
    let bestR = -2;
    for (let x = 0; x <= 1 - w + 1e-9; x += 1 / 256) {
      const profile = [];
      for (let j = 0; j < samples; j += 1) profile.push(at(x + ((j + 0.5) / samples) * w));
      const r = corr(shot, profile);
      if (r > bestR) {
        bestR = r;
        best = x;
      }
    }
    return { best, r: bestR, want: window.__labReframe.centerAt(video.currentTime) - w / 2 };
  }, [png.toString('base64'), CROP_SAMPLES]);
}

/**
 * 生の位置がどれだけ荒れているか（隣り合うコマの差の平均）。
 *
 * **「間引くと落ちる」の中身を数で言うために置いてある。** 見るのは
 * `raw`（ならす前）で、`target` を見ると「ならしが効いた量」を測ることになってしまう。
 */
function jitter(targets) {
  if (targets.length < 2) return 0;
  let sum = 0;
  for (let i = 1; i < targets.length; i += 1) sum += Math.abs(targets[i] - targets[i - 1]);
  return sum / (targets.length - 1);
}

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
