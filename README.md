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
6. Agregar además el dominio exacto donde corre la app y cualquier subdominio o entorno de pruebas real necesario.
7. Verificar que **ningún** dominio pertenezca a otro proyecto Firebase antes de guardar cambios.

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

### `UPLOAD_ENDPOINT` para `/upload`, `/syncClaims` y `/admin/session/*`

Ahora el deploy publica `UPLOAD_ENDPOINT` dentro de `public/firebase-config.js`, y `public/js/auth.js` lo reutiliza para construir la base de:

- `/syncClaims`
- `/admin/session/register`
- `/admin/session/status`

La recomendación es una de estas dos:

1. **Mismo origen**: exponer el backend detrás del mismo dominio del frontend y usar `UPLOAD_ENDPOINT=https://tu-dominio.com/upload`.
2. **Origen separado**: publicar el backend en otro dominio HTTPS y definir `UPLOAD_ENDPOINT=https://api.tu-dominio.com/upload`.

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
