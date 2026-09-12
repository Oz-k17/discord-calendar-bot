import { useCallback, useEffect, useState } from 'react';
import { asFolder, listFolder, LibraryError, type LibraryEntry } from '../../engine/library';
import { mediaRegistry, UNSORTED } from '../../engine/media';
import { useApp } from '../../store/app';

/**
 * 共有素材フォルダ（NAS）から素材を選ぶ窓。
 *
 * 選んでも実体は取り込まず、URL の参照として登録する（`media.ts` を見よ）。
 * 同じフォルダが見える人なら、プロジェクトを渡すだけで同じ素材が開ける。
 */
export function NasBrowser({ onClose }: { onClose: () => void }) {
  const { settings, updateSettings } = useApp();
  const [base, setBase] = useState(settings.mediaBase);
  const [path, setPath] = useState('');
  const [entries, setEntries] = useState<LibraryEntry[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);

  const load = useCallback(
    async (nextPath: string) => {
      setBusy(true);
      setError(null);
      try {
        setEntries(await listFolder(base, nextPath));
        setPath(nextPath);
        setPicked(new Set());
      } catch (e) {
        setEntries([]);
        setError(e instanceof LibraryError ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [base],
  );

  useEffect(() => {
    void load('');
  }, [load]);

  // パンくず。空文字の要素が先頭（＝素材フォルダそのもの）。
  const crumbs = path.split('/').filter(Boolean);

  const toggle = (entry: LibraryEntry) => {
    setPicked((prev) => {
      const next = new Set(prev);
      const key = path + entry.path;
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const add = async () => {
    setAdding(true);
    const failed: string[] = [];
    // NAS のフォルダ名を、そのままライブラリのフォルダ名にする。
    // 向こうで整理してあるものを、こちらで整理し直させる意味がない。
    const folder = crumbs.length > 0 ? decodeURIComponent(crumbs[crumbs.length - 1]) : UNSORTED;
    for (const relative of picked) {
      try {
        await mediaRegistry.addFromUrl(asFolder(base) + relative, folder);
      } catch (e) {
        failed.push(`${relative}: ${e instanceof Error ? e.message : '読み込み失敗'}`);
      }
    }
    setAdding(false);
    if (failed.length > 0) setError(failed.join(' / '));
    else onClose();
  };

  return (
    <div className="modal-backdrop" onClick={() => !adding && onClose()}>
      <div className="modal wide-modal" onClick={(e) => e.stopPropagation()}>
        <h2>共有フォルダから追加</h2>
        <p className="muted small">
          選んだ素材は<strong>コピーせずに参照</strong>します。同じフォルダが見える人なら、
          プロジェクトを渡すだけで同じ素材を開けます。
        </p>

        <label className="field">
          <span className="field-label">
            素材フォルダ
            <span className="field-hint">アプリと同じ場所から配られている必要があります</span>
          </span>
          <div className="base-row">
            <input
              type="text"
              value={base}
              spellCheck={false}
              onChange={(e) => setBase(e.target.value)}
              placeholder="media/"
            />
            <button
              type="button"
              onClick={() => {
                updateSettings({ mediaBase: base });
                void load('');
              }}
              disabled={busy}
            >
              {busy ? '確認中…' : '開く'}
            </button>
          </div>
        </label>

        <div className="crumbs">
          <button type="button" className="chip" onClick={() => void load('')} disabled={busy}>
            素材
          </button>
          {crumbs.map((name, i) => (
            <button
              key={`${name}-${i}`}
              type="button"
              className="chip"
              disabled={busy || i === crumbs.length - 1}
              onClick={() => void load(crumbs.slice(0, i + 1).join('/') + '/')}
            >
              {decodeURIComponent(name)}
            </button>
          ))}
        </div>

        {error && <p className="warn small">{error}</p>}

        <ul className="nas-list">
          {entries.map((entry) => {
            const key = path + entry.path;
            return (
              <li key={key}>
                {entry.kind === 'folder' ? (
                  <button type="button" className="nas-row" onClick={() => void load(key)} disabled={busy}>
                    <span className="nas-kind">フォルダ</span>
                    {entry.name}
                  </button>
                ) : (
                  <label className={picked.has(key) ? 'nas-row picked' : 'nas-row'}>
                    <input type="checkbox" checked={picked.has(key)} onChange={() => toggle(entry)} />
                    <span className="nas-kind">{KIND_LABEL[entry.kind]}</span>
                    {entry.name}
                    {entry.size !== undefined && <span className="nas-size">{formatSize(entry.size)}</span>}
                  </label>
                )}
              </li>
            );
          })}
          {!busy && entries.length === 0 && !error && (
            <li className="muted small">このフォルダには、扱える素材がありません。</li>
          )}
        </ul>

        <div className="modal-actions">
          <button type="button" onClick={onClose} disabled={adding}>
            閉じる
          </button>
          <button type="button" className="primary" onClick={() => void add()} disabled={adding || picked.size === 0}>
            {adding ? '追加中…' : `${picked.size} 個を追加`}
          </button>
        </div>
      </div>
    </div>
  );
}

const KIND_LABEL: Record<string, string> = { video: '動画', image: '画像', audio: '音声' };

function formatSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
