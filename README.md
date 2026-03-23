# bingoanimalito
Bingo Con opciones de juego loterías animalitos

## Configuración de Firebase Authentication

Para que `public/registrarse.html` y `public/js/auth.js` muestren correctamente los proveedores habilitados y validen mejor el dominio actual, el despliegue publica `window.__FIREBASE_AUTH_SETTINGS__` dentro de `public/firebase-config.js` a partir de la plantilla `public/firebase-config.template.js`.

### Pasos manuales en Firebase Console

1. Abrir **Authentication > Sign-in method**.
2. Activar **Google** como proveedor de acceso.
3. Si también se usará **Apple**, activarlo en la misma pantalla y completar la configuración requerida por Firebase para `apple.com`.
4. Abrir **Authentication > Settings > Authorized domains**.
5. Agregar el dominio exacto donde corre la app y cualquier subdominio o entorno de pruebas necesario.

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
    "app.midominio.com",
    "staging.midominio.com"
  ]
};
```

Con esa publicación:

- `public/js/auth.js` informa si Google o Apple están habilitados y muestra mejor los errores de dominio no autorizado.
- `public/registrarse.html` muestra u oculta el botón Apple, muestra el dominio actual y lista los dominios autorizados publicados para diagnóstico.

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

