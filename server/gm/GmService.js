const { GoogleGenerativeAI } = require('@google/generative-ai');
const config = require('../config');

const SYSTEM_PROMPT = `Você é o Mestre de uma mesa de RPG Tormenta20 (Arton).
Estilo: RPG de mesa narrativo — história viva, diálogos, exploração, tensão e consequências.
NÃO é dungeon crawler: o tabuleiro só ilustra combate; a narrativa é o centro.

Regras obrigatórias:
- NÃO role dados e NÃO invente números de dano/cura/HP.
- NÃO invente itens, poderes, magias ou aliados que não estejam no estado do ator.
- Magias: SÓ use type "cast" e spellKey se a magia estiver em actor.spells.
- Habilidades: SÓ use type "skill" e skillKey se estiver em actor.skills com rank > 0.
- Se o jogador pedir algo que não conhece (ex.: Guerreiro pedindo bola de fogo), narre a falha
  (ele tenta e nada acontece / não sabe aquela magia) e use intent "wait" ou "inspect" — NUNCA cast/skill inválido.
- Responda APENAS JSON válido no schema pedido.
- partySize afeta a tensão: party grande = mundo mais hostil.
- Se mercyScore do ator for alto, dê "colher de chá": pistas, NPCs hesitam, saídas narrativas.
- intents devem refletir a ação real possível do personagem (attack/move/cast/skill/inspect/talk/use_item/wait).
- spellKey válidos apenas se o ator tiver: missil_magico | bola_de_fogo | cura_ferimentos | luz.
- Continuidade: cada sessão é uma aventura ÚNICA — avance a trama, não reinicie a taverna genérica.`;

const ADVENTURE_SEEDS = [
  {
    title: 'O Cálice Roubado',
    setting: 'Taverna de Arton, noite chuvosa',
    hook: 'O taberneiro grita que o cálice sagrado de Valkaria sumiu do altar improvisado atrás do balcão.',
  },
  {
    title: 'Sombras na Estrada Real',
    setting: 'Acampamento à beira da Estrada Real',
    hook: 'Um mensageiro sangrando cai entre as fogueiras pedindo escolta até o próximo posto — alguém o segue.',
  },
  {
    title: 'A Barganha do Corvo',
    setting: 'Mercado noturno de um vilarejo',
    hook: 'Um corvo mecânico entrega um bilhete: "Tragam a pedra azul antes do amanhecer, ou a criança some."',
  },
  {
    title: 'Ruínas do Deus da Tormenta',
    setting: 'Ruínas semi-afundadas sob névoa',
    hook: 'Runas antigas pulsam; algo desperta sob as pedras e pede um nome em troca de passagem.',
  },
  {
    title: 'Motim no Porto',
    setting: 'Doca fedorenta ao amanhecer',
    hook: 'Marinheiros cercam um capitão acusado de vender a tripulação a cultistas — a verdade não é simples.',
  },
  {
    title: 'O Funeral Que Não Era',
    setting: 'Capela de madeira na colina',
    hook: 'O caixão está vazio. A viúva jura ter visto o morto andando na névoa com olhos de fogo.',
  },
];

function knownSpellSet(actor) {
  return new Set(actor?.spells || []);
}

function knownSkillSet(actor) {
  const ranks = actor?.skillRanks || {};
  return new Set(Object.keys(ranks).filter((k) => ranks[k] > 0));
}

class GmService {
  constructor() {
    this.enabled = Boolean(config.gemini.apiKey);
    this.modelName = config.gemini.model;
    if (this.enabled) {
      this.genAI = new GoogleGenerativeAI(config.gemini.apiKey);
      this.model = this.genAI.getGenerativeModel({
        model: this.modelName,
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 2048,
          responseMimeType: 'application/json',
        },
      });
    }
  }

  pickAdventureSeed() {
    return ADVENTURE_SEEDS[Math.floor(Math.random() * ADVENTURE_SEEDS.length)];
  }

  /**
   * Remove intents de magia/habilidade que o personagem não possui.
   */
  sanitizeForActor(actor, gmOut) {
    const out = gmOut || { narrative: '', intents: [] };
    const spells = knownSpellSet(actor);
    const skills = knownSkillSet(actor);
    const intents = [];
    let blocked = false;

    for (const intent of out.intents || []) {
      const type = intent?.type || 'wait';
      if (type === 'cast') {
        const key = intent.spellKey || intent.skillHint;
        if (!key || !spells.has(key)) {
          blocked = true;
          continue;
        }
      }
      if (type === 'skill') {
        const key = intent.skillKey || intent.skillHint;
        if (!key || !skills.has(key)) {
          blocked = true;
          continue;
        }
      }
      intents.push(intent);
    }

    if (blocked) {
      if (!intents.length) intents.push({ type: 'wait' });
      const note = `${actor.name} tenta algo além do que sabe fazer — a magia ou o poder não responde.`;
      const nar = String(out.narrative || '').trim();
      if (!/não (conhece|sabe)|além do que sabe|não responde/i.test(nar)) {
        out.narrative = nar ? `${nar} ${note}` : note;
      }
    }

    out.intents = intents;
    return out;
  }

  async narrate({ action, actor, session, memory, mercy }) {
    const context = {
      action,
      adventure: session.adventure || null,
      actor: {
        name: actor.name,
        class: actor.classLabel || actor.classKey,
        hp: `${actor.hp}/${actor.hpMax}`,
        mp: `${actor.mp}/${actor.mpMax}`,
        status: actor.status,
        spells: actor.spells || [],
        skills: Object.entries(actor.skillRanks || {})
          .filter(([, r]) => r > 0)
          .map(([k, r]) => ({ key: k, rank: r })),
        position: { x: actor.x, y: actor.y },
        mercyScore: mercy.score,
      },
      partySize: session.scale.partySize,
      enemies: session.enemies
        .filter((e) => e.hp > 0)
        .map((e) => ({ id: e.id, name: e.name, hp: `${e.hp}/${e.hpMax}`, x: e.x, y: e.y })),
      allies: Object.values(session.characters).map((c) => ({
        name: c.name,
        hp: `${c.hp}/${c.hpMax}`,
        x: c.x,
        y: c.y,
      })),
      memory: (memory || '').slice(-1500),
    };

    if (!this.enabled) {
      return this.sanitizeForActor(actor, this.fallback(action, actor, session, mercy));
    }

    try {
      const prompt = `${SYSTEM_PROMPT}

Contexto:
${JSON.stringify(context, null, 2)}

Schema JSON:
{
  "narrative": "string (2–5 frases, tom de mesa de RPG)",
  "intents": [{"type":"attack|move|inspect|talk|cast|skill|use_item|wait","targetId":"string|null","spellKey":"string|null","skillKey":"string|null","dx":0,"dy":0,"skillHint":"string|null"}],
  "sceneHints": {"mood":"string","focusEntityId":"string|null"},
  "mercyNotes": "string|null"
}`;

      const result = await this.model.generateContent(prompt);
      const text = result.response.text();
      const parsed = this.parseModelJson(text);
      if (!parsed.intents) parsed.intents = [{ type: 'wait' }];
      if (!parsed.narrative) parsed.narrative = 'O mestre descreve a cena em silêncio tenso.';
      return this.sanitizeForActor(actor, parsed);
    } catch (err) {
      console.error('[gm] gemini falhou, usando fallback:', err.message);
      return this.sanitizeForActor(actor, this.fallback(action, actor, session, mercy));
    }
  }

  /**
   * Abertura narrativa única da sessão (IA ou seed).
   */
  async generateIntro(session) {
    const adventure = session.adventure || this.pickAdventureSeed();
    const party = Object.values(session.characters).map((c) => `${c.name} (${c.classLabel || c.classKey})`);
    const enemies = session.enemies.filter((e) => e.hp > 0).map((e) => e.name);

    if (!this.enabled) {
      return {
        narrative:
          `Aventura: ${adventure.title}. ${adventure.setting}. ${adventure.hook} ` +
          `Presentes: ${party.join(', ')}.` +
          (enemies.length ? ` Ameaças à vista: ${enemies.join(', ')}.` : ''),
        adventure,
      };
    }

    try {
      const prompt = `Você é o Mestre de Tormenta20. Escreva a ABERTURA de uma aventura de mesa ÚNICA.
Semente: ${JSON.stringify(adventure)}
Party: ${party.join(', ')}
Possíveis ameaças no cenário: ${enemies.join(', ') || 'nenhuma ainda'}

Responda APENAS JSON:
{
  "title": "string",
  "setting": "string",
  "narrative": "3–6 frases vividas abrindo a cena. Sem números de combate. Convide a party a agir."
}`;
      const result = await this.model.generateContent(prompt);
      const parsed = this.parseModelJson(result.response.text());
      return {
        narrative: parsed.narrative || `${adventure.hook}`,
        adventure: {
          title: parsed.title || adventure.title,
          setting: parsed.setting || adventure.setting,
          hook: adventure.hook,
        },
      };
    } catch (err) {
      console.error('[gm] intro falhou:', err.message);
      return {
        narrative: `${adventure.title}. ${adventure.setting}. ${adventure.hook}`,
        adventure,
      };
    }
  }

  extractJson(text) {
    let t = String(text || '').trim();
    t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    if (t.startsWith('{')) return t;
    const m = t.match(/\{[\s\S]*\}/);
    return m ? m[0] : '';
  }

  parseModelJson(text) {
    const raw = this.extractJson(text);
    if (!raw) throw new Error('Resposta sem JSON');

    try {
      return JSON.parse(raw);
    } catch (e1) {
      // Tenta fechar aspas/chaves truncadas
      let fixed = raw
        .replace(/,\s*([}\]])/g, '$1')
        .replace(/[\u0000-\u001f]+/g, ' ');
      if (!/"\s*$/.test(fixed) && (fixed.match(/"/g) || []).length % 2 === 1) {
        fixed += '"';
      }
      const open = (fixed.match(/\{/g) || []).length;
      const close = (fixed.match(/\}/g) || []).length;
      if (open > close) fixed += '}'.repeat(open - close);

      try {
        return JSON.parse(fixed);
      } catch (e2) {
        const narrative = this.pullField(raw, 'narrative')
          || this.pullField(text, 'narrative')
          || String(text || '').replace(/[{}\[\]"]/g, ' ').trim().slice(0, 500);
        if (!narrative) throw e1;
        console.warn('[gm] JSON parcial recuperado via narrative');
        return {
          narrative,
          intents: [{ type: 'wait' }],
          title: this.pullField(raw, 'title') || undefined,
          setting: this.pullField(raw, 'setting') || undefined,
        };
      }
    }
  }

  pullField(text, field) {
    const re = new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`, 'i');
    const m = String(text || '').match(re);
    if (!m) return null;
    try {
      return JSON.parse(`"${m[1]}"`);
    } catch {
      return m[1];
    }
  }

  fallback(action, actor, session, mercy) {
    const lower = action.toLowerCase();
    const enemy = session.enemies.find((e) => e.hp > 0);
    const spells = knownSpellSet(actor);
    const intents = [];
    let narrative = `${actor.name} observa a cena com atenção.`;

    if (/atac|golpe|bater|ferir|lutar|espada|adaga|embate/.test(lower)) {
      if (enemy) {
        narrative = `${actor.name} avança em direção a ${enemy.name}, pronto para o embate.`;
        intents.push({ type: 'attack', targetId: enemy.name });
      } else {
        narrative = `${actor.name} parte para o confronto — uma ameaça se revela nas sombras!`;
        intents.push({ type: 'attack', targetId: null });
      }
    } else if (/cura|curar|heal/.test(lower)) {
      if (spells.has('cura_ferimentos')) {
        narrative = `${actor.name} canaliza uma bênção, luz suave envolvendo as feridas.`;
        intents.push({ type: 'cast', spellKey: 'cura_ferimentos', targetId: 'self' });
      } else {
        narrative = `${actor.name} tenta invocar uma cura, mas não conhece essa magia.`;
        intents.push({ type: 'wait' });
      }
    } else if (/bola|fogo|míssil|missil|magia|feiti|feitiço/.test(lower)) {
      let spell = null;
      if (/bola|fogo/.test(lower) && spells.has('bola_de_fogo')) spell = 'bola_de_fogo';
      else if (/míssil|missil/.test(lower) && spells.has('missil_magico')) spell = 'missil_magico';
      else if (spells.has('missil_magico')) spell = 'missil_magico';
      else if (spells.has('bola_de_fogo')) spell = 'bola_de_fogo';

      if (spell) {
        narrative = `${actor.name} traça runas no ar; energia arcana vibra na cena.`;
        intents.push({ type: 'cast', spellKey: spell, targetId: enemy?.name || null });
      } else {
        const cls = actor.classLabel || actor.classKey || 'aventureiro';
        narrative =
          `${actor.name} concentra-se e tenta conjurar... mas como ${cls} não conhece essa magia. ` +
          `Nada acontece além do olhar curioso dos presentes.`;
        intents.push({ type: 'wait' });
      }
    } else if (/anda|vou|corro|mov|norte|sul|leste|oeste/.test(lower)) {
      narrative = `${actor.name} se desloca pelo cenário.`;
      let dx = 0;
      let dy = 0;
      if (/norte|cima/.test(lower)) dy = -1;
      if (/sul|baixo/.test(lower)) dy = 1;
      if (/leste|direita/.test(lower)) dx = 1;
      if (/oeste|esquerda/.test(lower)) dx = -1;
      if (!dx && !dy) dy = -1;
      intents.push({ type: 'move', dx, dy });
    } else if (/inspec|olho|procuro|olhar|exam/.test(lower)) {
      narrative = mercy.score >= 0.4
        ? `${actor.name} nota um detalhe útil — uma pista clara na cena.`
        : `${actor.name} examina o entorno com cuidado.`;
      intents.push({ type: 'inspect' });
    } else if (/falo|convers|digo|oi|olá|respondo|declaro|chamo|nome/.test(lower) || action.trim().split(/\s+/).length <= 6) {
      const adv = session.adventure;
      const setting = adv?.setting || 'a cena';
      narrative =
        `${actor.name} responde: "${action.trim()}". ` +
        `Em ${setting}, a presença parece absorver as palavras — o ar vibra, runas ou olhares se voltam para o grupo. ` +
        `Algo mudou. O que fazem a seguir?`;
      intents.push({ type: 'talk', targetId: enemy?.name || null });
    } else {
      const adv = session.adventure;
      narrative =
        `${actor.name} age: "${action}". ` +
        (adv
          ? `Em ${adv.setting}, a trama de "${adv.title}" reage de forma sutil — um detalhe novo aparece, mas a tensão permanece.`
          : 'A cena se rearrange em torno da ação.');
      intents.push({ type: 'wait' });
    }

    return {
      narrative,
      intents,
      sceneHints: { mood: 'tense', focusEntityId: enemy?.id || null },
      mercyNotes: mercy.score >= 0.4 ? 'oferecer pista/saída' : null,
    };
  }
}

module.exports = GmService;
