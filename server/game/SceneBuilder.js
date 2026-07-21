const { v4: uuidv4 } = require('uuid');

/**
 * Cenários visuais do tabuleiro OT + NPCs iniciais por aventura.
 */

function layoutKeyForAdventure(adventure) {
  const blob = `${adventure?.title || ''} ${adventure?.setting || ''}`.toLowerCase();
  if (/taverna|cálice|taberneiro|balcão/.test(blob)) return 'tavern';
  if (/estrada|acampamento|mensageiro|fogueira/.test(blob)) return 'road_camp';
  if (/porto|doca|marin|motim/.test(blob)) return 'docks';
  if (/ruína|runas|tormenta|névoa/.test(blob)) return 'ruins';
  if (/capela|funeral|viúva/.test(blob)) return 'chapel';
  if (/mercado|corvo|vilarejo/.test(blob)) return 'market';
  return 'tavern';
}

function seedNpcsForLayout(layoutKey) {
  const presets = {
    tavern: [
      { name: 'Taberneiro', role: 'innkeeper', x: 2, y: 2, color: '#d4a84a', mood: 'alarmed' },
      { name: 'Freguês', role: 'patron', x: 5, y: 4, color: '#8a7a60', mood: 'nervous' },
    ],
    road_camp: [
      { name: 'Mensageiro', role: 'messenger', x: 4, y: 4, color: '#c07050', mood: 'wounded' },
    ],
    docks: [
      { name: 'Capitão', role: 'captain', x: 6, y: 3, color: '#5a7a9a', mood: 'accused' },
      { name: 'Marinheiro', role: 'sailor', x: 3, y: 5, color: '#6a8a7a', mood: 'angry' },
    ],
    ruins: [
      { name: 'Eco Ancestral', role: 'spirit', x: 6, y: 3, color: '#7a90c4', mood: 'awakening' },
    ],
    chapel: [
      { name: 'Viúva', role: 'widow', x: 5, y: 4, color: '#a090a8', mood: 'grief' },
    ],
    market: [
      { name: 'Corvo Mecânico', role: 'construct', x: 6, y: 3, color: '#606870', mood: 'waiting' },
      { name: 'Comerciante', role: 'merchant', x: 3, y: 5, color: '#b09050', mood: 'wary' },
    ],
  };
  return (presets[layoutKey] || presets.tavern).map((n) => makeNpc(n));
}

function makeNpc(partial) {
  return {
    id: partial.id || uuidv4(),
    kind: 'npc',
    name: partial.name || 'NPC',
    role: partial.role || 'npc',
    mood: partial.mood || 'neutral',
    x: Number(partial.x) || 4,
    y: Number(partial.y) || 4,
    color: partial.color || '#c4a060',
    interactable: true,
  };
}

function upsertNpcs(session, list) {
  if (!session.npcs) session.npcs = [];
  if (!Array.isArray(list) || !list.length) return [];
  const added = [];
  for (const raw of list) {
    if (!raw || !raw.name) continue;
    const existing = session.npcs.find(
      (n) => n.name.toLowerCase() === String(raw.name).toLowerCase()
    );
    if (existing) {
      if (raw.mood) existing.mood = raw.mood;
      if (raw.x != null) existing.x = Number(raw.x);
      if (raw.y != null) existing.y = Number(raw.y);
      continue;
    }
    const npc = makeNpc({
      name: raw.name,
      role: raw.role,
      mood: raw.mood,
      x: raw.x != null ? raw.x : 3 + (session.npcs.length % 4),
      y: raw.y != null ? raw.y : 3 + Math.floor(session.npcs.length / 4),
      color: raw.color,
    });
    session.npcs.push(npc);
    added.push(npc);
  }
  return added;
}

function buildSceneTiles(layoutKey, w, h) {
  if (layoutKey === 'road_camp') return buildCampTiles(w, h);
  if (layoutKey === 'docks') return buildDocksTiles(w, h);
  if (layoutKey === 'ruins') return buildRuinsTiles(w, h);
  if (layoutKey === 'chapel') return buildChapelTiles(w, h);
  if (layoutKey === 'market') return buildMarketTiles(w, h);
  return buildTavernTiles(w, h);
}

function emptyFloor(w, h) {
  const tiles = [];
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let type = 'floor';
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) type = 'wall';
      tiles.push({ x, y, type });
    }
  }
  return tiles;
}

function setTile(tiles, w, x, y, type) {
  if (x <= 0 || y <= 0 || x >= w - 1) return;
  const t = tiles.find((cell) => cell.x === x && cell.y === y);
  if (t && t.type === 'floor') t.type = type;
}

function buildTavernTiles(w, h) {
  const tiles = emptyFloor(w, h);
  // Balcão longo
  for (let x = 1; x <= 4; x += 1) setTile(tiles, w, x, 1, 'bar');
  setTile(tiles, w, 1, 2, 'barrel');
  setTile(tiles, w, 4, 2, 'barrel');
  // Mesas + cadeiras
  setTile(tiles, w, 3, 4, 'table');
  setTile(tiles, w, 4, 4, 'table');
  setTile(tiles, w, 3, 5, 'chair');
  setTile(tiles, w, 4, 5, 'chair');
  setTile(tiles, w, 7, 3, 'table');
  setTile(tiles, w, 8, 3, 'table');
  setTile(tiles, w, 7, 4, 'chair');
  setTile(tiles, w, 8, 4, 'chair');
  setTile(tiles, w, 6, 6, 'table');
  setTile(tiles, w, 9, 6, 'barrel');
  // Lareira
  setTile(tiles, w, w - 2, 2, 'hearth');
  setTile(tiles, w, w - 2, 3, 'hearth');
  // Porta frontal
  const door = tiles.find((t) => t.x === Math.floor(w / 2) && t.y === h - 1);
  if (door) door.type = 'door';
  return tiles;
}

function buildCampTiles(w, h) {
  const tiles = emptyFloor(w, h);
  // Abre bordas (acampamento aberto)
  for (const t of tiles) {
    if (t.type === 'wall' && t.y === 0) t.type = 'floor';
    if (t.type === 'wall' && (t.x === 0 || t.x === w - 1) && t.y > 2) t.type = 'floor';
  }
  setTile(tiles, w, 5, 4, 'hearth');
  setTile(tiles, w, 4, 5, 'barrel');
  setTile(tiles, w, 6, 5, 'barrel');
  setTile(tiles, w, 3, 3, 'chair');
  setTile(tiles, w, 7, 3, 'chair');
  return tiles;
}

function buildDocksTiles(w, h) {
  const tiles = emptyFloor(w, h);
  for (let x = 1; x < w - 1; x += 1) setTile(tiles, w, x, h - 2, 'bar');
  setTile(tiles, w, 2, 3, 'barrel');
  setTile(tiles, w, 3, 3, 'barrel');
  setTile(tiles, w, 8, 4, 'crate');
  setTile(tiles, w, 9, 4, 'crate');
  setTile(tiles, w, 5, 5, 'crate');
  const door = tiles.find((t) => t.x === Math.floor(w / 2) && t.y === h - 1);
  if (door) door.type = 'door';
  return tiles;
}

function buildRuinsTiles(w, h) {
  const tiles = emptyFloor(w, h);
  setTile(tiles, w, 3, 3, 'ruin');
  setTile(tiles, w, 4, 3, 'ruin');
  setTile(tiles, w, 7, 5, 'ruin');
  setTile(tiles, w, 5, 6, 'rune');
  setTile(tiles, w, 6, 6, 'rune');
  setTile(tiles, w, 2, 7, 'ruin');
  return tiles;
}

function buildChapelTiles(w, h) {
  const tiles = emptyFloor(w, h);
  setTile(tiles, w, 5, 2, 'altar');
  setTile(tiles, w, 6, 2, 'altar');
  setTile(tiles, w, 4, 5, 'chair');
  setTile(tiles, w, 5, 5, 'chair');
  setTile(tiles, w, 6, 5, 'chair');
  setTile(tiles, w, 7, 5, 'chair');
  const door = tiles.find((t) => t.x === Math.floor(w / 2) && t.y === h - 1);
  if (door) door.type = 'door';
  return tiles;
}

function buildMarketTiles(w, h) {
  const tiles = emptyFloor(w, h);
  setTile(tiles, w, 2, 3, 'crate');
  setTile(tiles, w, 3, 3, 'table');
  setTile(tiles, w, 7, 3, 'table');
  setTile(tiles, w, 8, 3, 'crate');
  setTile(tiles, w, 5, 5, 'barrel');
  setTile(tiles, w, 4, 6, 'crate');
  return tiles;
}

module.exports = {
  layoutKeyForAdventure,
  seedNpcsForLayout,
  makeNpc,
  upsertNpcs,
  buildSceneTiles,
  buildTavernTiles,
};
