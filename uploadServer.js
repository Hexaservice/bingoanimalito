require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { buildRoleClaims, buildUserProfileUpdate } = require('./lib/roleProvisioning');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs/promises');
const admin = require('firebase-admin');
const EstadosPagoPremio = require('./public/js/estadoPagoPremio.js');
const { isSorteoEligibleForAutoPrize } = require('./public/js/sorteoAutoPrizeEligibility.js');
const { construirEventoGanadorIdCanonico } = require('./lib/premiosPendientesIds');
const {
  buildBilleteraIdentity,
  normalizeIdentityValue,
  looksLikeEmailIdentity
} = require('./public/js/billeteraIdentity.js');

const requiredEnv = ['GOOGLE_APPLICATION_CREDENTIALS', 'FIREBASE_STORAGE_BUCKET'];

function getMissingRequiredEnv(env = process.env) {
  return requiredEnv.filter((name) => !env[name]);
}

function validateRequiredEnv(env = process.env) {
  const missingRequiredEnv = getMissingRequiredEnv(env);
  if (missingRequiredEnv.length > 0) {
    console.error(
      `Faltan variables de entorno requeridas para uploadServer: ${missingRequiredEnv.join(', ')}`
    );
    process.exit(1);
  }
}

function initializeFirebase() {
  if (!admin.apps.length) {
    admin.initializeApp({
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET
    });
  }
}

const app = express();

const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000,http://127.0.0.1:3000')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(helmet());
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: Number(process.env.RATE_LIMIT_MAX_REQUESTS || 300),
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Demasiadas solicitudes, intenta más tarde' }
  })
);
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error('Origen no permitido por CORS'));
    }
  })
);
app.use(express.json());

const ALLOWED_FILE_TYPES = {
  '.png': ['image/png'],
  '.jpg': ['image/jpeg'],
  '.jpeg': ['image/jpeg'],
  '.pdf': ['application/pdf']
};
const LOTERIAS_SOURCE_OF_TRUTH = Object.freeze({
  collection: 'loterias',
  fields: ['id', 'nombre', 'estado', 'jerarquia', 'imagen']
});
const dangerousNamePattern = /(^\.+$|\.\.|[\\/]|[\x00-\x1F\x7F])/;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: Number(process.env.MAX_UPLOAD_FILE_SIZE_BYTES || 5 * 1024 * 1024),
    files: 1
  },
  fileFilter(req, file, callback) {
    const extension = path.extname(file.originalname || '').toLowerCase();
    const allowedMimeTypes = ALLOWED_FILE_TYPES[extension];

    if (!allowedMimeTypes || !allowedMimeTypes.includes(file.mimetype)) {
      return callback(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'file'));
    }

    if (dangerousNamePattern.test(file.originalname) || path.basename(file.originalname) !== file.originalname) {
      return callback(new Error('Nombre de archivo inválido'));
    }

    return callback(null, true);
  }
});

function registrarAuditoria({ email, fileType, result, reason }) {
  console.info(
    JSON.stringify({
      event: 'upload_audit',
      userEmail: email || 'desconocido',
      timestamp: new Date().toISOString(),
      fileType: fileType || 'desconocido',
      result,
      reason: reason || null
    })
  );
}

function hashValue(value) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  const salt = process.env.ADMIN_SESSION_HASH_SALT || 'bingo-admin-session';
  return crypto.createHash('sha256').update(`${salt}:${normalized}`).digest('hex');
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function getAuthTimeFromToken(decodedToken) {
  const iat = Number(decodedToken?.iat || 0);
  return Number.isFinite(iat) && iat > 0 ? iat * 1000 : Date.now();
}

async function deleteCollectionBySorteoId({ db, collectionName, sorteoId, pageSize = 200 }) {
  let deleted = 0;

  while (true) {
    const snapshot = await db
      .collection(collectionName)
      .where('sorteoId', '==', sorteoId)
      .limit(pageSize)
      .get();

    if (snapshot.empty) {
      break;
    }

    const batch = db.batch();
    snapshot.docs.forEach((doc) => {
      batch.delete(doc.ref);
    });

    await batch.commit();
    deleted += snapshot.size;
  }

  return deleted;
}

async function countCollectionBySorteoId({ db, collectionName, sorteoId, pageSize = 400 }) {
  let count = 0;
  let lastDoc = null;

  while (true) {
    let query = db
      .collection(collectionName)
      .where('sorteoId', '==', sorteoId)
      .orderBy('__name__')
      .limit(pageSize);

    if (lastDoc) {
      query = query.startAfter(lastDoc);
    }

    const snapshot = await query.get();
    if (snapshot.empty) {
      break;
    }

    count += snapshot.size;
    lastDoc = snapshot.docs[snapshot.docs.length - 1];

    if (snapshot.size < pageSize) {
      break;
    }
  }

  return count;
}

async function deleteDocumentById({ db, collectionName, docId }) {
  const ref = db.collection(collectionName).doc(docId);
  const snapshot = await ref.get();

  if (!snapshot.exists) {
    return 0;
  }

  await ref.delete();
  return 1;
}

async function countDocumentById({ db, collectionName, docId }) {
  const ref = db.collection(collectionName).doc(docId);
  const snapshot = await ref.get();
  return snapshot.exists ? 1 : 0;
}

async function getPurgeCounts({ db, sorteoId, dryRun }) {
  return {
    CartonJugado: dryRun
      ? await countCollectionBySorteoId({ db, collectionName: 'CartonJugado', sorteoId })
      : await deleteCollectionBySorteoId({ db, collectionName: 'CartonJugado', sorteoId }),
    ConsecutivosCarton: dryRun
      ? await countDocumentById({ db, collectionName: 'ConsecutivosCarton', docId: sorteoId })
      : await deleteDocumentById({ db, collectionName: 'ConsecutivosCarton', docId: sorteoId }),
    SorteosCentroPagos: dryRun
      ? await countDocumentById({ db, collectionName: 'SorteosCentroPagos', docId: sorteoId })
      : await deleteDocumentById({ db, collectionName: 'SorteosCentroPagos', docId: sorteoId }),
    cantos: dryRun
      ? await countDocumentById({ db, collectionName: 'cantos', docId: sorteoId })
      : await deleteDocumentById({ db, collectionName: 'cantos', docId: sorteoId }),
    cantarsorteos: dryRun
      ? await countDocumentById({ db, collectionName: 'cantarsorteos', docId: sorteoId })
      : await deleteDocumentById({ db, collectionName: 'cantarsorteos', docId: sorteoId }),
    formas: dryRun
      ? await countCollectionBySorteoId({ db, collectionName: 'formas', sorteoId })
      : await deleteCollectionBySorteoId({ db, collectionName: 'formas', sorteoId }),
    GanadoresSorteosTiempoReal: dryRun
      ? await countCollectionBySorteoId({ db, collectionName: 'GanadoresSorteosTiempoReal', sorteoId })
      : await deleteCollectionBySorteoId({ db, collectionName: 'GanadoresSorteosTiempoReal', sorteoId }),
    sorteos: dryRun
      ? await countDocumentById({ db, collectionName: 'sorteos', docId: sorteoId })
      : await deleteDocumentById({ db, collectionName: 'sorteos', docId: sorteoId })
  };
}

async function validarUsuarioSuperadmin(decodedToken) {
  const email = decodedToken?.email;
  if (!email) {
    return { ok: false, status: 401, body: { error: 'Token sin correo asociado' } };
  }

  try {
    const doc = await admin.firestore().collection('users').doc(email).get();
    const role = doc.exists ? doc.data().role : undefined;
    if (role !== 'Superadmin') {
      return { ok: false, status: 403, body: { error: 'Acceso restringido a Superadmin' } };
    }
    return { ok: true, email, role };
  } catch (error) {
    console.error('Error validando usuario superadmin', error);
    return { ok: false, status: 500, body: { error: 'Error verificando permisos', message: error.message } };
  }
}

async function verificarToken(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const match = authHeader.match(/^Bearer (.+)$/);
  if (!match) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(match[1]);
  } catch (e) {
    console.error('Error verificando token', e);
    return res.status(401).json({ error: 'Token inválido' });
  }

  const email = decoded.email;
  if (!email) {
    return res.status(401).json({ error: 'Token sin correo asociado' });
  }

  try {
    const doc = await admin.firestore().collection('users').doc(email).get();
    const role = doc.exists ? doc.data().role : undefined;
    if (!['Superadmin', 'Administrador'].includes(role)) {
      return res.status(403).json({ error: 'Acceso restringido a roles administrativos' });
    }
    req.user = { uid: decoded.uid, email, role };
    next();
  } catch (e) {
    console.error('Error obteniendo el rol del usuario', e);
    return res.status(500).json({ error: 'Error verificando permisos', message: e.message });
  }
}

async function verificarOperadorPrivilegiado(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const match = authHeader.match(/^Bearer (.+)$/);
  if (!match) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(match[1]);
  } catch (e) {
    console.error('Error verificando token', e);
    return res.status(401).json({ error: 'Token inválido' });
  }

  const email = decoded.email;
  if (!email) {
    return res.status(401).json({ error: 'Token sin correo asociado' });
  }

  try {
    const doc = await admin.firestore().collection('users').doc(email).get();
    const role = doc.exists ? doc.data().role : undefined;
    if (!['Superadmin', 'Administrador', 'Colaborador'].includes(role)) {
      return res.status(403).json({ error: 'Acceso restringido a operadores autorizados' });
    }
    req.user = { uid: decoded.uid, email, role };
    next();
  } catch (e) {
    console.error('Error obteniendo el rol del usuario', e);
    return res.status(500).json({ error: 'Error verificando permisos', message: e.message });
  }
}

function normalizeString(value, maxLength = 200) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function normalizeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function normalizePendingPrizeState(value) {
  return normalizeString(value, 40).toLowerCase();
}

function getLegacyDirectPrizeRefFromPendingRef(premioRef) {
  const billeteraRef = premioRef?.parent?.parent;
  if (!billeteraRef || typeof billeteraRef.collection !== 'function') return null;
  return billeteraRef.collection('premiosPagosdirectos').doc(premioRef.id);
}

function buildReconciledPrizeTransactionId(premioId) {
  const normalized = normalizeString(premioId, 320).toLowerCase();
  const digest = crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 32);
  return `premio_reconciliado_${digest}`;
}

async function reconcileSinglePendingPrize({
  db,
  premioDoc,
  sorteoId,
  acreditadoPor,
  origen
}) {
  const premioId = normalizeString(premioDoc.id, 320).toLowerCase();
  if (!premioId) {
    return { status: 'omitido', reason: 'premio_id_invalido' };
  }

  const transaccionId = buildReconciledPrizeTransactionId(premioId);
  const transaccionRef = db.collection('transacciones').doc(transaccionId);

  return db.runTransaction(async (tx) => {
    const premioSnap = await tx.get(premioDoc.ref);
    if (!premioSnap.exists) {
      return { status: 'omitido', reason: 'premio_no_existe', premioId };
    }

    const premioData = premioSnap.data() || {};
    const sorteoPremio = normalizeString(premioData.sorteoId, 120);
    if (!sorteoPremio || sorteoPremio !== sorteoId) {
      return { status: 'omitido', reason: 'sorteo_distinto', premioId };
    }

    const estadoActual = normalizePendingPrizeState(premioData.estado || 'pendiente');
    const creditos = Math.max(0, normalizeNumber(premioData.creditos));
    const cartones = Math.max(
      0,
      normalizeNumber(premioData.cartonesGratis ?? premioData.cartones)
    );

    const transaccionPorPremioQuery = db
      .collection('transacciones')
      .where('premioId', '==', premioId)
      .limit(1);
    const legacyPremioRef = getLegacyDirectPrizeRefFromPendingRef(premioDoc.ref);

    const [walletSnap, transaccionIdSnap, transaccionPorPremioSnap] = await Promise.all([
      tx.get(premioDoc.ref.parent.parent),
      tx.get(transaccionRef),
      tx.get(transaccionPorPremioQuery)
    ]);

    const transaccionExistente = transaccionIdSnap.exists || !transaccionPorPremioSnap.empty;
    const yaAcreditado = estadoActual === 'acreditado';

    if (yaAcreditado || transaccionExistente) {
      if (!yaAcreditado) {
        tx.set(
          premioDoc.ref,
          {
            estado: 'acreditado',
            acreditadoEn: premioData.acreditadoEn || admin.firestore.FieldValue.serverTimestamp(),
            acreditadoPor: premioData.acreditadoPor || acreditadoPor,
            origen: premioData.origen || origen,
            reconciliadoEn: admin.firestore.FieldValue.serverTimestamp(),
            reconciliadoPor: acreditadoPor
          },
          { merge: true }
        );
        if (legacyPremioRef) {
          tx.set(
            legacyPremioRef,
            {
              estado: 'acreditado',
              acreditadoEn: premioData.acreditadoEn || admin.firestore.FieldValue.serverTimestamp(),
              acreditadoPor: premioData.acreditadoPor || acreditadoPor,
              origen: premioData.origen || origen,
              reconciliadoEn: admin.firestore.FieldValue.serverTimestamp(),
              reconciliadoPor: acreditadoPor
            },
            { merge: true }
          );
        }
      }
      return { status: 'omitido', reason: 'ya_acreditado', premioId };
    }

    if (estadoActual !== 'pendiente') {
      return { status: 'omitido', reason: 'estado_no_pendiente', premioId };
    }

    const billeteraRef = premioDoc.ref.parent.parent;
    const billeteraData = walletSnap.exists ? walletSnap.data() || {} : {};
    const saldoActual = normalizeNumber(billeteraData.creditos);
    const cartonesActuales = normalizeNumber(
      billeteraData.CartonesGratis ?? billeteraData.cartonesGratis
    );

    tx.set(
      billeteraRef,
      {
        creditos: saldoActual + creditos,
        CartonesGratis: cartonesActuales + cartones,
        actualizadoEn: admin.firestore.FieldValue.serverTimestamp()
      },
      { merge: true }
    );

    tx.set(
      premioDoc.ref,
      {
        estado: 'acreditado',
        acreditadoEn: admin.firestore.FieldValue.serverTimestamp(),
        acreditadoPor,
        origen,
        reconciliadoEn: admin.firestore.FieldValue.serverTimestamp(),
        reconciliadoPor: acreditadoPor
      },
      { merge: true }
    );
    if (legacyPremioRef) {
      tx.set(
        legacyPremioRef,
        {
          estado: 'acreditado',
          acreditadoEn: admin.firestore.FieldValue.serverTimestamp(),
          acreditadoPor,
          origen,
          reconciliadoEn: admin.firestore.FieldValue.serverTimestamp(),
          reconciliadoPor: acreditadoPor
        },
        { merge: true }
      );
    }

    tx.set(
      transaccionRef,
      {
        tipotrans: 'premio',
        origen: 'premios_pendientes_reconciliados',
        estado: 'APROBADO',
        premioId,
        sorteoId,
        IDbilletera: billeteraRef.id,
        Monto: creditos,
        cartonesGratis: cartones,
        referencia: 'PREMIO_RECONCILIADO',
        usuariogestor: acreditadoPor,
        rolusuario: 'sistema',
        creadoEn: admin.firestore.FieldValue.serverTimestamp(),
        actualizadoEn: admin.firestore.FieldValue.serverTimestamp()
      },
      { merge: false }
    );

    return { status: 'acreditado', premioId, creditos, cartones };
  });
}

async function reconcilePendingPrizesBySorteo({
  db,
  sorteoId,
  acreditadoPor = 'sistema:reconciliacion',
  origen = 'premios_pendientes_reconciliados',
  pageSize = 100
}) {
  const normalizedSorteoId = normalizeString(sorteoId, 120);
  if (!normalizedSorteoId) {
    throw new Error('sorteoId es obligatorio para reconciliar premios pendientes directos');
  }

  const summary = {
    sorteoId: normalizedSorteoId,
    revisados: 0,
    acreditados: 0,
    omitidos: 0,
    errores: 0
  };

  let lastDoc = null;
  while (true) {
    let query = db
      .collectionGroup('premiosPendientesDirectos')
      .where('sorteoId', '==', normalizedSorteoId)
      .orderBy('__name__')
      .limit(pageSize);
    if (lastDoc) query = query.startAfter(lastDoc);
    const snap = await query.get();
    if (snap.empty) break;

    for (const doc of snap.docs) {
      summary.revisados += 1;
      try {
        const result = await reconcileSinglePendingPrize({
          db,
          premioDoc: doc,
          sorteoId: normalizedSorteoId,
          acreditadoPor,
          origen
        });
        if (result?.status === 'acreditado') summary.acreditados += 1;
        else summary.omitidos += 1;
      } catch (error) {
        summary.errores += 1;
        console.error('[reconciliar-premios-pendientes-directos] error procesando premio', {
          premioId: doc.id,
          sorteoId: normalizedSorteoId,
          error: error?.message || error
        });
      }
    }

    lastDoc = snap.docs[snap.docs.length - 1];
    if (snap.size < pageSize) break;
  }

  return summary;
}

function buildPremioDocId({ sorteoId, formaIdx, cartonId, prefijo = '' }) {
  const sanitize = (value) => normalizeString(String(value || ''), 120).replace(/[^\w-]/g, '_');
  const baseId = `${sanitize(sorteoId)}__f${sanitize(formaIdx)}__${sanitize(cartonId)}`;
  return prefijo ? `${sanitize(prefijo)}__${baseId}` : baseId;
}

function extractEventoGanadorIdComponents(eventoGanadorId) {
  const normalized = normalizeString(eventoGanadorId, 220);
  if (!normalized) return null;

  const [, maybePrefijo = '', maybeSorteoId = '', maybeForma = '', maybeCartonId = ''] = normalized.match(/^(?:([^_]+?)__)?(.+?)__f([^_]+?)__(.+)$/) || [];
  const parsedFormaIdx = Number(maybeForma);

  if (!maybeSorteoId || !maybeCartonId || !Number.isFinite(parsedFormaIdx)) {
    return null;
  }

  return {
    prefijo: maybePrefijo,
    segundoLugar: maybePrefijo.toLowerCase() === 'segundo',
    sorteoId: maybeSorteoId,
    formaIdx: parsedFormaIdx,
    cartonId: maybeCartonId
  };
}

function normalizeCartonWinnerKey(cartonData = {}) {
  const userId = normalizeString(cartonData?.userId || cartonData?.usuarioId, 160).toLowerCase();
  const cartonNum = Number(
    cartonData?.cartonNum
    ?? cartonData?.Ncarton
    ?? cartonData?.numero
    ?? cartonData?.numeroCarton
  );
  if (userId && Number.isFinite(cartonNum)) {
    return `usr:${userId}::num:${cartonNum}`;
  }
  const cartonId = normalizeString(cartonData?.id, 200);
  if (cartonId) return `id:${cartonId}`;
  return '';
}

function buildOfficialPendingPrizeId(eventoGanadorId) {
  const normalized = normalizeString(eventoGanadorId, 320).toLowerCase();
  const digest = crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 40);
  return `ppd_${digest}`;
}

function computeWinnerPrizeAmounts(forma = {}, totalGanadores = 1) {
  const rawCredito = Number(forma?.valorPremio ?? forma?.premio ?? forma?.monto ?? forma?.creditos ?? 0);
  const creditosBase = Number.isFinite(rawCredito) ? Math.max(0, rawCredito) : 0;
  const total = Math.max(1, Number(totalGanadores) || 1);
  const creditos = creditosBase / total;
  const cartonesBaseRaw = Number(forma?.cartonesGratis ?? 0);
  const cartonesPorGanadorRaw = Number(forma?.cartonesGratisPorGanador);
  const cartonesBase = Number.isFinite(cartonesBaseRaw) ? Math.max(0, cartonesBaseRaw) : 0;
  const cartonesPorGanador = Number.isFinite(cartonesPorGanadorRaw)
    ? Math.max(0, cartonesPorGanadorRaw)
    : null;
  // Convención oficial:
  // - cartonesGratisPorGanador: valor explícito por ganador (no se divide).
  // - cartonesGratis: total de la forma, se divide entre ganadores igual que créditos.
  const cartonesGratis = Math.max(
    0,
    cartonesPorGanador !== null
      ? cartonesPorGanador
      : (cartonesBase / total)
  );
  return {
    creditos: Number(creditos.toFixed(6)),
    cartonesGratis: Number(cartonesGratis.toFixed(6))
  };
}

async function generatePendingDirectPrizesFromOfficialResults({
  db,
  sorteoId,
  generadoPor = 'sistema:premios-oficiales'
}) {
  const normalizedSorteoId = normalizeString(sorteoId, 120);
  if (!normalizedSorteoId) {
    throw new Error('sorteoId es obligatorio');
  }

  const sorteoRef = db.collection('sorteos').doc(normalizedSorteoId);
  const sorteoSnap = await sorteoRef.get();
  if (!sorteoSnap.exists) {
    throw new Error(`No existe el sorteo ${normalizedSorteoId}`);
  }

  const sorteoData = sorteoSnap.data() || {};
  const lockRaw = sorteoData?.ganadoresBloqueadosPorForma;
  const formas = Array.isArray(sorteoData?.formas) ? sorteoData.formas : [];
  if (!lockRaw || typeof lockRaw !== 'object') {
    return { sorteoId: normalizedSorteoId, evaluados: 0, creados: 0, duplicados: 0 };
  }

  const cartonesSnap = await db
    .collection('CartonJugado')
    .where('sorteoId', '==', normalizedSorteoId)
    .get();
  const cartonByWinnerKey = new Map();
  cartonesSnap.forEach((doc) => {
    const data = doc.data() || {};
    const key = normalizeCartonWinnerKey({ ...data, id: doc.id });
    if (key && !cartonByWinnerKey.has(key)) {
      cartonByWinnerKey.set(key, { id: doc.id, data });
    }
  });

  let evaluados = 0;
  let creados = 0;
  let duplicados = 0;
  let bloqueadosTotales = 0;

  for (const [idxRaw, lockValue] of Object.entries(lockRaw)) {
    const formaIdx = Number(idxRaw);
    if (!Number.isFinite(formaIdx)) continue;
    const cartonClaves = Array.isArray(lockValue?.cartonClaves)
      ? lockValue.cartonClaves.map((item) => normalizeString(item, 220)).filter(Boolean)
      : [];
    if (!cartonClaves.length) continue;
    bloqueadosTotales += cartonClaves.length;

    const forma = formas.find((item) => Number(item?.idx) === formaIdx) || {};
    const { creditos, cartonesGratis } = computeWinnerPrizeAmounts(forma, cartonClaves.length);

    for (const cartonClave of cartonClaves) {
      evaluados += 1;
      const carton = cartonByWinnerKey.get(cartonClave);
      if (!carton) continue;

      const winnerIdentity = await resolveWinnerIdentity({
        normalizedEmail: normalizeString(carton.data?.email || carton.data?.gmail, 160).toLowerCase(),
        normalizedUserId: normalizeString(carton.data?.userId || carton.data?.usuarioId, 160),
        cartonData: carton.data,
        loadUserById: async (id) => {
          if (!id) return null;
          const userSnap = await db.collection('users').doc(id).get();
          if (!userSnap.exists) return null;
          return { id: userSnap.id, data: userSnap.data() || {} };
        },
        loadUserByUid: async (uid) => {
          if (!uid) return null;
          const usersSnap = await db.collection('users').where('uid', '==', uid).limit(1).get();
          if (usersSnap.empty) return null;
          const userDoc = usersSnap.docs[0];
          return { id: userDoc.id, data: userDoc.data() || {} };
        }
      });
      const billeteraCandidates = Array.isArray(winnerIdentity?.billeteraCandidates)
        ? winnerIdentity.billeteraCandidates
        : [];
      const billeteraIdentity = buildBilleteraIdentity({
        email: winnerIdentity?.canonicalEmail,
        uid: winnerIdentity?.internalCandidates?.[0],
        extraCandidates: billeteraCandidates
      });
      const billeteraId = normalizeIdentityValue(billeteraIdentity.billeteraId, 160);
      if (!billeteraId) {
        console.info('[premios-directos-oficiales][control]', {
          sorteoId: normalizedSorteoId,
          evaluados,
          creados,
          duplicados,
          billeteraId: null,
          eventoGanadorId: null,
          estado: 'omitido_billetera_no_resuelta',
          billeteraCandidates
        });
        continue;
      }

      const eventoGanadorId = construirEventoGanadorIdCanonico({
        sorteoId: normalizedSorteoId,
        formaIdx,
        cartonClaveGanador: cartonClave,
        cartonId: normalizeString(carton.id, 180)
      });
      if (!eventoGanadorId) {
        console.info('[premios-directos-oficiales][control]', {
          sorteoId: normalizedSorteoId,
          evaluados,
          creados,
          duplicados,
          billeteraId,
          eventoGanadorId: null,
          estado: 'omitido_evento_ganador_invalido',
          billeteraCandidates: billeteraIdentity.billeteraCandidates
        });
        continue;
      }
      const premioId = buildOfficialPendingPrizeId(eventoGanadorId);
      const billeteraRef = db.collection('Billetera').doc(billeteraId);
      const premioRef = billeteraRef.collection('premiosPendientesDirectos').doc(premioId);
      const premioLegacyRef = billeteraRef.collection('premiosPagosdirectos').doc(premioId);

      const [premioSnap, duplicatedByEventSnap] = await Promise.all([
        premioRef.get(),
        billeteraRef
          .collection('premiosPendientesDirectos')
          .where('eventoGanadorId', '==', eventoGanadorId)
          .limit(1)
          .get()
      ]);
      if (premioSnap.exists || !duplicatedByEventSnap.empty) {
        duplicados += 1;
        console.info('[premios-directos-oficiales][control]', {
          sorteoId: normalizedSorteoId,
          evaluados,
          creados,
          duplicados,
          billeteraId,
          eventoGanadorId,
          estado: 'duplicado',
          billeteraCandidates: billeteraIdentity.billeteraCandidates
        });
        continue;
      }

      const payloadPremioPendiente = {
        premioId,
        clavePendiente: premioId,
        eventoGanadorId,
        idx: formaIdx,
        nombre: normalizeString(forma?.nombre, 160) || `Forma ${formaIdx}`,
        creditos,
        cartonesGratis,
        cartonClaveGanador: normalizeString(cartonClave, 220).toLowerCase(),
        cartonId: normalizeString(carton.id, 180),
        cartonLabel: normalizeString(
          carton.data?.cartonLabel || carton.data?.etiqueta || `${carton.data?.userId || ''} #${carton.data?.cartonNum ?? ''}`,
          180
        ),
        color: normalizeString(forma?.color, 40),
        sorteoId: normalizedSorteoId,
        estado: 'pendiente',
        origen: 'backend:resultados-oficiales',
        creadoEn: admin.firestore.FieldValue.serverTimestamp(),
        generadoPor: normalizeString(generadoPor, 160),
        ganadorLockCerradoEn: lockValue?.cerradoEn || null
      };
      await Promise.all([
        premioRef.set(payloadPremioPendiente, { merge: false }),
        premioLegacyRef.set(payloadPremioPendiente, { merge: true })
      ]);
      creados += 1;
      console.info('[premios-directos-oficiales][control]', {
        sorteoId: normalizedSorteoId,
        evaluados,
        creados,
        duplicados,
        billeteraId,
        eventoGanadorId,
        estado: 'creado',
        billeteraCandidates: billeteraIdentity.billeteraCandidates
      });
    }
  }

  console.info('[premios-directos-oficiales][resumen]', {
    sorteoId: normalizedSorteoId,
    evaluados,
    creados,
    duplicados,
    bloqueadosTotales
  });
  if (creados === 0 && bloqueadosTotales > 0) {
    console.warn('[premios-directos-oficiales][alerta-operativa] Sin premios creados con ganadores bloqueados', {
      sorteoId: normalizedSorteoId,
      evaluados,
      creados,
      duplicados,
      bloqueadosTotales
    });
  }

  return {
    sorteoId: normalizedSorteoId,
    evaluados,
    creados,
    duplicados,
    bloqueadosTotales
  };
}


function getAcreditacionExecutionMode({ source, origen, manualApproval, userRole }) {
  const normalizedSource = normalizeString(source, 120).toLowerCase();
  const normalizedOrigen = normalizeString(origen, 80).toLowerCase();
  const normalizedUserRole = normalizeString(userRole, 40).toLowerCase();
  const explicitManualApproval = manualApproval === true;
  const sourceRequestsManual = normalizedSource === 'centropagos/manual' || normalizedOrigen === 'centropagos/manual';
  const manualRequested = explicitManualApproval || sourceRequestsManual;
  const hasPrivilegedRole = ['superadmin', 'administrador', 'colaborador'].includes(normalizedUserRole);
  const manualAllowed = manualRequested && hasPrivilegedRole;

  return {
    mode: manualAllowed ? 'manual' : 'automatico',
    manualRequested,
    manualAllowed,
    hasPrivilegedRole
  };
}

function normalizePremioTransactionState(value) {
  return EstadosPagoPremio.normalizarLectura(value);
}

function getBilleteraCandidates({ userEmail, cartonData, payloadUserId }) {
  const values = [
    normalizeIdentityValue(userEmail, 160).toLowerCase(),
    normalizeIdentityValue(payloadUserId, 160),
    normalizeIdentityValue(cartonData?.email, 160).toLowerCase(),
    normalizeIdentityValue(cartonData?.gmail, 160).toLowerCase(),
    normalizeIdentityValue(cartonData?.IDbilletera, 160)
  ].filter(Boolean);
  return Array.from(new Set(values));
}

async function resolveWinnerIdentity({
  normalizedEmail,
  normalizedUserId,
  cartonData,
  loadUserById,
  loadUserByUid
}) {
  const cartonUserId = normalizeIdentityValue(cartonData?.userId || cartonData?.usuarioId, 160);
  const emailCandidates = [
    normalizeIdentityValue(normalizedEmail, 160).toLowerCase(),
    normalizeIdentityValue(cartonData?.email, 160).toLowerCase(),
    normalizeIdentityValue(cartonData?.gmail, 160).toLowerCase(),
    looksLikeEmailIdentity(cartonData?.IDbilletera) ? normalizeIdentityValue(cartonData?.IDbilletera, 160).toLowerCase() : ''
  ].filter(Boolean);
  const internalCandidates = [
    normalizeIdentityValue(normalizedUserId, 160),
    cartonUserId,
    looksLikeEmailIdentity(cartonData?.IDbilletera) ? '' : normalizeIdentityValue(cartonData?.IDbilletera, 160)
  ].filter(Boolean);

  const identities = [normalizeIdentityValue(normalizedUserId, 160), cartonUserId].filter(Boolean);
  for (const identity of identities) {
    if (looksLikeEmailIdentity(identity)) {
      emailCandidates.push(normalizeIdentityValue(identity, 160).toLowerCase());
      continue;
    }

    const directUser = await loadUserById(identity);
    if (directUser) {
      const emailByData = normalizeIdentityValue(directUser.data?.email || directUser.data?.gmail, 160).toLowerCase();
      if (emailByData) emailCandidates.push(emailByData);
      if (looksLikeEmailIdentity(directUser.id)) {
        emailCandidates.push(directUser.id.toLowerCase());
      } else if (directUser.id) {
        internalCandidates.push(normalizeIdentityValue(directUser.id, 160));
      }
      if (directUser.data?.uid) {
        internalCandidates.push(normalizeIdentityValue(directUser.data.uid, 160));
      }
    }

    const uidUser = await loadUserByUid(identity);
    if (uidUser) {
      const emailByData = normalizeIdentityValue(uidUser.data?.email || uidUser.data?.gmail, 160).toLowerCase();
      if (emailByData) emailCandidates.push(emailByData);
      if (looksLikeEmailIdentity(uidUser.id)) {
        emailCandidates.push(uidUser.id.toLowerCase());
      } else if (uidUser.id) {
        internalCandidates.push(normalizeIdentityValue(uidUser.id, 160));
      }
      if (uidUser.data?.uid) {
        internalCandidates.push(normalizeIdentityValue(uidUser.data.uid, 160));
      }
    }
  }

  const uniqueEmails = Array.from(new Set(emailCandidates.filter(Boolean)));
  const uniqueInternals = Array.from(new Set(internalCandidates.filter(Boolean)));
  const emailVisible = uniqueEmails[0] || '';
  const billeteraIdentity = buildBilleteraIdentity({
    email: emailVisible || normalizedEmail,
    uid: normalizedUserId || cartonUserId,
    extraCandidates: [
      ...getBilleteraCandidates({ userEmail: normalizedEmail, payloadUserId: normalizedUserId, cartonData }),
      ...uniqueInternals
    ]
  });

  return {
    emailVisible,
    canonicalEmail: billeteraIdentity.canonicalEmail || emailVisible,
    billeteraCandidates: billeteraIdentity.billeteraCandidates,
    billeteraId: billeteraIdentity.billeteraId,
    internalCandidates: uniqueInternals
  };
}

app.post('/toggleUser', verificarToken, async (req, res) => {
  const { email, disabled } = req.body || {};
  if (!email || typeof disabled !== 'boolean') {
    return res.status(400).json({ error: 'Datos inválidos' });
  }
  try {
    const user = await admin.auth().getUserByEmail(email);
    await admin.auth().updateUser(user.uid, { disabled });
    await admin.firestore().collection('users').doc(email).set({ disabled }, { merge: true });
    res.json({ status: 'ok' });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Error actualizando usuario', message: e.message });
    }
  }
});

app.post('/syncClaims', verificarToken, async (req, res) => {
  const email = req.user?.email;
  if (!email) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  try {
    const [profileDoc, userRecord] = await Promise.all([
      admin.firestore().collection('users').doc(email).get(),
      admin.auth().getUserByEmail(email)
    ]);

    const role = profileDoc.exists ? profileDoc.data()?.role : undefined;
    if (!role) {
      return res.status(400).json({ error: 'Rol no encontrado en el perfil del usuario' });
    }

    const nextClaims = {
      ...(userRecord.customClaims || {}),
      ...buildRoleClaims(role, { forceAdmin: role === 'Administrador' })
    };

    await admin.auth().setCustomUserClaims(userRecord.uid, nextClaims);

    const userProfileUpdate = buildUserProfileUpdate({
      email,
      uid: userRecord.uid,
      role,
      claims: nextClaims,
      managedBy: 'syncClaims-endpoint'
    });

    await admin.firestore().collection('users').doc(email).set({
      ...userProfileUpdate,
      authProviders: (userRecord.providerData || []).map(provider => provider.providerId).filter(Boolean),
      roleUpdatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    return res.json({ status: 'ok', role });
  } catch (e) {
    console.error('Error sincronizando custom claims', e);
    return res.status(500).json({ error: 'Error sincronizando custom claims', message: e.message });
  }
});

app.post('/admin/session/register', async (req, res) => {
  const authHeader = req.headers.authorization || '';
  const match = authHeader.match(/^Bearer (.+)$/);
  if (!match) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(match[1], true);
  } catch (error) {
    return res.status(401).json({ error: 'Token inválido' });
  }

  const validation = await validarUsuarioSuperadmin(decoded);
  if (!validation.ok) {
    return res.status(validation.status).json(validation.body);
  }

  const uid = decoded.uid;
  const userAgent = req.headers['user-agent'] || '';
  const ip = getClientIp(req);
  const deviceId = typeof req.body?.deviceId === 'string' && req.body.deviceId.trim()
    ? req.body.deviceId.trim().slice(0, 120)
    : null;

  if (!deviceId) {
    return res.status(400).json({ error: 'deviceId requerido' });
  }

  const sessionRef = admin.firestore().collection('adminSessions').doc(uid);
  const lastIssuedAt = getAuthTimeFromToken(decoded);
  const now = Date.now();

  let replaced = false;
  let invalidateBefore = null;
  let previousDeviceId = null;

  await admin.firestore().runTransaction(async (tx) => {
    const snapshot = await tx.get(sessionRef);
    const previous = snapshot.exists ? snapshot.data() : null;
    previousDeviceId = previous?.deviceId || null;
    replaced = Boolean(previous && previous.deviceId && previous.deviceId !== deviceId);
    invalidateBefore = replaced ? now : Number(previous?.invalidateBefore || 0);

    tx.set(sessionRef, {
      uid,
      lastIssuedAt,
      deviceId,
      ipHash: hashValue(ip),
      userAgentHash: hashValue(userAgent),
      invalidateBefore: invalidateBefore || 0,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  });

  if (replaced && process.env.ADMIN_SINGLE_DEVICE_MODE !== 'false') {
    try {
      await admin.auth().revokeRefreshTokens(uid);
    } catch (error) {
      console.error('No se pudieron revocar refresh tokens para superadmin', error);
    }
  }

  await admin.firestore().collection('adminAccessAudit').add({
    uid,
    email: validation.email,
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
    motivo: replaced ? 'new_session_replaced_previous' : 'new_session_registered',
    previousDeviceId,
    currentDeviceId: deviceId
  });

  return res.json({
    status: 'ok',
    replaced,
    invalidateBefore: invalidateBefore || 0
  });
});

app.post('/admin/session/status', async (req, res) => {
  const authHeader = req.headers.authorization || '';
  const match = authHeader.match(/^Bearer (.+)$/);
  if (!match) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(match[1], true);
  } catch (error) {
    return res.status(401).json({ error: 'Token inválido' });
  }

  const validation = await validarUsuarioSuperadmin(decoded);
  if (!validation.ok) {
    return res.status(validation.status).json(validation.body);
  }

  const uid = decoded.uid;
  const deviceId = typeof req.body?.deviceId === 'string' ? req.body.deviceId.trim() : '';
  if (!deviceId) {
    return res.status(400).json({ error: 'deviceId requerido' });
  }

  const snapshot = await admin.firestore().collection('adminSessions').doc(uid).get();
  if (!snapshot.exists) {
    return res.json({ valid: false, reason: 'SESSION_NOT_FOUND' });
  }

  const session = snapshot.data() || {};
  const tokenIssuedAt = getAuthTimeFromToken(decoded);
  const invalidateBefore = Number(session.invalidateBefore || 0);
  const valid = session.deviceId === deviceId && tokenIssuedAt >= invalidateBefore;
  return res.json({ valid, reason: valid ? null : 'SESSION_REPLACED' });
});

app.post('/admin/audit/parametros', async (req, res) => {
  const authHeader = req.headers.authorization || '';
  const match = authHeader.match(/^Bearer (.+)$/);
  if (!match) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(match[1], true);
  } catch (error) {
    return res.status(401).json({ error: 'Token inválido' });
  }

  const validation = await validarUsuarioSuperadmin(decoded);
  if (!validation.ok) {
    return res.status(validation.status).json(validation.body);
  }

  const motivo = typeof req.body?.motivo === 'string' && req.body.motivo.trim()
    ? req.body.motivo.trim().slice(0, 160)
    : 'acceso_parametros';

  await admin.firestore().collection('adminAccessAudit').add({
    uid: decoded.uid,
    email: validation.email,
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
    motivo
  });

  return res.json({ status: 'ok' });
});

app.post('/admin/purge-sorteo', verificarToken, async (req, res) => {
  const { sorteoId, sorteoNombre, dryRun } = req.body || {};
  const normalizedDryRun = dryRun === true;
  const PREVIEW_VALID_WINDOW_MS = 10 * 60 * 1000;

  if (!['Superadmin', 'Administrador'].includes(req.user?.role)) {
    return res.status(403).json({ error: 'Acceso restringido a roles administrativos' });
  }

  if (typeof sorteoId !== 'string' || !sorteoId.trim()) {
    return res.status(400).json({ error: 'sorteoId es obligatorio' });
  }

  const normalizedSorteoId = sorteoId.trim();
  const normalizedSorteoNombre = typeof sorteoNombre === 'string' && sorteoNombre.trim()
    ? sorteoNombre.trim().slice(0, 200)
    : null;

  const db = admin.firestore();

  try {
    if (!normalizedDryRun) {
      const recentPreviewSnapshot = await db
        .collection('adminAccessAudit')
        .where('uid', '==', req.user?.uid || null)
        .orderBy('timestamp', 'desc')
        .limit(20)
        .get();

      const recentPreview = recentPreviewSnapshot.docs.find((doc) => {
        const data = doc.data() || {};
        return data.motivo === 'purge_sorteo_preview' && data.sorteoId === normalizedSorteoId;
      });

      if (!recentPreview) {
        return res.status(409).json({
          error: 'Debes hacer una previsualización antes de depurar este sorteo.'
        });
      }

      const previewData = recentPreview.data() || {};
      const previewAtMs = previewData.timestamp?.toMillis ? previewData.timestamp.toMillis() : 0;
      if (!previewAtMs || Date.now() - previewAtMs > PREVIEW_VALID_WINDOW_MS) {
        return res.status(409).json({
          error: 'La previsualización expiró. Genera una nueva antes de depurar.',
          previewValidWindowMs: PREVIEW_VALID_WINDOW_MS
        });
      }
    }

    const deletedCounts = await getPurgeCounts({
      db,
      sorteoId: normalizedSorteoId,
      dryRun: normalizedDryRun
    });

    await db.collection('adminAccessAudit').add({
      uid: req.user?.uid || null,
      email: req.user?.email || 'desconocido',
      role: req.user?.role || 'desconocido',
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      motivo: normalizedDryRun ? 'purge_sorteo_preview' : 'purge_sorteo',
      sorteoId: normalizedSorteoId,
      sorteoNombre: normalizedSorteoNombre,
      dryRun: normalizedDryRun,
      deletedCounts
    });

    return res.json({
      status: 'ok',
      sorteoId: normalizedSorteoId,
      dryRun: normalizedDryRun,
      previewValidWindowMs: PREVIEW_VALID_WINDOW_MS,
      deletedCounts
    });
  } catch (error) {
    console.error('Error purgando sorteo', error);
    return res.status(500).json({ error: 'Error purgando sorteo', message: error.message });
  }
});

async function acreditarPremioEventoHandler(req, res) {
  const premioId = normalizeString(req.body?.premioId, 320).toLowerCase();
  const eventoGanadorId = normalizeString(req.body?.eventoGanadorId, 320);
  const billeteraId = normalizeString(
    req.body?.billeteraId
    || req.body?.email
    || req.body?.IDbilletera
    || req.body?.userId,
    160
  ).toLowerCase();

  if (!premioId && !eventoGanadorId) {
    return res.status(400).json({
      error: 'Debes enviar premioId o eventoGanadorId para acreditar el premio pendiente directo.'
    });
  }

  const db = admin.firestore();

  try {
    const premioDocRef = (() => {
      const normalizedPremioId = premioId || buildOfficialPendingPrizeId(eventoGanadorId);
      if (billeteraId && normalizedPremioId) {
        return db
          .collection('Billetera')
          .doc(billeteraId)
          .collection('premiosPendientesDirectos')
          .doc(normalizedPremioId);
      }
      return null;
    })();

    let premioDoc = null;
    if (premioDocRef) {
      const premioSnap = await premioDocRef.get();
      if (premioSnap.exists) premioDoc = premioSnap;
    }

    if (!premioDoc && eventoGanadorId) {
      const premioByEventoSnap = await db
        .collectionGroup('premiosPendientesDirectos')
        .where('eventoGanadorId', '==', eventoGanadorId)
        .limit(2)
        .get();
      if (premioByEventoSnap.size > 1) {
        return res.status(409).json({
          error: 'Se encontraron múltiples premios pendientes para el evento indicado.',
          eventoGanadorId
        });
      }
      if (!premioByEventoSnap.empty) {
        premioDoc = premioByEventoSnap.docs[0];
      }
    }

    if (!premioDoc && premioId) {
      const premioByIdSnap = await db
        .collectionGroup('premiosPendientesDirectos')
        .where('premioId', '==', premioId)
        .limit(2)
        .get();
      if (premioByIdSnap.size > 1) {
        return res.status(409).json({
          error: 'Se encontraron múltiples premios pendientes con el premioId indicado.',
          premioId
        });
      }
      if (!premioByIdSnap.empty) {
        premioDoc = premioByIdSnap.docs[0];
      }
    }

    if (!premioDoc || !premioDoc.exists) {
      return res.status(404).json({
        error: 'No se encontró el premio pendiente directo solicitado.',
        premioId: premioId || null,
        eventoGanadorId: eventoGanadorId || null
      });
    }

    const premioData = premioDoc.data() || {};
    const sorteoId = normalizeString(req.body?.sorteoId, 120) || normalizeString(premioData.sorteoId, 120);
    if (!sorteoId) {
      return res.status(400).json({
        error: 'No se pudo determinar el sorteoId del premio pendiente a acreditar.'
      });
    }

    const acreditadoPor = normalizeString(req.user?.email, 200) || 'sistema:acreditar-premio-evento';
    const result = await reconcileSinglePendingPrize({
      db,
      premioDoc,
      sorteoId,
      acreditadoPor,
      origen: 'backend/acreditarPremioEvento'
    });

    if (result?.status === 'acreditado') {
      return res.json({
        status: 'ok',
        resultado: 'acreditado',
        idempotente: false,
        premioId: result.premioId,
        creditos: result.creditos,
        cartones: result.cartones
      });
    }

    if (result?.reason === 'ya_acreditado') {
      return res.json({
        status: 'ok',
        resultado: 'ya_acreditado',
        idempotente: true,
        premioId: result.premioId || normalizeString(premioDoc.id, 320).toLowerCase()
      });
    }

    return res.status(409).json({
      error: 'No se pudo acreditar el premio pendiente directo en el estado actual.',
      detalle: result || null
    });
  } catch (error) {
    console.error('[acreditar-premio-evento] fallo', error);
    return res.status(500).json({
      error: 'Error acreditando premio pendiente directo',
      message: error.message
    });
  }
}

app.post('/acreditarPremioEvento', verificarOperadorPrivilegiado, acreditarPremioEventoHandler);

app.post('/admin/generar-premios-pendientes-directos-oficiales', verificarToken, async (req, res) => {
  const sorteoId = normalizeString(req.body?.sorteoId, 120);
  if (!sorteoId) {
    return res.status(400).json({ error: 'sorteoId es obligatorio' });
  }

  try {
    const summary = await generatePendingDirectPrizesFromOfficialResults({
      db: admin.firestore(),
      sorteoId,
      generadoPor: normalizeString(req.user?.email, 200) || 'sistema:premios-oficiales'
    });
    return res.json({
      status: 'ok',
      ...summary
    });
  } catch (error) {
    console.error('[generar-premios-pendientes-directos-oficiales] fallo', error);
    return res.status(500).json({
      error: 'Error generando premios pendientes directos oficiales',
      message: error?.message || String(error)
    });
  }
});

app.post('/admin/reconciliar-premios-pendientes-directos', verificarToken, async (req, res) => {
  const sorteoId = normalizeString(req.body?.sorteoId, 120);
  const pageSize = Math.max(10, Math.min(250, Number(req.body?.pageSize) || 100));

  if (!sorteoId) {
    return res.status(400).json({ error: 'sorteoId es obligatorio' });
  }

  try {
    const resultado = await reconcilePendingPrizesBySorteo({
      db: admin.firestore(),
      sorteoId,
      pageSize,
      acreditadoPor: normalizeString(req.user?.email, 200) || 'sistema:reconciliacion',
      origen: 'premios_pendientes_reconciliados'
    });

    return res.json({
      status: 'ok',
      ...resultado
    });
  } catch (error) {
    console.error('[reconciliar-premios-pendientes-directos] fallo de endpoint', error);
    return res.status(500).json({
      error: 'Error reconciliando premios pendientes directos',
      message: error?.message || String(error)
    });
  }
});

function toPublicImageUrl(req, relativePath) {
  const normalizedPath = normalizeString(relativePath, 260).replace(/^\/+/, '');
  if (!normalizedPath) return '';
  if (/^https?:\/\//i.test(normalizedPath)) return normalizedPath;
  const baseUrl = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
  return `${baseUrl.replace(/\/+$/, '')}/${normalizedPath}`;
}

function normalizeLoteriaImageItem({ name, relativePath, updatedAt }, req) {
  const normalizedName = normalizeString(name, 180);
  const normalizedPath = normalizeString(relativePath, 260).replace(/^\/+/, '');
  if (!normalizedName || !normalizedPath) return null;
  return {
    name: normalizedName,
    path: normalizedPath,
    url: toPublicImageUrl(req, normalizedPath),
    updatedAt: updatedAt || null
  };
}

function normalizeLoteriaImageKey(value) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/^\/+/, '').replace(/\\/g, '/').toLowerCase();
}

function normalizarSlugLoteria(value) {
  const base = normalizeString(value, 180).toLowerCase();
  if (!base) return 'loteria';
  return base
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'loteria';
}

function buildLoteriasImageSyncReport({ loterias = [], images = [] }) {
  const catalogByKey = new Map();
  images.forEach((item) => {
    const key = normalizeLoteriaImageKey(item?.path || '');
    if (key) catalogByKey.set(key, item);
  });

  const referencedKeys = new Set();
  const missingReferencedImages = [];
  const caseAndSlugWarnings = [];

  loterias.forEach((item) => {
    const imagen = normalizeString(item?.imagen, 320).replace(/^\/+/, '');
    if (!imagen) return;

    const imageKey = normalizeLoteriaImageKey(imagen);
    if (imageKey) referencedKeys.add(imageKey);

    const catalogMatch = imageKey ? catalogByKey.get(imageKey) : null;
    if (!catalogMatch) {
      missingReferencedImages.push({
        id: item.id || '',
        nombre: item.nombre || '',
        estado: item.estado || '',
        jerarquia: Number.isFinite(Number(item.jerarquia)) ? Number(item.jerarquia) : null,
        imagen
      });
      return;
    }

    const resolvedPath = normalizeString(catalogMatch.path || '', 320).replace(/^\/+/, '');
    if (resolvedPath && resolvedPath !== imagen) {
      caseAndSlugWarnings.push({
        type: 'case_mismatch',
        id: item.id || '',
        nombre: item.nombre || '',
        imagenDeclarada: imagen,
        imagenCatalogo: resolvedPath
      });
    }

    const expectedSlugPath = `img/loterias/${normalizarSlugLoteria(item.nombre || item.id || '')}.png`;
    if (imageKey && normalizeLoteriaImageKey(expectedSlugPath) !== imageKey) {
      caseAndSlugWarnings.push({
        type: 'slug_mismatch',
        id: item.id || '',
        nombre: item.nombre || '',
        imagenDeclarada: imagen,
        slugEsperado: expectedSlugPath
      });
    }
  });

  const orphanImages = images
    .filter((item) => {
      const key = normalizeLoteriaImageKey(item?.path || '');
      return key && !referencedKeys.has(key);
    })
    .map((item) => ({
      name: item.name || '',
      path: item.path || '',
      url: item.url || ''
    }));

  return {
    sourceOfTruth: LOTERIAS_SOURCE_OF_TRUTH,
    summary: {
      loterias: loterias.length,
      imagenesCatalogo: images.length,
      referenciasSinArchivo: missingReferencedImages.length,
      imagenesHuerfanas: orphanImages.length,
      alertasCaseSlug: caseAndSlugWarnings.length
    },
    missingReferencedImages,
    orphanImages,
    caseAndSlugWarnings
  };
}

async function listLocalLoteriaImages(req) {
  const loteriasDir = path.join(__dirname, 'public', 'img', 'loterias');
  const entries = await fs.readdir(loteriasDir, { withFileTypes: true });
  const files = await Promise.all(entries
    .filter((entry) => entry.isFile())
    .map(async (entry) => {
      const extension = path.extname(entry.name || '').toLowerCase();
      if (!ALLOWED_FILE_TYPES[extension] || extension === '.pdf') return null;
      const fullPath = path.join(loteriasDir, entry.name);
      const stats = await fs.stat(fullPath);
      return normalizeLoteriaImageItem(
        {
          name: entry.name,
          relativePath: path.posix.join('img/loterias', entry.name),
          updatedAt: stats.mtime?.toISOString ? stats.mtime.toISOString() : null
        },
        req
      );
    }));

  return files.filter(Boolean).sort((a, b) => a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }));
}

async function listManifestLoteriaImages(req) {
  const manifestPath = path.join(__dirname, 'public', 'img', 'loterias', 'manifest.json');
  const raw = await fs.readFile(manifestPath, 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error('El manifest de loterías debe ser un arreglo JSON.');
  }

  return parsed
    .map((item) => normalizeLoteriaImageItem(
      {
        name: normalizeString(item?.name, 220),
        relativePath: normalizeString(item?.path, 320),
        updatedAt: item?.updatedAt || null
      },
      req
    ))
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }));
}

async function listStorageLoteriaImages(req) {
  const bucket = admin.storage().bucket();
  const [files] = await bucket.getFiles({ prefix: 'img/loterias/' });
  const normalizedFiles = files
    .map((file) => {
      const fileName = path.posix.basename(file.name || '');
      if (!fileName || fileName === '.' || fileName === '..') return null;
      const extension = path.extname(fileName || '').toLowerCase();
      if (!ALLOWED_FILE_TYPES[extension] || extension === '.pdf') return null;
      return normalizeLoteriaImageItem(
        {
          name: fileName,
          relativePath: path.posix.join('img/loterias', fileName),
          updatedAt: file.metadata?.updated || null
        },
        req
      );
    })
    .filter(Boolean);

  return normalizedFiles.sort((a, b) => a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }));
}

async function getLoteriasImageCatalog(req) {
  try {
    const manifestImages = await listManifestLoteriaImages(req);
    return { images: manifestImages, source: 'manifest' };
  } catch (error) {
    console.warn('[loterias][images] manifest_unavailable_fallback', error?.message || error);
  }

  const useStorage = process.env.LOTERIAS_IMAGES_SOURCE === 'storage' || process.env.NODE_ENV === 'production';
  if (!useStorage) {
    const images = await listLocalLoteriaImages(req);
    return { images, source: 'local' };
  }

  try {
    const storageImages = await listStorageLoteriaImages(req);
    if (storageImages.length > 0) {
      return { images: storageImages, source: 'storage' };
    }
  } catch (error) {
    console.warn('[loterias][images] storage_unavailable_fallback_local', error?.message || error);
  }

  const localImages = await listLocalLoteriaImages(req);
  return { images: localImages, source: 'local-fallback' };
}

app.get('/admin/loterias/images', verificarToken, async (req, res) => {
  try {
    const { images } = await getLoteriasImageCatalog(req);
    return res.json({ images });
  } catch (error) {
    console.error('Error listando imágenes de loterías', error);
    return res.status(500).json({ error: 'No se pudieron listar las imágenes de loterías', message: error.message });
  }
});

app.get('/admin/loterias/sync-report', verificarToken, async (req, res) => {
  try {
    const { images, source } = await getLoteriasImageCatalog(req);
    const loteriasSnapshot = await admin.firestore().collection(LOTERIAS_SOURCE_OF_TRUTH.collection).get();
    const loterias = loteriasSnapshot.docs.map((doc) => {
      const data = doc.data() || {};
      return {
        id: doc.id,
        nombre: normalizeString(data.nombre, 180),
        estado: normalizeString(data.estado, 40),
        jerarquia: Number.isFinite(Number(data.jerarquia)) ? Number(data.jerarquia) : null,
        imagen: normalizeString(data.imagen, 320).replace(/^\/+/, '')
      };
    });

    const report = buildLoteriasImageSyncReport({ loterias, images });
    return res.json({
      ...report,
      imageCatalogSource: source
    });
  } catch (error) {
    console.error('Error generando sync-report de loterías', error);
    return res.status(500).json({ error: 'No se pudo generar el reporte de loterías', message: error.message });
  }
});

app.post('/upload', verificarToken, upload.single('file'), async (req, res) => {
  if (!req.file) {
    registrarAuditoria({ email: req.user?.email, result: 'rechazado', reason: 'Archivo requerido' });
    return res.status(400).json({ error: 'Archivo requerido' });
  }
  try {
    const bucket = admin.storage().bucket();
    const extension = path.extname(req.file.originalname).toLowerCase();
    const fileName = `${Date.now()}-${Math.round(Math.random() * 1e9)}${extension}`;
    const file = bucket.file(fileName);
    await file.save(req.file.buffer, { contentType: req.file.mimetype });
    const [url] = await file.getSignedUrl({
      action: 'read',
      expires: Date.now() + Number(process.env.SIGNED_URL_EXPIRATION_MS || 15 * 60 * 1000)
    });
    registrarAuditoria({ email: req.user?.email, fileType: req.file.mimetype, result: 'exitoso' });
    res.json({ url, expiresInMs: Number(process.env.SIGNED_URL_EXPIRATION_MS || 15 * 60 * 1000) });
  } catch (e) {
    console.error(e);
    registrarAuditoria({
      email: req.user?.email,
      fileType: req.file?.mimetype,
      result: 'fallido',
      reason: e.message
    });
    res.status(500).json({ error: 'Error al subir archivo', message: e.message });
  }
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const message = err.code === 'LIMIT_FILE_SIZE' ? 'Archivo excede el tamaño permitido' : 'Archivo no permitido';
    registrarAuditoria({
      email: req.user?.email,
      fileType: req.file?.mimetype,
      result: 'rechazado',
      reason: message
    });
    return res.status(400).json({ error: message });
  }

  if (err && err.message === 'Nombre de archivo inválido') {
    registrarAuditoria({
      email: req.user?.email,
      result: 'rechazado',
      reason: err.message
    });
    return res.status(400).json({ error: err.message });
  }

  if (err && err.message === 'Origen no permitido por CORS') {
    return res.status(403).json({ error: err.message });
  }

  return next(err);
});

function startServer() {
  validateRequiredEnv();
  initializeFirebase();

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Servicio de subida escuchando en puerto ${PORT}`);
  });
}

if (require.main === module) {
  startServer();
}

module.exports = {
  app,
  requiredEnv,
  getMissingRequiredEnv,
  validateRequiredEnv,
  initializeFirebase,
  startServer,
  hashValue,
  getClientIp,
  getAuthTimeFromToken,
  deleteCollectionBySorteoId,
  deleteDocumentById,
  countCollectionBySorteoId,
  countDocumentById,
  getPurgeCounts,
  isSorteoEligibleForAutoPrize,
  normalizePendingPrizeState,
  buildReconciledPrizeTransactionId,
  reconcileSinglePendingPrize,
  reconcilePendingPrizesBySorteo,
  buildPremioDocId,
  extractEventoGanadorIdComponents,
  normalizeCartonWinnerKey,
  buildOfficialPendingPrizeId,
  computeWinnerPrizeAmounts,
  generatePendingDirectPrizesFromOfficialResults,
  resolveWinnerIdentity,
  getAcreditacionExecutionMode,
  acreditarPremioEventoHandler,
  normalizeLoteriaImageItem,
  listLocalLoteriaImages,
  listStorageLoteriaImages,
  getLoteriasImageCatalog,
  toPublicImageUrl,
  normalizeLoteriaImageKey,
  buildLoteriasImageSyncReport
};
