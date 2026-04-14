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

const ORIGINAL_PREMIOS_PAGOS_DIRECTOS_MIRROR_ENABLED = process.env.PREMIOS_PAGOS_DIRECTOS_MIRROR_ENABLED;
process.env.PREMIOS_PAGOS_DIRECTOS_MIRROR_ENABLED = 'true';

describe('reconciliación de premios pendientes directos', () => {
  afterAll(() => {
    if (ORIGINAL_PREMIOS_PAGOS_DIRECTOS_MIRROR_ENABLED === undefined) {
      delete process.env.PREMIOS_PAGOS_DIRECTOS_MIRROR_ENABLED;
      return;
    }
    process.env.PREMIOS_PAGOS_DIRECTOS_MIRROR_ENABLED = ORIGINAL_PREMIOS_PAGOS_DIRECTOS_MIRROR_ENABLED;
  });

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
    expect(targets).toContain('premiosLedger-doc');
  });

  test('reconcileSinglePendingPrize no actualiza legacy si el flag de espejo está desactivado', async () => {
    process.env.PREMIOS_PAGOS_DIRECTOS_MIRROR_ENABLED = 'false';
    jest.resetModules();
    const { reconcileSinglePendingPrize } = require('../uploadServer.js');

    const premioRef = {
      id: 'ppd_sin_espejo',
      parent: {
        parent: {
          id: 'ganador@example.com',
          collection: jest.fn((name) => ({
            doc: (id) => ({ __kind: `${name}-doc`, id })
          }))
        }
      }
    };
    const premioDoc = { id: 'ppd_sin_espejo', ref: premioRef };
    const premioSnap = {
      exists: true,
      data: () => ({ sorteoId: 'SRT-9', estado: 'pendiente', creditos: 5, cartonesGratis: 1 })
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
    expect(targets).not.toContain('premiosPagosdirectos-doc');

    process.env.PREMIOS_PAGOS_DIRECTOS_MIRROR_ENABLED = 'true';
    jest.resetModules();
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
    const creditoWrite = tx.set.mock.calls.find(([target]) => target === premioRef.parent.parent);
    expect(creditoWrite).toBeUndefined();
    const targets = tx.set.mock.calls.map(([target]) => target?.__kind || target?.id || '');
    expect(targets).toContain('premiosLedger-doc');
  });

  test('reconcileSinglePendingPrize no suma de nuevo si el ledger ya está acreditado', async () => {
    const { reconcileSinglePendingPrize } = require('../uploadServer.js');

    const premioRef = {
      id: 'ppd_ledger_acreditado',
      parent: {
        parent: {
          id: 'ganador@example.com',
          collection: jest.fn((name) => ({
            doc: (id) => ({ __kind: `${name}-doc`, id, data: () => ({ estado: 'acreditado' }) })
          }))
        }
      }
    };
    const premioDoc = { id: 'ppd_ledger_acreditado', ref: premioRef };
    const premioSnap = {
      exists: true,
      data: () => ({ sorteoId: 'SRT-9', estado: 'pendiente', creditos: 7, cartonesGratis: 1 })
    };
    const queryByPremio = { __kind: 'query-by-premio' };

    const tx = {
      get: jest.fn(async (target) => {
        if (target === premioRef) return premioSnap;
        if (target === premioRef.parent.parent) return { exists: true, data: () => ({ creditos: 100, CartonesGratis: 3 }) };
        if (target && target.__kind === 'transaccion-ref') return { exists: false };
        if (target === queryByPremio) return { empty: true, docs: [] };
        if (target && target.__kind === 'premiosLedger-doc') {
          return { exists: true, data: () => ({ estado: 'acreditado', transaccionId: 'tx-ya' }) };
        }
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
      reason: 'ya_acreditado',
      premioId: 'ppd_ledger_acreditado'
    }));
    const creditoWrite = tx.set.mock.calls.find(([target]) => target === premioRef.parent.parent);
    expect(creditoWrite).toBeUndefined();
  });


  test('reconcilePendingPrizesBySorteo procesa solo premios pendientes no acreditados', async () => {
    const { reconcilePendingPrizesBySorteo } = require('../uploadServer.js');

    const makePremioDoc = ({ id, estado, creditos, cartonesGratis }) => {
      const billeteraRef = {
        __kind: `wallet-${id}`,
        id: `${id}@example.com`,
        collection: jest.fn((name) => ({
          doc: (docId) => ({ __kind: `${name}-doc-${id}`, id: docId })
        }))
      };
      const premioRef = {
        __kind: `premio-${id}`,
        id,
        parent: { parent: billeteraRef }
      };
      return {
        id,
        ref: premioRef,
        __state: {
          sorteoId: 'SRT-9',
          estado,
          creditos,
          cartonesGratis,
          billetera: { creditos: 10, CartonesGratis: 1 }
        }
      };
    };

    const pendienteDoc = makePremioDoc({ id: 'ppd_pendiente', estado: 'pendiente', creditos: 5, cartonesGratis: 1 });
    const acreditadoDoc = makePremioDoc({ id: 'ppd_acreditado', estado: 'acreditado', creditos: 8, cartonesGratis: 2 });
    const docs = [pendienteDoc, acreditadoDoc];

    const txById = new Map();
    const txGet = async (target) => {
      const owner = docs.find((doc) => doc.ref === target || doc.ref.parent.parent === target);
      if (owner && owner.ref === target) {
        return { exists: true, data: () => ({ ...owner.__state }) };
      }
      if (owner && owner.ref.parent.parent === target) {
        return { exists: true, data: () => ({ ...owner.__state.billetera }) };
      }
      if (target && target.__kind === 'transaccion-ref') {
        return { exists: txById.has(target.id), data: () => txById.get(target.id) };
      }
      if (target && target.__kind === 'query-by-premio') {
        const hasTx = Array.from(txById.values()).some((tx) => tx.premioId === target.premioId);
        return hasTx ? { empty: false, docs: [{ id: 'tx-existente' }] } : { empty: true, docs: [] };
      }
      return { exists: false, empty: true, docs: [] };
    };

    const db = {
      collectionGroup: jest.fn(() => ({
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        startAfter: jest.fn().mockReturnThis(),
        get: jest.fn()
          .mockResolvedValueOnce({ empty: false, docs, size: docs.length })
          .mockResolvedValueOnce({ empty: true, docs: [], size: 0 })
      })),
      collection: jest.fn((name) => {
        if (name === 'transacciones') {
          return {
            doc: jest.fn((id) => ({ __kind: 'transaccion-ref', id })),
            where: jest.fn((_f, _o, premioId) => ({
              limit: jest.fn(() => ({ __kind: 'query-by-premio', premioId }))
            }))
          };
        }
        return {};
      }),
      runTransaction: jest.fn(async (cb) => cb({
        get: jest.fn(txGet),
        set: jest.fn((target, payload) => {
          const owner = docs.find((doc) => doc.ref === target || target?.__kind === `premiosPagosdirectos-doc-${doc.id}`);
          if (owner && (owner.ref === target || target?.__kind === `premiosPagosdirectos-doc-${owner.id}`)) {
            owner.__state = { ...owner.__state, ...payload };
            return;
          }
          const walletOwner = docs.find((doc) => doc.ref.parent.parent === target);
          if (walletOwner) {
            walletOwner.__state.billetera = { ...walletOwner.__state.billetera, ...payload };
            return;
          }
          if (target?.__kind === 'transaccion-ref') {
            txById.set(target.id, payload);
          }
        })
      }))
    };

    const result = await reconcilePendingPrizesBySorteo({
      db,
      sorteoId: 'SRT-9',
      pageSize: 50,
      acreditadoPor: 'ops@test.com',
      origen: 'reconciliacion-test'
    });

    expect(result).toEqual({
      sorteoId: 'SRT-9',
      revisados: 2,
      acreditados: 1,
      omitidos: 1,
      errores: 0
    });
    expect(pendienteDoc.__state.estado).toBe('acreditado');
    expect(acreditadoDoc.__state.billetera.creditos).toBe(10);
    expect(txById.size).toBe(1);
  });
});
