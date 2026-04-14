# bingoanimalito
Bingo Con opciones de juego loterías animalitos

## Configuración de Firebase Authentication

Para que `public/registrarse.html` y `public/js/auth.js` muestren correctamente los proveedores habilitados y validen mejor el dominio actual, el despliegue publica `window.__FIREBASE_AUTH_SETTINGS__` dentro de `public/firebase-config.js` a partir de la plantilla `public/firebase-config.template.js`.

### Pasos manuales en Firebase Console

1. Abrir **Authentication > Sign-in method**.
2. Activar **Google** como proveedor de acceso.
3. Mantener **Apple** desactivado salvo que exista una decisión explícita de producto y una configuración completa de Apple Sign In en Firebase para `apple.com`. En este repositorio la UX, los mensajes de diagnóstico y los términos publicados asumen **Google** como proveedor principal.
4. Abrir **Authentication > Settings > Authorized domains**.
5. Confirmar como mínimo estos dominios del proyecto correcto:
   - `bingoanimalito.web.app`
   - `bingoanimalito.firebaseapp.com`
   - `bingoanimalito.juega-online.com`
   - `localhost` (si se usa flujo local)
6. Agregar además cualquier dominio real de staging/preview en uso antes de probar login social.
7. Verificar que **ningún** dominio pertenezca a otro proyecto Firebase antes de guardar cambios.


### Generación automática de `public/firebase-config.js`

- `public/firebase-config.template.js` es la única fuente de plantilla versionada.
- `public/firebase-config.js` se debe regenerar con `npm run generate:firebase-config`.
- `firebase.json` ejecuta ese comando en `hosting.predeploy`, evitando publicar credenciales o dominios equivocados en cada despliegue.
- Dominios por defecto publicados por el script (si no se define `FIREBASE_AUTH_AUTHORIZED_DOMAINS_JSON`):
  - `bingoanimalito.web.app`
  - `bingoanimalito.firebaseapp.com`
  - `bingoanimalito.juega-online.com`
  - `localhost`

### Secrets esperados por GitHub Actions

Además de los secretos actuales de Firebase web, el workflow acepta estos secretos opcionales para publicar la configuración visible en el frontend:

- `FIREBASE_AUTH_GOOGLE_ENABLED`: `true` o `false`. Si no se define, el deploy asume `true`.
- `FIREBASE_AUTH_APPLE_ENABLED`: `true` o `false`. Si no se define, el deploy asume `false`.
- `FIREBASE_AUTH_AUTHORIZED_DOMAINS_JSON`: arreglo JSON con los dominios autorizados que deben mostrarse en la app. Ejemplo: `["bingoanimalito.web.app","app.midominio.com","staging.midominio.com"]`.

### Ejemplo de configuración publicada

```js
window.__FIREBASE_AUTH_SETTINGS__ = {
  providers: {
    google: true,
    apple: false
  },
  authorizedDomains: [
    "bingoanimalito.web.app",
    "bingoanimalito.firebaseapp.com",
    "app.midominio.com",
    "staging.midominio.com"
  ]
};
```

Con esa publicación:

- `public/js/auth.js` informa si Google o Apple están habilitados y muestra mejor los errores de dominio no autorizado.
- `public/registrarse.html` muestra u oculta el botón Apple, muestra el dominio actual y lista los dominios autorizados publicados para diagnóstico.

### Rollback operativo para validación de rol/claims (alto riesgo)

Cuando se despliega un cambio en autenticación administrativa con degradación por `ROLE_MISMATCH`, se puede volver temporalmente a la política anterior (logout forzado) sin revertir código:

1. Publicar en la configuración runtime del frontend (`window.__APP_CONFIG__` o `window.appConfig`) el flag:

```js
window.__APP_CONFIG__ = {
  forceLogoutOnRecoverableRoleMismatch: true
};
```

2. Alternativamente, para diagnóstico inmediato en runtime, definir `window.__AUTH_FORCE_LOGOUT_ON_RECOVERABLE_ROLE_MISMATCH__ = true`.
3. Criterio sugerido de abortar deploy: si en los primeros 15 minutos post-deploy más de **5%** de validaciones administrativas terminan en `ROLE_MISMATCH`, abortar rollout y activar el flag anterior mientras se corrige origen de claims/perfil.

## Configurar y ejecutar `uploadServer.js`

El backend `uploadServer.js` **no arranca** si faltan estas variables obligatorias:

- `GOOGLE_APPLICATION_CREDENTIALS`
- `FIREBASE_STORAGE_BUCKET`

Puedes tomar `.env.example` como base y luego iniciar localmente así:

```bash
cp .env.example .env
npm start
```

Ejemplo mínimo:

```env
GOOGLE_APPLICATION_CREDENTIALS=/ruta/absoluta/serviceAccountKey.json
FIREBASE_STORAGE_BUCKET=bingoanimalito.appspot.com
ALLOWED_ORIGINS=https://bingoanimalito.web.app,https://app.midominio.com
UPLOAD_ENDPOINT=https://api.midominio.com/upload
PORT=3000
```

### CORS: `ALLOWED_ORIGINS`

`uploadServer.js` usa `ALLOWED_ORIGINS` para permitir llamadas del frontend. Debe contener el **dominio real** donde está publicado el cliente, separado por comas si hay más de uno.

Ejemplos:

- Producción en Hosting: `ALLOWED_ORIGINS=https://bingoanimalito.web.app`
- Producción + staging: `ALLOWED_ORIGINS=https://bingoanimalito.web.app,https://staging.midominio.com`
- Desarrollo local + producción: `ALLOWED_ORIGINS=http://localhost:3000,https://bingoanimalito.web.app`

Si el frontend llama desde un origen no incluido, el backend responderá `403` por CORS.

### `UPLOAD_ENDPOINT` obligatorio para `/upload`, `/syncClaims`, `/admin/session/*` y billetera (`/wallet/*`)

Ahora el deploy publica `UPLOAD_ENDPOINT` dentro de `public/firebase-config.js` (generado desde `public/firebase-config.template.js`), y `public/js/auth.js` lo reutiliza para construir la base de:

- `/syncClaims`
- `/admin/session/register`
- `/admin/session/status`
- endpoints de billetera como `/wallet/transfer-credits` (cuando `billetera.html` usa `getWalletApiBase`).

> Nota técnica: `/wallet/transfer-credits` se valida y ejecuta en backend con Firebase Admin SDK (no como escritura directa del cliente a Firestore).

`UPLOAD_ENDPOINT` es **obligatorio** cuando el frontend usa rutas administrativas (`/syncClaims`, `/admin/session/*`, `/admin/audit/*`) o de billetera (`/wallet/*`). Si falta, `public/js/auth.js` deja la resincronización de claims en estado de configuración incompleta y bloquea ese flujo con un diagnóstico explícito.

La configuración válida es una de estas dos (evitando que apunte al hosting estático si backend y frontend no comparten origen):

1. **Mismo origen**: exponer el backend detrás del mismo dominio del frontend y usar `UPLOAD_ENDPOINT=https://tu-dominio.com/upload`.
2. **Origen separado**: publicar el backend en otro dominio HTTPS y definir `UPLOAD_ENDPOINT=https://api.tu-dominio.com/upload`.

Checklist rápido de validación en producción:

1. Abrir la app publicada y verificar en `firebase-config.js` que `window.UPLOAD_ENDPOINT` no esté vacío.
2. Confirmar que la URL tenga el dominio real del backend (ejemplo: `https://api.tu-dominio.com/upload`).
3. Si backend/frontend usan dominios distintos, **no** usar la URL del hosting estático para `UPLOAD_ENDPOINT`.
4. En modo admin o con `?debug=1` en `billetera.html`, revisar el diagnóstico visible de base efectiva para confirmar la URL usada por `getWalletApiBase`.

### Matriz rápida de ejecución y dependencias (billetera/transferencias)

| Operación | Ejecutor | ¿Afectada por lock de premios en `firestore.rules`? | ¿Depende de CORS / `UPLOAD_ENDPOINT`? |
| --- | --- | --- | --- |
| Transferir créditos (`POST /wallet/transfer-credits`) | Backend (`uploadServer.js` + Admin SDK) | No, porque la transacción la ejecuta el backend | Sí |
| Escribir premios/acreditaciones directo desde cliente a Firestore | Cliente (SDK web) | Sí, cuando el lock está activo se bloquea según reglas | No |
| Acreditación directa controlada sobre `Billetera/{email}` (excepción de reglas) | Cliente (SDK web, con validaciones de reglas) | Sí, solo permitida la mutación puntual definida en reglas | No |
| Acreditación de premios y actualización de `premiosPendientesDirectos` | Backend (`uploadServer.js` + Admin SDK) | No, la escritura ocurre como sistema | Sí, usando endpoints backend autenticados |

### Contrato actualizado de acreditación de premios (backend 100%)

A partir de este cambio, el contrato operativo para premios es:

1. **Cliente solicita**: el frontend solo consulta `Billetera/{email}/premiosPendientesDirectos` para UX y dispara la solicitud al backend.
2. **Backend acredita**: únicamente procesos con `isSystemRequest()` pueden crear/actualizar/eliminar en `Billetera/{email}` y `premiosPendientesDirectos` cuando el lock de producción está activo.
3. **Sin excepción cliente para acreditación directa**: se elimina la excepción de reglas que permitía al dueño acreditar saldo/cartones directamente sobre Firestore.

Este contrato reduce superficie de fraude y centraliza trazabilidad de acreditaciones en backend.

### Checklist operativo explícito para `/wallet/transfer-credits`

Antes de validar “transferencia rota”, ejecutar este checklist en orden:

1. **Endpoint efectivo**
   - En la app publicada, abrir `public/firebase-config.js` servido por Hosting y confirmar que `window.UPLOAD_ENDPOINT` tenga una URL HTTPS real del backend (por ejemplo `https://api.tu-dominio.com/upload`).
   - Confirmar en `billetera.html?debug=1` que la “Base efectiva” apunte al backend esperado.
2. **CORS permitido**
   - En backend, definir `ALLOWED_ORIGINS` con el origen exacto del frontend productivo (`scheme + host + puerto`), sin path ni query.
   - Ejemplo válido: `ALLOWED_ORIGINS=https://bingoanimalito.web.app`.
3. **Prueba manual con token válido**
   - Generar un ID token de un usuario autenticado y ejecutar:

```bash
curl -i -X POST "https://api.tu-dominio.com/wallet/transfer-credits" \
  -H "Authorization: Bearer <ID_TOKEN_VALIDO>" \
  -H "Content-Type: application/json" \
  --data '{"toEmail":"destino@dominio.com","amount":1}'
```

   - Resultado esperado: respuesta JSON (`200/4xx` según reglas de negocio), **no** error HTML ni fallo CORS del navegador.

### Health check JSON rápido del backend

`uploadServer.js` expone `GET /health` para verificar rápidamente que la API responde JSON:

```bash
curl -sS https://api.tu-dominio.com/health
```

Respuesta esperada (ejemplo):

```json
{"ok":true,"service":"uploadServer","timestamp":"2026-01-01T00:00:00.000Z"}
```

Si `/health` responde correctamente pero `/wallet/transfer-credits` falla, el problema ya no es “API caída” sino configuración/autorización del flujo de billetera.

### Troubleshooting rápido: mensajes genéricos al transferir créditos

Cuando la UI muestra un error genérico en transferencias, validar en este orden:

1. **Base API efectiva (`UPLOAD_ENDPOINT`)**
   - Revisar `public/firebase-config.js` publicado y confirmar `window.UPLOAD_ENDPOINT` con dominio backend real.
   - En `billetera.html?debug=1`, validar que la “Base efectiva” coincida.
2. **CORS (`ALLOWED_ORIGINS`)**
   - Confirmar que incluya el origen exacto del frontend (incluyendo `https://` y puerto si aplica).
   - Si falta, el navegador puede mostrar error genérico aunque backend esté activo.
3. **Sesión/token**
   - Reautenticar usuario y repetir, para descartar token expirado o inválido.
4. **Prueba aislada por `curl`**
   - Ejecutar el `curl` de la sección de checklist para separar problema de UI vs. backend.
5. **Respuesta backend**
   - Si `curl` devuelve JSON con `4xx`, revisar regla de negocio (saldo, destinatario, permisos).
   - Si `curl` falla por conexión/HTML, revisar URL, proxy y despliegue del backend.

En GitHub Actions, define también el secret:

- `UPLOAD_ENDPOINT`

Así `public/firebase-config.js` quedará alineado con el backend real y `auth.js` no intentará llamar endpoints administrativos al origen equivocado.

## Provisionar un Superadmin real en Firebase

Para que un correo quede como **usuario real** en Firebase Authentication con proveedor de Google, primero debe iniciar sesión en la app con Google al menos una vez. Después de eso, el script `scripts/assignRoleClaims.js` puede validar que el usuario ya tenga `google.com` enlazado y sincronizar tanto los custom claims como el documento `users/{email}` en Firestore.

Ejemplo:

```bash
node scripts/assignRoleClaims.js \
  --email objetivo@dominio.com \
  --role Superadmin \
  --require-google true
```

Ese flujo deja en Authentication los claims `{ role: 'Superadmin', roles: ['Superadmin'], admin: true }` y en Firestore actualiza `users/{email}` con al menos `email`, `role`, `roles`, `admin` y `uid`.

## Operación segura: backfill masivo de claims operativos

Para alinear usuarios operativos existentes (`Superadmin`, `Administrador`, `Colaborador`) entre Firebase Auth y `users/{email}`, existe el script:

```bash
npm run backfill:operational-claims -- --dry-run true
```

### Qué hace el backfill

1. Recorre `users` filtrando por:
   - `role in [Superadmin, Administrador, Colaborador]`
   - o `roles array-contains-any [Superadmin, Administrador, Colaborador]`.
2. Para cada usuario:
   - valida email y uid contra Firebase Auth,
   - construye claims canónicos (`role`, `roles`, `admin`),
   - ejecuta `setCustomUserClaims` (solo fuera de dry-run),
   - actualiza `users/{email}` con `role`, `roles`, `admin`, `uid`, `roleUpdatedAt`.
3. Imprime reporte final con:
   - `totalProcesados`,
   - `exitosos`,
   - `fallidos`,
   - lista de `errores` con causa.

### Modo auditoría (dry-run)

Primero correr SIEMPRE en modo simulación:

```bash
npm run backfill:operational-claims -- --dry-run true
```

En este modo **no** se escriben claims ni Firestore; solo valida y reporta.

### Ejecución real (con confirmación explícita)

```bash
npm run backfill:operational-claims -- --confirm true
```

Opcional: limitar lote para pruebas controladas.

```bash
npm run backfill:operational-claims -- --confirm true --limit 20
```

### Rollback operativo

Si se detecta desalineación después del backfill:

1. Detener operación (no continuar lotes).
2. Re-ejecutar en `--dry-run true` para identificar cuentas afectadas.
3. Restaurar usuario por usuario con el script puntual:

```bash
node scripts/assignRoleClaims.js --email usuario@dominio.com --role <Superadmin|Administrador|Colaborador>
```

4. Forzar cierre/reinicio de sesión en frontend para refrescar token con claims actualizados.

### Verificación post-ejecución

Checklist recomendado:

1. Validar que `fallidos` sea `0` o que todas las causas estén diagnosticadas.
2. Para una muestra de usuarios, confirmar:
   - claims en Auth (`role`, `roles`, `admin`),
   - documento `users/{email}` con `roles`, `admin`, `roleUpdatedAt`, `uid`.
3. Probar acceso a vistas operativas (`super.html`, `admin.html`, `collab.html`) y acciones críticas según rol.

## Checklist operativo para `cantarsorteos.html` (roles sincronizados)

Antes de usar acciones sensibles como **finalizar sorteo** en `cantarsorteos`, validar siempre:

1. El usuario está autenticado y tiene correo válido en Firebase Auth.
2. Existe el documento `users/{email}` en Firestore.
3. `users/{email}.role` es uno de los roles operativos permitidos (`Superadmin`, `Administrador` o `Colaborador`).
4. El rol de claims (`claims.role` o `claims.roles[]`) coincide exactamente con `users/{email}.role`.
5. Si hay desalineación claims/documento, ejecutar resincronización de claims y volver a iniciar sesión **antes** de operar.

Este repositorio aplica política de seguridad de sincronización estricta: para operaciones privilegiadas no basta con acceso de UI; claims y documento `users/{email}` deben coincidir.

## Operación: lock de escrituras de premios (sin excepción cliente de acreditación)

Cuando `Variablesglobales/Parametros.bloquearEscriturasClientePremios == true`, las reglas de Firestore mantienen bloqueadas las escrituras de cliente relacionadas con premios.

Importante: ese lock aplica a escrituras directas iniciadas desde cliente (SDK web). No bloquea transacciones internas del backend ejecutadas con Firebase Admin SDK.

Regla vigente:

- No existe excepción cliente para acreditar premios en `Billetera/{email}` cuando el lock está activo.
- El cliente (jugador u operador) debe invocar endpoints backend autenticados para acreditar (`/acreditarPremioEvento` y reconciliación de cierre en CentroPagos).
- La escritura final de saldo, estado de premio y transacción contable ocurre por backend con Firebase Admin SDK.

En resumen: con lock activo, el cliente no recupera permisos de escritura de premios; la acreditación es backend-first.

## Convención oficial de reparto por ganador (backend + frontend)

Para evitar diferencias entre cálculo de servidor y visualización en cliente, la regla vigente es:

- **Créditos por ganador**: siempre `creditosBase / max(1, totalGanadores)`.
- **Cartones gratis por ganador**:
  - Si existe `cartonesGratisPorGanador`, ese valor es **fijo por ganador** (no se divide).
  - Si no existe, `cartonesGratis` se interpreta como **total de la forma** y se divide entre ganadores con `cartonesGratis / max(1, totalGanadores)`.
- **Redondeo**: se normaliza a **6 decimales** (ejemplo: `Number(valor.toFixed(6))`) en backend y frontend para mantener resultados idénticos.

### Nota de compatibilidad histórica / migración

- Formas históricas que dependían de flags tipo `premioCompartido`, `dividirPremio` o `divisible` ahora siguen la regla única de división para créditos.
- Si un sorteo histórico requiere conservar un valor fijo de cartones por ganador, definir explícitamente `cartonesGratisPorGanador` en la forma.
- No se requiere migración de documentos de premios ya generados/acreditados; la regla aplica a nuevos cálculos de premios pendientes.
- Para billetera y transacciones históricas, los montos ya guardados con 2 decimales se siguen leyendo sin migración; la visualización ahora acepta hasta 6 decimales y elimina ceros de cola para mantener compatibilidad hacia atrás.

## Catálogo oficial de imágenes de loterías

La fuente oficial de imágenes permitidas para loterías está en:

- `public/img/loterias/manifest.json`

Cada elemento del manifiesto contiene:

- `name`: nombre del archivo.
- `path`: ruta pública relativa (por ejemplo `img/loterias/lotto-activo.png`).
- `updatedAt` (opcional): fecha ISO de última actualización.

### Flujo operativo (alta/baja de archivos)

1. **Subir o eliminar el archivo** en `public/img/loterias/` mediante **Pull Request en GitHub**.
2. Ejecutar `npm run generate:loterias-manifest` para regenerar `public/img/loterias/manifest.json`.
3. Incluir en el mismo PR el cambio del manifiesto y la imagen agregada/eliminada.
4. Al hacer merge y deploy, `/admin/loterias/images` servirá el catálogo oficial desde `manifest.json`.
5. En `public/configuraciones.html`, la app **solo permite seleccionar/validar** imágenes presentes en ese catálogo oficial.

> Importante: la app ya no “da de alta” archivos binarios de loterías. Solo asigna o quita referencias a archivos aprobados y versionados por PR.

### Flujo resumido solicitado

**Subir imagen al repo → deploy → seleccionar en Configuraciones**

- Subes imagen + manifiesto en PR.
- Se aprueba/mergea y se despliega.
- La imagen queda disponible para selección en Configuraciones.
