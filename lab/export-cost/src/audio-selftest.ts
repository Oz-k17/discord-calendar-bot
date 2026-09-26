/**
 * 音の側の検算（ブラウザ不要）。
 *
 * ここで押さえるのは **窓に割った置き方が、一括の置き方と同じ音を指しているか**。
 * 実際に混ざった波が同じかは `bench.mjs` が出口で突き合わせる（`audio.mjs` の `verify`）。
 * **中を読んだ根拠と、出口で測った根拠は別物**なので両方置く
 * （9/26・2 回目に映像の側で同じことをした）。
 *
 * 一括と窓割りの差は「素材内の読み出し位置」と「音量の折れ線」の 2 つにしか出ない。
 * なので、その 2 つを**タイムライン上の絶対秒で引き直して**突き合わせる形にしてある
 * （`probeAt`）。窓の数や境目の置き方を変えても、この 2 つが動かなければ音は同じ。
 */

import {
  AUDIO_CHUNK_SECONDS,
  SAMPLE_RATE,
  gainAt,
  planAudioWindows,
  soundsOf,
  splitAudioSequence,
  summarizeAudioCost,
  windowSounds,
  type AudioWindow,
  type LabAudioSequence,
} from './audio-mix.ts';

export interface TestResult {
  name: string;
  ok: boolean;
  detail?: string;
}

const near = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) <= tol;
const mib = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)}MB`;

/**
 * ある絶対秒に、どの音が素材のどこを何の音量で鳴らしているか。
 *
 * 窓の並びから引き直すので、**窓 1 つ（一括）でも窓 100 個でも同じ形で読める**。
 * ここが一致していれば、窓の切り方は音に出ない。
 */
function probeAt(windows: AudioWindow[], time: number): Map<string, { sourceTime: number; gain: number }> {
  const out = new Map<string, { sourceTime: number; gain: number }>();
  for (const window of windows) {
    if (time < window.from - 1e-9 || time >= window.to - 1e-9) continue;
    const inWindow = time - window.from;
    for (const placement of window.placements) {
      // **半開区間で見る。** 終端をぴったり含めると、一括の側だけが
      // 「終わったばかりの音」を拾い、窓の側に無いぶんが食い違いとして出る
      // （窓の境目とクリップの切れ目が揃った瞬間に必ず起きる）。
      if (inWindow < placement.startAt - 1e-9) continue;
      if (inWindow >= placement.startAt + placement.seconds - 1e-9) continue;
      out.set(placement.soundId, {
        sourceTime: placement.offset + (inWindow - placement.startAt) * placement.speed,
        gain: gainAt(placement.envelope, inWindow),
      });
    }
  }
  return out;
}

/** 一括（窓 1 つ）と、窓に割った形を、細かい格子で突き合わせる。 */
function compareWindows(
  sequence: LabAudioSequence,
  windowSeconds: number,
  { step = 0.01, loopSpan = 0 }: { step?: number; loopSpan?: number } = {},
): { checked: number; worstSource: number; worstGain: number; missing: number } {
  const whole = planAudioWindows(sequence, { windowSeconds: Math.max(sequence.duration, 1e-6) });
  const split = planAudioWindows(sequence, { windowSeconds });
  let checked = 0;
  let worstSource = 0;
  let worstGain = 0;
  let missing = 0;
  // **足し算で格子を作らない。** 誤差が溜まって窓の境目にぎりぎり乗り、
  // どちらの窓に入るかが丸めで決まる（9/26・1 回目に `plan.ts` で踏んだのと同じ形）。
  // 掛け算で出し、さらに半端な値（0.0037 秒）ずらして節の真上を避ける。
  const steps = Math.floor((sequence.duration - 0.0037) / step);
  for (let i = 0; i <= steps; i += 1) {
    const t = i * step + 0.0037;
    const a = probeAt(whole, t);
    const b = probeAt(split, t);
    for (const [id, expected] of a) {
      const got = b.get(id);
      if (!got) {
        missing += 1;
        continue;
      }
      checked += 1;
      // ループは折り返した後の位置で比べる（一括の側は WebAudio が折り返す前の値を持つ）。
      const wrap = (x: number) => (loopSpan > 0 ? ((x % loopSpan) + loopSpan) % loopSpan : x);
      const dSource = Math.abs(wrap(got.sourceTime) - wrap(expected.sourceTime));
      const dGain = Math.abs(got.gain - expected.gain);
      if (dSource > worstSource) worstSource = dSource;
      if (dGain > worstGain) worstGain = dGain;
    }
    for (const id of b.keys()) if (!a.has(id)) missing += 1;
  }
  return { checked, worstSource, worstGain, missing };
}

export function runAudioSelfTest(): TestResult[] {
  const out: TestResult[] = [];
  const ok = (name: string, condition: boolean, detail = '') => out.push({ name, ok: condition, detail });

  // ---- 一括の置き方が、本体と同じか ----

  {
    const sequence = splitAudioSequence({ seconds: 13, pieces: 1 });
    const placements = windowSounds(soundsOf(sequence), 0, 13);
    ok(
      '窓を尺いっぱいに取れば、素材の頭から尺ぶん鳴らすだけ（＝本体の一括ミックス）',
      placements.length === 1 &&
        near(placements[0].startAt, 0) &&
        near(placements[0].offset, 0) &&
        near(placements[0].seconds, 13),
      `${placements.length} 本 / 開始 ${placements[0]?.startAt} / 素材 ${placements[0]?.offset} / ${placements[0]?.seconds} 秒`,
    );
  }

  {
    // **窓に割ったときの本題。** 途中の窓は素材の中を進めておかないと、頭から鳴り直す。
    const sequence = splitAudioSequence({ seconds: 13, pieces: 1 });
    const sounds = soundsOf(sequence);
    const third = windowSounds(sounds, 3, 4)[0];
    ok(
      '3 秒目の窓は、素材の 3 秒目から読む',
      near(third.offset, 3) && near(third.startAt, 0) && near(third.seconds, 1),
      `素材 ${third.offset}s / 窓の中 ${third.startAt}s / ${third.seconds}s`,
    );
    const fast = windowSounds(soundsOf(splitAudioSequence({ seconds: 6, pieces: 1, speed: 2 })), 3, 4)[0];
    ok(
      '2 倍速なら、3 秒目の窓は素材の 6 秒目から読む',
      near(fast.offset, 6) && near(fast.speed, 2),
      `素材 ${fast.offset}s / 速さ ${fast.speed}`,
    );
  }

  {
    const sequence = splitAudioSequence({ seconds: 13, pieces: 1 });
    const windows = planAudioWindows(sequence, { windowSeconds: 1 });
    const covered = windows.reduce((n, w) => n + w.placements.reduce((m, p) => m + p.seconds, 0), 0);
    ok(
      '窓に割っても、鳴らす秒の合計は変わらない（隙間も重なりも無い）',
      windows.length === 13 && near(covered, 13, 1e-9),
      `${windows.length} 窓 / 合計 ${covered.toFixed(6)} 秒`,
    );
    // 窓から窓へ、素材内の位置が続いているか（1 コマぶんの飛びも無いこと）。
    let worstStep = 0;
    for (let i = 1; i < windows.length; i += 1) {
      const before = windows[i - 1].placements[0];
      const after = windows[i].placements[0];
      const expected = before.offset + before.seconds * before.speed;
      worstStep = Math.max(worstStep, Math.abs(after.offset - expected));
    }
    ok('素材内の位置は、窓の境目で途切れない', worstStep < 1e-9, `最大のずれ ${worstStep.toExponential(1)} 秒`);
  }

  // ---- フェードの途中で窓が切れる ----

  {
    // 1.5 秒のフェードイン／アウトに対して窓は 1 秒なので、**境目が必ずフェードの途中に来る**。
    const sequence = splitAudioSequence({ seconds: 13, pieces: 1, fade: 1.5, volume: 0.8 });
    const c = compareWindows(sequence, 1);
    ok(
      'フェードの途中で窓が切れても、音量はその時点から続く',
      c.missing === 0 && c.worstGain < 1e-9 && c.worstSource < 1e-9,
      `${c.checked} 点 / 音量のずれ ${c.worstGain.toExponential(1)} / 素材のずれ ${c.worstSource.toExponential(1)}`,
    );
    const mid = windowSounds(soundsOf(sequence), 1, 2)[0];
    ok(
      'フェードインの途中から始まる窓の先頭は、0 ではなくその時点の音量',
      near(mid.envelope[0].gain, (0.8 * 1) / 1.5, 1e-9),
      `窓の先頭 ${mid.envelope[0].gain.toFixed(4)}（0.8 × 1 / 1.5 = ${((0.8 * 1) / 1.5).toFixed(4)}）`,
    );
  }

  {
    // フェードの合計が尺を超える形。本体は 2 つを別々に切るので節の時刻が前後するが、
    // ここは交差しないよう切ってから並べる（README と `fadeEnvelope` の注）。
    const sequence: LabAudioSequence = {
      duration: 2,
      clips: [
        {
          id: 'clip-0',
          mediaId: 'asset',
          kind: 'audio',
          start: 0,
          duration: 2,
          sourceIn: 0,
          assetDuration: 10,
          fadeIn: 1.6,
          fadeOut: 1.6,
        },
      ],
    };
    const envelope = soundsOf(sequence)[0].envelope;
    const ordered = envelope.every((p, i) => i === 0 || p.time >= envelope[i - 1].time - 1e-9);
    ok(
      'フェードイン＋フェードアウトが尺を超えても、折れ線は前後しない',
      ordered && envelope[envelope.length - 1].time <= 2 + 1e-9,
      envelope.map((p) => `${p.time.toFixed(2)}s:${p.gain.toFixed(2)}`).join(' → '),
    );
  }

  // ---- 割ったクリップ・トランジションの引き延ばし ----

  {
    // 5 つに割った上にトランジション（前のカットの音を引き延ばす）を足して、
    // **1 つの窓の中に 2 本の音が別々の素材位置で入る**形を作る。
    // 本体は「前のクリップにフェードアウトがあれば引き延ばさない」ので、
    // 引き延ばしを出したい素材では**フェードインだけ**を残す。
    const sequence = splitAudioSequence({ seconds: 10, pieces: 5, transition: 0.4, fade: 0.2 });
    for (const clip of sequence.clips) clip.fadeOut = 0;
    const sounds = soundsOf(sequence);
    ok(
      'トランジションの引き延ばしも 1 本の音として並ぶ',
      sounds.length === 9 && sounds.filter((s) => s.id.endsWith(':tail')).length === 4,
      `${sounds.length} 本（うち引き延ばし ${sounds.filter((s) => s.id.endsWith(':tail')).length} 本）`,
    );
    const c = compareWindows(sequence, 1);
    ok(
      '割ったクリップも引き延ばしも、窓に割って同じ所を鳴らす',
      c.missing === 0 && c.worstGain < 1e-9 && c.worstSource < 1e-9,
      `${c.checked} 点 / 音量のずれ ${c.worstGain.toExponential(1)} / 素材のずれ ${c.worstSource.toExponential(1)}`,
    );
  }

  {
    // 窓の幅を素直でない値にしても同じであること（境目がクリップの切れ目と揃わない）。
    const sequence = splitAudioSequence({ seconds: 10, pieces: 3, transition: 0.4, fade: 0.7 });
    for (const clip of sequence.clips) clip.fadeOut = 0;
    const worst = [0.37, 0.5, 1, 2.5, 7].map((w) => compareWindows(sequence, w));
    ok(
      '窓の幅を 0.37 / 0.5 / 1 / 2.5 / 7 秒に振っても、鳴る所は動かない',
      worst.every((c) => c.missing === 0 && c.worstGain < 1e-9 && c.worstSource < 1e-9),
      worst.map((c) => c.worstGain.toExponential(0)).join(' / '),
    );
  }

  {
    const sequence: LabAudioSequence = {
      duration: 4,
      clips: [
        {
          id: 'clip-0',
          mediaId: 'asset',
          kind: 'video',
          start: 0,
          duration: 2,
          sourceIn: 0,
          assetDuration: 10,
          fadeOut: 0.5,
        },
        {
          id: 'clip-1',
          mediaId: 'asset',
          kind: 'video',
          start: 2,
          duration: 2,
          sourceIn: 5,
          assetDuration: 10,
          transitionIn: 0.5,
        },
      ],
    };
    ok(
      '前のクリップにフェードアウトがあるときは引き延ばさない（本体と同じ）',
      soundsOf(sequence).every((s) => !s.id.endsWith(':tail')),
      `${soundsOf(sequence).length} 本`,
    );
  }

  // ---- ループ・素材の端 ----

  {
    // 素材 3 秒を 10 秒ぶんループさせる。**窓の途中で折り返しが来る。**
    const sequence = splitAudioSequence({ seconds: 10, pieces: 1, assetSeconds: 3, loop: true });
    const c = compareWindows(sequence, 1, { loopSpan: 3 });
    ok(
      'ループしている音も、窓に割って同じ所を鳴らす',
      c.missing === 0 && c.worstSource < 1e-9,
      `${c.checked} 点 / 素材のずれ ${c.worstSource.toExponential(1)}`,
    );
    const late = windowSounds(soundsOf(sequence), 7, 8)[0];
    ok(
      '7 秒目の窓は、折り返した後の位置（7 % 3 = 1 秒目）から読む',
      near(late.offset, 1) && late.loop,
      `素材 ${late.offset.toFixed(3)}s`,
    );
  }

  {
    // 素材 3 秒しか無いのに 10 秒置くクリップ。**越えた窓は音源を組まない。**
    const sequence = splitAudioSequence({ seconds: 10, pieces: 1, assetSeconds: 3 });
    const windows = planAudioWindows(sequence, { windowSeconds: 1 });
    const placed = windows.filter((w) => w.placements.length > 0).length;
    ok(
      '素材の端を越えた窓には、音源を組まない',
      placed === 3 && windows.length === 10,
      `${placed} / ${windows.length} 窓に置いた`,
    );
    // 一括のほうは 1 本置いて後ろが無音になるだけなので、置いた本数は 1 本。
    ok(
      '一括のほうは 1 本置いて、素材が尽きた後ろは無音になる（本体と同じ）',
      windowSounds(soundsOf(sequence), 0, 10).length === 1,
    );
  }

  {
    const sequence: LabAudioSequence = {
      duration: 5,
      clips: [
        { id: 'a', mediaId: 'asset', kind: 'audio', start: 0, duration: 5, sourceIn: 12, assetDuration: 10 },
        { id: 'b', mediaId: 'asset', kind: 'audio', start: 0, duration: 5, sourceIn: 0, assetDuration: 10, muted: true },
      ],
    };
    ok('素材の端より後ろから始まるクリップと、消したクリップは並べない', soundsOf(sequence).length === 0);
    // それでも**起こすバイトは減らない**（本体は起こしてから置く段で落とすので）。
    const stats = summarizeAudioCost(sequence, { windowSeconds: 1 });
    ok(
      '消したクリップでも、素材は起こされる（本体の順番がそうなっている）',
      stats.sounds === 0 && stats.assets === 1 && stats.decodedSeconds === 10,
      `音 ${stats.sounds} 本 / 素材 ${stats.assets} / 起こす ${stats.decodedSeconds}s`,
    );
  }

  // ---- 数え上げ ----

  {
    const stats = summarizeAudioCost(splitAudioSequence({ seconds: 13, pieces: 1 }));
    // 13 秒 × 48000 × 2ch × 4 バイト ＝ 4.99MB。
    ok(
      '一括ミックスの入れ物は、尺だけで決まる',
      stats.mixBytes === Math.ceil(13 * SAMPLE_RATE) * 2 * 4 && stats.mixBytes === 4_992_000,
      `${mib(stats.mixBytes)}`,
    );
    ok(
      '出力へ渡すたびに 1 秒ぶんを複製するので、複製の合計はミックスと同じ大きさ',
      stats.sliceCopies === 13 && stats.sliceBytes === stats.mixBytes,
      `${stats.sliceCopies} 回 / ${mib(stats.sliceBytes)}`,
    );
  }

  {
    // **本体は素材まるごとを起こす。** 1 時間の素材から 10 秒だけ使っても 1 時間ぶん乗る。
    const stats = summarizeAudioCost(splitAudioSequence({ seconds: 10, pieces: 1, assetSeconds: 3600 }));
    ok(
      '10 秒だけ使うクリップでも、1 時間の素材は 1 時間ぶんデコードされる',
      near(stats.usedSeconds, 10) && near(stats.decodedSeconds, 3600),
      `使う ${stats.usedSeconds}s / 起こす ${stats.decodedSeconds}s（${mib(stats.decodedBytes)}）`,
    );
    ok(
      'そのぶんは窓に割っても消えない（減るのはミックスの側だけ）',
      stats.windowPeakBytes > stats.decodedBytes && stats.memoryRatio < 1.2,
      `一括 ${mib(stats.peakBytes)} / 窓 ${mib(stats.windowPeakBytes)}（${stats.memoryRatio.toFixed(2)} 倍）`,
    );
  }

  {
    // 尺を振ったときに、窓のほうの山が伸びないこと。**ここが窓に割る理由。**
    const short = summarizeAudioCost(splitAudioSequence({ seconds: 13, pieces: 1, assetSeconds: 13 }));
    const long = summarizeAudioCost(splitAudioSequence({ seconds: 3600, pieces: 1, assetSeconds: 13 }));
    ok(
      '尺が 277 倍になっても、窓に割った側の山は伸びない',
      long.windowPeakBytes === short.windowPeakBytes && long.mixBytes > 1_000_000_000,
      `一括 ${mib(short.peakBytes)} → ${mib(long.peakBytes)} / 窓 ${mib(short.windowPeakBytes)} → ${mib(long.windowPeakBytes)}`,
    );
    ok(
      '1 時間のタイムラインでは、一括は窓割りの 200 倍以上を抱える',
      long.memoryRatio > 200,
      `${long.memoryRatio.toFixed(0)} 倍（${mib(long.peakBytes)} 対 ${mib(long.windowPeakBytes)}）`,
    );
  }

  {
    // 窓を出力へ渡す単位より広く取ると、複製が 1 枚ぶん戻ってくる。
    const same = summarizeAudioCost(splitAudioSequence({ seconds: 60 }), { windowSeconds: AUDIO_CHUNK_SECONDS });
    const wide = summarizeAudioCost(splitAudioSequence({ seconds: 60 }), { windowSeconds: 5 });
    ok(
      '窓を渡す単位（1 秒）と同じにすると、複製が 1 枚も要らない',
      same.windowPeakBytes < wide.windowPeakBytes &&
        wide.windowPeakBytes - same.windowPeakBytes === Math.round(SAMPLE_RATE * 2 * 4) + (5 - 1) * SAMPLE_RATE * 2 * 4,
      `1 秒窓 ${mib(same.windowPeakBytes)} / 5 秒窓 ${mib(wide.windowPeakBytes)}`,
    );
  }

  {
    const stats = summarizeAudioCost(splitAudioSequence({ seconds: 10, pieces: 5 }));
    ok(
      '同じ素材を指す 5 つのクリップでも、起こす素材は 1 つ',
      stats.assets === 1 && stats.sounds === 5,
      `素材 ${stats.assets} / 音 ${stats.sounds} 本`,
    );
  }

  // ---- 境目・極端な値 ----

  {
    const windows = planAudioWindows({ clips: [], duration: 0 }, { windowSeconds: 1 });
    ok('尺 0 のタイムラインでも落ちない', windows.length === 0);
    const stats = summarizeAudioCost({ clips: [], duration: 0 });
    ok(
      '音が 1 本も無くても数え上げは通る（入れ物は 1 サンプルぶん）',
      stats.sounds === 0 && stats.mixBytes === 8 && stats.windows === 0,
      `${stats.mixBytes} バイト`,
    );
  }

  {
    // 尺が窓の倍数でないとき、最後の窓は尺で切る（伸ばすと渡すサンプル数が変わる）。
    const windows = planAudioWindows(splitAudioSequence({ seconds: 2.5 }), { windowSeconds: 1 });
    const last = windows[windows.length - 1];
    ok(
      '尺が窓の倍数でなければ、最後の窓は尺で切る',
      windows.length === 3 && near(last.to, 2.5) && near(last.placements[0].seconds, 0.5),
      `${windows.length} 窓 / 最後は ${last.from}〜${last.to}s`,
    );
  }

  {
    let threw = 0;
    for (const w of [0, -1, Number.NaN]) {
      try {
        planAudioWindows(splitAudioSequence({ seconds: 2 }), { windowSeconds: w });
      } catch {
        threw += 1;
      }
    }
    ok('窓の幅に 0 や負の数を渡したら黙って通さない', threw === 3, `${threw} / 3 件で止まった`);
  }

  {
    // 速さは本体と同じ範囲で丸める（0 を渡されても止まらないこと）。
    const sequence: LabAudioSequence = {
      duration: 2,
      clips: [
        { id: 'a', mediaId: 'asset', kind: 'audio', start: 0, duration: 2, sourceIn: 0, assetDuration: 60, speed: 0 },
        { id: 'b', mediaId: 'asset', kind: 'audio', start: 0, duration: 2, sourceIn: 0, assetDuration: 60, speed: 99 },
      ],
    };
    const sounds = soundsOf(sequence);
    ok(
      '速さは本体と同じ範囲（1/16〜16 倍）に丸める',
      near(sounds[0].speed, 1) && near(sounds[1].speed, 16),
      `${sounds[0].speed} / ${sounds[1].speed}`,
    );
  }

  return out;
}
