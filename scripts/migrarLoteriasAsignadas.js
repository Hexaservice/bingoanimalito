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

function normalizarIds(ids) {
  if (!Array.isArray(ids)) return [];
  const vistos = new Set();
  const salida = [];
  ids.forEach((id) => {
    const texto = String(id || '').trim();
    if (!texto || vistos.has(texto)) return;
    vistos.add(texto);
    salida.push(texto);
  });
  return salida;
}

async function main() {
  const args = parseArgs(process.argv);
  const dryRun = args['dry-run'] !== 'false';
  const limite = Number(args.limit || 0);

  const credentialsPath = resolveCredentialsPath();
  admin.initializeApp({
    credential: admin.credential.cert(require(credentialsPath))
  });

  const db = admin.firestore();
  const snap = await db.collection('sorteos').get();

  let revisados = 0;
  let actualizados = 0;
  let batch = db.batch();
  let pendientes = 0;

  for (const doc of snap.docs) {
    if (limite > 0 && revisados >= limite) break;
    revisados += 1;
    const data = doc.data() || {};
    const asignadas = normalizarIds(data.loteriasAsignadas);
    const activas = normalizarIds(data.loteriasActivas);

    if (asignadas.length > 0) continue;
    if (activas.length === 0) continue;

    actualizados += 1;
    if (!dryRun) {
      batch.set(doc.ref, { loteriasAsignadas: activas }, { merge: true });
      pendientes += 1;
      if (pendientes >= 400) {
        await batch.commit();
        batch = db.batch();
        pendientes = 0;
      }
    }
  }

  if (!dryRun && pendientes > 0) {
    await batch.commit();
  }

  console.log(JSON.stringify({
    coleccion: 'sorteos',
    dryRun,
    revisados,
    actualizados
  }, null, 2));
}

main().then(() => process.exit(0)).catch((err) => {
  console.error('Error migrando loterías asignadas:', err.message || err);
  process.exit(1);
});
