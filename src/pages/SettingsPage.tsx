import { useRef, useState } from 'react';
import { LayoutToggle } from '../components/LayoutToggle';
import { Brand, SiteNav } from '../components/SiteNav';
import { Field, Panel, Segmented, Toggle } from '../components/ui';
import { ASPECT_PRESETS } from '../model/types';
import {
  PANEL_LABELS,
  PANEL_SLOTS,
  SHORTCUT_LABELS,
  type PreviewQuality,
  shortcutFromEvent,
  shortcutLabel,
  useApp,
  type PanelSlot,
  type ShortcutAction,
} from '../store/app';
import type { Lang } from '../i18n';
import { saveBlob } from '../engine/exporter';
import { adoptProjectAssets, buildProjectFile, parseProjectFile, ProjectFileError } from '../engine/project-file';
import { useEditor } from '../store/editor';

const SLOT_LABELS: Record<PanelSlot, string> = { left: '左', right: '右', bottom: '下段' };

export default function SettingsPage() {
  const { settings, updateSettings, resetShortcuts, resetPanels } = useApp();
  const { project, dispatch } = useEditor();
  const [recording, setRecording] = useState<ShortcutAction | null>(null);
  const projectInput = useRef<HTMLInputElement>(null);
  const [handoff, setHandoff] = useState<{ kind: 'ok' | 'warn'; text: string } | null>(null);

  /** プロジェクトを 1 個のファイルに畳んで保存する。 */
  const saveProject = async () => {
    const file = buildProjectFile(project);
    const name = `${project.name || 'project'}.vivid.json`;
    try {
      await saveBlob(new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' }), name);
      setHandoff(
        file.localOnly.length > 0
          ? {
              kind: 'warn',
              text: `${name} を保存しました。ただし取り込んだ素材（${file.localOnly.join('・')}）は運べません。共有フォルダに置いて「共有」から入れ直すと、渡した相手でも開けます。`,
            }
          : { kind: 'ok', text: `${name} を保存しました。素材 ${file.assets.length} 個ぶんの在り処が入っています。` },
      );
    } catch (error) {
      setHandoff({ kind: 'warn', text: `保存できませんでした: ${error instanceof Error ? error.message : String(error)}` });
    }
  };

  /** もらったファイルを開く。いまの編集内容は置き換わる。 */
  const openProject = async (file: File) => {
    try {
      const parsed = parseProjectFile(await file.text());
      const added = await adoptProjectAssets(parsed);
      dispatch({ type: 'load', project: parsed.project });
      setHandoff({
        kind: parsed.localOnly.length > 0 ? 'warn' : 'ok',
        text:
          `「${parsed.project.name}」を開きました（素材 ${added} 個を追加）。` +
          (parsed.localOnly.length > 0
            ? ` 元の人の端末にしか無い素材（${parsed.localOnly.join('・')}）は入っていないので、その部分は空になります。`
            : ''),
      });
    } catch (error) {
      setHandoff({
        kind: 'warn',
        text: error instanceof ProjectFileError ? error.message : `開けませんでした: ${String(error)}`,
      });
    }
  };

  /** キーを 1 つ押して割り当てを覚える。 */
  const record = (action: ShortcutAction) => {
    setRecording(action);
    const onKey = (event: KeyboardEvent) => {
      event.preventDefault();
      if (event.key === 'Escape') {
        setRecording(null);
        window.removeEventListener('keydown', onKey, true);
        return;
      }
      if (['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'MetaLeft', 'MetaRight', 'AltLeft', 'AltRight'].includes(event.code)) {
        return;
      }
      updateSettings({ shortcuts: { ...settings.shortcuts, [action]: shortcutFromEvent(event) } });
      setRecording(null);
      window.removeEventListener('keydown', onKey, true);
    };
    window.addEventListener('keydown', onKey, true);
  };

  return (
    <div className="page">
      <header className="topbar">
        <Brand />
        <SiteNav />
        <div className="topbar-actions">
          <LayoutToggle />
        </div>
      </header>

      <main className="page-body">
        <Panel title="表示">
          <Field label="インターフェースの言語">
            <Segmented<Lang>
              value={settings.lang}
              options={[
                { value: 'ja', label: '日本語' },
                { value: 'en', label: 'English' },
              ]}
              onChange={(lang) => updateSettings({ lang })}
            />
          </Field>
          <Toggle label="タイムラインでクリップの端に吸着する" checked={settings.snap} onChange={(snap) => updateSettings({ snap })} />

          <Field label="プレビューの画質" hint="書き出しには影響しません">
            <Segmented
              value={String(settings.previewQuality)}
              options={[
                { value: '1080', label: '高' },
                { value: '720', label: '標準' },
                { value: '480', label: '軽い' },
              ]}
              onChange={(value) => updateSettings({ previewQuality: Number(value) as PreviewQuality })}
            />
          </Field>
          <p className="muted small">
            重い素材で再生がカクつくときは「軽い」にすると滑らかになります。プレビューの表示だけが粗くなり、
            書き出される動画の画質は変わりません。
          </p>
        </Panel>

        <Panel title="編集画面のレイアウト">
          <p className="muted small">
            素材・インスペクタ・タイムラインは、見出しを掴んで左右のレールや下段へ移せます。
            他のパネルの<strong>見出しの上に落とすと重なってタブ</strong>になり、
            見出しの <code>×</code> で仕舞えます。仕舞ったものは編集画面の「パネル」から戻せます。
            境目をドラッグすれば幅と高さも変えられます。
          </p>
          <ul className="layout-summary">
            {PANEL_SLOTS.map((slot) => (
              <li key={slot}>
                <span className="muted">{SLOT_LABELS[slot]}</span>
                <strong>
                  {settings.panels.slots[slot]
                    .map((group) => group.panels.map((id) => PANEL_LABELS[id]).join('＋'))
                    .join('・') || 'なし'}
                </strong>
              </li>
            ))}
            {settings.panels.hidden.length > 0 && (
              <li>
                <span className="muted">仕舞ってある</span>
                <strong>{settings.panels.hidden.map((id) => PANEL_LABELS[id]).join('・')}</strong>
              </li>
            )}
          </ul>
          <button type="button" className="wide" onClick={resetPanels}>
            配置を初期状態に戻す
          </button>
        </Panel>

        <Panel title="プロジェクトの受け渡し">
          <p className="muted small">
            編集内容をファイル 1 個にして、他の人に渡せます。
            <strong>素材は「共有」から入れたものだけが一緒に運べます</strong>
            （相手にも同じ共有フォルダが見えている必要があります）。
            取り込んだ素材はその端末の中にしか無いので運べません。
          </p>
          <input
            ref={projectInput}
            type="file"
            accept=".json,application/json"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void openProject(file);
              e.target.value = '';
            }}
          />
          <div className="chip-row">
            <button type="button" onClick={() => void saveProject()}>
              プロジェクトを書き出す
            </button>
            <button type="button" onClick={() => projectInput.current?.click()}>
              プロジェクトを開く
            </button>
          </div>
          {handoff && <p className={handoff.kind === 'warn' ? 'warn small' : 'muted small'}>{handoff.text}</p>}
        </Panel>

        <Panel title="共有素材フォルダ">
          <p className="muted small">
            NAS などに置いた共有フォルダの場所です。編集画面の「共有」から素材を選ぶときに使います。
            <strong>アプリと同じ場所（同じホスト・同じ口）から配られている必要があります</strong>。
            別の場所を指すとブラウザに止められます。
          </p>
          <Field label="素材フォルダ" hint="ページからの相対パス。既定は media/">
            <input
              type="text"
              value={settings.mediaBase}
              spellCheck={false}
              placeholder="media/"
              onChange={(e) => updateSettings({ mediaBase: e.target.value })}
            />
          </Field>
        </Panel>

        <Panel title="書き出しの既定値">
          <Field label="アスペクト比">
            <div className="chip-row wrap">
              {ASPECT_PRESETS.map((preset) => (
                <button
                  key={preset.key}
                  type="button"
                  className={settings.exportAspect === preset.key ? 'chip active' : 'chip'}
                  onClick={() => updateSettings({ exportAspect: preset.key })}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </Field>
          <Field label="画質">
            <Segmented
              value={String(settings.exportQuality)}
              options={[
                { value: '1080', label: '1080p' },
                { value: '720', label: '720p' },
                { value: '480', label: '480p' },
              ]}
              onChange={(value) => updateSettings({ exportQuality: Number(value) })}
            />
          </Field>
          <Field label="形式">
            <Segmented
              value={settings.exportFormat}
              options={[
                { value: 'auto', label: 'おまかせ' },
                { value: 'mp4', label: 'MP4' },
                { value: 'webm', label: 'WebM' },
              ]}
              onChange={(value) => updateSettings({ exportFormat: value as typeof settings.exportFormat })}
            />
          </Field>
        </Panel>

        <Panel
          title="ショートカットキー"
          action={
            <button type="button" onClick={resetShortcuts}>
              既定に戻す
            </button>
          }
        >
          <ul className="shortcut-list">
            {(Object.keys(SHORTCUT_LABELS) as ShortcutAction[]).map((action) => (
              <li key={action}>
                <span>{SHORTCUT_LABELS[action]}</span>
                <button
                  type="button"
                  className={recording === action ? 'active' : ''}
                  onClick={() => record(action)}
                  title="クリックしてから新しいキーを押してください（Esc で中止）"
                >
                  {recording === action ? 'キーを押す…' : shortcutLabel(settings.shortcuts[action])}
                </button>
              </li>
            ))}
          </ul>
        </Panel>
      </main>
    </div>
  );
}
