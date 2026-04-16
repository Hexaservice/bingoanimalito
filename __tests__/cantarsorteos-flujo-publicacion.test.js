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

describe('cantarsorteos flujo de publicación', () => {
  const htmlPath = path.join(__dirname, '..', 'public', 'cantarsorteos.html');
  const html = fs.readFileSync(htmlPath, 'utf8');

  test('reemplaza botón finalizar por botón de publicación de resultados', () => {
    expect(html).toContain('id="pdf-resultados-btn"');
    expect(html).toContain('Publicar PDF resultados');
    expect(html).not.toContain('id="finalizar-btn"');
  });

  test('incluye confirmaciones explícitas antes de publicar PDFs', () => {
    expect(html).toContain('¿Confirmas publicar PDF/cartones jugando para jugadores?');
    expect(html).toContain('¿Confirmas publicar PDF resultados y habilitar Cartones ganadores?');
  });

  test('resolverFlagsFlujo considera flags legacy y canónicos de resultados', () => {
    const fnFlags = extraerBloqueEntre(
      html,
      'function normalizarFlagSiNo(valor){',
      'function actualizarUI(){'
    );

    const context = {};
    vm.createContext(context);
    vm.runInContext(`${fnFlags}\nthis.resolverFlagsFlujo = resolverFlagsFlujo;`, context);

    const result = context.resolverFlagsFlujo({
      estado: 'Finalizado',
      resultadoPublicadoJugadores: 'si',
      pdfresul: 'no',
      cartonesGanadoresPublicados: 'no'
    });

    expect(result.publicadoResultados).toBe(true);
    expect(result.publicadoJugadores).toBe(false);
  });

  test('publicarPdfResultados persiste flags para juegoactivo', async () => {
    const fnBloque = extraerBloqueEntre(
      html,
      'async function publicarPdfResultados(){',
      'async function cargarSorteo(){'
    );

    const calls = [];
    const context = {
      state: { sorteoId: 'SRT-1' },
      confirmarAccion: jest.fn().mockResolvedValue(true),
      log: jest.fn(),
      db: {
        collection: jest.fn((name) => ({
          doc: jest.fn((id) => ({
            set: jest.fn(async (payload) => {
              calls.push({ name, id, payload });
            })
          }))
        }))
      },
      firebase: { firestore: { FieldValue: { serverTimestamp: () => 'ts' } } },
      Promise
    };

    vm.createContext(context);
    vm.runInContext(`${fnBloque}\nthis.publicarPdfResultados = publicarPdfResultados;`, context);

    await context.publicarPdfResultados();

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.payload.pdfresul).toBe('si');
      expect(call.payload.resultadoPublicadoJugadores).toBe('si');
      expect(call.payload.cartonesGanadoresPublicados).toBe('si');
    }
  });
});
