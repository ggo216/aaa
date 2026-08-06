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
  atk_single:   { cat: 'attack', name: '공격형-단일',   icon: 'slash',      range: 1.4, atk: 3.4, aspd: 1.0, targets: 1, splash: 0,
    desc: '가장 가까운 적 1명에게 강력한 단일 공격', short: '단일 강공격' },
  atk_multi:    { cat: 'attack', name: '공격형-다중',   icon: 'multislash', range: 1.3, atk: 1.4, aspd: 1.0, targets: 4, splash: 0.9,
    desc: '여러 적 동시 공격 + 스플래시, 확률로 더 큰 폭발 피해와 짧은 화면 흔들림', short: '다중 공격 + 대폭발 확률' },
  magic_multi:  { cat: 'magic',  name: '마법형-다중',   icon: 'fire',       range: 2.2, atk: 1.1, aspd: 0.9, targets: 5, splash: 1.1,
    desc: '다수의 적에게 마법 공격 + 확률로 화상(지속피해)과 잔류 화염지대 생성', short: '화상 + 화염지대' },
  magic_ctrl:   { cat: 'magic',  name: '마법형-제어',   icon: 'frost',      range: 2.1, atk: 0.6, aspd: 0.9, targets: 5, splash: 1.1, cc: true,
    desc: '공격한 적을 둔화시킴, 서리 3중첩 시 강력한 결빙(1초)', short: '둔화, 3스택 시 결빙' },
  ranged_single:{ cat: 'ranged', name: '원거리-단일',   icon: 'bolt',       range: 3.2, atk: 1.8, aspd: 2.2, targets: 1, splash: 0,
    desc: '매우 긴 사거리에서 단일 대상을 저격, 확률로 번개가 맵 전역 무작위 적을 추가 타격', short: '저격 + 무작위 번개' },
  buff_debuff:  { cat: 'buff',   name: '버프형-디버프', icon: 'debuff',     range: 1.6, atk: 0.5, aspd: 1.0, targets: 1, splash: 0, debuff: true,
    desc: '공격한 적에게 저주를 부여, 확률로 역병지대를 남겨 둔화+지속피해', short: '저주 + 역병지대' },
  buff_support: { cat: 'buff',   name: '버프형-지원',   icon: 'buff',       range: 1.8, atk: 0.2, aspd: 0.6, targets: 1, splash: 0, support: true,
    desc: '아군에게 버프(오라) 부여, 스킬 발동 시 보조 터렛을 함께 소환', short: '아군 버프 + 보조터렛' },
};

// ---- Legendary+ active skills (레전더리/미스틱 등급 카드 전용, 일정 주기마다 자동 발동) ----
const SKILL_INTERVAL = 10; // seconds between activations
const LEGENDARY_SKILLS = {
  atk_single:   { name: '필살 일격', desc: '가장 가까운 적에게 강력한 추가 피해', dmgMult: 3.0 },
  atk_multi:    { name: '회전베기', desc: '사거리 내 모든 적에게 광역 피해', dmgMult: 1.4 },
  magic_multi:  { name: '메테오 폭격', desc: '사거리 내 다수의 적에게 폭발 피해', dmgMult: 1.8 },
  magic_ctrl:   { name: '절대영도', desc: '사거리 내 모든 적을 강하게 둔화', dmgMult: 0.6, freeze: true },
  ranged_single:{ name: '관통사격', desc: '일직선상의 적 3명을 관통 저격', dmgMult: 2.2 },
  buff_debuff:  { name: '저주 각인', desc: '사거리 내 모든 적에게 강력한 저주 부여', dmgMult: 0.5, curse: true },
  buff_support: { name: '전군 강화', desc: '모든 아군에게 짧은 시간 강력한 버프 부여', ally: true },
};

// ---- 연구실 (Research Lab): per-subtype skill trees, shared by every owned card of
// that subtype regardless of individual card tier/grade. No max level on any node;
// each level adds a small flat bonus. Tokens earned when a CARD's enhancement level
// increases (2 tokens per level-up), spent per subtype.
//
// tree shape (mastery gating): root -> branchA/branchB (need root Lv.3) -> leafA/leafB
// (need their branch Lv.3) -> capstone "active" node (need leafB Lv.3), an independent
// periodic burst skill available to ANY card of that subtype once unlocked, regardless
// of card tier — a normal-tier card can eventually nuke just from lab investment.
const LAB_BASE_COST = 3;
const LAB_COST_STEP = 1;
function labNodeCost(level) { return LAB_BASE_COST + level * LAB_COST_STEP; }
const LAB_ACTIVE_INTERVAL = 15; // seconds, for capstone active-skill nodes

function passiveNode(id, name, icon, effectKey, perLevel, requiresId, requiresLevel) {
  return { id, name, icon, type: 'passive', effectKey, perLevel, requires: requiresId ? { id: requiresId, level: requiresLevel } : null };
}
function activeNode(id, name, icon, requiresId, requiresLevel, kind, dmgMultPerLevel) {
  return { id, name, icon, type: 'active', effectKey: 'skillDmgPct', perLevel: dmgMultPerLevel, activeKind: kind, requires: { id: requiresId, level: requiresLevel } };
}

const LAB_TREES = {
  atk_single: [
    passiveNode('root', '예리한 칼날', 'slash', 'atkPct', 1.4, null),
    passiveNode('branchA', '일격필살', 'target', 'critChanceAdd', 1.3, 'root', 3),
    passiveNode('branchB', '쾌속 연격', 'fastfwd', 'aspdPct', 1.2, 'root', 3),
    passiveNode('leafA', '처형자의 원한', 'debuff', 'normalDmgPct', 2.0, 'branchA', 3),
    passiveNode('leafB', '추가 타격', 'multislash', 'extraAtkChance', 0.6, 'branchB', 3),
    activeNode('capstone', '심판의 일격', 'bolt', 'leafB', 3, 'single', 0.6),
  ],
  atk_multi: [
    passiveNode('root', '광역 숙련', 'multislash', 'atkPct', 1.4, null),
    passiveNode('branchA', '치명 연쇄', 'target', 'critChanceAdd', 1.3, 'root', 3),
    passiveNode('branchB', '쾌속 난타', 'fastfwd', 'aspdPct', 1.2, 'root', 3),
    passiveNode('leafA', '여파', 'sparkle', 'splashPct', 2.2, 'branchA', 3),
    passiveNode('leafB', '유혈', 'debuff', 'dotChance', 1.0, 'branchB', 3),
    activeNode('capstone', '대지 붕괴', 'bolt', 'leafB', 3, 'aoe', 0.35),
  ],
  magic_multi: [
    passiveNode('root', '마력 증폭', 'arcane', 'atkPct', 1.4, null),
    passiveNode('branchA', '치명 마력', 'target', 'critChanceAdd', 1.3, 'root', 3),
    passiveNode('branchB', '시전 가속', 'fastfwd', 'aspdPct', 1.2, 'root', 3),
    passiveNode('leafA', '화염 낙인', 'debuff', 'dotChance', 1.0, 'branchA', 3),
    passiveNode('leafB', '연쇄 폭발', 'sparkle', 'splashPct', 2.2, 'branchB', 3),
    activeNode('capstone', '메테오 소환', 'bolt', 'leafB', 3, 'aoe', 0.45),
  ],
  magic_ctrl: [
    passiveNode('root', '냉기 마력', 'frost', 'atkPct', 1.4, null),
    passiveNode('branchA', '혹한 강화', 'frost', 'slowAdd', 1.3, 'root', 3),
    passiveNode('branchB', '시전 가속', 'fastfwd', 'aspdPct', 1.2, 'root', 3),
    passiveNode('leafA', '서리 폭발', 'sparkle', 'splashPct', 2.0, 'branchA', 3),
    passiveNode('leafB', '동상', 'debuff', 'dotChance', 0.9, 'branchB', 3),
    activeNode('capstone', '절대영도 강림', 'bolt', 'leafB', 3, 'freeze', 0.3),
  ],
  ranged_single: [
    passiveNode('root', '정밀 조준', 'arrow', 'atkPct', 1.4, null),
    passiveNode('branchA', '치명 사격', 'target', 'critChanceAdd', 1.3, 'root', 3),
    passiveNode('branchB', '속사', 'fastfwd', 'aspdPct', 1.2, 'root', 3),
    passiveNode('leafA', '보스 헌터', 'target', 'bossDmgPct', 2.0, 'branchA', 3),
    passiveNode('leafB', '이중 사격', 'arrow', 'extraAtkChance', 0.6, 'branchB', 3),
    activeNode('capstone', '궁극 저격', 'bolt', 'leafB', 3, 'single', 0.7),
  ],
  buff_debuff: [
    passiveNode('root', '저주술 연마', 'debuff', 'atkPct', 1.4, null),
    passiveNode('branchA', '약화 강화', 'debuff', 'debuffPct', 1.3, 'root', 3),
    passiveNode('branchB', '저주 범위 확장', 'sparkle', 'rangePct', 1.2, 'root', 3),
    passiveNode('leafA', '역병', 'debuff', 'dotChance', 1.1, 'branchA', 3),
    passiveNode('leafB', '파멸의 표식', 'target', 'bossDmgPct', 2.0, 'branchB', 3),
    activeNode('capstone', '대재앙', 'bolt', 'leafB', 3, 'curse', 0.3),
  ],
  buff_support: [
    passiveNode('root', '축복의 오라', 'buff', 'atkPct', 1.0, null),
    passiveNode('branchA', '치명 축복', 'target', 'auraCritChance', 1.3, 'root', 3),
    passiveNode('branchB', '가속 오라', 'fastfwd', 'aspdPct', 1.2, 'root', 3),
    passiveNode('leafA', '파괴 축복', 'target', 'auraCritDmg', 2.0, 'branchA', 3),
    passiveNode('leafB', '용맹의 축복', 'target', 'auraBossDmg', 1.5, 'branchB', 3),
    activeNode('capstone', '천군만마', 'bolt', 'leafB', 3, 'ally', 0),
  ],
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
          // tier is already conveyed visually everywhere (border/pill color, foil glow),
          // so baking the tier name into the text label just made every name long
          name: NAME_PARTS[subKey][v],
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
