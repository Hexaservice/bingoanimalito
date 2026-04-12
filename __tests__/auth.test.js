function setupWindow(){
  const sessionStore = {};
  global.window = {
    location: { href: 'index.html', origin: 'https://app.test', hostname: 'app.test' },
    firebaseConfig: { projectId: 'demo-test' },
    alert: () => {},
    confirm: () => true,
    prompt: () => '',
    sessionStorage: {
      setItem: (key, value) => { sessionStore[key] = String(value); },
      getItem: (key) => Object.prototype.hasOwnProperty.call(sessionStore, key) ? sessionStore[key] : null,
      removeItem: (key) => { delete sessionStore[key]; }
    }
  };
  global.alert = global.window.alert;
  global.confirm = global.window.confirm;
  global.prompt = global.window.prompt;
  global.document = {
    getElementById: () => null,
    querySelector: () => null
  };
}

function cleanup(){
  delete global.window;
  delete global.document;
  delete global.alert;
  delete global.confirm;
  delete global.prompt;
  delete global.firebase;
  jest.resetModules();
  jest.clearAllMocks();
}

function buildFirebaseMock({ userExists = false, role = 'Jugador', userReadError = null } = {}){
  const userDoc = userExists
    ? { exists: true, data: () => ({ role }) }
    : { exists: false, data: () => ({}) };

  return {
    apps: [],
    initializeApp: jest.fn(() => ({})),
    app: jest.fn(() => ({})),
    firestore: jest.fn(() => ({
      collection: jest.fn((name) => {
        if(name === 'Variablesglobales'){
          return { doc: jest.fn(() => ({ get: jest.fn(async () => ({ exists: false, data: () => ({}) })) })) };
        }
        if(name === 'users'){
          return {
            doc: jest.fn(() => ({
              get: jest.fn(async () => {
                if(userReadError){
                  throw userReadError;
                }
                return userDoc;
              })
            }))
          };
        }
        return { doc: jest.fn(() => ({ get: jest.fn(async () => ({ exists: false, data: () => ({}) })) })) };
      })
    })),
    auth: Object.assign(
      jest.fn(() => ({
        setPersistence: jest.fn(async () => undefined),
        onAuthStateChanged: jest.fn(),
        getRedirectResult: jest.fn(async () => ({})),
        signOut: jest.fn(async () => undefined)
      })),
      {
        GoogleAuthProvider: function(){ this.setCustomParameters = jest.fn(); },
        OAuthProvider: function(){ this.addScope = jest.fn(); },
        Auth: { Persistence: { LOCAL: 'local' } }
      }
    )
  };
}

describe('auth.js', () => {
  afterEach(cleanup);

  test('getUserRole retorna Jugador y exists=false cuando el usuario no existe', async () => {
    setupWindow();
    global.firebase = buildFirebaseMock({ userExists: false });

    let getUserRole;
    jest.isolateModules(() => {
      ({ getUserRole } = require('../public/js/auth.js'));
    });

    const fakeUser = {
      email: 'nuevo@correo.com',
      getIdTokenResult: jest.fn(async () => ({ claims: {} }))
    };

    await expect(getUserRole(fakeUser)).resolves.toEqual({ role: 'Jugador', exists: false });
  });

  test('getUserRole no interpreta un error de lectura como usuario inexistente', async () => {
    setupWindow();
    global.firebase = buildFirebaseMock({
      userReadError: Object.assign(new Error('Missing or insufficient permissions.'), {
        code: 'permission-denied'
      })
    });

    let getUserRole;
    jest.isolateModules(() => {
      ({ getUserRole } = require('../public/js/auth.js'));
    });

    const fakeUser = {
      email: 'bloqueado@correo.com',
      getIdTokenResult: jest.fn(async () => ({ claims: {} }))
    };

    await expect(getUserRole(fakeUser)).resolves.toEqual({
      role: 'Jugador',
      exists: null,
      readError: true,
      errorCode: 'permission-denied'
    });
  });

  test('getUserRole prioriza custom claim role cuando existe', async () => {
    setupWindow();
    global.firebase = buildFirebaseMock({ userExists: true, role: 'Jugador' });

    let getUserRole;
    jest.isolateModules(() => {
      ({ getUserRole } = require('../public/js/auth.js'));
    });

    const fakeUser = {
      email: 'admin@correo.com',
      getIdTokenResult: jest.fn(async () => ({ claims: { role: 'Administrador' } }))
    };

    await expect(getUserRole(fakeUser)).resolves.toEqual({ role: 'Administrador', exists: true });
  });

  test('redirectByRole redirige según rol', () => {
    setupWindow();
    global.firebase = buildFirebaseMock();

    let redirectByRole;
    jest.isolateModules(() => {
      ({ redirectByRole } = require('../public/js/auth.js'));
    });

    redirectByRole('Colaborador');
    expect(window.location.href).toBe('collab.html');

    redirectByRole('Administrador');
    expect(window.location.href).toBe('admin.html');

    redirectByRole('Superadmin');
    expect(window.location.href).toBe('super.html');

    redirectByRole('RolX');
    expect(window.location.href).toBe('player.html');
  });

  test('getUserRole intenta resincronizar claims cuando el rol persistente es administrativo', async () => {
    setupWindow();
    window.UPLOAD_ENDPOINT = 'https://api.test/upload';
    window.fetch = jest.fn(async () => ({ ok: true, status: 200 }));
    global.fetch = window.fetch;
    global.firebase = buildFirebaseMock({ userExists: true, role: 'Superadmin' });

    let getUserRole;
    jest.isolateModules(() => {
      ({ getUserRole } = require('../public/js/auth.js'));
    });

    const fakeUser = {
      email: 'superadmin@correo.com',
      getIdToken: jest.fn(async () => 'token-demo'),
      getIdTokenResult: jest
        .fn()
        .mockResolvedValueOnce({ claims: {} })
        .mockResolvedValueOnce({ claims: { role: 'Superadmin', roles: ['Superadmin'] } })
    };

    await expect(getUserRole(fakeUser)).resolves.toEqual({ role: 'Superadmin', exists: true });
    expect(window.fetch).toHaveBeenCalledWith(
      'https://api.test/syncClaims',
      expect.objectContaining({ method: 'POST' })
    );
  });

  test('getRoleConsistencyDiagnosis reporta desalineación entre claims y users/{email}.role', async () => {
    setupWindow();
    global.firebase = buildFirebaseMock({ userExists: true, role: 'Jugador' });

    let getRoleConsistencyDiagnosis;
    jest.isolateModules(() => {
      ({ getRoleConsistencyDiagnosis } = require('../public/js/auth.js'));
    });

    const fakeUser = {
      email: 'admin@correo.com',
      getIdTokenResult: jest.fn(async () => ({ claims: { role: 'Administrador' } }))
    };

    await expect(getRoleConsistencyDiagnosis(fakeUser)).resolves.toEqual(
      expect.objectContaining({
        ok: false,
        code: 'ROLE_MISMATCH',
        claimsRole: 'Administrador',
        userDocRole: 'Jugador'
      })
    );
  });

  test('getRoleConsistencyDiagnosis intenta resincronizar claims antes de bloquear acceso administrativo', async () => {
    setupWindow();
    window.UPLOAD_ENDPOINT = 'https://api.test/upload';
    window.fetch = jest.fn(async () => ({ ok: true, status: 200 }));
    global.fetch = window.fetch;
    global.firebase = buildFirebaseMock({ userExists: true, role: 'Superadmin' });

    let getRoleConsistencyDiagnosis;
    jest.isolateModules(() => {
      ({ getRoleConsistencyDiagnosis } = require('../public/js/auth.js'));
    });

    const fakeUser = {
      email: 'superadmin@correo.com',
      getIdToken: jest.fn(async () => 'token-demo'),
      getIdTokenResult: jest
        .fn()
        .mockResolvedValueOnce({ claims: {} })
        .mockResolvedValueOnce({ claims: { role: 'Superadmin', roles: ['Superadmin'], admin: true } })
    };

    await expect(getRoleConsistencyDiagnosis(fakeUser)).resolves.toEqual({
      ok: true,
      code: 'CLAIMS_RESYNC',
      claimsRole: 'Superadmin',
      userDocRole: 'Superadmin'
    });
    expect(window.fetch).toHaveBeenCalledWith(
      'https://api.test/syncClaims',
      expect.objectContaining({ method: 'POST' })
    );
  });

  test('verificarRolFuerte falla cuando no hay custom claims válidos', async () => {
    setupWindow();
    window.UPLOAD_ENDPOINT = 'https://api.test/upload';
    window.fetch = jest.fn(async () => ({ ok: false, status: 500 }));
    global.fetch = window.fetch;
    global.firebase = buildFirebaseMock({ userExists: true, role: 'superadmin' });

    let verificarRolFuerte;
    jest.isolateModules(() => {
      ({ verificarRolFuerte } = require('../public/js/auth.js'));
    });

    const fakeUser = {
      email: 'superadmin@correo.com',
      getIdToken: jest.fn(async () => 'token-demo'),
      getIdTokenResult: jest.fn(async () => ({ claims: {} }))
    };

    const authFactory = global.firebase.auth;
    authFactory.mockImplementation(() => ({
      setPersistence: jest.fn(async () => undefined),
      onAuthStateChanged: jest.fn(),
      getRedirectResult: jest.fn(async () => ({})),
      currentUser: fakeUser
    }));

    await expect(verificarRolFuerte('Superadmin', { forceRefresh: true })).resolves.toEqual(
      expect.objectContaining({ ok: false, reason: 'HTTP_500' })
    );
  });

  test('getRoleConsistencyDiagnosis muestra diagnóstico explícito cuando falta UPLOAD_ENDPOINT', async () => {
    setupWindow();
    global.firebase = buildFirebaseMock({ userExists: true, role: 'Superadmin' });

    let getRoleConsistencyDiagnosis;
    jest.isolateModules(() => {
      ({ getRoleConsistencyDiagnosis } = require('../public/js/auth.js'));
    });

    const fakeUser = {
      email: 'superadmin@correo.com',
      getIdToken: jest.fn(async () => 'token-demo'),
      getIdTokenResult: jest.fn(async () => ({ claims: {} }))
    };

    await expect(getRoleConsistencyDiagnosis(fakeUser)).resolves.toEqual(
      expect.objectContaining({
        ok: false,
        code: 'INCOMPLETE_BACKEND_CONFIG',
        syncFailureReason: 'MISSING_UPLOAD_ENDPOINT',
        message: 'No se puede resincronizar claims porque falta configuración del backend'
      })
    );
  });
  test('tieneReautenticacionReciente retorna true cuando existe registro reciente en sessionStorage', async () => {
    setupWindow();
    global.firebase = buildFirebaseMock();

    const fakeUser = {
      uid: 'uid-demo',
      metadata: { lastSignInTime: '2000-01-01T00:00:00.000Z' }
    };

    const authFactory = global.firebase.auth;
    authFactory.mockImplementation(() => ({
      setPersistence: jest.fn(async () => undefined),
      onAuthStateChanged: jest.fn(),
      getRedirectResult: jest.fn(async () => ({})),
      currentUser: fakeUser
    }));

    let registrarReautenticacionReciente, tieneReautenticacionReciente;
    jest.isolateModules(() => {
      ({ registrarReautenticacionReciente, tieneReautenticacionReciente } = require('../public/js/auth.js'));
    });

    await new Promise(resolve => setTimeout(resolve, 0));

    registrarReautenticacionReciente(fakeUser);
    expect(tieneReautenticacionReciente({ maxAgeMs: 60 * 1000, incluirMetadata: false })).toBe(true);
  });

  test('tieneReautenticacionReciente retorna false cuando no hay sesión reciente', async () => {
    setupWindow();
    global.firebase = buildFirebaseMock();

    const fakeUser = {
      uid: 'uid-demo-2',
      metadata: { lastSignInTime: '2000-01-01T00:00:00.000Z' }
    };

    const authFactory = global.firebase.auth;
    authFactory.mockImplementation(() => ({
      setPersistence: jest.fn(async () => undefined),
      onAuthStateChanged: jest.fn(),
      getRedirectResult: jest.fn(async () => ({})),
      currentUser: fakeUser
    }));

    let tieneReautenticacionReciente;
    jest.isolateModules(() => {
      ({ tieneReautenticacionReciente } = require('../public/js/auth.js'));
    });

    await new Promise(resolve => setTimeout(resolve, 0));

    expect(tieneReautenticacionReciente({ maxAgeMs: 60 * 1000 })).toBe(false);
  });

  test('isAppleAuthEnabled retorna false por defecto e isGoogleAuthEnabled true', () => {
    setupWindow();
    global.firebase = buildFirebaseMock();

    let isAppleAuthEnabled, isGoogleAuthEnabled;
    jest.isolateModules(() => {
      ({ isAppleAuthEnabled, isGoogleAuthEnabled } = require('../public/js/auth.js'));
    });

    expect(isAppleAuthEnabled()).toBe(false);
    expect(isGoogleAuthEnabled()).toBe(true);
  });

  test('lee providers y dominios autorizados publicados en window.__FIREBASE_AUTH_SETTINGS__', () => {
    setupWindow();
    window.__FIREBASE_AUTH_SETTINGS__ = {
      providers: { google: true, apple: true },
      authorizedDomains: ['app.test', 'staging.app.test']
    };
    global.firebase = buildFirebaseMock();

    let isAppleAuthEnabled, getAuthorizedDomains, isCurrentDomainPublished, describePublishedProviders;
    jest.isolateModules(() => {
      ({ isAppleAuthEnabled, getAuthorizedDomains, isCurrentDomainPublished, describePublishedProviders } = require('../public/js/auth.js'));
    });

    expect(isAppleAuthEnabled()).toBe(true);
    expect(getAuthorizedDomains()).toEqual(['app.test', 'staging.app.test']);
    expect(isCurrentDomainPublished()).toBe(true);
    expect(describePublishedProviders()).toBe('Google y Apple');
  });

  test('buildFirebaseAuthErrorMessage describe unauthorized-domain con el host actual y dominios publicados', () => {
    setupWindow();
    window.__FIREBASE_AUTH_SETTINGS__ = {
      providers: { google: true, apple: false },
      authorizedDomains: ['app.test', 'staging.app.test']
    };
    global.firebase = buildFirebaseMock();

    let buildFirebaseAuthErrorMessage;
    jest.isolateModules(() => {
      ({ buildFirebaseAuthErrorMessage } = require('../public/js/auth.js'));
    });

    const mensaje = buildFirebaseAuthErrorMessage({ code: 'auth/unauthorized-domain' }, 'Google');
    expect(mensaje).toMatch(/app\.test/);
    expect(mensaje).toMatch(/Authorized domains/);
    expect(mensaje).toMatch(/staging\.app\.test/);
  });

  test('ensureAuth mantiene sesión y activa modo restringido ante ROLE_MISMATCH recuperable', async () => {
    setupWindow();
    window.confirm = () => false;
    window.UPLOAD_ENDPOINT = 'https://api.test/upload';
    window.fetch = jest.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    global.fetch = window.fetch;
    global.firebase = buildFirebaseMock({ userExists: true, role: 'Superadmin' });

    const authMock = {
      setPersistence: jest.fn(async () => undefined),
      onAuthStateChanged: jest.fn(),
      getRedirectResult: jest.fn(async () => ({})),
      signOut: jest.fn(async () => undefined),
      currentUser: null
    };
    global.firebase.auth.mockImplementation(() => authMock);

    let ensureAuth;
    jest.isolateModules(() => {
      ({ ensureAuth } = require('../public/js/auth.js'));
    });

    const fakeUser = {
      uid: 'uid-role-mismatch',
      email: 'superadmin@correo.com',
      getIdTokenResult: jest.fn(async () => ({ claims: { role: 'Administrador' } }))
    };

    ensureAuth('Administrador');
    await new Promise(resolve => setTimeout(resolve, 0));
    const authStateHandler = authMock.onAuthStateChanged.mock.calls.at(-1)?.[0];
    await authStateHandler(fakeUser);

    expect(authMock.signOut).not.toHaveBeenCalled();
    expect(window.__AUTH_SENSITIVE_OPS_BLOCKED__).toBe(true);
    expect(window.__AUTH_ROLE_CONSISTENCY__).toEqual(expect.objectContaining({ code: 'ROLE_MISMATCH' }));
  });

  test('ensureAuth hace logout cuando el token es inválido/expirado', async () => {
    setupWindow();
    global.firebase = buildFirebaseMock({ userExists: true, role: 'Superadmin' });

    const authMock = {
      setPersistence: jest.fn(async () => undefined),
      onAuthStateChanged: jest.fn(),
      getRedirectResult: jest.fn(async () => ({})),
      signOut: jest.fn(async () => undefined),
      currentUser: null
    };
    global.firebase.auth.mockImplementation(() => authMock);

    let ensureAuth;
    jest.isolateModules(() => {
      ({ ensureAuth } = require('../public/js/auth.js'));
    });

    const fakeUser = {
      uid: 'uid-token-expirado',
      email: 'superadmin@correo.com',
      getIdTokenResult: jest.fn(async () => {
        const error = new Error('Token expirado');
        error.code = 'auth/id-token-expired';
        throw error;
      })
    };

    ensureAuth('Superadmin');
    await new Promise(resolve => setTimeout(resolve, 0));
    const authStateHandler = authMock.onAuthStateChanged.mock.calls.at(-1)?.[0];
    await authStateHandler(fakeUser);

    expect(authMock.signOut).toHaveBeenCalledTimes(1);
    expect(window.__AUTH_SENSITIVE_OPS_BLOCKED__).toBe(true);
  });

  test('ensureAuth desbloquea operaciones tras sync de claims exitoso', async () => {
    setupWindow();
    window.UPLOAD_ENDPOINT = 'https://api.test/upload';
    window.fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    global.fetch = window.fetch;
    global.firebase = buildFirebaseMock({ userExists: true, role: 'Superadmin' });

    const authMock = {
      setPersistence: jest.fn(async () => undefined),
      onAuthStateChanged: jest.fn(),
      getRedirectResult: jest.fn(async () => ({})),
      signOut: jest.fn(async () => undefined),
      currentUser: null
    };
    global.firebase.auth.mockImplementation(() => authMock);

    let ensureAuth;
    jest.isolateModules(() => {
      ({ ensureAuth } = require('../public/js/auth.js'));
    });

    const fakeUser = {
      uid: 'uid-sync-ok',
      email: 'superadmin@correo.com',
      getIdToken: jest.fn(async () => 'token-demo'),
      getIdTokenResult: jest.fn()
    };
    fakeUser.getIdTokenResult
      .mockResolvedValueOnce({ claims: {} })
      .mockResolvedValue({ claims: { role: 'Superadmin', roles: ['Superadmin'], admin: true } });

    ensureAuth('Superadmin');
    await new Promise(resolve => setTimeout(resolve, 0));
    const authStateHandler = authMock.onAuthStateChanged.mock.calls.at(-1)?.[0];
    await authStateHandler(fakeUser);

    expect(window.fetch).toHaveBeenCalledWith(
      'https://api.test/syncClaims',
      expect.objectContaining({ method: 'POST' })
    );
    expect(window.__AUTH_SENSITIVE_OPS_BLOCKED__).toBe(false);
    expect(authMock.signOut).not.toHaveBeenCalled();
  });

});
