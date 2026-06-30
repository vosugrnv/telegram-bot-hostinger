// Map BIN ngân hàng -> tên hiển thị (các ngân hàng phổ biến VN)
const BANK_NAMES = {
  '970422': 'MB Bank',
  '970415': 'VietinBank',
  '970418': 'BIDV',
  '970436': 'Vietcombank',
  '970407': 'Techcombank',
  '970416': 'ACB',
  '970432': 'VPBank',
  '970423': 'TPBank',
  '970403': 'Sacombank',
  '970405': 'Agribank',
  '970448': 'OCB',
  '970426': 'MSB',
  '970443': 'SHB',
  '970441': 'VIB',
  '970454': 'VietCapital Bank',
  '970437': 'HDBank',
  '970409': 'BacABank',
  '970412': 'PVcomBank',
  '970419': 'NCB',
  '970429': 'SCB',
  '970438': 'BaoVietBank',
  '970440': 'SeABank',
  '963388': 'Timo',
  '970400': 'SaigonBank',
};

function bankName(bin) {
  return BANK_NAMES[bin] || `Ngân hàng (BIN ${bin})`;
}

// Định dạng tiền: 30000 -> "30.000đ"
function money(amount) {
  return Number(amount).toLocaleString('vi-VN') + 'đ';
}

// Định dạng ngắn cho thẻ sản phẩm: 275000 -> "275k", 1200000 -> "1.2tr"
function moneyShort(amount) {
  const n = Number(amount);
  if (n >= 1_000_000) {
    const tr = n / 1_000_000;
    const s = tr % 1 === 0 ? String(tr) : tr.toFixed(1).replace(/\.0$/, '');
    return `${s}tr`;
  }
  if (n >= 1_000) {
    const k = n / 1_000;
    const s = k % 1 === 0 ? String(k) : k.toFixed(1).replace(/\.0$/, '');
    return `${s}k`;
  }
  return `${n}đ`;
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Tạo nội dung chuyển khoản dạng "<Họ tên> chuyen tien" (không dấu, <= 25 ký tự
// để vừa giới hạn nội dung CK của PayOS/VietQR)
const HO = ['Nguyen', 'Tran', 'Le', 'Pham', 'Vu', 'Vo', 'Bui', 'Do', 'Ho', 'Ngo', 'Dang', 'Dinh'];
const DEM = ['Van', 'Thi', 'Minh', 'Thu', 'Duc', 'Anh', 'Gia', 'Hai', 'Hoa', 'Quoc', 'Ngoc'];
const TEN = ['An', 'Ha', 'Tam', 'Mai', 'Hai', 'Quan', 'Nam', 'Binh', 'Long', 'Linh', 'Son', 'Lan', 'Hung', 'Phuc', 'Vy'];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomTransferContent() {
  const suffix = ' chuyen tien';
  const maxNameLen = 25 - suffix.length; // tên phải <= 13 ký tự
  for (let i = 0; i < 30; i++) {
    const name = `${pick(HO)} ${pick(DEM)} ${pick(TEN)}`;
    if (name.length <= maxNameLen) return `${name}${suffix}`;
  }
  // Dự phòng: cắt cho vừa
  return `${pick(HO)} ${pick(TEN)}${suffix}`.slice(0, 25);
}

module.exports = { bankName, money, moneyShort, escapeHtml, randomTransferContent };
