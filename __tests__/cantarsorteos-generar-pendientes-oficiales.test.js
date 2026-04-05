const fs = require('fs');
const path = require('path');
const vm = require('vm');

function extraerBloqueEntre(source, inicioPattern, finPattern) {
  const inicio = source.indexOf(inicioPattern);
  if (inicio < 0) throw new Error(`No se encontró inicio: ${inicioPattern}`);
  const fin = source.indexOf(finPattern, inicio);
  if (fin < 0) throw new Error(`No se encontró fin: ${finPattern}`);
  return source.slice(inicio, fin);
}

describe('cantarsorteos generarPremiosPendientesDirectosOficiales', () => {
  const htmlPath = path.join(__dirname, '..', 'public', 'cantarsorteos.html');
  const html = fs.readFileSync(htmlPath, 'utf8');
  const fnResumen = extraerBloqueEntre(
    html,
    'function extraerResumenPremiosDirectosOficiales(data = {}){',
    'async function generarPremiosPendientesDirectosOficiales(sorteoId){'
  );
  const fnGenerar = extraerBloqueEntre(
    html,
    'async function generarPremiosPendientesDirectosOficiales(sorteoId){',
    'async function finalizarSorteo(){'
  );

  function crearContexto({ fetchImpl }) {
    const context = {
      auth: {
        currentUser: {
          getIdToken: jest.fn().mockResolvedValue('token-de-prueba')
        }
      },
      validarPermisoFinalizarSorteo: jest.fn().mockResolvedValue({ permitido: true }),
      resolverApiAdminBaseCantarsorteos: jest.fn(() => 'https://api.test'),
      registrarTelemetriaOperacion: jest.fn(),
      fetch: fetchImpl,
      console
    };

    vm.createContext(context);
    vm.runInContext(`${fnResumen}\n${fnGenerar}\nthis.generarPremiosPendientesDirectosOficiales = generarPremiosPendientesDirectosOficiales;`, context);
    return context;
  }

  test('invoca POST al endpoint oficial al generar pendientes desde finalización', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ creados: 1, duplicados: 0, evaluados: 1 })
    });
    const ctx = crearContexto({ fetchImpl: fetchMock });

    const result = await ctx.generarPremiosPendientesDirectosOficiales('SRT-FINAL-1');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.test/admin/generar-premios-pendientes-directos-oficiales',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          Authorization: 'Bearer token-de-prueba'
        }),
        body: JSON.stringify({ sorteoId: 'SRT-FINAL-1' })
      })
    );
    expect(result.ok).toBe(true);
    expect(result.idempotente).toBe(false);
    expect(result.resumen).toEqual({ creados: 1, duplicados: 0, evaluados: 1 });
  });

  test('trata respuesta 409 como idempotente sin fallar', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ creados: 0, duplicados: 1, evaluados: 1 })
    });
    const ctx = crearContexto({ fetchImpl: fetchMock });

    const result = await ctx.generarPremiosPendientesDirectosOficiales('SRT-FINAL-1');

    expect(result.ok).toBe(true);
    expect(result.idempotente).toBe(true);
    expect(result.statusCode).toBe(409);
    expect(result.resumen).toEqual({ creados: 0, duplicados: 1, evaluados: 1 });
  });
});
