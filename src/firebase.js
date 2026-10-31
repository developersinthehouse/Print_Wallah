const { cert, getApps, initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

function initializeFirebase(environment = process.env) {
  const rawCredentials = String(environment.FIREBASE_SERVICE_ACCOUNT_JSON || '').trim();
  const projectId = String(environment.FIREBASE_PROJECT_ID || '').trim();

  if (!rawCredentials || !projectId) {
    throw new Error('Firebase setup is incomplete. Configure FIREBASE_PROJECT_ID and FIREBASE_SERVICE_ACCOUNT_JSON.');
  }

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(rawCredentials);
  } catch (error) {
    throw new Error(`FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON: ${error.message}`, { cause: error });
  }
  if (serviceAccount.project_id !== projectId || !serviceAccount.client_email || !serviceAccount.private_key) {
    throw new Error('Firebase service account JSON must match FIREBASE_PROJECT_ID and include client_email and private_key.');
  }

  const app = getApps()[0] || initializeApp({
    credential: cert(serviceAccount),
    projectId,
  });
  const db = getFirestore(app);
  db.settings({ ignoreUndefinedProperties: true });

  return {
    app,
    db,
    projectId,
  };
}

let instance;
function getFirebase() {
  if (!instance) instance = initializeFirebase();
  return instance;
}

module.exports = { getFirebase, initializeFirebase };
