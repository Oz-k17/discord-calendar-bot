/**
 * 試し用の音を作る。
 *
 *   npm run lab:fixtures          # 短いものを一式
 *   npm run lab:fixtures -- long  # 長尺（10 分）も作る
 *
 * 素材を手で用意しなくても試せるようにするため、そして
 * **毎回まったく同じ音が出る**ようにするために置いている。
 * 乱数に種を固定してあるので、「昨日は 38% 削れた／今日は 41% 削れた」を
 * そのまま比べられる。Math.random を使うとそれができない。
 *
 * 出力は lab/fixtures/out/（git には入れない）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHORT_FIXTURES, SHORT_LENGTH, SPARSE_UTTERANCES, UTTERANCES } from './spec.mjs';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'out');
const SR = 44100;

/** 種を固定した擬似乱数（mulberry32）。 */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function writeWav(name, samples) {
  const bytes = Buffer.alloc(44 + samples.length * 2);
  bytes.write('RIFF', 0);
  bytes.writeUInt32LE(36 + samples.length * 2, 4);
  bytes.write('WAVE', 8);
  bytes.write('fmt ', 12);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(SR, 24);
  bytes.writeUInt32LE(SR * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i += 1) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    bytes.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  const file = path.join(OUT, name);
  fs.writeFileSync(file, bytes);
  const seconds = samples.length / SR;
  console.log(`${name}  ${seconds.toFixed(1)} 秒  ${(bytes.length / 1024 / 1024).toFixed(2)} MB`);
  return file;
}

/**
 * 声らしい音。倍音を重ねたうえで、音節くらいの速さで音量を揺らす。
 * 本物の声ではないが、「鳴っている／黙っている」を見分ける処理を試すには足りる。
 *
 * `vowel` を真にすると、音節ごとに倍音の重みを行き来させる（母音が移り変わる）。
 * **既定を偽のままにしてあるのは、既存の素材を 1 ビットも変えないため。**
 * 種を固定してある意味が無くなり、記録に残した過去の数字と比べられなくなる。
 *
 * なお、`vowel` が偽のときのこの音は、発話中ずっと倍音の重みも f0 も変わらない。
 * **つまりスペクトルの形は動かず、トレモロのかかった楽器と同じ形をしている。**
 * 「声とは何か」を模した音としては、そこが抜けている。
 */
function speak(data, from, to, level, random, vowel = false) {
  const f0 = 120 + random() * 40;
  // 「あ」と「い」のつもりの倍音の重み。
  const shapes = [
    [1, 0.6, 0.35, 0.2],
    [1, 0.15, 0.7, 0.5],
  ];
  for (let i = Math.round(from * SR); i < Math.min(data.length, Math.round(to * SR)); i += 1) {
    const t = i / SR;
    const local = t - from;
    // 音節（1 秒に 4 つくらい）と、語尾に向かって落ちる包絡。
    const syllable = 0.55 + 0.45 * Math.sin(2 * Math.PI * 4.2 * local);
    const fade = Math.min(1, local / 0.05, (to - from - local) / 0.08);
    const env = level * syllable * Math.max(0, fade);
    if (vowel) {
      // 音節と同じ速さで、2 つの母音の間を行き来する。
      const blend = 0.5 + 0.5 * Math.sin(2 * Math.PI * 4.2 * local + Math.PI / 2);
      let v = 0;
      for (let h = 0; h < shapes[0].length; h += 1) {
        const weight = shapes[0][h] * (1 - blend) + shapes[1][h] * blend;
        v += weight * Math.sin(2 * Math.PI * f0 * (h + 1) * t);
      }
      data[i] += env * v * 0.28;
      continue;
    }
    data[i] +=
      env *
      (Math.sin(2 * Math.PI * f0 * t) +
        0.6 * Math.sin(2 * Math.PI * f0 * 2 * t) +
        0.35 * Math.sin(2 * Math.PI * f0 * 3 * t) +
        0.2 * Math.sin(2 * Math.PI * f0 * 5 * t)) *
      0.28;
  }
}

/**
 * 音楽らしい音。和音が一定の音量で鳴り続けるので、しきい値方式には手強い。
 *
 * `tremolo` に周波数を渡すと、その速さで音量を揺らす。
 * これは **わざと意地悪な素材** を作るためのもの。声らしさを
 * 「音程がある（tone）× 音節の速さで揺れる（modulation）」で測っているので、
 * 音程のある楽器を音節と同じ速さで震わせると、声が 1 つも無いのに
 * 声らしさが高く出てしまう。この抜け道を塞げているかを確かめるために要る。
 */
function music(data, from, to, level, tremolo = 0) {
  const chord = [220, 277.18, 329.63, 440];
  for (let i = Math.round(from * SR); i < Math.min(data.length, Math.round(to * SR)); i += 1) {
    const t = i / SR;
    // 2 秒周期で少し揺らして、まったくの定常にならないようにする。
    const swell = 0.85 + 0.15 * Math.sin(2 * Math.PI * 0.5 * t);
    // ビブラート気味に深く揺らす。声の音節（4.2Hz）と同じ帯域を狙う。
    const shake = tremolo ? 0.55 + 0.45 * Math.sin(2 * Math.PI * tremolo * t) : 1;
    let v = 0;
    for (const f of chord) v += Math.sin(2 * Math.PI * f * t);
    data[i] += (level * swell * shake * v) / chord.length;
  }
}

/**
 * 「フォルマントが動く楽器」。和音を倍音の多い音で鳴らし、
 * そこへ**声の音節と同じ速さで動く共鳴（フォルマント）**を掛ける。
 *
 * これは **わざと意地悪な素材** を作るためのもの。
 * 「スペクトルの形（包絡）が動いているか」で声を見分けようとすると、
 * 音量の揺れだけの `music-tremolo` は弾けるが、**包絡そのものが動く音**は弾けない。
 * 包絡の動きに賭ける手が本当に成り立つのかを確かめるには、
 * 「声でないのに包絡が動く音」が手元に無いと話にならない。
 *
 * 声と違うのは**音程が 2 つ同時に鳴っている**こと（和音なので基本周波数が 1 つに定まらない）。
 * そこが残された手がかりになるかどうかも、この素材で測れる。
 */
function wahChord(data, from, to, level, rate) {
  const chord = [220, 277.18];
  const period = 1 / rate;
  for (let i = Math.round(from * SR); i < Math.min(data.length, Math.round(to * SR)); i += 1) {
    const t = i / SR;
    // 2 秒ごとに 0.6 秒の休符を置く（フレーズの切れ目のつもり）。
    // 音量の幅が無いと、しきい値が「全編が鳴っている」に落ちて何も起きず、
    // 判定が破れていても被害が見えない。実害の出る形にしておく。
    if (t % 2 >= 1.4) continue;
    // 音節と同じ速さで「タタタタ」と音を置く。
    const local = t % period;
    const note = Math.min(1, local / 0.01, (period * 0.75 - local) / 0.03);
    if (note <= 0) continue;
    // 共鳴の中心を 400〜1600Hz の間で行き来させる（対数で動かす。人の口の動きに近い）。
    const center = Math.exp(Math.log(400) + (Math.log(1600) - Math.log(400)) * (0.5 + 0.5 * Math.sin(2 * Math.PI * rate * t)));
    let v = 0;
    let norm = 0;
    for (const f0 of chord) {
      for (let h = 1; h <= 12; h += 1) {
        const f = f0 * h;
        if (f > SR / 2) break;
        // 対数周波数での距離で共鳴の効きを決める（共鳴の幅は 1 オクターブ弱）。
        const d = Math.log(f / center) / 0.6;
        const gain = Math.exp(-d * d) / h;
        v += gain * Math.sin(2 * Math.PI * f * t);
        norm += gain;
      }
    }
    data[i] += norm > 0 ? (level * note * v) / norm : 0;
  }
}

/**
 * 和音が途中で変わる音楽。**わざと意地悪な素材**。
 *
 * 鳴りっぱなしの音楽はスペクトルの形が動かないので「どこかで形が動いたか」で弾けるが、
 * 和音が変わればそこで形は動く。本物の曲はたいてい和音が変わるので、
 * 「形がどこかで動いたら声がある」とみなす判定は、そこで破れるはず。破れ方を測るために要る。
 */
function chordProgression(data, from, to, level, everySeconds) {
  const progression = [
    [220, 277.18, 329.63],
    [246.94, 293.66, 369.99],
    [196, 246.94, 293.66],
    [174.61, 220, 261.63],
  ];
  for (let i = Math.round(from * SR); i < Math.min(data.length, Math.round(to * SR)); i += 1) {
    const t = i / SR;
    const chord = progression[Math.floor(t / everySeconds) % progression.length];
    const swell = 0.85 + 0.15 * Math.sin(2 * Math.PI * 0.5 * t);
    let v = 0;
    for (const f of chord) v += Math.sin(2 * Math.PI * f * t) + 0.4 * Math.sin(2 * Math.PI * f * 2 * t);
    data[i] += (level * swell * v) / (chord.length * 1.4);
  }
}

function noise(data, level, random) {
  for (let i = 0; i < data.length; i += 1) data[i] += (random() - 0.5) * 2 * level;
}

/**
 * 打楽器らしい音。指定した速さで「タッ」と鳴る。
 *
 * これは **わざと意地悪な素材** を作るためのもの。
 * 声を見分けるのに「音量が 1 秒に 3〜6 回くらい揺れているか」を見る手が有力だが、
 * それだと同じ速さで刻む音楽に引っかかる。引っかかることを確かめられなければ、
 * 「うまくいった」の中身が「自分に都合のいい素材で試しただけ」になってしまう。
 */
function drums(data, from, to, level, hitsPerSecond, random) {
  const period = SR / hitsPerSecond;
  for (let i = Math.round(from * SR); i < Math.min(data.length, Math.round(to * SR)); i += 1) {
    const sincePeak = i % period;
    // 立ち上がりが速く、80ms ほどで減衰する打撃音。
    const env = Math.exp(-sincePeak / (0.08 * SR));
    const t = i / SR;
    data[i] += level * env * ((random() - 0.5) * 1.2 + 0.6 * Math.sin(2 * Math.PI * 90 * t));
  }
}

function makeShort(
  name,
  {
    speech = true,
    sparse = false,
    bgm = false,
    bgmLevel = 0.12,
    bgmTremolo = 0,
    /** 声の音節と同じ速さで共鳴が動く楽器（Hz）。0 で鳴らさない。 */
    wah = 0,
    wahLevel = 0.3,
    /** 和音が何秒ごとに変わるか。0 で鳴らさない。 */
    chordEvery = 0,
    chordLevel = 0.25,
    beat = 0,
    beatLevel = 0.25,
    noiseLevel = 0.002,
    speechLevel = 0.5,
    vowel = false,
    seed = 1,
  },
) {
  const random = rng(seed);
  const data = new Float32Array(Math.round(SHORT_LENGTH * SR));
  noise(data, noiseLevel, random);
  if (bgm) music(data, 0, SHORT_LENGTH, bgmLevel, bgmTremolo);
  if (wah) wahChord(data, 0, SHORT_LENGTH, wahLevel, wah);
  if (chordEvery) chordProgression(data, 0, SHORT_LENGTH, chordLevel, chordEvery);
  if (beat) drums(data, 0, SHORT_LENGTH, beatLevel, beat, random);
  if (speech) {
    for (const [from, to] of sparse ? SPARSE_UTTERANCES : UTTERANCES)
      speak(data, from, to, speechLevel, random, vowel);
  }
  return writeWav(name, data);
}

fs.mkdirSync(OUT, { recursive: true });
console.log(`出力先: ${OUT}\n`);

// 何をどう作るかは spec.mjs にまとめてある（測る側からも同じものを参照するため）。
for (const fixture of SHORT_FIXTURES) {
  process.stdout.write(`${fixture.hard ? '※ ' : '  '}${fixture.note.padEnd(24, '　')} `);
  makeShort(fixture.name, fixture.options);
}
console.log('\n※ は、声を見分ける処理をいじめるために足した素材。');

if (process.argv.includes('long')) {
  // 長尺での処理時間とメモリを測るためのもの。10 分ぶん。
  const minutes = 10;
  const random = rng(9);
  const data = new Float32Array(Math.round(minutes * 60 * SR));
  noise(data, 0.002, random);
  for (let t = 0; t + 6 < minutes * 60; t += 6) {
    speak(data, t + 0.5, t + 2.2, 0.5, random);
    speak(data, t + 3.0, t + 5.0, 0.5, random);
  }
  writeWav('speech-long.wav', data);
}

console.log('\n完了。');
