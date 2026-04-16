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

const { reconcileSinglePendingPrize } = require('../uploadServer');

function createDbDouble() {
  const state = {
    billetera: { creditos: 100, CartonesGratis: 2 },
    premios: new Map(),
    ledger: new Map(),
    transacciones: new Map()
  };

  const billeteraRef = {
    id: 'jugador@example.com',
    collection: jest.fn((name) => ({
      doc: (id) => ({ __kind: `${name}-doc`, id })
    }))
  };

  const db = {
    collection: jest.fn((name) => {
      if (name === 'transacciones') {
        return {
          doc: (id) => ({ __kind: 'transaccion-ref', id }),
          where: (field, op, value) => ({
            limit: () => ({ __kind: 'tx-query', field, op, value })
          })
        };
      }
      return {};
    }),
    runTransaction: jest.fn(async (fn) => fn({
      get: jest.fn(async (target) => {
        if (target?.__kind === 'premio-ref') {
          const doc = state.premios.get(target.id);
          return { exists: !!doc, data: () => ({ ...(doc || {}) }) };
        }
        if (target === billeteraRef) {
          return { exists: true, data: () => ({ ...state.billetera }) };
        }
        if (target?.__kind === 'transaccion-ref') {
          return { exists: state.transacciones.has(target.id), data: () => state.transacciones.get(target.id) };
        }
        if (target?.__kind === 'premiosLedger-doc') {
          return { exists: state.ledger.has(target.id), data: () => state.ledger.get(target.id) };
        }
        if (target?.__kind === 'tx-query') {
          const docs = Array.from(state.transacciones.values()).filter((tx) => tx?.[target.field] === target.value);
          return { empty: docs.length === 0, docs: docs.map((d, i) => ({ id: `tx-${i}`, data: () => d })) };
        }
        return { exists: false, empty: true, docs: [] };
      }),
      set: jest.fn((target, payload) => {
        if (target === billeteraRef) {
          state.billetera = { ...state.billetera, ...payload };
          return;
        }
        if (target?.__kind === 'premio-ref' || target?.__kind === 'premiosPagosdirectos-doc') {
          const prev = state.premios.get(target.id) || {};
          state.premios.set(target.id, { ...prev, ...payload });
          return;
        }
        if (target?.__kind === 'premiosLedger-doc') {
          state.ledger.set(target.id, { ...(state.ledger.get(target.id) || {}), ...payload });
          return;
        }
        if (target?.__kind === 'transaccion-ref') {
          state.transacciones.set(target.id, payload);
        }
      })
    }))
  };

  function makePremioDoc(id) {
    return {
      id,
      ref: {
        __kind: 'premio-ref',
        id,
        parent: { parent: billeteraRef }
      }
    };
  }

  return { db, state, makePremioDoc };
}

describe('regresión backend premios directos sin aprobación manual', () => {
  test('acredita inmediatamente en billetera y crea transacción consistente', async () => {
    const { db, state, makePremioDoc } = createDbDouble();
    state.premios.set('ppd_a', {
      sorteoId: 'SRT-1',
      estado: 'pendiente',
      creditos: 5.25,
      cartonesGratis: 1,
      eventoGanadorId: 'SRT-1__f1__usr:jugador@example.com::num:1'
    });

    const result = await reconcileSinglePendingPrize({
      db,
      premioDoc: makePremioDoc('ppd_a'),
      sorteoId: 'SRT-1',
      acreditadoPor: 'sistema:test',
      origen: 'premios_automaticos_cierre_forma',
      eventoGanadorId: 'SRT-1__f1__usr:jugador@example.com::num:1'
    });

    expect(result.status).toBe('acreditado');
    expect(state.billetera.creditos).toBe(105.25);
    expect(state.billetera.CartonesGratis).toBe(3);
    expect(state.transacciones.size).toBe(1);
    const tx = Array.from(state.transacciones.values())[0];
    expect(tx).toEqual(expect.objectContaining({
      tipotrans: 'premio',
      referencia: 'PREMIO',
      eventoGanadorId: 'SRT-1__f1__usr:jugador@example.com::num:1',
      IDbilletera: 'jugador@example.com'
    }));
  });

  test('reintentos por mismo eventoGanadorId no duplican acreditación', async () => {
    const { db, state, makePremioDoc } = createDbDouble();
    const eventoGanadorId = 'SRT-1__f2__usr:jugador@example.com::num:9';
    state.premios.set('ppd_1', {
      sorteoId: 'SRT-1',
      estado: 'pendiente',
      creditos: 8,
      cartonesGratis: 2,
      eventoGanadorId
    });

    const primera = await reconcileSinglePendingPrize({
      db,
      premioDoc: makePremioDoc('ppd_1'),
      sorteoId: 'SRT-1',
      acreditadoPor: 'sistema:test',
      origen: 'premios_automaticos_cierre_forma',
      eventoGanadorId
    });

    state.premios.set('ppd_2', {
      sorteoId: 'SRT-1',
      estado: 'pendiente',
      creditos: 8,
      cartonesGratis: 2,
      eventoGanadorId
    });

    const segunda = await reconcileSinglePendingPrize({
      db,
      premioDoc: makePremioDoc('ppd_2'),
      sorteoId: 'SRT-1',
      acreditadoPor: 'sistema:test',
      origen: 'premios_automaticos_cierre_forma',
      eventoGanadorId
    });

    expect(primera.status).toBe('acreditado');
    expect(segunda).toEqual(expect.objectContaining({ status: 'omitido', reason: 'premio_duplicado' }));
    expect(state.transacciones.size).toBe(1);
    expect(state.billetera.creditos).toBe(108);
  });

  test('la acreditación backend funciona sin ruta de aprobación manual', async () => {
    const { db, state, makePremioDoc } = createDbDouble();
    state.premios.set('ppd_manual_off', {
      sorteoId: 'SRT-2',
      estado: 'pendiente',
      creditos: 3,
      cartonesGratis: 0,
      eventoGanadorId: 'SRT-2__f1__usr:jugador@example.com::num:2'
    });

    const result = await reconcileSinglePendingPrize({
      db,
      premioDoc: makePremioDoc('ppd_manual_off'),
      sorteoId: 'SRT-2',
      acreditadoPor: 'sistema:test',
      origen: 'premios_automaticos_cierre_forma',
      eventoGanadorId: 'SRT-2__f1__usr:jugador@example.com::num:2'
    });

    expect(result.status).toBe('acreditado');
    expect(state.premios.get('ppd_manual_off').estado).toBe('acreditado');
  });
});
