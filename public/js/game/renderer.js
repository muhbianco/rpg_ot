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

  class OtRenderer {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.world = null;
      this.originX = canvas.width / 2;
      this.originY = 60;
    }

    setWorld(world) {
      this.world = world;
      this.draw();
    }

    playEffects(effects) {
      if (!Array.isArray(effects) || !effects.length) return;
      // Aplicação imediata do estado; animações detalhadas entram na evolução do renderer.
      for (const fx of effects) {
        if (fx.type === 'move' && fx.id != null) {
          const ent = (this.world?.entities || []).find((e) => e.id === fx.id);
          if (ent && fx.x != null) {
            ent.x = fx.x;
            ent.y = fx.y;
          }
        }
      }
      this.draw();
      this.flashCombat(effects);
    }

    flashCombat(effects) {
      const hasHit = effects.some((e) => e.type === 'attack' || e.type === 'cast' || e.type === 'death');
      if (!hasHit || !this.canvas) return;
      this.canvas.classList.remove('fx-hit');
      void this.canvas.offsetWidth;
      this.canvas.classList.add('fx-hit');
    }

    draw() {
      const { ctx, canvas, world } = this;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (!world) return;

      const tiles = world.tiles || [];
      for (const t of tiles) {
        this.drawTile(t.x, t.y, t.type);
      }

      const entities = [...(world.entities || [])].sort((a, b) => (a.x + a.y) - (b.x + b.y));
      for (const e of entities) {
        this.drawEntity(e);
      }
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

    drawEntity(e) {
      const { ctx } = this;
      const { px, py } = iso(e.x, e.y);
      const ox = this.originX + px;
      const oy = this.originY + py + 8;

      // shadow
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.beginPath();
      ctx.ellipse(ox, oy + 10, 14, 6, 0, 0, Math.PI * 2);
      ctx.fill();

      // body
      ctx.fillStyle = e.color || '#ccc';
      ctx.fillRect(ox - 10, oy - 28, 20, 28);
      ctx.fillStyle = '#1a120c';
      ctx.fillRect(ox - 7, oy - 38, 14, 12);

      // hp pip
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
    }
  }

  window.OtRenderer = OtRenderer;
})();
