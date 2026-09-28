/**
 * クリップごとの音量を、互いに揃える。
 *
 * `lufs.ts` が「タイムライン全体をどれくらいの大きさで出すか」を決めるのに対して、
 * こちらは**その中でクリップどうしの大きさを揃える**。別撮りのカットを並べたとき、
 * 1 本ごとにマイクとの距離も録音レベルも違うので、**全体の倍率をいくら正しく決めても
 * カットが変わるたびに音量が跳ねる。** そこを先に潰しておくための処理。
 *
 * 順番は必ず「クリップごとに揃える → 繋ぐ → 全体を目標へ（`lufs.ts`）→ 均す（`limiter.ts`）」。
 * 逆にすると、全体の倍率をクリップごとのばらつきが決めてしまう。
 *
 * ここが決めるのは**倍率だけ**（音は作らない）。当てた音が要るのは検算と試聴のときだけなので、
 * それは `applyClipGains` に分けてある。DOM にも WebAudio にも依存しない。
 *
 * ## 測る場所について（2026-09-20・2 回目に測って決めた）
 *
 * 「クリップ全体で測る」のと「自動カットが残した区間だけで測る」のを、
 * 発話区間の正解（`spec.mjs`）と突き合わせて比べた。揃えたあとに残る**声**のずれは
 * **全体 2.21 LU 対 残した区間 2.14 LU で、0.07 LU しか違わない。**
 * カットの結果を持ってくると `clip-match` が `silence.ts` に依存することになるが、
 * **その代価に見合う差が出なかった**ので、ここはクリップ全体を測る。
 * （区間を指定したいときのために `concatRanges` は置いてある。使うかは呼ぶ側の判断。）
 */

import type { AudioLike } from './loudness.ts';
import type { ClipEdit } from './edits.ts';
import { measureLoudness, type LoudnessMeasurement, type LoudnessOptions } from './lufs.ts';

/** 揃える対象 1 本。`group` が同じものは**ひとまとめに測って、同じ倍率を当てる**。 */
export interface ClipSource {
  /** 表示用の名前。`group` を省いたときはこれが群の鍵になる。 */
  id: string;
  buffer: AudioLike;
  /**
   * 同じ撮影から切り出したもの同士をまとめる鍵。
   *
   * **自動カットが 1 本の素材を刻んだ「かけら」には、必ず同じ鍵を渡すこと。**
   * かけらごとに別の倍率を当てると、切れ目のたびに部屋の音が段になる。
   * しかも揃えて得られるものが無い——同じ撮影の中でのかけらどうしの開きは
   * 測ったところ **0.03〜1.68 LU** しかなく（2026-09-20・2 回目）、
   * そこに残っているのは揃えるべきばらつきではなく**しゃべり方の抑揚**のほう。
   */
  group?: string;
}

/** 1 本（または 1 群）の測定結果。 */
export interface ClipLoudness {
  id: string;
  group: string;
  /** ラウドネス（LUFS）。ゲートを通る窓が無ければ null。 */
  lufs: number | null;
  /** 尺（秒）。基準を決めるときの重みになる。 */
  duration: number;
  /** ゲートを通った 0.4 秒窓の数。群をまとめるときの重みに使う。 */
  gatedBlocks: number;
  /** 測るのに使った生の結果（真のピークなどを見たいとき用）。群をまとめた行では null。 */
  measurement: LoudnessMeasurement | null;
}

export interface ClipMatchOptions {
  /**
   * 何に合わせるか。
   * - `median`（既定）… クリップの**尺で重みを付けた中央値**。外れ値に引きずられない。
   * - `mean` … 尺で重みを付けた平均（パワーで平均するので、繋いで測った値とほぼ同じ）。
   * - `loudest` … いちばん大きいクリップ。
   * - 数値 … その LUFS を直に基準にする。
   *
   * **既定が中央値なのは、平均が外れ値 1 本で動くから。** ただし
   * **引きずるのは静かな外れ値ではなく、大きいほうだった**（2026-09-20・2 回目に測って、
   * 書く前の見込みが外れた）。43 本から 1 本抜いたときに基準が動く幅は:
   *
   * | 抜いたもの | median | mean | loudest |
   * | --- | --- | --- | --- |
   * | `room-tone`（-49.1 LUFS・静かな外れ値） | 0.00 | 0.10 | 0.00 |
   * | `speech-loud-clipped`（-4.7 LUFS・大きい外れ値） | -0.06 | **-1.86** | **-6.14** |
   *
   * パワーで平均する以上、**30dB 下の 1 本は和にほとんど足されない**（0.1% 未満）。
   * 一方で 15dB 上の 1 本は和の 3 割を持っていく。
   * 「声の無いクリップが混じると平均が下がる」は、**dB の見かけから来る思い込み**だった。
   *
   * **ただし中央値が守ってくれるのは「まともなクリップが過半数」のときだけ。**
   * 3 本のうち 2 本が外れ値だと、**中央値そのものが外れ値に乗る**
   * （画面の検算で踏んだ。ふつうの声 1 本・小さい声 1 本・部屋の音 1 本を並べたら、
   * 基準が小さい声になってふつうの声が 18dB 下げられた）。
   * **どの基準を選んでも同じで、直す手は無い。** 見分けが要るので、凍結した壁と同じ。
   * 代わりに「半分以上が上限に当たったら基準のほうを疑う」を画面から知らせている。
   */
  reference?: 'median' | 'mean' | 'loudest' | number;
  /**
   * 上げてよい上限（dB）。既定 12。
   *
   * **下げる側より狭いのは、上げる側にだけ代価があるから。** 持ち上げれば部屋鳴りも
   * ヒスも一緒に上がるが、下げるほうは何も増えない。
   * そして上限がいちばん効くのは**声の入っていないクリップ**で、そこは素直に揃えにいくと
   * 30dB 以上持ち上げる（`room-tone.wav` は -49.1 LUFS）。
   * **「声の入っていないクリップ」を見分ける手は無い**（見分けの追い込みは 2026-09-19 に凍結）。
   * なので上限で被害を止め、当たったことを `limitedBy: 'cap'` で外へ出す。
   */
  maxBoostDb?: number;
  /** 下げてよい上限（dB）。既定 24。 */
  maxCutDb?: number;
  /**
   * これより短いクリップは測らずに 0dB のままにする（秒）。既定 0.4。
   *
   * 0.4 秒は LUFS の窓 1 つぶん。**これを下回ると窓が 1 つも立たないので、
   * `measureLoudness` は null を返す**（＝どのみち測れない）。そのぶん
   * **この線の判定は `lufs === null` より先に置いてある**（順番が逆だと、短いクリップが
   * 「測れなかった」に落ちて、見た人が録音の失敗を疑いにいってしまう）。
   * 窓が 1〜2 個しか立たない長さでも値は暴れるので、そこは `minGatedBlocks` で見る。
   */
  minDuration?: number;
  /**
   * 倍率を当てるのに必要な窓の数。既定 4（＝ 0.4 秒窓が 4 つ＝実質 0.7 秒ぶん）。
   *
   * **短いクリップを無理に揃えないための線。** 相づち 1 つぶんのクリップは、
   * 中身が「あ」だけなので測った値が素材の大きさを表さない。
   */
  minGatedBlocks?: number;
}

export const DEFAULT_CLIP_MATCH: Required<Omit<ClipMatchOptions, 'reference'>> & {
  reference: NonNullable<ClipMatchOptions['reference']>;
} = {
  reference: 'median',
  maxBoostDb: 12,
  maxCutDb: 24,
  minDuration: 0.4,
  minGatedBlocks: 4,
};

/** 1 本ぶんの結果。 */
export interface ClipGain {
  id: string;
  group: string;
  gain: number;
  gainDb: number;
  /** 測った値（群の値）。 */
  lufs: number | null;
  /** 当てたあとのラウドネス（LUFS）。上限に当たったならここが基準からずれる。 */
  resultLufs: number | null;
  /**
   * 何に止められたか。
   * - `none` … 基準ちょうどに揃った
   * - `cap` … 上限に当たった（**中身を確かめたほうがよい印**。声の無いクリップはここに出る）
   * - `tooShort` … 短すぎるので触らなかった
   * - `unmeasurable` … ゲートを通る窓が無く測れなかった（無音のクリップなど）
   */
  limitedBy: 'none' | 'cap' | 'tooShort' | 'unmeasurable';
  /** 上限が無ければ当てていた倍率（dB）。`cap` のときだけ `gainDb` と食い違う。 */
  wantedDb: number;
}

export interface ClipMatchPlan {
  /** 合わせにいった値（LUFS）。測れるクリップが 1 本も無ければ null。 */
  referenceLufs: number | null;
  gains: ClipGain[];
  /** 揃える前のクリップどうしの開き（LU）。測れたものだけで見る。 */
  spreadBefore: number;
  /** 揃えたあとの開き（LU）。上限に当たったクリップが残るので 0 にはならないことがある。 */
  spreadAfter: number;
}

/** 区間の並びを繋いだ音を作る（測る場所を絞りたいとき用）。範囲外と長さ 0 は落とす。 */
export function concatRanges(buffer: AudioLike, ranges: { start: number; end: number }[]): AudioLike | null {
  const sr = buffer.sampleRate;
  const spans: [number, number][] = [];
  for (const r of ranges) {
    const from = Math.max(0, Math.min(buffer.length, Math.round(r.start * sr)));
    const to = Math.max(0, Math.min(buffer.length, Math.round(r.end * sr)));
    if (to > from) spans.push([from, to]);
  }
  const total = spans.reduce((sum, [a, b]) => sum + (b - a), 0);
  if (total === 0) return null;

  const planes: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c += 1) {
    const src = buffer.getChannelData(c);
    const out = new Float32Array(total);
    let k = 0;
    for (const [a, b] of spans) for (let i = a; i < b; i += 1) out[k++] = src[i];
    planes.push(out);
  }
  return {
    sampleRate: sr,
    numberOfChannels: buffer.numberOfChannels,
    length: total,
    getChannelData: (c: number) => planes[c],
  };
}

/** LUFS ↔ パワー。群をまとめるときに「dB のまま足さない」ためだけに要る。 */
const toPower = (lufs: number) => Math.pow(10, (lufs + 0.691) / 10);
const fromPower = (power: number) => (power > 0 ? -0.691 + 10 * Math.log10(power) : null);

/** クリップを 1 本ずつ測る。 */
export function measureClips(clips: ClipSource[], options: LoudnessOptions = {}): ClipLoudness[] {
  return clips.map((clip) => {
    const m = measureLoudness(clip.buffer, options);
    return {
      id: clip.id,
      group: clip.group ?? clip.id,
      lufs: m.integratedLufs,
      duration: clip.buffer.length / clip.buffer.sampleRate,
      gatedBlocks: m.gatedBlocks,
      measurement: m,
    };
  });
}

/**
 * すでに測ってある結果から `ClipLoudness` を組む。
 *
 * 画面のように**読み込んだときに 1 回だけ測る**作りだと、揃えるたびに測り直すのは無駄
 * （13 秒で 1 秒近くかかる）。ラウドネスも真のピークも基準には依らないので、
 * 測り直す必要があるのは素材そのものが変わったときだけ。
 */
export function clipLoudnessFrom(
  id: string,
  measurement: LoudnessMeasurement,
  group = id,
): ClipLoudness {
  return {
    id,
    group,
    lufs: measurement.integratedLufs,
    duration: measurement.duration,
    gatedBlocks: measurement.gatedBlocks,
    measurement,
  };
}

/**
 * 同じ群のクリップを 1 つの値にまとめる。
 *
 * **dB のまま平均してはいけない**ので、パワーへ戻し、ゲートを通った窓の数で重みを付けて平均する
 * （＝その群を繋いで測り直したのとほぼ同じ値になる。どれだけ同じかは検算で押さえてある）。
 * 完全に同じにならないのは、2 段目のゲートが群ぜんたいの平均から引き直されるため。
 */
export function groupClips(measured: ClipLoudness[]): ClipLoudness[] {
  const order: string[] = [];
  const byGroup = new Map<string, ClipLoudness[]>();
  for (const m of measured) {
    if (!byGroup.has(m.group)) {
      byGroup.set(m.group, []);
      order.push(m.group);
    }
    byGroup.get(m.group)!.push(m);
  }

  return order.map((group) => {
    const members = byGroup.get(group)!;
    const duration = members.reduce((sum, m) => sum + m.duration, 0);
    const gatedBlocks = members.reduce((sum, m) => sum + m.gatedBlocks, 0);
    let power = 0;
    for (const m of members) {
      if (m.lufs === null || m.gatedBlocks <= 0) continue;
      power += toPower(m.lufs) * m.gatedBlocks;
    }
    return {
      id: members.length === 1 ? members[0].id : `${group}（${members.length} 本）`,
      group,
      lufs: gatedBlocks > 0 ? fromPower(power / gatedBlocks) : null,
      duration,
      gatedBlocks,
      // 群としての真のピークは「members の最大」だが、いまそれを使う場面が無いので持たない。
      measurement: members.length === 1 ? members[0].measurement : null,
    };
  });
}

/** 重み付きの中央値。重みの合計の半分を跨いだところの値を返す。 */
function weightedMedian(values: { value: number; weight: number }[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a.value - b.value);
  const total = sorted.reduce((sum, v) => sum + v.weight, 0);
  // 重みが全部 0 のときは重みの無い中央値へ落とす（尺 0 のクリップだけ、という形）。
  if (total <= 0) return sorted[Math.floor((sorted.length - 1) / 2)].value;
  let acc = 0;
  for (const v of sorted) {
    acc += v.weight;
    if (acc >= total / 2) return v.value;
  }
  return sorted[sorted.length - 1].value;
}

/**
 * 測った結果から、クリップごとの倍率を決める。
 *
 * **群ごとに 1 つの倍率**を決めて、その群のクリップ全部に同じものを配る。
 * 触らないと決めたクリップ（短すぎる・測れない）は 0dB で、理由が `limitedBy` に出る。
 *
 * ここで絶対の目標（-14 LUFS など）へ合わせないのは、そこは `lufs.ts` の仕事だから。
 * **こちらは「互いに揃える」だけに閉じている**ので、あとから目標を変えても
 * クリップどうしの関係は変わらない。
 */
export function planClipMatch(measured: ClipLoudness[], options: ClipMatchOptions = {}): ClipMatchPlan {
  const opts = { ...DEFAULT_CLIP_MATCH, ...options };
  const grouped = groupClips(measured);

  // 基準を決めるのに数えてよいのは「触る対象になる群」だけ。
  // 短すぎる群や測れない群を数えると、基準そのものが引きずられる。
  const usable = grouped.filter(
    (g) => g.lufs !== null && g.duration >= opts.minDuration && g.gatedBlocks >= opts.minGatedBlocks,
  );

  let referenceLufs: number | null = null;
  if (typeof opts.reference === 'number') {
    referenceLufs = opts.reference;
  } else if (usable.length > 0) {
    if (opts.reference === 'loudest') {
      referenceLufs = Math.max(...usable.map((g) => g.lufs as number));
    } else if (opts.reference === 'mean') {
      const totalWeight = usable.reduce((sum, g) => sum + g.duration, 0);
      let power = 0;
      for (const g of usable) power += toPower(g.lufs as number) * g.duration;
      referenceLufs = totalWeight > 0 ? fromPower(power / totalWeight) : null;
    } else {
      referenceLufs = weightedMedian(usable.map((g) => ({ value: g.lufs as number, weight: g.duration })));
    }
  }

  // 群ごとに倍率を決めてから、メンバーへ配る。
  const perGroup = new Map<string, { gainDb: number; wantedDb: number; limitedBy: ClipGain['limitedBy']; lufs: number | null }>();
  for (const g of grouped) {
    // **順番に意味がある。** 3 つの理由は重なって立つので、
    // 「見た人が次にすることが違う」順に並べてある（検算で 2 回踏んだ）。
    //   ① 尺が足りない → 短すぎる。中身は関係ない。
    //   ② 尺はあるのに測れない → 無音。録音の失敗を疑う先。
    //   ③ 尺はあり音もあるが窓が足りない → 短すぎる（相づち 1 つぶんなど）。
    // ①と③を先にまとめると、**無音の 4 秒まで「短すぎる」になる**（窓が 0 個なので）。
    if (g.duration < opts.minDuration) {
      perGroup.set(g.group, { gainDb: 0, wantedDb: 0, limitedBy: 'tooShort', lufs: g.lufs });
      continue;
    }
    if (g.lufs === null) {
      perGroup.set(g.group, { gainDb: 0, wantedDb: 0, limitedBy: 'unmeasurable', lufs: null });
      continue;
    }
    if (g.gatedBlocks < opts.minGatedBlocks) {
      perGroup.set(g.group, { gainDb: 0, wantedDb: 0, limitedBy: 'tooShort', lufs: g.lufs });
      continue;
    }
    if (referenceLufs === null) {
      perGroup.set(g.group, { gainDb: 0, wantedDb: 0, limitedBy: 'unmeasurable', lufs: g.lufs });
      continue;
    }
    const wantedDb = referenceLufs - g.lufs;
    const gainDb = Math.min(opts.maxBoostDb, Math.max(-opts.maxCutDb, wantedDb));
    // 浮動小数の端で `cap` が立たないように、丸め誤差ぶんの遊びを持たせる。
    const limitedBy: ClipGain['limitedBy'] = Math.abs(gainDb - wantedDb) > 1e-9 ? 'cap' : 'none';
    perGroup.set(g.group, { gainDb, wantedDb, limitedBy, lufs: g.lufs });
  }

  const gains: ClipGain[] = measured.map((m) => {
    const decided = perGroup.get(m.group)!;
    return {
      id: m.id,
      group: m.group,
      gain: Math.pow(10, decided.gainDb / 20),
      gainDb: decided.gainDb,
      // 群の値を見せる（そのクリップ単体の値ではない）。同じ倍率が当たる理由がここに出る。
      lufs: decided.lufs,
      resultLufs: decided.lufs === null ? null : decided.lufs + decided.gainDb,
      limitedBy: decided.limitedBy,
      wantedDb: decided.wantedDb,
    };
  });

  // 開きは**触る対象になった群**だけで見る。測れない群を混ぜると、
  // 「揃えたのに開きが縮まない」が触れないものを数えているせいなのか分からなくなる。
  const before = usable.map((g) => g.lufs as number);
  const after = usable.map((g) => (g.lufs as number) + (perGroup.get(g.group)?.gainDb ?? 0));
  const spread = (xs: number[]) => (xs.length > 0 ? Math.max(...xs) - Math.min(...xs) : 0);

  return { referenceLufs, gains, spreadBefore: spread(before), spreadAfter: spread(after) };
}

/**
 * 決めた倍率を当てた音を返す（元は壊さない）。
 *
 * **ここでピークの天井は見ていない。** 見るべき場所は繋いだあとの `lufs.ts` と `limiter.ts` で、
 * ここで先に抑えると「揃える」と「歪ませない」が同じつまみになる（`lufs.ts` と同じ理由）。
 */
export function applyClipGains(clips: ClipSource[], plan: ClipMatchPlan): AudioLike[] {
  const byId = new Map(plan.gains.map((g) => [g.id, g]));
  return clips.map((clip, i) => {
    // **並びで引く。** `plan.gains` は `measureClips` の並びをそのまま保っているので index が正しい。
    // id で引くと、同じ id のクリップが 2 本あったときに**黙って片方の倍率が両方へ当たる。**
    // 並びが合わない渡し方をされたときだけ id に落とす。
    const decided = plan.gains.length === clips.length ? plan.gains[i] : byId.get(clip.id);
    const gain = decided?.gain ?? 1;
    const planes: Float32Array[] = [];
    for (let c = 0; c < clip.buffer.numberOfChannels; c += 1) {
      const src = clip.buffer.getChannelData(c);
      const out = new Float32Array(src.length);
      for (let i = 0; i < src.length; i += 1) out[i] = src[i] * gain;
      planes.push(out);
    }
    return {
      sampleRate: clip.buffer.sampleRate,
      numberOfChannels: clip.buffer.numberOfChannels,
      length: clip.buffer.length,
      getChannelData: (c: number) => planes[c],
    };
  });
}

/**
 * 自動カットが刻んだかけら 1 つと、そこへ当てる倍率。
 *
 * `ClipEdit`（`edits.ts`）に倍率を足しただけのもの。本体のタイムラインへ置くとき、
 * **分割したかけらそれぞれに、その素材ぶんの倍率を 1 つ持たせる**のがここの形。
 */
export interface MatchedClipEdit extends ClipEdit {
  group: string;
  gain: number;
  gainDb: number;
  limitedBy: ClipGain['limitedBy'];
}

/**
 * 群ごとに決めた倍率を、`toClipEdits` が返したかけらへ配る。
 *
 * **ここが `clip-match` と `edits`（＝本体への継ぎ目）を繋ぐ 1 本**です。
 * 1 本の素材から出たかけらは**全部が同じ群**なので、受け取る倍率も 1 つになります。
 * かけらごとに測り直さないのがこの形の肝で、そうしないと切れ目のたびに
 * 部屋の音が段になります（README の「かけらごとに揃えてはいけません」）。
 *
 * **その群が計画に無ければ 1 倍にして `unmeasurable` を立てます。**
 * 黙って別の群の倍率を当てると、画面では揃ったように見えて音だけが違う、という壊れ方をします。
 */
export function attachClipGains(edits: ClipEdit[], group: string, plan: ClipMatchPlan): MatchedClipEdit[] {
  const decided = plan.gains.find((g) => g.group === group);
  return edits.map((edit) => ({
    ...edit,
    group,
    gain: decided?.gain ?? 1,
    gainDb: decided?.gainDb ?? 0,
    limitedBy: decided?.limitedBy ?? 'unmeasurable',
  }));
}
