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

describe('sellado con liquidación administrativa', () => {
  test('liquida porcentajes administrativos, crea transacciones PAGO y marca idempotencia', async () => {
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
      transacciones: {}
    };

    const sorteoRef = { kind: 'sorteo', id: 's1' };
    const walletRef = (id) => ({ kind: 'wallet', id });
    const txRef = (id) => ({ kind: 'tx', id });
    let txCounter = 0;

    const usersByRole = {
      agencia: [
        { id: 'ag1@test.com', data: { email: 'ag1@test.com', rolinterno: 'agencia' } },
        { id: 'ag2@test.com', data: { email: 'ag2@test.com', rolinterno: 'agencia' } }
      ],
      desarrollador: [
        { id: 'dev1@test.com', data: { email: 'dev1@test.com', rolinterno: 'desarrollador' } }
      ]
    };

    const db = {
      collection: jest.fn((name) => {
        if (name === 'sorteos') {
          return { doc: jest.fn(() => sorteoRef) };
        }
        if (name === 'Billetera') {
          return { doc: jest.fn((id) => walletRef(id)) };
        }
        if (name === 'transacciones') {
          return { doc: jest.fn(() => txRef(`tx-${++txCounter}`)) };
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
            if (ref.kind === 'wallet') {
              const wallet = state.wallets[ref.id];
              return { exists: Boolean(wallet), data: () => ({ ...(wallet || {}) }) };
            }
            return { exists: false, data: () => ({}) };
          }),
          set: jest.fn((ref, payload, options) => {
            if (ref.kind === 'sorteo') {
              state.sorteo = options?.merge ? { ...state.sorteo, ...payload } : { ...payload };
            } else if (ref.kind === 'wallet') {
              const current = state.wallets[ref.id] || {};
              state.wallets[ref.id] = options?.merge ? { ...current, ...payload } : { ...payload };
            } else if (ref.kind === 'tx') {
              state.transacciones[ref.id] = { ...payload };
            }
          })
        };
        return fn(tx);
      })
    };

    const result = await ejecutarSelladoConLiquidacionAdmin({ db, sorteoId: 's1', operadorEmail: 'admin@test.com' });

    expect(result.ok).toBe(true);
    expect(result.idempotente).toBe(false);
    expect(result.pagosAplicados).toHaveLength(3);
    expect(state.sorteo.totalporcentaje).toBe(0);
    expect(state.sorteo.totalporcentajesu).toBe(0);
    expect(state.sorteo.selladoPagoAdminAplicado).toBe(true);
    expect(state.wallets['ag1@test.com'].creditos).toBe(12);
    expect(state.wallets['ag2@test.com'].creditos).toBe(21);
    expect(state.wallets['dev1@test.com'].creditos).toBe(6);
    const txDocs = Object.values(state.transacciones);
    expect(txDocs.every((doc) => doc.tipotrans === 'pago' && doc.referencia === 'PAGO')).toBe(true);
  });

  test('si ya fue aplicado, responde idempotente sin crear pagos nuevos', async () => {
    jest.resetModules();
    const { ejecutarSelladoConLiquidacionAdmin } = require('../uploadServer.js');

    const sorteoRef = { kind: 'sorteo', id: 's2' };
    const state = {
      sorteo: { id: 's2', selladoPagoAdminAplicado: true, estado: 'Activo', pdf: 'si' }
    };

    const db = {
      collection: jest.fn((name) => {
        if (name === 'sorteos') return { doc: jest.fn(() => sorteoRef) };
        if (name === 'users') return { where: jest.fn(() => ({ get: jest.fn(async () => ({ forEach: () => {} })) })) };
        if (name === 'Billetera') return { doc: jest.fn(() => ({ kind: 'wallet' })) };
        if (name === 'transacciones') return { doc: jest.fn(() => ({ kind: 'tx' })) };
        throw new Error(`Colección no mockeada: ${name}`);
      }),
      runTransaction: jest.fn(async (fn) => {
        const tx = {
          get: jest.fn(async () => ({ exists: true, data: () => ({ ...state.sorteo }) })),
          set: jest.fn((ref, payload, options) => {
            if (ref.kind === 'sorteo') {
              state.sorteo = options?.merge ? { ...state.sorteo, ...payload } : { ...payload };
            }
          })
        };
        return fn(tx);
      })
    };

    const result = await ejecutarSelladoConLiquidacionAdmin({ db, sorteoId: 's2', operadorEmail: 'admin@test.com' });

    expect(result.ok).toBe(true);
    expect(result.idempotente).toBe(true);
    expect(result.pagosAplicados).toHaveLength(0);
    expect(state.sorteo.estado).toBe('Sellado');
    expect(state.sorteo.pdf).toBe('no');
  });
});
