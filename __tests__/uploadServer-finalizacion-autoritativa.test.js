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

describe('finalización autoritativa de sorteo', () => {
  test('bloquea cuando faltan resultados y formas sin ganador', () => {
    const { buildFinalizationContract } = require('../uploadServer.js');

    const contrato = buildFinalizationContract({
      sorteoData: {
        estado: 'Jugando',
        formas: [{ idx: 1, nombre: 'Linea' }, { idx: 2, nombre: 'Bingo' }],
        ganadoresBloqueadosPorForma: {
          '1': { cartonClaves: ['usr:a::num:1'] }
        },
        loterias: [{ id: 'l1', mostrarBloquesIntermedios: true }]
      },
      cantosData: {
        resultadosPorCelda: {
          a: { exacta: '01', intermedia: null }
        }
      }
    });

    expect(contrato.permitido).toBe(false);
    expect(contrato.motivo).toBe('faltan_resultados_y_ganadores');
    expect(contrato.detalle.totalFormasSinGanador).toBe(1);
    expect(contrato.detalle.bloquesResultadosPendientes).toBeGreaterThan(0);
  });

  test('permite finalizar cuando no hay bloques de resultados requeridos y no hay ganadores', () => {
    const { buildFinalizationContract } = require('../uploadServer.js');

    const contrato = buildFinalizationContract({
      sorteoData: {
        estado: 'Jugando',
        formas: [{ idx: 1, nombre: 'Linea' }],
        ganadoresBloqueadosPorForma: {},
        loterias: []
      },
      cantosData: {
        resultadosPorCelda: {}
      }
    });

    expect(contrato.permitido).toBe(true);
    expect(contrato.detalle.resultadosCompletos).toBe(true);
    expect(contrato.detalle.totalResultadosRequeridos).toBe(0);
    expect(contrato.detalle.totalFormasSinGanador).toBe(1);
  });

  test('serializa concurrencia: solo la primera finalización cambia estado', async () => {
    jest.resetModules();
    const { executeAuthoritativeSorteoFinalization } = require('../uploadServer.js');

    const state = {
      sorteo: {
        estado: 'Jugando',
        formas: [{ idx: 1, nombre: 'Linea' }],
        ganadoresBloqueadosPorForma: {
          '1': { cartonClaves: ['usr:a::num:1'] }
        },
        loterias: [{ id: 'l1', mostrarBloquesIntermedios: true }]
      },
      cantos: { resultadosPorCelda: {} }
    };

    const sorteoRef = { __kind: 'sorteo-ref', id: 's1' };
    const cantosRef = { __kind: 'cantos-ref', id: 's1' };

    const db = {
      collection: jest.fn((name) => ({
        doc: jest.fn(() => (name === 'sorteos' ? sorteoRef : cantosRef))
      })),
      runTransaction: jest.fn(async (fn) => {
        const tx = {
          get: jest.fn(async (ref) => {
            if (ref === sorteoRef) {
              return {
                exists: true,
                data: () => ({ ...state.sorteo })
              };
            }
            if (ref === cantosRef) {
              return {
                exists: true,
                data: () => ({ ...state.cantos })
              };
            }
            return { exists: false, data: () => ({}) };
          }),
          update: jest.fn((ref, payload) => {
            if (ref === sorteoRef) {
              state.sorteo = { ...state.sorteo, ...payload };
            }
          })
        };
        return fn(tx);
      })
    };

    const primera = await executeAuthoritativeSorteoFinalization({
      db,
      sorteoId: 's1',
      operadorEmail: 'op1@demo.com'
    });
    const segunda = await executeAuthoritativeSorteoFinalization({
      db,
      sorteoId: 's1',
      operadorEmail: 'op2@demo.com'
    });

    expect(primera.permitido).toBe(true);
    expect(primera.motivo).toBe('finalizado');
    expect(segunda.permitido).toBe(false);
    expect(segunda.motivo).toBe('estado_no_jugando');
    expect(state.sorteo.estado).toBe('Finalizado');
    expect(state.sorteo.finalizadoPor).toBe('op1@demo.com');
  });
});
