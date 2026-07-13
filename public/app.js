const state = { statusFilter: 'all', currentUser: null };

// Redirect to login automatically if any API call comes back unauthenticated
const _origFetch = window.fetch;
window.fetch = async (...args) => {
  const res = await _origFetch(...args);
  if (res.status === 401 && !args[0].includes('/api/login')) {
    window.location.href = '/login.html';
  }
  return res;
};

async function initAuth() {
  const me = await fetch('/api/me').then(r => r.ok ? r.json() : null);
  if (!me) return; // fetch wrapper above already redirects on 401
  state.currentUser = me;
  document.getElementById('account-name').textContent = `${me.username} (${me.role})`;
  if (me.role !== 'admin') {
    document.querySelectorAll('[data-tab="billing"], [data-tab="reports"], #nav-users').forEach(el => el.style.display = 'none');
  }
}

document.getElementById('btn-logout').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  window.location.href = '/login.html';
});

// ---------- Tab switching ----------
document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
  });
});

// ---------- Stats ----------
async function loadStats() {
  const s = await fetch('/api/stats').then(r => r.json());
  document.getElementById('stats').innerHTML = `
    <div class="stat-row"><span>Total orders</span><b>${s.totalOrders}</b></div>
    <div class="stat-row"><span>Pending</span><b>${s.pending}</b></div>
    <div class="stat-row ${s.needsReview ? 'warn' : ''}"><span>Needs review</span><b>${s.needsReview}</b></div>
    <div class="stat-row ${s.lowStock ? 'warn' : ''}"><span>Low stock lines</span><b>${s.lowStock}</b></div>
    <div class="stat-row"><span>Unpaid (₹)</span><b>${s.unpaidTotal.toFixed(0)}</b></div>
  `;
}

// ---------- Orders ----------
document.querySelectorAll('.chip').forEach(chip => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    state.statusFilter = chip.dataset.status;
    loadOrders();
  });
});

async function loadOrders() {
  const orders = await fetch('/api/orders?status=' + state.statusFilter).then(r => r.json());
  const el = document.getElementById('orders-list');
  if (orders.length === 0) {
    el.innerHTML = `<p class="subtle">No orders here yet. Orders from WhatsApp will appear automatically, or add one manually.</p>`;
    return;
  }
  el.innerHTML = orders.map(orderCard).join('');

  el.querySelectorAll('[data-status-change]').forEach(sel => {
    sel.addEventListener('change', async () => {
      await fetch(`/api/orders/${sel.dataset.statusChange}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: sel.value })
      });
      loadOrders(); loadStats();
    });
  });

  el.querySelectorAll('[data-delete-order]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this order?')) return;
      await fetch(`/api/orders/${btn.dataset.deleteOrder}`, { method: 'DELETE' });
      loadOrders(); loadStats();
    });
  });

  el.querySelectorAll('[data-make-invoice]').forEach(btn => {
    btn.addEventListener('click', async () => {
      await fetch(`/api/orders/${btn.dataset.makeInvoice}/invoice`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taxRate: 0 })
      });
      alert('Invoice created — check the Billing tab.');
      loadInvoices();
    });
  });
}

function orderCard(o) {
  const itemsHtml = o.items.map(it => {
    const parts = [it.item_type];
    if (it.category) parts.push(it.category);
    if (it.color) parts.push(it.color);
    parts.push(it.size || '?');
    return `<span class="item-tag">${parts.join(' · ')} × ${it.quantity}</span>`;
  }).join('');

  return `
    <div class="order-card ${o.needs_review ? 'review' : ''}">
      <div class="order-top">
        <div>
          <div class="order-id">${o.order_number || 'ORDER #' + o.id} · ${o.order_date || new Date(o.created_at).toLocaleDateString()}</div>
          <div class="order-customer">${o.customer_name || 'Unnamed customer'} ${o.customer_phone ? '· ' + o.customer_phone : ''}</div>
          ${o.school_name ? `<div class="order-school">${o.school_name}${o.spoc ? ' · SPOC: ' + o.spoc : ''}</div>` : ''}
        </div>
        <div class="order-meta">
          ${o.needs_review ? '<span class="badge review">Needs review</span>' : ''}
          <select class="status-select" data-status-change="${o.id}">
            ${['pending','confirmed','in_production','ready','delivered','cancelled'].map(s =>
              `<option value="${s}" ${s === o.status ? 'selected' : ''}>${s.replace('_',' ')}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="order-items">${itemsHtml || '<span class="subtle">No items parsed — check raw message or photo below</span>'}</div>
      ${o.has_image ? `<img class="order-photo" src="/api/orders/${o.id}/image" alt="Order photo" onclick="window.open(this.src)">` : ''}
      ${o.raw_message ? `<div class="order-raw">${escapeHtml(o.raw_message)}</div>` : ''}
      ${o.notes ? `<div class="order-remarks"><strong>Remarks:</strong> ${escapeHtml(o.notes)}</div>` : ''}
      <div class="order-actions">
        <button class="link-btn" data-make-invoice="${o.id}">Generate invoice</button>
        <button class="link-btn danger" data-delete-order="${o.id}">Delete</button>
      </div>
    </div>
  `;
}

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, m => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[m]));
}

// ---------- Manual order modal (structured form) ----------
const modal = document.getElementById('modal-backdrop');
let itemRowCount = 0;

function addItemRow(values = {}) {
  itemRowCount++;
  const id = itemRowCount;
  const div = document.createElement('div');
  div.className = 'item-row';
  div.dataset.rowId = id;
  div.innerHTML = `
    <div><label>Item Name</label><input class="i-item-name" value="${values.itemName || ''}" placeholder="e.g. Shirt"></div>
    <div><label>Category</label><input class="i-category" value="${values.category || ''}" placeholder="e.g. Boys Wear"></div>
    <div><label>Size</label><input class="i-size" value="${values.size || ''}" placeholder="e.g. 32"></div>
    <div><label>Color</label><input class="i-color" value="${values.color || ''}" placeholder="e.g. White"></div>
    <div><label>Qty</label><input class="i-qty" type="number" min="1" value="${values.quantity || 1}"></div>
    <button type="button" class="remove-item" onclick="this.closest('.item-row').remove()">×</button>
  `;
  document.getElementById('m-items').appendChild(div);
}

function resetManualForm() {
  document.getElementById('m-party-name').value = '';
  document.getElementById('m-mobile').value = '';
  document.getElementById('m-school').value = '';
  document.getElementById('m-spoc').value = '';
  document.getElementById('m-remarks').value = '';
  document.getElementById('m-delivery-date').value = '';
  document.getElementById('m-order-date').value = new Date().toISOString().slice(0, 10);
  document.getElementById('m-items').innerHTML = '';
  addItemRow();
}

document.getElementById('btn-add-manual').addEventListener('click', () => {
  resetManualForm();
  modal.classList.add('open');
});
document.getElementById('m-add-item').addEventListener('click', () => addItemRow());
document.getElementById('m-cancel').addEventListener('click', () => modal.classList.remove('open'));

document.getElementById('m-save').addEventListener('click', async () => {
  const partyName = document.getElementById('m-party-name').value.trim();
  if (!partyName) return alert('Party name is required.');

  const items = [...document.querySelectorAll('#m-items .item-row')].map(row => ({
    itemName: row.querySelector('.i-item-name').value.trim(),
    category: row.querySelector('.i-category').value.trim(),
    size: row.querySelector('.i-size').value.trim(),
    color: row.querySelector('.i-color').value.trim(),
    quantity: Number(row.querySelector('.i-qty').value) || 1
  })).filter(it => it.itemName);

  if (items.length === 0) return alert('Add at least one item with a name.');

  await fetch('/api/orders/manual', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      partyName,
      mobileNumber: document.getElementById('m-mobile').value.trim(),
      schoolName: document.getElementById('m-school').value.trim(),
      spoc: document.getElementById('m-spoc').value.trim(),
      orderDate: document.getElementById('m-order-date').value,
      deliveryDate: document.getElementById('m-delivery-date').value,
      remarks: document.getElementById('m-remarks').value.trim(),
      items
    })
  });

  modal.classList.remove('open');
  loadOrders(); loadStats();
});

// ---------- Inventory ----------
const invModal = document.getElementById('inv-modal-backdrop');
document.getElementById('btn-add-inventory').addEventListener('click', () => invModal.classList.add('open'));
document.getElementById('i-cancel').addEventListener('click', () => invModal.classList.remove('open'));
document.getElementById('i-save').addEventListener('click', async () => {
  await fetch('/api/inventory', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      item_type: document.getElementById('i-type').value.trim(),
      size: document.getElementById('i-size').value.trim(),
      fabric: document.getElementById('i-fabric').value.trim(),
      stock_qty: Number(document.getElementById('i-qty').value),
      reorder_level: Number(document.getElementById('i-reorder').value),
      unit_cost: Number(document.getElementById('i-cost').value)
    })
  });
  invModal.classList.remove('open');
  loadInventory(); loadStats();
});

async function loadInventory() {
  const rows = await fetch('/api/inventory').then(r => r.json());
  const tbody = document.querySelector('#inventory-table tbody');
  tbody.innerHTML = rows.map(r => `
    <tr>
      <td>${r.item_type}</td>
      <td>${r.size}</td>
      <td>${r.fabric || '-'}</td>
      <td class="${r.stock_qty <= r.reorder_level ? 'low-stock' : ''}">${r.stock_qty}</td>
      <td>${r.reorder_level}</td>
      <td>₹${r.unit_cost}</td>
      <td><button class="link-btn danger" onclick="deleteInventory(${r.id})">Remove</button></td>
    </tr>
  `).join('') || '<tr><td colspan="7" class="subtle">No stock lines yet.</td></tr>';
}

async function deleteInventory(id) {
  if (!confirm('Remove this stock line?')) return;
  await fetch(`/api/inventory/${id}`, { method: 'DELETE' });
  loadInventory(); loadStats();
}

// ---------- Billing ----------
async function loadInvoices() {
  const rows = await fetch('/api/invoices').then(r => r.json());
  const tbody = document.querySelector('#invoices-table tbody');
  tbody.innerHTML = rows.map(inv => `
    <tr>
      <td>${inv.invoice_number}</td>
      <td>${inv.customer_name || '-'}</td>
      <td>${inv.school_name || '-'}</td>
      <td>₹${inv.total.toFixed(2)}</td>
      <td>₹${inv.paid_amount.toFixed(2)}</td>
      <td><span class="badge ${inv.payment_status}">${inv.payment_status}</span></td>
      <td>
        <a class="link-btn" href="/api/invoices/${inv.id}/pdf" target="_blank">PDF</a>
        <button class="link-btn" onclick="markPaid(${inv.id}, ${inv.total})">Mark paid</button>
      </td>
    </tr>
  `).join('') || '<tr><td colspan="7" class="subtle">No invoices yet — generate one from an order.</td></tr>';
}

async function markPaid(id, total) {
  await fetch(`/api/invoices/${id}/payment`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paid_amount: total })
  });
  loadInvoices(); loadStats();
}

// ---------- Reports ----------
function fmtDate(d) { return d.toISOString().slice(0, 10); }

function getRange(key) {
  const now = new Date();
  let from, to;
  if (key === 'this_month') {
    from = new Date(now.getFullYear(), now.getMonth(), 1);
    to = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  } else if (key === 'last_month') {
    from = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    to = new Date(now.getFullYear(), now.getMonth(), 0);
  } else if (key === 'this_year') {
    from = new Date(now.getFullYear(), 0, 1);
    to = new Date(now.getFullYear(), 11, 31);
  } else if (key === 'last_year') {
    from = new Date(now.getFullYear() - 1, 0, 1);
    to = new Date(now.getFullYear() - 1, 11, 31);
  }
  return { from: fmtDate(from), to: fmtDate(to) };
}

document.querySelectorAll('#tab-reports .chip').forEach(chip => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('#tab-reports .chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    const { from, to } = getRange(chip.dataset.range);
    document.getElementById('r-from').value = from;
    document.getElementById('r-to').value = to;
    loadReport(from, to);
  });
});

document.getElementById('btn-apply-range').addEventListener('click', () => {
  document.querySelectorAll('#tab-reports .chip').forEach(c => c.classList.remove('active'));
  const from = document.getElementById('r-from').value;
  const to = document.getElementById('r-to').value;
  if (!from || !to) return alert('Pick both dates.');
  loadReport(from, to);
});

document.getElementById('btn-download-csv').addEventListener('click', () => {
  const from = document.getElementById('r-from').value;
  const to = document.getElementById('r-to').value;
  if (!from || !to) return alert('Pick a date range first.');
  window.open(`/api/reports/csv?from=${from}&to=${to}`, '_blank');
});

async function loadReport(from, to) {
  const r = await fetch(`/api/reports?from=${from}&to=${to}`).then(res => res.json());

  document.getElementById('report-cards').innerHTML = `
    <div class="report-card"><div class="label">Total orders</div><div class="value">${r.orderCount}</div></div>
    <div class="report-card"><div class="label">Total billed (₹)</div><div class="value">${r.revenue.totalBilled.toFixed(0)}</div></div>
    <div class="report-card"><div class="label">Total collected (₹)</div><div class="value">${r.revenue.totalPaid.toFixed(0)}</div></div>
    <div class="report-card"><div class="label">Outstanding (₹)</div><div class="value">${(r.revenue.totalBilled - r.revenue.totalPaid).toFixed(0)}</div></div>
  `;

  document.querySelector('#report-items-table tbody').innerHTML = r.itemBreakdown.map(i =>
    `<tr><td>${i.item_type}</td><td>${i.total_qty}</td><td>${i.order_count}</td></tr>`
  ).join('') || '<tr><td colspan="3" class="subtle">No items in this range.</td></tr>';

  document.querySelector('#report-status-table tbody').innerHTML = r.statusBreakdown.map(s =>
    `<tr><td>${s.status.replace('_',' ')}</td><td>${s.c}</td></tr>`
  ).join('') || '<tr><td colspan="2" class="subtle">No orders in this range.</td></tr>';

  document.querySelector('#report-school-table tbody').innerHTML = r.schoolBreakdown.map(s =>
    `<tr><td>${s.school_name}</td><td>${s.c}</td></tr>`
  ).join('') || '<tr><td colspan="2" class="subtle">No orders in this range.</td></tr>';
}

// Default report view: this month
(() => { const { from, to } = getRange('this_month'); document.getElementById('r-from').value = from; document.getElementById('r-to').value = to; loadReport(from, to); })();

// ---------- Product Master ----------
const productModal = document.getElementById('product-modal-backdrop');
const pickerModal = document.getElementById('product-picker-backdrop');
const abbrevModal = document.getElementById('abbrev-modal-backdrop');
let productCategoryFilter = '';
let abbreviationsCache = [];
let patternsCache = [];

// ---- Abbreviation helpers ----
function autoAbbreviate(text) {
  if (!text) return '';
  return text.trim().split(/\s+/).map(w => w[0].toUpperCase()).join('');
}

const DECORATION_MAP = { 'Print': 'P', 'Embroidery': 'E', 'Batch': 'B', 'NA': 'NA' };

function generateItemName() {
  const itemType = document.getElementById('p-item-type').value;
  const fabricCode = document.getElementById('p-fabric-code').value.trim();
  const size = document.getElementById('p-size').value.trim();
  const stitching = document.getElementById('p-stitching').value;
  const decoration = document.getElementById('p-decoration').value;
  const abbrevEntry = abbreviationsCache.find(a => a.item_type === itemType);
  const itemAbbr = abbrevEntry ? abbrevEntry.abbreviation : (itemType ? autoAbbreviate(itemType) : '');
  const patternEntry = patternsCache.find(p => p.pattern_name === stitching);
  const stitchAbbr = patternEntry ? patternEntry.abbreviation : (stitching ? autoAbbreviate(stitching) : '');
  const decoAbbr = DECORATION_MAP[decoration] || decoration;
  const parts = [itemAbbr, fabricCode, stitchAbbr, decoAbbr, size].filter(Boolean);
  const generated = parts.join('-');
  document.getElementById('p-generated-name').textContent = generated || '\u2014';
  return generated;
}

['p-item-type','p-fabric-code','p-size','p-stitching','p-decoration'].forEach(id => {
  const el = document.getElementById(id);
  el.addEventListener('change', generateItemName);
  el.addEventListener('input', generateItemName);
});

async function loadAbbreviations() {
  abbreviationsCache = await fetch('/api/abbreviations').then(r => r.json()).catch(() => []);
  const sel = document.getElementById('p-item-type');
  const current = sel.value;
  sel.innerHTML = '<option value="">\u2014 Select item type \u2014</option>' +
    abbreviationsCache.map(a => `<option value="${a.item_type}" ${a.item_type === current ? 'selected' : ''}>${a.item_type} (${a.abbreviation})</option>`).join('');
  const tbody = document.querySelector('#abbrev-table tbody');
  if (tbody) {
    tbody.innerHTML = abbreviationsCache.map(a => `
      <tr>
        <td>${a.item_type}</td>
        <td><strong style="font-family:var(--mono)">${a.abbreviation}</strong></td>
        <td>
          <button class="link-btn" onclick="editAbbrev(${a.id}, '${a.item_type.replace(/'/g,"\\'")}', '${a.abbreviation}')">Edit</button>
          <button class="link-btn danger" onclick="deleteAbbrev(${a.id})">Delete</button>
        </td>
      </tr>
    `).join('') || '<tr><td colspan="3" class="subtle">No abbreviations yet.</td></tr>';
  }
}

document.getElementById('btn-add-abbrev').addEventListener('click', () => {
  document.getElementById('ab-id').value = '';
  document.getElementById('ab-type').value = '';
  document.getElementById('ab-abbr').value = '';
  document.getElementById('abbrev-modal-title').textContent = 'Add item abbreviation';
  abbrevModal.classList.add('open');
});
document.getElementById('ab-cancel').addEventListener('click', () => abbrevModal.classList.remove('open'));
document.getElementById('ab-save').addEventListener('click', async () => {
  const id = document.getElementById('ab-id').value;
  const item_type = document.getElementById('ab-type').value.trim();
  const abbreviation = document.getElementById('ab-abbr').value.trim().toUpperCase();
  if (!item_type || !abbreviation) return alert('Both fields are required.');
  const url = id ? `/api/abbreviations/${id}` : '/api/abbreviations';
  const method = id ? 'PUT' : 'POST';
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ item_type, abbreviation }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return alert(data.error || 'Could not save.');
  abbrevModal.classList.remove('open');
  await loadAbbreviations();
  generateItemName();
});

function editAbbrev(id, type, abbr) {
  document.getElementById('ab-id').value = id;
  document.getElementById('ab-type').value = type;
  document.getElementById('ab-abbr').value = abbr;
  document.getElementById('abbrev-modal-title').textContent = 'Edit abbreviation';
  abbrevModal.classList.add('open');
}

async function deleteAbbrev(id) {
  if (!confirm('Remove this abbreviation?')) return;
  await fetch(`/api/abbreviations/${id}`, { method: 'DELETE' });
  await loadAbbreviations();
}

async function loadPatterns() {
  patternsCache = await fetch('/api/patterns').then(r => r.json()).catch(() => []);
  const sel = document.getElementById('p-stitching');
  const current = sel.value;
  sel.innerHTML = '<option value="">\u2014 Select pattern \u2014</option>' +
    patternsCache.map(p => `<option value="${p.pattern_name}" ${p.pattern_name === current ? 'selected' : ''}>${p.pattern_name} (${p.abbreviation})</option>`).join('');
  const tbody = document.querySelector('#pattern-table tbody');
  if (tbody) {
    tbody.innerHTML = patternsCache.map(p => `
      <tr>
        <td>${p.pattern_name}</td>
        <td><strong style="font-family:var(--mono)">${p.abbreviation}</strong></td>
        <td>
          <button class="link-btn" onclick="editPattern(${p.id}, '${p.pattern_name.replace(/'/g,"\\'")}', '${p.abbreviation}')">Edit</button>
          <button class="link-btn danger" onclick="deletePattern(${p.id})">Delete</button>
        </td>
      </tr>
    `).join('') || '<tr><td colspan="3" class="subtle">No patterns yet.</td></tr>';
  }
}

const patternModal = document.getElementById('pattern-modal-backdrop');
document.getElementById('btn-add-pattern').addEventListener('click', () => {
  document.getElementById('pt-id').value = '';
  document.getElementById('pt-name').value = '';
  document.getElementById('pt-abbr').value = '';
  document.getElementById('pattern-modal-title').textContent = 'Add stitching pattern';
  patternModal.classList.add('open');
});
document.getElementById('pt-cancel').addEventListener('click', () => patternModal.classList.remove('open'));
document.getElementById('pt-save').addEventListener('click', async () => {
  const id = document.getElementById('pt-id').value;
  const pattern_name = document.getElementById('pt-name').value.trim();
  const abbreviation = document.getElementById('pt-abbr').value.trim().toUpperCase();
  if (!pattern_name || !abbreviation) return alert('Both fields are required.');
  const url = id ? `/api/patterns/${id}` : '/api/patterns';
  const method = id ? 'PUT' : 'POST';
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pattern_name, abbreviation }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return alert(data.error || 'Could not save.');
  patternModal.classList.remove('open');
  await loadPatterns();
  generateItemName();
});

function editPattern(id, name, abbr) {
  document.getElementById('pt-id').value = id;
  document.getElementById('pt-name').value = name;
  document.getElementById('pt-abbr').value = abbr;
  document.getElementById('pattern-modal-title').textContent = 'Edit stitching pattern';
  patternModal.classList.add('open');
}

async function deletePattern(id) {
  if (!confirm('Remove this pattern?')) return;
  await fetch(`/api/patterns/${id}`, { method: 'DELETE' });
  await loadPatterns();
}

function resetProductForm() {
  document.getElementById('p-id').value = '';
  document.getElementById('p-item-type').value = '';
  document.getElementById('p-fabric-code').value = '';
  document.getElementById('p-size').value = '';
  document.getElementById('p-stitching').value = '';
  document.getElementById('p-decoration').value = 'NA';
  document.getElementById('p-price').value = '0';
  document.getElementById('p-remarks').value = '';
  document.getElementById('p-generated-name').textContent = '\u2014';
  document.getElementById('product-modal-title').textContent = 'Add product';
}

document.getElementById('btn-add-product').addEventListener('click', () => {
  resetProductForm();
  productModal.classList.add('open');
});
document.getElementById('p-cancel').addEventListener('click', () => productModal.classList.remove('open'));

document.getElementById('p-save').addEventListener('click', async () => {
  const id = document.getElementById('p-id').value;
  const itemName = generateItemName();
  if (!itemName || itemName === '\u2014') return alert('Please select an item type and fill in fabric code to generate a name.');
  const body = {
    product_category: 'General',
    item_name: itemName,
    fabric_code: document.getElementById('p-fabric-code').value.trim(),
    size: document.getElementById('p-size').value.trim(),
    stitching_pattern: document.getElementById('p-stitching').value.trim(),
    decoration: document.getElementById('p-decoration').value,
    unit_price: Number(document.getElementById('p-price').value) || 0,
    remarks: document.getElementById('p-remarks').value.trim()
  };
  const url = id ? `/api/products/${id}` : '/api/products';
  const method = id ? 'PUT' : 'POST';
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return alert(data.error || 'Could not save product.');
  productModal.classList.remove('open');
  loadProducts();
  loadProductCategories();
});

async function loadProductCategories() { /* category column removed - no-op */ }

async function loadProducts() {
  const search = document.getElementById('product-search').value.trim();
  const params = new URLSearchParams();
  if (search) params.set('search', search);
  const products = await fetch('/api/products?' + params).then(r => r.json()).catch(() => []);
  const tbody = document.querySelector('#products-table tbody');
  tbody.innerHTML = products.map(p => `
    <tr>
      <td><strong style="font-family:var(--mono);color:var(--navy)">${p.item_name}</strong></td>
      <td>${p.fabric_code || '-'}</td>
      <td>${p.size || '-'}</td>
      <td>${p.stitching_pattern || '-'}</td>
      <td>${p.decoration || '-'}</td>
      <td>\u20b9${p.unit_price}</td>
      <td>${p.remarks || '-'}</td>
      <td>
        <button class="link-btn" onclick="editProduct(${p.id})">Edit</button>
        <button class="link-btn danger" onclick="deleteProduct(${p.id})">Delete</button>
      </td>
    </tr>
  `).join('') || '<tr><td colspan="8" class="subtle">No products yet. Add your first product above.</td></tr>';
}

async function editProduct(id) {
  const products = await fetch('/api/products').then(r => r.json());
  const p = products.find(x => x.id === id);
  if (!p) return;
  document.getElementById('p-id').value = p.id;
  const matchedAbbrev = abbreviationsCache.find(a => p.item_name.startsWith(a.abbreviation + '-'));
  document.getElementById('p-item-type').value = matchedAbbrev ? matchedAbbrev.item_type : '';
  document.getElementById('p-fabric-code').value = p.fabric_code || '';
  document.getElementById('p-size').value = p.size || '';
  document.getElementById('p-stitching').value = p.stitching_pattern || '';
  document.getElementById('p-decoration').value = p.decoration || 'NA';
  document.getElementById('p-price').value = p.unit_price || 0;
  document.getElementById('p-remarks').value = p.remarks || '';
  document.getElementById('product-modal-title').textContent = 'Edit product';
  generateItemName();
  productModal.classList.add('open');
}

async function deleteProduct(id) {
  if (!confirm('Remove this product from the master list?')) return;
  await fetch(`/api/products/${id}`, { method: 'DELETE' });
  loadProducts();
  loadProductCategories();
}

document.getElementById('product-search').addEventListener('keydown', e => { if (e.key === 'Enter') loadProducts(); });
document.getElementById('btn-product-search').addEventListener('click', () => loadProducts());

// ---------- Product Picker (in order form) ----------
document.getElementById('m-pick-product').addEventListener('click', () => {
  document.getElementById('picker-search').value = '';
  loadPickerResults('');
  pickerModal.classList.add('open');
});
document.getElementById('picker-cancel').addEventListener('click', () => pickerModal.classList.remove('open'));
document.getElementById('picker-search').addEventListener('keydown', e => { if (e.key === 'Enter') loadPickerResults(e.target.value); });
document.getElementById('btn-picker-search').addEventListener('click', () => loadPickerResults(document.getElementById('picker-search').value));

async function loadPickerResults(search) {
  const params = new URLSearchParams();
  if (search) params.set('search', search);
  const products = await fetch('/api/products?' + params).then(r => r.json()).catch(() => []);
  const container = document.getElementById('picker-results');
  if (products.length === 0) {
    container.innerHTML = '<p class="subtle" style="padding:12px;">No products found. Add them in the Product Master tab first.</p>';
    return;
  }
  container.innerHTML = products.map(p => `
    <div class="picker-row" onclick="pickProduct(${p.id})">
      <div class="picker-name" style="font-family:var(--mono);color:var(--navy)">${p.item_name}</div>
      <div class="picker-meta">${p.size ? 'Size: ' + p.size + ' \u00b7 ' : ''}${p.unit_price ? '\u20b9' + p.unit_price : ''}</div>
    </div>
  `).join('');
}

async function pickProduct(id) {
  const products = await fetch('/api/products').then(r => r.json());
  const p = products.find(x => x.id === id);
  if (!p) return;
  addItemRow({ itemName: p.item_name, category: '', size: p.size || '', color: '', quantity: 1, unit_price: p.unit_price || 0 });
  pickerModal.classList.remove('open');
}

// ---------- Users (admin only) ----------
const userModal = document.getElementById('user-modal-backdrop');
document.getElementById('btn-add-user').addEventListener('click', () => {
  document.getElementById('u-username').value = '';
  document.getElementById('u-password').value = '';
  document.getElementById('u-role').value = 'staff';
  userModal.classList.add('open');
});
document.getElementById('u-cancel').addEventListener('click', () => userModal.classList.remove('open'));

document.getElementById('u-save').addEventListener('click', async () => {
  const username = document.getElementById('u-username').value.trim();
  const password = document.getElementById('u-password').value;
  const role = document.getElementById('u-role').value;
  if (!username || !password) return alert('Username and password are required.');
  const res = await fetch('/api/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, role })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return alert(data.error || 'Could not create user.');
  userModal.classList.remove('open');
  loadUsers();
});

async function loadUsers() {
  const res = await fetch('/api/users');
  if (!res.ok) return; // not an admin, or not yet authenticated
  const users = await res.json();
  document.querySelector('#users-table tbody').innerHTML = users.map(u => `
    <tr>
      <td>${u.username}</td>
      <td>${u.role}</td>
      <td>${new Date(u.created_at).toLocaleDateString()}</td>
      <td>
        <button class="link-btn" onclick="resetPassword(${u.id})">Reset password</button>
        <button class="link-btn danger" onclick="deleteUser(${u.id})">Delete</button>
      </td>
    </tr>
  `).join('') || '<tr><td colspan="4" class="subtle">No users yet.</td></tr>';
}

async function resetPassword(id) {
  const password = prompt('Enter a new password (at least 6 characters):');
  if (!password) return;
  const res = await fetch(`/api/users/${id}/password`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return alert(data.error || 'Could not reset password.');
  alert('Password updated.');
}

async function deleteUser(id) {
  if (!confirm('Remove this user? They will no longer be able to log in.')) return;
  const res = await fetch(`/api/users/${id}`, { method: 'DELETE' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return alert(data.error || 'Could not delete user.');
  loadUsers();
}

// ---------- Init ----------
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
initAuth();
loadStats();
loadOrders();
loadInventory();
loadInvoices();
loadUsers();
loadAbbreviations();
loadPatterns();
loadProducts();
loadProductCategories();
setInterval(() => { loadOrders(); loadStats(); }, 15000); // poll for new WhatsApp orders
