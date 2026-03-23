const {
  ALLOWED_ROLES,
  normalizeEmail,
  parseBooleanFlag,
  userHasProvider,
  buildRoleClaims,
  buildUserProfileUpdate
} = require('../lib/roleProvisioning');

describe('roleProvisioning helpers', () => {
  test('normalizeEmail limpia y pone en minúsculas', () => {
    expect(normalizeEmail('  USER@Test.COM ')).toBe('user@test.com');
  });

  test('parseBooleanFlag reconoce variantes comunes en español e inglés', () => {
    expect(parseBooleanFlag('true')).toBe(true);
    expect(parseBooleanFlag('Sí')).toBe(true);
    expect(parseBooleanFlag('0')).toBe(false);
    expect(parseBooleanFlag(undefined, true)).toBe(true);
  });

  test('userHasProvider detecta google.com', () => {
    expect(userHasProvider({ providerData: [{ providerId: 'google.com' }] }, 'google.com')).toBe(true);
    expect(userHasProvider({ providerData: [{ providerId: 'password' }] }, 'google.com')).toBe(false);
  });

  test('buildRoleClaims genera claims esperados para Superadmin', () => {
    expect(buildRoleClaims('Superadmin')).toEqual({
      role: 'Superadmin',
      roles: ['Superadmin'],
      admin: true
    });
  });

  test('buildRoleClaims permite forzar admin en otros roles', () => {
    expect(buildRoleClaims('Administrador', { forceAdmin: true })).toEqual({
      role: 'Administrador',
      roles: ['Administrador'],
      admin: true
    });
  });

  test('buildRoleClaims rechaza roles inválidos', () => {
    expect(() => buildRoleClaims('Root')).toThrow(`Rol inválido. Permitidos: ${ALLOWED_ROLES.join(', ')}`);
  });

  test('buildUserProfileUpdate arma documento consistente para Firestore', () => {
    expect(buildUserProfileUpdate({
      email: 'Admin@Test.com',
      uid: 'uid-123',
      role: 'Superadmin',
      claims: { role: 'Superadmin', roles: ['Superadmin'], admin: true },
      managedBy: 'syncClaims-endpoint'
    })).toEqual({
      email: 'admin@test.com',
      role: 'Superadmin',
      roles: ['Superadmin'],
      admin: true,
      uid: 'uid-123',
      roleManagedBy: 'syncClaims-endpoint'
    });
  });
});
