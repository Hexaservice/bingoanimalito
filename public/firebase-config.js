// Configuración publicada de Firebase para el cliente web.
window.__FIREBASE_CONFIG__ = {
  apiKey: "AIzaSyDFDwPoH0Gl6GO3O0gLVmcTtcaXsYgUSV0",
  authDomain: "bingoanimalito.firebaseapp.com",
  projectId: "bingoanimalito",
  storageBucket: "bingoanimalito.firebasestorage.app",
  messagingSenderId: "396029548802",
  appId: "1:396029548802:web:88c183bf7e1d7df9d60a1b"
};

window.firebaseConfig = window.__FIREBASE_CONFIG__;

window.__FIREBASE_AUTH_SETTINGS__ = {
  providers: {
    google: true,
    apple: false
  },
  authorizedDomains: [
    "bingoanimalito.web.app",
    "bingoanimalito.firebaseapp.com"
  ]
};

window.__APP_CONFIG__ = {
  uploadEndpoint: ""
};

window.UPLOAD_ENDPOINT = window.__APP_CONFIG__.uploadEndpoint;
