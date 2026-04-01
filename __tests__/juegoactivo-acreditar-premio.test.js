const fs = require('fs');
const vm = require('vm');
const { JSDOM } = require('jsdom');

function extraerFuncion(html, nombre) {
  const firmaAsync = `async function ${nombre}`;
  const firmaSync = `function ${nombre}`;
  let inicio = html.indexOf(firmaAsync);
  if (inicio < 0) {
    inicio = html.indexOf(firmaSync);
  }
  if (inicio < 0) {
    throw new Error(`No se encontró la función ${nombre}`);
  }
  let indice = html.indexOf('{', inicio);
  let nivel = 0;
  let fin = -1;
  while (indice < html.length) {
    const ch = html[indice];
    if (ch === '{') nivel += 1;
    if (ch === '}') {
      nivel -= 1;
      if (nivel === 0) {
        fin = indice;
        break;
      }
    }
    indice += 1;
  }
  if (fin < 0) {
    throw new Error(`No se pudo cerrar la función ${nombre}`);
  }
  return html.slice(inicio, fin + 1);
}

describe('juegoactivo.html - acreditarPremioAhora cuando no hay premio pendiente', () => {
  test('no remueve la línea visual ni cierra modal, muestra mensaje y permite reintento', async () => {
    const html = fs.readFileSync('public/juegoactivo.html', 'utf8');
    const fnAcreditar = extraerFuncion(html, 'acreditarPremioAhora');

    const dom = new JSDOM('<div id="root"><div class="celebracion-linea"><button class="boton-acreditar-ahora">Acreditar Ahora</button></div></div>');
    const button = dom.window.document.querySelector('button');
    const linea = dom.window.document.querySelector('.celebracion-linea');

    const alertMock = jest.fn();
    const warnMock = jest.fn();
    const cerrarModalCelebracionSiSinPendientes = jest.fn();

    const context = {
      activeSorteoId: 'SRT-1',
      acreditandoPremioAhora: false,
      db: {
        collection: () => ({
          doc: () => ({
            collection: () => ({ doc: () => ({ __tipo: 'premioRef' }) }),
            __tipo: 'billeteraRef'
          })
        }),
        runTransaction: async (cb) => {
          const tx = {
            get: async (ref) => {
              if (ref && ref.__tipo === 'premioRef') {
                return { exists: false, data: () => ({}) };
              }
              return {
                exists: true,
                data: () => ({ creditos: 15, CartonesGratis: 2 })
              };
            },
            set: jest.fn()
          };
          return cb(tx);
        }
      },
      usuarioActual: { email: 'jugador@test.com' },
      cerrarModalCelebracionSiSinPendientes,
      alert: alertMock,
      console: { warn: warnMock },
      firebase: { firestore: { FieldValue: { serverTimestamp: () => 'TS' } } }
    };

    vm.createContext(context);
    vm.runInContext(fnAcreditar, context);

    await context.acreditarPremioAhora({
      clavePendiente: 'clave-inexistente',
      sorteoId: 'SRT-1',
      idx: 1,
      cartonLabel: 'Cartón 001'
    }, button);

    expect(dom.window.document.body.contains(linea)).toBe(true);
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe('Acreditar Ahora');
    expect(cerrarModalCelebracionSiSinPendientes).not.toHaveBeenCalled();
    expect(alertMock).toHaveBeenCalledWith('No se encontró el premio pendiente para acreditar. Recarga e intenta de nuevo.');
    expect(warnMock).toHaveBeenCalledWith(
      'Premio pendiente no encontrado para acreditar',
      expect.objectContaining({
        billeteraId: 'jugador@test.com',
        premioId: 'clave-inexistente',
        sorteoId: 'SRT-1',
        idx: 1,
        cartonLabel: 'Cartón 001'
      })
    );
  });
});
