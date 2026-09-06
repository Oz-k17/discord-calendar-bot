/**
 * 合成した波形で、計算そのものが正しいかを確かめる。
 * 素材を用意しなくても壊れていないことが分かるように、画面から実行できるようにしてある。
 */

import { analyzeLoudness, toDb, type AudioLike } from './loudness';
import { autoThresholdDb, planJetCut } from './silence';
import { gainAt, planDucking } from './ducking';
import { toClipEdits } from './edits';
import { buildPeaks } from './peaks';

export interface TestResult {
  name: string;
  ok: boolean;
  detail: string;
}

/** 指定した区間だけサイン波が鳴る、1ch の合成音を作る。 */
function makeTone(seconds: number, sampleRate: number, tones: { from: number; to: number; amp?: number }[]): AudioLike {
  const length = Math.round(seconds * sampleRate);
  const data = new Float32Array(length);
  for (const tone of tones) {
    const from = Math.round(tone.from * sampleRate);
    const to = Math.min(length, Math.round(tone.to * sampleRate));
    const amp = tone.amp ?? 0.5;
    for (let i = from; i < to; i += 1) data[i] = amp * Math.sin((2 * Math.PI * 440 * i) / sampleRate);
  }
  return { sampleRate, numberOfChannels: 1, length, getChannelData: () => data };
}

const near = (a: number, b: number, tolerance: number) => Math.abs(a - b) <= tolerance;

export function runSelfTest(): TestResult[] {
  const results: TestResult[] = [];
  const check = (name: string, ok: boolean, detail: string) => results.push({ name, ok, detail });

  // --- 音量の測定 ---
  {
    const sr = 8000;
    const buffer = makeTone(1, sr, [{ from: 0, to: 1, amp: 0.5 }]);
    const track = analyzeLoudness(buffer, 0.02);
    // 振幅 0.5 のサイン波の RMS は 0.5/√2 ≒ 0.354 → 約 -9dB
    const middle = track.db[Math.floor(track.db.length / 2)];
    check('サイン波の音量が理論値と一致する', near(middle, toDb(0.5 / Math.SQRT2), 0.5), `${middle.toFixed(2)} dB`);
    check('コマ数が尺 ÷ hop と一致する', near(track.db.length, 1 / 0.02, 1), `${track.db.length} コマ`);
  }

  // --- 無音カット ---
  {
    const sr = 8000;
    // 無音 1s / 声 1s / 無音 0.5s / 声 1s / 無音 1s
    const buffer = makeTone(4.5, sr, [
      { from: 1, to: 2 },
      { from: 2.5, to: 3.5 },
    ]);
    const track = analyzeLoudness(buffer, 0.02);
    const threshold = autoThresholdDb(track, 0.25);
    check('自動しきい値が無音と声の間に来る', threshold > -100 && threshold < -12, `${threshold.toFixed(1)} dB`);

    // 0.5 秒の切れ目は minSilence(0.35) より長いので、2 本に分かれるはず。
    const split = planJetCut(track, { minSilence: 0.35, padding: 0.05 });
    check('切れ目が長ければ 2 本に分かれる', split.keep.length === 2, `${split.keep.length} 本`);
    check('前後の無音が落ちる', near(split.removed, 2.4, 0.2), `${split.removed.toFixed(2)} 秒を削減`);
    check(
      '残す区間が声の位置と合っている',
      near(split.keep[0].start, 0.95, 0.08) && near(split.keep[1].end, 3.55, 0.08),
      `${split.keep.map((r) => `${r.start.toFixed(2)}〜${r.end.toFixed(2)}`).join(' / ')}`,
    );

    // minSilence を 0.6 に上げると、0.5 秒の切れ目は繋がったままになるはず。
    const joined = planJetCut(track, { minSilence: 0.6, padding: 0.05 });
    check('切れ目が短ければ繋がったまま', joined.keep.length === 1, `${joined.keep.length} 本`);

    // 余白は語頭・語尾を食わないための保険。増やせば残る尺も増える。
    const padded = planJetCut(track, { minSilence: 0.35, padding: 0.2 });
    check('余白を増やすと残る尺が伸びる', padded.resultDuration > split.resultDuration, `${split.resultDuration.toFixed(2)} → ${padded.resultDuration.toFixed(2)} 秒`);

    // 全編無音なら 1 本も残らない。
    const quiet = planJetCut(analyzeLoudness(makeTone(2, sr, []), 0.02));
    check('全編無音なら何も残らない', quiet.keep.length === 0, `${quiet.keep.length} 本`);

    // --- 計画 → クリップ ---
    const edits = toClipEdits(split.keep, { start: 10, duration: 4.5, sourceIn: 0 });
    check('分割後もタイムライン上で隙間なく並ぶ', edits.length === 2 && near(edits[1].start, edits[0].start + edits[0].duration, 1e-6), edits.map((e) => `${e.start.toFixed(2)}+${e.duration.toFixed(2)}`).join(' / '));
    check('置いた位置（10 秒）から始まる', near(edits[0].start, 10, 1e-6), `${edits[0].start} 秒`);

    // クリップが素材の一部しか使っていない場合は、その外は無視される。
    const trimmed = toClipEdits(split.keep, { start: 0, duration: 1.5, sourceIn: 2.5 });
    check('トリム済みクリップでは使っている範囲だけ切る', trimmed.length === 1 && trimmed[0].sourceIn >= 2.5, `${trimmed.length} 本 / sourceIn=${trimmed[0]?.sourceIn.toFixed(2)}`);
  }

  // --- ダッキング ---
  {
    const sr = 8000;
    const voice = analyzeLoudness(makeTone(4, sr, [{ from: 1, to: 2 }]), 0.02);
    const points = planDucking(voice, { duckDb: -12, attack: 0.1, release: 0.4, hold: 0.2, thresholdDb: -45 });
    check('声の前は下がっていない', near(gainAt(points, 0.5), 1, 0.02), gainAt(points, 0.5).toFixed(3));
    check('声のあいだは約 -12dB', near(gainAt(points, 1.5), 0.251, 0.02), gainAt(points, 1.5).toFixed(3));
    check('声のあとで戻る', near(gainAt(points, 3.5), 1, 0.02), gainAt(points, 3.5).toFixed(3));
    check('音量が 0〜1 に収まっている', points.every((p) => p.gain >= 0 && p.gain <= 1), `${points.length} 点`);
    check('時刻が昇順に並んでいる', points.every((p, i) => i === 0 || p.time >= points[i - 1].time), 'ok');

    const silent = planDucking(analyzeLoudness(makeTone(2, sr, []), 0.02));
    check('声が無ければ下げない', silent.length === 1 && silent[0].gain === 1, `${silent.length} 点`);
  }

  // --- 波形 ---
  {
    const peaks = buildPeaks(makeTone(1, 8000, [{ from: 0, to: 1, amp: 0.8 }]), 100);
    check('波形の山が振幅と一致する', near(Math.max(...peaks.max), 0.8, 0.02), Math.max(...peaks.max).toFixed(3));
    check('波形のバケット数が指定どおり', peaks.max.length === 100, `${peaks.max.length}`);
  }

  return results;
}
