(function(global){
  function toSafeInteger(value){
    const num = Number(value);
    if(!Number.isFinite(num)) return 0;
    return Math.max(0, Math.floor(num));
  }

  function distribuirMontoPorUsuarios({
    montoRol = 0,
    usuarios = [],
    rolInterno = '',
    modoMonto = 'total_por_rol',
    montoFijoPorCuenta = 0
  } = {}){
    const listaUsuarios = Array.isArray(usuarios) ? usuarios : [];
    const totalUsuariosRol = listaUsuarios.length;
    if(!totalUsuariosRol) return [];

    if(modoMonto === 'monto_fijo_por_cuenta'){
      const montoUnitario = toSafeInteger(montoFijoPorCuenta);
      return listaUsuarios.map((usuario)=>({
        usuario,
        rolInterno,
        montoAsignado: montoUnitario,
        montoRolBase: montoUnitario,
        totalUsuariosRol,
        metodoDistribucion: 'monto_fijo_por_cuenta'
      }));
    }

    const montoRolBase = toSafeInteger(montoRol);
    const montoBasePorUsuario = Math.floor(montoRolBase / totalUsuariosRol);
    const remanente = montoRolBase - (montoBasePorUsuario * totalUsuariosRol);
    return listaUsuarios.map((usuario, idx)=>({
      usuario,
      rolInterno,
      montoAsignado: montoBasePorUsuario + (idx < remanente ? 1 : 0),
      montoRolBase,
      totalUsuariosRol,
      metodoDistribucion: 'total_por_rol_floor_remanente'
    }));
  }

  function resumirDistribucionPorRol(registros = []){
    const mapa = new Map();
    (Array.isArray(registros) ? registros : []).forEach((item)=>{
      const rol = (item?.rolInterno || 'sin_rol').toString();
      if(!mapa.has(rol)){
        mapa.set(rol, {
          rolInterno: rol,
          totalUsuarios: 0,
          totalCreditos: 0,
          montoRolBase: Number(item?.montoRolBase || 0) || 0,
          metodoDistribucion: item?.metodoDistribucion || ''
        });
      }
      const registro = mapa.get(rol);
      registro.totalUsuarios += 1;
      registro.totalCreditos += Number(item?.creditos || 0) || 0;
      if(!registro.metodoDistribucion && item?.metodoDistribucion){
        registro.metodoDistribucion = item.metodoDistribucion;
      }
    });
    return Array.from(mapa.values());
  }

  const api = {
    distribuirMontoPorUsuarios,
    resumirDistribucionPorRol
  };

  if(typeof module !== 'undefined' && module.exports){
    module.exports = api;
  }
  global.CentroPagosAdminDistribucion = api;
})(typeof window !== 'undefined' ? window : globalThis);
