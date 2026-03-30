(function(global){
  const BINGO_LETRAS = ['B', 'I', 'N', 'G', 'O'];

  function construirClaveResultado(loteriaId, fila){
    return `${String(loteriaId || '').trim()}|${Math.max(0, Number(fila) || 0)}`;
  }

  function descomponerClaveResultado(clave){
    const texto = (clave ?? '').toString().trim();
    if(!texto.includes('|')) return null;
    const [loteriaIdRaw, filaRaw] = texto.split('|');
    const loteriaId = String(loteriaIdRaw || '').trim();
    const fila = Number.parseInt(String(filaRaw || '').trim(), 10);
    if(!loteriaId || !Number.isInteger(fila) || fila < 0 || fila > 14) return null;
    return { loteriaId, fila };
  }

  function obtenerFilaDesdeClaveLegacy(claveLegacy){
    const match = /^([BINGO])-(\d{1,2})$/i.exec((claveLegacy || '').trim());
    if(!match) return null;
    const letra = match[1].toUpperCase();
    const numero = Number.parseInt(match[2], 10);
    if(!Number.isInteger(numero)) return null;
    const idxColumna = BINGO_LETRAS.indexOf(letra);
    if(idxColumna < 1 || idxColumna > 4) return null;
    const base = idxColumna * 15 + 1;
    const fila = numero - base;
    if(fila < 0 || fila > 14) return null;
    return { idxColumna, fila };
  }

  function resolverClaveResultadoCompatible(claveOriginal, opciones = {}){
    const clave = (claveOriginal ?? '').toString().trim();
    if(!clave) return '';
    if(clave.includes('|')){
      return clave;
    }
    const legacy = obtenerFilaDesdeClaveLegacy(clave);
    if(!legacy) return '';
    const resolverLoteria = typeof opciones.obtenerLoteriaIdPorColumna === 'function'
      ? opciones.obtenerLoteriaIdPorColumna
      : null;
    if(!resolverLoteria) return '';
    const loteriaId = String(resolverLoteria(legacy.idxColumna) || '').trim();
    if(!loteriaId) return '';
    return construirClaveResultado(loteriaId, legacy.fila);
  }

  global.CantosResultadosClave = {
    construirClaveResultado,
    descomponerClaveResultado,
    obtenerFilaDesdeClaveLegacy,
    resolverClaveResultadoCompatible
  };
})(window);
