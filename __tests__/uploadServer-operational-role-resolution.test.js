jest.mock('firebase-admin', () => ({
  apps: [],
  initializeApp: jest.fn(),
  firestore: Object.assign(jest.fn(), {
    FieldValue: {
      serverTimestamp: jest.fn(() => '__SERVER_TIMESTAMP__')
    }
  }),
  auth: jest.fn(() => ({ verifyIdToken: jest.fn() }))
}));

describe('resolución robusta de rol operativo', () => {
  test('acepta rol en campos legacy y fallback por uid', async () => {
    jest.resetModules();
    const { loadOperationalUserProfile } = require('../uploadServer.js');

    const docs = {
      'admin@test.com': { exists: false, data: () => ({}) },
      UID_ADMIN: { exists: true, id: 'UID_ADMIN', data: () => ({ rolinterno: 'colaborador' }) }
    };
    const db = {
      collection: jest.fn(() => ({
        doc: jest.fn((id) => ({
          get: jest.fn(async () => ({ id, ...(docs[id] || { exists: false, data: () => ({}) }) }))
        }))
      }))
    };

    const result = await loadOperationalUserProfile({
      db,
      email: 'admin@test.com',
      uid: 'UID_ADMIN'
    });

    expect(result.role).toBe('Colaborador');
    expect(result.source).toBe('users/UID_ADMIN');
  });

  test('usa custom claims operativos cuando no existe role en users/{id}', async () => {
    jest.resetModules();
    const { loadOperationalUserProfile } = require('../uploadServer.js');

    const db = {
      collection: jest.fn(() => ({
        doc: jest.fn(() => ({
          get: jest.fn(async () => ({ exists: false, data: () => ({}) }))
        }))
      }))
    };

    const result = await loadOperationalUserProfile({
      db,
      email: 'operador@test.com',
      uid: 'UID_OPERADOR',
      claims: { role: ' admin ' }
    });

    expect(result).toEqual({ role: 'Administrador', source: 'custom_claims' });
  });

  test('no eleva permisos con custom claims no operativos', async () => {
    jest.resetModules();
    const { loadOperationalUserProfile } = require('../uploadServer.js');

    const db = {
      collection: jest.fn(() => ({
        doc: jest.fn(() => ({
          get: jest.fn(async () => ({ exists: false, data: () => ({}) }))
        }))
      }))
    };

    const result = await loadOperationalUserProfile({
      db,
      email: 'jugador@test.com',
      uid: 'UID_JUGADOR',
      claims: { role: 'InvitadoVIP' }
    });

    expect(result).toEqual({ role: null, source: 'no_role_match' });
  });
});
