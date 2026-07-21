(() => {
  const TILE = 52;
  const COLORS = {
    floor: '#3a2a1c',
    floorAlt: '#332418',
    wall: '#1a120c',
    table: '#5a3a22',
    bar: '#6a4428',
    door: '#8a5a30',
    barrel: '#4a3020',
    chair: '#503828',
    hearth: '#8a4020',
    crate: '#5a4830',
    ruin: '#3a3a38',
    rune: '#3a4a6a',
    altar: '#6a6050',
  };

  function iso(x, y) {
    return {
      px: (x - y) * (TILE / 2),
      py: (x + y) * (TILE / 4),
    };
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function easeOut(t) {
    return 1 - (1 - t) * (1 - t);
  }

  class OtRenderer {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.world = null;
      this.originX = canvas.width / 2;
      this.originY = 70;
      this.floats = [];
      this.pulses = [];
      this.lunge = null;
      this.focusId = null;
      this.selectedId = null;
      this.shakeUntil = 0;
      this.raf = null;
      this.onSelect = null;
      this._tick = this._tick.bind(this);
      this._onClick = this._onClick.bind(this);
      canvas.addEventListener('click', this._onClick);
      canvas.style.cursor = 'pointer';
      this._startLoop();
    }

    _startLoop() {
      if (this.raf) return;
      this.raf = requestAnimationFrame(this._tick);
    }

    _tick(now) {
      this.raf = requestAnimationFrame(this._tick);
      this.floats = this.floats.filter((f) => now < f.until);
      this.pulses = this.pulses.filter((p) => now < p.until);
      if (this.lunge && now >= this.lunge.until) this.lunge = null;
      this.draw(now);
    }

    setWorld(world) {
      this.world = world;
      this._fitOrigin();
      this.draw(performance.now());
    }

    _fitOrigin() {
      if (!this.world) return;
      const mw = this.world.mapW || 12;
      const mh = this.world.mapH || 10;
      const mid = iso(mw / 2, mh / 2);
      this.originX = this.canvas.width / 2 - mid.px * 0.15;
      this.originY = Math.max(48, this.canvas.height * 0.12);
    }

    setFocus(entityId) {
      this.focusId = entityId || null;
    }

    screenPos(x, y) {
      const { px, py } = iso(x, y);
      return { ox: this.originX + px, oy: this.originY + py + 8 };
    }

    _onClick(ev) {
      if (!this.world) return;
      const rect = this.canvas.getBoundingClientRect();
      const sx = ((ev.clientX - rect.left) / rect.width) * this.canvas.width;
      const sy = ((ev.clientY - rect.top) / rect.height) * this.canvas.height;
      const hit = this.hitTest(sx, sy);
      if (!hit) return;
      this.selectedId = hit.id;
      this.focusId = hit.id;
      if (typeof this.onSelect === 'function') this.onSelect(hit);
    }

    hitTest(sx, sy) {
      const now = performance.now();
      const entities = [...(this.world.entities || [])].reverse();
      for (const e of entities) {
        const pos = this.entityDrawPos(e, now);
        const { ox, oy } = this.screenPos(pos.x, pos.y);
        if (Math.abs(sx - ox) < 18 && sy > oy - 44 && sy < oy + 16) return e;
      }
      return null;
    }

    playEffects(effects) {
      if (!Array.isArray(effects) || !effects.length || !this.world) return;
      const now = performance.now();

      for (const fx of effects) {
        if (fx.type === 'move' && fx.id != null) {
          const ent = (this.world.entities || []).find((e) => e.id === fx.id);
          if (ent) {
            if (fx.fromX != null) {
              ent._animFrom = { x: fx.fromX, y: fx.fromY, t0: now, t1: now + 280 };
            }
            if (fx.x != null) {
              ent.x = fx.x;
              ent.y = fx.y;
            }
          }
        }
        if (fx.type === 'attack' || fx.type === 'cast') {
          const atk = (this.world.entities || []).find((e) => e.id === (fx.attackerId || fx.casterId));
          const tgt = (this.world.entities || []).find((e) => e.id === fx.targetId);
          if (atk && tgt) {
            this.lunge = {
              id: atk.id,
              fromX: atk.x,
              fromY: atk.y,
              toX: tgt.x,
              toY: tgt.y,
              t0: now,
              until: now + 320,
            };
          }
          if (tgt && fx.damage) {
            const p = this.screenPos(tgt.x, tgt.y);
            this.floats.push({
              text: `-${fx.damage}`,
              color: '#ff6b5a',
              x: p.ox,
              y: p.oy - 30,
              t0: now,
              until: now + 900,
            });
            this.shakeUntil = now + 220;
          }
          if (tgt && fx.healed) {
            const p = this.screenPos(tgt.x, tgt.y);
            this.floats.push({
              text: `+${fx.healed}`,
              color: '#5dca7a',
              x: p.ox,
              y: p.oy - 30,
              t0: now,
              until: now + 900,
            });
          }
          if (tgt) this.pulses.push({ id: tgt.id, color: '#e8a060', t0: now, until: now + 400 });
        }
        if (fx.type === 'death' && fx.id != null) {
          const ent = (this.world.entities || []).find((e) => e.id === fx.id);
          if (ent) ent._dying = { t0: now, until: now + 700 };
        }
        if (fx.type === 'spawn' && fx.id != null) {
          this.pulses.push({ id: fx.id, color: '#7ec4e8', t0: now, until: now + 600 });
        }
        if (fx.type === 'focus' && fx.id != null) {
          this.focusId = fx.id;
          this.selectedId = fx.id;
        }
      }
    }

    entityDrawPos(e, now) {
      let x = e.x;
      let y = e.y;
      if (e._animFrom && now < e._animFrom.t1) {
        const t = easeOut((now - e._animFrom.t0) / (e._animFrom.t1 - e._animFrom.t0));
        x = lerp(e._animFrom.x, e.x, t);
        y = lerp(e._animFrom.y, e.y, t);
      } else if (e._animFrom) {
        delete e._animFrom;
      }

      if (this.lunge && this.lunge.id === e.id) {
        const dur = this.lunge.until - this.lunge.t0;
        const t = (now - this.lunge.t0) / dur;
        const wave = t < 0.5 ? t * 2 : (1 - t) * 2;
        x = lerp(this.lunge.fromX, this.lunge.toX, wave * 0.35);
        y = lerp(this.lunge.fromY, this.lunge.toY, wave * 0.35);
      }
      return { x, y };
    }

    draw(now = performance.now()) {
      const { ctx, canvas, world } = this;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (!world) return;

      // fundo atmosfera
      const g = ctx.createRadialGradient(canvas.width / 2, canvas.height * 0.3, 20, canvas.width / 2, canvas.height / 2, canvas.width * 0.6);
      g.addColorStop(0, 'rgba(80,45,20,0.25)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      let shakeX = 0;
      let shakeY = 0;
      if (now < this.shakeUntil) {
        shakeX = (Math.random() - 0.5) * 6;
        shakeY = (Math.random() - 0.5) * 4;
      }
      ctx.save();
      ctx.translate(shakeX, shakeY);

      for (const t of world.tiles || []) this.drawTile(t.x, t.y, t.type);

      const entities = [...(world.entities || [])].sort((a, b) => (a.x + a.y) - (b.x + b.y));
      for (const e of entities) {
        if (e._dying && now >= e._dying.until) continue;
        this.drawEntity(e, now);
      }

      for (const f of this.floats) {
        const life = (now - f.t0) / (f.until - f.t0);
        ctx.globalAlpha = 1 - life;
        ctx.fillStyle = f.color;
        ctx.font = 'bold 14px Cinzel, serif';
        ctx.textAlign = 'center';
        ctx.fillText(f.text, f.x, f.y - life * 28);
        ctx.globalAlpha = 1;
      }

      ctx.restore();
    }

    drawTile(x, y, type) {
      const { ctx } = this;
      const { px, py } = iso(x, y);
      const ox = this.originX + px;
      const oy = this.originY + py;
      const hw = TILE / 2;
      const hh = TILE / 4;

      ctx.beginPath();
      ctx.moveTo(ox, oy);
      ctx.lineTo(ox + hw, oy + hh);
      ctx.lineTo(ox, oy + hh * 2);
      ctx.lineTo(ox - hw, oy + hh);
      ctx.closePath();

      let fill = COLORS.floor;
      if ((x + y) % 2 === 0 && type === 'floor') fill = COLORS.floorAlt;
      if (COLORS[type]) fill = COLORS[type];

      ctx.fillStyle = fill;
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.stroke();

      if (type === 'wall') {
        ctx.fillStyle = '#24180f';
        ctx.fillRect(ox - hw + 8, oy - 20, hw * 2 - 16, 24);
      }
      if (type === 'table') {
        ctx.fillStyle = '#6a4428';
        ctx.fillRect(ox - 10, oy + 2, 20, 8);
        ctx.fillStyle = '#3a2418';
        ctx.fillRect(ox - 8, oy + 10, 3, 8);
        ctx.fillRect(ox + 5, oy + 10, 3, 8);
      }
      if (type === 'bar') {
        ctx.fillStyle = '#7a5030';
        ctx.fillRect(ox - 12, oy, 24, 10);
      }
      if (type === 'barrel') {
        ctx.fillStyle = '#5a3820';
        ctx.beginPath();
        ctx.ellipse(ox, oy + 6, 8, 10, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#2a1810';
        ctx.stroke();
      }
      if (type === 'chair') {
        ctx.fillStyle = '#503828';
        ctx.fillRect(ox - 6, oy + 2, 12, 6);
        ctx.fillRect(ox - 6, oy - 4, 3, 8);
      }
      if (type === 'hearth') {
        ctx.fillStyle = '#a05028';
        ctx.fillRect(ox - 10, oy - 2, 20, 14);
        ctx.fillStyle = '#e8a040';
        ctx.globalAlpha = 0.7 + Math.sin(performance.now() / 180) * 0.2;
        ctx.beginPath();
        ctx.arc(ox, oy + 2, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      if (type === 'crate') {
        ctx.fillStyle = '#6a5840';
        ctx.fillRect(ox - 9, oy, 18, 12);
        ctx.strokeStyle = '#2a2010';
        ctx.strokeRect(ox - 9, oy, 18, 12);
      }
      if (type === 'ruin') {
        ctx.fillStyle = '#4a4a48';
        ctx.fillRect(ox - 8, oy - 6, 16, 16);
      }
      if (type === 'rune') {
        ctx.strokeStyle = '#7ec4ff';
        ctx.globalAlpha = 0.6 + Math.sin(performance.now() / 300 + x) * 0.25;
        ctx.beginPath();
        ctx.arc(ox, oy + 6, 8, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      if (type === 'altar') {
        ctx.fillStyle = '#8a8070';
        ctx.fillRect(ox - 12, oy, 24, 10);
        ctx.fillStyle = '#c4b898';
        ctx.fillRect(ox - 6, oy - 8, 12, 8);
      }
      if (type === 'door') {
        ctx.fillStyle = '#9a6a38';
        ctx.fillRect(ox - 8, oy - 14, 16, 28);
      }
    }

    drawEntity(e, now) {
      const { ctx } = this;
      const pos = this.entityDrawPos(e, now);
      const { ox, oy } = this.screenPos(pos.x, pos.y);

      let alpha = 1;
      if (e._dying) {
        alpha = Math.max(0, 1 - (now - e._dying.t0) / (e._dying.until - e._dying.t0));
      }
      ctx.globalAlpha = alpha;

      const pulse = this.pulses.find((p) => p.id === e.id);
      if (pulse) {
        const life = (now - pulse.t0) / (pulse.until - pulse.t0);
        ctx.beginPath();
        ctx.arc(ox, oy - 10, 18 + life * 16, 0, Math.PI * 2);
        ctx.strokeStyle = pulse.color;
        ctx.globalAlpha = alpha * (1 - life);
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.globalAlpha = alpha;
      }

      if (this.focusId === e.id || this.selectedId === e.id) {
        ctx.strokeStyle = e.kind === 'npc' ? '#7ec4e8' : '#d4a84a';
        ctx.lineWidth = 2;
        ctx.strokeRect(ox - 14, oy - 42, 28, 48);
      }

      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.beginPath();
      ctx.ellipse(ox, oy + 10, 14, 6, 0, 0, Math.PI * 2);
      ctx.fill();

      // Corpo
      ctx.fillStyle = e.color || '#ccc';
      if (e.kind === 'npc') {
        ctx.beginPath();
        ctx.moveTo(ox, oy - 30);
        ctx.lineTo(ox + 11, oy);
        ctx.lineTo(ox - 11, oy);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = '#1a120c';
        ctx.beginPath();
        ctx.arc(ox, oy - 34, 7, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillRect(ox - 10, oy - 28, 20, 28);
        ctx.fillStyle = '#1a120c';
        ctx.fillRect(ox - 7, oy - 38, 14, 12);
      }

      if (e.hpMax) {
        const pct = Math.max(0, e.hp / e.hpMax);
        ctx.fillStyle = '#200';
        ctx.fillRect(ox - 12, oy - 44, 24, 4);
        ctx.fillStyle = e.kind === 'enemy' ? '#b33a2a' : '#3a9a4a';
        ctx.fillRect(ox - 12, oy - 44, 24 * pct, 4);
      } else if (e.kind === 'npc') {
        ctx.fillStyle = 'rgba(126,196,232,0.85)';
        ctx.font = 'bold 8px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('NPC', ox, oy - 44);
      }

      ctx.fillStyle = e.kind === 'npc' ? '#9ed4f0' : '#f2e6d4';
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(e.name || '', ox, oy + 22);
      ctx.globalAlpha = 1;
    }
  }

  window.OtRenderer = OtRenderer;
})();
