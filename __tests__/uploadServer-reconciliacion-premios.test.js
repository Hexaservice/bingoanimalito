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
});
