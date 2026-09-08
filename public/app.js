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
  { title: 'Ключи и пополнения за минуту', text: 'Код приходит автоматически сразу после оплаты.', image: 'assets/banner-01.webp', position: 'center 58%' },
  { title: 'Подписки со скидкой', text: 'Discord Nitro, YouTube Premium, Spotify.', image: 'assets/banner-02.webp', position: 'center 48%' },
  { title: 'Гифт-карты PSN и Xbox', text: 'Пополняй баланс без карты российского банка.', image: 'assets/banner-03.webp', position: 'center 54%' },
  { title: 'Промокод WELCOME10', text: 'Минус 10% на первый заказ.', image: 'assets/banner-04.webp', position: 'center' },
  { title: 'Игровая валюта', text: 'Robux, UC, алмазы: выдача из пула ключей.', image: 'assets/banner-05.webp', position: 'center 56%' },
  { title: 'Поддержка 24/7', text: 'Если код не подошёл, разберёмся и заменим.', image: 'assets/banner-06.webp', position: 'center 52%' },
];

function initBanner() {
  const track = document.getElementById('bannerTrack');
  const dots = document.getElementById('bannerDots');
  let index = 0;

  track.innerHTML = SLIDES.map((s) => `
    <article class="banner__slide" style="--banner-image:url('${s.image}');--banner-position:${s.position}">
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
  ['Steam', 'service-steam.svg', 'steam'], ['Telegram', 'service-telegram.svg', 'telegram'],
  ['Roblox', 'service-roblox.svg', 'roblox'], ['Brawl Stars', 'service-brawl.svg', 'brawl'],
  ['PUBG Mobile', 'service-pubg.svg', 'pubg'], ['App Store', 'service-appstore.svg', 'appstore'],
  ['ChatGPT', 'service-chatgpt.svg', 'chatgpt'], ['PlayStation', 'service-playstation.svg', 'playstation'],
  ['TikTok', 'service-tiktok.svg', 'tiktok'], ['Mobile Legends', 'service-mlbb.svg', 'mlbb'],
];

function initServices() {
  document.getElementById('services').innerHTML =
    SERVICES.map(([name, icon, key]) => `
      <button class="service" type="button" title="${name}">
        <img class="service__icon service__icon--${key}" src="assets/${icon}" alt="${name}" width="128" height="128"><span>${name}</span>
      </button>`).join('') +
    `<button class="service service--more" type="button">
       <span class="service__more" aria-hidden="true">•••</span><span>ещё 841</span>
     </button>`;
}

/* --- 5. Витрина: поиск, фильтры, живые обновления ---------------------------- */

/**
 * Состояние витрины целиком живёт в адресе страницы.
 * Так подборку можно переслать ссылкой, открыть в новой вкладке и вернуться к ней кнопкой
 * "Назад", а перезагрузка не сбрасывает выбранные фильтры.
 */
const state = {
  q: '', type: '', minPrice: '', maxPrice: '', inStock: false, sort: 'popular',
};

const grid = document.getElementById('cards');
const resultCount = document.getElementById('resultCount');
const loadMore = document.getElementById('loadMore');

let nextCursor = null;
let cardsBySku = new Map();     // sku -> DOM-узел карточки, чтобы обновлять точечно
let requestSeq = 0;             // номер поколения запроса
let appliedSeq = 0;             // номер поколения, которое сейчас на экране
let inFlight = null;            // текущий запрос, чтобы отменить устаревший

function readStateFromUrl() {
  const p = new URLSearchParams(location.search);
  state.q = p.get('q') ?? '';
  state.type = p.get('type') ?? '';
  state.minPrice = p.get('min') ?? '';
  state.maxPrice = p.get('max') ?? '';
  state.inStock = p.get('in_stock') === '1';
  state.sort = p.get('sort') ?? 'popular';
}

function writeStateToUrl({ replace = true } = {}) {
  const p = new URLSearchParams();
  if (state.q) p.set('q', state.q);
  if (state.type) p.set('type', state.type);
  if (state.minPrice) p.set('min', state.minPrice);
  if (state.maxPrice) p.set('max', state.maxPrice);
  if (state.inStock) p.set('in_stock', '1');
  if (state.sort && state.sort !== 'popular') p.set('sort', state.sort);
  const url = p.toString() ? `?${p}` : location.pathname;
  history[replace ? 'replaceState' : 'pushState']({}, '', url);
}

function syncControls() {
  document.getElementById('searchInput').value = state.q;
  document.getElementById('minPrice').value = state.minPrice;
  document.getElementById('maxPrice').value = state.maxPrice;
  document.getElementById('inStock').checked = state.inStock;
  document.getElementById('sort').value = state.sort;
  document.querySelectorAll('#tabs .tab').forEach((t) => {
    t.classList.toggle('is-active', (t.dataset.type || '') === state.type);
  });
}

function searchUrl(cursor = null) {
  const p = new URLSearchParams();
  if (state.q) p.set('q', state.q);
  if (state.type) p.set('type', state.type);
  if (state.minPrice) p.set('min_price', state.minPrice);
  if (state.maxPrice) p.set('max_price', state.maxPrice);
  if (state.inStock) p.set('in_stock', '1');
  p.set('sort', state.sort);
  p.set('limit', '24');
  if (cursor) p.set('cursor', cursor);
  return `/api/search?${p}`;
}

function cardHtml(item) {
  const soldOut = item.available === 0;
  return `
    <img class="card__img" src="${item.image || 'assets/product-steam.webp'}" alt="${item.name}"
         width="640" height="400" loading="lazy">
    <div class="card__body">
      <div class="card__name">${item.name}</div>
      <div class="card__prices">
        <span class="card__price" data-price>${money(item.price, item.currency)}</span>
        ${item.old_price ? `<span class="card__old">${money(item.old_price, item.currency)}</span>` : ''}
      </div>
      <div class="card__stock ${soldOut ? 'card__stock--empty' : ''}" data-stock>
        ${soldOut ? 'закончились' : `в наличии: ${item.available}`}
      </div>
      <div class="card__actions">
        <button class="card__buy" data-sku="${item.sku}" ${soldOut ? 'disabled' : ''}>Купить</button>
        <button class="card__cart" data-cart-add="${item.sku}" title="В корзину">+</button>
      </div>
    </div>`;
}

function makeCard(item) {
  const el = document.createElement('article');
  el.className = 'card';
  el.dataset.sku = item.sku;
  el.innerHTML = cardHtml(item);
  return el;
}

/**
 * Обновление одной карточки на месте.
 * Именно так живое обновление не мигает: меняются только цена, остаток и доступность кнопки,
 * а не весь список целиком.
 */
function patchCard(el, item) {
  const price = el.querySelector('[data-price]');
  if (price) {
    const next = money(item.price, item.currency || 'RUB');
    if (price.textContent.trim() !== next) {
      price.textContent = next;
      price.classList.remove('is-flash');
      void price.offsetWidth;              // перезапуск подсветки изменения
      price.classList.add('is-flash');
    }
  }
  const stock = el.querySelector('[data-stock]');
  if (stock) {
    stock.textContent = item.available === 0 ? 'закончились' : `в наличии: ${item.available}`;
    stock.classList.toggle('card__stock--empty', item.available === 0);
  }
  const buy = el.querySelector('.card__buy');
  if (buy) {
    // Товар закончился у всех сразу: кнопка гаснет во всех открытых вкладках.
    buy.disabled = item.available === 0 || item.is_active === false;
    // Надпись живого обновления не трогаем: если покупатель уже получил отказ в гонке,
    // «Раскупили» на кнопке объясняет причину лучше, чем безликое «Купить».
    if (buy.textContent.trim() === 'Оформляем...') buy.textContent = 'Купить';
  }
}

/**
 * Загрузка результатов.
 *
 * Каждому запросу присваивается номер. Ответ применяется, только если его номер новее
 * уже показанного: медленный ответ на старый запрос не перетирает свежий результат.
 * Предыдущий запрос при этом отменяется, чтобы не держать соединение зря.
 */
async function loadResults({ append = false } = {}) {
  const seq = ++requestSeq;
  if (inFlight) inFlight.abort();
  const controller = new AbortController();
  inFlight = controller;

  grid.setAttribute('aria-busy', 'true');
  try {
    const res = await fetch(searchUrl(append ? nextCursor : null), { signal: controller.signal });
    const data = await res.json();
    if (seq < appliedSeq) return;           // ответ устарел: на экране уже более свежий
    appliedSeq = seq;

    if (!append) {
      cardsBySku = new Map();
      const frag = document.createDocumentFragment();
      for (const item of data.items) {
        const el = makeCard(item);
        cardsBySku.set(item.sku, el);
        frag.append(el);
      }
      // Замена одним движением: список не успевает мигнуть пустотой.
      grid.replaceChildren(frag);
      if (data.items.length === 0) {
        grid.innerHTML = '<p class="muted">Ничего не нашлось. Попробуйте другой запрос или снимите фильтры.</p>';
      }
    } else {
      const frag = document.createDocumentFragment();
      for (const item of data.items) {
        const el = makeCard(item);
        cardsBySku.set(item.sku, el);
        frag.append(el);
      }
      grid.append(frag);
    }

    nextCursor = data.next_cursor;
    loadMore.hidden = !nextCursor;

    if (data.total !== undefined) {
      resultCount.textContent = data.total === 0
        ? ''
        : `найдено: ${data.total}${data.total_capped ? '+' : ''}`;
    }
    document.getElementById('gridTitle').textContent = state.q ? `Результаты: ${state.q}` : 'Популярные товары';
  } catch (err) {
    if (err.name !== 'AbortError') {
      grid.innerHTML = '<p class="muted">Не получилось загрузить каталог. Обновите страницу.</p>';
    }
  } finally {
    if (inFlight === controller) inFlight = null;
    grid.setAttribute('aria-busy', 'false');
  }
}

function applyState({ push = false } = {}) {
  writeStateToUrl({ replace: !push });
  nextCursor = null;
  loadResults();
}

function initSearchAndFilters() {
  const input = document.getElementById('searchInput');

  // Ввод не бьёт по серверу на каждый символ, но и не заставляет ждать: короткая пауза
  // и отмена предыдущего запроса дают ощущение мгновенности без лишней нагрузки.
  let debounce = null;
  input.addEventListener('input', () => {
    state.q = input.value;
    clearTimeout(debounce);
    debounce = setTimeout(() => applyState(), 150);
  });

  const numeric = (id, key) => {
    const el = document.getElementById(id);
    let t = null;
    el.addEventListener('input', () => {
      state[key] = el.value;
      clearTimeout(t);
      t = setTimeout(() => applyState(), 250);
    });
  };
  numeric('minPrice', 'minPrice');
  numeric('maxPrice', 'maxPrice');

  document.getElementById('inStock').addEventListener('change', (e) => {
    state.inStock = e.target.checked;
    applyState();
  });
  document.getElementById('sort').addEventListener('change', (e) => {
    state.sort = e.target.value;
    applyState();
  });
  document.getElementById('resetFilters').addEventListener('click', () => {
    Object.assign(state, { q: '', type: '', minPrice: '', maxPrice: '', inStock: false, sort: 'popular' });
    syncControls();
    applyState({ push: true });
  });

  document.getElementById('tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (!tab) return;
    state.type = tab.dataset.type || '';
    syncControls();
    applyState({ push: true });
  });

  loadMore.addEventListener('click', () => loadResults({ append: true }));

  // Кнопки "Назад" и "Вперёд" возвращают ту подборку, которая была: состояние читается из адреса.
  window.addEventListener('popstate', () => {
    readStateFromUrl();
    syncControls();
    nextCursor = null;
    loadResults();
  });
}

/* --- 6. Живая витрина: обновления без перезагрузки --------------------------- */

/**
 * Канал живых обновлений.
 *
 * EventSource переподключается сам, но после обрыва часть событий пропущена, поэтому
 * при каждом успешном подключении витрина и корзина обновляются полным снимком:
 * иначе на экране осталась бы устаревшая цена и живая кнопка у раскупленного товара.
 */
function initLive() {
  const dot = document.getElementById('liveDot');
  let firstOpen = true;

  const source = new EventSource('/api/stream');

  source.addEventListener('open', () => {
    dot.dataset.state = 'online';
    dot.title = 'Витрина обновляется вживую';
    if (!firstOpen) {
      loadResults();          // догоняем всё, что пропустили за время обрыва
      refreshCartPrices();
    }
    firstOpen = false;
  });

  source.addEventListener('error', () => {
    dot.dataset.state = 'offline';
    dot.title = 'Связь потеряна, переподключаемся';
  });

  source.addEventListener('products', (e) => {
    const items = JSON.parse(e.data);
    for (const item of items) {
      const card = cardsBySku.get(item.sku);
      if (card) patchCard(card, item);
      updateCartItem(item);
    }
  });
}

/* --- 7. Корзина: цены в ней тоже живые --------------------------------------- */

/**
 * Корзина хранится в браузере: она не влияет на инварианты магазина, ей незачем занимать
 * место на сервере. А вот цены и наличие в ней обязаны быть живыми, иначе покупатель
 * узнает о подорожании уже после оплаты.
 */
const CART_KEY = 'shop.cart.v1';
let cart = [];

function readCart() {
  try { cart = JSON.parse(localStorage.getItem(CART_KEY) || '[]'); } catch { cart = []; }
}
function saveCart() {
  try { localStorage.setItem(CART_KEY, JSON.stringify(cart)); } catch { /* приватный режим */ }
}

function renderCart() {
  document.getElementById('cartCount').textContent = String(cart.length);
  const body = document.getElementById('cartBody');
  if (cart.length === 0) {
    body.innerHTML = '<p class="muted">Пока пусто. Добавьте товар кнопкой «+» на карточке.</p>';
    return;
  }
  body.innerHTML = cart.map((item) => `
    <div class="cart__row" data-cart-sku="${item.sku}">
      <div>
        <div class="cart__name">${item.name}</div>
        <div class="cart__meta">
          <span data-cart-price>${money(item.price, item.currency || 'RUB')}</span>
          ${item.price_changed ? `<span class="cart__changed">цена изменилась: было ${money(item.added_price)}</span>` : ''}
          ${item.available === 0 ? '<span class="cart__gone">раскупили</span>' : ''}
        </div>
      </div>
      <div class="cart__actions">
        <button class="card__buy" data-sku="${item.sku}" ${item.available === 0 ? 'disabled' : ''}>Купить</button>
        <button class="btn-ghost" data-cart-remove="${item.sku}">×</button>
      </div>
    </div>`).join('');
}

function updateCartItem(product) {
  const item = cart.find((c) => c.sku === product.sku);
  if (!item) return;
  item.price = product.price;
  item.currency = product.currency;
  item.available = product.available;
  // Отметка о подорожании нужна ДО оплаты, а не после: покупатель должен увидеть новую цену
  // в корзине, а не узнать о ней из чека.
  item.price_changed = item.added_price !== undefined && item.added_price !== product.price;
  saveCart();
  renderCart();
}

/** После обрыва связи корзина, как и витрина, догоняет состояние снимком. */
async function refreshCartPrices() {
  if (cart.length === 0) return;
  const results = await Promise.all(cart.map(async (item) => {
    const res = await fetch(`/api/search?q=${encodeURIComponent(item.sku)}&limit=1`);
    const data = await res.json();
    return data.items.find((p) => p.sku === item.sku) ?? null;
  }));
  for (const product of results) if (product) updateCartItem(product);
}

function initCart() {
  readCart();
  renderCart();

  const panel = document.getElementById('cartPanel');
  document.getElementById('cartBtn').addEventListener('click', () => {
    const open = panel.hidden;
    panel.hidden = !open;
    document.getElementById('cartBtn').setAttribute('aria-expanded', String(open));
    if (open) refreshCartPrices();
  });
  document.getElementById('cartClose').addEventListener('click', () => { panel.hidden = true; });

  document.addEventListener('click', (e) => {
    const add = e.target.closest('[data-cart-add]');
    if (add) {
      const sku = add.dataset.cartAdd;
      const card = cardsBySku.get(sku);
      if (!card || cart.some((c) => c.sku === sku)) return;
      const priceText = card.querySelector('[data-price]')?.textContent ?? '';
      const price = Number(priceText.replace(/[^\d]/g, '')) || 0;
      cart.push({
        sku,
        name: card.querySelector('.card__name')?.textContent?.trim() ?? sku,
        price,
        added_price: price,
        currency: 'RUB',
        available: card.querySelector('.card__buy')?.disabled ? 0 : 1,
      });
      saveCart();
      renderCart();
      return;
    }

    const remove = e.target.closest('[data-cart-remove]');
    if (remove) {
      cart = cart.filter((c) => c.sku !== remove.dataset.cartRemove);
      saveCart();
      renderCart();
    }
  });
}

/* --- 8. Покупка -------------------------------------------------------------- */

/**
 * Покупка.
 *
 * Idempotency-Key генерируется один раз на действие и переиспользуется при повторных кликах,
 * поэтому двойной клик даёт ОДИН заказ. Кнопка блокируется до ответа.
 *
 * Отказ 409 sold_out это нормальный исход гонки за последнюю единицу, а не ошибка:
 * покупателю показывается понятное сообщение и предлагается продолжить, а деньги при этом
 * не списываются, потому что оплаты ещё не было.
 */
async function buy(button, { promocode = null } = {}) {
  const sku = button.dataset.sku;

  const action = `${sku}|${promocode || ''}`;
  if (button.dataset.idempotencyAction !== action) {
    button.dataset.idempotencyAction = action;
    button.dataset.idempotencyKey = `${sku}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  const label = button.textContent;
  button.disabled = true;
  button.textContent = 'Оформляем...';

  try {
    const { status, body } = await api.post('/api/orders',
      { sku, promocode },
      { 'Idempotency-Key': button.dataset.idempotencyKey });

    if (status === 409 && body.error === 'sold_out') {
      showSoldOut(sku, button);
      return;
    }
    if (status >= 400) throw new Error(body.message || body.error || 'Не получилось создать заказ');
    location.href = `order.html?id=${encodeURIComponent(body.id)}`;
  } catch (err) {
    button.disabled = false;
    button.textContent = label;
    alert(err.message);
  }
}

/** Проигравший в гонке видит объяснение и выход, а не пустую ошибку. */
function showSoldOut(sku, button) {
  const card = cardsBySku.get(sku);
  button.textContent = 'Раскупили';
  button.disabled = true;

  const box = document.createElement('div');
  box.className = 'sold-out';
  box.innerHTML = `
    <strong>Этот товар только что раскупили.</strong>
    <span>Последнюю единицу забрал другой покупатель. Деньги не списаны.</span>
    <span class="sold-out__actions">
      <button class="btn-ghost" data-sold-out-similar="${sku}">Посмотреть похожие</button>
      <button class="btn-ghost" data-sold-out-close>Закрыть</button>
    </span>`;
  (card ?? document.body).append(box);

  box.addEventListener('click', (e) => {
    if (e.target.closest('[data-sold-out-close]')) box.remove();
    if (e.target.closest('[data-sold-out-similar]')) {
      const name = card?.querySelector('.card__name')?.textContent?.trim() ?? '';
      state.q = name.split(':')[0].trim();
      state.inStock = true;
      syncControls();
      applyState({ push: true });
      box.remove();
    }
  });

  if (card) patchCard(card, { price: 0, available: 0, currency: 'RUB' });
  // Точный остаток подтянет ближайшее живое обновление, а пока кнопка уже погашена.
}

function initBuying() {
  document.addEventListener('click', (e) => {
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

/* --- Запуск ------------------------------------------------------------------ */

initBanner();
initCatalogMenu();
initCurrency();
initServices();
initPromo();
initBuying();
initCart();

readStateFromUrl();
syncControls();
initSearchAndFilters();
loadResults();
initLive();
