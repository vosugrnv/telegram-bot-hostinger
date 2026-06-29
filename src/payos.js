const QRCode = require('qrcode');

let payos = null;

function getClient() {
  if (payos) return payos;

  const clientId = process.env.PAYOS_CLIENT_ID;
  const apiKey = process.env.PAYOS_API_KEY;
  const checksumKey = process.env.PAYOS_CHECKSUM_KEY;

  if (!clientId || !apiKey || !checksumKey) {
    return null;
  }

  const { PayOS } = require('@payos/node');
  payos = new PayOS({ clientId, apiKey, checksumKey });
  return payos;
}

function isConfigured() {
  return getClient() !== null;
}

// Tạo link thanh toán PayOS. Trả về dữ liệu QR + thông tin chuyển khoản.
async function createPayment({ orderCode, amount, description, productName, quantity, expiredAt }) {
  const client = getClient();
  if (!client) throw new Error('PAYOS_NOT_CONFIGURED');

  const returnUrl = process.env.PAYOS_RETURN_URL || 'https://payos.vn';
  const cancelUrl = process.env.PAYOS_CANCEL_URL || 'https://payos.vn';

  const data = await client.paymentRequests.create({
    orderCode,
    amount,
    description,
    items: [{ name: productName, quantity, price: Math.round(amount / quantity) }],
    returnUrl,
    cancelUrl,
    ...(expiredAt ? { expiredAt } : {}),
  });

  return data;
}

// Lấy trạng thái đơn: PENDING | PAID | CANCELLED | EXPIRED ...
async function getStatus(orderCode) {
  const client = getClient();
  if (!client) throw new Error('PAYOS_NOT_CONFIGURED');
  const info = await client.paymentRequests.get(orderCode);
  return info;
}

async function cancelPayment(orderCode, reason = 'Hết hạn thanh toán') {
  const client = getClient();
  if (!client) return null;
  try {
    return await client.paymentRequests.cancel(orderCode, reason);
  } catch (err) {
    return null;
  }
}

// Đăng ký URL webhook với PayOS (PayOS sẽ test URL này)
async function confirmWebhook(webhookUrl) {
  const client = getClient();
  if (!client) throw new Error('PAYOS_NOT_CONFIGURED');
  return client.webhooks.confirm(webhookUrl);
}

// Xác thực dữ liệu webhook (chống giả mạo bằng checksum). Trả về WebhookData hoặc throw.
async function verifyWebhook(body) {
  const client = getClient();
  if (!client) throw new Error('PAYOS_NOT_CONFIGURED');
  return client.webhooks.verify(body);
}

// Sinh ảnh QR (PNG buffer) từ chuỗi VietQR mà PayOS trả về
async function qrBuffer(qrText) {
  return QRCode.toBuffer(qrText, {
    width: 512,
    margin: 2,
    errorCorrectionLevel: 'M',
  });
}

module.exports = {
  isConfigured,
  createPayment,
  getStatus,
  cancelPayment,
  confirmWebhook,
  verifyWebhook,
  qrBuffer,
};
