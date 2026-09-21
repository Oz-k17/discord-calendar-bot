/**
 * 試し用の「拍のある音」を作る。
 *
 *   node lab/fixtures/make-beats.mjs           # 一覧を出すだけ
 *   node lab/fixtures/make-beats.mjs kick-120  # 1 本だけ作って様子を出す
 *
 * 種を固定してあるので、毎回まったく同じ音が出る（数字をそのまま並べられる）。
 * ファイルには書き出さない（理由は `beats.mjs` の頭に書いた）。
 *
 * ## 音は「正解の拍の列」から作る
 *
 * 打点を置く所を BPM から計算し直すのではなく、**`beats.mjs` が正解として持っている
 * 秒の列をそのまま使って**鳴らしている。こうしておくと、テンポが変わる素材でも
 * 人が叩いたように揺れる素材でも、**正解と音がずれようが無い**。
 * 別々に計算すると、丸めの違いだけで「判定は当たっているのに外れと数える」ことが起きる。
 *
 * 拍と拍の間にある打点（裏拍・ハネた 3 連）は、**その 2 拍の間を割って**置く。
 * 一定のテンポなら格子と同じだが、テンポが動く所では拍の間隔ごと伸び縮みする。
 * 実際の演奏もそう動くので、こちらのほうが素直。
 */

import { pathToFileURL } from 'node:url';

import { BEAT_FIXTURES, BEAT_LENGTH, beatFixture, truthBpm } from './beats.mjs';

const SR = 44100;

/** 種を固定した擬似乱数（mulberry32）。ほかの素材と同じもの。 */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * バスドラム。130Hz から 48Hz へ落ちる正弦に、速い減衰を掛ける。
 *
 * 低い側だけで鳴るので、**帯域をまたいで立ち上がりを見る手**と
 * **低い帯域だけを見る手**の違いがここで出る。
 */
function kick(data, at, level) {
  const from = Math.round(at * SR);
  const dur = Math.round(0.4 * SR);
  let phase = 0;
  for (let i = 0; i < dur; i += 1) {
    const s = from + i;
    if (s < 0 || s >= data.length) continue;
    const t = i / SR;
    const freq = 48 + (130 - 48) * Math.exp(-t / 0.035);
    phase += (2 * Math.PI * freq) / SR;
    data[s] += level * Math.exp(-t / 0.10) * Math.sin(phase);
  }
}

/** スネア。雑音と 185Hz の胴鳴りを混ぜる。中域から上に広く出る。 */
function snare(data, at, level, rnd) {
  const from = Math.round(at * SR);
  const dur = Math.round(0.25 * SR);
  for (let i = 0; i < dur; i += 1) {
    const s = from + i;
    if (s < 0 || s >= data.length) continue;
    const t = i / SR;
    const noise = (rnd() - 0.5) * 2;
    const body = Math.sin(2 * Math.PI * 185 * t);
    data[s] += level * (noise * 0.8 * Math.exp(-t / 0.055) + body * 0.35 * Math.exp(-t / 0.045));
  }
}

/**
 * ハイハット。高い側へ寄せた雑音を短く。
 *
 * 雑音を 1 つ前との差にしているのは、**高い側へ寄せる**ため（素朴な微分が高域強調になる）。
 * わざわざ帯域を分けているのは、`hats-8th-120` で「倍のテンポへ引く力」を
 * 低い側の打点と別に持たせたいから。帯ごと同じ音だと、帯域で分ける手を先に潰してしまう。
 */
function hat(data, at, level, rnd) {
  const from = Math.round(at * SR);
  const dur = Math.round(0.1 * SR);
  let prev = 0;
  for (let i = 0; i < dur; i += 1) {
    const s = from + i;
    if (s < 0 || s >= data.length) continue;
    const t = i / SR;
    const n = (rnd() - 0.5) * 2;
    const high = n - prev;
    prev = n;
    data[s] += level * high * Math.exp(-t / 0.022);
  }
}

const VOICES = { kick, snare, hat };

/**
 * 和音。`changes` の秒で鳴っている和音が変わる。
 *
 * `attack` を持たせてあるのは、**立ち上がりの鋭さだけを変えた素材**を作るため。
 * 打点が無い素材（`pad-only-96`）では、ここだけが拍の手がかりになる。
 */
function pad(data, changes, level, attack, rnd) {
  // 和音は 3 度ずつ積んだだけのもの。音楽的な良し悪しはここでは関係が無い。
  const roots = [196, 220, 233, 262, 174];
  const partials = [1, 1.26, 1.5, 2];
  for (let c = 0; c < changes.length; c += 1) {
    const start = changes[c];
    const end = c + 1 < changes.length ? changes[c + 1] : BEAT_LENGTH;
    const root = roots[Math.floor(rnd() * roots.length)];
    const from = Math.round(start * SR);
    const to = Math.min(data.length, Math.round((end + attack) * SR));
    for (let s = Math.max(0, from); s < to; s += 1) {
      const t = (s - from) / SR;
      // 入りと出をなだらかにする。切り替えの段差そのものが打点になってしまうため。
      const rise = Math.min(1, t / Math.max(1e-6, attack));
      const fall = Math.min(1, Math.max(0, end + attack - s / SR) / Math.max(1e-6, attack));
      const env = Math.min(rise, fall);
      let v = 0;
      for (const p of partials) v += Math.sin(2 * Math.PI * root * p * (s / SR)) / partials.length;
      data[s] += level * env * v;
    }
  }
}

/**
 * しゃべり声に似せた音。拍とは無関係な所に音節を並べる。
 *
 * 本物らしさは要らない。要るのは**3〜6Hz で立ち上がりが並ぶ**ことだけで、
 * それが拍の列にとっての偽の打点になる。
 */
function speech(data, level, rnd) {
  let t = 1.0;
  while (t < BEAT_LENGTH - 0.3) {
    const dur = 0.12 + rnd() * 0.22;
    const f0 = 105 + rnd() * 45;
    const from = Math.round(t * SR);
    const to = Math.min(data.length, Math.round((t + dur) * SR));
    for (let s = from; s < to; s += 1) {
      const u = (s - from) / SR;
      // 音節ひとつの包絡。立ち上がりは速く、終わりはなだらかに。
      const env = Math.min(1, u / 0.02) * Math.min(1, (dur - u) / 0.05);
      let v = 0;
      for (let h = 1; h <= 6; h += 1) v += Math.sin(2 * Math.PI * f0 * h * (s / SR)) / (h * 1.4);
      data[s] += level * env * v;
    }
    // 音節の間は 0.05〜0.25 秒。ときどき大きく空ける（息継ぎ）。
    t += dur + 0.05 + rnd() * 0.2 + (rnd() < 0.15 ? 0.5 : 0);
  }
}

/**
 * 素材を 1 本その場で作る。
 *
 * 返すのは `AudioLike`（`auto-cut/src/loudness.ts` と同じ形）と、正解の拍。
 */
export function renderBeatFixture(name) {
  const fixture = beatFixture(name);
  const o = fixture.options ?? {};
  const rnd = rng(o.seed ?? 1);
  const data = new Float32Array(Math.round(BEAT_LENGTH * SR));
  const beats = fixture.beats;
  const meter = o.meter ?? 4;

  // --- 打点を置く ---
  //
  // 拍の間にある打点（0.5 や 0.667）は、**その拍と次の拍の間を割って**置く。
  // 最後の拍だけは次が無いので、1 つ前との間隔を借りる。
  for (const voice of o.voices ?? []) {
    const make = VOICES[voice.kind];
    if (!make) throw new Error(`知らない音です: ${voice.kind}`);
    // **拍子より外の位置は黙って鳴らない**ので、ここで止める。
    // 3 拍子の素材に `at: 3.5` と書いても `k % 3` が 3 にならないだけで、
    // 素材は作れてしまい「なぜか打点が無い」という形で後から効いてくる。
    for (const at of voice.at) {
      if (at < 0 || at >= meter) throw new Error(`拍子（${meter}）の外です: ${voice.kind} の ${at}`);
    }
    for (let k = 0; k < beats.length; k += 1) {
      const period = k + 1 < beats.length ? beats[k + 1] - beats[k] : beats[k] - beats[k - 1] || 0.5;
      for (const at of voice.at) {
        if (Math.floor(at) !== k % meter) continue;
        const time = beats[k] + (at - Math.floor(at)) * period;
        if (time >= BEAT_LENGTH) continue;
        make(data, time, voice.level, rnd);
      }
    }
  }

  // --- 和音 ---
  if (o.pad) {
    const every = o.pad.every ?? 4;
    const changes = beats.filter((_, k) => k % every === 0);
    pad(data, changes, o.pad.level, o.pad.attack ?? 0.012, rnd);
  }

  // --- 声 ---
  if (o.speech) speech(data, o.speech.level, rnd);

  // --- 部屋の雑音 ---
  const noiseLevel = o.noiseLevel ?? 0.0008;
  for (let s = 0; s < data.length; s += 1) data[s] += (rnd() - 0.5) * 2 * noiseLevel;

  // **倍率は最後に掛ける。** 先に掛けると雑音まで一緒に小さくなり、
  // 「小さく録れた素材」ではなく「静かな部屋で録れた素材」になってしまう。
  if (o.gain != null) for (let s = 0; s < data.length; s += 1) data[s] *= o.gain;

  return {
    name,
    fixture,
    beats,
    bpm: fixture.bpm,
    audio: {
      sampleRate: SR,
      numberOfChannels: 1,
      length: data.length,
      getChannelData: () => data,
    },
  };
}

/** コマンドラインから呼ばれたときは一覧（または 1 本の様子）を出す。 */
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const only = process.argv[2];
  const list = only ? [beatFixture(only)] : BEAT_FIXTURES;
  const pad2 = (s, n) => String(s).padEnd(n, ' ');
  const right = (s, n) => String(s).padStart(n, ' ');
  console.log(`拍のある素材（${BEAT_LENGTH} 秒・${SR}Hz・その場で作る）\n`);
  console.log(`${pad2('素材', 22)}${right('BPM', 6)}${right('拍', 5)}${right('最大', 7)}${right('RMS', 8)}  説明`);
  console.log('-'.repeat(92));
  for (const f of list) {
    const clip = renderBeatFixture(f.name);
    const d = clip.audio.getChannelData(0);
    let peak = 0;
    let sum = 0;
    for (let i = 0; i < d.length; i += 1) {
      peak = Math.max(peak, Math.abs(d[i]));
      sum += d[i] * d[i];
    }
    const rms = Math.sqrt(sum / d.length);
    const bpm = truthBpm(f);
    console.log(
      `${pad2((f.hard ? '※ ' : '') + f.name, 22)}${right(bpm ? bpm.toFixed(1) : '—', 6)}${right(f.beats.length, 5)}` +
        `${right(peak.toFixed(3), 7)}${right(rms.toFixed(4), 8)}  ${f.note}`,
    );
  }
  console.log('\n※ は「拍の検出をいじめるために足した素材」。');
}
