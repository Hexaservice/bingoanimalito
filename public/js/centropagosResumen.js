(function initCentroPagosResumen(root, factory){
  if(typeof module === 'object' && module.exports){
    module.exports = factory();
    return;
  }
  root.CentroPagosResumen = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function crearCentroPagosResumen(){
  function resolverNombreForma(registro = {}){
    const idx = Number(registro.formaIdx);
    const formas = Array.isArray(registro.formasGanadoras) ? registro.formasGanadoras : [];
    const porIndice = Number.isInteger(idx) && idx >= 0 && idx < formas.length ? formas[idx] : null;
    const etiquetaObjeto = (porIndice && typeof porIndice === 'object')
      ? (porIndice.nombre || porIndice.label || porIndice.titulo || porIndice.forma || '')
      : porIndice;
    const etiqueta = (etiquetaObjeto || '').toString().trim();
    if(etiqueta && etiqueta !== '[object Object]') return etiqueta;
    const nombreDirecto = (registro.nombreForma || registro.nombre || registro.formaNombre || '').toString().trim();
    if(nombreDirecto && nombreDirecto !== '[object Object]') return nombreDirecto;
    if(Number.isInteger(idx) && idx >= 0) return `Forma ${idx + 1}`;
    return 'Forma sin índice';
  }

  function calcularResumenMontos({
    premiosActivos = [],
    sorteoId = '',
    normalizarEstado,
    estaFinalizado,
    resolverNombre = resolverNombreForma
  } = {}){
    const idObjetivo = (sorteoId || '').toString().trim();
    if(!idObjetivo){
      return {
        totalPremiosRepartir: 0,
        montoAcreditado: 0,
        montoPorAcreditar: 0,
        porForma: []
      };
    }

    const acumuladoPorForma = new Map();
    let totalPremiosRepartir = 0;
    let montoAcreditado = 0;

    const normalizar = typeof normalizarEstado === 'function'
      ? normalizarEstado
      : (valor=>(valor || '').toString().trim().toUpperCase());
    const finalizado = typeof estaFinalizado === 'function'
      ? estaFinalizado
      : (estado=>estado === 'APROBADO' || estado === 'ACEPTADO');

    const premiosSorteo = premiosActivos.filter(item=>(item?.sorteoId || '').trim() === idObjetivo);
    premiosSorteo.forEach(registro=>{
      const creditos = Number(registro?.creditos) || 0;
      const estadoNormalizado = normalizar(registro?.estado);
      const acreditado = finalizado(estadoNormalizado) ? creditos : 0;
      totalPremiosRepartir += creditos;
      montoAcreditado += acreditado;

      const nombreForma = resolverNombre(registro);
      const claveForma = Number.isInteger(registro?.formaIdx) ? `idx:${registro.formaIdx}` : `sin_idx:${nombreForma}`;
      if(!acumuladoPorForma.has(claveForma)){
        acumuladoPorForma.set(claveForma, {
          formaIdx: Number.isInteger(registro?.formaIdx) ? registro.formaIdx : Number.MAX_SAFE_INTEGER,
          nombreForma,
          totalForma: 0,
          acreditadoForma: 0
        });
      }

      const itemForma = acumuladoPorForma.get(claveForma);
      itemForma.totalForma += creditos;
      itemForma.acreditadoForma += acreditado;
    });

    const montoPorAcreditar = Math.max(totalPremiosRepartir - montoAcreditado, 0);
    const porForma = Array.from(acumuladoPorForma.values())
      .map(item=>({
        ...item,
        porAcreditarForma: Math.max(item.totalForma - item.acreditadoForma, 0)
      }))
      .sort((a,b)=>a.formaIdx - b.formaIdx || a.nombreForma.localeCompare(b.nombreForma, 'es', { sensitivity: 'base' }));

    return {
      totalPremiosRepartir,
      montoAcreditado,
      montoPorAcreditar,
      porForma
    };
  }

  return Object.freeze({
    resolverNombreForma,
    calcularResumenMontos
  });
});
