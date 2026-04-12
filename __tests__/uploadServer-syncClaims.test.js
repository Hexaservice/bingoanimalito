jest.mock('firebase-admin', () => ({
  apps: [],
  initializeApp: jest.fn(),
  firestore: Object.assign(jest.fn(), {
    FieldValue: {
      serverTimestamp: jest.fn(() => '__SERVER_TIMESTAMP__')
    }
  }),
  auth: jest.fn()
}));

function makeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    }
  };
}

describe('syncClaimsHandler', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  test('normaliza variantes de formato de rol y persiste claims canónicos', async () => {
    const admin = require('firebase-admin');

    const setProfile = jest.fn(async () => undefined);
    const usersCollection = {
      doc: jest.fn((email) => ({
        get: jest.fn(async () => ({ exists: true, data: () => ({ role: ' super administrador ' }) })),
        set: setProfile
      }))
    };

    admin.firestore.mockReturnValue({
      collection: jest.fn((name) => {
        if (name === 'users') return usersCollection;
        throw new Error(`Colección no esperada: ${name}`);
      })
    });

    const setCustomUserClaims = jest.fn(async () => undefined);
    admin.auth.mockReturnValue({
      getUserByEmail: jest.fn(async () => ({
        uid: 'uid-demo',
        customClaims: { featureX: true },
        providerData: [{ providerId: 'google.com' }]
      })),
      setCustomUserClaims
    });

    const { syncClaimsHandler } = require('../uploadServer.js');
    const req = { user: { email: 'admin@test.com' } };
    const res = makeRes();

    await syncClaimsHandler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ status: 'ok', role: 'Superadmin' });
    expect(setCustomUserClaims).toHaveBeenCalledWith('uid-demo', expect.objectContaining({
      role: 'Superadmin',
      roles: ['Superadmin'],
      admin: true,
      featureX: true
    }));
    expect(setProfile).toHaveBeenCalledWith(expect.objectContaining({
      role: 'Superadmin',
      roleManagedBy: 'syncClaims-endpoint',
      authProviders: ['google.com'],
      roleUpdatedAt: '__SERVER_TIMESTAMP__'
    }), { merge: true });
  });

  test('retorna 400 cuando el rol en users/{email} no es válido', async () => {
    const admin = require('firebase-admin');

    admin.firestore.mockReturnValue({
      collection: jest.fn(() => ({
        doc: jest.fn(() => ({
          get: jest.fn(async () => ({ exists: true, data: () => ({ role: 'InvitadoVIP' }) })),
          set: jest.fn(async () => undefined)
        }))
      }))
    });

    const setCustomUserClaims = jest.fn(async () => undefined);
    admin.auth.mockReturnValue({
      getUserByEmail: jest.fn(async () => ({ uid: 'uid-demo', customClaims: {} })),
      setCustomUserClaims
    });

    const { syncClaimsHandler } = require('../uploadServer.js');
    const req = { user: { email: 'admin@test.com' } };
    const res = makeRes();

    await syncClaimsHandler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/Rol no normalizable/);
    expect(setCustomUserClaims).not.toHaveBeenCalled();
  });

  test('retorna claims esperados en caso exitoso para Administrador', async () => {
    const admin = require('firebase-admin');

    const setProfile = jest.fn(async () => undefined);
    admin.firestore.mockReturnValue({
      collection: jest.fn(() => ({
        doc: jest.fn(() => ({
          get: jest.fn(async () => ({ exists: true, data: () => ({ role: 'admin' }) })),
          set: setProfile
        }))
      }))
    });

    const setCustomUserClaims = jest.fn(async () => undefined);
    admin.auth.mockReturnValue({
      getUserByEmail: jest.fn(async () => ({
        uid: 'uid-admin',
        customClaims: { featureY: false },
        providerData: []
      })),
      setCustomUserClaims
    });

    const { syncClaimsHandler } = require('../uploadServer.js');
    const req = { user: { email: 'admin@test.com' } };
    const res = makeRes();

    await syncClaimsHandler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ status: 'ok', role: 'Administrador' });
    expect(setCustomUserClaims).toHaveBeenCalledWith('uid-admin', expect.objectContaining({
      role: 'Administrador',
      roles: ['Administrador'],
      admin: true,
      featureY: false
    }));
    expect(setProfile).toHaveBeenCalledWith(expect.objectContaining({
      role: 'Administrador',
      admin: true,
      roleManagedBy: 'syncClaims-endpoint',
      roles: ['Administrador']
    }), { merge: true });
  });
});
