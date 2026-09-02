import { initializeApp } from "firebase/app";
import {
  initializeFirestore,
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

// Use initializeFirestore with experimentalAutoDetectLongPolling so Firestore
// automatically falls back from WebSocket to long-polling when the WebSocket
// connection is blocked or stuck — fixes write-timeout errors in environments
// where WebSocket upgrade is unreliable (corporate networks, some mobile carriers).
export const db = app ? initializeFirestore(app, {
  experimentalAutoDetectLongPolling: true,
}) : null;

export const storage = app ? getStorage(app) : null;
export const auth = app ? getAuth(app) : null;

// Force-reconnect helper — call when writes are timing out.
// Disables then re-enables the Firestore network, flushing any stuck WebSocket
// and causing the SDK to establish a fresh connection.
export const reconnectFirestore = async () => {
  if (!db) return;
  try { await disableNetwork(db); } catch (_) {}
  try { await enableNetwork(db); } catch (_) {}
};

if (app && import.meta.env.VITE_USE_FIREBASE_EMULATOR === "true") {
  connectFirestoreEmulator(db, "127.0.0.1", 8080);
}

// Signs in anonymously so Firestore/Storage rules (request.auth != null) pass.
// The anonymous UID is ephemeral — it's only used to prove this is a legitimate
// app session, not a raw API scraper.
export const authReady = auth
  ? signInAnonymously(auth).then(() => true).catch(() => false)
  : Promise.resolve(false);
