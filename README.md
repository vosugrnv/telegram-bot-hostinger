# Telegram Shop Bot — PayOS + Hostinger

Bot Telegram bán tài khoản tự động: menu mua hàng, chọn số lượng, thanh toán **PayOS** (QR điền sẵn số tiền) hoặc **ví nội bộ**, tự động giao tài khoản và trừ kho khi nhận được tiền. Chạy **webhook** trên Hostinger.

## Tính năng

- Menu chính: 🛍️ Mua hàng · 👤 Hồ sơ · 🧾 Lịch sử mua · 💰 Ví · 💬 Hỗ trợ · 🌐 Ngôn ngữ
- Mua hàng: chọn sản phẩm → nhập số lượng → xác nhận đơn → chọn thanh toán
- **Thanh toán ngay (PayOS)**: gửi thông tin STK + nội dung CK + **ảnh QR điền sẵn số tiền**
- **Thanh toán qua ví**: trừ số dư ví, giao hàng ngay
- Tự động kiểm tra thanh toán (10 giây/lần) → giao tài khoản, **xóa tài khoản đã bán khỏi file**, cập nhật tồn kho
- Đơn quá **15 phút** chưa thanh toán → tự hủy (khách đặt lại từ đầu)
- Nạp tiền vào ví qua PayOS
- **Admin Web Panel** tại `/admin`: quản lý sản phẩm, kho tài khoản, đơn hàng, upload ảnh sản phẩm

## Cấu trúc

```
telegram-bot-hostinger/
├── index.js              # Khởi động bot + health server + watcher
├── src/
│   ├── shop.js           # Toàn bộ luồng shop + watcher thanh toán
│   ├── store.js          # Đọc/ghi sản phẩm, kho, đơn, ví
│   ├── payos.js          # Tích hợp PayOS + sinh QR
│   ├── keyboards.js      # Menu & nút
│   └── utils.js          # Tiền tệ, tên ngân hàng
├── data/
│   ├── products.json     # Danh mục sản phẩm
│   ├── accounts/
│   │   └── <id>           # Kho tài khoản (mỗi dòng 1 tài khoản)
│   ├── images/            # Ảnh sản phẩm theo id (id.jpg/png/webp)
│   ├── orders.json       # Đơn hàng
│   └── users.json        # Ví người dùng
├── package.json
└── .env                  # Token & PayOS (KHÔNG commit)
```

## Cấu hình môi trường (.env)

```bash
cp .env.example .env
```

| Biến | Bắt buộc | Mô tả |
|------|----------|-------|
| `BOT_TOKEN` | ✅ | Token từ @BotFather |
| `BOT_NAME` | | Tên bot hiển thị |
| `SUPPORT_CONTACT` | | Liên hệ hỗ trợ (vd `@admin`) |
| `ADMIN_PASSWORD` | ✅* | Mật khẩu đăng nhập trang quản trị `/admin` |
| `DATA_DIR` | | Đường dẫn thư mục data bền vững (khuyến nghị đặt ngoài thư mục app) |
| `BOTS_CONFIG` | | JSON danh sách bot cho admin đa bot: `[{id,name,dataDir},...]` |
| `PAYOS_CLIENT_ID` | ✅* | PayOS → Kênh thanh toán → Thông tin xác thực |
| `PAYOS_API_KEY` | ✅* | |
| `PAYOS_CHECKSUM_KEY` | ✅* | |
| `PAYOS_RETURN_URL` | | URL trả về sau thanh toán (tùy chọn) |
| `PAYOS_CANCEL_URL` | | URL khi hủy (tùy chọn) |

\* Bắt buộc nếu muốn dùng "Thanh toán ngay" và "Nạp ví". Thiếu PayOS thì bot vẫn chạy, chỉ tắt 2 chức năng này.

## Quản lý sản phẩm & kho

**Thêm/sửa sản phẩm** — `data/products.json`:

```json
{
  "products": [
    { "id": "veo3_ultra_1m", "name": "VEO3 ULTRA 1 THÁNG", "price": 30000, "emoji": "✅", "description": "..." }
  ]
}
```

**Nạp kho tài khoản** — tạo file `data/accounts/<id>`, mỗi dòng 1 tài khoản (id phải khớp `products.json`):

```
email01@mail.com|matkhau01
email02@mail.com|matkhau02
```

- Tồn kho hiển thị = số dòng trong file − số đang chờ thanh toán.
- Khi khách thanh toán xong, bot lấy dòng đầu tiên, gửi cho khách và **xóa dòng đó khỏi file**.

## Chạy local

```bash
npm install
npm start
```

> ⚠️ Chỉ chạy bot ở **một nơi**. Nếu đang chạy trên Hostinger thì tắt local (tránh lỗi 409).

## Triển khai trên Hostinger

1. Nén (KHÔNG kèm `node_modules`, `.env`):
   ```powershell
   Compress-Archive -Path index.js, package.json, package-lock.json, src, data -DestinationPath bot-deploy.zip -Force
   ```
2. hPanel → **Node.js / Deployments** → upload `bot-deploy.zip`
   - Node version: 18.x · Root: `./` · Start: `npm start`
3. **Environment variables**: thêm `BOT_TOKEN`, `BOT_NAME`, `PAYOS_*`, `SUPPORT_CONTACT`
4. **Deploy** → xem **Runtime logs** cần có:
   ```
   [OK] Health server: port ...
   [OK] <BOT_NAME> đã khởi động (polling)
   [OK] Bộ theo dõi thanh toán đã chạy (mỗi 10s)
   ```

## Admin Web Panel

- URL: `https://<domain>/admin`
- Đăng nhập bằng `ADMIN_PASSWORD`
- **Một trang admin** quản lý toàn bộ: sản phẩm, kho tài khoản, đơn hàng (tên hàng, chi tiết acc đã giao, giá trị, thời gian, khách mua)
- Chức năng:
  - Tab **Sản phẩm**: thêm/sửa/xóa sản phẩm
  - Tab **Kho**: thêm tiếp hoặc ghi đè tài khoản theo từng sản phẩm, upload ảnh
  - Tab **Đơn hàng**: xem mã đơn, khách mua, sản phẩm, số lượng, giá trị, thời gian, tài khoản đã giao

### Quản lý nhiều bot Telegram

Mỗi bot vẫn chạy **process riêng** (mỗi app có `BOT_TOKEN` + `DATA_DIR` riêng). Trang admin trung tâm đọc/ghi trực tiếp vào thư mục data của từng bot.

1. Tạo thư mục data riêng cho mỗi bot, ví dụ:
   - `/home/<user>/bot-data-shop1`
   - `/home/<user>/bot-data-shop2`
2. Trên **một** deployment (admin hub), đặt biến `BOTS_CONFIG` (JSON một dòng):

```json
[
  {"id":"shop1","name":"Media AI Hub","dataDir":"/home/<user>/bot-data-shop1"},
  {"id":"shop2","name":"Shop 2","dataDir":"/home/<user>/bot-data-shop2"}
]
```

3. Mở `/admin` → chọn bot ở dropdown → thao tác Sản phẩm / Kho / Đơn hàng cho bot đó.

Nếu chỉ có **1 bot**, không cần `BOTS_CONFIG` — admin tự dùng `DATA_DIR` (hoặc `data/` mặc định).

## ⚠️ Lưu ý quan trọng về dữ liệu

Mỗi lần **redeploy/upload zip mới sẽ GHI ĐÈ** thư mục `data/` → mất kho đã bán, ví, lịch sử.

Khuyến nghị:
- Đặt `DATA_DIR` ra ngoài thư mục app để tránh mất dữ liệu khi redeploy.
  - Ví dụ `DATA_DIR=/home/<username>/bot-data`
  - Chuyển toàn bộ thư mục `nodejs/data/` sang đường dẫn đó, rồi restart app.
- Khi cần cập nhật code, chỉ zip `index.js`, `src/`, `package*.json` (bỏ `data/`) để không ghi đè dữ liệu.
- Với quy mô lớn nên chuyển sang database (MySQL/Postgres) thay cho file JSON.

## Bảo mật

- KHÔNG commit/upload `.env` hay token, dùng Environment variables.
- Token lộ → BotFather `/revoke`. PayOS lộ key → tạo lại trong dashboard PayOS.
