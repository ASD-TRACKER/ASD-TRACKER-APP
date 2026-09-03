import { initializeApp } from "firebase/app";
import {
  initializeFirestore,
  persistentLocalCache,
  persistentSingleTabManager,
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

// IndexedDB persistence: writes are queued locally so the UI updates instantly.
// The SDK syncs to Firebase servers in the background — server ACK can take
// 1-5 s on a normal connection. Use persistentSingleTabManager (not multiple)
// to avoid cross-tab coordination overhead that delays server sync.
export const db = app ? initializeFirestore(app, {
  localCache: persistentLocalCache({
    tabManager: persistentSingleTabManager(),
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
