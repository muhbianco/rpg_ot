/**
 * Habilidades (poderes) e traços raciais — MVP inspirado em Tormenta20.
 *
 * - Personagem começa com 1 ponto de poder (humano Versátil: +1).
 * - A cada nível ganha +1 ponto para desbloquear/subir rank.
 * - Kit de classe define o que pode aprender no início.
 * - Cooldown: turnos do próprio personagem até poder usar de novo.
 */

const { attrMod } = require('./catalog');

const STARTING_POWER_POINTS = 1;
const POINTS_PER_LEVEL = 1;
const MAX_RANK = 3;

/** Traços raciais passivos (buffs) */
const RACE_TRAITS = {
  humano: [
    {
      key: 'versatil',
      label: 'Versátil',
      description: 'Humanos se adaptam rápido. Começa com +1 ponto de poder extra.',
      startingPowerPointsBonus: 1,
    },
    {
      key: 'adaptavel',
      label: 'Adaptável',
      description: 'Recebe +1 em testes de perícia gerais (inspecionar / conversar).',
      skillCheckBonus: 1,
    },
  ],
  anao: [
    {
      key: 'pele_rochosa',
      label: 'Pele Rochosa',
      description: 'Pele dura como pedra. +1 Defesa permanente.',
      defenseBonus: 1,
    },
    {
      key: 'devagar_e_sempre',
      label: 'Devagar e Sempre',
      description: 'Resistência anã: −1 de dano recebido (mín. 1 quando sofre dano).',
      damageReduction: 1,
    },
    {
      key: 'visao_no_escuro',
      label: 'Visão no Escuro',
      description: 'Enxerga no escuro. Bônus em inspeção (+2).',
      inspectBonus: 2,
    },
  ],
  elfo: [
    {
      key: 'graca_elfica',
      label: 'Graça Élfica',
      description: 'Movimentos ágeis. +1 Defesa.',
      defenseBonus: 1,
    },
    {
      key: 'sentidos_aguçados',
      label: 'Sentidos Aguçados',
      description: 'Visão e audição superiores. +2 em inspeção.',
      inspectBonus: 2,
    },
    {
      key: 'imune_sono',
      label: 'Imune a Sono',
      description: 'Élfos não dormem da mesma forma; imunes a efeitos de sono.',
      immunities: ['sono'],
    },
  ],
  qareen: [
    {
      key: 'heranca_elemental',
      label: 'Herança Elemental',
      description: 'Sangue genie. Resistência a fogo: −2 de dano de fogo.',
      fireResist: 2,
    },
    {
      key: 'presenca_arcana',
      label: 'Presença Arcana',
      description: 'Aura carismática. +1 em conversa / influência.',
      talkBonus: 1,
    },
    {
      key: 'desejo_menor',
      label: 'Desejo Menor',
      description: 'Uma vez por combate pode rerrolar um teste falho (automático na 1ª falha grave).',
      mercyBoost: 0.1,
    },
  ],
};

/**
 * Catálogo de habilidades.
 * scaleAttr: atributo que escala efeito (modificador).
 * cooldown: turnos do usuário após o uso.
 * unlockCost: pontos para colocar no rank 1.
 * rankCost: pontos por rank adicional.
 */
const SKILLS = {
  // —— Guerreiro ——
  ataque_especial: {
    key: 'ataque_especial',
    label: 'Ataque Especial',
    classKey: 'guerreiro',
    scaleAttr: 'FOR',
    description: 'Golpe potente. Soma o modificador de Força extra no dano (× rank).',
    cooldown: 2,
    mpCost: 0,
    unlockCost: 1,
    rankCost: 1,
    maxRank: MAX_RANK,
    type: 'attack',
    tags: ['ofensivo'],
  },
  golpe_demolidor: {
    key: 'golpe_demolidor',
    label: 'Golpe Demolidor',
    classKey: 'guerreiro',
    scaleAttr: 'FOR',
    description: 'Ignora parte da armadura: −2 Defesa do alvo neste ataque + dano bônus.',
    cooldown: 3,
    mpCost: 0,
    unlockCost: 1,
    rankCost: 1,
    maxRank: MAX_RANK,
    type: 'attack',
    tags: ['ofensivo'],
  },
  postura_defensiva: {
    key: 'postura_defensiva',
    label: 'Postura Defensiva',
    classKey: 'guerreiro',
    scaleAttr: 'CON',
    description: 'Assume guarda. +2 Defesa (+1 por rank) até o próximo turno seu.',
    cooldown: 3,
    mpCost: 0,
    unlockCost: 1,
    rankCost: 1,
    maxRank: MAX_RANK,
    type: 'buff_self',
    tags: ['defensivo'],
  },

  // —— Ladino ——
  ataque_furtivo: {
    key: 'ataque_furtivo',
    label: 'Ataque Furtivo',
    classKey: 'ladino',
    scaleAttr: 'DES',
    description: 'Explora a abertura. Dano extra 1d6 + DES por rank.',
    cooldown: 2,
    mpCost: 0,
    unlockCost: 1,
    rankCost: 1,
    maxRank: MAX_RANK,
    type: 'attack',
    tags: ['ofensivo'],
  },
  esquiva_sobrenatural: {
    key: 'esquiva_sobrenatural',
    label: 'Esquiva Sobrenatural',
    classKey: 'ladino',
    scaleAttr: 'DES',
    description: 'Reflexos impossíveis. +3 Defesa (+1/rank) até o próximo turno.',
    cooldown: 3,
    mpCost: 0,
    unlockCost: 1,
    rankCost: 1,
    maxRank: MAX_RANK,
    type: 'buff_self',
    tags: ['defensivo'],
  },
  golpe_preciso: {
    key: 'golpe_preciso',
    label: 'Golpe Preciso',
    classKey: 'ladino',
    scaleAttr: 'DES',
    description: 'Aponta o ponto frágil. +2 no ataque e crítico mais fácil neste golpe.',
    cooldown: 3,
    mpCost: 0,
    unlockCost: 1,
    rankCost: 1,
    maxRank: MAX_RANK,
    type: 'attack',
    tags: ['ofensivo'],
  },

  // —— Clérigo ——
  canalizar_energia: {
    key: 'canalizar_energia',
    label: 'Canalizar Energia',
    classKey: 'clerigo',
    scaleAttr: 'SAB',
    description: 'Canaliza poder divino. Cura aliado (ou a si) 1d8 + SAB × rank. Custa 1 PM.',
    cooldown: 2,
    mpCost: 1,
    unlockCost: 1,
    rankCost: 1,
    maxRank: MAX_RANK,
    type: 'heal',
    tags: ['suporte'],
  },
  bencao: {
    key: 'bencao',
    label: 'Bênção',
    classKey: 'clerigo',
    scaleAttr: 'SAB',
    description: 'Abençoa a si. +1 ataque e +1 Defesa (+1/rank no ataque) por 1 turno.',
    cooldown: 3,
    mpCost: 1,
    unlockCost: 1,
    rankCost: 1,
    maxRank: MAX_RANK,
    type: 'buff_self',
    tags: ['suporte'],
  },
  ira_sagrada: {
    key: 'ira_sagrada',
    label: 'Ira Sagrada',
    classKey: 'clerigo',
    scaleAttr: 'SAB',
    description: 'Golpe abençoado. Ataque com dano extra divino (1d6 + SAB × rank).',
    cooldown: 2,
    mpCost: 1,
    unlockCost: 1,
    rankCost: 1,
    maxRank: MAX_RANK,
    type: 'attack',
    tags: ['ofensivo'],
  },

  // —— Arcanista ——
  missil_magico: {
    key: 'missil_magico',
    label: 'Míssil Mágico',
    classKey: 'arcanista',
    scaleAttr: 'INT',
    description: 'Projétil de força que acerta sempre. 1d4+1 + INT × rank. Custa 1 PM.',
    cooldown: 1,
    mpCost: 1,
    unlockCost: 1,
    rankCost: 1,
    maxRank: MAX_RANK,
    type: 'auto_damage',
    tags: ['arcano'],
  },
  escudo_arcano: {
    key: 'escudo_arcano',
    label: 'Escudo Arcano',
    classKey: 'arcanista',
    scaleAttr: 'INT',
    description: 'Barreira mágica. +2 Defesa (+1/rank) até o próximo turno. Custa 1 PM.',
    cooldown: 3,
    mpCost: 1,
    unlockCost: 1,
    rankCost: 1,
    maxRank: MAX_RANK,
    type: 'buff_self',
    tags: ['defensivo', 'arcano'],
  },
  explosao_arcana: {
    key: 'explosao_arcana',
    label: 'Explosão Arcana',
    classKey: 'arcanista',
    scaleAttr: 'INT',
    description: 'Estouro de energia. 2d6 + INT × rank (alvo pode resistir pela metade). Custa 2 PM.',
    cooldown: 3,
    mpCost: 2,
    unlockCost: 1,
    rankCost: 1,
    maxRank: MAX_RANK,
    type: 'damage_save',
    tags: ['arcano', 'ofensivo'],
  },
};

const CLASS_KITS = {
  guerreiro: ['ataque_especial', 'golpe_demolidor', 'postura_defensiva'],
  ladino: ['ataque_furtivo', 'esquiva_sobrenatural', 'golpe_preciso'],
  clerigo: ['canalizar_energia', 'bencao', 'ira_sagrada'],
  arcanista: ['missil_magico', 'escudo_arcano', 'explosao_arcana'],
};

function raceTraitsFor(raceKey) {
  return RACE_TRAITS[raceKey] || [];
}

function classKit(classKey) {
  return (CLASS_KITS[classKey] || []).map((k) => SKILLS[k]).filter(Boolean);
}

function startingPowerPoints(raceKey) {
  let pts = STARTING_POWER_POINTS;
  for (const t of raceTraitsFor(raceKey)) {
    pts += t.startingPowerPointsBonus || 0;
  }
  return pts;
}

function powerPointsForLevel(level, raceKey) {
  const lvl = Math.max(1, Number(level) || 1);
  return startingPowerPoints(raceKey) + (lvl - 1) * POINTS_PER_LEVEL;
}

function sumSpentPoints(ranks) {
  let spent = 0;
  for (const [key, rank] of Object.entries(ranks || {})) {
    const skill = SKILLS[key];
    const r = Number(rank) || 0;
    if (!skill || r <= 0) continue;
    spent += skill.unlockCost + Math.max(0, r - 1) * skill.rankCost;
  }
  return spent;
}

/**
 * Valida distribuição de ranks.
 * Só permite skills do kit da classe (ou já aprendidas — futuro).
 */
function validateSkillRanks({ classKey, raceKey, level, ranks }) {
  const allowed = new Set(CLASS_KITS[classKey] || []);
  const clean = {};
  for (const [key, raw] of Object.entries(ranks || {})) {
    const rank = Number(raw);
    if (!Number.isInteger(rank) || rank < 0) {
      return { ok: false, error: `Rank inválido em ${key}.` };
    }
    if (rank === 0) continue;
    if (!allowed.has(key) || !SKILLS[key]) {
      return { ok: false, error: `Habilidade ${key} não faz parte do kit desta classe.` };
    }
    if (rank > (SKILLS[key].maxRank || MAX_RANK)) {
      return { ok: false, error: `${SKILLS[key].label} excede o rank máximo.` };
    }
    clean[key] = rank;
  }
  const budget = powerPointsForLevel(level || 1, raceKey);
  const spent = sumSpentPoints(clean);
  if (spent > budget) {
    return { ok: false, error: `Pontos de poder excedidos (${spent}/${budget}).` };
  }
  return { ok: true, ranks: clean, spent, remaining: budget - spent, budget };
}

function publicSkill(skill) {
  return {
    key: skill.key,
    label: skill.label,
    classKey: skill.classKey,
    scaleAttr: skill.scaleAttr,
    description: skill.description,
    cooldown: skill.cooldown,
    mpCost: skill.mpCost,
    unlockCost: skill.unlockCost,
    rankCost: skill.rankCost,
    maxRank: skill.maxRank,
    type: skill.type,
    tags: skill.tags || [],
  };
}

function publicCatalogSkills() {
  return {
    startingPowerPoints: STARTING_POWER_POINTS,
    pointsPerLevel: POINTS_PER_LEVEL,
    maxRank: MAX_RANK,
    kits: CLASS_KITS,
    skills: Object.fromEntries(Object.values(SKILLS).map((s) => [s.key, publicSkill(s)])),
    raceTraits: Object.fromEntries(
      Object.entries(RACE_TRAITS).map(([race, traits]) => [
        race,
        traits.map((t) => ({
          key: t.key,
          label: t.label,
          description: t.description,
        })),
      ])
    ),
  };
}

function applyRaceCombatBonuses(char, raceKey) {
  let defenseBonus = 0;
  let damageReduction = 0;
  let fireResist = 0;
  let inspectBonus = 0;
  let talkBonus = 0;
  let skillCheckBonus = 0;
  const immunities = [];
  for (const t of raceTraitsFor(raceKey)) {
    defenseBonus += t.defenseBonus || 0;
    damageReduction += t.damageReduction || 0;
    fireResist += t.fireResist || 0;
    inspectBonus += t.inspectBonus || 0;
    talkBonus += t.talkBonus || 0;
    skillCheckBonus += t.skillCheckBonus || 0;
    if (t.immunities) immunities.push(...t.immunities);
  }
  return {
    defenseBonus,
    damageReduction,
    fireResist,
    inspectBonus,
    talkBonus,
    skillCheckBonus,
    immunities,
  };
}

function tickCooldowns(char) {
  if (!char || !char.skillCooldowns) return;
  for (const key of Object.keys(char.skillCooldowns)) {
    char.skillCooldowns[key] -= 1;
    if (char.skillCooldowns[key] <= 0) delete char.skillCooldowns[key];
  }
}

function clearExpiredBuffs(char) {
  if (!char) return;
  if (char.tempDefenseBonus) {
    // buffs "até próximo turno" caem ao começar o turno do personagem
    char.tempDefenseBonus = 0;
  }
  if (char.tempAttackBonus) {
    char.tempAttackBonus = 0;
  }
  // Recalcula defesa base + racial + temp
  // (defense permanente já inclui racial no build)
}

module.exports = {
  SKILLS,
  CLASS_KITS,
  RACE_TRAITS,
  STARTING_POWER_POINTS,
  POINTS_PER_LEVEL,
  MAX_RANK,
  raceTraitsFor,
  classKit,
  startingPowerPoints,
  powerPointsForLevel,
  sumSpentPoints,
  validateSkillRanks,
  publicCatalogSkills,
  publicSkill,
  applyRaceCombatBonuses,
  tickCooldowns,
  clearExpiredBuffs,
  attrMod,
};
