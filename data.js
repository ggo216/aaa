// ===================== AAA Defense - Data Definitions =====================

// ---- Grade system (rolled when a unit is SUMMONED onto the field) ----
const GRADES = [
  { id: 'E',   mult: 1.00, weight: 40,  color: '#8a8f9c' },
  { id: 'D',   mult: 1.18, weight: 25,  color: '#3c9c68' },
  { id: 'C',   mult: 1.42, weight: 15,  color: '#3182c4' },
  { id: 'B',   mult: 1.75, weight: 10,  color: '#6767c4' },
  { id: 'A',   mult: 2.25, weight: 6,   color: '#9660bd' },
  { id: 'S',   mult: 3.00, weight: 2.3, color: '#bd9530', fullRange: true },
  { id: 'SS',  mult: 4.20, weight: 1.0, color: '#c17a41', fullRange: true },
  { id: 'SSS', mult: 6.00, weight: 0.3, color: '#c1465f', fullRange: true },
];
const GRADE_SELL_PRICE = { E: 3, D: 5, C: 10, B: 20, A: 35, S: 60, SS: 100, SSS: 300 };
const BULK_SELL_MAX_GRADE = 'A'; // bulk-sell only allowed up to grade A

// ---- Tier system (the unit CARD's rarity, unlocked into the deck) ----
const TIERS = [
  { id: 'normal',    name: '노멀',     mult: 1.0, color: '#7b8291', weight: 45 },
  { id: 'rare',      name: '레어',     mult: 1.35, color: '#2f8ab8', weight: 28 },
  { id: 'epic',      name: '에픽',     mult: 1.85, color: '#8266bd', weight: 16 },
  { id: 'unique',    name: '유니크',   mult: 2.6, color: '#c14e93', weight: 7 },
  { id: 'legendary', name: '레전더리', mult: 3.6, color: '#c1863a', weight: 3 },
  { id: 'mystic',    name: '미스틱',   mult: 5.2, color: '#c14545', weight: 1 },
];

// ---- Card enhancement (spend duplicate cards to permanently boost a card's base stats) ----
const ENHANCE_BASE_COST = 3;   // duplicates required for level 1 -> level 2
const ENHANCE_COST_STEP = 2;   // extra duplicates required per level
const ENHANCE_STAT_BONUS = { atk: 0.07, range: 0.045, aspd: 0.05 }; // +% per level
const ENHANCE_MAX_LEVEL = 10;
function enhanceRequirement(level) { return ENHANCE_BASE_COST + level * ENHANCE_COST_STEP; }

// ---- Subtypes (4 categories -> 7 subtypes total) ----
const SUBTYPES = {
  atk_single:   { cat: 'attack', name: '공격형-단일',   icon: 'slash',      range: 1.4, atk: 3.4, aspd: 1.0, targets: 1, splash: 0 },
  atk_multi:    { cat: 'attack', name: '공격형-다중',   icon: 'multislash', range: 1.3, atk: 1.4, aspd: 1.0, targets: 4, splash: 0.9 },
  magic_multi:  { cat: 'magic',  name: '마법형-다중',   icon: 'arcane',     range: 2.2, atk: 1.1, aspd: 0.9, targets: 5, splash: 1.1 },
  magic_ctrl:   { cat: 'magic',  name: '마법형-제어',   icon: 'frost',      range: 2.1, atk: 0.6, aspd: 0.9, targets: 5, splash: 1.1, cc: true },
  ranged_single:{ cat: 'ranged', name: '원거리-단일',   icon: 'arrow',      range: 3.2, atk: 1.8, aspd: 2.2, targets: 1, splash: 0 },
  buff_debuff:  { cat: 'buff',   name: '버프형-디버프', icon: 'debuff',     range: 1.6, atk: 0.5, aspd: 1.0, targets: 1, splash: 0, debuff: true },
  buff_support: { cat: 'buff',   name: '버프형-지원',   icon: 'buff',       range: 1.8, atk: 0.2, aspd: 0.6, targets: 1, splash: 0, support: true },
};

const TRAIT_POOL = [
  { key: 'critChance', label: '치명타 확률', fmt: v => `치확+${v}%` },
  { key: 'critDmg',    label: '치명타 피해', fmt: v => `치피+${v}%` },
  { key: 'range',      label: '사거리',      fmt: v => `사거리+${v}%` },
  { key: 'aspd',       label: '공격속도',    fmt: v => `공속+${v}%` },
  { key: 'atk',        label: '공격력',      fmt: v => `공격력+${v}%` },
  { key: 'bossDmg',    label: '보스 피해',   fmt: v => `보스피해+${v}%` },
  { key: 'slow',       label: '둔화 강도',   fmt: v => `둔화+${v}%` },
  { key: 'targets',    label: '타격 대상',   fmt: v => `대상+${v}` },
];

const VARIANT_NAMES = ['I', 'II', 'III'];
const NAME_PARTS = {
  atk_single: ['글라디우스', '베르세르크', '단두대'],
  atk_multi: ['윈드밀', '헤일스톰', '분쇄자'],
  magic_multi: ['아르카나', '메테오', '프리즘'],
  magic_ctrl: ['프로스트', '체인로크', '블리자드'],
  ranged_single: ['스나이퍼', '레이븐', '이글아이'],
  buff_debuff: ['커스', '위더', '헥스'],
  buff_support: ['오라클', '벡스틸러', '세인트'],
};

// Build the full unit-card catalogue: 6 tiers x 7 subtypes x 3 variants = 126 cards
const UNIT_DEFS = [];
(function buildCatalogue() {
  let uid = 0;
  for (const tier of TIERS) {
    for (const subKey of Object.keys(SUBTYPES)) {
      const sub = SUBTYPES[subKey];
      // single-target subtypes must never roll the "targets" trait, or a unit
      // explicitly designed to hit one enemy would silently become multi-target
      const eligibleTraits = sub.targets <= 1 ? TRAIT_POOL.filter(t => t.key !== 'targets') : TRAIT_POOL;
      for (let v = 0; v < 3; v++) {
        const trait1 = eligibleTraits[(v + TIERS.indexOf(tier) * 2) % eligibleTraits.length];
        const trait2 = eligibleTraits[(v + TIERS.indexOf(tier) * 2 + 3) % eligibleTraits.length];
        const traitScale = 6 + TIERS.indexOf(tier) * 4 + v * 3; // growing bonus %
        uid++;
        UNIT_DEFS.push({
          id: `u${uid}`,
          tierId: tier.id,
          subKey,
          cat: sub.cat,
          name: `${tier.name} ${NAME_PARTS[subKey][v]}`,
          icon: sub.icon,
          variant: VARIANT_NAMES[v],
          base: {
            hp: 1,
            atk: sub.atk * tier.mult,
            range: sub.range * (1 + (TIERS.indexOf(tier)) * 0.06),
            aspd: sub.aspd,
            targets: sub.targets,
            splash: sub.splash,
            cc: !!sub.cc,
            debuff: !!sub.debuff,
            support: !!sub.support,
          },
          traits: [
            { ...trait1, value: traitScale },
            { ...trait2, value: Math.round(traitScale * 0.7) },
          ],
        });
      }
    }
  }
})();

function weightedPick(items, weightFn) {
  const total = items.reduce((s, it) => s + weightFn(it), 0);
  let r = Math.random() * total;
  for (const it of items) {
    r -= weightFn(it);
    if (r <= 0) return it;
  }
  return items[items.length - 1];
}

function rollGrade() {
  return weightedPick(GRADES, g => g.weight);
}

function rollCardTier() {
  return weightedPick(TIERS, t => t.weight);
}
