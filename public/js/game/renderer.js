(() => {
  const TILE = 48;
  const COLORS = {
    floor: '#3a2a1c',
    floorAlt: '#332418',
    wall: '#1a120c',
    table: '#5a3a22',
    bar: '#6a4428',
    door: '#8a5a30',
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
      this.originY = 60;
      this.floats = [];
      this.pulses = [];
      this.lunge = null;
      this.focusId = null;
      this.shakeUntil = 0;
      this.raf = null;
      this._tick = this._tick.bind(this);
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
      this.draw(performance.now());
    }

    setFocus(entityId) {
      this.focusId = entityId || null;
    }

    screenPos(x, y) {
      const { px, py } = iso(x, y);
      return { ox: this.originX + px, oy: this.originY + py + 8 };
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

        if (fx.type === 'attack') {
          const attacker = (this.world.entities || []).find((e) => e.id === fx.attackerId);
          const target = (this.world.entities || []).find((e) => e.id === fx.targetId);
          if (attacker && target) {
            this.lunge = {
              id: attacker.id,
              fromX: attacker.x,
              fromY: attacker.y,
              toX: target.x,
              toY: target.y,
              until: now + 320,
              t0: now,
            };
          }
          if (target && fx.damage) {
            const pos = this.screenPos(target.x, target.y);
            this.floats.push({
              text: `-${fx.damage}`,
              color: '#e07060',
              x: pos.ox,
              y: pos.oy - 40,
              until: now + 900,
              t0: now,
            });
            this.pulses.push({ id: target.id, color: '#b33a2a', until: now + 400, t0: now });
          }
          if (fx.outcome === 'miss' || fx.outcome === 'fumble') {
            if (target) {
              const pos = this.screenPos(target.x, target.y);
              this.floats.push({
                text: 'ERROU',
                color: '#b8a48c',
                x: pos.ox,
                y: pos.oy - 36,
                until: now + 700,
                t0: now,
              });
            }
          }
          this.shakeUntil = now + 180;
          this.canvas.classList.remove('fx-hit');
          void this.canvas.offsetWidth;
          this.canvas.classList.add('fx-hit');
        }

        if (fx.type === 'cast') {
          const target = (this.world.entities || []).find((e) => e.id === fx.targetId);
          const caster = (this.world.entities || []).find((e) => e.id === fx.casterId);
          if (caster) this.pulses.push({ id: caster.id, color: '#5a6ac8', until: now + 500, t0: now });
          if (target && fx.healed) {
            const pos = this.screenPos(target.x, target.y);
            this.floats.push({
              text: `+${fx.healed}`,
              color: '#5dca7a',
              x: pos.ox,
              y: pos.oy - 40,
              until: now + 900,
              t0: now,
            });
            this.pulses.push({ id: target.id, color: '#3a9a4a', until: now + 450, t0: now });
          }
          if (target && fx.damage) {
            const pos = this.screenPos(target.x, target.y);
            this.floats.push({
              text: `-${fx.damage}`,
              color: '#8aa4e8',
              x: pos.ox,
              y: pos.oy - 40,
              until: now + 900,
              t0: now,
            });
            this.pulses.push({ id: target.id, color: '#5a6ac8', until: now + 450, t0: now });
          }
        }

        if (fx.type === 'death' && fx.id) {
          const ent = (this.world.entities || []).find((e) => e.id === fx.id);
          if (ent) {
            const pos = this.screenPos(ent.x, ent.y);
            this.floats.push({
              text: 'CAIU',
              color: '#d4a84a',
              x: pos.ox,
              y: pos.oy - 48,
              until: now + 1200,
              t0: now,
            });
            ent._dying = { t0: now, until: now + 600 };
          }
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
      if (type === 'wall') fill = COLORS.wall;
      if (type === 'table') fill = COLORS.table;
      if (type === 'bar') fill = COLORS.bar;
      if (type === 'door') fill = COLORS.door;

      ctx.fillStyle = fill;
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.stroke();

      if (type === 'wall') {
        ctx.fillStyle = '#24180f';
        ctx.fillRect(ox - hw + 8, oy - 18, hw * 2 - 16, 22);
      }
    }

    drawEntity(e, now) {
      const { ctx } = this;
      const pos = this.entityDrawPos(e, now);
      const { px, py } = iso(pos.x, pos.y);
      const ox = this.originX + px;
      const oy = this.originY + py + 8;

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

      if (this.focusId === e.id) {
        ctx.strokeStyle = '#d4a84a';
        ctx.lineWidth = 2;
        ctx.strokeRect(ox - 14, oy - 42, 28, 48);
      }

      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.beginPath();
      ctx.ellipse(ox, oy + 10, 14, 6, 0, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = e.color || '#ccc';
      ctx.fillRect(ox - 10, oy - 28, 20, 28);
      ctx.fillStyle = '#1a120c';
      ctx.fillRect(ox - 7, oy - 38, 14, 12);

      if (e.hpMax) {
        const pct = Math.max(0, e.hp / e.hpMax);
        ctx.fillStyle = '#200';
        ctx.fillRect(ox - 12, oy - 44, 24, 4);
        ctx.fillStyle = e.kind === 'enemy' ? '#b33a2a' : '#3a9a4a';
        ctx.fillRect(ox - 12, oy - 44, 24 * pct, 4);
      }

      ctx.fillStyle = '#f2e6d4';
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(e.name || '', ox, oy + 22);
      ctx.globalAlpha = 1;
    }
  }

  window.OtRenderer = OtRenderer;
})();
