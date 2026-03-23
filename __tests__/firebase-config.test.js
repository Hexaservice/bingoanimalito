const fs = require('fs');

describe('public/firebase-config.js', () => {
  const file = fs.readFileSync('public/firebase-config.js', 'utf8');

  test('publica Google habilitado y Apple deshabilitado por defecto en el archivo versionado', () => {
    expect(file).toMatch(/window\.__FIREBASE_AUTH_SETTINGS__ = \{/);
    expect(file).toMatch(/google: true/);
    expect(file).toMatch(/apple: false/);
  });

  test('incluye los dominios base del proyecto bingoanimalito', () => {
    expect(file).toMatch(/"bingoanimalito\.web\.app"/);
    expect(file).toMatch(/"bingoanimalito\.firebaseapp\.com"/);
  });
});
