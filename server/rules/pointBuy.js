/**
 * Point-buy de atributos (estilo Tormenta / d20).
 * Modelo baseado em SCORE (o RulesEngine usa attrMod = floor((score-10)/2)).
 *
 * - Todos começam em BASE (8).
 * - O jogador distribui POOL pontos, comprando pontos de atributo pela tabela de custo.
 * - Bônus de raça é aplicado DEPOIS (pode ultrapassar MAX).
 * - Cada classe tem um preset recomendado (já válido) que prioriza o atributo-chave.
 */

const { ATTRS } = require('./catalog');

const BASE = 8;
const MIN = 8;
const MAX = 15;
const POOL = 27;

const COST = { 8: 0, 9: 1, 10: 2, 11: 3, 12: 4, 13: 5, 14: 7, 15: 9 };

const KEY_ATTR = {
  guerreiro: 'FOR',
  ladino: 'DES',
  clerigo: 'SAB',
  arcanista: 'INT',
};

const CLASS_PRESETS = {
  guerreiro: { FOR: 15, DES: 13, CON: 14, INT: 10, SAB: 12, CAR: 8 },
  ladino: { FOR: 10, DES: 15, CON: 13, INT: 14, SAB: 12, CAR: 8 },
  clerigo: { FOR: 13, DES: 12, CON: 14, INT: 8, SAB: 15, CAR: 10 },
  arcanista: { FOR: 8, DES: 14, CON: 13, INT: 15, SAB: 12, CAR: 10 },
};

function baseAttrs() {
  return ATTRS.reduce((acc, k) => ({ ...acc, [k]: BASE }), {});
}

function presetFor(classKey) {
  const preset = CLASS_PRESETS[classKey] || CLASS_PRESETS.guerreiro;
  return { ...preset };
}

function scoreCost(score) {
  return COST[score];
}

function spentPoints(attrs) {
  let spent = 0;
  for (const k of ATTRS) {
    const c = COST[attrs?.[k]];
    if (c == null) return null;
    spent += c;
  }
  return spent;
}

/**
 * Valida uma distribuição PRÉ-racial vinda do cliente.
 * @returns {{ ok: boolean, error?: string, attrs?: object, spent?: number, remaining?: number }}
 */
function validate(rawAttrs) {
  const attrs = {};
  for (const k of ATTRS) {
    const v = Number(rawAttrs?.[k]);
    if (!Number.isInteger(v)) return { ok: false, error: `Atributo ${k} inválido.` };
    if (v < MIN || v > MAX) return { ok: false, error: `${k} deve estar entre ${MIN} e ${MAX}.` };
    attrs[k] = v;
  }
  const spent = spentPoints(attrs);
  if (spent == null) return { ok: false, error: 'Valor de atributo fora da tabela.' };
  if (spent > POOL) return { ok: false, error: `Pontos excedidos (${spent}/${POOL}).` };
  return { ok: true, attrs, spent, remaining: POOL - spent };
}

function publicConfig() {
  return {
    base: BASE,
    min: MIN,
    max: MAX,
    pool: POOL,
    cost: COST,
    keyAttr: KEY_ATTR,
    presets: CLASS_PRESETS,
  };
}

module.exports = {
  BASE,
  MIN,
  MAX,
  POOL,
  COST,
  KEY_ATTR,
  CLASS_PRESETS,
  baseAttrs,
  presetFor,
  scoreCost,
  spentPoints,
  validate,
  publicConfig,
};
