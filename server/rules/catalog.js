/** Catálogo MVP Tormenta20 — dados corretos por arma/magia */

const ATTRS = ['FOR', 'DES', 'CON', 'INT', 'SAB', 'CAR'];

const ATTR_LABELS = {
  FOR: 'Força',
  DES: 'Destreza',
  CON: 'Constituição',
  INT: 'Inteligência',
  SAB: 'Sabedoria',
  CAR: 'Carisma',
};

const RACES = {
  humano: { label: 'Humano', bonus: { FOR: 1, DES: 1, CON: 1, INT: 1, SAB: 1, CAR: 1 } },
  anao: { label: 'Anão', bonus: { CON: 2, FOR: 1 } },
  elfo: { label: 'Elfo', bonus: { DES: 2, INT: 1 } },
  qareen: { label: 'Qareen', bonus: { CAR: 2, INT: 1 } },
};

const CLASSES = {
  guerreiro: {
    label: 'Guerreiro',
    hitDie: 20,
    mpBase: 0,
    mpPerLevel: 0,
    defenseBonus: 2,
    attackAttr: 'FOR',
    weapon: 'espada_longa',
    spells: [],
  },
  ladino: {
    label: 'Ladino',
    hitDie: 12,
    mpBase: 2,
    mpPerLevel: 1,
    defenseBonus: 1,
    attackAttr: 'DES',
    weapon: 'adaga',
    spells: [],
  },
  clerigo: {
    label: 'Clérigo',
    hitDie: 16,
    mpBase: 6,
    mpPerLevel: 3,
    defenseBonus: 1,
    attackAttr: 'FOR',
    weapon: 'clava',
    spells: ['cura_ferimentos', 'luz'],
  },
  arcanista: {
    label: 'Arcanista',
    hitDie: 8,
    mpBase: 8,
    mpPerLevel: 4,
    defenseBonus: 0,
    attackAttr: 'INT',
    weapon: 'cajado',
    spells: ['bola_de_fogo', 'missil_magico'],
  },
};

const WEAPONS = {
  adaga: { label: 'Adaga', damageDice: '1d4', critRange: 19, critMult: 2, attr: 'DES', range: 1, style: 'melee' },
  clava: { label: 'Clava', damageDice: '1d6', critRange: 20, critMult: 2, attr: 'FOR', range: 1, style: 'melee' },
  espada_longa: { label: 'Espada Longa', damageDice: '1d8', critRange: 19, critMult: 2, attr: 'FOR', range: 1, style: 'melee' },
  mangual: { label: 'Mangual', damageDice: '1d10', critRange: 20, critMult: 2, attr: 'FOR', range: 1, style: 'melee' },
  machado_grande: { label: 'Machado Grande', damageDice: '1d12', critRange: 20, critMult: 3, attr: 'FOR', range: 1, style: 'melee' },
  cajado: { label: 'Cajado', damageDice: '1d6', critRange: 20, critMult: 2, attr: 'FOR', range: 1, style: 'melee' },
};

const SPELLS = {
  missil_magico: {
    label: 'Míssil Mágico',
    cost: 1,
    damageDice: '1d4+1',
    type: 'force',
    autoHit: true,
    range: 8,
  },
  bola_de_fogo: {
    label: 'Bola de Fogo',
    cost: 3,
    damageDice: '3d6',
    type: 'fire',
    autoHit: false,
    saveAttr: 'DES',
    range: 6,
  },
  cura_ferimentos: {
    label: 'Cura Ferimentos',
    cost: 2,
    healDice: '2d8+2',
    type: 'heal',
    range: 1,
  },
  luz: {
    label: 'Luz',
    cost: 1,
    type: 'utility',
    range: 0,
  },
};

const ENEMY_TEMPLATES = {
  goblin: {
    key: 'goblin',
    name: 'Goblin',
    baseHp: 12,
    baseDefense: 14,
    attackMod: 3,
    damageDice: '1d6+1',
    weaponAttr: 'DES',
    color: '#6a8f3d',
  },
  lobo: {
    key: 'lobo',
    name: 'Lobo Faminto',
    baseHp: 18,
    baseDefense: 13,
    attackMod: 4,
    damageDice: '1d8+2',
    weaponAttr: 'FOR',
    color: '#8a6a4a',
  },
  bandido: {
    key: 'bandido',
    name: 'Bandido',
    baseHp: 22,
    baseDefense: 15,
    attackMod: 5,
    damageDice: '1d8+2',
    weaponAttr: 'FOR',
    color: '#7a4a4a',
  },
};

function attrMod(score) {
  return Math.floor((Number(score) - 10) / 2);
}

function chebyshev(a, b) {
  if (!a || !b) return 99;
  return Math.max(Math.abs((a.x || 0) - (b.x || 0)), Math.abs((a.y || 0) - (b.y || 0)));
}

function inRange(attacker, target, range) {
  const r = Number(range);
  if (!Number.isFinite(r) || r < 0) return true;
  if (r === 0) return true; // self/utility
  return chebyshev(attacker, target) <= r;
}

module.exports = {
  ATTRS,
  ATTR_LABELS,
  RACES,
  CLASSES,
  WEAPONS,
  SPELLS,
  ENEMY_TEMPLATES,
  attrMod,
  chebyshev,
  inRange,
};
