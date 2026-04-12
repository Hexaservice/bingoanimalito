#!/usr/bin/env node
const admin = require('firebase-admin');
const fs = require('fs');
const {
  normalizeEmail,
  parseBooleanFlag
} = require('../lib/roleProvisioning');
const {
  OPERATIONAL_ROLES,
  validateIdentity,
  buildCanonicalClaimsForUser,
  initReport,
  registerSuccess,
  registerFailure
} = require('../lib/operationalClaimsBackfill');

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

async function collectOperationalUserDocs(db, limit = 0) {
  const byEmail = new Map();

  const roleQuery = await db.collection('users').where('role', 'in', OPERATIONAL_ROLES).get();
  roleQuery.docs.forEach(doc => {
    byEmail.set(normalizeEmail(doc.id), doc);
  });

  const rolesQuery = await db.collection('users').where('roles', 'array-contains-any', OPERATIONAL_ROLES).get();
  rolesQuery.docs.forEach(doc => {
    byEmail.set(normalizeEmail(doc.id), doc);
  });

  const docs = Array.from(byEmail.values());
  if (limit > 0) {
    return docs.slice(0, limit);
  }
  return docs;
}

async function applyBackfillForUser({ doc, auth, db, dryRun }) {
  const data = doc.data() || {};
  const referenceEmail = normalizeEmail(data.email || doc.id);

  if (!referenceEmail) {
    throw new Error('Documento sin email o id válido');
  }

  const authRecord = await auth.getUserByEmail(referenceEmail);
  const identity = validateIdentity({ ...data, email: referenceEmail }, authRecord);
  const canonicalClaims = buildCanonicalClaimsForUser(data);

  if (!dryRun) {
    await auth.setCustomUserClaims(identity.uid, canonicalClaims);
    await db.collection('users').doc(identity.email).set({
      role: canonicalClaims.role,
      roles: canonicalClaims.roles,
      admin: Boolean(canonicalClaims.admin),
      uid: identity.uid,
      roleUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
      roleManagedBy: 'operational-backfill-script'
    }, { merge: true });
  }

  return {
    email: identity.email,
    uid: identity.uid,
    claims: canonicalClaims
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const dryRun = parseBooleanFlag(args['dry-run'], false);
  const confirm = parseBooleanFlag(args.confirm, false);
  const limit = Number(args.limit || 0);

  if (!dryRun && !confirm) {
    throw new Error('Operación bloqueada: ejecuta con --confirm true o usa --dry-run true para auditoría.');
  }

  const credentialsPath = resolveCredentialsPath();
  admin.initializeApp({
    credential: admin.credential.cert(require(credentialsPath))
  });

  const auth = admin.auth();
  const db = admin.firestore();

  const docs = await collectOperationalUserDocs(db, Number.isFinite(limit) ? limit : 0);
  const report = initReport(dryRun);

  for (const doc of docs) {
    const data = doc.data() || {};
    const referenceEmail = normalizeEmail(data.email || doc.id || 'desconocido');
    try {
      const result = await applyBackfillForUser({ doc, auth, db, dryRun });
      registerSuccess(report);
      console.log(`[OK] ${result.email} -> ${JSON.stringify(result.claims)}`);
    } catch (error) {
      registerFailure(report, referenceEmail, error.message || String(error));
      console.error(`[FAIL] ${referenceEmail}: ${error.message || error}`);
    }
  }

  console.log('\n=== REPORTE FINAL BACKFILL CLAIMS OPERATIVOS ===');
  console.log(JSON.stringify(report, null, 2));

  if (report.fallidos > 0) {
    process.exitCode = 2;
  }
}

main().catch(error => {
  console.error('Error en backfill de claims operativos:', error.message || error);
  process.exit(1);
});
