/**
 * MercyService — "colher de chá" para players sofrendo.
 * mercyScore 0..1
 */
function computeMercyScore(char) {
  if (!char) return 0;
  const hpRatio = char.hpMax > 0 ? char.hp / char.hpMax : 1;
  const mercy = char.mercy || {};
  const deaths = mercy.deaths || 0;
  const fails = mercy.failStreak || 0;
  const punishments = mercy.punishments || 0;

  let score = 0;
  if (hpRatio <= 0.25) score += 0.45;
  else if (hpRatio <= 0.5) score += 0.25;
  else if (hpRatio <= 0.7) score += 0.1;

  score += Math.min(0.3, deaths * 0.15);
  score += Math.min(0.2, fails * 0.05);
  score += Math.min(0.2, punishments * 0.05);

  return Math.max(0, Math.min(1, score));
}

function mercyCombatModifiers(mercyScore) {
  return {
    defenseBonus: Math.floor(mercyScore * 3),
    enemyAttackPenalty: Math.floor(mercyScore * 4),
    enemyDamageMult: Math.max(0.55, 1 - mercyScore * 0.35),
    preferOtherTargets: mercyScore >= 0.55,
    forceHint: mercyScore >= 0.4,
  };
}

function registerFail(char) {
  char.mercy = char.mercy || { deaths: 0, failStreak: 0, punishments: 0 };
  char.mercy.failStreak += 1;
}

function registerSuccess(char) {
  char.mercy = char.mercy || { deaths: 0, failStreak: 0, punishments: 0 };
  char.mercy.failStreak = 0;
}

function registerDown(char) {
  char.mercy = char.mercy || { deaths: 0, failStreak: 0, punishments: 0 };
  char.mercy.deaths += 1;
  char.status = Array.isArray(char.status) ? char.status : [];
  if (!char.status.includes('incapacitado')) char.status.push('incapacitado');
  char.hp = 0;
}

module.exports = {
  computeMercyScore,
  mercyCombatModifiers,
  registerFail,
  registerSuccess,
  registerDown,
};
