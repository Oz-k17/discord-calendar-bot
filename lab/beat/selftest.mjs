/**
 * 拍の検出の検算をコマンドラインから走らせる。
 *
 *   npm run lab:test   （auto-cut / scene-cut のぶんと続けて走る）
 *
 * 判断する部分は DOM にも WebAudio にも依存していないので、ブラウザは要らない。
 * 素材（16 秒ぶんの波形）も作らないので、手を入れるたびに走らせられる。
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
