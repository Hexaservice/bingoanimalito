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

describe('cierre transaccional de forma ganadora', () => {
  test('doble cierre simultáneo de la misma forma es idempotente', async () => {
    jest.resetModules();
    const { closeWinnerFormTransactional } = require('../uploadServer');

    const state = { lock: null };
    const lockRef = { id: 's1__f1' };

    const db = {
      collection: jest.fn(() => ({
        doc: jest.fn(() => lockRef)
      })),
      runTransaction: jest.fn(async (callback) => {
        const tx = {
          get: jest.fn(async () => ({
            exists: Boolean(state.lock),
            data: () => ({ ...(state.lock || {}) })
          })),
          set: jest.fn((_, payload) => {
            state.lock = { ...(state.lock || {}), ...payload };
          })
        };
        return callback(tx);
      })
    };

    const [primero, segundo] = await Promise.all([
      closeWinnerFormTransactional({
        db,
        sorteoId: 's1',
        formaIdx: 1,
        winnerKeys: ['usr:a::num:1'],
        pasoCierre: 12,
        cerradoPor: 'admin@demo.com'
      }),
      closeWinnerFormTransactional({
        db,
        sorteoId: 's1',
        formaIdx: 1,
        winnerKeys: ['usr:a::num:1'],
        pasoCierre: 12,
        cerradoPor: 'admin@demo.com'
      })
    ]);

    const statuses = new Set([primero.status, segundo.status]);
    expect(statuses.has('closed')).toBe(true);
    expect([...statuses].every((value) => ['closed', 'already_closed'].includes(value))).toBe(true);
    expect(state.lock.winnerKeys).toEqual(['usr:a::num:1']);
    expect(state.lock.cerrada).toBe(true);
  });

  test('reintento de cierre con nuevos cantos no sobreescribe winnerKeys cerrados', async () => {
    jest.resetModules();
    const { closeWinnerFormTransactional } = require('../uploadServer');

    const lockRef = { id: 's1__f2' };
    const state = {
      lock: {
        sorteoId: 's1',
        formaIdx: 2,
        cerrada: true,
        winnerKeys: ['usr:original::num:7'],
        pasoCierre: 20
      }
    };

    const db = {
      collection: jest.fn(() => ({
        doc: jest.fn(() => lockRef)
      })),
      runTransaction: jest.fn(async (callback) => {
        const tx = {
          get: jest.fn(async () => ({
            exists: true,
            data: () => ({ ...state.lock })
          })),
          set: jest.fn(() => {
            throw new Error('No debería escribir en lock ya cerrado');
          })
        };
        return callback(tx);
      })
    };

    const result = await closeWinnerFormTransactional({
      db,
      sorteoId: 's1',
      formaIdx: 2,
      winnerKeys: ['usr:nuevo::num:99'],
      pasoCierre: 45,
      cerradoPor: 'otro@demo.com'
    });

    expect(result.status).toBe('already_closed');
    expect(result.lock.winnerKeys).toEqual(['usr:original::num:7']);
    expect(db.runTransaction).toHaveBeenCalledTimes(1);
  });

  test('finalización permite formas pendientes cuando hay resultados completos y otras cerradas', () => {
    jest.resetModules();
    const { buildFinalizationContract } = require('../uploadServer');

    const contract = buildFinalizationContract({
      sorteoData: {
        estado: 'Jugando',
        formas: [{ idx: 1, nombre: 'Línea' }, { idx: 2, nombre: 'Cuatro esquinas' }, { idx: 3, nombre: 'Bingo' }],
        loterias: [{ id: 'l1', bloquesHorarios: ['08:00'], mostrarBloquesIntermedios: false }]
      },
      cantosData: {
        resultadosPorCelda: {
          'l1_08:00': { exacta: '11' }
        }
      },
      winnerFormIdxs: new Set([1])
    });

    expect(contract.permitido).toBe(true);
    expect(contract.detalle.totalFormasSinGanador).toBe(2);
    expect(contract.detalle.resultadosCompletos).toBe(true);
  });
});
