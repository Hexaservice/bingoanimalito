const {
  distribuirMontoPorUsuarios,
  resumirDistribucionPorRol
} = require('../public/js/admin-payout-distribution');

describe('admin-payout-distribution', () => {
  test('distribuye monto total por rol entre 2+ usuarios con floor + remanente', () => {
    const usuarios = [
      { uid: 'u1', email: 'uno@correo.com' },
      { uid: 'u2', email: 'dos@correo.com' },
      { uid: 'u3', email: 'tres@correo.com' }
    ];
    const resultado = distribuirMontoPorUsuarios({
      montoRol: 10,
      usuarios,
      rolInterno: 'agencia',
      modoMonto: 'total_por_rol'
    });

    expect(resultado).toHaveLength(3);
    expect(resultado.map(item => item.montoAsignado)).toEqual([4, 3, 3]);
    expect(resultado.every(item => item.montoRolBase === 10)).toBe(true);
    expect(resultado.every(item => item.totalUsuariosRol === 3)).toBe(true);
    expect(resultado.every(item => item.metodoDistribucion === 'total_por_rol_floor_remanente')).toBe(true);
  });

  test('resumirDistribucionPorRol agrega totales y metadatos por rol', () => {
    const resumen = resumirDistribucionPorRol([
      { rolInterno: 'agencia', creditos: 4, montoRolBase: 10, metodoDistribucion: 'total_por_rol_floor_remanente' },
      { rolInterno: 'agencia', creditos: 3, montoRolBase: 10, metodoDistribucion: 'total_por_rol_floor_remanente' },
      { rolInterno: 'agencia', creditos: 3, montoRolBase: 10, metodoDistribucion: 'total_por_rol_floor_remanente' }
    ]);

    expect(resumen).toHaveLength(1);
    expect(resumen[0]).toMatchObject({
      rolInterno: 'agencia',
      totalUsuarios: 3,
      totalCreditos: 10,
      montoRolBase: 10,
      metodoDistribucion: 'total_por_rol_floor_remanente'
    });
  });
});
