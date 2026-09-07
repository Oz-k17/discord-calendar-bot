/**
 * 画面まで含めて確かめたいときの下ごしらえ。
 *
 * playwright はリポジトリの依存には入れていない（本体の配布物とは関係が無いので）。
 * グローバルに入っていればそれを使い、無ければ「飛ばした」と分かる形で終わる。
 * 判断そのものは selftest（ブラウザ不要）で押さえてあるので、
 * ここが動かない環境でも作業は続けられる、という切り分けにしてある。
 */

import { execSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';

/** グローバルに入っている playwright を借りる。無ければ null。 */
export function loadPlaywright() {
  for (const base of [process.cwd(), globalRoot()]) {
    if (!base) continue;
    try {
      return createRequire(path.join(base, 'noop.js'))('playwright');
    } catch {
      /* 次を試す */
    }
  }
  return null;
}

function globalRoot() {
  try {
    return execSync('npm root -g', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

/** 空いているポートを 1 つ借りる。決め打ちにすると他の作業とぶつかる。 */
export function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/**
 * vite の開発サーバを立ち上げ、URL と止め方を返す。
 * ビルドを挟まないので、書き換えてすぐ確かめられる。
 */
export async function serve(root, { timeoutMs = 40000 } = {}) {
  const port = await freePort();
  const child = spawn('npx', ['vite', root, '--port', String(port), '--strictPort'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const url = `http://127.0.0.1:${port}/`;

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`vite が ${timeoutMs}ms 以内に起動しませんでした`)), timeoutMs);
    const onData = (chunk) => {
      if (String(chunk).includes(String(port))) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`vite が終了しました（コード ${code}）`));
    });
  });

  return { url, stop: () => child.kill() };
}

/** swiftshader 指定は、GPU の無い環境でも canvas が描けるようにするため。 */
export async function launch(playwright) {
  return playwright.chromium.launch({
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
  });
}
