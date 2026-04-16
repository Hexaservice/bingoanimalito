const { calcularResumenMontos } = require('../public/js/estadisticassorteoResumen.js');
const estadosPago = require('../public/js/estadoPagoPremio.js');

describe('estadisticassorteoResumen.calcularResumenMontos', () => {
  function buildContext(premiosActivos) {
    return {
      premiosActivos,
      sorteoId: 'SRT-CP-1',
      normalizarEstado: estadosPago.normalizarLectura,
      estaFinalizado: estadosPago.estaFinalizado
    };
  }

  test('calcula totales globales y por forma correctamente', () => {
    const resumen = calcularResumenMontos(buildContext([
      { sorteoId: 'SRT-CP-1', formaIdx: 0, formasGanadoras: ['Linea'], creditos: 100, estado: 'PENDIENTE' },
      { sorteoId: 'SRT-CP-1', formaIdx: 0, formasGanadoras: ['Linea'], creditos: 50, estado: 'APROBADO' },
      { sorteoId: 'SRT-CP-1', formaIdx: 1, formasGanadoras: ['Linea', 'Bingo'], creditos: 40, estado: 'ACEPTADO' },
      { sorteoId: 'SRT-CP-1', formaIdx: 1, formasGanadoras: ['Linea', 'Bingo'], creditos: 10, estado: 'ARCHIVADO' },
      { sorteoId: 'OTRO', formaIdx: 0, creditos: 999, estado: 'APROBADO' }
    ]));

    expect(resumen.totalPremiosRepartir).toBe(200);
    expect(resumen.montoAcreditado).toBe(90);
    expect(resumen.montoPorAcreditar).toBe(110);

    expect(resumen.porForma).toEqual([
      {
        formaIdx: 0,
        nombreForma: 'Linea',
        totalForma: 150,
        acreditadoForma: 50,
        porAcreditarForma: 100
      },
      {
        formaIdx: 1,
        nombreForma: 'Bingo',
        totalForma: 50,
        acreditadoForma: 40,
        porAcreditarForma: 10
      }
    ]);
  });

  test('actualiza el resumen al cambiar estado de un premio', () => {
    const premios = [
      { sorteoId: 'SRT-CP-1', formaIdx: 0, formasGanadoras: ['Linea'], creditos: 80, estado: 'PENDIENTE' },
      { sorteoId: 'SRT-CP-1', formaIdx: 0, formasGanadoras: ['Linea'], creditos: 20, estado: 'PENDIENTE' }
    ];

    const antes = calcularResumenMontos(buildContext(premios));
    expect(antes.montoAcreditado).toBe(0);
    expect(antes.montoPorAcreditar).toBe(100);

    premios[0].estado = 'APROBADO';
    const despues = calcularResumenMontos(buildContext(premios));
    expect(despues.montoAcreditado).toBe(80);
    expect(despues.montoPorAcreditar).toBe(20);
    expect(despues.porForma[0].acreditadoForma).toBe(80);
    expect(despues.porForma[0].porAcreditarForma).toBe(20);
  });

  test('normaliza estados para la métrica acreditado vs por acreditar', () => {
    const resumen = calcularResumenMontos(buildContext([
      { sorteoId: 'SRT-CP-1', formaIdx: 0, formasGanadoras: ['Linea'], creditos: 25, estado: 'pendiente' },
      { sorteoId: 'SRT-CP-1', formaIdx: 0, formasGanadoras: ['Linea'], creditos: 15, estado: 'APROBADO' },
      { sorteoId: 'SRT-CP-1', formaIdx: 1, formasGanadoras: ['Linea', 'Bingo'], creditos: 5, estado: 'aceptado' },
      { sorteoId: 'SRT-CP-1', formaIdx: 1, formasGanadoras: ['Linea', 'Bingo'], creditos: 10, estado: 'archivado' }
    ]));

    expect(resumen.montoAcreditado).toBe(20);
    expect(resumen.montoPorAcreditar).toBe(35);
  });
});
