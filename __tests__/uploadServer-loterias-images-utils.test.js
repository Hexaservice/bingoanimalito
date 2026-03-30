jest.mock('firebase-admin', () => ({
  apps: [],
  initializeApp: jest.fn()
}));

describe('uploadServer utilidades de imágenes de loterías', () => {
  afterEach(() => {
    jest.resetModules();
  });

  test('normalizeLoteriaImageItem devuelve estructura mínima esperada', () => {
    const { normalizeLoteriaImageItem } = require('../uploadServer.js');
    const req = {
      protocol: 'https',
      get: jest.fn(() => 'bingoonline.com')
    };

    const result = normalizeLoteriaImageItem(
      {
        name: 'la-granjita.png',
        relativePath: 'img/loterias/la-granjita.png',
        updatedAt: '2026-03-30T10:00:00.000Z'
      },
      req
    );

    expect(result).toEqual({
      name: 'la-granjita.png',
      path: 'img/loterias/la-granjita.png',
      url: 'https://bingoonline.com/img/loterias/la-granjita.png',
      updatedAt: '2026-03-30T10:00:00.000Z'
    });
  });

  test('toPublicImageUrl respeta URL absoluta y normaliza slash inicial', () => {
    const { toPublicImageUrl } = require('../uploadServer.js');
    const req = {
      protocol: 'https',
      get: jest.fn(() => 'bingoonline.com')
    };

    expect(toPublicImageUrl(req, 'https://cdn.example.com/img/loterias/a.png')).toBe(
      'https://cdn.example.com/img/loterias/a.png'
    );
    expect(toPublicImageUrl(req, '/img/loterias/a.png')).toBe('https://bingoonline.com/img/loterias/a.png');
  });
});
