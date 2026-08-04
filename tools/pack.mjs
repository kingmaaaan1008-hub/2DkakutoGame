/**
 * アセットビルド 第2段階。
 *
 * build-assets.ps1 が .build/atlas に吐いた PNG アトラスを WebP に変換し、
 * ゲームが実際に読み込む assets/characters へ配置する。
 * WebP にすると同じ見た目のまま容量が 1/4 程度になる（PNG 12.4MB → 2.8MB）。
 *
 * sharp が入っていない環境では PNG のまま配置してマニフェストもそれに合わせる。
 * 見た目は変わらないので、開発を止めずに済ませるためのフォールバック。
 */
import { readdir, readFile, writeFile, mkdir, copyFile, rm } from 'node:fs/promises';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IN = path.join(ROOT, '.build', 'atlas');
const OUT = path.join(ROOT, 'assets', 'characters');

// 劣化が目視で分からず、かつ十分小さくなる設定。
// alphaQuality を 100 にしておかないと輪郭にハローが出る。
const WEBP = { quality: 82, alphaQuality: 100, effort: 6 };

let sharp = null;
try {
  ({ default: sharp } = await import('sharp'));
} catch {
  console.warn('! sharp が見つからないため PNG のまま配置します (npm i でインストールされます)');
}

async function main() {
  let entries;
  try {
    entries = await readdir(IN);
  } catch {
    console.error(`入力が見つかりません: ${IN}`);
    console.error('先に tools/build-assets.ps1 を実行してください。');
    process.exitCode = 1;
    return;
  }

  const ids = entries.filter((f) => f.endsWith('.json')).map((f) => path.basename(f, '.json'));
  if (ids.length === 0) {
    console.error(`${IN} にマニフェストがありません`);
    process.exitCode = 1;
    return;
  }

  await mkdir(OUT, { recursive: true });
  let totalIn = 0;
  let totalOut = 0;

  // 1 キャラが複数ページに分かれるので、前回の出力が残っていると
  // ページ数が減ったときに使われない画像が居座る。id で始まるものを一度掃除する。
  const stale = await readdir(OUT);

  for (const id of ids) {
    const raw = await readFile(path.join(IN, `${id}.json`), 'utf8');
    const manifest = JSON.parse(raw.replace(/^﻿/, '')); // 念のため BOM を落とす

    // <id>.webp（分割前の 1 枚もの）と <id>-N.webp/png の両方が対象。
    const owned = new RegExp(`^${id}(-\\d+)?\\.(webp|png)$`);
    await Promise.all(
      stale.filter((f) => owned.test(f)).map((f) => rm(path.join(OUT, f), { force: true }))
    );

    const outNames = [];
    for (const pageFile of manifest.images) {
      const srcPng = path.join(IN, pageFile);
      totalIn += (await stat(srcPng)).size;

      let outName;
      if (sharp) {
        outName = pageFile.replace(/\.png$/, '.webp');
        await sharp(srcPng).webp(WEBP).toFile(path.join(OUT, outName));
      } else {
        outName = pageFile;
        await copyFile(srcPng, path.join(OUT, outName));
      }

      const size = (await stat(path.join(OUT, outName))).size;
      totalOut += size;
      outNames.push(outName);
      console.log(`  ${outName.padEnd(20)} ${(size / 1048576).toFixed(2)} MB`);
    }

    manifest.images = outNames;
    await writeFile(path.join(OUT, `${id}.json`), JSON.stringify(manifest, null, 2) + '\n');
  }

  console.log(
    `\n${ids.length} キャラ  ${(totalIn / 1048576).toFixed(2)} MB -> ${(totalOut / 1048576).toFixed(2)} MB` +
      `  (${(totalOut / totalIn * 100).toFixed(0)}%)`
  );
  console.log(`出力: ${OUT}`);
}

await main();
