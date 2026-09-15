/**
 * NAS に置いた素材フォルダを覗く。
 *
 * 素材そのものは取り込まず、URL で参照するだけなので（`media.ts` の「参照」）、
 * ここがやるのは「そのフォルダに何があるか」を知ることだけ。
 *
 * 一覧の取り方は NAS の Web サーバによって違う。こちらから指定できないので、
 * よくある 3 つを順に試して、最初に読めたものを使う:
 *
 *   1. nginx の `autoindex_format json` … 素直な JSON が返る。推奨の構成（deploy/nas/）はこれ
 *   2. ふつうの HTML のフォルダ一覧 … nginx / Apache の既定。<a href> を拾う
 *   3. 手書きの `media.json` … Web サーバに一覧を出させられないとき用の逃げ道
 *
 * どれも同じオリジンから読む前提。別オリジンだと CORS で弾かれるので、
 * アプリと素材は同じ Web サーバから配ること（deploy/nas/README.md）。
 */

import { kindOfName } from './media';

export interface LibraryEntry {
  /** 表示名（ファイル名 / フォルダ名）。 */
  name: string;
  /** ベース URL からの相対パス。素材として登録するときはこれをそのまま渡す。 */
  path: string;
  kind: 'folder' | 'video' | 'image' | 'audio';
  /** 分かれば。フォルダや、一覧に出ていないときは undefined。 */
  size?: number;
}

/** 末尾のスラッシュを 1 つに揃える。連結の食い違いを無くすため。 */
export function asFolder(base: string): string {
  return base.replace(/\/+$/, '') + '/';
}

/** nginx の autoindex_format json が返す形。 */
interface NginxEntry {
  name?: unknown;
  type?: unknown;
  size?: unknown;
}

function fromNginxJson(text: string): LibraryEntry[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const out: LibraryEntry[] = [];
  for (const raw of parsed as NginxEntry[]) {
    if (!raw || typeof raw.name !== 'string') return null; // 形が違う。別の読み方に譲る。
    const isDir = raw.type === 'directory';
    const entry = toEntry(raw.name, isDir);
    if (entry) out.push({ ...entry, size: typeof raw.size === 'number' ? raw.size : undefined });
  }
  return out;
}

/**
 * 手書きの一覧。ファイル名の配列でも、{ files: [...] } でも受ける。
 * 書く側に規則を覚えてもらうほどの物ではないので、緩く読む。
 */
function fromManifest(text: string): LibraryEntry[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { files?: unknown })?.files)
      ? (parsed as { files: unknown[] }).files
      : null;
  if (!list) return null;
  const out: LibraryEntry[] = [];
  for (const raw of list) {
    const name = typeof raw === 'string' ? raw : typeof (raw as { name?: unknown })?.name === 'string' ? (raw as { name: string }).name : null;
    if (!name) continue;
    const entry = toEntry(name, name.endsWith('/'));
    if (entry) out.push(entry);
  }
  return out;
}

/**
 * HTML のフォルダ一覧から <a href> を拾う。
 * 親フォルダへのリンクや、並び替え用のリンク（?C=N;O=D）は素材ではないので落とす。
 */
function fromHtml(text: string): LibraryEntry[] {
  const out: LibraryEntry[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(/<a\s+[^>]*href="([^"]+)"/gi)) {
    const href = match[1];
    if (!href || href.startsWith('?') || href.startsWith('#') || href.startsWith('/')) continue;
    if (href === '../' || href === './' || /^[a-z]+:/i.test(href)) continue;
    const name = decodeURIComponent(href.replace(/\/$/, ''));
    if (seen.has(name)) continue;
    seen.add(name);
    const entry = toEntry(name, href.endsWith('/'));
    if (entry) out.push(entry);
  }
  return out;
}

function toEntry(rawName: string, isDir: boolean): LibraryEntry | null {
  const name = rawName.replace(/\/$/, '');
  if (!name || name.startsWith('.')) return null; // 隠しファイルは出さない
  if (isDir) return { name, path: `${encodeURIComponent(name)}/`, kind: 'folder' };
  const kind = kindOfName(name);
  if (!kind) return null; // 扱えない形式は一覧に出さない（選ばせてから断るより親切）
  return { name, path: encodeURIComponent(name), kind };
}

export class LibraryError extends Error {}

/**
 * フォルダの中身を一覧する。
 * `base` は素材フォルダ、`path` はその中の相対パス（空なら直下）。
 */
export async function listFolder(base: string, path = ''): Promise<LibraryEntry[]> {
  const url = asFolder(asFolder(base) + path);

  let response: Response;
  try {
    response = await fetch(url, { headers: { accept: 'application/json, text/html' } });
  } catch (error) {
    throw new LibraryError(
      `${url} に繋がりませんでした。NAS が動いているか、アプリと同じ場所から配られているか確かめてください。（${String(error)}）`,
    );
  }
  if (!response.ok) {
    // 一覧が閉じている Web サーバは 403 を返す。その場合は media.json を探す。
    const manifest = await fetchManifest(url);
    if (manifest) return sortEntries(manifest);
    throw new LibraryError(
      `${url} の一覧を取れませんでした（HTTP ${response.status}）。フォルダ一覧を有効にするか、media.json を置いてください。`,
    );
  }

  const text = await response.text();
  const json = fromNginxJson(text);
  if (json) return sortEntries(json);

  const html = fromHtml(text);
  if (html.length > 0) return sortEntries(html);

  const manifest = await fetchManifest(url);
  if (manifest) return sortEntries(manifest);

  return []; // 繋がってはいるが、中身が無い（か、読み取れる形で出ていない）
}

async function fetchManifest(folderUrl: string): Promise<LibraryEntry[] | null> {
  try {
    const response = await fetch(`${folderUrl}media.json`);
    if (!response.ok) return null;
    return fromManifest(await response.text());
  } catch {
    return null;
  }
}

/** フォルダを先に、あとは名前順。数字混じりの名前が素直に並ぶよう numeric で比べる。 */
function sortEntries(entries: LibraryEntry[]): LibraryEntry[] {
  return [...entries].sort((a, b) => {
    if ((a.kind === 'folder') !== (b.kind === 'folder')) return a.kind === 'folder' ? -1 : 1;
    return a.name.localeCompare(b.name, 'ja', { numeric: true });
  });
}
