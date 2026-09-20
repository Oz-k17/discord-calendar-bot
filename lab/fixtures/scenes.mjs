/**
 * 試し用の「映像」素材の正解。
 *
 * 音の側の `spec.mjs` と同じ役割で、**どこでカットが切り替わっているか**を
 * 作る側と測る側の両方から参照できるようにしてある。
 *
 * ## なぜ合成なのか、なぜファイルに書き出さないのか
 *
 * 音の素材は `lab/fixtures/out/` に .wav として書き出しているが、映像はしない。
 * 13 秒 × 15fps × 128×72 の RGBA で 1 本 7MB あり、12 本で 85MB になる。
 * そのうえ**本物の動画にするにはエンコーダが要る**（ラボに外部ライブラリは足さない方針）。
 * 種を固定した生成なら毎回 1 ビットまで同じものが出るので、
 * 「昨日の数字と今日の数字を並べる」という目的は書き出さなくても満たせる。
 * 本物の動画を読むのは画面側の仕事で、そこは `ImageData` を渡す入口だけ合わせてある。
 *
 * ## 正解の置き方
 *
 * `cuts` は**切り替わった瞬間の秒**。そのコマから新しい場面、という向きで書く。
 * ディゾルブのように渡りが連続していて途中に止まる所が無いものは、**渡り切る真ん中**。
 * フェード（黒へ落ちて黒から上がる）は、**黒が止まっている区間の両端**を 2 点で置く。
 * 分けているのは測ってからで、理由は `fade-black` の注に書いた。
 */

/** 素材の長さ（秒）と、コマの速さ。音の側の 13 秒に合わせてある。 */
export const SCENE_LENGTH = 13;
export const SCENE_FPS = 15;

/** 解析に渡すコマの大きさ。本物の動画を縮めて渡す想定なので、もとから小さい。 */
export const FRAME_WIDTH = 128;
export const FRAME_HEIGHT = 72;

/**
 * 素材の一覧。`hard` は「シーン検出をいじめるために足したもの」。
 *
 * 意地悪の向きは 2 つある。混ぜてあるのは、片方だけ見ていると
 * 「切りすぎ」と「切らなさすぎ」のどちらかに倒れたことに気づけないため。
 *   - **切らせたい所で切らない**（似た色どうしのカット・ディゾルブ）
 *   - **切ってほしくない所で切る**（パン・ズーム・手ぶれ・フラッシュ・被写体の横断）
 */
export const SCENE_FIXTURES = [
  {
    name: 'cuts-plain',
    note: '色も模様も違う 4 場面が切り替わる（いちばん素直）',
    cuts: [3.0, 6.0, 9.4],
    options: { seed: 101, shots: 4, cutsAt: [3.0, 6.0, 9.4] },
  },
  {
    name: 'cuts-rapid',
    note: '0.4 秒ごとに切り替わる（最短シーン長の扱いを見る）',
    cuts: rapidCuts(0.6, 0.4, 13.0),
    options: { seed: 102, cutsAt: rapidCuts(0.6, 0.4, 13.0) },
  },

  // ここから下は意地悪な素材。
  {
    name: 'cuts-similar',
    note: '同じ配色・同じ明るさのまま模様だけが変わるカット',
    hard: true,
    cuts: [4.0, 8.4],
    options: { seed: 103, cutsAt: [4.0, 8.4], samePalette: true },
  },
  {
    name: 'dissolve',
    note: '1 秒かけて次の場面へ溶ける（クロスディゾルブ）',
    hard: true,
    cuts: [6.4],
    options: { seed: 104, dissolve: { at: 6.4, seconds: 1.0 } },
  },
  {
    /**
     * 正解を 1 点（渡りの真ん中 6.4）から **2 点**へ直した（2026-09-20・4 回目）。
     *
     * 測ったら、検出は黒の**両端**（5.87 と 7.00）を正しく見つけていて、
     * 真ん中では何も起きていなかった。黒が 1 秒続くあいだ絵は動かないので、
     * ここには**止まっている区間が 1 つある**——つまり切り所は 2 つある。
     * ディゾルブと違って「渡りの真ん中」に当たるものが存在しない。
     * 1 点という置き方のほうが間違っていたので、正解の側を直してある。
     */
    name: 'fade-black',
    note: '黒へ落ちて、黒から上がる（間に 1 秒の黒）',
    hard: true,
    cuts: [5.9, 6.9],
    options: { seed: 105, fadeBlack: { at: 6.4, hold: 1.0, ramp: 0.5 } },
  },
  {
    name: 'pan',
    note: 'カメラが横に流れ続ける。カットは 1 つも無い',
    hard: true,
    cuts: [],
    options: { seed: 106, pan: 0.9 },
  },
  {
    /**
     * `pan` は帯が巡るので、画面へ入ってくる中身が**出ていった中身と同じ**だった。
     * 分布を見る手がそこで強く見えるのは、手の性質だけでなく素材の性質でもある。
     * こちらは 13 秒かけて一度も戻らない帯の上をパンするので、
     * **新しい中身が入ってくるぶんだけ分布も動く**。線の余裕がどれだけ残るかが出る。
     */
    name: 'pan-reveal',
    note: 'カメラが流れ続け、新しい景色が入ってくる（同じ絵は戻らない）',
    hard: true,
    cuts: [],
    options: { seed: 115, pan: 0.9, panReveal: true },
  },
  {
    name: 'zoom',
    note: '被写体へぐんぐん寄る。カットは 1 つも無い',
    hard: true,
    cuts: [],
    options: { seed: 107, zoom: 0.11 },
  },
  {
    name: 'handheld',
    note: '手持ちの揺れと粒状ノイズ。カットは 1 つも無い',
    hard: true,
    cuts: [],
    options: { seed: 108, shake: 0.02, grain: 0.05 },
  },
  {
    name: 'motion',
    note: '大きな被写体が画面を横切る。カットは 1 つも無い',
    hard: true,
    cuts: [],
    options: { seed: 109, crossing: true },
  },
  {
    name: 'flash',
    note: 'カメラのフラッシュが 3 回光る。カットは 1 つも無い',
    hard: true,
    cuts: [],
    options: { seed: 110, flashes: [2.6, 5.2, 9.8] },
  },
  {
    name: 'flash-cuts',
    note: 'フラッシュの光る現場で、場面も 2 回切り替わる',
    hard: true,
    cuts: [4.2, 8.8],
    options: { seed: 111, cutsAt: [4.2, 8.8], flashes: [2.6, 5.4, 10.6] },
  },
  {
    /**
     * `lumaHist` を既定に選んだ理由（パンに強い）を、そのまま裏返して潰すための素材。
     * 明るさの分布が 1 段も動かないカットなら、選んだ量は原理的に 0 しか返せない。
     * 色の分布（`rgbHist`）なら見えるはずなので、**既定の選び方が代価つきだったか**が出る。
     */
    name: 'cuts-samebright',
    note: '明るさの分布はそのまま、色だけが変わるカット',
    hard: true,
    cuts: [4.0, 8.4],
    options: { seed: 113, cutsAt: [4.0, 8.4], sameLuma: true },
  },
  {
    /**
     * またぐ幅（6 コマ = 0.4 秒）を潰すための素材。
     * 挟まる場面がまたぐ幅より短いと、門は**その場面を丸ごとまたいで**
     * 前後に同じ絵を見つけてしまう。フラッシュを落とす仕組みが、
     * そのまま短いインサートも落とすはず。
     */
    name: 'quick-insert',
    note: '0.33 秒の短いインサートが 2 回挟まる（本編は同じ場面）',
    hard: true,
    cuts: [4.0, 4.333, 8.0, 8.333],
    options: {
      seed: 114,
      cutsAt: [4.0, 4.333, 8.0, 8.333],
      shotOrder: [0, 1, 0, 2, 0],
    },
  },
  {
    name: 'dark-noise',
    note: '暗い場面でノイズだけが暴れる。カットは 1 つも無い',
    hard: true,
    cuts: [],
    options: { seed: 112, dark: true, grain: 0.09 },
  },
];

/** 等間隔のカットを並べる。手で書くと数え違えるので作らせる。 */
function rapidCuts(from, every, until) {
  const out = [];
  for (let t = from; t < until - 0.2; t += every) out.push(Number(t.toFixed(3)));
  return out;
}

/** 名前から引く。 */
export function sceneFixture(name) {
  const found = SCENE_FIXTURES.find((f) => f.name === name);
  if (!found) throw new Error(`素材 ${name} は一覧にありません`);
  return found;
}
