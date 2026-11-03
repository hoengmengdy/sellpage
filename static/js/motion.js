'use strict';

// Visual effects only; the storefront in app.js works without this file.
(() => {
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const finePointer = matchMedia('(hover: hover) and (pointer: fine)').matches;
  const topbar = document.querySelector('.topbar');
  const progress = document.getElementById('scrollProgress');

  // Scroll progress bar and compact topbar.
  let ticking = false;
  function onScroll() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      const max = document.documentElement.scrollHeight - innerHeight;
      progress.style.transform = `scaleX(${max > 0 ? scrollY / max : 0})`;
      topbar.classList.toggle('scrolled', scrollY > 30);
      ticking = false;
    });
  }
  addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  // Bootstrap tooltips on the header icon buttons.
  if (window.bootstrap && finePointer) {
    document.querySelectorAll('#searchToggle, #cartToggle, .account-link').forEach(element => {
      element.setAttribute('data-bs-title', element.getAttribute('aria-label'));
      new bootstrap.Tooltip(element, { placement: 'bottom', trigger: 'hover' });
    });
  }

  if (reduceMotion) return;

  // Scroll reveal for static sections and for product cards rendered by app.js.
  const revealer = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      const element = entry.target;
      element.classList.add('in');
      revealer.unobserve(element);
      // Drop the reveal classes afterwards so hover/tilt transitions are not delayed.
      setTimeout(() => element.classList.remove('reveal', 'in'), 900 + (Number(element.style.getPropertyValue('--i')) || 0) * 70);
    });
  }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });

  function reveal(elements) {
    elements.forEach((element, index) => {
      element.classList.add('reveal');
      element.style.setProperty('--i', index % 8);
      revealer.observe(element);
    });
  }
  reveal(document.querySelectorAll('.service-strip > *'));
  reveal(document.querySelectorAll('.section-heading, .catalog-toolbar, .catalog-note'));
  reveal(document.querySelectorAll('.benefits-panel > *, .benefit-list > div, .contact-card, .footer-main > *'));

  const grid = document.getElementById('productGrid');
  new MutationObserver(() => reveal(grid.querySelectorAll('.product-card:not(.reveal)'))).observe(grid, { childList: true });
  reveal(grid.querySelectorAll('.product-card'));

  // Cart badge bump when its count changes.
  const cartCount = document.getElementById('cartCount');
  let lastCount = cartCount.textContent;
  new MutationObserver(() => {
    if (cartCount.textContent === lastCount) return;
    lastCount = cartCount.textContent;
    cartCount.classList.remove('bump');
    void cartCount.offsetWidth;
    cartCount.classList.add('bump');
  }).observe(cartCount, { childList: true, characterData: true, subtree: true });

  if (finePointer) {
    // 3D tilt + spotlight on product cards.
    grid.addEventListener('pointermove', event => {
      const card = event.target.closest('.product-card');
      if (!card || card.classList.contains('reveal')) return;
      const rect = card.getBoundingClientRect();
      const x = (event.clientX - rect.left) / rect.width;
      const y = (event.clientY - rect.top) / rect.height;
      card.classList.add('tilting');
      card.style.transform = `translateY(-8px) rotateX(${(0.5 - y) * 14}deg) rotateY(${(x - 0.5) * 16}deg)`;
      card.style.setProperty('--mx', `${x * 100}%`);
      card.style.setProperty('--my', `${y * 100}%`);
    });
    grid.addEventListener('pointerout', event => {
      const card = event.target.closest('.product-card');
      if (!card || card.contains(event.relatedTarget)) return;
      card.classList.remove('tilting');
      card.style.transform = '';
    });

    // Hero visual follows the pointer.
    const visual = document.querySelector('.hero-visual');
    const stage = document.createElement('div');
    stage.className = 'tilt-stage';
    stage.append(...visual.children);
    visual.append(stage);
    document.querySelector('.hero').addEventListener('pointermove', event => {
      const rect = visual.getBoundingClientRect();
      const x = (event.clientX - rect.left) / rect.width - 0.5;
      const y = (event.clientY - rect.top) / rect.height - 0.5;
      stage.style.transform = `rotateY(${x * 22}deg) rotateX(${-y * 18}deg)`;
    });
    document.querySelector('.hero').addEventListener('pointerleave', () => { stage.style.transform = ''; });
  }

  // Gold sparks rising through the hero.
  const canvas = document.getElementById('heroSparks');
  const context = canvas.getContext('2d');
  const hero = canvas.parentElement;
  let sparks = [];
  let width = 0;
  let height = 0;
  let running = true;

  function resize() {
    const ratio = Math.min(devicePixelRatio || 1, 2);
    width = hero.clientWidth;
    height = hero.clientHeight;
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    const count = Math.round(Math.min(70, width / 18));
    sparks = Array.from({ length: count }, () => spawn(true));
  }

  function spawn(anywhere) {
    return {
      x: Math.random() * width,
      y: anywhere ? Math.random() * height : height + 10,
      r: Math.random() * 1.8 + 0.4,
      speed: Math.random() * 0.6 + 0.2,
      drift: (Math.random() - 0.5) * 0.4,
      alpha: Math.random() * 0.6 + 0.2,
    };
  }

  function frame() {
    if (!running) return;
    context.clearRect(0, 0, width, height);
    sparks.forEach((spark, index) => {
      spark.y -= spark.speed;
      spark.x += spark.drift;
      if (spark.y < -10) sparks[index] = spawn(false);
      context.beginPath();
      context.fillStyle = `rgba(255, 196, 40, ${spark.alpha * Math.min(1, spark.y / (height * 0.6))})`;
      context.shadowColor = '#ffb900';
      context.shadowBlur = 8;
      context.arc(spark.x, spark.y, spark.r, 0, Math.PI * 2);
      context.fill();
    });
    requestAnimationFrame(frame);
  }

  new IntersectionObserver(([entry]) => {
    const visible = entry.isIntersecting && !document.hidden;
    if (visible && !running) { running = true; requestAnimationFrame(frame); }
    else if (!visible) running = false;
  }).observe(hero);
  addEventListener('resize', resize);
  resize();
  requestAnimationFrame(frame);
})();
