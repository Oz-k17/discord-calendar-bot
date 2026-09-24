/**
 * 自動リフレームの検算をコマンドラインから走らせる。
 *
 *   npm run lab:test   （ほかの試作のぶんと続けて走る）
 *
 * 判断する部分は DOM にも canvas にも依存していないので、ブラウザは要らない。
 * 素材（7MB のコマの列）も作らないので、手を入れるたびに走らせられる。
 */

const { runSelfTest } = await import('./src/selftest.ts');

const results = runSelfTest();
let failed = 0;
for (const r of results) {
  if (!r.ok) failed += 1;
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  :: ${r.detail}` : ''}`);
}
console.log(`\n${results.length - failed} / ${results.length} 件が通りました。`);
if (failed > 0) {
  console.error(`${failed} 件が失敗しています。`);
  process.exit(1);
}
