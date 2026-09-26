/**
 * 書き出しの仕事量と、段ごとの取り分の検算。
 *
 * ブラウザは要らない（並べ方も集計も DOM に触らない）。
 * ここで押さえるのは「数えた数が合っているか」だけで、
 * 「実際どれくらいかかるか」は `bench.mjs` がブラウザで測る。
 */

import {
  decodeShape,
  planExportWork,
  splitSequence,
  summarizePlan,
  visibleAt,
  type LabSequence,
} from './plan.ts';
import { projectOverlap, projectSpeedup, summarizeRun, type FrameSample } from './cost.ts';

export interface TestResult {
  name: string;
  ok: boolean;
  detail?: string;
}

const near = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) <= tol;

/** 段の時間が全コマ同じ、という作り物の計測。取り分の検算に使う。 */
function flatRun(decode: number, draw: number, encode: number, frames: number): FrameSample[] {
  return Array.from({ length: frames }, () => ({ decode, draw, encode }));
}

export function runSelfTest(): TestResult[] {
  const out: TestResult[] = [];
  const ok = (name: string, condition: boolean, detail = '') => out.push({ name, ok: condition, detail });

  // ---- 並べ方 ----

  {
    const seq = splitSequence({ duration: 10, pieces: 1 });
    const plan = planExportWork(seq, 30);
    const stats = summarizePlan(plan);
    ok(
      '1 本のクリップなら、デコードは 1 コマに 1 枚',
      plan.totalFrames === 300 && stats.decodeCalls === 300 && near(stats.decodesPerFrame, 1),
      `${plan.totalFrames} コマ / ${stats.decodeCalls} 枚`,
    );
    ok('開くデコーダは 1 つ', stats.decoderOpens === 1 && stats.redundantOpens === 0);
  }

  {
    // **この試作の本題。** 1 本の素材を 5 つに割っただけで、開き直しが 4 回増える。
    const seq = splitSequence({ duration: 10, pieces: 5 });
    const stats = summarizePlan(planExportWork(seq, 30));
    ok(
      '1 本の素材を 5 つに割ると、同じファイルを 5 回開き直す',
      stats.decoderOpens === 5 && stats.redundantOpens === 4,
      `開く ${stats.decoderOpens} 回 / うち開き直し ${stats.redundantOpens} 回`,
    );
    ok(
      '割ってもデコードする枚数は増えない（増えるのは開き直しだけ）',
      stats.decodeCalls === 300,
      `${stats.decodeCalls} 枚`,
    );
  }

  {
    // トランジションの最中だけ 2 本映る＝そのコマのデコードが 2 枚になる。
    const seq = splitSequence({ duration: 10, pieces: 2, transition: 0.5 });
    const plan = planExportWork(seq, 30);
    const stats = summarizePlan(plan);
    ok(
      'トランジションの間は 1 コマで 2 枚デコードする',
      stats.framesWithMultipleDecodes === 15 && stats.decodeCalls === 315,
      `${stats.framesWithMultipleDecodes} コマ / ${stats.decodeCalls} 枚`,
    );
    ok(
      'その間はデコーダも 2 本同時に開く',
      stats.maxConcurrentDecoders === 2,
      `${stats.maxConcurrentDecoders} 本`,
    );
  }

  {
    // 速度 0.5 は、素材の同じコマを 2 回要求する（書き出し 30fps に対し素材は 15fps 進む）。
    const seq: LabSequence = {
      duration: 4,
      clips: [
        { id: 'a', mediaId: 'm', kind: 'video', start: 0, duration: 4, sourceIn: 0, speed: 0.5, assetDuration: 10 },
      ],
    };
    const stats = summarizePlan(planExportWork(seq, 30), { sourceFps: 30 });
    ok(
      'スロー再生では、同じ素材コマを 2 回要求する（素材 30fps・半速なので全コマ）',
      stats.repeatedSourceFrames === 119,
      `${stats.repeatedSourceFrames} 回 / ${stats.decodeCalls} 枚`,
    );
  }

  {
    // ループは素材内の時刻が巻き戻るので、順に読む形（`canvases()`）に置き換えられない。
    const seq: LabSequence = {
      duration: 6,
      clips: [
        { id: 'a', mediaId: 'm', kind: 'video', start: 0, duration: 6, sourceIn: 0, loop: true, assetDuration: 2 },
      ],
    };
    const stats = summarizePlan(planExportWork(seq, 30));
    ok(
      'ループするクリップは、素材内の時刻が単調に並ばない',
      stats.monotonicStreams === 0,
      `単調 ${stats.monotonicStreams} 本`,
    );
    const plain = summarizePlan(planExportWork(splitSequence({ duration: 6, pieces: 3 }), 30));
    ok(
      'ふつうのクリップは単調に並ぶ（順に読む形へ置き換えられる側）',
      plain.monotonicStreams === 3,
      `単調 ${plain.monotonicStreams} / 3 本`,
    );
  }

  {
    // 静止画はデコーダを持たない。**描く仕事だけ**が残る。
    const seq: LabSequence = {
      duration: 2,
      clips: [{ id: 'a', mediaId: 'm', kind: 'image', start: 0, duration: 2, sourceIn: 0, assetDuration: 0 }],
    };
    const plan = planExportWork(seq, 30);
    const stats = summarizePlan(plan);
    ok(
      '静止画はデコーダを開かない（描くだけ）',
      stats.decoderOpens === 0 && plan.perFrame.every((f) => f.draw.length === 1 && f.decode.length === 0),
      `開く ${stats.decoderOpens} / 描く ${plan.perFrame[0]?.draw.length}`,
    );
  }

  {
    // **同じ並びでも、素材のコマが粗ければ「2 回要求」になる。**
    // ここを外から渡すようにした理由そのもの（等速でも素材が 15fps なら半分が重複）。
    const seq = splitSequence({ duration: 4, pieces: 1 });
    const fine = summarizePlan(planExportWork(seq, 30), { sourceFps: 30 });
    const coarse = summarizePlan(planExportWork(seq, 30), { sourceFps: 15 });
    ok(
      '素材のコマが粗いと、等速でも同じ素材コマを 2 回要求する',
      fine.repeatedSourceFrames === 0 && coarse.repeatedSourceFrames === 119,
      `素材 30fps で ${fine.repeatedSourceFrames} 回 / 15fps で ${coarse.repeatedSourceFrames} 回`,
    );
  }

  {
    // 速い再生では、素材のコマを飛ばしながら読む。**「順に読む」形が不利になる側。**
    const seq = splitSequence({ duration: 12, pieces: 1, assetDuration: 12, speed: 4 });
    const plan = planExportWork(seq, 30);
    const stats = summarizePlan(plan, { sourceFps: 30 });
    ok(
      '4 倍速では尺が 4 分の 1 になり、要求するコマも 4 分の 1',
      plan.totalFrames === 90 && stats.decodeCalls === 90 && stats.repeatedSourceFrames === 0,
      `${plan.totalFrames} コマ / ${stats.decodeCalls} 枚`,
    );
    const stream = plan.streams[0];
    ok(
      '素材内は 1 コマおきではなく 4 コマおきに進む（飛ばして読む側）',
      near(stream.times[1] - stream.times[0], 4 / 30, 1e-9),
      `${((stream.times[1] - stream.times[0]) * 30).toFixed(2)} コマぶん`,
    );
  }

  {
    // 並びだけを見て「順に読む形が向くか」を決める。**測った境目は素材コマ 1.5 個ぶんの歩幅。**
    const at = (speed: number) =>
      decodeShape(planExportWork(splitSequence({ duration: 12, assetDuration: 12, speed }), 30).streams[0], {
        sourceFps: 15,
      });
    const rows = [1, 2, 3, 4].map((speed) => ({ speed, ...at(speed) }));
    ok(
      '歩幅は速さに比例する（素材 15fps を 30fps へ書き出す）',
      rows.every((r) => near(r.strideFrames, r.speed / 2, 1e-6)),
      rows.map((r) => `${r.speed}倍 ${r.strideFrames.toFixed(2)} コマ`).join(' / '),
    );
    ok(
      '等速と 2 倍は「順に読む」側、3 倍からは「飛ばして読む」側（互角の手前で切る）',
      rows[0].sequential && rows[1].sequential && !rows[2].sequential && !rows[3].sequential,
      rows.map((r) => `${r.speed}倍 ${r.strideFrames.toFixed(2)} コマ ${r.sequential ? '順' : '飛'}`).join(' / '),
    );
    const looped = decodeShape(
      planExportWork(
        {
          duration: 6,
          clips: [
            { id: 'a', mediaId: 'm', kind: 'video', start: 0, duration: 6, sourceIn: 0, loop: true, assetDuration: 2 },
          ],
        },
        30,
      ).streams[0],
      { sourceFps: 30 },
    );
    ok('巻き戻るクリップは、歩幅によらず「順に読む」側にしない', !looped.sequential && !looped.monotonic);
    ok(
      'コマが 1 枚しか無い注文でも落ちない',
      decodeShape({ clipId: 'a', mediaId: 'm', frames: [0], times: [0] }).strideFrames === 0,
    );
  }

  // ---- 境界 ----

  {
    const empty = planExportWork({ clips: [], duration: 0 }, 30);
    ok('クリップが 1 つも無くても落ちない', empty.totalFrames === 0 && summarizePlan(empty).decodeCalls === 0);
    const gap = planExportWork({ clips: [], duration: 2 }, 30);
    ok(
      '何も置いていない秒では、デコードも描画も注文しない',
      gap.totalFrames === 60 && gap.perFrame.every((f) => f.decode.length === 0 && f.draw.length === 0),
    );
    ok('クリップの外の秒では映るものが無い', visibleAt({ clips: [], duration: 2 }, 1).length === 0);
    let threw = false;
    try {
      planExportWork(splitSequence(), 0);
    } catch {
      threw = true;
    }
    ok('fps に 0 を渡したら黙って通さない', threw);
    let threwSource = false;
    try {
      summarizePlan(planExportWork(splitSequence(), 30), { sourceFps: 0 });
    } catch {
      threwSource = true;
    }
    ok('素材のコマの速さに 0 を渡したら黙って通さない', threwSource);
    let threwSpeed = false;
    try {
      splitSequence({ speed: 0 });
    } catch {
      threwSpeed = true;
    }
    ok('再生速度に 0 を渡したら黙って通さない', threwSpeed);
  }

  // ---- 取り分 ----

  {
    // 1 コマ 10ms（4 + 1 + 5）・100 コマ・壁時計 1200ms。差の 200ms が `other`。
    const run = summarizeRun(flatRun(4, 1, 5, 100), 1200);
    ok(
      '段の取り分と、どれでもない時間で 1 になる',
      near(run.stages.decode.share + run.stages.draw.share + run.stages.encode.share + run.other.share, 1, 1e-9),
      `decode ${run.stages.decode.share.toFixed(3)} / draw ${run.stages.draw.share.toFixed(3)} / encode ${run.stages.encode.share.toFixed(3)} / other ${run.other.share.toFixed(3)}`,
    );
    ok('コマ／秒は壁時計から出る', near(run.fps, 83.3333, 1e-3), `${run.fps.toFixed(2)} コマ/秒`);
    ok(
      '取り分 1/3 の段をタダにしても、全体は 1.5 倍止まり',
      near(projectSpeedup(run, 'decode', Infinity), 1.5, 1e-9),
      `${projectSpeedup(run, 'decode', Infinity).toFixed(3)} 倍（取り分 ${run.stages.decode.share.toFixed(3)}）`,
    );
    ok(
      '2 倍速くしただけなら 1.2 倍',
      near(projectSpeedup(run, 'decode', 2), 1.2, 1e-9),
      `${projectSpeedup(run, 'decode', 2).toFixed(3)} 倍`,
    );
    ok(
      'デコードとエンコードを重ねられたら 1.5 倍（小さいほうが消える）',
      near(projectOverlap(run, 'decode', 'encode'), 1 / (1 - 4 / 12), 1e-9),
      `${projectOverlap(run, 'decode', 'encode').toFixed(3)} 倍`,
    );
  }

  {
    // 測り方を間違えて壁時計が段の合計より短く出たとき、負の取り分を作らない。
    const run = summarizeRun(flatRun(4, 1, 5, 10), 50);
    ok('壁時計が合計より短くても、どれでもない時間は負にならない', run.other.share === 0 && run.other.sum === 0);
    const zero = summarizeRun([], 0);
    ok('1 コマも測れていなくても落ちない', zero.frames === 0 && zero.fps === 0 && zero.stages.decode.share === 0);
    let threw = false;
    try {
      projectSpeedup(run, 'decode', 0);
    } catch {
      threw = true;
    }
    ok('倍率に 0 を渡したら黙って通さない', threw);
  }

  return out;
}
