function normalizarTexto(valor, max = 220) {
  return String(valor ?? '').trim().slice(0, max);
}

function normalizarFormaIdx(valor) {
  const num = Number(valor);
  return Number.isFinite(num) ? String(Math.trunc(num)) : '0';
}

function normalizarCartonClaveGanador(valor) {
  return normalizarTexto(valor, 220).toLowerCase();
}

function construirClaveLegacyPremioPendiente({ sorteoId, formaIdx, cartonLabel } = {}) {
  const sorteo = normalizarTexto(sorteoId, 120).toLowerCase();
  const forma = normalizarFormaIdx(formaIdx);
  const label = normalizarTexto(cartonLabel, 180).toLowerCase();
  if (!sorteo) return '';
  return `${sorteo}::${forma}::${label}`;
}

function construirEventoGanadorIdCanonico({ sorteoId, formaIdx, cartonClaveGanador, cartonId } = {}) {
  const sorteo = normalizarTexto(sorteoId, 120);
  const forma = normalizarFormaIdx(formaIdx);
  const claveCarton = normalizarCartonClaveGanador(cartonClaveGanador) || normalizarTexto(cartonId, 220);
  if (!sorteo || !claveCarton) return '';
  return `${sorteo}__f${forma}__${claveCarton}`;
}

function construirClavesCandidatasPremioPendiente(detalle = {}) {
  const candidatas = [
    normalizarTexto(detalle?.premioId, 220).toLowerCase(),
    normalizarTexto(detalle?.clavePendiente, 220).toLowerCase(),
    normalizarTexto(detalle?.eventoGanadorId, 320).toLowerCase(),
    construirEventoGanadorIdCanonico({
      sorteoId: detalle?.sorteoId,
      formaIdx: detalle?.idx,
      cartonClaveGanador: detalle?.cartonClaveGanador,
      cartonId: detalle?.cartonId
    }).toLowerCase(),
    construirClaveLegacyPremioPendiente({
      sorteoId: detalle?.sorteoId,
      formaIdx: detalle?.idx,
      cartonLabel: detalle?.cartonLabel
    })
  ].filter(Boolean);

  return Array.from(new Set(candidatas));
}

const api = {
  normalizarCartonClaveGanador,
  construirClaveLegacyPremioPendiente,
  construirEventoGanadorIdCanonico,
  construirClavesCandidatasPremioPendiente
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
}

if (typeof window !== 'undefined') {
  window.PremiosPendientesIds = api;
}
