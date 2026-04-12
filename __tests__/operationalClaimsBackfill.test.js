const {
  OPERATIONAL_ROLES,
  extractCandidateRole,
  validateIdentity,
  buildCanonicalClaimsForUser,
  initReport,
  registerSuccess,
  registerFailure
} = require('../lib/operationalClaimsBackfill');

describe('operationalClaimsBackfill helpers', () => {
  test('extractCandidateRole prioriza role y luego roles[]', () => {
    expect(extractCandidateRole({ role: 'Administrador', roles: ['Colaborador'] })).toBe('Administrador');
    expect(extractCandidateRole({ roles: ['Colaborador'] })).toBe('Colaborador');
    expect(extractCandidateRole({})).toBeNull();
  });

  test('validateIdentity valida email/uid entre Firestore y Auth', () => {
    expect(validateIdentity(
      { email: 'Admin@Test.com', uid: 'uid-1' },
      { email: 'admin@test.com', uid: 'uid-1' }
    )).toEqual({ email: 'admin@test.com', uid: 'uid-1' });
  });

  test('validateIdentity falla cuando uid no coincide', () => {
    expect(() => validateIdentity(
      { email: 'admin@test.com', uid: 'uid-a' },
      { email: 'admin@test.com', uid: 'uid-b' }
    )).toThrow('UID desalineado');
  });

  test('buildCanonicalClaimsForUser normaliza y limita a roles operativos', () => {
    expect(buildCanonicalClaimsForUser({ role: 'super administrador' })).toEqual({
      role: 'Superadmin',
      roles: ['Superadmin'],
      admin: true
    });

    expect(() => buildCanonicalClaimsForUser({ role: 'Jugador' })).toThrow('Rol no operativo o inválido');
    expect(OPERATIONAL_ROLES).toEqual(['Superadmin', 'Administrador', 'Colaborador']);
  });

  test('report helpers acumulan éxitos y fallidos con causa', () => {
    const report = initReport(true);
    registerSuccess(report);
    registerFailure(report, 'a@test.com', 'sin uid');

    expect(report).toEqual({
      dryRun: true,
      totalProcesados: 2,
      exitosos: 1,
      fallidos: 1,
      errores: [{ email: 'a@test.com', cause: 'sin uid' }]
    });
  });
});
