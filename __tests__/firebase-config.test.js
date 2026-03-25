const fs = require('fs');

describe('public/firebase-config.js', () => {
  const file = fs.readFileSync('public/firebase-config.js', 'utf8');

  test('publica Google habilitado y Apple deshabilitado por defecto en el archivo versionado', () => {
    expect(file).toMatch(/window\.__FIREBASE_AUTH_SETTINGS__ = \{/);
    expect(file).toMatch(/google: true/);
    expect(file).toMatch(/apple: false/);
  });

  test('incluye todos los dominios autorizados reales publicados para producción y desarrollo local', () => {
    expect(file).toMatch(/"bingoanimalito\.web\.app"/);
    expect(file).toMatch(/"bingoanimalito\.firebaseapp\.com"/);
    expect(file).toMatch(/"www\.bingo\.juega-online\.com"/);
    expect(file).toMatch(/"localhost"/);
  });

  test('mantiene datos de app web alineados al proyecto bingoanimalito', () => {
    expect(file).toMatch(/projectId: "bingoanimalito"/);
    expect(file).toMatch(/authDomain: "bingoanimalito\.firebaseapp\.com"/);
    expect(file).toMatch(/messagingSenderId: "396029548802"/);
    expect(file).toMatch(/appId: "1:396029548802:web:[a-z0-9]+"/i);
    expect(file).toMatch(/apiKey: "AIza[^"]+"/);
  });
});
