/**
 * Web 版のビルド結果を、配布用の 2 か所へ配る。
 *
 *  - docs/                      … そのまま開ける Web 版。GitHub Pages の公開元にもできる
 *  - ios/ViVidEdit.swiftpm/...  … iOS 版に同梱する分
 *
 * ラボ（lab/auto-cut）のビルド結果があれば docs/lab/ にも置く。
 * docs/ は毎回まるごと作り直すので、ここで一緒に配らないと消えてしまう。
 * iOS 版には入れない（同梱するのは製品のほうだけ）。
 *
 * 通常ならビルド生成物はコミットしないが、ここでは
 * 「リポジトリを落として index.html を開けば動く」「iPad には npm が無い」
 * という 2 点を優先して、あえてリポジトリに含めている。
 */
import { cp, mkdir, rm, readdir, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const dist = path.join(root, 'dist');

const targets = [
  path.join(root, 'docs'),
  path.join(root, 'ios', 'ViVidEdit.swiftpm', 'Resources', 'web'),
];

if (!existsSync(dist)) {
  console.error('dist/ がありません。先に `npm run build` を実行してください。');
  process.exit(1);
}

async function totalBytes(dir) {
  let sum = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    sum += entry.isDirectory() ? await totalBytes(full) : (await stat(full)).size;
  }
  return sum;
}

for (const target of targets) {
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  await cp(dist, target, { recursive: true });
  const bytes = await totalBytes(target);
  console.log(`同梱しました: ${path.relative(root, target)} (${(bytes / 1024).toFixed(0)} KB)`);
}

const labDist = path.join(root, 'lab', 'auto-cut', 'dist');
if (existsSync(labDist)) {
  const labTarget = path.join(root, 'docs', 'lab');
  await cp(labDist, labTarget, { recursive: true });
  console.log(`同梱しました: ${path.relative(root, labTarget)} (${((await totalBytes(labTarget)) / 1024).toFixed(0)} KB)`);
} else {
  console.log('ラボのビルドが無いので docs/lab は作りませんでした（`npm run lab:build` で作れます）。');
}

// GitHub Pages は既定で Jekyll が走り、_ で始まるファイルなどを無視してしまう。
await writeFile(path.join(root, 'docs', '.nojekyll'), '');
