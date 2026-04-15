const fs = require('fs');
const vm = require('vm');

function cargarAdapters(){
  const codigo = fs.readFileSync('public/js/sorteoDataAdapters.js', 'utf8');
  const contexto = { window: {} };
  vm.createContext(contexto);
  vm.runInContext(codigo, contexto);
  return contexto.window.SorteoDataAdapters;
}

describe('SorteoDataAdapters.obtenerLoteriasAsignadas', () => {
  test('retorna IDs válidos desde loteriasAsignadas con normalización y trim', () => {
    const { obtenerLoteriasAsignadas } = cargarAdapters();
    const ids = obtenerLoteriasAsignadas({
      loteriasAsignadas: ['  zulia  ', '', 'caracas', '   ', null, undefined, 25, { id: 'x' }]
    });

    expect(ids).toEqual(['zulia', 'caracas']);
  });

  test('ignora loterias legacy cuando no existe loteriasAsignadas', () => {
    const { obtenerLoteriasAsignadas } = cargarAdapters();
    const ids = obtenerLoteriasAsignadas({
      loterias: ['legacy-a', 'legacy-b'],
      loteriasActivas: ['legacy-c']
    });

    expect(ids).toEqual([]);
  });
});

describe('SorteoDataAdapters.resolverLoteriasAsignadas', () => {
  test('descarta IDs inexistentes al resolver docs de loterías', async () => {
    const { resolverLoteriasAsignadas } = cargarAdapters();
    const docsPorId = {
      zulia: { exists: true, id: 'zulia', data: () => ({ nombre: 'Zulia' }) },
      caracas: { exists: true, id: 'caracas', data: () => ({ nombre: 'Caracas' }) },
      inexistente: { exists: false, id: 'inexistente', data: () => ({}) }
    };
    const db = {
      collection: (nombre) => ({
        doc: (id) => ({
          get: async () => {
            if(nombre !== 'loterias') throw new Error('Colección inválida');
            return docsPorId[id] || { exists: false, id, data: () => ({}) };
          }
        })
      })
    };

    const docs = await resolverLoteriasAsignadas(db, [' zulia ', 'inexistente', 123, { bad: true }, 'caracas']);

    expect(docs.map((doc) => doc.id)).toEqual(['zulia', 'caracas']);
  });
});
