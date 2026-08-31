/* Витрина: данные тянутся из API, интерактив на чистом JS без фреймворков. */

const money = (minor, currency = 'RUB') =>
  new Intl.NumberFormat('ru-RU', { style: 'currency', currency, maximumFractionDigits: 0 }).format(minor);

const api = {
  get: (path) => fetch(path).then((r) => r.json()),
  post: (path, body, headers = {}) =>
    fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
      .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) })),
};

/* --- 1. Баннер-карусель ---------------------------------------------------- */

const SLIDES = [
  { title: 'Ключи и пополнения за минуту', text: 'Код приходит автоматически сразу после оплаты.', bg: 'linear-gradient(120deg,#111827,#2a475e)' },
  { title: 'Подписки со скидкой', text: 'Discord Nitro, YouTube Premium, Spotify.', bg: 'linear-gradient(120deg,#3b1d5e,#7a3ff2)' },
  { title: 'Гифт-карты PSN и Xbox', text: 'Пополняй баланс без карты российского банка.', bg: 'linear-gradient(120deg,#0d2a54,#0070d1)' },
  { title: 'Промокод WELCOME10', text: 'Минус 10% на первый заказ.', bg: 'linear-gradient(120deg,#14532d,#17a34a)' },
  { title: 'Игровая валюта', text: 'Robux, UC, алмазы: выдача из пула ключей.', bg: 'linear-gradient(120deg,#5a1a1a,#e2231a)' },
  { title: 'Поддержка 24/7', text: 'Если код не подошёл, разберёмся и заменим.', bg: 'linear-gradient(120deg,#1f2937,#4b5563)' },
];

function initBanner() {
  const track = document.getElementById('bannerTrack');
  const dots = document.getElementById('bannerDots');
  let index = 0;

  track.innerHTML = SLIDES.map((s) => `
    <article class="banner__slide" style="background:${s.bg}">
      <h2>${s.title}</h2><p>${s.text}</p>
    </article>`).join('');
  dots.innerHTML = SLIDES.map((_, i) => `<button type="button" aria-label="Слайд ${i + 1}"></button>`).join('');

  const render = () => {
    track.style.transform = `translateX(-${index * 100}%)`;
    [...dots.children].forEach((d, i) => d.classList.toggle('is-active', i === index));
  };
  const go = (next) => { index = (next + SLIDES.length) % SLIDES.length; render(); };

  document.getElementById('bannerNext').addEventListener('click', () => { go(index + 1); restart(); });
  document.getElementById('bannerPrev').addEventListener('click', () => { go(index - 1); restart(); });
  [...dots.children].forEach((dot, i) => dot.addEventListener('click', () => { go(i); restart(); }));

  let timer = setInterval(() => go(index + 1), 5000);
  const restart = () => { clearInterval(timer); timer = setInterval(() => go(index + 1), 5000); };
  document.getElementById('banner').addEventListener('mouseenter', () => clearInterval(timer));
  document.getElementById('banner').addEventListener('mouseleave', restart);

  render();
}

/* --- 2. Меню каталога ------------------------------------------------------ */

function initCatalogMenu() {
  const btn = document.getElementById('catalogBtn');
  const menu = document.getElementById('catalogMenu');

  const setOpen = (open) => {
    menu.classList.toggle('is-open', open);
    btn.setAttribute('aria-expanded', String(open));
  };

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    setOpen(!menu.classList.contains('is-open'));
  });
  // Клик вне меню и Esc закрывают его.
  document.addEventListener('click', (e) => {
    if (menu.classList.contains('is-open') && !menu.contains(e.target)) setOpen(false);
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setOpen(false); });

  menu.querySelectorAll('.catalog-menu__cat').forEach((cat) => {
    cat.addEventListener('mouseenter', () => {
      menu.querySelectorAll('.catalog-menu__cat').forEach((c) => c.classList.remove('is-active'));
      cat.classList.add('is-active');
    });
  });
}

/* --- 3. Переключатель валют (только отображение) --------------------------- */

function initCurrency() {
  const box = document.getElementById('currency');
  box.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    [...box.children].forEach((b) => b.classList.toggle('is-active', b === btn));
  });
}

/* --- 4. Ряд сервисов ------------------------------------------------------- */

const SERVICES = [
  ['Steam', 'svc-steam'], ['Telegram', 'svc-telegram'], ['Roblox', 'svc-roblox'],
  ['Brawl Stars', 'svc-brawl'], ['PUBG Mobile', 'svc-pubg'], ['App Store', 'svc-appstore'],
  ['ChatGPT', 'svc-chatgpt'], ['PlayStation', 'svc-playstation'], ['TikTok', 'svc-tiktok'],
  ['Mobile Legends', 'svc-mlbb'],
];

function initServices() {
  document.getElementById('services').innerHTML =
    SERVICES.map(([name, icon]) => `
      <button class="service" type="button" title="${name}">
        <img src="assets/${icon}.svg" alt="${name}"><span>${name}</span>
      </button>`).join('') +
    `<button class="service service--more" type="button">
       <img src="assets/svc-appstore.svg" alt=""><span>ещё 841</span>
     </button>`;
}

/* --- 5. Карточки товаров и покупка ----------------------------------------- */

let catalogCache = [];

async function loadCatalog() {
  const data = await api.get('/api/catalog?limit=60');
  catalogCache = data.items;
  renderCards('all');
}

function renderCards(type) {
  const items = (type === 'all' ? catalogCache : catalogCache.filter((i) => i.type === type)).slice(0, 5);
  const box = document.getElementById('cards');

  if (items.length === 0) {
    box.innerHTML = '<p class="muted">В этой категории пока пусто.</p>';
    return;
  }

  box.innerHTML = items.map((item) => `
    <article class="card">
      <img class="card__img" src="${item.image || 'assets/steam.svg'}" alt="${item.name}" loading="lazy">
      <div class="card__body">
        <div class="card__name">${item.name}</div>
        <div class="card__prices">
          <span class="card__price">${money(item.price, item.currency)}</span>
          ${item.old_price ? `<span class="card__old">${money(item.old_price, item.currency)}</span>` : ''}
        </div>
        <div class="card__stock ${item.available ? '' : 'card__stock--empty'}">
          ${item.available ? `в наличии: ${item.available}` : 'ключи закончились'}
        </div>
        <button class="card__buy" data-sku="${item.sku}" ${item.available ? '' : 'disabled'}>Купить</button>
      </div>
    </article>`).join('');
}

function initTabs() {
  const tabs = document.getElementById('tabs');
  tabs.addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (!tab) return;
    [...tabs.children].forEach((t) => t.classList.toggle('is-active', t === tab));
    renderCards(tab.dataset.type);
  });
}

/**
 * Покупка. Idempotency-Key генерируется один раз на кнопку и переиспользуется при повторных
 * кликах, поэтому двойной клик даёт ОДИН заказ, а не два. Кнопка блокируется до ответа.
 */
async function buy(button, { promocode = null } = {}) {
  const sku = button.dataset.sku;

  // Ключ идемпотентности описывает КОНКРЕТНОЕ действие: тот же товар и тот же промокод.
  // Поменяли промокод, значит это другой запрос, и ключ нужен новый.
  const action = `${sku}|${promocode || ''}`;
  if (button.dataset.idempotencyAction !== action) {
    button.dataset.idempotencyAction = action;
    button.dataset.idempotencyKey = `${sku}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  const label = button.textContent;
  button.disabled = true;
  button.textContent = 'Создаём заказ...';

  try {
    const { status, body } = await api.post('/api/orders',
      { sku, promocode },
      { 'Idempotency-Key': button.dataset.idempotencyKey });

    if (status >= 400) throw new Error(body.message || body.error || 'Не получилось создать заказ');
    location.href = `order.html?id=${encodeURIComponent(body.id)}`;
  } catch (err) {
    button.disabled = false;
    button.textContent = label;
    alert(err.message);
  }
}

function initBuying() {
  document.getElementById('cards').addEventListener('click', (e) => {
    const btn = e.target.closest('.card__buy');
    if (btn) buy(btn);
  });

  const topupBtn = document.getElementById('topupBuy');
  topupBtn.addEventListener('click', () => {
    const promo = document.getElementById('promoInput').value.trim() || null;
    buy(topupBtn, { promocode: promo });
  });
}

/* --- Промокод: предпросмотр, считает сервер -------------------------------- */

function initPromo() {
  const row = document.getElementById('promoRow');
  const toggle = document.getElementById('promoToggle');
  const hint = document.getElementById('promoHint');

  toggle.addEventListener('click', () => {
    const open = !row.classList.contains('is-open');
    row.classList.toggle('is-open', open);
    toggle.setAttribute('aria-expanded', String(open));
  });

  document.getElementById('promoCheck').addEventListener('click', async () => {
    const code = document.getElementById('promoInput').value.trim();
    if (!code) return;

    const { body } = await api.post('/api/promo/quote', { code, sku: 'STEAM-TOPUP-500' });
    hint.classList.remove('is-ok', 'is-bad');

    if (body.applied) {
      hint.classList.add('is-ok');
      hint.textContent = `Скидка ${money(body.discount_minor)}, к оплате ${money(body.total_minor)}. Осталось использований: ${body.uses_left}.`;
    } else {
      hint.classList.add('is-bad');
      hint.textContent = body.reason === 'limit_reached'
        ? 'Лимит использований исчерпан.'
        : 'Такой промокод не найден.';
    }
  });
}

initBanner();
initCatalogMenu();
initCurrency();
initServices();
initTabs();
initPromo();
initBuying();
loadCatalog();
