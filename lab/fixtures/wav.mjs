/**
 * 16bit PCM の WAV を読んで、AudioBuffer と同じ形にする。
 *
 * ブラウザなら decodeAudioData で済むが、コマンドラインから測るときに
 * ブラウザを立ち上げるのは大げさなので、自前で読む。
 * 対応するのは make-audio.mjs が書き出す形式だけ（16bit PCM）。
 */

import fs from 'node:fs';

export function readWav(file) {
  const buf = fs.readFileSync(file);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`${file} は WAV ではありません`);
  }

  let sampleRate = 44100;
  let channels = 1;
  let bits = 16;
  let data = null;

  // チャンクを順に辿る。fmt と data の位置は決め打ちにできない。
  let at = 12;
  while (at + 8 <= buf.length) {
    const id = buf.toString('ascii', at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    const body = at + 8;
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4);
      bits = buf.readUInt16LE(body + 14);
    } else if (id === 'data') {
      data = buf.subarray(body, body + size);
    }
    at = body + size + (size % 2);
  }

  if (!data) throw new Error(`${file} に data チャンクがありません`);
  if (bits !== 16) throw new Error(`${file} は 16bit ではありません（${bits}bit）`);

  const frames = Math.floor(data.length / 2 / channels);
  const planes = [];
  for (let c = 0; c < channels; c += 1) planes.push(new Float32Array(frames));
  for (let i = 0; i < frames; i += 1) {
    for (let c = 0; c < channels; c += 1) {
      planes[c][i] = data.readInt16LE((i * channels + c) * 2) / 32768;
    }
  }

  return {
    sampleRate,
    numberOfChannels: channels,
    length: frames,
    duration: frames / sampleRate,
    getChannelData: (c) => planes[c],
  };
}
