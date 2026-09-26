/**
 * 書き出しの仕事量・段ごとの取り分の検算をコマンドラインから走らせる。
 *
 *   npm run lab:test   （ほかの試作のぶんと続けて走る）
 *
 * 並べ方も集計も DOM に触らないので、ブラウザは要らない。
 * 実測のほうは `npm run lab:export`（playwright が無ければ飛ばす）。
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
