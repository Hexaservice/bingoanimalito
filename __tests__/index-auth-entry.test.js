const fs = require('fs');

describe('index.html - acceso inicial', () => {
  const html = fs.readFileSync('public/index.html', 'utf8');

  test('expone botones de proveedores para iniciar sesión desde la portada', () => {
    expect(html).toMatch(/id="login-google-btn"/);
    expect(html).toMatch(/id="login-apple-btn"/);
    expect(html).toMatch(/function sincronizarProveedoresInicio\(\)/);
    expect(html).toMatch(/providersContainer\.classList\.toggle\('visible'\)/);
  });

  test('el enlace de registro envía siempre a registrarse.html', () => {
    expect(html).toMatch(/id="register-link">Regístrate<\/a>/);
    expect(html).toMatch(/window\.location\.href='registrarse\.html';/);
    expect(html).not.toMatch(/document\.getElementById\('register-link'\)[\s\S]*loginGoogle\(\)/);
  });
});
