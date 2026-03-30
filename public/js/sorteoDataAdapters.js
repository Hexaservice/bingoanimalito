(function(global){
  function obtenerLoteriasAsignadas(sorteo){
    const origen = Array.isArray(sorteo?.loteriasAsignadas)
      ? sorteo.loteriasAsignadas
      : (Array.isArray(sorteo?.loteriasActivas)
        ? sorteo.loteriasActivas
        : (Array.isArray(sorteo?.loterias) ? sorteo.loterias : []));
    return origen.map(id=>String(id || '').trim()).filter(Boolean);
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
    normalizarClaveResultado,
    normalizarMiniaturaLoteria,
    formatearNumeroAnimalVisual
  };
})(window);
