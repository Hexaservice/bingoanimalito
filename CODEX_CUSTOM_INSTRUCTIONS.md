# Instrucciones personalizadas sugeridas para Codex (PR optimizados)

> Objetivo: mejorar calidad, trazabilidad y velocidad de revisión de Pull Requests para **bingoanimalito**.

## Texto recomendado para pegar en "Instrucciones personalizadas"

```md
Actúa como ingeniero senior en este repositorio. Tu objetivo principal es crear PRs pequeños, verificables y fáciles de aprobar.

Reglas de ejecución obligatorias:

1) Antes de tocar código
- Lee `README.md` y respeta los flujos operativos vigentes (Firebase Auth, lock de premios, catálogo de loterías).
- Haz cambios mínimos y enfocados al objetivo; evita refactors no solicitados.

2) Calidad técnica
- Mantén compatibilidad con arquitectura actual (frontend estático en `public/` + backend Express en `uploadServer.js`).
- No rompas contratos de datos en Firestore ni reglas de seguridad (`firestore.rules`, `storage.rules`).
- No introduzcas secretos ni credenciales en código.

3) Pruebas y validación
- Ejecuta al menos:
  - `npm test`
- Si cambias scripts de configuración o despliegue, valida además:
  - `npm run generate:firebase-config` (cuando aplique)
  - `npm run generate:loterias-manifest` (cuando se toquen imágenes/manifiesto de loterías)
- Si una prueba no puede correr por entorno, repórtalo explícitamente en el PR con causa y mitigación.

4) Convenciones de PR
- Crea ramas con prefijo semántico: `fix/...`, `feat/...`, `chore/...`, `docs/...`.
- Título del commit y PR en formato Conventional Commits (ej: `fix(auth): corrige dominio autorizado en diagnóstico`).
- El PR debe incluir siempre:
  - Resumen de cambios
  - Motivación y problema que resuelve
  - Riesgos/impacto
  - Plan de rollback
  - Evidencia de pruebas (comandos + resultado)
  - Checklist de seguridad (sin secretos, sin credenciales hardcodeadas)

5) Estrategia de cambios
- Prefiere PRs <= 400 líneas netas cuando sea posible.
- Si el alcance crece, divide en PRs secuenciales (infra/config primero, luego lógica, luego UI).
- Para frontend, evita cambios visuales innecesarios fuera del objetivo.

6) Reglas específicas de este repo
- Si agregas/eliminas imágenes de loterías, actualiza `public/img/loterias/manifest.json` en el mismo PR.
- Si tocas autenticación/frontend config, garantiza coherencia con `public/firebase-config.template.js` y documentación en `README.md`.
- Si tocas pagos/premios, preserva la convención oficial de reparto y redondeo a 6 decimales.

7) Salida final del agente
- Entrega un resumen corto y una sección de "Testing" con comando + estado (PASS/FAIL/WARN).
- Incluye notas de seguimiento recomendadas para reviewer y para deploy.
```

## Ajuste opcional (más estricto para producción)

```md
Si un cambio afecta autenticación, premios, billetera, o reglas de Firestore, exige PR en modo "alto riesgo":
- Añadir matriz de impacto (usuario, datos, seguridad, operación).
- Requerir evidencia de prueba enfocada en regresión del flujo afectado.
- Incluir rollback específico (archivo/flag/comando) y criterio de abortar deploy.
```

## Por qué estas instrucciones sí están alineadas con la app

- El proyecto usa **frontend estático + backend Node/Express**, por lo que conviene exigir PRs pequeños y pruebas de integración básicas.
- Hay flujos sensibles (auth, premios, billetera, reglas), así que pedir matriz de riesgo/rollback reduce incidentes en producción.
- El repo ya define comandos operativos y convenciones claras en README; llevarlas a instrucciones de Codex evita PRs incompletos.
