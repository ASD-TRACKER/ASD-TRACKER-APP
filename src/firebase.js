import { initializeApp } from "firebase/app";
import { getFirestore, connectFirestoreEmulator } from "firebase/firestore";
import { getStorage } from "firebase/storage";

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
export const db = app ? getFirestore(app) : null;
export const storage = app ? getStorage(app) : null;

if (app && import.meta.env.VITE_USE_FIREBASE_EMULATOR === "true") {
  connectFirestoreEmulator(db, "127.0.0.1", 8080);
}

// No Firebase Auth — Firestore rules use: allow read, write: if true
// The app uses PIN-based auth at the application level; the Firebase project ID
// in the bundle already restricts access to users of this app.
export const authReady = Promise.resolve(!!app);
