/**
 * 表紙を**どの形式で書き出すか**を、素材ごとに測って決める。
 *
 *   npm run lab:thumb:format
 *
 * `export.ts` には 9/23（2 回目）に「表紙は文字や線が乗る前提なので、非可逆では出さない」と
 * 書いた。**それは測って決めたことではない。** ここで測る。
 *
 * ## なぜブラウザを立てるのか
 *
 * JPEG を焼く道具が Node に無い。外部ライブラリを足す話でもなくて、
 * **画面が実際に使うのは `canvas.toBlob` なのだから、それで測るのがいちばん近い。**
 * 素材はその場で WebM に焼いて食わせる（`uitest.mjs` と同じ手）。
 *
 * playwright が無い環境では、その旨を出して成功扱いで終わる（作業を止めないため）。
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { thumbFixture } from '../fixtures/thumbs.mjs';
import { launch, loadPlaywright, serve } from '../browser.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

const playwright = loadPlaywright();
if (!playwright) {
  console.log('playwright が見つからないので形式の測定は飛ばします。');
  process.exit(0);
}

/** 測る素材。**壊れ方が違うものを並べる**（平らな面・文字帯・粒・場面の多さ）。 */
const NAMES = (process.env.LAB_FIXTURES ?? 'whip-still,whip-captions,whip-grain,cuts-plain').split(',');
const QUALITIES = [0.5, 0.7, 0.8, 0.85, 0.9, 0.95, 1];
/**
 * 焼く倍率。既定の 4 倍は 512×288 で、**置き先の容量を語るには小さすぎる**
 * （画素あたりの効率は大きさで変わるので、掛け算では出せない）。
 * `LAB_SCALE=15` で 1920×1080＝書き出しの上限そのものになる。
 */
const SCALE = Number(process.env.LAB_SCALE ?? 4);
/**
 * 帯の板の不透明度（2026-09-24）。既定は素材の書いたまま（不透明）。
 * 9/23（3 回目）の「帯の中のほうが誤差が小さい」は**平らな板**での話だったので、
 * 透かして測り直せるようにここを口にしてある。
 */
const CAPTION_ALPHA = process.env.LAB_CAPTION_ALPHA ? Number(process.env.LAB_CAPTION_ALPHA) : null;

/**
 * 素材に焼き込みの文字帯があるなら、その区間（高さの割合）を返す。
 *
 * 帯の中と外を分けて測るために要る。**全体の平均だけを見ると、
 * 画面の 26% でしかない帯の荒れが残り 74% に薄められて見えなくなる。**
 */
function captionBands(name) {
  const spec = thumbFixture(name);
  const caps = spec.options?.captions;
  if (!caps) return [];
  const bands = [];
  if (caps.top > 0) bands.push({ from: 0, to: caps.top });
  if (caps.bottom > 0) bands.push({ from: 1 - caps.bottom, to: 1 });
  return bands;
}

const pad = (s, n) => String(s).padEnd(n, ' ');
const num = (v, d = 2) => (v === null || v === undefined || Number.isNaN(v) ? '—' : v.toFixed(d)).padStart(7) + '  ';

const server = await serve(here);
const browser = await launch(playwright);
const reports = [];
try {
  const page = await (await browser.newContext({ viewport: { width: 1000, height: 900 } })).newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(server.url, { waitUntil: 'networkidle' });
  await page.addScriptTag({ type: 'module', url: './testkit/encode.ts' });
  await page.addScriptTag({ type: 'module', url: './testkit/formats.ts' });
  await page.waitForFunction(() => typeof window.__labThumbFormats === 'function', null, { timeout: 30000 });

  for (const name of NAMES) {
    const bands = captionBands(name);
    process.stdout.write(`${name} を測っています…\n`);
    const report = await page.evaluate(
      ([n, q, b, s, a]) => window.__labThumbFormats(n, { qualities: q, bands: b, scale: s, captionAlpha: a }),
      [name, QUALITIES, bands, SCALE, CAPTION_ALPHA],
    );
    reports.push(report);
  }
  if (errors.length) console.error(`\n画面の例外: ${errors.slice(0, 3).join(' / ')}`);
} finally {
  await browser.close();
  server.stop();
}

// --- 素材ごとの表（候補は平均する。候補どうしの違いは形式の話ではないので） ---

for (const report of reports) {
  const rows = report.picks.filter((r) => r.length);
  if (!rows.length) {
    console.log(`\n### ${report.fixture}: 候補が取れませんでした`);
    continue;
  }
  const mean = (get) => rows.reduce((sum, row, i) => sum + get(row, i), 0) / rows.length;
  console.log(
    `\n### ${report.fixture}  ${report.width}×${report.height} ・ ${rows.length} 枚` +
      (report.bands.length ? ` ・ 文字帯 ${report.bands.map((b) => `${(b.from * 100).toFixed(0)}〜${(b.to * 100).toFixed(0)}%`).join(' ')}` : ''),
  );
  console.log(
    `${pad('形式', 12)}${pad('KB', 9)}${pad('B/千画素', 9)}${pad('PNG比', 9)}` +
      `${pad('誤差', 9)}${pad('帯の中', 9)}${pad('帯の外', 9)}${pad('最悪の升', 9)}${pad('細かさ比', 9)}${pad('元の細かさ', 11)}${pad('分布', 9)}`,
  );
  const pngBytes = mean((row) => row[0].bytes);
  // 段の数は**測れた行**から取る。`picks[0]` は読み直せなかった候補だと空で、
  // そこを長さの基準にすると 1 段も出ないまま「表を出した」ことになる。
  for (let k = 0; k < rows[0].length; k += 1) {
    const s = rows[0][k];
    console.log(
      pad(s.label, 12) +
        num(mean((row) => row[k].bytes) / 1024, 1) +
        num(mean((row) => row[k].bytesPerKilopixel), 1) +
        num(mean((row) => row[k].bytes) / pngBytes, 3) +
        num(mean((row) => row[k].rmse), 2) +
        (report.bands.length ? num(mean((row) => row[k].rmseInBand), 2) : pad('—', 9)) +
        (report.bands.length ? num(mean((row) => row[k].rmseOutBand), 2) : pad('—', 9)) +
        num(mean((row) => row[k].worstCell), 2) +
        num(mean((row) => row[k].gradRatio), 3) +
        (mean((row) => row[k].gradBefore).toFixed(5)).padStart(9) + '  ' +
        num(mean((row) => row[k].histDistance), 4),
    );
  }
}

// --- 素材をまたいで並べる（同じ品質を全部の素材に当てられるか） ---

console.log('\n### 素材をまたいで（JPEG ÷ PNG の大きさ / 細かさ比 / 誤差）');
console.log(pad('品質', 12) + reports.map((r) => pad(r.fixture, 22)).join(''));
const labels = reports[0]?.picks.find((r) => r.length)?.map((s) => s.label) ?? [];
for (let k = 1; k < labels.length; k += 1) {
  const cells = reports.map((report) => {
    const rows = report.picks.filter((r) => r.length);
    if (!rows.length) return pad('—', 22);
    const mean = (get) => rows.reduce((sum, row) => sum + get(row), 0) / rows.length;
    const ratio = mean((row) => row[k].bytes) / mean((row) => row[0].bytes);
    return pad(`${(ratio * 100).toFixed(1)}% ${mean((row) => row[k].gradRatio).toFixed(3)} ${mean((row) => row[k].rmse).toFixed(2)}`, 22);
  });
  console.log(pad(labels[k], 12) + cells.join(''));
}

console.log(
  '\n読み方: 「細かさ比」が 1 から離れるほど、**表紙を選んだ根拠（細かさ）が書き出しで削られている**。\n' +
    '「最悪の升」は 8×8 の升目でいちばん荒れた所の誤差で、平均に埋もれる局所の崩れを拾う。\n' +
    '「元の細かさ」は比の分母。**ここが小さい素材では、同じ量の粗が大きな比になる**ので、\n' +
    '細かさ比は元の細かさと並べて読むこと（素材は引き伸ばして焼いているので、倍率を上げるほど滑らかになる）。',
);
