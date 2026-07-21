const { GoogleGenerativeAI } = require('@google/generative-ai');
const config = require('../config');

const SYSTEM_PROMPT = `Você é o Mestre de uma mesa de RPG no universo Tormenta (Arton).
Estilo: narrativo, vívido, conciso (2–4 frases). Tom de taverna/aventura.
Regras obrigatórias:
- NÃO role dados e NÃO invente números de dano/cura/HP.
- NÃO invente itens, poderes ou aliados que não estejam no estado.
- Responda APENAS JSON válido no schema pedido.
- partySize afeta a tensão: party grande = mundo mais hostil.
- Se mercyScore do ator for alto, dê "colher de chá": pistas, inimigos hesitam, saídas narrativas — sem quebrar o desafio por completo.
- intents devem refletir a ação do jogador (attack/move/cast/inspect/talk/use_item/wait).
- Para magias use spellKey: missil_magico | bola_de_fogo | cura_ferimentos | luz quando couber.
- targetId pode ser nome do inimigo, id, "self", ou null.`;

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
          maxOutputTokens: 1024,
          responseMimeType: 'application/json',
        },
      });
    }
  }

  async narrate({ action, actor, session, memory, mercy }) {
    const context = {
      action,
      actor: {
        name: actor.name,
        class: actor.classLabel || actor.classKey,
        hp: `${actor.hp}/${actor.hpMax}`,
        mp: `${actor.mp}/${actor.mpMax}`,
        status: actor.status,
        spells: actor.spells,
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
      map: 'Taverna de Arton',
    };

    if (!this.enabled) {
      return this.fallback(action, actor, session, mercy);
    }

    try {
      const prompt = `${SYSTEM_PROMPT}

Contexto:
${JSON.stringify(context, null, 2)}

Schema JSON:
{
  "narrative": "string",
  "intents": [{"type":"attack|move|inspect|talk|cast|use_item|wait","targetId":"string|null","spellKey":"string|null","dx":0,"dy":0,"skillHint":"string|null"}],
  "sceneHints": {"mood":"string","focusEntityId":"string|null"},
  "mercyNotes": "string|null"
}`;

      const result = await this.model.generateContent(prompt);
      const text = result.response.text();
      const parsed = JSON.parse(this.extractJson(text));
      if (!parsed.intents) parsed.intents = [];
      if (!parsed.narrative) parsed.narrative = 'Algo se move nas sombras da taverna.';
      return parsed;
    } catch (err) {
      console.error('[gm] gemini falhou, usando fallback:', err.message);
      return this.fallback(action, actor, session, mercy);
    }
  }

  extractJson(text) {
    const t = String(text || '').trim();
    if (t.startsWith('{')) return t;
    const m = t.match(/\{[\s\S]*\}/);
    return m ? m[0] : '{"narrative":"O mestre hesita.","intents":[{"type":"wait"}]}';
  }

  fallback(action, actor, session, mercy) {
    const lower = action.toLowerCase();
    const enemy = session.enemies.find((e) => e.hp > 0);
    const intents = [];
    let narrative = `${actor.name} observa o salão de madeira escura da Taverna de Arton.`;

    if (/atac|golpe|bater|ferir|lutar|espada|adaga/.test(lower) && enemy) {
      narrative = `${actor.name} avança entre as mesas em direção a ${enemy.name}. Tochas tremulam; o cheiro de cerveja mistura-se à tensão.`;
      intents.push({ type: 'attack', targetId: enemy.name });
    } else if (/cura|curar|heal/.test(lower)) {
      narrative = `${actor.name} canaliza a bênção de uma divindade de Arton, luz suave envolvendo as feridas.`;
      intents.push({ type: 'cast', spellKey: 'cura_ferimentos', targetId: 'self' });
    } else if (/bola|fogo|míssil|missil|magia|feiti/.test(lower)) {
      const spell = /bola|fogo/.test(lower) ? 'bola_de_fogo' : 'missil_magico';
      narrative = `${actor.name} traça runas no ar; energia arcana vibra sob o teto baixo da taverna.`;
      intents.push({ type: 'cast', spellKey: spell, targetId: enemy?.name || null });
    } else if (/anda|vou|corro|mov|norte|sul|leste|oeste/.test(lower)) {
      narrative = `${actor.name} se desloca pelo piso de tábuas rangentes.`;
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
        ? `${actor.name} nota uma porta lateral entreaberta e um goblin distraído — uma chance clara.`
        : `${actor.name} examina o salão: mesas, um balcão e criaturas hostis à espreita.`;
      intents.push({ type: 'inspect' });
    } else if (/falo|convers|digo|oi|olá/.test(lower)) {
      narrative = `Palavras ecoam na taverna. Nem todos os presentes parecem dispostos a negociar.`;
      intents.push({ type: 'talk', targetId: enemy?.name || null });
    } else {
      narrative = `${actor.name} age: "${action}". O ambiente responde com murmúrios e o ranger de madeira.`;
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
