/* Админка: сверка, ручная повторная выдача, пополнение пула. Дизайн по заданию не требуется. */

const money = (amount) => new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 0 }).format(amount);
const tokenInput = document.getElementById('token');
tokenInput.value = localStorage.getItem('adminToken') || 'admin-token';

const headers = () => ({ 'content-type': 'application/json', 'X-Admin-Token': tokenInput.value });

async function load() {
  localStorage.setItem('adminToken', tokenInput.value);
  const res = await fetch('/api/admin/reconciliation', { headers: headers() });
  if (res.status === 401) {
    document.getElementById('paidNotDelivered').innerHTML = '<p class="muted">Неверный токен.</p>';
    return;
  }
  const report = await res.json();

  document.getElementById('paidNotDelivered').innerHTML = report.paid_not_delivered.count === 0
    ? '<p class="muted">Пусто: всё оплаченное выдано.</p>'
    : `<table><thead><tr><th>Заказ</th><th>Товар</th><th>Статус</th><th>Сумма</th><th>Попыток</th><th>Причина</th><th></th></tr></thead>
       <tbody>${report.paid_not_delivered.items.map((o) => `
         <tr>
           <td><a href="order.html?id=${o.id}" style="text-decoration:underline">${o.id}</a></td>
           <td>${o.product_name}</td>
           <td><span class="pill">${o.status}</span></td>
           <td>${money(o.amount_minor)}</td>
           <td>${o.attempts}</td>
           <td class="muted">${o.last_error || ''}</td>
           <td><button class="btn-ghost" data-deliver="${o.id}">Выдать</button></td>
         </tr>`).join('')}</tbody></table>`;

  document.getElementById('deliveredNotPaid').innerHTML = report.delivered_not_paid.count === 0
    ? '<p class="muted">Пусто, как и должно быть.</p>'
    : `<table><tbody>${report.delivered_not_paid.items.map((o) => `<tr><td>${o.id}</td><td>${o.code}</td></tr>`).join('')}</tbody></table>`;

  document.getElementById('stock').innerHTML =
    `<table><thead><tr><th>SKU</th><th>Товар</th><th>Свободно</th><th>Всего</th><th></th></tr></thead>
     <tbody>${report.stock.map((s) => `
       <tr>
         <td>${s.sku}</td><td>${s.name}</td>
         <td${s.free === 0 ? ' style="color:#dc2626;font-weight:700"' : ''}>${s.free}</td>
         <td>${s.total}</td>
         <td><button class="btn-ghost" data-restock="${s.sku}">Завезти 5</button></td>
       </tr>`).join('')}</tbody></table>`;

  document.getElementById('promocodes').innerHTML =
    `<table><thead><tr><th>Код</th><th>Тип</th><th>Значение</th><th>Использовано</th><th>Лимит</th></tr></thead>
     <tbody>${report.promocodes.map((p) => `
       <tr><td>${p.code}</td><td>${p.type}</td><td>${p.value}</td>
           <td>${p.used_count}</td><td>${p.max_uses}</td></tr>`).join('')}</tbody></table>`;

  document.getElementById('ledger').innerHTML =
    `<table><thead><tr><th>Счёт</th><th>Дебет</th><th>Кредит</th><th>Сальдо</th></tr></thead>
     <tbody>${report.ledger.accounts.map((a) => `
       <tr><td>${a.account}</td><td>${money(a.debit_minor)}</td>
           <td>${money(a.credit_minor)}</td><td>${money(a.balance_minor)}</td></tr>`).join('')}</tbody></table>
     <p class="muted" style="margin-top:10px">
       Журнал ${report.ledger.balanced ? 'сходится' : 'НЕ сходится'}:
       дебет ${money(report.ledger.total_debit_minor)}, кредит ${money(report.ledger.total_credit_minor)}.
     </p>`;
}

document.addEventListener('click', async (e) => {
  const deliver = e.target.closest('[data-deliver]');
  if (deliver) {
    deliver.disabled = true;
    await fetch(`/api/admin/orders/${deliver.dataset.deliver}/deliver`, { method: 'POST', headers: headers(), body: '{}' });
    load();
    return;
  }
  const restock = e.target.closest('[data-restock]');
  if (restock) {
    restock.disabled = true;
    await fetch(`/api/admin/stock/${restock.dataset.restock}/restock`, {
      method: 'POST', headers: headers(), body: JSON.stringify({ count: 5 }),
    });
    load();
  }
});

document.getElementById('reload').addEventListener('click', load);
load();
