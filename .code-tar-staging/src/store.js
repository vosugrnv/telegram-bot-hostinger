const fs = require('fs');
const path = require('path');

const STATE_TTL_MS = 30 * 60 * 1000;

function resolveDataDir() {
  const fromEnv = String(process.env.DATA_DIR || '').trim();
  if (fromEnv) {
    // If user explicitly sets DATA_DIR, always honor it.
    // ensureDirs() will seed missing files there on first run.
    return path.resolve(fromEnv);
  }

  const candidates = [
    path.join(__dirname, '..', 'data'),
    path.join(process.cwd(), 'data'),
  ].filter(Boolean);

  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'products.json'))) {
      return dir;
    }
  }
  return path.join(__dirname, '..', 'data');
}

function createStore(dataDir) {
  const ACCOUNTS_DIR = path.join(dataDir, 'accounts');
  const IMAGES_DIR = path.join(dataDir, 'images');
  const PRODUCTS_FILE = path.join(dataDir, 'products.json');
  const ORDERS_FILE = path.join(dataDir, 'orders.json');
  const USERS_FILE = path.join(dataDir, 'users.json');
  const STATES_FILE = path.join(dataDir, 'states.json');

  function ensureDirs() {
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    if (!fs.existsSync(ACCOUNTS_DIR)) fs.mkdirSync(ACCOUNTS_DIR, { recursive: true });
    if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });

    if (!fs.existsSync(PRODUCTS_FILE)) writeJson(PRODUCTS_FILE, { products: [] });
    if (!fs.existsSync(ORDERS_FILE)) writeJson(ORDERS_FILE, { orders: [] });
    if (!fs.existsSync(USERS_FILE)) writeJson(USERS_FILE, { users: {} });
    if (!fs.existsSync(STATES_FILE)) writeJson(STATES_FILE, { states: {} });
  }

  function readJson(file, fallback) {
    try {
      const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
      return JSON.parse(raw);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error(`[ERROR] Không đọc được ${file}: ${err.message}`);
      }
      return fallback;
    }
  }

  function writeJson(file, data) {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  }

  function getProducts() {
    const data = readJson(PRODUCTS_FILE, { products: [] });
    if (Array.isArray(data)) return data;
    return data.products || [];
  }

  function getProduct(productId) {
    return getProducts().find((p) => p.id === productId) || null;
  }

  function saveProducts(products) {
    writeJson(PRODUCTS_FILE, { products });
  }

  function addProduct(product) {
    const products = getProducts();
    if (products.some((p) => p.id === product.id)) return null;
    products.push(product);
    saveProducts(products);
    return product;
  }

  function updateProduct(productId, patch) {
    const products = getProducts();
    const idx = products.findIndex((p) => p.id === productId);
    if (idx === -1) return null;
    products[idx] = { ...products[idx], ...patch };
    saveProducts(products);
    return products[idx];
  }

  function deleteProduct(productId) {
    const products = getProducts();
    const next = products.filter((p) => p.id !== productId);
    if (next.length === products.length) return false;
    saveProducts(next);
    return true;
  }

  function productImage(productId) {
    if (!fs.existsSync(IMAGES_DIR)) return null;
    for (const ext of ['jpg', 'jpeg', 'png', 'webp']) {
      const file = path.join(IMAGES_DIR, `${productId}.${ext}`);
      if (fs.existsSync(file)) return file;
    }
    return null;
  }

  function saveProductImage(productId, ext, buffer) {
    const safeExt = String(ext || '').toLowerCase();
    if (!['jpg', 'jpeg', 'png', 'webp'].includes(safeExt)) return null;

    for (const oldExt of ['jpg', 'jpeg', 'png', 'webp']) {
      const oldFile = path.join(IMAGES_DIR, `${productId}.${oldExt}`);
      if (fs.existsSync(oldFile) && oldExt !== safeExt) fs.unlinkSync(oldFile);
    }

    const file = path.join(IMAGES_DIR, `${productId}.${safeExt}`);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, buffer);
    fs.renameSync(tmp, file);
    return file;
  }

  function accountFile(productId) {
    const noext = path.join(ACCOUNTS_DIR, productId);
    const txt = path.join(ACCOUNTS_DIR, `${productId}.txt`);
    if (fs.existsSync(noext)) return noext;
    if (fs.existsSync(txt)) return txt;
    return noext;
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

  function appendAccountLines(productId, lines) {
    const current = readAccountLines(productId);
    const more = (lines || []).map((l) => String(l).trim()).filter(Boolean);
    writeAccountLines(productId, [...current, ...more]);
  }

  function physicalStock(productId) {
    return readAccountLines(productId).length;
  }

  function heldStock(productId) {
    return getOrders()
      .filter((o) => o.status === 'pending' && o.productId === productId)
      .reduce((sum, o) => sum + o.quantity, 0);
  }

  function availableStock(productId) {
    return Math.max(0, physicalStock(productId) - heldStock(productId));
  }

  function popAccounts(productId, quantity) {
    const lines = readAccountLines(productId);
    const taken = lines.slice(0, quantity);
    const remaining = lines.slice(quantity);
    writeAccountLines(productId, remaining);
    return taken;
  }

  function listAccountIds() {
    if (!fs.existsSync(ACCOUNTS_DIR)) return [];
    const set = new Set();
    for (const f of fs.readdirSync(ACCOUNTS_DIR)) {
      if (f.startsWith('.')) continue;
      if (f.toLowerCase().endsWith('.tmp')) continue;
      set.add(f.replace(/\.txt$/i, ''));
    }
    return [...set];
  }

  function deleteAccountFile(productId) {
    const file = accountFile(productId);
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
      return true;
    }
    return false;
  }

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

  function soldCount(productId) {
    return getOrders()
      .filter((o) => o.status === 'paid' && o.productId === productId && o.type !== 'topup')
      .reduce((sum, o) => sum + (o.quantity || 0), 0);
  }

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

  return {
    dataDir,
    getState,
    setState,
    clearState,
    getProducts,
    getProduct,
    saveProducts,
    addProduct,
    updateProduct,
    deleteProduct,
    productImage,
    saveProductImage,
    readAccountLines,
    writeAccountLines,
    appendAccountLines,
    physicalStock,
    availableStock,
    popAccounts,
    listAccountIds,
    deleteAccountFile,
    addOrder,
    getOrder,
    updateOrder,
    getOrders,
    getPendingOrders,
    getUserOrders,
    soldCount,
    getUsers,
    getUser,
    getAllUserIds,
    updateUser,
    getBalance,
    addBalance,
    deductBalance,
  };
}

const defaultDataDir = resolveDataDir();
const defaultStore = createStore(defaultDataDir);

function logStoreStartup(dataDir, store) {
  const productsFile = path.join(dataDir, 'products.json');
  const exists = fs.existsSync(productsFile);
  const size = exists ? fs.statSync(productsFile).size : 0;
  const count = store.getProducts().length;
  const accountsDir = path.join(dataDir, 'accounts');
  let accountFiles = 0;
  if (fs.existsSync(accountsDir)) {
    accountFiles = fs.readdirSync(accountsDir).filter((f) => !f.startsWith('.')).length;
  }

  console.log(`[INFO] DATA_DIR = ${dataDir}`);
  console.log(`[INFO] products.json tồn tại: ${exists} (${size} bytes)`);
  console.log(`[INFO] Số sản phẩm đọc được: ${count}`);
  console.log(`[INFO] Số file kho accounts/: ${accountFiles}`);
  if (exists && size > 200 && count === 0) {
    console.error('[ERROR] products.json có dữ liệu nhưng không đọc được — kiểm tra JSON hợp lệ (dấu phẩy, ngoặc).');
  }
}

logStoreStartup(defaultDataDir, defaultStore);

module.exports = {
  createStore,
  resolveDataDir,
  ...defaultStore,
};
