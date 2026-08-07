// ===================== AAA Defense - Game Logic =====================
// per-subtype identity color: used to tint that subtype's basic-attack projectile/hit
// particles so units read as visually distinct at a glance (crit still overrides to gold
// everywhere it already did — this only changes the NON-crit baseline color per subKey)
const SUBTYPE_COLORS = {
  atk_single: '#e0553f',    // sharp red/orange
  atk_multi: '#c17a41',     // warm amber (matches its existing explosion color)
  magic_multi: '#e0803f',   // fire orange
  magic_ctrl: '#5fb8d9',    // icy cyan
  ranged_single: '#4a90d9', // steel blue (kept close to prior universal blue)
  buff_debuff: '#8a5fc1',   // violet curse
  buff_support: '#3c9c68',  // green (matches its existing buff-zone color)
  heal_support: '#5fcf8a',  // soft green/white
  tank_guard: '#9aa1ad',    // grey/steel
};
const GRID = 5;
const CELL = 76; // smaller cells than before
const MARGIN = 52; // space between canvas edge and the 5x5 grid, hosts the outer monster track
const TRACK_GAP = 22; // distance from the grid edge to the track centerline
const canvas = document.getElementById('field');
const ctx = canvas.getContext('2d');
canvas.width = GRID * CELL + MARGIN * 2;
canvas.height = GRID * CELL + MARGIN * 2;

// cached refs for the handful of DOM nodes touched every animation frame (60/sec),
// instead of re-querying the DOM on each tick
const HUD = {
  wave: document.getElementById('waveLabel'),
  swarm: document.getElementById('swarmLabel'),
  timer: document.getElementById('timerLabel'),
  gold: document.getElementById('goldLabel'),
  collGem: document.getElementById('collGemLabel'), // gems (특수재화) only ever shown on the collection screen now
  collCoin: document.getElementById('collCoinLabel'),
};
HUD.timerStat = HUD.timer.closest('.stat');
HUD.swarmStat = HUD.swarm.closest('.stat');
HUD.goldStat = HUD.gold.closest('.stat');
HUD.collGemStat = HUD.collGem ? HUD.collGem.closest('.stat') : null;
HUD.collCoinStat = HUD.collCoin ? HUD.collCoin.closest('.stat') : null;

// all 25 cells of the 5x5 map are placeable; monsters loop forever around a
// track that runs OUTSIDE the grid border (like the original design), so the
// track never eats into placement space
const INTERIOR = [];
for (let r = 0; r < GRID; r++)
  for (let c = 0; c < GRID; c++)
    INTERIOR.push({ c, r });

const DECK_SIZE = 8;
const MONSTER_SWARM_CAP = 100; // instant game-over threshold if the field ever holds this many live monsters
const MAX_SPEED_MULT = 5; // was 10 — the highest multiplier was the single biggest per-frame cost spike
const BENCH_MAX = 5;

function cellCenter(c, r) { return { x: MARGIN + c * CELL + CELL / 2, y: MARGIN + r * CELL + CELL / 2 }; }
function cellKey(c, r) { return `${c},${r}`; }

// assigns a placed instance's cell and caches its pixel center on the instance itself.
// tickCombat() and draw() run for every placed unit every single tick/frame — re-parsing
// "c,r" out of the key string (split+map, two array allocations) and recomputing a fresh
// {x,y} object every time was a real source of GC-pressure frame spikes under sustained
// combat (found via a max/p99 frame-time stress test). Computing it once here, only when
// a unit actually moves, and reading the cached inst.center everywhere else fixes that.
function placeUnitAt(inst, key) {
  inst.cellKey = key;
  const [c, r] = key.split(',').map(Number);
  inst.center = cellCenter(c, r);
}

// ---------------- outer track (perimeter loop monsters march along) ----------------
const TRACK_CORNERS = (() => {
  const x0 = MARGIN - TRACK_GAP, y0 = MARGIN - TRACK_GAP;
  const x1 = MARGIN + GRID * CELL + TRACK_GAP, y1 = MARGIN + GRID * CELL + TRACK_GAP;
  return [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
})();
const TRACK_SEGMENTS = TRACK_CORNERS.map((p, i) => {
  const n = TRACK_CORNERS[(i + 1) % TRACK_CORNERS.length];
  return { a: p, b: n, len: Math.hypot(n.x - p.x, n.y - p.y) };
});
const TRACK_LENGTH = TRACK_SEGMENTS.reduce((s, seg) => s + seg.len, 0);

function trackPoint(dist, laneOffset) {
  dist = ((dist % TRACK_LENGTH) + TRACK_LENGTH) % TRACK_LENGTH;
  const off = laneOffset || 0;
  for (const seg of TRACK_SEGMENTS) {
    if (dist <= seg.len) {
      const t = seg.len === 0 ? 0 : dist / seg.len;
      const ux = (seg.b.x - seg.a.x) / (seg.len || 1), uy = (seg.b.y - seg.a.y) / (seg.len || 1);
      const px = -uy, py = ux; // perpendicular unit vector
      return { x: seg.a.x + (seg.b.x - seg.a.x) * t + px * off, y: seg.a.y + (seg.b.y - seg.a.y) * t + py * off };
    }
    dist -= seg.len;
  }
  return TRACK_CORNERS[0];
}

// ---------------- state ----------------
const state = {
  screen: 'home', // home | game | collection
  phase: 'idle', // idle | prep | wave | gameover
  wave: 0,
  bestWave: Number(localStorage.getItem('aaa_best_wave') || 0),
  waveTimer: 0,
  waveDuration: 45,
  prepTimer: 3,
  gold: 50,
  gems: 0,
  cardCoin: 30,
  monsters: [],
  monsterSeq: 0,
  spawnQueue: [],
  spawnTimer: 0,
  placed: {}, // cellKey -> unit instance
  bench: [],
  collection: {}, // defId -> { count, level }
  activeDeck: [], // up to DECK_SIZE defIds; only these are summonable
  deckBonus: {},
  runUpgrades: {}, // defId -> level; gold-funded, in-run only, resets on reload/restart
  labTokens: {}, // legacy per-subtype pool from before the token/mastery merge — kept only
                  // so reconcileLabPoints() can fold an old save's leftover balance into
                  // masteryPoints on load; nothing writes to this anymore
  masteryPoints: 0, // 연구실 포인트: single shared pool, 4 per card enhancement level-up, spendable on ANY subtype's tree
  labProgress: {}, // subKey -> { nodeId -> level }, persistent, benefits every card of that subtype
  labSelectedSub: 'atk_single',
  bulkSellMaxGrade: BULK_SELL_MAX_GRADE, // player-adjustable in-run via the grade picker next to 일괄 판매; defaults to the same 'A' ceiling as before
  instSeq: 0,
  selected: null, // {kind:'bench', idx} | {kind:'field', key}
  selectedAt: 0, // timestamp of the last selection change, for a quick range-indicator fade-in
  projectiles: [],
  particles: [],
  floatingTexts: [],
  zones: [], // lingering ground-effect areas (fire/plague), see spawnZone/tickZones
  turrets: [], // temporary buff_support deployables, see spawnTurret/tickTurrets
  rings: [], // fast expand/fade shockwave rings (atk_multi big explosion), see spawnShockRing
  bolts: [], // jagged lightning polylines (ranged_single chain lightning), see spawnBolt
  bombs: [], // pending bomb-attach detonations (atk_single capstone), see attachBomb/tickBombs
  meteors: [], // telegraphed delayed AoE strikes (magic_multi capstone), see spawnMeteor/tickMeteors
  lasers: [], // sustained/piercing beam VFX (ranged_single capstone), see spawnLaserBeam
  speedMult: 1,
  // now a COUNTER (not boolean): with boss-count-per-wave scaling (see beginWave), a boss
  // wave can spawn several bosses at once, so this tracks how many are still alive rather
  // than a single true/false — endWave()'s fail check needs ALL of them dead, not just one
  bossAliveThisWave: 0,
  bossKilledInTime: true,
};

function log(msg) {
  const el = document.getElementById('log');
  el.textContent = msg;
}

// ---------------- local persistence ----------------
// previously ONLY bestWave survived a reload; everything else (collection, deck,
// currencies, lab tokens/progress, and the in-progress run) lived purely in memory.
// iOS Safari frequently reloads a backgrounded home-screen-bookmarked tab to reclaim
// memory, which silently wiped all of it — this is the root cause behind "게임이
// 초기화되는 버그" and "연구실 포인트가 사라지는 버그". Persisting to localStorage
// (in addition to the existing cross-device cloud save) fixes both.
const SAVE_KEY = 'aaa_save_v1';
const RUN_SNAPSHOT_KEY = 'aaa_run_snapshot_v1';
let saveTimer = null;

function saveLocalProgress() {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({
      collection: state.collection,
      activeDeck: state.activeDeck,
      bestWave: state.bestWave,
      gems: state.gems,
      cardCoin: state.cardCoin,
      labTokens: state.labTokens,
      labProgress: state.labProgress,
      masteryPoints: state.masteryPoints,
    }));
  } catch (e) { /* storage unavailable/full — non-fatal, just skip persisting this tick */ }
}

function scheduleLocalSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveLocalProgress, 400);
}

function loadLocalProgress() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (data.collection) state.collection = data.collection;
    if (data.activeDeck) state.activeDeck = data.activeDeck.filter(id => state.collection[id]);
    if (typeof data.bestWave === 'number') state.bestWave = Math.max(state.bestWave, data.bestWave);
    if (typeof data.gems === 'number') state.gems = data.gems;
    if (typeof data.cardCoin === 'number') state.cardCoin = data.cardCoin;
    if (data.labTokens) state.labTokens = data.labTokens;
    if (data.labProgress) state.labProgress = data.labProgress;
    if (typeof data.masteryPoints === 'number') state.masteryPoints = data.masteryPoints;
  } catch (e) { /* corrupted save — ignore and start fresh rather than crash */ }
}

// a lightweight snapshot of the ACTIVE run (gold/wave/placed units/bench), saved
// continuously while a run is in progress so a mid-wave reload can resume instead
// of dumping the player back to an empty home screen
function saveRunSnapshot() {
  if (state.screen !== 'game' || state.phase === 'idle' || state.phase === 'gameover') {
    localStorage.removeItem(RUN_SNAPSHOT_KEY);
    return;
  }
  try {
    localStorage.setItem(RUN_SNAPSHOT_KEY, JSON.stringify({
      wave: state.wave, gold: state.gold, placed: state.placed, bench: state.bench,
      runUpgrades: state.runUpgrades, activeDeck: state.activeDeck, ts: Date.now(),
    }));
  } catch (e) { /* non-fatal */ }
}

function tryRestoreRunSnapshot() {
  try {
    const raw = localStorage.getItem(RUN_SNAPSHOT_KEY);
    if (!raw) return false;
    const snap = JSON.parse(raw);
    // stale snapshots (long-abandoned run, e.g. from a previous day) aren't resumed
    if (!snap || Date.now() - snap.ts > 30 * 60 * 1000) { localStorage.removeItem(RUN_SNAPSHOT_KEY); return false; }
    state.wave = snap.wave || 0;
    state.gold = typeof snap.gold === 'number' ? snap.gold : 50;
    state.placed = snap.placed || {};
    // .center is a cached-at-placement-time perf optimization (see placeUnitAt()) —
    // a snapshot saved before that existed won't have it, so re-derive it here rather
    // than trusting every restored instance to already carry it
    for (const [key, inst] of Object.entries(state.placed)) {
      if (!inst.center) { const [c, r] = key.split(',').map(Number); inst.center = cellCenter(c, r); }
      // a snapshot saved before the unit-HP system (or several other fields since
      // added) existed won't carry them — re-derive/default everything here rather
      // than trusting a restored instance to already carry the current full shape
      if (typeof ensureUnitHp === 'function') ensureUnitHp(inst);
      ensureUnitFields(inst);
    }
    state.bench = snap.bench || [];
    for (const inst of state.bench) ensureUnitFields(inst); // same gap applies to bench units — hp is fine to stay null here (lazily computed on placement)
    state.runUpgrades = snap.runUpgrades || {};
    if (snap.activeDeck) state.activeDeck = snap.activeDeck.filter(id => state.collection[id]);
    updateDeckBonus();
    document.getElementById('startRow').classList.add('hidden');
    // set phase away from 'idle' BEFORE showScreen()'s internal render() runs — render()
    // always calls saveRunSnapshot(), whose guard treats phase 'idle' as "no run in
    // progress" and deletes the snapshot; doing this after showScreen() meant the very
    // act of restoring immediately erased the snapshot it just restored, so a second
    // reload right after resuming would lose the run again
    state.phase = 'prep';
    showScreen('game');
    beginPrep(); // resume by re-running the current wave's spawn queue from a clean prep countdown
    log(`이전 진행 상황을 복구했습니다 (웨이브 ${state.wave})`);
    return true;
  } catch (e) {
    localStorage.removeItem(RUN_SNAPSHOT_KEY);
    return false;
  }
}

// ---------------- deck / collection / units ----------------
function startingDeck() {
  const picks = [];
  // deliberately still just 3 core-damage subtypes (atk/ranged/magic) even now that there
  // are 9 subtypes total (healer/tanker added) — a brand new run needs to be able to KILL
  // things from turn one; healer/tanker are support pieces that are only useful once the
  // player already has damage on the field, so they stay gacha-acquired rather than starters
  const wanted = ['atk_single', 'ranged_single', 'magic_multi'];
  for (const w of wanted) {
    const def = UNIT_DEFS.find(d => d.tierId === 'normal' && d.subKey === w && d.variant === 'I');
    picks.push(def.id);
  }
  return picks;
}

function ownedDefIdList() { return Object.keys(state.collection); }
function levelOf(defId) { return (state.collection[defId] && state.collection[defId].level) || 0; }

function enhanceCard(defId) {
  const entry = state.collection[defId];
  if (!entry) return;
  const req = enhanceRequirement(entry.level);
  if (entry.level >= ENHANCE_MAX_LEVEL || entry.count < req) return;
  entry.count -= req;
  entry.level += 1;
  const def = UNIT_DEFS_BY_ID[defId];
  // every card level-up feeds 4 연구실 포인트 into the single shared pool, spendable on
  // ANY subtype's tree — this used to be split into a subtype-locked token (2) plus a
  // separate universal mastery point (2), but having two currencies for the same thing
  // was just confusing (they even looked alike), so it's one pool now
  state.masteryPoints = (state.masteryPoints || 0) + 4;
  log(`${def.name} 강화! Lv.${entry.level} (+4 연구실 포인트)`);
  render();
}

// enhances every owned card as many times as its duplicate stock allows, in one click,
// instead of clicking each card's enhance button over and over
function bulkEnhanceAll() {
  let totalUps = 0;
  for (const defId of ownedDefIdList()) {
    const entry = state.collection[defId];
    let ups = 0;
    while (entry.level < ENHANCE_MAX_LEVEL) {
      const req = enhanceRequirement(entry.level);
      if (entry.count < req) break;
      entry.count -= req;
      entry.level += 1;
      ups++;
    }
    if (ups > 0) {
      state.masteryPoints = (state.masteryPoints || 0) + 4 * ups;
      totalUps += ups;
    }
  }
  log(totalUps > 0 ? `일괄 강화 완료! 총 ${totalUps}회 강화됨` : '강화 가능한 카드가 없습니다');
  render();
}

// deck editing is only locked while a wave is actually in progress (prep countdown
// or live combat) — computed live from phase so it can never go stale, unlike a
// separate manually-toggled flag that stayed true even after the run had ended
function isRunLocked() { return state.phase === 'prep' || state.phase === 'wave'; }

function toggleDeckCard(defId) {
  if (isRunLocked()) { log('웨이브 진행 중에는 덱을 변경할 수 없습니다'); render(); return; }
  const idx = state.activeDeck.indexOf(defId);
  if (idx >= 0) {
    state.activeDeck.splice(idx, 1);
  } else {
    if (state.activeDeck.length >= DECK_SIZE) { log(`덱은 최대 ${DECK_SIZE}장까지 구성할 수 있습니다`); render(); return; }
    state.activeDeck.push(defId);
  }
  updateDeckBonus();
  render();
}

// ---------------- in-run gold upgrades (per run only, resets on restart) ----------------
const RUN_UPGRADE_STAT_BONUS = { atk: 0.09, range: 0.04, aspd: 0.05 };
// no level cap — cost keeps climbing (25 + level*20) so it's naturally self-limiting
// by the run's gold economy rather than an artificial ceiling
function runUpgradeCost(level) { return 25 + level * 20; }

function upgradeRunType(defId) {
  if (!state.activeDeck.includes(defId) || state.phase === 'gameover') return;
  const lvl = state.runUpgrades[defId] || 0;
  const cost = runUpgradeCost(lvl);
  if (state.gold < cost) return;
  state.gold -= cost;
  state.runUpgrades[defId] = lvl + 1;
  const def = UNIT_DEFS_BY_ID[defId];
  log(`${def.name} 인게임 강화! Lv.${lvl + 1}`);
  render();
}

// ---------------- deck set bonuses ----------------
const CAT_LABEL = { attack: '공격형', magic: '마법형', ranged: '원거리형', buff: '버프형', support: '지원형', guard: '수호형' };
const CAT_EFFECT = {
  attack: { key: 'atkPct', label: '공격력' },
  magic: { key: 'critChanceAdd', label: '치명타 확률', suffix: '%p' },
  ranged: { key: 'aspdPct', label: '공격속도' },
  buff: { key: 'bossDmgAdd', label: '보스 피해' },
  // healer/tanker (#3/#4) reuse existing bonus keys rather than plumbing brand new ones
  // through computeStats — aspd for healer (faster heal cadence), atk for tanker
  support: { key: 'aspdPct', label: '공격속도' },
  guard: { key: 'atkPct', label: '공격력' },
};

function computeDeckBonuses() {
  const bonus = { atkPct: 0, aspdPct: 0, critChanceAdd: 0, bossDmgAdd: 0, allPct: 0, notes: [] };
  const deck = state.activeDeck.map(id => UNIT_DEFS_BY_ID[id]).filter(Boolean);
  if (deck.length === 0) return bonus;

  const catCount = {};
  deck.forEach(d => { catCount[d.cat] = (catCount[d.cat] || 0) + 1; });
  for (const cat of Object.keys(catCount)) {
    const n = catCount[cat];
    const eff = CAT_EFFECT[cat];
    if (n >= 5) {
      bonus[eff.key] += 18;
      bonus.notes.push({ label: `${CAT_LABEL[cat]} 5종`, desc: `${eff.label} +18${eff.suffix || '%'}` });
    } else if (n >= 3) {
      bonus[eff.key] += 8;
      bonus.notes.push({ label: `${CAT_LABEL[cat]} 3종 이상`, desc: `${eff.label} +8${eff.suffix || '%'}` });
    }
  }

  const tierRank = TIERS.map(t => t.id);
  const tierCount = {};
  deck.forEach(d => { tierCount[d.tierId] = (tierCount[d.tierId] || 0) + 1; });
  for (const tierId of Object.keys(tierCount)) {
    const n = tierCount[tierId];
    const tier = TIERS_BY_ID[tierId];
    const idx = tierRank.indexOf(tierId);
    if (n >= 5) {
      const v = 10 + idx * 3;
      bonus.allPct += v;
      bonus.notes.push({ label: `${tier.name} 등급 통일`, desc: `전체 능력치 +${v}%` });
    } else if (n >= 3) {
      const v = 4 + idx * 2;
      bonus.allPct += v;
      bonus.notes.push({ label: `${tier.name} 3종 이상`, desc: `전체 능력치 +${v}%` });
    }
  }
  return bonus;
}

function updateDeckBonus() { state.deckBonus = computeDeckBonuses(); }

// ---------------- 연구실 (research lab / skill trees) ----------------
function labNodeLevel(subKey, nodeId) {
  return (state.labProgress[subKey] && state.labProgress[subKey][nodeId]) || 0;
}

function labNodeUnlocked(subKey, node) {
  if (!node.requires) return true;
  return labNodeLevel(subKey, node.requires.id) >= node.requires.level;
}

function upgradeLabNode(subKey, nodeId) {
  const tree = LAB_TREES[subKey];
  const node = tree.find(n => n.id === nodeId);
  if (!node || !labNodeUnlocked(subKey, node)) return;
  const level = labNodeLevel(subKey, nodeId);
  const cost = labNodeCost(level);
  const mastery = state.masteryPoints || 0;
  if (mastery < cost) return;
  // single shared pool now — see enhanceCard()'s comment for why the old
  // subtype-locked-token + universal-mastery split was merged into one
  state.masteryPoints = mastery - cost;
  state.labProgress[subKey] = state.labProgress[subKey] || {};
  state.labProgress[subKey][nodeId] = level + 1;
  log(`${node.name} Lv.${level + 1} 습득!`);
  render();
}

// aggregate bonus from every node in a subtype's tree; benefits ALL owned/placed
// cards of that subtype regardless of their individual grade or card tier.
// computeStats() calls this once per placed unit per combat tick — with only 7
// possible subtypes but up to 25 placed units, that's up to 25 fresh 15-key object
// allocations/sec-at-60fps for what's often the same handful of distinct subtypes,
// which was contributing real GC-pause frame spikes under heavy combat (found via
// a max/p99 frame-time stress test, not just the average). Cache the result for the
// current combat tick and reuse it across every unit of the same subtype that tick;
// invalidated every tick via labBonusCacheTick so it can never go stale within a run.
let labBonusCacheTick = -1;
let labBonusCache = {};
function computeLabBonus(subKey) {
  if (labBonusCacheTick === combatTickId && labBonusCache[subKey]) return labBonusCache[subKey];
  const bonus = {
    atkPct: 0, aspdPct: 0, critChanceAdd: 0, slowAdd: 0, debuffPct: 0, rangePct: 0, skillDmgPct: 0,
    normalDmgPct: 0, bossDmgPct: 0, splashPct: 0, dotChance: 0, extraAtkChance: 0,
    auraCritChance: 0, auraCritDmg: 0, auraBossDmg: 0,
    healPct: 0, shieldPct: 0, guardHpPct: 0, // heal_support / tank_guard (#3/#4) lab-tree effects
    xpGainPct: 0, jobPowerPct: 0, branchPowerPct: 0, // 전직 시스템 연동 노드 (숙련 교본 / 전직 공명 / 전직 특화)
    // 서브타입별 특화 노드(LAB_SPEC_NODES)가 쓰는 축. 기존 키로 표현할 수 없는 것만 새로 만든다:
    // ccPowerPct = 경성 제어(결빙/속박/기절/봉인) 지속시간, auraAspdPct/auraRangePct = 오라의
    // "종류"를 넓히는 지원형 전용 축, tauntPowerPct = 도발 확률/지속시간
    critDmgAdd: 0, ccPowerPct: 0, auraAspdPct: 0, auraRangePct: 0, tauntPowerPct: 0,
  };
  const tree = LAB_TREES[subKey];
  if (!tree) return bonus;
  for (const node of tree) {
    const lvl = labNodeLevel(subKey, node.id);
    if (lvl > 0 && node.effectKey in bonus) bonus[node.effectKey] += node.perLevel * lvl;
  }
  if (labBonusCacheTick !== combatTickId) { labBonusCache = {}; labBonusCacheTick = combatTickId; }
  labBonusCache[subKey] = bonus;
  return bonus;
}

function makeInstance(defId, grade) {
  state.instSeq++;
  return {
    instId: 'i' + state.instSeq, defId, grade: grade.id, cooldown: 0, cellKey: null, buffs: null, skillCooldown: SKILL_INTERVAL,
    // hp/maxHp: null until ensureUnitHp() first computes them (at placement) — a unit
    // sitting on the bench never takes damage, so there's no need to eagerly compute stats
    hp: null, maxHp: null,
    weaken: null, // { atkMult, aspdMult, until } — applied by boss/mid-boss debuff skills, see applyUnitWeaken()
    frenzyUntil: 0, // atk_multi legendary skill self-buff window (aspd x3), see triggerLegendarySkill
    healCooldown: 0, // heal_support's periodic heal tick, independent of its (weak) normal attack cooldown
    // ---- 유닛 성장/전직 (run-scoped, resets with the run like everything else on an instance) ----
    level: 1, xp: 0,
    jobTier: 1,      // 1 = 미전직, 2/3/4 = 10/20/30레벨 전직 차수
    jobBranch: null, // 2차 전직 시 무작위로 결정되는 갈래 id (JOB_BRANCH_BY_ID)
    jobCounter: 0,   // 갈래별 "N번째 공격마다" 카운터 (천공술사 메테오 등)
    jobCooldown: 0,  // 갈래별 주기 효과 타이머 (기공술사 터렛 등)
    // 버프/치유 기여자 추적용 — 매 전투 틱마다 count만 0으로 되돌려 재사용 (배열 재할당 없음)
    buffSrc: null, buffSrcCount: 0,
  };
}

// O(1) lookups instead of UNIT_DEFS.find()/GRADES.find() linear scans — these run
// many times per unit per combat tick (computeStats, tickCombat, updateSupportBuffs,
// draw, ...), so an O(n) scan through 126 defs on every call was a real hot-path cost
const UNIT_DEFS_BY_ID = {};
for (const d of UNIT_DEFS) UNIT_DEFS_BY_ID[d.id] = d;
const GRADES_BY_ID = {};
for (const g of GRADES) GRADES_BY_ID[g.id] = g;
function defOf(instance) { return UNIT_DEFS_BY_ID[instance.defId]; }
function gradeOf(instance) { return GRADES_BY_ID[instance.grade]; }

// base-line stats for a card in the collection grid: E-grade, no summon-instance
// randomness, no deck/support buffs — just the card's own enhancement level, so
// cards can be compared apples-to-apples before you ever summon one
function previewCardStats(defId) {
  const def = UNIT_DEFS_BY_ID[defId];
  const lvl = levelOf(defId);
  const atk = def.base.atk * (1 + lvl * ENHANCE_STAT_BONUS.atk);
  const range = def.base.range * (1 + lvl * ENHANCE_STAT_BONUS.range);
  const aspd = def.base.aspd * (1 + lvl * ENHANCE_STAT_BONUS.aspd);
  return { atk, range, aspd, targets: def.base.targets };
}

function computeStats(instance) {
  const def = defOf(instance);
  const grade = gradeOf(instance);
  const lvl = levelOf(instance.defId);
  const runLvl = state.runUpgrades[instance.defId] || 0;
  let atk = def.base.atk * grade.mult * (1 + lvl * ENHANCE_STAT_BONUS.atk) * (1 + runLvl * RUN_UPGRADE_STAT_BONUS.atk);
  let range = def.base.range * (1 + (grade.mult - 1) * 0.15) * (1 + lvl * ENHANCE_STAT_BONUS.range) * (1 + runLvl * RUN_UPGRADE_STAT_BONUS.range);
  let aspd = def.base.aspd * (1 + (grade.mult - 1) * 0.08) * (1 + lvl * ENHANCE_STAT_BONUS.aspd) * (1 + runLvl * RUN_UPGRADE_STAT_BONUS.aspd);
  let critChance = 5, critDmg = 50, bossDmg = 0, slow = 0, targets = def.base.targets;
  for (const t of def.traits) {
    if (t.key === 'critChance') critChance += t.value;
    if (t.key === 'critDmg') critDmg += t.value;
    if (t.key === 'atk') atk *= (1 + t.value / 100);
    if (t.key === 'range') range *= (1 + t.value / 100);
    if (t.key === 'aspd') aspd *= (1 + t.value / 100);
    if (t.key === 'bossDmg') bossDmg += t.value;
    if (t.key === 'slow') slow += t.value;
    if (t.key === 'targets') targets += Math.max(1, Math.round(t.value / 10));
  }
  // apply live support buffs from nearby buff_support units / buff zones / guard auras
  let dmgReductionPct = 0;
  if (instance.buffs) {
    atk *= (1 + (instance.buffs.atk || 0) / 100);
    aspd *= (1 + (instance.buffs.aspd || 0) / 100);
    range *= (1 + (instance.buffs.range || 0) / 100);
    critChance += (instance.buffs.critChance || 0);
    critDmg += (instance.buffs.critDmg || 0);
    bossDmg += (instance.buffs.bossDmg || 0);
    // damage reduction from tank_guard auras / tank_guard legendary shield — capped well
    // below 100% so a guarded unit can still eventually die, never becomes truly invincible
    dmgReductionPct = Math.min(75, instance.buffs.dmgReductionPct || 0);
  }
  // boss/mid-boss debuff skill: temporarily weakens this unit's atk/aspd (refreshes/
  // strengthens rather than stacking, same pattern as the monster-side applyX helpers)
  if (instance.weaken && performance.now() < instance.weaken.until) {
    atk *= instance.weaken.atkMult;
    aspd *= instance.weaken.aspdMult;
  }
  // 광란(frenzy, atk_multi 레전더리 스킬): 짧은 시간 자신의 공격속도 폭증
  if (instance.frenzyUntil && performance.now() < instance.frenzyUntil) {
    aspd *= 3;
  }
  // apply deck composition set bonuses
  const db = state.deckBonus;
  if (db) {
    atk *= (1 + (db.atkPct || 0) / 100) * (1 + (db.allPct || 0) / 100);
    aspd *= (1 + (db.aspdPct || 0) / 100) * (1 + (db.allPct || 0) / 100);
    range *= (1 + (db.allPct || 0) / 100);
    critChance += (db.critChanceAdd || 0);
    bossDmg += (db.bossDmgAdd || 0);
  }
  // apply 연구실 (research lab) subtype skill tree — benefits every card of this
  // subtype regardless of that card's own tier/grade
  const lab = computeLabBonus(def.subKey);
  let debuffPct = lab.debuffPct || 0;
  let skillDmgPct = lab.skillDmgPct || 0;
  let normalDmgPct = lab.normalDmgPct || 0;
  let splashPct = lab.splashPct || 0;
  let dotChance = lab.dotChance || 0;
  let extraAtkChance = lab.extraAtkChance || 0;
  let healPct = lab.healPct || 0;
  let shieldPct = lab.shieldPct || 0;
  let guardHpPct = lab.guardHpPct || 0;
  atk *= (1 + (lab.atkPct || 0) / 100);
  aspd *= (1 + (lab.aspdPct || 0) / 100);
  range *= (1 + (lab.rangePct || 0) / 100);
  critChance += (lab.critChanceAdd || 0);
  critDmg += (lab.critDmgAdd || 0);
  slow += (lab.slowAdd || 0);
  bossDmg += (lab.bossDmgPct || 0);

  // ---- 유닛 레벨 / 전직 (기존 등급·강화·런업그레이드와 동일한 곱연산 파이프라인에 합류) ----
  // 레벨은 인스턴스 단위(런 스코프)이므로 카드 강화(levelOf)와는 완전히 별개의 축이다.
  const uLvl = Math.max(0, (instance.level || 1) - 1);
  const uTier = Math.max(1, Math.min(4, instance.jobTier || 1));
  atk *= (1 + uLvl * JOB_LEVEL_STAT_BONUS.atk) * (1 + JOB_TIER_ATK_BONUS[uTier]);
  range *= (1 + uLvl * JOB_LEVEL_STAT_BONUS.range);
  aspd *= (1 + uLvl * JOB_LEVEL_STAT_BONUS.aspd);
  // 연구실 '전직 공명' — 전직 차수에 비례해서만 작동 (미전직 유닛에게는 0)
  if (uTier > 1) atk *= (1 + (lab.jobPowerPct || 0) * (uTier - 1) / 100);
  skillDmgPct += JOB_TIER_SKILL_DMG[uTier]; // 전직 차수마다 레전더리/연구실 스킬 위력도 함께 상승

  // 갈래별 스탯 성향 — 차수 1단계당 누적 (2차 ×1, 3차 ×2, 4차 ×3)
  let auraPowerPct = 0, branchSplashAdd = 0, branchDotAdd = 0, jobHpPct = 0;
  const jb = uTier > 1 ? jobBranchOf(instance) : null;
  if (jb && jb.stat) {
    const st = jb.stat, k = uTier - 1;
    if (st.atkPct) atk *= (1 + st.atkPct * k / 100);
    if (st.aspdPct) aspd *= (1 + st.aspdPct * k / 100);
    if (st.rangePct) range *= (1 + st.rangePct * k / 100);
    if (st.critAdd) critChance += st.critAdd * k;
    if (st.critDmgAdd) critDmg += st.critDmgAdd * k;
    if (st.bossAdd) bossDmg += st.bossAdd * k;
    if (st.slowAdd) slow += st.slowAdd * k;
    if (st.targetsAdd) targets += st.targetsAdd * k;
    if (st.debuffAdd) debuffPct += st.debuffAdd * k;
    if (st.normalAdd) normalDmgPct += st.normalAdd * k; // 폭파공: 일반 몬스터 추가 피해
    if (st.splashAdd) branchSplashAdd = st.splashAdd * k;
    if (st.dotAdd) branchDotAdd = st.dotAdd * k;
    if (st.healAdd) healPct += st.healAdd * k;
    if (st.shieldAdd) shieldPct += st.shieldAdd * k;
    if (st.auraPowerPct) auraPowerPct = st.auraPowerPct * k;
    if (st.hpPct) jobHpPct = st.hpPct * k;
    // 4차 광전사는 동시 타격 대상이 하나 늘어난다 (스탯 표에 담기 애매한 단발 보정)
    if (jb.id === 'am_frenzy' && uTier >= 4) targets += 1;
  }
  splashPct += branchSplashAdd;
  dotChance += branchDotAdd;
  // 연구실 '전직 특화' — 갈래 고유 메커니즘(처형 문턱/폭탄 확률/결빙 지속 등)의 강도.
  // 스탯이 아니라 resolveHit 쪽 갈래 로직이 읽는 값이라 그대로 실어보낸다.
  const branchPower = uTier > 1 ? (lab.branchPowerPct || 0) : 0;

  // ---- unit max HP (see #6): placed units now have hp that can reach 0 ----
  // base scales the same way atk/range/aspd already do — grade + card tier + enhancement
  // level + in-run gold upgrade — plus a per-subtype hpMult (tanker built to tank, ranged/
  // support are glass) and its own lab-tree self-bonus (tank_guard's 생명력 강화 node)
  const HP_BASE = 40;
  const sub = SUBTYPES[def.subKey];
  let maxHp = HP_BASE * (sub.hpMult || 1) * grade.mult * (TIERS_BY_ID[def.tierId] ? TIERS_BY_ID[def.tierId].mult : 1)
    * (1 + lvl * 0.05) * (1 + runLvl * 0.04)
    * (1 + uLvl * JOB_LEVEL_STAT_BONUS.hp) * (1 + JOB_TIER_HP_BONUS[uTier]) * (1 + jobHpPct / 100);
  if (def.subKey === 'tank_guard') maxHp *= (1 + guardHpPct / 100);

  return {
    atk, range, aspd, critChance, critDmg, bossDmg, slow, targets, debuffPct, skillDmgPct,
    normalDmgPct, splashPct, dotChance, extraAtkChance, healPct, shieldPct, guardHpPct,
    maxHp, dmgReductionPct, auraPowerPct, branchPower, jobTier: uTier, jobBranch: instance.jobBranch || null,
    // 특화 노드 축 — 스탯이 아니라 갈래 로직(applyJobAttack/도발/오라)이 직접 읽는 값
    ccPower: lab.ccPowerPct || 0, tauntPower: lab.tauntPowerPct || 0,
    auraAspdAdd: lab.auraAspdPct || 0, auraRangeAdd: lab.auraRangePct || 0,
    splash: def.base.splash, cc: def.base.cc, debuff: def.base.debuff, support: def.base.support,
    fullRange: !!grade.fullRange,
  };
}

// ---------------- monster scaling ----------------
function monsterHpForWave(wave, kind) {
  const base = 20;
  const growth = base * Math.pow(1.16, wave - 1);
  if (kind === 'mid') return growth * 9;
  if (kind === 'boss') return growth * 34;
  return growth;
}
function monsterSpeedForWave(wave, kind) {
  const base = 55; // px/sec
  const s = base + Math.min(wave, 30) * 1.2;
  if (kind === 'mid') return s * 0.7;
  if (kind === 'boss') return s * 0.5;
  return s;
}

// ---------------- monsters attacking units (#7) ----------------
// only mid-bosses and bosses attack placed units — regular monsters just march the track
// as before. IMPORTANT: unlike monster HP (which grows exponentially with wave, matched
// against units' own exponentially-growing DPS from grade/tier/enhancement/run-upgrades),
// placed UNIT hp does NOT scale with wave at all (see computeStats' maxHp calc) — only
// grade/card-tier/enhancement/run-level. Reusing monsterHpForWave's 1.15^wave curve here
// was tried first and one-shot even a tanker within ~15 waves. Linear growth, capped at
// wave 40 (same "cap the scaling, let boss COUNT carry later difficulty" idea already
// used by monsterSpeedForWave), keeps this a real threat without trivializing unit HP.
function monsterAtkForWave(wave, kind) {
  const base = 4 + Math.min(wave, 40) * 0.6;
  if (kind === 'boss') return base * 2.2;
  if (kind === 'mid') return base * 1.2;
  return 0;
}
// "medium or higher" range per the design ask — in CELL units so it reads consistently
// with unit ranges (a typical unit sits around 1.0-2.5 CELL range)
const MONSTER_ATK_RANGE = { mid: 2.1 * CELL, boss: 2.6 * CELL };
const MONSTER_ATK_INTERVAL = { mid: 2.4, boss: 1.7 }; // seconds between basic attacks

// ---------------- boss/mid-boss skill pool (#8) ----------------
// beyond the basic periodic attack above, bosses/mid-bosses also use varied skills on
// their OWN separate cooldown: damage, debuff (weaken nearby units), or buff (haste
// nearby monsters). Bosses get the full pool and hit harder/more often; mid-bosses get
// a smaller, weaker pool. No toast/shake per activation (see executeMonsterSkill) —
// same "particle burst only" convention already used for legendary/capstone skills.
const BOSS_SKILLS = [
  { id: 'crush', kind: 'damage', mult: 2.2 },
  { id: 'weaken', kind: 'debuff', atkMult: 0.65, aspdMult: 0.8, dur: 4500 },
  { id: 'rally', kind: 'buff', speedMult: 1.7, dur: 3500 },
];
const MID_SKILLS = [
  { id: 'strike', kind: 'damage', mult: 1.4 },
  { id: 'weaken', kind: 'debuff', atkMult: 0.85, aspdMult: 0.92, dur: 3000 },
];

// object pool for monsters — recycled objects from monsterPool are reused instead of
// allocating a fresh object every spawn (up to ~20+ spawns/wave, more at higher waves
// with mid/boss overlap), cutting GC pressure that's especially costly as pauses on
// mobile Safari. EVERY field a monster can carry over its whole life is reset in
// spawnMonster below — not just the ones this function directly sets — since a reused
// object could otherwise start life already "dying"/frozen/stunned from its last use.
const monsterPool = [];
function spawnMonster(kind) {
  const hp = monsterHpForWave(state.wave, kind);
  const speed = monsterSpeedForWave(state.wave, kind);
  const trackPos = Math.random() * 24; // slight stagger so bursts don't perfectly overlap
  const lane = (Math.random() - 0.5) * 10; // small perpendicular jitter for visual spread
  const p = trackPoint(trackPos, lane);
  state.monsterSeq++;
  const m = monsterPool.pop() || {};
  m.id = state.monsterSeq; m.kind = kind; m.hp = hp; m.maxHp = hp; m.speed = speed;
  m.trackPos = trackPos; m.lane = lane; m.x = p.x; m.y = p.y;
  m.slowUntil = 0; m.slowFactor = 1; m.debuffUntil = 0; m.debuffAtkTakenMult = 1;
  m.stunUntil = 0; // hard CC, separate mechanic from slow: tickMonsters skips movement entirely while now < stunUntil
  // 속박/봉인/경성제어 면역 창 — 풀 재사용 시 반드시 초기화. 안 하면 갓 스폰한 몬스터가
  // 이전 생의 속박을 그대로 달고 나오거나(정지 상태로 스폰), 반대로 면역 창이 남아 있어
  // 제어가 통째로 씹히는 유령 버그가 생긴다. see applyHardCC/applySeal
  m.bindUntil = 0; m.sealUntil = 0; m.ccImmuneUntil = 0; m.sealImmuneUntil = 0;
  m.dying = false; m.deathT = 0; m.frostStacks = 0; m.frostStackAt = 0;
  if (m.dots) m.dots.length = 0; else m.dots = []; // reuse the array too, not just the object
  // monster-attacks-units (#7) + boss/mid skills (#8) fields — always reset regardless of
  // kind, since a recycled pooled object could otherwise start life mid-cooldown from a
  // previous boss/mid use even though it just respawned as a plain 'normal' monster
  m.atkCooldown = (kind === 'mid' || kind === 'boss') ? (0.6 + Math.random()) : 0;
  m.skillCooldown = kind === 'boss' ? (3 + Math.random() * 3) : kind === 'mid' ? (5 + Math.random() * 3) : 0;
  m.hasteUntil = 0; m.hasteMult = 1; // rally skill (buff other monsters), see applyMonsterHaste
  m.bombTagged = false; // atk_single capstone bomb-attach marker, see attachBomb/tickBombs
  m.tauntedBy = null; m.tauntUntil = 0; // tank_guard taunt proc, see applyTaunt
  // 경험치 분배용 기여자 추적 (풀 재사용 시 반드시 초기화 — 안 하면 이전 몬스터를 때렸던
  // 유닛들이 새 몬스터의 첫 킬 경험치를 공짜로 나눠 갖는 오염이 생긴다).
  // 배열 자체는 재사용하고 count만 0으로 되돌린다 = 스폰당 추가 할당 0.
  m.xpValue = monsterXpValue(state.wave, kind);
  if (m.xpContributors) m.xpContribCount = 0;
  else { m.xpContributors = []; m.xpContribCount = 0; }
  state.monsters.push(m);
  if (kind === 'boss') state.bossAliveThisWave = (state.bossAliveThisWave || 0) + 1;
}

// ---------------- wave flow ----------------
// the 3-second "웨이브 시작까지" countdown was removed by request — starting/restarting
// a run now drops straight into combat. Kept as a thin wrapper (rather than having
// every caller call beginWave() directly) so the prep-overlay/phase machinery stays
// intact in case a delayed start is wanted again later.
function beginPrep() {
  document.getElementById('wavePrepOverlay').classList.add('hidden');
  beginWave();
}

function beginWave() {
  state.wave++;
  state.phase = 'wave';
  // boss waves get a much longer clock (60s) than normal/mid waves (20s) — 20s was
  // too tight to actually track down and kill a boss before an automatic loss
  const isBossWave = state.wave % 10 === 0;
  state.waveDuration = isBossWave ? 90 : 45;
  state.waveTimer = state.waveDuration;
  document.getElementById('wavePrepOverlay').classList.add('hidden');
  state.bossAliveThisWave = 0;
  state.bossKilledInTime = true;

  const queue = [];
  const NORMAL_SPAWNS_PER_WAVE = 15; // was 20, reduced by 5 per request
  for (let i = 0; i < NORMAL_SPAWNS_PER_WAVE; i++) queue.push({ t: (i / NORMAL_SPAWNS_PER_WAVE) * state.waveDuration, kind: 'normal' });
  if (isBossWave) {
    // boss COUNT scales up every 30 waves (#9): waves 10/20 -> 1 boss, 30-50 -> 2,
    // 60-80 -> 3, 90+ -> 4, capped at 5 so it ramps difficulty without becoming
    // an unplayable flood. Staggered spawn times so they don't all appear on top
    // of each other on the same instant.
    const bossCount = Math.min(5, 1 + Math.floor(state.wave / 30));
    for (let i = 0; i < bossCount; i++) queue.push({ t: 1 + i * 6, kind: 'boss' });
  } else if (state.wave % 5 === 0) queue.push({ t: 1, kind: 'mid' });
  queue.sort((a, b) => a.t - b.t);
  state.spawnQueue = queue;
  state.spawnTimer = 0;
}

function endWave() {
  // boss wave time limit removed by request: killing every boss is no longer required
  // to advance — the wave simply proceeds once the timer runs out, same as normal waves.
  // no gold on wave-clear anymore — gold instead comes from killing monsters
  // during the wave (see onMonsterKilled), with bonus gold on mid/boss kills.
  // card coin still drops on wave clear as before.
  const coinGain = 3 + state.wave; // nerfed from 5+wave*2 — card-coin income (and thus how easily duplicates/gacha pulls pile up) was too generous
  state.cardCoin += coinGain;
  log(`웨이브 ${state.wave} 종료! +${coinGain} 카드코인`);
  showWaveToast(`WAVE ${state.wave} CLEAR`);
  flashField('flashGold');
  // only the very first wave has a 3s prep countdown; afterwards waves chain immediately
  beginWave();
}

function gameOver(reason) {
  state.phase = 'gameover';
  state.bench = [];
  state.selected = null;
  if (state.wave > state.bestWave) {
    state.bestWave = state.wave;
    localStorage.setItem('aaa_best_wave', String(state.bestWave));
  }
  document.getElementById('finalWave').textContent = `도달 웨이브: ${state.wave}  (최고 ${state.bestWave})`;
  document.getElementById('finalGoldGain').textContent = reason;
  document.getElementById('gameOverOverlay').classList.remove('hidden');
  flashField('flashRed');
  shakeScreen(10);
  render();
}

// ---------------- run lifecycle ----------------
// everything here is scoped to a single playthrough and is thrown away when a
// new run starts; the card collection/deck itself is untouched
function resetRun() {
  state.gold = 50;
  state.wave = 0;
  state.phase = 'idle';
  state.waveTimer = 0;
  combatAccum = 0; // don't carry leftover fixed-timestep debt into the next run
  for (const m of state.monsters) { if (monsterPool.length < 80) monsterPool.push(m); } // recycle for the next run too
  state.monsters = [];
  state.spawnQueue = [];
  state.spawnTimer = 0;
  state.placed = {};
  state.bench = [];
  state.runUpgrades = {};
  state.selected = null;
  for (const p of state.projectiles) { if (projectilePool.length < 60) projectilePool.push(p); }
  state.projectiles = [];
  state.particles = [];
  state.floatingTexts = [];
  state.zones = [];
  state.turrets = [];
  state.rings = [];
  state.bolts = [];
  state.bombs = [];
  state.meteors = [];
  state.lasers = [];
  state.bossAliveThisWave = 0;
  state.bossKilledInTime = true;
  document.getElementById('gameOverOverlay').classList.add('hidden');
  document.getElementById('wavePrepOverlay').classList.add('hidden');
  document.getElementById('startRow').classList.remove('hidden');
}

// ---------------- vfx helpers ----------------
function flashField(cls) {
  const el = document.getElementById('fieldFlash');
  el.classList.remove('flashGold', 'flashRed');
  void el.offsetWidth;
  el.classList.add(cls);
  setTimeout(() => { el.classList.remove(cls); }, 260);
}

let waveToastTimer = null;
function showWaveToast(text) {
  const el = document.getElementById('waveToast');
  el.textContent = text;
  el.classList.remove('hidden');
  requestAnimationFrame(() => el.classList.add('show'));
  clearTimeout(waveToastTimer);
  waveToastTimer = setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.classList.add('hidden'), 250);
  }, 1600);
}

let shakeTime = 0, shakeMag = 0;
// screen shake removed by request — no-op kept (rather than deleting every call site)
// so nothing throws; shakeTime/shakeMag simply never become nonzero, so draw()'s own
// shake-offset code (gated on shakeTime>0) never runs either
function shakeScreen(mag) { /* no-op */ }

function pulseStat(statEl) {
  if (!statEl) return;
  statEl.classList.remove('pulse');
  void statEl.offsetWidth;
  statEl.classList.add('pulse');
}

// ---------------- gacha ----------------
function acquireCard(pool) {
  const owned = new Set(ownedDefIdList());
  const candidates = pool.filter(d => !owned.has(d.id));
  const def = candidates.length ? candidates[Math.floor(Math.random() * candidates.length)] : pool[Math.floor(Math.random() * pool.length)];
  if (!state.collection[def.id]) {
    state.collection[def.id] = { count: 1, level: 0 };
    log(`새 카드 획득: ${def.name} (${def.variant})`);
  } else {
    state.collection[def.id].count += 1;
    log(`중복 카드 획득: ${def.name} (보유 ${state.collection[def.id].count}장)`);
  }
}

const GACHA_NORMAL_COST = 15;
const GACHA_GEM_COST = 5;

function gachaNormal() {
  if (state.cardCoin < GACHA_NORMAL_COST) return;
  state.cardCoin -= GACHA_NORMAL_COST;
  const tier = rollCardTier();
  const pool = UNIT_DEFS.filter(d => d.tierId === tier.id);
  acquireCard(pool);
  render();
}

const GACHA_BULK_COUNT = 30;
function gachaBulkNormal() {
  const totalCost = GACHA_NORMAL_COST * GACHA_BULK_COUNT;
  if (state.cardCoin < totalCost) return;
  state.cardCoin -= totalCost;
  for (let i = 0; i < GACHA_BULK_COUNT; i++) {
    const tier = rollCardTier();
    const pool = UNIT_DEFS.filter(d => d.tierId === tier.id);
    acquireCard(pool);
  }
  log(`일반 뽑기 ${GACHA_BULK_COUNT}연 완료!`);
  render();
}

function gachaGem() {
  if (state.gems < GACHA_GEM_COST) return;
  state.gems -= GACHA_GEM_COST;
  // gem gacha skews strongly toward higher tiers
  const boosted = TIERS.map((t, i) => ({ t, w: t.weight * (1 + i * i) }));
  const total = boosted.reduce((s, x) => s + x.w, 0);
  let r = Math.random() * total;
  let chosen = boosted[0].t;
  for (const b of boosted) { r -= b.w; if (r <= 0) { chosen = b.t; break; } }
  const pool = UNIT_DEFS.filter(d => d.tierId === chosen.id);
  acquireCard(pool);
  render();
}

function summonUnit() {
  if (state.gold < 10 || state.activeDeck.length === 0 || state.phase === 'idle' || state.phase === 'gameover') return;
  if (state.bench.length >= BENCH_MAX) { log(`대기 유닛은 최대 ${BENCH_MAX}칸까지입니다`); render(); return; }
  state.gold -= 10;
  const defId = state.activeDeck[Math.floor(Math.random() * state.activeDeck.length)];
  const grade = rollGrade();
  const inst = makeInstance(defId, grade);
  state.bench.push(inst);
  render();
}

// ---------------- selection / placement / sell ----------------
// clicking a bench card places it straight onto a random open field cell,
// instead of the old two-step "select, then click a field cell" flow
function placeFromBench(idx) {
  const inst = state.bench[idx];
  if (!inst) return;
  const emptyCells = INTERIOR.filter(p => !state.placed[cellKey(p.c, p.r)]);
  if (emptyCells.length === 0) {
    log('필드에 빈 자리가 없습니다');
    state.selected = { kind: 'bench', idx };
    state.selectedAt = performance.now();
    render();
    return;
  }
  const cell = emptyCells[Math.floor(Math.random() * emptyCells.length)];
  const key = cellKey(cell.c, cell.r);
  state.bench.splice(idx, 1);
  placeUnitAt(inst, key);
  inst.placedAt = performance.now();
  ensureUnitHp(inst);
  ensureUnitFields(inst);
  state.placed[key] = inst;
  state.selected = null;
  render();
}
function selectField(key) {
  const cur = state.selected;
  if (cur) {
    if (cur.kind === 'bench') {
      const inst = state.bench[cur.idx];
      if (!inst) { state.selected = null; render(); return; }
      const occupant = state.placed[key];
      if (occupant) {
        state.bench.splice(cur.idx, 1);
        occupant.cellKey = null;
        occupant.center = null;
        state.bench.push(occupant);
        placeUnitAt(inst, key);
        state.placed[key] = inst;
      } else {
        state.bench.splice(cur.idx, 1);
        placeUnitAt(inst, key);
        state.placed[key] = inst;
      }
      inst.placedAt = performance.now();
      ensureUnitHp(inst);
      ensureUnitFields(inst);
      state.selected = null;
      render();
      return;
    }
    if (cur.kind === 'field') {
      if (cur.key === key) { state.selected = null; render(); return; }
      const a = state.placed[cur.key];
      const b = state.placed[key];
      state.placed[cur.key] = b || null;
      state.placed[key] = a || null;
      if (!state.placed[cur.key]) delete state.placed[cur.key];
      if (b) placeUnitAt(b, cur.key);
      if (a) placeUnitAt(a, key);
      state.selected = null;
      render();
      return;
    }
  }
  if (state.placed[key]) {
    state.selected = { kind: 'field', key };
    state.selectedAt = performance.now();
    render();
  }
}

// small particle "poof" wherever a placed unit leaves the field (sold), so the slot
// doesn't just blink empty — reuses the same particle system as combat hit effects
function poofAt(key, color) {
  const [c, r] = key.split(',').map(Number);
  const center = cellCenter(c, r);
  spawnHitParticles(center.x, center.y, color, 10);
}

// ---------------- unit HP (#6): placed units can now take damage and die ----------------
// lazily computes and stores a fresh hp/maxHp pair the first time a unit instance is
// actually placed on the field — bench units never take damage so there's no need to
// eagerly track hp for them. Safe to call repeatedly; only acts once (inst.hp == null).
function ensureUnitHp(inst) {
  if (inst.hp == null) {
    const stats = computeStats(inst);
    inst.maxHp = stats.maxHp;
    inst.hp = stats.maxHp;
  }
}

// defaults every field makeInstance() sets besides hp/maxHp (handled by ensureUnitHp)
// and center/cellKey (handled by placeUnitAt) — call this on ANY unit instance that
// might not have been created fresh via makeInstance() this session: a bench/placed
// unit restored from an older local-storage snapshot predating one of these fields
// would otherwise carry `undefined` into combat code that reads it unconditionally
// (e.g. `inst.healCooldown -= dt`), decaying into a silent NaN/no-op bug rather than
// a crash — annoying to debug and easy to miss, so just guarantee it never happens.
function ensureUnitFields(inst) {
  if (inst.buffs === undefined) inst.buffs = null;
  if (typeof inst.cooldown !== 'number') inst.cooldown = 0;
  if (typeof inst.skillCooldown !== 'number') inst.skillCooldown = SKILL_INTERVAL;
  if (inst.weaken === undefined) inst.weaken = null;
  if (typeof inst.frenzyUntil !== 'number') inst.frenzyUntil = 0;
  if (typeof inst.healCooldown !== 'number') inst.healCooldown = 0;
  // 성장/전직 필드 — 예전 스냅샷에서 복구된 인스턴스에는 없을 수 있다. 없는 채로 전투에
  // 들어가면 `inst.xp += amount`가 곧장 NaN이 되고, NaN은 어떤 비교에도 false라 레벨업이
  // 조용히 영원히 막히는 최악의 형태로 터진다 — 그래서 여기서 무조건 보장한다.
  if (typeof inst.level !== 'number' || !isFinite(inst.level)) inst.level = 1;
  if (typeof inst.xp !== 'number' || !isFinite(inst.xp)) inst.xp = 0;
  if (typeof inst.jobTier !== 'number' || !isFinite(inst.jobTier)) inst.jobTier = 1;
  if (inst.jobBranch === undefined) inst.jobBranch = null;
  if (inst.jobBranch && !JOB_BRANCH_BY_ID[inst.jobBranch]) inst.jobBranch = null; // 삭제/개명된 갈래 id 방어
  if (typeof inst.jobCounter !== 'number') inst.jobCounter = 0;
  if (typeof inst.jobCooldown !== 'number') inst.jobCooldown = 0;
  if (!Array.isArray(inst.buffSrc)) inst.buffSrc = [];
  if (typeof inst.buffSrcCount !== 'number') inst.buffSrcCount = 0;
  // 레벨 10 이상인데 갈래가 비어 있는 인스턴스(구버전 스냅샷)는 여기서 한 번만 보정.
  // 렌더/프레임 루프가 아니라 배치/복구 시점에서만 호출되는 함수이므로, 반복 실행으로
  // 이득을 얻는 종류의 보정이 아니다 (연구실 포인트 재조정 함수와 동일한 규율).
  inst.level = Math.max(1, Math.min(MAX_UNIT_LEVEL, Math.floor(inst.level)));
  const shouldTier = 1 + JOB_TIER_LEVELS.filter(l => inst.level >= l).length;
  if (inst.jobTier < shouldTier) {
    const branches = JOB_BRANCHES[defOf(inst).subKey];
    if (branches) {
      if (!inst.jobBranch) inst.jobBranch = branches[Math.floor(Math.random() * branches.length)].id;
      inst.jobTier = shouldTier;
    }
  }
  if (inst.jobTier < 2) inst.jobBranch = null;
}

// ---------------- 전직 갈래 조회 헬퍼 ----------------
function jobBranchOf(inst) { return inst && inst.jobBranch ? JOB_BRANCH_BY_ID[inst.jobBranch] : null; }
// 전직 "차수 단계" — 2차=1, 3차=2, 4차=3, 미전직=0. 모든 갈래 효과의 스케일 기준값.
function jobStep(inst) { const t = inst.jobTier || 1; return t > 1 ? t - 1 : 0; }

// ---------------- 경험치 기여자 추적 (1/n 분배) ----------------
// 몬스터 하나가 죽을 때까지 "누가 관여했는가"를 cellKey 문자열 배열로 들고 다닌다.
// Set/객체 대신 고정 배열 + 카운터인 이유: resolveHit은 최악의 경우 프레임당 수백 번
// 호출되는 핫 루프라 여기서 객체/이터레이터를 새로 만들면 곧장 GC 압력이 된다.
// 배열은 몬스터 풀과 함께 재사용되고, 필드 최대 25유닛이라 선형 스캔 길이는 25 이하.
function addXpContributor(m, key) {
  if (!key || !m.xpContributors) return;
  const arr = m.xpContributors;
  const n = m.xpContribCount;
  for (let i = 0; i < n; i++) if (arr[i] === key) return;
  if (n >= 32) return; // 안전 상한 (필드 정원보다 넉넉함)
  arr[n] = key;
  m.xpContribCount = n + 1;
}
// 이 유닛을 "지금 버프/치유/보호막으로 돕고 있는" 지원 유닛들도 같은 킬의 기여자로 등록.
// 지원 유닛 쪽에서 매 틱 모든 몬스터를 훑는 대신, 실제 타격이 일어나는 순간에만 옮겨
// 붙이므로 추가 비용이 O(버프 제공자 수)로 끝난다.
function addXpAssists(m, inst) {
  const n = inst.buffSrcCount || 0;
  if (n === 0) return;
  const src = inst.buffSrc;
  for (let i = 0; i < n; i++) addXpContributor(m, src[i]);
}
function addBuffSource(target, srcKey) {
  if (!srcKey) return;
  if (!target.buffSrc) { target.buffSrc = []; target.buffSrcCount = 0; }
  const n = target.buffSrcCount || 0;
  for (let i = 0; i < n; i++) if (target.buffSrc[i] === srcKey) return;
  if (n >= 16) return;
  target.buffSrc[n] = srcKey;
  target.buffSrcCount = n + 1;
}

// ---------------- 경험치 획득 / 레벨업 / 전직 ----------------
function awardUnitXp(inst, amount) {
  if (!inst || !(amount > 0)) return;
  if (typeof inst.level !== 'number' || !isFinite(inst.level)) ensureUnitFields(inst);
  if (inst.level >= MAX_UNIT_LEVEL) { inst.xp = 0; return; }
  // 연구실 '숙련 교본' — 서브타입 트리 투자에 비례해 획득 경험치 증가
  const lab = computeLabBonus(defOf(inst).subKey);
  inst.xp += amount * (1 + (lab.xpGainPct || 0) / 100);
  // 한 번의 획득으로 여러 레벨이 한꺼번에 오를 수 있다 (보스 킬 등). guard는 만에 하나
  // xpToNext가 0/NaN이 되어도 프레임이 잠기지 않게 하는 안전 밸브.
  let guard = 0;
  while (inst.level < MAX_UNIT_LEVEL && guard++ < 60) {
    const need = unitXpToNext(inst.level);
    if (!(need > 0) || inst.xp < need) break;
    inst.xp -= need;
    inst.level++;
    onUnitLevelUp(inst);
  }
  if (inst.level >= MAX_UNIT_LEVEL) inst.xp = 0; // 만렙에서는 경험치 바를 꽉 찬 채로 고정
}

function onUnitLevelUp(inst) {
  const c = inst.center;
  if (c) {
    if (state.floatingTexts.length < MAX_FLOATING_TEXTS) {
      state.floatingTexts.push({ x: c.x, y: c.y - 30, t: 0, dur: 0.85, value: 'Lv.' + inst.level, levelUp: true });
    }
    spawnHitParticles(c.x, c.y, '#3c9c68', 5);
  }
  // 레벨업 시 최대체력이 올라간 만큼 즉시 회복시켜 준다 (tickCombat이 maxHp로 클램프)
  if (inst.hp != null && inst.maxHp != null) inst.hp += inst.maxHp * 0.12;
  if (JOB_TIER_LEVELS.indexOf(inst.level) >= 0) advanceJob(inst);
}

// 2차 전직에서만 갈래를 무작위로 결정하고, 3·4차는 그 갈래를 그대로 더 깊게 판다.
function advanceJob(inst) {
  const def = defOf(inst);
  const branches = JOB_BRANCHES[def.subKey];
  if (!branches || branches.length === 0) return;
  if (!inst.jobBranch) inst.jobBranch = branches[Math.floor(Math.random() * branches.length)].id;
  inst.jobTier = Math.min(4, (inst.jobTier || 1) + 1);
  inst.jobCounter = 0;
  inst.jobCooldown = 0;
  const b = jobBranchOf(inst);
  const tierName = b && b.tiers[inst.jobTier - 2] ? b.tiers[inst.jobTier - 2] : b ? b.name : '';
  const c = inst.center;
  if (c) {
    // 전직은 흔한 이벤트가 아니라서(런당 유닛별 최대 3회) 링+파티클+짧은 흔들림까지 허용 —
    // 레전더리/캡스톤 스킬처럼 초당 여러 번 터지는 종류가 아니다
    spawnShockRing(c.x, c.y, 46, '#c1863a');
    spawnHitParticles(c.x, c.y, '#c1863a', 16);
    shakeScreen(2.5);
    if (state.floatingTexts.length < MAX_FLOATING_TEXTS) {
      state.floatingTexts.push({ x: c.x, y: c.y - 44, t: 0, dur: 1.3, value: tierName, jobUp: true });
    }
  }
  log(`${def.name} ${JOB_TIER_LABEL[inst.jobTier]} 전직! → ${b ? b.name : ''} · ${tierName}`);
}

// distinct from poofAt() (sale): a darker, heavier burst + a shockring + a small
// screen-shake, so a unit actually dying in combat reads as a loss, not a transaction
function spawnUnitDeathBurst(x, y) {
  spawnHitParticles(x, y, '#3a3f52', 16);
  spawnShockRing(x, y, 34, '#3a3f52');
  shakeScreen(3);
}

// removes a placed unit the same way selling does (state.placed + selection), but with
// NO gold refund and a distinct "death" VFX instead of the sale poof
function killUnit(key, inst) {
  spawnUnitDeathBurst(inst.center.x, inst.center.y);
  delete state.placed[key];
  if (state.selected && state.selected.kind === 'field' && state.selected.key === key) state.selected = null;
}

// central damage entrypoint for anything that hurts a PLACED UNIT (monster basic attacks,
// boss/mid-boss skills) — mirrors dealDamage()'s role for monsters. showText defaults to
// true since unit damage is comparatively rare/high-signal, unlike monster DoT/splash spam.
function damageUnit(key, inst, amount, showText = true) {
  if (!inst || inst.hp == null) return;
  // tank_guard aura / shield skills reduce incoming damage — capped at 75% so a guarded
  // unit can still eventually die rather than becoming truly invincible
  const reduction = Math.min(75, (inst.buffs && inst.buffs.dmgReductionPct) || 0);
  amount *= (1 - reduction / 100);
  // 영원한 성채 (불굴의 방벽 4차): 받은 피해의 일부를 가장 가까운 적에게 그대로 되돌린다.
  // 몬스터 기본공격/보스 스킬에서만 호출되는 저빈도 경로라 여기서의 근접 탐색은 부담이 없다.
  if (inst.jobBranch === 'tg_bulwark' && (inst.jobTier || 1) >= 4 && amount > 0) {
    let best = null, bestD = Infinity;
    for (const mo of state.monsters) {
      if (mo.dying) continue;
      const d = dist(inst.center.x, inst.center.y, mo.x, mo.y);
      if (d < bestD) { bestD = d; best = mo; }
    }
    if (best) {
      addXpContributor(best, inst.cellKey);
      dealDamage(best, amount * 0.45, false, false);
      spawnHitParticles(best.x, best.y, '#4a72d6', 4);
    }
  }
  inst.hp -= amount;
  if (showText && state.floatingTexts.length < MAX_FLOATING_TEXTS) {
    state.floatingTexts.push({
      x: inst.center.x + (Math.random() * 10 - 5), y: inst.center.y - 26, t: 0, dur: 0.6,
      value: Math.round(amount), unitDmg: true,
    });
  }
  if (inst.hp <= 0) killUnit(key, inst);
}

function sellSelected() {
  const sel = state.selected;
  if (!sel) return;
  let inst;
  if (sel.kind === 'bench') inst = state.bench.splice(sel.idx, 1)[0];
  else {
    inst = state.placed[sel.key];
    if (inst) poofAt(sel.key, (GRADES_BY_ID[inst.grade] || {}).color || '#8a8f9c');
    delete state.placed[sel.key];
  }
  if (inst) state.gold += GRADE_SELL_PRICE[inst.grade];
  state.selected = null;
  render();
}

// sells a bench unit directly (its own small × badge on the card), without needing to
// select it first and hit the separate 판매 button — a card only ever sits in the
// bench waiting to be placed or sold, so a one-tap sell here saves a redundant step
function sellBenchUnit(idx) {
  const inst = state.bench[idx];
  if (!inst) return;
  state.bench.splice(idx, 1);
  state.gold += GRADE_SELL_PRICE[inst.grade];
  if (state.selected && state.selected.kind === 'bench') {
    if (state.selected.idx === idx) state.selected = null;
    else if (state.selected.idx > idx) state.selected.idx -= 1;
  }
  render();
}

function bulkSell() {
  const rank = GRADES.map(g => g.id);
  const maxIdx = rank.indexOf(state.bulkSellMaxGrade);
  let gained = 0;
  state.bench = state.bench.filter(inst => {
    if (rank.indexOf(inst.grade) <= maxIdx) { gained += GRADE_SELL_PRICE[inst.grade]; return false; }
    return true;
  });
  for (const key of Object.keys(state.placed)) {
    const inst = state.placed[key];
    if (rank.indexOf(inst.grade) <= maxIdx) {
      gained += GRADE_SELL_PRICE[inst.grade];
      poofAt(key, (GRADES_BY_ID[inst.grade] || {}).color || '#8a8f9c');
      delete state.placed[key];
    }
  }
  state.gold += gained;
  state.selected = null;
  log(`일괄 판매로 +${gained} 골드`);
  render();
}

// summons repeatedly (same 10-gold cost/roll as a single summonUnit call) until the
// bench is full or gold runs out — accounts for units already sitting on the bench
function summonAll() {
  if (state.activeDeck.length === 0 || state.phase === 'idle' || state.phase === 'gameover') { render(); return; }
  let n = 0;
  while (state.bench.length < BENCH_MAX && state.gold >= 10) {
    state.gold -= 10;
    const defId = state.activeDeck[Math.floor(Math.random() * state.activeDeck.length)];
    const grade = rollGrade();
    state.bench.push(makeInstance(defId, grade));
    n++;
  }
  if (n > 0) log(`전체 소환: ${n}마리 소환`);
  render();
}

// sells every unit currently sitting on the bench (not placed field units)
function sellAllBench() {
  if (state.bench.length === 0) { render(); return; }
  let gained = 0;
  for (const inst of state.bench) gained += GRADE_SELL_PRICE[inst.grade];
  state.bench = [];
  if (state.selected && state.selected.kind === 'bench') state.selected = null;
  state.gold += gained;
  log(`대기 유닛 전체 판매: +${gained} 골드`);
  render();
}

// places every bench unit onto a random open field cell, one at a time, stopping
// early if the field fills up before the bench empties
function placeAllBench() {
  if (state.bench.length === 0) { render(); return; }
  let n = 0;
  while (state.bench.length > 0) {
    const emptyCells = INTERIOR.filter(p => !state.placed[cellKey(p.c, p.r)]);
    if (emptyCells.length === 0) break;
    const inst = state.bench.shift();
    const cell = emptyCells[Math.floor(Math.random() * emptyCells.length)];
    const key = cellKey(cell.c, cell.r);
    placeUnitAt(inst, key);
    inst.placedAt = performance.now();
    ensureUnitHp(inst);
    ensureUnitFields(inst);
    state.placed[key] = inst;
    n++;
  }
  if (state.bench.length > 0) log('필드에 빈 자리가 없어 일부만 배치했습니다');
  else if (n > 0) log(`전체 배치: ${n}마리 배치`);
  state.selected = null;
  render();
}

// ---------------- combat ----------------
function dist(ax, ay, bx, by) { return Math.hypot(ax - bx, ay - by); }

// buff-granting units (아군에게 뭔가를 주는 유닛: 오라클/지원, 탱커, 힐러) now have their
// OWN buff/aura radius, independent of their normal attack-range stat — attack range
// was nerfed earlier this session for combat balance, which was quietly shrinking these
// units' support radius along with it even though "how far I can buff/heal/shield" isn't
// really the same thing as "how far I can hit an enemy". Grows slightly with the card's
// own enhancement level so investing in a support card keeps paying off even after its
// lab tree is maxed out.
const BUFF_AURA_RANGE = { buff_support: 2.2, tank_guard: 1.6, heal_support: 2.0 };
const BUFF_AURA_RANGE_PER_LEVEL = 0.02; // +2% per enhancement level
function buffAuraRange(inst) {
  const base = BUFF_AURA_RANGE[defOf(inst).subKey];
  if (!base) return 0;
  return base * CELL * (1 + levelOf(inst.defId) * BUFF_AURA_RANGE_PER_LEVEL);
}

function updateSupportBuffs() {
  // computed once and reused for both the outer supports scan and the inner per-target
  // scan below — this used to call Object.entries(state.placed) fresh inside the outer
  // loop (once per support unit), allocating a whole new array of every placed unit
  // O(supports * placedCount) times per combat tick instead of just once
  const allPlaced = Object.entries(state.placed);
  // .buffs와 함께 "누가 나를 돕고 있는가"(경험치 기여 어시스트) 목록도 매 틱 초기화한다.
  // 배열은 재사용하고 카운터만 0으로 되돌려 틱당 추가 할당이 생기지 않게 한다.
  for (const [, inst] of allPlaced) {
    inst.buffs = null;
    if (!inst.buffSrc) inst.buffSrc = [];
    inst.buffSrcCount = 0;
  }
  const supports = allPlaced.filter(([k, inst]) => defOf(inst).base.support);
  if (supports.length === 0) return;
  // 연구실 아우라 노드: buff_support 트리는 서브타입 공용이라 모든 지원형 유닛에 대해 한 번만 계산하면 된다
  const supportLab = computeLabBonus('buff_support');
  for (const [key, sInst] of supports) {
    const grade = gradeOf(sInst);
    const supportStats = computeStats(sInst); // respects enhancement/run-upgrade/deck bonuses on the buffer itself
    const range = buffAuraRange(sInst);
    const center = sInst.center; // cached at placement time — see placeUnitAt()
    const lvl = levelOf(sInst.defId);
    const runLvl = state.runUpgrades[sInst.defId] || 0;
    // 전쟁성가/기공술사 갈래의 오라 강도 보정 (auraPowerPct) — 전쟁성가는 오라 자체를,
    // 기공술사는 오라를 조금 양보하는 대신 아래 tickCombat에서 상시 터렛을 뽑는다
    const power = (4 + (grade.mult - 1) * 6) * (1 + lvl * ENHANCE_STAT_BONUS.atk) * (1 + runLvl * RUN_UPGRADE_STAT_BONUS.atk)
      * (1 + (supportStats.auraPowerPct || 0) / 100);
    // 전쟁성가는 오라의 "종류"를 차수마다 하나씩 더 연다 — 강도만 커지는 대신 3차에서
    // 진군(공속), 4차에서 치명타·사거리 성가가 겹쳐 울려서 버프형이 단조로워지지 않게 한다.
    // 기공술사는 이 확장 대신 상시 터렛(tickCombat)을 가져가므로 chantStep은 0으로 남는다.
    const chantStep = sInst.jobBranch === 'bs_warchant' ? Math.max(0, (sInst.jobTier || 1) - 1) : 0;
    for (const [k2, tInst] of allPlaced) {
      if (k2 === key) continue;
      const p2 = tInst.center; // cached at placement time — see placeUnitAt()
      if (supportStats.fullRange || dist(center.x, center.y, p2.x, p2.y) <= range) {
        addBuffSource(tInst, key); // 이 아군이 관여한 킬의 경험치를 함께 나눠 받는다
        tInst.buffs = tInst.buffs || {};
        tInst.buffs.atk = (tInst.buffs.atk || 0) + power;
        // '질주의 오라' / '광역 축복' 특화 노드 — 지원형 트리에서만 나오는 오라 전용 축
        tInst.buffs.aspd = (tInst.buffs.aspd || 0) + power * 0.6 + (supportStats.auraAspdAdd || 0)
          + (chantStep >= 2 ? power * 0.35 * (chantStep - 1) : 0);
        tInst.buffs.range = (tInst.buffs.range || 0) + power * 0.3 + (supportStats.auraRangeAdd || 0)
          + (chantStep >= 3 ? power * 0.25 : 0);
        tInst.buffs.critChance = (tInst.buffs.critChance || 0) + power * 0.4 + supportLab.auraCritChance
          + (chantStep >= 3 ? power * 0.3 : 0);
        tInst.buffs.critDmg = (tInst.buffs.critDmg || 0) + power * 0.5 + supportLab.auraCritDmg
          + (chantStep >= 3 ? power * 0.5 : 0);
        tInst.buffs.bossDmg = (tInst.buffs.bossDmg || 0) + power * 0.6 + supportLab.auraBossDmg;
      }
    }
  }
}

// tank_guard's passive damage-reduction aura (#4) — a CONTINUOUS aura like buff_support's,
// not an on-cooldown skill, so it must run every combat tick. Called AFTER
// updateSupportBuffs() (which resets .buffs to null first) so it ADDS onto whatever that
// pass already set, rather than wiping it — same additive-stacking pattern used there.
function updateGuardAuras() {
  const allPlaced = Object.entries(state.placed);
  const guards = allPlaced.filter(([, inst]) => defOf(inst).base.guard);
  if (guards.length === 0) return;
  const guardLab = computeLabBonus('tank_guard');
  for (const [key, gInst] of guards) {
    const guardStats = computeStats(gInst);
    const range = buffAuraRange(gInst);
    const center = gInst.center;
    const grade = gradeOf(gInst);
    // 불굴의 방벽 갈래는 보호막 오라 자체를 계속 끌어올린다 (shieldPct에 이미 합산됨)
    const power = 12 + (grade.mult - 1) * 8 + (guardStats.shieldPct || guardLab.shieldPct) * 0.6;
    for (const [k2, tInst] of allPlaced) {
      const p2 = tInst.center;
      if (dist(center.x, center.y, p2.x, p2.y) <= range) { // includes the tanker itself (k2 === key allowed)
        if (k2 !== key) addBuffSource(tInst, key); // 자기 자신은 "도움"이 아니므로 제외
        tInst.buffs = tInst.buffs || {};
        tInst.buffs.dmgReductionPct = (tInst.buffs.dmgReductionPct || 0) + power;
      }
    }
  }
}

// buff_support's reworked "zone" skill (#1, 오라클 리워크): instead of a global field-wide
// buff, the legendary skill / lab capstone now drops a localized zone (see spawnZone kind
// 'buff') that boosts whatever allies are standing IN it. This aggregates that onto
// inst.buffs every tick, same additive pattern as the aura passes above.
function updateZoneBuffs() {
  const buffZones = state.zones.filter(z => z.kind === 'buff');
  if (buffZones.length === 0) return;
  for (const [, inst] of Object.entries(state.placed)) {
    const c = inst.center;
    for (const z of buffZones) {
      if (dist(c.x, c.y, z.x, z.y) <= z.r) {
        inst.buffs = inst.buffs || {};
        inst.buffs.atk = (inst.buffs.atk || 0) + z.atkPct;
        inst.buffs.aspd = (inst.buffs.aspd || 0) + z.aspdPct;
      }
    }
  }
}

// heal_support's periodic heal-over-time (#3) — heals every damaged ally within range by
// a flat-ish amount derived from its own atk stat, boosted by the healPct lab node.
function doHealTick(inst, stats, center) {
  const baseHeal = stats.atk * 0.9 * (1 + stats.healPct / 100);
  const healRange = buffAuraRange(inst);
  const step = jobStep(inst);
  const branch = stats.jobBranch;
  const bp = stats.branchPower || 0;
  let healedAny = false;
  for (const [k2, ally] of Object.entries(state.placed)) {
    const c2 = ally.center;
    if (dist(center.x, center.y, c2.x, c2.y) > healRange) continue;
    if (k2 !== inst.cellKey) addBuffSource(ally, inst.cellKey); // 치유도 "도움"이므로 경험치 기여
    // 생명의 원천(hs_bloom): 체력이 가득한 아군에게는 넘친 치유가 보호막(피해 경감)으로 굳는다
    if (branch === 'hs_bloom' && step > 0) {
      ally.buffs = ally.buffs || {};
      ally.buffs.dmgReductionPct = Math.min(75, (ally.buffs.dmgReductionPct || 0) + (4 + bp * 0.1) * step);
    }
    // 수호천사(hs_zealot): 치유가 곧 공격 버프 — 치유 사거리 안의 아군을 강화한다
    if (branch === 'hs_zealot' && step > 0) {
      ally.buffs = ally.buffs || {};
      ally.buffs.atk = (ally.buffs.atk || 0) + (7 + bp * 0.15) * step;
      if (step >= 2) ally.buffs.aspd = (ally.buffs.aspd || 0) + 4 * step;
      // 심판의 광휘(4차): 축복이 치명타까지 벼려낸다 — 공격형 힐러가 후반에 실제로
      // "세 번째 딜러"처럼 느껴지게 하는 마지막 한 겹
      if (step >= 3) ally.buffs.critChance = (ally.buffs.critChance || 0) + 6;
    }
    if (ally.hp == null || ally.maxHp == null) continue;
    if (ally.hp >= ally.maxHp) continue;
    // 재생의 샘(생명의 원천 3차+): 위독한 아군을 선별해 훨씬 크게 응급 치유한다.
    // 순수 치유 갈래가 "숫자만 큰 힐"에 머물지 않고 실제 구조 능력을 갖게 되는 지점.
    let healAmount = baseHeal;
    if (branch === 'hs_bloom' && step >= 2 && ally.hp < ally.maxHp * 0.5) {
      healAmount *= 1 + 0.35 * step + bp * 0.004;
    }
    ally.hp = Math.min(ally.maxHp, ally.hp + healAmount);
    healedAny = true;
    spawnHitParticles(c2.x, c2.y, '#3c9c68', 4);
    if (state.floatingTexts.length < MAX_FLOATING_TEXTS) {
      state.floatingTexts.push({ x: c2.x + (Math.random() * 10 - 5), y: c2.y - 26, t: 0, dur: 0.55, value: '+' + Math.round(healAmount), heal: true });
    }
  }
  if (healedAny) spawnHitParticles(center.x, center.y, '#3c9c68', 3);
  // 심판의 광휘 (수호천사 4차): 치유의 파동이 주변 적까지 태운다 — 힐러가 처음으로
  // 스스로 킬 기여를 만들어내는 지점이라 경험치 기여자로도 정식 등록된다
  if (branch === 'hs_zealot' && stats.jobTier >= 4) {
    const novaR = healRange;
    for (const m of state.monsters) {
      if (m.dying) continue;
      if (dist(center.x, center.y, m.x, m.y) > novaR) continue;
      addXpContributor(m, inst.cellKey);
      dealDamage(m, stats.atk * (0.6 + bp * 0.01), false, false);
    }
    spawnShockRing(center.x, center.y, novaR, '#e0c56a');
  }
}

function findTargets(center, statsObj, count) {
  const inRange = state.monsters.filter(m => !m.dying && (statsObj.fullRange || dist(center.x, center.y, m.x, m.y) <= statsObj.range * CELL));
  if (count <= 1) {
    // single-target units feel more natural engaging whatever is closest, like a real guard would,
    // rather than every unit on the field snapping to the same lowest-hp monster
    inRange.sort((a, b) => dist(center.x, center.y, a.x, a.y) - dist(center.x, center.y, b.x, b.y));
  } else {
    // multi-hit units still prioritize low-hp targets so cleaves/aoe help secure kills
    inRange.sort((a, b) => a.hp - b.hp);
  }
  return inRange.slice(0, count);
}

// same targeting rules as findTargets(), but reads from an already range-filtered/
// distance-sorted `pool` instead of re-scanning+re-filtering every monster on the field.
// tickCombat's swing catch-up loop can call this several times per unit within a single
// frame at high game-speed multipliers (dt covers more attack intervals -> more swings
// resolved synchronously) — since monster POSITIONS never change mid-tickCombat (tickMonsters
// already ran earlier this same loop() iteration), the in-range set and each candidate's
// distance-to-attacker are both static for the whole tick, so recomputing dist() and
// re-filtering the full monster list against range on every single swing was pure waste.
// Only what genuinely changes between swings (hp, from earlier swings this same tick, and
// dying status, from kills this same tick) is re-checked here.
function findTargetsFromPool(pool, count) {
  const live = pool.filter(m => !m.dying);
  if (count <= 1) return live.slice(0, count); // pool is already distance-sorted, closest-first
  live.sort((a, b) => a.hp - b.hp); // hp changes swing-to-swing, so this still needs a fresh sort
  return live.slice(0, count);
}

// caps on transient VFX arrays: with splash/DoT/extra-attack now able to fire several
// damage instances per frame (especially against the monster cluster near the nest),
// uncapped growth here was a real source of frame drops during heavy combat.
// floatingTexts specifically was measured (draw() with/without the array, isolated via
// stress test) as the single largest line item in per-frame draw cost — each one does a
// save/translate/scale + a font change + strokeText (notably pricier than fillText on
// canvas) + fillText + restore, and at heavy-combat volume the array was sitting at or
// near its cap essentially every frame. Lowered from 90 to 55: still plenty of visible
// damage feedback, but a meaningfully smaller fixed per-frame draw cost.
// lowered further (55->40, 240->190, 150->110): combined with dealDamage()'s new
// showText=false suppression on incidental damage (splash/DoT/zone/turret ticks —
// the highest-VOLUME sources), the caps themselves were rarely the limiting factor
// anymore, but a smaller worst-case still means a smaller worst-case draw cost
const MAX_FLOATING_TEXTS = 40;
const MAX_PARTICLES = 190;
const MAX_PROJECTILES = 110;
const MAX_ZONES = 14;
const MAX_TURRETS = 8;

// object pool for projectiles ("bullets") — mirrors the monster pool above: reuse a
// recycled object instead of allocating a fresh one at every attack, cutting GC
// pressure during heavy combat (particularly costly as pauses on mobile Safari)
const projectilePool = [];
function spawnProjectile(x1, y1, x2, y2, dur, color) {
  if (state.projectiles.length >= MAX_PROJECTILES) return;
  const p = projectilePool.pop() || {};
  p.x1 = x1; p.y1 = y1; p.x2 = x2; p.y2 = y2; p.t = 0; p.dur = dur; p.color = color;
  state.projectiles.push(p);
}

// lingering ground-effect areas (fire zones from magic_multi, plague zones from
// buff_debuff, buff zones from buff_support, tornado zones from atk_multi).
// Duration/tick-cadence run on the speed-multiplied dt (via tickZones), same as the
// rest of combat, so they read consistently at 1x and 10x game speed.
// extra: { atkPct, aspdPct } for kind 'buff' (ignored otherwise). vx/vy: optional
// per-second drift in px — used by 'tornado' zones so they travel instead of sitting still.
function spawnZone(x, y, r, kind, dmgPerTick, tickInterval, duration, extra, vx, vy) {
  if (state.zones.length >= MAX_ZONES) return;
  state.zones.push({
    x, y, r, kind, dmgPerTick, tickInterval, tickTimer: tickInterval, life: duration, particleTimer: 0,
    atkPct: extra ? (extra.atkPct || 0) : 0, aspdPct: extra ? (extra.aspdPct || 0) : 0,
    vx: vx || 0, vy: vy || 0,
  });
}

function tickZones(dt) {
  if (state.zones.length === 0) return;
  for (const z of state.zones) {
    if (z.vx || z.vy) { z.x += z.vx * dt; z.y += z.vy * dt; } // tornado: travels along its path
    z.life -= dt;
    z.tickTimer -= dt;
    z.particleTimer -= dt;
    // buff zones don't damage monsters — they're handled separately by updateZoneBuffs()
    if (z.tickTimer <= 0 && z.kind !== 'buff') {
      z.tickTimer += z.tickInterval;
      for (const m of state.monsters) {
        if (m.dying) continue;
        if (dist(z.x, z.y, m.x, m.y) <= z.r) {
          dealDamage(m, z.dmgPerTick, false, false);
          if (z.kind === 'plague') applySlow(m, 0.6, performance.now() + 700);
        }
      }
    }
    if (z.particleTimer <= 0) {
      if (z.kind === 'fire') {
        // flame-colored particles licking upward out of the zone
        z.particleTimer = 0.12;
        if (state.particles.length < MAX_PARTICLES) {
          const px = z.x + (Math.random() * z.r * 1.2 - z.r * 0.6);
          const py = z.y + (Math.random() * z.r * 0.5 - z.r * 0.25);
          state.particles.push({
            x: px, y: py, vx: (Math.random() * 20 - 10), vy: -50 - Math.random() * 40,
            t: 0, dur: 0.35 + Math.random() * 0.2, color: Math.random() < 0.5 ? '#c17a41' : '#d19a5a', r: 2 + Math.random() * 2,
          });
        }
      } else if (z.kind === 'buff') {
        // buff zone (오라클 rework): gentle upward-drifting sparkle motes, golden-green —
        // deliberately NOT the fire/plague drift so the buff zone reads as "blessing", not
        // "hazard", at a glance across the field
        z.particleTimer = 0.18;
        if (state.particles.length < MAX_PARTICLES) {
          const ang = Math.random() * Math.PI * 2;
          const rr = Math.random() * z.r * 0.8;
          state.particles.push({
            x: z.x + Math.cos(ang) * rr, y: z.y + Math.sin(ang) * rr,
            vx: (Math.random() * 8 - 4), vy: -26 - Math.random() * 16,
            t: 0, dur: 0.5 + Math.random() * 0.25, color: Math.random() < 0.5 ? '#5cb37e' : '#e0c765', r: 1.6 + Math.random() * 1.6,
          });
        }
      } else if (z.kind === 'tornado') {
        // tornado: debris caught in a swirling orbit around the zone center instead of
        // drifting up/down like fire or plague — its own distinct motion language since
        // it's also the only zone type that itself travels across the field
        z.particleTimer = 0.05;
        if (state.particles.length < MAX_PARTICLES) {
          const ang = Math.random() * Math.PI * 2;
          const rr = z.r * (0.5 + Math.random() * 0.5);
          const px = z.x + Math.cos(ang) * rr, py = z.y + Math.sin(ang) * rr;
          // tangential velocity (perpendicular to the radius) so particles visibly orbit
          // rather than fly outward, plus a slight inward pull to keep them circling
          const tx = -Math.sin(ang), ty = Math.cos(ang);
          state.particles.push({
            x: px, y: py, vx: tx * 90 - Math.cos(ang) * 14, vy: ty * 90 - Math.sin(ang) * 14,
            t: 0, dur: 0.3 + Math.random() * 0.15, color: '#8c8c96', r: 1.8 + Math.random() * 1.8,
          });
        }
      } else {
        // plague: slower, sickly, bubbling motion — visually distinct from fire
        z.particleTimer = 0.22;
        if (state.particles.length < MAX_PARTICLES) {
          const px = z.x + (Math.random() * z.r * 1.4 - z.r * 0.7);
          const py = z.y + (Math.random() * z.r * 0.6 - z.r * 0.3);
          state.particles.push({
            x: px, y: py, vx: (Math.random() * 12 - 6), vy: -14 - Math.random() * 10,
            t: 0, dur: 0.6 + Math.random() * 0.3, color: '#8a7a9c', r: 2.5 + Math.random() * 2.5,
          });
        }
      }
    }
  }
  state.zones = state.zones.filter(z => z.life > 0);
}

// temporary buff_support deployable turret: fires on its own cooldown at the
// nearest non-dying monster in range, dealing modest damage off the caster's atk
function spawnTurret(x, y, range, dmgPerTick, fireInterval, duration) {
  if (state.turrets.length >= MAX_TURRETS) return;
  state.turrets.push({ x, y, range, dmgPerTick, fireInterval, fireTimer: fireInterval, life: duration });
}

function tickTurrets(dt) {
  if (state.turrets.length === 0) return;
  for (const t of state.turrets) {
    t.life -= dt;
    t.fireTimer -= dt;
    if (t.fireTimer <= 0) {
      t.fireTimer += t.fireInterval;
      let target = null, bestD = Infinity;
      for (const m of state.monsters) {
        if (m.dying) continue;
        const d = dist(t.x, t.y, m.x, m.y);
        if (d <= t.range && d < bestD) { bestD = d; target = m; }
      }
      if (target) {
        dealDamage(target, t.dmgPerTick, false, false);
        spawnHitParticles(target.x, target.y, '#379966', 4);
        t.fireFlash = performance.now(); // recoil scale-punch cue drawn in draw()
        spawnProjectile(t.x, t.y, target.x, target.y, 0.15, '#379966');
      }
    }
  }
  state.turrets = state.turrets.filter(t => t.life > 0);
}

// applying the same status again while it's already active refreshes/strengthens it
// instead of stacking a duplicate, independent instance of the same effect
function applySlow(m, factor, untilTs) {
  const now = performance.now();
  if (now >= m.slowUntil || factor <= m.slowFactor) m.slowFactor = factor; // stronger (lower) or a fresh application wins
  m.slowUntil = Math.max(m.slowUntil, untilTs);
}
function applyDebuffMult(m, mult, untilTs) {
  const now = performance.now();
  if (now >= m.debuffUntil || mult >= m.debuffAtkTakenMult) m.debuffAtkTakenMult = mult; // stronger or fresh wins
  m.debuffUntil = Math.max(m.debuffUntil, untilTs);
}
// tank_guard's taunt proc: a taunted mid/boss must prioritize whichever unit taunted
// it (while still taunted and that unit is within its own attack/skill range) instead
// of its normal nearest-target pick — see tickMonsterAttacks/tickMonsterSkills. A
// fresh taunt from a DIFFERENT unit simply overrides the old one (there's only ever
// one "most urgent threat" at a time, unlike stacking damage-style effects).
function applyTaunt(m, tauntKey, untilTs) {
  // a fresh taunt (from anyone) simply becomes the new most-urgent-threat, and the
  // same taunter re-applying just extends their own duration rather than resetting it
  m.tauntUntil = (m.tauntedBy === tauntKey) ? Math.max(m.tauntUntil || 0, untilTs) : untilTs;
  m.tauntedBy = tauntKey;
}
// ---- 경성 제어(hard CC): 기절 / 속박 ----
// 둘 다 이동을 완전히 멈추지만 의미가 다르다: 기절은 "끊는" 제어(짧고, 봉인 갈래의 언어),
// 속박은 "붙잡는" 제어(그 자리에 뿌리내리게 하고 취약까지 부여 — 결빙 갈래의 언어).
//
// 중요: 기절 + 속박 + 결빙(applySlow 0.03)이 서로 겹쳐 무한 정지가 되지 않도록,
// 경성 제어가 걸릴 때마다 그 몬스터에 "면역 창"(ccImmuneUntil)을 남긴다. 면역 창이
// 살아있는 동안 새 경성 제어는 통째로 무시되고, 부드러운 제어(둔화/취약/도트)만 계속
// 통한다. 보스/중간보스는 지속시간이 추가로 크게 깎여 절대 잠기지 않는다.
const HARD_CC_IMMUNE_MS = 1300; // 제어가 끝난 뒤 이만큼은 다음 경성 제어를 받지 않는다
const HARD_CC_BOSS_SCALE = { boss: 0.35, mid: 0.6, normal: 1 };
// kind: 'stun' | 'bind' | 'freeze'. 셋 다 같은 원장(ccImmuneUntil)을 공유하는 게 핵심이다 —
// 종류별로 따로 관리하면 기절→속박→결빙을 번갈아 걸어 면역 창을 영원히 우회할 수 있다.
// 실측으로 확인한 문제였다: 빙결술사 6기 + 도발자 8기를 한 지점에 쌓았더니 결빙이 게이트를
// 통과해 400프레임 내내 100% 잠금이 나왔다. 하나의 원장으로 묶은 뒤 같은 조건에서 크게 떨어진다.
function applyHardCC(m, kind, durMs) {
  const now = performance.now();
  if (now < (m.ccImmuneUntil || 0)) return false; // 아직 면역 창 안 — 중첩 잠금 방지
  const dur = durMs * (HARD_CC_BOSS_SCALE[m.kind] || 1);
  if (dur <= 0) return false;
  const until = now + dur;
  if (kind === 'bind') {
    m.bindUntil = Math.max(m.bindUntil || 0, until);
    // 속박은 "붙잡아 두고 부수기 쉽게 만드는" 제어라 취약을 함께 건다
    applyDebuffMult(m, 1.15, until);
  } else if (kind === 'freeze') {
    applySlow(m, 0.03, until); // 결빙 = 둔화의 극단값이지만 잠금 예산은 기절/속박과 공유한다
  } else {
    m.stunUntil = Math.max(m.stunUntil || 0, until);
  }
  m.ccImmuneUntil = until + HARD_CC_IMMUNE_MS;
  return true;
}
// 봉인(seal): 이동은 막지 않고 보스/중간보스의 "스킬 시전"만 잠근다 (tickMonsterSkills 참고).
// 이동을 막지 않으니 경성 제어와 같은 원장을 쓰진 않지만, 자체 면역 창은 반드시 필요하다 —
// 없이 두면 한파술사 1기가 보스를 매 타격마다 재봉인해서 보스 스킬이 영구히 잠겼다(실측:
// 보스 3기 200프레임 내내 100% 봉인). 봉인이 끝나면 최소 그만큼은 반드시 시전 기회를 준다.
const SEAL_MAX_MS = 2500;
const SEAL_IMMUNE_MS = 4000;
function applySeal(m, durMs) {
  const now = performance.now();
  if (now < (m.sealImmuneUntil || 0)) return false;
  const until = now + Math.min(durMs, SEAL_MAX_MS);
  m.sealUntil = Math.max(m.sealUntil || 0, until);
  m.sealImmuneUntil = until + SEAL_IMMUNE_MS;
  return true;
}
function applyDot(m, dmgPerTick) {
  if (m.dots.length > 0) {
    // refresh the existing stack rather than piling on a second copy of the same DoT
    const existing = m.dots[0];
    existing.dmgPerTick = Math.max(existing.dmgPerTick, dmgPerTick);
    existing.ticksLeft = 3;
    existing.nextTick = performance.now() + 900;
    return;
  }
  m.dots.push({ dmgPerTick, ticksLeft: 3, nextTick: performance.now() + 900 });
}
// boss/mid-boss debuff skill (#8): weakens a UNIT's atk/aspd — same refresh/strengthen
// pattern as the monster-side applyX helpers above, just targeting a placed unit instance
function applyUnitWeaken(inst, atkMult, aspdMult, untilTs) {
  const now = performance.now();
  if (!inst.weaken || now >= inst.weaken.until) inst.weaken = { atkMult: 1, aspdMult: 1, until: 0 };
  if (atkMult <= inst.weaken.atkMult) inst.weaken.atkMult = atkMult; // stronger (lower) wins
  if (aspdMult <= inst.weaken.aspdMult) inst.weaken.aspdMult = aspdMult;
  inst.weaken.until = Math.max(inst.weaken.until, untilTs);
}
// boss "rally" skill (#8): temporarily hastens a nearby MONSTER's move speed
function applyMonsterHaste(m, mult, untilTs) {
  const now = performance.now();
  if (now >= m.hasteUntil || mult >= (m.hasteMult || 1)) m.hasteMult = mult;
  m.hasteUntil = Math.max(m.hasteUntil || 0, untilTs);
}

// showText defaults to true for primary attacks. Secondary/incidental damage sources
// (splash, DoT ticks, zone ticks, turret ticks) pass false — those can land many times
// per second across many monsters at once and were the biggest contributor to floating-
// text volume without adding much readable information over the primary hit's own number
function dealDamage(m, amount, isCrit, showText = true) {
  m.hp -= amount;
  if (showText && state.floatingTexts.length < MAX_FLOATING_TEXTS) {
    state.floatingTexts.push({
      x: m.x + (Math.random() * 14 - 7), y: m.y - 18, t: 0, dur: isCrit ? 0.9 : 0.6,
      value: Math.round(amount), crit: isCrit,
    });
  }
}

// resolves one attack instance against one target: crit roll, boss/normal/debuff
// modifiers, the hit itself, then any on-hit 연구실 procs (splash, poison/DoT)
function resolveHit(m, inst, stats, center) {
  const now = performance.now();
  const def = defOf(inst);
  inst.atkFlash = now; // quick recoil/scale-punch drawn in draw(), for attack feedback that reads at a glance
  // 경험치 기여자 등록: 이 유닛 + 지금 이 유닛을 돕고 있는 지원 유닛들
  addXpContributor(m, inst.cellKey);
  addXpAssists(m, inst);
  const crit = Math.random() * 100 < stats.critChance;
  let dmg = stats.atk * (crit ? (1 + stats.critDmg / 100) : 1);
  if ((m.kind === 'boss' || m.kind === 'mid') && stats.bossDmg) dmg *= (1 + stats.bossDmg / 100);
  if (m.kind === 'normal' && stats.normalDmgPct) dmg *= (1 + stats.normalDmgPct / 100);
  if (now < m.debuffUntil) dmg *= m.debuffAtkTakenMult; // debuff-type units mark targets to take extra damage
  dealDamage(m, dmg, crit);
  const subColor = SUBTYPE_COLORS[def.subKey] || '#4a72d6';
  spawnProjectile(center.x, center.y, m.x, m.y, 0.15, crit ? '#bd9530' : subColor);
  spawnHitParticles(m.x, m.y, crit ? '#bd9530' : subColor, crit ? 6 : 3);
  if (stats.cc) applySlow(m, Math.max(0.35, 1 - stats.slow / 100 - 0.3), now + 1500);
  if (stats.debuff) applyDebuffMult(m, 1.25 + stats.debuffPct / 100, now + 2000);

  // 여파 (연구실): 주변 대상에게도 감소된 피해
  if (stats.splashPct > 0) {
    for (const other of state.monsters) {
      if (other === m || other.dying) continue;
      if (dist(m.x, m.y, other.x, other.y) <= 55) {
        dealDamage(other, dmg * stats.splashPct / 100, false, false);
        spawnHitParticles(other.x, other.y, '#c17a41', 3);
      }
    }
  }
  // 도트 계열 (연구실): 확률로 서브타입에 맞는 원소 효과 발동 (같은 효과는 중복 대신 갱신/강화됨)
  if (stats.dotChance > 0 && Math.random() * 100 < stats.dotChance) {
    if (def.subKey === 'magic_ctrl') {
      // 동상: 서리 스택이 2.5초 내 갱신되지 않으면 초기화, 3스택에서 강한 결빙
      if (m.frostStacks && now - (m.frostStackAt || 0) > 2500) m.frostStacks = 0;
      m.frostStacks = (m.frostStacks || 0) + 1;
      m.frostStackAt = now;
      if (m.frostStacks >= 3) {
        m.frostStacks = 0;
        // freeze duration scales off 혹한 강화 (slowAdd -> folded into stats.slow), so
        // deeper investment in that branch makes the payoff hit harder, not just proc more
        const freezeDur = Math.min(2200, 600 + stats.slow * 25);
        applySlow(m, 0.03, now + freezeDur); // hard freeze, near-total stop
        spawnIcyShatter(m.x, m.y);
      } else {
        applySlow(m, Math.max(0.35, 1 - stats.slow / 100 - 0.3), now + 1500);
      }
    } else if (def.subKey === 'magic_multi') {
      // 화염 낙인: 화상(DoT) + 잔류 화염지대 (연쇄 폭발 노드가 지대 피해를 강화)
      applyDot(m, stats.atk * 0.4);
      spawnZone(m.x, m.y, 48, 'fire', stats.atk * 0.12 * (1 + stats.splashPct / 100), 0.5, 3);
    } else if (def.subKey === 'atk_multi') {
      // 유혈: 기본 스플래시보다 큰 범위의 폭발 (여파 노드가 강도를 강화)
      const bigR = 55 * 1.6;
      for (const other of state.monsters) {
        if (other === m || other.dying) continue;
        if (dist(m.x, m.y, other.x, other.y) <= bigR) {
          dealDamage(other, stats.atk * (stats.splashPct / 100) * 1.3, false, false);
        }
      }
      spawnHitParticles(m.x, m.y, '#c17a41', 16);
      spawnShockRing(m.x, m.y, bigR, '#c17a41');
      shakeScreen(2.5);
    } else if (def.subKey === 'buff_debuff') {
      // 역병: 잔류 역병지대 (둔화 + 지속피해) — 강도/지속시간이 약화 강화(debuffPct)로 강화됨
      const plagueDur = Math.min(6, 3 + stats.debuffPct * 0.06);
      spawnZone(m.x, m.y, 45, 'plague', stats.atk * 0.25 * (1 + stats.debuffPct / 200), 0.6, plagueDur);
    } else {
      applyDot(m, stats.atk * 0.4);
    }
  }

  // 공격형-단일 전용: 확률 기반 기절 + 매우 낮은 확률의 즉사 (일격필살/처형자의 원한 노드 레벨에서 직접 파생,
  // 해당 노드가 이미 부여하는 critChanceAdd/normalDmgPct는 그대로 유지되는 '추가' 효과)
  if (def.subKey === 'atk_single' && !m.dying) {
    const branchALvl = labNodeLevel('atk_single', 'branchA');
    const leafALvl = labNodeLevel('atk_single', 'leafA');
    const stunChance = Math.min(15, branchALvl * 1.1); // %, capped ~15%
    const executeChance = Math.min(4, leafALvl * 0.28); // % capped ~4%, normal-kind only
    if (stunChance > 0 && Math.random() * 100 < stunChance) {
      m.stunUntil = Math.max(m.stunUntil || 0, now + 700);
      spawnStunBurst(m.x, m.y);
    }
    if (m.kind === 'normal' && executeChance > 0 && Math.random() * 100 < executeChance) {
      m.hp = 0; // routes through the existing dying/fade pipeline in tickCombat
      spawnHitParticles(m.x, m.y, '#c1465f', 20);
      if (state.floatingTexts.length < MAX_FLOATING_TEXTS) {
        state.floatingTexts.push({ x: m.x, y: m.y - 20, t: 0, dur: 1.0, value: '즉사!', execute: true });
      }
    }
  }

  // 수호형-탱커 전용: 기본공격 확률 기반 도발 — leafB "도발의 기백" 노드 레벨에서 직접
  // 파생 (해당 노드가 이미 부여하는 critChanceAdd는 그대로 유지). 도발된 보스/중간보스는
  // 사거리 내에 이 탱커가 있는 한 다른 유닛보다 우선 타겟한다 (tickMonsterAttacks/
  // tickMonsterSkills 참고).
  if (def.subKey === 'tank_guard' && !m.dying && inst.cellKey) {
    const tauntNodeLvl = labNodeLevel('tank_guard', 'leafB');
    // '격노의 도발'(tauntPowerPct) 특화 노드가 확률 상한까지 함께 밀어올린다
    const tauntChance = Math.min(35 + (stats.tauntPower || 0) * 0.4, 12 + tauntNodeLvl * 1.2 + (stats.tauntPower || 0) * 0.5);
    if (Math.random() * 100 < tauntChance) {
      applyTaunt(m, inst.cellKey, now + 4000);
      spawnHitParticles(m.x, m.y - 6, '#c9a24a', 5);
    }
  }

  // ---- 전직 갈래별 기본공격 변화 (2차 이상에서만) ----
  // 미전직 유닛은 아래 비교 한 번만 치르고 빠져나간다
  if (inst.jobTier > 1) applyJobAttack(m, inst, stats, center, dmg, crit, now);
}

// 전직한 유닛의 기본공격이 "갈래의 정체성"대로 달라지는 지점. 전부 기존 메커니즘
// (폭탄 부착 / 광란 / 화염지대 / 서리 스택 / 번개 연쇄 / 저주·역병 / 도발)에서 뻗어
// 나오며, 새 시스템을 만드는 대신 기존 pooled spawn 함수(spawnProjectile/spawnHitParticles/
// spawnZone/spawnMeteor/attachBomb/...)만 재사용한다. step = 전직 차수 단계(1/2/3).
function applyJobAttack(m, inst, stats, center, dmg, crit, now) {
  const step = stats.jobTier - 1;
  const bp = stats.branchPower || 0; // 연구실 '전직 특화' 투자분
  switch (stats.jobBranch) {
    // ---------- 공격형-단일 ----------
    case 'as_exec': {
      // 처형: 체력 비율이 문턱 아래인 적을 즉시 베어낸다. 4차부터는 중간보스까지 대상.
      if (m.dying || !m.maxHp) break;
      // 보스 학살형의 본체: 처형이 통하지 않는 보스에게는 대신 "처형 각인"을 새긴다.
      // 각인은 취약(모든 아군이 주는 피해 증가)으로 표현되며, 느린 공속의 한 방마다
      // 갱신·강화되어 결국 보스전 총 피해량으로 환산된다.
      const allowMid = step >= 3;
      if (m.kind === 'boss' || (m.kind === 'mid' && !allowMid)) {
        applyDebuffMult(m, 1.08 + 0.06 * step + bp / 400, now + 3000);
        break;
      }
      const threshold = (0.05 * step + bp * 0.002) * (m.kind === 'mid' ? 0.4 : 1);
      if (m.hp / m.maxHp <= threshold) {
        m.hp = 0;
        spawnHitParticles(m.x, m.y, '#7b2f6b', 18);
        if (step >= 3) { // 종언의 심판: 처형이 주변까지 휩쓴다
          spawnShockRing(m.x, m.y, 52, '#7b2f6b');
          for (const o of state.monsters) {
            if (o === m || o.dying) continue;
            if (dist(m.x, m.y, o.x, o.y) <= 52) { addXpContributor(o, inst.cellKey); dealDamage(o, dmg * 0.6, false, false); }
          }
        }
        if (state.floatingTexts.length < MAX_FLOATING_TEXTS) {
          state.floatingTexts.push({ x: m.x, y: m.y - 20, t: 0, dur: 1.0, value: '처형!', execute: true });
        }
      }
      break;
    }
    case 'as_bomb': {
      // 폭파공: 단일 강타가 광역 지연 폭발로 바뀐다 (기존 capstone 폭탄 메커니즘의 상시화)
      if (m.dying || m.bombTagged) break;
      const chance = 14 * step + bp * 0.4;
      if (Math.random() * 100 < chance) {
        attachBomb(m, stats.atk * (0.7 + 0.45 * step), Math.max(600, 1400 - step * 250));
        spawnHitParticles(m.x, m.y, '#c1465f', 4);
      }
      break;
    }
    // ---------- 공격형-다중 ----------
    case 'am_frenzy': {
      // 광전사: 때릴수록 스스로 빨라진다 — 광란 창을 조금씩 밀어 상시에 가깝게 유지
      const chance = 10 * step + bp * 0.35;
      if (Math.random() * 100 < chance) {
        const base = Math.max(inst.frenzyUntil || 0, now);
        inst.frenzyUntil = Math.min(now + 1200 + step * 900, base + 350 + step * 200);
        if (crit) spawnHitParticles(center.x, center.y, '#c1465f', 4);
      }
      break;
    }
    case 'am_quake': {
      // 분쇄자: 매 타격이 폭심지가 된다 (기존 '유혈' 대폭발의 상시 축소판)
      const r = 34 + 14 * step;
      for (const o of state.monsters) {
        if (o === m || o.dying) continue;
        if (dist(m.x, m.y, o.x, o.y) <= r) {
          addXpContributor(o, inst.cellKey);
          dealDamage(o, dmg * (0.16 + 0.09 * step) * (1 + bp / 100), false, false);
        }
      }
      if (crit) spawnShockRing(m.x, m.y, r, '#c17a41'); // 링은 치명타에만 — 매 타격마다 띄우면 화면이 링으로 덮인다
      break;
    }
    // ---------- 마법형-다중 ----------
    case 'mm_pyro': {
      // 화염술사: 화상이 확률이 아니라 확정이 되고, 3차부터 잔류 화염지대까지 상시로 깐다
      applyDot(m, stats.atk * (0.2 + 0.12 * step) * (1 + bp / 100));
      if (step >= 2 && (step >= 3 || crit)) {
        spawnZone(m.x, m.y, 40 + step * 6, 'fire', stats.atk * 0.1 * step * (1 + stats.splashPct / 100), 0.5, 2 + step * 0.5);
      }
      // 겁화의 대재앙(4차): 불타는 적은 갑주가 녹아 모든 아군에게 더 큰 피해를 받는다 —
      // 순수 도트 갈래에 "팀 기여" 한 겹을 더해 화염술사가 후반에도 존재감을 갖게 한다
      if (step >= 3) applyDebuffMult(m, 1.12 + bp / 500, now + 2500);
      break;
    }
    case 'mm_astral': {
      // 천공술사: N번째 공격마다 기본공격이 텔레그래프 후 낙하하는 메테오로 대체된다
      inst.jobCounter = (inst.jobCounter || 0) + 1;
      const every = Math.max(2, 5 - step);
      if (inst.jobCounter >= every) {
        inst.jobCounter = 0;
        spawnMeteor(m.x, m.y, stats.atk * (1.0 + 0.6 * step) * (1 + bp / 100), 46 + step * 6);
        // 천공의 종말(3차+): 낙하 충격이 대상을 잠깐 기절시킨다. 마법형-다중이 순수 피해
        // 갈래로만 남지 않게 하는 최소한의 유틸 — 면역 창이 있어 도배되지 않는다.
        if (step >= 2 && applyHardCC(m, 'stun', 400 + 150 * step)) spawnStunBurst(m.x, m.y);
      }
      break;
    }
    // ---------- 마법형-제어 ----------
    case 'mc_glacier': {
      // 빙결술사: 기본공격이 확정으로 서리를 쌓고, 3중첩에서 강한 결빙 (기존 서리 스택 메커니즘 승격)
      if (m.frostStacks && now - (m.frostStackAt || 0) > 2500) m.frostStacks = 0;
      m.frostStacks = (m.frostStacks || 0) + 1;
      m.frostStackAt = now;
      if (m.frostStacks >= 3) {
        m.frostStacks = 0;
        // 연구실 '속박의 사슬'(ccPowerPct)이 제어 지속시간 전체를 함께 늘린다
        const dur = (500 + 260 * step + bp * 6) * (1 + (stats.ccPower || 0) / 100);
        // 3차부터는 결빙이 "속박"으로 굳는다(이동 차단 + 취약). 그 전까지는 순수 결빙.
        // 둘 다 applyHardCC의 공유 면역 창을 통과해야 하므로, 빙결술사를 아무리 쌓아도
        // 잠금이 이어붙어 영구 정지가 되지 않는다 — 대신 면역 창 밖에서는 확실히 걸린다.
        const froze = applyHardCC(m, step >= 2 ? 'bind' : 'freeze', dur);
        if (froze) {
          spawnIcyShatter(m.x, m.y);
          if (step >= 3) { // 절대영도의 주인: 결빙/속박이 주변으로 번진다
            for (const o of state.monsters) {
              if (o === m || o.dying) continue;
              if (dist(m.x, m.y, o.x, o.y) <= 60) {
                applySlow(o, 0.15, now + dur * 0.6); // 번짐의 둔화는 연성 제어라 게이트 밖
                applyHardCC(o, 'bind', dur * 0.45);
              }
            }
          }
        } else {
          // 면역 창 중이라 잠그지 못한 타격은 그냥 흘려보내지 않고 강한 둔화로 환산한다 —
          // 제어형이 "아무것도 못 하는 프레임"을 갖지 않게 하는 보상 경로
          applySlow(m, Math.max(0.3, 1 - stats.slow / 100 - 0.35), now + 1200);
        }
      }
      break;
    }
    case 'mc_rime': {
      // 한파술사: 붙잡는 대신 "끊는다" — 둔화된 적에게 추가 피해를 넣으면서 확률로 기절시키고,
      // 4차에서는 보스/중간보스의 스킬 시전 자체를 봉인한다 (빙결술사의 결빙/속박과 완전히 다른 축)
      if (now < m.slowUntil) {
        dealDamage(m, dmg * (0.15 * step) * (1 + bp / 100), false, false);
        if (step >= 2) applyDebuffMult(m, 1.08 + 0.07 * step, now + 2000);
        const stunChance = 6 * step + bp * 0.25;
        if (Math.random() * 100 < stunChance) {
          if (applyHardCC(m, 'stun', (450 + 220 * step) * (1 + (stats.ccPower || 0) / 100))) spawnStunBurst(m.x, m.y);
        }
      }
      // 동토의 재앙: 봉인. 이동은 그대로 두고 보스/중간보스의 스킬만 잠근다 — 하드 캡(SEAL_MAX_MS)
      // 과 "쿨다운은 계속 흐른다"는 규칙 덕에 보스를 무력화하는 게 아니라 위험 타이밍을 미룬다.
      if (step >= 3 && (m.kind === 'boss' || m.kind === 'mid')) {
        applySeal(m, 1200 * (1 + (stats.ccPower || 0) / 100));
      }
      break;
    }
    // ---------- 원거리-단일 ----------
    case 'rs_sniper': {
      // 저격수: 한 발이 조준선을 관통한다 (capstone 관통 레이저의 상시 축소판)
      const ang = Math.atan2(m.y - center.y, m.x - center.x);
      const len = (stats.fullRange ? 2000 : stats.range * CELL) * 1.15;
      const ex = center.x + Math.cos(ang) * len, ey = center.y + Math.sin(ang) * len;
      let pierced = 0;
      const maxPierce = step;
      for (const o of state.monsters) {
        if (o === m || o.dying || pierced >= maxPierce) continue;
        if (pointToSegmentDist(o.x, o.y, center.x, center.y, ex, ey) <= 18) {
          addXpContributor(o, inst.cellKey);
          dealDamage(o, dmg * (0.45 + 0.15 * step), false, false);
          pierced++;
        }
      }
      if (step >= 3 && crit) spawnLaserBeam(center.x, center.y, ex, ey, '#2f8ab8'); // 일점 파열의 시각 신호
      break;
    }
    case 'rs_storm': {
      // 뇌전술사: 기존 번개 연쇄가 기본공격의 주력이 된다
      const chance = 20 * step + bp * 0.5;
      if (crit || Math.random() * 100 < chance) resolveHitLightning(m, inst, stats, center);
      break;
    }
    // ---------- 버프형-디버프 ----------
    case 'bd_plague': {
      // 역병술사: 기본공격이 역병지대를 남긴다 (기존 leafA '역병'의 상시화)
      const chance = 16 * step + bp * 0.45;
      if (Math.random() * 100 < chance) {
        spawnZone(m.x, m.y, 40 + step * 5, 'plague', stats.atk * (0.18 + 0.08 * step) * (1 + stats.debuffPct / 200), 0.6, 2.5 + step);
      }
      break;
    }
    case 'bd_doom': {
      // 파멸술사: 저주 자체를 극단으로 — 표식이 더 강하게 붙고, 3차부터 주변으로 전염된다
      applyDebuffMult(m, 1.25 + 0.14 * step + bp / 300, now + 2200 + step * 500);
      if (step >= 2) {
        let spread = step - 1;
        for (const o of state.monsters) {
          if (o === m || o.dying || spread <= 0) continue;
          if (dist(m.x, m.y, o.x, o.y) <= 70) { applyDebuffMult(o, 1.15 + 0.08 * step, now + 2000); spread--; }
        }
      }
      break;
    }
    // ---------- 수호형-탱커 ----------
    case 'tg_provoker': {
      // 도발자: 도발이 확정에 가까워지고, 도발된 적은 둔화 + 모든 아군에게 더 큰 피해를 받는다
      applyTaunt(m, inst.cellKey, now + (3000 + step * 800) * (1 + (stats.tauntPower || 0) / 100));
      applyDebuffMult(m, 1.1 + 0.09 * step + bp / 400, now + 2500);
      if (step >= 2) applySlow(m, Math.max(0.4, 1 - 0.12 * step), now + 1500);
      // 전장의 지배자(4차): 끌어모으는 데서 그치지 않고 아예 발을 묶는다 — 탱커가 "맞아주는
      // 역할"에서 "라인을 세우는 역할"로 확장되는 지점
      if (step >= 3) applyHardCC(m, 'bind', 600 + (stats.ccPower || 0) * 4);
      if (step >= 3) { // 전장의 지배자: 탱커의 기본공격이 주변까지 휩쓴다
        for (const o of state.monsters) {
          if (o === m || o.dying) continue;
          if (dist(m.x, m.y, o.x, o.y) <= 48) { addXpContributor(o, inst.cellKey); dealDamage(o, dmg * 0.5, false, false); }
        }
      }
      break;
    }
    case 'tg_bulwark':
      // 방어 특화 갈래 — 기본공격이 아니라 보호막 오라/체력/반사(damageUnit)로 표현된다
      break;
    default: break;
  }
}

// 이중 사격 (원거리-단일 전용): 맵 전역 무작위 대상에게 번개가 튀는 보너스 사격 —
// resolveHit과 달리 사거리 체크 없이 임의의 살아있는 몬스터를 맞힌다. 첫 타격 이후
// 확률로 "감전"이 발동해 근처의 다른 몬스터로 연쇄된다: 매 점프마다 피해가 절반,
// 다음 점프 확률도 감소 — 기하급수적 감쇠 + 하드 캡(maxJump)으로 반드시 종료된다.
const LIGHTNING_CHAIN_RANGE = 95; // px, spatial proximity for the NEXT chain jump (not map-wide)
const LIGHTNING_MAX_JUMPS = 5;
const LIGHTNING_BASE_CHAIN_CHANCE = 55; // % chance the FIRST jump (origin -> jump1) occurs
const LIGHTNING_CHAIN_DECAY = 0.55; // each successive jump's chain-chance is multiplied by this

function resolveHitLightning(startMonster, inst, stats, center, _jumpCount) {
  const now = performance.now();
  const hitSet = new Set();
  let prevPoint = { x: center.x, y: center.y };
  let cur = startMonster;
  let jumpDmgMult = 1;
  let chainChance = LIGHTNING_BASE_CHAIN_CHANCE;
  let jumps = 0;

  for (let jump = 0; jump <= LIGHTNING_MAX_JUMPS; jump++) {
    if (!cur || cur.dying || hitSet.has(cur)) break;
    const crit = Math.random() * 100 < stats.critChance;
    const dmg = stats.atk * 0.6 * jumpDmgMult * (crit ? (1 + stats.critDmg / 100) : 1);
    addXpContributor(cur, inst.cellKey);
    addXpAssists(cur, inst);
    dealDamage(cur, dmg, crit);
    spawnBolt(prevPoint.x, prevPoint.y, cur.x, cur.y, '#4a90d9');
    spawnHitParticles(cur.x, cur.y, '#4a90d9', jump === 0 ? 6 : 4);
    applyDot(cur, stats.atk * 0.2 * jumpDmgMult);
    hitSet.add(cur);
    jumps++;
    prevPoint = { x: cur.x, y: cur.y };

    if (jump >= LIGHTNING_MAX_JUMPS) break;
    if (Math.random() * 100 >= chainChance) break; // natural geometric decay ends the chain
    // NEARBY monster only (spatial proximity), never another random map-wide pick
    const candidates = state.monsters.filter(x => !x.dying && !hitSet.has(x) && dist(cur.x, cur.y, x.x, x.y) <= LIGHTNING_CHAIN_RANGE);
    if (candidates.length === 0) break;
    candidates.sort((a, b) => dist(cur.x, cur.y, a.x, a.y) - dist(cur.x, cur.y, b.x, b.y));
    cur = candidates[0];
    jumpDmgMult *= 0.5; // each jump halves damage
    chainChance *= LIGHTNING_CHAIN_DECAY; // and lowers the odds of the next jump
  }
  return jumps;
}

// 지속피해(DoT) 처리: 0.9초 간격으로 3회 틱
function tickDots(dt) {
  const now = performance.now();
  for (const m of state.monsters) {
    if (m.dying || !m.dots || m.dots.length === 0) continue;
    m.dots = m.dots.filter(d => {
      if (now >= d.nextTick) {
        dealDamage(m, d.dmgPerTick, false, false);
        d.nextTick += 900;
        d.ticksLeft--;
      }
      return d.ticksLeft > 0;
    });
  }
}

// 연구실 capstone 스킬: 카드 등급과 무관하게 발동하는 서브타입 전용 궁극기
function triggerLabActiveSkill(inst, def, stats, center, capstoneLvl) {
  const node = LAB_TREES[def.subKey].find(n => n.id === 'capstone');
  const now = performance.now();
  // 전직 차수는 기본공격뿐 아니라 보유 스킬도 함께 끌어올린다 (요구사항: 차수마다
  // 기본 공격 및 스킬이 강화). 연구실 투자(capstoneLvl)와 곱해져 둘 다 의미를 갖는다.
  const jobSkillMult = 1 + JOB_TIER_SKILL_DMG[stats.jobTier || 1] / 100;
  const dmgMult = (1 + node.perLevel * capstoneLvl) * jobSkillMult;
  // no toast/shake here on purpose: once several units have their capstone skill,
  // a text popup or screen shake per activation would fire constantly and feel like spam.
  // the particle burst is enough local feedback without disrupting the whole screen.
  spawnHitParticles(center.x, center.y, '#4a72d6', 12);

  if (node.activeKind === 'ally') {
    // 오라클 리워크 (#1): 전군 버프 대신 캐스터 주변 지역에만 적용되는 버프 지대
    const zoneR = 2.0 * CELL;
    spawnZone(center.x, center.y, zoneR, 'buff', 0, 0.5, 5, { atkPct: (12 + capstoneLvl * 3) * jobSkillMult, aspdPct: (10 + capstoneLvl * 1.5) * jobSkillMult });
    spawnTurret(center.x, center.y, 2.5 * CELL, stats.atk * 0.5 * jobSkillMult, 0.5, 5);
    spawnShockRing(center.x, center.y, zoneR, '#3c9c68');
    return;
  }
  if (node.activeKind === 'heal') {
    const inRangeAllies = Object.values(state.placed).filter(a => a.hp != null && dist(center.x, center.y, a.center.x, a.center.y) <= stats.range * CELL);
    const healAmount = stats.atk * (1 + node.perLevel * capstoneLvl) * 2;
    for (const a of inRangeAllies) {
      a.hp = Math.min(a.maxHp, a.hp + healAmount);
      spawnHitParticles(a.center.x, a.center.y, '#3c9c68', 6);
    }
    return;
  }
  if (node.activeKind === 'guard') {
    // 철벽 선언: 사거리 내 아군에게 강력한 임시 피해감소 보호막 (자체 아우라와 별개로 추가 중첩)
    for (const [k2, a] of Object.entries(state.placed)) {
      if (dist(center.x, center.y, a.center.x, a.center.y) <= stats.range * CELL) {
        a.buffs = a.buffs || {};
        a.buffs.dmgReductionPct = Math.min(75, (a.buffs.dmgReductionPct || 0) + (20 + capstoneLvl * 3) * jobSkillMult);
      }
    }
    spawnShockRing(center.x, center.y, stats.range * CELL, '#7b8291');
    return;
  }

  const inRange = state.monsters.filter(m => stats.fullRange || dist(center.x, center.y, m.x, m.y) <= stats.range * CELL);
  if (inRange.length === 0 && node.activeKind !== 'bomb' && node.activeKind !== 'meteor' && node.activeKind !== 'laser') return;

  if (node.activeKind === 'bomb') {
    // 폭탄 부착 (#2): 즉시 소량 피해 + 대상에게 폭탄을 부착해 지연 후 광역 폭발
    if (inRange.length === 0) return;
    inRange.sort((a, b) => dist(center.x, center.y, a.x, a.y) - dist(center.x, center.y, b.x, b.y));
    const target = inRange[0];
    dealDamage(target, stats.atk * dmgMult * 0.3, false);
    attachBomb(target, stats.atk * dmgMult, 1500);
  } else if (node.activeKind === 'tornado') {
    // 회오리 소환 (#2): 정적 광역 대신 경로를 따라 이동하는 지속피해 지대
    const t = inRange[Math.floor(Math.random() * inRange.length)];
    const angle = Math.atan2(t.y - center.y, t.x - center.x);
    const speed = 65;
    spawnZone(center.x, center.y, 40, 'tornado', stats.atk * dmgMult * 0.25, 0.35, 4, null, Math.cos(angle) * speed, Math.sin(angle) * speed);
  } else if (node.activeKind === 'meteor') {
    // 메테오 소환 (#2): 텔레그래프 후 지연 낙하하는 진짜 메테오
    // meteor는 위쪽 공용 빈-사거리 가드에서 제외되어 있으므로(bomb/laser와 동일) 자체
    // 가드가 반드시 필요하다 — 없으면 사거리에 적이 하나도 없을 때 undefined.x로 프레임이
    // 통째로 죽는다 (연구실을 만렙까지 찍은 상태에서 실측으로 잡힌 크래시)
    if (inRange.length === 0) return;
    const t = inRange[Math.floor(Math.random() * inRange.length)];
    spawnMeteor(t.x, t.y, stats.atk * dmgMult * 2.2, 55);
  } else if (node.activeKind === 'laser') {
    // 관통 레이저 (#2): 조준선 상의 모든 적을 관통하는 두꺼운 빔
    if (inRange.length === 0) return;
    inRange.sort((a, b) => dist(center.x, center.y, a.x, a.y) - dist(center.x, center.y, b.x, b.y));
    const t = inRange[0];
    const angle = Math.atan2(t.y - center.y, t.x - center.x);
    const beamLen = stats.fullRange ? 2000 : stats.range * CELL;
    const ex = center.x + Math.cos(angle) * beamLen, ey = center.y + Math.sin(angle) * beamLen;
    spawnLaserBeam(center.x, center.y, ex, ey, '#2f8ab8');
    for (const m of state.monsters) {
      if (m.dying) continue;
      if (pointToSegmentDist(m.x, m.y, center.x, center.y, ex, ey) <= 24) dealDamage(m, stats.atk * dmgMult, true);
    }
  } else if (node.activeKind === 'freeze') {
    for (const m of inRange) { dealDamage(m, stats.atk * dmgMult, false); applySlow(m, 0.05, now + 2500); }
  } else if (node.activeKind === 'curse') {
    for (const m of inRange) { dealDamage(m, stats.atk * dmgMult, false); applyDebuffMult(m, 1.6, now + 3000); }
  }
}

function spawnHitParticles(x, y, color, count) {
  if (state.particles.length >= MAX_PARTICLES) return;
  for (let i = 0; i < count && state.particles.length < MAX_PARTICLES; i++) {
    const ang = Math.random() * Math.PI * 2;
    const spd = 40 + Math.random() * 90;
    // slight per-particle spawn stagger (negative t) + size/speed variance so a burst
    // arrives as a quick ripple instead of every particle popping in one synchronous frame
    state.particles.push({
      x, y, vx: Math.cos(ang) * spd, vy: Math.sin(ang) * spd,
      t: -Math.random() * 0.045, dur: 0.35 + Math.random() * 0.2, color, r: 1.6 + Math.random() * 3,
      rot: Math.random() * Math.PI * 2, vrot: (Math.random() * 2 - 1) * 6,
    });
  }
}

// angular/sharp particle burst for the hard-freeze proc, distinct from the default
// round soft burst — true faceted shard polygons (see draw()'s `shape:'shard'` branch),
// not just tight-spread circles, so a freeze reads as glass/ice breaking apart
function spawnIcyShatter(x, y) {
  if (state.particles.length >= MAX_PARTICLES) return;
  const count = 12;
  for (let i = 0; i < count && state.particles.length < MAX_PARTICLES; i++) {
    const ang = (Math.PI * 2 * i) / count + Math.random() * 0.3;
    const spd = 90 + Math.random() * 130;
    state.particles.push({
      x, y, vx: Math.cos(ang) * spd, vy: Math.sin(ang) * spd,
      t: -Math.random() * 0.03, dur: 0.24 + Math.random() * 0.16,
      color: Math.random() < 0.5 ? '#bfe3f5' : '#eaf7fc',
      r: 2 + Math.random() * 2.6, shape: 'shard',
      rot: ang, vrot: (Math.random() * 2 - 1) * 4, elong: 1.8 + Math.random() * 1.2,
    });
  }
}

// two small dots orbiting the monster's head while stunned — classic "stunned" cue,
// cheap to draw (no persistent state needed, computed live in draw() from stunUntil)
function spawnStunBurst(x, y) {
  spawnHitParticles(x, y, '#c9a227', 5);
}

// fast-expanding fast-fading shockwave ring for the atk_multi big-explosion proc
const MAX_RINGS = 24;
function spawnShockRing(x, y, maxR, color) {
  if (state.rings.length >= MAX_RINGS) return;
  state.rings.push({ x, y, r: 4, maxR, t: 0, dur: 0.32, color });
}

// jagged lightning polyline between two points: a straight line with a few small
// random perpendicular jitters along the path reads convincingly as a bolt on canvas
const MAX_BOLTS = 40;
function spawnBolt(x1, y1, x2, y2, color) {
  if (state.bolts.length >= MAX_BOLTS) return;
  const segs = 5;
  const pts = [{ x: x1, y: y1 }];
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len, ny = dx / len; // perpendicular unit vector
  for (let i = 1; i < segs; i++) {
    const t = i / segs;
    const jitter = (Math.random() * 2 - 1) * Math.min(14, len * 0.18);
    pts.push({ x: x1 + dx * t + nx * jitter, y: y1 + dy * t + ny * jitter });
  }
  pts.push({ x: x2, y: y2 });
  state.bolts.push({ pts, t: 0, dur: 0.16, color });
}

// 레전더리/미스틱 카드 전용 자동 스킬. 유닛의 서브타입 특성에 맞춰 서로 다른 효과를 낸다.
function triggerLegendarySkill(inst, def, stats, center) {
  const skill = LEGENDARY_SKILLS[def.subKey];
  if (!skill) return;
  const now = performance.now();
  const dmgMult = (skill.dmgMult || 0) * (1 + stats.skillDmgPct / 100);
  // same reasoning as the lab capstone skill: no toast/shake per activation, or a
  // field full of legendary units would spam a notification every few seconds
  spawnHitParticles(center.x, center.y, '#c1465f', 14);

  if (def.subKey === 'buff_support') {
    // 오라클 리워크 (#1): 전군 버프 대신 캐스터 주변 지역 버프 지대 + 보조 터렛
    const zoneR = 2.2 * CELL;
    spawnZone(center.x, center.y, zoneR, 'buff', 0, 0.5, 6, { atkPct: 35 + stats.skillDmgPct * 0.5, aspdPct: 28 + jobStep(inst) * 6 });
    spawnTurret(center.x, center.y, 2.5 * CELL, stats.atk * 0.5, 0.5, 5);
    spawnShockRing(center.x, center.y, zoneR, '#3c9c68');
    return;
  }
  if (def.subKey === 'heal_support') {
    const inRangeAllies = Object.values(state.placed).filter(a => a.hp != null && dist(center.x, center.y, a.center.x, a.center.y) <= stats.range * CELL);
    const healAmount = stats.atk * (skill.healMult || 2.5) * (1 + stats.skillDmgPct / 100);
    for (const a of inRangeAllies) {
      a.hp = Math.min(a.maxHp, a.hp + healAmount);
      spawnHitParticles(a.center.x, a.center.y, '#3c9c68', 8);
    }
    return;
  }
  if (def.subKey === 'tank_guard') {
    // 불굴의 방벽: 사거리 내 아군에게 강력한 임시 피해감소 보호막
    for (const a of Object.values(state.placed)) {
      if (dist(center.x, center.y, a.center.x, a.center.y) <= stats.range * CELL) {
        a.buffs = a.buffs || {};
        a.buffs.dmgReductionPct = Math.min(75, (a.buffs.dmgReductionPct || 0) + 30 + jobStep(inst) * 7);
      }
    }
    spawnShockRing(center.x, center.y, stats.range * CELL, '#7b8291');
    return;
  }
  if (def.subKey === 'atk_multi') {
    // 광란 (#2 frenzy): 순간 피해 대신 자신의 공격속도를 짧게 폭증시키는 자가 버프
    inst.frenzyUntil = now + 4000 + jobStep(inst) * 1300; // 전직 차수마다 광란 지속시간이 길어진다
    spawnHitParticles(center.x, center.y, '#c1465f', 16);
    return;
  }

  const inRange = state.monsters.filter(m => stats.fullRange || dist(center.x, center.y, m.x, m.y) <= stats.range * CELL);
  if (inRange.length === 0) return;

  if (def.subKey === 'atk_single' || def.subKey === 'ranged_single') {
    // single target burst (ranged hits a few in a line, single-target hits the nearest)
    inRange.sort((a, b) => dist(center.x, center.y, a.x, a.y) - dist(center.x, center.y, b.x, b.y));
    const hitCount = def.subKey === 'ranged_single' ? 3 + jobStep(inst) : 1; // 관통사격 대상 수가 차수마다 늘어난다
    for (const m of inRange.slice(0, hitCount)) {
      dealDamage(m, stats.atk * dmgMult, true);
      spawnHitParticles(m.x, m.y, '#c1465f', 8);
    }
  } else if (def.subKey === 'magic_multi') {
    for (const m of inRange) {
      dealDamage(m, stats.atk * dmgMult, true);
    }
  } else if (def.subKey === 'magic_ctrl') {
    for (const m of inRange) {
      dealDamage(m, stats.atk * dmgMult, true);
      applySlow(m, 0.05, now + 2500);
    }
  } else if (def.subKey === 'buff_debuff') {
    // 연쇄 저주 폭발 (#2 multi-burst): 짧은 시간 동안 여러 번의 보너스 공격을 몰아침 —
    // resolveHit을 그대로 재사용하므로 버프형-디버프의 저주(debuff) 효과도 매 타격마다 자연히 재적용됨
    inRange.sort((a, b) => dist(center.x, center.y, a.x, a.y) - dist(center.x, center.y, b.x, b.y));
    const burstCount = 5 + jobStep(inst); // 연쇄 저주 폭발 횟수가 차수마다 늘어난다
    for (let i = 0; i < burstCount; i++) {
      const targets = findTargetsFromPool(inRange, stats.targets || 1);
      if (targets.length === 0) break;
      for (const m of targets) resolveHit(m, inst, stats, center);
    }
  }
}

let combatTickId = 0;
function tickCombat(dt) {
  combatTickId++; // bumped once per tick so computeLabBonus() can safely cache per-subtype within this tick
  updateSupportBuffs();
  updateGuardAuras(); // tank_guard passive damage-reduction aura (#4)
  updateZoneBuffs(); // buff_support zone-buff rework (#1)
  const now = performance.now();
  for (const [key, inst] of Object.entries(state.placed)) {
    const def = defOf(inst);
    const stats = computeStats(inst);
    const center = inst.center; // cached at placement time — see placeUnitAt()

    // unit HP (#6) upkeep: lazily init (should already be set by ensureUnitHp() at
    // placement, this is just a safety net) and clamp down if maxHp shrank/hp overflowed
    if (inst.hp == null) inst.hp = stats.maxHp;
    inst.maxHp = stats.maxHp;
    if (inst.hp > inst.maxHp) inst.hp = inst.maxHp;

    if (!def.base.support) {
      inst.cooldown -= dt;
      const interval = 1 / Math.max(0.1, stats.aspd);
      // loop (capped) rather than a single if-check: at high game-speed multipliers a
      // single frame's dt can cover several of a fast unit's attack intervals, and only
      // ever allowing one attack per frame silently capped DPS well below what the
      // unit's stats promise. Capped at 30 to avoid a pathological catch-up spiral — in
      // practice this never binds at realistic aspd values (verified via stress test:
      // even at 10x speed with maxed-out attack speed investment, a frame's worth of
      // swings tops out well under 30), so it's a safety valve, not the active bottleneck.
      // What DOES scale with the multiplier is legitimate: more real attacks genuinely
      // happen per rendered frame, which is required to preserve the promised DPS at
      // fast-forward speeds — so the target-lookup itself is precomputed ONCE per unit per
      // tick (see findTargetsFromPool) instead of once per swing, since monster positions
      // are frozen for the rest of this tick regardless of how many swings resolve.
      let swings = 0;
      if (inst.cooldown <= 0) {
        const rangePool = state.monsters.filter(m => !m.dying && (stats.fullRange || dist(center.x, center.y, m.x, m.y) <= stats.range * CELL));
        if (stats.targets <= 1) rangePool.sort((a, b) => dist(center.x, center.y, a.x, a.y) - dist(center.x, center.y, b.x, b.y));
        while (inst.cooldown <= 0 && swings < 30) {
          const targets = findTargetsFromPool(rangePool, stats.targets);
          if (targets.length === 0) { inst.cooldown = 0; break; }
          inst.cooldown += interval;
          swings++;
          for (const m of targets) {
            resolveHit(m, inst, stats, center);
            // 추가 타격 (연구실): 확률로 한 번 더 공격. 원거리-단일(이중 사격)은 사거리와
            // 무관하게 맵 전역의 무작위 대상에게 번개가 튀는 것으로 대체됨
            if (stats.extraAtkChance > 0 && Math.random() * 100 < stats.extraAtkChance) {
              if (def.subKey === 'ranged_single') {
                // 이중 사격: 맞히는 무작위 대상의 "수"가 leafB(이중 사격) 투자 레벨에 따라
                // 1에서 시작해 서서히 늘어남 (최대치로 캡되어 맵 전체를 쓸어버리지 않도록)
                const leafBLvl = labNodeLevel('ranged_single', 'leafB');
                const targetCount = Math.min(4, 1 + Math.floor(leafBLvl / 3));
                const boltPool = state.monsters.filter(x => !x.dying && x !== m);
                for (let i = 0; i < boltPool.length && i < targetCount; i++) {
                  const pickIdx = Math.floor(Math.random() * boltPool.length);
                  const bolt = boltPool.splice(pickIdx, 1)[0];
                  resolveHitLightning(bolt, inst, stats, center);
                }
              } else {
                const others = findTargetsFromPool(rangePool, targets.length + 1).filter(x => x !== m);
                if (others.length > 0) resolveHit(others[0], inst, stats, center);
              }
            }
          }
        }
      }
    }

    // 레전더리/미스틱 등급 카드는 일정 주기마다 자동으로 특수 스킬을 발동 (지원형 포함)
    if (def.tierId === 'legendary' || def.tierId === 'mystic') {
      inst.skillCooldown -= dt;
      if (inst.skillCooldown <= 0) {
        inst.skillCooldown += SKILL_INTERVAL;
        triggerLegendarySkill(inst, def, stats, center);
      }
    }

    // 연구실 capstone 노드: 카드 등급과 무관하게, 해당 서브타입 트리를 끝까지 투자하면 열리는 전용 스킬
    const capstoneLvl = labNodeLevel(def.subKey, 'capstone');
    if (capstoneLvl > 0) {
      inst.labSkillCooldown = (inst.labSkillCooldown ?? LAB_ACTIVE_INTERVAL) - dt;
      if (inst.labSkillCooldown <= 0) {
        inst.labSkillCooldown += LAB_ACTIVE_INTERVAL;
        triggerLabActiveSkill(inst, def, stats, center, capstoneLvl);
      }
    }

    // 기공술사 (bs_artificer): 스킬에서만 나오던 보조 터렛을 상시로 뽑아낸다.
    // 지원형이라 기본공격 루프를 아예 타지 않는 유닛에게 "전직으로 공격 수단이 생기는"
    // 변화를 주는 지점 — spawnTurret은 MAX_TURRETS 캡을 자체적으로 지킨다.
    if (inst.jobBranch === 'bs_artificer' && (inst.jobTier || 1) > 1) {
      const step = inst.jobTier - 1;
      inst.jobCooldown -= dt;
      if (inst.jobCooldown <= 0) {
        inst.jobCooldown += Math.max(3.5, 11 - step * 2.2);
        const count = step >= 3 ? 2 : 1; // 강철 군단: 4차에서 2문 동시 전개
        for (let i = 0; i < count; i++) {
          const ox = (i === 0 ? 0 : (Math.random() * 2 - 1) * CELL * 0.6);
          const oy = (i === 0 ? 0 : (Math.random() * 2 - 1) * CELL * 0.6);
          spawnTurret(center.x + ox, center.y + oy, 2.5 * CELL, stats.atk * (0.45 + 0.25 * step), 0.5, 4 + step);
        }
        spawnHitParticles(center.x, center.y, '#7b8291', 6);
      }
    }

    // 불굴의 방벽 (tg_bulwark) 3차+: 방벽 충격파. 순수 수동형이던 갈래에 "필드에 개입하는"
    // 능동 한 겹을 더한다 — 주변 적을 밀어붙이듯 기절시켜 라인을 다시 세운다. 도발자와는
    // 축이 갈린다(도발자는 끌어모아 속박, 방벽은 제자리에서 끊는다). spawnShockRing/
    // spawnHitParticles만 재사용하므로 새 파티클 시스템은 없고, applyHardCC의 면역 창이
    // 잠금 중첩을 막는다.
    if (inst.jobBranch === 'tg_bulwark' && (inst.jobTier || 1) >= 3) {
      const step = inst.jobTier - 1;
      inst.jobCooldown -= dt;
      if (inst.jobCooldown <= 0) {
        inst.jobCooldown += Math.max(4, 9 - step);
        const pulseR = Math.max(buffAuraRange(inst), 2 * CELL);
        for (const m of state.monsters) {
          if (m.dying) continue;
          if (dist(center.x, center.y, m.x, m.y) > pulseR) continue;
          addXpContributor(m, inst.cellKey);
          dealDamage(m, stats.atk * (0.5 + 0.3 * step), false, false);
          applyHardCC(m, 'stun', 450 + 200 * step);
        }
        spawnShockRing(center.x, center.y, pulseR, '#6f88b5');
      }
    }

    // heal_support (#3): periodic heal tick, independent of its own (weak) attack cooldown.
    // unit deaths (from monster attacks/skills) only ever happen AFTER this per-unit loop
    // finishes (see tickMonsterAttacks/tickMonsterSkills below), so `inst` here is always
    // still alive/placed at this point in the tick.
    if (def.subKey === 'heal_support') {
      inst.healCooldown -= dt;
      if (inst.healCooldown <= 0) {
        const healInterval = 1.6 / Math.max(0.1, stats.aspd);
        inst.healCooldown += healInterval;
        doHealTick(inst, stats, center);
      }
    }
  }
  tickDots(dt);
  tickZones(dt);
  tickTurrets(dt);
  tickMonsterAttacks(dt); // monsters attacking units (#7)
  tickMonsterSkills(dt); // boss/mid-boss skill pool (#8)
  tickBombs(); // bomb-attach delayed detonation (#2)
  tickMeteors(dt); // meteor telegraph/impact (#2)
  // don't yank a killed monster out of existence on the exact frame it dies — mark it
  // "dying" and let the main loop fade/shrink it out over a short real-time window
  // (see the cosmetic-effects block in loop()), so kills read as an impact instead of
  // monsters just blinking out of the world mid-combat
  for (const m of state.monsters) {
    if (m.hp <= 0 && !m.dying) {
      m.dying = true;
      m.deathT = 0;
      onMonsterKilled(m);
    }
  }
}

function onMonsterKilled(m) {
  const burstColor = m.kind === 'boss' ? '#c1465f' : m.kind === 'mid' ? '#c17a41' : '#b8657a';
  spawnHitParticles(m.x, m.y, burstColor, m.kind === 'boss' ? 22 : m.kind === 'mid' ? 14 : 7);
  // gold now comes from killing monsters (not from clearing the wave) — every kill
  // gives a small wave-scaled base amount, with a much larger bonus on mid/boss kills
  state.gold += 1 + Math.floor(state.wave / 4);

  // ---- 경험치 분배 (1/n): 이 몬스터를 죽이는 데 관여한 모든 유닛에게 균등 분배 ----
  // 단독 처치면 기여자가 1명이므로 그대로 전부, 여럿이 때렸거나 그 중 누군가를
  // 버프/치유/보호막으로 도운 지원 유닛이 있으면 그 인원수만큼 나뉜다.
  const contribN = m.xpContribCount || 0;
  if (contribN > 0) {
    const share = (m.xpValue || 0) / contribN;
    for (let i = 0; i < contribN; i++) {
      const u = state.placed[m.xpContributors[i]];
      // 그 사이 팔렸거나 죽은 유닛은 몫을 못 받지만, 분모에서는 빠지지 않는다 —
      // "그 킬에 몇 명이 관여했는가"는 이미 확정된 사실이기 때문
      if (u) awardUnitXp(u, share);
    }
    m.xpContribCount = 0; // 사망 연출 중 중복 지급 방지
  }

  if (m.kind === 'mid') {
    state.gold += 8 + state.wave * 2;
    if (Math.random() < 0.35) { state.gems += 1; log('중간보스 처치! 특수재화 +1'); pulseStat(HUD.collGemStat); }
    shakeScreen(4);
  } else if (m.kind === 'boss') {
    state.bossAliveThisWave = Math.max(0, (state.bossAliveThisWave || 0) - 1); // one fewer boss still alive; wave clears once this hits 0
    state.gold += 25 + state.wave * 4;
    const g = 2 + Math.floor(Math.random() * 3);
    state.gems += g;
    log(`보스 처치! 특수재화 +${g}`);
    pulseStat(HUD.collGemStat);
    shakeScreen(8);
  }
}

function tickMonsters(dt) {
  const now = performance.now();
  for (const m of state.monsters) {
    if (m.dying) continue; // freeze in place while its death fade plays out
    if (now < m.stunUntil) continue; // stunned: fully immobilized, distinct from slow
    if (now < m.bindUntil) continue; // bound/rooted: also fully immobilized (see applyHardCC)
    const slow = now < m.slowUntil ? m.slowFactor : 1;
    const haste = now < m.hasteUntil ? (m.hasteMult || 1) : 1; // boss "rally" skill (#8)
    m.trackPos += m.speed * slow * haste * dt;
    const p = trackPoint(m.trackPos, m.lane);
    m.x = p.x; m.y = p.y;
  }
}

// ---------------- monster -> unit basic attacks (#7) ----------------
// only mid-bosses/bosses attack; each on its own cooldown, targeting the nearest placed
// unit within its (medium-or-higher) range. Visualized with a threatening-colored
// projectile so a player can see WHY a unit's hp is dropping.
// if this monster is currently taunted and the taunting unit is still alive AND within
// `range`, it MUST be the target — otherwise fall back to the normal nearest-in-range
// pick. Shared by both the basic-attack and skill target selection below.
function pickTauntedOrNearest(m, placedList, range) {
  if (m.tauntedBy && performance.now() < (m.tauntUntil || 0)) {
    const tInst = state.placed[m.tauntedBy];
    if (tInst && tInst.hp > 0 && dist(m.x, m.y, tInst.center.x, tInst.center.y) <= range) {
      return [m.tauntedBy, tInst];
    }
  }
  let best = null, bestD = Infinity;
  for (const [key, inst] of placedList) {
    if (inst.hp <= 0 || state.placed[key] !== inst) continue;
    const d = dist(m.x, m.y, inst.center.x, inst.center.y);
    if (d <= range && d < bestD) { bestD = d; best = [key, inst]; }
  }
  return best;
}

function tickMonsterAttacks(dt) {
  const placedList = Object.entries(state.placed);
  if (placedList.length === 0) return;
  for (const m of state.monsters) {
    if (m.dying) continue;
    if (m.kind !== 'mid' && m.kind !== 'boss') continue;
    m.atkCooldown -= dt;
    if (m.atkCooldown > 0) continue;
    const range = MONSTER_ATK_RANGE[m.kind];
    // placedList is a snapshot taken once for the whole tick; a unit killed by an
    // earlier monster's attack THIS SAME tick is still present in it, so
    // pickTauntedOrNearest() skips anything already dead/removed rather than
    // re-"killing" a phantom and stealing an attack that should've gone elsewhere
    const best = pickTauntedOrNearest(m, placedList, range);
    m.atkCooldown = MONSTER_ATK_INTERVAL[m.kind];
    if (!best) continue;
    const dmg = monsterAtkForWave(state.wave, m.kind);
    spawnProjectile(m.x, m.y, best[1].center.x, best[1].center.y, 0.22, m.kind === 'boss' ? '#7a1f38' : '#8a4a1f');
    damageUnit(best[0], best[1], dmg);
  }
}

// ---------------- boss/mid-boss skills (#8) ----------------
// separate cooldown from the basic attack above. No toast/shake on activation — same
// "particle burst only" convention already used for legendary/lab capstone skills, since
// several bosses/mid-bosses could otherwise spam a notification every few seconds.
function tickMonsterSkills(dt) {
  for (const m of state.monsters) {
    if (m.dying) continue;
    if (m.kind !== 'mid' && m.kind !== 'boss') continue;
    m.skillCooldown -= dt;
    if (m.skillCooldown > 0) continue;
    // 봉인(한파술사 4차): 쿨다운은 계속 흐르되 시전 자체가 잠긴다 — 봉인이 풀리는 순간
    // 바로 한 발 나가므로 "영구 봉쇄"가 아니라 "타이밍 지연"으로 작동한다
    if (performance.now() < (m.sealUntil || 0)) continue;
    const pool = m.kind === 'boss' ? BOSS_SKILLS : MID_SKILLS;
    const skill = pool[Math.floor(Math.random() * pool.length)];
    m.skillCooldown = m.kind === 'boss' ? (7 + Math.random() * 3) : (10 + Math.random() * 4);
    executeMonsterSkill(m, skill);
  }
}

function executeMonsterSkill(m, skill) {
  const now = performance.now();
  const baseRange = m.kind === 'boss' ? MONSTER_ATK_RANGE.boss : MONSTER_ATK_RANGE.mid;
  if (skill.kind === 'damage') {
    const range = baseRange * 1.15; // skills reach slightly further than the basic attack
    const best = pickTauntedOrNearest(m, Object.entries(state.placed), range);
    spawnHitParticles(m.x, m.y, m.kind === 'boss' ? '#7a1f38' : '#8a4a1f', 10);
    if (best) {
      const dmg = monsterAtkForWave(state.wave, m.kind) * skill.mult;
      spawnProjectile(m.x, m.y, best[1].center.x, best[1].center.y, 0.28, '#c1465f');
      damageUnit(best[0], best[1], dmg);
    }
  } else if (skill.kind === 'debuff') {
    spawnHitParticles(m.x, m.y, '#6b4a9c', 10);
    for (const [, inst] of Object.entries(state.placed)) {
      if (dist(m.x, m.y, inst.center.x, inst.center.y) <= baseRange) {
        applyUnitWeaken(inst, skill.atkMult, skill.aspdMult, now + skill.dur);
      }
    }
  } else if (skill.kind === 'buff') {
    spawnHitParticles(m.x, m.y, '#3c9c68', 10);
    for (const other of state.monsters) {
      if (other.dying || other === m) continue;
      if (dist(m.x, m.y, other.x, other.y) <= baseRange * 1.3) {
        applyMonsterHaste(other, skill.speedMult, now + skill.dur);
      }
    }
  }
}

// ---------------- bomb-attach (atk_single capstone, #2) ----------------
// attaches a delayed-detonation marker to a monster instead of an instant hit — tagged by
// the monster's unique `id` (never reused, unlike the pooled object itself) so a detonation
// scheduled against a monster that died/got recycled in the meantime harmlessly no-ops
// rather than hitting whatever unrelated monster now occupies that pooled object.
const MAX_BOMBS = 20;
function attachBomb(m, dmg, delayMs) {
  if (state.bombs.length >= MAX_BOMBS) return;
  state.bombs.push({ monsterId: m.id, x: m.x, y: m.y, dmg, detonateAt: performance.now() + delayMs });
  m.bombTagged = true;
}
function tickBombs() {
  if (state.bombs.length === 0) return;
  const now = performance.now();
  const remaining = [];
  for (const b of state.bombs) {
    if (now < b.detonateAt) { remaining.push(b); continue; }
    const target = state.monsters.find(x => x.id === b.monsterId && !x.dying);
    const x = target ? target.x : b.x, y = target ? target.y : b.y;
    if (target) target.bombTagged = false;
    spawnShockRing(x, y, 60, '#c1465f');
    spawnHitParticles(x, y, '#c1465f', 14);
    shakeScreen(3);
    for (const other of state.monsters) {
      if (other.dying) continue;
      if (dist(x, y, other.x, other.y) <= 60) dealDamage(other, b.dmg, false, false);
    }
  }
  state.bombs = remaining;
}

// ---------------- meteor: telegraphed delayed AoE (magic_multi capstone, #2) ----------------
const MAX_METEORS = 10;
function spawnMeteor(x, y, dmg, radius) {
  if (state.meteors.length >= MAX_METEORS) return;
  state.meteors.push({ x, y, dmg, radius, t: 0, delay: 1.2, impacted: false });
}
function tickMeteors(dt) {
  if (state.meteors.length === 0) return;
  for (const mt of state.meteors) {
    mt.t += dt;
    if (!mt.impacted && mt.t >= mt.delay) {
      mt.impacted = true;
      spawnShockRing(mt.x, mt.y, mt.radius, '#8266bd');
      spawnHitParticles(mt.x, mt.y, '#8266bd', 18);
      shakeScreen(4);
      for (const m of state.monsters) {
        if (m.dying) continue;
        if (dist(mt.x, mt.y, m.x, m.y) <= mt.radius) dealDamage(m, mt.dmg, false, false);
      }
    }
  }
  state.meteors = state.meteors.filter(mt => mt.t < mt.delay + 0.4);
}

// ---------------- laser: piercing beam along a line (ranged_single capstone, #2) ----------------
const MAX_LASERS = 20;
function spawnLaserBeam(x1, y1, x2, y2, color) {
  if (state.lasers.length >= MAX_LASERS) return;
  state.lasers.push({ x1, y1, x2, y2, t: 0, dur: 0.3, color });
}
// shortest distance from point (px,py) to the segment (x1,y1)-(x2,y2)
function pointToSegmentDist(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return dist(px, py, x1 + dx * t, y1 + dy * t);
}

// ---------------- main loop ----------------
let lastT = performance.now();
let snapshotAccum = 0;
let upgradeListAccum = 0;
// Fixed Time Step: at high speedMult, dt (= rawDt*speedMult) can be a fairly large
// chunk of simulated time in one go — tickMonsters/tickCombat then have to do that
// whole chunk of movement/combat resolution synchronously in a single frame, which is
// exactly the kind of spike that hurt on mobile Safari. Splitting it into several
// small FIXED_STEP-sized ticks (a standard fixed-timestep accumulator) spreads the
// same total amount of simulated work across more, individually-cheaper calls instead
// of one big one. combatAccum carries any leftover fractional step across frames so no
// simulated time is silently lost; MAX_SUBSTEPS_PER_FRAME caps the worst case (a slow
// frame) so catching up can never itself cascade into more slowness.
const FIXED_STEP = 1 / 60;
const MAX_SUBSTEPS_PER_FRAME = 8;
let combatAccum = 0;
function loop(now) {
  const rawDt = Math.min(0.05, (now - lastT) / 1000);
  lastT = now;

  // the whole per-frame body is wrapped in try/catch: requestAnimationFrame(loop) at
  // the bottom must ALWAYS fire, in ANY case, or a single uncaught exception anywhere
  // in a frame's update (a bad restored save, an edge case in the newer monster-attack/
  // boss-skill/zone code, anything) permanently kills the game loop with no visible
  // error on iOS Safari — exactly matching reports of the game just freezing mid-play,
  // freezing on the prep countdown, or the field going black after a reload. Catching
  // and logging here means a single bad frame gets skipped instead of the whole game
  // dying silently and forever.
  try {
    runFrame(rawDt);
  } catch (e) {
    // log the STACK, not just the error object: console formatting collapses the object
    // form to a one-line preview, which made a real recurring frame error effectively
    // undebuggable (you could see it happened, never where)
    console.error('[loop] frame error, skipping this frame:\n' + (e && e.stack ? e.stack : e));
  }
  requestAnimationFrame(loop);
}

function runFrame(rawDt) {
  if (state.screen === 'game') {
    const dt = rawDt * state.speedMult;

    // 'prep' is never actually entered anymore (beginPrep() now calls beginWave()
    // immediately — the 3s countdown was removed by request), so there's no per-frame
    // handling for it here; state.phase briefly passes through 'prep' as a transient
    // "not idle" marker in a couple of places but is overwritten before a frame ever
    // sees it. Left `isRunLocked()`'s 'prep' check alone since it's a harmless no-op
    // safety net, not dead code causing confusion the way this branch would be.
    if (state.phase === 'wave') {
      state.waveTimer -= dt;
      state.spawnTimer += dt;
      while (state.spawnQueue.length && state.spawnQueue[0].t <= state.spawnTimer) {
        const sp = state.spawnQueue.shift();
        spawnMonster(sp.kind);
      }
      // Fixed Time Step: simulate this frame's combat/movement in FIXED_STEP-sized
      // chunks instead of one big `dt` call — see the constants/comment above.
      combatAccum = Math.min(combatAccum + dt, FIXED_STEP * (MAX_SUBSTEPS_PER_FRAME + 2));
      let substeps = 0;
      while (combatAccum >= FIXED_STEP && substeps < MAX_SUBSTEPS_PER_FRAME) {
        tickMonsters(FIXED_STEP);
        tickCombat(FIXED_STEP);
        combatAccum -= FIXED_STEP;
        substeps++;
      }
      // dying monsters linger briefly for their death-fade animation (see below), so
      // they must NOT count toward the swarm cap — otherwise the very kill that should
      // have saved the player could still trigger a false game-over for ~0.28s
      const aliveCount = state.monsters.reduce((n, m) => n + (m.dying ? 0 : 1), 0);
      if (aliveCount >= MONSTER_SWARM_CAP) {
        gameOver(`필드에 몬스터가 ${MONSTER_SWARM_CAP}마리 이상 쌓였습니다`);
      } else if (state.waveTimer <= 0) {
        endWave();
      }
    }

    // purely cosmetic effects run on real time (rawDt), not the speed-multiplied dt,
    // so hit sparks/damage numbers stay readable instead of flashing by at 10x speed
    { // release expired projectiles back into the pool instead of letting the GC collect them
      const survivingProjectiles = [];
      for (const p of state.projectiles) {
        p.t += rawDt;
        if (p.t < p.dur) survivingProjectiles.push(p);
        else if (projectilePool.length < 60) projectilePool.push(p);
      }
      state.projectiles = survivingProjectiles;
    }
    state.rings = state.rings.filter(rg => { rg.t += rawDt; return rg.t < rg.dur; });
    state.bolts = state.bolts.filter(b => { b.t += rawDt; return b.t < b.dur; });
    state.lasers = state.lasers.filter(lz => { lz.t += rawDt; return lz.t < lz.dur; });
    for (const pt of state.particles) { pt.x += pt.vx * rawDt; pt.y += pt.vy * rawDt; pt.vx *= 0.92; pt.vy *= 0.92; pt.t += rawDt; }
    state.particles = state.particles.filter(pt => pt.t < pt.dur);
    for (const ft of state.floatingTexts) { ft.y -= 24 * rawDt; ft.t += rawDt; }
    state.floatingTexts = state.floatingTexts.filter(ft => ft.t < ft.dur);
    if (shakeTime > 0) shakeTime = Math.max(0, shakeTime - rawDt);
    // dying monsters fade/shrink out over real time (not speed-multiplied) so kills
    // read the same at 1x and 10x speed instead of vanishing instantly at high speed
    const DEATH_FADE_DUR = 0.28;
    for (const m of state.monsters) { if (m.dying) m.deathT += rawDt; }
    // release fully-faded monsters back into the pool instead of just dropping them
    // for the GC — see spawnMonster()'s pooling comment
    const survivingMonsters = [];
    for (const m of state.monsters) {
      if (!m.dying || m.deathT < DEATH_FADE_DUR) survivingMonsters.push(m);
      else if (monsterPool.length < 80) monsterPool.push(m);
    }
    state.monsters = survivingMonsters;

    updateHud();
    draw();

    // keep the resumable run-snapshot fresh during live combat too, not just on
    // click-triggered render() calls — gold/monster kills change constantly mid-wave
    snapshotAccum += rawDt;
    if (snapshotAccum >= 3) { snapshotAccum = 0; saveRunSnapshot(); }

    // keep the 유닛 강화 buttons' disabled state honest as gold changes passively
    // mid-wave — updateUpgradeListState() only touches attributes on already-existing
    // button nodes (see its own comment for why NOT calling renderUpgradeList() here
    // matters), so this is safe to run this often
    upgradeListAccum += rawDt;
    if (upgradeListAccum >= 0.25) { upgradeListAccum = 0; updateUpgradeListState(); }
  }
}

// ---------------- rendering (canvas) ----------------
const gradePillWidthCache = {};

// the base field background — outer track, grid lines, cell borders — never changes
// frame to frame (only the per-cell "occupied" tint does), yet draw() was redrawing
// ~39 individual stroke/rect calls for it 60 times a second. Isolated stress-testing
// showed canvas draw-call overhead (not particle/monster/unit count) was the actual
// dominant source of remaining frame-time spikes even with the field otherwise empty,
// so this static portion is now pre-rendered once to an offscreen canvas and just
// blitted with a single drawImage() every frame instead.
const bgCanvas = document.createElement('canvas');
bgCanvas.width = canvas.width;
bgCanvas.height = canvas.height;
(function renderStaticBackground() {
  const bctx = bgCanvas.getContext('2d');
  bctx.fillStyle = '#fbfbfd';
  bctx.fillRect(0, 0, bgCanvas.width, bgCanvas.height);
  bctx.lineWidth = TRACK_GAP * 1.5;
  bctx.strokeStyle = '#eef1fa';
  bctx.beginPath();
  bctx.rect(TRACK_CORNERS[0].x, TRACK_CORNERS[0].y, TRACK_CORNERS[2].x - TRACK_CORNERS[0].x, TRACK_CORNERS[2].y - TRACK_CORNERS[0].y);
  bctx.stroke();
  bctx.lineWidth = 1.5;
  bctx.setLineDash([5, 5]);
  bctx.strokeStyle = 'rgba(74,114,214,0.3)';
  bctx.stroke();
  bctx.setLineDash([]);
  for (let i = 0; i <= GRID; i++) {
    bctx.strokeStyle = '#e2e4ea';
    bctx.lineWidth = 1;
    bctx.beginPath(); bctx.moveTo(MARGIN + i * CELL, MARGIN); bctx.lineTo(MARGIN + i * CELL, MARGIN + GRID * CELL); bctx.stroke();
    bctx.beginPath(); bctx.moveTo(MARGIN, MARGIN + i * CELL); bctx.lineTo(MARGIN + GRID * CELL, MARGIN + i * CELL); bctx.stroke();
  }
  for (const p of INTERIOR) {
    bctx.strokeStyle = '#dfe2ea';
    bctx.lineWidth = 1;
    bctx.strokeRect(MARGIN + p.c * CELL + 2, MARGIN + p.r * CELL + 2, CELL - 4, CELL - 4);
  }
})();

function roundRectPath(ctx2, x, y, w, h, radius) {
  ctx2.beginPath();
  ctx2.moveTo(x + radius, y);
  ctx2.arcTo(x + w, y, x + w, y + h, radius);
  ctx2.arcTo(x + w, y + h, x, y + h, radius);
  ctx2.arcTo(x, y + h, x, y, radius);
  ctx2.arcTo(x, y, x + w, y, radius);
  ctx2.closePath();
}

function draw() {
  ctx.save();
  if (shakeTime > 0) {
    const m = shakeMag * (shakeTime / 0.35);
    ctx.translate((Math.random() * 2 - 1) * m, (Math.random() * 2 - 1) * m);
  }
  ctx.clearRect(-20, -20, canvas.width + 40, canvas.height + 40);
  // static background (track/grid/cell borders) — pre-rendered once, see bgCanvas above
  ctx.drawImage(bgCanvas, 0, 0);

  // only the per-cell "occupied" tint is dynamic; the border under it is already baked
  // into bgCanvas, so this only needs a fill, not a fill+stroke, and only for occupied
  // cells (rather than looping and re-filling all 25 every frame)
  for (const key of Object.keys(state.placed)) {
    const [pc, pr] = key.split(',').map(Number);
    ctx.fillStyle = '#eaf0ff';
    ctx.fillRect(MARGIN + pc * CELL + 2, MARGIN + pr * CELL + 2, CELL - 4, CELL - 4);
  }

  // lingering zone effects (fire/plague), drawn under units/monsters
  for (const z of state.zones) {
    // oracle-style buff zones no longer show a range/boundary animation at all (by
    // request) — the buff itself still applies normally (see updateZoneBuffs), it's
    // just invisible on the field instead of drawing a circle where its radius is
    if (z.kind === 'buff') continue;
    const nowZ = performance.now();
    const pulse = 0.16 + Math.sin(nowZ / 300 + z.x) * 0.05;
    // radial gradient (hot core fading to edge) instead of a flat translucent disc —
    // reads much richer than a single solid fill, still one fillRect-cost draw call
    const ZONE_COLORS = { fire: '193,122,65', plague: '138,122,156', buff: '60,150,90', tornado: '140,140,150' };
    const zCol = ZONE_COLORS[z.kind] || ZONE_COLORS.plague;
    const grad = ctx.createRadialGradient(z.x, z.y, 0, z.x, z.y, z.r);
    grad.addColorStop(0, `rgba(${zCol},${pulse * 1.8})`);
    grad.addColorStop(0.6, `rgba(${zCol},${pulse})`);
    grad.addColorStop(1, `rgba(${zCol},0)`);
    ctx.beginPath();
    ctx.arc(z.x, z.y, z.r, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();
    if (z.kind === 'fire') {
      // "alive" pulsing radius on the edge stroke
      const edgeR = z.r + Math.sin(nowZ / 180 + z.x) * 3;
      ctx.beginPath();
      ctx.arc(z.x, z.y, edgeR, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(193,122,65,0.45)';
      ctx.lineWidth = 1.8;
      ctx.stroke();
    } else if (z.kind === 'tornado') {
      // fast-spinning pinwheel spokes instead of a static/dashed edge — the one zone
      // type that itself travels, so its edge should visibly "spin in place" too
      ctx.save();
      ctx.translate(z.x, z.y);
      ctx.rotate(nowZ / 140);
      ctx.strokeStyle = `rgba(${zCol},0.55)`;
      ctx.lineWidth = 2;
      for (let i = 0; i < 3; i++) {
        const a = (Math.PI * 2 / 3) * i;
        ctx.beginPath();
        ctx.arc(0, 0, z.r, a, a + 0.9);
        ctx.stroke();
      }
      ctx.restore();
    } else {
      // slow dash-rotation edge (plague): distinct from fire's pulsing and the other two above
      ctx.save();
      ctx.setLineDash([4, 5]);
      ctx.lineDashOffset = -(nowZ / 40) % 100;
      ctx.beginPath();
      ctx.arc(z.x, z.y, z.r, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(${zCol},0.5)`;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.restore();
    }
  }

  // meteor telegraphs (magic_multi capstone, #2): a growing/pulsing warning ring at the
  // impact point BEFORE it lands, so the strike reads as genuinely delayed/telegraphed
  for (const mt of state.meteors) {
    if (mt.impacted) continue;
    const p = Math.min(1, mt.t / mt.delay);
    ctx.beginPath();
    ctx.arc(mt.x, mt.y, mt.radius * (0.5 + p * 0.5), 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(130,102,189,${0.3 + p * 0.5})`;
    ctx.lineWidth = 2 + p * 2;
    ctx.stroke();
    ctx.fillStyle = `rgba(130,102,189,${0.06 + p * 0.1})`;
    ctx.fill();
  }

  // laser beams (ranged_single capstone, #2): a thick fading beam, distinct from the
  // thin jagged lightning bolt used elsewhere
  for (const lz of state.lasers) {
    const a = Math.max(0, 1 - lz.t / lz.dur);
    ctx.beginPath();
    ctx.moveTo(lz.x1, lz.y1); ctx.lineTo(lz.x2, lz.y2);
    ctx.strokeStyle = hexToRgba(lz.color, a * 0.35);
    ctx.lineWidth = 14 * a + 2;
    ctx.lineCap = 'round';
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(lz.x1, lz.y1); ctx.lineTo(lz.x2, lz.y2);
    ctx.strokeStyle = hexToRgba('#ffffff', a * 0.85);
    ctx.lineWidth = 3 * a + 0.6;
    ctx.stroke();
    ctx.lineCap = 'butt';
  }

  // buff_support deployable turrets — quick scale-punch on fire, mirroring the same
  // attack-recoil technique used for placed units elsewhere in this function
  for (const t of state.turrets) {
    const sinceFire = performance.now() - (t.fireFlash || -9999);
    const fireScale = sinceFire < 130 ? 1 + 0.22 * (1 - sinceFire / 130) : 1;
    ctx.save();
    if (fireScale !== 1) { ctx.translate(t.x, t.y); ctx.scale(fireScale, fireScale); ctx.translate(-t.x, -t.y); }
    ctx.beginPath();
    ctx.arc(t.x, t.y, 11, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.strokeStyle = '#379966';
    ctx.lineWidth = 2;
    ctx.stroke();
    drawGlyph(ctx, 'turret', t.x, t.y, 6, '#379966');
    ctx.restore();
  }

  // selected unit range indicator
  if (state.selected) {
    let inst = null, center = null;
    if (state.selected.kind === 'field') {
      inst = state.placed[state.selected.key];
      const [c, r] = state.selected.key.split(',').map(Number);
      center = cellCenter(c, r);
    } else if (state.selected.kind === 'bench') {
      inst = state.bench[state.selected.idx];
    }
    if (inst && center) {
      const stats = computeStats(inst);
      // quick fade-in rather than popping in at full opacity the instant something's selected
      const fadeIn = Math.min(1, (performance.now() - (state.selectedAt || 0)) / 150);
      ctx.save();
      ctx.globalAlpha = fadeIn;
      ctx.fillStyle = 'rgba(58,110,255,0.08)';
      ctx.strokeStyle = 'rgba(58,110,255,0.55)';
      ctx.lineWidth = 2;
      if (stats.fullRange) {
        // covers the whole canvas, not just the grid: full-range units also hit monsters on the outer track
        ctx.fillRect(4, 4, canvas.width - 8, canvas.height - 8);
        ctx.strokeRect(4, 4, canvas.width - 8, canvas.height - 8);
      } else {
        ctx.beginPath();
        ctx.arc(center.x, center.y, stats.range * CELL, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      ctx.lineWidth = 1;
      ctx.restore();
    }
    // highlight interior cells as placement targets when a bench unit selected
    if (state.selected.kind === 'bench') {
      for (const p of INTERIOR) {
        ctx.strokeStyle = 'rgba(58,110,255,0.55)';
        ctx.lineWidth = 2;
        ctx.strokeRect(MARGIN + p.c * CELL + 4, MARGIN + p.r * CELL + 4, CELL - 8, CELL - 8);
        ctx.lineWidth = 1;
      }
    }
  }

  // placed units
  const BADGE_R = 17; // unit icon circle radius, kept well clear of the CELL slot
  for (const [key, inst] of Object.entries(state.placed)) {
    const { x, y } = inst.center; // cached at placement time — see placeUnitAt()
    const def = defOf(inst);
    const grade = gradeOf(inst);

    // freshly-placed units pop in with a quick ease-out scale instead of just appearing,
    // and every attack gives a quick recoil scale-punch — small per-unit motion that
    // makes the field read as "alive" instead of static badges that only ever move
    // when repositioned
    const nowDraw = performance.now();
    const age = nowDraw - (inst.placedAt || 0);
    const popScale = age < 220 ? 0.4 + 0.6 * (1 - Math.pow(1 - Math.min(1, age / 220), 3)) : 1;
    const sinceAtk = nowDraw - (inst.atkFlash || -9999);
    const atkScale = sinceAtk < 110 ? 1 + 0.16 * (1 - sinceAtk / 110) : 1;
    const unitScale = popScale * atkScale;
    if (unitScale !== 1) {
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(unitScale, unitScale);
      ctx.translate(-x, -y);
    }

    // buffed indicator: a soft pulsing ring around the whole unit (same pulse language
    // as boss/mid monsters elsewhere in this file) instead of a small static badge icon —
    // reads as "something is actively happening to this unit" at a glance on the field
    const isBuffedNow = !!inst.buffs || (inst.frenzyUntil && performance.now() < inst.frenzyUntil);
    if (isBuffedNow) {
      const pulse = 3 + Math.sin(performance.now() / 220) * 2.5;
      ctx.beginPath();
      ctx.arc(x, y, BADGE_R + 6 + pulse, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(55,153,102,0.45)';
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }

    // tank_guard (#4): a standing translucent shield-aura ring, always visible on the
    // tanker itself (not just when generically "buffed") so its passive damage-reduction
    // aura reads as radiating FROM this unit, rather than looking identical to any other
    // buffed ally's shared green pulse ring above. Slow, steady breathing motion —
    // deliberately calmer than the buff pulse so it reads as "sturdy" not "excited".
    if (def.base.guard) {
      const breathe = 2 + Math.sin(performance.now() / 500) * 1.2;
      ctx.beginPath();
      ctx.arc(x, y, BADGE_R + 10 + breathe, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(74,114,214,0.28)';
      ctx.lineWidth = 1.6;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x, y, BADGE_R + 10 + breathe, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(74,114,214,0.05)';
      ctx.fill();
    }

    ctx.beginPath();
    ctx.arc(x, y + 2, BADGE_R + 1, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(20,25,40,0.10)';
    ctx.fill();

    ctx.beginPath();
    ctx.arc(x, y, BADGE_R, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = grade.color;
    ctx.stroke();
    drawGlyph(ctx, def.icon, x, y - 1, 8, '#2d3140');

    // unit HP bar (#6): thin bar ABOVE the badge, deliberately distinct from monster hp
    // bars (which sit above monster heads and go green->gold->red) — this one stays a
    // steady blue/violet track so a glance never confuses "my unit" with "an enemy"
    if (inst.maxHp) {
      const hpW = BADGE_R * 1.7;
      const hpPct = Math.max(0, inst.hp / inst.maxHp);
      const hpY = y - BADGE_R - 9;
      ctx.fillStyle = 'rgba(0,0,0,0.15)';
      ctx.fillRect(x - hpW / 2, hpY, hpW, 4);
      ctx.fillStyle = hpPct > 0.5 ? '#4a72d6' : hpPct > 0.2 ? '#8266bd' : '#c1465f';
      ctx.fillRect(x - hpW / 2, hpY, hpW * hpPct, 4);
    }

    // grade pill, fully clear of the circle below it (previously overlapped the icon)
    const pillY = y + BADGE_R + 10;
    ctx.font = '800 9px sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    // only 8 possible grade strings ever appear here, so cache their measured width
    // instead of re-running ctx.measureText for every placed unit on every frame
    if (!(inst.grade in gradePillWidthCache)) gradePillWidthCache[inst.grade] = ctx.measureText(inst.grade).width + 12;
    const pillW = gradePillWidthCache[inst.grade];
    roundRectPath(ctx, x - pillW / 2, pillY - 7, pillW, 14, 7);
    ctx.fillStyle = grade.color;
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.fillText(inst.grade, x, pillY + 0.5);

    // 유닛 레벨 배지 + 경험치 게이지 (좌상단) — 카드 강화(+N, 우상단)와 색·위치를 분리해
    // 두 개의 완전히 다른 성장 축이라는 게 한눈에 읽히게 한다. 전직한 유닛은 금색으로
    // 바뀌고 차수(II/III/IV)가 함께 표시된다.
    {
      const uLevel = inst.level || 1;
      const uTier = inst.jobTier || 1;
      const bx = x - BADGE_R * 0.78, by = y - BADGE_R * 0.78;
      ctx.beginPath();
      ctx.arc(bx, by, uTier > 1 ? 9 : 8, 0, Math.PI * 2);
      ctx.fillStyle = uTier >= 4 ? '#c1465f' : uTier === 3 ? '#9660bd' : uTier === 2 ? '#c1863a' : '#2d3140';
      ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.font = '800 8px sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillStyle = '#fff';
      ctx.fillText(String(uLevel), bx, by + 0.5);
    }

    if (state.selected && state.selected.kind === 'field' && state.selected.key === key) {
      ctx.strokeStyle = '#111827'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, BADGE_R + 5, 0, Math.PI * 2); ctx.stroke();
    }
    if (unitScale !== 1) ctx.restore();
  }

  // shockwave rings (atk_multi big explosion): fast-expanding, fast-fading stroke circle
  for (const rg of state.rings) {
    const lt = rg.t / rg.dur;
    const ease = 1 - Math.pow(1 - lt, 2);
    const r = rg.r + (rg.maxR - rg.r) * ease;
    const a = Math.max(0, 1 - ease);
    // faint soft outer band + a crisp bright leading edge, instead of one flat stroke
    ctx.beginPath();
    ctx.arc(rg.x, rg.y, r, 0, Math.PI * 2);
    ctx.strokeStyle = hexToRgba(rg.color, a * 0.3);
    ctx.lineWidth = 9 * a + 1;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(rg.x, rg.y, r, 0, Math.PI * 2);
    ctx.strokeStyle = hexToRgba(rg.color, a);
    ctx.lineWidth = 2 * a + 0.6;
    ctx.stroke();
  }

  // jagged lightning bolts (ranged_single chain): a soft wide glow pass underneath
  // a crisp bright core, easing out on width+alpha — cheap "afterimage" look for a
  // fast-fading effect without an actual second trailing draw
  for (const b of state.bolts) {
    const lt = b.t / b.dur;
    const ease = 1 - Math.pow(1 - lt, 2);
    const a = Math.max(0, 1 - ease);
    ctx.beginPath();
    b.pts.forEach((p, i) => { if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y); });
    ctx.lineJoin = 'round';
    ctx.strokeStyle = hexToRgba(b.color, a * 0.35);
    ctx.lineWidth = 6 * (1 - ease * 0.7);
    ctx.stroke();
    ctx.strokeStyle = hexToRgba('#ffffff', a * 0.9);
    ctx.lineWidth = 1.4 * (1 - ease * 0.5);
    ctx.stroke();
  }

  // projectiles: eased (ease-out) rather than linear travel, for a snappier arrival
  for (const p of state.projectiles) {
    const lt = p.t / p.dur;
    const t = 1 - Math.pow(1 - lt, 2);
    const x = p.x1 + (p.x2 - p.x1) * t;
    const y = p.y1 + (p.y2 - p.y1) * t;
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fillStyle = p.color;
    ctx.fill();
  }

  // monsters
  const nowDrawMonsters = performance.now();
  for (const m of state.monsters) {
    const radius = m.kind === 'boss' ? 22 : m.kind === 'mid' ? 16 : 10;
    // dying monsters shrink + fade out over DEATH_FADE_DUR (set in loop()) instead of
    // just vanishing on the frame their hp crosses 0 — reads as an actual kill, and
    // still holds up at high game-speed multipliers since it runs on real time
    const dyingT = m.dying ? Math.min(1, (m.deathT || 0) / 0.28) : 0;
    // eased (quadratic in) shrink+fade: starts slow (still reads as "just died") then
    // accelerates away, instead of a constant-speed linear shrink — a small change but
    // it reads less like a UI element sliding out and more like an actual death impact
    const dyingEase = dyingT * dyingT;
    const deathScale = 1 - dyingEase * 0.7;
    const deathAlpha = 1 - dyingEase;
    // a tiny idle bob so the field doesn't look like static tokens sitting on rails —
    // per-monster phase offset (via id) keeps them from all bobbing in lockstep
    const bob = m.dying ? 0 : Math.sin(nowDrawMonsters / 260 + m.id) * 1.3;
    ctx.save();
    ctx.globalAlpha = deathAlpha;
    if (deathScale !== 1) {
      ctx.translate(m.x, m.y + bob);
      ctx.scale(deathScale, deathScale);
      ctx.translate(-m.x, -(m.y + bob));
    }
    const my = m.y + bob;
    if ((m.kind === 'boss' || m.kind === 'mid') && !m.dying) {
      const pulse = 3 + Math.sin(nowDrawMonsters / 180) * 2;
      ctx.beginPath();
      ctx.arc(m.x, my, radius + pulse, 0, Math.PI * 2);
      ctx.strokeStyle = m.kind === 'boss' ? 'rgba(193,70,95,0.4)' : 'rgba(193,122,65,0.4)';
      ctx.lineWidth = 3;
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(m.x, my, radius, 0, Math.PI * 2);
    ctx.fillStyle = m.kind === 'boss' ? '#c1465f' : m.kind === 'mid' ? '#c17a41' : '#b8657a';
    ctx.fill();
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2; ctx.stroke();

    // hard-frozen: translucent pale-blue overlay so "this one is frozen" reads at a
    // glance without checking the tiny status badge
    const isFrozen = !m.dying && nowDrawMonsters < m.slowUntil && m.slowFactor <= 0.06;
    if (isFrozen) {
      ctx.beginPath();
      ctx.arc(m.x, my, radius, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(191,227,245,0.55)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(120,190,225,0.85)'; ctx.lineWidth = 1.5; ctx.stroke();
    }
    // 속박: 발밑을 감는 사슬 링 — 결빙(몸 전체 하늘색 오버레이)과도, 기절(머리 위 점)과도
    // 겹치지 않는 위치/모양이라 셋이 동시에 걸려도 서로 가리지 않는다
    if (!m.dying && nowDrawMonsters < m.bindUntil) {
      ctx.beginPath();
      ctx.ellipse(m.x, my + radius * 0.7, radius * 1.05, radius * 0.42, 0, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(63,95,191,0.9)'; ctx.lineWidth = 2.2;
      ctx.setLineDash([4, 3]); ctx.stroke(); ctx.setLineDash([]);
    }
    // stunned: a couple of small dots orbiting the head — classic "stunned" cue
    if (!m.dying && nowDrawMonsters < m.stunUntil) {
      const orbitR = radius + 7;
      for (let oi = 0; oi < 2; oi++) {
        const a = nowDrawMonsters / 160 + oi * Math.PI;
        const ox = m.x + Math.cos(a) * orbitR;
        const oy = my - radius - 4 + Math.sin(a) * (orbitR * 0.35);
        ctx.beginPath();
        ctx.arc(ox, oy, 2.2, 0, Math.PI * 2);
        ctx.fillStyle = '#c9a227';
        ctx.fill();
      }
    }
    // hp bar
    const w = radius * 2.2;
    const pct = Math.max(0, m.hp / m.maxHp);
    ctx.fillStyle = 'rgba(0,0,0,0.15)';
    ctx.fillRect(m.x - w / 2, my - radius - 9, w, 5);
    ctx.fillStyle = pct > 0.5 ? '#2fa85a' : pct > 0.2 ? '#bd9530' : '#c1465f';
    ctx.fillRect(m.x - w / 2, my - radius - 9, w * pct, 5);

    // active status icons (slow/debuff currently applied to this monster)
    const nowTs = nowDrawMonsters;
    const activeIcons = [];
    if (!m.dying && nowTs < m.slowUntil) activeIcons.push({ name: 'frost', color: '#3f5fbf', stacks: m.frostStacks || 0 });
    if (!m.dying && nowTs < m.debuffUntil) activeIcons.push({ name: 'debuff', color: '#c1465f' });
    if (!m.dying && m.dots && m.dots.length > 0) activeIcons.push({ name: 'sparkle', color: '#c17a41' });
    if (!m.dying && nowTs < m.stunUntil) activeIcons.push({ name: 'stun', color: '#c9a227' });
    if (!m.dying && nowTs < m.bindUntil) activeIcons.push({ name: 'lock', color: '#3f5fbf' }); // 속박
    if (!m.dying && nowTs < m.sealUntil) activeIcons.push({ name: 'x', color: '#6b4a9c' }); // 봉인(스킬 잠김)
    if (!m.dying && m.bombTagged) activeIcons.push({ name: 'skull', color: '#c1465f' }); // bomb-attach marker (#2)
    activeIcons.forEach((icon, i) => {
      const bx = m.x - radius - 2 + i * 13;
      const by = my + radius + 8;
      ctx.beginPath(); ctx.arc(bx, by, 6.5, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff'; ctx.fill();
      ctx.strokeStyle = icon.color; ctx.lineWidth = 1.3; ctx.stroke();
      drawGlyph(ctx, icon.name, bx, by, 4.5, icon.color);
      // frost stack count: the user's favorite mechanic, so make the stack progress
      // toward the 3-stack freeze clearly legible right on the badge
      if (icon.stacks > 0) {
        ctx.font = '800 7px sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillStyle = '#ffffff';
        ctx.beginPath(); ctx.arc(bx + 5, by - 5, 4.2, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = icon.color; ctx.lineWidth = 1; ctx.stroke();
        ctx.fillStyle = icon.color;
        ctx.fillText(String(icon.stacks), bx + 5, by - 4.5);
      }
    });
    ctx.restore();
  }

  // hit particles: circles (default, soft radial-gradient glow) or angular shards
  // (ice-shatter proc) — real polygon shapes instead of every effect reusing the
  // same round dot, per-particle rotation for shards so they read as tumbling glass
  for (const pt of state.particles) {
    const life = Math.max(0, 1 - Math.max(0, pt.t) / pt.dur);
    if (life <= 0) continue;
    const alpha = life;
    if (pt.shape === 'shard') {
      const rot = pt.rot + (pt.vrot || 0) * Math.max(0, pt.t);
      const len = pt.r * (pt.elong || 1.8) * life;
      const wid = pt.r * 0.6 * life;
      ctx.save();
      ctx.translate(pt.x, pt.y);
      ctx.rotate(rot);
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      ctx.moveTo(len, 0);
      ctx.lineTo(-len * 0.35, wid);
      ctx.lineTo(-len * 0.35, -wid);
      ctx.closePath();
      ctx.fillStyle = pt.color;
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.6)';
      ctx.lineWidth = 0.6;
      ctx.stroke();
      ctx.restore();
    } else {
      // flat fill + globalAlpha, not a per-particle radial gradient: with up to
      // MAX_PARTICLES(240) of these possibly alive at once every single frame,
      // ctx.createRadialGradient()+addColorStop() per particle turned out to be a
      // real input-lag source during heavy combat (each one allocates a gradient
      // object and does extra rasterization work) — this reads almost identically
      // at this particle size but is dramatically cheaper
      const r = pt.r * life;
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2);
      ctx.fillStyle = pt.color;
      ctx.globalAlpha = alpha;
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }
  ctx.globalAlpha = 1;

  // floating damage numbers
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const ft of state.floatingTexts) {
    const life = Math.max(0, 1 - ft.t / ft.dur);
    const riseT = Math.min(1, ft.t / ft.dur);
    const rise = (ft.crit ? 30 : 20) * (1 - Math.pow(1 - riseT, 2)); // ease-out: quick then settles, instead of a constant-speed drift
    const pop = ft.crit ? 1 + 0.5 * Math.max(0, 1 - ft.t / 0.12) : 1;
    ctx.save();
    ctx.translate(ft.x, ft.y - rise);
    ctx.scale(pop, pop);
    ctx.globalAlpha = life;
    if (ft.execute) {
      // distinctive instant-kill callout, visually separate from a normal/crit number
      // so an execute reads as its own feel-good moment
      ctx.font = '900 21px sans-serif';
      ctx.lineWidth = 4; ctx.strokeStyle = '#ffffff'; ctx.lineJoin = 'round';
      ctx.strokeText(ft.value, 0, 0);
      ctx.fillStyle = '#7b2f6b';
      ctx.fillText(ft.value, 0, 0);
    } else if (ft.jobUp) {
      // 전직 콜아웃 — 런당 유닛별 최대 3번뿐인 이벤트라 가장 크고 눈에 띄게
      ctx.font = '900 15px sans-serif';
      ctx.lineWidth = 4; ctx.strokeStyle = '#ffffff'; ctx.lineJoin = 'round';
      ctx.strokeText(ft.value, 0, 0);
      ctx.fillStyle = '#c1863a';
      ctx.fillText(ft.value, 0, 0);
    } else if (ft.levelUp) {
      ctx.font = '900 13px sans-serif';
      ctx.lineWidth = 3; ctx.strokeStyle = '#ffffff'; ctx.lineJoin = 'round';
      ctx.strokeText(ft.value, 0, 0);
      ctx.fillStyle = '#3c9c68';
      ctx.fillText(ft.value, 0, 0);
    } else if (ft.crit) {
      ctx.font = '800 10px sans-serif';
      ctx.fillStyle = '#c1465f';
      ctx.fillText('CRITICAL', 0, -14);
      ctx.font = '900 19px sans-serif';
      ctx.lineWidth = 3.5; ctx.strokeStyle = '#ffffff'; ctx.lineJoin = 'round';
      ctx.strokeText(String(ft.value), 0, 0);
      ctx.fillStyle = '#c1465f';
      ctx.fillText(String(ft.value), 0, 0);
    } else if (ft.heal) {
      // heal_support ticks: green "+N", visually distinct from red/blue damage numbers
      ctx.font = '800 13px sans-serif';
      ctx.lineWidth = 3; ctx.strokeStyle = '#ffffff'; ctx.lineJoin = 'round';
      ctx.strokeText(String(ft.value), 0, 0);
      ctx.fillStyle = '#3c9c68';
      ctx.fillText(String(ft.value), 0, 0);
    } else if (ft.unitDmg) {
      // damage taken by a PLACED UNIT (monster attack/skill) — a distinct dark-red tone
      // so it never reads as just another monster-damage number
      ctx.font = '800 13px sans-serif';
      ctx.lineWidth = 3; ctx.strokeStyle = '#ffffff'; ctx.lineJoin = 'round';
      ctx.strokeText('-' + String(ft.value), 0, 0);
      ctx.fillStyle = '#7a1f38';
      ctx.fillText('-' + String(ft.value), 0, 0);
    } else {
      ctx.font = '800 13px sans-serif';
      ctx.lineWidth = 3; ctx.strokeStyle = '#ffffff'; ctx.lineJoin = 'round';
      ctx.strokeText(String(ft.value), 0, 0);
      ctx.fillStyle = '#3a4258';
      ctx.fillText(String(ft.value), 0, 0);
    }
    ctx.restore();
  }

  ctx.restore();
}

// ---------------- UI sync ----------------
function hexToRgba(hex, alpha) {
  const n = parseInt(hex.replace('#', ''), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}

function unitCardHtml(inst) {
  const def = defOf(inst);
  const grade = gradeOf(inst);
  // 전직/레벨 배지: 벤치 카드에서도 육성된 유닛을 한눈에 구분할 수 있어야 한다
  const uLevel = inst.level || 1;
  const uTier = inst.jobTier || 1;
  const tierColor = uTier >= 4 ? '#c1465f' : uTier === 3 ? '#9660bd' : uTier === 2 ? '#c1863a' : '#2d3140';
  const lvlBadge = (uLevel > 1 || uTier > 1)
    ? `<div class="cardLvBadge" style="background:${tierColor}">${uLevel}${uTier > 1 ? ['', '', 'Ⅱ', 'Ⅲ', 'Ⅳ'][uTier] : ''}</div>` : '';
  return `<div class="icon" style="color:${grade.color}">${svgIcon(def.icon, 24)}</div><div class="cname">${def.name}</div><div class="grade" style="color:${grade.color}">${inst.grade}</div>${lvlBadge}`;
}

// ---------------- screen routing ----------------
function showScreen(name) {
  state.screen = name;
  document.getElementById('homeScreen').classList.toggle('hidden', name !== 'home');
  document.getElementById('gameScreen').classList.toggle('hidden', name !== 'game');
  document.getElementById('collectionScreen').classList.toggle('hidden', name !== 'collection');
  document.getElementById('labScreen').classList.toggle('hidden', name !== 'lab');
  window.scrollTo(0, 0);
  render();
}

let lastGold = state.gold, lastGems = state.gems, lastCoin = state.cardCoin;
let displayGold = state.gold; // ticks up/down smoothly toward state.gold instead of snapping
// animate: true while running every frame on the game screen (wave-clear rewards etc.
// read as a satisfying count-up); false everywhere else, where a per-frame loop isn't
// driving this call anyway so an eased approach would just lag behind stale
function syncCurrencyDisplays(animate) {
  if (animate) {
    displayGold += (state.gold - displayGold) * 0.2;
    if (Math.abs(state.gold - displayGold) < 0.5) displayGold = state.gold;
  } else {
    displayGold = state.gold;
  }
  HUD.gold.textContent = Math.round(displayGold);
  if (HUD.collGem) HUD.collGem.textContent = state.gems;
  if (HUD.collCoin) HUD.collCoin.textContent = state.cardCoin;
  if (state.gold > lastGold) pulseStat(HUD.goldStat);
  if (state.gems > lastGems) pulseStat(HUD.collGemStat);
  if (state.cardCoin > lastCoin) pulseStat(HUD.collCoinStat);
  lastGold = state.gold; lastGems = state.gems; lastCoin = state.cardCoin;
}

function render() {
  syncCurrencyDisplays();
  if (state.screen === 'home') renderHome();
  if (state.screen === 'game') renderGame();
  if (state.screen === 'collection') renderCollectionScreen();
  if (state.screen === 'lab') renderLabScreen();
  if (typeof scheduleCloudSave === 'function') scheduleCloudSave();
  scheduleLocalSave();
  saveRunSnapshot();
}

function renderHome() {
  document.getElementById('bestWaveLabel').textContent = state.bestWave;
}

// runs every animation frame (not just on clicks) so the wave/timer/monster-count
// readouts actually count down live instead of freezing between UI interactions
function updateHud() {
  HUD.wave.textContent = state.wave;
  // dying (fading-out) monsters are cosmetic leftovers, not part of the live swarm count
  const aliveCount = state.monsters.reduce((n, m) => n + (m.dying ? 0 : 1), 0);
  HUD.swarm.textContent = `${aliveCount}/${MONSTER_SWARM_CAP}`;
  HUD.timer.textContent = state.phase === 'wave' ? Math.max(0, Math.ceil(state.waveTimer)) + 's' : '--';
  const isBossWave = state.wave > 0 && state.wave % 10 === 0;
  HUD.timerStat.classList.toggle('boss-wave', isBossWave && state.phase === 'wave');
  HUD.timerStat.classList.toggle('urgent', isBossWave && state.phase === 'wave' && state.waveTimer <= 8 && state.bossAliveThisWave > 0);
  // early warning before the swarm-cap instant game-over, mirroring the boss-timer urgency cue
  HUD.swarmStat.classList.toggle('urgent', aliveCount >= MONSTER_SWARM_CAP * 0.8);
  syncCurrencyDisplays(true);
  const summonBtn = document.getElementById('summonBtn');
  if (summonBtn) {
    summonBtn.disabled = state.gold < 10 || state.activeDeck.length === 0
      || state.phase === 'idle' || state.phase === 'gameover' || state.bench.length >= BENCH_MAX;
    // the "why disabled" reason used to live ONLY in the title attribute — which never
    // appears on iOS Safari (no hover state on a touchscreen, and a disabled button
    // doesn't even receive the tap in the first place to reveal it any other way), so
    // on the platform this game is actually played on, that explanation was invisible
    // the whole time. The button's own visible label is now the explanation instead.
    const reason = state.activeDeck.length === 0 ? '덱을 먼저 구성하세요'
      : state.phase === 'idle' ? '게임 시작 후 소환'
      : state.phase === 'gameover' ? '게임 종료됨'
      : state.bench.length >= BENCH_MAX ? '대기 유닛 가득참'
      : state.gold < 10 ? '골드 부족 (10 필요)'
      : '';
    summonBtn.textContent = reason || '소환 (10 골드)';
    summonBtn.title = reason;
  }
  const runActive = state.phase !== 'idle' && state.phase !== 'gameover';
  const summonAllBtn = document.getElementById('summonAllBtn');
  if (summonAllBtn) {
    summonAllBtn.disabled = !runActive || state.activeDeck.length === 0
      || state.gold < 10 || state.bench.length >= BENCH_MAX;
  }
  const placeAllBtn = document.getElementById('placeAllBtn');
  if (placeAllBtn) placeAllBtn.disabled = state.bench.length === 0;
  const sellAllBenchBtn = document.getElementById('sellAllBenchBtn');
  if (sellAllBenchBtn) sellAllBenchBtn.disabled = state.bench.length === 0;
}

const TIERS_BY_ID = {};
for (const t of TIERS) TIERS_BY_ID[t.id] = t;

// rebuilds the in-run "유닛 강화" list's STRUCTURE — only called on interaction-driven
// render() (deck contents changing), never on the per-frame throttle. Tearing down and
// recreating every row+button on a timer (this used to also run from a 0.25s loop
// throttle) made the buttons visibly flicker and could drop a click that landed in the
// same instant a row got replaced out from under the pointer — a real reported bug.
// The throttle now calls updateUpgradeListState() instead, which only touches
// disabled/text/title on the EXISTING nodes, never replacing them.
function renderUpgradeList() {
  if (state.screen !== 'game') return;
  const gdl = document.getElementById('gameDeckList');
  if (!gdl) return;
  gdl.innerHTML = '';
  state.activeDeck.forEach(defId => {
    const def = UNIT_DEFS_BY_ID[defId];
    const tier = TIERS_BY_ID[def.tierId];
    const row = document.createElement('div');
    row.className = 'upgradeRow';
    row.dataset.defid = defId;
    row.innerHTML = `
      <span class="upgradeIcon" style="color:${tier.color}">${svgIcon(def.icon, 18)}</span>
      <div class="upgradeName">${def.name}<span class="lvlTag"></span></div>
      <button class="upgradeBtn"></button>
    `;
    row.querySelector('.upgradeBtn').onclick = () => upgradeRunType(defId);
    gdl.appendChild(row);
  });
  if (state.activeDeck.length === 0) {
    gdl.innerHTML = '<div class="hint">덱이 비어 있습니다. 카드함에서 덱을 구성하세요.</div>';
  }
  updateUpgradeListState();
}

// cheap per-row refresh: only mutates disabled/textContent/title on nodes that already
// exist (built by renderUpgradeList above) — safe to call every frame or on a throttle
// without any flicker or risk of eating an in-progress click
function updateUpgradeListState() {
  if (state.screen !== 'game') return;
  const gdl = document.getElementById('gameDeckList');
  if (!gdl) return;
  gdl.querySelectorAll('.upgradeRow').forEach(row => {
    const defId = row.dataset.defid;
    const rl = state.runUpgrades[defId] || 0;
    const cost = runUpgradeCost(rl);
    const lvlTag = row.querySelector('.lvlTag');
    if (lvlTag) lvlTag.textContent = rl > 0 ? ` +${rl}` : '';
    const btn = row.querySelector('.upgradeBtn');
    if (!btn) return;
    btn.disabled = state.gold < cost || state.phase === 'gameover';
    btn.title = state.gold < cost ? '골드가 부족합니다' : '';
    btn.textContent = `+${cost}G`;
  });
}

function renderGame() {
  updateHud();

  const bench = document.getElementById('benchList');
  bench.innerHTML = '';
  state.bench.forEach((inst, idx) => {
    const grade = gradeOf(inst);
    const div = document.createElement('div');
    const isHigh = ['S', 'SS', 'SSS'].includes(inst.grade);
    div.className = 'card' + (state.selected && state.selected.kind === 'bench' && state.selected.idx === idx ? ' selected' : '') + (isHigh ? ' foil' : '');
    div.style.borderColor = grade.color;
    div.style.boxShadow = `0 0 0 1px ${hexToRgba(grade.color, 0.25)}, 0 0 14px ${hexToRgba(grade.color, isHigh ? 0.45 : 0.2)}`;
    div.innerHTML = unitCardHtml(inst) + `<div class="benchSellX" title="즉시 판매 (${GRADE_SELL_PRICE[inst.grade]} 골드)">${svgIcon('coin', 10)}</div>`;
    div.onclick = () => placeFromBench(idx);
    div.querySelector('.benchSellX').onclick = (e) => { e.stopPropagation(); sellBenchUnit(idx); };
    bench.appendChild(div);
  });

  renderUpgradeList();

  const selEl = document.getElementById('selectedInfo');
  const sellBtn = document.getElementById('sellBtn');
  if (state.selected) {
    const inst = state.selected.kind === 'bench' ? state.bench[state.selected.idx] : state.placed[state.selected.key];
    if (inst) {
      const def = defOf(inst); const grade = gradeOf(inst); const stats = computeStats(inst); const lvl = levelOf(inst.defId);
      const statCells = [
        { label: '공격력', value: stats.atk.toFixed(1) },
        { label: '사거리', value: stats.fullRange ? '전체' : stats.range.toFixed(2) },
        { label: '공속', value: stats.aspd.toFixed(2) },
        { label: '치확', value: stats.critChance.toFixed(0) + '%' },
        { label: '치피', value: stats.critDmg.toFixed(0) + '%' },
      ];
      if (stats.bossDmg) statCells.push({ label: '보스피해', value: stats.bossDmg.toFixed(0) + '%' });
      const sub = SUBTYPES[def.subKey];
      const traitClass = sub.cc ? 'cc' : sub.debuff ? 'debuff' : sub.support ? 'support' : '';
      const traitIcon = sub.cc ? 'frost' : sub.debuff ? 'debuff' : sub.support ? 'buff' : sub.icon;
      // currently buffed right now? shown as one compact badge — the field itself
      // (canvas pulsing ring, see draw()) is the primary indicator; this is just a
      // quick-glance confirmation, not a restatement of everything the buff grants
      const isBuffedNow = !!inst.buffs || (inst.frenzyUntil && performance.now() < inst.frenzyUntil);
      // ---- 유닛 레벨 / 경험치 / 전직 정보 ----
      const uLevel = inst.level || 1;
      const uTier = inst.jobTier || 1;
      const branch = jobBranchOf(inst);
      const atMax = uLevel >= MAX_UNIT_LEVEL;
      const need = unitXpToNext(uLevel);
      const xpPct = atMax ? 100 : Math.max(0, Math.min(100, ((inst.xp || 0) / (need || 1)) * 100));
      const nextJobLevel = JOB_TIER_LEVELS.find(l => l > uLevel);
      const tierColor = uTier >= 4 ? '#c1465f' : uTier === 3 ? '#9660bd' : uTier === 2 ? '#c1863a' : '#7b8291';
      const jobBlock = `
        <div class="jobBlock">
          <div class="jobRow">
            <span class="jobLevel">Lv.${uLevel}${atMax ? ' <em>MAX</em>' : ''}</span>
            ${branch
              ? `<span class="jobPill" style="background:${tierColor}">${JOB_TIER_LABEL[uTier]} · ${branch.name}</span>`
              : `<span class="jobPill jobPillPlain">미전직 · 10레벨 전직</span>`}
          </div>
          <div class="xpTrack"><div class="xpFill" style="width:${xpPct.toFixed(1)}%"></div></div>
          <div class="jobNote">${atMax ? '최대 레벨 도달 — 모든 전직 완료'
            : branch ? `${branch.tiers[uTier - 2]} · ${branch.short}${nextJobLevel ? ` (다음 전직 ${nextJobLevel}레벨)` : ''}`
            : `경험치 ${Math.floor(inst.xp || 0)}/${need}`}</div>
          ${branch ? `<div class="jobDesc">${branch.desc}</div>` : ''}
        </div>`;
      selEl.innerHTML = `
        <div class="unitHead">
          <span class="unitIcon" style="color:${grade.color}">${svgIcon(def.icon, 22)}</span>
          <div class="unitHeadText">
            <div class="unitName">${def.name} <span class="unitVariant">${def.variant}</span></div>
            <div class="unitSub"><span class="gradePill" style="background:${grade.color}">${inst.grade}</span>${lvl > 0 ? `<span class="lvlTag">+${lvl}</span>` : ''}</div>
          </div>
        </div>
        <div class="subDesc${traitClass ? ' ' + traitClass : ''}">${svgIcon(traitIcon, 11)}<span>${sub.short}</span></div>
        ${jobBlock}
        ${isBuffedNow ? `<div class="activeEffectsRow"><div class="activeEffectTag">${svgIcon('buff', 12)}<span>버프 받는 중</span></div></div>` : ''}
        <div class="statGrid">
          ${statCells.map(s => `<div class="statCell"><small>${s.label}</small><b>${s.value}</b></div>`).join('')}
        </div>
        <div class="sellRow">판매가 <b>${GRADE_SELL_PRICE[inst.grade]}</b> 골드</div>
      `;
      sellBtn.disabled = false;
    } else { selEl.innerHTML = ''; sellBtn.disabled = true; }
  } else { selEl.innerHTML = ''; sellBtn.disabled = true; }

  document.querySelectorAll('.speedBtn').forEach(btn => {
    btn.classList.toggle('active', Number(btn.dataset.speed) === state.speedMult);
  });
}

function renderCollectionScreen() {
  const gachaNormalBtn = document.getElementById('gachaNormalBtn');
  const gachaGemBtn = document.getElementById('gachaGemBtn');
  const gachaBulkNormalBtn = document.getElementById('gachaBulkNormalBtn');
  gachaNormalBtn.disabled = state.cardCoin < GACHA_NORMAL_COST;
  gachaNormalBtn.title = gachaNormalBtn.disabled ? '카드코인이 부족합니다' : '';
  gachaGemBtn.disabled = state.gems < GACHA_GEM_COST;
  gachaGemBtn.title = gachaGemBtn.disabled ? '특수재화가 부족합니다' : '';
  gachaBulkNormalBtn.disabled = state.cardCoin < GACHA_NORMAL_COST * GACHA_BULK_COUNT;
  gachaBulkNormalBtn.title = gachaBulkNormalBtn.disabled ? '카드코인이 부족합니다' : '';
  const bulkEnhanceBtn = document.getElementById('bulkEnhanceBtn');
  if (bulkEnhanceBtn) {
    const anyEnhanceable = ownedDefIdList().some(defId => {
      const entry = state.collection[defId];
      return entry.level < ENHANCE_MAX_LEVEL && entry.count >= enhanceRequirement(entry.level);
    });
    bulkEnhanceBtn.disabled = !anyEnhanceable;
    // visible label, not title — see the summonBtn comment in updateHud() for why
    // title-only explanations don't work on the platform this is actually played on
    bulkEnhanceBtn.textContent = anyEnhanceable ? '일괄 강화' : '강화 가능한 카드 없음';
    bulkEnhanceBtn.title = anyEnhanceable ? '' : '강화 가능한 카드가 없습니다';
  }

  const locked = isRunLocked();
  const deckFull = state.activeDeck.length >= DECK_SIZE;

  const deckCountLabel = document.getElementById('deckCountLabel');
  if (deckCountLabel) {
    deckCountLabel.textContent = `${state.activeDeck.length}/${DECK_SIZE}`;
    deckCountLabel.classList.toggle('full', deckFull);
  }

  // deck lock notice
  const lockNotice = document.getElementById('deckLockNotice');
  if (lockNotice) lockNotice.classList.toggle('hidden', !locked);

  // deck slots
  const slots = document.getElementById('deckSlots');
  slots.innerHTML = '';
  for (let i = 0; i < DECK_SIZE; i++) {
    const defId = state.activeDeck[i];
    const slot = document.createElement('div');
    slot.className = 'deckSlot' + (defId ? ' filled' : '') + (locked ? ' locked' : '');
    if (defId) {
      const def = UNIT_DEFS_BY_ID[defId];
      const tier = TIERS_BY_ID[def.tierId];
      slot.style.borderColor = tier.color;
      slot.innerHTML = `<span style="color:${tier.color}">${svgIcon(def.icon, 16)}</span><div class="cname">${def.name}</div>${locked ? '' : `<div class="removeX">${svgIcon('x', 8)}</div>`}`;
      if (!locked) slot.onclick = () => toggleDeckCard(defId);
    } else {
      slot.innerHTML = `<span class="slotIcon">${svgIcon('plus', 16)}</span><div class="cname">빈 슬롯</div>`;
    }
    slots.appendChild(slot);
  }

  // set bonus summary
  const info = document.getElementById('setBonusInfo');
  const bonus = state.deckBonus || {};
  if (!bonus.notes || bonus.notes.length === 0) {
    info.innerHTML = `<div class="setBonusEmpty">덱을 같은 계열/등급 카드로 3장 이상 구성하면 세트 효과가 발동합니다.</div>`;
  } else {
    info.innerHTML = bonus.notes.map(n => `<div class="setBonusRow"><b>${n.label}</b><span>${n.desc}</span></div>`).join('');
  }

  // owned card grid
  const list = document.getElementById('collectionList');
  list.innerHTML = '';
  const tierRank = TIERS.map(t => t.id);
  const owned = ownedDefIdList().sort((a, b) => {
    const da = UNIT_DEFS_BY_ID[a], db = UNIT_DEFS_BY_ID[b];
    return tierRank.indexOf(db.tierId) - tierRank.indexOf(da.tierId);
  });
  owned.forEach(defId => {
    const def = UNIT_DEFS_BY_ID[defId];
    const tier = TIERS_BY_ID[def.tierId];
    const entry = state.collection[defId];
    const req = enhanceRequirement(entry.level);
    const canEnhance = entry.level < ENHANCE_MAX_LEVEL && entry.count >= req;
    const isHighTier = tier.id === 'legendary' || tier.id === 'mystic';
    const inDeck = state.activeDeck.includes(defId);
    const unaddable = !inDeck && deckFull && !locked;
    const div = document.createElement('div');
    div.className = 'collCard' + (isHighTier ? ' foil' : '') + (inDeck ? ' inDeck' : '') + (locked ? ' locked' : '') + (unaddable ? ' unaddable' : '') + (canEnhance ? ' canEnhance' : '');
    div.style.borderColor = tier.color;
    div.style.boxShadow = `0 0 0 1px ${hexToRgba(tier.color, 0.2)}, 0 0 16px ${hexToRgba(tier.color, isHighTier ? 0.4 : 0.15)}`;
    const stats = previewCardStats(defId);
    // trait badge: what kind of crowd-control/debuff/buff this unit applies, plus a
    // plain-text description of the actual effect — a hover-only title tooltip isn't
    // visible on touch devices and didn't say WHAT the effect does, just its category
    const sub = SUBTYPES[def.subKey];
    const traitClass = sub.cc ? 'cc' : sub.debuff ? 'debuff' : sub.support ? 'support' : '';
    const traitIcon = sub.cc ? 'frost' : sub.debuff ? 'debuff' : sub.support ? 'buff' : sub.icon;
    div.innerHTML = `
      ${inDeck ? '<div class="deckBadge">덱 등록됨</div>' : ''}
      <div class="collIcon" style="color:${tier.color}">${svgIcon(def.icon, 30)}</div>
      <div class="collName" style="color:${tier.color}">${def.name}</div>
      <div class="collSub">${SUBTYPES[def.subKey].name}</div>
      <div class="subDesc${traitClass ? ' ' + traitClass : ''}">${svgIcon(traitIcon, 11)}<span>${sub.desc}</span></div>
      <div class="collStats">
        <div><small>공격</small><b>${stats.atk.toFixed(1)}</b></div>
        <div><small>사거리</small><b>${stats.range.toFixed(2)}</b></div>
        <div><small>공속</small><b>${stats.aspd.toFixed(2)}</b></div>
      </div>
      <div class="collRow">보유 <b>${entry.count}</b>장 &nbsp;Lv.${entry.level}${entry.level >= ENHANCE_MAX_LEVEL ? ' (MAX)' : ''}</div>
      <button class="enhanceBtn" ${canEnhance ? '' : 'disabled'} title="${entry.level >= ENHANCE_MAX_LEVEL ? '최대 레벨입니다' : canEnhance ? '' : `카드 ${req - entry.count}장이 더 필요합니다`}">${entry.level >= ENHANCE_MAX_LEVEL ? '최대 강화' : `강화 (${entry.count}/${req})`}</button>
    `;
    div.addEventListener('click', (e) => {
      if (e.target.closest('.enhanceBtn')) return;
      toggleDeckCard(defId);
    });
    div.querySelector('.enhanceBtn').onclick = (e) => { e.stopPropagation(); enhanceCard(defId); };
    list.appendChild(div);
  });
}

const LAB_EFFECT_LABELS = {
  atkPct: '공격력', aspdPct: '공격속도', critChanceAdd: '치명타 확률',
  slowAdd: '둔화 강도', debuffPct: '저주 강도', rangePct: '사거리', skillDmgPct: '스킬 위력',
  normalDmgPct: '일반 몬스터 피해', bossDmgPct: '보스 피해', splashPct: '스플래시 피해',
  dotChance: '도트 확률', extraAtkChance: '추가 공격 확률',
  auraCritChance: '아군 치명타 확률(오라)', auraCritDmg: '아군 치명타 피해(오라)', auraBossDmg: '아군 보스 피해(오라)',
  healPct: '치유량', shieldPct: '피해감소(오라)', guardHpPct: '최대 체력',
  xpGainPct: '경험치 획득량', jobPowerPct: '차수당 공격력(전직 필요)', branchPowerPct: '전직 갈래 효과 강도',
  critDmgAdd: '치명타 피해', ccPowerPct: '제어 지속시간(결빙·속박·기절·봉인)',
  auraAspdPct: '아군 공격속도(오라)', auraRangePct: '아군 사거리(오라)', tauntPowerPct: '도발 확률·지속',
};
const LAB_ACTIVE_KIND_LABEL = {
  single: '단일 강타', aoe: '광역 폭발', freeze: '광역 빙결', curse: '광역 저주', ally: '지역 버프',
  bomb: '폭탄 부착', tornado: '이동 회오리', meteor: '메테오 낙하', laser: '관통 레이저',
  heal: '대량 치유', guard: '보호막 선언',
};

// safety-net reconciliation: recomputes what the single shared 연구실 포인트 balance
// SHOULD be — "earned" derived from the collection's current enhancement levels (4
// per level, the only source of these points), "spent" derived from labProgress's
// current node levels (summing labNodeCost() for each unlocked level across EVERY
// subtype, since it's all one pool now) — and tops up any shortfall it finds. Also
// folds in any leftover per-subtype state.labTokens from before the subtype-token /
// universal-mastery split was merged into a single pool, so nobody's earlier progress
// gets lost in the merge. Never lowers an existing balance, only raises one that's
// below what full correct accounting implies.
//
// IMPORTANT: this is a ONE-TIME correction applied right after loading saved data
// (init(), and once after a cloud merge), NOT something to call on every render — see
// the git history/comments on this function for why calling it after every purchase
// silently topped the balance back up right after spending it down (free upgrades).
function reconcileLabPoints() {
  let totalEarned = 0;
  for (const defId of ownedDefIdList()) {
    const entry = state.collection[defId];
    if (!entry || !entry.level) continue;
    totalEarned += entry.level * 4;
  }
  let totalSpent = 0;
  for (const sk of Object.keys(LAB_TREES)) {
    for (const node of LAB_TREES[sk]) {
      const lvl = labNodeLevel(sk, node.id);
      for (let L = 0; L < lvl; L++) totalSpent += labNodeCost(L);
    }
  }
  let legacyTokens = 0;
  if (state.labTokens) { for (const v of Object.values(state.labTokens)) legacyTokens += v || 0; }
  const expected = Math.max(0, totalEarned - totalSpent) + legacyTokens;
  state.masteryPoints = Math.max(state.masteryPoints || 0, expected);
  state.labTokens = {}; // fully folded into masteryPoints — don't double-count on a later call
}

function renderLabScreen() {
  const subKey = state.labSelectedSub;
  const masteryLabel = document.getElementById('labMasteryLabel');
  if (masteryLabel) masteryLabel.textContent = state.masteryPoints || 0;

  // subtype selector tabs
  const tabWrap = document.getElementById('labSubTabs');
  tabWrap.innerHTML = '';
  Object.keys(LAB_TREES).forEach(sk => {
    const info = SUBTYPES[sk];
    const btn = document.createElement('button');
    btn.className = 'labTab' + (sk === subKey ? ' active' : '');
    btn.innerHTML = `${svgIcon(info.icon, 16)}<span>${info.name}</span>`;
    btn.onclick = () => { state.labSelectedSub = sk; render(); };
    tabWrap.appendChild(btn);
  });

  // 전직 갈래 안내: 이 서브타입의 유닛이 10레벨에 무작위로 둘 중 하나를 얻는다는 사실과,
  // 각 갈래가 어떤 방향으로 강해지는지(2/3/4차 이름 포함)를 연구실에서 미리 볼 수 있게 한다
  const jobWrap = document.getElementById('labJobBranches');
  if (jobWrap) {
    const branches = JOB_BRANCHES[subKey] || [];
    jobWrap.innerHTML = branches.map((b, i) => `
      <div class="jobBranchCard${i === 0 ? ' aSide' : ' bSide'}">
        <div class="jbHead"><span class="jbName">${b.name}</span><span class="jbShort">${b.short}</span></div>
        <div class="jbDesc">${b.desc}</div>
        <div class="jbTiers">${b.tiers.map((t, ti) => `<span class="jbTier">${JOB_TIER_LABEL[ti + 2]} ${t}</span>`).join('')}</div>
      </div>`).join('');
  }

  // skill tree for the selected subtype: root -> branchA/branchB -> leafA/leafB -> capstone
  const grid = document.getElementById('labTreeGrid');
  grid.innerHTML = '';
  const tree = LAB_TREES[subKey];
  // xpGain/branchMastery/jobSync는 전직 시스템 연동 노드 — 각각 선행 조건(root Lv.3 /
  // leafA Lv.3 / capstone Lv.3)이 있는 위치에 자연스럽게 끼워 넣는다
  // specA/specB(서브타입별 특화 한 쌍)는 각각 leafA/leafB를 선행 조건으로 갖는 "잎의 잎"이라
  // leafA/leafB 바로 아래 같은 좌/우 열에 놓아야 사슬이 시각적으로 이어진다
  const rows = [['root'], ['xpGain'], ['branchA', 'branchB'], ['leafA', 'leafB'], ['specA', 'specB'], ['branchMastery', 'capstone'], ['jobSync']];
  rows.forEach(rowIds => {
    const rowEl = document.createElement('div');
    rowEl.className = 'labRow';
    rowIds.forEach(nodeId => {
      const node = tree.find(n => n.id === nodeId);
      if (!node) return;
      const level = labNodeLevel(subKey, nodeId);
      const unlocked = labNodeUnlocked(subKey, node);
      const cost = labNodeCost(level);
      const canAfford = unlocked && (state.masteryPoints || 0) >= cost;
      const isActive = node.type === 'active';
      const card = document.createElement('div');
      card.className = 'labNode' + (isActive ? ' skillNode' : '') + (unlocked ? '' : ' locked') + (level > 0 ? ' active' : '');
      let effectLine;
      if (isActive) {
        effectLine = level > 0
          ? `${LAB_ACTIVE_KIND_LABEL[node.activeKind]} · ${LAB_ACTIVE_INTERVAL}초마다`
          : `${node.requires.level}레벨 필요 (미해금 스킬)`;
      } else {
        const effectLabel = LAB_EFFECT_LABELS[node.effectKey] || node.effectKey;
        effectLine = `${effectLabel} +${(node.perLevel * Math.max(level, 1)).toFixed(1)}${level === 0 ? ' (다음)' : ''}`;
      }
      card.innerHTML = `
        <div class="labNodeIcon">${svgIcon(unlocked ? node.icon : 'lock', 20)}</div>
        <div class="labNodeName">${node.name}${isActive ? ' <span class="labSkillTag">스킬</span>' : ''}</div>
        <div class="labNodeEffect">${effectLine}</div>
        <div class="labNodeLevel">Lv.${level}</div>
        <button class="labNodeBtn" ${canAfford ? '' : 'disabled'} title="${unlocked ? (canAfford ? '' : '포인트가 부족합니다') : `${node.requires.level}레벨을 먼저 해금하세요`}">${unlocked ? (canAfford ? `강화 (${cost} 포인트)` : `포인트 부족 (${cost} 필요)`) : `Lv.${node.requires.level} 필요`}</button>
      `;
      card.querySelector('.labNodeBtn').onclick = () => upgradeLabNode(subKey, nodeId);
      rowEl.appendChild(card);
    });
    grid.appendChild(rowEl);
  });
}

// ---------------- input ----------------
// this is a click/tap game board, not a document with selectable text or draggable
// content, so kill native drag and the right-click context menu everywhere
document.addEventListener('contextmenu', (e) => e.preventDefault());
document.addEventListener('dragstart', (e) => e.preventDefault());
document.addEventListener('selectstart', (e) => { if (!e.target.closest('input, textarea')) e.preventDefault(); });

// iOS Safari (especially as a bookmarked/home-screen app) pinch-to-zoom gestures
// otherwise blow up the layout; touch-action:manipulation (CSS, already applied to
// * and html/body) natively disables double-tap-to-zoom in modern mobile browsers,
// so only Safari's own non-standard pinch gesture events need blocking directly here.
// (A manual touchend-based "was that a double-tap" heuristic used to live here too,
// but it compared timestamps globally rather than per-element, so two quick taps on
// the SAME button — e.g. tapping 소환 repeatedly — got misread as a double-tap-zoom
// attempt and had their second click swallowed. touch-action already handles the
// real double-tap-zoom case, so the heuristic was redundant AND actively buggy.)
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('gesturechange', (e) => e.preventDefault());
document.addEventListener('gestureend', (e) => e.preventDefault());

canvas.addEventListener('click', (e) => {
  if (state.phase === 'idle' || state.phase === 'gameover') return;
  const rect = canvas.getBoundingClientRect();
  const x = (e.clientX - rect.left) * (canvas.width / rect.width) - MARGIN;
  const y = (e.clientY - rect.top) * (canvas.height / rect.height) - MARGIN;
  const c = Math.floor(x / CELL), r = Math.floor(y / CELL);
  if (c < 0 || c >= GRID || r < 0 || r >= GRID) return;
  const isInterior = INTERIOR.some(p => p.c === c && p.r === r);
  if (!isInterior) return;
  selectField(cellKey(c, r));
});

document.getElementById('summonBtn').onclick = summonUnit;
document.getElementById('sellBtn').onclick = sellSelected;
document.getElementById('bulkSellBtn').onclick = bulkSell;
document.getElementById('summonAllBtn').onclick = summonAll;
document.getElementById('placeAllBtn').onclick = placeAllBench;
document.getElementById('sellAllBenchBtn').onclick = sellAllBench;
// grade picker for 일괄 판매's threshold — built once here (options never change),
// its selected value drives state.bulkSellMaxGrade which bulkSell() reads live
(function setupBulkSellGradePicker() {
  const sel = document.getElementById('bulkSellGrade');
  if (!sel) return;
  sel.innerHTML = GRADES.map(g => `<option value="${g.id}">${g.id} 이하</option>`).join('');
  sel.value = state.bulkSellMaxGrade;
  sel.onchange = () => { state.bulkSellMaxGrade = sel.value; };
})();
document.getElementById('gachaNormalBtn').onclick = gachaNormal;
document.getElementById('gachaGemBtn').onclick = gachaGem;
document.getElementById('gachaBulkNormalBtn').onclick = gachaBulkNormal;
document.getElementById('bulkEnhanceBtn').onclick = bulkEnhanceAll;
document.getElementById('startBtn').onclick = () => {
  document.getElementById('startRow').classList.add('hidden');
  state.gold = 50; // the real run-start reset: whatever was spent/left over before this click doesn't matter
  state.bench = [];
  state.selected = null;
  beginPrep();
  render();
};
document.getElementById('restartBtn').onclick = () => { resetRun(); showScreen('game'); };

document.querySelectorAll('.speedBtn').forEach(btn => {
  btn.onclick = () => { state.speedMult = Math.min(MAX_SPEED_MULT, Number(btn.dataset.speed)); render(); };
});

document.getElementById('goGameBtn').onclick = () => { resetRun(); showScreen('game'); };
document.getElementById('goCollectionBtn').onclick = () => showScreen('collection');
document.getElementById('gameHomeBtn').onclick = () => showScreen('home');
document.getElementById('gameCollBtn').onclick = () => showScreen('collection');
document.getElementById('gameLabBtn').onclick = () => showScreen('lab');
document.getElementById('collHomeBtn').onclick = () => showScreen('home');
document.getElementById('collGameBtn').onclick = () => showScreen('game');
document.getElementById('goLabBtn').onclick = () => showScreen('lab');
document.getElementById('collLabBtn').onclick = () => showScreen('lab');
document.getElementById('labHomeBtn').onclick = () => showScreen('home');
document.getElementById('labCollBtn').onclick = () => showScreen('collection');

// ---------------- init ----------------
function applyStaticIcons() {
  document.querySelectorAll('[data-icon]').forEach(el => {
    const name = el.dataset.icon;
    const label = el.dataset.iconLabel;
    el.innerHTML = svgIcon(name, el.classList.contains('statBadge') ? 15 : el.classList.contains('navBtn') ? 17 : 14) + (label ? `<span>${label}</span>` : '');
  });
}

// flush pending saves immediately on backgrounding/close — the debounce timer used
// during normal play may not get a chance to fire before iOS reclaims the tab
function flushSaves() {
  clearTimeout(saveTimer);
  saveLocalProgress();
  saveRunSnapshot();
  // best-effort — a network write isn't guaranteed to land before the tab is actually
  // killed, which is exactly why loadCloudProgress() now merges instead of overwrites
  // (see cloud.js) rather than relying on this alone
  if (typeof saveCloudProgress === 'function') saveCloudProgress();
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushSaves(); });
window.addEventListener('pagehide', flushSaves);

function init() {
  loadLocalProgress();
  if (Object.keys(state.collection).length === 0) {
    // fresh install / first ever play: seed the starter deck
    for (const defId of startingDeck()) {
      state.collection[defId] = { count: 1, level: 0 };
      state.activeDeck.push(defId);
    }
  }
  reconcileLabPoints();
  updateDeckBonus();
  applyStaticIcons();
  // tryRestoreRunSnapshot() MUST run before this initial render(): render() always
  // calls saveRunSnapshot() at its end, and while state.screen is still the default
  // 'home' (before a restore has had a chance to flip it to 'game'), that guard
  // deletes RUN_SNAPSHOT_KEY outright — wiping the very snapshot we're about to try
  // to read. That made the "resume mid-run after reload" feature silently no-op on
  // every real page load even though it worked fine when tested by calling
  // tryRestoreRunSnapshot() manually mid-session. tryRestoreRunSnapshot() renders
  // itself (via showScreen) when it restores, so only fall back to a plain render()
  // when there was nothing to restore.
  if (!tryRestoreRunSnapshot()) render();
}
init();
requestAnimationFrame(loop);
