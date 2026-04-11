#!/usr/bin/env node
const admin = require('firebase-admin');
const fs = require('fs');

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function resolveCredentialsPath() {
  const provided = process.env.GOOGLE_APPLICATION_CREDENTIALS || './serviceAccountKey.json';
  if (!fs.existsSync(provided)) {
    throw new Error(`No se encontró el archivo de credenciales en: ${provided}`);
  }
  return provided;
}

function normalizeAlias(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, '')
    .slice(0, 40);
}

async function main() {
  const args = parseArgs(process.argv);
  const applyChanges = Boolean(args.apply);
  const credentialsPath = resolveCredentialsPath();

  admin.initializeApp({
    credential: admin.credential.cert(require(credentialsPath))
  });

  const db = admin.firestore();
  const usersSnap = await db.collection('users').get();

  let reviewed = 0;
  let updated = 0;
  let skipped = 0;
  let batch = db.batch();
  let pendingOps = 0;

  for (const doc of usersSnap.docs) {
    reviewed += 1;
    const data = doc.data() || {};
    const alias = normalizeAlias(data.alias);
    if (!alias) {
      skipped += 1;
      continue;
    }
    const aliasLower = alias.toLocaleLowerCase('es');
    if (data.aliasLower === aliasLower) {
      skipped += 1;
      continue;
    }
    updated += 1;
    if (applyChanges) {
      batch.set(doc.ref, { aliasLower }, { merge: true });
      pendingOps += 1;
      if (pendingOps >= 400) {
        await batch.commit();
        batch = db.batch();
        pendingOps = 0;
      }
    }
  }

  if (applyChanges && pendingOps > 0) {
    await batch.commit();
  }

  if (!applyChanges) {
    console.log(`[DRY RUN] Documentos revisados: ${reviewed}`);
    console.log(`[DRY RUN] Documentos para actualizar aliasLower: ${updated}`);
    console.log(`[DRY RUN] Documentos omitidos: ${skipped}`);
    console.log('Para aplicar cambios, ejecuta: node scripts/backfillAliasLower.js --apply');
    return;
  }

  console.log(`Documentos revisados: ${reviewed}`);
  console.log(`Documentos actualizados aliasLower: ${updated}`);
  console.log(`Documentos omitidos: ${skipped}`);
}

main().then(() => process.exit(0)).catch((err) => {
  console.error('Error en backfill de aliasLower:', err.message || err);
  process.exit(1);
});
