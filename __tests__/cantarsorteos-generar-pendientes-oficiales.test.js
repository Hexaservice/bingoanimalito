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

  test('retorna modo omitido cuando el motor está deshabilitado', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ creados: 1, duplicados: 0, evaluados: 1 })
    });
    const ctx = crearContexto({ fetchImpl: fetchMock });

    const result = await ctx.generarPremiosPendientesDirectosOficiales('SRT-FINAL-1');

    expect(fetchMock).toHaveBeenCalledTimes(0);
    expect(result).toEqual(expect.objectContaining({
      ok: false,
      omitido: true,
      idempotente: true,
      statusCode: 409,
      motivo: 'premios_engine_v2_disabled'
    }));
  });

  test('mantiene respuesta idempotente sin realizar fetch', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ creados: 0, duplicados: 1, evaluados: 1 })
    });
    const ctx = crearContexto({ fetchImpl: fetchMock });

    const result = await ctx.generarPremiosPendientesDirectosOficiales('SRT-FINAL-1');

    expect(fetchMock).toHaveBeenCalledTimes(0);
    expect(result.ok).toBe(false);
    expect(result.idempotente).toBe(true);
    expect(result.statusCode).toBe(409);
    expect(result.resumen).toEqual({ creados: 0, duplicados: 0, evaluados: 0 });
  });
});
