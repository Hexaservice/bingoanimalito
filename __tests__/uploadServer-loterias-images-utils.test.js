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

  test('buildLoteriasImageSyncReport detecta faltantes, huérfanas y alertas de slug/case', () => {
    const { buildLoteriasImageSyncReport } = require('../uploadServer.js');
    const report = buildLoteriasImageSyncReport({
      loterias: [
        {
          id: 'lotto',
          nombre: 'Lotto Activo',
          estado: 'Activa',
          jerarquia: 1,
          imagen: 'img/loterias/Lotto-Activo.png'
        },
        {
          id: 'ruleta',
          nombre: 'Ruleta Activa',
          estado: 'Activa',
          jerarquia: 2,
          imagen: 'img/loterias/no-existe.png'
        }
      ],
      images: [
        {
          name: 'lotto-activo.png',
          path: 'img/loterias/lotto-activo.png',
          url: 'https://bingoonline.com/img/loterias/lotto-activo.png'
        },
        {
          name: 'huérfana.png',
          path: 'img/loterias/huerfana.png',
          url: 'https://bingoonline.com/img/loterias/huerfana.png'
        }
      ]
    });

    expect(report.summary.referenciasSinArchivo).toBe(1);
    expect(report.summary.imagenesHuerfanas).toBe(1);
    expect(report.summary.alertasCaseSlug).toBeGreaterThanOrEqual(1);
    expect(report.missingReferencedImages[0]).toMatchObject({ id: 'ruleta' });
    expect(report.orphanImages[0]).toMatchObject({ path: 'img/loterias/huerfana.png' });
  });
});
