require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { ALLOWED_ROLES, buildRoleClaims, buildUserProfileUpdate, normalizeRoleToCanonical } = require('./lib/roleProvisioning');
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
const PREMIOS_ENGINE_V2_ENABLED = String(process.env.PREMIOS_ENGINE_V2_ENABLED || 'false').trim().toLowerCase() === 'true';
const PREMIOS_PAGOS_DIRECTOS_MIRROR_ENABLED = String(process.env.PREMIOS_PAGOS_DIRECTOS_MIRROR_ENABLED || 'false').trim().toLowerCase() === 'true';

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

function normalizeOrigin(value) {
  const parsed = new URL(String(value).trim());
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`Protocolo no soportado en origen CORS: ${value}`);
  }

  if (parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password) {
    throw new Error(`El origen CORS debe incluir solo scheme + host + puerto: ${value}`);
  }

  return parsed.origin;
}

function getAllowedOrigins(env = process.env) {
  const raw = env.ALLOWED_ORIGINS || 'http://localhost:3000,http://127.0.0.1:3000';
  const parsed = raw
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
    .map((origin) => normalizeOrigin(origin));

  if (!parsed.length) {
    throw new Error('ALLOWED_ORIGINS no puede estar vacío.');
  }

  return [...new Set(parsed)];
}

let allowedOrigins = [];
try {
  allowedOrigins = getAllowedOrigins(process.env);
} catch (error) {
  console.error(`Configuración inválida de ALLOWED_ORIGINS: ${error.message}`);
  process.exit(1);
}

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

app.get('/health', (req, res) => {
  res.status(200).json({
    ok: true,
    service: 'uploadServer',
    timestamp: new Date().toISOString()
  });
});

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

async function verificarUsuarioAutenticado(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const match = authHeader.match(/^Bearer (.+)$/);
  if (!match) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  try {
    const decoded = await admin.auth().verifyIdToken(match[1]);
    const email = normalizeString(decoded?.email, 200).toLowerCase();
    if (!email) {
      return res.status(401).json({ error: 'Token sin correo asociado' });
    }
    req.user = { uid: decoded.uid || '', email };
    return next();
  } catch (error) {
    console.error('Error verificando token de usuario', error);
    return res.status(401).json({ error: 'Token inválido' });
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

async function verificarOperadorPrivilegiadoOJugadorAcreditacion(req, res, next) {
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

  const email = normalizeString(decoded?.email, 200).toLowerCase();
  if (!email) {
    return res.status(401).json({ error: 'Token sin correo asociado' });
  }

  try {
    const doc = await admin.firestore().collection('users').doc(email).get();
    const role = normalizeOperationalRole(doc.exists ? doc.data()?.role : null) || 'Jugador';
    const isOperador = ['Superadmin', 'Administrador', 'Colaborador'].includes(role);
    req.user = {
      uid: normalizeString(decoded?.uid, 200),
      email,
      role,
      authScope: isOperador ? 'operador' : 'jugador'
    };
    return next();
  } catch (e) {
    console.error('Error obteniendo el rol del usuario', e);
    return res.status(500).json({ error: 'Error verificando permisos', message: e.message });
  }
}

async function verificarOperadorFinalizacion(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const match = authHeader.match(/^Bearer (.+)$/);
  if (!match) {
    return res.status(401).json({ permitido: false, motivo: 'sesion_invalida', detalle: { mensaje: 'No autorizado' } });
  }
  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(match[1]);
  } catch (error) {
    console.error('Error verificando token para finalizar sorteo', error);
    return res.status(401).json({ permitido: false, motivo: 'sesion_invalida', detalle: { mensaje: 'Token inválido' } });
  }
  const email = normalizeString(decoded?.email, 200).toLowerCase();
  if (!email) {
    return res.status(401).json({ permitido: false, motivo: 'sesion_invalida', detalle: { mensaje: 'Token sin correo asociado' } });
  }
  try {
    const userDoc = await admin.firestore().collection('users').doc(email).get();
    const userRole = normalizeOperationalRole(userDoc.exists ? userDoc.data()?.role : null);
    if (!ROLES_OPERATIVOS_FINALIZACION.has(userRole)) {
      return res.status(403).json({
        permitido: false,
        motivo: 'permisos_insuficientes',
        detalle: { mensaje: 'Acceso restringido a operadores autorizados', userRole: userRole || 'sin-rol' }
      });
    }
    req.user = { uid: decoded.uid, email, role: userRole };
    return next();
  } catch (error) {
    console.error('Error validando operador de finalización', error);
    return res.status(500).json({ permitido: false, motivo: 'error_interno', detalle: { mensaje: error.message } });
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

function normalizeSorteoEstadoForAcreditacion(value) {
  const estado = normalizeString(value, 40).toLowerCase();
  if (['activo', 'activa', 'en_juego', 'en-juego'].includes(estado)) {
    return 'jugando';
  }
  return estado;
}

const MAX_FILAS_RESULTADOS = 13;
const ROLES_OPERATIVOS_FINALIZACION = new Set(['Superadmin', 'Administrador', 'Colaborador']);

function normalizeOperationalRole(value) {
  const raw = normalizeString(value, 60);
  const normalized = raw.toLowerCase();
  if (normalized === 'superadmin' || normalized === 'super administrador' || normalized === 'super-administrador') {
    return 'Superadmin';
  }
  if (normalized === 'administrador' || normalized === 'administradores' || normalized === 'admin') {
    return 'Administrador';
  }
  if (normalized === 'colaborador' || normalized === 'colaboradores') {
    return 'Colaborador';
  }
  if (normalized === 'jugador' || normalized === 'player') {
    return 'Jugador';
  }
  return raw || null;
}

function normalizeScheduleLabel(value) {
  const schedule = normalizeString(value, 40).toLowerCase().replace(/\./g, '');
  if (!schedule) return '';
  const match = /^(\d{1,2}):(\d{2})(?:\s*([ap]m))?$/.exec(schedule);
  if (!match) return schedule.replace(/\s+/g, ' ');
  let hours = Number.parseInt(match[1], 10);
  const minutes = match[2];
  const period = match[3];
  if (period === 'pm' && hours < 12) hours += 12;
  if (period === 'am' && hours === 12) hours = 0;
  return `${String(hours).padStart(2, '0')}:${minutes}`;
}

function buildScheduleByRow(row, isIntermedia = false) {
  const baseHour = 8 + Math.max(0, Number.isFinite(Number(row)) ? Number(row) : 0);
  return `${String(baseHour).padStart(2, '0')}:${isIntermedia ? '30' : '00'}`;
}

function isResultBlockEnabled(loteria = {}, row, tipoBloque) {
  const normalizedRow = Number.isFinite(Number(row)) ? Math.max(0, Number(row)) : 0;
  const blockType = normalizeString(tipoBloque, 20).toLowerCase();
  const isIntermedia = blockType === 'intermedia';
  const expectedSchedule = normalizeScheduleLabel(buildScheduleByRow(normalizedRow, isIntermedia));
  const scheduleBlocks = Array.isArray(loteria?.bloquesHorarios) ? loteria.bloquesHorarios : [];
  const normalizedBlocks = new Set(scheduleBlocks.map((item) => normalizeScheduleLabel(item)).filter(Boolean));
  if (normalizedBlocks.size > 0) {
    return normalizedBlocks.has(expectedSchedule);
  }
  if (isIntermedia) {
    const allowsIntermedia = loteria?.mostrarBloquesIntermedios ?? loteria?.horaIntermedia ?? loteria?.bloqueIntermedia ?? loteria?.intermedia ?? true;
    return Boolean(allowsIntermedia);
  }
  const allowsExacta = loteria?.horaExacta ?? loteria?.bloqueExacta ?? loteria?.exacta ?? true;
  return Boolean(allowsExacta);
}

function normalizeResultNumber(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  const number = Number(text);
  if (!Number.isFinite(number)) return null;
  return number;
}

function computeRequiredResultBlocks(loterias = []) {
  if (!Array.isArray(loterias) || !loterias.length) return 0;
  let total = 0;
  loterias.forEach((loteria) => {
    for (let row = 0; row < MAX_FILAS_RESULTADOS; row += 1) {
      if (isResultBlockEnabled(loteria, row, 'exacta')) total += 1;
      if (isResultBlockEnabled(loteria, row, 'intermedia')) total += 1;
    }
  });
  return total;
}

function buildAllowedResultCellKeys(loterias = []) {
  if (!Array.isArray(loterias) || !loterias.length) return new Set();
  const allowedKeys = new Set();
  loterias.forEach((loteria) => {
    const loteriaId = normalizeString(loteria?.id, 120);
    if (!loteriaId) return;
    for (let row = 0; row < MAX_FILAS_RESULTADOS; row += 1) {
      if (isResultBlockEnabled(loteria, row, 'exacta')) {
        allowedKeys.add(`${loteriaId}_${buildScheduleByRow(row, false)}`);
      }
      if (isResultBlockEnabled(loteria, row, 'intermedia')) {
        allowedKeys.add(`${loteriaId}_${buildScheduleByRow(row, true)}`);
      }
    }
  });
  return allowedKeys;
}

function computeLoadedResultBlocks(resultadosPorCelda = {}, allowedCellKeys = null) {
  if (!resultadosPorCelda || typeof resultadosPorCelda !== 'object') return 0;
  let loaded = 0;
  const onlyAllowed = allowedCellKeys instanceof Set && allowedCellKeys.size > 0;
  Object.entries(resultadosPorCelda).forEach(([cellKey, item]) => {
    if (onlyAllowed && !allowedCellKeys.has(normalizeString(cellKey, 160))) return;
    if (normalizeResultNumber(item?.exacta) !== null) loaded += 1;
    if (normalizeResultNumber(item?.intermedia) !== null) loaded += 1;
  });
  return loaded;
}

function getMissingWinnerForms(sorteoData = {}, { winnerFormIdxs = null } = {}) {
  const formas = Array.isArray(sorteoData?.formas) ? sorteoData.formas : [];
  const activeForms = formas
    .map((forma) => ({
      idx: Number(forma?.idx),
      nombre: normalizeString(forma?.nombre || `Forma ${forma?.idx}`, 120)
    }))
    .filter((forma) => Number.isFinite(forma.idx));
  const winnerIdxSet = winnerFormIdxs instanceof Set
    ? winnerFormIdxs
    : new Set();
  const lock = (sorteoData?.ganadoresBloqueadosPorForma && typeof sorteoData.ganadoresBloqueadosPorForma === 'object')
    ? sorteoData.ganadoresBloqueadosPorForma
    : {};
  return activeForms.filter((forma) => {
    if (winnerIdxSet.has(forma.idx)) return false;
    const lockEntry = lock[String(forma.idx)];
    const cartonClaves = normalizeUniqueWinnerKeys(lockEntry?.cartonClaves);
    return cartonClaves.length === 0;
  });
}

function normalizeUniqueWinnerKeys(rawKeys) {
  if (!Array.isArray(rawKeys)) return [];
  return Array.from(new Set(
    rawKeys
      .map((item) => normalizeString(item, 220))
      .filter(Boolean)
  ));
}

function buildFinalizationContract({
  sorteoData = {},
  cantosData = {},
  loteriasConfig = null,
  winnerFormIdxs = null
} = {}) {
  const estado = normalizeString(sorteoData?.estado, 40).toLowerCase();
  const missingWinnerForms = getMissingWinnerForms(sorteoData, { winnerFormIdxs });
  const totalMissingWinners = missingWinnerForms.length;
  const allFormsHaveWinners = totalMissingWinners === 0;
  const loterias = Array.isArray(loteriasConfig)
    ? loteriasConfig
    : (Array.isArray(sorteoData?.loterias)
      ? sorteoData.loterias
      : (Array.isArray(sorteoData?.loteriasAsignadas) ? sorteoData.loteriasAsignadas : []));
  const allowedResultCellKeys = buildAllowedResultCellKeys(loterias);
  const requiredResults = computeRequiredResultBlocks(loterias);
  const loadedResults = computeLoadedResultBlocks(cantosData?.resultadosPorCelda, allowedResultCellKeys);
  const resultsComplete = requiredResults === 0 || loadedResults >= requiredResults;
  const permitted = estado === 'jugando' && (allFormsHaveWinners || resultsComplete);

  if (estado !== 'jugando') {
    return {
      permitido: false,
      motivo: 'estado_no_jugando',
      detalle: {
        estadoActual: estado || 'desconocido',
        totalFormasSinGanador: totalMissingWinners,
        totalResultadosRequeridos: requiredResults,
        totalResultadosCargados: loadedResults
      }
    };
  }

  if (!allFormsHaveWinners && !resultsComplete) {
    return {
      permitido: false,
      motivo: 'faltan_resultados_y_ganadores',
      detalle: {
        estadoActual: estado,
        totalFormasSinGanador: totalMissingWinners,
        formasSinGanador: missingWinnerForms,
        totalResultadosRequeridos: requiredResults,
        totalResultadosCargados: loadedResults,
        bloquesResultadosPendientes: Math.max(0, requiredResults - loadedResults)
      }
    };
  }

  return {
    permitido: true,
    motivo: 'ok',
    detalle: {
      estadoActual: estado,
      totalFormasSinGanador: totalMissingWinners,
      formasSinGanador: missingWinnerForms,
      totalResultadosRequeridos: requiredResults,
      totalResultadosCargados: loadedResults,
      resultadosCompletos: resultsComplete
    }
  };
}

async function resolveSorteoLoteriasForFinalization({ tx, db, sorteoData = {} } = {}) {
  const inlineLoterias = Array.isArray(sorteoData?.loterias) ? sorteoData.loterias : [];
  const configuredLoterias = inlineLoterias.filter((item) => item && typeof item === 'object' && !Array.isArray(item));
  if (configuredLoterias.length) return configuredLoterias;

  const loteriaIds = Array.isArray(sorteoData?.loteriasAsignadas)
    ? sorteoData.loteriasAsignadas
      .map((item) => normalizeString(item, 120))
      .filter(Boolean)
    : [];
  if (!loteriaIds.length || !db) return configuredLoterias;

  const docs = await Promise.all(loteriaIds.map((id) => {
    const ref = db.collection('loterias').doc(id);
    if (tx && typeof tx.get === 'function') return tx.get(ref);
    return ref.get();
  }));
  const loterias = [];
  docs.forEach((docSnap) => {
    if (!docSnap?.exists) return;
    const data = docSnap.data() || {};
    loterias.push({ id: docSnap.id, ...data });
  });
  return loterias;
}

async function resolveWinnerFormIdxsFromRealtime({ tx, db, sorteoId } = {}) {
  const normalizedSorteoId = normalizeString(sorteoId, 120);
  if (!normalizedSorteoId || !db) return new Set();
  const collectionRef = db.collection('GanadoresSorteosTiempoReal');
  if (!collectionRef || typeof collectionRef.where !== 'function') return new Set();
  const query = collectionRef.where('sorteoId', '==', normalizedSorteoId);
  const snap = tx && typeof tx.get === 'function'
    ? await tx.get(query)
    : await query.get();
  const winnerIdxs = new Set();
  snap.forEach((doc) => {
    const data = doc.data() || {};
    const idx = Number(
      data?.formaIdx
      ?? data?.idx
      ?? data?.forma?.idx
      ?? data?.formaIndice
      ?? data?.formaId
    );
    if (Number.isFinite(idx)) winnerIdxs.add(idx);
  });
  return winnerIdxs;
}

async function executeAuthoritativeSorteoFinalization({ db, sorteoId, operadorEmail }) {
  const normalizedSorteoId = normalizeString(sorteoId, 120);
  if (!normalizedSorteoId) {
    return {
      permitido: false,
      motivo: 'sorteo_id_obligatorio',
      detalle: { mensaje: 'sorteoId es obligatorio' }
    };
  }
  const sorteoRef = db.collection('sorteos').doc(normalizedSorteoId);
  const cantosRef = db.collection('cantos').doc(normalizedSorteoId);
  return db.runTransaction(async (tx) => {
    const [sorteoSnap, cantosSnap] = await Promise.all([tx.get(sorteoRef), tx.get(cantosRef)]);
    if (!sorteoSnap.exists) {
      return {
        permitido: false,
        motivo: 'sorteo_no_encontrado',
        detalle: { mensaje: `No existe el sorteo ${normalizedSorteoId}` }
      };
    }
    const sorteoData = sorteoSnap.data() || {};
    const cantosData = cantosSnap.exists ? (cantosSnap.data() || {}) : {};
    const [loteriasConfig, winnerFormIdxs] = await Promise.all([
      resolveSorteoLoteriasForFinalization({ tx, db, sorteoData }),
      resolveWinnerFormIdxsFromRealtime({ tx, db, sorteoId: normalizedSorteoId })
    ]);
    const contrato = buildFinalizationContract({
      sorteoData,
      cantosData,
      loteriasConfig,
      winnerFormIdxs
    });
    if (!contrato.permitido) return contrato;
    tx.update(sorteoRef, {
      estado: 'Finalizado',
      pdfresul: 'si',
      visibleJuegoActivo: 'si',
      resultadoPublicadoJugadores: 'si',
      resultadoPublicadoEn: admin.firestore.FieldValue.serverTimestamp(),
      finalizadoEn: admin.firestore.FieldValue.serverTimestamp(),
      finalizadoPor: normalizeString(operadorEmail, 200) || 'desconocido'
    });
    return {
      permitido: true,
      motivo: 'finalizado',
      detalle: {
        ...contrato.detalle,
        sorteoId: normalizedSorteoId
      }
    };
  });
}

function buildPremiosEngineDisabledResponse({ action, sorteoId = '', status = 409 } = {}) {
  return {
    statusCode: status,
    payload: {
      error: `La acción ${action || 'premios'} está deshabilitada porque premiosEngineV2Enabled=false.`,
      code: 'PREMIOS_ENGINE_V2_DISABLED',
      premiosEngineV2Enabled: PREMIOS_ENGINE_V2_ENABLED,
      action: action || 'premios',
      sorteoId: normalizeString(sorteoId, 120) || '',
      idempotente: true
    }
  };
}

function getLegacyDirectPrizeRefFromPendingRef(premioRef) {
  if (!PREMIOS_PAGOS_DIRECTOS_MIRROR_ENABLED) return null;
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
  origen,
  eventoGanadorId = ''
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
    const eventoGanadorIdPremio = normalizeString(
      eventoGanadorId || premioData.eventoGanadorId,
      320
    );
    const idx = Number.isFinite(Number(premioData.idx)) ? Number(premioData.idx) : null;
    const nombre = normalizeString(premioData.nombre, 200);
    const creditos = Math.max(0, normalizeNumber(premioData.creditos));
    const cartones = Math.max(
      0,
      normalizeNumber(premioData.cartonesGratis ?? premioData.cartones)
    );

    const transaccionPorPremioQuery = db
      .collection('transacciones')
      .where('premioId', '==', premioId)
      .limit(1);
    const billeteraRef = premioDoc.ref.parent.parent;
    const legacyPremioRef = getLegacyDirectPrizeRefFromPendingRef(premioDoc.ref);
    const ledgerRef = billeteraRef.collection('premiosLedger').doc(premioId);

    const [walletSnap, transaccionIdSnap, transaccionPorPremioSnap, ledgerSnap] = await Promise.all([
      tx.get(billeteraRef),
      tx.get(transaccionRef),
      tx.get(transaccionPorPremioQuery),
      tx.get(ledgerRef)
    ]);

    const ledgerData = ledgerSnap.exists ? ledgerSnap.data() || {} : {};
    const ledgerEstado = normalizePendingPrizeState(ledgerData.estado || '');
    const transaccionExistente = transaccionIdSnap.exists || !transaccionPorPremioSnap.empty;
    const yaAcreditado = estadoActual === 'acreditado' || ledgerEstado === 'acreditado';
    const transaccionIdLedger = normalizeString(
      ledgerData.transaccionId,
      320
    ) || (transaccionIdSnap.exists ? transaccionId : null);
    const ledgerPayloadBase = {
      premioId,
      eventoGanadorId: eventoGanadorIdPremio || null,
      sorteoId,
      idx,
      nombre: nombre || null,
      creditos,
      cartonesGratis: cartones
    };

    if (yaAcreditado || transaccionExistente) {
      tx.set(
        ledgerRef,
        {
          ...ledgerPayloadBase,
          estado: 'acreditado',
          acreditadoEn: premioData.acreditadoEn
            || ledgerData.acreditadoEn
            || admin.firestore.FieldValue.serverTimestamp(),
          acreditadoPor: premioData.acreditadoPor || ledgerData.acreditadoPor || acreditadoPor,
          origen: premioData.origen || ledgerData.origen || origen,
          transaccionId: transaccionIdLedger
        },
        { merge: true }
      );
      if (!yaAcreditado) {
        tx.set(
          premioDoc.ref,
          {
            estado: 'acreditado',
            acreditadoEn: premioData.acreditadoEn || admin.firestore.FieldValue.serverTimestamp(),
            acreditadoPor: premioData.acreditadoPor || acreditadoPor,
            origen: premioData.origen || origen,
            eventoGanadorId: premioData.eventoGanadorId || eventoGanadorIdPremio || null,
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
              eventoGanadorId: premioData.eventoGanadorId || eventoGanadorIdPremio || null,
              reconciliadoEn: admin.firestore.FieldValue.serverTimestamp(),
              reconciliadoPor: acreditadoPor
            },
            { merge: true }
          );
        }
      }
      return { status: 'omitido', reason: yaAcreditado ? 'ya_acreditado' : 'premio_duplicado', premioId };
    }

    if (estadoActual !== 'pendiente') {
      return { status: 'omitido', reason: 'estado_no_pendiente', premioId };
    }

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
        eventoGanadorId: eventoGanadorIdPremio || null,
        reconciliadoEn: admin.firestore.FieldValue.serverTimestamp(),
        reconciliadoPor: acreditadoPor
      },
      { merge: true }
    );
    tx.set(
      ledgerRef,
      {
        ...ledgerPayloadBase,
        estado: 'acreditado',
        acreditadoEn: admin.firestore.FieldValue.serverTimestamp(),
        acreditadoPor,
        origen,
        transaccionId
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
          eventoGanadorId: eventoGanadorIdPremio || null,
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
        eventoGanadorId: eventoGanadorIdPremio || null,
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

    return { status: 'acreditado', premioId, creditos, cartones, eventoGanadorId: eventoGanadorIdPremio || null };
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
  // Convención vigente:
  // - cartonesGratisPorGanador: valor explícito por ganador.
  // - cartonesGratis: total de la forma, se divide entre ganadores.
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
    const cartonClaves = normalizeUniqueWinnerKeys(lockValue?.cartonClaves);
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
      const premioLegacyRef = PREMIOS_PAGOS_DIRECTOS_MIRROR_ENABLED
        ? billeteraRef.collection('premiosPagosdirectos').doc(premioId)
        : null;

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
      if (premioLegacyRef) {
        await Promise.all([
          premioRef.set(payloadPremioPendiente, { merge: false }),
          premioLegacyRef.set(payloadPremioPendiente, { merge: true })
        ]);
      } else {
        await premioRef.set(payloadPremioPendiente, { merge: false });
      }
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

function buildWalletResolutionContext({ email, uid, extraCandidates = [] } = {}) {
  const canonicalEmail = normalizeIdentityValue(email, 160).toLowerCase();
  const normalizedUid = normalizeIdentityValue(uid, 160);
  const normalizedExtra = Array.isArray(extraCandidates)
    ? extraCandidates.map((item) => normalizeIdentityValue(item, 160)).filter(Boolean)
    : [];
  const internalCandidates = Array.from(new Set([
    normalizedUid,
    ...normalizedExtra.filter((item) => !looksLikeEmailIdentity(item))
  ].filter(Boolean)));
  const billeteraIdentity = buildBilleteraIdentity({
    email: canonicalEmail,
    uid: normalizedUid,
    extraCandidates: normalizedExtra
  });
  const prioritizedCandidates = Array.from(new Set([
    canonicalEmail,
    ...internalCandidates,
    ...(Array.isArray(billeteraIdentity.billeteraCandidates) ? billeteraIdentity.billeteraCandidates : [])
  ].filter(Boolean)));
  return {
    canonicalEmail: billeteraIdentity.canonicalEmail || canonicalEmail,
    billeteraId: normalizeIdentityValue(billeteraIdentity.billeteraId, 160),
    billeteraCandidates: prioritizedCandidates,
    internalCandidates
  };
}

async function resolveWalletDocInTransaction({ tx, db, context }) {
  const fallbackWalletId = normalizeIdentityValue(
    context?.billeteraId || context?.canonicalEmail || context?.internalCandidates?.[0],
    160
  );
  const candidates = Array.isArray(context?.billeteraCandidates)
    ? context.billeteraCandidates.map((item) => normalizeIdentityValue(item, 160)).filter(Boolean)
    : [];
  const orderedCandidates = Array.from(new Set([
    normalizeIdentityValue(context?.canonicalEmail, 160).toLowerCase(),
    ...candidates
  ].filter(Boolean)));

  for (const candidate of orderedCandidates) {
    const ref = db.collection('Billetera').doc(candidate);
    const snap = await tx.get(ref);
    if (snap.exists) {
      return { ref, snap, usedWalletId: candidate };
    }
  }

  const fallbackRef = db.collection('Billetera').doc(fallbackWalletId);
  const fallbackSnap = await tx.get(fallbackRef);
  return { ref: fallbackRef, snap: fallbackSnap, usedWalletId: fallbackWalletId };
}

async function resolveWalletIdForAuthenticatedUser({ db, email, uid, extraCandidates = [] }) {
  const context = buildWalletResolutionContext({
    email,
    uid,
    extraCandidates
  });
  const candidates = Array.from(new Set([
    normalizeIdentityValue(context?.canonicalEmail, 160).toLowerCase(),
    ...(Array.isArray(context?.billeteraCandidates) ? context.billeteraCandidates : [])
  ].filter(Boolean)));
  for (const candidate of candidates) {
    const snap = await db.collection('Billetera').doc(candidate).get();
    if (snap.exists) {
      return candidate;
    }
  }
  return normalizeIdentityValue(context?.billeteraId || context?.canonicalEmail, 160).toLowerCase();
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

app.post('/wallet/transfer-credits', verificarUsuarioAutenticado, async (req, res) => {
  const db = admin.firestore();
  const userEmail = normalizeString(req.user?.email, 200).toLowerCase();
  const alias = normalizeString(req.body?.alias, 40);
  const monto = Number(req.body?.monto);
  if (!alias) {
    return res.status(400).json({ error: 'El alias es obligatorio.' });
  }
  if (!/^[\p{L}\p{N}]+$/u.test(alias)) {
    return res.status(400).json({ error: 'El alias solo permite letras y números.' });
  }
  if (!Number.isFinite(monto) || monto <= 0) {
    return res.status(400).json({ error: 'El monto debe ser mayor a 0.' });
  }
  const montoNormalizado = Number(monto.toFixed(6));
  try {
    const aliasLower = alias.toLocaleLowerCase('es');
    const [receptorAliasLowerSnap, emisorUserSnap] = await Promise.all([
      db.collection('users').where('aliasLower', '==', aliasLower).limit(2).get(),
      db.collection('users').doc(userEmail).get()
    ]);

    if (receptorAliasLowerSnap.size > 1) {
      return res.status(409).json({
        error: 'Conflicto de alias: existen múltiples usuarios con el mismo alias normalizado.',
        code: 'ALIAS_CONFLICT_ALIAS_LOWER'
      });
    }

    let receptorDoc = receptorAliasLowerSnap.docs[0] || null;

    if (!receptorDoc) {
      const receptorAliasExactSnap = await db.collection('users').where('alias', '==', alias).limit(2).get();
      if (receptorAliasExactSnap.size > 1) {
        return res.status(409).json({
          error: 'Conflicto de alias: existen múltiples usuarios con el alias exacto indicado.',
          code: 'ALIAS_CONFLICT_ALIAS_EXACT'
        });
      }
      if (receptorAliasExactSnap.empty) {
        return res.status(404).json({ error: 'No se encontró el alias beneficiario.' });
      }
      receptorDoc = receptorAliasExactSnap.docs[0];
    }

    const receptorEmail = receptorDoc.id.toLowerCase();
    const aliasBeneficiario = normalizeString(receptorDoc.data()?.alias || alias, 40);
    if (receptorEmail === userEmail) {
      return res.status(400).json({ error: 'No puedes transferirte créditos a tu propio alias.' });
    }

    const emisorUserData = emisorUserSnap.exists ? (emisorUserSnap.data() || {}) : {};
    const receptorUserData = receptorDoc.data() || {};
    const origenWalletContext = buildWalletResolutionContext({
      email: userEmail,
      uid: normalizeString(req.user?.uid, 200),
      extraCandidates: [
        normalizeString(emisorUserData?.uid, 200),
        normalizeString(emisorUserData?.IDbilletera, 200)
      ]
    });
    const destinoWalletContext = buildWalletResolutionContext({
      email: receptorEmail,
      uid: normalizeString(receptorUserData?.uid, 200),
      extraCandidates: [
        normalizeString(receptorUserData?.uid, 200),
        normalizeString(receptorUserData?.IDbilletera, 200)
      ]
    });
    if (!origenWalletContext.billeteraId || !destinoWalletContext.billeteraId) {
      return res.status(400).json({ error: 'No se pudo resolver la identidad de billetera.' });
    }

    const transaccionSalidaRef = db.collection('transacciones').doc();
    const transaccionEntradaRef = db.collection('transacciones').doc();
    const ahora = new Date();
    const fecha = `${String(ahora.getUTCDate()).padStart(2, '0')}/${String(ahora.getUTCMonth() + 1).padStart(2, '0')}/${ahora.getUTCFullYear()}`;
    const hora = `${String(ahora.getUTCHours()).padStart(2, '0')}:${String(ahora.getUTCMinutes()).padStart(2, '0')}`;

    await db.runTransaction(async (tx) => {
      const [origenResolved, destinoResolved] = await Promise.all([
        resolveWalletDocInTransaction({ tx, db, context: origenWalletContext }),
        resolveWalletDocInTransaction({ tx, db, context: destinoWalletContext })
      ]);
      const origenRef = origenResolved.ref;
      const destinoRef = destinoResolved.ref;
      const origenSnap = origenResolved.snap;
      const destinoSnap = destinoResolved.snap;
      const origenData = origenSnap.exists ? (origenSnap.data() || {}) : {};
      const destinoData = destinoSnap.exists ? (destinoSnap.data() || {}) : {};
      const creditosOrigen = Number(origenData.creditos || 0);
      const creditosTransito = Math.max(0, Number(origenData.creditostransito || 0));
      const disponibles = Math.max(0, creditosOrigen - creditosTransito);
      if (disponibles < montoNormalizado) {
        throw new Error('CREDITOS_INSUFICIENTES');
      }
      tx.set(origenRef, { creditos: Number((creditosOrigen - montoNormalizado).toFixed(6)) }, { merge: true });
      tx.set(destinoRef, {
        email: destinoWalletContext.canonicalEmail || receptorEmail,
        creditos: Number((Number(destinoData.creditos || 0) + montoNormalizado).toFixed(6)),
        CartonesGratis: Number(destinoData.CartonesGratis ?? destinoData.cartonesGratis ?? 0) || 0,
        creditostransito: Number(destinoData.creditostransito || 0) || 0
      }, { merge: true });
      tx.set(transaccionSalidaRef, {
        tipotrans: 'transferencia',
        IDbilletera: userEmail,
        idBilleteraInterna: origenResolved.usedWalletId,
        billeteraVisibleEmail: userEmail,
        beneficiarioEmail: receptorEmail,
        beneficiarioIdBilleteraInterna: destinoResolved.usedWalletId,
        aliasBeneficiario,
        aliasContraparte: aliasBeneficiario,
        transferenciaDireccion: 'saliente',
        Monto: montoNormalizado,
        estado: 'TRANSFERIDO',
        referencia: 'TRANSFERENCIA',
        comentario: '',
        usuariogestor: userEmail,
        rolusuario: 'Jugador',
        fechasolicitud: fecha,
        horasolicitud: hora,
        fechagestion: fecha,
        horagestion: hora,
        nota: ''
      });
      tx.set(transaccionEntradaRef, {
        tipotrans: 'transferencia',
        IDbilletera: receptorEmail,
        idBilleteraInterna: destinoResolved.usedWalletId,
        billeteraVisibleEmail: receptorEmail,
        beneficiarioEmail: receptorEmail,
        aliasBeneficiario,
        aliasContraparte: normalizeString(req.user?.name || req.user?.alias || '', 40),
        transferenciaDireccion: 'entrante',
        emisorEmail: userEmail,
        emisorIdBilleteraInterna: origenResolved.usedWalletId,
        Monto: montoNormalizado,
        estado: 'TRANSFERIDO',
        referencia: 'TRANSFERENCIA RECIBIDA',
        comentario: '',
        usuariogestor: userEmail,
        rolusuario: 'Jugador',
        fechasolicitud: fecha,
        horasolicitud: hora,
        fechagestion: fecha,
        horagestion: hora,
        nota: ''
      });
    });

    return res.json({ ok: true, aliasBeneficiario, monto: montoNormalizado });
  } catch (error) {
    if (error?.message === 'CREDITOS_INSUFICIENTES') {
      return res.status(400).json({ error: 'No tienes créditos suficientes para transferir ese monto.' });
    }
    console.error('Error al transferir créditos entre billeteras', error);
    return res.status(500).json({ error: 'No se pudo procesar la transferencia.' });
  }
});

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

async function syncClaimsHandler(req, res) {
  const email = req.user?.email;
  if (!email) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  try {
    const [profileDoc, userRecord] = await Promise.all([
      admin.firestore().collection('users').doc(email).get(),
      admin.auth().getUserByEmail(email)
    ]);

    const roleOriginal = profileDoc.exists ? profileDoc.data()?.role : undefined;
    if (!roleOriginal) {
      console.info(JSON.stringify({
        event: 'sync_claims_role',
        email,
        role_original: roleOriginal ?? null,
        role_normalizado: null,
        resultado: 'error_role_missing'
      }));
      return res.status(400).json({ error: 'Rol no encontrado en el perfil del usuario' });
    }

    const role = normalizeRoleToCanonical(roleOriginal);
    if (!role) {
      const allowedRolesLabel = ALLOWED_ROLES.join(', ');
      console.info(JSON.stringify({
        event: 'sync_claims_role',
        email,
        role_original: roleOriginal,
        role_normalizado: null,
        resultado: 'error_role_invalid'
      }));
      return res.status(400).json({
        error: `Rol no normalizable: "${roleOriginal}". Actualiza users/${email}.role a uno permitido: ${allowedRolesLabel}.`
      });
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

    console.info(JSON.stringify({
      event: 'sync_claims_role',
      email,
      role_original: roleOriginal,
      role_normalizado: role,
      resultado: 'ok'
    }));

    return res.json({ status: 'ok', role });
  } catch (e) {
    console.info(JSON.stringify({
      event: 'sync_claims_role',
      email,
      role_original: null,
      role_normalizado: null,
      resultado: 'error_internal'
    }));
    console.error('Error sincronizando custom claims', e);
    return res.status(500).json({ error: 'Error sincronizando custom claims', message: e.message });
  }
}

app.post('/syncClaims', verificarToken, syncClaimsHandler);

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
  if (!PREMIOS_ENGINE_V2_ENABLED) {
    const disabled = buildPremiosEngineDisabledResponse({ action: 'acreditar-premio-evento', status: 409 });
    return res.status(disabled.statusCode).json(disabled.payload);
  }

  const premioId = normalizeString(req.body?.premioId, 320).toLowerCase();
  const eventoGanadorId = normalizeString(req.body?.eventoGanadorId, 320);
  const origenCliente = normalizeString(req.body?.origen, 160);
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
    const isPlayerScopedCall = req.user?.authScope === 'jugador';
    const userEmail = normalizeString(req.user?.email, 200).toLowerCase();
    const userUid = normalizeString(req.user?.uid, 200);
    if (isPlayerScopedCall && !userEmail) {
      return res.status(401).json({
        error: 'El jugador autenticado no incluye email verificable.',
        code: 'JUGADOR_EMAIL_REQUERIDO'
      });
    }
    let resolvedPlayerWalletId = '';
    if (isPlayerScopedCall) {
      const userDoc = await db.collection('users').doc(userEmail).get();
      const userData = userDoc.exists ? (userDoc.data() || {}) : {};
      resolvedPlayerWalletId = await resolveWalletIdForAuthenticatedUser({
        db,
        email: userEmail,
        uid: userUid,
        extraCandidates: [
          normalizeString(userData?.uid, 200),
          normalizeString(userData?.IDbilletera, 200)
        ]
      });
      if (!resolvedPlayerWalletId) {
        return res.status(403).json({
          error: 'No se pudo resolver la billetera del jugador autenticado.',
          code: 'JUGADOR_BILLETERA_NO_RESUELTA'
        });
      }
    }
    const billeteraObjetivo = isPlayerScopedCall ? resolvedPlayerWalletId : billeteraId;

    let premioDoc = null;
    if (billeteraObjetivo && eventoGanadorId) {
      const premioCanonicalId = buildOfficialPendingPrizeId(eventoGanadorId);
      if (premioCanonicalId) {
        const canonicalSnap = await db
          .collection('Billetera')
          .doc(billeteraObjetivo)
          .collection('premiosPendientesDirectos')
          .doc(premioCanonicalId)
          .get();
        if (canonicalSnap.exists) premioDoc = canonicalSnap;
      }
      if (!premioDoc) {
        const premioByEventoWalletSnap = await db
          .collection('Billetera')
          .doc(billeteraObjetivo)
          .collection('premiosPendientesDirectos')
          .where('eventoGanadorId', '==', eventoGanadorId)
          .limit(2)
          .get();
        if (premioByEventoWalletSnap.size > 1) {
          return res.status(409).json({
            error: 'Se encontraron múltiples premios pendientes para el evento indicado en la billetera del jugador.',
            eventoGanadorId,
            billeteraId: billeteraObjetivo
          });
        }
        if (!premioByEventoWalletSnap.empty) {
          premioDoc = premioByEventoWalletSnap.docs[0];
        }
      }
    }

    if (!premioDoc && billeteraObjetivo && premioId) {
      const premioByWalletRef = db
        .collection('Billetera')
        .doc(billeteraObjetivo)
        .collection('premiosPendientesDirectos')
        .doc(premioId);
      const premioByWalletSnap = await premioByWalletRef.get();
      if (premioByWalletSnap.exists) {
        premioDoc = premioByWalletSnap;
      }
    }

    if (!premioDoc && !isPlayerScopedCall && eventoGanadorId) {
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
        code: 'PREMIO_NO_EXISTE',
        premioId: premioId || null,
        eventoGanadorId: eventoGanadorId || null
      });
    }

    const premioBilleteraId = normalizeString(premioDoc.ref?.parent?.parent?.id, 160).toLowerCase();
    if (isPlayerScopedCall && premioBilleteraId !== billeteraObjetivo) {
      return res.status(403).json({
        error: 'El premio no pertenece a la billetera del jugador autenticado.',
        code: 'PREMIO_NO_PERTENECE_JUGADOR',
        billeteraId: billeteraObjetivo
      });
    }

    const premioData = premioDoc.data() || {};
    const sorteoId = normalizeString(req.body?.sorteoId, 120) || normalizeString(premioData.sorteoId, 120);
    if (!sorteoId) {
      return res.status(400).json({
        error: 'No se pudo determinar el sorteoId del premio pendiente a acreditar.'
      });
    }
    const sorteoSnap = await db.collection('sorteos').doc(sorteoId).get();
    const estadoSorteo = normalizeSorteoEstadoForAcreditacion(sorteoSnap.data()?.estado);
    if (!['jugando', 'finalizado'].includes(estadoSorteo)) {
      return res.status(422).json({
        error: 'Solo se permite acreditar premios cuando el sorteo está en estado Jugando o Finalizado.',
        code: 'ESTADO_SORTEO_INVALIDO',
        premiosEngineV2Enabled: PREMIOS_ENGINE_V2_ENABLED,
        sorteoId,
        estadoSorteo: estadoSorteo || 'desconocido'
      });
    }

    const acreditadoPor = normalizeString(req.user?.email, 200) || 'sistema:acreditar-premio-evento';
    const origen = normalizeString(
      origenCliente ? `backend/acreditarPremioEvento/${origenCliente}` : 'backend/acreditarPremioEvento',
      220
    );
    const result = await reconcileSinglePendingPrize({
      db,
      premioDoc,
      sorteoId,
      acreditadoPor,
      origen,
      eventoGanadorId
    });

    await db.collection('adminAccessAudit').add({
      uid: req.user?.uid || null,
      email: acreditadoPor,
      role: req.user?.role || 'desconocido',
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      motivo: 'acreditar_premio_evento',
      resultado: result?.status === 'acreditado' ? 'acreditado' : (result?.reason || 'omitido'),
      premioId: result?.premioId || normalizeString(premioDoc.id, 320).toLowerCase(),
      eventoGanadorId: normalizeString(eventoGanadorId || premioData.eventoGanadorId, 320) || null,
      sorteoId,
      billeteraId: premioBilleteraId || billeteraObjetivo || null,
      acreditadoPor,
      origen
    });

    if (result?.status === 'acreditado') {
      return res.json({
        status: 'ok',
        resultado: 'acreditado',
        idempotente: false,
        premioId: result.premioId,
        creditos: result.creditos,
        cartones: result.cartones,
        eventoGanadorId: result.eventoGanadorId || normalizeString(eventoGanadorId || premioData.eventoGanadorId, 320) || null,
        billeteraId: premioBilleteraId || billeteraObjetivo || null
      });
    }

    if (result?.reason === 'ya_acreditado') {
      return res.json({
        status: 'ok',
        resultado: 'ya_acreditado',
        code: 'PREMIO_YA_ACREDITADO',
        idempotente: true,
        premioId: result.premioId || normalizeString(premioDoc.id, 320).toLowerCase(),
        eventoGanadorId: normalizeString(eventoGanadorId || premioData.eventoGanadorId, 320) || null,
        billeteraId: premioBilleteraId || billeteraObjetivo || null
      });
    }

    if (result?.reason === 'premio_duplicado') {
      return res.status(409).json({
        error: 'El premio ya tiene una transacción previa y se marcó como acreditado sin duplicar saldo.',
        code: 'PREMIO_DUPLICADO',
        idempotente: true,
        premioId: result.premioId || normalizeString(premioDoc.id, 320).toLowerCase(),
        eventoGanadorId: normalizeString(eventoGanadorId || premioData.eventoGanadorId, 320) || null,
        billeteraId: premioBilleteraId || billeteraObjetivo || null
      });
    }

    if (result?.reason === 'estado_no_pendiente') {
      return res.status(409).json({
        error: 'El premio no está en estado pendiente y no puede acreditarse.',
        code: 'PREMIO_ESTADO_INVALIDO',
        detalle: result || null
      });
    }

    if (result?.reason === 'premio_no_existe') {
      return res.status(404).json({
        error: 'No se encontró el premio pendiente directo solicitado.',
        code: 'PREMIO_NO_EXISTE',
        detalle: result || null
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

app.post('/acreditarPremioEvento', verificarOperadorPrivilegiadoOJugadorAcreditacion, acreditarPremioEventoHandler);

app.post('/admin/finalizar-sorteo', verificarOperadorFinalizacion, async (req, res) => {
  const sorteoId = normalizeString(req.body?.sorteoId, 120);
  if (!sorteoId) {
    return res.status(400).json({
      permitido: false,
      motivo: 'sorteo_id_obligatorio',
      detalle: { mensaje: 'sorteoId es obligatorio' }
    });
  }
  const db = admin.firestore();
  try {
    const resultado = await executeAuthoritativeSorteoFinalization({
      db,
      sorteoId,
      operadorEmail: req.user?.email || 'desconocido'
    });
    if (!resultado.permitido && resultado.motivo === 'sorteo_no_encontrado') {
      return res.status(404).json(resultado);
    }
    if (!resultado.permitido) {
      return res.status(409).json(resultado);
    }
    return res.status(200).json(resultado);
  } catch (error) {
    console.error('Error en finalización autoritativa del sorteo', { sorteoId, error });
    return res.status(500).json({
      permitido: false,
      motivo: 'error_finalizacion',
      detalle: { mensaje: 'Error interno al finalizar sorteo', code: normalizeString(error?.code, 80) || null }
    });
  }
});

app.post('/admin/generar-premios-pendientes-directos-oficiales', verificarToken, async (req, res) => {
  const sorteoId = normalizeString(req.body?.sorteoId, 120);
  if (!sorteoId) {
    return res.status(400).json({ error: 'sorteoId es obligatorio' });
  }
  if (!PREMIOS_ENGINE_V2_ENABLED) {
    const disabled = buildPremiosEngineDisabledResponse({ action: 'generar-premios-pendientes-directos-oficiales', sorteoId, status: 409 });
    return res.status(disabled.statusCode).json(disabled.payload);
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
  if (!PREMIOS_ENGINE_V2_ENABLED) {
    const disabled = buildPremiosEngineDisabledResponse({ action: 'reconciliar-premios-pendientes-directos', sorteoId, status: 409 });
    return res.status(disabled.statusCode).json(disabled.payload);
  }

  try {
    const db = admin.firestore();
    const sorteoSnap = await db.collection('sorteos').doc(sorteoId).get();
    const estadoSorteo = normalizeString(sorteoSnap.data()?.estado, 40).toLowerCase();
    if (estadoSorteo !== 'finalizado') {
      return res.status(422).json({
        error: 'Solo se permite acreditar premios pendientes cuando el sorteo está en estado Finalizado.',
        code: 'SORTEO_NO_FINALIZADO',
        sorteoId,
        estadoSorteo: estadoSorteo || 'desconocido',
        premiosEngineV2Enabled: PREMIOS_ENGINE_V2_ENABLED
      });
    }

    const resultado = await reconcilePendingPrizesBySorteo({
      db,
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
  normalizeOperationalRole,
  buildFinalizationContract,
  executeAuthoritativeSorteoFinalization,
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
  acreditarPremioEventoHandler,
  syncClaimsHandler,
  normalizeLoteriaImageItem,
  listLocalLoteriaImages,
  listStorageLoteriaImages,
  getLoteriasImageCatalog,
  toPublicImageUrl,
  normalizeLoteriaImageKey,
  buildLoteriasImageSyncReport
};
