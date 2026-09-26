/**
 * 測った時間をまとめる。
 *
 * 入口は「1 コマにつき、段ごとに何ミリ秒かかったか」の列だけなので、
 * ブラウザで測っても合成の数字を入れても同じように扱える（検算はそれでやっている）。
 *
 * ## 合計ではなく「取り分」で見る理由
 *
 * 書き出しの速さは端末で桁が違う。合計ミリ秒を記録に残しても、
 * 次の回の自分が別の端末で走らせたら比べられない。**段ごとの取り分**なら、
 * 遅い端末でも速い端末でもだいたい同じ形で出るので、記録として持ち越せる。
 *
 * ## 上限を先に出す
 *
 * `projectSpeedup` は「その段を n 倍速くしたら全体は何倍になるか」を返す。
 * 取り分 20% の段を無限に速くしても全体は 1.25 倍にしかならない、というのを
 * **手を入れる前に**出しておくための道具。ラボの `lab:probe` と同じ役回りで、
 * 実装してから「思ったより効かなかった」を繰り返さないために置いてある。
 */

export const STAGES = ['decode', 'draw', 'encode'] as const;
export type Stage = (typeof STAGES)[number];

/** 1 コマぶんの計測。単位はミリ秒。 */
export type FrameSample = Record<Stage, number>;

export interface StageSummary {
  sum: number;
  mean: number;
  median: number;
  /** 全体（実測の壁時計）に占める取り分。 */
  share: number;
}

export interface RunSummary {
  frames: number;
  /** 実測の壁時計（ミリ秒）。段の合計とは一致しない（その差が `other`）。 */
  wallMs: number;
  /** 1 秒あたり何コマ書き出せたか。 */
  fps: number;
  stages: Record<Stage, StageSummary>;
  /** 段のどれでもない時間（ループの雑用・GC・待ち合わせ）。 */
  other: StageSummary;
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function summarizeRun(samples: FrameSample[], wallMs: number): RunSummary {
  const frames = samples.length;
  // 壁時計が段の合計より小さいことは原理上あり得ないが、測り方を間違えると起きる。
  // そこで黙って負の取り分を出さず、**0 で止めて気づけるように**してある。
  const wall = Math.max(wallMs, 0);
  const stages = {} as Record<Stage, StageSummary>;
  let accounted = 0;
  for (const stage of STAGES) {
    const values = samples.map((s) => s[stage] ?? 0);
    const sum = values.reduce((a, b) => a + b, 0);
    accounted += sum;
    stages[stage] = {
      sum,
      mean: frames ? sum / frames : 0,
      median: median(values),
      share: wall > 0 ? sum / wall : 0,
    };
  }
  const otherSum = Math.max(0, wall - accounted);
  return {
    frames,
    wallMs: wall,
    fps: wall > 0 ? (frames * 1000) / wall : 0,
    stages,
    other: {
      sum: otherSum,
      mean: frames ? otherSum / frames : 0,
      median: 0, // コマごとには分けられない（引き算でしか出ないので）。
      share: wall > 0 ? otherSum / wall : 0,
    },
  };
}

/**
 * その段だけを `factor` 倍速くしたときの、全体の速さの倍率。
 *
 * `factor = Infinity`（その段がタダになる）を渡せば、**その段に手を入れて得られる上限**が出る。
 * 直列に回っている前提なので、重ねられる作りに変えた場合はこれより大きくなり得る。
 * そこは `projectOverlap` のほうで見る。
 */
export function projectSpeedup(summary: RunSummary, stage: Stage | 'other', factor: number): number {
  if (!(factor > 0)) throw new Error(`factor は正の数です（${factor}）`);
  const share = stage === 'other' ? summary.other.share : summary.stages[stage].share;
  const after = 1 - share + share / factor;
  return after > 0 ? 1 / after : Infinity;
}

/**
 * 2 つの段を重ねて回せたときの、全体の速さの倍率。
 *
 * いまの書き出しは 1 コマずつ「デコードを待つ → 描く → エンコードを待つ」なので、
 * 3 つの段が足し算で並ぶ。重ねられれば足し算が最大値になる、という見積もり。
 * **あくまで上限**で、実際にはコマ 1 枚ぶんの受け渡しが要るのでここまでは詰まらない。
 */
export function projectOverlap(summary: RunSummary, a: Stage, b: Stage): number {
  const sa = summary.stages[a].share;
  const sb = summary.stages[b].share;
  const after = 1 - sa - sb + Math.max(sa, sb);
  return after > 0 ? 1 / after : Infinity;
}
