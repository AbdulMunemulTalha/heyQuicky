// ORD-04 product page: pick options → Buy now → form → confirm. Plain script, no framework.
(function () {
  var P = window.HQ_PRODUCT;
  if (!P) return;
  var BN = '০১২৩৪৫৬৭৮৯';
  var bn = function (s) { return String(s).replace(/\d/g, function (d) { return BN[d]; }); };
  var taka = function (n) { return '৳' + Number(n).toLocaleString('en-IN'); };
  var $ = function (id) { return document.getElementById(id); };
  var el = function (tag, attrs, text) { var e = document.createElement(tag); for (var k in attrs || {}) { if (k === 'class') e.className = attrs[k]; else e.setAttribute(k, attrs[k]); } if (text != null) e.textContent = text; return e; };
  var COLOURS = { red: '#d92d20', black: '#111', white: '#fff', blue: '#2b4bff', navy: '#1f2a5a', green: '#1f8a4c', teal: '#2f7d78', pink: '#d97a9a', maroon: '#7a1f2b', yellow: '#f5c518', orange: '#f08a24', purple: '#7a4bd1', grey: '#8a8f98', gray: '#8a8f98', brown: '#7a4b25', cream: '#f1e6cf', golden: '#c9a227', gold: '#c9a227', 'লাল': '#d92d20', 'কালো': '#111', 'সাদা': '#fff', 'নীল': '#2b4bff', 'সবুজ': '#1f8a4c', 'গোলাপি': '#d97a9a', 'মেরুন': '#7a1f2b', 'হলুদ': '#f5c518', 'টিল': '#2f7d78' };
  var isColour = function (name) { return /colou?r|রং|রঙ/i.test(name); };

  var state = { pick: {}, qty: 1, zone: 'inside_dhaka', coupon: '', quote: null, busy: false };
  P.options.forEach(function (o) {
    // Start on the first value that still has stock.
    var first = o.values.find(function (v) { return available(o.name, v); });
    if (first && o.values.length === 1) state.pick[o.name] = first;
  });

  function available(name, value) {
    if (!P.variants.length) return true;
    return P.variants.some(function (v) {
      if (!v.left || v.options[name] !== value) return false;
      return Object.keys(state.pick).every(function (k) { return k === name || !state.pick[k] || v.options[k] === state.pick[k]; });
    });
  }
  function variant() {
    if (!P.variants.length) return null;
    return P.variants.find(function (v) { return v.left && P.options.every(function (o) { return v.options[o.name] === state.pick[o.name]; }); }) || null;
  }
  function missing() { return P.options.filter(function (o) { return !state.pick[o.name]; }).map(function (o) { return o.name; }); }

  function renderOptions() {
    var box = $('opts');
    box.textContent = '';
    P.options.forEach(function (o) {
      var wrap = el('div', { class: 'opt' });
      var lab = el('div', { class: 'lab', id: 'lab-' + o.name });
      lab.appendChild(el('span', null, o.name + (state.pick[o.name] ? ': ' + state.pick[o.name] : '')));
      wrap.appendChild(lab);
      var chips = el('div', { class: 'chips', role: 'radiogroup', 'aria-labelledby': 'lab-' + o.name });
      o.values.forEach(function (v) {
        var on = state.pick[o.name] === v;
        var b = el('button', { type: 'button', class: 'chip' + (on ? ' on' : ''), role: 'radio', 'aria-checked': String(on) });
        var hex = isColour(o.name) && COLOURS[String(v).toLowerCase()];
        if (hex) { var sw = el('span', { class: 'sw' }); sw.style.background = hex; b.appendChild(sw); }
        b.appendChild(document.createTextNode(v));
        if (!available(o.name, v)) { b.disabled = true; b.setAttribute('aria-label', v + ' — স্টক শেষ'); }
        b.onclick = function () { state.pick[o.name] = on ? undefined : v; renderOptions(); };
        chips.appendChild(b);
      });
      wrap.appendChild(chips);
      box.appendChild(wrap);
    });
    var v = variant();
    $('price').textContent = taka(v ? v.price : P.price);
  }

  function show(view) {
    ['product', 'form', 'done'].forEach(function (n) { $('view-' + n).hidden = n !== view; });
    $('back').hidden = view !== 'form';
    window.scrollTo(0, 0);
  }

  function err(id, text) { var e = $(id); e.textContent = text || ''; e.hidden = !text; }

  function renderSum() {
    var v = variant();
    var unit = v ? v.price : P.price;
    var q = state.quote;
    var subtotal = q ? q.subtotal : unit * state.qty;
    var z = P.zones.find(function (x) { return x.key === state.zone; });
    var delivery = q ? q.delivery : (P.freeOver && subtotal >= P.freeOver ? 0 : z.charge);
    var discount = q ? q.discount : 0;
    var total = subtotal + delivery - discount;
    var sum = $('sum');
    sum.textContent = '';
    var line = function (a, b, cls) { var d = el('div', cls ? { class: cls } : null); d.appendChild(el('span', null, a)); d.appendChild(el('span', null, b)); sum.appendChild(d); };
    line('পণ্যের দাম', taka(subtotal));
    line('ডেলিভারি', delivery ? taka(delivery) : 'ফ্রি');
    if (discount) line('কুপন ' + (q.coupon || ''), '−' + taka(discount));
    line('মোট (ক্যাশ অন ডেলিভারি)', taka(total), 'tot');
    $('confirm').textContent = 'অর্ডার কনফার্ম করুন · ' + taka(total);
    $('qty').textContent = bn(state.qty);
    $('pick').textContent = P.options.map(function (o) { return state.pick[o.name]; }).filter(Boolean).join(' · ');
  }

  var quoteTimer = null;
  function requote() {
    clearTimeout(quoteTimer);
    state.quote = null;
    renderSum();
    if (!state.coupon) return;
    quoteTimer = setTimeout(function () {
      post('/quote', body()).then(function (r) {
        if (r.ok) { state.quote = r.data; err('e-coupon', ''); } else if (r.data.field === 'coupon') { state.coupon = ''; err('e-coupon', r.data.error); } else { err('e-coupon', ''); }
        renderSum();
      });
    }, 250);
  }

  function renderZones() {
    var box = $('zones');
    box.textContent = '';
    P.zones.forEach(function (z) {
      var on = state.zone === z.key;
      var b = el('button', { type: 'button', class: 'zone' + (on ? ' on' : ''), role: 'radio', 'aria-checked': String(on) });
      b.appendChild(el('strong', null, { inside_dhaka: 'ঢাকার ভিতরে', dhaka_suburbs: 'ঢাকার আশেপাশে', outside_dhaka: 'ঢাকার বাইরে' }[z.key]));
      b.appendChild(el('small', null, taka(z.charge) + ' · ' + z.days));
      b.onclick = function () { state.zone = z.key; renderZones(); requote(); };
      box.appendChild(b);
    });
  }

  // ORD-10: Bangladeshi mobile numbers have 11 digits and start with 013–019 (Bangla digits and +88 are fine).
  function phoneProblem(raw) {
    var d = String(raw || '').replace(/[০-৯]/g, function (c) { return BN.indexOf(c); }).replace(/\D/g, '').replace(/^880/, '0').replace(/^88(?=01)/, '');
    if (!d) return 'মোবাইল নম্বর দিন';
    if (d.length !== 11) return 'নম্বরটি ১১ সংখ্যার হতে হবে (যেমন 01712345678)';
    if (!/^01[3-9]/.test(d)) return 'মোবাইল নম্বর ০১৩ থেকে ০১৯ দিয়ে শুরু হয়';
    return null;
  }

  function body() {
    var v = variant();
    var f = $('form');
    return { sku: v ? v.sku : undefined, qty: state.qty, zone: state.zone, coupon: state.coupon, name: f.name.value.trim(), phone: f.phone.value.trim(), address: f.address.value.trim(), website: f.website.value, c: P.chat };
  }

  function post(path, data) {
    return fetch('/api/p/' + P.shop + '/' + P.id + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) })
      .then(function (res) { return res.json().catch(function () { return {}; }).then(function (d) { return { ok: res.ok, data: d }; }); })
      .catch(function () { return { ok: false, data: { error: 'ইন্টারনেট সংযোগ দেখুন, তারপর আবার চেষ্টা করুন' } }; });
  }

  function confirm() {
    if (state.busy) return;
    var f = $('form');
    var p = phoneProblem(f.phone.value);
    f.phone.setAttribute('aria-invalid', String(Boolean(p)));
    err('e-phone', p);
    err('e-form', '');
    if (!f.name.value.trim()) { err('e-form', 'আপনার নাম লিখুন'); f.name.focus(); return; }
    if (p) { f.phone.focus(); return; }
    if (f.address.value.trim().length < 6) { err('e-form', 'পুরো ঠিকানা লিখুন, যাতে কুরিয়ার খুঁজে পায়'); f.address.focus(); return; }
    state.busy = true;
    var btn = $('confirm');
    btn.setAttribute('aria-disabled', 'true');
    btn.textContent = 'অর্ডার হচ্ছে…';
    post('/order', body()).then(function (r) {
      state.busy = false;
      btn.removeAttribute('aria-disabled');
      if (!r.ok) {
        if (r.data.field === 'phone') { f.phone.setAttribute('aria-invalid', 'true'); err('e-phone', r.data.error); f.phone.focus(); } else if (r.data.field === 'coupon') { state.coupon = ''; state.quote = null; err('e-coupon', r.data.error); } else if (r.data.field === 'options') { show('product'); } else { err('e-form', r.data.error || 'কিছু একটা সমস্যা হয়েছে'); }
        renderSum();
        return;
      }
      done(r.data);
    });
  }

  // ORD-11: what happens next.
  function done(d) {
    var box = $('done');
    box.textContent = '';
    box.appendChild(el('div', { class: 'tick', 'aria-hidden': 'true' }, '✓'));
    box.appendChild(el('h2', null, 'অর্ডার #' + bn(d.number) + ' হয়েছে!'));
    box.appendChild(el('p', null, 'মোট ' + taka(d.total) + (d.inChat ? ' · বিলটি আপনার মেসেঞ্জারে পাঠানো হয়েছে' : '')));
    var steps = el('ol', { class: 'steps' });
    if (d.advance) steps.appendChild(el('li', null, 'অর্ডারটি পাকা করতে ' + taka(d.advance) + ' অগ্রিম পাঠান — বিলের পেজে নম্বর আর নিয়ম আছে।'));
    steps.appendChild(el('li', null, 'দরকার হলে শপ থেকে আপনাকে কল করে অর্ডারটি মিলিয়ে নেবে।'));
    steps.appendChild(el('li', null, 'পার্সেল কুরিয়ারে দেওয়া হলে ট্র্যাকিং জানিয়ে দেওয়া হবে।'));
    steps.appendChild(el('li', null, 'পণ্য হাতে পেয়ে ' + (d.advance ? 'বাকি ' : '') + taka(Math.max(0, d.cod - (d.advance || 0))) + ' ক্যাশ দিন।'));
    box.appendChild(steps);
    var bill = el('a', { class: 'btn primary', href: d.billUrl, style: 'display:block' }, 'বিল ও ট্র্যাকিং দেখুন');
    box.appendChild(bill);
    if (P.messageUrl) { var m = el('a', { class: 'btn', href: P.messageUrl, style: 'display:block;margin-top:10px' }, 'শপকে মেসেজ করুন'); box.appendChild(m); }
    show('done');
  }

  // Wire up.
  renderOptions();
  var slides = $('slides'); var dots = $('dots');
  if (slides && dots) slides.addEventListener('scroll', function () { var i = Math.round(slides.scrollLeft / slides.clientWidth); Array.prototype.forEach.call(dots.children, function (d, j) { d.className = i === j ? 'on' : ''; }); }, { passive: true });
  $('buy').onclick = function () {
    if (!P.inStock) return;
    var need = missing();
    if (need.length || (P.variants.length && !variant())) {
      var first = document.querySelector('#opts .chips');
      var lab = need.length ? need.join(' ও ') + ' বেছে নিন' : 'এই মিলটি স্টকে নেই — অন্যটি বেছে নিন';
      var note = $('need') || el('div', { id: 'need', class: 'err', role: 'alert' });
      note.textContent = lab;
      $('opts').appendChild(note);
      if (first) first.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    var n = $('need'); if (n) n.remove();
    renderZones(); renderSum(); show('form');
    history.pushState({ v: 'form' }, '');
  };
  window.addEventListener('popstate', function () { if (!$('view-form').hidden) show('product'); });
  $('back').onclick = function () { history.back(); };
  $('minus').onclick = function () { if (state.qty > 1) { state.qty--; requote(); } };
  $('plus').onclick = function () { if (state.qty < 99) { state.qty++; requote(); } };
  $('apply').onclick = function () { state.coupon = $('f-coupon').value.trim(); if (!state.coupon) { err('e-coupon', 'কুপন কোড লিখুন'); return; } requote(); };
  $('f-phone').addEventListener('blur', function (e) { if (!e.target.value) return; var p = phoneProblem(e.target.value); e.target.setAttribute('aria-invalid', String(Boolean(p))); err('e-phone', p); });
  $('confirm').onclick = confirm;
  $('form').addEventListener('submit', function (e) { e.preventDefault(); confirm(); });
})();
