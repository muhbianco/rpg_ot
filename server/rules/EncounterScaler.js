/**
 * EncounterScaler — quanto maior a party, mais perigosos os inimigos.
 */
function scaleEncounter(partySize, base = {}) {
  const n = Math.max(1, Math.min(10, Number(partySize) || 1));
  const budget = (base.cr || 1) * (0.6 + 0.4 * n);
  const hpMult = 0.7 + 0.15 * n;
  const dmgMult = 0.8 + 0.08 * n;
  const enemyCount = Math.max(1, Math.round(n * 0.6));

  return {
    partySize: n,
    budget: Math.round(budget * 100) / 100,
    hpMult: Math.round(hpMult * 100) / 100,
    dmgMult: Math.round(dmgMult * 100) / 100,
    enemyCount,
  };
}

function applyScaleToEnemy(template, scale) {
  const hp = Math.max(5, Math.round(template.baseHp * scale.hpMult));
  return {
    ...template,
    hp,
    hpMax: hp,
    defense: template.baseDefense + Math.floor((scale.partySize - 1) / 3),
    attackMod: template.attackMod + Math.floor((scale.partySize - 1) / 4),
    dmgMult: scale.dmgMult,
  };
}

module.exports = { scaleEncounter, applyScaleToEnemy };
