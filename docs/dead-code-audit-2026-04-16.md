# Auditoría de dead code (2026-04-16)

## Alcance
- Frontend estático en `public/`.
- Backend Express en `uploadServer.js`.
- Reglas Firebase (`firestore.rules`, `storage.rules`).
- Scripts de soporte y configuración (`scripts/`, raíz del repo, `package.json`).

## Metodología aplicada
1. Inventario de archivos con `rg --files`.
2. Inventario de scripts npm desde `package.json`.
3. Mapeo de endpoints backend con `rg "app\.(get|post|put|delete|patch)\(" uploadServer.js`.
4. Búsquedas de referencias con `rg -n` para detectar posibles huérfanos (estáticas y por nombre string).
5. Clasificación de riesgo por impacto funcional (Auth, premios, billetera, reglas = ALTO RIESGO).

## Inventario resumido
### Backend (`uploadServer.js`)
- Endpoints activos detectados: `/health`, `/runtime-config`, `/wallet/transfer-credits`, `/syncClaims`, `/admin/session/*`, `/acreditarPremioEvento`, endpoints de finalización/sellado/reconciliación y endpoints de loterías/upload.
- Exporta utilidades para pruebas de regresión (bloque `module.exports` al final del archivo).

### Frontend (`public/`)
- Múltiples páginas HTML operativas para juego/admin.
- JS cargado por `<script src>` directo y algunos loads dinámicos (ej. `internalTransactionNotifier` desde `auth.js`).

### Firebase
- Reglas de Firestore y Storage con controles por rol y lock operativo.
- No se propone limpieza automática en reglas sin matriz de regresión de seguridad (ALTO RIESGO).

## Candidatos a eliminar

| ID | Tipo | Evidencia | Riesgo | Recomendación |
|---|---|---|---|---|
| DC-01 | archivo (script) | `scripts/migrarPremiosPendientesDirectosSubcoleccion.js` no aparece en `package.json` scripts y no tiene referencias cruzadas en código de runtime; solo auto-referencia textual interna. | Medio | **Deprecate con flag/documentación** en PR 1. Eliminar en PR 2 tras validar que la migración legacy ya no se requiere. |
| DC-02 | archivo (script) | `initUsers.js` no está conectado a scripts npm ni es importado por runtime; referencias halladas únicamente en documento histórico agregado (`DOCUMENTACION_COMPLETA...`). | Medio | **Deprecate** (mover a `scripts/legacy/` o documentar obsolescencia). |
| DC-03 | archivo (script) | `initRoles.js` en misma condición que `initUsers.js`: sin llamada desde npm scripts ni runtime actual. | Medio | **Deprecate** con ventana de observación; eliminar después de confirmar operación manual vigente. |
| DC-04 | archivo (script CI) | `scripts/gpt-pr-tools.mjs` sin workflow `.github/workflows` presente en este checkout, y sin referencias desde npm scripts/runtime. | Bajo | **Eliminar** en quick win si se confirma que CI externo no lo consume. |
| DC-05 | archivo (HTML diagnóstico) | `public/depurardb.html` no aparece enlazado desde otras páginas detectadas por búsqueda local; parece utilitario manual. | Medio | **Conservar** por ahora y etiquetar como página de diagnóstico interna; no eliminar sin confirmar uso operativo. |
| DC-06 | archivo (documentación snapshot) | `DOCUMENTACION_COMPLETA_PROYECTO_ Bingo-online.txt` es un volcado masivo histórico, no forma parte de runtime ni scripts npm. | Bajo | **Deprecate/archivar** fuera de raíz (ej. `docs/archive/`) para reducir ruido y riesgo de confusión. |

## Evidencia de no uso (detalle)

### DC-01 — `scripts/migrarPremiosPendientesDirectosSubcoleccion.js`
- **Ubicación:** `scripts/migrarPremiosPendientesDirectosSubcoleccion.js`.
- **Por qué parece no usado:** no existe script npm asociado ni llamada en backend/frontend.
- **Prueba de no referencia:** búsqueda textual global no devuelve consumidores fuera del propio archivo y documento snapshot.
- **Riesgo falso positivo:** medio (podría ejecutarse manualmente en incidentes).
- **Impacto potencial:** bajo/medio; solo impacta operaciones de migración histórica.

### DC-02 — `initUsers.js`
- **Ubicación:** `initUsers.js`.
- **Por qué parece no usado:** no expuesto en `package.json` scripts ni importado por app.
- **Prueba de no referencia:** búsquedas globales sin llamadas activas.
- **Riesgo falso positivo:** medio (seed manual eventual).
- **Impacto potencial:** bajo si no se usa en bootstrap manual.

### DC-03 — `initRoles.js`
- **Ubicación:** `initRoles.js`.
- **Por qué parece no usado:** misma condición que DC-02.
- **Prueba de no referencia:** sin usos en runtime/tests/scripts npm activos.
- **Riesgo falso positivo:** medio.
- **Impacto potencial:** bajo si no hay bootstrap manual actual.

### DC-04 — `scripts/gpt-pr-tools.mjs`
- **Ubicación:** `scripts/gpt-pr-tools.mjs`.
- **Por qué parece no usado:** sin workflow local que lo invoque y sin script npm.
- **Prueba de no referencia:** búsquedas globales sin consumidor operativo.
- **Riesgo falso positivo:** bajo/medio (si un pipeline externo lo invoca por ruta).
- **Impacto potencial:** bajo en runtime; nulo en producción app.

### DC-05 — `public/depurardb.html`
- **Ubicación:** `public/depurardb.html`.
- **Por qué parece no usado:** no está enlazada desde navegación principal detectada por búsquedas.
- **Prueba de no referencia:** sin `<a href>` ni redirects internos encontrados en rastreo local.
- **Riesgo falso positivo:** medio (uso manual por URL directa).
- **Impacto potencial:** bajo funcional, medio operativo (soporte/diagnóstico).

### DC-06 — `DOCUMENTACION_COMPLETA_PROYECTO_ Bingo-online.txt`
- **Ubicación:** raíz del repositorio.
- **Por qué parece no usado:** no participa en build/test/deploy.
- **Prueba de no referencia:** sin dependencias runtime, archivo de snapshot.
- **Riesgo falso positivo:** bajo.
- **Impacto potencial:** nulo en app; positivo para mantenibilidad al archivarlo.

## Plan de depuración por fases

### Fase 1 — Quick wins (bajo riesgo)
1. Eliminar `scripts/gpt-pr-tools.mjs` (DC-04) **si** se confirma inexistencia de pipeline externo.
2. Archivar `DOCUMENTACION_COMPLETA_PROYECTO_ Bingo-online.txt` (DC-06) en `docs/archive/`.
3. Añadir README corto de “legacy scripts” para evitar reintroducción accidental.

### Fase 2 — Limpieza moderada
1. Mover `initUsers.js` e `initRoles.js` a `scripts/legacy/` con aviso de deprecación.
2. Mover `scripts/migrarPremiosPendientesDirectosSubcoleccion.js` a `scripts/legacy/` y registrar comando manual de rollback (si todavía aplica).
3. Marcar `public/depurardb.html` como interna/no soportada o proteger acceso por entorno.

### Fase 3 — ALTO RIESGO (solo con regresión + rollback)
1. Cualquier ajuste en `firestore.rules` y `storage.rules`.
2. Cualquier retiro de endpoints de `uploadServer.js` vinculados a auth, premios, billetera o estados operativos.
3. Cualquier eliminación de utilidades exportadas usadas por tests de regresión de finalización/acreditación.

## Propuesta de PRs pequeños (<=400 líneas netas)

### PR-1 (chore/docs): inventario y marcación de legado
- **Motivación:** visibilidad y reducción de riesgo antes de borrar.
- **Cambios:** agregar inventario de scripts legacy + etiquetas de deprecación en comentarios (sin borrar código).
- **Riesgos:** mínimos.
- **Rollback:** revertir commit.
- **Pruebas:** `npm test`.

### PR-2 (chore): archive de artefactos no runtime
- **Motivación:** reducir ruido operacional.
- **Cambios:** mover `DOCUMENTACION_COMPLETA...` a `docs/archive/`; opcional eliminar `scripts/gpt-pr-tools.mjs` si confirmado.
- **Riesgos:** bajos, principalmente de procesos externos no versionados.
- **Rollback:** restaurar rutas previas.
- **Pruebas:** `npm test`.

### PR-3 (chore): consolidación de scripts huérfanos
- **Motivación:** aislar scripts legacy para no bloquear evolución.
- **Cambios:** mover `initUsers.js`, `initRoles.js`, `migrarPremiosPendientesDirectosSubcoleccion.js` a `scripts/legacy/` + README de uso manual.
- **Riesgos:** medios (operación manual puntual).
- **Rollback:** volver archivos a rutas originales.
- **Pruebas:** `npm test`.

## No eliminar todavía
- `firestore.rules` y `storage.rules` (ALTO RIESGO de seguridad/datos).
- Endpoints de premios/billetera/auth en `uploadServer.js` (ALTO RIESGO funcional).
- Funciones exportadas al final de `uploadServer.js` usadas por cobertura de regresión.
- `public/js/auth-role-utils.js`: aunque no está cargado en HTML, tiene cobertura explícita en Jest y sirve como utilidad compartida.
- `public/js/sorteoAutoPrizeEligibility.js`: usado directamente por backend para elegibilidad de premios.

## Checklist de seguridad
- [x] No se agregaron secretos.
- [x] No se agregaron credenciales hardcodeadas.
- [x] No se modificaron contratos Firestore/Storage.
- [x] No se tocaron flujos críticos (Auth, premios, billetera) en este PR de auditoría.
