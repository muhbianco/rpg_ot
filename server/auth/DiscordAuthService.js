const config = require('../config');

const DEFAULT_TIMEOUT = 8000;

async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

class DiscordAuthService {
  constructor() {
    this.cfg = config.discord;
    this.enabled = Boolean(this.cfg.clientId && this.cfg.clientSecret && this.cfg.serverId);
  }

  isConfigured() {
    return this.enabled;
  }

  buildAuthUrl(state) {
    const params = new URLSearchParams({
      client_id: this.cfg.clientId,
      redirect_uri: this.cfg.redirectUri,
      response_type: 'code',
      scope: this.cfg.scope,
      state,
    });
    return `https://discord.com/oauth2/authorize?${params.toString()}`;
  }

  async exchangeCode(code) {
    const body = new URLSearchParams({
      client_id: this.cfg.clientId,
      client_secret: this.cfg.clientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.cfg.redirectUri,
    });
    const res = await fetchWithTimeout(`${this.cfg.apiBase}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Discord token falhou (${res.status}): ${detail.slice(0, 200)}`);
    }
    return res.json();
  }

  async fetchUser(accessToken) {
    const res = await fetchWithTimeout(`${this.cfg.apiBase}/users/@me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) throw new Error(`Discord /users/@me falhou (${res.status}).`);
    return res.json();
  }

  async listGuilds(accessToken) {
    const res = await fetchWithTimeout(`${this.cfg.apiBase}/users/@me/guilds`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) throw new Error(`Discord /users/@me/guilds falhou (${res.status}).`);
    const guilds = await res.json();
    return Array.isArray(guilds) ? guilds : [];
  }

  async isGuildMember(accessToken) {
    const guilds = await this.listGuilds(accessToken);
    return guilds.some((g) => String(g.id) === String(this.cfg.serverId));
  }

  avatarUrl(discordId, avatarHash) {
    if (!avatarHash) return null;
    const ext = String(avatarHash).startsWith('a_') ? 'gif' : 'png';
    return `https://cdn.discordapp.com/avatars/${discordId}/${avatarHash}.${ext}?size=64`;
  }
}

module.exports = DiscordAuthService;
