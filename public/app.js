const state = { statusFilter: 'all' };

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
  const itemsHtml = o.items.map(it =>
    `<span class="item-tag">${it.item_type} · ${it.size || '?'} × ${it.quantity}</span>`
  ).join('');

  return `
    <div class="order-card ${o.needs_review ? 'review' : ''}">
      <div class="order-top">
        <div>
          <div class="order-id">ORDER #${o.id} · ${new Date(o.created_at).toLocaleString()}</div>
          <div class="order-customer">${o.customer_name || 'Unnamed customer'} ${o.customer_phone ? '· ' + o.customer_phone : ''}</div>
          ${o.school_name ? `<div class="order-school">${o.school_name}</div>` : ''}
        </div>
        <div class="order-meta">
          ${o.needs_review ? '<span class="badge review">Needs review</span>' : ''}
          <select class="status-select" data-status-change="${o.id}">
            ${['pending','confirmed','in_production','ready','delivered','cancelled'].map(s =>
              `<option value="${s}" ${s === o.status ? 'selected' : ''}>${s.replace('_',' ')}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="order-items">${itemsHtml || '<span class="subtle">No items parsed — check raw message below</span>'}</div>
      <div class="order-raw">${escapeHtml(o.raw_message || '')}</div>
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

// ---------- Manual order modal ----------
const modal = document.getElementById('modal-backdrop');
document.getElementById('btn-add-manual').addEventListener('click', () => modal.classList.add('open'));
document.getElementById('m-cancel').addEventListener('click', () => modal.classList.remove('open'));
document.getElementById('m-save').addEventListener('click', async () => {
  const rawText = document.getElementById('m-text').value.trim();
  if (!rawText) return alert('Paste the order text first.');
  await fetch('/api/orders/manual', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      rawText,
      phone: document.getElementById('m-phone').value.trim(),
      contactName: document.getElementById('m-name').value.trim()
    })
  });
  document.getElementById('m-text').value = '';
  document.getElementById('m-phone').value = '';
  document.getElementById('m-name').value = '';
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

// ---------- Init ----------
loadStats();
loadOrders();
loadInventory();
loadInvoices();
setInterval(() => { loadOrders(); loadStats(); }, 15000); // poll for new WhatsApp orders
