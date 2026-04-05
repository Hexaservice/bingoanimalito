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

describe('juegoactivo.html - registrarPremiosPendientes idempotente', () => {
  test('no vuelve a crear ni sobreescribe premios que ya existen', async () => {
    const html = fs.readFileSync('public/juegoactivo.html', 'utf8');
    const fnRegistrar = extraerFuncion(html, 'registrarPremiosPendientes');

    const premioRefExistente = { id: 'srt-1::1::cartón 1' };
    const premioRefNuevo = { id: 'srt-1::2::cartón 2' };
    const docMap = new Map([
      [premioRefExistente, { exists: true }],
      [premioRefNuevo, { exists: false }]
    ]);

    const setMock = jest.fn();
    const commitMock = jest.fn(async () => {});
    const batchMock = {
      set: setMock,
      commit: commitMock
    };

    const context = {
      activeSorteoId: 'SRT-1',
      locksGanadoresListos: true,
      precargarLocksGanadoresRemotos: jest.fn(async () => new Map()),
      construirClavePremioPendiente: (detalle) => `${(detalle?.sorteoId || 'SRT-1').toLowerCase()}::${Number(detalle?.idx) || 0}::${(detalle?.cartonLabel || '').toString().trim().toLowerCase()}`,
      ganadoresBloqueadosPorForma: new Map([
        [1, { paso: 0, cartonClaves: ['usr:default::num:1'] }],
        [2, { paso: 0, cartonClaves: ['usr:default::num:2'] }]
      ]),
      cierresPremiosPorForma: new Map(),
      db: {
        collection: () => ({
          doc: () => ({
            collection: () => ({
              doc: (id) => {
                if (id.includes('::1::')) return premioRefExistente;
                return premioRefNuevo;
              }
            })
          })
        }),
        batch: () => batchMock
      },
      usuarioActual: { email: 'jugador@test.com' },
      firebase: { firestore: { FieldValue: { serverTimestamp: () => 'TS' } } }
    };

    premioRefExistente.get = jest.fn(async () => docMap.get(premioRefExistente));
    premioRefNuevo.get = jest.fn(async () => docMap.get(premioRefNuevo));

    vm.createContext(context);
    vm.runInContext(fnRegistrar, context);

    await context.registrarPremiosPendientes([
      { idx: 1, nombre: 'Forma 1', creditos: 100, cartonLabel: 'Cartón 1', cartonClaveGanador: 'usr:default::num:1', sorteoId: 'SRT-1' },
      { idx: 2, nombre: 'Forma 2', creditos: 200, cartonLabel: 'Cartón 2', cartonClaveGanador: 'usr:default::num:2', sorteoId: 'SRT-1' }
    ]);

    expect(premioRefExistente.get).toHaveBeenCalled();
    expect(premioRefNuevo.get).toHaveBeenCalled();
    expect(setMock).toHaveBeenCalledTimes(1);
    expect(setMock).toHaveBeenCalledWith(
      premioRefNuevo,
      expect.objectContaining({
        premioId: 'srt-1::2::cartón 2',
        estado: 'pendiente'
      })
    );
    expect(commitMock).toHaveBeenCalledTimes(1);
  });
});

describe('juegoactivo.html - acreditarPremioAhora cuando premio ya está acreditado', () => {
  test('reemplaza el botón por Cerrar sin mostrar alerta de premio pendiente', async () => {
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
                return { exists: true, data: () => ({ estado: 'acreditado' }) };
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
      document: dom.window.document,
      alert: alertMock,
      console: { warn: warnMock },
      firebase: { firestore: { FieldValue: { serverTimestamp: () => 'TS' } } }
    };

    vm.createContext(context);
    vm.runInContext(fnAcreditar, context);

    await context.acreditarPremioAhora({
      clavePendiente: 'clave-acreditada',
      sorteoId: 'SRT-1',
      idx: 5,
      cartonLabel: 'Cartón 003'
    }, button);

    expect(dom.window.document.body.contains(linea)).toBe(true);
    const botonCerrar = dom.window.document.querySelector('.boton-cerrar-forma');
    expect(botonCerrar).not.toBeNull();
    expect(botonCerrar.textContent).toBe('Cerrar');
    expect(cerrarModalCelebracionSiSinPendientes).not.toHaveBeenCalled();
    expect(alertMock).not.toHaveBeenCalled();
    expect(warnMock).not.toHaveBeenCalled();
  });
});

describe('juegoactivo.html - registrarPremiosPendientes evita premios tardíos al cambiar lock de forma', () => {
  test('si la forma ya fue cerrada con otro set, no crea nuevos premiosPendientesDirectos', async () => {
    const html = fs.readFileSync('public/juegoactivo.html', 'utf8');
    const fnRegistrar = extraerFuncion(html, 'registrarPremiosPendientes');

    const docs = new Map();
    const setMock = jest.fn((ref, data) => {
      docs.set(ref.id, { exists: true, data });
    });
    const commitMock = jest.fn(async () => {});
    const batchMock = { set: setMock, commit: commitMock };

    const billeteraCollection = {
      doc: (id) => ({
        id,
        get: jest.fn(async () => docs.get(id) || { exists: false }),
      })
    };
    const billeteraRef = {
      collection: () => billeteraCollection
    };

    const context = {
      activeSorteoId: 'SRT-LOCK',
      locksGanadoresListos: true,
      precargarLocksGanadoresRemotos: jest.fn(async () => new Map()),
      usuarioActual: { email: 'jugador@test.com' },
      construirClavePremioPendiente: (detalle) => `${(detalle?.sorteoId || 'SRT-LOCK').toLowerCase()}::${Number(detalle?.idx) || 0}::${(detalle?.cartonLabel || '').toString().trim().toLowerCase()}`,
      ganadoresBloqueadosPorForma: new Map([[1, { paso: 3, cartonClaves: ['usr:ana::num:11'] }]]),
      cierresPremiosPorForma: new Map(),
      db: {
        collection: () => ({ doc: () => billeteraRef }),
        batch: () => batchMock
      },
      firebase: { firestore: { FieldValue: { serverTimestamp: () => 'TS' } } }
    };

    vm.createContext(context);
    vm.runInContext(fnRegistrar, context);

    await context.registrarPremiosPendientes([
      {
        idx: 1,
        nombre: 'Línea',
        creditos: 100,
        cartonLabel: 'Cartón 11',
        cartonClaveGanador: 'usr:ana::num:11',
        sorteoId: 'SRT-LOCK'
      }
    ]);

    expect(setMock).toHaveBeenCalledTimes(1);
    expect(commitMock).toHaveBeenCalledTimes(1);

    context.ganadoresBloqueadosPorForma = new Map([[1, { paso: 3, cartonClaves: ['usr:ana::num:11', 'usr:ana::num:22'] }]]);

    await context.registrarPremiosPendientes([
      {
        idx: 1,
        nombre: 'Línea',
        creditos: 100,
        cartonLabel: 'Cartón 22',
        cartonClaveGanador: 'usr:ana::num:22',
        sorteoId: 'SRT-LOCK'
      }
    ]);

    expect(setMock).toHaveBeenCalledTimes(1);
    expect(commitMock).toHaveBeenCalledTimes(1);
  });
});

describe('juegoactivo.html - usuario entra tarde/recarga con lock remoto de forma', () => {
  test('si la forma ya cerró, no acredita premio para cartón tardío fuera del lock', async () => {
    const html = fs.readFileSync('public/juegoactivo.html', 'utf8');
    const fnRegistrar = extraerFuncion(html, 'registrarPremiosPendientes');

    const setMock = jest.fn();
    const commitMock = jest.fn(async () => {});
    const batchMock = { set: setMock, commit: commitMock };
    const docs = new Map();
    const billeteraCollection = {
      doc: (id) => ({
        id,
        get: jest.fn(async () => docs.get(id) || { exists: false })
      })
    };
    const billeteraRef = { collection: () => billeteraCollection };
    const context = {
      activeSorteoId: 'SRT-LATE',
      locksGanadoresListos: true,
      precargarLocksGanadoresRemotos: jest.fn(async () => new Map()),
      usuarioActual: { email: 'jugador@test.com' },
      construirClavePremioPendiente: (detalle) => `${(detalle?.sorteoId || 'SRT-LATE').toLowerCase()}::${Number(detalle?.idx) || 0}::${(detalle?.cartonLabel || '').toString().trim().toLowerCase()}`,
      ganadoresBloqueadosPorForma: new Map([[1, { paso: 3, cartonClaves: ['usr:ana::num:11'] }]]),
      cierresPremiosPorForma: new Map(),
      db: {
        collection: () => ({ doc: () => billeteraRef }),
        batch: () => batchMock
      },
      firebase: { firestore: { FieldValue: { serverTimestamp: () => 'TS' } } }
    };

    vm.createContext(context);
    vm.runInContext(fnRegistrar, context);

    await context.registrarPremiosPendientes([
      {
        idx: 1,
        nombre: 'Línea',
        creditos: 100,
        cartonLabel: 'Cartón 22',
        cartonClaveGanador: 'usr:ana::num:22',
        sorteoId: 'SRT-LATE'
      }
    ]);

    expect(setMock).not.toHaveBeenCalled();
    expect(commitMock).not.toHaveBeenCalled();
  });
});
