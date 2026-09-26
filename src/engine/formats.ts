/**
 * 読み込める映像の入れ物（コンテナ）。
 * mediabunny の ALL_FORMATS を使うと全形式のデマルチプレクサを抱き込んで
 * 配布物が倍近くになるので、このアプリが実際に扱うものだけに絞っている。
 */
import { MATROSKA, MP4, QTFF, WEBM } from 'mediabunny';

export const VIDEO_INPUT_FORMATS = [MP4, QTFF, MATROSKA, WEBM];
