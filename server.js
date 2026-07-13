require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const session = require('express-session');
const bcrypt = require('bcryptjs');

const db = require('./db');
const { parseOrderMessage } = require('./parser');

const app = express();
app.use(bodyParser.json());

app.use(session({
  secret: process.env.SESSION_SECRET || 'please-set-a-real-SESSION_SECRET-in-env',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 } // 7 days
}));

// ---------------------------------------------------------------------------
// AUTH
// ---------------------------------------------------------------------------
function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  return res.status(401).json({ error: 'Not authenticated' });
}
function requireAdmin(req, res, next) {
  if (req.session && req.session.user && req.session.user.role === 'admin') return next();
  return res.status(403).json({ error: 'Admin access required' });
}

// Create a default admin account on first run, if no users exist yet.
// Change this password immediately after logging in (see the Users tab).
const userCount = db.prepare('SELECT COUNT(*) c FROM users').get().c;
if (userCount === 0) {
  const defaultUsername = process.env.ADMIN_USERNAME || 'admin';
  const defaultPassword = process.env.ADMIN_PASSWORD || 'changeme123';
  const hash = bcrypt.hashSync(defaultPassword, 10);
  db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run(defaultUsername, hash, 'admin');
  console.log(`No users found. Created default admin "${defaultUsername}". Log in and change the password from the Users tab immediately - or set ADMIN_USERNAME/ADMIN_PASSWORD in your environment before first run.`);
}

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  req.session.user = { id: user.id, username: user.username, role: user.role };
  res.json({ success: true, username: user.username, role: user.role });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

app.get('/api/me', (req, res) => {
  if (req.session && req.session.user) return res.json(req.session.user);
  res.status(401).json({ error: 'Not authenticated' });
});

// ---------------------------------------------------------------------------
// USER MANAGEMENT (admin only)
// ---------------------------------------------------------------------------
app.get('/api/users', requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT id, username, role, created_at FROM users ORDER BY created_at').all());
});

app.post('/api/users', requireAdmin, (req, res) => {
  const { username, password, role } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  try {
    const hash = bcrypt.hashSync(password, 10);
    db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)')
      .run(username, hash, role === 'admin' ? 'admin' : 'staff');
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: 'That username is already taken' });
  }
});

app.put('/api/users/:id/password', requireAdmin, (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(password, 10), req.params.id);
  res.json({ success: true });
});

app.delete('/api/users/:id', requireAdmin, (req, res) => {
  if (Number(req.params.id) === req.session.user.id) {
    return res.status(400).json({ error: "You can't delete your own account while logged in as it" });
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ---------------------------------------------------------------------------
// STATIC FILES - login page is public; the dashboard requires a session
// ---------------------------------------------------------------------------
app.get(['/', '/index.html'], (req, res, next) => {
  if (!req.session || !req.session.user) return res.redirect('/login.html');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || 'change-me-verify-token';
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;

// ---------------------------------------------------------------------------
// WHATSAPP WEBHOOK
// ---------------------------------------------------------------------------

// Meta calls this once when you set up the webhook, to verify you own the URL.
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook verified.');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// Meta POSTs every incoming WhatsApp message here.
app.post('/webhook', async (req, res) => {
  console.log('--- Incoming webhook POST ---');
  console.log(JSON.stringify(req.body, null, 2));
  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const message = value?.messages?.[0];

    if (!message) {
      console.log('No message in payload (likely a status update) - ignoring.');
      return res.sendStatus(200);
    }

    const fromPhone = message.from; // customer's WhatsApp number
    const contactName = value.contacts?.[0]?.profile?.name || null;
    const text = message.text?.body || '';

    if (text) {
      const orderId = saveIncomingOrder(text, fromPhone, contactName);
      console.log(`Saved as order #${orderId}`);
      // Auto-reply confirming receipt (optional but recommended so customer knows it went through)
      await sendWhatsAppReply(fromPhone,
        `Thanks! We've received your order and will confirm shortly. ✅`);
    } else if (message.type === 'image') {
      const caption = message.image?.caption || '';
      const orderId = await saveIncomingImageOrder(message.image.id, caption, fromPhone, contactName);
      console.log(`Saved image order #${orderId}`);
      await sendWhatsAppReply(fromPhone,
        `Thanks! We've received your order photo and will review it shortly. ✅`);
    } else {
      console.log(`Unhandled message type: ${message.type} - ignoring.`);
    }

    return res.sendStatus(200);
  } catch (err) {
    console.error('Webhook error:', err.message);
    return res.sendStatus(200); // Always 200 so Meta doesn't retry/disable the webhook
  }
});

async function sendWhatsAppReply(toPhone, bodyText) {
  if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) return; // not configured yet, skip silently
  try {
    await axios.post(
      `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: toPhone,
        text: { body: bodyText }
      },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
    );
  } catch (err) {
    console.error('Failed to send WhatsApp reply:', err.response?.data || err.message);
  }
}

async function saveIncomingImageOrder(mediaId, caption, phone, contactName) {
  let imageData = null;
  let imageMime = null;

  if (WHATSAPP_TOKEN) {
    try {
      // Step 1: get the temporary media URL from Meta
      const mediaInfo = await axios.get(
        `https://graph.facebook.com/v20.0/${mediaId}`,
        { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
      );
      // Step 2: download the actual image bytes from that URL
      const mediaFile = await axios.get(mediaInfo.data.url, {
        headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
        responseType: 'arraybuffer'
      });
      imageData = Buffer.from(mediaFile.data).toString('base64');
      imageMime = mediaInfo.data.mime_type || 'image/jpeg';
    } catch (err) {
      console.error('Failed to download WhatsApp image:', err.response?.data || err.message);
    }
  }

  const insertOrder = db.prepare(`
    INSERT INTO orders (order_number, order_date, customer_name, customer_phone, raw_message, source, needs_review, image_data, image_mime)
    VALUES (?, ?, ?, ?, ?, 'whatsapp', 1, ?, ?)
  `);
  const result = insertOrder.run(
    generateOrderNumber(), new Date().toISOString().slice(0, 10), contactName, phone,
    caption ? `[Order sent as photo] ${caption}` : '[Order sent as photo - see image]',
    imageData, imageMime
  );
  return result.lastInsertRowid;
}

function generateOrderNumber() {
  const year = new Date().getFullYear();
  const countThisYear = db.prepare(`
    SELECT COUNT(*) c FROM orders WHERE order_number LIKE ?
  `).get(`ORD-${year}-%`).c;
  const next = String(countThisYear + 1).padStart(4, '0');
  return `ORD-${year}-${next}`;
}

function saveIncomingOrder(rawText, phone, contactName) {
  const parsed = parseOrderMessage(rawText, phone);
  const customerName = parsed.customer_name || contactName || null;
  const today = new Date().toISOString().slice(0, 10);

  const insertOrder = db.prepare(`
    INSERT INTO orders (order_number, order_date, customer_name, customer_phone, school_name, raw_message, delivery_date, source, needs_review)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'whatsapp', ?)
  `);
  const result = insertOrder.run(
    generateOrderNumber(), today, customerName, phone, parsed.school_name, rawText, parsed.delivery_date, parsed.needs_review
  );

  const orderId = result.lastInsertRowid;
  const insertItem = db.prepare(`
    INSERT INTO order_items (order_id, item_type, size, quantity, color) VALUES (?, ?, ?, ?, ?)
  `);
  for (const item of parsed.items) {
    insertItem.run(orderId, item.item_type, item.size, item.quantity, item.color || null);
  }
  return orderId;
}

// ---------------------------------------------------------------------------
// MANUAL ORDER ENTRY - structured form (Party Name, Order Date, Mobile, School, SPOC, Items, Remarks)
// ---------------------------------------------------------------------------
app.post('/api/orders/manual', requireAuth, (req, res) => {
  const { partyName, mobileNumber, schoolName, spoc, orderDate, remarks, deliveryDate, items } = req.body;
  if (!partyName) return res.status(400).json({ error: 'Party name is required' });
  if (!items || items.length === 0) return res.status(400).json({ error: 'At least one item is required' });

  const insertOrder = db.prepare(`
    INSERT INTO orders (order_number, order_date, customer_name, customer_phone, school_name, spoc, notes, delivery_date, source, needs_review)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manual', 0)
  `);
  const result = insertOrder.run(
    generateOrderNumber(),
    orderDate || new Date().toISOString().slice(0, 10),
    partyName, mobileNumber || null, schoolName || null, spoc || null, remarks || null, deliveryDate || null
  );

  const orderId = result.lastInsertRowid;
  const insertItem = db.prepare(`
    INSERT INTO order_items (order_id, item_type, category, size, color, quantity) VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const item of items) {
    insertItem.run(orderId, item.itemName, item.category || null, item.size || null, item.color || null, item.quantity || 1);
  }
  res.json({ orderId });
});

// ---------------------------------------------------------------------------
// ORDERS API
// ---------------------------------------------------------------------------
app.get('/api/orders', requireAuth, (req, res) => {
  const { status } = req.query;
  const cols = 'id, order_number, order_date, customer_name, customer_phone, school_name, spoc, raw_message, status, delivery_date, notes, source, needs_review, image_mime, created_at, updated_at, (image_data IS NOT NULL) as has_image';
  let orders;
  if (status && status !== 'all') {
    orders = db.prepare(`SELECT ${cols} FROM orders WHERE status = ? ORDER BY created_at DESC`).all(status);
  } else {
    orders = db.prepare(`SELECT ${cols} FROM orders ORDER BY created_at DESC`).all();
  }
  const itemsStmt = db.prepare('SELECT * FROM order_items WHERE order_id = ?');
  const withItems = orders.map(o => ({ ...o, items: itemsStmt.all(o.id) }));
  res.json(withItems);
});

// Serve just the image for a given order (kept separate from /api/orders so the
// orders list stays light - images can be a few hundred KB each)
app.get('/api/orders/:id/image', requireAuth, (req, res) => {
  const row = db.prepare('SELECT image_data, image_mime FROM orders WHERE id = ?').get(req.params.id);
  if (!row || !row.image_data) return res.status(404).send('No image for this order');
  res.setHeader('Content-Type', row.image_mime || 'image/jpeg');
  res.send(Buffer.from(row.image_data, 'base64'));
});

app.get('/api/orders/:id', requireAuth, (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Not found' });
  order.items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id);
  res.json(order);
});

app.put('/api/orders/:id', requireAuth, (req, res) => {
  const { status, customer_name, school_name, spoc, delivery_date, order_date, notes } = req.body;
  db.prepare(`
    UPDATE orders SET
      status = COALESCE(?, status),
      customer_name = COALESCE(?, customer_name),
      school_name = COALESCE(?, school_name),
      spoc = COALESCE(?, spoc),
      delivery_date = COALESCE(?, delivery_date),
      order_date = COALESCE(?, order_date),
      notes = COALESCE(?, notes),
      needs_review = 0,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(status, customer_name, school_name, spoc, delivery_date, order_date, notes, req.params.id);
  res.json({ success: true });
});

app.put('/api/orders/:id/items', requireAuth, (req, res) => {
  const { items } = req.body; // full replacement list
  const del = db.prepare('DELETE FROM order_items WHERE order_id = ?');
  const ins = db.prepare('INSERT INTO order_items (order_id, item_type, category, size, color, quantity, unit_price) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const tx = db.transaction((items) => {
    del.run(req.params.id);
    for (const it of items) {
      ins.run(req.params.id, it.item_type, it.category || null, it.size, it.color || null, it.quantity, it.unit_price || 0);
    }
  });
  tx(items);
  res.json({ success: true });
});

app.delete('/api/orders/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM order_items WHERE order_id = ?').run(req.params.id);
  db.prepare('DELETE FROM orders WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ---------------------------------------------------------------------------
// INVENTORY API
// ---------------------------------------------------------------------------
app.get('/api/inventory', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM inventory ORDER BY item_type, size').all());
});

app.post('/api/inventory', requireAdmin, (req, res) => {
  const { item_type, size, fabric, stock_qty, reorder_level, unit_cost } = req.body;
  db.prepare(`
    INSERT INTO inventory (item_type, size, fabric, stock_qty, reorder_level, unit_cost)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(item_type, size) DO UPDATE SET
      fabric = excluded.fabric,
      stock_qty = excluded.stock_qty,
      reorder_level = excluded.reorder_level,
      unit_cost = excluded.unit_cost
  `).run(item_type, size, fabric || null, stock_qty || 0, reorder_level || 10, unit_cost || 0);
  res.json({ success: true });
});

app.put('/api/inventory/:id/adjust', requireAuth, (req, res) => {
  const { delta } = req.body; // e.g. -5 when stock used, +50 when restocked
  db.prepare('UPDATE inventory SET stock_qty = stock_qty + ? WHERE id = ?').run(delta, req.params.id);
  res.json({ success: true });
});

app.delete('/api/inventory/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM inventory WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ---------------------------------------------------------------------------
// BILLING / INVOICES API
// ---------------------------------------------------------------------------
app.post('/api/orders/:id/invoice', requireAdmin, (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id);

  const subtotal = items.reduce((sum, it) => sum + (it.unit_price * it.quantity), 0);
  const taxRate = parseFloat(req.body.taxRate ?? 0);
  const tax = subtotal * (taxRate / 100);
  const total = subtotal + tax;
  const invoiceNumber = `INV-${new Date().getFullYear()}-${String(order.id).padStart(4, '0')}`;

  const existing = db.prepare('SELECT * FROM invoices WHERE order_id = ?').get(order.id);
  if (existing) {
    db.prepare('UPDATE invoices SET subtotal=?, tax=?, total=? WHERE id=?')
      .run(subtotal, tax, total, existing.id);
  } else {
    db.prepare(`
      INSERT INTO invoices (order_id, invoice_number, subtotal, tax, total)
      VALUES (?, ?, ?, ?, ?)
    `).run(order.id, invoiceNumber, subtotal, tax, total);
  }
  res.json({ invoiceNumber, subtotal, tax, total });
});

app.get('/api/invoices', requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT invoices.*, orders.customer_name, orders.school_name
    FROM invoices JOIN orders ON invoices.order_id = orders.id
    ORDER BY invoices.created_at DESC
  `).all();
  res.json(rows);
});

app.put('/api/invoices/:id/payment', requireAdmin, (req, res) => {
  const { paid_amount } = req.body;
  const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(req.params.id);
  if (!invoice) return res.status(404).json({ error: 'Not found' });
  const status = paid_amount >= invoice.total ? 'paid' : (paid_amount > 0 ? 'partial' : 'unpaid');
  db.prepare('UPDATE invoices SET paid_amount = ?, payment_status = ? WHERE id = ?')
    .run(paid_amount, status, req.params.id);
  res.json({ success: true, status });
});

// Generate a downloadable PDF invoice
app.get('/api/invoices/:id/pdf', requireAdmin, (req, res) => {
  const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(req.params.id);
  if (!invoice) return res.status(404).send('Not found');
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(invoice.order_id);
  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id);

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename=${invoice.invoice_number}.pdf`);

  const doc = new PDFDocument({ margin: 50 });
  doc.pipe(res);

  doc.fontSize(20).text('INVOICE', { align: 'right' });
  doc.fontSize(10).text(invoice.invoice_number, { align: 'right' });
  doc.moveDown();
  doc.fontSize(12).text(`Customer: ${order.customer_name || 'N/A'}`);
  doc.text(`School: ${order.school_name || 'N/A'}`);
  doc.text(`Date: ${invoice.created_at}`);
  doc.moveDown();

  doc.font('Helvetica-Bold');
  doc.text('Item', 50, doc.y, { continued: true, width: 200 });
  doc.text('Size', 250, doc.y, { continued: true, width: 100 });
  doc.text('Qty', 350, doc.y, { continued: true, width: 60 });
  doc.text('Unit Price', 410, doc.y, { continued: true, width: 80 });
  doc.text('Total', 490);
  doc.font('Helvetica');
  doc.moveDown(0.5);

  items.forEach(it => {
    const lineTotal = it.unit_price * it.quantity;
    doc.text(it.item_type, 50, doc.y, { continued: true, width: 200 });
    doc.text(it.size || '-', 250, doc.y, { continued: true, width: 100 });
    doc.text(String(it.quantity), 350, doc.y, { continued: true, width: 60 });
    doc.text(it.unit_price.toFixed(2), 410, doc.y, { continued: true, width: 80 });
    doc.text(lineTotal.toFixed(2), 490);
  });

  doc.moveDown();
  doc.text(`Subtotal: ${invoice.subtotal.toFixed(2)}`, { align: 'right' });
  doc.text(`Tax: ${invoice.tax.toFixed(2)}`, { align: 'right' });
  doc.font('Helvetica-Bold').text(`Total: ${invoice.total.toFixed(2)}`, { align: 'right' });

  doc.end();
});

// ---------------------------------------------------------------------------
// DASHBOARD STATS
// ---------------------------------------------------------------------------
app.get('/api/stats', requireAuth, (req, res) => {
  const totalOrders = db.prepare('SELECT COUNT(*) c FROM orders').get().c;
  const pending = db.prepare("SELECT COUNT(*) c FROM orders WHERE status = 'pending'").get().c;
  const needsReview = db.prepare('SELECT COUNT(*) c FROM orders WHERE needs_review = 1').get().c;
  const lowStock = db.prepare('SELECT COUNT(*) c FROM inventory WHERE stock_qty <= reorder_level').get().c;
  const unpaidTotal = db.prepare("SELECT COALESCE(SUM(total-paid_amount),0) s FROM invoices WHERE payment_status != 'paid'").get().s;
  res.json({ totalOrders, pending, needsReview, lowStock, unpaidTotal });
});

// ---------------------------------------------------------------------------
// ITEM ABBREVIATIONS API
// ---------------------------------------------------------------------------
app.get('/api/abbreviations', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM item_abbreviations ORDER BY item_type').all());
});

app.post('/api/abbreviations', requireAdmin, (req, res) => {
  const { item_type, abbreviation } = req.body;
  if (!item_type || !abbreviation) return res.status(400).json({ error: 'Both fields required' });
  try {
    db.prepare('INSERT INTO item_abbreviations (item_type, abbreviation) VALUES (?, ?)').run(item_type.trim(), abbreviation.trim().toUpperCase());
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: 'That item type already exists' });
  }
});

app.put('/api/abbreviations/:id', requireAdmin, (req, res) => {
  const { item_type, abbreviation } = req.body;
  db.prepare('UPDATE item_abbreviations SET item_type = ?, abbreviation = ? WHERE id = ?')
    .run(item_type.trim(), abbreviation.trim().toUpperCase(), req.params.id);
  res.json({ success: true });
});

app.delete('/api/abbreviations/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM item_abbreviations WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ---------------------------------------------------------------------------
// PRODUCT MASTER API
// ---------------------------------------------------------------------------
app.get('/api/products', requireAuth, (req, res) => {
  const { category, search } = req.query;
  let query = 'SELECT * FROM products WHERE active = 1';
  const params = [];
  if (category) { query += ' AND product_category = ?'; params.push(category); }
  if (search) { query += ' AND (item_name LIKE ? OR fabric_code LIKE ? OR stitching_pattern LIKE ?)'; params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
  query += ' ORDER BY product_category, item_name';
  res.json(db.prepare(query).all(...params));
});

app.get('/api/products/categories', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT DISTINCT product_category FROM products WHERE active = 1 ORDER BY product_category').all();
  res.json(rows.map(r => r.product_category));
});

app.post('/api/products', requireAdmin, (req, res) => {
  const { product_category, item_name, fabric_code, size, stitching_pattern, decoration, unit_price, remarks } = req.body;
  if (!product_category || !item_name) return res.status(400).json({ error: 'Product category and item name are required' });
  const result = db.prepare(`
    INSERT INTO products (product_category, item_name, fabric_code, size, stitching_pattern, decoration, unit_price, remarks)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(product_category, item_name, fabric_code || null, size || null, stitching_pattern || null, decoration || null, unit_price || 0, remarks || null);
  res.json({ id: result.lastInsertRowid });
});

app.put('/api/products/:id', requireAdmin, (req, res) => {
  const { product_category, item_name, fabric_code, size, stitching_pattern, decoration, unit_price, remarks } = req.body;
  db.prepare(`
    UPDATE products SET
      product_category = COALESCE(?, product_category),
      item_name = COALESCE(?, item_name),
      fabric_code = ?,
      size = ?,
      stitching_pattern = ?,
      decoration = ?,
      unit_price = COALESCE(?, unit_price),
      remarks = ?
    WHERE id = ?
  `).run(product_category, item_name, fabric_code || null, size || null, stitching_pattern || null, decoration || null, unit_price, remarks || null, req.params.id);
  res.json({ success: true });
});

app.delete('/api/products/:id', requireAdmin, (req, res) => {
  // Soft delete — keeps history intact
  db.prepare('UPDATE products SET active = 0 WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ---------------------------------------------------------------------------
// REPORTS API
// ---------------------------------------------------------------------------
app.get('/api/reports', requireAdmin, (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from and to dates required (YYYY-MM-DD)' });
  const toInclusive = to + ' 23:59:59';

  const orderCount = db.prepare(`
    SELECT COUNT(*) c FROM orders WHERE created_at BETWEEN ? AND ?
  `).get(from, toInclusive).c;

  const statusBreakdown = db.prepare(`
    SELECT status, COUNT(*) c FROM orders WHERE created_at BETWEEN ? AND ? GROUP BY status
  `).all(from, toInclusive);

  const itemBreakdown = db.prepare(`
    SELECT oi.item_type, SUM(oi.quantity) total_qty, COUNT(DISTINCT oi.order_id) order_count
    FROM order_items oi
    JOIN orders o ON oi.order_id = o.id
    WHERE o.created_at BETWEEN ? AND ?
    GROUP BY oi.item_type
    ORDER BY total_qty DESC
  `).all(from, toInclusive);

  const revenue = db.prepare(`
    SELECT COALESCE(SUM(i.total),0) totalBilled, COALESCE(SUM(i.paid_amount),0) totalPaid
    FROM invoices i JOIN orders o ON i.order_id = o.id
    WHERE o.created_at BETWEEN ? AND ?
  `).get(from, toInclusive);

  const schoolBreakdown = db.prepare(`
    SELECT COALESCE(school_name, 'Unspecified') school_name, COUNT(*) c
    FROM orders WHERE created_at BETWEEN ? AND ?
    GROUP BY school_name ORDER BY c DESC LIMIT 10
  `).all(from, toInclusive);

  res.json({ orderCount, statusBreakdown, itemBreakdown, revenue, schoolBreakdown });
});

app.get('/api/reports/csv', requireAdmin, (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).send('from and to dates required');
  const toInclusive = to + ' 23:59:59';

  const rows = db.prepare(`
    SELECT o.id, o.created_at, o.customer_name, o.customer_phone, o.school_name,
           o.status, o.delivery_date, oi.item_type, oi.size, oi.quantity
    FROM orders o
    LEFT JOIN order_items oi ON oi.order_id = o.id
    WHERE o.created_at BETWEEN ? AND ?
    ORDER BY o.created_at
  `).all(from, toInclusive);

  const header = 'Order ID,Date,Customer,Phone,School,Status,Delivery Date,Item,Size,Quantity\n';
  const csvBody = rows.map(r => [
    r.id, r.created_at, r.customer_name || '', r.customer_phone || '', r.school_name || '',
    r.status, r.delivery_date || '', r.item_type || '', r.size || '', r.quantity || ''
  ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename=orders_${from}_to_${to}.csv`);
  res.send(header + csvBody);
});

app.listen(PORT, () => {
  console.log(`Uniform Order System running on http://localhost:${PORT}`);
});
