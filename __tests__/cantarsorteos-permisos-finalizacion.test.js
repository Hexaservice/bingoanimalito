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

describe('cantarsorteos validarPermisoEfectivoFinalizarSorteo', () => {
  const htmlPath = path.join(__dirname, '..', 'public', 'cantarsorteos.html');
  const html = fs.readFileSync(htmlPath, 'utf8');
  const fnNormalizarRol = extraerBloqueEntre(
    html,
    'function normalizarRolOperativo(valor){',
    'function extraerRolClaimOperativo(claims = {}){'
  );
  const fnExtraerRolClaim = extraerBloqueEntre(
    html,
    'function extraerRolClaimOperativo(claims = {}){',
    'async function validarPermisoEfectivoFinalizarSorteo(){'
  );
  const fnValidarPermiso = extraerBloqueEntre(
    html,
    'async function validarPermisoEfectivoFinalizarSorteo(){',
    'async function finalizarSorteo(){'
  );

  function crearContexto({ claimsRole = 'Administrador', userDocExists = true, userDocRole = 'Jugador' } = {}) {
    const context = {
      auth: {
        currentUser: {
          email: 'admin@correo.com',
          getIdTokenResult: jest.fn(async () => ({ claims: claimsRole ? { role: claimsRole } : {} }))
        }
      },
      db: {
        collection: jest.fn(() => ({
          doc: jest.fn(() => ({
            get: jest.fn(async () => ({
              exists: userDocExists,
              data: () => ({ role: userDocRole })
            }))
          }))
        }))
      },
      console
    };

    vm.createContext(context);
    vm.runInContext(
      `${fnNormalizarRol}\n${fnExtraerRolClaim}\n${fnValidarPermiso}\nthis.validarPermisoEfectivoFinalizarSorteo = validarPermisoEfectivoFinalizarSorteo;`,
      context
    );
    return context;
  }

  test('bloquea finalización cuando claims y users/{email}.role no coinciden', async () => {
    const ctx = crearContexto({ claimsRole: 'Jugador', userDocExists: true, userDocRole: 'Administrador' });

    const result = await ctx.validarPermisoEfectivoFinalizarSorteo();

    expect(result.permitido).toBe(false);
    expect(result.mensaje).toContain('desalineación de rol');
    expect(result.mensaje).toContain('users/admin@correo.com.role=Administrador');
  });
});
