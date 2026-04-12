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

describe('endpoint /acreditarPremioEvento', () => {
  test('responde 409 cuando el motor de premios está deshabilitado', async () => {
    const { acreditarPremioEventoHandler } = require('../uploadServer.js');

    const req = {
      body: {},
      headers: {},
      user: { email: 'admin@example.com', role: 'Administrador' }
    };
    const res = makeRes();

    await acreditarPremioEventoHandler(req, res);

    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual(expect.objectContaining({
      code: 'PREMIOS_ENGINE_V2_DISABLED',
      premiosEngineV2Enabled: false,
      action: 'acreditar-premio-evento',
      idempotente: true
    }));
  });

  test('mantiene respuesta idempotente 409 aunque llegue premio válido', async () => {
    jest.resetModules();
    const admin = require('firebase-admin');
    const { acreditarPremioEventoHandler } = require('../uploadServer.js');

    const premioId = 'ppd_123';
    const billeteraId = 'ganador@example.com';
    const premioRef = {
      id: premioId,
      parent: {
        parent: {
          id: billeteraId
        }
      }
    };
    const premioSnap = {
      exists: true,
      id: premioId,
      ref: premioRef,
      data: () => ({
        premioId,
        sorteoId: 'sorteo-1',
        estado: 'acreditado',
        creditos: 10,
        cartonesGratis: 1
      })
    };
    premioRef.get = jest.fn().mockResolvedValue(premioSnap);

    const queryByPremio = {
      get: jest.fn().mockResolvedValue({ empty: true })
    };
    const tx = {
      get: jest.fn(async (target) => {
        if (target === premioRef) return premioSnap;
        if (target === premioRef.parent.parent) return { exists: true, data: () => ({ creditos: 200, CartonesGratis: 4 }) };
        if (target && target.__kind === 'transaccion-ref') return { exists: false };
        if (target === queryByPremio) return { empty: true };
        return { exists: false, empty: true };
      }),
      set: jest.fn()
    };

    const db = {
      collection: jest.fn((name) => {
        if (name === 'Billetera') {
          return {
            doc: jest.fn(() => ({
              collection: jest.fn(() => ({
                doc: jest.fn(() => premioRef)
              }))
            }))
          };
        }
        if (name === 'transacciones') {
          return {
            doc: jest.fn(() => ({ __kind: 'transaccion-ref' })),
            where: jest.fn(() => ({
              limit: jest.fn(() => queryByPremio)
            }))
          };
        }
        return {};
      }),
      collectionGroup: jest.fn(() => ({
        where: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        get: jest.fn().mockResolvedValue({ empty: true, docs: [], size: 0 })
      })),
      runTransaction: jest.fn(async (fn) => fn(tx))
    };

    admin.firestore.mockReturnValue(db);

    const req = {
      body: {
        premioId,
        billeteraId,
        sorteoId: 'sorteo-1'
      },
      headers: {},
      user: { email: 'admin@example.com', role: 'Administrador' }
    };
    const res = makeRes();

    await acreditarPremioEventoHandler(req, res);

    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual(expect.objectContaining({
      code: 'PREMIOS_ENGINE_V2_DISABLED',
      premiosEngineV2Enabled: false,
      action: 'acreditar-premio-evento',
      idempotente: true
    }));
  });
});
