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
 */
function speak(data, from, to, level, random) {
  const f0 = 120 + random() * 40;
  for (let i = Math.round(from * SR); i < Math.min(data.length, Math.round(to * SR)); i += 1) {
    const t = i / SR;
    const local = t - from;
    // 音節（1 秒に 4 つくらい）と、語尾に向かって落ちる包絡。
    const syllable = 0.55 + 0.45 * Math.sin(2 * Math.PI * 4.2 * local);
    const fade = Math.min(1, local / 0.05, (to - from - local) / 0.08);
    const env = level * syllable * Math.max(0, fade);
    data[i] +=
      env *
      (Math.sin(2 * Math.PI * f0 * t) +
        0.6 * Math.sin(2 * Math.PI * f0 * 2 * t) +
        0.35 * Math.sin(2 * Math.PI * f0 * 3 * t) +
        0.2 * Math.sin(2 * Math.PI * f0 * 5 * t)) *
      0.28;
  }
}

/** 音楽らしい音。和音が一定の音量で鳴り続けるので、しきい値方式には手強い。 */
function music(data, from, to, level) {
  const chord = [220, 277.18, 329.63, 440];
  for (let i = Math.round(from * SR); i < Math.min(data.length, Math.round(to * SR)); i += 1) {
    const t = i / SR;
    // 2 秒周期で少し揺らして、まったくの定常にならないようにする。
    const swell = 0.85 + 0.15 * Math.sin(2 * Math.PI * 0.5 * t);
    let v = 0;
    for (const f of chord) v += Math.sin(2 * Math.PI * f * t);
    data[i] += (level * swell * v) / chord.length;
  }
}

function noise(data, level, random) {
  for (let i = 0; i < data.length; i += 1) data[i] += (random() - 0.5) * 2 * level;
}

/** 発話の並び。息継ぎ（0.2 秒）と間（0.7〜1.2 秒）を混ぜてある。 */
const UTTERANCES = [
  [1.0, 2.2],
  [2.9, 4.4],
  [4.6, 5.4],
  [6.6, 8.0],
  [8.2, 8.9],
  [10.0, 11.6],
];
const SHORT_LENGTH = 13;

function makeShort(name, { speech = true, bgm = false, noiseLevel = 0.002, speechLevel = 0.5, seed = 1 }) {
  const random = rng(seed);
  const data = new Float32Array(Math.round(SHORT_LENGTH * SR));
  noise(data, noiseLevel, random);
  if (bgm) music(data, 0, SHORT_LENGTH, 0.12);
  if (speech) for (const [from, to] of UTTERANCES) speak(data, from, to, speechLevel, random);
  return writeWav(name, data);
}

fs.mkdirSync(OUT, { recursive: true });
console.log(`出力先: ${OUT}\n`);

// 基準。きれいに録れた声。
makeShort('speech.wav', { seed: 1 });
// いまのしきい値方式が苦手な素材。BGM 込みで録ってしまった場合。
makeShort('speech-bgm.wav', { bgm: true, seed: 2 });
// 部屋のノイズが大きい。しきい値がノイズに引っ張られないかを見る。
makeShort('speech-noisy.wav', { noiseLevel: 0.02, seed: 3 });
// 録音レベルが小さい。固定しきい値なら何も残らないはずの素材。
makeShort('speech-quiet.wav', { speechLevel: 0.06, noiseLevel: 0.0006, seed: 4 });
// ダッキングの相手。
makeShort('bgm.wav', { speech: false, bgm: true, noiseLevel: 0.0005, seed: 5 });

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
