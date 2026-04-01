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

function toNonNegativeNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

function buildPremioId(raw = {}, fallbackId = '') {
  const explicitId = (raw.premioId || raw.clavePendiente || fallbackId || '').toString().trim().toLowerCase();
  if (explicitId) return explicitId;
  const sorteoId = (raw.sorteoId || '').toString().trim().toLowerCase();
  const idx = Number(raw.idx) || 0;
  const cartonLabel = (raw.cartonLabel || '').toString().trim().toLowerCase();
  return `${sorteoId}::${idx}::${cartonLabel}`;
}

async function main() {
  const args = parseArgs(process.argv);
  const dryRun = args['dry-run'] !== 'false';
  const removeMap = args['remove-map'] === 'true';

  const credentialsPath = resolveCredentialsPath();
  admin.initializeApp({
    credential: admin.credential.cert(require(credentialsPath))
  });

  const db = admin.firestore();
  const walletSnap = await db.collection('Billetera').get();

  let walletsWithLegacyMap = 0;
  let premiosMigrados = 0;
  let walletsUpdated = 0;

  for (const walletDoc of walletSnap.docs) {
    const data = walletDoc.data() || {};
    const legacyMap = data.premiosPendientesDirectos;
    if (!legacyMap || typeof legacyMap !== 'object' || Array.isArray(legacyMap)) continue;

    const entries = Object.entries(legacyMap);
    if (!entries.length) continue;

    walletsWithLegacyMap += 1;
    if (dryRun) {
      premiosMigrados += entries.length;
      continue;
    }

    const batch = db.batch();
    const subcolRef = walletDoc.ref.collection('premiosPendientesDirectos');

    entries.forEach(([legacyKey, rawItem]) => {
      const item = rawItem && typeof rawItem === 'object' ? rawItem : {};
      const premioId = buildPremioId(item, legacyKey);
      if (!premioId) return;
      premiosMigrados += 1;
      const docRef = subcolRef.doc(premioId);
      batch.set(docRef, {
        premioId,
        clavePendiente: (item.clavePendiente || premioId).toString(),
        idx: Number(item.idx) || 0,
        nombre: (item.nombre || '').toString(),
        creditos: toNonNegativeNumber(item.creditos),
        cartonesGratis: toNonNegativeNumber(item.cartonesGratis),
        cartonLabel: (item.cartonLabel || '').toString(),
        color: (item.color || '').toString(),
        sorteoId: (item.sorteoId || '').toString(),
        estado: (item.estado || 'pendiente').toString(),
        origen: (item.origen || 'migracion:premiosPendientesDirectos-mapa').toString(),
        creadoEn: item.creadoEn || admin.firestore.FieldValue.serverTimestamp(),
        migradoEn: admin.firestore.FieldValue.serverTimestamp(),
        migradoPor: 'script:migrarPremiosPendientesDirectosSubcoleccion'
      }, { merge: true });
    });

    if (removeMap) {
      batch.set(walletDoc.ref, {
        premiosPendientesDirectos: admin.firestore.FieldValue.delete()
      }, { merge: true });
    }

    await batch.commit();
    walletsUpdated += 1;
  }

  console.log(JSON.stringify({
    dryRun,
    removeMap,
    totalBilleteras: walletSnap.size,
    billeterasConMapaLegado: walletsWithLegacyMap,
    billeterasActualizadas: walletsUpdated,
    premiosMigrados
  }, null, 2));
}

main().then(() => process.exit(0)).catch(err => {
  console.error('Error en migración de premios pendientes directos:', err.message || err);
  process.exit(1);
});
