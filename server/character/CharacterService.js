const { v4: uuidv4 } = require('uuid');
const { RACES, CLASSES, WEAPONS, ATTRS, ATTR_LABELS, attrMod } = require('../rules/catalog');
const pointBuy = require('../rules/pointBuy');
const skills = require('../rules/skills');

function applyRaceBonus(attrs, race) {
  const out = { ...attrs };
  for (const [k, v] of Object.entries(race.bonus || {})) {
    out[k] = (out[k] || pointBuy.BASE) + v;
  }
  return out;
}

function buildCharacter({ playerId, partyId, name, raceKey, classKey, attrs: rawAttrs, skillRanks: rawRanks }) {
  const race = RACES[raceKey] || RACES.humano;
  const klass = CLASSES[classKey] || CLASSES.guerreiro;

  const chosen = rawAttrs ? pointBuy.validate(rawAttrs) : { ok: true, attrs: pointBuy.presetFor(classKey) };
  if (!chosen.ok) throw new Error(chosen.error || 'Atributos inválidos.');
  const attrs = applyRaceBonus(chosen.attrs, race);

  const level = 1;
  const ranksValidation = skills.validateSkillRanks({
    classKey,
    raceKey,
    level,
    ranks: rawRanks || {},
  });
  if (!ranksValidation.ok) throw new Error(ranksValidation.error);

  const raceCombat = skills.applyRaceCombatBonuses({}, raceKey);
  const hpMax = klass.hitDie + attrMod(attrs.CON);
  const mpMax = klass.mpBase + klass.mpPerLevel * level + Math.max(0, attrMod(attrs.INT) + attrMod(attrs.SAB));
  const baseDefense = 10 + attrMod(attrs.DES) + klass.defenseBonus + (raceCombat.defenseBonus || 0);
  const weaponKey = klass.weapon;
  const weapon = WEAPONS[weaponKey];

  const powerBudget = skills.powerPointsForLevel(level, raceKey);
  const skillRanks = ranksValidation.ranks;
  const knownSkills = Object.keys(skillRanks).filter((k) => skillRanks[k] > 0);

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
    baseDefense,
    defense: baseDefense,
    weaponKey,
    weaponLabel: weapon.label,
    spells: [...(klass.spells || [])],
    skillRanks,
    knownSkills,
    powerPointsSpent: ranksValidation.spent,
    powerPointsBudget: powerBudget,
    powerPointsRemaining: ranksValidation.remaining,
    skillCooldowns: {},
    tempDefenseBonus: 0,
    tempAttackBonus: 0,
    raceTraits: skills.raceTraitsFor(raceKey).map((t) => ({
      key: t.key,
      label: t.label,
      description: t.description,
    })),
    raceTraitsCombat: raceCombat,
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

function skillsPayload(char) {
  if (!char) return [];
  const ranks = char.skillRanks || {};
  return Object.entries(ranks)
    .filter(([, r]) => r > 0)
    .map(([key, rank]) => {
      const def = skills.SKILLS[key];
      if (!def) return null;
      const cd = (char.skillCooldowns && char.skillCooldowns[key]) || 0;
      return {
        key,
        label: def.label,
        rank,
        scaleAttr: def.scaleAttr,
        scaleAttrLabel: ATTR_LABELS[def.scaleAttr] || def.scaleAttr,
        description: def.description,
        cooldown: def.cooldown,
        cooldownLeft: cd,
        mpCost: def.mpCost,
        ready: cd <= 0,
        type: def.type,
      };
    })
    .filter(Boolean);
}

function publicCatalog() {
  return {
    races: Object.entries(RACES).map(([key, v]) => ({
      key,
      label: v.label,
      bonus: v.bonus || {},
      traits: skills.raceTraitsFor(key).map((t) => ({
        key: t.key,
        label: t.label,
        description: t.description,
      })),
    })),
    classes: Object.entries(CLASSES).map(([key, v]) => ({
      key,
      label: v.label,
      weapon: WEAPONS[v.weapon]?.label,
      spells: v.spells,
      keyAttr: pointBuy.KEY_ATTR[key] || null,
      preset: pointBuy.presetFor(key),
      kit: skills.classKit(key).map((s) => skills.publicSkill(s)),
    })),
    attrs: ATTRS,
    attrLabels: ATTR_LABELS,
    pointBuy: pointBuy.publicConfig(),
    skills: skills.publicCatalogSkills(),
  };
}

function previewCharacter({ name, raceKey, classKey, attrs: rawAttrs, skillRanks }) {
  const validation = rawAttrs
    ? pointBuy.validate(rawAttrs)
    : { ok: true, attrs: pointBuy.presetFor(classKey), spent: null, remaining: null };
  if (!validation.ok) return { ok: false, error: validation.error };
  try {
    const character = buildCharacter({
      playerId: 'preview',
      partyId: 'preview',
      name: name || 'Herói',
      raceKey,
      classKey,
      attrs: validation.attrs,
      skillRanks: skillRanks || {},
    });
    return {
      ok: true,
      hud: hudPayload(character),
      spent: validation.spent,
      remaining: validation.remaining,
      finalAttrs: character.attrs,
      power: {
        budget: character.powerPointsBudget,
        spent: character.powerPointsSpent,
        remaining: character.powerPointsRemaining,
      },
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
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
    skills: skillsPayload(char),
    raceTraits: char.raceTraits || [],
    powerPointsRemaining: char.powerPointsRemaining,
    powerPointsBudget: char.powerPointsBudget,
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
  skillsPayload,
  RACES,
  CLASSES,
  WEAPONS,
};
