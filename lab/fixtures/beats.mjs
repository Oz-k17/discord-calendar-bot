/**
 * 試し用の「拍のある音」素材の正解。
 *
 * 音の側の `spec.mjs`、映像の側の `scenes.mjs` と同じ役割で、
 * **どこに拍があるか / テンポはいくつか**を作る側と測る側の両方から参照できるようにしてある。
 *
 * ## 正解は「拍の秒の並び」で持つ。BPM はそこから出す
 *
 * BPM だけを正解にすると、**テンポは当たっているのに拍が裏に乗っている**手を
 * 「当たり」と数えてしまう。曲に合わせてカットを置きたいのだから、
 * 要るのは「1 分に何拍か」ではなく「何秒の所に拍が来るか」のほう。
 * なので正解は秒の並び（`beats`）が本体で、`bpm` はその間隔から出した見出しにすぎない。
 *
 * 揺れのある素材（`jitter` / `swing`）では、**正解は鳴った所そのもの**に置いてある。
 * 人が合わせて手を叩くのは楽譜の上ではなく鳴った音のほうなので、
 * 「均等な格子」を正解にすると、正しく追えた手のほうが外れと数えられてしまう。
 *
 * ## ファイルには書き出さない
 *
 * `spec.mjs` の素材は `lab/fixtures/out/` に .wav として書き出しているが、こちらはしない。
 * 種を固定した生成なら毎回 1 ビットまで同じ音が出るので、数字を並べる目的はそれで足りる。
 * 映像の側（`scenes.mjs`）と同じ考え方で、呼ぶ側は `renderBeatFixture(name)` で
 * その場で作る（`make-beats.mjs`）。
 */

/**
 * 素材の長さ（秒）。
 *
 * ほかの素材は 13 秒だが、こちらだけ 16 秒にしてある。
 * **途中でテンポが変わる素材で、前半と後半をそれぞれ測れる長さが要る**ため
 * （13 秒だと後半が 6.5 秒しか無く、遅いテンポでは拍が 8 つしか入らない）。
 */
export const BEAT_LENGTH = 16;

/** 拍 1 つの秒数。 */
export const beatPeriod = (bpm) => 60 / bpm;

/**
 * 一定のテンポの拍を並べる。`phase` は最初の拍が来る秒。
 *
 * 頭を 0.00 秒にしていないのは、**素材の先頭にいきなり拍が来る形だけで試さない**ため。
 * 先頭合わせを前提にした手は、それだけで通ってしまう。
 */
function steadyBeats(bpm, phase, length = BEAT_LENGTH) {
  const period = beatPeriod(bpm);
  const out = [];
  for (let t = phase; t < length - 1e-9; t += period) out.push(Math.round(t * 1e6) / 1e6);
  return out;
}

/** 途中でテンポが変わる拍の並び。`changeAt` の直後の拍から新しい間隔になる。 */
function changingBeats(bpmA, bpmB, changeAt, phase, length = BEAT_LENGTH) {
  const out = [];
  let t = phase;
  while (t < length - 1e-9) {
    out.push(Math.round(t * 1e6) / 1e6);
    t += beatPeriod(t < changeAt ? bpmA : bpmB);
  }
  return out;
}

/**
 * だんだんテンポが変わる拍の並び（段ではなく坂）。
 *
 * **段で変わる素材だけで試さない**ために置いてある。窓ごとにテンポを出す手は
 * 「窓の中では一定」を仮定するので、段には強く、坂には弱いはず——
 * その見立てが当たっているかは測らないと分からない。
 */
function rampingBeats(bpmA, bpmB, phase, length = BEAT_LENGTH) {
  const out = [];
  let t = phase;
  while (t < length - 1e-9) {
    out.push(Math.round(t * 1e6) / 1e6);
    const u = Math.min(1, Math.max(0, (t - phase) / (length - phase)));
    t += beatPeriod(bpmA + (bpmB - bpmA) * u);
  }
  return out;
}

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
 * 人が叩いたようにずらした拍の並び。
 *
 * **ずらす前の格子ではなく、ずらした後を正解にする**（上の注のとおり）。
 * 幅の ±18ms は、合わせて叩いた人の典型的なばらつきくらい。
 */
function jitteredBeats(bpm, phase, spread, seed, length = BEAT_LENGTH) {
  const rnd = rng(seed);
  return steadyBeats(bpm, phase, length).map((t) => Math.round((t + (rnd() - 0.5) * 2 * spread) * 1e6) / 1e6);
}

/**
 * 素材の一覧。`hard` は「拍の検出をいじめるために足したもの」。
 *
 * 意地悪の向きは 3 つある。混ぜてあるのは、1 つだけ見ていると
 * 「そこだけ通る手」を掴んだことに気づけないため。
 *   - **テンポを取り違えさせる**（8 分のハットで倍に引く・遅い曲）
 *   - **拍の位置をずらさせる**（ウラだけ鳴る・ハネる・人が叩いた揺れ）
 *   - **そもそも拍が無い / 見えない**（打点の無い和音・雑音だけ・ほぼ無音）
 *   - **テンポが一定でない**（段で変わる・坂で変わる。2026-09-21・2 回目に増やした）
 *
 * `voices` の `at` は**小節の中の拍の位置**（拍単位、0 が小節頭）。
 * 0.5 なら裏拍、0.667 ならハネた 3 連の 2 つ目。
 *
 * `varying: true` は**素材まるごとで 1 つの BPM を答えようが無い素材**の印。
 * こういう素材で「BPM が当たったか」を数えると、正解の中央値をたまたま踏んだだけの
 * 手が当たりに見えてしまうので、`lab:beat` は BPM の勘定から外す（拍の F 値では数える）。
 *
 * `mute: [[from, to]]` はその秒の間だけ**打点を鳴らさない**（和音と声は鳴り続ける）。
 * 窓ごとにテンポを出す手に「手がかりの無い窓」を食わせるために足した。
 */
export const BEAT_FIXTURES = [
  {
    name: 'kick-120',
    note: 'キックだけの四つ打ち BPM 120（いちばん素直）',
    bpm: 120,
    beats: steadyBeats(120, 0.5),
    options: { seed: 201, meter: 4, voices: [{ kind: 'kick', at: [0, 1, 2, 3], level: 0.5 }] },
  },
  {
    name: 'band-100',
    note: 'キック・スネア・8 分ハットの伴奏 BPM 100',
    bpm: 100,
    beats: steadyBeats(100, 0.35),
    options: {
      seed: 202,
      meter: 4,
      voices: [
        { kind: 'kick', at: [0, 2], level: 0.5 },
        { kind: 'snare', at: [1, 3], level: 0.35 },
        { kind: 'hat', at: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5], level: 0.12 },
      ],
      pad: { every: 2, level: 0.08 },
    },
  },
  {
    name: 'fast-150',
    note: '速い伴奏 BPM 150',
    bpm: 150,
    beats: steadyBeats(150, 0.2),
    options: {
      seed: 203,
      meter: 4,
      voices: [
        { kind: 'kick', at: [0, 1.5, 2], level: 0.45 },
        { kind: 'snare', at: [1, 3], level: 0.35 },
        { kind: 'hat', at: [0.5, 1.5, 2.5, 3.5], level: 0.1 },
      ],
    },
  },
  {
    name: 'slow-72',
    note: 'ゆったりした曲 BPM 72（半分に取られやすい側）',
    bpm: 72,
    beats: steadyBeats(72, 0.6),
    options: {
      seed: 204,
      meter: 4,
      voices: [
        { kind: 'kick', at: [0, 2], level: 0.5 },
        { kind: 'snare', at: [1, 3], level: 0.3 },
      ],
      pad: { every: 4, level: 0.1 },
    },
  },

  // ここから下は意地悪な素材。
  {
    // **倍のテンポへ引く素材。** 拍そのものより 8 分のハットのほうが数が多く、
    // 自己相関の山は半分の周期に立つ。「いちばん高い山を選ぶ」手はここで 240 と答える。
    name: 'hats-8th-120',
    note: '8 分ハットが拍より目立つ BPM 120（倍に取られやすい）',
    hard: true,
    bpm: 120,
    beats: steadyBeats(120, 0.45),
    options: {
      seed: 205,
      meter: 4,
      voices: [
        { kind: 'kick', at: [0, 2], level: 0.3 },
        { kind: 'hat', at: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5], level: 0.3 },
      ],
    },
  },
  {
    // **位相を裏へ取らせる素材。オモテは数で、ウラは強さで勝つ。**
    //
    // 正解の置き方を 2 度直した素材（2026-09-21）。最初は「オモテには何も鳴らない」
    // 形にしたが、それは**正解の置き方のほうが間違っていた**——オモテに手がかりが
    // 1 つも無ければ人が聴いてもウラを拍に取るので、そこで「外れ」と数えるのは
    // 判定の落ち度ではない。次にオモテの 2・4 へ弱いスネアを置いたが、今度は
    // **強さを 1.3 倍まで上げても位相が動かなかった**。効いていたのは強さではなく
    // **打点の数**で（ウラ 4 つ対 オモテ 2 つ）、振っていたつまみが的を外していた。
    //
    // いまの形は、**オモテが数で勝ち、ウラが強さで勝つ**ように置いてある
    // （スネアが 4 拍すべてに 0.22、キックがウラ 4 か所すべてに 0.55）。
    // **キックをウラの 2 か所だけにする形も試したが、それだと 2 拍ごとの繰り返しができて
    // テンポのほうが半分に取られ（63.9）、位相の話を測れなくなる。**
    // 打点が半拍ごとに並ぶこの形なら、拍の間隔は曖昧でないまま位相だけを問える。
    // こうして初めて「強い所へ引かれるのか、数の多い所へ付くのか」を分けて測れる。
    // 人が聴けば、途切れずに並ぶスネアのほうを拍に取る。
    name: 'syncopated-128',
    note: 'ウラの打点のほうが強い BPM 128（数と強さが逆を向く）',
    hard: true,
    bpm: 128,
    beats: steadyBeats(128, 0.3),
    options: {
      seed: 206,
      meter: 4,
      voices: [
        { kind: 'snare', at: [0, 1, 2, 3], level: 0.22 },
        { kind: 'kick', at: [0.5, 1.5, 2.5, 3.5], level: 0.55 },
      ],
      pad: { every: 4, level: 0.16 },
    },
  },
  {
    // **打点そのものが無い素材。** 和音が拍ごとに変わるだけで、立ち上がりは鈍い。
    // 「鋭い立ち上がりを数える」手はここで何も見つけられない。
    name: 'pad-only-96',
    note: '打点が無く、和音が 1 拍ごとに変わるだけ BPM 96',
    hard: true,
    bpm: 96,
    beats: steadyBeats(96, 0.4),
    options: { seed: 207, meter: 4, voices: [], pad: { every: 1, level: 0.3, attack: 0.05 } },
  },
  {
    // **偽の打点を混ぜる素材。** 声の音節は 3〜6Hz で、BPM に直すと 180〜360。
    // 拍とは関係の無い所に立ち上がりが並ぶので、拍の列が濁る。
    name: 'speech-over-110',
    note: '伴奏の上で人がしゃべる BPM 110（声の音節が偽の打点になる）',
    hard: true,
    bpm: 110,
    beats: steadyBeats(110, 0.55),
    options: {
      seed: 208,
      meter: 4,
      voices: [
        { kind: 'kick', at: [0, 2], level: 0.4 },
        { kind: 'snare', at: [1, 3], level: 0.28 },
      ],
      speech: { level: 0.35 },
    },
  },
  {
    // **均等でない刻み。** 拍の間が 2 つに割れず 3 連で割れるので、
    // 裏の打点が 0.5 ではなく 0.667 に来る。均等を前提にした位相合わせが揺れる。
    name: 'swing-104',
    note: 'ハネた伴奏 BPM 104（裏が 3 連の 2 つ目に来る）',
    hard: true,
    bpm: 104,
    beats: steadyBeats(104, 0.45),
    options: {
      seed: 209,
      meter: 4,
      voices: [
        { kind: 'kick', at: [0, 2], level: 0.45 },
        { kind: 'snare', at: [1, 3], level: 0.3 },
        { kind: 'hat', at: [0, 0.667, 1, 1.667, 2, 2.667, 3, 3.667], level: 0.12 },
      ],
    },
  },
  {
    // **途中でテンポが変わる素材。** 素材まるごとで 1 つの BPM を出す手は、
    // ここで必ず外す（どちらか / 間のどこか になる）。**外し方を見るために置いてある。**
    name: 'tempo-change-90-120',
    note: '8 秒でテンポが 90 → 120 に変わる（一定を仮定する手の限界を見る）',
    hard: true,
    varying: true,
    bpm: null,
    beats: changingBeats(90, 120, 8, 0.4),
    options: {
      seed: 210,
      meter: 4,
      voices: [
        { kind: 'kick', at: [0, 2], level: 0.5 },
        { kind: 'snare', at: [1, 3], level: 0.32 },
      ],
    },
  },
  {
    // **逆向きに変わる素材**（2026-09-21・2 回目に追加）。
    // 段で変わる素材が 90 → 120 の 1 本しか無いと、**速くなる側でだけ効く手**を
    // 掴んだことに気づけない。遅くなる側は打点の数が減るので、
    // 窓ごとに測る手にとっては手がかりが薄いほうへ落ちる。
    name: 'tempo-change-120-90',
    note: '8 秒でテンポが 120 → 90 に変わる（速くなる側だけで試さない）',
    hard: true,
    varying: true,
    bpm: null,
    beats: changingBeats(120, 90, 8, 0.3),
    options: {
      seed: 216,
      meter: 4,
      voices: [
        { kind: 'kick', at: [0, 2], level: 0.5 },
        { kind: 'snare', at: [1, 3], level: 0.32 },
      ],
    },
  },
  {
    // **段ではなく坂**（2026-09-21・2 回目に追加）。
    // 窓ごとにテンポを出す手は「窓の中では一定」を仮定するので、
    // **坂では窓の中でも間隔が動く**。段だけで試すと、その仮定の代価が見えない。
    // 100 → 130 は 16 秒で 1.3 倍なので、8 秒の窓の中でも 0.9 倍ほど動く。
    name: 'tempo-ramp-100-130',
    note: 'だんだん速くなる 100 → 130（段ではなく坂。窓の中でも間隔が動く）',
    hard: true,
    varying: true,
    bpm: null,
    beats: rampingBeats(100, 130, 0.45),
    options: {
      seed: 217,
      meter: 4,
      voices: [
        { kind: 'kick', at: [0, 2], level: 0.5 },
        { kind: 'snare', at: [1, 3], level: 0.32 },
        { kind: 'hat', at: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5], level: 0.12 },
      ],
    },
  },
  {
    // **テンポは一定だが、途中で打点が止まる素材**（2026-09-21・2 回目に追加）。
    // **窓ごとにテンポを出す手を潰すために置いた。** 6.0〜10.0 秒は和音だけになるので、
    // その中に丸ごと入る窓は打点を 1 つも見ない。一定を仮定する手はここで何も失わないが、
    // 窓ごとに測る手は**手がかりの無い窓で迷子になる**（迷子になったぶんを
    // そのまま拍の位置へ流してしまうと、前後の合っていた所まで道連れになる）。
    //
    // 正解の拍は**ブレイク中も途切れずに置いてある**。和音が 4 拍ごとに変わるので、
    // 小節の頭だけは素材の中に手がかりが残っている（`syncopated-128` で学んだ
    // 「正解と呼ぶ根拠が素材の中にあるか」の条件を、ここでも満たしてある）。
    name: 'break-116',
    note: '一定の BPM 116 だが 6〜10 秒は打点が止まる（窓ごとに測る手を潰す）',
    hard: true,
    bpm: 116,
    beats: steadyBeats(116, 0.35),
    options: {
      seed: 218,
      meter: 4,
      voices: [
        { kind: 'kick', at: [0, 2], level: 0.5 },
        { kind: 'snare', at: [1, 3], level: 0.32 },
        { kind: 'hat', at: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5], level: 0.12 },
      ],
      pad: { every: 4, level: 0.12 },
      mute: [[6.0, 10.0]],
    },
  },
  {
    // **人が叩いた揺れ。** 打ち込みは 1ms も狂わないので、それだけで試すと
    // 「格子に当てはめる」手が実力以上に見える。
    name: 'jitter-118',
    note: '人が叩いたように ±18ms 揺れる BPM 118',
    hard: true,
    bpm: 118,
    beats: jitteredBeats(118, 0.5, 0.018, 4211),
    options: {
      seed: 211,
      meter: 4,
      voices: [
        { kind: 'kick', at: [0, 2], level: 0.5 },
        { kind: 'snare', at: [1, 3], level: 0.32 },
      ],
      followBeats: true,
    },
  },
  {
    // **3 拍子。** 4 拍子を前提にした重み付け（小節の頭を強く見るなど）が
    // 入っていないかを見る。
    name: 'waltz-150',
    note: '3 拍子 BPM 150（4 拍子を前提にしていないか）',
    hard: true,
    bpm: 150,
    beats: steadyBeats(150, 0.3),
    options: {
      seed: 212,
      meter: 3,
      voices: [
        { kind: 'kick', at: [0], level: 0.5 },
        { kind: 'snare', at: [1, 2], level: 0.22 },
      ],
      pad: { every: 3, level: 0.1 },
    },
  },
  {
    // **小さく録れた素材。** 絶対値で線を引いていないかを見る。
    // 中身は `band-100` と 1 ビット違わず、掛けた倍率だけが違う。
    name: 'quiet-124',
    note: '録音レベルが小さい BPM 124（絶対値で線を引いていないか）',
    hard: true,
    bpm: 124,
    beats: steadyBeats(124, 0.4),
    options: {
      seed: 213,
      meter: 4,
      voices: [
        { kind: 'kick', at: [0, 2], level: 0.5 },
        { kind: 'snare', at: [1, 3], level: 0.32 },
        { kind: 'hat', at: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5], level: 0.12 },
      ],
      gain: 0.04,
    },
  },
  {
    // **拍が無い素材。** 何かを答えてしまう手ではなく、
    // 「無い」と言える手が要る。正解の拍は空。
    name: 'noise-only',
    note: '雑音だけ（拍は無い。「無い」と言えるか）',
    hard: true,
    bpm: null,
    beats: [],
    options: { seed: 214, meter: 4, voices: [], noiseLevel: 0.05 },
  },
  {
    // **ほぼ無音。** 0 で割る・空の配列を触る、といった所で落ちないかを見る。
    name: 'near-silence',
    note: 'ほぼ無音（壊れずに「無い」と言えるか）',
    hard: true,
    bpm: null,
    beats: [],
    options: { seed: 215, meter: 4, voices: [], noiseLevel: 0.00002 },
  },
];

/** 名前から素材を引く。無ければ投げる（名前の打ち間違いを黙って通さない）。 */
export function beatFixture(name) {
  const found = BEAT_FIXTURES.find((f) => f.name === name);
  if (!found) throw new Error(`そんな素材はありません: ${name}（${BEAT_FIXTURES.map((f) => f.name).join(', ')}）`);
  return found;
}

/**
 * 正解の拍の間隔から出した BPM（中央値）。
 *
 * テンポが変わる素材では「前半と後半のどちらか」しか当たらないので、
 * こちらは見出しとしてだけ使う。判定の当たり外れは `beats` と突き合わせて決める。
 *
 * **`varying` の素材では、この値を「当たり／外れ」の基準に使わないこと。**
 * 90 → 120 の素材の中央値はたまたま 120 で、一定を仮定する手が後半に合わせると
 * 「BPM は当たり・拍は 3 分の 1 しか合っていない」という読み方になる。
 * 2026-09-21（1 回目）の 13/13 はその形で 1 本ぶん甘く数えていた。
 */
export function truthBpm(fixture) {
  const beats = fixture.beats;
  if (beats.length < 2) return null;
  const gaps = [];
  for (let i = 1; i < beats.length; i += 1) gaps.push(beats[i] - beats[i - 1]);
  gaps.sort((a, b) => a - b);
  const mid = gaps[Math.floor(gaps.length / 2)];
  return mid > 0 ? 60 / mid : null;
}
