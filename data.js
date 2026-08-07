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

// ===================== 유닛 성장 / 전직 시스템 (unit level & job advancement) =====================
// 필드에 배치된 유닛은 몬스터를 처치하며 경험치를 얻는다. 단독 처치는 경험치 100%,
// 여러 유닛이 피해를 주거나 버프/치유/보호막으로 도왔다면 기여자 수로 1/n 분배된다
// (game.js의 addXpContributor / onMonsterKilled 참고).
//
// 레벨은 RUN 단위(런이 끝나면 초기화 — 배치/대기 유닛과 동일한 수명)이며 최대 30.
// 10/20/30 레벨에서 2차/3차/4차 전직이 자동 발동한다. 갈래(branch) 선택은 2차 때
// 단 한 번, 무작위로 결정되고 3·4차는 그 갈래를 더 깊게 파고든다.
const MAX_UNIT_LEVEL = 30;
const JOB_TIER_LEVELS = [10, 20, 30]; // 2차 / 3차 / 4차 전직 레벨

// 레벨당 소폭 상승하는 전체 스탯 (ENHANCE_STAT_BONUS와 동일한 "레벨당 +%" 패턴이지만,
// 10레벨짜리 강화 시스템보다 훨씬 긴 1~30 곡선이라 레벨당 폭은 더 작다)
const JOB_LEVEL_STAT_BONUS = { atk: 0.022, range: 0.008, aspd: 0.012, hp: 0.020 };
// 전직 차수 자체가 주는 추가 배율 (index = jobTier, 1=기본 / 2·3·4=전직)
const JOB_TIER_ATK_BONUS = [0, 0, 0.15, 0.34, 0.60];
const JOB_TIER_HP_BONUS = [0, 0, 0.12, 0.28, 0.50];
// 전직 차수마다 레전더리/연구실 스킬 위력도 함께 강화된다 (skillDmgPct에 합산)
const JOB_TIER_SKILL_DMG = [0, 0, 25, 60, 110];

// 다음 레벨까지 필요한 경험치 (누적 아님).
// 지수 곡선(1.17^n)을 먼저 써봤다가 폐기했다: 웨이브당 경험치 수입은 대략 "선형"으로
// 늘어나므로 누적 수입은 웨이브 수의 제곱에 가깝게 자라는데, 지수 요구량은 그보다
// 훨씬 빨리 도망가서 실측상 13웨이브에 겨우 8레벨 — 3차/4차 전직을 런 안에서 아예
// 볼 수 없었다. 선형 증가(=누적 요구량이 2차식)로 바꾸면 요구량과 수입이 같은 차수로
// 자라서, 10/20/30레벨 전직이 대략 10/20/30웨이브 근처에 자연스럽게 걸린다.
// 계수는 실측으로 두 번 조정했다. 처음의 가파른 선형(18+14n)은 여전히 뒤로 갈수록
// 수입을 앞질러서 19웨이브에 15레벨에 그쳤다 — 웨이브당 수입 증가가 기대만큼 가파르지
// 않았기 때문(웨이브당 몬스터 수는 거의 일정하고 웨이브 길이도 길어진다).
// 거의 평탄한 증가로 낮춰 요구량 곡선을 실제 수입 곡선(대략 W^1.3)에 맞춘다.
// 누적: 10레벨까지 639, 20레벨까지 1729, 30레벨까지 3219 (비율 1 : 2.7 : 5.0).
function unitXpToNext(level) { return 55 + (level - 1) * 4; }

// 몬스터가 주는 경험치 — 골드 공식(1 + wave/4)과 같은 결에서, 중간보스/보스는 훨씬 큼.
// 계수는 "9유닛 만원 필드(= 모든 킬이 9등분되는 최악의 분배 조건)"에서 위 곡선과 맞물려
// 10/20/30웨이브 무렵 각 전직이 걸리도록 실측으로 맞춘 값이다. 유닛을 적게 깔면 1/n의
// n이 작아져 훨씬 빨리 큰다 — 의도된 트레이드오프.
function monsterXpValue(wave, kind) {
  // 2차항을 조금 섞어 후반 웨이브의 수입이 난이도 상승과 함께 따라 오르게 한다 —
  // 순수 선형이면 20/30웨이브대 수입이 3·4차 전직 요구량을 못 따라잡는다
  const base = 13 + wave * 3.0 + wave * wave * 0.06;
  if (kind === 'boss') return base * 26;
  if (kind === 'mid') return base * 8;
  return base;
}

// ---- 9개 서브타입 × 2갈래 = 18개 전직 설계 ----
// 각 갈래는 해당 서브타입이 "이미 가진" 메커니즘(폭탄 부착 / 광란 / 화염지대 / 서리스택 /
// 번개 연쇄 / 저주·역병 / 버프지대·터렛 / 치유 / 도발·보호막)에서 뻗어 나오며,
// 한쪽은 순수 파괴력·폭발, 다른 한쪽은 유틸리티·제어·지원 쪽으로 확실히 갈린다.
// stat: 전직 "차수 1단계당" 붙는 수치 보정 (2차=×1, 3차=×2, 4차=×3)
const JOB_BRANCHES = {
  atk_single: [
    // 보스 학살형: 공속을 크게 희생하는 대신 한 방이 무겁다. 일반 몹은 처형으로 즉시
    // 지우고, 처형이 통하지 않는 보스/중간보스에게는 대신 "처형 각인"을 누적시켜
    // 아군 전체가 주는 피해를 계속 키운다 — 느린 공속 / 큰 한 방 / 보스 특화의 축.
    { id: 'as_exec', name: '처형자', short: '처형·보스 학살', tiers: ['사형집행인', '단두대', '종언의 심판'],
      desc: '느리지만 압도적으로 무거운 한 방. 체력이 낮은 일반 적은 즉시 베어내고, 처형이 통하지 않는 보스에게는 처형 각인을 누적시켜 받는 피해를 계속 키운다',
      stat: { atkPct: 15, aspdPct: -8, critAdd: 4, critDmgAdd: 16, bossAdd: 15 } },
    // 일반형: 빠른 공속 + 광역 폭발 + 일반 몬스터 특화. 보스 앞에서는 처형자에게 밀리지만
    // 물량 웨이브를 통째로 지우는 쪽으로 확실히 갈린다.
    { id: 'as_bomb', name: '폭파공', short: '광역·물량 섬멸', tiers: ['폭탄술사', '연쇄 폭파', '절멸 기폭'],
      desc: '단일 강타를 버리고 빠른 공속과 광역 지연 폭발을 택한다. 스플래시와 일반 몬스터 추가 피해에 특화되어 물량 웨이브를 통째로 정리한다',
      stat: { atkPct: 5, aspdPct: 11, rangePct: 5, splashAdd: 10, normalAdd: 12 } },
  ],
  atk_multi: [
    { id: 'am_frenzy', name: '광전사', short: '광란 지속', tiers: ['피의 광란', '무한 난도질', '불멸의 광전'],
      desc: '광란(자가 공속 폭증)을 상시에 가깝게 유지한다. 타격할수록 스스로 빨라지고, 4차에서는 동시 타격 대상까지 늘어난다',
      stat: { aspdPct: 14, atkPct: 4, targetsAdd: 0 } },
    { id: 'am_quake', name: '분쇄자', short: '광역 폭발', tiers: ['대지 분쇄', '지진파', '대격변'],
      desc: '유혈 대폭발을 기본공격에 상시 부여한다. 한 번의 휘두름이 곧 폭심지가 되며 범위와 여파가 계속 커진다',
      stat: { atkPct: 11, splashAdd: 22, rangePct: 6 } },
  ],
  magic_multi: [
    { id: 'mm_pyro', name: '화염술사', short: '화상·화염지대', tiers: ['불의 낙인', '화염 폭풍', '겁화의 대재앙'],
      desc: '확률에 기대던 화상과 잔류 화염지대를 기본공격의 확정 효과로 만든다. 4차에서는 불타는 적이 "취약" 상태가 되어 모든 아군에게 더 큰 피해를 받는다',
      stat: { atkPct: 6, dotAdd: 18, rangePct: 7 } },
    { id: 'mm_astral', name: '천공술사', short: '메테오 폭격', tiers: ['운석 소환', '유성우', '천공의 종말'],
      desc: '지속피해 대신 하늘에서 떨어지는 한 방에 집중한다. 일정 횟수마다 기본공격이 텔레그래프 후 낙하하는 메테오로 바뀌며, 3차부터는 낙하 충격이 적을 기절시킨다',
      stat: { atkPct: 13, critDmgAdd: 12, bossAdd: 8 } },
  ],
  magic_ctrl: [
    // 두 갈래가 모두 "둔화 변종"이 되지 않도록, 제어의 종류 자체를 갈라놓았다.
    // 빙결술사 = 붙잡아 두는 쪽(결빙 → 속박), 한파술사 = 끊고 무력화하는 쪽(기절 → 봉인).
    { id: 'mc_glacier', name: '빙결술사', short: '결빙·속박', tiers: ['서리 각인', '영구동토', '절대영도의 주인'],
      desc: '적을 그 자리에 붙들어 두는 데 특화된다. 기본공격이 확정적으로 서리를 쌓아 3중첩 결빙을 터뜨리고, 3차부터는 결빙이 속박(완전 정지 + 취약)으로 굳으며 4차에서는 주변까지 번진다',
      stat: { slowAdd: 10, atkPct: 4, rangePct: 6 } },
    { id: 'mc_rime', name: '한파술사', short: '기절·봉인', tiers: ['혹한의 저주', '한파의 심판', '동토의 재앙'],
      desc: '붙잡는 대신 끊어버린다. 둔화된 적을 추가로 두들기며 확률로 기절시키고, 4차에서는 보스/중간보스의 스킬 시전 자체를 봉인한다',
      stat: { atkPct: 12, slowAdd: 5, critDmgAdd: 10 } },
  ],
  ranged_single: [
    // 저격형: 더 넓은 사거리 / 높은 공격력 / 느린 공속 — 한 발의 무게로 싸운다
    { id: 'rs_sniper', name: '저격수', short: '장거리 관통 저격', tiers: ['정밀 관통', '초장거리 저격', '일점 파열'],
      desc: '사거리를 극단까지 늘리고 공속을 버리는 대신, 한 발이 조준선 위의 적을 전부 꿰뚫는다. 맵 반대편의 보스를 뒤에서 계속 두들기는 역할',
      stat: { atkPct: 18, aspdPct: -9, rangePct: 16, bossAdd: 16, critDmgAdd: 10 } },
    // 속사기형: 사거리와 한 방의 무게를 포기하고 공속으로 밀어붙이며, 그 타수를 전부
    // 연쇄 번개로 환산해 군중을 처리한다
    { id: 'rs_storm', name: '뇌전술사', short: '속사·연쇄 번개', tiers: ['감전 사격', '폭풍 연쇄', '뇌신의 강림'],
      desc: '사거리 대신 공속을 극단으로 끌어올린다. 쏟아붓는 타수마다 번개가 튀어, "몇 명에게 튀느냐"로 싸우는 군중 처리형',
      stat: { aspdPct: 18, atkPct: 5, critAdd: 5, rangePct: -4 } },
  ],
  buff_debuff: [
    { id: 'bd_plague', name: '역병술사', short: '역병지대', tiers: ['역병 파종', '창궐', '흑사의 군림'],
      desc: '저주보다 땅을 오염시키는 쪽을 택한다. 기본공격이 역병지대를 남기고, 차수가 오를수록 지대가 커지고 오래 남는다',
      stat: { atkPct: 5, dotAdd: 16, rangePct: 9 } },
    { id: 'bd_doom', name: '파멸술사', short: '저주 증폭', tiers: ['파멸의 표식', '전염되는 저주', '대재앙의 예언자'],
      desc: '저주 그 자체를 극단으로 밀어붙인다. 표식이 찍힌 적은 모든 아군에게서 훨씬 큰 피해를 받고, 저주가 주변으로 전염된다',
      stat: { debuffAdd: 20, atkPct: 6, bossAdd: 10 } },
  ],
  buff_support: [
    // 버프 "종류"를 늘리는 축: 2차는 순수 강도, 3차부터 공속 성가, 4차에서 치명타 성가가
    // 추가로 열려서 차수가 오를수록 오라의 폭이 넓어진다 (강도만 커지는 게 아니라)
    { id: 'bs_warchant', name: '전쟁성가', short: '다중 오라 강화', tiers: ['전투의 찬가', '승전가', '군신의 성가'],
      desc: '오라의 강도와 "종류"를 함께 넓힌다. 2차는 공격력·보스 피해, 3차에서 진군의 공속 성가, 4차에서 치명타 성가와 사거리 축복까지 겹쳐 울린다',
      stat: { auraPowerPct: 20, atkPct: 4 } },
    { id: 'bs_artificer', name: '기공술사', short: '보조 터렛', tiers: ['자동 포탑', '포탑 진지', '강철 군단'],
      desc: '오라 강도를 조금 양보하고, 스킬에서만 나오던 보조 터렛을 상시로 뽑아낸다. 지원형이면서 스스로 화력을 만들어내는 갈래',
      stat: { auraPowerPct: 8, atkPct: 12 } },
  ],
  heal_support: [
    { id: 'hs_bloom', name: '생명의 원천', short: '순수 치유', tiers: ['생명 개화', '재생의 샘', '불멸의 성역'],
      desc: '치유량 자체를 극대화하고, 넘친 치유는 보호막(피해 경감)으로 굳는다. 3차부터는 위독한(체력 50% 미만) 아군을 훨씬 크게 응급 치유하는 선별 치유가 열린다',
      stat: { healAdd: 26, shieldAdd: 5, rangePct: 8 } },
    { id: 'hs_zealot', name: '수호천사', short: '공격형 치유', tiers: ['축복의 손길', '성전의 인도자', '심판의 광휘'],
      desc: '치유가 곧 버프가 된다. 치유받은 아군은 공격력·공속·치명타가 오르고, 4차에서는 치유의 파동이 주변 적까지 태운다',
      stat: { healAdd: 10, atkPct: 14, aspdPct: 6 } },
  ],
  tank_guard: [
    { id: 'tg_bulwark', name: '불굴의 방벽', short: '보호막 특화', tiers: ['철벽', '난공불락', '영원한 성채'],
      desc: '피해 경감 오라와 자신의 체력을 끝까지 밀어올린다. 3차부터는 주기적으로 방벽 충격파를 터뜨려 주변 적을 기절시키고, 4차에서는 받은 피해의 일부를 그대로 되돌려준다',
      stat: { hpPct: 22, shieldAdd: 7, rangePct: 6 } },
    { id: 'tg_provoker', name: '도발자', short: '도발·속박', tiers: ['전장의 함성', '광역 도발', '전장의 지배자'],
      desc: '맞아주는 것에 그치지 않고 적을 끌어모아 묶어놓는다. 도발된 적은 둔화 + 취약 상태가 되고, 4차에서는 아예 속박되어 그 자리에 발이 묶인다',
      stat: { hpPct: 10, atkPct: 15, splashAdd: 14 } },
  ],
};

const JOB_BRANCH_BY_ID = {};
for (const subKey of Object.keys(JOB_BRANCHES)) {
  for (const b of JOB_BRANCHES[subKey]) { b.subKey = subKey; JOB_BRANCH_BY_ID[b.id] = b; }
}
// 전직 차수 표기 (jobTier 1 = 미전직)
const JOB_TIER_LABEL = ['', '기본', '2차', '3차', '4차'];

// ---- 전직 시스템과 맞물리는 연구실 노드 (모든 서브타입 트리에 공통 추가) ----
// 기존 root->branch->leaf->capstone 사슬은 그대로 두고, 성장/전직에만 작용하는 세 노드를
// 덧붙인다. 셋 다 "전직을 해야/깊게 파야 의미가 있는" 노드라서, 연구실 투자와 필드 육성이
// 서로를 끌어올리는 구조가 된다.
//  - 숙련 교본(xpGain): 경험치 획득량 증가 — 전직을 더 빨리 보게 해주는 진입 노드
//  - 전직 특화(branchMastery): 갈래 고유 메커니즘(처형 문턱/폭탄 확률/결빙 지속 등)의 강도 증가
//  - 전직 공명(jobSync): 전직 차수에 비례하는 전체 공격력 증가 — 4차 유닛에게 가장 크게 작용
for (const subKey of Object.keys(LAB_TREES)) {
  const tree = LAB_TREES[subKey];
  tree.push(passiveNode('xpGain', '숙련 교본', 'sparkle', 'xpGainPct', 4.0, 'root', 3));
  tree.push(passiveNode('branchMastery', '전직 특화', 'target', 'branchPowerPct', 3.0, 'leafA', 3));
  tree.push(passiveNode('jobSync', '전직 공명', 'buff', 'jobPowerPct', 2.5, 'capstone', 3));
}

// ---- 서브타입별 "특화" 노드 한 쌍 (specA / specB) ----
// 갈래는 10레벨에 무작위로 정해지고 바꿀 수 없다 — 그래서 "내 유닛의 개성을 내가 고른다"는
// 축은 갈래가 아니라 연구실이 맡아야 한다. 각 서브타입에 서로 반대 방향을 가리키는 두 노드를
// 두어, 같은 갈래를 뽑았더라도 어떤 맛으로 밀지(정밀/속사, 보스/물량, 붙잡기/끊기, 치유/보호막
// …)를 플레이어가 직접 정하게 만든다. 둘 다 찍을 수도 있지만 포인트가 유한하므로 실질적으로는
// 선택이 된다. specA는 leafA Lv.3, specB는 leafB Lv.3을 요구해 기존 사슬의 결을 그대로 따른다.
const LAB_SPEC_NODES = {
  atk_single:   [['specA', '참수 각인', 'skull', 'bossDmgPct', 2.2], ['specB', '군중 분쇄', 'multislash', 'splashPct', 2.2]],
  atk_multi:    [['specA', '광란의 맥동', 'fastfwd', 'aspdPct', 1.1], ['specB', '대지 균열', 'sparkle', 'splashPct', 2.4]],
  magic_multi:  [['specA', '겁화의 낙인', 'fire', 'dotChance', 0.9], ['specB', '천공 낙하', 'target', 'critDmgAdd', 2.6]],
  // 제어형만 제어 강도(ccPowerPct)라는 전용 축을 갖는다 — 결빙/속박/기절/봉인 지속시간에 작용
  magic_ctrl:   [['specA', '속박의 사슬', 'frost', 'ccPowerPct', 2.6], ['specB', '균열 증폭', 'debuff', 'debuffPct', 1.3]],
  ranged_single:[['specA', '초장거리 조준', 'target', 'rangePct', 1.7], ['specB', '속사 훈련', 'fastfwd', 'aspdPct', 1.3]],
  buff_debuff:  [['specA', '역병 확산', 'flask', 'dotChance', 1.0], ['specB', '파멸의 예언', 'debuff', 'debuffPct', 1.5]],
  buff_support: [['specA', '질주의 오라', 'fastfwd', 'auraAspdPct', 1.6], ['specB', '광역 축복', 'sparkle', 'auraRangePct', 2.0]],
  heal_support: [['specA', '치유 증폭', 'heart', 'healPct', 2.4], ['specB', '수호의 결계', 'shield', 'shieldPct', 1.1]],
  tank_guard:   [['specA', '불굴의 육체', 'heart', 'guardHpPct', 2.2], ['specB', '격노의 도발', 'target', 'tauntPowerPct', 2.6]],
};
for (const subKey of Object.keys(LAB_SPEC_NODES)) {
  const [a, b] = LAB_SPEC_NODES[subKey];
  LAB_TREES[subKey].push(passiveNode(a[0], a[1], a[2], a[3], a[4], 'leafA', 3));
  LAB_TREES[subKey].push(passiveNode(b[0], b[1], b[2], b[3], b[4], 'leafB', 3));
}

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
