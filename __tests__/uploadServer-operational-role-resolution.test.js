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
});
