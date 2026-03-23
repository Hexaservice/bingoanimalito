#!/usr/bin/env node
const admin = require('firebase-admin');
const fs = require('fs');
const {
  ALLOWED_ROLES,
  normalizeEmail,
  parseBooleanFlag,
  userHasProvider,
  buildRoleClaims,
  buildUserProfileUpdate
} = require('../lib/roleProvisioning');

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

async function main() {
  const args = parseArgs(process.argv);
  const email = normalizeEmail(args.email);
  const role = String(args.role || '').trim();
  const forceAdmin = parseBooleanFlag(args.admin, false);
  const requireGoogle = parseBooleanFlag(args['require-google'], false);

  if (!email || !role) {
    throw new Error('Uso: node scripts/assignRoleClaims.js --email usuario@dominio.com --role <Jugador|Colaborador|Administrador|Superadmin> [--admin true] [--require-google true]');
  }

  const credentialsPath = resolveCredentialsPath();
  admin.initializeApp({
    credential: admin.credential.cert(require(credentialsPath))
  });

  const auth = admin.auth();
  const db = admin.firestore();

  const userRecord = await auth.getUserByEmail(email);
  if (requireGoogle && !userHasProvider(userRecord, 'google.com')) {
    throw new Error(`El usuario ${email} todavía no tiene el proveedor google.com enlazado en Firebase Authentication. Primero debe iniciar sesión real con Google.`);
  }

  const nextClaims = buildRoleClaims(role, { forceAdmin });

  await auth.setCustomUserClaims(userRecord.uid, nextClaims);

  const userProfileUpdate = buildUserProfileUpdate({
    email,
    uid: userRecord.uid,
    role,
    claims: nextClaims,
    managedBy: 'admin-script'
  });

  await db.collection('users').doc(email).set({
    ...userProfileUpdate,
    authProviders: (userRecord.providerData || []).map(provider => provider.providerId).filter(Boolean),
    roleUpdatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  console.log(`Rol ${role} y custom claims asignados a ${email} (uid: ${userRecord.uid}).`);
}

main().then(() => process.exit(0)).catch(err => {
  console.error('Error al asignar rol/claims:', err.message || err);
  process.exit(1);
});
