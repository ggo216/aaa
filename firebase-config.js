// ===================== Firebase project config =====================
// Fill these in from: Firebase Console -> Project settings -> General -> "내 앱" -> 웹 앱(</>) -> firebaseConfig
// These values are public identifiers (not secrets) and are safe to ship in client code;
// actual data access is protected by Firestore security rules, not by hiding this object.
const firebaseConfig = {
  apiKey: "AIzaSyARZzj2SaiMyEvrSvOoJOsVzL424l88pvs",
  authDomain: "aaad-b9f45.firebaseapp.com",
  projectId: "aaad-b9f45",
  storageBucket: "aaad-b9f45.firebasestorage.app",
  messagingSenderId: "152778097399",
  appId: "1:152778097399:web:6a92ae81bea31e454309f2",
  measurementId: "G-2XZFBG3955",
};

if (firebaseConfig.apiKey === "YOUR_API_KEY") {
  console.warn('[AAA] firebase-config.js is still using placeholder values — cloud login/save will not work until you paste your real Firebase config here.');
} else {
  firebase.initializeApp(firebaseConfig);
}
