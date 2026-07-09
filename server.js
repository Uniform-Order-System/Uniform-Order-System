require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

const db = require('./db');
const { parseOrderMessage } = require('./parser');

const app = express();
app.use(bodyParser.json());
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
  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const message = value?.messages?.[0];

    if (!message) {
      // Could be a status update (delivered/read) rather than a new message - ignore.
      return res.sendStatus(200);
    }

    const fromPhone = message.from; // customer's WhatsApp number
    const contactName = value.contacts?.[0]?.profile?.name || null;
    const text = message.text?.body || '';

    if (text) {
      saveIncomingOrder(text, fromPhone, contactName);
      // Auto-reply confirming receipt (optional but recommended so customer knows it went through)
      await sendWhatsAppReply(fromPhone,
        `Thanks! We've received your order and will confirm shortly. ✅`);
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

function saveIncomingOrder(rawText, phone, contactName) {
  const parsed = parseOrderMessage(rawText, phone);
  const customerName = parsed.customer_name || contactName || null;

  const insertOrder = db.prepare(`
    INSERT INTO orders (customer_name, customer_phone, school_name, raw_message, delivery_date, source, needs_review)
    VALUES (?, ?, ?, ?, ?, 'whatsapp', ?)
  `);
  const result = insertOrder.run(
    customerName, phone, parsed.school_name, rawText, parsed.delivery_date, parsed.needs_review
  );

  const orderId = result.lastInsertRowid;
  const insertItem = db.prepare(`
    INSERT INTO order_items (order_id, item_type, size, quantity) VALUES (?, ?, ?, ?)
  `);
  for (const item of parsed.items) {
    insertItem.run(orderId, item.item_type, item.size, item.quantity);
  }
  return orderId;
}

// ---------------------------------------------------------------------------
// MANUAL ORDER ENTRY (paste a WhatsApp message manually, or key in by hand)
// ---------------------------------------------------------------------------
app.post('/api/orders/manual', (req, res) => {
  const { rawText, phone, contactName } = req.body;
  if (!rawText) return res.status(400).json({ error: 'rawText is required' });
  const orderId = saveIncomingOrder(rawText, phone || 'N/A', contactName);
  res.json({ orderId });
});

// ---------------------------------------------------------------------------
// ORDERS API
// ---------------------------------------------------------------------------
app.get('/api/orders', (req, res) => {
  const { status } = req.query;
  let orders;
  if (status && status !== 'all') {
    orders = db.prepare('SELECT * FROM orders WHERE status = ? ORDER BY created_at DESC').all(status);
  } else {
    orders = db.prepare('SELECT * FROM orders ORDER BY created_at DESC').all();
  }
  const itemsStmt = db.prepare('SELECT * FROM order_items WHERE order_id = ?');
  const withItems = orders.map(o => ({ ...o, items: itemsStmt.all(o.id) }));
  res.json(withItems);
});

app.get('/api/orders/:id', (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Not found' });
  order.items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id);
  res.json(order);
});

app.put('/api/orders/:id', (req, res) => {
  const { status, customer_name, school_name, delivery_date, notes } = req.body;
  db.prepare(`
    UPDATE orders SET
      status = COALESCE(?, status),
      customer_name = COALESCE(?, customer_name),
      school_name = COALESCE(?, school_name),
      delivery_date = COALESCE(?, delivery_date),
      notes = COALESCE(?, notes),
      needs_review = 0,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(status, customer_name, school_name, delivery_date, notes, req.params.id);
  res.json({ success: true });
});

app.put('/api/orders/:id/items', (req, res) => {
  const { items } = req.body; // full replacement list
  const del = db.prepare('DELETE FROM order_items WHERE order_id = ?');
  const ins = db.prepare('INSERT INTO order_items (order_id, item_type, size, quantity, unit_price) VALUES (?, ?, ?, ?, ?)');
  const tx = db.transaction((items) => {
    del.run(req.params.id);
    for (const it of items) {
      ins.run(req.params.id, it.item_type, it.size, it.quantity, it.unit_price || 0);
    }
  });
  tx(items);
  res.json({ success: true });
});

app.delete('/api/orders/:id', (req, res) => {
  db.prepare('DELETE FROM order_items WHERE order_id = ?').run(req.params.id);
  db.prepare('DELETE FROM orders WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ---------------------------------------------------------------------------
// INVENTORY API
// ---------------------------------------------------------------------------
app.get('/api/inventory', (req, res) => {
  res.json(db.prepare('SELECT * FROM inventory ORDER BY item_type, size').all());
});

app.post('/api/inventory', (req, res) => {
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

app.put('/api/inventory/:id/adjust', (req, res) => {
  const { delta } = req.body; // e.g. -5 when stock used, +50 when restocked
  db.prepare('UPDATE inventory SET stock_qty = stock_qty + ? WHERE id = ?').run(delta, req.params.id);
  res.json({ success: true });
});

app.delete('/api/inventory/:id', (req, res) => {
  db.prepare('DELETE FROM inventory WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ---------------------------------------------------------------------------
// BILLING / INVOICES API
// ---------------------------------------------------------------------------
app.post('/api/orders/:id/invoice', (req, res) => {
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

app.get('/api/invoices', (req, res) => {
  const rows = db.prepare(`
    SELECT invoices.*, orders.customer_name, orders.school_name
    FROM invoices JOIN orders ON invoices.order_id = orders.id
    ORDER BY invoices.created_at DESC
  `).all();
  res.json(rows);
});

app.put('/api/invoices/:id/payment', (req, res) => {
  const { paid_amount } = req.body;
  const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(req.params.id);
  if (!invoice) return res.status(404).json({ error: 'Not found' });
  const status = paid_amount >= invoice.total ? 'paid' : (paid_amount > 0 ? 'partial' : 'unpaid');
  db.prepare('UPDATE invoices SET paid_amount = ?, payment_status = ? WHERE id = ?')
    .run(paid_amount, status, req.params.id);
  res.json({ success: true, status });
});

// Generate a downloadable PDF invoice
app.get('/api/invoices/:id/pdf', (req, res) => {
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
app.get('/api/stats', (req, res) => {
  const totalOrders = db.prepare('SELECT COUNT(*) c FROM orders').get().c;
  const pending = db.prepare("SELECT COUNT(*) c FROM orders WHERE status = 'pending'").get().c;
  const needsReview = db.prepare('SELECT COUNT(*) c FROM orders WHERE needs_review = 1').get().c;
  const lowStock = db.prepare('SELECT COUNT(*) c FROM inventory WHERE stock_qty <= reorder_level').get().c;
  const unpaidTotal = db.prepare("SELECT COALESCE(SUM(total-paid_amount),0) s FROM invoices WHERE payment_status != 'paid'").get().s;
  res.json({ totalOrders, pending, needsReview, lowStock, unpaidTotal });
});

app.listen(PORT, () => {
  console.log(`Uniform Order System running on http://localhost:${PORT}`);
});
