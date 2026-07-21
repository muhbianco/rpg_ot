/**
 * Campanha multi-sala: cada sala tem objetivo; cumprir avança a narrativa.
 */

const LAYOUTS = ['tavern', 'road_camp', 'market', 'ruins', 'docks', 'chapel'];

function normalizeLayout(key) {
  const k = String(key || '').toLowerCase();
  if (LAYOUTS.includes(k)) return k;
  if (/taverna|inn|balcão/.test(k)) return 'tavern';
  if (/estrada|camp|fogueira/.test(k)) return 'road_camp';
  if (/mercado|feira/.test(k)) return 'market';
  if (/ruína|ruin|cripta|caverna|templo/.test(k)) return 'ruins';
  if (/porto|doca|navio/.test(k)) return 'docks';
  if (/capela|igreja|cemitério/.test(k)) return 'chapel';
  return 'tavern';
}

/**
 * Campanha fallback (sem IA) a partir de uma semente.
 */
function buildFallbackCampaign(seed) {
  const title = seed.title || 'Aventura em Arton';
  const roomsBySeed = {
    'O Cálice Roubado': [
      {
        name: 'Taverna de Arton',
        layoutKey: 'tavern',
        objective: 'Acalmar o taberneiro e obter a primeira pista sobre o cálice.',
        completeWhen: 'A party consegue informações úteis do taberneiro ou de um freguês.',
        npcs: [
          { name: 'Taberneiro', role: 'innkeeper', mood: 'alarmed' },
          { name: 'Freguês', role: 'patron', mood: 'nervous' },
        ],
      },
      {
        name: 'Beco atrás da taverna',
        layoutKey: 'market',
        objective: 'Seguir o rastro e confrontar ou interrogar o suspeito.',
        completeWhen: 'A party obtém uma confissão, um objeto roubado parcial, ou uma direção clara.',
        npcs: [{ name: 'Informante', role: 'tipster', mood: 'shady' }],
      },
      {
        name: 'Capela abandonada',
        layoutKey: 'chapel',
        objective: 'Recuperar o cálice sem deixar o vilão fugir com ele.',
        completeWhen: 'O cálice está com a party ou o ladrão foi rendido/derrotado.',
        npcs: [{ name: 'Cultista', role: 'cultist', mood: 'hostile' }],
      },
      {
        name: 'Retorno à taverna',
        layoutKey: 'tavern',
        objective: 'Devolver o cálice e fechar a trama com o taberneiro.',
        completeWhen: 'O cálice é devolvido e a taverna reconhece a party.',
        npcs: [{ name: 'Taberneiro', role: 'innkeeper', mood: 'hopeful' }],
      },
    ],
    'Sombras na Estrada Real': [
      {
        name: 'Acampamento na Estrada Real',
        layoutKey: 'road_camp',
        objective: 'Estabilizar o mensageiro e aceitar (ou recusar com custo) a escolta.',
        completeWhen: 'A party decide o rumo e obtém o destino do próximo posto.',
        npcs: [{ name: 'Mensageiro', role: 'messenger', mood: 'wounded' }],
      },
      {
        name: 'Clareira da emboscada',
        layoutKey: 'ruins',
        objective: 'Sobreviver à emboscada ou negociar passagem.',
        completeWhen: 'Os perseguidores são afastados, derrotados ou convencidos a recuar.',
        npcs: [],
      },
      {
        name: 'Posto de guarda',
        layoutKey: 'docks',
        objective: 'Entregar o mensageiro / mensagem em segurança.',
        completeWhen: 'A mensagem chega ao destinatário ou o posto assume a guarda.',
        npcs: [{ name: 'Sargento', role: 'guard', mood: 'stern' }],
      },
      {
        name: 'Fogos do acampamento',
        layoutKey: 'road_camp',
        objective: 'Descobrir quem ordenou a perseguição.',
        completeWhen: 'A party revela o mandante ou obtém uma prova decisiva.',
        npcs: [{ name: 'Mensageiro', role: 'messenger', mood: 'relieved' }],
      },
    ],
  };

  const rooms = (roomsBySeed[title] || defaultRooms(seed)).map((r, i) => ({
    id: `room_${i + 1}`,
    index: i,
    name: r.name,
    layoutKey: normalizeLayout(r.layoutKey),
    objective: r.objective,
    completeWhen: r.completeWhen,
    npcs: r.npcs || [],
    status: i === 0 ? 'active' : 'locked',
  }));

  return {
    title,
    premise: seed.hook || seed.setting || title,
    seed,
    rooms,
    roomIndex: 0,
    completedCount: 0,
  };
}

function defaultRooms(seed) {
  const layout = normalizeLayout(seed.layoutKey);
  return [
    {
      name: seed.setting || 'Cena inicial',
      layoutKey: layout,
      objective: 'Investigar o gancho da aventura e obter a próxima direção.',
      completeWhen: 'A party descobre para onde ir a seguir.',
      npcs: [],
    },
    {
      name: 'Caminho intermediário',
      layoutKey: layout === 'tavern' ? 'road_camp' : 'ruins',
      objective: 'Superar o obstáculo central da trama.',
      completeWhen: 'O obstáculo é resolvido por combate, diálogo ou engenho.',
      npcs: [],
    },
    {
      name: 'Confronto decisivo',
      layoutKey: layout === 'chapel' ? 'chapel' : 'ruins',
      objective: 'Resolver o conflito principal da aventura.',
      completeWhen: 'O conflito principal está resolvido.',
      npcs: [],
    },
    {
      name: 'Desfecho',
      layoutKey: layout,
      objective: 'Encerrar a história e colher as consequências.',
      completeWhen: 'A party fecha a trama com um desfecho claro.',
      npcs: [],
    },
  ];
}

function normalizeCampaign(raw, seed) {
  if (!raw || !Array.isArray(raw.rooms) || raw.rooms.length < 3) {
    return buildFallbackCampaign(seed || { title: raw?.title, hook: raw?.premise });
  }

  const rooms = raw.rooms.slice(0, 8).map((r, i) => ({
    id: r.id || `room_${i + 1}`,
    index: i,
    name: r.name || `Sala ${i + 1}`,
    layoutKey: normalizeLayout(r.layoutKey || r.setting),
    objective: r.objective || 'Avançar a trama nesta cena.',
    completeWhen: r.completeWhen || r.objective || 'O objetivo da sala é cumprido.',
    npcs: Array.isArray(r.npcs) ? r.npcs : [],
    status: i === 0 ? 'active' : 'locked',
  }));

  return {
    title: raw.title || seed?.title || 'Aventura',
    premise: raw.premise || seed?.hook || '',
    seed: seed || null,
    rooms,
    roomIndex: 0,
    completedCount: 0,
  };
}

function currentRoom(campaign) {
  if (!campaign?.rooms?.length) return null;
  const idx = Math.min(campaign.roomIndex || 0, campaign.rooms.length - 1);
  return campaign.rooms[idx];
}

function questPayload(campaign) {
  const room = currentRoom(campaign);
  if (!room) return null;
  return {
    title: campaign.title,
    premise: campaign.premise,
    roomIndex: campaign.roomIndex + 1,
    roomTotal: campaign.rooms.length,
    roomName: room.name,
    objective: room.objective,
    completedCount: campaign.completedCount || 0,
  };
}

module.exports = {
  LAYOUTS,
  normalizeLayout,
  buildFallbackCampaign,
  normalizeCampaign,
  currentRoom,
  questPayload,
};
