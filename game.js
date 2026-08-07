// ===================== AAA Defense - Game Logic =====================
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
      // a snapshot saved before the unit-HP system existed won't carry hp/maxHp either —
      // same "re-derive on restore" treatment as .center just above
      if (typeof ensureUnitHp === 'function') ensureUnitHp(inst);
    }
    state.bench = snap.bench || [];
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
  slow += (lab.slowAdd || 0);
  bossDmg += (lab.bossDmgPct || 0);

  // ---- unit max HP (see #6): placed units now have hp that can reach 0 ----
  // base scales the same way atk/range/aspd already do — grade + card tier + enhancement
  // level + in-run gold upgrade — plus a per-subtype hpMult (tanker built to tank, ranged/
  // support are glass) and its own lab-tree self-bonus (tank_guard's 생명력 강화 node)
  const HP_BASE = 40;
  const sub = SUBTYPES[def.subKey];
  let maxHp = HP_BASE * (sub.hpMult || 1) * grade.mult * (TIERS_BY_ID[def.tierId] ? TIERS_BY_ID[def.tierId].mult : 1)
    * (1 + lvl * 0.05) * (1 + runLvl * 0.04);
  if (def.subKey === 'tank_guard') maxHp *= (1 + guardHpPct / 100);

  return {
    atk, range, aspd, critChance, critDmg, bossDmg, slow, targets, debuffPct, skillDmgPct,
    normalDmgPct, splashPct, dotChance, extraAtkChance, healPct, shieldPct, guardHpPct,
    maxHp, dmgReductionPct,
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
  m.dying = false; m.deathT = 0; m.frostStacks = 0; m.frostStackAt = 0;
  if (m.dots) m.dots.length = 0; else m.dots = []; // reuse the array too, not just the object
  // monster-attacks-units (#7) + boss/mid skills (#8) fields — always reset regardless of
  // kind, since a recycled pooled object could otherwise start life mid-cooldown from a
  // previous boss/mid use even though it just respawned as a plain 'normal' monster
  m.atkCooldown = (kind === 'mid' || kind === 'boss') ? (0.6 + Math.random()) : 0;
  m.skillCooldown = kind === 'boss' ? (3 + Math.random() * 3) : kind === 'mid' ? (5 + Math.random() * 3) : 0;
  m.hasteUntil = 0; m.hasteMult = 1; // rally skill (buff other monsters), see applyMonsterHaste
  m.bombTagged = false; // atk_single capstone bomb-attach marker, see attachBomb/tickBombs
  state.monsters.push(m);
  if (kind === 'boss') state.bossAliveThisWave = (state.bossAliveThisWave || 0) + 1;
}

// ---------------- wave flow ----------------
function beginPrep() {
  state.phase = 'prep';
  state.prepTimer = 3;
  document.getElementById('wavePrepOverlay').classList.remove('hidden');
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
  for (let i = 0; i < 20; i++) queue.push({ t: (i / 20) * state.waveDuration, kind: 'normal' });
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
  // boss wave fail check — bossAliveThisWave is now a COUNTER (see #9), so this only
  // clears once EVERY boss spawned this wave has been killed, not just one of several
  if (state.wave % 10 === 0 && state.bossAliveThisWave > 0) {
    return gameOver('보스를 제한시간 내에 처치하지 못했습니다');
  }
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
function shakeScreen(mag) { shakeTime = 0.35; shakeMag = mag; }

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

// ---------------- combat ----------------
function dist(ax, ay, bx, by) { return Math.hypot(ax - bx, ay - by); }

function updateSupportBuffs() {
  // computed once and reused for both the outer supports scan and the inner per-target
  // scan below — this used to call Object.entries(state.placed) fresh inside the outer
  // loop (once per support unit), allocating a whole new array of every placed unit
  // O(supports * placedCount) times per combat tick instead of just once
  const allPlaced = Object.entries(state.placed);
  for (const [, inst] of allPlaced) inst.buffs = null;
  const supports = allPlaced.filter(([k, inst]) => defOf(inst).base.support);
  if (supports.length === 0) return;
  // 연구실 아우라 노드: buff_support 트리는 서브타입 공용이라 모든 지원형 유닛에 대해 한 번만 계산하면 된다
  const supportLab = computeLabBonus('buff_support');
  for (const [key, sInst] of supports) {
    const grade = gradeOf(sInst);
    const supportStats = computeStats(sInst); // respects enhancement/run-upgrade/deck bonuses on the buffer itself
    const range = supportStats.range * CELL;
    const center = sInst.center; // cached at placement time — see placeUnitAt()
    const lvl = levelOf(sInst.defId);
    const runLvl = state.runUpgrades[sInst.defId] || 0;
    const power = (4 + (grade.mult - 1) * 6) * (1 + lvl * ENHANCE_STAT_BONUS.atk) * (1 + runLvl * RUN_UPGRADE_STAT_BONUS.atk);
    for (const [k2, tInst] of allPlaced) {
      if (k2 === key) continue;
      const p2 = tInst.center; // cached at placement time — see placeUnitAt()
      if (supportStats.fullRange || dist(center.x, center.y, p2.x, p2.y) <= range) {
        tInst.buffs = tInst.buffs || {};
        tInst.buffs.atk = (tInst.buffs.atk || 0) + power;
        tInst.buffs.aspd = (tInst.buffs.aspd || 0) + power * 0.6;
        tInst.buffs.range = (tInst.buffs.range || 0) + power * 0.3;
        tInst.buffs.critChance = (tInst.buffs.critChance || 0) + power * 0.4 + supportLab.auraCritChance;
        tInst.buffs.critDmg = (tInst.buffs.critDmg || 0) + power * 0.5 + supportLab.auraCritDmg;
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
    const range = guardStats.range * CELL;
    const center = gInst.center;
    const grade = gradeOf(gInst);
    const power = 12 + (grade.mult - 1) * 8 + guardLab.shieldPct * 0.6;
    for (const [k2, tInst] of allPlaced) {
      const p2 = tInst.center;
      if (dist(center.x, center.y, p2.x, p2.y) <= range) { // includes the tanker itself (k2 === key allowed)
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
  const healAmount = stats.atk * 0.9 * (1 + stats.healPct / 100);
  let healedAny = false;
  for (const [, ally] of Object.entries(state.placed)) {
    if (ally.hp == null || ally.maxHp == null) continue;
    if (ally.hp >= ally.maxHp) continue;
    const c2 = ally.center;
    if (dist(center.x, center.y, c2.x, c2.y) > stats.range * CELL) continue;
    ally.hp = Math.min(ally.maxHp, ally.hp + healAmount);
    healedAny = true;
    spawnHitParticles(c2.x, c2.y, '#3c9c68', 4);
    if (state.floatingTexts.length < MAX_FLOATING_TEXTS) {
      state.floatingTexts.push({ x: c2.x + (Math.random() * 10 - 5), y: c2.y - 26, t: 0, dur: 0.55, value: '+' + Math.round(healAmount), heal: true });
    }
  }
  if (healedAny) spawnHitParticles(center.x, center.y, '#3c9c68', 3);
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
  const crit = Math.random() * 100 < stats.critChance;
  let dmg = stats.atk * (crit ? (1 + stats.critDmg / 100) : 1);
  if ((m.kind === 'boss' || m.kind === 'mid') && stats.bossDmg) dmg *= (1 + stats.bossDmg / 100);
  if (m.kind === 'normal' && stats.normalDmgPct) dmg *= (1 + stats.normalDmgPct / 100);
  if (now < m.debuffUntil) dmg *= m.debuffAtkTakenMult; // debuff-type units mark targets to take extra damage
  dealDamage(m, dmg, crit);
  spawnProjectile(center.x, center.y, m.x, m.y, 0.15, crit ? '#bd9530' : '#4a72d6');
  spawnHitParticles(m.x, m.y, crit ? '#bd9530' : '#4a72d6', crit ? 6 : 3);
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
  const dmgMult = 1 + node.perLevel * capstoneLvl;
  // no toast/shake here on purpose: once several units have their capstone skill,
  // a text popup or screen shake per activation would fire constantly and feel like spam.
  // the particle burst is enough local feedback without disrupting the whole screen.
  spawnHitParticles(center.x, center.y, '#4a72d6', 12);

  if (node.activeKind === 'ally') {
    // 오라클 리워크 (#1): 전군 버프 대신 캐스터 주변 지역에만 적용되는 버프 지대
    const zoneR = 2.0 * CELL;
    spawnZone(center.x, center.y, zoneR, 'buff', 0, 0.5, 5, { atkPct: 12 + capstoneLvl * 3, aspdPct: 10 + capstoneLvl * 1.5 });
    spawnTurret(center.x, center.y, 2.5 * CELL, stats.atk * 0.5, 0.5, 5);
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
        a.buffs.dmgReductionPct = Math.min(75, (a.buffs.dmgReductionPct || 0) + 20 + capstoneLvl * 3);
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
    spawnZone(center.x, center.y, zoneR, 'buff', 0, 0.5, 6, { atkPct: 35 + stats.skillDmgPct * 0.5, aspdPct: 28 });
    spawnTurret(center.x, center.y, 2.5 * CELL, stats.atk * 0.5, 0.5, 5);
    spawnShockRing(center.x, center.y, zoneR, '#3c9c68');
    return;
  }
  if (def.subKey === 'heal_support') {
    const inRangeAllies = Object.values(state.placed).filter(a => a.hp != null && dist(center.x, center.y, a.center.x, a.center.y) <= stats.range * CELL);
    const healAmount = stats.atk * (skill.healMult || 2.5);
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
        a.buffs.dmgReductionPct = Math.min(75, (a.buffs.dmgReductionPct || 0) + 30);
      }
    }
    spawnShockRing(center.x, center.y, stats.range * CELL, '#7b8291');
    return;
  }
  if (def.subKey === 'atk_multi') {
    // 광란 (#2 frenzy): 순간 피해 대신 자신의 공격속도를 짧게 폭증시키는 자가 버프
    inst.frenzyUntil = now + 4000;
    spawnHitParticles(center.x, center.y, '#c1465f', 16);
    return;
  }

  const inRange = state.monsters.filter(m => stats.fullRange || dist(center.x, center.y, m.x, m.y) <= stats.range * CELL);
  if (inRange.length === 0) return;

  if (def.subKey === 'atk_single' || def.subKey === 'ranged_single') {
    // single target burst (ranged hits a few in a line, single-target hits the nearest)
    inRange.sort((a, b) => dist(center.x, center.y, a.x, a.y) - dist(center.x, center.y, b.x, b.y));
    const hitCount = def.subKey === 'ranged_single' ? 3 : 1;
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
    for (let i = 0; i < 5; i++) {
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
function tickMonsterAttacks(dt) {
  const placedList = Object.entries(state.placed);
  if (placedList.length === 0) return;
  for (const m of state.monsters) {
    if (m.dying) continue;
    if (m.kind !== 'mid' && m.kind !== 'boss') continue;
    m.atkCooldown -= dt;
    if (m.atkCooldown > 0) continue;
    const range = MONSTER_ATK_RANGE[m.kind];
    let best = null, bestD = Infinity;
    for (const [key, inst] of placedList) {
      // placedList is a snapshot taken once for the whole tick (see comment above); a
      // unit killed by an earlier monster's attack THIS SAME tick is still present in
      // it, so skip anything already dead/removed rather than re-"killing" a phantom
      // and stealing an attack that should've gone to a still-living unit
      if (inst.hp <= 0 || state.placed[key] !== inst) continue;
      const d = dist(m.x, m.y, inst.center.x, inst.center.y);
      if (d <= range && d < bestD) { bestD = d; best = [key, inst]; }
    }
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
    let best = null, bestD = Infinity;
    for (const [key, inst] of Object.entries(state.placed)) {
      const d = dist(m.x, m.y, inst.center.x, inst.center.y);
      if (d <= range && d < bestD) { bestD = d; best = [key, inst]; }
    }
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
function loop(now) {
  const rawDt = Math.min(0.05, (now - lastT) / 1000);
  lastT = now;

  if (state.screen === 'game') {
    const dt = rawDt * state.speedMult;

    if (state.phase === 'prep') {
      state.prepTimer -= dt;
      document.getElementById('prepCount').textContent = Math.max(0, Math.ceil(state.prepTimer));
      if (state.prepTimer <= 0) beginWave();
    } else if (state.phase === 'wave') {
      state.waveTimer -= dt;
      state.spawnTimer += dt;
      while (state.spawnQueue.length && state.spawnQueue[0].t <= state.spawnTimer) {
        const sp = state.spawnQueue.shift();
        spawnMonster(sp.kind);
      }
      tickMonsters(dt);
      tickCombat(dt);
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

  requestAnimationFrame(loop);
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
    } else if (z.kind === 'buff') {
      // soft double-ring shimmer, no dashing/rotation — reads as a calm "blessing" field
      // rather than the hazard-y spinning edges used by plague/tornado
      const shimmer = 0.35 + Math.sin(nowZ / 260 + z.x) * 0.15;
      ctx.beginPath();
      ctx.arc(z.x, z.y, z.r, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(${zCol},${shimmer})`;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(z.x, z.y, z.r * 0.86, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(224,199,101,${shimmer * 0.7})`;
      ctx.lineWidth = 1;
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
    const lvl = levelOf(inst.defId);
    const runLvl = state.runUpgrades[inst.defId] || 0;

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

    if (lvl > 0 || runLvl > 0) {
      ctx.beginPath();
      ctx.arc(x + BADGE_R * 0.72, y - BADGE_R * 0.72, 8, 0, Math.PI * 2);
      ctx.fillStyle = runLvl > 0 ? '#3c9c68' : '#4a72d6';
      ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.font = '800 8px sans-serif';
      ctx.fillStyle = '#fff';
      ctx.fillText('+' + (lvl + runLvl), x + BADGE_R * 0.72, y - BADGE_R * 0.72 + 0.5);
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
    const deathScale = 1 - dyingT * 0.7;
    const deathAlpha = 1 - dyingT;
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
  return `<div class="icon" style="color:${grade.color}">${svgIcon(def.icon, 24)}</div><div class="cname">${def.name}</div><div class="grade" style="color:${grade.color}">${inst.grade}</div>`;
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
      selEl.innerHTML = `
        <div class="unitHead">
          <span class="unitIcon" style="color:${grade.color}">${svgIcon(def.icon, 22)}</span>
          <div class="unitHeadText">
            <div class="unitName">${def.name} <span class="unitVariant">${def.variant}</span></div>
            <div class="unitSub"><span class="gradePill" style="background:${grade.color}">${inst.grade}</span>${lvl > 0 ? `<span class="lvlTag">+${lvl}</span>` : ''}</div>
          </div>
        </div>
        <div class="subDesc${traitClass ? ' ' + traitClass : ''}">${svgIcon(traitIcon, 11)}<span>${sub.short}</span></div>
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

  // skill tree for the selected subtype: root -> branchA/branchB -> leafA/leafB -> capstone
  const grid = document.getElementById('labTreeGrid');
  grid.innerHTML = '';
  const tree = LAB_TREES[subKey];
  const rows = [['root'], ['branchA', 'branchB'], ['leafA', 'leafB'], ['capstone']];
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
  btn.onclick = () => { state.speedMult = Number(btn.dataset.speed); render(); };
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
