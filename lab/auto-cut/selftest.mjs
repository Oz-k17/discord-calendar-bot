/**
 * セルフテストをコマンドラインから走らせる。
 *
 *   npm run lab:test
 *
 * 判断する部分は DOM にも WebAudio にも依存していないので、
 * ブラウザもサーバも要らない。Node が .ts をそのまま読める（型を落として実行する）ので、
 * ビルドも挟まない。壊れていれば終了コード 1 で落ちる。
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
