const fs = require('fs');
const vm = require('vm');
const { JSDOM } = require('jsdom');

function extraerFuncion(html, nombre) {
  const firma = `function ${nombre}`;
  const inicio = html.indexOf(firma);
  if (inicio < 0) throw new Error(`No se encontró la función ${nombre}`);
  let i = html.indexOf('{', inicio);
  let nivel = 0;
  let fin = -1;
  while (i < html.length) {
    const ch = html[i];
    if (ch === '{') nivel += 1;
    if (ch === '}') {
      nivel -= 1;
      if (nivel === 0) {
        fin = i;
        break;
      }
    }
    i += 1;
  }
  if (fin < 0) throw new Error(`No se pudo cerrar la función ${nombre}`);
  return html.slice(inicio, fin + 1);
}

describe('juegoactivo.html - cierre de formas mantiene verdes históricos', () => {
  test('nuevo resultado después del cierre no revierte clases ganadoras históricas y solo aplica flash temporal', () => {
    const html = fs.readFileSync('public/juegoactivo.html', 'utf8');
    const fnObtenerRegistro = extraerFuncion(html, 'obtenerRegistroFormaCerrada');
    const fnTodasCerradas = extraerFuncion(html, 'estanTodasLasFormasGanadorasCerradas');
    const fnFlash = extraerFuncion(html, 'aplicarFlashTemporalPostCierre');
    const fnRender = extraerFuncion(html, 'renderCantos');

    const dom = new JSDOM('<div id="ultimo"></div>');
    const doc = dom.window.document;
    const celdaHistorica = doc.createElement('div');
    const celdaNueva = doc.createElement('div');
    celdaHistorica.className = 'canto-cell ganador cantado';
    celdaNueva.className = 'canto-cell';
    celdaHistorica.dataset.tituloBase = '10';
    celdaNueva.dataset.tituloBase = '20';

    const cantoCellsMap = new Map([
      [10, celdaHistorica],
      [20, celdaNueva]
    ]);

    const context = {
      document: doc,
      setTimeout,
      clearTimeout,
      esMapaValido: (valor) => valor instanceof Map,
      ganadoresBloqueadosPorForma: new Map([[1, { cartonClaves: ['carton-1'], paso: 0 }]]),
      formasActivas: [{ idx: 1 }],
      cantoCellsMap,
      cantosOrdenados: [10, 20],
      cantosResultadoMap: new Map(),
      cantoColorMap: new Map(),
      cantosEtiquetas: [],
      ultimoCantoEl: doc.getElementById('ultimo'),
      ultimoCantoBoton: null,
      ultimoCantoValorActual: '',
      vistaConductoActiva: false,
      ultimoCantoPopupEl: null,
      crearGridCantos: () => {},
      generarEtiquetaDesdeNumero: (n) => String(n).padStart(2, '0'),
      alternarVistaConducto: () => {},
      cerrarVentanaUltimoCanto: () => {},
      aplicarEstadoVistaConducto: () => {},
      cantoPostCierreFlashTimers: new Map(),
      CANTO_POST_CIERRE_FLASH_MS: 1300
    };

    vm.createContext(context);
    vm.runInContext(`${fnObtenerRegistro}\n${fnTodasCerradas}\n${fnFlash}\n${fnRender}`, context);

    context.renderCantos();

    expect(celdaHistorica.classList.contains('ganador')).toBe(true);
    expect(celdaHistorica.classList.contains('cantado')).toBe(true);
    expect(celdaNueva.classList.contains('ganador')).toBe(false);
    expect(celdaNueva.classList.contains('cantado')).toBe(false);
    expect(celdaNueva.classList.contains('post-cierre-flash')).toBe(true);
  });
});
