/**
 * **字の縁取り（細い線）が、書き出しでどれだけ荒れるか**を実寸で測る（2026-09-24・2 回目）。
 *
 *   npm run lab:thumb:outline
 *
 * 9/23（3 回目）に `export.ts` の「文字や線が乗るから非可逆では出さない」を測って、
 * **逆だった**（帯の中のほうが誤差が小さい）と分かった。9/24（1 回目）に板を透かすと
 * その得は消えて、**噛み合っていたのは字ではなく平らな板だった**と分かった。
 * では「線」のほうはどうなのか——というのがここ。
 *
 * `format-probe` と分けてあるのは、あちらが素材を **128×72 で描いて 15 倍に引き伸ばす**道で、
 * **実寸の 4 画素の線を入力に持てない**から（`testkit/outline.ts` の注）。
 * ここは最初から 1920×1080 で描く。動画に焼かないので、出る数は
 * **上限**（本物の動画より鮮明な線を渡したときの荒れ）として読む。
 *
 * playwright が無い環境では、その旨を出して成功扱いで終わる（作業を止めないため）。
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { launch, loadPlaywright, serve } from '../browser.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

const playwright = loadPlaywright();
if (!playwright) {
  console.log('playwright が見つからないので縁取りの書き出しの測定は飛ばします。');
  process.exit(0);
}

/** 測る素材。帯を持つのはこの 1 本だけなので、縁取りの話もここで測る。 */
const NAME = process.env.LAB_FIXTURES ?? 'whip-captions';
const QUALITIES = [0.7, 0.85, 0.9, 0.95];
/** 縁取りの太さ（画面の高さに対する割合）。1080p の 4 画素が 0.0037。 */
const OUTLINE = Number(process.env.LAB_CAPTION_OUTLINE ?? 0.0037);
/** 描く倍率。15 で 1920×1080＝書き出しの上限そのもの。 */
const SCALE = Number(process.env.LAB_RENDER_SCALE ?? 15);

const pad = (s, n) => String(s).padEnd(n, ' ');
const num = (v, d = 2) => (v === null || v === undefined || Number.isNaN(v) ? '—' : v.toFixed(d)).padStart(8) + '  ';

const server = await serve(here);
const browser = await launch(playwright);
let report = null;
let bare = null;
try {
  const page = await (await browser.newContext({ viewport: { width: 1000, height: 900 } })).newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(server.url, { waitUntil: 'networkidle' });
  await page.addScriptTag({ type: 'module', url: './testkit/outline.ts' });
  await page.waitForFunction(() => typeof window.__labOutlineFormats === 'function', null, { timeout: 30000 });

  process.stdout.write(`${NAME} を実寸（${SCALE} 倍）で描いて測っています…\n`);
  report = await page.evaluate(
    ([n, q, w, s]) => window.__labOutlineFormats(n, { qualities: q, outline: w, renderScale: s }),
    [NAME, QUALITIES, OUTLINE, SCALE],
  );
  // **縁取りが無いときの同じ表**を必ず並べる。片方だけでは
  // 「線が荒れている」のか「帯がもともと荒れている」のかが分からない。
  bare = await page.evaluate(
    ([n, q, s]) => window.__labOutlineFormats(n, { qualities: q, outline: 0, renderScale: s }),
    [NAME, QUALITIES, SCALE],
  );
  if (errors.length) console.error(`\n画面の例外: ${errors.slice(0, 3).join(' / ')}`);
} finally {
  await browser.close();
  server.stop();
}

if (!report) {
  console.error('測れませんでした。');
  process.exit(1);
}

console.log(
  `\n### ${report.fixture}  ${report.width}×${report.height} ・ ${report.time.toFixed(2)}s ・ ` +
    `縁取り ${OUTLINE}（${(OUTLINE * report.height).toFixed(1)} 画素）・ 線の画素 ${report.outlinePixels}` +
    `（画面の ${((report.outlinePixels / (report.width * report.height)) * 100).toFixed(2)}%）`,
);
console.log(
  `\n${pad('形式', 12)}${pad('KB', 10)}${pad('誤差', 10)}${pad('帯の中', 10)}${pad('帯の外', 10)}` +
    `${pad('線の上', 10)}${pad('帯の残り', 10)}${pad('線/残り', 10)}`,
);
for (let k = 0; k < report.samples.length; k += 1) {
  const s = report.samples[k];
  console.log(
    pad(s.label, 12) +
      num(s.bytes / 1024, 1) +
      num(s.rmse) +
      num(s.rmseInBand) +
      num(s.rmseOutBand) +
      num(s.rmseOnOutline) +
      num(s.rmseBandRest) +
      num(s.rmseBandRest > 0 ? s.rmseOnOutline / s.rmseBandRest : 0, 2),
  );
}

console.log(`\n### 同じ素材・縁取りなし（比べる相手）\n`);
console.log(`${pad('形式', 12)}${pad('KB', 10)}${pad('誤差', 10)}${pad('帯の中', 10)}${pad('帯の外', 10)}`);
for (const s of bare.samples) {
  console.log(pad(s.label, 12) + num(s.bytes / 1024, 1) + num(s.rmse) + num(s.rmseInBand) + num(s.rmseOutBand));
}

console.log('\n「線の上」が「帯の残り」より大きければ、細い線は非可逆のいちばん苦手な形という読みが当たり。');
console.log('大きさ（KB）は縁取りありとなしを縦に見比べる。線が増えたぶん PNG も JPEG も太るはず。');
