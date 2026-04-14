const fs = require('fs');
const path = require('path');

describe('firestore.rules - billetera y subcolección premiosPendientesDirectos', () => {
  const rulesPath = path.join(__dirname, '..', 'firestore.rules');
  const rules = fs.readFileSync(rulesPath, 'utf8');

  test('billetera elimina excepción de acreditación directa del cliente', () => {
    expect(rules).toContain('match /Billetera/{email}');
    expect(rules).toContain('allow create, update: if isSystemRequest()');
    expect(rules).toContain('|| (!isProductionLockEnabled() && (isAdmin() || isOwner(email) || isPrivilegedOperator()));');
    expect(rules).not.toContain('function isPlayerDirectPrizeAccreditationUpdate(email)');
    expect(rules).not.toContain('allowedPlayerDirectPrizeAccreditationKeys()');
    expect(rules).not.toContain('walletDiff.changedKeys().hasOnly(');
  });

  test('premios pendientes conserva lectura para jugador y bloquea mutaciones cliente', () => {
    expect(rules).toContain('match /premiosPendientesDirectos/{premioId}');
    expect(rules).toContain('allow read: if isAdmin() || isOwner(email);');
    expect(rules).toContain('allow create: if isSystemRequest();');
    expect(rules).toContain('allow update, delete: if isSystemRequest();');
    expect(rules).not.toContain('hasPendingPrizeAccreditationMutationShape()');
  });
});
