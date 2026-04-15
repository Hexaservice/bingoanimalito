#!/usr/bin/env node
const admin = require('firebase-admin');
const fs = require('fs');

const WINNER_LOCKS_COLLECTION = 'GanadoresSorteosTiempoReal';
const LEGACY_FIELD = 'ganadoresBloqueadosPorForma';

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

function normalizeWinnerKeys(raw = []) {
  if (!Array.isArray(raw)) return [];
  return Array.from(new Set(
    raw
      .map((item) => String(item || '').trim())
      .filter(Boolean)
  ));
}

async function main() {
  const args = parseArgs(process.argv);
  const dryRun = args['dry-run'] !== 'false';
  const removeLegacy = args['remove-legacy'] === 'true';
  const limit = Number(args.limit || 0);

  const credentialsPath = resolveCredentialsPath();
  admin.initializeApp({
    credential: admin.credential.cert(require(credentialsPath))
  });

  const db = admin.firestore();
  const sorteosSnap = await db.collection('sorteos').get();
  let revisados = 0;
  let sorteosConLegacy = 0;
  let locksMigrados = 0;
  let legacyRemovidos = 0;
  let batch = db.batch();
  let pendingWrites = 0;

  for (const sorteoDoc of sorteosSnap.docs) {
    if (limit > 0 && revisados >= limit) break;
    revisados += 1;

    const sorteoData = sorteoDoc.data() || {};
    const legacyLocks = sorteoData?.[LEGACY_FIELD];
    if (!legacyLocks || typeof legacyLocks !== 'object') continue;

    const entries = Object.entries(legacyLocks);
    if (!entries.length) continue;
    sorteosConLegacy += 1;

    for (const [idxRaw, lockData] of entries) {
      const formaIdx = Number(idxRaw);
      if (!Number.isFinite(formaIdx)) continue;
      const winnerKeys = normalizeWinnerKeys(lockData?.cartonClaves || lockData?.winnerKeys);
      if (!winnerKeys.length) continue;

      const docId = `${sorteoDoc.id}__f${formaIdx}`;
      const lockRef = db.collection(WINNER_LOCKS_COLLECTION).doc(docId);
      locksMigrados += 1;
      if (!dryRun) {
        batch.set(lockRef, {
          sorteoId: sorteoDoc.id,
          formaIdx,
          cerrada: true,
          pasoCierre: Number.isFinite(Number(lockData?.paso)) ? Number(lockData.paso) : null,
          winnerKeys,
          cerradoEn: lockData?.cerradoEn || admin.firestore.FieldValue.serverTimestamp(),
          cerradoPor: 'script:migrar-ganadores-locks'
        }, { merge: true });
        pendingWrites += 1;
      }
    }

    if (!dryRun && removeLegacy) {
      batch.update(sorteoDoc.ref, {
        [LEGACY_FIELD]: admin.firestore.FieldValue.delete()
      });
      pendingWrites += 1;
      legacyRemovidos += 1;
    }

    if (!dryRun && pendingWrites >= 400) {
      await batch.commit();
      batch = db.batch();
      pendingWrites = 0;
    }
  }

  if (!dryRun && pendingWrites > 0) {
    await batch.commit();
  }

  console.log(JSON.stringify({
    dryRun,
    removeLegacy,
    revisados,
    sorteosConLegacy,
    locksMigrados,
    legacyRemovidos
  }, null, 2));
}

main().then(() => process.exit(0)).catch((err) => {
  console.error('Error migrando locks de ganadores realtime:', err.message || err);
  process.exit(1);
});
