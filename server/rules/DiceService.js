/**
 * DiceService — Tormenta20 dice expressions (hidden from clients).
 * Supports d4, d6, d8, d10, d12, d20 and NdX[+/-]M
 */
class DiceService {
  constructor({ debug = false } = {}) {
    this.debug = debug;
  }

  rollDie(faces) {
    const allowed = [4, 6, 8, 10, 12, 20];
    if (!allowed.includes(faces)) {
      throw new Error(`Dado inválido: d${faces}`);
    }
    return 1 + Math.floor(Math.random() * faces);
  }

  /**
   * @param {string} expr e.g. "1d20+5", "2d6+3", "1d8", "3d6"
   * @returns {{ total: number, rolls: number[], modifier: number, expr: string }}
   */
  roll(expr) {
    const cleaned = String(expr).toLowerCase().replace(/\s+/g, '');
    const m = cleaned.match(/^(\d+)d(4|6|8|10|12|20)([+-]\d+)?$/);
    if (!m) throw new Error(`Expressão de dado inválida: ${expr}`);

    const count = parseInt(m[1], 10);
    const faces = parseInt(m[2], 10);
    const modifier = m[3] ? parseInt(m[3], 10) : 0;
    if (count < 1 || count > 40) throw new Error(`Quantidade de dados inválida: ${count}`);

    const rolls = [];
    for (let i = 0; i < count; i += 1) rolls.push(this.rollDie(faces));
    const total = rolls.reduce((a, b) => a + b, 0) + modifier;

    if (this.debug) {
      console.log(`[dice] ${cleaned} -> [${rolls.join(',')}]${modifier ? (modifier > 0 ? `+${modifier}` : modifier) : ''} = ${total}`);
    }

    return { total, rolls, modifier, expr: cleaned, faces, count };
  }

  /** d20 test/attack/resistance */
  d20(modifier = 0) {
    return this.roll(`1d20${modifier >= 0 ? `+${modifier}` : modifier}`);
  }

  /** Weapon/spell damage or heal */
  damage(expr, extraMod = 0) {
    const base = this.roll(expr);
    if (!extraMod) return base;
    return {
      ...base,
      modifier: base.modifier + extraMod,
      total: base.total + extraMod,
      expr: `${base.expr}${extraMod >= 0 ? `+${extraMod}` : extraMod}`,
    };
  }
}

module.exports = DiceService;
