const Database = require('better-sqlite3');
const path = require('path');

// DB_PATH lets you point at a persistent disk in production (e.g. Render:
// /var/data/uniforms.db). Defaults to a local file for development.
const dbPath = process.env.DB_PATH || path.join(__dirname, 'uniforms.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_number TEXT,                    -- auto-generated, e.g. ORD-2026-0007
  order_date TEXT,                      -- date the order was placed (editable, defaults to today)
  customer_name TEXT,                   -- "Party Name"
  customer_phone TEXT,                  -- "Mobile Number"
  school_name TEXT,
  spoc TEXT,                            -- School point of contact
  raw_message TEXT,
  status TEXT DEFAULT 'pending',        -- pending | confirmed | in_production | ready | delivered | cancelled
  delivery_date TEXT,
  notes TEXT,                           -- "Extra Remarks"
  source TEXT DEFAULT 'whatsapp',       -- whatsapp | manual
  needs_review INTEGER DEFAULT 0,       -- 1 if parser wasn't confident, business owner should verify
  image_data TEXT,                      -- base64 image data, if order arrived as a photo
  image_mime TEXT,                      -- e.g. image/jpeg
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  item_type TEXT,       -- "Item Name" e.g. Shirt, Pinafore, Trouser, Tie
  category TEXT,        -- e.g. Boys Wear, Girls Wear, Sportswear, Winterwear
  size TEXT,             -- e.g. 32, M, 8-9yr
  color TEXT,
  quantity INTEGER DEFAULT 1,
  unit_price REAL DEFAULT 0,
  FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS inventory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_type TEXT NOT NULL,
  size TEXT NOT NULL,
  fabric TEXT,
  stock_qty INTEGER DEFAULT 0,
  reorder_level INTEGER DEFAULT 10,
  unit_cost REAL DEFAULT 0,
  UNIQUE(item_type, size)
);

CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  invoice_number TEXT UNIQUE,
  subtotal REAL DEFAULT 0,
  tax REAL DEFAULT 0,
  total REAL DEFAULT 0,
  paid_amount REAL DEFAULT 0,
  payment_status TEXT DEFAULT 'unpaid', -- unpaid | partial | paid
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY(order_id) REFERENCES orders(id)
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT DEFAULT 'staff',    -- admin | staff
  created_at TEXT DEFAULT (datetime('now'))
);
`);

// Migration: add columns if this database was created before they existed
const migrateColumn = (table, col, type) => {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`); } catch (e) { /* already exists */ }
};
migrateColumn('orders', 'image_data', 'TEXT');
migrateColumn('orders', 'image_mime', 'TEXT');
migrateColumn('orders', 'order_number', 'TEXT');
migrateColumn('orders', 'order_date', 'TEXT');
migrateColumn('orders', 'spoc', 'TEXT');
migrateColumn('order_items', 'category', 'TEXT');
migrateColumn('order_items', 'color', 'TEXT');

module.exports = db;
