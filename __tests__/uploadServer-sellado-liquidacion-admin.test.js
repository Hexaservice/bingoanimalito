jest.mock('firebase-admin', () => ({
  apps: [],
  initializeApp: jest.fn(),
  firestore: Object.assign(jest.fn(), {
    FieldValue: {
      serverTimestamp: jest.fn(() => '__SERVER_TIMESTAMP__'),
      increment: jest.fn((value) => ({ __incrementBy: Number(value) || 0 }))
    }
  }),
  auth: jest.fn(() => ({ verifyIdToken: jest.fn() }))
}));

describe('sellado con liquidación administrativa', () => {
  function buildDbMock({ state, usersByRole }) {
    const sorteoRef = {
      kind: 'sorteo',
      id: state.sorteo.id,
      collection: jest.fn((name) => {
        if (name !== 'liquidaciones') throw new Error(`Subcolección no mockeada: ${name}`);
        return {
          doc: jest.fn((runId) => ({
            kind: 'run',
            id: runId,
            set: jest.fn(async (payload, options) => applySet({ kind: 'run', id: runId }, payload, options))
          }))
        };
      }),
      set: jest.fn(async (payload, options) => applySet({ kind: 'sorteo', id: state.sorteo.id }, payload, options))
    };

    let txCounter = 0;

    function resolvePayload(current, payload, options) {
      const base = options?.merge ? { ...current } : {};
      for (const [key, value] of Object.entries(payload || {})) {
        if (value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, '__incrementBy')) {
          const currentValue = Number(base[key] || 0);
          base[key] = Number((currentValue + value.__incrementBy).toFixed(6));
        } else {
          base[key] = value;
        }
      }
      return base;
    }

    function applySet(ref, payload, options) {
      if (ref.kind === 'sorteo') {
        state.sorteo = resolvePayload(state.sorteo, payload, options);
        return;
      }
      if (ref.kind === 'wallet') {
        const current = state.wallets[ref.id] || {};
        state.wallets[ref.id] = resolvePayload(current, payload, options);
        return;
      }
      if (ref.kind === 'tx') {
        state.transacciones[ref.id] = resolvePayload(state.transacciones[ref.id] || {}, payload, options);
        return;
      }
      if (ref.kind === 'run') {
        state.runs[ref.id] = resolvePayload(state.runs[ref.id] || {}, payload, options);
      }
    }

    return {
      collection: jest.fn((name) => {
        if (name === 'sorteos') {
          return { doc: jest.fn(() => sorteoRef) };
        }
        if (name === 'Billetera') {
          return { doc: jest.fn((id) => ({ kind: 'wallet', id })) };
        }
        if (name === 'transacciones') {
          return { doc: jest.fn(() => ({ kind: 'tx', id: `tx-${++txCounter}` })) };
        }
        if (name === 'users') {
          return {
            where: jest.fn((_field, _op, role) => ({
              get: jest.fn(async () => ({
                forEach: (cb) => (usersByRole[role] || []).forEach((u) => cb({ id: u.id, data: () => u.data }))
              }))
            }))
          };
        }
        throw new Error(`Colección no mockeada: ${name}`);
      }),
      runTransaction: jest.fn(async (fn) => {
        const tx = {
          get: jest.fn(async (ref) => {
            if (ref.kind === 'sorteo') {
              return { exists: true, data: () => ({ ...state.sorteo }) };
            }
            return { exists: false, data: () => ({}) };
          }),
          set: jest.fn((ref, payload, options) => applySet(ref, payload, options))
        };
        return fn(tx);
      }),
      batch: jest.fn(() => {
        const ops = [];
        return {
          set: jest.fn((ref, payload, options) => ops.push({ ref, payload, options })),
          commit: jest.fn(async () => {
            ops.forEach((op) => applySet(op.ref, op.payload, op.options));
          })
        };
      })
    };
  }

  test('ejecuta fase A+B, liquida pagos y marca completado', async () => {
    jest.resetModules();
    const { ejecutarSelladoConLiquidacionAdmin } = require('../uploadServer.js');

    const state = {
      sorteo: {
        id: 's1',
        nombre: 'Sorteo 1',
        totalporcentaje: 3,
        totalporcentajesu: 1,
        selladoPagoAdminAplicado: false
      },
      wallets: {
        'ag1@test.com': { creditos: 10 },
        'ag2@test.com': { creditos: 20 },
        'dev1@test.com': { creditos: 5 }
      },
      transacciones: {},
      runs: {}
    };

    const db = buildDbMock({
      state,
      usersByRole: {
        agencia: [
          { id: 'ag1@test.com', data: { email: 'ag1@test.com', rolinterno: 'agencia' } },
          { id: 'ag2@test.com', data: { email: 'ag2@test.com', rolinterno: 'agencia' } }
        ],
        desarrollador: [
          { id: 'dev1@test.com', data: { email: 'dev1@test.com', rolinterno: 'desarrollador' } }
        ]
      }
    });

    const result = await ejecutarSelladoConLiquidacionAdmin({ db, sorteoId: 's1', operadorEmail: 'admin@test.com' });

    expect(result.ok).toBe(true);
    expect(result.idempotente).toBe(false);
    expect(result.runId).toBeTruthy();
    expect(result.pagosAplicados).toHaveLength(3);
    expect(state.sorteo.totalporcentaje).toBe(0);
    expect(state.sorteo.totalporcentajesu).toBe(0);
    expect(state.sorteo.selladoPagoAdminAplicado).toBe(true);
    expect(state.sorteo.selladoLiquidacionEstado).toBe('completado');
    expect(state.wallets['ag1@test.com'].creditos).toBe(12);
    expect(state.wallets['ag2@test.com'].creditos).toBe(21);
    expect(state.wallets['dev1@test.com'].creditos).toBe(6);
    const txDocs = Object.values(state.transacciones);
    expect(txDocs.every((doc) => doc.tipotrans === 'pago' && doc.referencia === 'PAGO')).toBe(true);
    expect(state.runs[result.runId].estado).toBe('completado');
  });

  test('si ya fue aplicado, responde idempotente sin crear pagos nuevos', async () => {
    jest.resetModules();
    const { ejecutarSelladoConLiquidacionAdmin } = require('../uploadServer.js');

    const state = {
      sorteo: { id: 's2', selladoPagoAdminAplicado: true, estado: 'Activo', pdf: 'si' },
      wallets: {},
      transacciones: {},
      runs: {}
    };

    const db = buildDbMock({ state, usersByRole: {} });
    const result = await ejecutarSelladoConLiquidacionAdmin({ db, sorteoId: 's2', operadorEmail: 'admin@test.com' });

    expect(result.ok).toBe(true);
    expect(result.idempotente).toBe(true);
    expect(result.pagosAplicados).toHaveLength(0);
    expect(state.sorteo.estado).toBe('Sellado');
    expect(state.sorteo.pdf).toBe('no');
    expect(Object.keys(state.runs)).toHaveLength(0);
  });
});
