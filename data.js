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

// ---- Subtypes (4 categories -> 7 subtypes total, now 9 with healer/tanker) ----
// range values were nerfed ~20% across the board once already, then an additional 5%
// on top of that (all subtypes, proportionally)
// hpMult: multiplier on the shared unit-HP base formula (see computeStats' maxHp calc
// in game.js) — tanker is built to soak hits, ranged/support are glass, others baseline
const SUBTYPES = {
  atk_single:   { cat: 'attack', name: '공격형-단일',   icon: 'slash',      range: 1.05, atk: 3.4, aspd: 1.0, targets: 1, splash: 0, hpMult: 1.1,
    desc: '가장 가까운 적 1명에게 강력한 단일 공격, 확률로 폭탄을 부착해 지연 폭발시킴', short: '단일 강공격 + 폭탄 부착' },
  atk_multi:    { cat: 'attack', name: '공격형-다중',   icon: 'multislash', range: 0.95, atk: 1.4, aspd: 1.0, targets: 4, splash: 0.9, hpMult: 1.0,
    desc: '여러 적 동시 공격 + 스플래시, 확률로 더 큰 폭발 피해와 짧은 화면 흔들림', short: '다중 공격 + 대폭발 확률' },
  magic_multi:  { cat: 'magic',  name: '마법형-다중',   icon: 'fire',       range: 1.71, atk: 1.1, aspd: 0.9, targets: 5, splash: 1.1, hpMult: 0.9,
    desc: '다수의 적에게 마법 공격 + 확률로 화상(지속피해)과 잔류 화염지대 생성', short: '화상 + 화염지대' },
  magic_ctrl:   { cat: 'magic',  name: '마법형-제어',   icon: 'frost',      range: 1.62, atk: 0.6, aspd: 0.9, targets: 5, splash: 1.1, cc: true, hpMult: 0.9,
    desc: '공격한 적을 둔화시킴, 서리 3중첩 시 강력한 결빙(1초)', short: '둔화, 3스택 시 결빙' },
  ranged_single:{ cat: 'ranged', name: '원거리-단일',   icon: 'bolt',       range: 2.47, atk: 1.8, aspd: 2.2, targets: 1, splash: 0, hpMult: 0.75,
    desc: '매우 긴 사거리에서 단일 대상을 저격, 확률로 번개가 맵 전역 무작위 적을 추가 타격', short: '저격 + 무작위 번개' },
  buff_debuff:  { cat: 'buff',   name: '버프형-디버프', icon: 'debuff',     range: 1.24, atk: 0.5, aspd: 1.0, targets: 1, splash: 0, debuff: true, hpMult: 0.85,
    desc: '공격한 적에게 저주를 부여, 확률로 역병지대를 남겨 둔화+지속피해', short: '저주 + 역병지대' },
  buff_support: { cat: 'buff',   name: '버프형-지원',   icon: 'buff',       range: 1.33, atk: 0.2, aspd: 0.6, targets: 1, splash: 0, support: true, hpMult: 0.8,
    desc: '아군에게 버프(오라) 부여, 스킬 발동 시 캐스터 주변 지역에 강화 버프 지대를 전개 + 보조 터렛 소환', short: '지역 버프 + 보조터렛' },
  heal_support: { cat: 'support', name: '지원형-힐러',  icon: 'heart',      range: 1.35, atk: 0.35, aspd: 0.55, targets: 1, splash: 0, hpMult: 1.2,
    desc: '주기적으로 사거리 내 피해를 입은 아군을 치유, 스킬 발동 시 대량 치유', short: '아군 지속 치유' },
  tank_guard:   { cat: 'guard',  name: '수호형-탱커',   icon: 'shield',     range: 0.55, atk: 0.3, aspd: 0.7, targets: 1, splash: 0, guard: true, hpMult: 2.6,
    desc: '근처 아군의 피해를 경감시키는 보호막 오라를 상시 전개, 매우 튼튼함', short: '피해 경감 오라 + 높은 체력' },
};

// ---- Legendary+ active skills (레전더리/미스틱 등급 카드 전용, 일정 주기마다 자동 발동) ----
const SKILL_INTERVAL = 10; // seconds between activations
const LEGENDARY_SKILLS = {
  atk_single:   { name: '필살 일격', desc: '가장 가까운 적에게 강력한 추가 피해', dmgMult: 3.0 },
  // 광란(frenzy): 순간 피해 대신 자신의 공격속도를 짧게 폭증시키는 자가 버프로 변경
  atk_multi:    { name: '광란', desc: '짧은 시간 자신의 공격속도가 폭발적으로 증가 (+200%)', frenzy: true },
  magic_multi:  { name: '메테오 폭격', desc: '사거리 내 다수의 적에게 폭발 피해', dmgMult: 1.8 },
  magic_ctrl:   { name: '절대영도', desc: '사거리 내 모든 적을 강하게 둔화', dmgMult: 0.6, freeze: true },
  ranged_single:{ name: '관통사격', desc: '일직선상의 적 3명을 관통 저격', dmgMult: 2.2 },
  // 연쇄 저주 폭발(multi-burst): 짧은 시간 동안 여러 번의 보너스 공격을 몰아친다
  buff_debuff:  { name: '연쇄 저주 폭발', desc: '사거리 내 적에게 저주를 실은 보너스 공격을 5연속 가함', burst: true },
  buff_support: { name: '축복의 지대', desc: '캐스터 주변 지역에 강력한 버프 지대를 전개', ally: true },
  heal_support: { name: '기적의 치유', desc: '사거리 내 모든 아군을 대량으로 치유', healMult: 3.0 },
  tank_guard:   { name: '불굴의 방벽', desc: '사거리 내 아군에게 강력한 피해감소 보호막 부여', ally: true, shield: true },
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
  // capstone activeKind 'bomb': 폭탄 부착(지연 후 광역 폭발) — 즉시 단일 강타 대신
  // 대상에게 폭탄을 부착해 짧은 지연 뒤 주변에 폭발 피해를 입히는 별도 메커니즘
  atk_single: [
    passiveNode('root', '예리한 칼날', 'slash', 'atkPct', 1.4, null),
    passiveNode('branchA', '일격필살', 'target', 'critChanceAdd', 1.3, 'root', 3),
    passiveNode('branchB', '쾌속 연격', 'fastfwd', 'aspdPct', 1.2, 'root', 3),
    passiveNode('leafA', '처형자의 원한', 'debuff', 'normalDmgPct', 2.0, 'branchA', 3),
    passiveNode('leafB', '추가 타격', 'multislash', 'extraAtkChance', 0.57, 'branchB', 3),
    activeNode('capstone', '폭탄 부착', 'bolt', 'leafB', 3, 'bomb', 0.6),
  ],
  // capstone activeKind 'tornado': 정적인 광역 폭발 대신 경로를 따라 이동하며 지속피해를
  // 주는 회오리를 소환 — 기존 다른 지대 효과(화염/역병)와 달리 스스로 이동한다는 점이 핵심
  atk_multi: [
    passiveNode('root', '광역 숙련', 'multislash', 'atkPct', 1.4, null),
    passiveNode('branchA', '치명 연쇄', 'target', 'critChanceAdd', 1.3, 'root', 3),
    passiveNode('branchB', '쾌속 난타', 'fastfwd', 'aspdPct', 1.2, 'root', 3),
    passiveNode('leafA', '여파', 'sparkle', 'splashPct', 2.2, 'branchA', 3),
    passiveNode('leafB', '유혈', 'debuff', 'dotChance', 0.95, 'branchB', 3),
    activeNode('capstone', '회오리 소환', 'bolt', 'leafB', 3, 'tornado', 0.35),
  ],
  // capstone activeKind 'meteor': 즉시 광역 피해 대신 착탄 지점을 미리 표시(텔레그래프)한 뒤
  // 지연시간 후 떨어지는 진짜 "메테오" — 이름값에 맞는 실제 메커니즘으로 교체
  magic_multi: [
    passiveNode('root', '마력 증폭', 'arcane', 'atkPct', 1.4, null),
    passiveNode('branchA', '치명 마력', 'target', 'critChanceAdd', 1.3, 'root', 3),
    passiveNode('branchB', '시전 가속', 'fastfwd', 'aspdPct', 1.2, 'root', 3),
    passiveNode('leafA', '화염 낙인', 'debuff', 'dotChance', 0.95, 'branchA', 3),
    passiveNode('leafB', '연쇄 폭발', 'sparkle', 'splashPct', 2.2, 'branchB', 3),
    activeNode('capstone', '메테오 소환', 'bolt', 'leafB', 3, 'meteor', 0.45),
  ],
  magic_ctrl: [
    passiveNode('root', '냉기 마력', 'frost', 'atkPct', 1.4, null),
    passiveNode('branchA', '혹한 강화', 'frost', 'slowAdd', 1.3, 'root', 3),
    passiveNode('branchB', '시전 가속', 'fastfwd', 'aspdPct', 1.2, 'root', 3),
    passiveNode('leafA', '서리 폭발', 'sparkle', 'splashPct', 2.0, 'branchA', 3),
    passiveNode('leafB', '동상', 'debuff', 'dotChance', 0.86, 'branchB', 3),
    activeNode('capstone', '절대영도 강림', 'bolt', 'leafB', 3, 'freeze', 0.3),
  ],
  // capstone activeKind 'laser': 단일 대상 강타 대신 관통형 레이저 빔 — 조준선 상의 모든
  // 적을 한 번에 관통 타격하는, 두꺼운 빔으로 표현되는 별도 시각/메커니즘
  ranged_single: [
    passiveNode('root', '정밀 조준', 'arrow', 'atkPct', 1.4, null),
    passiveNode('branchA', '치명 사격', 'target', 'critChanceAdd', 1.3, 'root', 3),
    passiveNode('branchB', '속사', 'fastfwd', 'aspdPct', 1.2, 'root', 3),
    passiveNode('leafA', '보스 헌터', 'target', 'bossDmgPct', 2.0, 'branchA', 3),
    passiveNode('leafB', '이중 사격', 'arrow', 'extraAtkChance', 0.57, 'branchB', 3),
    activeNode('capstone', '관통 레이저', 'bolt', 'leafB', 3, 'laser', 0.7),
  ],
  buff_debuff: [
    passiveNode('root', '저주술 연마', 'debuff', 'atkPct', 1.4, null),
    passiveNode('branchA', '약화 강화', 'debuff', 'debuffPct', 1.3, 'root', 3),
    passiveNode('branchB', '저주 범위 확장', 'sparkle', 'rangePct', 1.2, 'root', 3),
    passiveNode('leafA', '역병', 'debuff', 'dotChance', 1.05, 'branchA', 3),
    passiveNode('leafB', '파멸의 표식', 'target', 'bossDmgPct', 2.0, 'branchB', 3),
    activeNode('capstone', '대재앙', 'bolt', 'leafB', 3, 'curse', 0.3),
  ],
  buff_support: [
    passiveNode('root', '축복의 오라', 'buff', 'atkPct', 1.0, null),
    passiveNode('branchA', '치명 축복', 'target', 'auraCritChance', 1.3, 'root', 3),
    passiveNode('branchB', '가속 오라', 'fastfwd', 'aspdPct', 1.2, 'root', 3),
    passiveNode('leafA', '파괴 축복', 'target', 'auraCritDmg', 2.0, 'branchA', 3),
    passiveNode('leafB', '용맹의 축복', 'target', 'auraBossDmg', 1.5, 'branchB', 3),
    // capstone activeKind 'ally': 이제 전군이 아니라 캐스터 주변 지역(버프 지대)에만 적용됨 — 오라클 리워크
    activeNode('capstone', '천군만마', 'bolt', 'leafB', 3, 'ally', 0),
  ],
  heal_support: [
    passiveNode('root', '생명의 손길', 'heart', 'atkPct', 1.4, null),
    passiveNode('branchA', '치유 가속', 'fastfwd', 'aspdPct', 1.2, 'root', 3),
    passiveNode('branchB', '치유 범위 확장', 'sparkle', 'rangePct', 1.2, 'root', 3),
    passiveNode('leafA', '응급 처치', 'heart', 'healPct', 2.2, 'branchA', 3),
    passiveNode('leafB', '보호의 기운', 'shield', 'shieldPct', 1.0, 'branchB', 3),
    activeNode('capstone', '대치유', 'bolt', 'leafB', 3, 'heal', 0.5),
  ],
  tank_guard: [
    passiveNode('root', '철벽 방어', 'shield', 'atkPct', 1.4, null),
    passiveNode('branchA', '생명력 강화', 'heart', 'guardHpPct', 2.0, 'root', 3),
    passiveNode('branchB', '기민한 반응', 'fastfwd', 'aspdPct', 1.2, 'root', 3),
    passiveNode('leafA', '피해 분산', 'shield', 'shieldPct', 1.3, 'branchA', 3),
    passiveNode('leafB', '도발의 기백', 'target', 'critChanceAdd', 1.3, 'branchB', 3),
    activeNode('capstone', '철벽 선언', 'bolt', 'leafB', 3, 'guard', 0.4),
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
  heal_support: ['세라핌', '메디쿠스', '라이프스프링'],
  tank_guard: ['아이언월', '바스티온', '가디언'],
};

// Build the full unit-card catalogue: 6 tiers x 9 subtypes x 3 variants = 162 cards
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
            guard: !!sub.guard,
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
