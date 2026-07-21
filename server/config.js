require('dotenv').config();

const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'production',
  corsOrigin: process.env.CORS_ORIGIN || 'https://rpgot.muhbianco.com.br',
  db: {
    host: process.env.DB_HOST || 'host.docker.internal',
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'rpg_ot',
    connectionLimit: 8,
  },
  gemini: {
    apiKey: process.env.GEMINI_API_KEY || '',
    model: process.env.GEMINI_MODEL || 'gemini-2.5-pro',
  },
  limits: {
    nicknameMin: 2,
    nicknameMax: 20,
    actionMax: 400,
    partyMin: 1,
    partyMax: 10,
    maxConnectionsPerIp: 8,
    actionsPerMinute: 20,
    payloadMaxBytes: 8192,
  },
};

module.exports = config;
