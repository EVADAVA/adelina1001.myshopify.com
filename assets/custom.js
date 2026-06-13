(function () {
  window.adelinaCartOverrideLoaded = true;
  var shouldResetCartOnLoad = false;
  var CART_KEY = '_aCart';
  var CART_FLOW_KEY = '_aCartFlow';

  // ── Utilities ──────────────────────────────────────────────────────────────
  function getCartRoot() {
    if (window.Shopify && window.Shopify.routes && window.Shopify.routes.root) {
      return window.Shopify.routes.root;
    }
    var m = window.location.pathname.match(/^\/[a-z]{2}(?:-[a-z]{2})?\//i);
    return m ? m[0] : '/';
  }

  // Detect return from Shopify's order thank-you page (checkout completed).
  // Referrer-domain tricks are unreliable across redirect chains (shop.app, etc.),
  // so we only check the path for /thank_you which Shopify always appends.
  function isPostCheckout() {
    if (!document.referrer) return false;
    try {
      return /\/thank_you(\/|$)/.test(new URL(document.referrer).pathname);
    } catch (e) { return false; }
  }

  function setLoading(on) {
    document.dispatchEvent(new CustomEvent(on ? 'theme:loading:start' : 'theme:loading:end'));
  }

  function updateHeaderCartCount(n) {
    document.querySelectorAll('.Header__CartCount').forEach(function (el) { el.textContent = n; });
    document.querySelectorAll('.Header__CartDot').forEach(function (el) { el.classList.toggle('is-visible', n > 0); });
  }

  function parseItemCount(html) {
    var m = html && html.match(/"itemCount"\s*:\s*(\d+)/);
    return m ? parseInt(m[1], 10) : null;
  }

  function replaceCartDrawer(html) {
    var current = document.getElementById('sidebar-cart');
    if (!current) return;
    var tmp = document.createElement('div');
    tmp.innerHTML = html;
    var fresh = tmp.querySelector('#sidebar-cart');
    if (!fresh) return;
    current.innerHTML = fresh.innerHTML;
  }

  function openCartDrawer() {
    var drawer = document.getElementById('sidebar-cart');
    if (!drawer) return;
    drawer.setAttribute('aria-hidden', 'false');
    document.documentElement.classList.add('no-scroll');
    var overlay = document.querySelector('.PageOverlay');
    if (overlay) overlay.classList.add('is-visible');
  }

  function closeCartDrawer() {
    var drawer = document.getElementById('sidebar-cart');
    if (!drawer) return;
    drawer.setAttribute('aria-hidden', 'true');
    document.documentElement.classList.remove('no-scroll');
    var overlay = document.querySelector('.PageOverlay');
    if (overlay) overlay.classList.remove('is-visible');
  }

  function showError(button, message) {
    var old = button.parentElement && button.parentElement.querySelector('.adelina-cart-error');
    if (old) old.remove();
    var el = document.createElement('p');
    el.className = 'adelina-cart-error';
    el.style.cssText = 'color:red;font-size:13px;margin-top:8px;';
    el.textContent = message || 'Could not add to cart. Please try again.';
    button.insertAdjacentElement('afterend', el);
    setTimeout(function () { el.remove(); }, 8000);
  }

  // ── Local cart store (sessionStorage) ─────────────────────────────────────
  // Источник истины — sessionStorage, а не серверная корзина Shopify.
  // Это нужно, потому что cart/add.js НЕ заменяет количество, а прибавляет
  // его к уже имеющемуся в серверной корзине. Поэтому при изменении конкретной
  // строки используем cart/change.js (ставит абсолютное количество), при
  // добавлении нового товара — cart/add.js с точной дельтой, а при полной
  // ресинхронизации (sendCart, только на загрузке страницы) — точечные
  // cart/update.js + cart/add.js по разнице между локальным и серверным
  // состоянием. После каждой операции локальное состояние перестраивается
  // из ответа сервера (syncLocalFromServerItems) — он единственный источник
  // истины. Ключ: строковый variant ID. Значение: количество.

  function cartGet() {
    try { return JSON.parse(sessionStorage.getItem(CART_KEY) || '{}'); }
    catch (e) { return {}; }
  }

  function hasCartItems(c) {
    return Object.keys(c || {}).some(function (id) {
      return parseInt(c[id], 10) > 0;
    });
  }

  // Per-line race guard: prevent double-click +/- from racing two change.js requests
  // for the same line. Different lines should not block each other.
  var inFlightLines = {};

  function cartSetActive(active) {
    try {
      if (active) sessionStorage.setItem(CART_FLOW_KEY, '1');
      else sessionStorage.removeItem(CART_FLOW_KEY);
    } catch (e) {}
  }

  function cartHasActiveFlow() {
    try { return sessionStorage.getItem(CART_FLOW_KEY) === '1'; }
    catch (e) { return false; }
  }

  function cartSet(c) {
    try {
      sessionStorage.setItem(CART_KEY, JSON.stringify(c));
      cartSetActive(hasCartItems(c));
    }
    catch (e) {}
  }

  shouldResetCartOnLoad = !cartHasActiveFlow() || isPostCheckout();

  function cartAddItem(variantId, qty) {
    var c = cartGet();
    var k = String(variantId);
    c[k] = (c[k] || 0) + qty;
    cartSet(c);
  }

  function cartToItems() {
    var c = cartGet();
    return Object.keys(c).map(function (id) {
      return { id: parseInt(id, 10), quantity: c[id] };
    });
  }

  // Перестраивает локальную корзину из массива cart.items, который вернул
  // сервер. Это единственный надёжный источник истины после операции —
  // строим состояние из факта, а не угадываем дельты.
  function syncLocalFromServerItems(items) {
    var c = {};
    (items || []).forEach(function (line) {
      var vid = String(line.variant_id);
      c[vid] = (c[vid] || 0) + line.quantity;
    });
    cartSet(c);
    return c;
  }

  function applyDrawerResponse(data, fallbackCount) {
    var html = data.sections && data.sections['cart-drawer-section'];
    if (html) {
      replaceCartDrawer(html);
      var count = parseItemCount(html);
      updateHeaderCartCount(count !== null ? count : fallbackCount);
      // Notify the Complete-the-Set nudge to recompute (drawer was re-rendered).
      window.dispatchEvent(new CustomEvent('adl:cart:rendered'));
    }
  }

  // ── Точечное добавление товара ─────────────────────────────────────────────
  // cart/add.js ПРИБАВЛЯЕТ количество к существующей строке. Поэтому сюда
  // передаём РОВНО ту дельту, которую пользователь добавляет сейчас — а не
  // пересчитанный локальный итог (иначе старое количество учлось бы дважды).
  // Локальное состояние уже обновлено оптимистично через cartAddItem выше по
  // стеку — здесь только подтверждаем его или откатываем при ошибке.
  function addToServerCart(variantId, quantity, done) {
    var cartRoot = getCartRoot();
    setLoading(true);
    fetch(cartRoot + 'cart/add.js', {
      method: 'POST',
      body: JSON.stringify({ items: [{ id: parseInt(variantId, 10), quantity: quantity }], sections: 'cart-drawer-section' }),
      credentials: 'same-origin',
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' }
    })
    .then(function (r) { return r.json().then(function (data) { return { ok: r.ok, data: data }; }); })
    .then(function (res) {
      if (!res.ok) throw new Error(res.data.description || res.data.message || 'Error');
      applyDrawerResponse(res.data, cartToItems().length);
      if (done) done(null, res.data);
    })
    .catch(function (err) { if (done) done(err, null); })
    .finally(function () { setLoading(false); });
  }

  // ── Установка точного количества для конкретной строки ────────────────────
  // cart/change.js — единственный AJAX-эндпоинт, который ЗАМЕНЯЕТ количество
  // строки (а не прибавляет к нему). id — line_item.key вида "VARIANT_ID:HASH",
  // однозначно определяет строку даже если один и тот же вариант лежит в
  // корзине несколько раз с разными свойствами. Так же устроены штатные
  // обработчики в snippets/cart-items.liquid — мы просто перехватываем клик
  // раньше них (capture phase) и используем тот же самый эндпоинт.
  function changeLine(lineId, quantity, done) {
    // Per-line race guard: if a request for this line is in flight, drop the new click.
    if (inFlightLines[lineId]) {
      if (done) done(null, null);  // silent no-op
      return;
    }
    inFlightLines[lineId] = true;
    var cartRoot = getCartRoot();
    setLoading(true);
    fetch(cartRoot + 'cart/change.js', {
      method: 'POST',
      body: JSON.stringify({ id: lineId, quantity: quantity, sections: 'cart-drawer-section' }),
      credentials: 'same-origin',
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' }
    })
    .then(function (r) { return r.json().then(function (data) { return { ok: r.ok, data: data }; }); })
    .then(function (res) {
      if (!res.ok) throw new Error(res.data.description || res.data.message || 'Error');

      // Защита от «фантомной пустой корзины»: мы только что ПОВЫСИЛИ
      // количество строки (quantity > 0), поэтому корзина физически не может
      // оказаться пустой. Если сервер всё же вернул item_count: 0 — значит,
      // он потерял сессию и подменил её новой пустой (см. диагностику бага
      // с пустым /cart — токен корзины менялся на каждой загрузке в приватном
      // режиме). Доверять такому ответу и затирать им локальную корзину
      // нельзя — вместо этого запускаем полную ресинхронизацию, которая
      // воссоздаст содержимое локальной корзины на сервере.
      if (quantity > 0 && res.data.item_count === 0) {
        sendCart(done);
        return;
      }

      syncLocalFromServerItems(res.data.items);
      applyDrawerResponse(res.data, res.data.item_count);
      if (done) done(null, res.data);
    })
    .catch(function (err) { if (done) done(err, null); })
    .finally(function () {
      setLoading(false);
      delete inFlightLines[lineId];  // always release the lock
    });
  }

  // ── Полная ресинхронизация сервера с локальной корзиной ────────────────────
  // Нужна только при загрузке страницы: серверная корзина могла «протухнуть»
  // или быть очищена чекаутом, а sessionStorage остаётся источником истины.
  // В отличие от подхода «clear, затем add», корзина здесь НИКОГДА не проходит
  // через полностью пустое состояние: существующие строки получают точные
  // количества через cart/update.js (абсолютные значения, 0 удаляет строку),
  // а варианты, которых ещё нет на сервере, добавляются через cart/add.js.
  // Если update упадёт — до add дело не дойдёт, корзина останется в прежнем,
  // непустом виде (а не превратится в пустую, как при подходе «clear первым»,
  // который, по всей видимости, и вызвал баг с «пустой корзиной» на /cart).
  function sendCart(done) {
    var localItems = cartGet();
    var cartRoot = getCartRoot();
    setLoading(true);

    fetch(cartRoot + 'cart.js', {
      credentials: 'same-origin',
      headers: { 'Accept': 'application/json' }
    })
    .then(function (r) { return r.json(); })
    .then(function (serverCart) {
      var updates = {};
      var serverHasVariant = {};

      (serverCart.items || []).forEach(function (line) {
        var vid = String(line.variant_id);
        serverHasVariant[vid] = true;
        updates[vid] = localItems[vid] || 0;
      });

      var toAdd = [];
      Object.keys(localItems).forEach(function (vid) {
        if (!serverHasVariant[vid] && localItems[vid] > 0) {
          toAdd.push({ id: parseInt(vid, 10), quantity: localItems[vid] });
        }
      });

      var chain = Promise.resolve();

      if (Object.keys(updates).length > 0) {
        chain = chain.then(function () {
          return fetch(cartRoot + 'cart/update.js', {
            method: 'POST',
            body: JSON.stringify({ updates: updates }),
            credentials: 'same-origin',
            headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' }
          })
          .then(function (r) { return r.json().then(function (data) { return { ok: r.ok, data: data }; }); })
          .then(function (res) {
            if (!res.ok) throw new Error(res.data.description || res.data.message || 'Update error');
          });
        });
      }

      return chain.then(function () {
        if (toAdd.length > 0) {
          return fetch(cartRoot + 'cart/add.js', {
            method: 'POST',
            body: JSON.stringify({ items: toAdd, sections: 'cart-drawer-section' }),
            credentials: 'same-origin',
            headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' }
          });
        }
        return fetch(cartRoot + 'cart/update.js', {
          method: 'POST',
          body: JSON.stringify({ updates: {}, sections: 'cart-drawer-section' }),
          credentials: 'same-origin',
          headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' }
        });
      })
      .then(function (r) { return r.json().then(function (data) { return { ok: r.ok, data: data }; }); })
      .then(function (res) {
        if (!res.ok) throw new Error(res.data.description || res.data.message || 'Error');
        syncLocalFromServerItems(res.data.items);
        applyDrawerResponse(res.data, res.data.item_count);
        if (done) done(null, res.data);
      });
    })
    .catch(function (err) { if (done) done(err, null); })
    .finally(function () { setLoading(false); });
  }

  // ── Принятие серверной корзины как истины при «холодном» старте ───────────
  // sessionStorage живёт в пределах вкладки. Новая вкладка, возврат на сайт
  // (в т.ч. из abandoned-cart письма) или переход после чекаута — везде
  // локальный стор пуст, но серверная корзина может быть полна. Раньше здесь
  // выполнялся sendCart() с пустым стором, который ОБНУЛЯЛ все строки
  // серверной корзины — покупатели теряли корзину. Теперь наоборот: при
  // холодном старте локальный стор строится из серверной корзины (после
  // чекаута Shopify сам её очищает, так что пост-чекаут кейс покрыт тем же
  // путём). sendCart() остаётся только для активной сессии с непустым локальным
  // стором — починка протухшей серверной корзины (исходный баг «пустой /cart»).
  function adoptServerCart() {
    fetch(getCartRoot() + 'cart.js', {
      credentials: 'same-origin',
      headers: { 'Accept': 'application/json' }
    })
    .then(function (r) { return r.json(); })
    .then(function (serverCart) {
      syncLocalFromServerItems(serverCart.items);
      updateHeaderCartCount(serverCart.item_count);
    })
    .catch(function () { /* серверная корзина недоступна — ничего не трогаем */ });
  }

  if (shouldResetCartOnLoad) {
    adoptServerCart();
  } else if (hasCartItems(cartGet())) {
    sendCart();
  }

  // Если строку изменил inline-обработчик из cart-items.liquid (страница /cart),
  // он шлёт cart:updated с ответом change.js — синхронизируем локальный стор,
  // чтобы sendCart() на следующей навигации не откатил изменения.
  window.addEventListener('cart:updated', function (e) {
    if (e.detail && e.detail.items) syncLocalFromServerItems(e.detail.items);
  });

  // ── Add to Cart (capture phase) ────────────────────────────────────────────
  document.addEventListener('click', function (event) {
    var button = event.target.closest && event.target.closest('[data-action="add-to-cart"], .ProductForm__AddToCart');
    if (!button) return;
    var form = button.closest('form[action*="/cart/add"]');
    if (!form) return;
    if (form.dataset.adelinaAdding === 'true') return;

    event.preventDefault();
    event.stopImmediatePropagation();

    var formData = new FormData(form);
    var variantId = (formData.get ? formData.get('id') : null) || ((form.querySelector('[name="id"]') || {}).value);
    var quantity = parseInt((formData.get ? formData.get('quantity') : null) || ((form.querySelector('[name="quantity"]') || {}).value), 10) || 1;
    if (!variantId) return;

    var prevCart = cartGet();
    cartAddItem(variantId, quantity);

    form.dataset.adelinaAdding = 'true';
    button.setAttribute('disabled', 'disabled');

    addToServerCart(variantId, quantity, function (err) {
      if (err) {
        cartSet(prevCart); // откат при ошибке
        showError(button, err.message);
      } else {
        openCartDrawer();
      }
      form.dataset.adelinaAdding = 'false';
      button.removeAttribute('disabled');
    });
  }, true);

  // На странице /cart дровер (#sidebar-cart) не рендерится, и наш capture-
  // обработчик не умеет перерисовывать разметку страницы корзины. Там работает
  // inline-скрипт из cart-items.liquid (?view=ajax → замена секции), а мы
  // подхватываем его результат через событие cart:updated выше.
  function isCartPage() {
    return window.theme && window.theme.template === 'cart' && !document.getElementById('sidebar-cart');
  }

  // ── Drawer: кнопки +/- и удалить (capture phase) ──────────────────────────
  document.addEventListener('click', function (e) {
    if (isCartPage()) return;
    var minus  = e.target.closest('[data-quantity-minus]');
    var plus   = e.target.closest('[data-quantity-plus]');
    var remove = e.target.closest('[data-remove-item]');
    var btn    = minus || plus || remove;
    if (!btn) return;

    var lineId = btn.getAttribute('data-line-id');
    if (!lineId) return;
    var variantId = btn.getAttribute('data-variant-id');

    e.preventDefault();
    e.stopImmediatePropagation();

    // Снимок локальной корзины ДО изменения — нужен для отката при ошибке
    // и для того, чтобы запасной sendCart() (на случай «фантомной пустой
    // корзины», см. changeLine) опирался на актуальное намерение пользователя,
    // а не на устаревшее значение, записанное до клика.
    var prevLocalCart = cartGet();

    if (remove) {
      if (variantId) cartAddItem(variantId, -(prevLocalCart[variantId] || 0));
      changeLine(lineId, 0, function (err) {
        if (err) {
          cartSet(prevLocalCart); // откат локальной корзины при ошибке
          sendCart(); // тихая ресинхронизация при ошибке удаления
        }
      });
      return;
    }

    var input = document.querySelector('input[data-line-id="' + lineId + '"][data-quantity-input]');
    var prevQty = input ? (parseInt(input.value, 10) || 1) : 1;
    var newQty = minus ? prevQty - 1 : prevQty + 1;
    if (newQty < 0) newQty = 0;

    // Оптимистичное обновление поля И локальной корзины — сервер подтвердит
    // или скорректирует значение. Обновлять только DOM недостаточно: если
    // changeLine() обнаружит «фантомную пустую корзину» и откатится на
    // sendCart(), та читает именно cartGet() — и должна увидеть уже новое,
    // желаемое количество, а не старое.
    if (input) {
      input.value = newQty;
      var minBtn = document.querySelector('[data-quantity-minus][data-line-id="' + lineId + '"]');
      if (minBtn) minBtn.disabled = (newQty <= 1);
    }
    if (variantId) cartAddItem(variantId, newQty - prevQty);

    changeLine(lineId, newQty, function (err) {
      if (err) {
        if (input) input.value = prevQty;
        cartSet(prevLocalCart); // откат локальной корзины при ошибке
        showError(btn, err.message);
      }
    });
  }, true);

  // ── Drawer: ввод количества ────────────────────────────────────────────────
  document.addEventListener('change', function (e) {
    if (isCartPage()) return;
    var input = e.target.closest('[data-quantity-input]');
    if (!input) return;
    var lineId = input.getAttribute('data-line-id');
    if (!lineId) return;
    var variantId = input.getAttribute('data-variant-id');
    var qty = parseInt(input.value, 10);
    if (isNaN(qty) || qty < 0) qty = 0;
    e.stopImmediatePropagation();

    var prevLocalCart = cartGet();
    var prevQty = variantId ? (prevLocalCart[variantId] || 0) : null;
    if (variantId) cartAddItem(variantId, qty - prevQty);

    changeLine(lineId, qty, function (err) {
      if (err) {
        cartSet(prevLocalCart);
        showError(input, err.message);
      }
    });
  }, true);

  // ── Checkout ───────────────────────────────────────────────────────────────
  // Build a Shopify cart permalink from the local cart state. This is a normal
  // page navigation, so Markets creates the checkout from the intended items.
  // After the permalink redirect lands on /cart, localStorage flag triggers
  // form.submit() which bypasses all click handlers and goes to checkout.
  document.addEventListener('DOMContentLoaded', function () {
    try {
      if (localStorage.getItem('_adelinaCheckout') !== '1') return;
      localStorage.removeItem('_adelinaCheckout');
      // Только на странице корзины и только форма самой корзины (form.Cart):
      // на других страницах селектор form[action*="/cart"] матчил бы форму
      // /cart/add товара, и протухший флаг вызывал бы неожиданный сабмит.
      if (!window.theme || window.theme.template !== 'cart') return;
      var cartForm = document.querySelector('form.Cart[action*="/cart"]');
      if (cartForm) cartForm.submit();
    } catch (e) {}
  });

  document.addEventListener('click', function (e) {
    var btn = e.target.closest('button[name="checkout"], .Cart__Checkout');
    if (!btn) return;
    // On the cart page the native form submit handles checkout — don't intercept
    if (window.theme && window.theme.template === 'cart') return;
    var items = cartToItems();
    if (items.length === 0) return;

    e.preventDefault();
    e.stopImmediatePropagation();

    var path = items.map(function (item) {
      return item.id + ':' + item.quantity;
    }).join(',');

    try { localStorage.setItem('_adelinaCheckout', '1'); } catch (e) {}
    window.location.href = getCartRoot() + 'cart/' + path;
  }, true);

  // ── Drawer: закрытие ───────────────────────────────────────────────────────
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-action="close-drawer"][data-drawer-id="sidebar-cart"]');
    if (!btn) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    closeCartDrawer();
  }, true);
})();
