function normalizeIdentityValue(value, max = 160) {
  return String(value ?? '').trim().slice(0, max);
}

function looksLikeEmailIdentity(value) {
  return typeof value === 'string' && /@/.test(value.trim());
}

function normalizeEmailIdentity(value) {
  return looksLikeEmailIdentity(value) ? normalizeIdentityValue(value, 160).toLowerCase() : '';
}

function buildBilleteraIdentity({ email, uid, extraCandidates = [] } = {}) {
  const canonicalEmail = normalizeEmailIdentity(email);
  const fallbackUidRaw = normalizeIdentityValue(uid, 160);
  const fallbackUid = fallbackUidRaw.toLowerCase();
  const primaryBilleteraId = canonicalEmail || fallbackUid;

  const normalizedExtra = Array.isArray(extraCandidates)
    ? extraCandidates
      .flatMap((item) => {
        const normalized = normalizeIdentityValue(item, 160);
        if (!normalized) return [];
        if (looksLikeEmailIdentity(normalized)) return [normalized.toLowerCase()];
        const lowered = normalized.toLowerCase();
        return Array.from(new Set([normalized, lowered]));
      })
      .filter(Boolean)
    : [];

  const billeteraCandidates = Array.from(new Set([
    primaryBilleteraId,
    canonicalEmail,
    fallbackUid,
    fallbackUidRaw,
    ...normalizedExtra
  ].filter(Boolean)));

  return {
    canonicalEmail,
    fallbackUid,
    billeteraId: primaryBilleteraId,
    billeteraCandidates
  };
}

const api = {
  normalizeIdentityValue,
  looksLikeEmailIdentity,
  normalizeEmailIdentity,
  buildBilleteraIdentity
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
}

if (typeof window !== 'undefined') {
  window.BilleteraIdentity = api;
}
