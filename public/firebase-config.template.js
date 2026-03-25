// Plantilla para generar la configuración de Firebase durante los despliegues.
// Los valores __FIREBASE_*__ se reemplazan en los workflows de GitHub Actions.
window.__FIREBASE_CONFIG__ = {
  apiKey: "__FIREBASE_API_KEY__",
  authDomain: "__FIREBASE_AUTH_DOMAIN__",
  databaseURL: "__FIREBASE_DATABASE_URL__",
  projectId: "__FIREBASE_PROJECT_ID__",
  storageBucket: "__FIREBASE_STORAGE_BUCKET__",
  messagingSenderId: "__FIREBASE_MESSAGING_SENDER_ID__",
  appId: "__FIREBASE_APP_ID__"
};

window.firebaseConfig = window.__FIREBASE_CONFIG__;

window.__FIREBASE_AUTH_SETTINGS__ = {
  providers: {
    google: __FIREBASE_AUTH_GOOGLE_ENABLED__,
    apple: __FIREBASE_AUTH_APPLE_ENABLED__
  },
  authorizedDomains: __FIREBASE_AUTH_AUTHORIZED_DOMAINS__
};

window.__APP_CONFIG__ = {
  uploadEndpoint: "__UPLOAD_ENDPOINT__"
};

window.UPLOAD_ENDPOINT = window.__APP_CONFIG__.uploadEndpoint;
