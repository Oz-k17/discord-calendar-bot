/**
 * アプリ全体の設定とテンプレート。
 * エディタの状態とは寿命が違う（ページを跨いで生き残る）ので、別ストアにして localStorage に置く。
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { setLang, type Lang } from '../i18n';
import { uid } from '../model/factory';
import type { AspectKey, Sequence, TextProps } from '../model/types';
import { migrateStorageKey } from './storage';

export type ShortcutAction =
  | 'playPause'
  | 'split'
  | 'addText'
  | 'delete'
  | 'rippleDelete'
  | 'undo'
  | 'redo'
  | 'stepBack'
  | 'stepForward'
  | 'zoomIn'
  | 'zoomOut';

export const SHORTCUT_LABELS: Record<ShortcutAction, string> = {
  playPause: '再生 / 一時停止',
  split: '再生ヘッドで分割',
  addText: 'テロップを追加',
  delete: '削除',
  rippleDelete: 'リップル削除',
  undo: '元に戻す',
  redo: 'やり直す',
  stepBack: '1 フレーム戻る',
  stepForward: '1 フレーム進む',
  zoomIn: 'タイムラインを拡大',
  zoomOut: 'タイムラインを縮小',
};

export const DEFAULT_SHORTCUTS: Record<ShortcutAction, string> = {
  playPause: 'Space',
  split: 'KeyC',
  addText: 'KeyT',
  delete: 'Delete',
  rippleDelete: 'shift+Delete',
  undo: 'mod+KeyZ',
  redo: 'mod+shift+KeyZ',
  stepBack: 'ArrowLeft',
  stepForward: 'ArrowRight',
  zoomIn: 'mod+Equal',
  zoomOut: 'mod+Minus',
};

export type LayoutMode = 'desktop' | 'mobile';

/** 編集画面に置けるパネル。 */
export type PanelId = 'media' | 'inspector' | 'timeline';
/** パネルを置ける場所。 */
export type PanelSlot = 'left' | 'right' | 'bottom';

export const PANEL_IDS: PanelId[] = ['media', 'inspector', 'timeline'];
export const PANEL_SLOTS: PanelSlot[] = ['left', 'right', 'bottom'];

export const PANEL_LABELS: Record<PanelId, string> = {
  media: '素材',
  inspector: 'インスペクタ',
  timeline: 'タイムライン',
};

export interface PanelLayout {
  slots: Record<PanelSlot, PanelId[]>;
  /** 左右のレールの幅と、下段の高さ（px）。 */
  leftWidth: number;
  rightWidth: number;
  dockHeight: number;
}

export const DEFAULT_PANELS: PanelLayout = {
  slots: { left: ['media'], right: ['inspector'], bottom: ['timeline'] },
  leftWidth: 290,
  rightWidth: 330,
  dockHeight: 300,
};

export const PANEL_LIMITS = {
  railMin: 200,
  railMax: 560,
  dockMin: 120,
  dockMax: 720,
};

const clampSize = (value: number, min: number, max: number) =>
  Math.round(Math.max(min, Math.min(max, Number.isFinite(value) ? value : min)));

/**
 * 保存されたレイアウトを、必ず「すべてのパネルがちょうど 1 回ずつ出てくる」形に直す。
 * パネルが増えたり名前が変わったりしても、古い設定のせいで画面が欠けないようにするため。
 */
export function sanitizePanels(layout: Partial<PanelLayout> | undefined): PanelLayout {
  const slots: Record<PanelSlot, PanelId[]> = { left: [], right: [], bottom: [] };
  const placed = new Set<PanelId>();
  for (const slot of PANEL_SLOTS) {
    for (const id of layout?.slots?.[slot] ?? []) {
      if (!PANEL_IDS.includes(id) || placed.has(id)) continue;
      placed.add(id);
      slots[slot].push(id);
    }
  }
  for (const id of PANEL_IDS) {
    if (placed.has(id)) continue;
    const home = PANEL_SLOTS.find((slot) => DEFAULT_PANELS.slots[slot].includes(id)) ?? 'left';
    slots[home].push(id);
  }
  return {
    slots,
    leftWidth: clampSize(layout?.leftWidth ?? DEFAULT_PANELS.leftWidth, PANEL_LIMITS.railMin, PANEL_LIMITS.railMax),
    rightWidth: clampSize(layout?.rightWidth ?? DEFAULT_PANELS.rightWidth, PANEL_LIMITS.railMin, PANEL_LIMITS.railMax),
    dockHeight: clampSize(layout?.dockHeight ?? DEFAULT_PANELS.dockHeight, PANEL_LIMITS.dockMin, PANEL_LIMITS.dockMax),
  };
}

/** プレビューを描く解像度（長辺の px）。書き出しの画質には影響しない。 */
export type PreviewQuality = 480 | 720 | 1080;

export interface Settings {
  lang: Lang;
  layout: LayoutMode;
  previewQuality: PreviewQuality;
  exportQuality: number;
  exportAspect: AspectKey;
  exportFormat: 'auto' | 'mp4' | 'webm';
  snap: boolean;
  shortcuts: Record<ShortcutAction, string>;
  /** 編集画面のパネル配置。 */
  panels: PanelLayout;
}

/** 初回だけ画面幅で当たりをつける。以後はユーザーが選んだものを記憶する。 */
function guessLayout(): LayoutMode {
  return typeof window !== 'undefined' && window.innerWidth < 820 ? 'mobile' : 'desktop';
}

export const DEFAULT_SETTINGS: Settings = {
  lang: 'ja',
  layout: 'desktop',
  previewQuality: 720,
  exportQuality: 1080,
  exportAspect: '9:16',
  exportFormat: 'auto',
  snap: true,
  shortcuts: { ...DEFAULT_SHORTCUTS },
  panels: DEFAULT_PANELS,
};

export interface TextTemplate {
  id: string;
  kind: 'text';
  name: string;
  text: TextProps;
  createdAt: number;
}

export interface LayoutTemplate {
  id: string;
  kind: 'layout';
  name: string;
  sequence: Sequence;
  createdAt: number;
}

export type Template = TextTemplate | LayoutTemplate;

const SETTINGS_KEY = 'vivid.settings';
const TEMPLATES_KEY = 'vivid.templates';

// 旧名で保存されていた分を引き継ぐ（アプリ名変更にともなう一度きりの処理）。
migrateStorageKey('tateyoko.settings', SETTINGS_KEY);
migrateStorageKey('tateyoko.templates', TEMPLATES_KEY);

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? ({ ...fallback, ...JSON.parse(raw) } as T) : fallback;
  } catch {
    return fallback;
  }
}

function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 容量超過などは黙って諦める */
  }
}

interface AppApi {
  settings: Settings;
  updateSettings: (patch: Partial<Settings>) => void;
  resetShortcuts: () => void;
  /** 編集画面のパネル配置を更新する（保存まで面倒をみる）。 */
  updatePanels: (patch: Partial<PanelLayout>) => void;
  resetPanels: () => void;
  templates: Template[];
  addTemplate: (template: Omit<TextTemplate, 'id' | 'createdAt'> | Omit<LayoutTemplate, 'id' | 'createdAt'>) => Template;
  removeTemplate: (id: string) => void;
  renameTemplate: (id: string, name: string) => void;
}

const AppContext = createContext<AppApi | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(() => {
    const loaded = load(SETTINGS_KEY, { ...DEFAULT_SETTINGS, layout: guessLayout() });
    return { ...loaded, panels: sanitizePanels(loaded.panels) };
  });
  const [templates, setTemplates] = useState<Template[]>(() => {
    try {
      const raw = localStorage.getItem(TEMPLATES_KEY);
      return raw ? (JSON.parse(raw) as Template[]) : [];
    } catch {
      return [];
    }
  });

  useEffect(() => {
    setLang(settings.lang);
    // 管理ページ側の CSS もここを見て切り替える
    document.documentElement.dataset.layout = settings.layout;
    save(SETTINGS_KEY, settings);
  }, [settings]);

  useEffect(() => {
    save(TEMPLATES_KEY, templates);
  }, [templates]);

  const updateSettings = useCallback((patch: Partial<Settings>) => {
    setSettings((prev) => ({ ...prev, ...patch }));
  }, []);

  const resetShortcuts = useCallback(() => {
    setSettings((prev) => ({ ...prev, shortcuts: { ...DEFAULT_SHORTCUTS } }));
  }, []);

  const updatePanels = useCallback((patch: Partial<PanelLayout>) => {
    setSettings((prev) => ({ ...prev, panels: sanitizePanels({ ...prev.panels, ...patch }) }));
  }, []);

  const resetPanels = useCallback(() => {
    setSettings((prev) => ({ ...prev, panels: sanitizePanels(DEFAULT_PANELS) }));
  }, []);

  const addTemplate = useCallback<AppApi['addTemplate']>((template) => {
    const created = { ...template, id: uid('tpl'), createdAt: Date.now() } as Template;
    setTemplates((prev) => [created, ...prev]);
    return created;
  }, []);

  const removeTemplate = useCallback((id: string) => {
    setTemplates((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const renameTemplate = useCallback((id: string, name: string) => {
    setTemplates((prev) => prev.map((t) => (t.id === id ? { ...t, name } : t)));
  }, []);

  const value = useMemo<AppApi>(
    () => ({
      settings,
      updateSettings,
      resetShortcuts,
      updatePanels,
      resetPanels,
      templates,
      addTemplate,
      removeTemplate,
      renameTemplate,
    }),
    [settings, updateSettings, resetShortcuts, updatePanels, resetPanels, templates, addTemplate, removeTemplate, renameTemplate],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppApi {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('AppProvider の外側で useApp が呼ばれました');
  return ctx;
}

/** KeyboardEvent を 'mod+shift+KeyZ' 形式にする。 */
export function shortcutFromEvent(event: KeyboardEvent): string {
  const parts: string[] = [];
  if (event.metaKey || event.ctrlKey) parts.push('mod');
  if (event.shiftKey) parts.push('shift');
  if (event.altKey) parts.push('alt');
  parts.push(event.code);
  return parts.join('+');
}

export function shortcutLabel(value: string): string {
  return value
    .replace('mod', 'Ctrl/⌘')
    .replace('shift', 'Shift')
    .replace('alt', 'Alt')
    .replace('Key', '')
    .replace('Digit', '')
    .replace('Equal', '+')
    .replace('Minus', '-')
    .replace('Arrow', '')
    .replace(/\+/g, ' + ')
    .replace('Ctrl/⌘ + ', 'Ctrl/⌘+');
}
