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

// merges cloud data with whatever's already in state (already loaded from local
// storage by the time this runs) instead of blindly overwriting it. This used to be
// a straight overwrite, which meant: earn lab tokens -> saved locally instantly and
// correctly -> but the cloud save is debounced 800ms and isn't guaranteed to complete
// before the tab gets backgrounded/reloaded (no reliable flush-on-hide for a network
// write) -> next load, Firebase auth is still signed in -> loadCloudProgress() runs
// automatically and overwrote the correctly-persisted local tokens with the STALE
// cloud snapshot from before they were earned. Taking the max on every numeric/
// monotonic field (and per-card/per-node where the data is structured) means neither
// side can ever regress the other, regardless of which write actually landed first.
function mergeCloudData(data) {
  if (data.collection) {
    const merged = { ...state.collection };
    for (const defId of Object.keys(data.collection)) {
      const cloudEntry = data.collection[defId];
      const localEntry = merged[defId];
      if (!localEntry) { merged[defId] = cloudEntry; continue; }
      // keep whichever side is further along for THIS card — comparing level first
      // (count naturally drops as you spend duplicates enhancing, so a lower count
      // at a higher level is expected progress, not a loss) keeps each card's own
      // {count, level} pair internally consistent rather than mixing fields from
      // both sides and producing a state neither side actually had
      const cloudAhead = cloudEntry.level > localEntry.level
        || (cloudEntry.level === localEntry.level && cloudEntry.count > localEntry.count);
      merged[defId] = cloudAhead ? cloudEntry : localEntry;
    }
    state.collection = merged;
  }
  if (data.activeDeck) state.activeDeck = data.activeDeck.filter(id => state.collection[id]);
  if (typeof data.bestWave === 'number') state.bestWave = Math.max(state.bestWave, data.bestWave);
  if (typeof data.gems === 'number') state.gems = Math.max(state.gems, data.gems);
  if (typeof data.cardCoin === 'number') state.cardCoin = Math.max(state.cardCoin, data.cardCoin);
  if (typeof data.masteryPoints === 'number') state.masteryPoints = Math.max(state.masteryPoints || 0, data.masteryPoints);
  if (data.labTokens) {
    const merged = { ...state.labTokens };
    for (const subKey of Object.keys(data.labTokens)) merged[subKey] = Math.max(merged[subKey] || 0, data.labTokens[subKey] || 0);
    state.labTokens = merged;
  }
  if (data.labProgress) {
    const merged = { ...state.labProgress };
    for (const subKey of Object.keys(data.labProgress)) {
      const mergedSub = { ...(merged[subKey] || {}) };
      for (const nodeId of Object.keys(data.labProgress[subKey])) {
        // node levels only ever go up, so the higher one is always the correct one
        mergedSub[nodeId] = Math.max(mergedSub[nodeId] || 0, data.labProgress[subKey][nodeId] || 0);
      }
      merged[subKey] = mergedSub;
    }
    state.labProgress = merged;
  }
}

async function loadCloudProgress() {
  setCloudStatus('동기화 중...');
  try {
    const snap = await userDocRef().get();
    if (snap.exists) {
      const data = snap.data();
      applyingCloudData = true;
      mergeCloudData(data);
      updateDeckBonus();
      applyingCloudData = false;
      setCloudStatus(`${currentUser.displayName || currentUser.email} 님으로 동기화됨`);
      // the merge may have pulled local-only progress that the cloud doesn't have yet
      // (or vice versa) — push the merged result back up so both sides converge
      await saveCloudProgress();
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
      labTokens: state.labTokens,
      labProgress: state.labProgress,
      masteryPoints: state.masteryPoints,
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
