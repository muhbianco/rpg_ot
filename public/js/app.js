(() => {
  const $ = (s) => document.querySelector(s);

  const screens = {
    landing: $('#screen-landing'),
    nick: $('#screen-nick'),
    party: $('#screen-party'),
    hall: $('#screen-hall'),
    game: $('#screen-game'),
  };

  let socket = null;
  let me = null;
  let catalog = null;
  let party = null;
  let renderer = null;
  let readySent = false;

  function show(name) {
    Object.entries(screens).forEach(([key, el]) => {
      const on = key === name;
      el.classList.toggle('hidden', !on);
      el.setAttribute('aria-hidden', on ? 'false' : 'true');
    });
  }

  function connect() {
    if (socket) return socket;
    socket = io({ transports: ['websocket', 'polling'], reconnection: true });

    socket.on('meta', (meta) => {
      $('#online-count').textContent = String(meta.online || 0);
      $('#gm-status').textContent = meta.gemini ? 'Gemini ativo' : 'fallback local';
      if (meta.catalog) {
        catalog = meta.catalog;
        fillCatalog();
      }
    });

    socket.on('party:update', (snap) => {
      party = snap;
      renderParty();
      renderHallMembers();
      if (snap && (snap.status === 'hall' || snap.status === 'active')) {
        if (snap.status === 'hall') show('hall');
      }
    });

    socket.on('party:hall', (snap) => {
      party = snap;
      show('hall');
      renderHallMembers();
    });

    socket.on('session:start', (payload) => {
      show('game');
      ensureRenderer();
      if (payload.world) renderer.setWorld(payload.world);
      renderPartyHud(payload.party || []);
      pushNarrative('Mestre', 'A sessão começa na Taverna de Arton. As tochas crepitam.');
    });

    socket.on('session:state', (payload) => {
      ensureRenderer();
      if (payload.world) renderer.setWorld(payload.world);
      if (payload.party) renderPartyHud(payload.party);
      if (payload.hud) renderHud(payload.hud);
    });

    socket.on('narrative:push', (payload) => {
      const who = payload.character || payload.from || 'Mestre';
      pushNarrative(who, payload.text);
      (payload.combat || []).forEach((c) => {
        if (c.summary) pushNarrative('Combate', c.summary);
      });
    });

    return socket;
  }

  function ensureRenderer() {
    if (!renderer) {
      renderer = new window.OtRenderer($('#game-canvas'));
    }
  }

  function fillCatalog() {
    if (!catalog) return;
    const raceSel = $('#char-race');
    const classSel = $('#char-class');
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
    const ul = $('#party-hud');
    ul.replaceChildren();
    (list || []).forEach((p) => {
      const li = document.createElement('li');
      li.textContent = `${p.name} ${p.hpPct}%`;
      ul.appendChild(li);
    });
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

  $('#btn-enter').addEventListener('click', () => {
    connect();
    show('nick');
  });

  $('#btn-nick-back').addEventListener('click', () => show('landing'));

  $('#form-nick').addEventListener('submit', (e) => {
    e.preventDefault();
    const nickname = $('#input-nick').value.trim();
    $('#nick-error').textContent = '';
    connect().emit('auth:join', { nickname }, (res) => {
      if (!res?.ok) {
        $('#nick-error').textContent = res?.error || 'Falha';
        return;
      }
      me = res.player;
      $('#you-label').textContent = me.nickname;
      $('#char-name').value = me.nickname;
      show('party');
    });
  });

  $('#btn-create-party').addEventListener('click', () => {
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

  $('#form-join').addEventListener('submit', (e) => {
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

  $('#btn-leave-party').addEventListener('click', () => {
    socket.emit('party:leave', {}, () => {
      party = null;
      renderParty();
    });
  });

  $('#btn-hall').addEventListener('click', () => {
    $('#party-error').textContent = '';
    socket.emit('party:start_hall', {}, (res) => {
      if (!res?.ok) {
        $('#party-error').textContent = res?.error || 'Falha';
        return;
      }
      party = res.party;
      show('hall');
    });
  });

  $('#form-char').addEventListener('submit', (e) => {
    e.preventDefault();
    $('#hall-error').textContent = '';
    readySent = false;
    socket.emit('character:submit', {
      name: $('#char-name').value,
      race: $('#char-race').value,
      classKey: $('#char-class').value,
    }, (res) => {
      if (!res?.ok) {
        $('#hall-error').textContent = res?.error || 'Falha';
        return;
      }
      party = res.party;
      const c = res.character;
      $('#char-preview').textContent = `${c.name} — ${c.race} ${c.class} | HP ${c.hp}/${c.hpMax} | Mana ${c.mp}/${c.mpMax} | Def ${c.defense} | ${c.weapon}`;
      $('#btn-ready').disabled = false;
      renderHallMembers();
    });
  });

  $('#btn-ready').addEventListener('click', () => {
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

  $('#form-action').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = $('#input-action').value.trim();
    if (!text) return;
    $('#action-error').textContent = '';
    $('#input-action').value = '';
    socket.emit('action:submit', { text }, (res) => {
      if (!res?.ok) {
        $('#action-error').textContent = res?.error || 'Falha';
        return;
      }
      if (res.result?.hud) renderHud(res.result.hud);
    });
  });
})();
