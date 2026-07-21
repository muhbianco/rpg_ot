const { GoogleGenerativeAI } = require('@google/generative-ai');
const config = require('../config');
const { currentRoom, normalizeCampaign, buildFallbackCampaign } = require('../game/AdventureCampaign');

const SYSTEM_PROMPT = `Você é o Mestre de uma mesa de RPG Tormenta20 (Arton).
Estilo: RPG de mesa narrativo longo — história viva, diálogos, exploração, tensão e consequências.
A aventura tem VÁRIAS SALAS/CENAS. A party só avança de sala quando o objetivo da sala atual for cumprido.
NÃO é dungeon crawler: o tabuleiro ilustra a cena; a narrativa é o centro.

Regras obrigatórias:
- NÃO role dados e NÃO invente números de dano/cura/HP.
- NÃO invente itens, poderes, magias ou aliados que não estejam no estado.
- Magias: SÓ "cast" se spellKey estiver em actor.spells.
- Habilidades: SÓ "skill" se skillKey estiver em actor.skills com rank > 0.
- Se o jogador pedir algo que não conhece, narre a falha e use wait/inspect.
- Responda APENAS JSON válido.
- Continuidade: respeite a sala atual, o objetivo e a memória.
- Liste novos NPCs em "npcs" quando entrarem na cena.
- objectiveProgress: "none" | "partial" | "complete"
  - complete SOMENTE se o critério completeWhen da sala atual foi claramente atingido pela ação/narrativa.
  - Não marque complete por combate genérico ou por o jogador só tentar algo.
- Turno do jogador: movimento + 1 ação. Se a ação for inválida (magia/habilidade que não conhece, fora de alcance),
  narre a falha e use intent "wait" — o servidor NÃO avançará o turno.`;

const ADVENTURE_SEEDS = [
  {
    title: 'O Cálice Roubado',
    setting: 'Taverna de Arton, noite chuvosa',
    hook: 'O taberneiro grita que o cálice sagrado de Valkaria sumiu do altar improvisado atrás do balcão.',
    layoutKey: 'tavern',
  },
  {
    title: 'Sombras na Estrada Real',
    setting: 'Acampamento à beira da Estrada Real',
    hook: 'Um mensageiro sangrando cai entre as fogueiras pedindo escolta até o próximo posto — alguém o segue.',
    layoutKey: 'road_camp',
  },
  {
    title: 'A Barganha do Corvo',
    setting: 'Mercado noturno de um vilarejo',
    hook: 'Um corvo mecânico entrega um bilhete: "Tragam a pedra azul antes do amanhecer, ou a criança some."',
    layoutKey: 'market',
  },
  {
    title: 'Ruínas do Deus da Tormenta',
    setting: 'Ruínas semi-afundadas sob névoa',
    hook: 'Runas antigas pulsam; algo desperta sob as pedras e pede um nome em troca de passagem.',
    layoutKey: 'ruins',
  },
  {
    title: 'Motim no Porto',
    setting: 'Doca fedorenta ao amanhecer',
    hook: 'Marinheiros cercam um capitão acusado de vender a tripulação a cultistas — a verdade não é simples.',
    layoutKey: 'docks',
  },
  {
    title: 'O Funeral Que Não Era',
    setting: 'Capela de madeira na colina',
    hook: 'O caixão está vazio. A viúva jura ter visto o morto andando na névoa com olhos de fogo.',
    layoutKey: 'chapel',
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
          maxOutputTokens: 4096,
          responseMimeType: 'application/json',
        },
      });
    }
  }

  pickAdventureSeed() {
    return ADVENTURE_SEEDS[Math.floor(Math.random() * ADVENTURE_SEEDS.length)];
  }

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
    if (!out.objectiveProgress) out.objectiveProgress = 'none';
    if (!out.npcs) out.npcs = [];
    if (blocked) out.invalidAttempt = true;
    return out;
  }

  async narrate({ action, actor, session, memory, mercy }) {
    const room = currentRoom(session.campaign);
    const context = {
      action,
      campaign: session.campaign
        ? {
            title: session.campaign.title,
            premise: session.campaign.premise,
            roomIndex: (session.campaign.roomIndex || 0) + 1,
            roomTotal: session.campaign.rooms?.length || 0,
          }
        : null,
      room: room
        ? {
            name: room.name,
            objective: room.objective,
            completeWhen: room.completeWhen,
            layoutKey: room.layoutKey,
          }
        : null,
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
      npcs: (session.npcs || []).map((n) => ({
        id: n.id,
        name: n.name,
        role: n.role,
        mood: n.mood,
        x: n.x,
        y: n.y,
      })),
      allies: Object.values(session.characters).map((c) => ({
        name: c.name,
        hp: `${c.hp}/${c.hpMax}`,
        x: c.x,
        y: c.y,
      })),
      memory: (memory || '').slice(-1800),
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
  "narrative": "string (3–6 frases; reaja à ação e ao objetivo da sala)",
  "intents": [{"type":"attack|move|inspect|talk|cast|skill|use_item|wait","targetId":"string|null","spellKey":"string|null","skillKey":"string|null","dx":0,"dy":0}],
  "npcs": [{"name":"string","role":"string","mood":"string"}],
  "objectiveProgress": "none|partial|complete",
  "objectiveNote": "string|null",
  "sceneHints": {"mood":"string","focusEntityId":"string|null"},
  "mercyNotes": "string|null"
}`;

      const result = await this.model.generateContent(prompt);
      const parsed = this.parseModelJson(result.response.text());
      if (!parsed.intents) parsed.intents = [{ type: 'wait' }];
      if (!parsed.npcs) parsed.npcs = [];
      if (!parsed.objectiveProgress) parsed.objectiveProgress = 'none';
      if (!parsed.narrative) parsed.narrative = 'O mestre descreve a cena em silêncio tenso.';
      return this.sanitizeForActor(actor, parsed);
    } catch (err) {
      console.error('[gm] gemini falhou, usando fallback:', err.message);
      return this.sanitizeForActor(actor, this.fallback(action, actor, session, mercy));
    }
  }

  async generateCampaign(session) {
    const seed = session.adventure || this.pickAdventureSeed();
    const party = Object.values(session.characters).map((c) => `${c.name} (${c.classLabel || c.classKey})`);

    if (!this.enabled) {
      const campaign = buildFallbackCampaign(seed);
      const room = campaign.rooms[0];
      return {
        campaign,
        narrative:
          `${campaign.title}. ${campaign.premise} ` +
          `Vocês estão em ${room.name}. Objetivo: ${room.objective} Party: ${party.join(', ')}.`,
        npcs: room.npcs || [],
      };
    }

    try {
      const prompt = `Você é o Mestre de Tormenta20. Crie uma AVENTURA LONGA de mesa (não uma única sala).
Semente: ${JSON.stringify(seed)}
Party: ${party.join(', ')}

layoutKey válidos: tavern | road_camp | market | ruins | docks | chapel

Responda APENAS JSON:
{
  "title": "string",
  "premise": "1–2 frases do arco geral",
  "rooms": [
    {
      "name": "nome da cena/sala",
      "layoutKey": "tavern",
      "objective": "o que a party precisa conquistar AQUI",
      "completeWhen": "critério claro de sucesso desta sala",
      "npcs": [{"name":"string","role":"string","mood":"string"}]
    }
  ],
  "openingNarrative": "4–7 frases abrindo a PRIMEIRA sala, apresentando NPCs e o objetivo sem spoilar o final"
}

Regras: 4 a 6 salas; cada sala com objetivo distinto; progressão geográfica/narrativa; última sala é o desfecho.`;

      const result = await this.model.generateContent(prompt);
      const parsed = this.parseModelJson(result.response.text());
      const campaign = normalizeCampaign(parsed, seed);
      const room = campaign.rooms[0];
      return {
        campaign,
        narrative:
          parsed.openingNarrative
          || `${campaign.title}. ${campaign.premise} Vocês estão em ${room.name}. Objetivo: ${room.objective}`,
        npcs: (parsed.rooms?.[0]?.npcs?.length ? parsed.rooms[0].npcs : room.npcs) || [],
      };
    } catch (err) {
      console.error('[gm] campaign falhou:', err.message);
      const campaign = buildFallbackCampaign(seed);
      const room = campaign.rooms[0];
      return {
        campaign,
        narrative: `${campaign.title}. ${campaign.premise} Em ${room.name}: ${room.objective}`,
        npcs: room.npcs || [],
      };
    }
  }

  async generateIntro(session) {
    return this.generateCampaign(session);
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
          || this.pullField(raw, 'openingNarrative')
          || this.pullField(text, 'narrative')
          || String(text || '').replace(/[{}\[\]"]/g, ' ').trim().slice(0, 500);
        if (!narrative) throw e1;
        console.warn('[gm] JSON parcial recuperado via narrative');
        return {
          narrative,
          openingNarrative: narrative,
          intents: [{ type: 'wait' }],
          objectiveProgress: 'none',
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
    const room = currentRoom(session.campaign);
    const intents = [];
    let narrative = `${actor.name} observa a cena com atenção.`;
    let objectiveProgress = 'none';

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
        narrative = `${actor.name} concentra-se... mas como ${cls} não conhece essa magia.`;
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
    } else if (/inspec|olho|procuro|olhar|exam|pergun|pista|investig/.test(lower)) {
      narrative = room
        ? `${actor.name} investiga ${room.name}. Algo útil sobre o objetivo (“${room.objective}”) começa a surgir.`
        : `${actor.name} examina o entorno com cuidado.`;
      intents.push({ type: 'inspect' });
      objectiveProgress = 'partial';
    } else if (/falo|convers|digo|oi|olá|respondo|declaro|chamo|nome/.test(lower) || action.trim().split(/\s+/).length <= 8) {
      const npc = (session.npcs || [])[0];
      narrative = npc
        ? `${actor.name} fala com ${npc.name}: "${action.trim()}". ${npc.name} reage — a conversa empurra a trama.`
        : `${actor.name} responde: "${action.trim()}". A cena absorve as palavras.`;
      intents.push({ type: 'talk', targetId: npc?.name || null });
      objectiveProgress = 'partial';
    } else {
      narrative = room
        ? `${actor.name} age: "${action}". Em ${room.name}, a trama se move um pouco em direção a: ${room.objective}`
        : `${actor.name} age: "${action}". A cena se rearrange.`;
      intents.push({ type: 'wait' });
      objectiveProgress = 'partial';
    }

    return {
      narrative,
      intents,
      npcs: [],
      objectiveProgress,
      objectiveNote: null,
      sceneHints: { mood: 'tense', focusEntityId: enemy?.id || null },
      mercyNotes: mercy.score >= 0.4 ? 'oferecer pista/saída' : null,
    };
  }
}

module.exports = GmService;
