require('dotenv').config();

const http = require('http');
const crypto = require('crypto');
const { Telegraf } = require('telegraf');
const { registerShop, startPaymentWatcher, fulfillByOrderCode } = require('./src/shop');
const store = require('./src/store');
const payos = require('./src/payos');
const admin = require('./src/admin');

const PAYOS_WEBHOOK_PATH = '/payos-webhook';

const token = process.env.BOT_TOKEN;
const botName = process.env.BOT_NAME || 'Shop Bot';

if (!token) {
  console.error('[ERROR] Thiếu BOT_TOKEN. Tạo file .env từ .env.example');
  process.exit(1);
}

// URL công khai của app trên Hostinger (đổi nếu dùng domain khác)
const PUBLIC_URL = (
  process.env.PUBLIC_URL || 'https://antiquewhite-ram-556370.hostingersite.com'
).replace(/\/$/, '');

// Mặc định dùng webhook (phù hợp Hostinger/Passenger).
// Đặt USE_POLLING=true khi chạy local để dùng long-polling.
const USE_POLLING = process.env.USE_POLLING === 'true';

const PORT = process.env.PORT || 3000;

// webhookReply: false -> mọi tin nhắn gọi API trực tiếp (ổn định trên Hostinger/Passenger,
// tránh trường hợp bot nhận update nhưng không trả lời được).
const bot = new Telegraf(token, { telegram: { webhookReply: false } });
registerShop(bot);

let watcherStarted = false;
function ensureWatcher() {
  if (!watcherStarted) {
    watcherStarted = true;
    startPaymentWatcher(bot);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logStartupInfo(mode) {
  console.log(`[OK] ${botName} đã khởi động (${mode})`);
  console.log(`[INFO] Số sản phẩm tải được: ${store.getProducts().length}`);
  console.log(`[INFO] PayOS đã cấu hình: ${payos.isConfigured()}`);
}

// ---------------- Webhook mode (Hostinger) ----------------

async function startWebhook() {
  const secretPath =
    '/tg/' + crypto.createHash('sha256').update(token).digest('hex').slice(0, 32);
  const webhookCb = bot.webhookCallback(secretPath);

  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === secretPath) {
      return webhookCb(req, res);
    }
    if (req.method === 'POST' && req.url === PAYOS_WEBHOOK_PATH) {
      return handlePayosWebhook(req, res);
    }
    if (req.url === '/' || req.url === '/health') {
      const products = store.getProducts();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        ok: true,
        bot: botName,
        mode: 'webhook',
        dataDir: store.dataDir,
        productCount: products.length,
        payosConfigured: payos.isConfigured(),
      }));
      return;
    }
    if (admin.handle(req, res)) return;
    res.writeHead(404);
    res.end('Not found');
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[OK] HTTP/webhook server: port ${PORT}`);
  });

  const webhookUrl = `${PUBLIC_URL}${secretPath}`;
  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await bot.telegram.setWebhook(webhookUrl, { drop_pending_updates: true });
      const info = await bot.telegram.getWebhookInfo();
      console.log(`[OK] Đã đặt Telegram webhook (pending: ${info.pending_update_count})`);
      break;
    } catch (err) {
      const isConflict = err.response?.error_code === 409;
      if (isConflict && attempt < maxRetries) {
        console.warn(`[WARN] Telegram webhook conflict. Thử lại ${attempt}/${maxRetries} sau 5 giây...`);
        await sleep(5000);
        continue;
      }
      throw err;
    }
  }
  logStartupInfo('webhook');
  ensureWatcher();
  await registerPayosWebhook();
}

// Đăng ký webhook PayOS (PayOS sẽ tự giao hàng khi nhận thanh toán)
async function registerPayosWebhook() {
  if (!payos.isConfigured()) {
    console.log('[INFO] PayOS chưa cấu hình -> bỏ qua đăng ký webhook PayOS.');
    return;
  }
  try {
    await payos.confirmWebhook(`${PUBLIC_URL}${PAYOS_WEBHOOK_PATH}`);
    console.log(`[OK] Đã đăng ký webhook PayOS: ${PUBLIC_URL}${PAYOS_WEBHOOK_PATH}`);
  } catch (err) {
    console.warn(`[WARN] Không đăng ký được webhook PayOS: ${err.message}`);
  }
}

// Xử lý webhook thanh toán từ PayOS
function handlePayosWebhook(req, res) {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > 1e6) req.destroy(); // chặn payload quá lớn
  });
  req.on('end', async () => {
    // Luôn trả 200 để PayOS xác nhận đã nhận (tránh retry vô hạn)
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));

    if (!body) return; // request test khi đăng ký webhook
    try {
      const parsed = JSON.parse(body);
      const data = await payos.verifyWebhook(parsed); // throw nếu sai chữ ký
      if (data && data.code === '00') {
        await fulfillByOrderCode(bot.telegram, data.orderCode, data.amount);
      }
    } catch (err) {
      console.warn('[PAYOS-WH] Bỏ qua webhook không hợp lệ:', err.message);
    }
  });
}

// ---------------- Polling mode (local dev) ----------------

function startHealthServer() {
  const server = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/health') {
      const products = store.getProducts();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        ok: true,
        bot: botName,
        mode: 'polling',
        dataDir: store.dataDir,
        productCount: products.length,
        payosConfigured: payos.isConfigured(),
      }));
      return;
    }
    if (admin.handle(req, res)) return;
    res.writeHead(404);
    res.end('Not found');
  });
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[OK] Health server: port ${PORT}`);
  });
}

// Tự gọi vào URL công khai để Passenger không cho app "ngủ" (giữ polling sống)
function startKeepAlive() {
  const interval = Number(process.env.KEEPALIVE_MS) || 2 * 60 * 1000; // mặc định 2 phút
  if (!PUBLIC_URL || /localhost|127\.0\.0\.1/.test(PUBLIC_URL)) {
    console.log('[INFO] Bỏ qua keep-alive (PUBLIC_URL là local).');
    return;
  }
  setInterval(async () => {
    try {
      await fetch(`${PUBLIC_URL}/health`, { method: 'GET' });
    } catch (e) {
      console.warn('[KEEPALIVE] ping lỗi:', e.message);
    }
  }, interval);
  console.log(`[OK] Keep-alive bật: tự ping ${PUBLIC_URL}/health mỗi ${interval / 1000}s`);
}

async function startPolling() {
  startHealthServer();
  await bot.telegram.deleteWebhook({ drop_pending_updates: true });
  await sleep(1000);

  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await bot.launch({ dropPendingUpdates: true }, () => {
        logStartupInfo('polling');
        ensureWatcher();
        startKeepAlive();
      });
      return;
    } catch (err) {
      const isConflict = err.response?.error_code === 409;
      if (isConflict && attempt < maxRetries) {
        console.warn(
          `[WARN] Có instance khác đang dùng token này. Thử lại ${attempt}/${maxRetries} sau 5 giây...`
        );
        await sleep(5000);
        continue;
      }
      throw err;
    }
  }
}

async function start() {
  if (USE_POLLING) {
    await startPolling();
  } else {
    await startWebhook();
  }
}

start().catch((err) => {
  console.error('[FATAL]', err.message || err);
  process.exit(1);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
