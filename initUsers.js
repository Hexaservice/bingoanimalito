#!/usr/bin/env node
/**
 * Wrapper de compatibilidad para script legacy.
 * Ruta canónica actual: scripts/legacy/initUsers.js
 */
console.warn('[DEPRECATED] Usa scripts/legacy/initUsers.js (este wrapper será removido en fase posterior).');
require('./scripts/legacy/initUsers.js');
