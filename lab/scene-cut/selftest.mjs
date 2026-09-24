/**
 * シーン検出の検算をコマンドラインから走らせる。
 *
 *   npm run lab:test   （auto-cut のぶんと続けて走る）
 *
 * 判断する部分は DOM にも canvas にも依存していないので、ブラウザは要らない。
 * 素材（7MB のコマの列）も作らないので、手を入れるたびに走らせられる。
 */

const { runSelfTest } = await import('./src/selftest.ts');
const { renderSpec } = await import('../fixtures/make-frames.mjs');

const results = runSelfTest();

// --- 素材の側の検算（2026-09-24） ---
//
// `src/selftest.ts` は素材を作らない（7MB のコマの列を毎回作らないため）。
// ただし**帯の透け方だけは、素材を描いてみないと確かめられない**——
// つまみが黙って無視されても、判定の側の検算は 1 件も落ちない。
// 実際にそれを試したら、落ちたのはベンチの数字だけだった（91 行ぶん後ろの記録を参照）。
// 数秒で済むように、**速さを 2fps まで落とした 1 本**だけを描いて確かめる。
{
  const band = { top: 0.2, bottom: 0.2 };
  const draw = (captions, sheer = {}) =>
    renderSpec({ name: 'sheer-check', cuts: [], options: { seed: 7, ...(captions ? { captions: band } : {}) } }, { fps: 2, ...sheer })
      .frames[3].data;
  // **基準は「帯なし」**。帯の中だけで比べると、混ぜる向きを逆にした実装
  // （不透明度 1 で透ける）も同じ数字を出して素通りする。実際に 1 度素通りした。
  const none = draw(false);
  const opaque = draw(true, { captionAlpha: 1 });
  const clear = draw(true, { captionAlpha: 0, captionInkAlpha: 0 });
  // 板だけを消したもの（字は不透明のまま）。倍率を見るのはこちらを基準に——
  // `clear` は字まで消しているので、板の効き具合とは別の量になる。
  const plateOff = draw(true, { captionAlpha: 0 });
  // **半分では混ぜる向きを取り違えても同じ絵になる**（0.5 は対称）。
  // 4 分の 1 で測らないと、逆向きの実装が素通りする。実際に 1 度素通りした。
  const quarter = draw(true, { captionAlpha: 0.25 });
  // **数えるのは「違う画素の数」ではなく「どれだけ違うか」。**
  // 板を 1 でも透かせば帯の画素は全部変わるので、数だけ見ると 0.5 と 0 が同じ 26% になり、
  // 「効いたつもり」で通ってしまう（実際にそれで 1 度通した）。
  const apart = (a, b) => {
    let sum = 0;
    for (let p = 0; p < a.length; p += 4) sum += Math.abs(a[p] - b[p]) + Math.abs(a[p + 1] - b[p + 1]) + Math.abs(a[p + 2] - b[p + 2]);
    return sum / ((a.length / 4) * 3);
  };
  const full = apart(opaque, plateOff);
  const part = apart(quarter, plateOff);
  results.push({
    name: '不透明度 1 は帯を隠し、0 は帯なしと 1 ビットも変わらない',
    ok: apart(clear, none) === 0 && apart(opaque, none) > 1,
    detail: `0 と帯なし ${apart(clear, none).toFixed(3)} / 1 と帯なし ${apart(opaque, none).toFixed(1)}`,
  });
  results.push({
    name: '板の不透明度が、その割合どおりに効く（0.25 は 4 分の 1 の所）',
    ok: full > 1 && Math.abs(part / full - 0.25) < 0.02,
    detail: `板を消した所からの寄り  0.25 で ${part.toFixed(1)} / 1 で ${full.toFixed(1)}（比 ${(part / full).toFixed(3)}）`,
  });
}
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
