/**
 * 合成したコマで、計算そのものが正しいかを確かめる。
 *
 * 素材（`make-frames.mjs`）は使わない。あちらは 1 本 7MB を毎回その場で作るので、
 * **手を入れるたびに走らせるもの**の中に置くと重すぎる。
 * ここで見るのは「計算が合っているか」だけで、効きは `npm run lab:reframe` が見る。
 *
 * 検算を書くときは、**わざと壊して FAIL することまで確かめる**
 * （2026-09-23・2 回目に、止まった素材では素通りする検査を書いた）。
 */

import {
  COLUMNS,
  FULL_BAND,
  type FrameLike,
  type Weights,
  columnCenter,
  contrast,
  diffLuma,
  readCentroid,
  readPeak,
  spatialOdds,
  summarizeColumns,
} from './columns.ts';
import { DEFAULT_REFRAME, planReframe, rawTargets, summarizeForReframe, toCropRects } from './reframe.ts';

export interface TestResult {
  name: string;
  ok: boolean;
  detail?: string;
}

/**
 * 塗り分けたコマを作る。`paint(u, v)` が 0〜255 の RGB を返す。
 * 画素の**真ん中**で引くので、`summarizeColumns` の畳み方と辻褄が合う。
 */
function makeFrame(width: number, height: number, paint: (u: number, v: number) => [number, number, number]): FrameLike {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = paint((x + 0.5) / width, (y + 0.5) / height);
      const p = (y * width + x) * 4;
      data[p] = r;
      data[p + 1] = g;
      data[p + 2] = b;
      data[p + 3] = 255;
    }
  }
  return { width, height, data };
}

/** 背景の上に、横位置 `at`・半幅 `rx` の柱を 1 本立てたコマ。 */
function withBar(at: number, rx = 0.08, bg: [number, number, number] = [40, 60, 90]): FrameLike {
  return makeFrame(128, 72, (u) => (Math.abs(u - at) < rx ? [240, 140, 40] : bg));
}

/** コマの列から `ColumnStat[]` を作る（秒は等間隔）。 */
function clipOf(frames: FrameLike[], fps = 15) {
  const times = frames.map((_, i) => i / fps);
  return summarizeForReframe(frames, times);
}

export function runSelfTest(): TestResult[] {
  const out: TestResult[] = [];
  const push = (name: string, ok: boolean, detail?: string) => out.push({ name, ok, detail });

  // --- 列へ畳む ---

  {
    // 左半分だけ白。列の前半は 1・後半は 0 になるはず。
    const f = makeFrame(64, 16, (u) => (u < 0.5 ? [255, 255, 255] : [0, 0, 0]));
    const c = summarizeColumns(f, 0);
    push(
      '列は左右を取り違えない（左半分が白なら前半の列だけ立つ）',
      c.luma[0] > 0.99 && c.luma[COLUMNS - 1] < 0.01,
      `列0 ${c.luma[0].toFixed(3)} / 列${COLUMNS - 1} ${c.luma[COLUMNS - 1].toFixed(3)}`,
    );
  }
  {
    // 上半分だけ白。**帯を絞れば結果が変わる**ことを見る（つまみが黙って無視されないか）。
    const f = makeFrame(64, 16, (_u, v) => (v < 0.5 ? [255, 255, 255] : [0, 0, 0]));
    const all = summarizeColumns(f, 0, FULL_BAND).luma[0];
    const lower = summarizeColumns(f, 0, { from: 0.6, to: 1 }).luma[0];
    const upper = summarizeColumns(f, 0, { from: 0, to: 0.4 }).luma[0];
    push(
      '見る帯のつまみが効く（上半分だけ白いコマを、上から見るか下から見るかで変わる）',
      Math.abs(all - 0.5) < 0.01 && upper > 0.99 && lower < 0.01,
      `全部 ${all.toFixed(3)} / 上 ${upper.toFixed(3)} / 下 ${lower.toFixed(3)}`,
    );
    const flat = summarizeColumns(f, 0, { from: 0.7, to: 0.3 });
    push(
      '帯が潰れていても列が 0 にならない（0 行で割らない）',
      Number.isFinite(flat.luma[0]),
      `潰れた帯の列0 ${flat.luma[0]}`,
    );
  }
  {
    const empty = summarizeColumns({ width: 0, height: 0, data: new Uint8ClampedArray(0) }, 1.5);
    push('大きさ 0 のコマでも落ちない', empty.luma.length === COLUMNS && empty.time === 1.5);
  }

  // --- 被写体を指す ---

  {
    const cols = clipOf([withBar(0.75)]);
    const u = readPeak(spatialOdds(cols, 0));
    push('浮いている柱の位置を指す', Math.abs(u - 0.75) < 0.03, `指した ${u.toFixed(3)}（正解 0.75）`);
  }
  {
    // **重心は 2 つあると間を指す**。probe で測った性質を、合成データで固定しておく。
    const cols = clipOf([makeFrame(128, 72, (u) => (Math.abs(u - 0.2) < 0.06 || Math.abs(u - 0.8) < 0.06 ? [240, 140, 40] : [40, 60, 90]))]);
    const w = spatialOdds(cols, 0);
    const mid = readCentroid(w);
    const peak = readPeak(w);
    push(
      '柱が 2 本あると、重心は間を指し、山はどちらかを指す',
      Math.abs(mid - 0.5) < 0.05 && Math.min(Math.abs(peak - 0.2), Math.abs(peak - 0.8)) < 0.05,
      `重心 ${mid.toFixed(3)} / 山 ${peak.toFixed(3)}`,
    );
  }
  {
    // 一様なコマでは指す手が答えを持たない。ここで真ん中を返すと、
    // 「何も無い」と「真ん中に居る」が同じ顔になる。
    const cols = clipOf([makeFrame(64, 16, () => [70, 70, 70])]);
    const w = spatialOdds(cols, 0);
    push('一様なコマでは位置を答えない（NaN）', Number.isNaN(readPeak(w)), `尖り ${contrast(w).toFixed(4)}`);
  }
  {
    // 引き算の手は**動いた縁を 2 本**返すので、山は中心からずれる（probe の 0.141 の正体）。
    const cols = clipOf([withBar(0.4), withBar(0.5)]);
    const w = diffLuma(cols, 1);
    const mid = readCentroid(w);
    const peak = readPeak(w, 2);
    push(
      '引き算は前と後の縁を 2 つ返す（重心は真ん中・山は端）',
      Math.abs(mid - 0.45) < 0.04 && Math.abs(peak - 0.45) > 0.03,
      `重心 ${mid.toFixed(3)} / 山 ${peak.toFixed(3)}`,
    );
  }
  {
    const w: Weights = new Float64Array(COLUMNS);
    w[10] = 1;
    push('尖りは、山と真ん中の列の差', Math.abs(contrast(w) - 1) < 1e-9, `${contrast(w)}`);
    push('列の真ん中を返す', Math.abs(columnCenter(0) - 0.5 / COLUMNS) < 1e-9);
  }

  // --- 枠を決める ---

  {
    // 動かない柱。**1 コマも動かない**のが正解（頭の置き所で決まり切る）。
    const frames = Array.from({ length: 45 }, () => withBar(0.72));
    const plan = planReframe(clipOf(frames));
    push(
      '止まっている被写体では枠が 1 度も動かない',
      plan.travel < 1e-9 && Math.abs(plan.frames[0].center - 0.72) < 0.03,
      `動いた量 ${plan.travel.toFixed(4)} / 置き所 ${plan.frames[0].center.toFixed(3)}`,
    );
  }
  {
    // 端まで動く柱。枠は追いつき、**窓が画面からはみ出さない**。
    const frames = Array.from({ length: 60 }, (_v, i) => withBar(0.2 + (0.7 * i) / 59));
    const plan = planReframe(clipOf(frames));
    const half = DEFAULT_REFRAME.cropWidth / 2;
    const last = plan.frames[plan.frames.length - 1];
    const inRange = plan.frames.every((f) => f.center >= half - 1e-9 && f.center <= 1 - half + 1e-9);
    push(
      '動く被写体を追い、窓は画面からはみ出さない',
      inRange && Math.abs(last.center - Math.min(0.9, 1 - half)) < 0.06,
      `終わりの中心 ${last.center.toFixed(3)}（上限 ${(1 - half).toFixed(3)}）`,
    );
  }
  {
    // deadband の内側の揺れには反応しない。**これが無いと出来上がりが手ぶれ映像になる。**
    const frames = Array.from({ length: 60 }, (_v, i) => withBar(0.5 + (i % 2 ? 0.02 : -0.02)));
    const plan = planReframe(clipOf(frames));
    push('小さく揺れるだけの被写体には枠が反応しない', plan.travel < 1e-9, `動いた量 ${plan.travel.toFixed(4)}`);
  }
  {
    // 寄せの上限が効いているか。1 コマで飛ばないこと。
    const frames = [...Array.from({ length: 30 }, () => withBar(0.2)), ...Array.from({ length: 60 }, () => withBar(0.8))];
    const cols = clipOf(frames);
    const plan = planReframe(cols, { maxSpeed: 0.2 });
    const jump = Math.max(...plan.frames.slice(1).map((f, i) => Math.abs(f.center - plan.frames[i].center)));
    push(
      '寄せの上限を超えて 1 コマで飛ばない',
      jump <= 0.2 / 15 + 1e-9,
      `いちばん大きい 1 コマの動き ${jump.toFixed(4)}（上限 ${(0.2 / 15).toFixed(4)}）`,
    );
    // 上限を上げれば速く寄る。**つまみが黙って無視されていないか**まで見る。
    const fast = planReframe(cols, { maxSpeed: 1.0 });
    const reach = (p: typeof plan) => p.frames.findIndex((f) => Math.abs(f.center - 0.8) < 0.02);
    push(
      '寄せの上限を上げると、速く寄り切る',
      reach(fast) > 0 && reach(fast) < reach(plan),
      `0.2 で ${reach(plan)} コマ / 1.0 で ${reach(fast)} コマ`,
    );
  }
  {
    // 指せないコマ（真っ黒）が挟まっても、**生の位置が**真ん中へ帰らない。
    //
    // ここを `planReframe` の中心で見ると素通りする（実際に 1 度素通りした）。
    // ならしが中央値なので、15 コマの窓に 2 コマの外れ値が入っても消えてしまう。
    // **見るべき層を間違えた検査は、壊しても落ちない。**
    const black = makeFrame(128, 72, () => [0, 0, 0]);
    const frames = [...Array.from({ length: 30 }, () => withBar(0.8)), black, black, ...Array.from({ length: 10 }, () => withBar(0.8))];
    const raw = rawTargets(clipOf(frames));
    push(
      '指せないコマでは前の答えを引き継ぐ（真ん中へ帰らない）',
      Math.abs(raw[30] - 0.8) < 0.03 && Math.abs(raw[31] - 0.8) < 0.03,
      `黒いコマでの生の位置 ${raw[30].toFixed(3)} / ${raw[31].toFixed(3)}`,
    );
    const head = rawTargets(clipOf([black, black]));
    push('頭から指せなくても落ちない', head.every((v) => Number.isFinite(v)), `${head[0]}`);
  }
  {
    // **上下の帯を外しているか**を、枠の側から見る。
    //
    // 縦に一様な素材（`withBar`）では、帯を外しても外さなくても同じ答えになるので、
    // つまみを黙って無視する作りが素通りする（実際に 1 度素通りした）。
    // 画面のまん中に止まった被写体を置き、**上の帯の中だけで柱が動く**素材で見る。
    const captioned = (capAt: number) =>
      makeFrame(128, 72, (u, v) => {
        if (v < 0.12) return Math.abs(u - capAt) < 0.06 ? [255, 255, 255] : [10, 10, 10];
        return Math.abs(u - 0.5) < 0.08 ? [240, 140, 40] : [40, 60, 90];
      });
    const frames = [captioned(0.9)];
    const times = [0];
    // 字幕の居る列（0.9 ＝ 28 列目）で、帯を外したときと全部見たときの重みを比べる。
    // **枠の動きで見ると素通りする**——真ん中の被写体が強いので、
    // 引っぱられていても山は動かない。見るのは重みそのもの。
    const at = Math.floor(0.9 * COLUMNS);
    const banded = spatialOdds(summarizeForReframe(frames, times), 0)[at];
    const whole = spatialOdds(summarizeForReframe(frames, times, { rowBand: FULL_BAND }), 0)[at];
    push(
      '上下の帯を外すと、字幕の居る列が浮かなくなる',
      whole > banded * 3,
      `帯を外して ${banded.toFixed(4)} / 全部見て ${whole.toFixed(4)}`,
    );
  }
  {
    push('コマが 1 枚も無くても落ちない', planReframe([]).frames.length === 0);
    const one = planReframe(clipOf([withBar(0.8)]));
    push('コマが 1 枚だけでも落ちない', one.frames.length === 1 && Number.isFinite(one.frames[0].center));
  }
  {
    // 窓が画面より広ければ動かしようが無い。黙って端へ寄せず、真ん中で止める。
    const plan = planReframe(clipOf([withBar(0.8), withBar(0.2)]), { cropWidth: 1.4 });
    push(
      '窓が画面より広いときは真ん中で止まる',
      plan.travel === 0 && plan.frames.every((f) => f.center === 0.5),
      `中心 ${plan.frames.map((f) => f.center).join(' / ')}`,
    );
  }
  {
    const plan = planReframe(clipOf([withBar(0.72)]));
    const [rect] = toCropRects(plan);
    push(
      'クロップの矩形は、中心と幅から素直に出る',
      Math.abs(rect.x + rect.width / 2 - plan.frames[0].center) < 1e-9 && Math.abs(rect.width - DEFAULT_REFRAME.cropWidth) < 1e-9,
      `x ${rect.x.toFixed(3)} 幅 ${rect.width.toFixed(3)}`,
    );
  }

  return out;
}
