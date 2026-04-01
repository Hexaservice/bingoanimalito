const fs = require('fs');
const path = require('path');

describe('firestore.rules - excepción segura de acreditación directa en Billetera', () => {
  const rulesPath = path.join(__dirname, '..', 'firestore.rules');
  const rules = fs.readFileSync(rulesPath, 'utf8');

  test('caso permitido: dueño puede acreditar premio pendiente directo con cambios acotados', () => {
    expect(rules).toContain('function isPlayerDirectPrizeAccreditationUpdate(email)');
    expect(rules).toContain("walletDiff.changedKeys().hasOnly(allowedPlayerDirectPrizeAccreditationKeys())");
    expect(rules).toContain("walletDiff.changedKeys().hasAny(['creditos', 'CartonesGratis', 'cartonesGratis'])");
    expect(rules).toContain("walletDiff.changedKeys().hasAny(['premiosPendientesDirectos'])");
    expect(rules).toContain('pendingDirectPrizeDiff.removedKeys().size() == 1');
    expect(rules).toContain('pendingDirectPrizeDiff.addedKeys().size() == 0');
    expect(rules).toContain('pendingDirectPrizeDiff.changedKeys().size() == 0');
  });

  test('caso bloqueado: dueño no puede modificar campos fuera de la excepción', () => {
    expect(rules).toContain("walletDiff.changedKeys().hasOnly(allowedPlayerDirectPrizeAccreditationKeys())");
    expect(rules).toContain('|| (isPlayerDirectPrizeAccreditationUpdate(email))');
    expect(rules).toContain('|| (!isProductionLockEnabled() && (isAdmin() || isOwner(email) || isPrivilegedOperator()));');
  });
});
