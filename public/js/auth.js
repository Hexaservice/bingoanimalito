let app, auth, db, provider, appleProvider, appName = 'Bingo Animalito';
const DISABLED_MSG = "Tu cuenta ha sido deshabilitada, Motivado posiblemente a que has incumplido una o más clausulas en nuestros Terminos y condiciones. Contacta con un administrador del sistema si necesitas información.";
const STRONG_AUTH_SESSION_KEY = 'bo_superadmin_strong_auth';
const SUPERADMIN_DEVICE_KEY = 'bo_superadmin_device_id';
let firebaseInitPromise = null;
let firebaseConfigLoadPromise = null;
let adminSessionWatcher = null;
let lastAuditStamp = null;
const nativeAlert = hasWindow() ? window.alert.bind(window) : null;
const nativeConfirm = hasWindow() ? window.confirm.bind(window) : null;
const nativePrompt = hasWindow() ? window.prompt.bind(window) : null;

function hasWindow(){
  return typeof window !== 'undefined';
}

function normalizeRole(role){
  if(typeof role !== 'string') return null;
  const limpio = role.trim().toLowerCase();
  if(!limpio) return null;
  if(limpio === 'superadmin' || limpio === 'super administrador' || limpio === 'super-administrador') return 'Superadmin';
  if(limpio === 'administrador' || limpio === 'admin') return 'Administrador';
  if(limpio === 'colaborador') return 'Colaborador';
  if(limpio === 'jugador' || limpio === 'player') return 'Jugador';
  return role.trim();
}

function roleEquals(left, right){
  const leftNormalized = normalizeRole(left);
  const rightNormalized = normalizeRole(right);
  if(!leftNormalized || !rightNormalized) return false;
  return leftNormalized === rightNormalized;
}

function isPrivilegedRole(role){
  const normalized = normalizeRole(role);
  return normalized === 'Superadmin' || normalized === 'Administrador' || normalized === 'Colaborador';
}

function resolveRoleFromClaims(claims = {}){
  const roleFromClaim = normalizeRole(claims.role);
  if(roleFromClaim) return roleFromClaim;
  if(Array.isArray(claims.roles) && claims.roles.length){
    const roleFromArray = claims.roles.map(normalizeRole).find(Boolean);
    if(roleFromArray) return roleFromArray;
  }
  return null;
}

function buildRoleConsistencyMessage(result){
  const claimsRole = result.claimsRole || 'sin rol en claims';
  const userDocRole = result.userDocRole || 'sin rol en users/{email}';
  return `Bloqueo de seguridad: el rol en claims (${claimsRole}) no coincide con users/{email}.role (${userDocRole}). Solicita resincronizar rol y vuelve a iniciar sesión.`;
}

function hasValidUserDocRoleForRecovery(result){
  return !!normalizeRole(result?.userDocRole || null);
}

function isRecoverableRoleConsistencyError(code){
  return code === 'ROLE_MISMATCH' || code === 'CLAIMS_READ_ERROR';
}

function isInvalidOrExpiredTokenError(errorCode){
  const normalizedCode = (errorCode || '').toString().trim().toLowerCase();
  return normalizedCode === 'auth/id-token-expired'
    || normalizedCode === 'auth/user-token-expired'
    || normalizedCode === 'auth/invalid-user-token'
    || normalizedCode === 'auth/user-token-revoked';
}

function getConfigFromWindow(){
  if(!hasWindow()) return null;
  const cfg = window.firebaseConfig || window.__FIREBASE_CONFIG__;
  if(cfg && Object.keys(cfg).length > 0) return cfg;
  return null;
}

function getAuthRuntimeSettings(){
  if(!hasWindow()) return {};
  const settings = window.__FIREBASE_AUTH_SETTINGS__ || window.firebaseAuthSettings || {};
  if(settings && typeof settings === 'object') return settings;
  return {};
}

function getAppRuntimeSettings(){
  if(!hasWindow()) return {};
  const settings = window.__APP_CONFIG__ || window.appConfig || {};
  if(settings && typeof settings === 'object') return settings;
  return {};
}

function buildResyncFailureMessage(reason){
  if(reason === 'MISSING_UPLOAD_ENDPOINT' || reason === 'INCOMPLETE_BACKEND_CONFIG'){
    return 'No se puede resincronizar claims porque falta configuración del backend';
  }
  return null;
}

function isProviderEnabled(providerKey, defaultValue = true){
  const settings = getAuthRuntimeSettings();
  const providers = settings.providers;
  if(providers && typeof providers === 'object' && Object.prototype.hasOwnProperty.call(providers, providerKey)){
    return !!providers[providerKey];
  }
  return defaultValue;
}

function isGoogleAuthEnabled(){
  return isProviderEnabled('google', true);
}

function isAppleAuthEnabled(){
  return isProviderEnabled('apple', false);
}

function getAuthorizedDomains(){
  const settings = getAuthRuntimeSettings();
  const domains = settings.authorizedDomains;
  if(!Array.isArray(domains)) return [];
  return domains
    .map(domain => typeof domain === 'string' ? domain.trim().toLowerCase() : '')
    .filter(Boolean);
}

function isCurrentDomainPublished(){
  const hostname = getCurrentHostname().trim().toLowerCase();
  if(!hostname) return false;
  return getAuthorizedDomains().includes(hostname);
}

function getPublishedProviderLabels(){
  const labels = [];
  if(isGoogleAuthEnabled()) labels.push('Google');
  if(isAppleAuthEnabled()) labels.push('Apple');
  return labels;
}

function describePublishedProviders(){
  const labels = getPublishedProviderLabels();
  if(labels.length === 0) return 'ningún proveedor publicado';
  if(labels.length === 1) return labels[0];
  return `${labels.slice(0, -1).join(', ')} y ${labels[labels.length - 1]}`;
}

function getCurrentHostname(){
  if(!hasWindow() || !window.location) return '';
  if(window.location.hostname || window.location.host){
    return window.location.hostname || window.location.host || '';
  }
  const originOrHref = window.location.origin || window.location.href || '';
  if(!originOrHref) return '';
  try{
    return new URL(originOrHref, 'https://placeholder.local').hostname || '';
  }catch(error){
    return '';
  }
}

function getAuthDomain(){
  const cfg = getConfigFromWindow();
  return cfg?.authDomain || '';
}

function isStoragePersistenceError(error){
  const code = (error?.code || '').toLowerCase();
  const message = (error?.message || '').toLowerCase();
  return [
    'auth/web-storage-unsupported',
    'auth/web-storage-unavailable',
    'auth/web-storage-error'
  ].includes(code)
    || message.includes('storage')
    || message.includes('cookie')
    || message.includes('cookies')
    || message.includes('localstorage')
    || message.includes('sessionstorage')
    || message.includes('indexeddb');
}

function getPersistenceModeLabel(mode){
  if(mode === firebase?.auth?.Auth?.Persistence?.LOCAL) return 'LOCAL';
  if(mode === firebase?.auth?.Auth?.Persistence?.SESSION) return 'SESSION';
  if(mode === firebase?.auth?.Auth?.Persistence?.NONE) return 'NONE';
  return 'DESCONOCIDO';
}

function buildFirebaseInitializationErrorMessage(error){
  if(isStoragePersistenceError(error)){
    return 'No se pudo preparar el acceso porque el navegador está bloqueando el almacenamiento o las cookies necesarias para Firebase. Habilita cookies/almacenamiento del sitio y vuelve a intentarlo.';
  }
  return 'No se pudo inicializar Firebase en este momento. Recarga la página e inténtalo nuevamente.';
}

function buildFirebaseAuthErrorMessage(error, providerLabel = 'el proveedor seleccionado'){
  const code = error?.code || '';
  const hostname = getCurrentHostname();
  const authDomain = getAuthDomain();
  if(code === 'auth/user-disabled'){
    return DISABLED_MSG;
  }
  if(isStoragePersistenceError(error)){
    return 'El navegador bloqueó el almacenamiento o las cookies necesarias para iniciar sesión. Limpia caché/cookies, habilita cookies de terceros si aplica y prueba nuevamente desde un dominio autorizado en Firebase.';
  }
  if(code === 'auth/unauthorized-domain'){
    const publishedDomains = getAuthorizedDomains();
    const publishedDomainsText = publishedDomains.length ? publishedDomains.join(', ') : 'ninguno publicado en firebase-config.js';
    return `Firebase bloqueó el acceso porque el dominio actual (${hostname || 'sin dominio detectado'}) no está autorizado. Revisa Authentication > Settings > Authorized domains y agrega ese dominio exacto, junto con cualquier subdominio o entorno de pruebas necesario. Dominios publicados en la app: ${publishedDomainsText}.`;
  }
  if(code === 'auth/operation-not-allowed'){
    return `Firebase no tiene habilitado ${providerLabel}. Revisa Authentication > Sign-in method y activa ${providerLabel}.`;
  }
  if(code === 'auth/invalid-auth-event' || code === 'auth/invalid-credential'){
    return `No se pudo completar la autenticación con ${providerLabel}. Verifica que authDomain (${authDomain || 'no configurado'}) pertenezca al proyecto correcto si usas signInWithRedirect.`;
  }
  return `Error al iniciar sesión con ${providerLabel}.`;
}

function getFirebaseConfigScriptUrl(){
  if(!hasWindow()) return '/firebase-config.js';
  const url = new URL('/firebase-config.js', window.location.origin);
  return url.toString();
}

function ensureFirebaseConfigScript(){
  if(!hasWindow()) return Promise.resolve();
  if(getConfigFromWindow()) return Promise.resolve();
  if(!firebaseConfigLoadPromise){
    firebaseConfigLoadPromise = new Promise((resolve, reject)=>{
      if(typeof document === 'undefined'){
        resolve();
        return;
      }
      const existing = document.querySelector('script[data-firebase-config]');
      if(existing){
        if(getConfigFromWindow()){
          resolve();
          return;
        }
        existing.addEventListener('load', ()=>resolve(), { once: true });
        existing.addEventListener('error', ()=>reject(new Error(`No se pudo cargar ${getFirebaseConfigScriptUrl()}`)), { once: true });
        return;
      }
      const script = document.createElement('script');
      script.src = getFirebaseConfigScriptUrl();
      script.async = false;
      script.dataset.firebaseConfig = 'true';
      script.onload = ()=>resolve();
      script.onerror = ()=>reject(new Error(`No se pudo cargar ${getFirebaseConfigScriptUrl()}`));
      document.head.appendChild(script);
    });
  }
  return firebaseConfigLoadPromise;
}

async function initFirebase(){
  if(app) return app;
  if(firebaseInitPromise) return firebaseInitPromise;

  firebaseInitPromise = (async ()=>{
    if(typeof firebase === 'undefined'){
      throw new Error('Firebase SDK no disponible.');
    }
    try{
      await ensureFirebaseConfigScript();
    }catch(loadErr){
      console.error('No se pudo cargar firebase-config.js', loadErr);
      throw loadErr;
    }

    const firebaseConfig = getConfigFromWindow();
    if (!firebaseConfig) {
      throw new Error('Firebase config no disponible. Genere public/firebase-config.js antes de cargar auth.js.');
    }
    app = firebase.apps.length ? firebase.app() : firebase.initializeApp(firebaseConfig);

    db = firebase.firestore();
    auth = firebase.auth();
    provider = new firebase.auth.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    appleProvider = new firebase.auth.OAuthProvider('apple.com');
    appleProvider.addScope('email');
    appleProvider.addScope('name');

    const persistenceModes = [
      firebase.auth.Auth.Persistence.LOCAL,
      firebase.auth.Auth.Persistence.SESSION,
      firebase.auth.Auth.Persistence.NONE
    ];
    let originalPersistenceError = null;
    let persistenceModeUsed = null;

    for(const mode of persistenceModes){
      try{
        await auth.setPersistence(mode);
        persistenceModeUsed = mode;
        break;
      }catch(persistenceError){
        if(!originalPersistenceError){
          originalPersistenceError = persistenceError;
          console.error('Error original al configurar la persistencia de Firebase', persistenceError);
        }else{
          console.warn(`Falló el fallback de persistencia ${getPersistenceModeLabel(mode)}`, persistenceError);
        }

        if(!isStoragePersistenceError(persistenceError) || mode === firebase.auth.Auth.Persistence.NONE){
          throw persistenceError;
        }
      }
    }

    console.info('Modo de persistencia usado por Firebase', {
      mode: getPersistenceModeLabel(persistenceModeUsed),
      fallbackApplied: !!originalPersistenceError
    });
    return app;
  })();

  return firebaseInitPromise;
}

initFirebase()
  .then(() => {
    initAppName();
    ensureInternalTransactionNotifierScript();
  })
  .catch(e => {
    console.error('No se pudo inicializar Firebase al cargar auth.js', e);
  });
overrideDialogs();

async function initAppName(){
  try{
    await initFirebase();
  }catch(e){
    return;
  }
  try{
    const doc = await db.collection('Variablesglobales').doc('Parametros').get();
    if(doc.exists && doc.data().Aplicacion){
      appName = doc.data().Aplicacion;
    }
  }catch(e){
    console.error('Error obteniendo nombre de la app', e);
  }
}


function ensureInternalTransactionNotifierScript(){
  if(!hasWindow() || typeof document === 'undefined') return;
  if(window.internalTransactionNotifier) return;
  if(document.querySelector('script[data-internal-transaction-notifier]')) return;
  const script = document.createElement('script');
  script.src = 'js/internalTransactionNotifier.js';
  script.async = false;
  script.dataset.internalTransactionNotifier = 'true';
  document.head.appendChild(script);
}

function overrideDialogs(){
  if(!hasWindow() || typeof document === 'undefined') return;
  window.nativeDialogs = {
    alert: nativeAlert,
    confirm: nativeConfirm,
    prompt: nativePrompt
  };

  const ensureStyles = () => {
    if(document.getElementById('global-dialog-styles')) return;
    const style = document.createElement('style');
    style.id = 'global-dialog-styles';
    style.textContent = `
      .global-dialog-overlay{position:fixed;inset:0;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,0.55);z-index:12000;padding:16px;}
      .global-dialog-card{background:#0f172a;color:#e2e8f0;border-radius:16px;box-shadow:0 20px 45px rgba(0,0,0,0.35);width:min(480px,100%);border:1px solid #334155;overflow:hidden;font-family:'Poppins',sans-serif;}
      .global-dialog-header{background:linear-gradient(135deg,#9333ea,#2563eb);padding:14px 18px;color:#fff;display:flex;align-items:center;gap:10px;}
      .global-dialog-header h3{margin:0;font-size:1.1rem;letter-spacing:0.02em;}
      .global-dialog-body{padding:18px;font-size:0.95rem;line-height:1.5;color:#cbd5e1;}
      .global-dialog-body p{margin:0;white-space:pre-wrap;}
      .global-dialog-input{width:100%;padding:10px 12px;border-radius:10px;border:1px solid #334155;background:#0b1224;color:#e2e8f0;margin-top:12px;font-size:0.95rem;box-sizing:border-box;}
      .global-dialog-actions{display:flex;justify-content:flex-end;gap:10px;padding:0 18px 16px;}
      .global-dialog-btn{border:none;border-radius:999px;padding:10px 16px;font-weight:600;font-size:0.95rem;cursor:pointer;transition:transform 0.15s ease,box-shadow 0.15s ease;}
      .global-dialog-btn:focus{outline:2px solid #a855f7;outline-offset:2px;}
      .global-dialog-btn.primary{background:linear-gradient(135deg,#22c55e,#16a34a);color:#0b1224;box-shadow:0 10px 25px rgba(34,197,94,0.35);}
      .global-dialog-btn.secondary{background:#1f2937;color:#e2e8f0;border:1px solid #334155;}
      .global-dialog-btn:hover{transform:translateY(-1px);}
      @media (max-width:480px){.global-dialog-card{border-radius:12px;}.global-dialog-header{padding:12px 14px;}.global-dialog-actions{padding:0 14px 12px;}}
    `;
    document.head.appendChild(style);
  };

  const ensureDialog = () => {
    ensureStyles();
    let overlay = document.querySelector('.global-dialog-overlay');
    if(overlay) return overlay;
    overlay = document.createElement('div');
    overlay.className = 'global-dialog-overlay';
    overlay.setAttribute('role','dialog');
    overlay.setAttribute('aria-modal','true');

    const card = document.createElement('div');
    card.className = 'global-dialog-card';

    const header = document.createElement('div');
    header.className = 'global-dialog-header';
    const titleEl = document.createElement('h3');
    header.appendChild(titleEl);

    const body = document.createElement('div');
    body.className = 'global-dialog-body';
    const messageEl = document.createElement('p');
    const inputEl = document.createElement('input');
    inputEl.className = 'global-dialog-input';
    inputEl.type = 'text';
    inputEl.style.display = 'none';
    body.appendChild(messageEl);
    body.appendChild(inputEl);

    const actions = document.createElement('div');
    actions.className = 'global-dialog-actions';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'global-dialog-btn secondary';
    cancelBtn.textContent = 'Cancelar';
    const acceptBtn = document.createElement('button');
    acceptBtn.className = 'global-dialog-btn primary';
    acceptBtn.textContent = 'Aceptar';
    actions.appendChild(cancelBtn);
    actions.appendChild(acceptBtn);

    card.appendChild(header);
    card.appendChild(body);
    card.appendChild(actions);
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    return overlay;
  };

  const showDialog = (options) => {
    const {
      message = '',
      type = 'alert',
      placeholder = 'Escribe tu respuesta',
      defaultValue = '',
      acceptText = 'Aceptar',
      cancelText = 'Cancelar',
      title = appName
    } = options;

    const overlay = ensureDialog();
    if(!overlay){
      const fallback = type === 'confirm' ? nativeConfirm : type === 'prompt' ? nativePrompt : nativeAlert;
      return Promise.resolve(fallback ? fallback(message) : undefined);
    }

    const card = overlay.querySelector('.global-dialog-card');
    const titleEl = overlay.querySelector('.global-dialog-header h3');
    const messageEl = overlay.querySelector('.global-dialog-body p');
    const inputEl = overlay.querySelector('.global-dialog-input');
    const [cancelBtn, acceptBtn] = overlay.querySelectorAll('.global-dialog-btn');

    titleEl.textContent = title || appName;
    messageEl.textContent = message;
    acceptBtn.textContent = acceptText;
    cancelBtn.textContent = cancelText;
    inputEl.style.display = type === 'prompt' ? 'block' : 'none';
    inputEl.value = defaultValue || '';
    inputEl.placeholder = placeholder;
    cancelBtn.style.display = type === 'alert' ? 'none' : 'inline-flex';
    overlay.style.display = 'flex';
    overlay.dataset.type = type;
    overlay.focus();

    const focusTarget = type === 'prompt' ? inputEl : (type === 'alert' ? acceptBtn : cancelBtn);
    setTimeout(()=>{ focusTarget.focus(); }, 30);

    return new Promise(resolve => {
      const cleanup = () => {
        overlay.style.display = 'none';
        overlay.dataset.type = '';
        overlay.onclick = null;
        document.removeEventListener('keydown', onKeyDown);
        acceptBtn.onclick = null;
        cancelBtn.onclick = null;
      };

      const close = (value) => {
        cleanup();
        resolve(value);
      };

      const onKeyDown = (ev) => {
        if(ev.key === 'Escape'){
          ev.preventDefault();
          if(type === 'alert') close(undefined);
          else close(type === 'prompt' ? null : false);
        }
        if(ev.key === 'Enter'){
          if(document.activeElement === cancelBtn) return;
          ev.preventDefault();
          acceptBtn.click();
        }
      };

      overlay.onclick = (e)=>{ if(e.target === overlay) close(type === 'alert' ? undefined : type === 'prompt' ? null : false); };
      acceptBtn.onclick = ()=>{ const val = type === 'prompt' ? inputEl.value : true; close(val); };
      cancelBtn.onclick = ()=> close(type === 'prompt' ? null : false);
      document.addEventListener('keydown', onKeyDown);
    }).then(val => {
      if(type === 'confirm') return !!val;
      if(type === 'alert') return undefined;
      return val;
    });
  };

  window.alert = (message) => showDialog({ message, type: 'alert' });
  window.confirm = (message) => showDialog({ message, type: 'confirm' });
  window.prompt = (message, def = '') => showDialog({ message, type: 'prompt', defaultValue: def });
  window.modalDialogs = { alert: window.alert, confirm: window.confirm, prompt: window.prompt };
}

async function loginGoogle(){
  try {
    await initFirebase();
  } catch(initErr){
    console.error('No se pudo inicializar Firebase', initErr);
    alert(buildFirebaseInitializationErrorMessage(initErr));
    return;
  }
  if(!isGoogleAuthEnabled()){
    alert('Google no está habilitado para esta aplicación. Actívalo en Firebase Authentication > Sign-in method o ajusta la configuración publicada.');
    return;
  }
  try {
    if(provider && provider.setCustomParameters){
      provider.setCustomParameters({ prompt: 'select_account' });
    }
    await auth.signInWithPopup(provider);
  } catch(err) {
    if (err.code === 'auth/user-disabled') {
      alert(DISABLED_MSG);
      return;
    }
    console.warn('Popup login failed, trying redirect', err);
    try {
      await auth.signInWithRedirect(provider);
    } catch(e){
      console.error('Error login Google', e);
      alert(buildFirebaseAuthErrorMessage(e, 'Google'));
    }
  }
}

async function loginApple(){
  try {
    await initFirebase();
  } catch(initErr){
    console.error('No se pudo inicializar Firebase', initErr);
    alert(buildFirebaseInitializationErrorMessage(initErr));
    return;
  }
  if(!isAppleAuthEnabled()){
    alert('Apple no está habilitado para esta aplicación. Si desean usar ese botón, actívenlo en Firebase Authentication > Sign-in method y publíquenlo en la configuración del sitio.');
    return;
  }
  try{
    await auth.signInWithPopup(appleProvider);
  }catch(err){
    if (err.code === 'auth/user-disabled') {
      alert(DISABLED_MSG);
      return;
    }
    console.warn('Popup login failed, trying redirect', err);
    try{
      await auth.signInWithRedirect(appleProvider);
    }catch(e){
      console.error('Error login Apple', e);
      alert(buildFirebaseAuthErrorMessage(e, 'Apple'));
    }
  }
}

function logout(){
  stopAdminSessionWatcher();
  if(hasWindow() && window.sessionStorage){
    try{ window.sessionStorage.removeItem(STRONG_AUTH_SESSION_KEY); }
    catch(error){ console.warn('No se pudo limpiar el estado de reautenticación', error); }
  }
  auth.signOut();
}

async function handleRedirect(){
  try {
    await initFirebase();
  }catch(initErr){
    console.error('No se pudo inicializar Firebase al procesar el inicio de sesión con redirección', initErr);
    return;
  }
  try {
    const result = await auth.getRedirectResult();
    if(result.user){
      const { role, exists } = await getUserRole(result.user);
      if(exists === false && role === 'Jugador'){
        window.location.href = 'registrarse.html';
        return;
      }
      redirectByRole(role);
    }
  } catch(err){
    if (err?.code) alert(buildFirebaseAuthErrorMessage(err, 'el proveedor configurado'));
    console.error('Error processing redirect login', err);
  }
}

async function getUserRole(user){
  try{
    await initFirebase();
  }catch(e){
    console.error('No se pudo inicializar Firebase al obtener el rol de usuario', e);
    throw e;
  }

  try{
    const token = await user.getIdTokenResult(true);
    const claims = token?.claims || {};
    const roleFromClaim = resolveRoleFromClaims(claims);
    if(roleFromClaim){
      return { role: roleFromClaim, exists: true };
    }
  }catch(e){
    console.error('No se pudieron leer los custom claims del usuario', e);
  }

  try{
    const emailId = (user?.email || '').trim().toLowerCase();
    if(!emailId){
      return { role: 'Jugador', exists: false };
    }
    const ref = db.collection('users').doc(emailId);
    const doc = await ref.get();
    if(!doc.exists){
      return { role: 'Jugador', exists: false };
    }
    const data = doc.data() || {};
    const rolPersistente = normalizeRole(data.role) || 'Jugador';

    if(rolPersistente && user && (rolPersistente === 'Superadmin' || rolPersistente === 'Administrador' || rolPersistente === 'Colaborador')){
      const resincronizacion = await intentarResincronizarClaims(user, rolPersistente);
      if(resincronizacion.ok){
        try{
          const tokenActualizado = await user.getIdTokenResult(true);
          const claimsActualizados = tokenActualizado?.claims || {};
          if(claimIncluyeRol(claimsActualizados, rolPersistente)){
            return { role: rolPersistente, exists: true };
          }
        }catch(syncErr){
          console.warn('Se intentó revalidar claims luego de resincronizar, pero falló la lectura del token', syncErr);
        }
      }else if(resincronizacion.reason){
        console.warn('La resincronización automática no se pudo completar', resincronizacion.reason);
      }
    }

    return { role: rolPersistente, exists: true };
  }catch(e){
    console.error('No se pudo leer el perfil de usuario para determinar su rol', e);
    return {
      role: 'Jugador',
      exists: null,
      readError: true,
      errorCode: e?.code || null
    };
  }
}

async function getRoleConsistencyDiagnosis(user, options = {}){
  const { forceRefreshToken = true, allowClaimsResync = true } = options;
  if(!user){
    return {
      ok: false,
      code: 'NO_AUTH',
      message: 'No hay sesión autenticada para validar permisos operativos.'
    };
  }

  let claimsRole = null;
  let claims = {};
  let claimsReadErrorCode = null;
  try{
    const token = await user.getIdTokenResult(forceRefreshToken);
    claims = token?.claims || {};
    claimsRole = resolveRoleFromClaims(claims);
  }catch(error){
    claimsReadErrorCode = error?.code || null;
  }

  const emailId = (user?.email || '').trim().toLowerCase();
  if(!emailId){
    return {
      ok: false,
      code: 'MISSING_EMAIL',
      claimsRole,
      message: 'La sesión no tiene correo asociado. No se pueden validar permisos operativos.'
    };
  }

  try{
    const doc = await db.collection('users').doc(emailId).get();
    if(!doc.exists){
      return {
        ok: false,
        code: 'USER_DOC_NOT_FOUND',
        claimsRole,
        userDocRole: null,
        message: `No existe users/${emailId}. Debe crearse y asignar rol operativo antes de continuar.`
      };
    }
    const userDocRole = normalizeRole(doc.data()?.role) || 'Jugador';
    if(claimsReadErrorCode){
      return {
        ok: false,
        code: 'CLAIMS_READ_ERROR',
        claimsRole,
        userDocRole,
        message: 'No se pudo leer el token de sesión para validar permisos operativos.',
        errorCode: claimsReadErrorCode
      };
    }
    if(isPrivilegedRole(claimsRole) || isPrivilegedRole(userDocRole)){
      const claimsCompatiblesConRol = claimIncluyeRol(claims, userDocRole);
      if(!claimsCompatiblesConRol){
        if(allowClaimsResync && isPrivilegedRole(userDocRole)){
          const resincronizacion = await intentarResincronizarClaims(user, userDocRole);
          if(resincronizacion.ok){
            try{
              const tokenActualizado = await user.getIdTokenResult(true);
              const claimsActualizados = tokenActualizado?.claims || {};
              if(claimIncluyeRol(claimsActualizados, userDocRole)){
                return {
                  ok: true,
                  code: 'CLAIMS_RESYNC',
                  claimsRole: resolveRoleFromClaims(claimsActualizados) || userDocRole,
                  userDocRole
                };
              }
            }catch(syncErr){
              console.warn('No se pudo validar claims luego de resincronización automática en diagnóstico de rol', syncErr);
            }
          }else{
            const configMessage = buildResyncFailureMessage(resincronizacion.reason);
            if(configMessage){
              return {
                ok: false,
                code: 'INCOMPLETE_BACKEND_CONFIG',
                claimsRole,
                userDocRole,
                syncFailureReason: resincronizacion.reason,
                message: configMessage
              };
            }
          }
        }
        const result = {
          ok: false,
          code: 'ROLE_MISMATCH',
          claimsRole,
          userDocRole
        };
        return {
          ...result,
          message: buildRoleConsistencyMessage(result)
        };
      }
    }
    return {
      ok: true,
      code: null,
      claimsRole: claimsRole || (claimIncluyeRol(claims, userDocRole) ? userDocRole : null),
      userDocRole
    };
  }catch(error){
    return {
      ok: false,
      code: 'USER_DOC_READ_ERROR',
      claimsRole,
      message: 'No se pudo leer users/{email} para validar permisos operativos.',
      errorCode: error?.code || null
    };
  }
}

function resolverApiBaseParaClaims(){
  if(!hasWindow()){
    return {
      ok: false,
      code: 'NO_WINDOW',
      apiBase: '',
      source: null
    };
  }
  const configuredEndpoint =
    typeof window.UPLOAD_ENDPOINT === 'string' && window.UPLOAD_ENDPOINT.trim()
      ? window.UPLOAD_ENDPOINT.trim()
      : '';
  const runtimeEndpoint =
    typeof getAppRuntimeSettings().uploadEndpoint === 'string'
      ? getAppRuntimeSettings().uploadEndpoint.trim()
      : '';
  const endpoint = configuredEndpoint || runtimeEndpoint;
  if(endpoint){
    return {
      ok: true,
      code: null,
      apiBase: endpoint.replace(/\/upload\/?$/, ''),
      source: configuredEndpoint ? 'UPLOAD_ENDPOINT' : 'runtime.uploadEndpoint'
    };
  }
  return {
    ok: false,
    code: 'MISSING_UPLOAD_ENDPOINT',
    apiBase: '',
    source: null
  };
}


function getAdminApiBase(){
  const resolution = resolverApiBaseParaClaims();
  return resolution.ok ? resolution.apiBase : '';
}

function getOrCreateSuperadminDeviceId(){
  if(!hasWindow() || !window.localStorage) return `fallback-${Date.now()}`;
  try{
    const existing = window.localStorage.getItem(SUPERADMIN_DEVICE_KEY);
    if(existing) return existing;
    const candidate = (window.crypto && window.crypto.randomUUID)
      ? window.crypto.randomUUID()
      : `device-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    window.localStorage.setItem(SUPERADMIN_DEVICE_KEY, candidate);
    return candidate;
  }catch(error){
    console.warn('No se pudo persistir el deviceId de superadmin', error);
    return `fallback-${Date.now()}`;
  }
}

async function postToAdminEndpoint(path, user, payload = {}){
  if(!user || typeof fetch !== 'function') return null;
  const apiBase = getAdminApiBase();
  if(!apiBase) return null;
  const token = await user.getIdToken(true);
  const response = await fetch(`${apiBase}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify(payload)
  });
  if(!response.ok){
    throw new Error(`HTTP ${response.status} en ${path}`);
  }
  return response.json();
}

async function registrarSesionSuperadmin(user, motivo = 'login'){
  if(!user) return;
  try{
    const deviceId = getOrCreateSuperadminDeviceId();
    await postToAdminEndpoint('/admin/session/register', user, { deviceId, motivo });
  }catch(error){
    console.warn('No se pudo registrar sesión administrativa activa', error);
  }
}

async function auditarAccesoParametros(user, motivo = 'acceso_parametros'){
  if(!hasWindow() || !user) return;
  const pathname = window.location?.pathname || '';
  if(!pathname.endsWith('/parametros.html') && !pathname.endsWith('parametros.html')) return;
  const auditKey = `${user.uid}:${motivo}`;
  if(lastAuditStamp === auditKey) return;
  try{
    await postToAdminEndpoint('/admin/audit/parametros', user, { motivo });
    lastAuditStamp = auditKey;
  }catch(error){
    console.warn('No se pudo registrar auditoría de acceso a parámetros', error);
  }
}

function stopAdminSessionWatcher(){
  if(adminSessionWatcher){
    clearInterval(adminSessionWatcher);
    adminSessionWatcher = null;
  }
}

function startAdminSessionWatcher(){
  stopAdminSessionWatcher();
  adminSessionWatcher = setInterval(async ()=>{
    const user = auth?.currentUser;
    if(!user) return;
    try{
      const deviceId = getOrCreateSuperadminDeviceId();
      const response = await postToAdminEndpoint('/admin/session/status', user, { deviceId });
      if(response && response.valid === false){
        await auditarAccesoParametros(user, 'sesion_reemplazada_logout_forzado');
        await window.alert('Tu sesión de Superadmin fue reemplazada por un nuevo inicio en otro dispositivo.');
        logout();
      }
    }catch(error){
      console.warn('No se pudo validar el estado de sesión administrativa', error);
    }
  }, 60000);
}


async function intentarResincronizarClaims(user, roleExpected){
  if(!user || !roleExpected || !hasWindow() || typeof fetch !== 'function'){
    return { ok: false, reason: 'INVALID_INPUT', status: null };
  }
  const apiBaseResolution = resolverApiBaseParaClaims();
  if(!apiBaseResolution.ok){
    return {
      ok: false,
      reason: apiBaseResolution.code || 'INCOMPLETE_BACKEND_CONFIG',
      status: null
    };
  }

  try{
    const token = await user.getIdToken(true);
    const response = await fetch(`${apiBaseResolution.apiBase}/syncClaims`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ roleExpected })
    });
    if(!response.ok){
      console.warn('No se pudo resincronizar custom claims automáticamente', response.status);
      return { ok: false, reason: `HTTP_${response.status}`, status: response.status };
    }
    return { ok: true, reason: null, status: response.status };
  }catch(error){
    console.warn('Falló la resincronización automática de custom claims', error);
    return { ok: false, reason: 'NETWORK_ERROR', status: null };
  }
}

function redirectByRole(role){
  switch(normalizeRole(role)){
    case 'Colaborador':
      window.location.href = 'collab.html';
      break;
    case 'Administrador':
      window.location.href = 'admin.html';
      break;
    case 'Superadmin':
      window.location.href = 'super.html';
      break;
    default:
      window.location.href = 'player.html';
  }
}

function setupSuperadminExit(buttonSelector = '#salir-super-btn', redirect = 'super.html'){
  if(!hasWindow()) return;
  initFirebase()
    .then(()=>{
      const button = typeof buttonSelector === 'string' ? document.querySelector(buttonSelector) : buttonSelector;
      if(!button) return;
      if(button.dataset.superExitReady === 'true') return;
      button.dataset.superExitReady = 'true';
      const bindRedirect = ()=>{
        if(button.dataset.superExitBound === 'true') return;
        button.addEventListener('click', ()=>{ window.location.href = redirect; });
        button.dataset.superExitBound = 'true';
      };
      auth.onAuthStateChanged(async user=>{
        if(!user){
          button.style.display = 'none';
          return;
        }
        try{
          const { role } = await getUserRole(user);
          if(role === 'Superadmin'){
            bindRedirect();
            button.style.display = 'flex';
            button.style.backgroundColor = '#d32f2f';
            button.style.borderColor = 'orange';
          }else{
            button.style.display = 'none';
          }
        }catch(err){
          console.error('No se pudo determinar si el usuario es Superadmin', err);
        }
      });
    })
    .catch(err=>{
      console.error('No se pudo configurar el botón de retorno a Superadmin', err);
    });
}

function ensureAuth(roleExpected){
  const rolesEsperados = (Array.isArray(roleExpected) ? roleExpected : (roleExpected ? [roleExpected] : []))
    .map(normalizeRole)
    .filter(Boolean);
  const requiereValidacionConsistencia = rolesEsperados.some(isPrivilegedRole);
  initFirebase()
    .then(() => {
      auth.onAuthStateChanged(async user => {
        if(!user){
          if(window.notificationCenter && typeof window.notificationCenter.desvincularUsuario === 'function'){
            try{ window.notificationCenter.desvincularUsuario(); }
            catch(err){ console.error('No se pudo desvincular el centro de notificaciones', err); }
          }
          stopAdminSessionWatcher();
          window.location.href='index.html';
          return;
        }
        const { role, exists } = await getUserRole(user);
        if(exists === false && role === 'Jugador'){
          window.location.href = 'registrarse.html';
          return;
        }
        if(rolesEsperados.length && !rolesEsperados.some(rol => roleEquals(rol, role)) && !roleEquals(role, 'Superadmin')){
          redirectByRole(role);
          return;
        }
        if(requiereValidacionConsistencia){
          const diagnosticoRol = await getRoleConsistencyDiagnosis(user, { forceRefreshToken: true });
          if(!diagnosticoRol.ok){
            if(hasWindow()){
              window.__AUTH_ROLE_CONSISTENCY__ = diagnosticoRol;
              window.__AUTH_SENSITIVE_OPS_BLOCKED__ = true;
            }
            const logoutCritico = diagnosticoRol.code === 'NO_AUTH'
              || diagnosticoRol.code === 'MISSING_EMAIL'
              || isInvalidOrExpiredTokenError(diagnosticoRol.errorCode);
            const degradacionRecuperable = isRecoverableRoleConsistencyError(diagnosticoRol.code)
              && hasValidUserDocRoleForRecovery(diagnosticoRol);

            if(logoutCritico){
              alert(`Acceso administrativo bloqueado. ${diagnosticoRol.message}`);
              logout();
              return;
            }

            if(degradacionRecuperable){
              const mensajeGuiado = `Acceso administrativo restringido. ${diagnosticoRol.message}\n\n¿Deseas reintentar sincronización ahora?\n- Aceptar: reintentar sincronización\n- Cancelar: continuar en modo restringido`;
              const reintentar = nativeConfirm ? nativeConfirm(mensajeGuiado) : false;
              if(reintentar){
                const reintentoDiagnostico = await getRoleConsistencyDiagnosis(user, { forceRefreshToken: true, allowClaimsResync: true });
                if(reintentoDiagnostico.ok){
                  if(hasWindow()){
                    window.__AUTH_ROLE_CONSISTENCY__ = reintentoDiagnostico;
                    window.__AUTH_SENSITIVE_OPS_BLOCKED__ = false;
                  }
                }else{
                  if(hasWindow()){
                    window.__AUTH_ROLE_CONSISTENCY__ = reintentoDiagnostico;
                    window.__AUTH_SENSITIVE_OPS_BLOCKED__ = true;
                  }
                  if(nativeAlert){
                    nativeAlert('Continuas en modo restringido. Solicita resincronización manual del rol antes de ejecutar operaciones sensibles.');
                  }
                }
              }else if(nativeAlert){
                nativeAlert('Continuas en modo restringido. Las operaciones sensibles permanecerán bloqueadas hasta sincronizar tu rol.');
              }
            }else{
              alert(`Acceso administrativo restringido. ${diagnosticoRol.message}`);
            }
          }
          if(hasWindow() && diagnosticoRol.ok){
            window.__AUTH_ROLE_CONSISTENCY__ = diagnosticoRol;
            window.__AUTH_SENSITIVE_OPS_BLOCKED__ = false;
          }
        }
        window.currentRole = role;
        if(roleEquals(role, 'Superadmin')){
          await registrarSesionSuperadmin(user, 'login_or_refresh');
          startAdminSessionWatcher();
          await auditarAccesoParametros(user, 'acceso_parametros');
        }else{
          stopAdminSessionWatcher();
        }
        const nombreVisible = (user.displayName && user.displayName.trim()) ? user.displayName : (user.email || '');
        const nameEl = document.getElementById('user-name');
        if (nameEl) nameEl.textContent = nombreVisible;
        const emailEl = document.getElementById('user-email');
        if (emailEl) emailEl.textContent = user.email;
        const picEl = document.getElementById('user-pic');
        if (picEl) {
          if (typeof asignarFotoUsuario === 'function') {
            asignarFotoUsuario(picEl, user.photoURL || '');
          } else {
            picEl.src = user.photoURL || picEl.src;
          }
        }
        const infoEl = document.getElementById('session-info');
        if (infoEl) infoEl.style.display = 'flex';
        const logoutEl = document.getElementById('logout-link');
        if (logoutEl) {
          logoutEl.addEventListener('click', e => {
            e.preventDefault();
            logout();
          });
        }
        startUserStatusWatcher();
        if(window.notificationCenter && typeof window.notificationCenter.vincularUsuario === 'function'){
          try{ window.notificationCenter.vincularUsuario(user, role); }
          catch(err){ console.error('No se pudo vincular el centro de notificaciones', err); }
        }
      });
    })
    .catch(err => {
      console.error('No se pudo iniciar la autenticación', err);
      alert(buildFirebaseInitializationErrorMessage(err));
      if(hasWindow()){
        window.location.href = 'index.html';
      }
    });
}

function claimIncluyeRol(claims, role){
  if(!claims || !role) return false;
  if(claims.admin === true) return true;
  if(roleEquals(claims.role, role)) return true;
  if(Array.isArray(claims.roles) && claims.roles.some(claimRole => roleEquals(claimRole, role))) return true;
  return false;
}

async function verificarRolFuerte(roleExpected = 'Superadmin', options = {}){
  const { forceRefresh = true } = options;
  await initFirebase();
  const user = auth.currentUser;
  if(!user){
    return { ok: false, reason: 'NO_AUTH', claims: null, user: null };
  }
  let claims = {};
  try{
    const tokenResult = await user.getIdTokenResult(forceRefresh);
    claims = tokenResult?.claims || {};
  }catch(error){
    console.warn('No se pudo leer el ID token para validar rol fuerte, se intentará con resincronización de claims.', error);
  }
  if(claimIncluyeRol(claims, roleExpected)){
    return { ok: true, reason: null, claims, user };
  }

  try{
    const resincronizacion = await intentarResincronizarClaims(user, roleExpected);
    if(!resincronizacion.ok){
      return { ok: false, reason: resincronizacion.reason || 'CLAIMS_RESYNC_FAILED', claims, user };
    }
    const tokenPostSync = await user.getIdTokenResult(true);
    const claimsPostSync = tokenPostSync?.claims || {};
    if(claimIncluyeRol(claimsPostSync, roleExpected)){
      return { ok: true, reason: 'CLAIMS_RESYNC', claims: claimsPostSync, user };
    }
  }catch(error){
    console.warn('No fue posible resincronizar custom claims para validación fuerte.', error);
  }

  return { ok: false, reason: 'MISSING_CLAIM', claims, user };
}

async function reautenticarConPopup(){
  await initFirebase();
  const user = auth.currentUser;
  if(!user){
    throw new Error('Usuario no autenticado');
  }

  const providerId = user.providerData?.[0]?.providerId;
  let providerInstance = null;
  if(providerId === 'google.com'){
    providerInstance = new firebase.auth.GoogleAuthProvider();
  }else if(providerId === 'apple.com'){
    providerInstance = new firebase.auth.OAuthProvider('apple.com');
    providerInstance.addScope('email');
    providerInstance.addScope('name');
  }

  if(!providerInstance || typeof user.reauthenticateWithPopup !== 'function'){
    throw new Error('Proveedor no soportado para reautenticación con popup');
  }
  await user.reauthenticateWithPopup(providerInstance);
  registrarReautenticacionReciente(user);
  await registrarSesionSuperadmin(user, 'reauth');
}

function registrarReautenticacionReciente(user = auth?.currentUser){
  if(!hasWindow() || !window.sessionStorage || !user?.uid) return;
  try{
    window.sessionStorage.setItem(STRONG_AUTH_SESSION_KEY, JSON.stringify({
      uid: user.uid,
      timestamp: Date.now()
    }));
  }catch(error){
    console.warn('No se pudo registrar la reautenticación reciente', error);
  }
}

function tieneReautenticacionReciente(options = {}){
  const { maxAgeMs = 10 * 60 * 1000, incluirMetadata = true } = options;
  const user = auth?.currentUser;
  if(!user) return false;

  if(hasWindow() && window.sessionStorage){
    try{
      const raw = window.sessionStorage.getItem(STRONG_AUTH_SESSION_KEY);
      if(raw){
        const parsed = JSON.parse(raw);
        if(parsed?.uid === user.uid && Number.isFinite(parsed?.timestamp)){
          if((Date.now() - parsed.timestamp) <= maxAgeMs){
            return true;
          }
        }
      }
    }catch(error){
      console.warn('No se pudo leer el estado de reautenticación reciente', error);
    }
  }

  if(!incluirMetadata) return false;
  const lastSignIn = user?.metadata?.lastSignInTime ? Date.parse(user.metadata.lastSignInTime) : NaN;
  if(Number.isFinite(lastSignIn)){
    return (Date.now() - lastSignIn) <= maxAgeMs;
  }

  return false;
}

let statusWatcher = null;
function startUserStatusWatcher(){
  if(statusWatcher) return;
  statusWatcher = setInterval(async ()=>{
    const u = auth.currentUser;
    if(!u) return;
    try{
      await u.reload();
    }catch(e){
      if(e.code === 'auth/user-disabled'){
        alert(DISABLED_MSG);
        logout();
      }
    }
  },60000);
}

if (typeof module !== "undefined") { module.exports = { getUserRole, getRoleConsistencyDiagnosis, isRecoverableRoleConsistencyError, redirectByRole, ensureAuth, setupSuperadminExit, verificarRolFuerte, reautenticarConPopup, registrarReautenticacionReciente, tieneReautenticacionReciente, isGoogleAuthEnabled, isAppleAuthEnabled, getAuthorizedDomains, isCurrentDomainPublished, getPublishedProviderLabels, describePublishedProviders, buildFirebaseAuthErrorMessage }; }
