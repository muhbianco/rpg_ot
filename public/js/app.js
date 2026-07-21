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
    $('#you-label').textContent = player.nickname || '—';
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

  function connect() {
    if (socket) return socket;
    socket = io({ transports: ['websocket', 'polling'], reconnection: true });

    socket.on('connect_error', (err) => {
      const msg = String(err?.message || err);
      if (msg.includes('unauthorized') || msg.includes('auth_unavailable')) {
        show('landing');
        const el = $('#auth-error');
        if (el) {
          el.textContent = msg.includes('auth_unavailable')
            ? AUTH_MESSAGES.disabled
            : 'Sessão expirada. Entre com Discord novamente.';
        }
      }
    });

    socket.on('auth:ok', (payload) => {
      if (payload?.player) setUserChip(payload.player);
      show('party');
    });

    socket.on('meta', (meta) => {
      $('#online-count').textContent = String(meta.online || 0);
      $('#gm-status').textContent = meta.gemini ? 'Gemini ativo' : 'fallback local';
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
      pushNarrative('Mestre', 'A sessão começa na Taverna de Arton. As tochas crepitam.');
    });

    socket.on('session:state', (payload) => {
      ensureRenderer();
      if (payload.world) renderer.setWorld(payload.world);
      if (payload.party) renderPartyHud(payload.party);
      if (payload.hud) renderHud(payload.hud);
      if (payload.turn) applyTurn(payload.turn);
      highlightTurnActor(payload.turn);
    });

    socket.on('turn:update', (turn) => {
      applyTurn(turn);
      highlightTurnActor(turn);
    });

    socket.on('narrative:push', (payload) => {
      const who = payload.character || payload.from || 'Mestre';
      if (payload.text) pushNarrative(who, payload.text);
      (payload.combat || []).forEach((c) => {
        if (c.summary) pushNarrative('Combate', c.summary);
      });
      if (payload.effects && renderer) renderer.playEffects(payload.effects);
    });

    socket.on('game:over', (payload) => {
      const msg = payload.outcome === 'victory'
        ? 'Vitória! Os inimigos foram derrotados.'
        : 'Derrota. A party caiu na Taverna de Arton.';
      pushNarrative('Mestre', msg);
      setActionEnabled(false, 'Partida encerrada');
      if (payload.turn) applyTurn(payload.turn);
    });

    return socket;
  }

  function enterGame(payload) {
    show('game');
    ensureRenderer();
    $('#narrative-log').replaceChildren();
    if (payload.world) renderer.setWorld(payload.world);
    renderPartyHud(payload.partyHud || payload.party || []);
    if (payload.hud) renderHud(payload.hud);
    if (payload.turn) applyTurn(payload.turn);
    highlightTurnActor(payload.turn);
    (payload.log || []).forEach((l) => pushNarrative(l.who || 'Log', l.text));
  }

  function highlightTurnActor(turn) {
    if (!renderer || !turn) return;
    const actorId = turn.current === 'gm' ? null : (
      (renderer.world?.entities || []).find((e) => e.playerId === turn.current)?.id || null
    );
    renderer.setFocus(actorId);
  }

  function ensureRenderer() {
    if (!renderer) renderer = new window.OtRenderer($('#game-canvas'));
  }

  function fillCatalog() {
    if (!catalog) return;
    const raceSel = $('#char-race');
    const classSel = $('#char-class');
    if (!raceSel || !classSel) return;
    raceSel.replaceChildren();
    classSel.replaceChildren();
    catalog.races.forEach((r) => {
      const o = document.createElement('option');
      o.value = r.key;
      o.textContent = r.label;
      raceSel.appendChild(o);
    });
    catalog.classes.forEach((c) => {
      const o = document.createElement('option');
      o.value = c.key;
      o.textContent = `${c.label} (${c.weapon || '—'})`;
      classSel.appendChild(o);
    });
  }

  function initAttrEditor() {
    const wrap = $('#attr-editor');
    if (!wrap || !catalog?.pointBuy) return;
    const pb = catalog.pointBuy;
    const classKey = $('#char-class')?.value || 'guerreiro';
    if (!attrState) attrState = { ...(pb.presets[classKey] || pb.presets.guerreiro) };
    if (wrap.childElementCount) {
      renderAttrEditor();
      return;
    }
    wrap.replaceChildren();
    (catalog.attrs || []).forEach((key) => {
      const row = document.createElement('div');
      row.className = 'attr-row';
      row.dataset.attr = key;
      row.innerHTML = `
        <span class="attr-label">${catalog.attrLabels?.[key] || key}</span>
        <button type="button" class="attr-btn" data-dir="-1" aria-label="Diminuir ${key}">−</button>
        <span class="attr-val">${attrState[key]}</span>
        <button type="button" class="attr-btn" data-dir="1" aria-label="Aumentar ${key}">+</button>
        <span class="attr-mod"></span>
      `;
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
      const trial = { ...attrState, [key]: next };
      if (spentPoints(trial) > pb.pool) return;
      attrState[key] = next;
      renderAttrEditor();
      requestPreview();
    });
    renderAttrEditor();
  }

  function spentPoints(attrs) {
    const cost = catalog?.pointBuy?.cost || {};
    return (catalog.attrs || []).reduce((sum, k) => sum + (cost[attrs[k]] || 0), 0);
  }

  function renderAttrEditor() {
    if (!attrState || !catalog?.pointBuy) return;
    const pb = catalog.pointBuy;
    const spent = spentPoints(attrState);
    const rem = pb.pool - spent;
    const remEl = $('#attr-remaining');
    if (remEl) remEl.textContent = `${rem} pontos restantes (${spent}/${pb.pool})`;
    $('#attr-editor')?.querySelectorAll('.attr-row').forEach((row) => {
      const key = row.dataset.attr;
      const v = attrState[key];
      row.querySelector('.attr-val').textContent = String(v);
      const mod = Math.floor((v - 10) / 2);
      row.querySelector('.attr-mod').textContent = mod >= 0 ? `+${mod}` : String(mod);
    });
  }

  function applyClassPreset() {
    if (!catalog?.pointBuy) return;
    const classKey = $('#char-class')?.value || 'guerreiro';
    attrState = { ...(catalog.pointBuy.presets[classKey] || catalog.pointBuy.presets.guerreiro) };
    renderAttrEditor();
    requestPreview();
  }

  let previewTimer = null;
  function requestPreview() {
    if (!socket || !attrState) return;
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => {
      socket.emit('character:preview', {
        name: $('#char-name')?.value,
        race: $('#char-race')?.value,
        classKey: $('#char-class')?.value,
        attrs: attrState,
      }, (res) => {
        if (!res?.ok || !res.hud) return;
        const c = res.hud;
        $('#char-preview').textContent =
          `${c.name} — ${c.race} ${c.class} | HP ${c.hp}/${c.hpMax} | Mana ${c.mp}/${c.mpMax} | Def ${c.defense} | ${c.weapon}`;
      });
    }, 200);
  }

  function renderParty() {
    const box = $('#party-box');
    if (!party) {
      box.classList.add('hidden');
      return;
    }
    box.classList.remove('hidden');
    $('#party-code').textContent = party.code;
    $('#party-size').textContent = String(party.size);
    const ul = $('#party-members');
    ul.replaceChildren();
    (party.members || []).forEach((m) => {
      const li = document.createElement('li');
      const host = m.playerId === party.hostId ? ' (host)' : '';
      const ready = m.ready ? ' ✓' : '';
      const char = m.character ? ` — ${m.character.name} (${m.character.class})` : '';
      li.textContent = `${m.nickname}${host}${ready}${char}`;
      ul.appendChild(li);
    });
    const isHost = me && party.hostId === me.id;
    $('#btn-hall').style.display = isHost && party.status === 'lobby' ? '' : 'none';
  }

  function renderHallMembers() {
    const ul = $('#hall-members');
    if (!ul || !party) return;
    ul.replaceChildren();
    (party.members || []).forEach((m) => {
      const li = document.createElement('li');
      li.textContent = `${m.nickname}: ${m.character ? `${m.character.name} / ${m.character.class}` : 'montando...'} ${m.ready ? '[PRONTO]' : ''}`;
      ul.appendChild(li);
    });
  }

  function renderHud(hud) {
    if (!hud) return;
    $('#hud-name').textContent = hud.name;
    $('#hud-class').textContent = `${hud.race} · ${hud.class} Nv.${hud.level}`;
    $('#hud-hp').textContent = `${hud.hp}/${hud.hpMax}`;
    $('#hud-mp').textContent = `${hud.mp}/${hud.mpMax}`;
    $('#bar-hp').style.width = `${hud.hpMax ? (hud.hp / hud.hpMax) * 100 : 0}%`;
    $('#bar-mp').style.width = `${hud.mpMax ? (hud.mp / hud.mpMax) * 100 : 0}%`;
    $('#hud-def').textContent = String(hud.defense);
    $('#hud-weapon').textContent = hud.weapon || '—';
    $('#hud-status').textContent = (hud.status && hud.status.length) ? hud.status.join(', ') : 'nenhum';
  }

  function renderPartyHud(list) {
    if (!list) return;
    const ul = $('#party-hud');
    ul.replaceChildren();
    list.forEach((p) => {
      const li = document.createElement('li');
      li.dataset.playerId = p.playerId || '';
      const mine = p.playerId === me?.id ? ' ★' : '';
      li.textContent = `${p.name} ${p.hpPct}%${mine}`;
      if (currentTurn?.current === p.playerId) li.classList.add('turn-active');
      ul.appendChild(li);
    });
  }

  function applyTurn(turn) {
    currentTurn = turn;
    const banner = $('#turn-banner');
    if (banner && turn) {
      banner.textContent = turn.outcome
        ? (turn.outcome === 'victory' ? 'Vitória!' : 'Derrota')
        : `Rodada ${turn.round} · Turno: ${turn.currentName}`;
      banner.classList.toggle('my-turn', turn.current === me?.id);
    }
    const myTurn = Boolean(turn && me && turn.current === me.id && !turn.outcome);
    setActionEnabled(myTurn, myTurn ? 'O que você faz?' : (turn?.currentName ? `Aguardando ${turn.currentName}...` : 'Aguarde o turno'));
    $('#party-hud')?.querySelectorAll('li').forEach((li) => {
      li.classList.toggle('turn-active', li.dataset.playerId === turn?.current);
    });
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

  function pushNarrative(who, text) {
    const log = $('#narrative-log');
    const div = document.createElement('div');
    div.className = 'entry';
    div.innerHTML = `<span class="who"></span> <span class="msg"></span>`;
    div.querySelector('.who').textContent = who + ':';
    div.querySelector('.msg').textContent = text;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  }

  function statusLabel(status) {
    return {
      lobby: 'Lobby',
      hall: 'Hall',
      active: 'Em andamento',
      ended: 'Finalizado',
    }[status] || status;
  }

  function loadGames() {
    $('#games-error').textContent = '';
    socket.emit('games:list', {}, (res) => {
      if (!res?.ok) {
        $('#games-error').textContent = res?.error || 'Falha ao listar.';
        return;
      }
      const list = $('#games-list');
      list.replaceChildren();
      const empty = $('#games-empty');
      if (!res.games?.length) {
        empty.classList.remove('hidden');
        return;
      }
      empty.classList.add('hidden');
      res.games.forEach((g) => {
        const li = document.createElement('li');
        li.className = 'game-item';
        const cls = CLASS_LABELS[g.charClass] || g.charClass || '—';
        const when = g.updatedAt ? new Date(g.updatedAt).toLocaleString('pt-BR') : '';
        li.innerHTML = `
          <div class="game-main">
            <strong>${g.code}</strong>
            <span class="pill status-${g.status}">${statusLabel(g.status)}</span>
            <span class="muted">${g.charName || 'sem ficha'} · ${cls} · ${g.memberCount} jogadores</span>
            <span class="muted tiny">${when}</span>
          </div>
          <div class="game-actions"></div>
        `;
        const actions = li.querySelector('.game-actions');
        if (g.canRejoin || g.canResumeLobby) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'btn tiny';
          btn.textContent = g.canRejoin ? 'Reentrar' : 'Retomar';
          btn.addEventListener('click', () => rejoinGame(g.partyId));
          actions.appendChild(btn);
        }
        if (g.status === 'ended' || g.sessionId) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'btn ghost tiny';
          btn.textContent = 'Ver recap';
          btn.addEventListener('click', () => loadRecap(g.partyId));
          actions.appendChild(btn);
        }
        list.appendChild(li);
      });
    });
  }

  function rejoinGame(partyId) {
    $('#games-error').textContent = '';
    socket.emit('games:rejoin', { partyId }, (res) => {
      if (!res?.ok) {
        $('#games-error').textContent = res?.error || 'Falha ao reentrar.';
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
    $('#games-error').textContent = '';
    socket.emit('games:recap', { partyId }, (res) => {
      if (!res?.ok) {
        $('#games-error').textContent = res?.error || 'Falha no recap.';
        return;
      }
      const r = res.recap;
      const box = $('#recap-box');
      box.classList.remove('hidden');
      $('#recap-title').textContent = `Recap · ${r.code || partyId.slice(0, 8)}`;
      const outcome = r.outcome === 'victory' ? 'Vitória' : r.outcome === 'defeat' ? 'Derrota' : statusLabel(r.status);
      $('#recap-meta').textContent = `${outcome}${r.endedAt ? ` · ${new Date(r.endedAt).toLocaleString('pt-BR')}` : ''}`;
      const chars = $('#recap-chars');
      chars.replaceChildren();
      (r.characters || []).forEach((c) => {
        const li = document.createElement('li');
        li.textContent = `${c.name} (${c.class}) — HP ${c.hp}/${c.hpMax}`;
        chars.appendChild(li);
      });
      const log = $('#recap-log');
      log.replaceChildren();
      const lines = (r.log && r.log.length ? r.log : r.actions) || [];
      lines.forEach((l) => {
        const div = document.createElement('div');
        div.className = 'entry';
        div.textContent = l.text;
        log.appendChild(div);
      });
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
          btn.addEventListener('click', (e) => e.preventDefault());
        }
        $('#auth-error').textContent = AUTH_MESSAGES.disabled;
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
      if (meData?.player) setUserChip(meData.player);
      connect();
      show('party');
    } catch {
      show('landing');
      $('#auth-error').textContent = 'Não foi possível verificar a sessão.';
    }
  }

  $('#btn-goto-games')?.addEventListener('click', () => {
    show('games');
    $('#recap-box').classList.add('hidden');
    loadGames();
  });

  $('#btn-games-back')?.addEventListener('click', () => show('party'));
  $('#btn-recap-close')?.addEventListener('click', () => $('#recap-box').classList.add('hidden'));

  $('#btn-hall-back')?.addEventListener('click', () => {
    show('party');
    renderParty();
  });

  $('#btn-game-lobby')?.addEventListener('click', () => {
    socket.emit('party:leave', {}, () => {
      party = null;
      currentTurn = null;
      show('party');
      renderParty();
    });
  });

  $('#btn-create-party')?.addEventListener('click', () => {
    $('#party-error').textContent = '';
    socket.emit('party:create', {}, (res) => {
      if (!res?.ok) {
        $('#party-error').textContent = res?.error || 'Falha';
        return;
      }
      party = res.party;
      renderParty();
    });
  });

  $('#form-join')?.addEventListener('submit', (e) => {
    e.preventDefault();
    $('#party-error').textContent = '';
    socket.emit('party:join', { code: $('#input-code').value }, (res) => {
      if (!res?.ok) {
        $('#party-error').textContent = res?.error || 'Falha';
        return;
      }
      party = res.party;
      renderParty();
    });
  });

  $('#btn-leave-party')?.addEventListener('click', () => {
    socket.emit('party:leave', {}, () => {
      party = null;
      renderParty();
    });
  });

  $('#btn-hall')?.addEventListener('click', () => {
    $('#party-error').textContent = '';
    socket.emit('party:start_hall', {}, (res) => {
      if (!res?.ok) {
        $('#party-error').textContent = res?.error || 'Falha';
        return;
      }
      party = res.party;
      show('hall');
      initAttrEditor();
    });
  });

  $('#char-class')?.addEventListener('change', applyClassPreset);
  $('#char-race')?.addEventListener('change', requestPreview);
  $('#char-name')?.addEventListener('input', requestPreview);
  $('#btn-attr-reset')?.addEventListener('click', applyClassPreset);

  $('#form-char')?.addEventListener('submit', (e) => {
    e.preventDefault();
    $('#hall-error').textContent = '';
    readySent = false;
    socket.emit('character:submit', {
      name: $('#char-name').value,
      race: $('#char-race').value,
      classKey: $('#char-class').value,
      attrs: attrState,
    }, (res) => {
      if (!res?.ok) {
        $('#hall-error').textContent = res?.error || 'Falha';
        return;
      }
      party = res.party;
      const c = res.character;
      $('#char-preview').textContent =
        `${c.name} — ${c.race} ${c.class} | HP ${c.hp}/${c.hpMax} | Mana ${c.mp}/${c.mpMax} | Def ${c.defense} | ${c.weapon}`;
      $('#btn-ready').disabled = false;
      renderHallMembers();
    });
  });

  $('#btn-ready')?.addEventListener('click', () => {
    if (readySent) return;
    $('#hall-error').textContent = '';
    socket.emit('party:ready', { ready: true }, (res) => {
      if (!res?.ok) {
        $('#hall-error').textContent = res?.error || 'Falha';
        return;
      }
      readySent = true;
      party = res.party;
      $('#btn-ready').textContent = 'AGUARDANDO PARTY...';
      $('#btn-ready').disabled = true;
      renderHallMembers();
    });
  });

  $('#form-action')?.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!currentTurn || currentTurn.current !== me?.id) {
      $('#action-error').textContent = 'Não é o seu turno.';
      return;
    }
    const text = $('#input-action').value.trim();
    if (!text) return;
    $('#action-error').textContent = '';
    $('#input-action').value = '';
    setActionEnabled(false, 'Resolvendo...');
    socket.emit('action:submit', { text }, (res) => {
      if (!res?.ok) {
        $('#action-error').textContent = res?.error || 'Falha';
        if (currentTurn) applyTurn(currentTurn);
        return;
      }
      if (res.result?.hud) renderHud(res.result.hud);
      if (res.result?.turn) applyTurn(res.result.turn);
    });
  });

  boot();
})();
