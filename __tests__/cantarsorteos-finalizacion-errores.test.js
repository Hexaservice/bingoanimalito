const fs = require('fs');
const path = require('path');
const vm = require('vm');

function extraerBloqueEntre(source, inicioPattern, finPattern) {
  const inicio = source.indexOf(inicioPattern);
  if (inicio < 0) throw new Error(`No se encontró inicio: ${inicioPattern}`);
  const fin = source.indexOf(finPattern, inicio);
  if (fin < 0) throw new Error(`No se encontró fin: ${finPattern}`);
  return source.slice(inicio, fin);
}

describe('cantarsorteos mapearErrorFinalizacionFirestore', () => {
  const htmlPath = path.join(__dirname, '..', 'public', 'cantarsorteos.html');
  const html = fs.readFileSync(htmlPath, 'utf8');
  const fnMapeoErrores = extraerBloqueEntre(
    html,
    'function mapearErrorFinalizacionFirestore(error){',
    'function registrarTelemetriaFinalizacion(nombreEvento, payload = {}){'
  );

  function crearMapeador() {
    const context = {};
    vm.createContext(context);
    vm.runInContext(
      `${fnMapeoErrores}\nthis.mapearErrorFinalizacionFirestore = mapearErrorFinalizacionFirestore;`,
      context
    );
    return context.mapearErrorFinalizacionFirestore;
  }

  test('mapea permission-denied a mensaje accionable de rol operativo', () => {
    const mapear = crearMapeador();

    const resultado = mapear({ code: 'permission-denied' });

    expect(resultado.code).toBe('permission-denied');
    expect(resultado.tipo).toBe('permisos');
    expect(resultado.mensajeUI).toContain('users/{email}');
  });

  test('mapea failed-precondition a mensaje de refrescar y validar', () => {
    const mapear = crearMapeador();

    const resultado = mapear({ code: 'failed-precondition' });

    expect(resultado.code).toBe('failed-precondition');
    expect(resultado.tipo).toBe('precondicion');
    expect(resultado.mensajeUI).toContain('Refresca');
  });

  test('usa fallback para códigos desconocidos', () => {
    const mapear = crearMapeador();

    const resultado = mapear({ code: 'otro-codigo-raro' });

    expect(resultado.code).toBe('otro-codigo-raro');
    expect(resultado.tipo).toBe('desconocido');
    expect(resultado.titulo).toBe('Error de finalización');
  });
});
