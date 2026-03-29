(function(global){
  const PATRON_LEGACY = /^([BINGO])[-\s]?0*(\d{1,2})$/i;

  function normalizarNumeroCanonico(valor){
    if(valor === null || valor === undefined) return null;
    if(typeof valor === 'number'){
      if(!Number.isFinite(valor)) return null;
      const entero = Math.trunc(valor);
      if(entero < 0 || entero > 99) return null;
      if(entero === 0){
        return Object.is(valor, -0) ? '0' : '0';
      }
      return String(entero);
    }
    const texto = String(valor).trim();
    if(!texto) return null;
    if(texto === '00') return '00';
    if(texto === '0') return '0';

    const legacy = texto.match(PATRON_LEGACY);
    if(legacy){
      const bruto = legacy[2] || '';
      if(bruto === '00') return '00';
      const numeroLegacy = parseInt(bruto, 10);
      if(!Number.isFinite(numeroLegacy)) return null;
      return numeroLegacy === 0 ? '0' : String(numeroLegacy);
    }

    if(/^\d+$/.test(texto)){
      const numero = parseInt(texto, 10);
      if(!Number.isFinite(numero)) return null;
      if(numero === 0){
        return texto === '00' ? '00' : '0';
      }
      return String(numero);
    }
    return null;
  }

  function ordenarNumerosCanonicos(lista){
    return (Array.isArray(lista) ? lista : [])
      .filter(Boolean)
      .slice()
      .sort((a,b)=>{
        if(a === b) return 0;
        if(a === '00') return -1;
        if(b === '00') return 1;
        const na = Number(a);
        const nb = Number(b);
        if(Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
        return String(a).localeCompare(String(b));
      });
  }

  global.CantosCanonicos = Object.freeze({
    /**
     * Contrato canónico de almacenamiento de cantos/resultados:
     * - `numeros`: arreglo de strings canónicos: '00', '0', '1'..'36'.
     * - `detalles[].numero`: string canónico con la misma regla.
     * - `resultadosPorCelda[clave].exacta/intermedia`: string canónico.
     * Compatibilidad temporal:
     * - Se aceptan entradas legacy como `B-14`, `I14`, enteros y strings numéricos.
     */
    normalizarNumeroCanonico,
    ordenarNumerosCanonicos
  });
})(window);
