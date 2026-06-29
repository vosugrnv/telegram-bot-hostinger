const fs = require('fs');
const path = require('path');

// Tìm thư mục data ở nhiều vị trí (phòng khi Hostinger chạy ở cwd khác)
function resolveDataDir() {
  const candidates = [
    process.env.DATA_DIR,
    path.join(__dirname, '..', 'data'),
    path.join(process.cwd(), 'data'),
  ].filter(Boolean);

  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'products.json'))) {
      return dir;
    }
  }
  // Không tìm thấy products.json -> dùng mặc định cạnh src
  return path.join(__dirname, '..', 'data');
}

const DATA_DIR = resolveDataDir();
const ACCOUNTS_DIR = path.join(DATA_DIR, 'accounts');
const PRODUCTS_FILE = path.join(DATA_DIR, 'products.json');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const STATES_FILE = path.join(DATA_DIR, 'states.json');

const STATE_TTL_MS = 30 * 60 * 1000; // trạng thái hội thoại hết hạn sau 30 phút

console.log(`[INFO] DATA_DIR = ${DATA_DIR}`);
console.log(`[INFO] products.json tồn tại: ${fs.existsSync(PRODUCTS_FILE)}`);

function ensureDirs() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(ACCOUNTS_DIR)) fs.mkdirSync(ACCOUNTS_DIR, { recursive: true });
}

function readJson(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`[WARN] Không đọc được ${path.basename(file)}: ${err.message}`);
    }
    return fallback;
  }
}

function writeJson(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

// ---------- Products ----------

function getProducts() {
  const data = readJson(PRODUCTS_FILE, { products: [] });
  return data.products || [];
}

function getProduct(productId) {
  return getProducts().find((p) => p.id === productId) || null;
}

// ---------- Account stock (text files) ----------

function accountFile(productId) {
  return path.join(ACCOUNTS_DIR, `${productId}.txt`);
}

function readAccountLines(productId) {
  const file = accountFile(productId);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function writeAccountLines(productId, lines) {
  const file = accountFile(productId);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, lines.join('\n') + (lines.length ? '\n' : ''));
  fs.renameSync(tmp, file);
}

// Số lượng vật lý trong file
function physicalStock(productId) {
  return readAccountLines(productId).length;
}

// Số lượng đang bị "giữ" bởi các đơn PayOS đang chờ thanh toán
function heldStock(productId) {
  return getOrders()
    .filter((o) => o.status === 'pending' && o.productId === productId)
    .reduce((sum, o) => sum + o.quantity, 0);
}

// Tồn kho khả dụng = vật lý - đang giữ
function availableStock(productId) {
  return Math.max(0, physicalStock(productId) - heldStock(productId));
}

// Lấy ra N tài khoản đầu tiên và XÓA khỏi file
function popAccounts(productId, quantity) {
  const lines = readAccountLines(productId);
  const taken = lines.slice(0, quantity);
  const remaining = lines.slice(quantity);
  writeAccountLines(productId, remaining);
  return taken;
}

// ---------- Orders ----------

function getOrders() {
  const data = readJson(ORDERS_FILE, { orders: [] });
  return data.orders || [];
}

function saveOrders(orders) {
  writeJson(ORDERS_FILE, { orders });
}

function addOrder(order) {
  const orders = getOrders();
  orders.push(order);
  saveOrders(orders);
  return order;
}

function getOrder(orderCode) {
  return getOrders().find((o) => o.orderCode === orderCode) || null;
}

function updateOrder(orderCode, patch) {
  const orders = getOrders();
  const idx = orders.findIndex((o) => o.orderCode === orderCode);
  if (idx === -1) return null;
  orders[idx] = { ...orders[idx], ...patch };
  saveOrders(orders);
  return orders[idx];
}

function getPendingOrders() {
  return getOrders().filter((o) => o.status === 'pending');
}

function getUserOrders(userId) {
  return getOrders().filter((o) => o.userId === userId);
}

// ---------- Users / Wallet ----------

function getUsers() {
  const data = readJson(USERS_FILE, { users: {} });
  return data.users || {};
}

function saveUsers(users) {
  writeJson(USERS_FILE, { users });
}

function getUser(userId) {
  const users = getUsers();
  const key = String(userId);
  if (!users[key]) {
    users[key] = { balance: 0, firstName: '', username: '' };
    saveUsers(users);
  }
  return users[key];
}

function getAllUserIds() {
  return Object.keys(getUsers());
}

function updateUser(userId, patch) {
  const users = getUsers();
  const key = String(userId);
  users[key] = { ...(users[key] || { balance: 0 }), ...patch };
  saveUsers(users);
  return users[key];
}

function getBalance(userId) {
  return getUser(userId).balance || 0;
}

function addBalance(userId, amount) {
  const user = getUser(userId);
  const newBalance = (user.balance || 0) + amount;
  updateUser(userId, { balance: newBalance });
  return newBalance;
}

function deductBalance(userId, amount) {
  const user = getUser(userId);
  if ((user.balance || 0) < amount) return false;
  updateUser(userId, { balance: user.balance - amount });
  return true;
}

// ---------- Conversation states (bền vững qua respawn process) ----------

function getStates() {
  const data = readJson(STATES_FILE, { states: {} });
  return data.states || {};
}

function saveStates(states) {
  writeJson(STATES_FILE, { states });
}

function getState(userId) {
  const state = getStates()[String(userId)];
  if (!state) return null;
  if (state._ts && Date.now() - state._ts > STATE_TTL_MS) {
    clearState(userId);
    return null;
  }
  return state;
}

function setState(userId, state) {
  const states = getStates();
  states[String(userId)] = { ...state, _ts: Date.now() };
  saveStates(states);
}

function clearState(userId) {
  const states = getStates();
  if (states[String(userId)]) {
    delete states[String(userId)];
    saveStates(states);
  }
}

ensureDirs();

module.exports = {
  getState,
  setState,
  clearState,
  getProducts,
  getProduct,
  physicalStock,
  availableStock,
  popAccounts,
  addOrder,
  getOrder,
  updateOrder,
  getOrders,
  getPendingOrders,
  getUserOrders,
  getUser,
  getAllUserIds,
  updateUser,
  getBalance,
  addBalance,
  deductBalance,
};
