/**
 * 合成したコマで、計算そのものが正しいかを確かめる。
 *
 * 素材（`make-frames.mjs`）は使わない。あちらは 1 本を毎回その場で描くので、
 * **手を入れるたびに走らせるもの**の中に置くと重すぎる
 * （動きボケの素材はシャッターのぶん 6 倍かかる）。
 * ここで見るのは「計算が合っているか」だけで、効きは `npm run lab:thumb` が見る。
 */

import {
  CLIP_HIGH,
  CLIP_LOW,
  DETAIL_H,
  DETAIL_W,
  summarizeThumb,
  summarizeThumbs,
  THUMB_METRICS,
  type FrameLike,
  type ThumbStat,
} from './thumb.ts';
import {
  DEFAULT_PICK,
  exposureScore,
  flashScore,
  pickThumbnails,
  sharpnessSeries,
  type PickOptions,
} from './pick.ts';
import {
  DEFAULT_EXPORT_FORMAT,
  DEFAULT_JPEG_QUALITY,
  EXPORT_FORMATS,
  EXPORT_LONG_SIDE,
  JPEG_QUALITY_MAX,
  JPEG_QUALITY_MIN,
  clampQuality,
  exportName,
  exportSize,
} from './export.ts';

export interface TestResult {
  name: string;
  ok: boolean;
  detail: string;
}

const W = 64;
const H = 36;

/** 一様な色のコマ。 */
function solid(level: number, width = W, height = H): FrameLike {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = level;
    data[i * 4 + 1] = level;
    data[i * 4 + 2] = level;
    data[i * 4 + 3] = 255;
  }
  return { width, height, data };
}

/**
 * 市松模様のコマ。`size` が 1 なら 1 画素ごと（いちばん細かい）、大きいほど粗い。
 *
 * ボケを「ぼかす処理」で作らずに**模様の粗さ**で作っているのは、
 * ここで確かめたいのが「細かい絵のほうが大きな値を返すか」だけだから。
 */
function checker(size: number, low = 60, high = 200, width = W, height = H): FrameLike {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const on = (Math.floor(x / size) + Math.floor(y / size)) % 2 === 0;
      const v = on ? high : low;
      const p = (y * width + x) * 4;
      data[p] = v;
      data[p + 1] = v;
      data[p + 2] = v;
      data[p + 3] = 255;
    }
  }
  return { width, height, data };
}

/** 一様乱数の粒を乗せたコマ（種を固定）。 */
function noisy(level: number, amplitude: number, seed = 1, width = W, height = H): FrameLike {
  let a = seed >>> 0;
  const rnd = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    for (let c = 0; c < 3; c += 1) data[i * 4 + c] = level + (rnd() - 0.5) * amplitude;
    data[i * 4 + 3] = 255;
  }
  return { width, height, data };
}

/** 画面の一部だけを市松にしたコマ（焼き込みの文字帯のつもり）。 */
function bandOnly(cover: number, size = 1, width = W, height = H): FrameLike {
  const frame = checker(size, 60, 200, width, height);
  const rows = Math.round(height * (1 - cover));
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const p = (y * width + x) * 4;
      frame.data[p] = 128;
      frame.data[p + 1] = 128;
      frame.data[p + 2] = 128;
    }
  }
  return frame;
}

function statsOf(frames: FrameLike[]): ThumbStat[] {
  return summarizeThumbs(
    frames,
    frames.map((_, i) => i * 0.1),
  );
}

const opts: PickOptions = DEFAULT_PICK;

export function runSelfTest(): TestResult[] {
  const results: TestResult[] = [];
  const check = (name: string, ok: boolean, detail = '') => results.push({ name, ok, detail });
  const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

  // --- コマ 1 枚を測る ---

  const flat = summarizeThumb(solid(128), 0);
  check('一様な面は細かさ 0', flat.grad === 0 && flat.contrast === 0, `grad=${flat.grad}`);
  check('一様な面の明るさは中ほど', near(flat.meanLuma, 128 / 255, 0.01), flat.meanLuma.toFixed(3));
  check('一様な面は飛んでいない', flat.clipped === 0);

  const black = summarizeThumb(solid(0), 0);
  const white = summarizeThumb(solid(255), 0);
  check('真っ黒は全部が黒つぶれ', black.clipped === 1 && black.meanLuma === 0);
  check('真っ白は全部が白飛び', white.clipped === 1 && near(white.meanLuma, 1, 1e-9));
  check(
    '黒つぶれ・白飛びの線は中を含まない',
    summarizeThumb(solid(Math.round(255 * (CLIP_LOW + CLIP_HIGH) * 0.5)), 0).clipped === 0,
  );

  const fine = summarizeThumb(checker(1), 0);
  const coarse = summarizeThumb(checker(8), 0);
  check(
    '細かい模様のほうが細かさが大きい',
    fine.grad > coarse.grad * 3,
    `${fine.grad.toFixed(3)} 対 ${coarse.grad.toFixed(3)}`,
  );
  check(
    '模様の粗さが変わっても明暗の幅は変わらない',
    near(fine.contrast, coarse.contrast, 0.02),
    `${fine.contrast.toFixed(3)} 対 ${coarse.contrast.toFixed(3)}`,
  );
  check(
    '2×2 に均すと、細かい模様だけが落ちる',
    fine.gradDown < fine.grad * 0.5 && coarse.gradDown > coarse.grad * 0.7,
    `細 ${(fine.gradDown / fine.grad).toFixed(2)} 倍 / 粗 ${(coarse.gradDown / coarse.grad).toFixed(2)} 倍`,
  );

  // 粒ノイズの見積り。一様乱数 ±amp/2（0〜255）を 3 色へ別々に乗せたときの
  // 明るさの標準偏差は (amp/255)/√12 × 0.750（Rec.709 の重みの二乗和）。
  const amp = 40;
  const lumaScale = Math.sqrt(0.2126 ** 2 + 0.7152 ** 2 + 0.0722 ** 2);
  const expected = ((amp / 255) / Math.sqrt(12)) * lumaScale;
  const grainy = summarizeThumb(noisy(128, amp), 0);
  check(
    '粒の大きさを 2 割の中で当てる',
    near(grainy.noise, expected, expected * 0.2),
    `見積り ${grainy.noise.toFixed(4)} / 本当 ${expected.toFixed(4)}`,
  );
  check(
    '粒だけのコマは、粒を引くと細かさが残らない',
    grainy.gradNet < grainy.grad * 0.2,
    `${grainy.gradNet.toFixed(4)} / ${grainy.grad.toFixed(4)}`,
  );
  check('一様な面には粒が無い', summarizeThumb(solid(128), 0).noise === 0);

  const empty = summarizeThumb({ width: 0, height: 0, data: new Uint8ClampedArray(0) }, 3);
  check('大きさ 0 のコマでも落ちない', empty.time === 3 && empty.grad === 0 && empty.cells.length === DETAIL_W * DETAIL_H);

  const band = summarizeThumb(bandOnly(0.25), 0);
  check(
    '画面の一部だけが細かいとき、升目もその一部だけ立つ',
    band.detail > 0.1 && band.detail < 0.45,
    `升目の ${(band.detail * 100).toFixed(0)}%`,
  );
  check('升目の数は格子のぶんだけ', band.cells.length === DETAIL_W * DETAIL_H);
  check('測れる量は一覧から全部引ける', Object.keys(THUMB_METRICS).every((k) => Number.isFinite(THUMB_METRICS[k](band))));

  // --- 写りの良さ ---

  check('真っ黒は 0 点', exposureScore(black, opts) === 0, String(exposureScore(black, opts)));
  check('真っ白も 0 点', exposureScore(white, opts) === 0);
  check('ふつうの明るさは満点', near(exposureScore(flat, opts), 1, 1e-9));
  check(
    '暗いほうから明るいほうへ、点が単調に上がる',
    (() => {
      let last = -1;
      for (let v = 0; v <= 40; v += 4) {
        const e = exposureScore(summarizeThumb(solid(v), 0), opts);
        if (e < last - 1e-9) return false;
        last = e;
      }
      return true;
    })(),
  );

  // --- 周りと比べた明るさ（フラッシュ） ---

  const flashSeries = statsOf([solid(100), solid(100), solid(240), solid(100), solid(100)]);
  check(
    '周りが暗いのに 1 枚だけ明るいコマは落とされる',
    flashScore(flashSeries, 2, opts) === 0 && flashScore(flashSeries, 0, opts) === 1,
    `光 ${flashScore(flashSeries, 2, opts).toFixed(2)} / ふつう ${flashScore(flashSeries, 0, opts).toFixed(2)}`,
  );
  const brightSeries = statsOf([solid(240), solid(240), solid(240), solid(240), solid(240)]);
  check(
    'ぜんぶ明るい素材は落とさない（明るいことは失敗ではない）',
    flashScore(brightSeries, 2, opts) === 1,
  );

  // --- 細かさの列 ---

  const mixed = statsOf([checker(1), checker(8), checker(1)]);
  const series = sharpnessSeries(mixed, opts);
  check('細かさの列は、細かいコマのほうが大きい', series[0] > series[1] && series[2] > series[1]);
  check(
    '升目ごとに比べる形でも順は同じ',
    (() => {
      const r = sharpnessSeries(mixed, { ...opts, sharpness: 'cellRatio' });
      return r[0] > r[1] && r[2] > r[1];
    })(),
  );
  check(
    '動いた升目だけで測る形でも順は同じ',
    (() => {
      const r = sharpnessSeries(mixed, { ...opts, sharpness: 'cellMoving' });
      return r[0] > r[1] && r[2] > r[1];
    })(),
  );

  // --- 選ぶ ---

  const clip = statsOf([checker(8), checker(8), checker(1), checker(8), checker(8)]);
  const one = pickThumbnails(clip, null, { count: 1 });
  check('いちばん細かいコマを選ぶ', one.length === 1 && one[0].index === 2, `${one[0]?.index}`);
  check('選んだ 1 枚は、ふつうより上だと分かる', one[0].relative > 1, one[0]?.relative.toFixed(2));

  const many = pickThumbnails(clip, null, { count: 3, minGap: 0 });
  check('頼んだ枚数だけ返す', many.length === 3, `${many.length} 枚`);
  check(
    '返ってくる並びは時間順',
    many.every((p, i) => i === 0 || p.time >= many[i - 1].time),
    many.map((p) => p.time.toFixed(1)).join(' '),
  );
  check(
    '同じコマを 2 回選ばない',
    new Set(many.map((p) => p.index)).size === many.length,
  );

  const gapped = pickThumbnails(statsOf(Array.from({ length: 10 }, () => checker(1))), null, {
    count: 3,
    minGap: 0.25,
  });
  check(
    '時間で離す（同じ点が並んでいても固まらない）',
    gapped.every((p, i) => i === 0 || p.time - gapped[i - 1].time >= 0.25 - 1e-9),
    gapped.map((p) => p.time.toFixed(2)).join(' '),
  );

  check('0 枚と言われたら 0 枚', pickThumbnails(clip, null, { count: 0 }).length === 0);
  check('コマが無ければ何も返さない', pickThumbnails([], null, { count: 3 }).length === 0);
  check(
    'コマより多く頼まれても、あるだけ返す',
    pickThumbnails(statsOf([checker(1), checker(2)]), null, { count: 5, minGap: 0 }).length === 2,
  );
  check(
    '真っ黒な尺でも返す（0 で割らない）',
    (() => {
      const dark = pickThumbnails(statsOf([solid(0), solid(0), solid(0)]), null, { count: 2, minGap: 0 });
      return dark.length === 2 && dark.every((p) => Number.isFinite(p.relative));
    })(),
  );
  check(
    '埋めた 1 枚には理由が付く',
    (() => {
      const same = pickThumbnails(statsOf([checker(1), checker(1), checker(1)]), null, { count: 3, minGap: 1 });
      return same.length === 3 && same.filter((p) => p.relaxed === 'gap').length === 2;
    })(),
  );
  check(
    '埋めないと言われたら、条件を満たすものだけ返す',
    pickThumbnails(statsOf([checker(1), checker(1), checker(1)]), null, { count: 3, minGap: 1, fill: false })
      .length === 1,
  );

  // 出来の下限。**似ていないことを理由に、出来の悪いコマを拾わない**（2026-09-23 に踏んだ穴）。
  check(
    '似ていなくても、出来が下限を割るコマは選ばない',
    (() => {
      const stats = statsOf([checker(1), checker(1), solid(250), checker(1)]);
      const picks = pickThumbnails(stats, null, { count: 2, minGap: 0, fill: false });
      return picks.every((p) => p.index !== 2);
    })(),
  );

  check(
    '既定は grad・ふつうを基準・0.7（測って決めた。pick.ts の注）',
    DEFAULT_PICK.sharpness === 'grad' && DEFAULT_PICK.floorBase === 'median' && DEFAULT_PICK.qualityFloor === 0.7,
    `${DEFAULT_PICK.sharpness}/${DEFAULT_PICK.floorBase}/${DEFAULT_PICK.qualityFloor}`,
  );
  check('升目は 8×8', DETAIL_W === 8 && DETAIL_H === 8);

  // --- 書き出し（2026-09-23・3 回目に形式を足した） ---
  //
  // `frameToImage` そのものは canvas が要るので、ここでは確かめられない
  // （画面の側は `uitest.mjs` が本物の JPEG として読めるかまで見る）。
  // ここで押さえるのは**名前と数の約束**——形式を足したときに黙って崩れるのはそちら。

  check(
    '名前の拡張子が形式から来る（JPEG に .png を付けて落とさない）',
    exportName('cuts.webm', 3.5, 'png') === 'cuts_3p50s.png' &&
      exportName('cuts.webm', 3.5, 'jpeg') === 'cuts_3p50s.jpg',
    `${exportName('cuts.webm', 3.5, 'png')} / ${exportName('cuts.webm', 3.5, 'jpeg')}`,
  );
  check(
    '形式を言わなければ既定（PNG）で名前を付ける',
    exportName('cuts.webm', 3.5) === exportName('cuts.webm', 3.5, DEFAULT_EXPORT_FORMAT),
    exportName('cuts.webm', 3.5),
  );
  check(
    '秒は名前に残る（3 枚落として混ざらないため）',
    exportName('a.webm', 0) === 'a_0p00s.png' && exportName('a.webm', 12.345, 'jpeg') === 'a_12p35s.jpg',
    `${exportName('a.webm', 0)} / ${exportName('a.webm', 12.345, 'jpeg')}`,
  );
  check(
    '名前の無い素材でも名前が作れる',
    exportName('', 1, 'jpeg') === 'thumb_1p00s.jpg',
    exportName('', 1, 'jpeg'),
  );

  // **1.0 を通さない。** 0.95 の 3〜4 倍の大きさになるのに誤差は 0.1/255 しか縮まず、
  // 細かさへの粗はそこでいちばん大きい（`export.ts` の注・`lab:thumb:format` で測った）。
  check(
    '品質は範囲の外を黙って通さない（1.0 を選ばせない）',
    clampQuality(1) === JPEG_QUALITY_MAX &&
      clampQuality(0) === JPEG_QUALITY_MIN &&
      clampQuality(0.9) === 0.9 &&
      clampQuality(Number.NaN) === DEFAULT_JPEG_QUALITY,
    `1→${clampQuality(1)} / 0→${clampQuality(0)} / NaN→${clampQuality(Number.NaN)}`,
  );
  check(
    '既定は PNG・JPEG は 0.90（測って決めた。export.ts の注）',
    DEFAULT_EXPORT_FORMAT === 'png' && DEFAULT_JPEG_QUALITY === 0.9 && JPEG_QUALITY_MAX === 0.95,
    `${DEFAULT_EXPORT_FORMAT} / ${DEFAULT_JPEG_QUALITY} / 上限 ${JPEG_QUALITY_MAX}`,
  );
  check(
    '形式の札に矛盾が無い（非可逆なのは JPEG だけ・拡張子は重ならない）',
    (() => {
      const specs = Object.values(EXPORT_FORMATS);
      const exts = new Set(specs.map((f) => f.ext));
      return (
        exts.size === specs.length &&
        specs.filter((f) => f.lossy).length === 1 &&
        EXPORT_FORMATS.jpeg.lossy &&
        !EXPORT_FORMATS.png.lossy
      );
    })(),
    Object.entries(EXPORT_FORMATS).map(([k, v]) => `${k}→.${v.ext}${v.lossy ? '(非可逆)' : ''}`).join(' '),
  );

  // 書き出す大きさ。**素材より大きくはしない**（無い細かさは作れない）。
  check(
    '長辺の上限まで縮める・素材が小さければ拡大しない',
    (() => {
      const big = exportSize(3840, 2160, EXPORT_LONG_SIDE);
      const small = exportSize(640, 360, EXPORT_LONG_SIDE);
      const tall = exportSize(1080, 1920, EXPORT_LONG_SIDE);
      return (
        big.width === 1920 &&
        big.height === 1080 &&
        small.width === 640 &&
        small.height === 360 &&
        tall.width === 1080 &&
        tall.height === 1920
      );
    })(),
    `${JSON.stringify(exportSize(3840, 2160, EXPORT_LONG_SIDE))} / ${JSON.stringify(exportSize(640, 360, EXPORT_LONG_SIDE))}`,
  );
  check(
    '大きさが 0 でも 0 を返さない（0 の canvas は作れない）',
    (() => {
      const zero = exportSize(0, 0, EXPORT_LONG_SIDE);
      return zero.width >= 1 && zero.height >= 1;
    })(),
  );

  return results;
}
