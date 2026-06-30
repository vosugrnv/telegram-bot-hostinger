const fs = require('fs');
const { Markup } = require('telegraf');
const store = require('./store');
const payos = require('./payos');
const { money, moneyShort, bankName, escapeHtml, randomTransferContent } = require('./utils');
const kb = require('./keyboards');

const ORDER_TTL_MS = 15 * 60 * 1000; // 15 phút
const WATCH_INTERVAL_MS = 10 * 1000; // check mỗi 10 giây
const ORDER_EPOCH = 1700000000; // mốc để rút gọn mã đơn (giây)

// Trạng thái hội thoại lưu vào file (bền vững qua respawn process trên Hostinger)
const userStates = {
  set: (userId, state) => store.setState(userId, state),
  get: (userId) => store.getState(userId),
  delete: (userId) => store.clearState(userId),
};

const botName = () => process.env.BOT_NAME || 'Shop Bot';
const supportContact = () => process.env.SUPPORT_CONTACT || 'admin';

// Danh sách admin (ADMIN_ID hoặc ADMIN_IDS, cách nhau bởi dấu phẩy)
function adminIds() {
  const raw = process.env.ADMIN_IDS || process.env.ADMIN_ID || '';
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function isAdmin(userId) {
  return adminIds().includes(String(userId));
}

// Mã đơn ngắn (~8 chữ số) cho PayOS (orderCode bắt buộc là SỐ)
function generateOrderCode() {
  let code = Math.floor(Date.now() / 1000) - ORDER_EPOCH;
  while (store.getOrder(code)) code += 1;
  return code;
}

// Mã tham chiếu 10 ký tự (chữ in hoa + số) cho nội dung CK & hiển thị
function generateRefCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let ref;
  do {
    ref = '';
    for (let i = 0; i < 10; i++) ref += chars[Math.floor(Math.random() * chars.length)];
  } while (store.getOrders().some((o) => o.refCode === ref));
  return ref;
}

// Mã đơn hiển thị: refCode 10 ký tự (chữ in hoa + số). Nhận order object hoặc orderCode (số).
function displayCode(orderOrCode) {
  const order =
    orderOrCode && typeof orderOrCode === 'object'
      ? orderOrCode
      : store.getOrder(Number(orderOrCode));
  if (order && order.refCode) return order.refCode;
  return String(orderOrCode);
}

// ---------------- Welcome + Menu ----------------

function welcomeText(ctx) {
  const who = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name || 'bạn';
  return (
    `👋 Xin chào <b>${escapeHtml(who)}</b> đã đến với <b>${escapeHtml(botName())}</b>!\n\n` +
    `📌 <b>Hướng dẫn nhanh:</b>\n` +
    `1. Nhấn nút "🛍️ Mua hàng"\n` +
    `2. Chọn sản phẩm bạn muốn mua\n` +
    `3. Chuyển khoản theo thông tin bot gửi\n` +
    `4. Sau khi thanh toán xong, bot sẽ tự xử lý đơn hàng\n\n` +
    `📌 Vui lòng chọn menu bên dưới:`
  );
}

// Gửi lời chào: xóa bàn phím cũ (reply keyboard) rồi gắn menu INLINE vào chính tin nhắn
async function sendWelcome(ctx) {
  const msg = await ctx.replyWithHTML(welcomeText(ctx), Markup.removeKeyboard());
  try {
    await ctx.telegram.editMessageReplyMarkup(
      msg.chat.id,
      msg.message_id,
      undefined,
      kb.mainMenu().reply_markup
    );
  } catch (e) {
    // Fallback: gửi menu inline ở tin nhắn riêng
    await ctx.reply('📋 Menu chính:', kb.mainMenu());
  }
}

// ---------------- Đăng ký handler ----------------

function registerShop(bot) {
  // Ghi nhận mọi người dùng tương tác với bot (để broadcast sau này)
  bot.use((ctx, next) => {
    if (ctx.from && !ctx.from.is_bot) {
      const u = store.getUser(ctx.from.id);
      if (u.firstName !== ctx.from.first_name || u.username !== (ctx.from.username || '')) {
        store.updateUser(ctx.from.id, {
          firstName: ctx.from.first_name || '',
          username: ctx.from.username || '',
        });
      }
    }
    return next();
  });

  // ---- Lấy ID Telegram của chính bạn (để điền ADMIN_ID) ----
  bot.command('myid', async (ctx) => {
    await ctx.replyWithHTML(
      `🆔 ID của bạn: <code>${ctx.from.id}</code>\n` +
        `Thêm ID này vào biến môi trường <b>ADMIN_ID</b> để dùng lệnh quản trị.`
    );
  });

  // ---- Admin: gửi thông báo cho tất cả khách ----
  bot.command('thongbao', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return; // im lặng với người thường
    const reply = ctx.message.reply_to_message;
    if (reply) {
      // Phát lại tin được trả lời (giữ nguyên ảnh/định dạng)
      return runBroadcast(ctx, ctx.chat.id, reply.message_id);
    }
    userStates.set(ctx.from.id, { action: 'awaiting_broadcast' });
    await ctx.replyWithHTML(
      '📢 <b>Soạn thông báo</b>\n\n' +
        'Gửi nội dung bạn muốn thông báo (chữ, ảnh, hoặc ảnh kèm chú thích).\n' +
        'Tôi sẽ gửi tới <b>tất cả khách đã dùng bot</b>.\n\n' +
        'Gõ /huy để hủy.'
    );
  });

  bot.command('huy', async (ctx) => {
    if (userStates.get(ctx.from.id)) {
      userStates.delete(ctx.from.id);
      return ctx.reply('Đã hủy thao tác.');
    }
  });

  // ---- Admin: thống kê nhanh ----
  bot.command('stats', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const userCount = store.getAllUserIds().length;
    const paid = store.getOrders().filter((o) => o.status === 'paid').length;
    await ctx.replyWithHTML(
      `📊 <b>Thống kê</b>\n\n` +
        `👥 Khách đã tương tác: <b>${userCount}</b>\n` +
        `✅ Đơn đã thanh toán: <b>${paid}</b>`
    );
  });

  // ---- Admin: dọn file kho không còn trong products.json ----
  bot.command('dondep', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;

    const validIds = new Set(store.getProducts().map((p) => p.id));
    // An toàn: nếu products.json lỗi/rỗng thì KHÔNG xóa gì cả
    if (validIds.size === 0) {
      return ctx.replyWithHTML(
        '⚠️ <b>Không dọn được.</b>\n' +
          'products.json đang trống hoặc lỗi (0 sản phẩm). ' +
          'Kiểm tra lại file rồi thử lại để tránh xóa nhầm kho.'
      );
    }

    const orphans = store.listAccountIds().filter((id) => !validIds.has(id));
    if (orphans.length === 0) {
      return ctx.replyWithHTML(
        `✅ Kho đã sạch. Tất cả file đều khớp ${validIds.size} sản phẩm.`
      );
    }

    let deleted = 0;
    for (const id of orphans) {
      if (store.deleteAccountFile(id)) deleted += 1;
    }

    const list = orphans.map((id) => `• ${escapeHtml(id)}.txt`).join('\n');
    await ctx.replyWithHTML(
      `🧹 <b>Đã dọn ${deleted} file kho cũ</b> (không còn trong sản phẩm):\n\n` +
        `${list}\n\n` +
        `📦 Còn lại: <b>${store.listAccountIds().length}</b> file kho khớp ` +
        `<b>${validIds.size}</b> sản phẩm.`
    );
  });

  bot.start(async (ctx) => {
    store.updateUser(ctx.from.id, {
      firstName: ctx.from.first_name || '',
      username: ctx.from.username || '',
    });
    userStates.delete(ctx.from.id);
    await sendWelcome(ctx);
  });

  bot.help(async (ctx) => {
    await sendWelcome(ctx);
  });

  // ---- Menu inline ----
  bot.action('menu:home', async (ctx) => {
    await ctx.answerCbQuery();
    await sendWelcome(ctx);
  });

  bot.action('menu:buy', async (ctx) => {
    await ctx.answerCbQuery();
    await showProducts(ctx);
  });

  bot.action('menu:profile', async (ctx) => {
    await ctx.answerCbQuery();
    const user = store.getUser(ctx.from.id);
    const orders = store.getUserOrders(ctx.from.id).filter((o) => o.status === 'paid');
    await ctx.replyWithHTML(
      `👤 <b>Hồ sơ của bạn</b>\n\n` +
        `🆔 ID: <code>${ctx.from.id}</code>\n` +
        `👋 Tên: ${escapeHtml(ctx.from.first_name || '')}\n` +
        `💰 Số dư ví: <b>${money(user.balance || 0)}</b>\n` +
        `🧾 Đơn đã mua: <b>${orders.length}</b>`,
      kb.backHome()
    );
  });

  bot.action('menu:history', async (ctx) => {
    await ctx.answerCbQuery();
    const orders = store
      .getUserOrders(ctx.from.id)
      .filter((o) => o.status === 'paid' && o.type === 'order')
      .sort((a, b) => (b.paidAt || 0) - (a.paidAt || 0))
      .slice(0, 10);

    if (!orders.length) {
      return ctx.reply('🧾 Bạn chưa có đơn hàng nào.', kb.backHome());
    }

    const lines = orders.map((o) => {
      const d = new Date(o.paidAt || o.createdAt).toLocaleString('vi-VN');
      return `• ${displayCode(o.orderCode)} | ${escapeHtml(o.productName)} x${o.quantity} | ${money(o.amount)} | ${d}`;
    });
    await ctx.replyWithHTML(
      `🧾 <b>Lịch sử mua (10 đơn gần nhất):</b>\n\n${lines.join('\n')}`,
      kb.backHome()
    );
  });

  bot.action('menu:wallet', async (ctx) => {
    await ctx.answerCbQuery();
    const user = store.getUser(ctx.from.id);
    await ctx.reply(
      `💰 <b>Ví của bạn</b>\n\nSố dư hiện tại: <b>${money(user.balance || 0)}</b>`,
      { parse_mode: 'HTML', ...kb.walletMenu() }
    );
  });

  bot.action('menu:support', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.replyWithHTML(
      `💬 <b>Hỗ trợ</b>\n\nLiên hệ: ${escapeHtml(supportContact())}\n` +
        `Vui lòng cung cấp mã đơn (OD...) khi cần hỗ trợ.`,
      kb.backHome()
    );
  });

  bot.action('menu:lang', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply('🌐 Ngôn ngữ hiện tại: Tiếng Việt 🇻🇳', kb.backHome());
  });

  // ---- Chọn sản phẩm ----
  bot.action(/^buy:(.+)$/, async (ctx) => {
    const productId = ctx.match[1];
    const product = store.getProduct(productId);
    await ctx.answerCbQuery();
    if (!product) return ctx.reply('❌ Sản phẩm không tồn tại.');

    const stock = store.availableStock(productId);
    if (stock <= 0) {
      return ctx.reply(`😢 Sản phẩm "${product.name}" tạm hết hàng.`);
    }

    userStates.set(ctx.from.id, { action: 'awaiting_quantity', productId });

    await sendProductCard(ctx, product, stock);
  });

  // ---- Nạp tiền vào ví ----
  bot.action('wallet_topup', async (ctx) => {
    await ctx.answerCbQuery();
    if (!payos.isConfigured()) {
      return ctx.reply('⚠️ Tính năng nạp ví chưa được cấu hình PayOS.');
    }
    userStates.set(ctx.from.id, { action: 'awaiting_topup' });
    await ctx.replyWithHTML(
      '💳 Vui lòng <b>nhập số tiền</b> muốn nạp (VND, tối thiểu 1.000):'
    );
  });

  // ---- Admin gửi nội dung broadcast bằng ảnh/video/file ----
  bot.on(['photo', 'video', 'document', 'animation'], async (ctx) => {
    const state = userStates.get(ctx.from.id);
    if (state && state.action === 'awaiting_broadcast' && isAdmin(ctx.from.id)) {
      return runBroadcast(ctx, ctx.chat.id, ctx.message.message_id);
    }
  });

  // ---- Nhập text (broadcast / số lượng / số tiền nạp) ----
  bot.on('text', async (ctx) => {
    const state = userStates.get(ctx.from.id);
    if (!state) return; // không trong luồng nào

    if (state.action === 'awaiting_broadcast' && isAdmin(ctx.from.id)) {
      return runBroadcast(ctx, ctx.chat.id, ctx.message.message_id);
    }

    const value = parseInt(ctx.message.text.replace(/[^\d]/g, ''), 10);

    if (state.action === 'awaiting_quantity') {
      const product = store.getProduct(state.productId);
      if (!product) {
        userStates.delete(ctx.from.id);
        return ctx.reply('❌ Sản phẩm không còn tồn tại.');
      }
      if (!value || value <= 0) {
        return ctx.reply('⚠️ Vui lòng nhập một số nguyên dương (ví dụ: 1, 2, 3...).');
      }
      const stock = store.availableStock(state.productId);
      if (value > stock) {
        return ctx.reply(`⚠️ Chỉ còn ${stock} sản phẩm. Vui lòng nhập số lượng nhỏ hơn.`);
      }

      userStates.delete(ctx.from.id);
      await createConfirmation(ctx, product, value);
      return;
    }

    if (state.action === 'awaiting_topup') {
      if (!value || value < 1000) {
        return ctx.reply('⚠️ Số tiền nạp tối thiểu là 1.000đ. Vui lòng nhập lại.');
      }
      userStates.delete(ctx.from.id);
      await createTopupOrder(ctx, value);
      return;
    }
  });

  // ---- Chọn phương thức thanh toán ----
  bot.action(/^pay_wallet:(\d+)$/, async (ctx) => {
    const orderCode = Number(ctx.match[1]);
    await ctx.answerCbQuery();
    await payWithWallet(ctx, orderCode);
  });

  bot.action(/^pay_payos:(\d+)$/, async (ctx) => {
    const orderCode = Number(ctx.match[1]);
    await ctx.answerCbQuery();
    await payWithPayOS(ctx, orderCode);
  });

  // ---- Kiểm tra thanh toán thủ công ----
  bot.action(/^check:(\d+)$/, async (ctx) => {
    const orderCode = Number(ctx.match[1]);
    await ctx.answerCbQuery('Đang kiểm tra...');
    const order = store.getOrder(orderCode);
    if (!order || order.status !== 'pending') {
      return ctx.reply('Đơn này không còn ở trạng thái chờ thanh toán.');
    }
    try {
      const info = await payos.getStatus(orderCode);
      if (info && info.status === 'PAID') {
        await fulfill(ctx.telegram, order);
      } else {
        await ctx.reply('⏳ Chưa nhận được thanh toán. Vui lòng thử lại sau ít phút.');
      }
    } catch (e) {
      await ctx.reply('⚠️ Không kiểm tra được trạng thái. Vui lòng thử lại sau.');
    }
  });

  // ---- Hủy đơn ----
  bot.action(/^cancel_order:(\d+)$/, async (ctx) => {
    const orderCode = Number(ctx.match[1]);
    await ctx.answerCbQuery('Đã hủy đơn');
    const order = store.getOrder(orderCode);
    if (order && order.status === 'pending') {
      if (order.method === 'payos' && order.paymentLinkId) {
        await payos.cancelPayment(orderCode, 'Khách hủy đơn');
      }
      store.updateOrder(orderCode, { status: 'cancelled' });
    }
    await ctx.reply(`❌ Đã hủy đơn ${displayCode(orderCode)}.`, kb.mainMenu());
  });

  bot.catch((err, ctx) => {
    console.error(`[ERROR] ${ctx?.updateType}:`, err);
  });
}

// ---------------- Hiển thị danh sách sản phẩm ----------------

// Caption thẻ sản phẩm (giống mẫu: giá, tồn kho, đã bán, mô tả blockquote)
function buildProductCardCaption(product, stock, { includePrompt = true } = {}) {
  const emoji = product.emoji || '📦';
  const desc = product.description
    ? escapeHtml(product.description).replace(/\r\n/g, '\n').replace(/\n/g, '\n')
    : '';

  let text =
    `${emoji} <b>${escapeHtml(product.name)}</b>\n\n` +
    `💵 Giá: <b>${moneyShort(product.price)}</b>\n` +
    `➕ Tồn kho: <b>${stock}</b> tài khoản`;

  if (desc) {
    text += `\n\n<blockquote>💎 Mô tả:\n"${desc}"`;
    if (product.features) {
      text += `\n\nTính năng:\n${escapeHtml(product.features)}`;
    }
    text += `</blockquote>`;
  } else if (product.features) {
    text += `\n\n<blockquote>Tính năng:\n${escapeHtml(product.features)}</blockquote>`;
  }

  if (includePrompt) {
    text += `\n\n🔢 Vui lòng <b>nhập số lượng</b> bạn muốn mua (gửi 1 con số):`;
  }

  return text;
}

// Gửi "thẻ sản phẩm": ảnh ở trên + caption ở dưới (giống mẫu).
async function sendProductCard(ctx, product, stock) {
  const fullCaption = buildProductCardCaption(product, stock);
  const headerCaption = buildProductCardCaption(product, stock, { includePrompt: false });

  let photo = null;
  if (product.image && /^https?:\/\//i.test(product.image)) {
    photo = product.image;
  } else {
    const localFile = store.productImage(product.id);
    if (localFile) photo = { source: fs.createReadStream(localFile) };
  }

  if (!photo) {
    return ctx.replyWithHTML(fullCaption);
  }

  const prompt = `\n\n🔢 Vui lòng <b>nhập số lượng</b> bạn muốn mua (gửi 1 con số):`;

  try {
    if (fullCaption.length <= 1024) {
      await ctx.replyWithPhoto(photo, { caption: fullCaption, parse_mode: 'HTML' });
      return;
    }

    // Caption quá dài -> ảnh kèm phần đầu, tin nhắn riêng cho mô tả + nhập số lượng
    await ctx.replyWithPhoto(photo, { caption: headerCaption, parse_mode: 'HTML' });

    const desc = product.description
      ? escapeHtml(product.description).replace(/\r\n/g, '\n')
      : '';
    let detail = '';
    if (desc) {
      detail = `<blockquote>💎 Mô tả:\n"${desc}"`;
      if (product.features) detail += `\n\nTính năng:\n${escapeHtml(product.features)}`;
      detail += `</blockquote>`;
    } else if (product.features) {
      detail = `<blockquote>Tính năng:\n${escapeHtml(product.features)}</blockquote>`;
    }
    await ctx.replyWithHTML(detail + prompt);
  } catch (e) {
    console.error(`[IMG] Không gửi được ảnh cho ${product.id}: ${e.message}`);
    await ctx.replyWithHTML(fullCaption);
  }
}

async function showProducts(ctx) {
  const products = store.getProducts();
  if (!products.length) {
    return ctx.reply(
      '🛒 Hiện chưa có sản phẩm nào. Vui lòng quay lại sau.',
      kb.backHome()
    );
  }
  await ctx.reply('🛍️ <b>Danh sách sản phẩm:</b>\n(Chọn sản phẩm bạn muốn mua)', {
    parse_mode: 'HTML',
    ...kb.productList(products, store.availableStock),
  });
}

// ---------------- Tạo xác nhận đơn ----------------

async function createConfirmation(ctx, product, quantity) {
  const amount = product.price * quantity;
  const orderCode = generateOrderCode();
  const refCode = generateRefCode();
  const balance = store.getBalance(ctx.from.id);

  store.addOrder({
    orderCode,
    refCode,
    type: 'order',
    userId: ctx.from.id,
    chatId: ctx.chat.id,
    productId: product.id,
    productName: product.name,
    price: product.price,
    quantity,
    amount,
    status: 'pending',
    method: null,
    createdAt: Date.now(),
  });

  await ctx.replyWithHTML(
    `🧾 <b>Xác nhận đơn hàng</b>\n\n` +
      `🧾 Mã đơn: <code>${displayCode(orderCode)}</code>\n` +
      `📦 Sản phẩm: <b>${escapeHtml(product.name)}</b>\n` +
      `🔢 Số lượng: <b>${quantity}</b>\n` +
      `💵 Thành tiền: <b>${money(amount)}</b>\n` +
      `💰 Tổng thanh toán: <b>${money(amount)}</b>\n` +
      `👛 Số dư ví hiện tại: <b>${money(balance)}</b>\n\n` +
      `⏳ Đơn có hiệu lực trong 15 phút.\n` +
      `Vui lòng chọn phương thức thanh toán:`,
    kb.paymentMethods(orderCode)
  );
}

// ---------------- Thanh toán bằng ví ----------------

async function payWithWallet(ctx, orderCode) {
  const order = store.getOrder(orderCode);
  if (!order || order.status !== 'pending') {
    return ctx.reply('Đơn này không còn hợp lệ.');
  }
  const balance = store.getBalance(order.userId);
  if (balance < order.amount) {
    return ctx.replyWithHTML(
      `❌ Số dư ví không đủ.\n` +
        `Cần: <b>${money(order.amount)}</b> | Hiện có: <b>${money(balance)}</b>\n\n` +
        `Vui lòng nạp thêm vào ví hoặc chọn "Thanh toán ngay".`
    );
  }

  // Trừ tiền trước, đánh dấu phương thức ví
  store.deductBalance(order.userId, order.amount);
  store.updateOrder(orderCode, { method: 'wallet' });
  await fulfill(ctx.telegram, store.getOrder(orderCode));
}

// ---------------- Thanh toán PayOS ----------------

async function payWithPayOS(ctx, orderCode) {
  const order = store.getOrder(orderCode);
  if (!order || order.status !== 'pending') {
    return ctx.reply('Đơn này không còn hợp lệ.');
  }
  if (!payos.isConfigured()) {
    return ctx.reply(
      '⚠️ PayOS chưa được cấu hình. Vui lòng liên hệ admin hoặc dùng "Thanh toán qua ví".'
    );
  }

  try {
    const ckContent = order.ckContent || randomTransferContent();
    if (!order.ckContent) store.updateOrder(orderCode, { ckContent });
    const data = await payos.createPayment({
      orderCode,
      amount: order.amount,
      description: ckContent.slice(0, 25),
      productName: order.productName,
      quantity: order.quantity,
      expiredAt: Math.floor((order.createdAt + ORDER_TTL_MS) / 1000),
    });

    store.updateOrder(orderCode, {
      method: 'payos',
      paymentLinkId: data.paymentLinkId,
    });

    const caption =
      `🧾 <b>Đã tạo đơn hàng thành công!</b>\n\n` +
      `📦 Sản phẩm: <b>${escapeHtml(order.productName)}</b>\n` +
      `🔢 Số lượng: <b>${order.quantity}</b>\n` +
      `💰 Số tiền: <b>${money(data.amount)}</b>\n` +
      `🧾 Mã đơn: <code>${displayCode(orderCode)}</code>\n` +
      `📝 Nội dung CK: <code>${escapeHtml(data.description)}</code>\n\n` +
      `🏦 <b>Thông tin thanh toán:</b>\n` +
      `- Ngân hàng: <b>${bankName(data.bin)}</b>\n` +
      `- STK: <code>${data.accountNumber}</code>\n` +
      `- Chủ TK: <b>${escapeHtml(data.accountName || '')}</b>\n\n` +
      `📌 Vui lòng chuyển <b>đúng số tiền</b> và <b>đúng nội dung</b> để bot tự động xử lý.\n` +
      `⏳ Đơn sẽ tự hủy sau 15 phút nếu chưa thanh toán.`;

    const buffer = await payos.qrBuffer(data.qrCode);
    await ctx.replyWithPhoto(
      { source: buffer },
      { caption, parse_mode: 'HTML', ...kb.payosActions(orderCode, data.checkoutUrl) }
    );
  } catch (err) {
    console.error('[PAYOS] create error:', err.message);
    await ctx.reply('⚠️ Không tạo được link thanh toán. Vui lòng thử lại sau ít phút.');
  }
}

// ---------------- Nạp ví qua PayOS ----------------

async function createTopupOrder(ctx, amount) {
  const orderCode = generateOrderCode();
  const refCode = generateRefCode();
  store.addOrder({
    orderCode,
    refCode,
    type: 'topup',
    userId: ctx.from.id,
    chatId: ctx.chat.id,
    amount,
    status: 'pending',
    method: 'payos',
    createdAt: Date.now(),
  });

  try {
    const ckContent = randomTransferContent();
    store.updateOrder(orderCode, { ckContent });
    const data = await payos.createPayment({
      orderCode,
      amount,
      description: ckContent.slice(0, 25),
      productName: 'Nap vi',
      quantity: 1,
      expiredAt: Math.floor((Date.now() + ORDER_TTL_MS) / 1000),
    });
    store.updateOrder(orderCode, { paymentLinkId: data.paymentLinkId });

    const caption =
      `💳 <b>Nạp tiền vào ví</b>\n\n` +
      `💰 Số tiền: <b>${money(data.amount)}</b>\n` +
      `🧾 Mã: <code>${displayCode(orderCode)}</code>\n` +
      `📝 Nội dung CK: <code>${escapeHtml(data.description)}</code>\n\n` +
      `🏦 <b>Thông tin thanh toán:</b>\n` +
      `- Ngân hàng: <b>${bankName(data.bin)}</b>\n` +
      `- STK: <code>${data.accountNumber}</code>\n` +
      `- Chủ TK: <b>${escapeHtml(data.accountName || '')}</b>\n\n` +
      `📌 Chuyển đúng số tiền và nội dung. Ví sẽ tự cộng tiền sau khi thanh toán.\n` +
      `⏳ Hết hạn sau 15 phút.`;

    const buffer = await payos.qrBuffer(data.qrCode);
    await ctx.replyWithPhoto(
      { source: buffer },
      { caption, parse_mode: 'HTML', ...kb.payosActions(orderCode, data.checkoutUrl) }
    );
  } catch (err) {
    console.error('[PAYOS] topup error:', err.message);
    store.updateOrder(orderCode, { status: 'cancelled' });
    await ctx.reply('⚠️ Không tạo được link nạp ví. Vui lòng thử lại sau.');
  }
}

// ---------------- Broadcast: gửi thông báo cho tất cả khách ----------------

async function runBroadcast(ctx, fromChatId, messageId) {
  userStates.delete(ctx.from.id);
  const ids = store.getAllUserIds();
  await ctx.reply(`📤 Đang gửi thông báo tới ${ids.length} khách...`);

  let ok = 0;
  let fail = 0;
  for (const id of ids) {
    try {
      // copyMessage giữ nguyên nội dung gốc (chữ/ảnh/định dạng), không kèm "forwarded from"
      await ctx.telegram.copyMessage(id, fromChatId, messageId);
      ok++;
    } catch (e) {
      fail++; // khách đã chặn bot hoặc xóa tài khoản
    }
    await sleep(40); // ~25 tin/giây, tránh vượt giới hạn Telegram
  }

  await ctx.replyWithHTML(
    `✅ <b>Đã gửi xong</b>\n\n` +
      `📨 Thành công: <b>${ok}</b>\n` +
      `⚠️ Không gửi được: <b>${fail}</b> (khách đã chặn bot)`
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------- Hoàn tất đơn (giao hàng / cộng ví) ----------------

async function fulfill(telegram, order) {
  // Đọc lại bản mới nhất, chống xử lý trùng
  const fresh = store.getOrder(order.orderCode);
  if (!fresh || fresh.status !== 'pending') return;

  // Đánh dấu paid TRƯỚC khi gửi để tránh giao 2 lần
  store.updateOrder(order.orderCode, { status: 'paid', paidAt: Date.now() });

  if (fresh.type === 'topup') {
    const newBalance = store.addBalance(fresh.userId, fresh.amount);
    await telegram.sendMessage(
      fresh.chatId,
      `✅ Nạp ví thành công <b>${money(fresh.amount)}</b>!\n` +
        `👛 Số dư hiện tại: <b>${money(newBalance)}</b>`,
      { parse_mode: 'HTML' }
    );
    return;
  }

  // type === 'order' -> lấy tài khoản, xóa khỏi kho
  const accounts = store.popAccounts(fresh.productId, fresh.quantity);

  if (accounts.length < fresh.quantity) {
    // Kho thiếu (hiếm gặp) -> báo khách & admin
    await telegram.sendMessage(
      fresh.chatId,
      `⚠️ Đã nhận thanh toán nhưng kho tạm thiếu hàng.\n` +
        `Đã giao ${accounts.length}/${fresh.quantity}. Vui lòng liên hệ ${supportContact()} để được hỗ trợ phần còn lại.`
    );
  }

  store.updateOrder(order.orderCode, { delivered: accounts });

  const list = accounts.map((a, i) => `${i + 1}. <code>${escapeHtml(a)}</code>`).join('\n');
  await telegram.sendMessage(
    fresh.chatId,
    `🎉 <b>Thanh toán thành công!</b>\n` +
      `📦 ${escapeHtml(fresh.productName)} x${fresh.quantity}\n` +
      `🧾 Mã đơn: <code>${displayCode(fresh.orderCode)}</code>\n\n` +
      `🔐 <b>Thông tin tài khoản của bạn:</b>\n${list}\n\n` +
      `Cảm ơn bạn đã mua hàng! 💚`,
    { parse_mode: 'HTML' }
  );
}

// Giao hàng theo mã đơn (gọi từ webhook PayOS). Có kiểm tra số tiền khớp.
async function fulfillByOrderCode(telegram, orderCode, paidAmount) {
  const order = store.getOrder(Number(orderCode));
  if (!order) {
    console.warn(`[PAYOS-WH] Không tìm thấy đơn ${orderCode}`);
    return;
  }
  if (order.status !== 'pending') return; // đã xử lý hoặc đã hủy
  if (typeof paidAmount === 'number' && paidAmount < order.amount) {
    console.warn(`[PAYOS-WH] Đơn ${orderCode} trả thiếu: ${paidAmount}/${order.amount}`);
    return;
  }
  await fulfill(telegram, order);
  console.log(`[PAYOS-WH] Đã giao đơn ${displayCode(order.orderCode)}`);
}

// ---------------- Bộ theo dõi thanh toán + hết hạn ----------------

async function tick(telegram) {
  const now = Date.now();
  const pending = store.getPendingOrders();

  for (const order of pending) {
    try {
      // Hết hạn 15 phút
      if (now - order.createdAt > ORDER_TTL_MS) {
        if (order.method === 'payos' && order.paymentLinkId) {
          await payos.cancelPayment(order.orderCode, 'Hết hạn thanh toán');
        }
        store.updateOrder(order.orderCode, { status: 'expired' });
        await telegram.sendMessage(
          order.chatId,
          `⏳ Đơn ${displayCode(order.orderCode)} đã hết hạn (quá 15 phút) và bị hủy.\n` +
            `Nếu vẫn muốn mua, vui lòng đặt lại từ đầu.`
        );
        continue;
      }

      // Chỉ check PayOS đã có link
      if (order.method === 'payos' && order.paymentLinkId) {
        const info = await payos.getStatus(order.orderCode);
        if (!info) continue;
        if (info.status === 'PAID') {
          await fulfill(telegram, order);
        } else if (['CANCELLED', 'EXPIRED', 'FAILED'].includes(info.status)) {
          store.updateOrder(order.orderCode, { status: 'cancelled' });
          await telegram.sendMessage(
            order.chatId,
            `❌ Đơn ${displayCode(order.orderCode)} đã bị hủy.`
          );
        }
      }
    } catch (e) {
      console.error('[WATCHER]', order.orderCode, e.message);
    }
  }
}

function startPaymentWatcher(bot) {
  setInterval(() => {
    tick(bot.telegram).catch((e) => console.error('[WATCHER] tick error:', e.message));
  }, WATCH_INTERVAL_MS);
  console.log('[OK] Bộ theo dõi thanh toán đã chạy (mỗi 10s)');
}

module.exports = { registerShop, startPaymentWatcher, fulfillByOrderCode };
