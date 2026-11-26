/* ============================================================================
 * app.js — Lógica de interfaz y negocio (anuncios, ofertas, valoraciones)
 * ==========================================================================*/

(async function init() {
  await Store.loadProfile();
  const localId = await P2P.initLocalId();
  document.getElementById('userIdLabel').textContent = `ID: ${localId}`;

  // Rellenar el nombre de usuario si ya existe en el perfil.
  if (Store.loadProfile().name) {
    document.getElementById('profileName').value = Store.loadProfile().name;
  }

  /* ---- Helpers de UI ---- */
  const $ = (sel) => document.querySelector(sel);
  const toast = (msg, isError = false) => {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    t.classList.toggle('error', !!isError);
    setTimeout(() => t.classList.add('hidden'), 3200);
  };

  function renderStars(value, sizeClass = '') {
    let html = '<span class="stars ' + sizeClass + '">';
    for (let i = 1; i <= 5; i++) {
      html += `<span>${i <= value ? '★' : '☆'}</span>`;
    }
    html += '</span>';
    return html;
  }

  function avgRating(reviews, targetId) {
    const list = reviews.filter(r => r.targetId === targetId && r.rating > 0);
    if (!list.length) return { avg: 0, count: 0 };
    const sum = list.reduce((s, r) => s + r.rating, 0);
    return { avg: Math.round((sum / list.length) * 10) / 10, count: list.length };
  }

  /* ---- Navegación por pestañas ---- */
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      $(`#tab-${tab.dataset.tab}`).classList.add('active');
    });
  });

  /* ---- Catálogo ---- */
  async function refreshCatalog() {
    const products = await Store.getProducts();
    renderCatalog(products);
    refreshCategoryFilter(products);
  }

  function renderCatalog(products) {
    const grid = $('#catalog');
    if (!products.length) {
      grid.innerHTML = '<p class="hint">Aún no hay anuncios. ¡Publica el primero o conecta con un peer!</p>';
      return;
    }
    grid.innerHTML = products.map(p => `
      <div class="product" data-id="${p.id}">
        <img src="${p.image || placeholderImg()}" alt="${escapeHtml(p.title)}" />
        <div class="body">
          <div class="title">${escapeHtml(p.title)}</div>
          <div class="price">${formatPrice(p.price)}</div>
          <div class="meta"><span>${escapeHtml(p.category || 'Otros')}</span><span>${escapeHtml(p.condition || '')}</span></div>
        </div>
      </div>
    `).join('');
  }

  function placeholderImg() {
    return 'data:image/svg+xml;utf8,' + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="210" height="160" fill="%23ffd9b8"><rect width="210" height="160"/><text x="50%" y="50%" fill="%23ff9a6c" font-family="sans-serif" font-size="40" text-anchor="middle" dominant-baseline="middle">📦</text></svg>'
    );
  }

  function refreshCategoryFilter(products) {
    const cats = [...new Set(products.map(p => p.category).filter(Boolean))];
    const sel = $('#categoryFilter');
    const current = sel.value;
    sel.innerHTML = '<option value="">Todas las categorías</option>' + cats.map(c => `<option>${escapeHtml(c)}</option>`).join('');
    sel.value = current;
  }

  /* ---- Búsqueda y filtros ---- */
  function applyFilters() {
    const search = $('#searchInput').value.toLowerCase().trim();
    const cat = $('#categoryFilter').value;
    const sort = $('#sortFilter').value;
    Store.getProducts().then(products => {
      let list = products.filter(p =>
        (!cat || p.category === cat) &&
        (search === '' || p.title.toLowerCase().includes(search))
      );
      if (sort === 'price-asc') list.sort((a, b) => a.price - b.price);
      else if (sort === 'price-desc') list.sort((a, b) => b.price - a.price);
      else list.sort((a, b) => b.timestamp - a.timestamp);
      renderCatalog(list);
    });
  }
  $('#searchInput').addEventListener('input', applyFilters);
  $('#categoryFilter').addEventListener('change', applyFilters);
  $('#sortFilter').addEventListener('change', applyFilters);

  /* ---- Modal de detalle del producto ---- */
  function openProductModal(id) {
    Store.getProducts().then(products => {
      const p = products.find(x => x.id === id);
      if (!p) return;

      Store.getReviews().then(reviews => {
        const r = avgRating(reviews, p.authorId);
        $('#modalContent').innerHTML = `
          <img src="${p.image || placeholderImg()}" alt="${escapeHtml(p.title)}" />
          <div class="title" style="font-size:22px">${escapeHtml(p.title)}</div>
          <div class="price">${formatPrice(p.price)}</div>
          <div class="meta"><span>${escapeHtml(p.category || 'Otros')}</span><span>${escapeHtml(p.condition || '')}</span></div>
          <p style="margin-top:12px;white-space:pre-wrap">${escapeHtml(p.description || 'Sin descripción.')}</p>
          <div class="owner">
            <strong>Vendedor:</strong> ${escapeHtml(p.authorName || 'Desconocido')}
            ${r.count ? renderStars(Math.round(r.avg), 'small') + ` (${r.count})` : ''}
          </div>
          <button class="primary" id="offerBtn">💬 Ofrecer un trato</button>
        `;
        $('#offerBtn').addEventListener('click', () => openOfferDialog(p));
        $('#productModal').classList.remove('hidden');
      });
    });
  }

  /* ---- Diálogo de ofrecer trato/oferta ---- */
  function openOfferDialog(product) {
    const dialog = document.createElement('div');
    dialog.className = 'modal';
    dialog.innerHTML = `
      <div class="modal-card">
        <button class="close-btn">&times;</button>
        <h3>Ofrecer un trato: ${escapeHtml(product.title)}</h3>
        <label>Tu oferta (EUR):
          <input type="number" id="offerAmount" min="0" step="0.01" value="${product.price}" />
        </label>
        <label>Mensaje para el vendedor:
          <textarea id="offerMessage" rows="3" placeholder="Hola, me interesa tu producto..."></textarea>
        </label>
        <button class="primary" id="confirmOffer">Enviar oferta</button>
      </div>
    `;
    document.body.appendChild(dialog);

    const close = () => dialog.remove();
    dialog.querySelector('.close-btn').addEventListener('click', close);
    dialog.addEventListener('click', e => { if (e.target === dialog) close(); });

    dialog.querySelector('#confirmOffer').addEventListener('click', async () => {
      const amount = parseFloat(dialog.querySelector('#offerAmount').value);
      const message = dialog.querySelector('#offerMessage').value.trim();
      if (!amount || amount <= 0) { toast('Introduce una oferta válida.', true); return; }

      await Store.addDeal({
        type: 'received',
        productId: product.id,
        productTitle: product.title,
        price: product.price,
        offerAmount: amount,
        message,
        sellerId: product.authorId,
        sellerName: product.authorName,
        buyerId: Store.loadProfile().name || 'invitado',
        status: 'pending',
      });
      close();
      toast('Oferta enviada. El vendedor lo revisará.');
      renderDeals();
    });
  }

  /* ---- Renderizar ofertas / tratos ---- */
  async function renderDeals() {
    const deals = await Store.getDeals();
    const el = $('#dealsList');
    if (!deals.length) {
      el.innerHTML = '<p class="hint">Aún no tienes ofertas ni tratos.</p>';
      return;
    }
    el.innerHTML = deals.slice().reverse().map(d => {
      const statusText = {
        pending: '⏳ Pendiente',
        accepted: '✅ Aceptada',
        rejected: '❌ Rechazada',
        closed: '🎪 Compra cerrada',
      }[d.status] || d.status;
      return `
        <div class="card">
          <strong>${escapeHtml(d.productTitle)}</strong> — ${formatPrice(d.price)}
          <div class="meta">Oferta: <strong style="color:var(--accent)">${formatPrice(d.offerAmount)}</strong> · ${statusText}</div>
          <p style="white-space:pre-wrap">${escapeHtml(d.message || '')}</p>
          ${renderDealActions(d)}
        </div>
      `;
    }).join('');
  }

  function renderDealActions(deal) {
    if (deal.type === 'received' && deal.status === 'pending') {
      return `<div style="display:flex;gap:8px">
        <button class="primary" data-act="accept" data-id="${deal.id}">Aceptar</button>
        <button data-act="reject" data-id="${deal.id}" style="background:#f0c9a8;color:#5a3a24;border:1px solid var(--border);padding:8px 14px;border-radius:8px;cursor:pointer">Rechazar</button>
      </div>`;
    }
    if (deal.type === 'sent' && deal.status === 'pending') {
      return `<p class="hint">Esperando respuesta del vendedor...</p>`;
    }
    if (deal.type === 'received' && deal.status === 'accepted') {
      return `<div style="display:flex;gap:8px">
        <button data-act="buy" data-id="${deal.id}" class="primary">Confirmar compra</button>
      </div>`;
    }
    return '';
  }

  /* ---- Acciones de ofertas (delegación de eventos) ---- */
  $('#dealsList').addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn || !btn.dataset.act) return;
    const id = btn.dataset.id;
    const act = btn.dataset.act;

    if (act === 'accept') await Store.updateDeal(id, { status: 'accepted' });
    else if (act === 'reject') await Store.updateDeal(id, { status: 'rejected' });
    else if (act === 'buy') {
      const deals = await Store.getDeals();
      const deal = deals.find(d => d.id === id);
      await Store.updateDeal(id, { status: 'closed', closedAt: Date.now() });
      toast('¡Compra registrada! Gracias por tu compra.');
      // Pedir valoración del vendedor tras cerrar la compra.
      if (deal && deal.sellerId) requestReview(deal.sellerId);
    }
    renderDeals();
  });

  /* ---- Sistema de valoraciones con estrellas ---- */
  function requestReview(targetId) {
    const dialog = document.createElement('div');
    dialog.className = 'modal';
    dialog.innerHTML = `
      <div class="modal-card">
        <button class="close-btn">&times;</button>
        <h3>Valorar al vendedor</h3>
        <p class="hint">¿Cómo ha sido tu experiencia? (1–5 estrellas)</p>
        <div id="starRating" style="font-size:36px"></div>
        <input type="hidden" id="selectedRating" value="0" />
        <label>Comentario (opcional):
          <textarea id="reviewText" rows="2"></textarea>
        </label>
        <button class="primary" id="submitReview">Enviar valoración</button>
      </div>
    `;
    document.body.appendChild(dialog);

    const ratingInput = dialog.querySelector('#selectedRating');
    const starContainer = dialog.querySelector('#starRating');
    let current = 0;

    function paintStars(n) {
      starContainer.innerHTML = '';
      for (let j = 1; j <= 5; j++) {
        const s = document.createElement('span');
        s.textContent = j <= n ? '★' : '☆';
          s.style.cssText = 'color:' + (j <= n ? 'var(--star)' : '#e6d3bf') + ';font-size:36px;';
        starContainer.appendChild(s);
      }
    }

    paintStars(0);
    for (let i = 1; i <= 5; i++) {
      const b = document.createElement('button');
      b.className = 'star-btn';
      b.textContent = i <= current ? '★' : '☆';
      b.style.cssText = 'font-size:36px;margin:0 4px;cursor:pointer;color:#e6d3bf;background:none;border:none;';
      b.addEventListener('click', () => {
        current = i;
        ratingInput.value = i;
        paintStars(i);
      });
      starContainer.appendChild(b);
    }

    const close = () => dialog.remove();
    dialog.querySelector('.close-btn').addEventListener('click', close);
    dialog.addEventListener('click', e => { if (e.target === dialog) close(); });
    dialog.querySelector('#submitReview').addEventListener('click', async () => {
      const rating = parseInt(ratingInput.value, 10);
      if (!rating) { toast('Elige una puntuación.', true); return; }
      await Store.addReview({
        targetId: targetId || null,
        authorName: Store.loadProfile().name || 'invitado',
        rating,
        comment: dialog.querySelector('#reviewText').value.trim(),
        reviewType: 'seller',
      });
      close();
      toast('¡Valoración enviada!');
      renderMyRating();
    });
  }

  /* ---- Perfil ---- */
  $('#saveProfileBtn').addEventListener('click', async () => {
    const name = document.getElementById('profileName').value.trim();
    if (!name) { toast('Introduce un nombre de usuario.', true); return; }
    await Store.saveProfile({ name });
    toast('Perfil guardado.');
  });

  document.getElementById('profileImage').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const dataUrl = await readFileAsDataURL(file);
    await Store.saveProfile({ avatar: dataUrl });
    toast('Foto de perfil actualizada.');
  });

  /* ---- Publicar anuncio ---- */
  $('#publishForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const fd = new FormData(form);
    const title = fd.get('title').trim();
    const price = parseFloat(fd.get('price'));
    const profile = Store.loadProfile();

    if (!profile.name) { toast('Primero configura tu nombre de usuario en Perfil.', true); return; }

    let image = '';
    const file = form.querySelector('[name=image]').files[0];
    if (file) image = await readFileAsDataURL(file);

    await Store.addProduct({
      title,
      category: fd.get('category'),
      price,
      condition: fd.get('condition'),
      description: fd.get('description').trim(),
      image,
      authorId: P2P.localId,
      authorName: profile.name,
    });

    form.reset();
    toast('Anuncio publicado y difundido a los peers conectados.');
    document.querySelector('.tab[data-tab="marketplace"]').click();
    await refreshCatalog();
  });

  /* ---- Eventos de catálogo (modal) ---- */
  $('#catalog').addEventListener('click', (e) => {
    const product = e.target.closest('.product');
    if (product) openProductModal(product.dataset.id);
  });

  $('#closeModal').addEventListener('click', () => $('#productModal').classList.add('hidden'));
  $('#productModal').addEventListener('click', e => { if (e.target.id === 'productModal') $('#productModal').classList.add('hidden'); });

  /* ---- Gestión de servidores públicos de señalización ---- */
  function renderServersModal() {
    const list = Store.getSignalingServers();
    const el = $('#serversList');
    el.innerHTML = '';
    list.forEach((s) => {
      const li = document.createElement('li');
      li.className = 'server-item';
      li.innerHTML = `
        <div class="server-info">
          <strong>${escapeHtml(s.name)}</strong>
          <div style="color:var(--muted);font-size:13px">${escapeHtml(s.url)}</div>
        </div>
        <button class="ghost" data-remove="${escapeHtml(s.url)}">🗑️ Dar de baja</button>`;
      el.appendChild(li);
    });

    el.querySelectorAll('button[data-remove]').forEach((b) => {
      b.addEventListener('click', async () => {
        const url = b.dataset.remove;
        const next = Store.saveSignalingServers(list.filter((x) => x.url !== url));
        renderServersModal();
        refreshServerSelect(next);
        toast('Servidor dado de baja.');
      });
    });
  }

  function refreshServerSelect(list) {
    const sel = $('#serverSelect');
    const current = sel.value;
    sel.innerHTML = '';
    list.forEach((s, i) => {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = s.name + (isLocalUrl(s.url) ? ' · local' : '');
      opt.dataset.url = s.url;
      sel.appendChild(opt);
    });
    if (current !== '' && list.some((s) => s.url === current)) {
      const idx = list.findIndex((s) => s.url === current);
      sel.value = String(idx);
    } else if (list.length) {
      sel.value = '0';
    }
  }

  function isLocalUrl(url) {
    try { const u = new URL(url); return u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.protocol === 'file:'; }
    catch { return false; }
  }

  /* ---- Conectar peers (señalización por servidor público) ---- */
  function currentServer() {
    const list = Store.getSignalingServers();
    const sel = $('#serverSelect');
    const idx = parseInt(sel.value, 10);
    return list[idx] || (list[0] ? list[0] : null);
  }

  $('#editServersBtn').addEventListener('click', () => {
    renderServersModal();
    $('#serversModal').classList.remove('hidden');
  });
  $('#closeServersModal').addEventListener('click', () => $('#serversModal').classList.add('hidden'));
  $('#serversModal').addEventListener('click', (e) => { if (e.target.id === 'serversModal') $('#serversModal').classList.add('hidden'); });

  $('#addServerForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#newServerName').value.trim();
    let url = $('#newServerUrl').value.trim();
    if (!name || !url) { toast('Rellena nombre y URL.', true); return; }
    try { new URL(url); } catch { toast('La URL no es válida.', true); return; }
    const list = Store.getSignalingServers();
    list.push({ name, url });
    Store.saveSignalingServers(list);
    $('#addServerForm').reset();
    renderServersModal();
    refreshServerSelect(Store.getSignalingServers());
    toast('Servidor añadido.');
  });

  function setPeerMode(mode) {
    const info = $('#roomInfo');
    if (mode === 'creating') {
      info.classList.remove('hidden');
      info.innerHTML = '<p class="hint">Comparte este código con la otra persona:</p><div id="codeBox" class="code-box"></div>';
    } else if (mode === 'joining') {
      info.classList.remove('hidden');
      info.innerHTML = '<p class="hint">Esperando a que el peer se una... La conexión se establece automáticamente.</p>';
    }
  }

  $('#createRoomBtn').addEventListener('click', async () => {
    const server = currentServer();
    if (!server) { toast('Añade al menos un servidor de señalización.', true); return; }
    setPeerMode('creating');
    try {
      const res = await P2P.invite(server.url);
      $('#codeBox').textContent = res.code;
      toast('Sala creada. Comparte el código ' + res.code + '.');
    } catch (err) {
      toast('Error al crear la sala: ' + err.message, true);
      setPeerMode(null);
    }
  });

  $('#joinRoomBtn').addEventListener('click', async () => {
    const server = currentServer();
    const code = $('#roomCodeInput').value.trim().toUpperCase();
    if (!server) { toast('Añade al menos un servidor de señalización.', true); return; }
    if (!code) { toast('Introduce el código de sala.', true); return; }
    setPeerMode('joining');
    try {
      await P2P.join(server.url, code);
      $('#roomCodeInput').value = '';
      toast('Conectado con el peer. Sincronizando datos...');
    } catch (err) {
      toast('Error al unirse a la sala: ' + err.message, true);
      setPeerMode(null);
    }
  });

  $('#serverSelect').addEventListener('change', () => { setPeerMode(null); });

  /* ---- Valoraciones recibidas y resumen del perfil ---- */
  async function renderMyRating() {
    const reviews = await Store.getReviews();
    const { avg, count } = avgRating(reviews, P2P.localId);

    const sum = $('#myRatingSummary');
    if (avg > 0) {
      sum.innerHTML = renderStars(Math.round(avg)) + `<div style="font-size:14px;color:var(--muted)">(${count} valoraciones)</div>`;
    } else {
      sum.textContent = 'Sin valoraciones todavía';
    }

    const received = reviews.filter(r => r.targetId === P2P.localId);
    const list = $('#reviewsReceived');
    if (!received.length) {
      list.innerHTML = '<li class="hint">Aún no has recibido valoraciones.</li>';
    } else {
      list.innerHTML = received.map(r => `
        <li class="review-item">
          ${renderStars(r.rating, 'small')}
          <strong>${escapeHtml(r.authorName || 'Anónimo')}</strong>
          <div style="color:var(--muted);font-size:13px">${escapeHtml(r.comment || '')}</div>
        </li>
      `).join('');
    }
  }

  /* ---- Utilidades ---- */
  function formatPrice(n) { return '€' + Number(n).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function escapeHtml(str) {
    if (str == null) return '';
    return String(str).replace(/[&<>"']/g, s => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[s]));
  }
  function readFileAsDataURL(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  /* ---- Sincronización periódica de seguridad ---- */
  setInterval(() => Store.broadcast(), 15000);

  /* ---- Arranque ---- */
  await refreshCatalog();
  renderMyRating();
  refreshServerSelect(Store.getSignalingServers());
})();
