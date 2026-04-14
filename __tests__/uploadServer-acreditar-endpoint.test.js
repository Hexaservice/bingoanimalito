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

function createFirestoreDouble({
  estadoSorteo = 'jugando',
  estadoPremioInicial = 'pendiente',
  userDocData = null,
  collectionGroupDocs = [],
  billeteraIdPremio = 'ganador@example.com'
} = {}) {
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
    id: billeteraIdPremio,
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
          doc: jest.fn((walletId) => ({
            id: walletId,
            get: jest.fn(async () => ({
              exists: String(walletId || '').toLowerCase() === String(billeteraRef.id || '').toLowerCase(),
              data: () => ({ ...state.billetera })
            })),
            collection: jest.fn(() => {
              const walletMatches = String(walletId || '').toLowerCase() === String(billeteraRef.id || '').toLowerCase();
              return {
                doc: jest.fn((id) => ({
                  ...premioRef,
                  id,
                  get: jest.fn(async () => ({
                    exists: walletMatches && String(id || '').toLowerCase() === String(state.premio.premioId || '').toLowerCase(),
                    id,
                    ref: premioRef,
                    data: () => ({ ...state.premio })
                  }))
                })),
                where: jest.fn((field, op, value) => ({
                  limit: jest.fn(() => ({
                    get: async () => {
                      const matchesEvento = field === 'eventoGanadorId' && op === '==' && value === state.premio.eventoGanadorId;
                      if (walletMatches && matchesEvento) {
                        return { empty: false, docs: [premioRef], size: 1 };
                      }
                      return { empty: true, docs: [], size: 0 };
                    }
                  }))
                }))
              };
            })
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
            get: jest.fn(async () => ({
              exists: !!userDocData,
              data: () => ({ ...(userDocData || {}) })
            }))
          }))
        };
      }
      return {};
    }),
    collectionGroup: jest.fn(() => {
      const query = {
        where: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        get: jest.fn().mockResolvedValue({
          empty: collectionGroupDocs.length === 0,
          docs: collectionGroupDocs,
          size: collectionGroupDocs.length
        })
      };
      return query;
    }),
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

  test('jugador autenticado sin email verificable responde 401', async () => {
    process.env.PREMIOS_ENGINE_V2_ENABLED = 'true';
    const admin = require('firebase-admin');
    const { acreditarPremioEventoHandler } = require('../uploadServer.js');
    const { db } = createFirestoreDouble();
    admin.firestore.mockReturnValue(db);

    const req = {
      body: {
        premioId: 'ppd_123',
        sorteoId: 'sorteo-1'
      },
      headers: {},
      user: { uid: 'uid-1', authScope: 'jugador' }
    };
    const res = makeRes();

    await acreditarPremioEventoHandler(req, res);

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual(expect.objectContaining({
      code: 'JUGADOR_EMAIL_REQUERIDO'
    }));
  });

  test('jugador autenticado no puede acreditar premio de otra billetera', async () => {
    process.env.PREMIOS_ENGINE_V2_ENABLED = 'true';
    const admin = require('firebase-admin');
    const { acreditarPremioEventoHandler } = require('../uploadServer.js');
    const { db } = createFirestoreDouble({
      userDocData: { uid: 'uid-jugador', IDbilletera: 'jugador@example.com', email: 'jugador@example.com' },
      collectionGroupDocs: [{
        id: 'ppd_123',
        exists: true,
        ref: {
          parent: {
            parent: {
              id: 'otra-billetera@example.com'
            }
          }
        },
        data: () => ({
          premioId: 'ppd_123',
          sorteoId: 'sorteo-1',
          estado: 'pendiente',
          creditos: 10,
          cartonesGratis: 1
        })
      }]
    });
    admin.firestore.mockReturnValue(db);

    const req = {
      body: {
        premioId: 'ppd_123',
        sorteoId: 'sorteo-1'
      },
      headers: {},
      user: { uid: 'uid-jugador', email: 'jugador@example.com', authScope: 'jugador' }
    };
    const res = makeRes();

    await acreditarPremioEventoHandler(req, res);

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual(expect.objectContaining({
      code: 'PREMIO_NO_PERTENECE_JUGADOR',
      billeteraId: 'jugador@example.com'
    }));
  });
});
