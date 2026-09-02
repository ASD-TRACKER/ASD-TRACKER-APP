import { initializeApp } from "firebase/app";
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  connectFirestoreEmulator,
  disableNetwork,
  enableNetwork,
} from "firebase/firestore";
import { getStorage } from "firebase/storage";
import { getAuth, signInAnonymously } from "firebase/auth";

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

export const firebaseConfigured = !!firebaseConfig.apiKey;
export const app = firebaseConfigured ? initializeApp(firebaseConfig) : null;

// IndexedDB persistence: setDoc/updateDoc resolves immediately once written
// to the local IndexedDB cache — never hangs waiting for a server round-trip.
// The SDK syncs to Firebase servers in the background automatically.
// persistentMultipleTabManager ensures multiple tabs in the same browser
// share data correctly without stale-read issues.
export const db = app ? initializeFirestore(app, {
  localCache: persistentLocalCache({
    tabManager: persistentMultipleTabManager(),
  }),
}) : null;

export const storage = app ? getStorage(app) : null;
export const auth = app ? getAuth(app) : null;

// Reconnect helper — forces the SDK to drop and re-establish its server
// connection. Useful when background server sync has stalled.
export const reconnectFirestore = async () => {
  if (!db) return;
  try { await disableNetwork(db); } catch (_) {}
  try { await enableNetwork(db); } catch (_) {}
};

if (app && import.meta.env.VITE_USE_FIREBASE_EMULATOR === "true") {
  connectFirestoreEmulator(db, "127.0.0.1", 8080);
}

// Signs in anonymously so Firestore/Storage rules (request.auth != null) pass.
export const authReady = auth
  ? signInAnonymously(auth).then(() => true).catch(() => false)
  : Promise.resolve(false);
