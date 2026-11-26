/* ============================================================================
 * store.js — Persistencia en IndexedDB + difusión/sincronización P2P
 * Cada nodo guarda sus propios datos y los difunde entre peers conectados.
 * ==========================================================================*/

const Store = (() => {
  const DB_NAME = 'rummage-db';
  const DB_VERSION = 1;
  let dbPromise = null;

  /* ---- Datos locales del usuario actual ---- */
  let localProfile = { name: '', avatar: '' };

  async function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = req.result;
        ['products', 'reviews', 'deals'].forEach((name) => {
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
    const p = { ...product, id: product.id || crypto.randomUUID(), timestamp: Date.now() };
    await put('products', p);
    broadcast();
    return p;
  }
  async function getProducts() { return getMany('products'); }

  /* ---- Valoraciones (estrellas) ---- */
  async function addReview(review) {
    const r = { ...review, id: review.id || crypto.randomUUID(), timestamp: Date.now() };
    await put('reviews', r);
    broadcast();
    return r;
  }
  async function getReviews() { return getMany('reviews'); }

  /* ---- Ofertas / tratos ---- */
  async function addDeal(deal) {
    const d = { ...deal, id: deal.id || crypto.randomUUID(), timestamp: Date.now() };
    await put('deals', d);
    broadcast();
    return d;
  }
  async function getDeals() { return getMany('deals'); }
  async function updateDeal(id, patch) {
    const deals = await getDeals();
    const deal = deals.find(d => d.id === id);
    if (deal) { await put('deals', { ...deal, ...patch }); broadcast(); }
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
    { name: 'Público Cloudflare', url: 'https://signal.cloudflarercs.com' },
    { name: 'Públo de prueba', url: 'http://localhost:8787' },
  ];

  function getSignalingServers() {
    let raw = localStorage.getItem(SERVERS_KEY);
    if (!raw) {
      localStorage.setItem(SERVERS_KEY, JSON.stringify(DEFAULT_SERVERS));
      return DEFAULT_SERVERS.slice();
    }
    try { return JSON.parse(raw); } catch { return DEFAULT_SERVERS.slice(); }
  }

  function saveSignalingServers(list) {
    const clean = list.filter(s => s && typeof s.url === 'string' && !!s.url.trim());
    localStorage.setItem(SERVERS_KEY, JSON.stringify(clean));
    return clean;
  }

  /* ---- Diffusión de datos entre peers ---- */
  // Envía el snapshot actual por todos los DataChannel abiertos (P2P directo).
  async function broadcast() {
    const msg = JSON.stringify({ type: 'sync', data: Store.snapshot() });
    P2P.sendAll(msg);
  }

  /* ---- Snapshot completo para sincronizar con un peer ---- */
  async function snapshot() {
    return {
      products: await getProducts(),
      reviews: await getReviews(),
      deals: await getDeals(),
    };
  }

  /* ---- Fusionar datos recibidos de otro peer (gossip/torrent) ---- */
  async function merge(remoteData) {
    const local = await snapshot();

    for (const p of remoteData.products || []) {
      if (!local.products.find(x => x.id === p.id)) await put('products', p);
    }
    for (const r of remoteData.reviews || []) {
      if (!local.reviews.find(x => x.id === r.id)) await put('reviews', r);
    }
    for (const d of remoteData.deals || []) {
      if (!local.deals.find(x => x.id === d.id)) await put('deals', d);
    }
  }

  return {
    addProduct, getProducts,
    addReview, getReviews,
    addDeal, getDeals, updateDeal,
    saveProfile, loadProfile,
    snapshot, merge, broadcast,
    getSignalingServers, saveSignalingServers,
  };
})();
