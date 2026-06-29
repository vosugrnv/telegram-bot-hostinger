const { Markup } = require('telegraf');
const { money } = require('./utils');

// Menu chính dạng INLINE, gắn ngay dưới tin nhắn chào (layout y hệt ảnh mẫu)
function mainMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🛍️ Mua hàng', 'menu:buy')],
    [
      Markup.button.callback('👤 Hồ sơ', 'menu:profile'),
      Markup.button.callback('🧾 Lịch sử mua', 'menu:history'),
    ],
    [Markup.button.callback('💰 Ví', 'menu:wallet')],
    [Markup.button.callback('💬 Hỗ trợ', 'menu:support')],
    [Markup.button.callback('🌐 Ngôn ngữ', 'menu:lang')],
  ]);
}

// Nút quay về menu chính
function backHome() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🔙 Menu chính', 'menu:home')],
  ]);
}

// Danh sách sản phẩm dạng nút inline (mỗi SP 1 hàng) + nút quay lại
function productList(products, stockOf) {
  const rows = products.map((p) => {
    const stock = stockOf(p.id);
    const label = `${p.emoji || '📦'} ${p.name} | ${money(p.price)} | 📦 ${stock}`;
    return [Markup.button.callback(label, `buy:${p.id}`)];
  });
  rows.push([Markup.button.callback('🔙 Menu chính', 'menu:home')]);
  return Markup.inlineKeyboard(rows);
}

function paymentMethods(orderCode) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('💰 Thanh toán qua ví', `pay_wallet:${orderCode}`)],
    [Markup.button.callback('🏦 Thanh toán ngay (PayOS)', `pay_payos:${orderCode}`)],
  ]);
}

function payosActions(orderCode, checkoutUrl) {
  const rows = [];
  if (checkoutUrl) {
    rows.push([Markup.button.url('🔗 Mở trang thanh toán', checkoutUrl)]);
  }
  rows.push([Markup.button.callback('🔄 Tôi đã thanh toán', `check:${orderCode}`)]);
  return Markup.inlineKeyboard(rows);
}

function walletMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('➕ Nạp tiền vào ví', 'wallet_topup')],
    [Markup.button.callback('🔙 Menu chính', 'menu:home')],
  ]);
}

module.exports = {
  mainMenu,
  backHome,
  productList,
  paymentMethods,
  payosActions,
  walletMenu,
};
