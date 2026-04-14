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

describe('reconciliación de premios pendientes directos', () => {
  test('buildReconciledPrizeTransactionId genera IDs determinísticos', () => {
    const { buildReconciledPrizeTransactionId } = require('../uploadServer.js');

    const a = buildReconciledPrizeTransactionId('SRT-1::F2::CARTON-4');
    const b = buildReconciledPrizeTransactionId('srt-1::f2::carton-4');
    const c = buildReconciledPrizeTransactionId('srt-1::f2::carton-5');

    expect(a).toBe(b);
    expect(a).toMatch(/^premio_reconciliado_[a-f0-9]{32}$/);
    expect(c).not.toBe(a);
  });

  test('normalizePendingPrizeState normaliza a minúsculas', () => {
    const { normalizePendingPrizeState } = require('../uploadServer.js');

    expect(normalizePendingPrizeState(' PENDIENTE ')).toBe('pendiente');
    expect(normalizePendingPrizeState('Acreditado')).toBe('acreditado');
    expect(normalizePendingPrizeState(null)).toBe('');
  });

  test('reconcilePendingPrizesBySorteo valida sorteoId', async () => {
    const { reconcilePendingPrizesBySorteo } = require('../uploadServer.js');

    await expect(reconcilePendingPrizesBySorteo({ db: {}, sorteoId: '' }))
      .rejects
      .toThrow('sorteoId es obligatorio para reconciliar premios pendientes directos');
  });

  test('reconcilePendingPrizesBySorteo retorna resumen sin registros cuando collectionGroup viene vacío', async () => {
    const { reconcilePendingPrizesBySorteo } = require('../uploadServer.js');

    const queryMock = {
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      startAfter: jest.fn().mockReturnThis(),
      get: jest.fn().mockResolvedValue({ empty: true, docs: [], size: 0 })
    };

    const db = {
      collectionGroup: jest.fn(() => queryMock)
    };

    const result = await reconcilePendingPrizesBySorteo({
      db,
      sorteoId: 'sorteo-100'
    });

    expect(db.collectionGroup).toHaveBeenCalledWith('premiosPendientesDirectos');
    expect(result).toEqual({
      sorteoId: 'sorteo-100',
      revisados: 0,
      acreditados: 0,
      omitidos: 0,
      errores: 0
    });
  });

  test('reconcileSinglePendingPrize actualiza también la colección legacy premiosPagosdirectos', async () => {
    const { reconcileSinglePendingPrize } = require('../uploadServer.js');

    const premioRef = {
      id: 'ppd_abc123',
      parent: {
        parent: {
          id: 'ganador@example.com',
          collection: jest.fn((name) => ({
            doc: (id) => ({ __kind: `${name}-doc`, id })
          }))
        }
      }
    };
    const premioDoc = {
      id: 'ppd_abc123',
      ref: premioRef
    };

    const premioSnap = {
      exists: true,
      data: () => ({
        sorteoId: 'SRT-9',
        estado: 'pendiente',
        creditos: 25,
        cartonesGratis: 2
      })
    };

    const queryByPremio = { __kind: 'query-by-premio' };
    const tx = {
      get: jest.fn(async (target) => {
        if (target === premioRef) return premioSnap;
        if (target === premioRef.parent.parent) return { exists: true, data: () => ({ creditos: 100, CartonesGratis: 3 }) };
        if (target && target.__kind === 'transaccion-ref') return { exists: false };
        if (target === queryByPremio) return { empty: true, docs: [] };
        return { exists: false, empty: true, docs: [] };
      }),
      set: jest.fn()
    };

    const db = {
      collection: jest.fn((name) => {
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
      runTransaction: jest.fn(async (cb) => cb(tx))
    };

    const result = await reconcileSinglePendingPrize({
      db,
      premioDoc,
      sorteoId: 'SRT-9',
      acreditadoPor: 'admin@test.com',
      origen: 'manual'
    });

    expect(result.status).toBe('acreditado');
    const targets = tx.set.mock.calls.map(([target]) => target?.__kind || target?.id || '');
    expect(targets).toContain('premiosPagosdirectos-doc');
  });

  test('reconcileSinglePendingPrize marca premio_duplicado cuando existe transacción previa sin volver a acreditar saldo', async () => {
    const { reconcileSinglePendingPrize } = require('../uploadServer.js');

    const premioRef = {
      id: 'ppd_duplicado',
      parent: {
        parent: {
          id: 'ganador@example.com',
          collection: jest.fn((name) => ({
            doc: (id) => ({ __kind: `${name}-doc`, id })
          }))
        }
      }
    };
    const premioDoc = {
      id: 'ppd_duplicado',
      ref: premioRef
    };

    const premioSnap = {
      exists: true,
      data: () => ({
        sorteoId: 'SRT-9',
        estado: 'pendiente',
        creditos: 25,
        cartonesGratis: 2
      })
    };

    const queryByPremio = { __kind: 'query-by-premio' };
    const tx = {
      get: jest.fn(async (target) => {
        if (target === premioRef) return premioSnap;
        if (target === premioRef.parent.parent) return { exists: true, data: () => ({ creditos: 100, CartonesGratis: 3 }) };
        if (target && target.__kind === 'transaccion-ref') return { exists: false };
        if (target === queryByPremio) return { empty: false, docs: [{ id: 'tx-previa' }] };
        return { exists: false, empty: true, docs: [] };
      }),
      set: jest.fn()
    };

    const db = {
      collection: jest.fn((name) => {
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
      runTransaction: jest.fn(async (cb) => cb(tx))
    };

    const result = await reconcileSinglePendingPrize({
      db,
      premioDoc,
      sorteoId: 'SRT-9',
      acreditadoPor: 'admin@test.com',
      origen: 'manual'
    });

    expect(result).toEqual(expect.objectContaining({
      status: 'omitido',
      reason: 'premio_duplicado',
      premioId: 'ppd_duplicado'
    }));
  });
});
