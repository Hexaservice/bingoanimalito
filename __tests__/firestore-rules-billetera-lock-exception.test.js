const fs = require('fs');
const path = require('path');

describe('firestore.rules - billetera y subcolección premiosPendientesDirectos', () => {
  const rulesPath = path.join(__dirname, '..', 'firestore.rules');
  const rules = fs.readFileSync(rulesPath, 'utf8');

  test('caso permitido: dueño puede acreditar saldo con cambios acotados', () => {
    expect(rules).toContain('function isPlayerDirectPrizeAccreditationUpdate(email)');
    expect(rules).toContain("walletDiff.changedKeys().hasOnly(allowedPlayerDirectPrizeAccreditationKeys())");
    expect(rules).toContain("walletDiff.changedKeys().hasAny(['creditos', 'CartonesGratis', 'cartonesGratis'])");
    expect(rules).toContain('&& nextCredits >= currentCredits');
    expect(rules).toContain('&& nextFreeCardsA == nextFreeCardsB;');
  });

  test('subcolección valida permisos mínimos y mutación de acreditación', () => {
    expect(rules).toContain('match /premiosPendientesDirectos/{premioId}');
    expect(rules).toContain('allow create: if isSystemRequest()');
    expect(rules).toContain('hasPendingPrizeCreateShape()');
    expect(rules).toContain('hasPendingPrizeAccreditationMutationShape()');
    expect(rules).toContain("diff.changedKeys().hasOnly(['estado', 'acreditadoEn', 'acreditadoPor', 'origen'])");
  });

  test('caso bloqueado: dueño no puede modificar campos fuera de la excepción', () => {
    expect(rules).toContain("walletDiff.changedKeys().hasOnly(allowedPlayerDirectPrizeAccreditationKeys())");
    expect(rules).toContain('|| (isPlayerDirectPrizeAccreditationUpdate(email))');
    expect(rules).toContain('|| (!isProductionLockEnabled() && (isAdmin() || isOwner(email) || isPrivilegedOperator()));');
  });
});
