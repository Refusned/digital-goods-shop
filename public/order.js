/* Страница статуса заказа: оплата-заглушка и ожидание выдачи. */

const params = new URLSearchParams(location.search);
const orderId = params.get('id');
const panel = document.getElementById('panel');

const money = (minor, currency = 'RUB') =>
  new Intl.NumberFormat('ru-RU', { style: 'currency', currency, maximumFractionDigits: 0 }).format(minor);

const STATUS_TEXT = {
  created: 'Ожидает оплаты',
  paid: 'Оплачен, готовим код',
  delivering: 'Выдаём код',
  delivered: 'Код выдан',
  payment_failed: 'Оплата не прошла',
  out_of_stock: 'Оплачен, ключи закончились',
  delivery_failed: 'Оплачен, выдача не удалась',
};

let pollTimer = null;

async function load() {
  if (!orderId) { panel.innerHTML = '<p class="muted">Не указан номер заказа.</p>'; return; }

  const res = await fetch(`/api/orders/${encodeURIComponent(orderId)}`);
  if (!res.ok) { panel.innerHTML = '<p class="muted">Заказ не найден.</p>'; return; }
  const order = await res.json();

  render(order);

  // Пока заказ не в финальном состоянии, тянем статус: выдача идёт вне запроса оплаты.
  const waiting = ['paid', 'delivering', 'out_of_stock', 'delivery_failed'].includes(order.status);
  clearTimeout(pollTimer);
  if (waiting) pollTimer = setTimeout(load, 1200);
}

function render(order) {
  const paidBlock = order.status === 'created' ? `
    <div class="actions">
      <button class="btn-primary" id="paySuccess">Оплатить ${money(order.amount, order.currency)}</button>
      <button class="btn-ghost" id="payFail">Оплата не прошла</button>
    </div>
    <p class="muted" style="margin-top:10px">
      Реального эквайринга нет: кнопка отправляет вебхук по контракту из задания на наш же эндпоинт.
    </p>` : '';

  const codeBlock = order.delivery ? `
    <div class="code-box">${order.delivery.code}</div>
    <p class="muted" style="text-align:center;margin-top:8px">Код закреплён за этим заказом и повторно не выдаётся.</p>` : '';

  const waitingBlock = ['paid', 'delivering'].includes(order.status)
    ? '<p class="muted">Выдаём код, страница обновится сама.</p>' : '';

  const recoverBlock = ['out_of_stock', 'delivery_failed'].includes(order.status) ? `
    <p class="muted">
      Оплата прошла, свободных ключей сейчас нет. Заказ в восстановимом состоянии: как только пул пополнят,
      фоновая задача выдаст код автоматически. То же самое можно сделать вручную из
      <a href="admin.html" style="text-decoration:underline">админки</a>.
    </p>` : '';

  panel.innerHTML = `
    <h1>Заказ ${order.id}</h1>
    <p class="muted">${order.product_name}</p>
    <p style="margin:14px 0"><span class="status" data-status="${order.status}">${STATUS_TEXT[order.status] || order.status}</span></p>

    <div class="rows">
      <div class="row"><span class="muted">Товар</span><span>${order.product_name}</span></div>
      <div class="row"><span class="muted">Цена</span><span>${money(order.base_amount, order.currency)}</span></div>
      ${order.discount ? `<div class="row"><span class="muted">Промокод ${order.promocode}</span><span>минус ${money(order.discount, order.currency)}</span></div>` : ''}
      <div class="row"><span class="muted">К оплате</span><strong>${money(order.amount, order.currency)}</strong></div>
      ${order.paid_at ? `<div class="row"><span class="muted">Оплачен</span><span>${new Date(order.paid_at).toLocaleString('ru-RU')}</span></div>` : ''}
      ${order.delivered_at ? `<div class="row"><span class="muted">Код выдан</span><span>${new Date(order.delivered_at).toLocaleString('ru-RU')}</span></div>` : ''}
    </div>

    ${codeBlock}${waitingBlock}${recoverBlock}${paidBlock}`;

  document.getElementById('paySuccess')?.addEventListener('click', (e) => pay(e.currentTarget, true));
  document.getElementById('payFail')?.addEventListener('click', (e) => pay(e.currentTarget, false));
}

async function pay(button, success) {
  button.disabled = true;
  button.textContent = 'Отправляем...';
  await fetch(`/api/orders/${encodeURIComponent(orderId)}/simulate-payment`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ success }),
  });
  load();
}

load();
