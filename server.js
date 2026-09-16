const express = require('express');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const app = express();
const db = new Database(path.join(__dirname, 'database.db'));

db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    "Order" TEXT PRIMARY KEY,
    "Status" TEXT,
    "Planned Delivery Date" TEXT
  );

  CREATE TABLE IF NOT EXISTS drivers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    "Order" TEXT NOT NULL,
    driver_name TEXT NOT NULL,
    carrier TEXT NOT NULL DEFAULT '',
    trailer TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL,
    destination TEXT NOT NULL,
    checkin_date TEXT NOT NULL,
    checkin_time TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TEXT NOT NULL
  );
`);

// Seed the default PIN if it doesn't exist yet
(function seedDefaultPin() {
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'pin'`).get();
  if (!row) {
    db.prepare(`INSERT INTO settings (key, value) VALUES ('pin', ?)`).run('1234');
    console.log('Initialized default PIN: 1234');
  }
})();

const SESSION_TTL_MINUTES = 60 * 8; // 8 hours

app.use(express.json());
app.use(express.static(__dirname));
app.use(express.static('public'));
const PORT = process.env.PORT || 8000;

// ═════════════════════════════════════════
//  AUTH HELPERS
// ═════════════════════════════════════════

function getPin() {
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'pin'`).get();
  return row ? row.value : '1234';
}

function issueToken() {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_TTL_MINUTES * 60 * 1000).toISOString();
  db.prepare(`INSERT INTO sessions (token, expires_at) VALUES (?, ?)`).run(token, expires);
  return token;
}

function isValidToken(token) {
  if (!token) return false;
  const row = db.prepare(`SELECT token, expires_at FROM sessions WHERE token = ?`).get(token);
  if (!row) return false;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    db.prepare(`DELETE FROM sessions WHERE token = ?`).run(token);
    return false;
  }
  return true;
}

function requireAuth(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!isValidToken(token)) {
    return res.status(401).json({ error: 'Unauthorized. Please log in again.' });
  }
  next();
}

setInterval(function() {
  const now = new Date().toISOString();
  db.prepare(`DELETE FROM sessions WHERE expires_at < ?`).run(now);
}, 60 * 60 * 1000).unref();

// ═════════════════════════════════════════
//  AUTH ROUTES
// ═════════════════════════════════════════

app.post('/api/pin/verify', (req, res) => {
  const { pin } = req.body || {};
  if (!pin || !/^\d{4}$/.test(String(pin))) {
    return res.json({ valid: false });
  }
  res.json({ valid: String(pin) === getPin() });
});

app.post('/api/pin/login', (req, res) => {
  const { pin } = req.body || {};
  if (!pin || !/^\d{4}$/.test(String(pin))) {
    return res.status(400).json({ error: 'PIN must be 4 digits.' });
  }
  if (String(pin) !== getPin()) {
    return res.status(401).json({ error: 'Incorrect PIN.' });
  }
  const token = issueToken();
  res.json({ token });
});

app.post('/api/pin/logout', (req, res) => {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token) db.prepare(`DELETE FROM sessions WHERE token = ?`).run(token);
  res.json({ success: true });
});

app.post('/api/pin/change', requireAuth, (req, res) => {
  const { currentPin, newPin } = req.body || {};

  if (!currentPin || !newPin) {
    return res.status(400).json({ error: 'Current and new PIN are required.' });
  }
  if (!/^\d{4}$/.test(String(newPin))) {
    return res.status(400).json({ error: 'New PIN must be exactly 4 digits.' });
  }

  try {
    const stored = getPin();
    if (String(currentPin) !== stored) {
      return res.status(401).json({ error: 'Current PIN is incorrect.' });
    }

    db.prepare(`UPDATE settings SET value = ? WHERE key = 'pin'`).run(String(newPin));

    const header = req.headers['authorization'] || '';
    const currentToken = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (currentToken) {
      db.prepare(`DELETE FROM sessions WHERE token != ?`).run(currentToken);
    }

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Unable to change PIN.' });
  }
});

// ═════════════════════════════════════════
//  ORDERS
// ═════════════════════════════════════════

app.get('/api/orders', (req, res) => {
  try {
    const orders = db.prepare(`
      SELECT
        "Order",
        "Status",
        "Planned Delivery Date" AS plannedTime
      FROM orders
      ORDER BY
        CASE WHEN "Planned Delivery Date" IS NULL OR "Planned Delivery Date" = '' THEN 1 ELSE 0 END,
        "Planned Delivery Date" ASC,
        "Order" ASC
    `).all();
    res.json({ orders });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Unable to load orders.' });
  }
});

app.get('/api/orders/:order', (req, res) => {
  const order = String(req.params.order).trim();
  const row = db.prepare(`
    SELECT "Order", "Status"
    FROM orders
    WHERE CAST("Order" AS TEXT) = ?
    LIMIT 1
  `).get(order);
  res.json({
    found: !!row,
    status: row ? row.Status : null,
    order: row ? row.Order : null
  });
});

app.post('/api/orders', requireAuth, (req, res) => {
  const { Order, Status, plannedDeliveryTime } = req.body;

  if (!Order) return res.status(400).json({ error: 'Order is required.' });

  const orderNum = String(Order).trim();

  try {
    const existing = db.prepare(`
      SELECT "Order" FROM orders WHERE CAST("Order" AS TEXT) = ? LIMIT 1
    `).get(orderNum);

    if (existing) {
      return res.status(409).json({
        error: 'Order #' + orderNum + ' already exists.',
        duplicate: true
      });
    }

    db.prepare(`
      INSERT INTO orders ("Order", "Status", "Planned Delivery Date")
      VALUES (?, ?, ?)
    `).run(
      orderNum,
      Status ? String(Status).trim() : 'PENDING',
      plannedDeliveryTime ? String(plannedDeliveryTime).trim() : null
    );

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    if (err.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
      return res.status(409).json({
        error: 'Order #' + orderNum + ' already exists.',
        duplicate: true
      });
    }
    res.status(500).json({ error: 'Unable to save order.' });
  }
});

app.post('/api/orders/bulk', requireAuth, (req, res) => {
  const orders = Array.isArray(req.body.orders) ? req.body.orders : [];
  if (!orders.length) return res.status(400).json({ error: 'No orders provided.' });

  const insert = db.prepare(`
    INSERT INTO orders ("Order", "Status", "Planned Delivery Date")
    VALUES (?, ?, ?)
  `);
  const checkExists = db.prepare(`
    SELECT 1 FROM orders WHERE CAST("Order" AS TEXT) = ? LIMIT 1
  `);

  const result = { inserted: 0, skipped: 0, skippedOrders: [] };

  const insertMany = db.transaction((rows) => {
    for (const o of rows) {
      const orderNum = String(o.Order).trim();
      if (checkExists.get(orderNum)) {
        result.skipped++;
        result.skippedOrders.push(orderNum);
        continue;
      }
      insert.run(
        orderNum,
        o.Status ? String(o.Status).trim() : 'PENDING',
        o.plannedDeliveryTime ? String(o.plannedDeliveryTime).trim() : null
      );
      result.inserted++;
    }
  });

  try {
    insertMany(orders);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Unable to save orders.' });
  }
});

app.delete('/api/orders/:order', requireAuth, (req, res) => {
  const orderNum = String(req.params.order).trim();

  try {
    const removeOrder = db.transaction(() => {
      const existing = db.prepare(`
        SELECT "Order" FROM orders WHERE CAST("Order" AS TEXT) = ? LIMIT 1
      `).get(orderNum);

      if (!existing) throw new Error('Order #' + orderNum + ' was not found.');

      db.prepare(`DELETE FROM drivers WHERE CAST("Order" AS TEXT) = ?`).run(orderNum);
      db.prepare(`DELETE FROM orders  WHERE CAST("Order" AS TEXT) = ?`).run(orderNum);
    });

    removeOrder();
    res.json({ success: true, deletedOrder: orderNum });
  } catch (err) {
    console.error(err);
    if (err.message.indexOf('was not found') !== -1) {
      return res.status(404).json({ error: err.message });
    }
    res.status(500).json({ error: 'Unable to remove order.' });
  }
});

// ═════════════════════════════════════════
//  DRIVERS
// ═════════════════════════════════════════

app.post('/api/check-in', (req, res) => {
  const {
    Order, driver_name, carrier, trailer, phone, destination,
    checkin_date, checkin_time
  } = req.body;

  if (!Order || !driver_name || !carrier || !trailer || !phone || !destination || !checkin_date || !checkin_time) {
    return res.status(400).json({ error: 'All fields are required.' });
  }

  try {
    const checkIn = db.transaction(() => {
      const orderNum = String(Order).trim();

      const order = db.prepare(`
        SELECT "Order" FROM orders WHERE CAST("Order" AS TEXT) = ? LIMIT 1
      `).get(orderNum);

      if (!order) throw new Error('Order #' + Order + ' was not found.');

      const existing = db.prepare(`
        SELECT id, driver_name FROM drivers WHERE CAST("Order" AS TEXT) = ? LIMIT 1
      `).get(orderNum);

      if (existing) {
        throw new Error(
          'Order #' + orderNum + ' is already checked in by ' + existing.driver_name + '.'
        );
      }

      db.prepare(`
        INSERT INTO drivers
          ("Order", driver_name, carrier, trailer, phone, destination, checkin_date, checkin_time)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        orderNum,
        String(driver_name).trim(),
        String(carrier).trim(),
        String(trailer).trim(),
        String(phone).trim(),
        String(destination).trim(),
        String(checkin_date).trim(),
        String(checkin_time).trim()
      );

      db.prepare(`
        UPDATE orders SET "Status" = 'CHECKED IN' WHERE CAST("Order" AS TEXT) = ?
      `).run(orderNum);
    });

    checkIn();
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message || 'Unable to save check-in.' });
  }
});

app.get('/api/drivers', (req, res) => {
  try {
    const drivers = db.prepare(`
      SELECT
        d.id,
        d."Order",
        d.driver_name,
        d.carrier,
        d.trailer,
        d.phone,
        d.destination,
        d.checkin_date,
        d.checkin_time,
        d.created_at,
        o."Planned Delivery Date" AS _plannedDeliveryDate
      FROM drivers d
      LEFT JOIN orders o
        ON CAST(o."Order" AS TEXT) = CAST(d."Order" AS TEXT)
      ORDER BY
        CASE WHEN o."Planned Delivery Date" IS NULL OR o."Planned Delivery Date" = '' THEN 1 ELSE 0 END,
        o."Planned Delivery Date" ASC,
        d.driver_name ASC
    `).all();
    res.json({ drivers });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Unable to load drivers.' });
  }
});

// ─────────────────────────────────────────
//  CLEAR ALL DRIVERS (must be BEFORE /:id)
// ─────────────────────────────────────────
app.delete('/api/drivers', requireAuth, (req, res) => {
  try {
    const clearAll = db.transaction(() => {
      const rows = db.prepare(`SELECT DISTINCT "Order" FROM drivers`).all();
      db.prepare('DELETE FROM drivers').run();
      const delOrder = db.prepare(`DELETE FROM orders WHERE CAST("Order" AS TEXT) = ?`);
      for (const row of rows) delOrder.run(String(row.Order));
      return rows.length;
    });

    const count = clearAll();
    res.json({ success: true, deletedOrders: count });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Unable to clear drivers.' });
  }
});

// ─────────────────────────────────────────
//  REMOVE ONE DRIVER (param route — after the bulk one)
// ─────────────────────────────────────────
app.delete('/api/drivers/:id', requireAuth, (req, res) => {
  try {
    const removeOne = db.transaction((id) => {
      const driver = db.prepare(`
        SELECT "Order" FROM drivers WHERE id = ? LIMIT 1
      `).get(id);

      if (!driver) throw new Error('Driver not found.');

      db.prepare('DELETE FROM drivers WHERE id = ?').run(id);
      db.prepare(`DELETE FROM orders WHERE CAST("Order" AS TEXT) = ?`).run(String(driver.Order));
      return driver.Order;
    });

    const orderNum = removeOne(req.params.id);
    res.json({ success: true, deletedOrder: orderNum });
  } catch (err) {
    console.error(err);
    if (err.message === 'Driver not found.') {
      return res.status(404).json({ error: err.message });
    }
    res.status(500).json({ error: 'Unable to remove driver.' });
  }
});

// ─────────────────────────────────────────
//  REMOVE ALL ORDERS (drivers untouched)
// ─────────────────────────────────────────
app.delete('/api/orders', requireAuth, (req, res) => {
  try {
    const count = db.prepare(`SELECT COUNT(*) AS c FROM orders`).get().c;
    db.prepare(`DELETE FROM orders`).run();
    res.json({ success: true, deletedOrders: count });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Unable to remove all orders.' });
  }
});

// ═════════════════════════════════════════
//  START
// ═════════════════════════════════════════
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Local driver check-in app running at http://192.168.1.222:${PORT}`);
});