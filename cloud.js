// ===================== Cloud save (Firebase Auth + Firestore) =====================
// Syncs only account-level meta-progression across devices: owned card collection,
// the active deck, best wave record, gems, and card coin. Run-scoped state (gold,
// current wave, placed/bench units, in-run upgrades) is intentionally local-only —
// it always resets on a new run anyway (see resetRun() in game.js).

let currentUser = null;
let cloudReady = typeof firebase !== 'undefined' && firebase.apps && firebase.apps.length > 0;
let cloudSaveTimer = null;
let applyingCloudData = false; // guard so loading cloud data doesn't immediately re-trigger a save

function cloudStatusEl() { return document.getElementById('cloudStatus'); }

function setCloudStatus(text) {
  const el = cloudStatusEl();
  if (el) el.textContent = text;
}

async function signInWithGoogle() {
  if (!cloudReady) { setCloudStatus('Firebase 설정이 아직 연결되지 않았습니다 (firebase-config.js 확인)'); return; }
  try {
    const provider = new firebase.auth.GoogleAuthProvider();
    await firebase.auth().signInWithPopup(provider);
  } catch (e) {
    setCloudStatus('로그인 실패: ' + e.message);
  }
}

function signOutOfGoogle() {
  if (!cloudReady) return;
  firebase.auth().signOut();
}

function userDocRef() {
  return firebase.firestore().collection('players').doc(currentUser.uid);
}

async function loadCloudProgress() {
  setCloudStatus('동기화 중...');
  try {
    const snap = await userDocRef().get();
    if (snap.exists) {
      const data = snap.data();
      applyingCloudData = true;
      if (data.collection) state.collection = data.collection;
      if (data.activeDeck) state.activeDeck = data.activeDeck.filter(id => state.collection[id]);
      if (typeof data.bestWave === 'number') state.bestWave = Math.max(state.bestWave, data.bestWave);
      if (typeof data.gems === 'number') state.gems = data.gems;
      if (typeof data.cardCoin === 'number') state.cardCoin = data.cardCoin;
      updateDeckBonus();
      applyingCloudData = false;
      setCloudStatus(`${currentUser.displayName || currentUser.email} 님으로 동기화됨`);
    } else {
      // first time this account has played: push current local progress up
      await saveCloudProgress();
      setCloudStatus(`${currentUser.displayName || currentUser.email} 님으로 동기화됨`);
    }
    render();
  } catch (e) {
    setCloudStatus('불러오기 실패: ' + e.message);
  }
}

async function saveCloudProgress() {
  if (!cloudReady || !currentUser || applyingCloudData) return;
  try {
    await userDocRef().set({
      collection: state.collection,
      activeDeck: state.activeDeck,
      bestWave: state.bestWave,
      gems: state.gems,
      cardCoin: state.cardCoin,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  } catch (e) {
    setCloudStatus('저장 실패: ' + e.message);
  }
}

// called from render() in game.js after any meaningful UI update; debounced so rapid
// clicks (gacha spam, deck edits) don't spam Firestore with a write per click
function scheduleCloudSave() {
  if (!currentUser || applyingCloudData) return;
  clearTimeout(cloudSaveTimer);
  cloudSaveTimer = setTimeout(saveCloudProgress, 800);
}

function updateAuthUi() {
  const signedOutView = document.getElementById('authSignedOut');
  const signedInView = document.getElementById('authSignedIn');
  if (!signedOutView || !signedInView) return;
  signedOutView.classList.toggle('hidden', !!currentUser);
  signedInView.classList.toggle('hidden', !currentUser);
  const nameEl = document.getElementById('authUserName');
  if (nameEl && currentUser) nameEl.textContent = currentUser.displayName || currentUser.email || '플레이어';
}

if (cloudReady) {
  firebase.auth().onAuthStateChanged(async (user) => {
    currentUser = user;
    updateAuthUi();
    if (user) {
      await loadCloudProgress();
    } else {
      setCloudStatus('로그인하면 다른 기기에서도 이어할 수 있어요');
    }
  });
} else {
  document.addEventListener('DOMContentLoaded', () => {
    setCloudStatus('Firebase 설정이 아직 연결되지 않았습니다');
  });
}

document.getElementById('googleSignInBtn') && (document.getElementById('googleSignInBtn').onclick = signInWithGoogle);
document.getElementById('signOutBtn') && (document.getElementById('signOutBtn').onclick = signOutOfGoogle);
