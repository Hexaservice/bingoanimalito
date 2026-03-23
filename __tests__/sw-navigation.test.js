const fs = require('fs');

describe('sw.js - navegación y caché del registro', () => {
  const sw = fs.readFileSync('public/sw.js', 'utf8');

  test('incluye registrarse.html en el app shell cacheado', () => {
    expect(sw).toMatch(/['"]\/registrarse\.html['"]/);
  });

  test('busca primero la navegación exacta cacheada antes de caer en index.html', () => {
    expect(sw).toMatch(/cache\.match\(event\.request, \{ ignoreSearch: false \}\)/);
    expect(sw).toMatch(/new URL\(event\.request\.url\)\.pathname/);
    expect(sw).toMatch(/return await cache\.match\('\/index\.html'\);/);
  });
});
