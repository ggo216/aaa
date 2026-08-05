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

const DECK_SIZE = 5;

function cellCenter(c, r) { return { x: MARGIN + c * CELL + CELL / 2, y: MARGIN + r * CELL + CELL / 2 }; }
function cellKey(c, r) { return `${c},${r}`; }

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
  waveDuration: 20,
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
  labTokens: {}, // subKey -> token count, earned 2 per card enhancement level-up
  labProgress: {}, // subKey -> { nodeId -> level }, persistent, benefits every card of that subtype
  labSelectedSub: 'atk_single',
  allyBuff: null, // { until, atkPct, aspdPct } set by a buff_support legendary skill activation
  instSeq: 0,
  selected: null, // {kind:'bench', idx} | {kind:'field', key}
  projectiles: [],
  particles: [],
  floatingTexts: [],
  speedMult: 1,
  bossAliveThisWave: false,
  bossKilledInTime: true,
};

function log(msg) {
  const el = document.getElementById('log');
  el.textContent = msg;
}

// ---------------- deck / collection / units ----------------
function startingDeck() {
  const picks = [];
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
  // every card level-up feeds 2 연구실 skill tokens into that subtype's tree
  state.labTokens[def.subKey] = (state.labTokens[def.subKey] || 0) + 2;
  log(`${def.name} 강화! Lv.${entry.level} (+2 ${SUBTYPES[def.subKey].name} 연구 토큰)`);
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
const RUN_UPGRADE_MAX_LEVEL = 8;
function runUpgradeCost(level) { return 25 + level * 20; }

function upgradeRunType(defId) {
  if (!state.activeDeck.includes(defId) || state.phase === 'gameover') return;
  const lvl = state.runUpgrades[defId] || 0;
  if (lvl >= RUN_UPGRADE_MAX_LEVEL) return;
  const cost = runUpgradeCost(lvl);
  if (state.gold < cost) return;
  state.gold -= cost;
  state.runUpgrades[defId] = lvl + 1;
  const def = UNIT_DEFS_BY_ID[defId];
  log(`${def.name} 인게임 강화! Lv.${lvl + 1} (이번 판에만 적용)`);
  render();
}

// ---------------- deck set bonuses ----------------
const CAT_LABEL = { attack: '공격형', magic: '마법형', ranged: '원거리형', buff: '버프형' };
const CAT_EFFECT = {
  attack: { key: 'atkPct', label: '공격력' },
  magic: { key: 'critChanceAdd', label: '치명타 확률', suffix: '%p' },
  ranged: { key: 'aspdPct', label: '공격속도' },
  buff: { key: 'bossDmgAdd', label: '보스 피해' },
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
    const tier = TIERS.find(t => t.id === tierId);
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
  const tokens = state.labTokens[subKey] || 0;
  if (tokens < cost) return;
  state.labTokens[subKey] = tokens - cost;
  state.labProgress[subKey] = state.labProgress[subKey] || {};
  state.labProgress[subKey][nodeId] = level + 1;
  log(`${node.name} Lv.${level + 1} 습득!`);
  render();
}

// aggregate bonus from every node in a subtype's tree; benefits ALL owned/placed
// cards of that subtype regardless of their individual grade or card tier
function computeLabBonus(subKey) {
  const bonus = {
    atkPct: 0, aspdPct: 0, critChanceAdd: 0, slowAdd: 0, debuffPct: 0, rangePct: 0, skillDmgPct: 0,
    normalDmgPct: 0, bossDmgPct: 0, splashPct: 0, dotChance: 0, extraAtkChance: 0,
    auraCritChance: 0, auraCritDmg: 0, auraBossDmg: 0,
  };
  const tree = LAB_TREES[subKey];
  if (!tree) return bonus;
  for (const node of tree) {
    const lvl = labNodeLevel(subKey, node.id);
    if (lvl > 0 && node.effectKey in bonus) bonus[node.effectKey] += node.perLevel * lvl;
  }
  return bonus;
}

function makeInstance(defId, grade) {
  state.instSeq++;
  return { instId: 'i' + state.instSeq, defId, grade: grade.id, cooldown: 0, cellKey: null, buffs: null, skillCooldown: SKILL_INTERVAL };
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
  // apply live support buffs from nearby buff_support units
  if (instance.buffs) {
    atk *= (1 + (instance.buffs.atk || 0) / 100);
    aspd *= (1 + (instance.buffs.aspd || 0) / 100);
    range *= (1 + (instance.buffs.range || 0) / 100);
    critChance += (instance.buffs.critChance || 0);
    critDmg += (instance.buffs.critDmg || 0);
    bossDmg += (instance.buffs.bossDmg || 0);
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
  atk *= (1 + (lab.atkPct || 0) / 100);
  aspd *= (1 + (lab.aspdPct || 0) / 100);
  range *= (1 + (lab.rangePct || 0) / 100);
  critChance += (lab.critChanceAdd || 0);
  slow += (lab.slowAdd || 0);
  bossDmg += (lab.bossDmgPct || 0);
  // field-wide temporary buff from a buff_support legendary skill activation
  if (state.allyBuff && performance.now() < state.allyBuff.until) {
    atk *= (1 + (state.allyBuff.atkPct || 0) / 100);
    aspd *= (1 + (state.allyBuff.aspdPct || 0) / 100);
  }
  return {
    atk, range, aspd, critChance, critDmg, bossDmg, slow, targets, debuffPct, skillDmgPct,
    normalDmgPct, splashPct, dotChance, extraAtkChance,
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

function spawnMonster(kind) {
  const hp = monsterHpForWave(state.wave, kind);
  const speed = monsterSpeedForWave(state.wave, kind);
  const trackPos = Math.random() * 24; // slight stagger so bursts don't perfectly overlap
  const lane = (Math.random() - 0.5) * 10; // small perpendicular jitter for visual spread
  const p = trackPoint(trackPos, lane);
  state.monsterSeq++;
  const m = {
    id: state.monsterSeq, kind, hp, maxHp: hp, speed,
    trackPos, lane, x: p.x, y: p.y,
    slowUntil: 0, slowFactor: 1, debuffUntil: 0, debuffAtkTakenMult: 1,
    dots: [], // { dmgPerTick, ticksLeft, nextTick }
  };
  state.monsters.push(m);
  if (kind === 'boss') state.bossAliveThisWave = true;
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
  state.waveTimer = state.waveDuration;
  document.getElementById('wavePrepOverlay').classList.add('hidden');
  state.bossAliveThisWave = false;
  state.bossKilledInTime = true;

  const queue = [];
  for (let i = 0; i < 20; i++) queue.push({ t: (i / 20) * state.waveDuration, kind: 'normal' });
  if (state.wave % 10 === 0) queue.push({ t: 1, kind: 'boss' });
  else if (state.wave % 5 === 0) queue.push({ t: 1, kind: 'mid' });
  queue.sort((a, b) => a.t - b.t);
  state.spawnQueue = queue;
  state.spawnTimer = 0;
}

function endWave() {
  // boss wave fail check
  if (state.wave % 10 === 0 && state.bossAliveThisWave) {
    return gameOver('보스를 제한시간 내에 처치하지 못했습니다');
  }
  const goldGain = 15 + state.wave * 5;
  const coinGain = 5 + state.wave * 2;
  state.gold += goldGain;
  state.cardCoin += coinGain;
  log(`웨이브 ${state.wave} 종료! +${goldGain} 골드, +${coinGain} 카드코인`);
  showWaveToast(`WAVE ${state.wave} CLEAR   +${goldGain} 골드`);
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
  state.monsters = [];
  state.spawnQueue = [];
  state.spawnTimer = 0;
  state.placed = {};
  state.bench = [];
  state.runUpgrades = {};
  state.selected = null;
  state.projectiles = [];
  state.particles = [];
  state.floatingTexts = [];
  state.bossAliveThisWave = false;
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
    log(`중복 카드 획득: ${def.name} (보유 ${state.collection[def.id].count}장, 강화 재료로 사용 가능)`);
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
  if (state.gold < 10 || state.activeDeck.length === 0 || state.phase === 'gameover') return;
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
    render();
    return;
  }
  const cell = emptyCells[Math.floor(Math.random() * emptyCells.length)];
  const key = cellKey(cell.c, cell.r);
  state.bench.splice(idx, 1);
  inst.cellKey = key;
  inst.placedAt = performance.now();
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
        state.bench.push(occupant);
        inst.cellKey = key;
        state.placed[key] = inst;
      } else {
        state.bench.splice(cur.idx, 1);
        inst.cellKey = key;
        state.placed[key] = inst;
      }
      inst.placedAt = performance.now();
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
      if (b) b.cellKey = cur.key;
      if (a) a.cellKey = key;
      state.selected = null;
      render();
      return;
    }
  }
  if (state.placed[key]) {
    state.selected = { kind: 'field', key };
    render();
  }
}

function sellSelected() {
  const sel = state.selected;
  if (!sel) return;
  let inst;
  if (sel.kind === 'bench') inst = state.bench.splice(sel.idx, 1)[0];
  else { inst = state.placed[sel.key]; delete state.placed[sel.key]; }
  if (inst) state.gold += GRADE_SELL_PRICE[inst.grade];
  state.selected = null;
  render();
}

function bulkSell() {
  const rank = GRADES.map(g => g.id);
  const maxIdx = rank.indexOf(BULK_SELL_MAX_GRADE);
  let gained = 0;
  state.bench = state.bench.filter(inst => {
    if (rank.indexOf(inst.grade) <= maxIdx) { gained += GRADE_SELL_PRICE[inst.grade]; return false; }
    return true;
  });
  for (const key of Object.keys(state.placed)) {
    const inst = state.placed[key];
    if (rank.indexOf(inst.grade) <= maxIdx) { gained += GRADE_SELL_PRICE[inst.grade]; delete state.placed[key]; }
  }
  state.gold += gained;
  state.selected = null;
  log(`일괄 판매로 +${gained} 골드`);
  render();
}

// ---------------- combat ----------------
function dist(ax, ay, bx, by) { return Math.hypot(ax - bx, ay - by); }

function updateSupportBuffs() {
  for (const inst of Object.values(state.placed)) inst.buffs = null;
  const supports = Object.entries(state.placed).filter(([k, inst]) => defOf(inst).base.support);
  if (supports.length === 0) return;
  // 연구실 아우라 노드: buff_support 트리는 서브타입 공용이라 모든 지원형 유닛에 대해 한 번만 계산하면 된다
  const supportLab = computeLabBonus('buff_support');
  for (const [key, sInst] of supports) {
    const grade = gradeOf(sInst);
    const supportStats = computeStats(sInst); // respects enhancement/run-upgrade/deck bonuses on the buffer itself
    const range = supportStats.range * CELL;
    const [c, r] = key.split(',').map(Number);
    const center = cellCenter(c, r);
    const lvl = levelOf(sInst.defId);
    const runLvl = state.runUpgrades[sInst.defId] || 0;
    const power = (4 + (grade.mult - 1) * 6) * (1 + lvl * ENHANCE_STAT_BONUS.atk) * (1 + runLvl * RUN_UPGRADE_STAT_BONUS.atk);
    for (const [k2, tInst] of Object.entries(state.placed)) {
      if (k2 === key) continue;
      const [c2, r2] = k2.split(',').map(Number);
      const p2 = cellCenter(c2, r2);
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

function findTargets(center, statsObj, count) {
  const inRange = state.monsters.filter(m => statsObj.fullRange || dist(center.x, center.y, m.x, m.y) <= statsObj.range * CELL);
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

// caps on transient VFX arrays: with splash/DoT/extra-attack now able to fire several
// damage instances per frame (especially against the monster cluster near the nest),
// uncapped growth here was a real source of frame drops during heavy combat
const MAX_FLOATING_TEXTS = 90;
const MAX_PARTICLES = 240;
const MAX_PROJECTILES = 150;

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
function applyAllyBuff(atkPct, aspdPct, untilTs) {
  const now = performance.now();
  if (state.allyBuff && now < state.allyBuff.until) {
    state.allyBuff.atkPct = Math.max(state.allyBuff.atkPct, atkPct);
    state.allyBuff.aspdPct = Math.max(state.allyBuff.aspdPct, aspdPct);
    state.allyBuff.until = Math.max(state.allyBuff.until, untilTs);
  } else {
    state.allyBuff = { until: untilTs, atkPct, aspdPct };
  }
}

function dealDamage(m, amount, isCrit) {
  m.hp -= amount;
  if (state.floatingTexts.length < MAX_FLOATING_TEXTS) {
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
  const crit = Math.random() * 100 < stats.critChance;
  let dmg = stats.atk * (crit ? (1 + stats.critDmg / 100) : 1);
  if ((m.kind === 'boss' || m.kind === 'mid') && stats.bossDmg) dmg *= (1 + stats.bossDmg / 100);
  if (m.kind === 'normal' && stats.normalDmgPct) dmg *= (1 + stats.normalDmgPct / 100);
  if (now < m.debuffUntil) dmg *= m.debuffAtkTakenMult; // debuff-type units mark targets to take extra damage
  dealDamage(m, dmg, crit);
  if (state.projectiles.length < MAX_PROJECTILES) {
    state.projectiles.push({ x1: center.x, y1: center.y, x2: m.x, y2: m.y, t: 0, dur: 0.15, color: crit ? '#bd9530' : '#4a72d6' });
  }
  spawnHitParticles(m.x, m.y, crit ? '#bd9530' : '#4a72d6', crit ? 6 : 3);
  if (stats.cc) applySlow(m, Math.max(0.35, 1 - stats.slow / 100 - 0.3), now + 1500);
  if (stats.debuff) applyDebuffMult(m, 1.25 + stats.debuffPct / 100, now + 2000);

  // 여파 (연구실): 주변 대상에게도 감소된 피해
  if (stats.splashPct > 0) {
    for (const other of state.monsters) {
      if (other === m) continue;
      if (dist(m.x, m.y, other.x, other.y) <= 55) {
        dealDamage(other, dmg * stats.splashPct / 100, false);
        spawnHitParticles(other.x, other.y, '#c17a41', 3);
      }
    }
  }
  // 도트 계열 (연구실): 확률로 중독/화상/출혈 등 지속피해 부여 (같은 효과는 중복 대신 갱신됨)
  if (stats.dotChance > 0 && Math.random() * 100 < stats.dotChance) {
    applyDot(m, stats.atk * 0.4);
  }
}

// 지속피해(DoT) 처리: 0.9초 간격으로 3회 틱
function tickDots(dt) {
  const now = performance.now();
  for (const m of state.monsters) {
    if (!m.dots || m.dots.length === 0) continue;
    m.dots = m.dots.filter(d => {
      if (now >= d.nextTick) {
        dealDamage(m, d.dmgPerTick, false);
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
    applyAllyBuff(15 + capstoneLvl * 2, 12 + capstoneLvl, now + 5000);
    return;
  }
  const inRange = state.monsters.filter(m => stats.fullRange || dist(center.x, center.y, m.x, m.y) <= stats.range * CELL);
  if (inRange.length === 0) return;

  if (node.activeKind === 'single') {
    inRange.sort((a, b) => dist(center.x, center.y, a.x, a.y) - dist(center.x, center.y, b.x, b.y));
    dealDamage(inRange[0], stats.atk * dmgMult, true);
  } else if (node.activeKind === 'aoe') {
    for (const m of inRange) dealDamage(m, stats.atk * dmgMult, true);
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
    state.particles.push({
      x, y, vx: Math.cos(ang) * spd, vy: Math.sin(ang) * spd,
      t: 0, dur: 0.35 + Math.random() * 0.2, color, r: 2 + Math.random() * 2.5,
    });
  }
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
    // temporary field-wide buff for every placed unit, read live in computeStats
    applyAllyBuff(25 + stats.skillDmgPct * 0.4, 20, now + 5000);
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
  } else if (def.subKey === 'atk_multi' || def.subKey === 'magic_multi') {
    for (const m of inRange) {
      dealDamage(m, stats.atk * dmgMult, true);
    }
  } else if (def.subKey === 'magic_ctrl') {
    for (const m of inRange) {
      dealDamage(m, stats.atk * dmgMult, true);
      applySlow(m, 0.05, now + 2500);
    }
  } else if (def.subKey === 'buff_debuff') {
    for (const m of inRange) {
      dealDamage(m, stats.atk * dmgMult, false);
      applyDebuffMult(m, 1.6 + stats.debuffPct / 100, now + 3000);
    }
  }
}

function tickCombat(dt) {
  updateSupportBuffs();
  const now = performance.now();
  for (const [key, inst] of Object.entries(state.placed)) {
    const def = defOf(inst);
    const stats = computeStats(inst);
    const [c, r] = key.split(',').map(Number);
    const center = cellCenter(c, r);

    if (!def.base.support) {
      inst.cooldown -= dt;
      const interval = 1 / Math.max(0.1, stats.aspd);
      // loop (capped) rather than a single if-check: at high game-speed multipliers a
      // single frame's dt can cover several of a fast unit's attack intervals, and only
      // ever allowing one attack per frame silently capped DPS well below what the
      // unit's stats promise. Capped at 30 to avoid a pathological catch-up spiral.
      let swings = 0;
      while (inst.cooldown <= 0 && swings < 30) {
        const targets = findTargets(center, stats, stats.targets);
        if (targets.length === 0) { inst.cooldown = 0; break; }
        inst.cooldown += interval;
        swings++;
        for (const m of targets) {
          resolveHit(m, inst, stats, center);
          // 추가 타격 (연구실): 확률로 사거리 내 다른 대상에게 한 번 더 공격
          if (stats.extraAtkChance > 0 && Math.random() * 100 < stats.extraAtkChance) {
            const others = findTargets(center, stats, targets.length + 1).filter(x => x !== m);
            if (others.length > 0) resolveHit(others[0], inst, stats, center);
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
  }
  tickDots(dt);
  state.monsters = state.monsters.filter(m => {
    if (m.hp <= 0) {
      onMonsterKilled(m);
      return false;
    }
    return true;
  });
}

function onMonsterKilled(m) {
  const burstColor = m.kind === 'boss' ? '#c1465f' : m.kind === 'mid' ? '#c17a41' : '#b8657a';
  spawnHitParticles(m.x, m.y, burstColor, m.kind === 'boss' ? 22 : m.kind === 'mid' ? 14 : 7);
  if (m.kind === 'mid') {
    if (Math.random() < 0.35) { state.gems += 1; log('중간보스 처치! 특수재화 +1'); pulseStat(HUD.collGemStat); }
    shakeScreen(4);
  } else if (m.kind === 'boss') {
    state.bossAliveThisWave = false; // boss defeated in time -> wave can now clear normally
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
    const slow = now < m.slowUntil ? m.slowFactor : 1;
    m.trackPos += m.speed * slow * dt;
    const p = trackPoint(m.trackPos, m.lane);
    m.x = p.x; m.y = p.y;
  }
}

// ---------------- main loop ----------------
let lastT = performance.now();
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
      if (state.monsters.length >= 50) {
        gameOver('필드에 몬스터가 50마리 이상 쌓였습니다');
      } else if (state.waveTimer <= 0) {
        endWave();
      }
    }

    // purely cosmetic effects run on real time (rawDt), not the speed-multiplied dt,
    // so hit sparks/damage numbers stay readable instead of flashing by at 10x speed
    state.projectiles = state.projectiles.filter(p => { p.t += rawDt; return p.t < p.dur; });
    for (const pt of state.particles) { pt.x += pt.vx * rawDt; pt.y += pt.vy * rawDt; pt.vx *= 0.92; pt.vy *= 0.92; pt.t += rawDt; }
    state.particles = state.particles.filter(pt => pt.t < pt.dur);
    for (const ft of state.floatingTexts) { ft.y -= 24 * rawDt; ft.t += rawDt; }
    state.floatingTexts = state.floatingTexts.filter(ft => ft.t < ft.dur);
    if (shakeTime > 0) shakeTime = Math.max(0, shakeTime - rawDt);

    updateHud();
    draw();
  }

  requestAnimationFrame(loop);
}

// ---------------- rendering (canvas) ----------------
const gradePillWidthCache = {};

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
  ctx.fillStyle = '#fbfbfd';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // outer track (monsters loop around the border, outside the placement grid)
  ctx.lineWidth = TRACK_GAP * 1.5;
  ctx.strokeStyle = '#eef1fa';
  ctx.beginPath();
  ctx.rect(TRACK_CORNERS[0].x, TRACK_CORNERS[0].y, TRACK_CORNERS[2].x - TRACK_CORNERS[0].x, TRACK_CORNERS[2].y - TRACK_CORNERS[0].y);
  ctx.stroke();
  ctx.lineWidth = 1.5;
  ctx.setLineDash([5, 5]);
  ctx.strokeStyle = 'rgba(74,114,214,0.3)';
  ctx.stroke();
  ctx.setLineDash([]);

  // placement cells (all 25 are placeable)
  for (const p of INTERIOR) {
    const key = cellKey(p.c, p.r);
    ctx.fillStyle = state.placed[key] ? '#eaf0ff' : '#ffffff';
    ctx.fillRect(MARGIN + p.c * CELL + 2, MARGIN + p.r * CELL + 2, CELL - 4, CELL - 4);
  }
  // grid lines
  for (let i = 0; i <= GRID; i++) {
    ctx.strokeStyle = '#e2e4ea';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(MARGIN + i * CELL, MARGIN); ctx.lineTo(MARGIN + i * CELL, MARGIN + GRID * CELL); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(MARGIN, MARGIN + i * CELL); ctx.lineTo(MARGIN + GRID * CELL, MARGIN + i * CELL); ctx.stroke();
  }
  // rounded borders on interior slots
  for (const p of INTERIOR) {
    ctx.strokeStyle = '#dfe2ea';
    ctx.lineWidth = 1;
    ctx.strokeRect(MARGIN + p.c * CELL + 2, MARGIN + p.r * CELL + 2, CELL - 4, CELL - 4);
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
    const [c, r] = key.split(',').map(Number);
    const { x, y } = cellCenter(c, r);
    const def = defOf(inst);
    const grade = gradeOf(inst);
    const lvl = levelOf(inst.defId);
    const runLvl = state.runUpgrades[inst.defId] || 0;

    // freshly-placed units pop in with a quick ease-out scale instead of just appearing
    const age = performance.now() - (inst.placedAt || 0);
    const popping = age < 220;
    if (popping) {
      const t = Math.min(1, age / 220);
      const scale = 0.4 + 0.6 * (1 - Math.pow(1 - t, 3));
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(scale, scale);
      ctx.translate(-x, -y);
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
    if (popping) ctx.restore();
  }

  // projectiles
  for (const p of state.projectiles) {
    const t = p.t / p.dur;
    const x = p.x1 + (p.x2 - p.x1) * t;
    const y = p.y1 + (p.y2 - p.y1) * t;
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fillStyle = p.color;
    ctx.fill();
  }

  // monsters
  for (const m of state.monsters) {
    const radius = m.kind === 'boss' ? 22 : m.kind === 'mid' ? 16 : 10;
    if (m.kind === 'boss' || m.kind === 'mid') {
      const pulse = 3 + Math.sin(performance.now() / 180) * 2;
      ctx.beginPath();
      ctx.arc(m.x, m.y, radius + pulse, 0, Math.PI * 2);
      ctx.strokeStyle = m.kind === 'boss' ? 'rgba(193,70,95,0.4)' : 'rgba(193,122,65,0.4)';
      ctx.lineWidth = 3;
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(m.x, m.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = m.kind === 'boss' ? '#c1465f' : m.kind === 'mid' ? '#c17a41' : '#b8657a';
    ctx.fill();
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2; ctx.stroke();
    // hp bar
    const w = radius * 2.2;
    const pct = Math.max(0, m.hp / m.maxHp);
    ctx.fillStyle = 'rgba(0,0,0,0.15)';
    ctx.fillRect(m.x - w / 2, m.y - radius - 9, w, 5);
    ctx.fillStyle = pct > 0.5 ? '#2fa85a' : pct > 0.2 ? '#bd9530' : '#c1465f';
    ctx.fillRect(m.x - w / 2, m.y - radius - 9, w * pct, 5);
  }

  // hit particles
  for (const pt of state.particles) {
    const life = 1 - pt.t / pt.dur;
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, pt.r * life, 0, Math.PI * 2);
    ctx.fillStyle = pt.color;
    ctx.globalAlpha = Math.max(0, life);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  // floating damage numbers
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const ft of state.floatingTexts) {
    const life = Math.max(0, 1 - ft.t / ft.dur);
    const rise = (ft.crit ? 30 : 20) * (ft.t / ft.dur);
    const pop = ft.crit ? 1 + 0.5 * Math.max(0, 1 - ft.t / 0.12) : 1;
    ctx.save();
    ctx.translate(ft.x, ft.y - rise);
    ctx.scale(pop, pop);
    ctx.globalAlpha = life;
    if (ft.crit) {
      ctx.font = '800 10px sans-serif';
      ctx.fillStyle = '#c1465f';
      ctx.fillText('CRITICAL', 0, -14);
      ctx.font = '900 19px sans-serif';
      ctx.lineWidth = 3.5; ctx.strokeStyle = '#ffffff'; ctx.lineJoin = 'round';
      ctx.strokeText(String(ft.value), 0, 0);
      ctx.fillStyle = '#c1465f';
      ctx.fillText(String(ft.value), 0, 0);
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
function syncCurrencyDisplays() {
  const goldNow = Math.floor(state.gold);
  HUD.gold.textContent = goldNow;
  if (HUD.collGem) HUD.collGem.textContent = state.gems;
  if (HUD.collCoin) HUD.collCoin.textContent = state.cardCoin;
  if (goldNow > lastGold) pulseStat(HUD.goldStat);
  if (state.gems > lastGems) pulseStat(HUD.collGemStat);
  if (state.cardCoin > lastCoin) pulseStat(HUD.collCoinStat);
  lastGold = goldNow; lastGems = state.gems; lastCoin = state.cardCoin;
}

function render() {
  syncCurrencyDisplays();
  if (state.screen === 'home') renderHome();
  if (state.screen === 'game') renderGame();
  if (state.screen === 'collection') renderCollectionScreen();
  if (state.screen === 'lab') renderLabScreen();
  if (typeof scheduleCloudSave === 'function') scheduleCloudSave();
}

function renderHome() {
  document.getElementById('bestWaveLabel').textContent = state.bestWave;
}

// runs every animation frame (not just on clicks) so the wave/timer/monster-count
// readouts actually count down live instead of freezing between UI interactions
function updateHud() {
  HUD.wave.textContent = state.wave;
  HUD.swarm.textContent = `${state.monsters.length}/50`;
  HUD.timer.textContent = state.phase === 'wave' ? Math.max(0, Math.ceil(state.waveTimer)) + 's' : '--';
  const isBossWave = state.wave > 0 && state.wave % 10 === 0;
  HUD.timerStat.classList.toggle('boss-wave', isBossWave && state.phase === 'wave');
  HUD.timerStat.classList.toggle('urgent', isBossWave && state.phase === 'wave' && state.waveTimer <= 8 && state.bossAliveThisWave);
  // early warning before the 50-monster instant game-over, mirroring the boss-timer urgency cue
  HUD.swarmStat.classList.toggle('urgent', state.monsters.length >= 40);
  syncCurrencyDisplays();
  const summonBtn = document.getElementById('summonBtn');
  if (summonBtn) summonBtn.disabled = state.gold < 10 || state.activeDeck.length === 0 || state.phase === 'gameover';
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
    div.innerHTML = unitCardHtml(inst);
    div.onclick = () => placeFromBench(idx);
    bench.appendChild(div);
  });

  const gdl = document.getElementById('gameDeckList');
  gdl.innerHTML = '';
  state.activeDeck.forEach(defId => {
    const def = UNIT_DEFS_BY_ID[defId];
    const tier = TIERS.find(t => t.id === def.tierId);
    const rl = state.runUpgrades[defId] || 0;
    const cost = runUpgradeCost(rl);
    const maxed = rl >= RUN_UPGRADE_MAX_LEVEL;
    const row = document.createElement('div');
    row.className = 'upgradeRow';
    row.innerHTML = `
      <span class="upgradeIcon" style="color:${tier.color}">${svgIcon(def.icon, 18)}</span>
      <div class="upgradeName">${def.name}${rl > 0 ? ` <span class="lvlTag">+${rl}</span>` : ''}</div>
      <button class="upgradeBtn" ${maxed || state.gold < cost || state.phase === 'gameover' ? 'disabled' : ''}>${maxed ? 'MAX' : `+${cost}G`}</button>
    `;
    row.querySelector('.upgradeBtn').onclick = () => upgradeRunType(defId);
    gdl.appendChild(row);
  });
  if (state.activeDeck.length === 0) {
    gdl.innerHTML = '<div class="hint">덱이 비어 있습니다. 카드함에서 덱을 구성하세요.</div>';
  }

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
      selEl.innerHTML = `
        <div class="unitHead">
          <span class="unitIcon" style="color:${grade.color}">${svgIcon(def.icon, 22)}</span>
          <div class="unitHeadText">
            <div class="unitName">${def.name} <span class="unitVariant">${def.variant}</span></div>
            <div class="unitSub"><span class="gradePill" style="background:${grade.color}">${inst.grade}</span>${lvl > 0 ? `<span class="lvlTag">+${lvl}</span>` : ''}</div>
          </div>
        </div>
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
  document.getElementById('gachaNormalBtn').disabled = state.cardCoin < GACHA_NORMAL_COST;
  document.getElementById('gachaGemBtn').disabled = state.gems < GACHA_GEM_COST;

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
      const tier = TIERS.find(t => t.id === def.tierId);
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
    const tier = TIERS.find(t => t.id === def.tierId);
    const entry = state.collection[defId];
    const req = enhanceRequirement(entry.level);
    const canEnhance = entry.level < ENHANCE_MAX_LEVEL && entry.count >= req;
    const isHighTier = tier.id === 'legendary' || tier.id === 'mystic';
    const inDeck = state.activeDeck.includes(defId);
    const unaddable = !inDeck && deckFull && !locked;
    const div = document.createElement('div');
    div.className = 'collCard' + (isHighTier ? ' foil' : '') + (inDeck ? ' inDeck' : '') + (locked ? ' locked' : '') + (unaddable ? ' unaddable' : '');
    div.style.borderColor = tier.color;
    div.style.boxShadow = `0 0 0 1px ${hexToRgba(tier.color, 0.2)}, 0 0 16px ${hexToRgba(tier.color, isHighTier ? 0.4 : 0.15)}`;
    const stats = previewCardStats(defId);
    div.innerHTML = `
      ${inDeck ? '<div class="deckBadge">덱 등록됨</div>' : ''}
      <div class="collIcon" style="color:${tier.color}">${svgIcon(def.icon, 30)}</div>
      <div class="collName" style="color:${tier.color}">${def.name}</div>
      <div class="collSub">${SUBTYPES[def.subKey].name}</div>
      <div class="collStats">
        <div><small>공격</small><b>${stats.atk.toFixed(1)}</b></div>
        <div><small>사거리</small><b>${stats.range.toFixed(2)}</b></div>
        <div><small>공속</small><b>${stats.aspd.toFixed(2)}</b></div>
      </div>
      <div class="collRow">보유 <b>${entry.count}</b>장 &nbsp;Lv.${entry.level}${entry.level >= ENHANCE_MAX_LEVEL ? ' (MAX)' : ''}</div>
      <button class="enhanceBtn" ${canEnhance ? '' : 'disabled'}>${entry.level >= ENHANCE_MAX_LEVEL ? '최대 강화' : `강화 (${entry.count}/${req})`}</button>
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
};
const LAB_ACTIVE_KIND_LABEL = { single: '단일 강타', aoe: '광역 폭발', freeze: '광역 빙결', curse: '광역 저주', ally: '전군 버프' };

function renderLabScreen() {
  const subKey = state.labSelectedSub;
  const tokens = state.labTokens[subKey] || 0;
  const subInfo = SUBTYPES[subKey];

  document.getElementById('labTokenLabel').textContent = tokens;
  document.getElementById('labTokenSubLabel').textContent = `${subInfo.name} 토큰`;

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
      const canAfford = unlocked && tokens >= cost;
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
        <button class="labNodeBtn" ${canAfford ? '' : 'disabled'}>${unlocked ? `강화 (${cost} 토큰)` : `Lv.${node.requires.level} 필요`}</button>
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
document.getElementById('gachaNormalBtn').onclick = gachaNormal;
document.getElementById('gachaGemBtn').onclick = gachaGem;
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
document.getElementById('gotoCollectionBtn').onclick = () => showScreen('collection');
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

function init() {
  for (const defId of startingDeck()) {
    state.collection[defId] = { count: 1, level: 0 };
    state.activeDeck.push(defId);
  }
  updateDeckBonus();
  applyStaticIcons();
  render();
}
init();
requestAnimationFrame(loop);
