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

### `UPLOAD_ENDPOINT` para `/upload`, `/syncClaims`, `/admin/session/*` y billetera (`/wallet/*`)

Ahora el deploy publica `UPLOAD_ENDPOINT` dentro de `public/firebase-config.js` (generado desde `public/firebase-config.template.js`), y `public/js/auth.js` lo reutiliza para construir la base de:

- `/syncClaims`
- `/admin/session/register`
- `/admin/session/status`
- endpoints de billetera como `/wallet/transfer-credits` (cuando `billetera.html` usa `getWalletApiBase`).

La recomendación es una de estas dos (evitando que apunte al hosting estático si backend y frontend no comparten origen):

1. **Mismo origen**: exponer el backend detrás del mismo dominio del frontend y usar `UPLOAD_ENDPOINT=https://tu-dominio.com/upload`.
2. **Origen separado**: publicar el backend en otro dominio HTTPS y definir `UPLOAD_ENDPOINT=https://api.tu-dominio.com/upload`.

Checklist rápido de validación en producción:

1. Abrir la app publicada y verificar en `firebase-config.js` que `window.UPLOAD_ENDPOINT` no esté vacío.
2. Confirmar que la URL tenga el dominio real del backend (ejemplo: `https://api.tu-dominio.com/upload`).
3. Si backend/frontend usan dominios distintos, **no** usar la URL del hosting estático para `UPLOAD_ENDPOINT`.
4. En modo admin o con `?debug=1` en `billetera.html`, revisar el diagnóstico visible de base efectiva para confirmar la URL usada por `getWalletApiBase`.

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

## Operación: lock de escrituras de premios y excepción segura de acreditación directa

Cuando `Variablesglobales/Parametros.bloquearEscriturasClientePremios == true`, las reglas de Firestore mantienen bloqueadas las escrituras de cliente relacionadas con premios.

Excepción controlada en `Billetera/{email}`:

- El dueño del documento (`isOwner(email)`) puede ejecutar **únicamente** una mutación de acreditación directa de premio pendiente.
- Esa mutación está restringida a:
  - actualización de `creditos`,
  - actualización de `CartonesGratis` o `cartonesGratis`,
  - eliminación de **exactamente una** entrada en `premiosPendientesDirectos`.
- No se permiten altas/cambios de contenido dentro de `premiosPendientesDirectos`, ni cambios en otros campos sensibles o no previstos.

En resumen: con lock activo, el cliente no recupera permisos generales de escritura; solo se habilita esta acreditación puntual y validada por reglas.

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
