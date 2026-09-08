/* Страница оформления: бронь с обратным отсчётом, оплата-заглушка и ожидание выдачи. */

const params = new URLSearchParams(location.search);
const orderId = params.get('id');
const panel = document.getElementById('panel');

const money = (minor, currency = 'RUB') =>
  new Intl.NumberFormat('ru-RU', { style: 'currency', currency, maximumFractionDigits: 0 }).format(minor);

const STATUS_TEXT = {
  created: 'Забронировано, ждём оплату',
  paid: 'Оплачен, готовим код',
  delivering: 'Выдаём код',
  delivered: 'Код выдан',
  payment_failed: 'Оплата не прошла',
  out_of_stock: 'Оплачен, ключи закончились',
  delivery_failed: 'Оплачен, выдача не удалась',
  expired: 'Бронь истекла',
};

const WAITING = ['paid', 'delivering', 'out_of_stock', 'delivery_failed'];

let pollTimer = null;
let tickTimer = null;
let order = null;

/**
 * Ключ идемпотентности платежа живёт в браузере и переживает перезагрузку страницы.
 *
 * Он и есть защита от «сломать покупку любыми действиями»: двойной клик, обновление страницы,
 * возврат кнопкой «Назад» и повтор после обрыва связи дают ОДИН и тот же ключ, а значит
 * одно и то же событие оплаты. Второй платёж создать физически нечем.
 */
function paymentKey(id) {
  const storageKey = `shop.pay.${id}`;
  try {
    let key = localStorage.getItem(storageKey);
    if (!key) {
      key = `${id}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      localStorage.setItem(storageKey, key);
    }
    return key;
  } catch {
    // Приватный режим: ключ хотя бы стабилен в пределах страницы.
    return `${id}-session`;
  }
}

async function load() {
  if (!orderId) { panel.innerHTML = '<p class="muted">Не указан номер заказа.</p>'; return; }

  const res = await fetch(`/api/orders/${encodeURIComponent(orderId)}`);
  if (!res.ok) { panel.innerHTML = '<p class="muted">Заказ не найден.</p>'; return; }
  order = await res.json();

  render();
  scheduleRefresh();
}

function scheduleRefresh() {
  clearTimeout(pollTimer);
  // Пока заказ не в конечном состоянии, статус подтягивается: выдача идёт вне запроса оплаты.
  if (WAITING.includes(order.status)) pollTimer = setTimeout(load, 1200);
  // Пока идёт бронь, страница сама узнает о её истечении, не дожидаясь действий покупателя.
  else if (order.status === 'created') pollTimer = setTimeout(load, 5000);
}

/**
 * Обратный отсчёт брони.
 *
 * Считается от серверного времени, а не от часов браузера: расхождение на минуту показало бы
 * покупателю неправду о том, сколько у него осталось.
 */
function startCountdown(secondsLeft) {
  clearInterval(tickTimer);
  const el = document.getElementById('countdown');
  if (!el) return;

  let left = secondsLeft;
  const paint = () => {
    const mm = String(Math.floor(left / 60)).padStart(2, '0');
    const ss = String(left % 60).padStart(2, '0');
    el.textContent = `${mm}:${ss}`;
    el.classList.toggle('is-urgent', left <= 30);
  };
  paint();

  tickTimer = setInterval(() => {
    left -= 1;
    if (left <= 0) {
      clearInterval(tickTimer);
      paint();
      load();                      // время вышло: спрашиваем сервер, что стало с бронью
      return;
    }
    paint();
  }, 1000);
}

function render() {
  const reservationBlock = order.status === 'created' ? `
    <div class="reservation">
      <div>
        <div class="reservation__title">Товар забронирован за вами</div>
        <div class="muted">Если не оплатить вовремя, бронь снимется и товар вернётся в продажу.</div>
      </div>
      <div class="reservation__timer" id="countdown">--:--</div>
    </div>` : '';

  const priceChangedBlock = order.status === 'created' && order.price_changed ? `
    <div class="notice notice--warn">
      Цена товара изменилась, пока вы оформляли заказ: сейчас в каталоге
      ${money(order.current_price, order.currency)}, а в заказе зафиксировано
      ${money(order.base_amount, order.currency)}.
      ${order.current_price > order.base_amount
        ? 'Оплатить можно по зафиксированной цене, она не вырастет.'
        : 'Оформите заказ заново, чтобы купить дешевле.'}
    </div>` : '';

  const payBlock = order.status === 'created' ? `
    <div class="actions">
      <button class="btn-primary" id="paySuccess">Оплатить ${money(order.amount, order.currency)}</button>
      <button class="btn-ghost" id="payFail">Оплата не прошла</button>
      <button class="btn-ghost" id="cancelOrder">Отменить бронь</button>
    </div>
    <p class="muted" style="margin-top:10px">
      Реального эквайринга нет: кнопка отправляет вебхук по контракту из задания на наш же эндпоинт.
    </p>` : '';

  const expiredBlock = order.status === 'expired' ? `
    <div class="notice">
      Бронь истекла, товар вернулся в продажу. Деньги не списывались.
      <a class="btn-ghost" href="index.html?q=${encodeURIComponent(order.product_name || '')}&in_stock=1">Найти снова</a>
    </div>` : '';

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

    ${reservationBlock}${priceChangedBlock}

    <div class="rows">
      <div class="row"><span class="muted">Товар</span><span>${order.product_name}</span></div>
      <div class="row"><span class="muted">Цена</span><span>${money(order.base_amount, order.currency)}</span></div>
      ${order.discount ? `<div class="row"><span class="muted">Промокод ${order.promocode}</span><span>минус ${money(order.discount, order.currency)}</span></div>` : ''}
      <div class="row"><span class="muted">К оплате</span><strong>${money(order.amount, order.currency)}</strong></div>
      ${order.paid_at ? `<div class="row"><span class="muted">Оплачен</span><span>${new Date(order.paid_at).toLocaleString('ru-RU')}</span></div>` : ''}
      ${order.delivered_at ? `<div class="row"><span class="muted">Код выдан</span><span>${new Date(order.delivered_at).toLocaleString('ru-RU')}</span></div>` : ''}
    </div>

    ${codeBlock}${waitingBlock}${recoverBlock}${expiredBlock}${payBlock}`;

  if (order.status === 'created' && order.reservation_seconds_left !== null) {
    startCountdown(order.reservation_seconds_left);
  } else {
    clearInterval(tickTimer);
  }

  document.getElementById('paySuccess')?.addEventListener('click', (e) => pay(e.currentTarget, true));
  document.getElementById('payFail')?.addEventListener('click', (e) => pay(e.currentTarget, false));
  document.getElementById('cancelOrder')?.addEventListener('click', cancelOrder);
}

/**
 * Оплата.
 *
 * Перед отправкой бронь продлевается: время, потраченное на оформление, не должно съедать
 * время на оплату. Повтор с тем же ключом идемпотентности безопасен: сервер отбросит
 * второе событие с тем же идентификатором.
 */
async function pay(button, success) {
  button.disabled = true;
  const label = button.textContent;
  button.textContent = 'Отправляем...';

  try {
    if (success) await fetch(`/api/orders/${encodeURIComponent(orderId)}/hold`, { method: 'POST' });

    const res = await fetch(`/api/orders/${encodeURIComponent(orderId)}/simulate-payment`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': paymentKey(orderId) },
      body: JSON.stringify({ success }),
    });
    if (!res.ok && res.status !== 409) throw new Error('Платёж не прошёл');
  } catch {
    // Обрыв связи в момент оплаты: повторить безопасно, ключ тот же.
    button.disabled = false;
    button.textContent = label;
    alert('Связь прервалась. Нажмите «Оплатить» ещё раз: повторная попытка не создаст второй платёж.');
    return;
  }
  await load();
}

async function cancelOrder() {
  await fetch(`/api/orders/${encodeURIComponent(orderId)}/cancel`, { method: 'POST' });
  await load();
}

/**
 * Возврат на страницу кнопкой «Назад» отдаёт её из кеша браузера вместе со старым статусом.
 * Поэтому состояние всегда перечитывается с сервера: показывать оплаченный заказ как
 * неоплаченный и предлагать оплатить его снова нельзя.
 */
window.addEventListener('pageshow', (e) => { if (e.persisted) load(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });

load();
