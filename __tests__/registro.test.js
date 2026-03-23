const fs = require('fs');

describe('registrarse.html - validaciones y botón registrar', () => {
  const html = fs.readFileSync('public/registrarse.html', 'utf8');

  test('incluye validaciones clave de paso 1 y paso 2', () => {
    expect(html).toMatch(/function validarPaso1\(mostrarErrores=true\)/);
    expect(html).toMatch(/Nombre inválido \(solo letras, hasta 40\)\./);
    expect(html).toMatch(/Apellido inválido \(solo letras, hasta 40\)\./);
    expect(html).toMatch(/Alias obligatorio \(máx\. 60 caracteres\)\./);
    expect(html).toMatch(/function validarPaso2\(mostrarErrores=true\)/);
    expect(html).toMatch(/Debes aceptar términos y condiciones\./);
    expect(html).toMatch(/Selecciona una cuenta \$\{proveedores\}\./);
  });

  test('actualizarEstadoRegistro controla estado disabled del botón', () => {
    expect(html).toMatch(/function actualizarEstadoRegistro\(\)/);
    expect(html).toMatch(/const requisitos = validarPaso1\(false\) && validarPaso2\(false\);/);
    expect(html).toMatch(/registrarBtn\.disabled = !requisitos;/);
  });

  test('evita doble envío con registroEnProceso', () => {
    expect(html).toMatch(/let registroEnProceso = false;/);
    expect(html).toMatch(/if\(registroEnProceso\) return;/);
    expect(html).toMatch(/registroEnProceso = true;/);
    expect(html).toMatch(/finally\{\s*registroEnProceso = false;\s*\}/);
  });

  test('sincroniza visibilidad de proveedores y oculta Apple por configuración', () => {
    expect(html).toMatch(/function sincronizarBotonesProveedores\(\)/);
    expect(html).toMatch(/loginAppleBtn\.hidden = !appleHabilitado;/);
    expect(html).toMatch(/Apple permanecerá oculto hasta habilitarlo explícitamente\./);
    expect(html).toMatch(/Dominio actual: \$\{dominioActual\}/);
    expect(html).toMatch(/Dominios publicados: \$\{textoDominios\}/);
  });

  test('si falla Firebase en registro no redirige automáticamente al index', () => {
    expect(html).toMatch(/No se pudo preparar el registro\. Recarga esta página e inténtalo nuevamente\./);
    expect(html).toMatch(/La página de registro no pudo inicializar la sesión y se mantendrá abierta para que no pierdas el formulario\./);
    expect(html).not.toMatch(/No se pudo inicializar Firebase en registrarse\.html[\s\S]*window\.location\.href='index\.html';/);
  });
});
