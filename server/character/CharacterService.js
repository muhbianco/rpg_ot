const { v4: uuidv4 } = require('uuid');
const { RACES, CLASSES, WEAPONS, ATTRS, attrMod } = require('../rules/catalog');

function defaultAttrs() {
  return { FOR: 12, DES: 12, CON: 12, INT: 12, SAB: 12, CAR: 12 };
}

function buildCharacter({ playerId, partyId, name, raceKey, classKey }) {
  const race = RACES[raceKey] || RACES.humano;
  const klass = CLASSES[classKey] || CLASSES.guerreiro;
  const attrs = defaultAttrs();
  for (const [k, v] of Object.entries(race.bonus || {})) {
    attrs[k] = (attrs[k] || 10) + v;
  }

  // leve ajuste por classe
  if (classKey === 'guerreiro') attrs.FOR += 2;
  if (classKey === 'ladino') attrs.DES += 2;
  if (classKey === 'clerigo') attrs.SAB += 2;
  if (classKey === 'arcanista') attrs.INT += 2;

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
    races: Object.entries(RACES).map(([key, v]) => ({ key, label: v.label })),
    classes: Object.entries(CLASSES).map(([key, v]) => ({
      key,
      label: v.label,
      weapon: WEAPONS[v.weapon]?.label,
      spells: v.spells,
    })),
    attrs: ATTRS,
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
  publicCatalog,
  hudPayload,
  partyMemberPublic,
  RACES,
  CLASSES,
};
