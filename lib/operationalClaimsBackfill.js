const { normalizeEmail, normalizeRoleToCanonical, buildRoleClaims } = require('./roleProvisioning');

const OPERATIONAL_ROLES = ['Superadmin', 'Administrador', 'Colaborador'];

function extractCandidateRole(userDoc = {}) {
  if (typeof userDoc.role === 'string' && userDoc.role.trim()) {
    return userDoc.role;
  }

  if (Array.isArray(userDoc.roles) && userDoc.roles.length > 0) {
    const first = userDoc.roles.find(role => typeof role === 'string' && role.trim());
    if (first) return first;
  }

  return null;
}

function validateIdentity(userDoc = {}, authRecord = null) {
  const docEmail = normalizeEmail(userDoc.email || userDoc.correo || userDoc.mail);
  if (!docEmail) {
    throw new Error('Documento sin email válido');
  }

  const authEmail = normalizeEmail(authRecord?.email);
  if (!authEmail) {
    throw new Error('Usuario en Auth sin email válido');
  }

  if (docEmail !== authEmail) {
    throw new Error(`Email desalineado entre Firestore (${docEmail}) y Auth (${authEmail})`);
  }

  const docUid = String(userDoc.uid || '').trim();
  if (docUid && docUid !== authRecord.uid) {
    throw new Error(`UID desalineado entre Firestore (${docUid}) y Auth (${authRecord.uid})`);
  }

  if (!authRecord.uid) {
    throw new Error('Usuario en Auth sin uid válido');
  }

  return {
    email: authEmail,
    uid: authRecord.uid
  };
}

function buildCanonicalClaimsForUser(userDoc = {}) {
  const rawRole = extractCandidateRole(userDoc);
  const canonicalRole = normalizeRoleToCanonical(rawRole);

  if (!canonicalRole || !OPERATIONAL_ROLES.includes(canonicalRole)) {
    throw new Error(`Rol no operativo o inválido: ${rawRole || 'N/D'}`);
  }

  return buildRoleClaims(canonicalRole);
}

function initReport(dryRun) {
  return {
    dryRun,
    totalProcesados: 0,
    exitosos: 0,
    fallidos: 0,
    errores: []
  };
}

function registerSuccess(report) {
  report.totalProcesados += 1;
  report.exitosos += 1;
}

function registerFailure(report, email, cause) {
  report.totalProcesados += 1;
  report.fallidos += 1;
  report.errores.push({ email, cause });
}

module.exports = {
  OPERATIONAL_ROLES,
  extractCandidateRole,
  validateIdentity,
  buildCanonicalClaimsForUser,
  initReport,
  registerSuccess,
  registerFailure
};
