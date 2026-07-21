const DiceService = require('./DiceService');
const { WEAPONS, SPELLS, attrMod } = require('./catalog');
const {
  computeMercyScore,
  mercyCombatModifiers,
  registerFail,
  registerSuccess,
  registerDown,
} = require('./MercyService');

class RulesEngine {
  constructor() {
    this.dice = new DiceService({ debug: process.env.DICE_DEBUG === '1' });
  }

  resolveSpell(caster, target, spellKey) {
    const spell = SPELLS[spellKey];
    if (!spell) return { type: 'spell', ok: false, reason: 'Magia desconhecida.' };
    const known = caster.spells || [];
    if (!known.includes(spellKey)) {
      return { type: 'spell', ok: false, reason: `${caster.name} não conhece ${spell.label}.` };
    }
    if ((caster.mp || 0) < spell.cost) {
      return { type: 'spell', ok: false, reason: 'PM insuficientes.' };
    }

    caster.mp -= spell.cost;

    if (spell.type === 'heal') {
      const heal = this.dice.damage(spell.healDice);
      const before = target.hp;
      target.hp = Math.min(target.hpMax, target.hp + heal.total);
      if (target.status?.includes('incapacitado') && target.hp > 0) {
        target.status = target.status.filter((s) => s !== 'incapacitado');
      }
      registerSuccess(caster);
      return {
        type: 'spell',
        ok: true,
        spell: spell.label,
        healed: target.hp - before,
        targetId: target.id,
      };
    }

    if (spell.type === 'utility') {
      registerSuccess(caster);
      return { type: 'spell', ok: true, spell: spell.label, utility: true };
    }

    // damage spell
    if (spell.autoHit) {
      const dmg = this.dice.damage(spell.damageDice);
      this.applyDamage(target, dmg.total);
      registerSuccess(caster);
      return { type: 'spell', ok: true, spell: spell.label, hit: true, damage: dmg.total };
    }

    const saveMod = attrMod(target.attrs?.[spell.saveAttr || 'DES'] || 10);
    const save = this.dice.d20(saveMod);
    const dc = 10 + attrMod(caster.attrs?.INT || caster.attrs?.SAB || 10) + 2;
    const half = save.total >= dc;
    const dmg = this.dice.damage(spell.damageDice);
    const dealt = half ? Math.floor(dmg.total / 2) : dmg.total;
    this.applyDamage(target, dealt);
    registerSuccess(caster);
    return {
      type: 'spell',
      ok: true,
      spell: spell.label,
      hit: true,
      saved: half,
      damage: dealt,
    };
  }

  /**
   * Resolve habilidade de classe (poder Tormenta).
   * @param {object} actor
   * @param {object|null} target
   * @param {string} skillKey
   * @param {object} skillDef — do catálogo SKILLS
   * @param {number} rank
   */
  resolveSkill(actor, target, skillKey, skillDef, rank = 1) {
    const r = Math.max(1, Number(rank) || 1);
    const scale = attrMod(actor.attrs?.[skillDef.scaleAttr] || 10);
    const cdLeft = actor.skillCooldowns?.[skillKey] || 0;
    if (cdLeft > 0) {
      return { ok: false, reason: `${skillDef.label} em recarga (${cdLeft} turno(s)).` };
    }
    if ((actor.mp || 0) < (skillDef.mpCost || 0)) {
      return { ok: false, reason: 'PM insuficientes.' };
    }

    actor.mp = (actor.mp || 0) - (skillDef.mpCost || 0);
    actor.skillCooldowns = actor.skillCooldowns || {};
    actor.skillCooldowns[skillKey] = skillDef.cooldown;

    const out = {
      ok: true,
      type: 'skill',
      skillKey,
      skill: skillDef.label,
      rank: r,
      damage: 0,
      healed: 0,
      outcome: 'ok',
    };

    if (skillDef.type === 'buff_self') {
      if (skillKey === 'postura_defensiva') {
        actor.tempDefenseBonus = (actor.tempDefenseBonus || 0) + 2 + (r - 1);
      } else if (skillKey === 'esquiva_sobrenatural') {
        actor.tempDefenseBonus = (actor.tempDefenseBonus || 0) + 3 + (r - 1);
      } else if (skillKey === 'escudo_arcano') {
        actor.tempDefenseBonus = (actor.tempDefenseBonus || 0) + 2 + (r - 1);
      } else if (skillKey === 'bencao') {
        actor.tempDefenseBonus = (actor.tempDefenseBonus || 0) + 1;
        actor.tempAttackBonus = (actor.tempAttackBonus || 0) + 1 + (r - 1);
      }
      actor.defense = (actor.baseDefense || actor.defense) + (actor.tempDefenseBonus || 0);
      registerSuccess(actor);
      out.summary = `${actor.name} usa ${skillDef.label}.`;
      return out;
    }

    if (skillDef.type === 'heal') {
      const tgt = target || actor;
      const healRoll = this.dice.damage(`1d8+${Math.max(0, scale * r)}`);
      const before = tgt.hp;
      tgt.hp = Math.min(tgt.hpMax, tgt.hp + healRoll.total);
      if (tgt.status?.includes('incapacitado') && tgt.hp > 0) {
        tgt.status = tgt.status.filter((s) => s !== 'incapacitado');
      }
      out.healed = tgt.hp - before;
      out.targetId = tgt.id;
      registerSuccess(actor);
      return out;
    }

    if (skillDef.type === 'auto_damage') {
      if (!target || target.kind === 'player') {
        return { ok: false, reason: 'Alvo inválido.' };
      }
      const bonus = Math.max(0, scale * r);
      const dmg = this.dice.damage('1d4+1', bonus);
      this.applyDamage(target, dmg.total, { fire: false, source: actor });
      out.damage = dmg.total;
      out.hit = true;
      out.outcome = 'hit';
      out.targetId = target.id;
      registerSuccess(actor);
      return out;
    }

    if (skillDef.type === 'damage_save') {
      if (!target || target.kind === 'player') {
        return { ok: false, reason: 'Alvo inválido.' };
      }
      const bonus = Math.max(0, scale * r);
      const dmg = this.dice.damage('2d6', bonus);
      const saveMod = attrMod(target.attrs?.DES || 10);
      const save = this.dice.d20(saveMod);
      const dc = 10 + scale + 2;
      const half = save.total >= dc;
      const dealt = half ? Math.floor(dmg.total / 2) : dmg.total;
      this.applyDamage(target, dealt, { fire: true, source: actor });
      out.damage = dealt;
      out.saved = half;
      out.hit = true;
      out.outcome = 'hit';
      out.targetId = target.id;
      registerSuccess(actor);
      return out;
    }

    if (skillDef.type === 'attack') {
      if (!target || target.kind === 'player') {
        return { ok: false, reason: 'Alvo inválido.' };
      }
      const opts = { skillKey, skillRank: r, scale };
      const atk = this.resolveAttack(actor, target, opts);
      out.hit = atk.hit;
      out.isCrit = atk.isCrit;
      out.outcome = atk.outcome;
      out.damage = atk.damage;
      out.targetId = target.id;
      return out;
    }

    return { ok: false, reason: 'Tipo de habilidade não suportado.' };
  }

  resolveAttack(attacker, defender, { isNpc = false, mercyMods = null, skillKey = null, skillRank = 1, scale = 0 } = {}) {
    const weapon = WEAPONS[attacker.weaponKey] || WEAPONS.clava;
    const atkAttr = weapon.attr || 'FOR';
    let attackMod = attrMod(attacker.attrs?.[atkAttr] || 10) + (attacker.attackBonus || 0) + (attacker.tempAttackBonus || 0);
    if (isNpc) attackMod = attacker.attackMod || attackMod;

    let defense = (defender.defense || 10);
    // defesa efetiva com buffs temporários do defensor já estão em defender.defense

    if (skillKey === 'golpe_demolidor') {
      defense = Math.max(1, defense - 2);
    }
    if (skillKey === 'golpe_preciso') {
      attackMod += 2;
    }

    if (!isNpc && mercyMods) {
      defense += mercyMods.defenseBonus || 0;
    }
    if (isNpc && mercyMods) {
      attackMod -= mercyMods.enemyAttackPenalty || 0;
    }

    const attackRoll = this.dice.d20(attackMod);
    const natural = attackRoll.rolls[0];
    let critRange = weapon.critRange || 20;
    if (skillKey === 'golpe_preciso') critRange = Math.min(critRange, 18);

    const isCrit = natural >= critRange;
    const isFumble = natural === 1;
    const hit = !isFumble && (isCrit || attackRoll.total >= defense);

    const result = {
      type: 'attack',
      hit,
      isCrit,
      isFumble,
      outcome: hit ? (isCrit ? 'critical' : 'hit') : (isFumble ? 'fumble' : 'miss'),
      damage: 0,
    };

    if (!hit) {
      if (!isNpc) registerFail(attacker);
      return result;
    }

    let dmg = this.dice.damage(weapon.damageDice, attrMod(attacker.attrs?.[atkAttr] || 10));
    let total = dmg.total;

    if (isCrit) {
      const extra = this.dice.damage(weapon.damageDice, 0);
      total += extra.total * ((weapon.critMult || 2) - 1);
    }

    // Bônus de habilidades
    if (skillKey === 'ataque_especial') {
      total += Math.max(0, scale) * skillRank + Math.max(0, scale);
    } else if (skillKey === 'golpe_demolidor') {
      total += 2 + skillRank;
    } else if (skillKey === 'ataque_furtivo') {
      const sneak = this.dice.damage(`1d6+${Math.max(0, scale * skillRank)}`);
      total += sneak.total;
    } else if (skillKey === 'ira_sagrada') {
      const holy = this.dice.damage(`1d6+${Math.max(0, scale * skillRank)}`);
      total += holy.total;
    } else if (skillKey === 'golpe_preciso') {
      total += skillRank;
    }

    if (isNpc && mercyMods) {
      total = Math.max(1, Math.round(total * (mercyMods.enemyDamageMult || 1)));
    } else if (isNpc && attacker.dmgMult) {
      total = Math.max(1, Math.round(total * attacker.dmgMult));
    }

    result.damage = total;
    this.applyDamage(defender, total, { source: attacker });
    if (!isNpc) registerSuccess(attacker);
    return result;
  }

  applyDamage(target, amount, { fire = false, source = null } = {}) {
    let dmg = amount;
    // Redução racial do alvo
    if (target.raceTraitsCombat?.damageReduction) {
      dmg = Math.max(1, dmg - target.raceTraitsCombat.damageReduction);
    }
    if (fire && target.raceTraitsCombat?.fireResist) {
      dmg = Math.max(0, dmg - target.raceTraitsCombat.fireResist);
    }
    target.hp = Math.max(0, (target.hp || 0) - dmg);
    if (target.hp <= 0) {
      registerDown(target);
    }
  }

  mercyFor(char) {
    const score = computeMercyScore(char);
    return { score, mods: mercyCombatModifiers(score) };
  }
}

module.exports = RulesEngine;
