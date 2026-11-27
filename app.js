/* ============================================================================
 * app.js — Lógica de interfaz y negocio (anuncios, ofertas, valoraciones)
 * ==========================================================================*/

(async function init() {
  await Store.loadProfile();
  const localId = await P2P.initLocalId();
  document.getElementById('userIdLabel').textContent = `ID: ${localId}`;

  // Rellenar el nombre de usuario si ya existe en el perfil.
  const savedProfile = Store.loadProfile();
  if (savedProfile.name) document.getElementById('profileName').value = savedProfile.name;
  if (savedProfile.city) document.getElementById('profileCity').value = savedProfile.city;

  /* ---- Helpers de UI ---- */
  const $ = (sel) => document.querySelector(sel);
  $('#profileCity').querySelectorAll('optgroup').forEach(group => {
    $('#cityFilter').append(group.cloneNode(true));
  });
  const toast = (msg, isError = false) => {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    t.classList.toggle('error', !!isError);
    setTimeout(() => t.classList.add('hidden'), 3200);
  };

  function renderProfilePreview(profile = Store.loadProfile()) {
    const image = $('#profilePreview');
    const fallback = $('#profileAvatarFallback');
    if (profile.avatar) {
      image.src = profile.avatar;
      image.hidden = false;
      fallback.hidden = true;
    } else {
      image.hidden = true;
      fallback.textContent = (profile.name || '?').charAt(0).toUpperCase();
      fallback.hidden = false;
    }
  }

  renderProfilePreview();

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
      if (tab.dataset.tab === 'my-products') renderMyProducts();
      if (tab.dataset.tab === 'closed-deals') renderClosedDeals();
    });
  });

  /* ---- Catálogo ---- */
  async function refreshCatalog() {
    const products = await Store.getProducts();
    const visibleProducts = products.filter(product => !product.deleted);
    refreshCategoryFilter(visibleProducts);
    applyFilters();
  }

  function renderCatalog(products) {
    const grid = $('#catalog');
    if (!products.length) {
      const hasFilters = $('#searchInput').value.trim() || $('#categoryFilter').value || $('#cityFilter').value;
      grid.innerHTML = hasFilters
        ? '<p class="hint">No hay anuncios que coincidan con los filtros.</p>'
        : '<p class="hint">Aún no hay anuncios. ¡Publica el primero o conecta con un peer!</p>';
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

  function renderSeller(product, reviews) {
    const name = product.authorName || 'Desconocido';
    const city = product.authorCity ? `<span class="seller-city">(${escapeHtml(product.authorCity)})</span>` : '';
    const avatar = product.authorAvatar
      ? `<img class="seller-avatar" src="${escapeHtml(product.authorAvatar)}" alt="Foto de ${escapeHtml(name)}" />`
      : `<span class="seller-avatar seller-avatar-fallback" aria-hidden="true">${escapeHtml(name.charAt(0).toUpperCase())}</span>`;
    const rating = avgRating(reviews, product.authorId);
    const ratingInfo = rating.count
      ? `${renderStars(Math.round(rating.avg), 'small')} <span class="seller-rating-value">${rating.avg.toFixed(1)} (${rating.count})</span>`
      : '<span class="seller-rating-empty">Sin valoraciones</span>';
    return `<div class="seller-meta">${avatar}<div class="seller-details"><div class="seller-name-line"><strong>${escapeHtml(name)}</strong>${city}</div><div class="seller-rating">${ratingInfo}</div></div></div>`;
  }

  async function renderMyProducts() {
    const products = (await Store.getProducts())
      .filter(product => product.authorId === P2P.localId && !product.deleted)
      .sort((a, b) => b.timestamp - a.timestamp);
    const list = $('#myProductsList');
    if (!products.length) {
      list.innerHTML = '<p class="hint">Todavía no has publicado anuncios.</p>';
      return;
    }
    list.innerHTML = products.map(product => `
      <article class="card my-product">
        <img src="${escapeHtml(product.image || placeholderImg())}" alt="${escapeHtml(product.title)}" />
        <div class="my-product-info">
          <strong>${escapeHtml(product.title)}</strong>
          <div class="price">${formatPrice(product.price)}</div>
          <div class="hint">${escapeHtml(product.category || 'Otros')} · ${escapeHtml(product.condition || '')}</div>
        </div>
        <div class="my-product-actions">
          <button type="button" class="ghost" data-act="edit" data-id="${escapeHtml(product.id)}">Editar</button>
          <button type="button" class="danger" data-act="delete" data-id="${escapeHtml(product.id)}">Eliminar</button>
        </div>
      </article>
    `).join('');
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
    const city = $('#cityFilter').value;
    const sort = $('#sortFilter').value;
    Store.getProducts().then(products => {
      let list = products.filter(p => !p.deleted &&
        (!cat || p.category === cat) &&
        (!city || p.authorCity === city) &&
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
  $('#cityFilter').addEventListener('change', applyFilters);
  $('#sortFilter').addEventListener('change', applyFilters);

  /* ---- Modal de detalle del producto ---- */
  let openProductId = null;
  function openProductModal(id) {
    openProductId = id;
    Store.getProducts().then(products => {
      const p = products.find(x => x.id === id);
      if (!p || p.deleted) return;

      Store.getReviews().then(reviews => {
        $('#modalContent').innerHTML = `
          <img src="${p.image || placeholderImg()}" alt="${escapeHtml(p.title)}" />
          <div class="title" style="font-size:22px">${escapeHtml(p.title)}</div>
          <div class="price">${formatPrice(p.price)}</div>
          <div class="product-detail-meta">${escapeHtml(p.category || 'Otros')} (<span class="product-condition">${escapeHtml(p.condition || '')}</span>)</div>
          <p style="margin-top:12px;white-space:pre-wrap">${escapeHtml(p.description || 'Sin descripción.')}</p>
          <div class="owner"><strong>Vendedor</strong>${renderSeller(p, reviews)}</div>
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
      <div class="modal-card form-card">
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
      const currentProduct = (await Store.getProducts()).find(item => item.id === product.id && !item.deleted);
      if (!currentProduct) {
        close();
        $('#productModal').classList.add('hidden');
        openProductId = null;
        toast('El anuncio ya no está disponible.', true);
        return;
      }

      const buyerProfile = Store.loadProfile();
      await Store.addDeal({
        productId: currentProduct.id,
        productTitle: currentProduct.title,
        price: currentProduct.price,
        offerAmount: amount,
        message,
        sellerId: currentProduct.authorId,
        sellerName: currentProduct.authorName,
        sellerAvatar: currentProduct.authorAvatar || '',
        buyerId: P2P.localId,
        buyerName: buyerProfile.name || 'invitado',
        buyerAvatar: buyerProfile.avatar || '',
        status: 'pending',
      });
      close();
      toast('Oferta enviada. El vendedor lo revisará.');
      renderDeals();
    });
  }

  /* ---- Renderizar ofertas / tratos ---- */
  function dealRole(deal) {
    if (deal.sellerId === P2P.localId) return 'received';
    if (deal.buyerId === P2P.localId || deal.buyerPeerId === P2P.localId) return 'sent';
    if (!deal.buyerPeerId && deal.buyerId === Store.loadProfile().name) return 'sent';
    return null;
  }

  function isCurrentBuyer(deal) {
    return deal.buyerId === P2P.localId || deal.buyerPeerId === P2P.localId ||
      (!deal.buyerPeerId && deal.buyerId === Store.loadProfile().name);
  }

  function updateDealsBadge(deals) {
    const activeCount = deals.filter(d => dealRole(d) && ['pending', 'accepted'].includes(d.status)).length;
    const badge = $('#dealsBadge');
    badge.textContent = String(activeCount);
    badge.hidden = activeCount === 0;
  }

  async function renderDeals() {
    const allDeals = await Store.getDeals();
    updateDealsBadge(allDeals);
    const deals = allDeals.filter(dealRole);
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
          ${renderDealActions(d, dealRole(d))}
        </div>
      `;
    }).join('');
  }

  async function renderClosedDeals() {
    const [allDeals, products] = await Promise.all([Store.getDeals(), Store.getProducts()]);
    const deals = allDeals
      .filter(deal => deal.status === 'closed' && dealRole(deal))
      .sort((a, b) => (b.closedAt || b.updatedAt || b.timestamp) - (a.closedAt || a.updatedAt || a.timestamp));
    const list = $('#closedDealsList');
    if (!deals.length) {
      list.innerHTML = '<p class="hint">Todavía no tienes compraventas cerradas.</p>';
      return;
    }
    list.innerHTML = deals.map(deal => {
      const product = products.find(item => item.id === deal.productId);
      const otherParty = dealRole(deal) === 'received'
        ? deal.buyerName || 'Comprador'
        : deal.sellerName || 'Vendedor';
      return `
        <button type="button" class="card closed-deal" data-id="${escapeHtml(deal.id)}">
          <img class="closed-deal-image" src="${escapeHtml(product?.image || placeholderImg())}" alt="${escapeHtml(deal.productTitle || 'Producto')}" />
          <span class="closed-deal-info"><strong>${escapeHtml(deal.productTitle || 'Producto')}</strong>
            <span class="hint">${dealRole(deal) === 'received' ? 'Comprador' : 'Vendedor'}: ${escapeHtml(otherParty)}</span>
          </span>
          <span class="closed-deal-price">${formatPrice(deal.price)}</span>
          <span class="closed-deal-open">Abrir chat →</span>
        </button>
      `;
    }).join('');
  }

  let openChatDealId = null;

  async function renderChat(dealId) {
    const [deals, messages, products] = await Promise.all([
      Store.getDeals(), Store.getDealMessages(dealId), Store.getProducts(),
    ]);
    const deal = deals.find(item => item.id === dealId && item.status === 'closed' && dealRole(item));
    if (!deal) {
      $('#chatModal').classList.add('hidden');
      openChatDealId = null;
      return;
    }
    const role = dealRole(deal);
    if (role === 'sent' && !deal.buyerAvatar) {
      const buyerProfile = Store.loadProfile();
      if (buyerProfile.avatar) {
        await Store.updateDeal(deal.id, {
          buyerName: buyerProfile.name || deal.buyerName,
          buyerAvatar: buyerProfile.avatar,
        });
        deal.buyerAvatar = buyerProfile.avatar;
      }
    }
    const product = products.find(item => item.id === deal.productId);
    const otherParty = role === 'received'
      ? deal.buyerName || 'Comprador'
      : deal.sellerName || 'Vendedor';
    const otherAvatar = role === 'received'
      ? deal.buyerAvatar
      : deal.sellerAvatar || product?.authorAvatar;
    const avatarMarkup = otherAvatar
      ? `<img class="chat-person-avatar" src="${escapeHtml(otherAvatar)}" alt="Foto de ${escapeHtml(otherParty)}" />`
      : `<span class="chat-person-avatar chat-person-fallback" aria-hidden="true">${escapeHtml(otherParty.charAt(0).toUpperCase())}</span>`;
    const messagesHtml = messages.length ? messages.map(message => `
      <div class="chat-message ${message.senderId === P2P.localId ? 'mine' : ''}">
        <div class="chat-message-meta">${escapeHtml(message.senderName || 'Usuario')} · ${new Date(message.timestamp).toLocaleString('es-ES')}</div>
        <div class="chat-message-body">${escapeHtml(message.text)}</div>
      </div>
    `).join('') : '<p class="hint chat-empty">Aún no hay mensajes. Inicia la conversación.</p>';
    $('#chatContent').innerHTML = `
      <h2 id="chatTitle">${escapeHtml(deal.productTitle || 'Compraventa')}</h2>
      <p class="hint chat-counterpart">Chat directo con ${escapeHtml(otherParty)}</p>
      <div class="chat-messages" id="chatMessages">${messagesHtml}</div>
      <div class="chat-composer">
        <div class="chat-person">${avatarMarkup}<span class="chat-person-name">${escapeHtml(otherParty)}</span></div>
        <form id="chatForm" class="chat-form">
          <label class="visually-hidden" for="chatMessageInput">Escribe un mensaje</label>
          <textarea id="chatMessageInput" rows="2" maxlength="2000" placeholder="Escribe un mensaje..." required></textarea>
          <button type="submit" class="primary">Enviar</button>
        </form>
      </div>
    `;
    $('#chatModal').classList.remove('hidden');
    const messageList = $('#chatMessages');
    messageList.scrollTop = messageList.scrollHeight;
  }

  $('#closedDealsList').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-id]');
    if (!button) return;
    openChatDealId = button.dataset.id;
    renderChat(openChatDealId);
  });

  $('#chatContent').addEventListener('submit', async (event) => {
    if (event.target.id !== 'chatForm') return;
    event.preventDefault();
    const input = $('#chatMessageInput');
    const text = input.value.trim();
    if (!text || !openChatDealId) return;
    const saved = await Store.addDealMessage({
      dealId: openChatDealId,
      senderId: P2P.localId,
      senderName: Store.loadProfile().name || 'Usuario',
      text,
    });
    if (!saved) { toast('No se pudo enviar el mensaje.', true); return; }
    await renderChat(openChatDealId);
    $('#chatMessageInput').focus();
  });

  function closeChat() {
    $('#chatModal').classList.add('hidden');
    openChatDealId = null;
  }
  $('#closeChatModal').addEventListener('click', closeChat);
  $('#chatModal').addEventListener('click', event => {
    if (event.target.id === 'chatModal') closeChat();
  });

  function renderDealActions(deal, role) {
    if (role === 'received' && deal.status === 'pending') {
      return `<div style="display:flex;gap:8px">
        <button class="primary" data-act="accept" data-id="${deal.id}">Aceptar</button>
        <button data-act="reject" data-id="${deal.id}" style="background:#f0c9a8;color:#5a3a24;border:1px solid var(--border);padding:8px 14px;border-radius:8px;cursor:pointer">Rechazar</button>
      </div>`;
    }
    if (role === 'sent' && deal.status === 'pending') {
      return `<p class="hint">Esperando respuesta del vendedor...</p>`;
    }
    if (role === 'sent' && deal.status === 'accepted') {
      return `<div style="display:flex;gap:8px">
        <button data-act="buy" data-id="${deal.id}" class="primary">Confirmar compra</button>
      </div>`;
    }
    if (role === 'received' && deal.status === 'accepted') return '<p class="hint">Esperando confirmación del comprador...</p>';
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
      if (!deal || !isCurrentBuyer(deal) || deal.status !== 'accepted') {
        toast('La oferta ya no está disponible para confirmar.', true);
        await renderDeals();
        return;
      }
      const buyerProfile = Store.loadProfile();
      const closed = await Store.updateDeal(id, {
        status: 'closed',
        closedAt: Date.now(),
        buyerName: buyerProfile.name || deal.buyerName,
        buyerAvatar: buyerProfile.avatar || deal.buyerAvatar || '',
      });
      if (!closed) { toast('No se pudo cerrar la compraventa.', true); return; }
      if (deal.productId) await Store.deleteProduct(deal.productId);
      toast('¡Compra registrada! Gracias por tu compra.');
      // Pedir valoración del vendedor tras cerrar la compra.
      if (deal && deal.sellerId) requestReview(deal.sellerId);
    }
    renderDeals();
    renderClosedDeals();
  });

  /* ---- Sistema de valoraciones con estrellas ---- */
  function requestReview(targetId) {
    const dialog = document.createElement('div');
    dialog.className = 'modal';
    dialog.innerHTML = `
      <div class="modal-card form-card">
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

    function paintStars(n) {
      ratingInput.value = String(n);
      starContainer.querySelectorAll('button').forEach((button, index) => {
        button.textContent = index < n ? '★' : '☆';
        button.style.color = index < n ? 'var(--star)' : '#e6d3bf';
      });
    }

    for (let i = 1; i <= 5; i++) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'star-btn';
      button.setAttribute('aria-label', `${i} ${i === 1 ? 'estrella' : 'estrellas'}`);
      button.textContent = '☆';
      button.style.cssText = 'font-size:36px;margin:0 4px;cursor:pointer;color:#e6d3bf;background:none;border:none;';
      button.addEventListener('click', () => {
        paintStars(i);
      });
      starContainer.appendChild(button);
    }
    paintStars(0);

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
    const city = document.getElementById('profileCity').value;
    const profile = await Store.saveProfile({ name, city });
    await Store.updateProductsByAuthor(P2P.localId, {
      authorName: profile.name,
      authorAvatar: profile.avatar || '',
      authorCity: profile.city || '',
    });
    renderProfilePreview(profile);
    toast('Perfil guardado.');
  });

  document.getElementById('profileImage').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const dataUrl = await readFileAsDataURL(file);
    const profile = await Store.saveProfile({ avatar: dataUrl });
    await Store.updateProductsByAuthor(P2P.localId, {
      authorName: profile.name,
      authorAvatar: profile.avatar,
      authorCity: profile.city || '',
    });
    renderProfilePreview(profile);
    toast('Foto de perfil actualizada.');
  });

  /* ---- Publicar anuncio ---- */
  let editingProductId = null;
  const publishForm = $('#publishForm');
  const publishButton = publishForm.querySelector('button[type="submit"]');
  const cancelProductEdit = $('#cancelProductEdit');

  function resetProductEditor() {
    editingProductId = null;
    publishForm.reset();
    publishButton.textContent = 'Publicar anuncio';
    cancelProductEdit.hidden = true;
  }

  cancelProductEdit.addEventListener('click', resetProductEditor);

  $('#myProductsList').addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-act]');
    if (!button) return;
    const products = await Store.getProducts();
    const product = products.find(item => item.id === button.dataset.id &&
      item.authorId === P2P.localId && !item.deleted);
    if (!product) { toast('El anuncio ya no está disponible.', true); return; }

    if (button.dataset.act === 'edit') {
      editingProductId = product.id;
      publishForm.elements.title.value = product.title;
      publishForm.elements.category.value = product.category || 'Otros';
      publishForm.elements.price.value = product.price;
      publishForm.elements.condition.value = product.condition || 'Nuevo';
      publishForm.elements.description.value = product.description || '';
      publishForm.elements.image.value = '';
      publishButton.textContent = 'Guardar cambios';
      cancelProductEdit.hidden = false;
      document.querySelector('.tab[data-tab="publish"]').click();
      return;
    }

    if (button.dataset.act === 'delete' && window.confirm(`¿Eliminar el anuncio «${product.title}»?`)) {
      const deleted = await Store.deleteProduct(product.id);
      toast(deleted ? 'Anuncio eliminado.' : 'El anuncio ya no está disponible.', !deleted);
    }
  });

  $('#publishForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const fd = new FormData(form);
    const title = fd.get('title').trim();
    const price = parseFloat(fd.get('price'));
    const profile = Store.loadProfile();

    if (!profile.name) { toast('Primero configura tu nombre de usuario en Perfil.', true); return; }

    const existing = editingProductId
      ? (await Store.getProducts()).find(product => product.id === editingProductId && !product.deleted)
      : null;
    if (editingProductId && (!existing || existing.authorId !== P2P.localId)) {
      resetProductEditor();
      toast('El anuncio ya no está disponible.', true);
      return;
    }

    let image = existing?.image || '';
    const file = form.querySelector('[name=image]').files[0];
    if (file) image = await readFileAsDataURL(file);

    const productData = {
      title,
      category: fd.get('category'),
      price,
      condition: fd.get('condition'),
      description: fd.get('description').trim(),
      image,
      authorId: P2P.localId,
      authorName: profile.name,
      authorAvatar: profile.avatar || '',
      authorCity: profile.city || '',
    };
    if (editingProductId) {
      const updated = await Store.updateProduct(editingProductId, productData);
      if (!updated) {
        resetProductEditor();
        toast('El anuncio ya no está disponible.', true);
        return;
      }
      toast('Anuncio actualizado.');
    } else {
      await Store.addProduct(productData);
      toast('Anuncio publicado y difundido a los peers conectados.');
    }

    resetProductEditor();
    document.querySelector('.tab[data-tab="marketplace"]').click();
    await refreshCatalog();
    await renderMyProducts();
  });

  /* ---- Eventos de catálogo (modal) ---- */
  $('#catalog').addEventListener('click', (e) => {
    const product = e.target.closest('.product');
    if (product) openProductModal(product.dataset.id);
  });

  $('#closeModal').addEventListener('click', () => {
    $('#productModal').classList.add('hidden');
    openProductId = null;
  });
  $('#productModal').addEventListener('click', e => {
    if (e.target.id === 'productModal') {
      $('#productModal').classList.add('hidden');
      openProductId = null;
    }
  });

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

  /* ---- Conexión automática por presencia (sin salas ni códigos) ---- */

  function refreshAutoStatus() {
    const st = P2P.autoConnectState();
    const el = $('#autoStatus');
    el.textContent = `Total de peers encontrados: ${st.count}`;
  }

  async function startAutoConnection() {
    const server = currentServer();
    if (!server) { toast('No hay servidor de señalización configurado.', true); return; }

    try {
      $('#autoConnectBtn').textContent = 'Conectando automáticamente...';
      await P2P.autoConnect(server.url);
      $('#autoConnectBtn').textContent = '⏸️ Dejar de buscar peers';
      refreshAutoStatus();
    } catch (err) {
      $('#autoConnectBtn').textContent = '🔗 Conectar automáticamente';
      toast('Error al conectar automáticamente: ' + err.message, true);
    }
  }

  $('#autoConnectBtn').addEventListener('click', async () => {
    const server = currentServer();
    if (!server) { toast('Añade al menos un servidor de señalización.', true); return; }

    if (P2P.autoConnectState().active) {
      // Desconectar de la búsqueda automática.
      P2P.stopAutoConnect();
      $('#autoConnectBtn').textContent = '🔗 Conectar automáticamente';
      toast('Búsqueda automática detenida.');
      refreshAutoStatus();
      return;
    }

    await startAutoConnection();
  });

  // Refrescar el estado de conexión periódicamente (para actualizar el contador).
  setInterval(refreshAutoStatus, 2500);

  $('#serverSelect').addEventListener('change', () => { refreshAutoStatus(); });

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

  /* ---- Arranque ---- */
  window.addEventListener('rummage:store-updated', (event) => {
    refreshCatalog();
    renderMyProducts();
    renderDeals();
    renderClosedDeals();
    renderMyRating();

    if (openChatDealId && !$('#chatModal').classList.contains('hidden')) renderChat(openChatDealId);
    if (openProductId && !$('#productModal').classList.contains('hidden')) {
      const selectedProductId = openProductId;
      Store.getProducts().then(products => {
        const product = products.find(item => item.id === selectedProductId);
        if (openProductId === selectedProductId && (!product || product.deleted)) {
          $('#productModal').classList.add('hidden');
          openProductId = null;
        }
      });
    }

    const changes = event.detail?.dealChanges;
    if (!changes) return;
    const addedDeals = changes.added || [];
    const updatedDeals = changes.updated || [];
    const acceptedForBuyer = [
      ...addedDeals.filter(d => d.status === 'accepted'),
      ...updatedDeals.filter(change => change.current.status === 'accepted' && change.previous.status !== 'accepted').map(change => change.current),
    ].some(isCurrentBuyer);
    const newIncomingOffer = addedDeals.some(d => dealRole(d) === 'received' && d.status === 'pending');
    if (acceptedForBuyer) toast('¡El vendedor ha aceptado tu oferta! Confirma la compra en Ofertas.');
    else if (newIncomingOffer) toast('Has recibido una nueva oferta.');
  });

  await refreshCatalog();
  await renderMyProducts();
  await renderDeals();
  await renderClosedDeals();
  renderMyRating();
  refreshServerSelect(Store.getSignalingServers());
  startAutoConnection();
})();
