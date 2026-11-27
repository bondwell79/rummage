/* ============================================================================
 * store.js — Persistencia en IndexedDB + difusión/sincronización P2P
 * Cada nodo guarda sus propios datos y los difunde entre peers conectados.
 * ==========================================================================*/

const Store = (() => {
  const DB_NAME = 'rummage-db';
  const DB_VERSION = 2;
  let dbPromise = null;

  function createId() {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  /* ---- Datos locales del usuario actual ---- */
  let localProfile = { name: '', avatar: '', city: '' };

  async function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = req.result;
        ['products', 'reviews', 'deals', 'messages'].forEach((name) => {
          if (!db.objectStoreNames.contains(name)) {
            db.createObjectStore(name, { keyPath: 'id' });
          }
        });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  /* Abre una transacción IndexedDB y devuelve el object store + la transacción. */
  async function openTx(storeName, mode) {
    const db = await openDb();
    const transaction = db.transaction(storeName, mode);
    return { store: transaction.objectStore(storeName), transaction };
  }

  function promisifyRequest(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function getMany(storeName) {
    const { store } = await openTx(storeName, 'readonly');
    return promisifyRequest(store.getAll());
  }

  async function put(storeName, item) {
    const { store } = await openTx(storeName, 'readwrite');
    return promisifyRequest(store.put(item));
  }

  async function deleteItem(storeName, id) {
    const { store } = await openTx(storeName, 'readwrite');
    return promisifyRequest(store.delete(id));
  }

  /* ---- Productos (anuncios) ---- */
  async function addProduct(product) {
    const timestamp = Date.now();
    const p = { ...product, id: product.id || createId(), timestamp, updatedAt: timestamp, revision: 0, deleted: false };
    await put('products', p);
    broadcast();
    return p;
  }
  async function getProducts() { return getMany('products'); }
  async function updateProduct(id, patch) {
    const products = await getProducts();
    const product = products.find(item => item.id === id && !item.deleted);
    if (!product) return false;
    const updatedAt = Math.max(Date.now(), (product.updatedAt || product.timestamp || 0) + 1);
    await put('products', { ...product, ...patch, updatedAt, revision: (product.revision || 0) + 1 });
    window.dispatchEvent(new CustomEvent('rummage:store-updated'));
    broadcast();
    return true;
  }
  async function deleteProduct(id) {
    const products = await getProducts();
    const product = products.find(item => item.id === id && !item.deleted);
    if (!product) return false;
    const updatedAt = Math.max(Date.now(), (product.updatedAt || product.timestamp || 0) + 1);
    await put('products', { ...product, deleted: true, updatedAt, revision: (product.revision || 0) + 1 });
    window.dispatchEvent(new CustomEvent('rummage:store-updated'));
    broadcast();
    return true;
  }
  async function updateProductsByAuthor(authorId, patch) {
    const products = await getProducts();
    const owned = products.filter(product => product.authorId === authorId && !product.deleted);
    for (const product of owned) {
      const updatedAt = Math.max(Date.now(), (product.updatedAt || product.timestamp || 0) + 1);
      await put('products', { ...product, ...patch, updatedAt, revision: (product.revision || 0) + 1 });
    }
    if (owned.length) {
      window.dispatchEvent(new CustomEvent('rummage:store-updated'));
      broadcast();
    }
  }

  /* ---- Valoraciones (estrellas) ---- */
  async function addReview(review) {
    const r = { ...review, id: review.id || createId(), timestamp: Date.now() };
    await put('reviews', r);
    broadcast();
    return r;
  }
  async function getReviews() { return getMany('reviews'); }

  /* ---- Ofertas / tratos ---- */
  async function addDeal(deal) {
    const timestamp = Date.now();
    const d = { ...deal, id: deal.id || createId(), timestamp, updatedAt: timestamp, revision: 0 };
    await put('deals', d);
    broadcast();
    return d;
  }
  async function getDeals() { return getMany('deals'); }
  async function updateDeal(id, patch) {
    const deals = await getDeals();
    const deal = deals.find(d => d.id === id);
    if (deal) {
      const updatedAt = Math.max(Date.now(), (deal.updatedAt || deal.timestamp || 0) + 1);
      await put('deals', { ...deal, ...patch, updatedAt, revision: (deal.revision || 0) + 1 });
      broadcast();
      return true;
    }
    return false;
  }

  async function getDealMessages(dealId) {
    return (await getMany('messages'))
      .filter(message => message.dealId === dealId)
      .sort((a, b) => a.timestamp - b.timestamp);
  }

  async function addDealMessage(message) {
    const deal = (await getDeals()).find(item => item.id === message.dealId && item.status === 'closed');
    if (!deal) return false;
    const entry = { ...message, id: message.id || createId(), timestamp: Date.now() };
    await put('messages', entry);
    window.dispatchEvent(new CustomEvent('rummage:store-updated'));
    const recipientId = deal.sellerId === P2P.localId
      ? [deal.buyerPeerId, deal.buyerId].find(peerId => peerId && peerId !== P2P.localId)
      : deal.sellerId;
    let sent = false;
    if (recipientId) {
      try {
        sent = await P2P.sendToPeer(recipientId, { type: 'deal-message', message: entry });
      } catch (error) {
        console.warn('[Store] No se pudo enviar el mensaje del chat:', error);
      }
    }
    return { ...entry, deliveryPending: !sent };
  }

  /* ---- Perfil local ---- */
  async function saveProfile(profile) {
    localProfile = { ...localProfile, ...profile };
    localStorage.setItem('rummage-profile', JSON.stringify(localProfile));
    return localProfile;
  }
  function loadProfile() {
    const raw = localStorage.getItem('rummage-profile');
    if (raw) localProfile = JSON.parse(raw);
    return localProfile;
  }

  /* ---- Servidores públicos de señalización (lista editable) ---- */
  const SERVERS_KEY = 'rummage-signaling-servers';
  const DEFAULT_SERVERS = [
    { name: 'rummage.website:8080', url: 'https://rummage.website:8080' },
  ];
  const OLD_DEFAULT_URLS = new Set([
    'https://signal.cloudflarercs.com',
    'http://localhost:8787',
  ]);

  function getSignalingServers() {
    let raw = localStorage.getItem(SERVERS_KEY);
    if (!raw) {
      localStorage.setItem(SERVERS_KEY, JSON.stringify(DEFAULT_SERVERS));
      return DEFAULT_SERVERS.slice();
    }
    try {
      const stored = JSON.parse(raw);
      if (!Array.isArray(stored)) throw new Error('lista no válida');
      const servers = stored.filter(s => s && typeof s.url === 'string' &&
        s.url !== DEFAULT_SERVERS[0].url && !OLD_DEFAULT_URLS.has(s.url));
      servers.unshift(DEFAULT_SERVERS[0]);
      if (servers.length !== stored.length || stored[0]?.url !== DEFAULT_SERVERS[0].url) {
        localStorage.setItem(SERVERS_KEY, JSON.stringify(servers));
      }
      return servers;
    } catch { return DEFAULT_SERVERS.slice(); }
  }

  function saveSignalingServers(list) {
    const clean = list.filter(s => s && typeof s.url === 'string' && !!s.url.trim());
    localStorage.setItem(SERVERS_KEY, JSON.stringify(clean));
    return clean;
  }

  /* ---- Diffusión de datos entre peers ---- */
  // Envía el snapshot actual por todos los DataChannel abiertos (P2P directo).
  async function broadcast() {
    try {
      await Promise.all(P2P.connectedPeerIds().map(async peerId => {
        await P2P.sendToPeer(peerId, { type: 'sync', data: await snapshot(peerId) });
      }));
    } catch (error) {
      console.warn('[Store] No se pudo difundir el snapshot:', error);
    }
  }

  /* ---- Snapshot completo para sincronizar con un peer ---- */
  async function snapshot(peerId = '') {
    const [products, reviews, allDeals, allMessages] = await Promise.all([
      getProducts(), getReviews(), getDeals(), getMany('messages'),
    ]);
    const deals = peerId
      ? allDeals.filter(deal => [deal.sellerId, deal.buyerId, deal.buyerPeerId].includes(peerId))
      : allDeals;
    const sharedDealIds = new Set(deals
      .filter(deal => deal.status === 'closed' &&
        [deal.sellerId, deal.buyerId, deal.buyerPeerId].includes(peerId))
      .map(deal => deal.id));
    return {
      products,
      reviews,
      deals,
      messages: peerId ? allMessages.filter(message => sharedDealIds.has(message.dealId)) : [],
    };
  }

  /* ---- Fusionar datos recibidos de otro peer (gossip/torrent) ---- */
  async function merge(remoteData, peerId = '') {
    const local = await snapshot();
    local.messages = await getMany('messages');
    let changed = false;
    const dealChanges = { added: [], updated: [] };
    const messageChanges = { added: [] };

    for (const p of remoteData.products || []) {
      const existing = local.products.find(x => x.id === p.id);
      if (!existing || (p.revision || 0) > (existing.revision || 0) ||
          ((p.revision || 0) === (existing.revision || 0) && (p.updatedAt || p.timestamp || 0) > (existing.updatedAt || existing.timestamp || 0))) {
        await put('products', p);
        changed = true;
      }
    }
    for (const r of remoteData.reviews || []) {
      if (!local.reviews.find(x => x.id === r.id)) { await put('reviews', r); changed = true; }
    }
    for (const d of remoteData.deals || []) {
      const existing = local.deals.find(x => x.id === d.id);
      if (!existing) {
        await put('deals', d);
        dealChanges.added.push(d);
        changed = true;
      } else if ((d.revision || 0) > (existing.revision || 0) ||
          ((d.revision || 0) === (existing.revision || 0) && (d.updatedAt || d.timestamp || 0) > (existing.updatedAt || existing.timestamp || 0))) {
        await put('deals', d);
        dealChanges.updated.push({ previous: existing, current: d });
        changed = true;
      }
    }
    const messageIds = new Set(local.messages.map(message => message.id));
    for (const message of remoteData.messages || []) {
      const deal = (remoteData.deals || []).find(item => item.id === message.dealId) ||
        local.deals.find(item => item.id === message.dealId);
      if (!peerId || !deal || deal.status !== 'closed' || message.senderId !== peerId ||
          ![deal.sellerId, deal.buyerId, deal.buyerPeerId].includes(peerId)) continue;
      if (!messageIds.has(message.id)) {
        await put('messages', message);
        messageIds.add(message.id);
        messageChanges.added.push(message);
        changed = true;
      }
    }
    if (changed) window.dispatchEvent(new CustomEvent('rummage:store-updated', { detail: { dealChanges, messageChanges } }));
    return changed;
  }

  return {
    addProduct, getProducts, updateProduct, deleteProduct, updateProductsByAuthor,
    addReview, getReviews,
    addDeal, getDeals, updateDeal, getDealMessages, addDealMessage,
    saveProfile, loadProfile,
    snapshot, merge, broadcast,
    getSignalingServers, saveSignalingServers,
  };
})();
