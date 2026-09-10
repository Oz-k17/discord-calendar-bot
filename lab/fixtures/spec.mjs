/**
 * 試し用素材の「正解」。
 *
 * どこでしゃべっているかを作る側と測る側の両方から参照できるようにしておく。
 * 正解が分かっていれば、「この特徴量は声とそれ以外をどれくらい分けられるか」を
 * 当てずっぽうではなく数字で比べられる。
 */

export const SHORT_LENGTH = 13;

/**
 * まばらな発話（秒）。BGM の上でたまにしゃべるだけ、という素材のため。
 * 13 秒のうち 2.6 秒しかしゃべらない（20%）。
 */
export const SPARSE_UTTERANCES = [
  [2.0, 3.4],
  [9.0, 10.2],
];

/** 発話の並び（秒）。息継ぎ（0.2 秒）と間（0.7〜1.2 秒）を混ぜてある。 */
export const UTTERANCES = [
  [1.0, 2.2],
  [2.9, 4.4],
  [4.6, 5.4],
  [6.6, 8.0],
  [8.2, 8.9],
  [10.0, 11.6],
];

/**
 * 短いほうの素材の一覧。`hard` は「声を見分ける処理をいじめるために足したもの」。
 * options はそのまま make-audio.mjs の makeShort へ渡る。
 */
export const SHORT_FIXTURES = [
  { name: 'speech.wav', note: 'きれいに録れた声', speech: true, options: { seed: 1 } },
  { name: 'speech-bgm.wav', note: 'BGM 込みで録った', speech: true, options: { bgm: true, seed: 2 } },
  { name: 'speech-noisy.wav', note: '部屋のノイズが大きい', speech: true, options: { noiseLevel: 0.02, seed: 3 } },
  {
    name: 'speech-quiet.wav',
    note: '録音レベルが小さい',
    speech: true,
    options: { speechLevel: 0.06, noiseLevel: 0.0006, seed: 4 },
  },
  { name: 'bgm.wav', note: '音楽だけ', speech: false, options: { speech: false, bgm: true, noiseLevel: 0.0005, seed: 5 } },

  // ここから下は意地悪な素材。「うまくいった」が素材のおかげでないことを確かめるためのもの。
  {
    name: 'speech-bgm-loud.wav',
    note: 'BGM が大きい（音量では分けられない）',
    speech: true,
    hard: true,
    options: { bgm: true, bgmLevel: 0.4, seed: 6 },
  },
  {
    name: 'speech-drums.wav',
    note: '1 秒に 4 回刻む打楽器の上でしゃべる',
    speech: true,
    hard: true,
    options: { beat: 4, seed: 7 },
  },
  {
    name: 'drums.wav',
    note: 'その打楽器だけ（声は無い）',
    speech: false,
    hard: true,
    options: { speech: false, beat: 4, noiseLevel: 0.0005, seed: 8 },
  },
  {
    name: 'music-tremolo.wav',
    note: '声と同じ速さで震える楽器だけ（声は無い）',
    speech: false,
    hard: true,
    options: { speech: false, bgm: true, bgmLevel: 0.3, bgmTremolo: 4.5, noiseLevel: 0.0005, seed: 10 },
  },
  {
    // 「形の変化」で判定する手を潰しにいく素材。背景がほとんど無いので、
    // 声が背景と混ざる効果に頼っていると、ここで声を見失う。
    name: 'speech-dry.wav',
    note: '背景がほぼ無い、乾いた声だけ',
    speech: true,
    hard: true,
    options: { noiseLevel: 0.00002, seed: 11 },
  },
  {
    // 上と同じ乾いた録音だが、声が母音を移り変わらせる（本物の声に近い）。
    // 上で見失うのが「乾いているから」なのか「声の作りが平板だから」なのかを分ける。
    name: 'speech-dry-vowel.wav',
    note: '乾いた声だけ・母音が移り変わる',
    speech: true,
    hard: true,
    options: { noiseLevel: 0.00002, vowel: true, seed: 12 },
  },
  {
    name: 'speech-sparse-bgm.wav',
    note: 'BGM の上でたまにしゃべるだけ（20%）',
    speech: true,
    sparse: true,
    hard: true,
    options: { bgm: true, bgmLevel: 0.25, sparse: true, seed: 9 },
  },
];

/** その素材の発話の並び。 */
export function utterancesOf(fixture) {
  if (!fixture.speech) return [];
  return fixture.sparse ? SPARSE_UTTERANCES : UTTERANCES;
}

/** 時刻が発話の中かどうか。声の無い素材は常に false。 */
export function isSpeechAt(fixture, seconds) {
  return utterancesOf(fixture).some(([from, to]) => seconds >= from && seconds < to);
}
