(function(global){
  function obtenerLoteriasAsignadas(sorteo){
    const origen = Array.isArray(sorteo?.loteriasAsignadas) ? sorteo.loteriasAsignadas : [];
    return origen
      .map(id=>typeof id === 'string' ? id.trim() : '')
      .filter(Boolean);
  }

  async function resolverLoteriasAsignadas(db, ids){
    if(!db || typeof db.collection !== 'function') return [];
    const idsNormalizados = obtenerLoteriasAsignadas({ loteriasAsignadas: ids });
    if(!idsNormalizados.length) return [];

    const docs = await Promise.all(
      idsNormalizados.map((id)=>db.collection('loterias').doc(id).get().catch(()=>null))
    );
    return docs.filter(doc=>doc && doc.exists);
  }

  function normalizarClaveResultado(celdaKey, opciones = {}){
    const clave = (celdaKey ?? '').toString().trim();
    if(!clave) return '';
    if(clave.includes('|')) return clave;
    const resolver = global.CantosResultadosClave?.resolverClaveResultadoCompatible;
    if(typeof resolver === 'function'){
      return resolver(clave, opciones) || '';
    }
    return clave;
  }

  function normalizarMiniaturaLoteria(dataLoteria){
    const valor = typeof dataLoteria === 'object' && dataLoteria !== null
      ? (dataLoteria.imagenMiniatura || dataLoteria.imagen || dataLoteria.logo || '')
      : dataLoteria;
    const texto = (valor ?? '').toString().trim();
    if(!texto) return '';
    if(/^https?:\/\//i.test(texto) || /^data:/i.test(texto) || texto.startsWith('img/')) return texto;
    if(texto.startsWith('//')) return `https:${texto}`;
    return `img/loterias/${texto.replace(/^\/+/, '')}`;
  }

  function formatearNumeroAnimalVisual(numero){
    const texto = (numero ?? '').toString().trim();
    if(texto === '00') return '00';
    if(texto === '0') return '0';
    const sinCerosIzquierda = texto.replace(/^0+/, '');
    return sinCerosIzquierda || '0';
  }

  global.SorteoDataAdapters = {
    obtenerLoteriasAsignadas,
    resolverLoteriasAsignadas,
    normalizarClaveResultado,
    normalizarMiniaturaLoteria,
    formatearNumeroAnimalVisual
  };
})(window);
