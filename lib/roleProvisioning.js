const ALLOWED_ROLES = ['Jugador', 'Colaborador', 'Administrador', 'Superadmin'];

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function parseBooleanFlag(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') return defaultValue;
  if (value === true || value === false) return value;

  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'si', 'sí'].includes(normalized)) return true;
  if (['false', '0', 'no', 'n'].includes(normalized)) return false;
  return defaultValue;
}

function userHasProvider(userRecord, providerId) {
  const providers = Array.isArray(userRecord?.providerData) ? userRecord.providerData : [];
  return providers.some(provider => provider?.providerId === providerId);
}

function stripAccents(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function normalizeRoleToCanonical(role) {
  if (typeof role !== 'string') return null;
  const trimmed = role.trim();
  if (!trimmed) return null;

  const normalized = stripAccents(trimmed)
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (normalized === 'superadmin' || normalized === 'super administrador') {
    return 'Superadmin';
  }
  if (normalized === 'administrador' || normalized === 'admin') {
    return 'Administrador';
  }
  if (normalized === 'colaborador') {
    return 'Colaborador';
  }
  if (normalized === 'jugador' || normalized === 'player') {
    return 'Jugador';
  }

  return null;
}

function buildRoleClaims(role, options = {}) {
  if (!ALLOWED_ROLES.includes(role)) {
    throw new Error(`Rol inválido. Permitidos: ${ALLOWED_ROLES.join(', ')}`);
  }

  const forceAdmin = Boolean(options.forceAdmin);
  return {
    role,
    roles: [role],
    admin: forceAdmin || role === 'Superadmin'
  };
}

function buildUserProfileUpdate({ email, uid, role, claims, managedBy = 'admin-script' }) {
  return {
    email: normalizeEmail(email),
    role,
    roles: Array.isArray(claims?.roles) ? claims.roles : [role],
    admin: Boolean(claims?.admin),
    uid,
    roleManagedBy: managedBy
  };
}

module.exports = {
  ALLOWED_ROLES,
  normalizeEmail,
  parseBooleanFlag,
  userHasProvider,
  normalizeRoleToCanonical,
  buildRoleClaims,
  buildUserProfileUpdate
};
