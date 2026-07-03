import { initializeApp } from "firebase/app";
import { getFirestore, connectFirestoreEmulator } from "firebase/firestore";
import { getAuth, signInAnonymously, connectAuthEmulator } from "firebase/auth";

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

// True once a real project is wired up via .env.local — see .env.example.
// Until then, the app falls back to localStorage-only (today's behavior, no cross-device sync).
export const firebaseConfigured = !!firebaseConfig.apiKey;

export const app = firebaseConfigured ? initializeApp(firebaseConfig) : null;
export const db = app ? getFirestore(app) : null;
const auth = app ? getAuth(app) : null;

// Local development against the Firebase Emulator Suite (firebase emulators:start) —
// opt in with VITE_USE_FIREBASE_EMULATOR=true so production builds never point at it by accident.
if (app && import.meta.env.VITE_USE_FIREBASE_EMULATOR === "true") {
  connectFirestoreEmulator(db, "127.0.0.1", 8080);
  connectAuthEmulator(auth, "http://127.0.0.1:9099");
}

// Anonymous auth — no sign-in UI, just blocks fully-unauthenticated internet access once
// Firestore rules require request.auth != null. Does not replace the app's own PIN-based
// "who's at the keyboard" identification; it only gates access to the database itself.
export const authReady = app
  ? signInAnonymously(auth).then(() => true).catch(err => { console.error("Firebase anonymous sign-in failed:", err); return false; })
  : Promise.resolve(false);
