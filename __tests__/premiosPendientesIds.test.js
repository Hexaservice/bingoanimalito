const {
  construirEventoGanadorIdCanonico,
  construirClavesCandidatasPremioPendiente
} = require('../lib/premiosPendientesIds');

describe('premiosPendientesIds', () => {
  test('genera clave canónica estable sin depender de cartonLabel visible', () => {
    const base = {
      sorteoId: 'SRT-2026',
      formaIdx: 1,
      cartonClaveGanador: 'usr:jugador@test.com::num:1',
      cartonId: 'carton-1'
    };

    const variantes = ['Cartón #1', 'cartón 1', '   Cartón   1   '];
    const ids = variantes.map((cartonLabel) => construirEventoGanadorIdCanonico({ ...base, cartonLabel }));

    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toBe('SRT-2026__f1__usr:jugador@test.com::num:1');
  });

  test('incluye compatibilidad legacy por cartonLabel sin pisar la clave canónica', () => {
    const detalle = {
      sorteoId: 'SRT-2026',
      idx: 1,
      cartonClaveGanador: 'usr:jugador@test.com::num:1',
      cartonLabel: ' Cartón #1 '
    };
    const candidatas = construirClavesCandidatasPremioPendiente(detalle);

    expect(candidatas[0]).toBe('srt-2026__f1__usr:jugador@test.com::num:1');
    expect(candidatas).toContain('srt-2026::1::cartón #1');
  });

  test('idempotencia con variaciones de label legacy', () => {
    const base = {
      sorteoId: 'SRT-2026',
      idx: 1,
      cartonClaveGanador: 'usr:jugador@test.com::num:1'
    };
    const a = construirClavesCandidatasPremioPendiente({ ...base, cartonLabel: 'Cartón #1' });
    const b = construirClavesCandidatasPremioPendiente({ ...base, cartonLabel: 'cartón 1' });
    const c = construirClavesCandidatasPremioPendiente({ ...base, cartonLabel: '  Cartón #1  ' });

    expect(a[0]).toBe(b[0]);
    expect(a[0]).toBe(c[0]);
    expect(a[0]).toBe('srt-2026__f1__usr:jugador@test.com::num:1');
    expect(a[1]).not.toBe(b[1]);
  });
});
