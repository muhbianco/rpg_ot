const { v4: uuidv4 } = require('uuid');
const { RACES, CLASSES, WEAPONS, ATTRS, ATTR_LABELS, attrMod } = require('../rules/catalog');
const pointBuy = require('../rules/pointBuy');

function applyRaceBonus(attrs, race) {
  const out = { ...attrs };
  for (const [k, v] of Object.entries(race.bonus || {})) {
    out[k] = (out[k] || pointBuy.BASE) + v;
  }
  return out;
}

function buildCharacter({ playerId, partyId, name, raceKey, classKey, attrs: rawAttrs }) {
  const race = RACES[raceKey] || RACES.humano;
  const klass = CLASSES[classKey] || CLASSES.guerreiro;

  // Distribuição pré-racial: usa a enviada pelo cliente (validada) ou o preset da classe.
  const chosen = rawAttrs ? pointBuy.validate(rawAttrs) : { ok: true, attrs: pointBuy.presetFor(classKey) };
  if (!chosen.ok) throw new Error(chosen.error || 'Atributos inválidos.');
  const attrs = applyRaceBonus(chosen.attrs, race);

  const level = 1;
  const hpMax = klass.hitDie + attrMod(attrs.CON);
  const mpMax = klass.mpBase + klass.mpPerLevel * level + Math.max(0, attrMod(attrs.INT) + attrMod(attrs.SAB));
  const defense = 10 + attrMod(attrs.DES) + klass.defenseBonus;
  const weaponKey = klass.weapon;
  const weapon = WEAPONS[weaponKey];

  return {
    id: uuidv4(),
    playerId,
    partyId,
    name: String(name).trim().slice(0, 40),
    race: raceKey,
    raceLabel: race.label,
    classKey,
    classLabel: klass.label,
    level,
    attrs,
    hp: hpMax,
    hpMax,
    mp: mpMax,
    mpMax,
    defense,
    weaponKey,
    weaponLabel: weapon.label,
    spells: [...(klass.spells || [])],
    status: [],
    inventory: [{ key: weaponKey, label: weapon.label, qty: 1 }],
    mercy: { deaths: 0, failStreak: 0, punishments: 0 },
    x: 4,
    y: 4,
    color: classColor(classKey),
  };
}

function classColor(classKey) {
  return {
    guerreiro: '#c45c2a',
    ladino: '#4a8f6a',
    clerigo: '#d4b84a',
    arcanista: '#5a6ac8',
  }[classKey] || '#aaaaaa';
}

function publicCatalog() {
  return {
    races: Object.entries(RACES).map(([key, v]) => ({ key, label: v.label, bonus: v.bonus || {} })),
    classes: Object.entries(CLASSES).map(([key, v]) => ({
      key,
      label: v.label,
      weapon: WEAPONS[v.weapon]?.label,
      spells: v.spells,
      keyAttr: pointBuy.KEY_ATTR[key] || null,
      preset: pointBuy.presetFor(key),
    })),
    attrs: ATTRS,
    attrLabels: ATTR_LABELS,
    pointBuy: pointBuy.publicConfig(),
  };
}

function previewCharacter({ name, raceKey, classKey, attrs: rawAttrs }) {
  const validation = rawAttrs ? pointBuy.validate(rawAttrs) : { ok: true, attrs: pointBuy.presetFor(classKey), spent: null, remaining: null };
  if (!validation.ok) return { ok: false, error: validation.error };
  const character = buildCharacter({
    playerId: 'preview',
    partyId: 'preview',
    name: name || 'Herói',
    raceKey,
    classKey,
    attrs: validation.attrs,
  });
  return {
    ok: true,
    hud: hudPayload(character),
    spent: validation.spent,
    remaining: validation.remaining,
    finalAttrs: character.attrs,
  };
}

function hudPayload(char) {
  if (!char) return null;
  return {
    id: char.id,
    name: char.name,
    race: char.raceLabel || char.race,
    class: char.classLabel || char.classKey,
    level: char.level,
    hp: char.hp,
    hpMax: char.hpMax,
    mp: char.mp,
    mpMax: char.mpMax,
    defense: char.defense,
    status: char.status || [],
    weapon: char.weaponLabel,
    spells: char.spells || [],
    attrs: char.attrs,
  };
}

function partyMemberPublic(member) {
  const c = member.character;
  return {
    playerId: member.playerId,
    nickname: member.nickname,
    ready: !!member.ready,
    character: c
      ? {
          name: c.name,
          class: c.classLabel || c.classKey,
          hp: c.hp,
          hpMax: c.hpMax,
          hpPct: c.hpMax ? Math.round((c.hp / c.hpMax) * 100) : 0,
          status: c.status || [],
        }
      : null,
  };
}

module.exports = {
  buildCharacter,
  previewCharacter,
  publicCatalog,
  hudPayload,
  partyMemberPublic,
  RACES,
  CLASSES,
};
