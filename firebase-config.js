// ============================================================
// PASTE YOUR FIREBASE CONFIG BELOW.
// Get it from: Firebase Console → Project settings → General
// → "Your apps" → SDK setup and configuration → Config
// (Same project you already use for x1877m — Firestore only,
//  no Storage needed since your billing blocks Storage.)
// ============================================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyCNCJcm1QXHRbdj_oG2yWChmT7XGtOVeHE",
  authDomain: "x1877m-3794a.firebaseapp.com",
  projectId: "x1877m-3794a",
  storageBucket: "x1877m-3794a.firebasestorage.app",
  messagingSenderId: "248018101169",
  appId: "1:248018101169:web:e35a3bf86e2b6ef29cd390",
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
