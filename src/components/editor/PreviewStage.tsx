import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { exporter } from '../../engine/exporter';
import { formatTime } from '../../engine/media';
import { player } from '../../engine/player';
import { CROP_CORNERS, cropDestForSelection, renderFrame, type CropCorner, type Rect } from '../../engine/renderer';
import { clipAtTime, clipsOnTrack, splitAt } from '../../model/ops';
import { clipEnd, type Clip, type Crop, type Sequence } from '../../model/types';
import { useApp } from '../../store/app';
import { useEditor } from '../../store/editor';

/**
 * プレビューを描く解像度。実解像度のまま描くと重いので落とす。
 * 素材が重くて再生がカクつくときは、設定でさらに下げられる（書き出しには影響しない）。
 */
function previewSize(sequence: Sequence, longEdge: number) {
  const scale = Math.min(1, longEdge / Math.max(sequence.width, sequence.height));
  return { width: Math.round(sequence.width * scale), height: Math.round(sequence.height * scale) };
}

export function usePlayerTime(): number {
  return useSyncExternalStore(player.subscribeTime, player.getTime, player.getTime);
}

export function usePlayerPlaying(): boolean {
  return useSyncExternalStore(player.subscribeState, player.getPlaying, player.getPlaying);
}

/** 範囲指定モードの操作。source は元の絵が描かれている矩形（シーケンス座標）。 */
type CropDrag =
  | { mode: 'draw'; anchorU: number; anchorV: number }
  | { mode: 'move'; offsetU: number; offsetV: number; origin: Crop }
  | { mode: 'resize'; corner: CropCorner; origin: Crop };

type Drag =
  | { kind: 'none' }
  | { kind: 'move'; id: string; startX: number; startY: number; originX: number; originY: number }
  | { kind: 'crop'; id: string; startX: number; startY: number; originX: number; originY: number }
  | { kind: 'cropSelect'; id: string; source: Rect; drag: CropDrag };

/** 切り抜き範囲の最小の大きさ（元の絵に対する割合）。潰れて掴めなくなるのを防ぐ。 */
const MIN_CROP = 0.04;

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));



export function PreviewStage() {
  const { sequence, selection, setSelection, apply, cropTarget, setCropTarget } = useEditor();
  const { settings } = useApp();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const boundsRef = useRef<Map<string, Rect>>(new Map());
  const dragRef = useRef<Drag>({ kind: 'none' });
  const [guides, setGuides] = useState(true);

  // 描画ループから最新値を読むための箱（RAF ごとに購読し直したくない）
  const latest = useRef({ sequence, selection, guides, cropTarget });
  latest.current = { sequence, selection, guides, cropTarget };

  const size = useMemo(
    () => previewSize(sequence, settings.previewQuality),
    [sequence.width, sequence.height, settings.previewQuality],
  );

  useEffect(() => {
    player.update(sequence);
  }, [sequence]);

  useEffect(() => {
    const sources = player.renderSources();
    // getContext は毎フレーム呼ばず一度だけ取る。
    let ctx: CanvasRenderingContext2D | null = null;
    let ctxOwner: HTMLCanvasElement | null = null;
    player.start((time) => {
      const canvas = canvasRef.current;
      if (canvas && canvas !== ctxOwner) {
        ctx = canvas.getContext('2d', { alpha: false });
        ctxOwner = canvas;
      }
      const { sequence: seq, selection: sel, guides: g, cropTarget: crop } = latest.current;
      // 書き出し中はプレビューを描かない。モーダルの裏に隠れて見えないうえ、
      // 描画に処理時間を取られると書き出しそのものが遅く・不安定になる。
      if (exporter.active) {
        // 実時間収録で書き出す場合のみ、収録用キャンバスへ描く。
        if (exporter.ctx && exporter.sequence) {
          renderFrame(exporter.ctx, exporter.sequence, time, sources, { guides: false, selectedIds: [] });
        }
      } else if (ctx) {
        boundsRef.current = renderFrame(ctx, seq, time, sources, { guides: g, selectedIds: sel, cropTarget: crop });
      }
    });
    return () => player.stop();
  }, []);

  const toSequenceCoords = useCallback(
    (event: { clientX: number; clientY: number }) => {
      const canvas = canvasRef.current;
      if (!canvas) return { x: 0, y: 0 };
      const rect = canvas.getBoundingClientRect();
      return {
        x: ((event.clientX - rect.left) / rect.width) * sequence.width,
        y: ((event.clientY - rect.top) / rect.height) * sequence.height,
      };
    },
    [sequence.width, sequence.height],
  );

  const hit = (rect: Rect | undefined, point: { x: number; y: number }) =>
    !!rect && point.x >= rect.x && point.x <= rect.x + rect.w && point.y >= rect.y && point.y <= rect.y + rect.h;

  /** 範囲指定モード中の 1 本道。ここでは切り抜き範囲だけを触る。 */
  const beginCropSelect = (event: React.PointerEvent<HTMLCanvasElement>, point: { x: number; y: number }): boolean => {
    if (!cropTarget) return false;
    const clip = sequence.clips.find((c) => c.id === cropTarget);
    const source = boundsRef.current.get(`cropsrc:${cropTarget}`);
    if (!clip || !source || source.w <= 0 || source.h <= 0) return false;

    let drag: CropDrag | null = null;
    for (const corner of CROP_CORNERS) {
      if (hit(boundsRef.current.get(`crophandle:${cropTarget}:${corner}`), point)) {
        drag = { mode: 'resize', corner, origin: clip.crop };
        break;
      }
    }
    // 全体が選ばれている間は「動かす」余地が無いので、内側を押しても引き直しにする。
    const wholeFrame = clip.crop.sw >= 0.995 && clip.crop.sh >= 0.995;
    if (!drag && !wholeFrame && hit(boundsRef.current.get(`cropsel:${cropTarget}`), point)) {
      drag = {
        mode: 'move',
        offsetU: (point.x - source.x) / source.w - clip.crop.sx,
        offsetV: (point.y - source.y) / source.h - clip.crop.sy,
        origin: clip.crop,
      };
    }
    if (!drag) {
      // 枠の外を押したら、そこを起点に新しい範囲を引き直す。
      drag = {
        mode: 'draw',
        anchorU: clamp01((point.x - source.x) / source.w),
        anchorV: clamp01((point.y - source.y) / source.h),
      };
    }
    dragRef.current = { kind: 'cropSelect', id: cropTarget, source, drag };
    event.currentTarget.setPointerCapture(event.pointerId);
    // 引き始めた時点で潰れた範囲にしておくと、動かした量がそのまま大きさになる。
    if (drag.mode === 'draw') {
      applyCrop(clip.id, (crop) => ({ ...crop, sx: drag.anchorU, sy: drag.anchorV, sw: 0, sh: 0 }), source);
    }
    return true;
  };

  const applyCrop = (id: string, next: (crop: Crop) => Crop, source: Rect) => {
    apply(
      (seq) => ({
        ...seq,
        clips: seq.clips.map((c) => (c.id === id ? { ...c, crop: cropDestForSelection(seq, c, source, next(c.crop)) } : c)),
      }),
      `cropSelect:${id}`,
    );
  };

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const point = toSequenceCoords(event);
    const time = player.time;

    if (beginCropSelect(event, point)) return;

    // 選択中クリップのクロップ枠を最優先で掴む
    for (const id of selection) {
      const clip = sequence.clips.find((c) => c.id === id);
      if (!clip?.crop.enabled) continue;
      if (hit(boundsRef.current.get(`crop:${id}`), point)) {
        dragRef.current = {
          kind: 'crop',
          id,
          startX: point.x,
          startY: point.y,
          originX: clip.crop.dx,
          originY: clip.crop.dy,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
        return;
      }
    }

    // テキストは上に描かれているものから
    const textClips = sequence.clips.filter(
      (c) => c.kind === 'text' && time >= c.start && time < clipEnd(c),
    );
    for (let i = textClips.length - 1; i >= 0; i -= 1) {
      const clip = textClips[i];
      if (hit(boundsRef.current.get(clip.id), point)) {
        setSelection([clip.id]);
        dragRef.current = { kind: 'move', id: clip.id, startX: point.x, startY: point.y, originX: clip.x, originY: clip.y };
        event.currentTarget.setPointerCapture(event.pointerId);
        return;
      }
    }

    // それ以外は一番上の映像トラックのクリップを動かす
    const videoTracks = sequence.tracks.filter((t) => t.kind === 'video' && !t.hidden);
    for (let i = videoTracks.length - 1; i >= 0; i -= 1) {
      const clip = clipAtTime(sequence, videoTracks[i].id, time);
      if (!clip) continue;
      setSelection([clip.id]);
      dragRef.current = { kind: 'move', id: clip.id, startX: point.x, startY: point.y, originX: clip.x, originY: clip.y };
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (drag.kind === 'none') return;
    const point = toSequenceCoords(event);

    if (drag.kind === 'cropSelect') {
      const { source } = drag;
      const u = clamp01((point.x - source.x) / source.w);
      const v = clamp01((point.y - source.y) / source.h);
      applyCrop(
        drag.id,
        (crop) => {
          const d = drag.drag;
          if (d.mode === 'draw') {
            return {
              ...crop,
              sx: Math.min(d.anchorU, u),
              sy: Math.min(d.anchorV, v),
              sw: Math.abs(u - d.anchorU),
              sh: Math.abs(v - d.anchorV),
            };
          }
          if (d.mode === 'move') {
            return {
              ...crop,
              sx: Math.max(0, Math.min(1 - d.origin.sw, u - d.offsetU)),
              sy: Math.max(0, Math.min(1 - d.origin.sh, v - d.offsetV)),
            };
          }
          const left = d.origin.sx;
          const top = d.origin.sy;
          const right = d.origin.sx + d.origin.sw;
          const bottom = d.origin.sy + d.origin.sh;
          const x0 = d.corner === 'nw' || d.corner === 'sw' ? u : left;
          const x1 = d.corner === 'ne' || d.corner === 'se' ? u : right;
          const y0 = d.corner === 'nw' || d.corner === 'ne' ? v : top;
          const y1 = d.corner === 'sw' || d.corner === 'se' ? v : bottom;
          return {
            ...crop,
            sx: Math.min(x0, x1),
            sy: Math.min(y0, y1),
            sw: Math.abs(x1 - x0),
            sh: Math.abs(y1 - y0),
          };
        },
        source,
      );
      return;
    }

    const dx = (point.x - drag.startX) / sequence.width;
    const dy = (point.y - drag.startY) / sequence.height;

    apply(
      (seq) => ({
        ...seq,
        clips: seq.clips.map((c) => {
          if (c.id !== drag.id) return c;
          if (drag.kind === 'crop') {
            return { ...c, crop: { ...c.crop, dx: drag.originX + dx, dy: drag.originY + dy } };
          }
          return { ...c, x: drag.originX + dx, y: drag.originY + dy };
        }),
      }),
      `${drag.kind}:${drag.id}`,
    );
  };

  const endDrag = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (drag.kind !== 'none' && event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    // 指を離した時点で潰れていたら、選び直しやすい大きさへ戻す。
    if (drag.kind === 'cropSelect') {
      applyCrop(
        drag.id,
        (crop) => ({
          ...crop,
          sw: Math.max(MIN_CROP, crop.sw),
          sh: Math.max(MIN_CROP, crop.sh),
          sx: Math.min(crop.sx, 1 - Math.max(MIN_CROP, crop.sw)),
          sy: Math.min(crop.sy, 1 - Math.max(MIN_CROP, crop.sh)),
        }),
        drag.source,
      );
    }
    dragRef.current = { kind: 'none' };
  };

  // 範囲指定中は Esc で抜けられるようにする。
  useEffect(() => {
    if (!cropTarget) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setCropTarget(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cropTarget, setCropTarget]);

  /** 選んだ範囲を画面いっぱいに引き伸ばす（切り抜いて寄る、いわゆるクロップズーム）。 */
  const fillFrame = () => {
    if (!cropTarget) return;
    apply(
      (seq) => ({
        ...seq,
        clips: seq.clips.map((c) => {
          if (c.id !== cropTarget) return c;
          const aspect = (c.crop.sw * (seq.width / seq.height)) / Math.max(c.crop.sh, 1e-6);
          // 画角を埋めるように、はみ出す側を基準に合わせる。
          const dw = aspect >= seq.width / seq.height ? (seq.height / seq.width) * aspect : 1;
          const dh = aspect >= seq.width / seq.height ? 1 : (seq.width / seq.height) / aspect;
          const scale = c.scale || 1;
          return {
            ...c,
            crop: { ...c.crop, dw: dw / scale, dh: dh / scale, dx: (1 - dw / scale) / 2 - c.x, dy: (1 - dh / scale) / 2 - c.y },
          };
        }),
      }),
      `cropFill:${cropTarget}`,
    );
  };

  const resetCrop = () => {
    if (!cropTarget) return;
    const source = boundsRef.current.get(`cropsrc:${cropTarget}`);
    if (!source) return;
    applyCrop(cropTarget, (crop) => ({ ...crop, sx: 0, sy: 0, sw: 1, sh: 1 }), source);
  };

  const onWheel = (event: React.WheelEvent<HTMLCanvasElement>) => {
    const id = selection[0];
    const clip = id ? sequence.clips.find((c) => c.id === id) : null;
    if (!clip) return;
    const next = Math.max(0.1, Math.min(6, clip.scale * (event.deltaY > 0 ? 0.96 : 1.04)));
    apply(
      (seq) => ({ ...seq, clips: seq.clips.map((c) => (c.id === clip.id ? { ...c, scale: next } : c)) }),
      `scale:${clip.id}`,
    );
  };

  return (
    <div className="preview">
      <div className={`preview-stage${cropTarget ? ' cropping' : ''}`}>
        <canvas
          ref={canvasRef}
          width={size.width}
          height={size.height}
          style={{ aspectRatio: `${sequence.width} / ${sequence.height}` }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onWheel={onWheel}
        />
      </div>
      {cropTarget && (
        <div className="crop-hud">
          <span>切り抜く範囲をなぞってください。角のつまみで大きさ、内側をドラッグで位置を変えられます。</span>
          <div className="crop-hud-actions">
            <button type="button" onClick={fillFrame}>
              画面いっぱいに
            </button>
            <button type="button" onClick={resetCrop}>
              全体に戻す
            </button>
            <button type="button" className="primary" onClick={() => setCropTarget(null)}>
              完了
            </button>
          </div>
        </div>
      )}
      <Transport guides={guides} onToggleGuides={() => setGuides((g) => !g)} />
    </div>
  );
}

function Transport({ guides, onToggleGuides }: { guides: boolean; onToggleGuides: () => void }) {
  const { sequence, apply, selection } = useEditor();
  const playing = usePlayerPlaying();
  const duration = player.duration;
  const frame = 1 / (sequence.fps || 30);
  const timeRef = useRef<HTMLSpanElement>(null);
  const scrubRef = useRef<HTMLInputElement>(null);

  // 時刻の表示は毎フレーム更新が要るが、React を通すと再描画のたびに
  // ツリー全体を作り直すことになるので、DOM を直接書き換える。
  useEffect(
    () =>
      player.subscribeFrame((t) => {
        if (timeRef.current) timeRef.current.textContent = formatTime(t, true, sequence.fps);
        const scrub = scrubRef.current;
        // つまみを掴んでいる間は上書きしない。
        if (scrub && document.activeElement !== scrub) {
          scrub.max = String(Math.max(0.01, player.duration));
          scrub.value = String(Math.min(t, player.duration));
        }
      }),
    [sequence.fps],
  );

  const boundaries = useMemo(() => {
    const points = new Set<number>([0]);
    for (const track of sequence.tracks) {
      for (const clip of clipsOnTrack(sequence, track.id)) {
        points.add(clip.start);
        points.add(clipEnd(clip));
      }
    }
    return [...points].sort((a, b) => a - b);
  }, [sequence]);

  const jump = (direction: -1 | 1) => {
    const now = player.time;
    if (direction < 0) {
      const previous = [...boundaries].reverse().find((b) => b < now - 0.05);
      player.seek(previous ?? 0);
    } else {
      const next = boundaries.find((b) => b > now + 0.05);
      player.seek(next ?? duration);
    }
  };

  return (
    <div className="transport">
      <div className="transport-scrub">
        <input
          ref={scrubRef}
          type="range"
          min={0}
          max={Math.max(0.01, duration)}
          step={0.01}
          defaultValue={0}
          onChange={(e) => player.seek(Number(e.target.value))}
          aria-label="再生位置"
        />
      </div>
      <div className="transport-row">
        <span className="timecode">
          <span ref={timeRef}>{formatTime(player.time, true, sequence.fps)}</span> <em>/ {formatTime(duration)}</em>
        </span>
        <div className="transport-buttons">
          <button type="button" title="前の継ぎ目へ" onClick={() => jump(-1)}>
            ⏮
          </button>
          <button type="button" title="1 フレーム戻る" onClick={() => player.nudge(-frame)}>
            ◀
          </button>
          <button type="button" className="primary" title="再生 / 一時停止" onClick={() => player.toggle()}>
            {playing ? '❚❚' : '▶'}
          </button>
          <button type="button" title="1 フレーム進む" onClick={() => player.nudge(frame)}>
            ▶
          </button>
          <button type="button" title="次の継ぎ目へ" onClick={() => jump(1)}>
            ⏭
          </button>
        </div>
        <div className="transport-tools">
          <button type="button" title="再生ヘッドで分割" onClick={() => apply((seq) => splitAt(seq, player.time, selection))}>
            ✂ 分割
          </button>
          <button type="button" className={guides ? 'active' : ''} title="SNS の UI に隠れる範囲" onClick={onToggleGuides}>
            ⌗ ガイド
          </button>
          <LoopButton />
        </div>
      </div>
    </div>
  );
}

function LoopButton() {
  const [loop, setLoop] = useState(player.loop);
  return (
    <button
      type="button"
      className={loop ? 'active' : ''}
      title="ループ再生"
      onClick={() => {
        player.setLoop(!loop);
        setLoop(!loop);
      }}
    >
      ⟳ ループ
    </button>
  );
}

export type { Clip };
