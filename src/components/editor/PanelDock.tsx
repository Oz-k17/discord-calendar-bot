/**
 * 編集画面のパネル配置。
 *
 * パネルは「左レール / 右レール / 下段」の 3 つの置き場のあいだを行き来できる。
 * 掴むのは各パネルの見出し（.panel-head）で、そこは中身のコンポーネントが
 * 自前で描いているため、ドラッグの開始だけをコンテキストで渡している。
 * HTML5 の drag&drop ではなく Pointer Events を使うのは、これならタッチでも
 * 同じコードで動くため。
 */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import {
  PANEL_LABELS,
  PANEL_LIMITS,
  PANEL_SLOTS,
  useApp,
  type PanelId,
  type PanelSlot,
} from '../../store/app';

interface DropTarget {
  slot: PanelSlot;
  index: number;
}

interface DockState {
  /** いま掴んでいるパネル。掴んでいなければ null。 */
  dragging: PanelId | null;
  target: DropTarget | null;
  pointer: { x: number; y: number } | null;
}

interface DockApi extends DockState {
  beginDrag: (id: PanelId, event: ReactPointerEvent) => void;
}

const DockContext = createContext<DockApi | null>(null);
/** いま描いているパネルの id。Panel 側が「自分を掴ませる」ために読む。 */
const DockPanelContext = createContext<PanelId | null>(null);

export function useDockGrip(): { onPointerDown: (event: ReactPointerEvent) => void; dragging: boolean } | null {
  const dock = useContext(DockContext);
  const id = useContext(DockPanelContext);
  if (!dock || !id) return null;
  return {
    onPointerDown: (event: ReactPointerEvent) => dock.beginDrag(id, event),
    dragging: dock.dragging === id,
  };
}

/** 置き場ごとの DOM。ドロップ先の判定に使う。 */
type SlotElements = Partial<Record<PanelSlot, HTMLElement | null>>;

/**
 * ポインタの位置から「どの置き場の、何番目に入れるか」を求める。
 * レールは縦並び、下段は横並びなので、比べる軸を変えている。
 */
function findTarget(elements: SlotElements, x: number, y: number): DropTarget | null {
  for (const slot of PANEL_SLOTS) {
    const el = elements[slot];
    if (!el) continue;
    const rect = el.getBoundingClientRect();
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) continue;
    const horizontal = slot === 'bottom';
    const items = [...el.querySelectorAll<HTMLElement>(':scope > .dock-item')];
    let index = items.length;
    for (let i = 0; i < items.length; i += 1) {
      const box = items[i].getBoundingClientRect();
      const middle = horizontal ? box.left + box.width / 2 : box.top + box.height / 2;
      if ((horizontal ? x : y) < middle) {
        index = i;
        break;
      }
    }
    return { slot, index };
  }
  return null;
}

const SlotRegistryContext = createContext<(slot: PanelSlot, el: HTMLElement | null) => void>(() => {});

export function DockProvider({ children }: { children: ReactNode }) {
  const { settings, updatePanels } = useApp();
  const elements = useRef<SlotElements>({});
  const [state, setState] = useState<DockState>({ dragging: null, target: null, pointer: null });
  // ドラッグ中の値をイベントハンドラから読むための箱。
  const live = useRef<DockState>(state);
  live.current = state;

  const registerSlot = useCallback((slot: PanelSlot, el: HTMLElement | null) => {
    elements.current[slot] = el;
  }, []);

  const beginDrag = useCallback(
    (id: PanelId, event: ReactPointerEvent) => {
      // 見出しの中のボタン（＋追加・削除など）を押したときは掴まない。
      if ((event.target as HTMLElement).closest('button, input, select, textarea, a')) return;
      event.preventDefault();
      setState({ dragging: id, target: null, pointer: { x: event.clientX, y: event.clientY } });

      const move = (e: PointerEvent) => {
        setState({
          dragging: id,
          target: findTarget(elements.current, e.clientX, e.clientY),
          pointer: { x: e.clientX, y: e.clientY },
        });
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        const target = live.current.target;
        setState({ dragging: null, target: null, pointer: null });
        if (!target) return;

        const slots = { ...settings.panels.slots };
        for (const slot of PANEL_SLOTS) slots[slot] = slots[slot].filter((p) => p !== id);
        // 取り除いたぶん、同じ置き場の中では入れる位置が 1 つ手前になることがある。
        const before = settings.panels.slots[target.slot].indexOf(id);
        const index = before >= 0 && before < target.index ? target.index - 1 : target.index;
        slots[target.slot] = [
          ...slots[target.slot].slice(0, index),
          id,
          ...slots[target.slot].slice(index),
        ];
        updatePanels({ slots });
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    },
    [settings.panels.slots, updatePanels],
  );

  const api = useMemo<DockApi>(() => ({ ...state, beginDrag }), [state, beginDrag]);

  return (
    <DockContext.Provider value={api}>
      <SlotRegistryContext.Provider value={registerSlot}>
        {children}
        {state.dragging && state.pointer && (
          <div className="dock-ghost" style={{ left: state.pointer.x, top: state.pointer.y }}>
            {PANEL_LABELS[state.dragging]}
          </div>
        )}
      </SlotRegistryContext.Provider>
    </DockContext.Provider>
  );
}

/** 置き場ひとつ。中に並ぶパネルの実体は render で受け取る。 */
export function DockSlot({
  slot,
  render,
  className,
  style,
}: {
  slot: PanelSlot;
  render: (id: PanelId) => ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  const { settings } = useApp();
  const dock = useContext(DockContext);
  const registerSlot = useContext(SlotRegistryContext);
  const ids = settings.panels.slots[slot];
  const target = dock?.target?.slot === slot ? dock.target.index : null;

  if (ids.length === 0 && !dock?.dragging) return null;

  return (
    <div
      ref={(el) => registerSlot(slot, el)}
      className={`dock-slot slot-${slot}${className ? ` ${className}` : ''}${dock?.dragging ? ' droppable' : ''}${
        target !== null ? ' hovered' : ''
      }`}
      style={style}
    >
      {ids.map((id, i) => (
        <div key={id} className={`dock-item item-${id}${dock?.dragging === id ? ' dragging' : ''}`}>
          {target === i && <div className="dock-marker" />}
          <DockPanelContext.Provider value={id}>{render(id)}</DockPanelContext.Provider>
        </div>
      ))}
      {target === ids.length && <div className="dock-marker" />}
      {ids.length === 0 && <p className="dock-empty">ここへ</p>}
    </div>
  );
}

/**
 * 置き場の境目。ドラッグで幅・高さを変える。
 * axis が 'x' なら左右、'y' なら上下。sign は「引いた向きに増えるか減るか」。
 */
export function DockSplitter({
  axis,
  value,
  sign = 1,
  onChange,
  label,
}: {
  axis: 'x' | 'y';
  value: number;
  sign?: 1 | -1;
  onChange: (next: number) => void;
  label: string;
}) {
  const min = axis === 'x' ? PANEL_LIMITS.railMin : PANEL_LIMITS.dockMin;
  const max = axis === 'x' ? PANEL_LIMITS.railMax : PANEL_LIMITS.dockMax;

  const onPointerDown = (event: ReactPointerEvent) => {
    event.preventDefault();
    const origin = axis === 'x' ? event.clientX : event.clientY;
    const start = value;
    const move = (e: PointerEvent) => {
      const delta = ((axis === 'x' ? e.clientX : e.clientY) - origin) * sign;
      onChange(Math.round(Math.max(min, Math.min(max, start + delta))));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div
      className={`dock-splitter axis-${axis}`}
      role="separator"
      aria-label={label}
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      onPointerDown={onPointerDown}
      onDoubleClick={() => onChange(axis === 'x' ? PANEL_LIMITS.railMin : PANEL_LIMITS.dockMin)}
      title={`${label}（ドラッグで幅を変更）`}
    />
  );
}
