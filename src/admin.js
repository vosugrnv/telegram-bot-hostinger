const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { createStore } = require('./store');
const botsConfig = require('./bots-config');

const COOKIE_NAME = 'admin_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const BODY_LIMIT = 5 * 1024 * 1024;

const storeCache = new Map();

function adminPassword() {
  return process.env.ADMIN_PASSWORD || '';
}

function sessionSecret() {
  return `${adminPassword()}::${process.env.BOT_TOKEN || 'multi-bot-admin'}`;
}

function hmac(value) {
  return crypto.createHmac('sha256', sessionSecret()).update(value).digest('hex');
}

function makeSessionToken() {
  const payload = `${Date.now()}.${crypto.randomBytes(8).toString('hex')}`;
  return `${payload}.${hmac(payload)}`;
}

function verifySessionToken(token) {
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length < 3) return false;

  const sig = parts.pop();
  const payload = parts.join('.');
  const expected = hmac(payload);
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;

  const ts = Number(payload.split('.')[0]);
  if (!ts || Date.now() - ts > SESSION_TTL_MS) return false;
  return true;
}

function parseCookies(req) {
  const raw = req.headers.cookie || '';
  const out = {};
  raw.split(';').forEach((c) => {
    const [k, ...rest] = c.trim().split('=');
    if (!k) return;
    out[k] = decodeURIComponent(rest.join('='));
  });
  return out;
}

function isAuthenticated(req) {
  if (!adminPassword()) return false;
  const cookies = parseCookies(req);
  return verifySessionToken(cookies[COOKIE_NAME]);
}

function sendJson(res, status, data, extraHeaders = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

function sendHtml(res, status, html) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > BODY_LIMIT) {
        reject(new Error('Payload quá l?n'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseJson(buffer) {
  try {
    return JSON.parse(buffer.toString('utf8') || '{}');
  } catch {
    return null;
  }
}

function basePath(pathname) {
  return pathname.replace(/\/+$/, '') || '/';
}

function sanitizeProduct(input) {
  const id = String(input.id || '').trim();
  if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) {
    return { error: 'ID ch? g?m ch?, s?, _ ho?c -' };
  }
  const name = String(input.name || '').trim();
  if (!name) return { error: 'Thi?u tên s?n ph?m' };
  const price = Number(input.price || 0);
  if (!Number.isFinite(price) || price <= 0) return { error: 'Giá không h?p l?' };

  return {
    product: {
      id,
      name,
      price: Math.round(price),
      emoji: String(input.emoji || '?').trim() || '?',
      description: String(input.description || '').trim(),
      features: String(input.features || '').trim(),
      image: String(input.image || '').trim(),
    },
  };
}

function getStoreForBot(botId) {
  const bot = botsConfig.getBot(botId);
  if (!bot) return { error: 'Bot không t?n t?i', status: 404 };

  if (!storeCache.has(bot.dataDir)) {
    storeCache.set(bot.dataDir, createStore(bot.dataDir));
  }

  return { bot, store: storeCache.get(bot.dataDir) };
}

function resolveBotId(u) {
  const fromQuery = (u.searchParams.get('bot') || '').trim();
  if (fromQuery) return fromQuery;
  if (botsConfig.getBots().length === 1) return botsConfig.defaultBotId();
  return '';
}

function renderAdminPage() {
  const htmlPath = path.join(__dirname, 'admin-page.html');
  return fs.readFileSync(htmlPath, 'utf8');
}

async function handleAsync(req, res) {
  const u = new URL(req.url, 'http://localhost');
  const pathname = basePath(u.pathname);

  if (pathname === '/admin' && req.method === 'GET') {
    sendHtml(res, 200, renderAdminPage());
    return;
  }

  if (pathname === '/admin/login' && req.method === 'POST') {
    if (!adminPassword()) {
      sendJson(res, 400, { error: 'ADMIN_PASSWORD ch?a c?u hình' });
      return;
    }
    const body = parseJson(await readBody(req));
    if (!body || body.password !== adminPassword()) {
      sendJson(res, 401, { error: 'M?t kh?u không ?úng' });
      return;
    }
    const token = makeSessionToken();
    sendJson(res, 200, { ok: true }, {
      'Set-Cookie': `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}; SameSite=Lax`,
    });
    return;
  }

  if (pathname === '/admin/logout' && req.method === 'POST') {
    sendJson(res, 200, { ok: true }, {
      'Set-Cookie': `${COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`,
    });
    return;
  }

  if (pathname === '/admin/api/session' && req.method === 'GET') {
    const bots = botsConfig.getBots().map((b) => ({ id: b.id, name: b.name }));
    sendJson(res, 200, {
      configured: Boolean(adminPassword()),
      authenticated: isAuthenticated(req),
      multiBot: bots.length > 1,
      bots,
      defaultBot: botsConfig.defaultBotId(),
    });
    return;
  }

  if (!isAuthenticated(req)) {
    sendJson(res, 401, { error: 'Ch?a ??ng nh?p' });
    return;
  }

  if (pathname === '/admin/api/bots' && req.method === 'GET') {
    sendJson(res, 200, {
      bots: botsConfig.getBots().map((b) => ({ id: b.id, name: b.name })),
      defaultBot: botsConfig.defaultBotId(),
    });
    return;
  }

  const botId = resolveBotId(u);
  if (!botId) {
    sendJson(res, 400, { error: 'Thi?u tham s? bot. Ch?n bot trên giao di?n admin.' });
    return;
  }

  const resolved = getStoreForBot(botId);
  if (resolved.error) {
    sendJson(res, resolved.status || 400, { error: resolved.error });
    return;
  }

  const store = resolved.store;

  if (pathname === '/admin/api/products' && req.method === 'GET') {
    const products = store.getProducts().map((p) => ({
      ...p,
      stock: store.physicalStock(p.id),
      availableStock: store.availableStock(p.id),
      imagePath: store.productImage(p.id),
    }));
    sendJson(res, 200, { botId, products });
    return;
  }

  if (pathname === '/admin/api/products' && req.method === 'POST') {
    const body = parseJson(await readBody(req));
    const parsed = sanitizeProduct(body || {});
    if (parsed.error) {
      sendJson(res, 400, { error: parsed.error });
      return;
    }

    const added = store.addProduct(parsed.product);
    if (!added) {
      sendJson(res, 409, { error: 'ID ?ã t?n t?i' });
      return;
    }

    sendJson(res, 200, { botId, product: added });
    return;
  }

  const productMatch = pathname.match(/^\/admin\/api\/products\/([^/]+)$/);
  if (productMatch && req.method === 'PUT') {
    const id = decodeURIComponent(productMatch[1]);
    const body = parseJson(await readBody(req));
    if (!body) {
      sendJson(res, 400, { error: 'JSON không h?p l?' });
      return;
    }

    const patch = {
      name: String(body.name || '').trim(),
      price: Number(body.price),
      emoji: String(body.emoji || '?').trim() || '?',
      description: String(body.description || '').trim(),
      features: String(body.features || '').trim(),
      image: String(body.image || '').trim(),
    };
    if (!patch.name || !Number.isFinite(patch.price) || patch.price <= 0) {
      sendJson(res, 400, { error: 'Tên/giá không h?p l?' });
      return;
    }

    const updated = store.updateProduct(id, patch);
    if (!updated) {
      sendJson(res, 404, { error: 'Không tìm th?y s?n ph?m' });
      return;
    }

    sendJson(res, 200, { botId, product: updated });
    return;
  }

  if (productMatch && req.method === 'DELETE') {
    const id = decodeURIComponent(productMatch[1]);
    const ok = store.deleteProduct(id);
    if (!ok) {
      sendJson(res, 404, { error: 'Không tìm th?y s?n ph?m' });
      return;
    }
    sendJson(res, 200, { botId, ok: true });
    return;
  }

  const stockMatch = pathname.match(/^\/admin\/api\/stock\/([^/]+)$/);
  if (stockMatch && req.method === 'GET') {
    const id = decodeURIComponent(stockMatch[1]);
    const lines = store.readAccountLines(id);
    sendJson(res, 200, { botId, id, count: lines.length, lines });
    return;
  }

  if (stockMatch && req.method === 'POST') {
    const id = decodeURIComponent(stockMatch[1]);
    const body = parseJson(await readBody(req));
    if (!body || typeof body.lines !== 'string') {
      sendJson(res, 400, { error: 'Thi?u lines' });
      return;
    }

    const lines = body.lines
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);

    if (body.mode === 'replace') {
      store.writeAccountLines(id, lines);
    } else {
      store.appendAccountLines(id, lines);
    }

    const count = store.readAccountLines(id).length;
    sendJson(res, 200, { botId, ok: true, count });
    return;
  }

  const imageMatch = pathname.match(/^\/admin\/api\/image\/([^/]+)$/);
  if (imageMatch && req.method === 'POST') {
    const id = decodeURIComponent(imageMatch[1]);
    const body = parseJson(await readBody(req));
    if (!body || !body.ext || !body.dataBase64) {
      sendJson(res, 400, { error: 'Thi?u ext ho?c dataBase64' });
      return;
    }

    const buffer = Buffer.from(body.dataBase64, 'base64');
    const saved = store.saveProductImage(id, body.ext, buffer);
    if (!saved) {
      sendJson(res, 400, { error: '??nh d?ng ?nh không h? tr?' });
      return;
    }

    sendJson(res, 200, { botId, ok: true, path: saved });
    return;
  }

  if (pathname === '/admin/api/orders' && req.method === 'GET') {
    const status = u.searchParams.get('status') || '';
    const users = store.getUsers();
    const orders = store
      .getOrders()
      .filter((o) => (status ? o.status === status : true))
      .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))
      .map((o) => {
        const user = users[String(o.userId)] || {};
        return {
          ...o,
          customerName: user.firstName || '',
          username: user.username || '',
        };
      });

    sendJson(res, 200, { botId, orders });
    return;
  }

  sendJson(res, 404, { error: 'Admin route not found' });
}

function handle(req, res) {
  const u = new URL(req.url, 'http://localhost');
  const pathname = basePath(u.pathname);
  if (!pathname.startsWith('/admin')) return false;

  handleAsync(req, res).catch((err) => {
    console.error('[ADMIN]', err.message || err);
    if (!res.headersSent) sendJson(res, 500, { error: 'L?i server admin' });
  });
  return true;
}

module.exports = { handle };
