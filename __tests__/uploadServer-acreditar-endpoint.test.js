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

function createFirestoreDouble({ estadoSorteo = 'jugando', estadoPremioInicial = 'pendiente' } = {}) {
  const state = {
    sorteo: { estado: estadoSorteo },
    premio: {
      premioId: 'ppd_123',
      sorteoId: 'sorteo-1',
      estado: estadoPremioInicial,
      creditos: 10,
      cartonesGratis: 1,
      eventoGanadorId: 'evt-1'
    },
    billetera: { creditos: 200, CartonesGratis: 4 },
    transacciones: new Map(),
    adminAudit: []
  };

  const billeteraRef = {
    __kind: 'billetera-ref',
    id: 'ganador@example.com',
    collection: jest.fn((name) => ({
      doc: (id) => ({ __kind: `${name}-doc`, id })
    }))
  };

  const premioRef = {
    __kind: 'premio-ref',
    id: state.premio.premioId,
    parent: { parent: billeteraRef },
    get: jest.fn(async () => ({
      exists: true,
      id: state.premio.premioId,
      ref: premioRef,
      data: () => ({ ...state.premio })
    }))
  };

  const queryByPremio = { __kind: 'query-by-premio' };

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
      if (name === 'sorteos') {
        return {
          doc: jest.fn(() => ({
            get: jest.fn(async () => ({ data: () => ({ ...state.sorteo }) }))
          }))
        };
      }
      if (name === 'transacciones') {
        return {
          doc: jest.fn((id) => ({ __kind: 'transaccion-ref', id })),
          where: jest.fn(() => ({
            limit: jest.fn(() => queryByPremio)
          }))
        };
      }
      if (name === 'adminAccessAudit') {
        return {
          add: jest.fn(async (payload) => {
            state.adminAudit.push(payload);
          })
        };
      }
      if (name === 'users') {
        return {
          doc: jest.fn(() => ({
            get: jest.fn(async () => ({ exists: false, data: () => ({}) }))
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
    runTransaction: jest.fn(async (fn) => fn({
      get: jest.fn(async (target) => {
        if (target === premioRef) {
          return { exists: true, data: () => ({ ...state.premio }) };
        }
        if (target === billeteraRef) {
          return { exists: true, data: () => ({ ...state.billetera }) };
        }
        if (target && target.__kind === 'transaccion-ref') {
          return { exists: state.transacciones.has(target.id), data: () => state.transacciones.get(target.id) };
        }
        if (target === queryByPremio) {
          const premioId = state.premio.premioId;
          const hasTx = Array.from(state.transacciones.values()).some((tx) => tx.premioId === premioId);
          return hasTx ? { empty: false, docs: [{ id: 'tx-previa' }] } : { empty: true, docs: [] };
        }
        return { exists: false, empty: true, docs: [] };
      }),
      set: jest.fn((target, payload) => {
        if (target === billeteraRef) {
          state.billetera = { ...state.billetera, ...payload };
          return;
        }
        if (target === premioRef || target?.__kind === 'premiosPagosdirectos-doc') {
          state.premio = { ...state.premio, ...payload };
          return;
        }
        if (target?.__kind === 'transaccion-ref') {
          state.transacciones.set(target.id, payload);
        }
      })
    }))
  };

  return { db, state };
}

describe('endpoint /acreditarPremioEvento', () => {
  const ORIGINAL_ENV = process.env.PREMIOS_ENGINE_V2_ENABLED;

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.PREMIOS_ENGINE_V2_ENABLED;
    else process.env.PREMIOS_ENGINE_V2_ENABLED = ORIGINAL_ENV;
    jest.resetModules();
    jest.clearAllMocks();
  });

  test('responde 409 cuando el motor de premios está deshabilitado', async () => {
    process.env.PREMIOS_ENGINE_V2_ENABLED = 'false';
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

  test.each(['jugando', 'finalizado'])('permite acreditar cuando el sorteo está en estado %s', async (estado) => {
    process.env.PREMIOS_ENGINE_V2_ENABLED = 'true';
    const admin = require('firebase-admin');
    const { acreditarPremioEventoHandler } = require('../uploadServer.js');
    const { db } = createFirestoreDouble({ estadoSorteo: estado, estadoPremioInicial: 'pendiente' });
    admin.firestore.mockReturnValue(db);

    const req = {
      body: {
        premioId: 'ppd_123',
        billeteraId: 'ganador@example.com',
        sorteoId: 'sorteo-1'
      },
      headers: {},
      user: { email: 'admin@example.com', role: 'Administrador' }
    };
    const res = makeRes();

    await acreditarPremioEventoHandler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      status: 'ok',
      resultado: 'acreditado',
      idempotente: false,
      premioId: 'ppd_123'
    }));
  });

  test('idempotencia: doble request sobre mismo premioId no duplica saldo ni transacción', async () => {
    process.env.PREMIOS_ENGINE_V2_ENABLED = 'true';
    const admin = require('firebase-admin');
    const { acreditarPremioEventoHandler } = require('../uploadServer.js');
    const { db, state } = createFirestoreDouble({ estadoSorteo: 'jugando', estadoPremioInicial: 'pendiente' });
    admin.firestore.mockReturnValue(db);

    const baseReq = {
      body: {
        premioId: 'ppd_123',
        billeteraId: 'ganador@example.com',
        sorteoId: 'sorteo-1'
      },
      headers: {},
      user: { email: 'admin@example.com', role: 'Administrador' }
    };

    const primera = makeRes();
    await acreditarPremioEventoHandler(baseReq, primera);
    const saldoTrasPrimera = state.billetera.creditos;
    const transaccionesTrasPrimera = state.transacciones.size;

    const segunda = makeRes();
    await acreditarPremioEventoHandler(baseReq, segunda);

    expect(primera.statusCode).toBe(200);
    expect(primera.body.resultado).toBe('acreditado');
    expect(segunda.statusCode).toBe(200);
    expect(segunda.body).toEqual(expect.objectContaining({
      resultado: 'ya_acreditado',
      code: 'PREMIO_YA_ACREDITADO',
      idempotente: true,
      premioId: 'ppd_123'
    }));
    expect(state.billetera.creditos).toBe(saldoTrasPrimera);
    expect(state.transacciones.size).toBe(transaccionesTrasPrimera);
    expect(state.transacciones.size).toBe(1);
  });
});
