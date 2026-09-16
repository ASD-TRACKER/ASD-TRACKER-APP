import { initializeApp } from "firebase/app";
import {
  initializeFirestore,
  memoryLocalCache,
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

// Memory-only cache: no IndexedDB. Writes go directly to the server without
// queuing in IndexedDB. Eliminates the write-stream-exhausted cycle where
// IndexedDB accumulates 500+ pending mutation batches from failed retries and
// floods the SDK write stream on reconnect. The app's own REC_ recovery saves
// (every 3 min) mean no data is lost across page reloads.
export const db = app ? initializeFirestore(app, {
  localCache: memoryLocalCache(),
}) : null;
// eslint-disable-next-line no-console
console.log("[ASD] Firestore cache: memory-only (no IndexedDB)");

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
// build-tag: memoryLocalCache
