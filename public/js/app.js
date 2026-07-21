(() => {
  const $ = (s) => document.querySelector(s);

  const screens = {
    landing: $('#screen-landing'),
    party: $('#screen-party'),
    games: $('#screen-games'),
    hall: $('#screen-hall'),
    game: $('#screen-game'),
  };

  let socket = null;
  let me = null;
  let catalog = null;
  let party = null;
  let renderer = null;
  let readySent = false;
  let currentTurn = null;
  let attrState = null;
  let skillRanks = {};

  const AUTH_MESSAGES = {
    denied: 'Você precisa estar no servidor Discord para jogar.',
    disabled: 'Login Discord não configurado no servidor (faltam secrets).',
    state: 'Sessão OAuth inválida. Tente novamente.',
    token: 'Falha ao obter token do Discord.',
    error: 'Erro no login Discord. Tente novamente.',
    ratelimited: 'Muitas tentativas. Aguarde um momento.',
  };

  const CLASS_LABELS = {
    guerreiro: 'Guerreiro',
    ladino: 'Ladino',
    clerigo: 'Clérigo',
    arcanista: 'Arcanista',
  };

  function show(name) {
    Object.entries(screens).forEach(([key, el]) => {
      if (!el) return;
      const on = key === name;
      el.classList.toggle('hidden', !on);
      el.setAttribute('aria-hidden', on ? 'false' : 'true');
    });
  }

  function authErrorFromQuery() {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('auth');
    if (!code) return;
    const el = $('#auth-error');
    if (el) el.textContent = AUTH_MESSAGES[code] || `Falha no login (${code}).`;
    window.history.replaceState({}, '', '/');
  }

  function setUserChip(player) {
    me = player;
    const label = $('#you-label');
    if (label) label.textContent = player.nickname || '—';
    const av = $('#you-avatar');
    if (av) {
      if (player.avatar) {
        av.src = player.avatar;
        av.classList.remove('hidden');
      } else {
        av.classList.add('hidden');
      }
    }
    const nameInput = $('#char-name');
    if (nameInput && !nameInput.value) nameInput.value = player.nickname || '';
  }

  function requireSocket() {
    if (socket) return socket;
    return connect();
  }

  function connect() {
    if (socket) return socket;
    socket = io({ transports: ['websocket', 'polling'], reconnection: true });

    socket.on('connect_error', (err) => {
      const msg = String(err && err.message ? err.message : err);
      if (msg.indexOf('unauthorized') >= 0 || msg.indexOf('auth_unavailable') >= 0) {
        show('landing');
        const el = $('#auth-error');
        if (el) {
          el.textContent = msg.indexOf('auth_unavailable') >= 0
            ? AUTH_MESSAGES.disabled
            : 'Sessão expirada. Entre com Discord novamente.';
        }
      }
    });

    socket.on('auth:ok', (payload) => {
      if (payload && payload.player) setUserChip(payload.player);
      show('party');
    });

    socket.on('meta', (meta) => {
      const online = $('#online-count');
      const gm = $('#gm-status');
      if (online) online.textContent = String(meta.online || 0);
      if (gm) {
        gm.textContent = meta.gemini ? 'Gemini ATIVO' : 'OFFLINE (fallback)';
        gm.style.color = meta.gemini ? '#5dca7a' : '#e07070';
      }
      if (meta.catalog) {
        catalog = meta.catalog;
        fillCatalog();
        initAttrEditor();
      }
    });

    socket.on('party:update', (snap) => {
      party = snap;
      renderParty();
      renderHallMembers();
      if (snap && snap.status === 'hall') show('hall');
    });

    socket.on('party:hall', (snap) => {
      party = snap;
      show('hall');
      renderHallMembers();
      initAttrEditor();
    });

    socket.on('session:start', (payload) => {
      enterGame(payload);
      if (payload.quest) renderQuest(payload.quest);
    });

    socket.on('session:state', (payload) => {
      ensureRenderer();
      if (payload.world) renderer.setWorld(payload.world);
      if (payload.party) renderPartyHud(payload.party);
      if (payload.hud) renderHud(payload.hud);
      if (payload.turn) applyTurn(payload.turn);
      if (payload.quest) renderQuest(payload.quest);
      highlightTurnActor(payload.turn);
    });

    socket.on('quest:update', (quest) => {
      renderQuest(quest);
    });

    socket.on('turn:update', (turn) => {
      applyTurn(turn);
      highlightTurnActor(turn);
    });

    socket.on('narrative:push', (payload) => {
      const kind = payload.kind || (payload.by === 'player' ? 'intent' : 'result');
      const who = kind === 'intent'
        ? (payload.character || payload.from || 'Jogador')
        : 'Mestre';
      const text = payload.text || '';
      if (text) pushNarrative(who, text, kind === 'intent' ? 'player' : 'gm');
      (payload.combat || []).forEach((c) => {
        if (c.summary && !text.includes(c.summary)) pushNarrative('Combate', c.summary, 'combat');
      });
      if (payload.effects && renderer) renderer.playEffects(payload.effects);
    });

    socket.on('game:over', (payload) => {
      const msg = payload.outcome === 'victory'
        ? 'Vitória! A aventura chegou ao desfecho — a party venceu a narrativa.'
        : 'Derrota. A party caiu antes de concluir a aventura.';
      pushNarrative('Mestre', msg);
      setActionEnabled(false, 'Partida encerrada');
      if (payload.turn) applyTurn(payload.turn);
    });

    socket.on('game:deleted', (payload) => {
      const deletedId = payload && payload.partyId;
      if (party && deletedId && party.id === deletedId) {
        party = null;
        show('party');
        renderParty();
      }
      if (screens.games && !screens.games.classList.contains('hidden')) {
        loadGames();
      }
    });

    return socket;
  }

  function enterGame(payload) {
    show('game');
    ensureRenderer();
    const log = $('#narrative-log');
    if (log) log.replaceChildren();
    if (payload.world) renderer.setWorld(payload.world);
    renderPartyHud(payload.partyHud || payload.party || []);
    if (payload.hud) renderHud(payload.hud);
    if (payload.turn) applyTurn(payload.turn);
    if (payload.quest) renderQuest(payload.quest);
    highlightTurnActor(payload.turn);
    (payload.log || []).forEach((l) => pushNarrative(l.who || 'Log', l.text));
  }

  function highlightTurnActor(turn) {
    if (!renderer || !turn) return;
    let actorId = null;
    if (turn.current !== 'gm' && renderer.world && renderer.world.entities) {
      const ent = renderer.world.entities.find((e) => e.playerId === turn.current);
      actorId = ent ? ent.id : null;
    }
    renderer.setFocus(actorId);
  }

  function ensureRenderer() {
    if (!renderer) {
      const canvas = $('#game-canvas');
      if (canvas && window.OtRenderer) {
        renderer = new window.OtRenderer(canvas);
        renderer.onSelect = (ent) => {
          const hint = $('#scene-hint');
          const input = $('#input-action');
          if (!ent) return;
          if (ent.kind === 'npc') {
            if (hint) hint.textContent = 'Selecionado: ' + ent.name + ' (NPC) — falar / perguntar / ajudar';
            if (input && !input.disabled) {
              input.value = 'Falo com ' + ent.name + ': ';
              input.focus();
            }
          } else if (ent.kind === 'enemy') {
            if (hint) hint.textContent = 'Selecionado: ' + ent.name + ' — aproxime-se (melee) ou ataque à distância';
            if (input && !input.disabled) {
              input.value = 'Ataco ' + ent.name;
              input.focus();
            }
          } else if (ent.kind === 'player') {
            if (hint) hint.textContent = 'Aliado: ' + ent.name;
          }
        };
      }
    }
  }

  function endMyTurn() {
    const input = $('#input-action');
    if (input) input.value = 'Encerrar turno';
    const form = $('#form-action');
    if (form) form.requestSubmit();
  }

  function fillCatalog() {
    if (!catalog) return;
    const raceSel = $('#char-race');
    const classSel = $('#char-class');
    if (!raceSel || !classSel) return;
    raceSel.replaceChildren();
    classSel.replaceChildren();
    (catalog.races || []).forEach((r) => {
      const o = document.createElement('option');
      o.value = r.key;
      o.textContent = r.label;
      raceSel.appendChild(o);
    });
    (catalog.classes || []).forEach((c) => {
      const o = document.createElement('option');
      o.value = c.key;
      o.textContent = c.label + (c.weapon ? ' (' + c.weapon + ')' : '');
      classSel.appendChild(o);
    });
  }

  function initAttrEditor() {
    const wrap = $('#attr-editor');
    if (!wrap || !catalog || !catalog.pointBuy) return;
    const pb = catalog.pointBuy;
    const classKey = ($('#char-class') && $('#char-class').value) || 'guerreiro';
    if (!attrState) attrState = Object.assign({}, pb.presets[classKey] || pb.presets.guerreiro);
    if (wrap.childElementCount) {
      renderAttrEditor();
      return;
    }
    wrap.replaceChildren();
    (catalog.attrs || []).forEach((key) => {
      const row = document.createElement('div');
      row.className = 'attr-row';
      row.dataset.attr = key;
      const label = (catalog.attrLabels && catalog.attrLabels[key]) || key;
      row.innerHTML =
        '<span class="attr-label">' + label + '</span>' +
        '<button type="button" class="attr-btn" data-dir="-1">−</button>' +
        '<span class="attr-val">' + attrState[key] + '</span>' +
        '<button type="button" class="attr-btn" data-dir="1">+</button>' +
        '<span class="attr-mod"></span>';
      wrap.appendChild(row);
    });
    wrap.addEventListener('click', (e) => {
      const btn = e.target.closest('.attr-btn');
      if (!btn) return;
      const row = btn.closest('.attr-row');
      const key = row.dataset.attr;
      const dir = Number(btn.dataset.dir);
      const next = attrState[key] + dir;
      if (next < pb.min || next > pb.max) return;
      const trial = Object.assign({}, attrState);
      trial[key] = next;
      if (spentPoints(trial) > pb.pool) return;
      attrState[key] = next;
      renderAttrEditor();
      requestPreview();
    });
    renderAttrEditor();
    syncPowerLabel();
  }

  function spentPoints(attrs) {
    const cost = (catalog && catalog.pointBuy && catalog.pointBuy.cost) || {};
    return (catalog.attrs || []).reduce((sum, k) => sum + (cost[attrs[k]] || 0), 0);
  }

  function renderAttrEditor() {
    if (!attrState || !catalog || !catalog.pointBuy) return;
    const pb = catalog.pointBuy;
    const spent = spentPoints(attrState);
    const remEl = $('#attr-remaining');
    if (remEl) remEl.textContent = (pb.pool - spent) + ' pontos restantes (' + spent + '/' + pb.pool + ')';
    const wrap = $('#attr-editor');
    if (!wrap) return;
    wrap.querySelectorAll('.attr-row').forEach((row) => {
      const key = row.dataset.attr;
      const v = attrState[key];
      row.querySelector('.attr-val').textContent = String(v);
      const mod = Math.floor((v - 10) / 2);
      row.querySelector('.attr-mod').textContent = mod >= 0 ? '+' + mod : String(mod);
    });
  }

  function powerBudget() {
    if (!catalog || !catalog.skills) return 1;
    const raceKey = ($('#char-race') && $('#char-race').value) || 'humano';
    let pts = catalog.skills.startingPowerPoints || 1;
    const race = (catalog.races || []).find((r) => r.key === raceKey);
    if (race && race.traits) {
      // Humano Versátil: +1 — espelha o servidor
      if (raceKey === 'humano') pts += 1;
    }
    return pts;
  }

  function skillSpendCost(key, toRank) {
    const def = catalog.skills.skills[key];
    if (!def || toRank <= 0) return 0;
    return def.unlockCost + Math.max(0, toRank - 1) * def.rankCost;
  }

  function totalSkillSpent() {
    let spent = 0;
    Object.keys(skillRanks).forEach((k) => {
      spent += skillSpendCost(k, skillRanks[k] || 0);
    });
    return spent;
  }

  function syncPowerLabel() {
    const rem = powerBudget() - totalSkillSpent();
    const el = $('#power-remaining');
    if (el) el.textContent = rem + ' ponto' + (rem === 1 ? '' : 's') + ' de poder';
    const summary = $('#skills-summary');
    if (summary) {
      const unlocked = Object.entries(skillRanks).filter(([, r]) => r > 0);
      if (!unlocked.length) {
        summary.textContent = 'Nenhuma habilidade desbloqueada ainda.';
      } else {
        summary.textContent = unlocked.map(([k, r]) => {
          const def = catalog.skills.skills[k];
          return (def ? def.label : k) + ' r' + r;
        }).join(' · ');
      }
    }
  }

  function resetSkillRanksForClass() {
    skillRanks = {};
    syncPowerLabel();
  }

  function openSkillsModal() {
    if (!catalog || !catalog.skills) return;
    const modal = $('#skills-modal');
    if (!modal) return;
    const classKey = ($('#char-class') && $('#char-class').value) || 'guerreiro';
    const raceKey = ($('#char-race') && $('#char-race').value) || 'humano';
    const title = $('#skills-modal-title');
    if (title) title.textContent = 'Habilidades · ' + classKey;
    const pts = $('#skills-modal-points');
    if (pts) {
      pts.textContent = 'Pontos de poder: ' + totalSkillSpent() + ' / ' + powerBudget() +
        ' (restam ' + (powerBudget() - totalSkillSpent()) + ')';
    }

    const traitsBox = $('#race-traits-box');
    if (traitsBox) {
      const race = (catalog.races || []).find((r) => r.key === raceKey);
      traitsBox.replaceChildren();
      const h = document.createElement('h4');
      h.textContent = 'Buffs de raça — ' + ((race && race.label) || raceKey);
      traitsBox.appendChild(h);
      const ul = document.createElement('ul');
      ((race && race.traits) || []).forEach((t) => {
        const li = document.createElement('li');
        li.innerHTML = '<strong></strong> — <span></span>';
        li.querySelector('strong').textContent = t.label;
        li.querySelector('span').textContent = t.description;
        ul.appendChild(li);
      });
      traitsBox.appendChild(ul);
    }

    const list = $('#skills-modal-list');
    if (!list) return;
    list.replaceChildren();
    const kitKeys = (catalog.skills.kits && catalog.skills.kits[classKey]) || [];
    kitKeys.forEach((key) => {
      const def = catalog.skills.skills[key];
      if (!def) return;
      const rank = skillRanks[key] || 0;
      const card = document.createElement('div');
      card.className = 'skill-card';
      card.dataset.skill = key;
      const scaleLabel = (catalog.attrLabels && catalog.attrLabels[def.scaleAttr]) || def.scaleAttr;
      card.innerHTML =
        '<h4></h4><div class="meta"></div><p class="muted"></p>' +
        '<div class="skill-rank-row">' +
        '<button type="button" class="attr-btn" data-skill-dir="-1">−</button>' +
        '<span class="attr-val skill-rank-val"></span>' +
        '<button type="button" class="attr-btn" data-skill-dir="1">+</button>' +
        '<span class="muted tiny">rank</span></div>';
      card.querySelector('h4').textContent = def.label;
      card.querySelector('.meta').textContent =
        'Escala com ' + scaleLabel + ' · CD ' + def.cooldown + ' turno(s)' +
        (def.mpCost ? ' · ' + def.mpCost + ' PM' : '');
      card.querySelector('p').textContent = def.description;
      card.querySelector('.skill-rank-val').textContent = String(rank);
      list.appendChild(card);
    });
    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
  }

  function closeSkillsModal() {
    const modal = $('#skills-modal');
    if (!modal) return;
    modal.classList.add('hidden');
    modal.setAttribute('aria-hidden', 'true');
    syncPowerLabel();
    requestPreview();
  }

  function adjustSkillRank(key, dir) {
    const def = catalog.skills.skills[key];
    if (!def) return;
    const cur = skillRanks[key] || 0;
    const next = cur + dir;
    if (next < 0 || next > def.maxRank) return;
    const trial = Object.assign({}, skillRanks);
    if (next === 0) delete trial[key];
    else trial[key] = next;
    let spent = 0;
    Object.keys(trial).forEach((k) => { spent += skillSpendCost(k, trial[k]); });
    if (spent > powerBudget()) return;
    skillRanks = trial;
    const card = document.querySelector('.skill-card[data-skill="' + key + '"] .skill-rank-val');
    if (card) card.textContent = String(next);
    const pts = $('#skills-modal-points');
    if (pts) {
      pts.textContent = 'Pontos de poder: ' + spent + ' / ' + powerBudget() +
        ' (restam ' + (powerBudget() - spent) + ')';
    }
    syncPowerLabel();
  }

  function renderHudSkills(skillsList) {
    const box = $('#hud-skills');
    if (!box) return;
    box.replaceChildren();
    if (!skillsList || !skillsList.length) {
      const p = document.createElement('p');
      p.className = 'muted tiny';
      p.textContent = 'Nenhuma habilidade.';
      box.appendChild(p);
      return;
    }
    skillsList.forEach((s) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'skill-chip';
      btn.setAttribute('data-nav', 'use-skill');
      btn.setAttribute('data-skill-key', s.key);
      btn.disabled = !s.ready || (currentTurn && me && currentTurn.current !== me.id);
      btn.innerHTML = '<strong></strong><div class="cd"></div>';
      btn.querySelector('strong').textContent = s.label + ' r' + s.rank;
      btn.querySelector('.cd').textContent = s.ready
        ? (s.scaleAttrLabel + (s.mpCost ? ' · ' + s.mpCost + ' PM' : ''))
        : ('Recarga: ' + s.cooldownLeft + ' turno(s)');
      box.appendChild(btn);
    });
  }

  function useSkill(skillKey) {
    if (!currentTurn || !me || currentTurn.current !== me.id) {
      const err = $('#action-error');
      if (err) err.textContent = 'Não é o seu turno.';
      return;
    }
    setActionEnabled(false, 'Usando habilidade...');
    requireSocket().emit('action:skill', { skillKey: skillKey }, (res) => {
      if (!res || !res.ok) {
        const err = $('#action-error');
        if (err) err.textContent = (res && res.error) || 'Falha';
        if (currentTurn) applyTurn(currentTurn);
        return;
      }
      if (res.result && res.result.hud) renderHud(res.result.hud);
      if (res.result && res.result.turn) applyTurn(res.result.turn);
    });
  }

  function applyClassPreset() {
    if (!catalog || !catalog.pointBuy) return;
    const classKey = ($('#char-class') && $('#char-class').value) || 'guerreiro';
    attrState = Object.assign({}, catalog.pointBuy.presets[classKey] || catalog.pointBuy.presets.guerreiro);
    resetSkillRanksForClass();
    renderAttrEditor();
    requestPreview();
  }

  let previewTimer = null;
  function requestPreview() {
    if (!socket || !attrState) return;
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => {
      socket.emit('character:preview', {
        name: $('#char-name') && $('#char-name').value,
        race: $('#char-race') && $('#char-race').value,
        classKey: $('#char-class') && $('#char-class').value,
        attrs: attrState,
        skillRanks: skillRanks,
      }, (res) => {
        if (!res || !res.ok || !res.hud) return;
        const c = res.hud;
        const preview = $('#char-preview');
        if (preview) {
          preview.textContent =
            c.name + ' — ' + c.race + ' ' + c.class +
            ' | HP ' + c.hp + '/' + c.hpMax +
            ' | Mana ' + c.mp + '/' + c.mpMax +
            ' | Def ' + c.defense + ' | ' + c.weapon;
        }
        if (res.power) {
          const el = $('#power-remaining');
          if (el) el.textContent = res.power.remaining + ' ponto(s) de poder';
        }
      });
    }, 200);
  }

  function renderParty() {
    const box = $('#party-box');
    if (!box) return;
    if (!party) {
      box.classList.add('hidden');
      return;
    }
    box.classList.remove('hidden');
    const code = $('#party-code');
    const size = $('#party-size');
    if (code) code.textContent = party.code;
    if (size) size.textContent = String(party.size);
    const ul = $('#party-members');
    if (!ul) return;
    ul.replaceChildren();
    (party.members || []).forEach((m) => {
      const li = document.createElement('li');
      const host = m.playerId === party.hostId ? ' (host)' : '';
      const ready = m.ready ? ' ✓' : '';
      const char = m.character ? ' — ' + m.character.name + ' (' + m.character.class + ')' : '';
      li.textContent = m.nickname + host + ready + char;
      ul.appendChild(li);
    });
    const hallBtn = $('#btn-hall');
    if (hallBtn) {
      const isHost = me && party.hostId === me.id;
      hallBtn.style.display = isHost && party.status === 'lobby' ? '' : 'none';
    }
  }

  function renderHallMembers() {
    const ul = $('#hall-members');
    if (!ul || !party) return;
    ul.replaceChildren();
    (party.members || []).forEach((m) => {
      const li = document.createElement('li');
      li.textContent =
        m.nickname + ': ' +
        (m.character ? m.character.name + ' / ' + m.character.class : 'montando...') +
        (m.ready ? ' [PRONTO]' : '');
      ul.appendChild(li);
    });
  }

  function renderHud(hud) {
    if (!hud) return;
    const set = (id, val) => { const el = $(id); if (el) el.textContent = val; };
    set('#hud-name', hud.name);
    set('#hud-class', hud.race + ' · ' + hud.class + ' Nv.' + hud.level);
    set('#hud-hp', hud.hp + '/' + hud.hpMax);
    set('#hud-mp', hud.mp + '/' + hud.mpMax);
    set('#hud-def', String(hud.defense));
    set('#hud-weapon', hud.weapon || '—');
    set('#hud-status', (hud.status && hud.status.length) ? hud.status.join(', ') : 'nenhum');
    renderHudSkills(hud.skills || []);
    const barHp = $('#bar-hp');
    const barMp = $('#bar-mp');
    if (barHp) barHp.style.width = (hud.hpMax ? (hud.hp / hud.hpMax) * 100 : 0) + '%';
    if (barMp) barMp.style.width = (hud.mpMax ? (hud.mp / hud.mpMax) * 100 : 0) + '%';
  }

  function renderPartyHud(list) {
    if (!list) return;
    const ul = $('#party-hud');
    if (!ul) return;
    ul.replaceChildren();
    list.forEach((p) => {
      const li = document.createElement('li');
      li.dataset.playerId = p.playerId || '';
      const mine = p.playerId === (me && me.id) ? ' ★' : '';
      li.textContent = p.name + ' ' + p.hpPct + '%' + mine;
      if (currentTurn && currentTurn.current === p.playerId) li.classList.add('turn-active');
      ul.appendChild(li);
    });
  }

  function renderQuest(quest) {
    if (!quest) return;
    const title = $('#quest-title');
    const room = $('#quest-room');
    const obj = $('#quest-objective');
    if (title) title.textContent = quest.title || 'Aventura';
    if (room) room.textContent = `Sala ${quest.roomIndex || '?'}/${quest.roomTotal || '?'} · ${quest.roomName || '—'}`;
    if (obj) obj.textContent = 'Objetivo: ' + (quest.objective || '—');
  }

  function applyTurn(turn) {
    currentTurn = turn;
    const banner = $('#turn-banner');
    if (banner && turn) {
      banner.textContent = turn.outcome
        ? (turn.outcome === 'victory' ? 'Vitória!' : 'Derrota')
        : 'Rodada ' + turn.round + ' · Turno: ' + turn.currentName;
      banner.classList.toggle('my-turn', !!(me && turn.current === me.id));
    }
    const budgetEl = $('#turn-budget');
    if (budgetEl) {
      if (turn && me && turn.current === me.id && turn.budget && !turn.outcome) {
        const parts = [];
        parts.push(turn.budget.canMove ? 'Movimento disponível' : 'Movimento usado');
        parts.push(turn.budget.canAct ? 'Ação disponível' : 'Ação usada');
        budgetEl.textContent = parts.join(' · ') + ' · diga “encerrar turno” se quiser passar';
      } else {
        budgetEl.textContent = '';
      }
    }
    const myTurn = !!(turn && me && turn.current === me.id && !turn.outcome);
    let placeholder = 'Aguarde o turno';
    if (myTurn && turn.budget) {
      if (turn.budget.canMove && turn.budget.canAct) placeholder = 'Mova-se e/ou aja (ataque, falar, habilidade…)';
      else if (turn.budget.canMove) placeholder = 'Ainda pode se mover — ou encerre o turno';
      else if (turn.budget.canAct) placeholder = 'Ainda pode agir — ou encerre o turno';
      else placeholder = 'Encerrar turno';
    } else if (turn && turn.currentName) {
      placeholder = 'Aguardando ' + turn.currentName + '...';
    }
    setActionEnabled(myTurn, placeholder);
    const endBtn = $('#btn-end-turn');
    if (endBtn) endBtn.disabled = !myTurn;

    const ul = $('#party-hud');
    if (ul) {
      ul.querySelectorAll('li').forEach((li) => {
        li.classList.toggle('turn-active', li.dataset.playerId === (turn && turn.current));
      });
    }
    const skillsBox = $('#hud-skills');
    if (skillsBox && skillsBox.querySelectorAll('.skill-chip').length) {
      skillsBox.querySelectorAll('.skill-chip').forEach((btn) => {
        const cdText = btn.querySelector('.cd');
        const onCd = cdText && /Recarga/.test(cdText.textContent || '');
        const canAct = !turn || !turn.budget || turn.budget.canAct !== false;
        btn.disabled = !myTurn || onCd || !canAct;
      });
    }
  }

  function setActionEnabled(enabled, placeholder) {
    const input = $('#input-action');
    const btn = $('#form-action button[type="submit"]');
    if (input) {
      input.disabled = !enabled;
      if (placeholder) input.placeholder = placeholder;
    }
    if (btn) btn.disabled = !enabled;
  }

  function pushNarrative(who, text, roleHint) {
    const log = $('#narrative-log');
    if (!log) return;
    const div = document.createElement('div');
    const role = roleHint || narrativeRole(who);
    div.className = 'entry from-' + role;
    const whoEl = document.createElement('span');
    whoEl.className = 'who';
    whoEl.textContent = who;
    const msgEl = document.createElement('span');
    msgEl.className = 'msg';
    msgEl.textContent = text;
    div.appendChild(whoEl);
    div.appendChild(msgEl);
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  }

  function narrativeRole(who) {
    const w = String(who || '').toLowerCase();
    if (w === 'mestre' || w === 'gm') return 'gm';
    if (w === 'combate') return 'combat';
    if (w === 'sistema' || w === 'log') return 'system';
    return 'player';
  }

  function statusLabel(status) {
    return ({ lobby: 'Lobby', hall: 'Hall', active: 'Em andamento', ended: 'Finalizado' })[status] || status;
  }

  function openMyGames() {
    show('games');
    const recap = $('#recap-box');
    if (recap) recap.classList.add('hidden');
    loadGames();
  }

  function goLobbyFromGame() {
    party = null;
    currentTurn = null;
    show('party');
    renderParty();
    try {
      requireSocket().emit('party:leave', {}, function () {});
    } catch (e) { /* ignore */ }
  }

  function loadGames() {
    const errEl = $('#games-error');
    if (errEl) errEl.textContent = '';
    let s;
    try {
      s = requireSocket();
    } catch (e) {
      if (errEl) errEl.textContent = 'Sem conexão.';
      return;
    }
    if (!s) {
      if (errEl) errEl.textContent = 'Sem conexão. Recarregue a página.';
      return;
    }
    s.emit('games:list', {}, (res) => {
      if (!res || !res.ok) {
        if (errEl) errEl.textContent = (res && res.error) || 'Falha ao listar.';
        return;
      }
      const list = $('#games-list');
      if (!list) return;
      list.replaceChildren();
      const empty = $('#games-empty');
      if (!res.games || !res.games.length) {
        if (empty) empty.classList.remove('hidden');
        return;
      }
      if (empty) empty.classList.add('hidden');
      res.games.forEach((g) => {
        const li = document.createElement('li');
        li.className = 'game-item';
        const cls = CLASS_LABELS[g.charClass] || g.charClass || '—';
        const when = g.updatedAt ? new Date(g.updatedAt).toLocaleString('pt-BR') : '';
        const main = document.createElement('div');
        main.className = 'game-main';
        main.innerHTML =
          '<strong></strong> <span class="pill"></span>' +
          '<span class="muted"></span><span class="muted tiny"></span>';
        main.querySelector('strong').textContent = g.code;
        const pill = main.querySelector('.pill');
        pill.classList.add('status-' + g.status);
        pill.textContent = statusLabel(g.status);
        main.querySelectorAll('.muted')[0].textContent =
          (g.charName || 'sem ficha') + ' · ' + cls + ' · ' + g.memberCount + ' jogadores';
        main.querySelectorAll('.muted')[1].textContent = when;
        const actions = document.createElement('div');
        actions.className = 'game-actions';
        if (g.canRejoin || g.canResumeLobby) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'btn tiny';
          btn.textContent = g.canRejoin ? 'Reentrar' : 'Retomar';
          btn.setAttribute('data-nav', 'rejoin');
          btn.setAttribute('data-party-id', g.partyId);
          actions.appendChild(btn);
        }
        if (g.status === 'ended' || g.sessionId) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'btn ghost tiny';
          btn.textContent = 'Ver recap';
          btn.setAttribute('data-nav', 'recap');
          btn.setAttribute('data-party-id', g.partyId);
          actions.appendChild(btn);
        }
        if (g.canDelete) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'btn danger tiny';
          btn.textContent = 'Excluir';
          btn.setAttribute('data-nav', 'delete-game');
          btn.setAttribute('data-party-id', g.partyId);
          btn.setAttribute('data-party-code', g.code || '');
          actions.appendChild(btn);
        }
        li.appendChild(main);
        li.appendChild(actions);
        list.appendChild(li);
      });
    });
  }

  function deleteGame(partyId, code) {
    const errEl = $('#games-error');
    if (errEl) errEl.textContent = '';
    const label = code || partyId;
    if (!window.confirm('Excluir a sala "' + label + '" permanentemente?\nTodos os dados (ficha, sessão e histórico) serão removidos.')) {
      return;
    }
    let s;
    try {
      s = requireSocket();
    } catch (e) {
      if (errEl) errEl.textContent = 'Sem conexão.';
      return;
    }
    s.emit('games:delete', { partyId: partyId }, (res) => {
      if (!res || !res.ok) {
        if (errEl) errEl.textContent = (res && res.error) || 'Falha ao excluir.';
        return;
      }
      if (party && party.id === partyId) {
        party = res.party || null;
        show('party');
        renderParty();
      }
      loadGames();
    });
  }

  function rejoinGame(partyId) {
    const errEl = $('#games-error');
    if (errEl) errEl.textContent = '';
    requireSocket().emit('games:rejoin', { partyId: partyId }, (res) => {
      if (!res || !res.ok) {
        if (errEl) errEl.textContent = (res && res.error) || 'Falha ao reentrar.';
        return;
      }
      party = res.party;
      if (res.mode === 'active') {
        enterGame(res);
        pushNarrative('Sistema', 'Você reentrou na partida em andamento.');
      } else if (res.mode === 'hall') {
        show('hall');
        renderHallMembers();
        initAttrEditor();
      } else {
        show('party');
        renderParty();
      }
    });
  }

  function loadRecap(partyId) {
    const errEl = $('#games-error');
    if (errEl) errEl.textContent = '';
    requireSocket().emit('games:recap', { partyId: partyId }, (res) => {
      if (!res || !res.ok) {
        if (errEl) errEl.textContent = (res && res.error) || 'Falha no recap.';
        return;
      }
      const r = res.recap;
      const box = $('#recap-box');
      if (!box) return;
      box.classList.remove('hidden');
      const title = $('#recap-title');
      if (title) title.textContent = 'Recap · ' + (r.code || String(partyId).slice(0, 8));
      const outcome = r.outcome === 'victory' ? 'Vitória' : r.outcome === 'defeat' ? 'Derrota' : statusLabel(r.status);
      const meta = $('#recap-meta');
      if (meta) meta.textContent = outcome + (r.endedAt ? ' · ' + new Date(r.endedAt).toLocaleString('pt-BR') : '');
      const chars = $('#recap-chars');
      if (chars) {
        chars.replaceChildren();
        (r.characters || []).forEach((c) => {
          const li = document.createElement('li');
          li.textContent = c.name + ' (' + c.class + ') — HP ' + c.hp + '/' + c.hpMax;
          chars.appendChild(li);
        });
      }
      const log = $('#recap-log');
      if (log) {
        log.replaceChildren();
        const lines = (r.log && r.log.length ? r.log : r.actions) || [];
        lines.forEach((l) => {
          const div = document.createElement('div');
          div.className = 'entry';
          div.textContent = l.text;
          log.appendChild(div);
        });
      }
    });
  }

  async function boot() {
    authErrorFromQuery();
    try {
      const statusRes = await fetch('/auth/status', { credentials: 'same-origin' });
      const status = await statusRes.json();
      const btn = $('#btn-discord');
      if (!status.configured) {
        if (btn) {
          btn.classList.add('disabled');
          btn.setAttribute('aria-disabled', 'true');
        }
        const err = $('#auth-error');
        if (err) err.textContent = AUTH_MESSAGES.disabled;
        show('landing');
        return;
      }
      if (!status.authenticated) {
        show('landing');
        return;
      }
      const meRes = await fetch('/api/me', { credentials: 'same-origin' });
      if (!meRes.ok) {
        show('landing');
        return;
      }
      const meData = await meRes.json();
      if (meData && meData.player) setUserChip(meData.player);
      connect();
      show('party');
    } catch (e) {
      show('landing');
      const err = $('#auth-error');
      if (err) err.textContent = 'Não foi possível verificar a sessão.';
    }
  }

  // Delegação única — garante que os botões funcionem
  const appRoot = document.getElementById('app');
  if (appRoot) {
    appRoot.addEventListener('click', (e) => {
      const t = e.target.closest(
        '#btn-goto-games, #btn-games-back, #btn-recap-close, #btn-hall-back, #btn-game-lobby, ' +
        '#btn-create-party, #btn-leave-party, #btn-hall, #btn-ready, #btn-attr-reset, ' +
        '#btn-skills, #btn-skills-close, #btn-end-turn, #btn-zoom-in, #btn-zoom-out, #btn-zoom-reset, ' +
        '[data-nav], [data-skill-dir]'
      );
      if (!t) return;

      const skillDir = t.getAttribute('data-skill-dir');
      if (skillDir) {
        e.preventDefault();
        const card = t.closest('.skill-card');
        if (card) adjustSkillRank(card.dataset.skill, Number(skillDir));
        return;
      }

      const nav = t.getAttribute('data-nav');
      if (nav === 'rejoin') {
        e.preventDefault();
        rejoinGame(t.getAttribute('data-party-id'));
        return;
      }
      if (nav === 'recap') {
        e.preventDefault();
        loadRecap(t.getAttribute('data-party-id'));
        return;
      }
      if (nav === 'delete-game') {
        e.preventDefault();
        deleteGame(t.getAttribute('data-party-id'), t.getAttribute('data-party-code'));
        return;
      }
      if (nav === 'use-skill') {
        e.preventDefault();
        useSkill(t.getAttribute('data-skill-key'));
        return;
      }

      if (t.id === 'btn-end-turn') {
        e.preventDefault();
        endMyTurn();
        return;
      }
      if (t.id === 'btn-zoom-in') {
        e.preventDefault();
        ensureRenderer();
        if (renderer) {
          const z = renderer.zoomBy(0.15);
          t.blur();
          const reset = $('#btn-zoom-reset');
          if (reset) reset.textContent = Math.round(z * 100) + '%';
        }
        return;
      }
      if (t.id === 'btn-zoom-out') {
        e.preventDefault();
        ensureRenderer();
        if (renderer) {
          const z = renderer.zoomBy(-0.15);
          const reset = $('#btn-zoom-reset');
          if (reset) reset.textContent = Math.round(z * 100) + '%';
        }
        return;
      }
      if (t.id === 'btn-zoom-reset') {
        e.preventDefault();
        ensureRenderer();
        if (renderer) {
          renderer.setZoom(1);
          t.textContent = '100%';
        }
        return;
      }

      if (t.id === 'btn-skills') {
        e.preventDefault();
        openSkillsModal();
        return;
      }
      if (t.id === 'btn-skills-close') {
        e.preventDefault();
        closeSkillsModal();
        return;
      }

      if (t.id === 'btn-goto-games') {
        e.preventDefault();
        openMyGames();
        return;
      }
      if (t.id === 'btn-games-back') {
        e.preventDefault();
        show('party');
        return;
      }
      if (t.id === 'btn-recap-close') {
        e.preventDefault();
        const box = $('#recap-box');
        if (box) box.classList.add('hidden');
        return;
      }
      if (t.id === 'btn-hall-back') {
        e.preventDefault();
        show('party');
        renderParty();
        return;
      }
      if (t.id === 'btn-game-lobby') {
        e.preventDefault();
        goLobbyFromGame();
        return;
      }
      if (t.id === 'btn-create-party') {
        e.preventDefault();
        const err = $('#party-error');
        if (err) err.textContent = '';
        requireSocket().emit('party:create', {}, (res) => {
          if (!res || !res.ok) {
            if (err) err.textContent = (res && res.error) || 'Falha';
            return;
          }
          party = res.party;
          renderParty();
        });
        return;
      }
      if (t.id === 'btn-leave-party') {
        e.preventDefault();
        requireSocket().emit('party:leave', {}, () => {
          party = null;
          renderParty();
        });
        return;
      }
      if (t.id === 'btn-hall') {
        e.preventDefault();
        const err = $('#party-error');
        if (err) err.textContent = '';
        requireSocket().emit('party:start_hall', {}, (res) => {
          if (!res || !res.ok) {
            if (err) err.textContent = (res && res.error) || 'Falha';
            return;
          }
          party = res.party;
          show('hall');
          initAttrEditor();
        });
        return;
      }
      if (t.id === 'btn-ready') {
        e.preventDefault();
        if (readySent) return;
        const err = $('#hall-error');
        if (err) err.textContent = '';
        requireSocket().emit('party:ready', { ready: true }, (res) => {
          if (!res || !res.ok) {
            if (err) err.textContent = (res && res.error) || 'Falha';
            return;
          }
          readySent = true;
          party = res.party;
          const readyBtn = $('#btn-ready');
          if (readyBtn) {
            readyBtn.textContent = 'AGUARDANDO PARTY...';
            readyBtn.disabled = true;
          }
          renderHallMembers();
        });
        return;
      }
      if (t.id === 'btn-attr-reset') {
        e.preventDefault();
        applyClassPreset();
      }
    });
  }

  const formJoin = $('#form-join');
  if (formJoin) {
    formJoin.addEventListener('submit', (e) => {
      e.preventDefault();
      const err = $('#party-error');
      if (err) err.textContent = '';
      const codeInput = $('#input-code');
      requireSocket().emit('party:join', { code: codeInput ? codeInput.value : '' }, (res) => {
        if (!res || !res.ok) {
          if (err) err.textContent = (res && res.error) || 'Falha';
          return;
        }
        party = res.party;
        renderParty();
      });
    });
  }

  const charClass = $('#char-class');
  if (charClass) {
    charClass.addEventListener('change', () => {
      applyClassPreset();
      syncPowerLabel();
    });
  }
  const charRace = $('#char-race');
  if (charRace) {
    charRace.addEventListener('change', () => {
      // Ao trocar raça, revalida pontos (humano tem +1)
      const spent = totalSkillSpent();
      if (spent > powerBudget()) resetSkillRanksForClass();
      syncPowerLabel();
      requestPreview();
    });
  }
  const charName = $('#char-name');
  if (charName) charName.addEventListener('input', requestPreview);

  const formChar = $('#form-char');
  if (formChar) {
    formChar.addEventListener('submit', (e) => {
      e.preventDefault();
      const err = $('#hall-error');
      if (err) err.textContent = '';
      readySent = false;
      requireSocket().emit('character:submit', {
        name: $('#char-name') && $('#char-name').value,
        race: $('#char-race') && $('#char-race').value,
        classKey: $('#char-class') && $('#char-class').value,
        attrs: attrState,
        skillRanks: skillRanks,
      }, (res) => {
        if (!res || !res.ok) {
          if (err) err.textContent = (res && res.error) || 'Falha';
          return;
        }
        party = res.party;
        const c = res.character;
        const preview = $('#char-preview');
        if (preview && c) {
          preview.textContent =
            c.name + ' — ' + c.race + ' ' + c.class +
            ' | HP ' + c.hp + '/' + c.hpMax +
            ' | Mana ' + c.mp + '/' + c.mpMax +
            ' | Def ' + c.defense + ' | ' + c.weapon;
        }
        const readyBtn = $('#btn-ready');
        if (readyBtn) readyBtn.disabled = false;
        renderHallMembers();
      });
    });
  }

  const formAction = $('#form-action');
  if (formAction) {
    formAction.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!currentTurn || !me || currentTurn.current !== me.id) {
        const err = $('#action-error');
        if (err) err.textContent = 'Não é o seu turno.';
        return;
      }
      const input = $('#input-action');
      const text = input ? input.value.trim() : '';
      if (!text) return;
      const err = $('#action-error');
      if (err) err.textContent = '';
      if (input) input.value = '';
      setActionEnabled(false, 'Resolvendo...');
      requireSocket().emit('action:submit', { text: text }, (res) => {
        if (!res || !res.ok) {
          if (err) err.textContent = (res && res.error) || 'Falha';
          if (currentTurn) applyTurn(currentTurn);
          return;
        }
        if (res.result && res.result.hud) renderHud(res.result.hud);
        if (res.result && res.result.turn) applyTurn(res.result.turn);
      });
    });
  }

  boot();
})();
