'use strict';

const $ = selector => document.querySelector(selector);
const TELEGRAM = 'https://t.me/heng_dexter3';
const CATEGORY_NAMES = { page: 'Facebook Page · PE', pe: 'Facebook Page · Reel', account: 'Facebook Account', service: 'Digital Service', other: 'Other', instagram: 'Instagram', tiktok: 'TikTok', youtube: 'YouTube' };
const grid = $('#productGrid');
const search = $('#searchInput');
const modal = $('#productModal');
const cartModal = $('#cartModal');
let products = [];
let loadState = 'loading';
let activeCategory = 'all';
let currentProductId = null;
let toastTimer;
let cartIds = [];

try {
  const saved = JSON.parse(localStorage.getItem('smm-digital-cart') || '[]');
  if (Array.isArray(saved)) cartIds = [...new Set(saved.filter(Number.isSafeInteger))];
} catch { /* The cart also works when browser storage is unavailable. */ }

const money = value => `$${Number(value).toFixed(2)}`;
const cents = value => Math.round(Number(value) * 100);
const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
const isPage = product => ['page', 'pe'].includes(product.category);
const hasOldPrice = product => product.oldPrice !== null && product.oldPrice !== undefined && product.oldPrice !== '';

function webUrl(value, fallback) {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) ? url.href : fallback;
  } catch { return fallback; }
}

function imageUrl(path) {
  if (!path) return location.protocol === 'file:' ? 'static/uploads/page-dashboard.png' : '/static/uploads/page-dashboard.png';
  if (location.protocol === 'file:' && path.startsWith('/')) return path.slice(1);
  return path;
}

// Decimal values without a unit (for example the existing "7.8") are ambiguous.
// Preserve the source label, but never assume it means thousands of followers.
function followerCount(label) {
  const raw = String(label ?? '').trim().replace(/,/g, '');
  const compact = raw.match(/^(\d+(?:\.\d+)?)\s*([km])(?:\s*followers?)?$/i);
  if (compact) return Number(compact[1]) * (compact[2].toLowerCase() === 'k' ? 1000 : 1000000);
  const integer = raw.match(/^(\d+)(?:\s*followers?)?$/i);
  return integer ? Number(integer[1]) : null;
}

function perThousand(product) {
  const followers = followerCount(product.followers);
  return followers > 0 && Number.isFinite(Number(product.price)) ? Number(product.price) * 1000 / followers : null;
}

function bestValueId() {
  const eligible = products.filter(product => isPage(product) && product.status === 'available' && perThousand(product) !== null);
  eligible.sort((a, b) => perThousand(a) - perThousand(b) || Number(a.price) - Number(b.price) || a.id - b.id);
  return eligible[0]?.id;
}

function categoryMatches(product) {
  if (activeCategory === 'all') return true;
  if (activeCategory === 'facebook') return isPage(product);
  return product.category === activeCategory;
}

function render() {
  const term = search.value.trim().toLowerCase();
  const result = products.filter(product => categoryMatches(product) && `${product.name} ${product.followers} ${product.category} ${CATEGORY_NAMES[product.category] || ''} ${product.description || ''}`.toLowerCase().includes(term));
  const bestId = bestValueId();
  grid.innerHTML = result.map(product => {
    const sold = product.status === 'sold';
    return `<article class="product-card ${sold ? 'is-sold' : ''}">
      <div class="product-image"><img src="${escapeHtml(imageUrl(product.image))}" alt="${escapeHtml(product.name)}" loading="lazy" width="480" height="310">${product.discount ? `<span class="discount">${escapeHtml(product.discount)}</span>` : ''}${sold ? '<span class="sold-badge">SOLD</span>' : ''}</div>
      <div class="card-body"><div class="card-category"><span><i class="fa-brands fa-facebook" aria-hidden="true"></i> ${escapeHtml(CATEGORY_NAMES[product.category] || product.category)}</span>${product.id === bestId ? '<span class="value-tag">BEST VALUE</span>' : ''}</div>
      <h3 class="product-name">${escapeHtml(product.name)}</h3><p class="followers"><i class="fa-solid fa-users" aria-hidden="true"></i> ${escapeHtml(product.followers)} <span>followers</span></p>
      <div class="price">${money(product.price)} ${hasOldPrice(product) ? `<del>${money(product.oldPrice)}</del>` : ''}</div>
      <div class="card-actions"><button class="view-button gold-button" data-id="${Number(product.id)}" type="button" aria-label="View details: ${escapeHtml(product.name)}">មើលលម្អិត <i class="fa-solid fa-arrow-right" aria-hidden="true"></i></button><button class="icon-button add-cart" data-id="${Number(product.id)}" type="button" aria-label="Add to cart: ${escapeHtml(product.name)}" ${sold ? 'disabled' : ''}><i class="fa-solid fa-plus" aria-hidden="true"></i></button></div></div>
    </article>`;
  }).join('');
  grid.hidden = result.length === 0;
  grid.setAttribute('aria-busy', 'false');
  $('#productCount').textContent = `ទំនិញ ${result.length} / ${products.length} products`;
  $('#emptyState').hidden = result.length !== 0;
  $('#emptyState h3').textContent = 'រកមិនឃើញទំនិញ';
  $('#emptyState p').textContent = 'សូមសាកល្បងពាក្យស្វែងរក ឬប្រភេទផ្សេងទៀត។';
  $('#resetFilters').textContent = 'បង្ហាញទាំងអស់';
  $('#clearSearch').hidden = !search.value;
}

async function loadProducts() {
  loadState = 'loading';
  $('#emptyState').hidden = true;
  grid.hidden = false;
  grid.setAttribute('aria-busy', 'true');
  grid.innerHTML = '<p class="loading-state" role="status">កំពុងទាញយកទំនិញ…</p>';
  try {
    let data;
    const snapshot = window.STOREFRONT_PRODUCTS;
    if (location.protocol === 'file:' && Array.isArray(snapshot)) {
      data = snapshot;
    } else {
      try {
        const response = await fetch('/api/products', { cache: 'no-store', signal: AbortSignal.timeout(12000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json();
        if (!payload.success || !Array.isArray(payload.products)) throw new Error('Invalid product response');
        data = payload.products;
      } catch (error) {
        if (!Array.isArray(snapshot)) throw error;
        data = snapshot;
      }
    }
    products = data.filter(product => product.status !== 'hidden');
    loadState = 'ready';
    cartIds = cartIds.filter(id => products.some(product => product.id === id && product.status === 'available'));
    render();
    renderCart();
  } catch (error) {
    loadState = 'error';
    grid.hidden = true;
    grid.setAttribute('aria-busy', 'false');
    $('#emptyState').hidden = false;
    $('#emptyState h3').textContent = 'មិនអាចទាញយកទំនិញបាន';
    $('#emptyState p').textContent = 'Unable to load products. Please try again or contact us on Telegram.';
    $('#resetFilters').textContent = 'Try again / ព្យាយាមម្តងទៀត';
    $('#productCount').textContent = 'Products unavailable';
    $('#cartItems').textContent = 'Products are temporarily unavailable. Please try again.';
    $('#cartCheckout').hidden = true;
    console.error('Failed to load products:', error);
  }
}

function selectCategory(category) {
  activeCategory = category === 'new' ? 'pe' : category;
  document.querySelectorAll('.filter').forEach(button => {
    const active = button.dataset.category === activeCategory;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  document.querySelectorAll('.main-nav a').forEach(link => {
    const active = link.dataset.navCategory === activeCategory || (activeCategory === 'all' && link.getAttribute('href') === '#home');
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  if (loadState === 'ready') render();
}

function openModal(id) {
  const product = products.find(item => item.id === id);
  if (!product) return;
  currentProductId = id;
  const sold = product.status === 'sold';
  $('#modalImage').src = imageUrl(product.image);
  $('#modalImage').alt = product.name;
  $('#modalTitle').textContent = product.name;
  $('#modalCategory').textContent = CATEGORY_NAMES[product.category] || product.category;
  $('#modalStatus').textContent = sold ? 'SOLD / លក់រួច' : 'Available / មានក្នុងស្តុក';
  $('#modalStatus').classList.toggle('sold', sold);
  $('#modalPrice').textContent = money(product.price);
  $('#modalOldPrice').textContent = hasOldPrice(product) ? money(product.oldPrice) : '';
  $('#modalOldPrice').hidden = !hasOldPrice(product);
  $('#modalFollowers').textContent = product.followers;
  $('#modalDescription').textContent = product.description || '';
  const facebook = modal.querySelector('.facebook');
  const telegram = modal.querySelector('.telegram');
  const buy = modal.querySelector('.buy-button');
  facebook.href = webUrl(product.facebook_url, 'https://facebook.com/');
  telegram.href = webUrl(product.telegram_url, TELEGRAM);
  buy.href = telegram.href;
  // Product previews remain accessible for sold listings, but purchase is disabled.
  buy.setAttribute('aria-disabled', String(sold));
  buy.tabIndex = sold ? -1 : 0;
  buy.innerHTML = sold ? '<i class="fa-solid fa-ban" aria-hidden="true"></i> SOLD / លក់រួច' : '<i class="fa-solid fa-bag-shopping" aria-hidden="true"></i> ទិញតាម Telegram';
  $('#modalAddCart').disabled = sold;
  $('#modalAddCart').innerHTML = '<i class="fa-solid fa-plus" aria-hidden="true"></i> Add to cart';
  document.body.classList.add('modal-open');
  modal.showModal();
  $('#modalClose').focus();
}

function toast(message) {
  clearTimeout(toastTimer);
  $('#toast').textContent = message;
  $('#toast').classList.add('visible');
  toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 2500);
}

function addToCart(id) {
  const product = products.find(item => item.id === id && item.status === 'available');
  if (!product) return;
  if (cartIds.includes(id)) return toast('This product is already in your cart.');
  cartIds.push(id);
  renderCart();
  toast('Added to your cart.');
  if (modal.open) $('#modalAddCart').textContent = 'Added to cart ✓';
}

function renderCart() {
  const items = cartIds.map(id => products.find(product => product.id === id && product.status === 'available')).filter(Boolean);
  $('#cartCount').textContent = String(items.length);
  $('#cartToggle').setAttribute('aria-label', `Open shopping cart, ${items.length} products`);
  $('#cartItems').innerHTML = items.length ? items.map(product => `<div class="cart-item"><img src="${escapeHtml(imageUrl(product.image))}" alt=""><div><strong>${escapeHtml(product.name)}</strong><small>${money(product.price)}</small></div><button class="icon-button" data-remove-id="${Number(product.id)}" type="button" aria-label="Remove ${escapeHtml(product.name)} from cart"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button></div>`).join('') : '<p class="section-subtitle">Your cart is empty. Browse the marketplace to choose a product.</p>';
  const totalCents = items.reduce((total, product) => total + cents(product.price), 0);
  $('#cartTotal').textContent = money(totalCents / 100);
  const checkout = $('#cartCheckout');
  checkout.hidden = !items.length;
  const message = `Hello SMM Digital, I would like to ask about these products:\n${items.map(product => `#${product.id} ${product.name} (${product.followers} followers) — ${money(product.price)}`).join('\n')}\nSubtotal: ${money(totalCents / 100)}`;
  checkout.href = `${TELEGRAM}?text=${encodeURIComponent(message)}`;
  try { localStorage.setItem('smm-digital-cart', JSON.stringify(cartIds)); } catch { /* Storage is optional. */ }
}

function closeMenu() {
  $('#mainNav').classList.remove('open');
  $('#menuToggle').setAttribute('aria-expanded', 'false');
  $('#menuToggle').setAttribute('aria-label', 'Open navigation');
}

$('#filters').addEventListener('click', event => {
  const button = event.target.closest('.filter');
  if (button) selectCategory(button.dataset.category);
});
$('#mainNav').addEventListener('click', event => {
  const link = event.target.closest('a');
  if (!link) return;
  selectCategory(link.dataset.navCategory || 'all');
  closeMenu();
});
search.addEventListener('input', () => { if (loadState === 'ready') render(); });
$('#clearSearch').addEventListener('click', () => { search.value = ''; search.focus(); if (loadState === 'ready') render(); });
$('#resetFilters').addEventListener('click', () => {
  if (loadState === 'error') return loadProducts();
  search.value = '';
  selectCategory('all');
});
$('#searchToggle').addEventListener('click', () => { closeMenu(); search.scrollIntoView({ block: 'center' }); search.focus({ preventScroll: true }); });
$('#menuToggle').addEventListener('click', () => {
  const open = $('#mainNav').classList.toggle('open');
  $('#menuToggle').setAttribute('aria-expanded', String(open));
  $('#menuToggle').setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
});
document.addEventListener('click', event => { if (!event.target.closest('.topbar')) closeMenu(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeMenu(); });
grid.addEventListener('click', event => {
  const detail = event.target.closest('.view-button');
  const add = event.target.closest('.add-cart');
  if (detail) openModal(Number(detail.dataset.id));
  if (add) addToCart(Number(add.dataset.id));
});
$('#modalClose').addEventListener('click', () => modal.close());
$('#modalAddCart').addEventListener('click', () => addToCart(currentProductId));
$('#cartToggle').addEventListener('click', () => { closeMenu(); document.body.classList.add('modal-open'); cartModal.showModal(); });
$('#cartClose').addEventListener('click', () => cartModal.close());
$('#cartItems').addEventListener('click', event => {
  const button = event.target.closest('[data-remove-id]');
  if (!button) return;
  cartIds = cartIds.filter(id => id !== Number(button.dataset.removeId));
  renderCart();
  $('#cartClose').focus();
});
[modal, cartModal].forEach(dialog => {
  dialog.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return;
    const focusable = [...dialog.querySelectorAll('a[href], button:not([disabled]), [tabindex]')]
      .filter(element => element.tabIndex >= 0 && element.getClientRects().length > 0);
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  });
  dialog.addEventListener('close', () => { if (!document.querySelector('dialog[open]')) document.body.classList.remove('modal-open'); });
  dialog.addEventListener('click', event => {
    if (event.target.closest('[aria-disabled="true"]')) event.preventDefault();
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
  });
});

selectCategory('all');
$('#cartCheckout').hidden = true;
$('#cartItems').textContent = 'Loading current products…';
if (location.protocol === 'file:') $('.account-link').href = 'http://127.0.0.1:5500/admin/login';
loadProducts();
