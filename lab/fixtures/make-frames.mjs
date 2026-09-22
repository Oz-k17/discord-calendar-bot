/**
 * 試し用の映像（コマの列）を作る。
 *
 *   node lab/fixtures/make-frames.mjs             # 一覧を出すだけ
 *   node lab/fixtures/make-frames.mjs pan         # 1 本だけ作って様子を出す
 *   node lab/fixtures/make-frames.mjs '' portrait # 縦型（9:16）で作る
 *   node lab/fixtures/make-frames.mjs '' landscape 30 # コマの速さを変えて作る
 *
 * 音の側の `make-audio.mjs` と同じで、**毎回まったく同じ絵が出る**ようにするために置いている。
 * 乱数に種を固定してあるので、「昨日は 8 本見つけた／今日は 9 本」をそのまま比べられる。
 *
 * ファイルには書き出さない（理由は `scenes.mjs` の頭に書いた）。
 * 呼ぶ側は `renderFixture(name)` でコマの列をその場で作る。
 */

import { SCENE_ASPECTS, SCENE_FIXTURES, SCENE_FPS, SCENE_LENGTH, sceneAspect, sceneFixture } from './scenes.mjs';

/** 種を固定した擬似乱数（mulberry32）。音の側と同じものを使う。 */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 色相・彩度・明度から RGB（0〜255）。場面ごとに色を散らすためだけのもの。 */
function hsv(h, s, v) {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  const table = [
    [v, t, p],
    [q, v, p],
    [p, v, t],
    [p, q, v],
    [t, p, v],
    [v, p, q],
  ][i % 6];
  return [table[0] * 255, table[1] * 255, table[2] * 255];
}

/**
 * 1 つの場面。
 *
 * 模様（`texU` / `texV`）を持たせてあるのは、**パンやズームで絵が動いたことにする**ため。
 * 色の面だけだと横へずらしても画素が 1 つも変わらず、「カメラが動いても切らない」を
 * 試したつもりで何も試していないことになる。
 */
function makeShot(rnd, { palette = null, dark = false, tint = null, span = 1 } = {}) {
  const hue = rnd();
  const top = palette ? palette.top.slice() : hsv(hue, 0.45 + 0.35 * rnd(), 0.55 + 0.35 * rnd());
  const bottom = palette
    ? palette.bottom.slice()
    : hsv((hue + 0.12 + 0.25 * rnd()) % 1, 0.45 + 0.35 * rnd(), 0.25 + 0.3 * rnd());

  // `span` は「画面何枚ぶんの帯を持つか」。1 なら画面ぶんだけで、パンすると同じ絵が巡る。
  // 大きくすると帯そのものが長くなり、パンで**新しい中身が入ってくる**。
  const wide = Math.max(1, Math.ceil(span));
  const texU = Float64Array.from({ length: 24 * wide }, () => rnd());
  const texV = Float64Array.from({ length: 12 }, () => rnd());

  const blobs = [];
  const count = (3 + Math.floor(rnd() * 3)) * wide;
  for (let i = 0; i < count; i += 1) {
    blobs.push({
      cx: rnd(),
      cy: 0.15 + 0.7 * rnd(),
      rx: 0.07 + 0.16 * rnd(),
      ry: 0.09 + 0.18 * rnd(),
      color: palette ? palette.blob.slice() : hsv(rnd(), 0.35 + 0.5 * rnd(), 0.3 + 0.6 * rnd()),
      vx: (rnd() - 0.5) * 0.03,
      vy: (rnd() - 0.5) * 0.02,
    });
  }

  if (dark) {
    // 暗所のつもり。色を残したまま全体を落とす（真っ黒にすると粒ノイズしか残らない）。
    for (const c of [top, bottom]) for (let i = 0; i < 3; i += 1) c[i] *= 0.13;
    for (const b of blobs) for (let i = 0; i < 3; i += 1) b.color[i] *= 0.16;
  }

  if (tint) {
    // 明るさを揃えたまま色だけを変える素材のため、灰色にしてから色味を掛ける。
    // 掛ける色味は明るさが 1 になるよう正規化してあるので、`lumaHist` は 1 段も動かない。
    for (const c of [top, bottom]) {
      const gray = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
      for (let i = 0; i < 3; i += 1) c[i] = gray * tint[i];
    }
    for (const b of blobs) {
      const gray = 0.2126 * b.color[0] + 0.7152 * b.color[1] + 0.0722 * b.color[2];
      for (let i = 0; i < 3; i += 1) b.color[i] = gray * tint[i];
    }
  }

  return { top, bottom, texU, texV, blobs };
}

/**
 * 明るさを変えずに色味だけを変える掛け算。
 *
 * 明るさ（Rec.709）が 1 になるよう割り戻してある。**飽和させると崩れる**ので、
 * 掛ける前の灰色と掛け算の最大が 255 を超えないよう、控えめな振り幅にしてある。
 */
function lumaNeutralTint(index) {
  const table = [
    [1.0, 1.0, 1.0],
    [1.35, 0.9, 1.25],
    [0.75, 1.1, 1.3],
    [1.2, 0.95, 0.7],
  ];
  const t = table[index % table.length];
  const l = 0.2126 * t[0] + 0.7152 * t[1] + 0.0722 * t[2];
  return [t[0] / l, t[1] / l, t[2] / l];
}

/** 模様を滑らかに読む（端は巻き戻す）。段差にすると、そこが偽のカットになってしまう。 */
function sampleWrap(arr, u) {
  const n = arr.length;
  const x = (((u % 1) + 1) % 1) * n;
  const i = Math.floor(x);
  const f = x - i;
  const a = arr[i % n];
  const b = arr[(i + 1) % n];
  return a + (b - a) * (f * f * (3 - 2 * f));
}

/**
 * 場面の 1 画素。u は横（巻き戻す）、v は縦（0〜1 に丸める）。
 *
 * `span` は帯の長さ（画面何枚ぶんか）。u を帯の座標へ直してから読むので、
 * 帯が長ければパンしても同じ絵が戻ってこない。
 */
function shotPixel(shot, u, v, t, out, span = 1) {
  const uw = (((u / span) % 1) + 1) % 1;
  const vc = v < 0 ? 0 : v > 1 ? 1 : v;
  const shade = 0.68 + 0.32 * (0.6 * sampleWrap(shot.texU, uw) + 0.4 * sampleWrap(shot.texV, vc));
  for (let i = 0; i < 3; i += 1) {
    out[i] = (shot.top[i] + (shot.bottom[i] - shot.top[i]) * vc) * shade;
  }
  for (const b of shot.blobs) {
    let bx = b.cx + b.vx * t;
    bx = ((bx % 1) + 1) % 1;
    const by = b.cy + b.vy * t;
    let du = uw - bx;
    if (du > 0.5) du -= 1;
    if (du < -0.5) du += 1;
    const dv = vc - by;
    const d = (du / b.rx) * (du / b.rx) + (dv / b.ry) * (dv / b.ry);
    if (d < 1) {
      // 縁を少しぼかす。輪郭が 1 画素で立つと、手ぶれだけで大きな差が出てしまう。
      const a = Math.min(1, (1 - d) * 2.2);
      for (let i = 0; i < 3; i += 1) out[i] += (b.color[i] - out[i]) * a;
    }
  }
}

/**
 * 素材 1 本ぶんのコマを作る。
 *
 * 返すのは `{ width, height, fps, times, frames }`。
 * `frames[i]` は RGBA の `Uint8ClampedArray`（`ImageData.data` と同じ並び）。
 * 本物の動画を縮めて渡すときと同じ形にしてある。
 */
export function renderFixture(name, { aspect = 'landscape', fps = SCENE_FPS } = {}) {
  const fixture = sceneFixture(name);
  const o = fixture.options ?? {};
  const view = sceneAspect(aspect);
  const width = view.width;
  const height = view.height;
  // 縦型は「同じ絵を縦長の受け皿に描き直す」のではなく、**横型の画面から横を切り出す**。
  // 理由は `scenes.mjs` の `PORTRAIT_CROP_U` の注に書いた。
  const cropU = view.cropU;
  // コマの速さは素材の側の話（描く絵は秒で決まるので、何コマ刻むかだけが変わる）。
  // **既定を変える口ではなく、「コマ数で決めたつまみが速さに耐えるか」を測る口**として足した。
  // 本物の動画は 30fps 級で来るのに、既定の `straddleFrames` も `localWindow` も
  // コマ数で書いてあるので、同じ数字が別の秒数を意味してしまう。
  if (!(fps > 0)) throw new Error(`fps は正の数です（${fps}）`);
  const total = Math.round(SCENE_LENGTH * fps);

  const rnd = rng(o.seed ?? 1);
  const cutsAt = o.cutsAt ?? [];
  // 同じ配色のまま模様だけ変える素材のため、先に色を決めて共有する。
  const palette = o.samePalette
    ? { top: hsv(0.58, 0.5, 0.72), bottom: hsv(0.62, 0.55, 0.34), blob: hsv(0.55, 0.45, 0.5) }
    : null;

  // パンで新しい中身が入ってくる素材では、帯をパンの距離ぶんだけ長く持つ。
  const span = o.panReveal ? 1 + (o.pan ?? 0) * SCENE_LENGTH : 1;

  // `shotOrder` は「区切りごとにどの場面を出すか」。同じ場面へ戻る（切り返し・インサート）ため。
  const order = o.shotOrder ?? null;
  const shotCount = order
    ? Math.max(...order) + 1
    : cutsAt.length + 1 + (o.dissolve || o.fadeBlack ? 1 : 0);
  const shots = [];
  if (o.sameLuma) {
    // 明るさを揃える素材では、場面の骨格（模様と配置）まで同じにする。
    // 骨格まで変えると「色が違うのか形が違うのか」が分からなくなるため。
    // 種を場面ごとに作り直すので、骨格（模様と配置）は 1 ビットも同じになる。
    for (let i = 0; i < shotCount; i += 1) {
      shots.push(makeShot(rng((o.seed ?? 1) + 1), { tint: lumaNeutralTint(i), span }));
    }
  } else {
    for (let i = 0; i < shotCount; i += 1) shots.push(makeShot(rnd, { palette, dark: o.dark, span }));
  }

  // 横切る被写体は場面の一部ではなく、カメラの前を通るものとして別に持つ。
  const crossing = o.crossing ? { color: hsv(0.08, 0.7, 0.95), ry: 0.42, rx: 0.2 } : null;

  const times = new Float64Array(total);
  const frames = [];
  const rgb = [0, 0, 0];
  const rgbB = [0, 0, 0];

  for (let f = 0; f < total; f += 1) {
    const t = f / fps;
    times[f] = t;
    const data = new Uint8ClampedArray(width * height * 4);

    // --- このコマで何が起きているか ---
    let index = 0;
    for (const c of cutsAt) if (t >= c - 1e-9) index += 1;
    let shot = order ? shots[order[Math.min(index, order.length - 1)]] : shots[Math.min(index, shots.length - 1)];
    let other = null;
    let mix = 0;

    if (o.dissolve) {
      const { at, seconds } = o.dissolve;
      const from = at - seconds / 2;
      if (t >= from + seconds) {
        shot = shots[1];
      } else if (t >= from) {
        other = shots[1];
        mix = (t - from) / seconds;
      }
    }

    let fade = 1;
    if (o.fadeBlack) {
      const { at, hold, ramp } = o.fadeBlack;
      const downFrom = at - hold / 2 - ramp;
      const downTo = at - hold / 2;
      const upFrom = at + hold / 2;
      const upTo = at + hold / 2 + ramp;
      if (t >= upTo) {
        shot = shots[1];
      } else if (t >= upFrom) {
        shot = shots[1];
        fade = (t - upFrom) / ramp;
      } else if (t >= downTo) {
        fade = 0;
      } else if (t >= downFrom) {
        fade = 1 - (t - downFrom) / ramp;
      }
    }

    // フラッシュは 2 コマで立ち上がって落ちる。1 コマだけだと「コマ落ち」と区別が付かない。
    let flash = 0;
    for (const at of o.flashes ?? []) {
      const d = Math.abs(t - at);
      if (d < 2.5 / fps) flash = Math.max(flash, 0.92 * (1 - d / (2.5 / fps)));
    }

    const pan = (o.pan ?? 0) * t;
    const zoom = 1 + (o.zoom ?? 0) * t;
    const shakeRnd = rng((o.seed ?? 1) * 7919 + f);
    const shakeU = o.shake ? (shakeRnd() - 0.5) * o.shake : 0;
    const shakeV = o.shake ? (shakeRnd() - 0.5) * o.shake : 0;
    const grainRnd = rng((o.seed ?? 1) * 104729 + f);
    const grain = (o.grain ?? 0) * 255;
    const crossX = crossing ? -0.3 + 1.6 * (t / SCENE_LENGTH) : 0;

    for (let y = 0; y < height; y += 1) {
      const v0 = (y + 0.5) / height;
      for (let x = 0; x < width; x += 1) {
        const u0 = (x + 0.5) / width;
        // 切り出しはカメラの前ではなく後ろ（撮れた画面を切る）なので、
        // ズーム・パン・手ぶれより先に効かせる。こうすると縦型では
        // 揺れもパンも**画面に対して 3.16 倍**になる——それが切り出しの代価そのもの。
        const uFrame = 0.5 + (u0 - 0.5) * cropU;
        const u = 0.5 + (uFrame - 0.5) / zoom + pan + shakeU;
        const v = 0.5 + (v0 - 0.5) / zoom + shakeV;

        shotPixel(shot, u, v, t, rgb, span);
        if (other) {
          shotPixel(other, u, v, t, rgbB, span);
          for (let i = 0; i < 3; i += 1) rgb[i] += (rgbB[i] - rgb[i]) * mix;
        }

        if (crossing) {
          // 横切る被写体は場面の一部ではなくカメラの前を通るものなので、
          // **切り出す前の画面**の座標で置く。横型では `uFrame === u0` なので
          // ここを切り替えても横型の絵は 1 ビットも変わらない。
          const du = uFrame - crossX;
          const dv = v0 - 0.5;
          const d = (du / crossing.rx) * (du / crossing.rx) + (dv / crossing.ry) * (dv / crossing.ry);
          if (d < 1) {
            const a = Math.min(1, (1 - d) * 3);
            for (let i = 0; i < 3; i += 1) rgb[i] += (crossing.color[i] - rgb[i]) * a;
          }
        }

        const p = (y * width + x) * 4;
        for (let i = 0; i < 3; i += 1) {
          let c = rgb[i] * fade;
          if (flash > 0) c += (255 - c) * flash;
          if (grain > 0) c += (grainRnd() - 0.5) * grain;
          data[p + i] = c;
        }
        data[p + 3] = 255;
      }
    }

    // `ImageData` と同じ形で返す。本物の動画を縮めて `getImageData()` した結果と入れ替えられる。
    frames.push({ width, height, data });
  }

  return {
    name,
    aspect,
    width,
    height,
    fps,
    times,
    frames,
    cuts: fixture.cuts,
    note: fixture.note,
    hard: !!fixture.hard,
  };
}

// --- コマンドラインから呼ばれたとき ---
//
// 判定の側が `node:url` を使わないのは、**このファイルをブラウザからも読むため**
// （2026-09-22・2 回目）。画面の確認（`scene-cut/uitest.mjs`）は、ここで作ったコマを
// ブラウザ側で本物の動画に焼いてから画面へ食わせる。静的な `import 'node:url'` が 1 行あるだけで
// vite がその解決に失敗するので、実行中の名前で見分ける形にしてある。
if (typeof process !== 'undefined' && process.argv?.[1]?.endsWith('make-frames.mjs')) {
  const only = process.argv[2];
  const aspect = process.argv[3] ?? 'landscape';
  const fps = Number(process.argv[4] ?? SCENE_FPS);
  const list = only ? [sceneFixture(only)] : SCENE_FIXTURES;
  console.log(`向き: ${aspect}（${SCENE_ASPECTS[aspect]?.label ?? '?'}） ・ ${fps}fps\n`);
  for (const f of list) {
    const clip = renderFixture(f.name, { aspect, fps });
    const mb = (clip.frames.length * clip.width * clip.height * 4) / 1024 / 1024;
    console.log(
      `${f.name.padEnd(14)} ${clip.frames.length} コマ  ${clip.width}×${clip.height}  ` +
        `${mb.toFixed(1)}MB  正解 ${f.cuts.length} 本  ${f.hard ? '※ ' : ''}${f.note}`,
    );
  }
}
