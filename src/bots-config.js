const fs = require('fs');
const path = require('path');
const { resolveDataDir } = require('./store');

function normalizeBot(entry) {
  const id = String(entry.id || '').trim();
  const name = String(entry.name || entry.id || '').trim();
  const dataDir = path.resolve(String(entry.dataDir || '').trim());
  if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) return null;
  if (!dataDir) return null;
  return { id, name: name || id, dataDir };
}

function singleBotFallback() {
  const dataDir = resolveDataDir();
  const id = String(process.env.BOT_ID || 'default').trim() || 'default';
  const name = String(process.env.BOT_NAME || id).trim() || id;
  return [{ id, name, dataDir }];
}

function parseBotsConfig() {
  const raw = (process.env.BOTS_CONFIG || '').trim();
  if (!raw) return singleBotFallback();

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.length) {
      console.error('[WARN] BOTS_CONFIG phải là mảng JSON không rỗng');
      return singleBotFallback();
    }

    const bots = parsed.map(normalizeBot).filter(Boolean);
    if (!bots.length) {
      console.error('[WARN] BOTS_CONFIG không có bot hợp lệ');
      return singleBotFallback();
    }

    const ids = new Set();
    for (const bot of bots) {
      if (ids.has(bot.id)) {
        console.error(`[WARN] BOTS_CONFIG trùng id: ${bot.id}`);
        return singleBotFallback();
      }
      ids.add(bot.id);
      if (!fs.existsSync(bot.dataDir)) {
        console.warn(`[WARN] DATA_DIR của bot "${bot.id}" chưa tồn tại: ${bot.dataDir}`);
      }
    }

    return bots;
  } catch (err) {
    console.error('[WARN] Không parse được BOTS_CONFIG:', err.message);
    return singleBotFallback();
  }
}

let cachedBots = null;

function getBots() {
  if (!cachedBots) cachedBots = parseBotsConfig();
  return cachedBots;
}

function getBot(botId) {
  if (!botId) return null;
  return getBots().find((b) => b.id === botId) || null;
}

function isMultiBot() {
  return Boolean((process.env.BOTS_CONFIG || '').trim()) && getBots().length > 0;
}

function defaultBotId() {
  return getBots()[0]?.id || 'default';
}

module.exports = {
  getBots,
  getBot,
  isMultiBot,
  defaultBotId,
};
