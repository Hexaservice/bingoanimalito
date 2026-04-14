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
  test('no remueve la línea visual ni cierra modal, muestra mensaje y permite reintento solo si backend responde PREMIO_NO_EXISTE', async () => {
    const html = fs.readFileSync('public/juegoactivo.html', 'utf8');
    const fnAcreditar = extraerFuncion(html, 'acreditarPremioAhora');

    const dom = new JSDOM('<div id="root"><div class="celebracion-linea"><button class="boton-acreditar-ahora">Acreditar Ahora</button></div></div>');
    const button = dom.window.document.querySelector('button');
    const linea = dom.window.document.querySelector('.celebracion-linea');

    const alertMock = jest.fn();
    const warnMock = jest.fn();
    const cerrarModalCelebracionSiSinPendientes = jest.fn();

    const queryVacio = {
      where: () => queryVacio,
      limit: () => ({ get: async () => ({ empty: true, docs: [] }) })
    };
    const collectionRef = {
      doc: () => ({ __tipo: 'premioRef', get: async () => ({ exists: false }) }),
      where: () => queryVacio
    };

    const context = {
      activeSorteoId: 'SRT-1',
      acreditandoPremioAhora: false,
      premiosPendientesIdsApi: {
        construirClavesCandidatasPremioPendiente: (detalle) => [String(detalle?.clavePendiente || '').toLowerCase()].filter(Boolean)
      },
      db: {
        collection: () => ({
          doc: () => ({
            collection: () => collectionRef,
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
      auth: { currentUser: { getIdToken: jest.fn(async () => 'token-ok') } },
      usuarioActual: { email: 'jugador@test.com' },
      cerrarModalCelebracionSiSinPendientes,
      fetch: jest.fn(async () => ({
        ok: false,
        status: 404,
        json: async () => ({ code: 'PREMIO_NO_EXISTE' })
      })),
      window: {
        UPLOAD_ENDPOINT: 'https://api.demo.com/upload',
        location: { origin: 'https://app.demo.com' },
        __APP_CONFIG__: {}
      },
      alert: alertMock,
      console: { warn: warnMock },
      firebase: { firestore: { FieldValue: { serverTimestamp: () => 'TS' } } }
    };

    vm.createContext(context);
    vm.runInContext(fnAcreditar, context);

    await context.acreditarPremioAhora({
      clavePendiente: 'clave-inexistente',
      eventoGanadorId: 'SRT-1__f1__usr:jugador@test.com::num:1',
      sorteoId: 'SRT-1',
      idx: 1,
      cartonLabel: 'Cartón 001'
    }, button);

    expect(dom.window.document.body.contains(linea)).toBe(true);
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe('Acreditar Ahora');
    expect(cerrarModalCelebracionSiSinPendientes).not.toHaveBeenCalled();
    expect(alertMock).toHaveBeenCalledWith('No se encontró el premio pendiente para acreditar. Recarga e intenta de nuevo.');
    expect(context.fetch).toHaveBeenCalledWith(
      'https://api.demo.com/acreditarPremioEvento',
      expect.objectContaining({ method: 'POST' })
    );
    expect(warnMock).toHaveBeenCalledWith(
      'Premio pendiente no encontrado para acreditar',
      expect.objectContaining({
        billeteraId: 'jugador@test.com',
        premioId: '',
        sorteoId: 'SRT-1',
        idx: 1,
        cartonLabel: 'Cartón 001'
      })
    );
  });
});

describe('juegoactivo.html - acreditarPremioAhora sin premio local pero acreditado por backend', () => {
  test('acredita usando eventoGanadorId aunque no exista premioRef local', async () => {
    const html = fs.readFileSync('public/juegoactivo.html', 'utf8');
    const fnAcreditar = extraerFuncion(html, 'acreditarPremioAhora');

    const dom = new JSDOM('<div id="root"><div class="celebracion-linea"><button class="boton-acreditar-ahora">Acreditar Ahora</button></div></div>');
    const button = dom.window.document.querySelector('button');
    const linea = dom.window.document.querySelector('.celebracion-linea');

    const queryVacio = {
      where: () => queryVacio,
      limit: () => ({ get: async () => ({ empty: true, docs: [] }) })
    };
    const collectionRef = {
      doc: () => ({ get: async () => ({ exists: false }) }),
      where: () => queryVacio
    };

    const context = {
      activeSorteoId: 'SRT-1',
      acreditandoPremioAhora: false,
      premiosPendientesIdsApi: {
        construirClavesCandidatasPremioPendiente: () => ['clave-inexistente']
      },
      db: {
        collection: () => ({
          doc: () => ({
            collection: () => collectionRef
          })
        })
      },
      auth: { currentUser: { getIdToken: jest.fn(async () => 'token-ok') } },
      usuarioActual: { email: 'jugador@test.com' },
      cerrarModalCelebracionSiSinPendientes: jest.fn(),
      fetch: jest.fn(async () => ({
        ok: true,
        json: async () => ({ resultado: 'acreditado' })
      })),
      window: {
        UPLOAD_ENDPOINT: 'https://api.demo.com/upload',
        location: { origin: 'https://app.demo.com' },
        __APP_CONFIG__: {}
      },
      alert: jest.fn(),
      console: { warn: jest.fn() },
      firebase: { firestore: { FieldValue: { serverTimestamp: () => 'TS' } } }
    };

    vm.createContext(context);
    vm.runInContext(fnAcreditar, context);

    await context.acreditarPremioAhora({
      clavePendiente: 'clave-inexistente',
      eventoGanadorId: 'SRT-1__f3__usr:jugador@test.com::num:9',
      sorteoId: 'SRT-1',
      idx: 3,
      cartonClaveGanador: 'usr:jugador@test.com::num:9',
      cartonLabel: 'Cartón 0009'
    }, button);

    expect(dom.window.document.body.contains(linea)).toBe(false);
    expect(context.cerrarModalCelebracionSiSinPendientes).toHaveBeenCalled();
    expect(context.alert).not.toHaveBeenCalled();
    expect(context.fetch).toHaveBeenCalledWith(
      'https://api.demo.com/acreditarPremioEvento',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"premioId":"clave-inexistente"')
      })
    );
    const requestBody = JSON.parse(context.fetch.mock.calls[0][1].body);
    expect(requestBody.eventoGanadorId).toBe('SRT-1__f3__usr:jugador@test.com::num:9');
    expect(requestBody.billeteraId).toBe('jugador@test.com');
  });
});

describe('juegoactivo.html - registrarPremiosPendientes deshabilitado en cliente', () => {
  test('no crea premios pendientes directos', async () => {
    const html = fs.readFileSync('public/juegoactivo.html', 'utf8');
    const fnRegistrar = extraerFuncion(html, 'registrarPremiosPendientes');

    const setMock = jest.fn();
    const commitMock = jest.fn();

    const context = {
      db: {
        batch: () => ({ set: setMock, commit: commitMock })
      }
    };

    vm.createContext(context);
    vm.runInContext(fnRegistrar, context);

    await context.registrarPremiosPendientes([{ idx: 1, nombre: 'Forma 1' }]);

    expect(setMock).not.toHaveBeenCalled();
    expect(commitMock).not.toHaveBeenCalled();
  });
});

describe('juegoactivo.html - acreditarPremioAhora cuando premio ya está acreditado', () => {
  test('remueve el botón de acreditación sin mostrar alerta de premio pendiente', async () => {
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
      premiosPendientesIdsApi: {
        construirClavesCandidatasPremioPendiente: (detalle) => [String(detalle?.clavePendiente || '').toLowerCase()].filter(Boolean)
      },
      db: {
        collection: () => ({
          doc: () => ({
            collection: () => ({ doc: () => ({ __tipo: 'premioRef', id: 'ppd_hash', get: async () => ({ exists: true }) }) })
          })
        })
      },
      auth: { currentUser: { getIdToken: jest.fn(async () => 'token-ok') } },
      usuarioActual: { email: 'jugador@test.com' },
      cerrarModalCelebracionSiSinPendientes,
      document: dom.window.document,
      fetch: jest.fn(async () => ({
        ok: true,
        json: async () => ({ resultado: 'ya_acreditado' })
      })),
      window: {
        UPLOAD_ENDPOINT: 'https://api.demo.com/upload',
        location: { origin: 'https://app.demo.com' },
        __APP_CONFIG__: {}
      },
      alert: alertMock,
      console: { warn: warnMock },
      firebase: { firestore: { FieldValue: { serverTimestamp: () => 'TS' } } }
    };

    vm.createContext(context);
    vm.runInContext(fnAcreditar, context);

    await context.acreditarPremioAhora({
      clavePendiente: 'clave-acreditada',
      eventoGanadorId: 'SRT-1__f5__usr:jugador@test.com::num:3',
      sorteoId: 'SRT-1',
      idx: 5,
      cartonLabel: 'Cartón 003'
    }, button);

    expect(dom.window.document.body.contains(linea)).toBe(true);
    const botonAcreditar = dom.window.document.querySelector('.boton-acreditar-ahora');
    expect(botonAcreditar).toBeNull();
    const botonCerrar = dom.window.document.querySelector('.boton-cerrar-forma');
    expect(botonCerrar).toBeNull();
    expect(cerrarModalCelebracionSiSinPendientes).not.toHaveBeenCalled();
    expect(alertMock).not.toHaveBeenCalled();
    expect(warnMock).not.toHaveBeenCalled();
  });
});

describe('juegoactivo.html - acreditarPremioAhora con contrato por eventoGanadorId', () => {
  test('acredita enviando eventoGanadorId sin búsquedas legacy en cliente', async () => {
    const html = fs.readFileSync('public/juegoactivo.html', 'utf8');
    const fnAcreditar = extraerFuncion(html, 'acreditarPremioAhora');

    const dom = new JSDOM('<div id="root"><div class="celebracion-linea"><button class="boton-acreditar-ahora">Acreditar Ahora</button></div></div>');
    const button = dom.window.document.querySelector('button');

    const context = {
      activeSorteoId: 'SRT-1',
      acreditandoPremioAhora: false,
      premiosPendientesIdsApi: {},
      db: {},
      auth: { currentUser: { getIdToken: jest.fn(async () => 'token-ok') } },
      usuarioActual: { email: 'Jugador@Test.com' },
      cerrarModalCelebracionSiSinPendientes: jest.fn(),
      fetch: jest.fn(async () => ({
        ok: true,
        json: async () => ({ resultado: 'acreditado' })
      })),
      window: {
        UPLOAD_ENDPOINT: 'https://api.demo.com/upload',
        location: { origin: 'https://app.demo.com' },
        __APP_CONFIG__: {}
      },
      alert: jest.fn(),
      console: { warn: jest.fn() },
      firebase: { firestore: { FieldValue: { serverTimestamp: () => 'TS' } } }
    };

    vm.createContext(context);
    vm.runInContext(fnAcreditar, context);

    await context.acreditarPremioAhora({
      clavePendiente: 'clave-vieja-inexistente',
      eventoGanadorId: 'SRT-1__f2__usr:jugador@test.com::num:7',
      sorteoId: 'SRT-1',
      idx: 2,
      cartonClaveGanador: 'usr:jugador@test.com::num:7',
      cartonLabel: 'Cartón 0007'
    }, button);

    expect(context.alert).not.toHaveBeenCalled();
    expect(context.cerrarModalCelebracionSiSinPendientes).toHaveBeenCalled();
    expect(context.fetch).toHaveBeenCalledWith(
      'https://api.demo.com/acreditarPremioEvento',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer token-ok'
        })
      })
    );
    const requestBody = JSON.parse(context.fetch.mock.calls[0][1].body);
    expect(requestBody).toEqual(expect.objectContaining({
      premioId: 'clave-vieja-inexistente',
      eventoGanadorId: 'SRT-1__f2__usr:jugador@test.com::num:7',
      billeteraId: 'jugador@test.com'
    }));
  });
});
