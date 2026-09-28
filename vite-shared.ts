import type { Plugin } from 'vite';

/**
 * 出力した <script> から type="module" と crossorigin を外す。
 * どちらも file:// から読むと CORS で弾かれ、ファイルを直接開いた場合と
 * iOS 版の WKWebView（file:// で読み込む）で画面が真っ白になる。
 * 中身は IIFE なので、module 指定なしの defer で同じ挙動になる。
 *
 * 本体（vite.config.ts）とラボ（lab/auto-cut/vite.config.ts）の両方で使う。
 * ラボも docs/lab/ に置いて配る以上、同じ制約を受けるため。
 */
export function classicScript(): Plugin {
  return {
    name: 'classic-script-tag',
    enforce: 'post',
    transformIndexHtml(html) {
      return html.replace(/<script\s+type="module"\s+crossorigin\s+/g, '<script defer ');
    },
  };
}

/** 1 ファイルの IIFE にまとめる。上と同じ理由（file:// では import が使えない）。 */
export const singleFileOutput = {
  format: 'iife' as const,
  inlineDynamicImports: true,
  entryFileNames: 'assets/[name]-[hash].js',
  chunkFileNames: 'assets/[name]-[hash].js',
  assetFileNames: 'assets/[name]-[hash].[ext]',
};
