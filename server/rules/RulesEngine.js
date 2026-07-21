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

  resolveAttack(attacker, defender, { isNpc = false, mercyMods = null } = {}) {
    const weapon = WEAPONS[attacker.weaponKey] || WEAPONS.clava;
    const atkAttr = weapon.attr || 'FOR';
    let attackMod = attrMod(attacker.attrs?.[atkAttr] || 10) + (attacker.attackBonus || 0);
    if (isNpc) attackMod = attacker.attackMod || attackMod;

    let defense = defender.defense || 10;
    if (!isNpc && mercyMods) {
      defense += mercyMods.defenseBonus || 0;
    }
    if (isNpc && mercyMods) {
      attackMod -= mercyMods.enemyAttackPenalty || 0;
    }

    const attackRoll = this.dice.d20(attackMod);
    const natural = attackRoll.rolls[0];
    const isCrit = natural >= (weapon.critRange || 20);
    const isFumble = natural === 1;
    const hit = !isFumble && (isCrit || attackRoll.total >= defense);

    const result = {
      type: 'attack',
      hit,
      isCrit,
      isFumble,
      // dice details stay server-side; only outcome exposed
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

    if (isNpc && mercyMods) {
      total = Math.max(1, Math.round(total * (mercyMods.enemyDamageMult || 1)));
    } else if (isNpc && attacker.dmgMult) {
      total = Math.max(1, Math.round(total * attacker.dmgMult));
    }

    result.damage = total;
    this.applyDamage(defender, total);
    if (!isNpc) registerSuccess(attacker);
    return result;
  }

  resolveSpell(caster, target, spellKey) {
    const spell = SPELLS[spellKey];
    if (!spell) return { type: 'spell', ok: false, reason: 'Magia desconhecida.' };
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

  resolveSkillCheck(actor, skillMod = 0, dc = 15) {
    const roll = this.dice.d20(skillMod);
    const success = roll.total >= dc;
    if (success) registerSuccess(actor);
    else registerFail(actor);
    return { type: 'check', success, dc };
  }

  applyDamage(target, amount) {
    target.hp = Math.max(0, (target.hp || 0) - amount);
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
