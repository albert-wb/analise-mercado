/**
 * background.js — Analisador Pro v8.0 (Mercado Livre + Shopee)
 *
 * Service worker (ES module). Responsabilidades:
 *   1. OAuth2 + PKCE com o Mercado Livre e ciclo de vida dos tokens.
 *   2. Proxy de rede: todas as chamadas a APIs externas passam por aqui,
 *      porque o service worker não sofre com o CORS da página hospedeira.
 *   3. Persistência: taxas, custos globais, garimpo e snapshots de vendas.
 *   4. Downloads de mídia.
 *
 * O service worker do MV3 é encerrado quando ocioso: todo estado relevante
 * vive em `chrome.storage.local`, nunca em variáveis de módulo.
 */

// ==================================================================
//  CONFIGURAÇÃO OAuth
// ==================================================================

/**
 * Credenciais padrão da aplicação registrada no Mercado Livre.
 *
 * ⚠️ Um CLIENT_SECRET embutido em uma extensão NÃO é segredo: qualquer
 * usuário consegue lê-lo descompactando o .crx. Isto é aceitável para uso
 * pessoal/interno. Para distribuição pública, troque a etapa de emissão de
 * token por um backend proxy que guarde o secret. Enquanto isso, cada usuário
 * pode cadastrar a própria aplicação em "Ajustes → Credenciais da API" —
 * o que estiver salvo em `ml_oauth_config` tem prioridade sobre o padrão.
 */
const DEFAULT_OAUTH = {
  clientId: '6682380728420881',
  clientSecret: 'c7Ap9cRS8ZuelpoAOQtp3bL61CCJh1a4',
};

const AUTH_URL = 'https://auth.mercadolivre.com.br/authorization';
const TOKEN_URL = 'https://api.mercadolibre.com/oauth/token';
const API_BASE = 'https://api.mercadolibre.com';

const TOKEN_REFRESH_ALARM = 'ml-token-refresh';
/** Renova o token com esta antecedência (segundos) para nunca servir um expirado. */
const REFRESH_SKEW_SECONDS = 300;
/** Quantos dias de histórico de vendas manter por produto. */
const SNAPSHOT_MAX_DAYS = 60;

const STORAGE_KEYS = {
  accessToken: 'ml_access_token',
  refreshToken: 'ml_refresh_token',
  tokenExpires: 'ml_token_expires',
  codeVerifier: 'ml_code_verifier',
  oauthConfig: 'ml_oauth_config',
  mlTaxes: 'ml_custom_taxes',
  shopeeTaxes: 'shopee_custom_taxes',
  globalCosts: 'global_costs',
  garimpo: 'garimpo_items',
  snapshots: 'snapshots',
};

/** A redirect URI é gerada pelo Chrome e precisa estar cadastrada no painel do ML. */
function getRedirectUri() {
  return chrome.identity.getRedirectURL();
}

async function getOAuthConfig() {
  const stored = await readStorage(STORAGE_KEYS.oauthConfig);
  const cfg = stored || {};
  return {
    clientId: (cfg.clientId || DEFAULT_OAUTH.clientId).trim(),
    clientSecret: (cfg.clientSecret || DEFAULT_OAUTH.clientSecret).trim(),
    isCustom: Boolean(cfg.clientId),
  };
}

// ==================================================================
//  HELPERS DE STORAGE
// ==================================================================

async function readStorage(key, fallback = null) {
  const result = await chrome.storage.local.get(key);
  return result[key] ?? fallback;
}

async function writeStorage(key, value) {
  if (value === null || value === undefined) {
    await chrome.storage.local.remove(key);
  } else {
    await chrome.storage.local.set({ [key]: value });
  }
}

// ==================================================================
//  PKCE
// ==================================================================

function base64urlEncode(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function generateCodeVerifier() {
  const randomBytes = new Uint8Array(32);
  crypto.getRandomValues(randomBytes);
  return base64urlEncode(randomBytes);
}

async function generateCodeChallenge(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64urlEncode(digest);
}

function randomState() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return base64urlEncode(bytes);
}

// ==================================================================
//  TOKENS
// ==================================================================

async function getAuthStatus() {
  const data = await chrome.storage.local.get([
    STORAGE_KEYS.accessToken,
    STORAGE_KEYS.refreshToken,
    STORAGE_KEYS.tokenExpires,
  ]);

  const accessToken = data[STORAGE_KEYS.accessToken];
  if (!accessToken) return { status: 'logged_out' };

  const remainingMs = (data[STORAGE_KEYS.tokenExpires] || 0) - Date.now();
  if (remainingMs <= 0) {
    return { status: 'expired', canRefresh: Boolean(data[STORAGE_KEYS.refreshToken]) };
  }

  return {
    status: 'logged_in',
    expiresIn: Math.floor(remainingMs / 1000),
    expiresAt: data[STORAGE_KEYS.tokenExpires],
  };
}

async function persistTokens(tokenData) {
  const expiresIn = Number(tokenData.expires_in) || 21600;
  await chrome.storage.local.set({
    [STORAGE_KEYS.accessToken]: tokenData.access_token,
    [STORAGE_KEYS.refreshToken]: tokenData.refresh_token,
    [STORAGE_KEYS.tokenExpires]: Date.now() + expiresIn * 1000,
  });
  scheduleTokenRefresh(expiresIn);
}

async function clearTokens() {
  await chrome.storage.local.remove([
    STORAGE_KEYS.accessToken,
    STORAGE_KEYS.refreshToken,
    STORAGE_KEYS.tokenExpires,
    STORAGE_KEYS.codeVerifier,
  ]);
  await chrome.alarms.clear(TOKEN_REFRESH_ALARM);
}

function scheduleTokenRefresh(expiresInSeconds) {
  const delayInMinutes = Math.max(1, (expiresInSeconds - REFRESH_SKEW_SECONDS) / 60);
  chrome.alarms.create(TOKEN_REFRESH_ALARM, { delayInMinutes });
}

async function postToken(params) {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: params,
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = payload.message || payload.error_description || payload.error || response.statusText;
    throw new Error(`Mercado Livre recusou a requisição de token: ${detail}`);
  }
  return payload;
}

/** Evita disparar N refreshes simultâneos quando várias chamadas veem o token vencido. */
let refreshInFlight = null;

function refreshAccessToken() {
  if (!refreshInFlight) {
    refreshInFlight = doRefreshAccessToken().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

async function doRefreshAccessToken() {
  const refreshToken = await readStorage(STORAGE_KEYS.refreshToken);
  if (!refreshToken) throw new Error('Refresh token não encontrado. Faça login novamente.');

  const { clientId, clientSecret } = await getOAuthConfig();
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
  });

  let tokenData;
  try {
    tokenData = await postToken(params);
  } catch (error) {
    // Refresh token inválido/revogado: não adianta tentar de novo.
    await clearTokens();
    throw error;
  }

  await persistTokens(tokenData);
  return tokenData.access_token;
}

/** Retorna um access token válido, renovando se necessário. `null` se deslogado. */
async function getValidAccessToken() {
  const status = await getAuthStatus();
  if (status.status === 'logged_in') return readStorage(STORAGE_KEYS.accessToken);
  if (status.status === 'expired' && status.canRefresh) {
    try {
      return await refreshAccessToken();
    } catch {
      return null;
    }
  }
  return null;
}

// ==================================================================
//  FLUXO DE LOGIN
// ==================================================================

async function iniciarAutenticacao() {
  const { clientId, clientSecret } = await getOAuthConfig();
  if (!clientId || !clientSecret) {
    throw new Error('Credenciais da API não configuradas. Preencha em Ajustes → Credenciais da API.');
  }

  const redirectUri = getRedirectUri();
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);
  const state = randomState();
  await writeStorage(STORAGE_KEYS.codeVerifier, codeVerifier);

  const authUrl = new URL(AUTH_URL);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('state', state);

  const redirectUrl = await chrome.identity.launchWebAuthFlow({
    url: authUrl.href,
    interactive: true,
  });

  if (!redirectUrl) throw new Error('Janela de autenticação fechada antes da conclusão.');

  const parsed = new URL(redirectUrl);
  const error = parsed.searchParams.get('error');
  if (error) {
    throw new Error(`Autorização negada: ${parsed.searchParams.get('error_description') || error}`);
  }
  if (parsed.searchParams.get('state') !== state) {
    throw new Error('Parâmetro state divergente — possível tentativa de CSRF. Login abortado.');
  }

  const authCode = parsed.searchParams.get('code');
  if (!authCode) throw new Error('Código de autorização não encontrado na URL de retorno.');

  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: clientId,
    client_secret: clientSecret,
    code: authCode,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  });

  const tokenData = await postToken(params);
  await persistTokens(tokenData);
  await writeStorage(STORAGE_KEYS.codeVerifier, null);
}

// ==================================================================
//  CLIENTE HTTP
// ==================================================================

const REQUEST_TIMEOUT_MS = 12000;

async function fetchJson(url, { headers = {}, timeout = REQUEST_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json', ...headers },
      signal: controller.signal,
    });
    return { response, data: await response.json().catch(() => null) };
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('Tempo limite excedido ao consultar a API.');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Chamada à API do Mercado Livre. Usa o token quando disponível e cai para
 * acesso anônimo quando o usuário não está logado — vários endpoints públicos
 * (itens, descrições, reviews) ainda respondem sem autenticação.
 */
async function mlApiGet(path, { requireAuth = false } = {}) {
  const url = path.startsWith('http') ? path : `${API_BASE}${path}`;
  const token = await getValidAccessToken();

  if (requireAuth && !token) throw new Error('Usuário não autenticado.');

  const authHeaders = token ? { Authorization: `Bearer ${token}` } : {};
  let { response, data } = await fetchJson(url, { headers: authHeaders });

  // Token rejeitado: renova uma vez e repete.
  if (response.status === 401 && token) {
    const newToken = await refreshAccessToken().catch(() => null);
    if (!newToken) {
      await clearTokens();
      throw new Error('Sessão expirada. Faça login novamente.');
    }
    ({ response, data } = await fetchJson(url, { headers: { Authorization: `Bearer ${newToken}` } }));
  }

  if (!response.ok) {
    const detail = data?.message || response.statusText || response.status;
    throw new Error(`Erro na API do Mercado Livre (${response.status}): ${detail}`);
  }
  return data;
}

async function shopeeApiGet(url) {
  const { response, data } = await fetchJson(url, {
    headers: { 'X-Requested-With': 'XMLHttpRequest' },
  });
  if (!response.ok) throw new Error(`Erro na API da Shopee (${response.status}).`);
  if (data && data.error) throw new Error(`A Shopee recusou a consulta (código ${data.error}).`);
  return data;
}

/** Executa a promessa e devolve `null` em vez de propagar o erro. */
async function safe(promise) {
  try {
    return await promise;
  } catch (error) {
    return null;
  }
}

// ==================================================================
//  CACHE EM MEMÓRIA
// ==================================================================

/**
 * Cache simples com TTL. Vive apenas enquanto o service worker estiver ativo,
 * o que já basta para evitar rajadas de chamadas repetidas (ex.: 50 cards de
 * busca do mesmo vendedor) sem arriscar servir dado velho por muito tempo.
 */
const memoryCache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000;

async function cached(key, producer, ttl = CACHE_TTL_MS) {
  const hit = memoryCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value;

  const value = await producer();
  memoryCache.set(key, { value, expiresAt: Date.now() + ttl });

  // Poda preguiçosa para o cache não crescer indefinidamente.
  if (memoryCache.size > 400) {
    for (const [k, entry] of memoryCache) {
      if (entry.expiresAt <= Date.now()) memoryCache.delete(k);
    }
  }
  return value;
}

// ==================================================================
//  INTELIGÊNCIA DE PRODUTO — MERCADO LIVRE
// ==================================================================

const ML_SITE = 'MLB';

function normalizeItemId(rawId) {
  return String(rawId || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Comissão real da categoria + taxa fixa, direto da tabela oficial do ML. */
async function fetchListingPrices(price, categoryId) {
  const params = new URLSearchParams({ price: String(price || 100) });
  if (categoryId) params.set('category_id', categoryId);
  const key = `listing_prices:${params}`;
  return cached(key, () => mlApiGet(`/sites/${ML_SITE}/listing_prices?${params}`));
}

async function fetchSeller(sellerId) {
  if (!sellerId) return null;
  return cached(`seller:${sellerId}`, () => mlApiGet(`/users/${sellerId}`));
}

/** Quantidade de anúncios ativos do vendedor — sinaliza porte da operação. */
async function fetchSellerListingCount(sellerId) {
  if (!sellerId) return null;
  return cached(`seller_count:${sellerId}`, async () => {
    const data = await mlApiGet(`/sites/${ML_SITE}/search?seller_id=${sellerId}&limit=1`);
    return data?.paging?.total ?? null;
  });
}

async function fetchCategory(categoryId) {
  if (!categoryId) return null;
  return cached(`category:${categoryId}`, () => mlApiGet(`/categories/${categoryId}`), 60 * 60 * 1000);
}

/** Série de visitas dos últimos N dias (exige token na maioria das contas). */
async function fetchVisits(itemId, days = 30) {
  return mlApiGet(`/items/${itemId}/visits/time_window?last=${days}&unit=day`, { requireAuth: true });
}

/** Posição do item no ranking de mais vendidos da categoria. */
async function fetchCategoryRanking(categoryId, itemId) {
  if (!categoryId) return null;
  const data = await cached(`highlights:${categoryId}`, () =>
    mlApiGet(`/highlights/${ML_SITE}/category/${categoryId}`),
  );
  const content = data?.content;
  if (!Array.isArray(content)) return null;
  const index = content.findIndex((entry) => normalizeItemId(entry.id) === normalizeItemId(itemId));
  return { position: index >= 0 ? index + 1 : null, total: content.length };
}

/** Concorrência dentro do anúncio de catálogo (quem está ganhando a Buy Box). */
async function fetchCatalogCompetition(catalogProductId, itemId) {
  if (!catalogProductId) return null;
  const [product, competitors] = await Promise.all([
    safe(mlApiGet(`/products/${catalogProductId}`)),
    safe(mlApiGet(`/products/${catalogProductId}/items?limit=20`)),
  ]);
  if (!product && !competitors) return null;

  const results = competitors?.results || [];
  const winnerId = normalizeItemId(product?.buy_box_winner?.item_id);
  return {
    catalogProductId,
    winnerItemId: winnerId || null,
    isWinner: Boolean(winnerId) && winnerId === normalizeItemId(itemId),
    winnerPrice: product?.buy_box_winner?.price ?? null,
    competitorCount: competitors?.paging?.total ?? results.length,
    lowestPrice: results.reduce(
      (min, entry) => (typeof entry.price === 'number' ? Math.min(min, entry.price) : min),
      Infinity,
    ),
  };
}

/**
 * Reúne, em paralelo, tudo que a API pública/autenticada sabe sobre um anúncio.
 * Cada bloco é opcional: se um endpoint falhar (401, 404, rate limit), o campo
 * volta `null` e o HUD simplesmente omite aquela seção.
 */
async function analyzeMlItem(rawItemId) {
  const itemId = normalizeItemId(rawItemId);
  if (!itemId) throw new Error('ID do anúncio não informado.');

  const item = await mlApiGet(`/items/${itemId}`);

  const [
    description,
    seller,
    sellerListings,
    category,
    listingPrices,
    reviews,
    visits,
    ranking,
    catalog,
  ] = await Promise.all([
    safe(mlApiGet(`/items/${itemId}/description`)),
    safe(fetchSeller(item.seller_id)),
    safe(fetchSellerListingCount(item.seller_id)),
    safe(fetchCategory(item.category_id)),
    safe(fetchListingPrices(item.price, item.category_id)),
    safe(mlApiGet(`/reviews/item/${itemId}`)),
    safe(fetchVisits(itemId)),
    safe(fetchCategoryRanking(item.category_id, itemId)),
    safe(fetchCatalogCompetition(item.catalog_product_id, itemId)),
  ]);

  return {
    item,
    description,
    seller,
    sellerListings,
    category,
    listingPrices,
    reviews,
    visits,
    ranking,
    catalog,
    authenticated: Boolean(await getValidAccessToken()),
  };
}

/**
 * Multiget de itens para enriquecer os cards da página de busca.
 * A API aceita no máximo 20 ids por chamada.
 */
const SEARCH_ATTRIBUTES = [
  'id',
  'title',
  'price',
  'original_price',
  'available_quantity',
  'sold_quantity',
  'listing_type_id',
  'date_created',
  'condition',
  'catalog_listing',
  'catalog_product_id',
  'health',
  'permalink',
  'seller_id',
  'category_id',
  'shipping',
].join(',');

async function fetchItemsBatch(ids) {
  const unique = [...new Set(ids.map(normalizeItemId).filter(Boolean))];
  const chunks = [];
  for (let i = 0; i < unique.length; i += 20) chunks.push(unique.slice(i, i + 20));

  const responses = await Promise.all(
    chunks.map((chunk) =>
      safe(mlApiGet(`/items?ids=${chunk.join(',')}&attributes=${SEARCH_ATTRIBUTES}`)),
    ),
  );

  const items = {};
  for (const response of responses) {
    for (const entry of response || []) {
      if (entry?.code === 200 && entry.body?.id) items[normalizeItemId(entry.body.id)] = entry.body;
    }
  }

  // Nickname do vendedor: usado para detectar monopólio de loja no grid.
  const sellerIds = [...new Set(Object.values(items).map((item) => item.seller_id).filter(Boolean))];
  const sellers = {};
  await Promise.all(
    sellerIds.map(async (sellerId) => {
      const seller = await safe(fetchSeller(sellerId));
      if (seller) {
        sellers[sellerId] = {
          id: sellerId,
          nickname: seller.nickname,
          level: seller.seller_reputation?.level_id ?? null,
          powerSeller: seller.seller_reputation?.power_seller_status ?? null,
          positive: seller.seller_reputation?.transactions?.ratings?.positive ?? null,
          city: seller.address?.city ?? null,
          state: seller.address?.state ?? null,
        };
      }
    }),
  );

  return { items, sellers };
}

// ==================================================================
//  SNAPSHOTS DE VENDAS
// ==================================================================

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Grava a leitura de vendas do dia. Mantém apenas o maior valor visto no dia
 * (as plataformas às vezes devolvem números menores por cache) e limita a
 * série a SNAPSHOT_MAX_DAYS entradas.
 */
async function saveSnapshot({ productId, vendas }) {
  if (!productId || typeof vendas !== 'number' || !Number.isFinite(vendas)) {
    throw new Error('Snapshot inválido: productId e vendas numéricas são obrigatórios.');
  }

  const snapshots = (await readStorage(STORAGE_KEYS.snapshots)) || {};
  const series = snapshots[productId] || [];
  const today = todayKey();
  const existing = series.find((entry) => entry.date === today);

  if (existing) {
    if (vendas > existing.vendas) existing.vendas = vendas;
  } else {
    series.push({ date: today, vendas });
  }

  series.sort((a, b) => (a.date < b.date ? -1 : 1));
  snapshots[productId] = series.slice(-SNAPSHOT_MAX_DAYS);

  await writeStorage(STORAGE_KEYS.snapshots, snapshots);
  return { history: snapshots[productId] };
}

// ==================================================================
//  GARIMPO
// ==================================================================

async function saveGarimpoItem(item) {
  if (!item || typeof item !== 'object') throw new Error('Item inválido.');
  const items = (await readStorage(STORAGE_KEYS.garimpo)) || [];
  // Substitui a entrada anterior da mesma URL em vez de acumular duplicatas.
  const deduped = items.filter((existing) => !item.url || existing.url !== item.url);
  deduped.unshift(item);
  await writeStorage(STORAGE_KEYS.garimpo, deduped.slice(0, 500));
  return { total: deduped.length };
}

async function removeGarimpoItem(itemId) {
  const items = (await readStorage(STORAGE_KEYS.garimpo)) || [];
  await writeStorage(STORAGE_KEYS.garimpo, items.filter((item) => item.id !== itemId));
}

// ==================================================================
//  DOWNLOADS DE MÍDIA
// ==================================================================

function guessExtension(url) {
  const match = url.match(/\.(jpe?g|png|webp|gif|mp4|webm)(?:[?#]|$)/i);
  return match ? match[1].toLowerCase() : 'jpg';
}

/** Reduz um texto livre a um nome de pasta/arquivo seguro para o downloads. */
function sanitizeSegment(value, fallback) {
  const clean = String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // remove os acentos separados pelo NFD
    .replace(/[^a-zA-Z0-9-_ ]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 48);
  return clean || fallback;
}

async function downloadMedia({ urls = [], prefix = 'midia' }) {
  const safePrefix = sanitizeSegment(prefix, 'midia');
  const valid = urls.filter((url) => typeof url === 'string' && /^https?:\/\//i.test(url));

  let baixadas = 0;
  let falhas = 0;

  for (const [index, url] of valid.entries()) {
    try {
      await chrome.downloads.download({
        url,
        filename: `analisador_pro/${safePrefix}/${safePrefix}_${index + 1}.${guessExtension(url)}`,
        conflictAction: 'uniquify',
        saveAs: false,
      });
      baixadas += 1;
    } catch (error) {
      console.warn('[Analisador Pro] Falha ao baixar mídia:', url, error);
      falhas += 1;
    }
  }

  return { baixadas, falhas, total: valid.length, ignoradas: urls.length - valid.length };
}

// ==================================================================
//  ROTEADOR DE MENSAGENS
// ==================================================================

/**
 * Cada handler recebe a mensagem e devolve o payload de sucesso (ou nada).
 * O invólucro padroniza a resposta em { success, ...payload } | { success:false, error }.
 */
const handlers = {
  // --- Auth ---
  login: async () => {
    await iniciarAutenticacao();
  },
  logout: async () => {
    await clearTokens();
  },
  getAuthStatus: async () => getAuthStatus(),
  getRedirectUri: async () => ({ redirectUri: getRedirectUri() }),
  getOAuthConfig: async () => {
    const { clientId, isCustom } = await getOAuthConfig();
    // O secret nunca sai do service worker.
    return { clientId: isCustom ? clientId : '', isCustom };
  },
  saveOAuthConfig: async ({ config }) => {
    if (!config) {
      await writeStorage(STORAGE_KEYS.oauthConfig, null);
      return;
    }
    if (!config.clientId || !config.clientSecret) {
      throw new Error('Informe Client ID e Client Secret.');
    }
    await writeStorage(STORAGE_KEYS.oauthConfig, {
      clientId: String(config.clientId).trim(),
      clientSecret: String(config.clientSecret).trim(),
    });
    await clearTokens();
  },

  // --- Configurações ---
  getCustomTaxes: async () => ({ taxes: await readStorage(STORAGE_KEYS.mlTaxes) }),
  saveCustomTaxes: async ({ taxes }) => {
    await writeStorage(STORAGE_KEYS.mlTaxes, taxes);
  },
  getShopeeCustomTaxes: async () => ({ taxes: await readStorage(STORAGE_KEYS.shopeeTaxes) }),
  saveShopeeCustomTaxes: async ({ taxes }) => {
    await writeStorage(STORAGE_KEYS.shopeeTaxes, taxes);
  },
  getGlobalCosts: async () => ({ costs: await readStorage(STORAGE_KEYS.globalCosts) }),
  saveGlobalCosts: async ({ costs }) => {
    await writeStorage(STORAGE_KEYS.globalCosts, costs);
  },

  // --- Garimpo ---
  saveGarimpo: async ({ item }) => saveGarimpoItem(item),
  getGarimpoList: async () => ({ items: (await readStorage(STORAGE_KEYS.garimpo)) || [] }),
  removeGarimpoItem: async ({ itemId }) => {
    await removeGarimpoItem(itemId);
  },
  clearGarimpo: async () => {
    await writeStorage(STORAGE_KEYS.garimpo, null);
  },

  // --- API Mercado Livre ---
  /** Raio-X completo de um anúncio: item, vendedor, categoria, tarifas, reviews, visitas. */
  analyzeMlItem: async ({ itemId }) => ({ analysis: await analyzeMlItem(itemId) }),
  /** Produto de catálogo (`/p/MLB…`) — usado para achar o anúncio vencedor. */
  fetchMlCatalogProduct: async ({ productId }) => {
    const id = normalizeItemId(productId);
    if (!id) throw new Error('ID do produto de catálogo não fornecido.');
    return { data: await mlApiGet(`/products/${id}`) };
  },
  /** Enriquecimento dos cards da página de busca. */
  fetchMlItemsBatch: async ({ ids }) => fetchItemsBatch(Array.isArray(ids) ? ids : []),
  fetchMlSuggestions: async ({ query }) => {
    const term = String(query || '').trim();
    if (!term) return { suggestions: [] };
    const url = `https://http2.mlstatic.com/resources/sites/MLB/autosuggest?showFilters=false&limit=12&api_version=2&q=${encodeURIComponent(term)}`;
    const { response, data } = await fetchJson(url);
    if (!response.ok) throw new Error(`Autosuggest indisponível (${response.status}).`);
    const suggestions = (data?.suggested_queries || [])
      .map((entry) => (typeof entry === 'string' ? entry : entry?.q))
      .filter(Boolean);
    return { suggestions };
  },

  // --- API Shopee ---
  fetchShopeeSuggestions: async ({ query }) => {
    const term = String(query || '').trim();
    if (!term) return { suggestions: [] };
    const data = await shopeeApiGet(
      `https://shopee.com.br/api/v4/search/search_hint?keyword=${encodeURIComponent(term)}`,
    );
    const raw = data?.data?.keywords ?? data?.keywords ?? [];
    const suggestions = raw
      .map((entry) => (typeof entry === 'string' ? entry : entry?.keyword))
      .filter(Boolean);
    return { suggestions };
  },
  // NÃO adicione aqui handlers que consultem as APIs de produto da Shopee.
  // Elas exigem mesma origem + cookies de sessão e recusam qualquer chamada
  // vinda do service worker (`{"error":99999}`). Esse trabalho é feito pelo
  // content script, que compartilha a origem da página. Ver a seção
  // "SHOPEE — PONTE COM A API INTERNA" em content.js.

  // --- Snapshots (a resposta já devolve a série completa) ---
  saveSnapshot: async ({ data }) => saveSnapshot(data || {}),

  // --- Downloads ---
  downloadMedia: async (message) => downloadMedia(message),
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handler = handlers[message?.type];
  if (!handler) {
    sendResponse({ success: false, error: `Ação desconhecida: ${message?.type}` });
    return false;
  }

  Promise.resolve()
    .then(() => handler(message))
    .then((payload) => sendResponse({ success: true, ...(payload || {}) }))
    .catch((error) => {
      console.warn(`[Analisador Pro] ${message.type} falhou:`, error);
      sendResponse({ success: false, error: error?.message || String(error) });
    });

  return true; // resposta assíncrona
});

// ==================================================================
//  ALARMES
// ==================================================================

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== TOKEN_REFRESH_ALARM) return;
  refreshAccessToken().catch((error) => {
    console.warn('[Analisador Pro] Renovação automática de token falhou:', error.message);
  });
});

/** Reagenda o alarme após reinício do navegador ou do service worker. */
async function ensureRefreshAlarm() {
  const status = await getAuthStatus();
  if (status.status === 'logged_in') {
    scheduleTokenRefresh(status.expiresIn);
  } else if (status.status === 'expired' && status.canRefresh) {
    refreshAccessToken().catch(() => {});
  }
}

// ==================================================================
//  declarativeNetRequest — remove o header Origin das APIs públicas
// ==================================================================

const DNR_RULES = [
  {
    id: 1,
    priority: 1,
    action: { type: 'modifyHeaders', requestHeaders: [{ header: 'origin', operation: 'remove' }] },
    condition: {
      urlFilter: '||mlstatic.com/resources/sites/',
      resourceTypes: ['xmlhttprequest'],
    },
  },
  {
    id: 2,
    priority: 1,
    action: { type: 'modifyHeaders', requestHeaders: [{ header: 'origin', operation: 'remove' }] },
    condition: {
      urlFilter: '||shopee.com.br/api/',
      resourceTypes: ['xmlhttprequest'],
    },
  },
];

async function setupDeclarativeRules() {
  if (!chrome.declarativeNetRequest?.updateDynamicRules) return;
  try {
    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: existing.map((rule) => rule.id),
      addRules: DNR_RULES,
    });
  } catch (error) {
    console.warn('[Analisador Pro] Não foi possível registrar as regras de rede:', error.message);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  setupDeclarativeRules();
  ensureRefreshAlarm();
  console.info(
    '[Analisador Pro] Cadastre esta Redirect URI no painel do Mercado Livre:',
    getRedirectUri(),
  );
});

chrome.runtime.onStartup.addListener(() => {
  setupDeclarativeRules();
  ensureRefreshAlarm();
});
