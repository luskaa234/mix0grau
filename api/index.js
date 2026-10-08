const crypto = require('crypto');
const { neon } = require('@neondatabase/serverless');

const STORE_WHATSAPP = process.env.STORE_WHATSAPP || '559899044137';
const ADMIN_PIN = process.env.MIX0GRAU_ADMIN_PIN || '';

let sql;
let schemaReady;

const DEFAULT_PRODUCTS = [
  ['Morango Trufado', 'Acai cremoso com morango e uma camada trufada bem generosa.', 'Trufados', 17, 24],
  ['Maracuja Trufado', 'A combinacao azedinha do maracuja com trufa doce na medida.', 'Trufados', 17, 24],
  ['Ninho Trufado', 'Creme de Ninho com toque trufado para um acai mais encorpado.', 'Trufados', 16, 23],
  ['Morango com Ninho', 'Morango e leite Ninho em uma mistura leve, doce e cremosa.', 'Ninho', 15, 20],
  ['Maracuja com Ninho', 'Maracuja refrescante com Ninho para equilibrar docura e acidez.', 'Ninho', 15, 20],
  ['Pacoca com Ninho', 'Acai com pacoca e Ninho, sabor de sobremesa brasileira.', 'Ninho', 12, 18],
  ['Tradicional', 'O classico com Ninho e leite condensado, simples e certeiro.', 'Tradicional', 12, 16],
  ['Creme de Ninho', 'Acai com creme de Ninho macio, doce e bem aconchegante.', 'Ninho', 12, 18],
];

function getSql() {
  if (!process.env.DATABASE_URL) {
    const err = new Error('DATABASE_URL nao configurada na Vercel.');
    err.status = 500;
    throw err;
  }
  if (!sql) sql = neon(process.env.DATABASE_URL);
  return sql;
}

function json(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(data));
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function newToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function digits(value) {
  return String(value || '').replace(/\D/g, '');
}

function adminOk(req) {
  const pin = String(req.headers['x-admin-pin'] || '');
  if (!ADMIN_PIN || pin.length !== ADMIN_PIN.length) return false;
  return crypto.timingSafeEqual(Buffer.from(pin), Buffer.from(ADMIN_PIN));
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return req.body ? JSON.parse(req.body) : {};
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

async function ensureSchema() {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    const db = getSql();
    await db`CREATE TABLE IF NOT EXISTS clients (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT NOT NULL UNIQUE,
      address TEXT NOT NULL DEFAULT '',
      token_hash TEXT NOT NULL,
      created TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
    await db`CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      items JSONB NOT NULL,
      total NUMERIC(10,2) NOT NULL,
      units INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      reward INTEGER NOT NULL DEFAULT 0,
      created TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
    await db`CREATE TABLE IF NOT EXISTS redemptions (
      id SERIAL PRIMARY KEY,
      client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      created TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
    await db`CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT 'Acai',
      active BOOLEAN NOT NULL DEFAULT TRUE,
      price350 NUMERIC(10,2) NOT NULL DEFAULT 0,
      price500 NUMERIC(10,2) NOT NULL DEFAULT 0,
      cost NUMERIC(10,2) NOT NULL DEFAULT 0,
      stock NUMERIC(10,2) NOT NULL DEFAULT 0,
      low_stock NUMERIC(10,2) NOT NULL DEFAULT 5,
      created TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
    await db`CREATE TABLE IF NOT EXISTS stock_movements (
      id SERIAL PRIMARY KEY,
      product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
      delta NUMERIC(10,2) NOT NULL,
      reason TEXT NOT NULL DEFAULT 'Ajuste manual',
      created TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
    await db`CREATE TABLE IF NOT EXISTS expenses (
      id SERIAL PRIMARY KEY,
      description TEXT NOT NULL,
      amount NUMERIC(10,2) NOT NULL,
      category TEXT NOT NULL DEFAULT 'Outros',
      created TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;

    const count = await db`SELECT COUNT(*)::int AS count FROM products`;
    if (!count[0].count) {
      for (const [name, description, category, price350, price500] of DEFAULT_PRODUCTS) {
        await db`INSERT INTO products(name, description, category, price350, price500)
          VALUES(${name}, ${description}, ${category}, ${price350}, ${price500})`;
      }
    }
  })();
  return schemaReady;
}

async function authClient(req) {
  const header = String(req.headers.authorization || '');
  const token = header.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  const db = getSql();
  const rows = await db`SELECT * FROM clients WHERE token_hash = ${hashToken(token)} LIMIT 1`;
  return rows[0] || null;
}

async function publicClient(client) {
  const db = getSql();
  const paidRows = await db`SELECT COALESCE(SUM(units),0)::int AS paid
    FROM orders WHERE client_id = ${client.id} AND status = 'approved' AND reward = 0`;
  const redeemedRows = await db`SELECT COUNT(*)::int AS redeemed FROM redemptions WHERE client_id = ${client.id}`;
  const paid = Number(paidRows[0].paid || 0);
  const redeemed = Number(redeemedRows[0].redeemed || 0);
  const balance = Math.max(0, paid - redeemed * 6);
  return {
    name: client.name,
    phone: client.phone,
    address: client.address || '',
    stamps: balance % 6,
    rewards: Math.floor(balance / 6),
    total_approved: paid,
    redeemed,
  };
}

function routeFrom(req) {
  const url = new URL(req.url, 'https://mix0grau.local');
  const path = url.searchParams.get('path') || url.pathname.replace(/^\/api\/?/, '');
  return path.split('/').filter(Boolean);
}

async function getProducts(res, admin = false) {
  const db = getSql();
  const rows = admin
    ? await db`SELECT * FROM products ORDER BY id DESC`
    : await db`SELECT id,name,description,category,price350,price500 FROM products WHERE active = TRUE ORDER BY id`;
  json(res, 200, rows);
}

async function dashboard(res) {
  const db = getSql();
  const statsRows = await db`SELECT
    COUNT(*)::int AS orders,
    COALESCE(SUM(CASE WHEN status = 'approved' THEN total ELSE 0 END),0)::float AS revenue,
    COALESCE(SUM(CASE WHEN status = 'approved' THEN units ELSE 0 END),0)::int AS units,
    COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END),0)::int AS pending
    FROM orders`;
  const expenseRows = await db`SELECT COALESCE(SUM(amount),0)::float AS expenses FROM expenses`;
  const clientRows = await db`SELECT COUNT(*)::int AS clients FROM clients`;
  const lowStock = await db`SELECT name,stock,low_stock FROM products WHERE active = TRUE AND stock <= low_stock ORDER BY id`;
  json(res, 200, {
    ...statsRows[0],
    expenses: Number(expenseRows[0].expenses || 0),
    clients: Number(clientRows[0].clients || 0),
    low_stock: lowStock,
  });
}

async function listClients(res) {
  const db = getSql();
  const clients = await db`SELECT * FROM clients ORDER BY id DESC LIMIT 500`;
  const out = [];
  for (const client of clients) out.push({ ...client, ...(await publicClient(client)) });
  json(res, 200, out);
}

async function handleGet(req, res, parts) {
  if (parts[0] === 'me') {
    const client = await authClient(req);
    return client ? json(res, 200, await publicClient(client)) : json(res, 401, { error: 'Nao autenticado' });
  }
  if (parts[0] === 'products') return getProducts(res);

  if (parts[0] === 'admin') {
    if (!adminOk(req)) return json(res, 403, { error: 'PIN invalido' });
    if (parts.join('/') === 'admin/orders') {
      const db = getSql();
      const rows = await db`SELECT orders.*, clients.name, clients.phone, clients.address
        FROM orders JOIN clients ON clients.id = orders.client_id
        ORDER BY orders.id DESC LIMIT 100`;
      return json(res, 200, rows);
    }
    if (parts.join('/') === 'admin/erp/products') return getProducts(res, true);
    if (parts.join('/') === 'admin/erp/clients') return listClients(res);
    if (parts.join('/') === 'admin/erp/expenses') {
      const rows = await getSql()`SELECT * FROM expenses ORDER BY id DESC LIMIT 200`;
      return json(res, 200, rows);
    }
    if (parts.join('/') === 'admin/erp/movements') {
      const rows = await getSql()`SELECT m.*, p.name FROM stock_movements m
        LEFT JOIN products p ON p.id = m.product_id ORDER BY m.id DESC LIMIT 100`;
      return json(res, 200, rows);
    }
    if (parts.join('/') === 'admin/erp/dashboard') return dashboard(res);
  }

  return json(res, 404, { error: 'Rota nao encontrada' });
}

async function handleLogin(req, res) {
  const db = getSql();
  const data = await readBody(req);
  const name = String(data.name || '').trim().slice(0, 80);
  const phone = digits(data.phone).slice(0, 13);
  const address = String(data.address || '').trim().slice(0, 180);
  if (name.length < 2 || phone.length < 10 || phone.length > 13) {
    return json(res, 400, { error: 'Informe nome e WhatsApp valido' });
  }

  const existing = await db`SELECT * FROM clients WHERE phone = ${phone} LIMIT 1`;
  const current = await authClient(req);
  if (existing[0] && (!current || Number(current.id) !== Number(existing[0].id))) {
    return json(res, 409, {
      error: 'Este WhatsApp ja possui cadastro. Abra pelo mesmo navegador ou peca ajuda para a loja atualizar seu perfil.',
    });
  }

  const token = newToken();
  if (existing[0]) {
    const savedAddress = address || existing[0].address || '';
    await db`UPDATE clients SET name = ${name}, address = ${savedAddress}, token_hash = ${hashToken(token)}
      WHERE id = ${existing[0].id}`;
  } else {
    await db`INSERT INTO clients(name, phone, address, token_hash)
      VALUES(${name}, ${phone}, ${address}, ${hashToken(token)})`;
  }

  const rows = await db`SELECT * FROM clients WHERE phone = ${phone} LIMIT 1`;
  return json(res, 200, { token, client: await publicClient(rows[0]) });
}

async function createOrder(req, res) {
  const db = getSql();
  const client = await authClient(req);
  if (!client) return json(res, 401, { error: 'Faca seu cadastro primeiro' });

  const data = await readBody(req);
  const items = data.items;
  if (!Array.isArray(items) || !items.length || items.length > 50) return json(res, 400, { error: 'Pedido invalido' });

  let total = 0;
  let units = 0;
  const clean = [];
  for (const item of items) {
    const productId = Number.parseInt(item.product, 10);
    const size = Number.parseInt(item.size, 10);
    const qty = Number.parseInt(item.qty, 10);
    const obs = String(item.obs || '').slice(0, 250);
    if (!productId || ![0, 1].includes(size) || qty < 1 || qty > 29 || item.type !== 'Garrafa') {
      return json(res, 400, { error: 'Item invalido ou indisponivel' });
    }
    const productRows = await db`SELECT price350, price500 FROM products WHERE id = ${productId} AND active = TRUE LIMIT 1`;
    if (!productRows[0]) return json(res, 400, { error: 'Produto indisponivel' });
    const price = Number(size === 0 ? productRows[0].price350 : productRows[0].price500);
    if (!price || price <= 0) return json(res, 400, { error: 'Preco nao cadastrado' });
    total += price * qty;
    units += qty;
    clean.push({ product: productId, size, qty, obs, price, type: 'Garrafa' });
  }
  if (units > 100) return json(res, 400, { error: 'Limite excedido' });

  const rows = await db`INSERT INTO orders(client_id, items, total, units)
    VALUES(${client.id}, ${JSON.stringify(clean)}::jsonb, ${total}, ${units})
    RETURNING id`;
  json(res, 200, { order_id: rows[0].id, total, status: 'pending', whatsapp: STORE_WHATSAPP });
}

async function saveProduct(req, res) {
  const db = getSql();
  const data = await readBody(req);
  const id = Number.parseInt(data.id || 0, 10);
  const name = String(data.name || '').trim().slice(0, 100);
  const description = String(data.description || '').trim().slice(0, 200);
  const category = String(data.category || 'Acai').trim().slice(0, 60);
  const price350 = Number(data.price350 || 0);
  const price500 = Number(data.price500 || 0);
  const cost = Number(data.cost || 0);
  const lowStock = Number(data.low_stock || 5);
  const active = data.active !== false && data.active !== '0';
  if (name.length < 2 || [price350, price500, cost, lowStock].some((v) => !Number.isFinite(v) || v < 0)) {
    return json(res, 400, { error: 'Dados do produto invalidos' });
  }
  if (id) {
    const rows = await db`UPDATE products SET name=${name}, description=${description}, category=${category},
      price350=${price350}, price500=${price500}, cost=${cost}, low_stock=${lowStock}, active=${active}
      WHERE id=${id} RETURNING id`;
    return rows[0] ? json(res, 200, { ok: true }) : json(res, 404, { error: 'Produto nao encontrado' });
  }
  await db`INSERT INTO products(name,description,category,price350,price500,cost,low_stock,active)
    VALUES(${name},${description},${category},${price350},${price500},${cost},${lowStock},${active})`;
  json(res, 200, { ok: true });
}

async function saveStock(req, res) {
  const db = getSql();
  const data = await readBody(req);
  const id = Number.parseInt(data.id, 10);
  const delta = Number(data.delta);
  const reason = String(data.reason || 'Ajuste manual').slice(0, 100);
  if (!id || !Number.isFinite(delta) || delta === 0 || delta < -100000 || delta > 100000) {
    return json(res, 400, { error: 'Movimentacao invalida' });
  }
  const product = await db`SELECT stock FROM products WHERE id=${id} LIMIT 1`;
  if (!product[0]) return json(res, 404, { error: 'Produto nao encontrado' });
  if (Number(product[0].stock) + delta < 0) return json(res, 400, { error: 'Estoque insuficiente' });
  await db`UPDATE products SET stock = stock + ${delta} WHERE id=${id}`;
  await db`INSERT INTO stock_movements(product_id,delta,reason) VALUES(${id},${delta},${reason})`;
  json(res, 200, { ok: true });
}

async function saveExpense(req, res, edit = false) {
  const db = getSql();
  const data = await readBody(req);
  const id = Number.parseInt(data.id || 0, 10);
  const description = String(data.description || '').trim().slice(0, 150);
  const amount = Number(data.amount || 0);
  const category = String(data.category || 'Outros').slice(0, 60);
  if (!description || !Number.isFinite(amount) || amount <= 0 || amount >= 1000000) {
    return json(res, 400, { error: 'Dados da despesa invalidos' });
  }
  if (edit) {
    const rows = await db`UPDATE expenses SET description=${description}, amount=${amount}, category=${category}
      WHERE id=${id} RETURNING id`;
    return rows[0] ? json(res, 200, { ok: true }) : json(res, 404, { error: 'Despesa nao encontrada' });
  }
  await db`INSERT INTO expenses(description,amount,category) VALUES(${description},${amount},${category})`;
  json(res, 200, { ok: true });
}

async function deleteExpense(req, res) {
  const data = await readBody(req);
  const id = Number.parseInt(data.id || 0, 10);
  const rows = await getSql()`DELETE FROM expenses WHERE id=${id} RETURNING id`;
  rows[0] ? json(res, 200, { ok: true }) : json(res, 404, { error: 'Despesa nao encontrada' });
}

async function saveClient(req, res) {
  const db = getSql();
  const data = await readBody(req);
  const id = Number.parseInt(data.id || 0, 10);
  const name = String(data.name || '').trim().slice(0, 80);
  const phone = digits(data.phone).slice(0, 13);
  const address = String(data.address || '').trim().slice(0, 180);
  if (!id || name.length < 2 || phone.length < 10 || phone.length > 13) {
    return json(res, 400, { error: 'Dados do cliente invalidos' });
  }
  const other = await db`SELECT id FROM clients WHERE phone=${phone} AND id<>${id} LIMIT 1`;
  if (other[0]) return json(res, 400, { error: 'Este WhatsApp ja esta em outro cadastro' });
  const rows = await db`UPDATE clients SET name=${name}, phone=${phone}, address=${address} WHERE id=${id} RETURNING id`;
  rows[0] ? json(res, 200, { ok: true }) : json(res, 404, { error: 'Cliente nao encontrado' });
}

async function setOrderStatus(req, res) {
  const data = await readBody(req);
  const id = Number.parseInt(data.id || 0, 10);
  const status = String(data.status || '');
  if (!['pending', 'approved', 'rejected'].includes(status)) return json(res, 400, { error: 'Status invalido' });
  const rows = await getSql()`UPDATE orders SET status=${status} WHERE id=${id} RETURNING id`;
  rows[0] ? json(res, 200, { ok: true }) : json(res, 404, { error: 'Pedido nao encontrado' });
}

async function redeem(req, res) {
  const db = getSql();
  const data = await readBody(req);
  const phone = digits(data.phone);
  const clients = await db`SELECT * FROM clients WHERE phone=${phone} LIMIT 1`;
  if (!clients[0]) return json(res, 404, { error: 'Cliente nao encontrado' });
  const pc = await publicClient(clients[0]);
  if (pc.rewards < 1) return json(res, 400, { error: 'Cliente ainda nao tem premio' });
  await db`INSERT INTO redemptions(client_id) VALUES(${clients[0].id})`;
  json(res, 200, { ok: true, client: await publicClient(clients[0]) });
}

async function handlePost(req, res, parts) {
  const path = parts.join('/');
  if (path === 'login') return handleLogin(req, res);
  if (path === 'orders') return createOrder(req, res);

  if (!path.startsWith('admin/') || !adminOk(req)) {
    return path.startsWith('admin/') ? json(res, 403, { error: 'PIN invalido' }) : json(res, 404, { error: 'Rota nao encontrada' });
  }

  if (path === 'admin/erp/product') return saveProduct(req, res);
  if (path === 'admin/erp/stock') return saveStock(req, res);
  if (path === 'admin/erp/expense') return saveExpense(req, res, false);
  if (path === 'admin/erp/expense_edit') return saveExpense(req, res, true);
  if (path === 'admin/erp/expense_delete') return deleteExpense(req, res);
  if (path === 'admin/erp/client') return saveClient(req, res);
  if (path === 'admin/approve' || path === 'admin/order_status') return setOrderStatus(req, res);
  if (path === 'admin/redeem') return redeem(req, res);
  return json(res, 404, { error: 'Rota nao encontrada' });
}

module.exports = async function handler(req, res) {
  try {
    await ensureSchema();
    const parts = routeFrom(req);
    if (req.method === 'GET') return await handleGet(req, res, parts);
    if (req.method === 'POST') return await handlePost(req, res, parts);
    return json(res, 405, { error: 'Metodo nao permitido' });
  } catch (err) {
    console.error(err);
    json(res, err.status || 500, { error: err.message || 'Erro interno do servidor' });
  }
};
