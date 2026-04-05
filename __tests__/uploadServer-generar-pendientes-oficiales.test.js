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

const {
  buildOfficialPendingPrizeId,
  generatePendingDirectPrizesFromOfficialResults
} = require('../uploadServer.js');

function makeSnapDocs(items) {
  const docs = items.map((item) => ({ id: item.id, data: () => item.data || {} }));
  return {
    empty: docs.length === 0,
    docs,
    forEach: (cb) => docs.forEach(cb)
  };
}

function createDbDouble({
  formas = [{ idx: 1, nombre: 'Linea', valorPremio: 120 }],
  lockPorForma = {
    '1': { cartonClaves: ['usr:ganador@example.com::num:7'], cerradoEn: '2026-04-01T00:00:00Z' }
  },
  cartones = [
    {
      id: 'carton-doc-7',
      data: {
        sorteoId: 'SRT-OF-1',
        userId: 'ganador@example.com',
        cartonNum: 7,
        email: 'ganador@example.com'
      }
    }
  ]
} = {}) {
  const premios = new Map();
  const sorteoData = {
    id: 'SRT-OF-1',
    data: {
      formas,
      ganadoresBloqueadosPorForma: lockPorForma
    }
  };

  function premioCollection(billeteraId) {
    return {
      doc: (premioId) => ({
        id: premioId,
        get: async () => ({ exists: premios.has(`${billeteraId}/${premioId}`) }),
        set: async (payload) => {
          premios.set(`${billeteraId}/${premioId}`, payload);
        }
      }),
      where: (field, op, value) => ({
        limit: () => ({
          get: async () => {
            const docs = Array.from(premios.entries())
              .filter(([key, data]) => key.startsWith(`${billeteraId}/`) && data?.[field] === value)
              .map(([key, data]) => ({ id: key.split('/')[1], data: () => data }));
            return { empty: docs.length === 0, docs };
          }
        })
      })
    };
  }

  const db = {
    collection: (name) => {
      if (name === 'sorteos') {
        return {
          doc: (id) => ({
            get: async () => {
              if (id !== sorteoData.id) return { exists: false, data: () => ({}) };
              return { exists: true, data: () => sorteoData.data };
            }
          })
        };
      }

      if (name === 'CartonJugado') {
        return {
          where: () => ({
            get: async () => makeSnapDocs(cartones)
          })
        };
      }

      if (name === 'users') {
        return {
          doc: (id) => ({
            get: async () => {
              if (id === 'ganador@example.com') {
                return { exists: true, id, data: () => ({ email: 'ganador@example.com' }) };
              }
              return { exists: false, id, data: () => ({}) };
            }
          }),
          where: () => ({
            limit: () => ({
              get: async () => ({ empty: true, docs: [] })
            })
          })
        };
      }

      if (name === 'Billetera') {
        return {
          doc: (billeteraId) => ({
            id: billeteraId,
            collection: () => premioCollection(billeteraId)
          })
        };
      }

      throw new Error(`Colección no mockeada: ${name}`);
    }
  };

  return { db, premios };
}

describe('generatePendingDirectPrizesFromOfficialResults', () => {
  test('crea premios pendientes solo desde lock oficial y evita duplicados por eventoGanadorId', async () => {
    const { db, premios } = createDbDouble();

    const first = await generatePendingDirectPrizesFromOfficialResults({
      db,
      sorteoId: 'SRT-OF-1',
      generadoPor: 'admin@test.com'
    });

    expect(first.creados).toBe(1);
    expect(first.duplicados).toBe(0);
    const created = Array.from(premios.values())[0];
    expect(created.estado).toBe('pendiente');
    expect(created.eventoGanadorId).toBe('SRT-OF-1__f1__usr:ganador@example.com::num:7');
    expect(created.cartonClaveGanador).toBe('usr:ganador@example.com::num:7');
    expect(created.cartonId).toBe('carton-doc-7');

    const second = await generatePendingDirectPrizesFromOfficialResults({
      db,
      sorteoId: 'SRT-OF-1',
      generadoPor: 'admin@test.com'
    });

    expect(second.creados).toBe(0);
    expect(second.duplicados).toBe(1);
    expect(premios.size).toBe(1);
  });

  test('buildOfficialPendingPrizeId es determinístico para idempotencia', () => {
    const idA = buildOfficialPendingPrizeId('SRT-OF-1__f2__carton-11');
    const idB = buildOfficialPendingPrizeId('SRT-OF-1__f2__carton-11');
    expect(idA).toBe(idB);
    expect(idA.startsWith('ppd_')).toBe(true);
  });

  test('divide créditos y cartones (si son totales de forma) entre 2+ ganadores con precisión de 6 decimales', async () => {
    const { db, premios } = createDbDouble({
      formas: [{
        idx: 1,
        nombre: 'Linea',
        valorPremio: 100,
        cartonesGratis: 5
      }],
      lockPorForma: {
        '1': {
          cartonClaves: [
            'usr:ganador@example.com::num:7',
            'usr:ganador2@example.com::num:8'
          ],
          cerradoEn: '2026-04-01T00:00:00Z'
        }
      },
      cartones: [
        {
          id: 'carton-doc-7',
          data: {
            sorteoId: 'SRT-OF-1',
            userId: 'ganador@example.com',
            cartonNum: 7,
            email: 'ganador@example.com'
          }
        },
        {
          id: 'carton-doc-8',
          data: {
            sorteoId: 'SRT-OF-1',
            userId: 'ganador2@example.com',
            cartonNum: 8,
            email: 'ganador2@example.com'
          }
        }
      ]
    });

    const result = await generatePendingDirectPrizesFromOfficialResults({
      db,
      sorteoId: 'SRT-OF-1',
      generadoPor: 'admin@test.com'
    });

    expect(result.creados).toBe(2);
    const premiosCreados = Array.from(premios.values());
    expect(premiosCreados).toHaveLength(2);
    premiosCreados.forEach((premio) => {
      expect(premio.creditos).toBe(50);
      expect(premio.cartonesGratis).toBe(2.5);
    });
  });

  test('respeta cartonesGratisPorGanador como valor fijo por ganador', async () => {
    const { db, premios } = createDbDouble({
      formas: [{
        idx: 1,
        nombre: 'Diagonal',
        valorPremio: 10,
        cartonesGratis: 5,
        cartonesGratisPorGanador: 1.75
      }],
      lockPorForma: {
        '1': {
          cartonClaves: [
            'usr:ganador@example.com::num:7',
            'usr:ganador2@example.com::num:8'
          ],
          cerradoEn: '2026-04-01T00:00:00Z'
        }
      },
      cartones: [
        {
          id: 'carton-doc-7',
          data: {
            sorteoId: 'SRT-OF-1',
            userId: 'ganador@example.com',
            cartonNum: 7,
            email: 'ganador@example.com'
          }
        },
        {
          id: 'carton-doc-8',
          data: {
            sorteoId: 'SRT-OF-1',
            userId: 'ganador2@example.com',
            cartonNum: 8,
            email: 'ganador2@example.com'
          }
        }
      ]
    });

    await generatePendingDirectPrizesFromOfficialResults({
      db,
      sorteoId: 'SRT-OF-1',
      generadoPor: 'admin@test.com'
    });

    const premiosCreados = Array.from(premios.values());
    expect(premiosCreados).toHaveLength(2);
    premiosCreados.forEach((premio) => {
      expect(premio.creditos).toBe(5);
      expect(premio.cartonesGratis).toBe(1.75);
    });
  });
});
