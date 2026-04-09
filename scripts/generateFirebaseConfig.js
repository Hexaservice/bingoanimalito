#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const templatePath = path.resolve(__dirname, '../public/firebase-config.template.js');
const outputPath = path.resolve(__dirname, '../public/firebase-config.js');

const parseBoolean = (value, fallback) => {
  if (typeof value === 'undefined') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'si'].includes(normalized)) return true;
  if (['false', '0', 'no'].includes(normalized)) return false;
  return fallback;
};

const parseAuthorizedDomains = () => {
  const raw = process.env.FIREBASE_AUTH_AUTHORIZED_DOMAINS_JSON;
  if (!raw) {
    return [
      'bingoanimalito.web.app',
      'bingoanimalito.firebaseapp.com',
      'bingoanimalito.juega-online.com',
      'localhost'
    ];
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('Debe ser un arreglo JSON.');
    return parsed.map((entry) => String(entry).trim()).filter(Boolean);
  } catch (error) {
    throw new Error(`FIREBASE_AUTH_AUTHORIZED_DOMAINS_JSON inválido: ${error.message}`);
  }
};

const replacements = {
  '__FIREBASE_API_KEY__': process.env.FIREBASE_API_KEY || 'AIzaSyDFDwPoH0Gl6GO3O0gLVmcTtcaXsYgUSV0',
  '__FIREBASE_AUTH_DOMAIN__': process.env.FIREBASE_AUTH_DOMAIN || 'bingoanimalito.firebaseapp.com',
  '__FIREBASE_DATABASE_URL__': process.env.FIREBASE_DATABASE_URL || '',
  '__FIREBASE_PROJECT_ID__': process.env.FIREBASE_PROJECT_ID || 'bingoanimalito',
  '__FIREBASE_STORAGE_BUCKET__': process.env.FIREBASE_STORAGE_BUCKET || 'bingoanimalito.firebasestorage.app',
  '__FIREBASE_MESSAGING_SENDER_ID__': process.env.FIREBASE_MESSAGING_SENDER_ID || '396029548802',
  '__FIREBASE_APP_ID__': process.env.FIREBASE_APP_ID || '1:396029548802:web:88c183bf7e1d7df9d60a1b',
  '__FIREBASE_AUTH_GOOGLE_ENABLED__': String(parseBoolean(process.env.FIREBASE_AUTH_GOOGLE_ENABLED, true)),
  '__FIREBASE_AUTH_APPLE_ENABLED__': String(parseBoolean(process.env.FIREBASE_AUTH_APPLE_ENABLED, false)),
  '__FIREBASE_AUTH_AUTHORIZED_DOMAINS__': JSON.stringify(parseAuthorizedDomains(), null, 2)
    .split('\n')
    .map((line, index) => (index === 0 ? line : `  ${line}`))
    .join('\n'),
  '__UPLOAD_ENDPOINT__': process.env.UPLOAD_ENDPOINT || ''
};

const template = fs.readFileSync(templatePath, 'utf8');
let output = template;
Object.entries(replacements).forEach(([token, value]) => {
  output = output.replaceAll(token, value);
});

const header = '// Archivo generado por scripts/generateFirebaseConfig.js.\n';
fs.writeFileSync(outputPath, `${header}${output}`);
console.log(`Generado: ${path.relative(process.cwd(), outputPath)}`);
