const admin = require('firebase-admin');
const fs = require('fs');

const BANK_NAMES_FROM_BINGO_ONLINE = [
  '0108 - Banco Provincial',
  '0134 - Banesco Banco Universal',
  '0116 - Banco Occidental de Descuento',
  '0191 - Banco Nacional de Crédito',
  '0163 - Banco del Tesoro',
  '0115 - Banco Exterior',
  '0128 - Banco Caroní',
  '0151 - Banco Fondo Común',
  '0138 - Banco Plaza',
  '0175 - Banco Bicentenario',
  '0137 - Banco Sofitasa',
  '0171 - Banco Activo',
  '0104 - Banco Venezolano de Crédito',
  '0166 - Banco Agrícola de Venezuela',
  '0174 - Banplus Banco Universal',
  '0114 - Banco del Caribe',
  '0156 - 100% Banco',
  '0106 - Banco Industrial de Venezuela',
  '0177 - Banco BANFANB',
  '0168 - Banco Mi Banco',
  '0146 - Banco del Pueblo Soberano',
  '0121 - Banco Provincial de Crédito',
  '0132 - Banco Guayana',
  '0190 - Citibank',
  '0187 - Banco de Exportación y Comercio',
  '0172 - Banco Bancamiga',
  '0193 - Banco Fintec',
];

function getCredentialsPath() {
  const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || './serviceAccountKey.json';
  if (!fs.existsSync(credentialsPath)) {
    console.error('Service account credentials not found at', credentialsPath);
    process.exit(1);
  }
  return credentialsPath;
}

function initializeFirebase() {
  if (!admin.apps.length) {
    const credentialsPath = getCredentialsPath();
    admin.initializeApp({
      credential: admin.credential.cert(require(credentialsPath)),
    });
  }
  return admin.firestore();
}

async function ensureBankForPlayers(db, nombre) {
  const existing = await db
    .collection('Bancos')
    .where('nombre', '==', nombre)
    .where('categoria', '==', 'Jugadores')
    .limit(1)
    .get();

  if (!existing.empty) {
    const doc = existing.docs[0];
    await doc.ref.set(
      {
        id: doc.id,
        nombre,
        categoria: 'Jugadores',
        estado: 'Activo',
      },
      { merge: true }
    );
    return { action: 'updated', id: doc.id, nombre };
  }

  const newRef = db.collection('Bancos').doc();
  await newRef.set({
    id: newRef.id,
    nombre,
    categoria: 'Jugadores',
    estado: 'Activo',
  });

  return { action: 'created', id: newRef.id, nombre };
}

async function main() {
  const db = initializeFirebase();
  const results = [];

  for (const nombre of BANK_NAMES_FROM_BINGO_ONLINE) {
    // eslint-disable-next-line no-await-in-loop
    const result = await ensureBankForPlayers(db, nombre);
    results.push(result);
  }

  const created = results.filter(r => r.action === 'created').length;
  const updated = results.filter(r => r.action === 'updated').length;

  console.log('Colección Bancos sincronizada para categoría Jugadores.');
  console.log(`Creados: ${created} | Actualizados: ${updated} | Total: ${results.length}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Error initializing banks:', err);
    process.exit(1);
  });
