#!/usr/bin/env node
const fs = require('node:fs/promises');
const path = require('node:path');

const ROOT_DIR = path.resolve(__dirname, '..');
const LOTERIAS_DIR = path.join(ROOT_DIR, 'public', 'img', 'loterias');
const MANIFEST_PATH = path.join(LOTERIAS_DIR, 'manifest.json');
const ALLOWED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg']);

function toPosixRelativePath(fileName) {
  return path.posix.join('img/loterias', fileName);
}

async function generateManifest() {
  const entries = await fs.readdir(LOTERIAS_DIR, { withFileTypes: true });
  const images = await Promise.all(entries
    .filter((entry) => entry.isFile())
    .filter((entry) => entry.name !== 'manifest.json')
    .filter((entry) => ALLOWED_EXTENSIONS.has(path.extname(entry.name || '').toLowerCase()))
    .map(async (entry) => {
      const absolutePath = path.join(LOTERIAS_DIR, entry.name);
      const stats = await fs.stat(absolutePath);
      return {
        name: entry.name,
        path: toPosixRelativePath(entry.name),
        updatedAt: stats.mtime?.toISOString ? stats.mtime.toISOString() : undefined
      };
    }));

  const sortedImages = images.sort((a, b) => a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }));
  const payload = `${JSON.stringify(sortedImages, null, 2)}\n`;

  await fs.writeFile(MANIFEST_PATH, payload, 'utf8');
  console.log(`[loterias-manifest] ${sortedImages.length} imágenes registradas en ${MANIFEST_PATH}`);
}

generateManifest().catch((error) => {
  console.error('[loterias-manifest] Error generando manifest.json', error);
  process.exitCode = 1;
});
