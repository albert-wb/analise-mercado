/**
 * content.js — Analisador Pro v8.0 (Mercado Livre + Shopee)
 *
 * Injeta o HUD "Dark Commerce" nas páginas de produto e as métricas nos cards
 * das páginas de busca.
 *
 * Princípios do arquivo:
 *   - Nenhuma string vinda da página ou da API é concatenada em HTML. Toda a
 *     UI é montada com `el()` / `textContent`, o que elimina XSS e também evita
 *     o bloqueio de `style="..."` inline pela CSP das plataformas.
 *   - Nenhuma chamada de rede sai daqui: tudo passa pelo service worker
 *     (`send()`), que não sofre com o CORS da página hospedeira.
 *   - Dados sempre degradam: API → DOM → omissão da seção. Nunca quebra o HUD.
 */

// ==================================================================
//  CONSTANTES
// ==================================================================

const PANEL_ID = 'meu-painel-analise';
const BUTTON_CLASS = 'meu-botao-analise';
const BADGE_CLASS = 'ml-search-badge';

/** Fallback usado quando a API de tarifas do ML não responde. */
const TAXAS_MERCADO_LIVRE = {
  limiteCustoFixo: 79.0,
  custoFixo: 6.0,
  taxasPorAnuncio: { Classico: 0.13, Premium: 0.18 },
};

const TAXAS_SHOPEE = {
  comissao: 0.14,
  taxaFixa: 3.0,
};

const CUSTOS_GLOBAIS_PADRAO = { imposto: 0, custoFixo: 0 };

/** Rótulos legíveis para os tipos de logística do Mercado Livre. */
const LOGISTICA_LABEL = {
  fulfillment: 'Full',
  self_service: 'Flex',
  cross_docking: 'Coleta',
  drop_off: 'Correios (Agência)',
  xd_drop_off: 'Correios (Coleta)',
  default: 'Padrão',
};

const TIPO_ANUNCIO_LABEL = {
  gold_pro: 'Premium',
  gold_special: 'Clássico',
  gold: 'Ouro',
  silver: 'Prata',
  bronze: 'Grátis',
  free: 'Grátis',
};

const REPUTACAO_LABEL = {
  '5_green': 'Verde (máxima)',
  '4_light_green': 'Verde claro',
  '3_yellow': 'Amarelo',
  '2_orange': 'Laranja',
  '1_red': 'Vermelho',
};

/** Palavras ignoradas ao minerar termos de avaliações e de SEO. */
const STOPWORDS = new Set(
  ('a o e de da do das dos em no na nos nas um uma uns umas para por com sem que se ao aos à às ' +
    'mais menos muito muita pouco pouca já não sim eu você ele ela nós eles elas meu minha seu sua ' +
    'este esta isso isto aquele aquela como quando onde qual quais mas ou porque pois então ainda ' +
    'foi ser são está estão tem têm ter teve havia sobre até entre desde após antes depois também ' +
    'só bem mal muito bom boa ótimo produto compra comprei chegou veio recomendo').split(/\s+/),
);

// ==================================================================
//  ESTADO
// ==================================================================

const state = {
  plataforma: 'unknown',
  /** Modelo unificado da análise atual (ver `criarAnaliseVazia`). */
  analise: null,
  taxasMl: null,
  taxasShopee: null,
  custosGlobais: { ...CUSTOS_GLOBAIS_PADRAO },
  /** Observers ativos — desconectados a cada troca de rota da SPA. */
  observers: [],
  timers: [],
  /** Cache de ids já enriquecidos na página de busca. */
  cardsEnriquecidos: new WeakSet(),
  /** Contagem de anúncios por vendedor na busca (detecção de monopólio). */
  contagemVendedores: new Map(),
};

// ==================================================================
//  MENSAGERIA
// ==================================================================

/** Envia uma mensagem ao service worker e resolve sempre (nunca rejeita). */
function send(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ success: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(response || { success: false, error: 'Sem resposta do service worker.' });
      });
    } catch (error) {
      resolve({ success: false, error: error.message });
    }
  });
}

// ==================================================================
//  HELPERS DE DOM
// ==================================================================

/**
 * Cria um elemento sem nunca interpretar HTML.
 * @param {string} tag
 * @param {object} [props] className | text | title | id | style | dataset | on | attrs
 * @param {Array<Node|string|null|false>} [children]
 */
function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);

  if (props.className) node.className = props.className;
  if (props.id) node.id = props.id;
  if (props.text !== undefined && props.text !== null) node.textContent = String(props.text);
  if (props.title) node.title = props.title;
  if (props.style) {
    for (const [key, value] of Object.entries(props.style)) {
      if (value !== null && value !== undefined) node.style.setProperty(key, String(value));
    }
  }
  if (props.dataset) {
    for (const [key, value] of Object.entries(props.dataset)) node.dataset[key] = value;
  }
  if (props.attrs) {
    for (const [key, value] of Object.entries(props.attrs)) node.setAttribute(key, value);
  }
  if (props.on) {
    for (const [event, handler] of Object.entries(props.on)) node.addEventListener(event, handler);
  }

  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

function svgEl(tag, attrs = {}) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

function textOf(selector, root = document) {
  const node = root.querySelector(selector);
  return node?.textContent?.trim() || null;
}

// ==================================================================
//  FORMATADORES
// ==================================================================

const fmtMoeda = (valor) =>
  typeof valor === 'number' && Number.isFinite(valor)
    ? valor.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
    : '—';

const fmtNumero = (valor) =>
  typeof valor === 'number' && Number.isFinite(valor) ? valor.toLocaleString('pt-BR') : '—';

const fmtDecimal = (valor, casas = 1) =>
  typeof valor === 'number' && Number.isFinite(valor)
    ? valor.toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas })
    : '—';

const fmtPercent = (valor, casas = 1) =>
  typeof valor === 'number' && Number.isFinite(valor) ? `${fmtDecimal(valor, casas)}%` : '—';

function fmtData(iso) {
  if (!iso) return '—';
  const data = new Date(iso);
  if (Number.isNaN(data.getTime())) return '—';
  return data.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function fmtIdade(dias) {
  if (typeof dias !== 'number' || !Number.isFinite(dias)) return '—';
  if (dias < 1) return 'Hoje';
  if (dias < 30) return `${dias} dia${dias > 1 ? 's' : ''}`;
  if (dias < 365) {
    const meses = Math.floor(dias / 30);
    return `${meses} ${meses > 1 ? 'meses' : 'mês'}`;
  }
  const anos = Math.floor(dias / 365);
  const restoMeses = Math.floor((dias % 365) / 30);
  return restoMeses > 0 ? `${anos}a ${restoMeses}m` : `${anos} ano${anos > 1 ? 's' : ''}`;
}

function diasEntre(iso, ate = Date.now()) {
  if (!iso) return null;
  const inicio = new Date(iso).getTime();
  if (Number.isNaN(inicio)) return null;
  return Math.max(1, Math.floor((ate - inicio) / 86400000));
}

function parseNumeroBR(texto) {
  if (!texto) return null;
  const limpo = String(texto).replace(/[^\d.,]/g, '').replace(/\./g, '').replace(',', '.');
  const valor = parseFloat(limpo);
  return Number.isFinite(valor) ? valor : null;
}

/** Interpreta textos como "+1000 vendidos", "2,5 mil vendidos". */
function parseQuantidadeTexto(texto) {
  if (!texto) return null;
  const normalizado = texto.toLowerCase();
  const match = normalizado.match(/([\d.,]+)\s*(mil|k)?/);
  if (!match) return null;
  let valor = parseFloat(match[1].replace(/\./g, '').replace(',', '.'));
  if (!Number.isFinite(valor)) return null;
  if (match[2]) valor *= 1000;
  return Math.round(valor);
}

// ==================================================================
//  CONFIGURAÇÕES (taxas e custos)
// ==================================================================

async function carregarConfiguracoes() {
  const [ml, shopee, globais] = await Promise.all([
    send({ type: 'getCustomTaxes' }),
    send({ type: 'getShopeeCustomTaxes' }),
    send({ type: 'getGlobalCosts' }),
  ]);

  state.taxasMl = normalizarTaxasMl(ml.success ? ml.taxes : null);
  state.taxasShopee = normalizarTaxasShopee(shopee.success ? shopee.taxes : null);
  state.custosGlobais = normalizarCustosGlobais(globais.success ? globais.costs : null);
}

function normalizarTaxasMl(taxas) {
  if (!taxas || typeof taxas !== 'object' || !taxas.taxasPorAnuncio) return { ...TAXAS_MERCADO_LIVRE };
  return {
    limiteCustoFixo: Number(taxas.limiteCustoFixo) || TAXAS_MERCADO_LIVRE.limiteCustoFixo,
    custoFixo: Number(taxas.custoFixo) || TAXAS_MERCADO_LIVRE.custoFixo,
    taxasPorAnuncio: {
      Classico: Number(taxas.taxasPorAnuncio.Classico) || TAXAS_MERCADO_LIVRE.taxasPorAnuncio.Classico,
      Premium: Number(taxas.taxasPorAnuncio.Premium) || TAXAS_MERCADO_LIVRE.taxasPorAnuncio.Premium,
    },
  };
}

function normalizarTaxasShopee(taxas) {
  if (!taxas || typeof taxas !== 'object') return { ...TAXAS_SHOPEE };
  return {
    comissao: Number(taxas.comissao) || TAXAS_SHOPEE.comissao,
    taxaFixa: Number.isFinite(Number(taxas.taxaFixa)) ? Number(taxas.taxaFixa) : TAXAS_SHOPEE.taxaFixa,
  };
}

function normalizarCustosGlobais(custos) {
  if (!custos || typeof custos !== 'object') return { ...CUSTOS_GLOBAIS_PADRAO };
  return {
    imposto: Number.isFinite(Number(custos.imposto)) ? Number(custos.imposto) : 0,
    custoFixo: Number.isFinite(Number(custos.custoFixo)) ? Number(custos.custoFixo) : 0,
  };
}

// Recalcula o HUD quando as configurações mudam no popup.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  let mudou = false;

  if (changes.ml_custom_taxes) {
    state.taxasMl = normalizarTaxasMl(changes.ml_custom_taxes.newValue);
    mudou = true;
  }
  if (changes.shopee_custom_taxes) {
    state.taxasShopee = normalizarTaxasShopee(changes.shopee_custom_taxes.newValue);
    mudou = true;
  }
  if (changes.global_costs) {
    state.custosGlobais = normalizarCustosGlobais(changes.global_costs.newValue);
    mudou = true;
  }

  if (mudou && document.getElementById(PANEL_ID)) recalcularCalculadora();
});

// ==================================================================
//  MODELO DE ANÁLISE
// ==================================================================

function criarAnaliseVazia(plataforma) {
  return {
    plataforma,
    id: null,
    url: window.location.href,
    permalink: null,
    titulo: null,
    preco: null,
    precoMin: null,
    precoMax: null,
    precoOriginal: null,
    descontoPercent: null,
    vendasTotais: null,
    vendas30d: null,
    vendas30dFonte: null, // 'medido' | 'estimado'
    vendasPorDia: null,
    diasRastreados: null,
    estoque: null,
    coberturaEstoqueDias: null,
    curtidas: null,
    variacoes: null,
    localizacao: null,
    faturamentoTotal: null,
    faturamento30d: null,
    dataCriacao: null,
    idadeDias: null,
    ultimaAtualizacao: null,
    tipoAnuncio: null,
    logistica: null,
    freteGratis: null,
    condicao: null,
    ean: null,
    marca: null,
    modelo: null,
    garantia: null,
    saudeFicha: null,
    catalogo: null,
    categoria: null,
    ranking: null,
    vendedor: null,
    visitas: null,
    tarifas: null, // { percentual, fixo, fonte, rotulo }
    avaliacoes: null,
    fotos: [],
    video: null,
    atributos: [],
    seo: null,
    fonteDados: [], // rótulos de origem: 'API', 'DOM', 'histórico local'
  };
}

// ==================================================================
//  MERCADO LIVRE — EXTRAÇÃO DO DOM
// ==================================================================

function extrairIdItemDaUrl(url = window.location.href) {
  // Anúncios de catálogo levam o item real no fragmento (#wid=MLB...) ou na query.
  const wid = url.match(/[?&#]wid=(MLB\d+)/i);
  if (wid) return wid[1].toUpperCase();
  const itemId = url.match(/[?&#]item_id=(MLB\d+)/i);
  if (itemId) return itemId[1].toUpperCase();

  // `/p/MLB123` é o id do PRODUTO de catálogo, não do anúncio: remove antes
  // de procurar o id do item para não confundir os dois.
  const semCatalogo = url.replace(/\/p\/MLB\d+/gi, '/p/');
  const direto = semCatalogo.match(/MLB-?(\d{6,})/i);
  return direto ? `MLB${direto[1]}` : null;
}

function extrairIdCatalogoDaUrl(url = window.location.href) {
  const match = url.match(/\/p\/(MLB\d+)/i);
  return match ? match[1].toUpperCase() : null;
}

function extrairDadosDomMeli() {
  const analise = criarAnaliseVazia('meli');
  analise.id = extrairIdItemDaUrl();

  // JSON-LD é a fonte mais estável do preço e do título.
  for (const script of $$('script[type="application/ld+json"]')) {
    try {
      const dados = JSON.parse(script.textContent);
      const produtos = Array.isArray(dados) ? dados : [dados];
      for (const produto of produtos) {
        if (produto['@type'] !== 'Product') continue;
        analise.titulo = analise.titulo || produto.name || null;
        const oferta = produto.offers?.offers?.[0] || produto.offers;
        if (oferta?.price) analise.preco = analise.preco ?? parseFloat(oferta.price);
        if (produto.gtin13 || produto.gtin) analise.ean = produto.gtin13 || produto.gtin;
        if (produto.brand?.name) analise.marca = produto.brand.name;
      }
    } catch {
      /* JSON-LD malformado: seguimos com o DOM */
    }
  }

  analise.titulo = analise.titulo || textOf('.ui-pdp-title') || document.title.split('|')[0].trim();

  if (analise.preco == null) {
    const container = $('.ui-pdp-price__second-line') || document;
    const inteiro = parseNumeroBR(textOf('.andes-money-amount__fraction', container));
    const centavos = parseNumeroBR(textOf('.andes-money-amount__cents', container));
    if (inteiro != null) analise.preco = inteiro + (centavos ? centavos / 100 : 0);
  }

  // Vendas: "+500 vendidos" / "Novo | 1 mil vendidos"
  const subtitulo = textOf('.ui-pdp-subtitle') || textOf('.ui-pdp-header__subtitle');
  if (subtitulo) {
    const match = subtitulo.match(/([\d.,]+\s*(?:mil)?)\s*vendid/i);
    if (match) analise.vendasTotais = parseQuantidadeTexto(match[1]);
    if (/novo/i.test(subtitulo)) analise.condicao = 'Novo';
    else if (/usado/i.test(subtitulo)) analise.condicao = 'Usado';
  }

  // Tipo de anúncio: parcelamento sem juros indica Premium.
  const parcelamento = textOf('.ui-pdp-price__subtitles') || '';
  analise.tipoAnuncio = /sem juros/i.test(parcelamento) ? 'Premium' : 'Clássico';

  // EAN na ficha técnica.
  if (!analise.ean) {
    for (const linha of $$('.ui-vpp-striped-specs__row, .andes-table__row')) {
      const cabecalho = textOf('th', linha)?.toUpperCase() || '';
      if (/^(EAN|GTIN|CÓDIGO UNIVERSAL DE PRODUTO)/.test(cabecalho)) {
        analise.ean = textOf('td', linha);
        break;
      }
    }
  }

  const frete = $('.ui-pdp-media__body')?.textContent?.toLowerCase() || '';
  analise.freteGratis = /gr[áa]tis/.test(frete) || Boolean($('.ui-pdp-color--GREEN'));

  const estoqueTexto = textOf('.ui-pdp-buybox__quantity__available') || textOf('.ui-pdp-stock-information');
  if (estoqueTexto) analise.estoque = parseQuantidadeTexto(estoqueTexto);

  const perfil = $('a[href*="/perfil/"]');
  if (perfil) {
    const match = perfil.getAttribute('href').match(/perfil\/([^/?#]+)/);
    if (match) analise.vendedor = { nick: decodeURIComponent(match[1]) };
  }

  // Fallback de idade quando a API não responde ("Publicado há 3 meses").
  const publicado = document.body.textContent.match(/Publicado h[áa] (\d+)\s*(dia|mês|meses|ano|anos)/i);
  if (publicado) {
    const quantidade = parseInt(publicado[1], 10);
    const unidade = publicado[2].toLowerCase();
    const data = new Date();
    if (unidade.startsWith('dia')) data.setDate(data.getDate() - quantidade);
    else if (unidade.startsWith('m')) data.setMonth(data.getMonth() - quantidade);
    else data.setFullYear(data.getFullYear() - quantidade);
    analise.dataCriacao = data.toISOString();
  }

  // Galeria (fallback quando a API de itens falha).
  analise.fotos = $$('.ui-pdp-gallery__figure img, .ui-pdp-thumbnail img')
    .map((img) => img.getAttribute('data-zoom') || img.src)
    .filter((url) => url && url.startsWith('http'))
    .map((url) => url.replace(/-[A-Z]\.(jpg|webp|png)/i, '-O.$1'));

  analise.fonteDados.push('DOM');
  return analise;
}

// ==================================================================
//  MERCADO LIVRE — ENRIQUECIMENTO VIA API
// ==================================================================

function rotuloLogistica(shipping) {
  if (!shipping) return null;
  if (shipping.logistic_type && LOGISTICA_LABEL[shipping.logistic_type]) {
    return LOGISTICA_LABEL[shipping.logistic_type];
  }
  if (shipping.store_pick_up) return 'Retirada';
  return shipping.mode ? 'Padrão' : null;
}

function valorAtributo(atributos, ...ids) {
  if (!Array.isArray(atributos)) return null;
  for (const id of ids) {
    const encontrado = atributos.find((attr) => attr.id === id);
    if (encontrado?.value_name) return encontrado.value_name;
  }
  return null;
}

/** Aplica o payload de `analyzeMlItem` sobre o modelo extraído do DOM. */
function aplicarAnaliseApiMeli(analise, payload) {
  const { item, seller, sellerListings, category, listingPrices, reviews, visits, ranking, catalog, description } =
    payload;
  if (!item) return analise;

  analise.id = item.id || analise.id;
  analise.titulo = item.title || analise.titulo;
  analise.permalink = item.permalink || null;
  analise.preco = typeof item.price === 'number' ? item.price : analise.preco;
  analise.precoOriginal = typeof item.original_price === 'number' ? item.original_price : null;
  if (analise.precoOriginal && analise.preco && analise.precoOriginal > analise.preco) {
    analise.descontoPercent = ((analise.precoOriginal - analise.preco) / analise.precoOriginal) * 100;
  }

  if (typeof item.sold_quantity === 'number' && item.sold_quantity > 0) {
    analise.vendasTotais = item.sold_quantity;
  }
  if (typeof item.initial_quantity === 'number' && typeof item.available_quantity === 'number') {
    // Quando `sold_quantity` não vem (a API deixou de expor em muitos casos),
    // a diferença entre o estoque inicial e o atual é a melhor aproximação.
    const vendidoEstimado = item.initial_quantity - item.available_quantity;
    if (!analise.vendasTotais && vendidoEstimado > 0) analise.vendasTotais = vendidoEstimado;
  }
  analise.estoque = typeof item.available_quantity === 'number' ? item.available_quantity : analise.estoque;

  analise.dataCriacao = item.date_created || analise.dataCriacao;
  analise.ultimaAtualizacao = item.last_updated || null;
  analise.tipoAnuncio = TIPO_ANUNCIO_LABEL[item.listing_type_id] || analise.tipoAnuncio;
  analise.logistica = rotuloLogistica(item.shipping) || analise.logistica;
  analise.freteGratis = item.shipping?.free_shipping ?? analise.freteGratis;
  analise.condicao = item.condition === 'new' ? 'Novo' : item.condition === 'used' ? 'Usado' : analise.condicao;
  analise.garantia = item.warranty || null;
  analise.saudeFicha = typeof item.health === 'number' ? item.health : null;
  analise.atributos = Array.isArray(item.attributes) ? item.attributes : [];

  analise.ean = valorAtributo(analise.atributos, 'GTIN', 'EAN') || analise.ean;
  analise.marca = valorAtributo(analise.atributos, 'BRAND') || analise.marca;
  analise.modelo = valorAtributo(analise.atributos, 'MODEL', 'ALPHANUMERIC_MODEL') || analise.modelo;

  const fotosApi = (item.pictures || []).map((foto) => foto.secure_url || foto.url).filter(Boolean);
  if (fotosApi.length) analise.fotos = fotosApi;
  if (item.video_id) analise.video = `https://www.youtube.com/watch?v=${item.video_id}`;

  if (category) {
    analise.categoria = {
      id: category.id,
      nome: category.name,
      caminho: (category.path_from_root || []).map((nivel) => nivel.name),
      totalItens: category.total_items_in_this_category ?? null,
    };
  }

  if (ranking?.position) analise.ranking = ranking;

  if (catalog) {
    analise.catalogo = {
      ...catalog,
      lowestPrice: Number.isFinite(catalog.lowestPrice) ? catalog.lowestPrice : null,
    };
  } else if (item.catalog_listing) {
    analise.catalogo = { catalogProductId: item.catalog_product_id || null, competitorCount: null };
  }

  if (seller) {
    const reputacao = seller.seller_reputation || {};
    const transacoes = reputacao.transactions || {};
    analise.vendedor = {
      id: seller.id,
      nick: seller.nickname || analise.vendedor?.nick || null,
      nivel: REPUTACAO_LABEL[reputacao.level_id] || reputacao.level_id || null,
      nivelId: reputacao.level_id || null,
      status: reputacao.power_seller_status || null,
      positivo: transacoes.ratings?.positive != null ? transacoes.ratings.positive * 100 : null,
      negativo: transacoes.ratings?.negative != null ? transacoes.ratings.negative * 100 : null,
      totalTransacoes: transacoes.total ?? null,
      canceladas: transacoes.canceled ?? null,
      cidade: seller.address?.city || null,
      uf: seller.address?.state || null,
      desde: seller.registration_date || null,
      anunciosAtivos: typeof sellerListings === 'number' ? sellerListings : null,
    };
  }

  if (visits) {
    const serie = (visits.results || []).map((ponto) => ({
      data: ponto.date,
      total: ponto.total ?? 0,
    }));
    const total = visits.total_visits ?? serie.reduce((soma, ponto) => soma + ponto.total, 0);
    analise.visitas = { total, serie };
  }

  if (listingPrices) {
    analise.tarifas = extrairTarifasReais(listingPrices, item.listing_type_id);
  }

  if (reviews) {
    analise.avaliacoes = normalizarAvaliacoesMeli(reviews);
  }

  analise.descricao = description?.plain_text || null;
  analise.fonteDados.push('API Mercado Livre');
  return analise;
}

/**
 * Converte a resposta de `/sites/MLB/listing_prices` na tarifa efetiva
 * (percentual + parcela fixa) do tipo de anúncio em questão.
 */
function extrairTarifasReais(listingPrices, listingTypeId) {
  const lista = Array.isArray(listingPrices) ? listingPrices : [listingPrices];
  const escolhido =
    lista.find((entrada) => entrada.listing_type_id === listingTypeId) ||
    lista.find((entrada) => entrada.listing_type_id === 'gold_special') ||
    lista[0];
  if (!escolhido?.sale_fee_details) return null;

  const detalhes = escolhido.sale_fee_details;
  const percentual = Number(detalhes.percentage_fee);
  const fixo = Number(detalhes.fixed_fee) || 0;
  if (!Number.isFinite(percentual)) return null;

  return {
    percentual: percentual / 100,
    fixo,
    rotulo: TIPO_ANUNCIO_LABEL[escolhido.listing_type_id] || escolhido.listing_type_id,
    fonte: 'API',
  };
}

function normalizarAvaliacoesMeli(reviews) {
  const niveis = reviews.rating_levels || {};
  const distribuicao = [
    niveis.one_star || 0,
    niveis.two_star || 0,
    niveis.three_star || 0,
    niveis.four_star || 0,
    niveis.five_star || 0,
  ];
  const lista = (reviews.reviews || []).map((review) => ({
    nota: review.rate ?? null,
    titulo: review.title || null,
    texto: review.content || '',
    data: review.date_created || null,
    likes: review.likes ?? 0,
  }));

  return {
    media: reviews.rating_average ?? null,
    total: reviews.paging?.total ?? distribuicao.reduce((a, b) => a + b, 0),
    distribuicao,
    lista,
    termosNegativos: minerarTermos(lista.filter((r) => (r.nota ?? 5) <= 3)),
    termosPositivos: minerarTermos(lista.filter((r) => (r.nota ?? 0) >= 4)),
  };
}

/** Extrai os termos mais recorrentes de um conjunto de avaliações. */
function minerarTermos(reviews, limite = 8) {
  const contagem = new Map();
  for (const review of reviews) {
    const palavras = `${review.titulo || ''} ${review.texto || ''}`
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/);
    const vistas = new Set();
    for (const palavra of palavras) {
      if (palavra.length < 4 || STOPWORDS.has(palavra) || vistas.has(palavra)) continue;
      vistas.add(palavra);
      contagem.set(palavra, (contagem.get(palavra) || 0) + 1);
    }
  }
  return [...contagem.entries()]
    .filter(([, total]) => total > 1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limite)
    .map(([termo, total]) => ({ termo, total }));
}

// ==================================================================
//  SHOPEE — PONTE COM A API INTERNA
// ==================================================================

/**
 * As APIs da Shopee só respondem para requisições de mesma origem, com os
 * cookies de sessão. Existem dois caminhos, nesta ordem de preferência:
 *
 *   1. `shopee-bridge.js` (mundo MAIN) observa as chamadas que a própria
 *      página já faz e nos entrega a resposta — sem custo e sem anti-bot;
 *   2. `shopeeApi()` refaz a chamada daqui mesmo. Como o content script
 *      compartilha a origem da página, os cookies acompanham a requisição.
 *
 * Chamar do service worker (como fazia a v8.0) sempre volta `error 99999`.
 */
const shopeeCache = {
  itens: new Map(), // itemid -> item
  buscas: new Map(), // itemid -> item_basic vindo da busca
  lojas: new Map(), // shopid -> loja
  avaliacoes: new Map(), // itemid -> ratings
  pontePronta: false,
};

window.addEventListener('message', (evento) => {
  // Só aceita mensagens da própria página, emitidas pela nossa ponte.
  if (evento.source !== window || evento.origin !== window.location.origin) return;
  const payload = evento.data;
  if (!payload || payload.__analisadorPro !== 'shopee') return;

  try {
    absorverPayloadShopee(payload.tipo, payload.dados);
  } catch (erro) {
    console.warn('[Analisador Pro] Falha ao processar dados da ponte:', erro);
  }
});

function absorverPayloadShopee(tipo, dados) {
  if (tipo === 'pronto') {
    shopeeCache.pontePronta = true;
    return;
  }

  if (tipo === 'item') {
    const item = dados?.data?.item ?? dados?.data;
    if (item?.itemid) shopeeCache.itens.set(String(item.itemid), item);
    return;
  }

  if (tipo === 'busca') {
    const itens = dados?.items || dados?.data?.items || [];
    for (const entrada of itens) {
      const basico = entrada?.item_basic || entrada?.item || entrada;
      if (basico?.itemid) shopeeCache.buscas.set(String(basico.itemid), basico);
    }
    // A busca renderiza antes de a fila da extensão rodar: reprocessa os cards.
    if (itens.length) agendarReprocessoShopee();
    return;
  }

  if (tipo === 'loja') {
    const loja = dados?.data;
    if (loja) shopeeCache.lojas.set(String(loja.shopid ?? loja.shop_id ?? ''), loja);
    return;
  }

  if (tipo === 'avaliacoes') {
    const ratings = dados?.data;
    const primeiro = ratings?.ratings?.[0];
    if (primeiro?.itemid) shopeeCache.avaliacoes.set(String(primeiro.itemid), ratings);
  }
}

/**
 * Pede à ponte que reenvie o que capturou antes deste script existir.
 * Chamado ao iniciar e a cada troca de rota da SPA.
 */
function solicitarReplayShopee() {
  if (state.plataforma !== 'shopee') return;
  try {
    window.postMessage({ __analisadorPro: 'shopee-replay' }, window.location.origin);
  } catch {
    /* ignora */
  }
}

let timerReprocessoShopee = null;

function agendarReprocessoShopee() {
  if (timerReprocessoShopee) return;
  timerReprocessoShopee = setTimeout(() => {
    timerReprocessoShopee = null;
    if (state.plataforma === 'shopee' && ehPaginaBuscaShopee()) processarCardsShopee();
  }, 300);
  state.timers.push(timerReprocessoShopee);
}

/**
 * Chamada direta à API da Shopee a partir da página (mesma origem, com
 * cookies). Devolve `null` em qualquer falha — o chamador degrada para o DOM.
 */
async function shopeeApi(caminho) {
  try {
    const resposta = await fetch(`${window.location.origin}${caminho}`, {
      credentials: 'include',
      headers: {
        Accept: 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        'X-API-SOURCE': 'pc',
        'X-Shopee-Language': 'pt-BR',
      },
    });
    if (!resposta.ok) return null;
    const dados = await resposta.json();
    // A Shopee sinaliza recusa no corpo, com HTTP 200.
    if (dados?.error) return null;
    return dados;
  } catch {
    return null;
  }
}

// ==================================================================
//  SHOPEE — EXTRAÇÃO
// ==================================================================

function extrairIdsShopee(url = window.location.href) {
  const match = url.match(/-i\.(\d+)\.(\d+)/);
  if (match) return { shopId: match[1], itemId: match[2] };
  // Formato alternativo: /product/<shopid>/<itemid>
  const alternativo = url.match(/\/product\/(\d+)\/(\d+)/);
  return alternativo ? { shopId: alternativo[1], itemId: alternativo[2] } : null;
}

/** Valores monetários da Shopee vêm multiplicados por 100.000. */
function shopeeParaReais(valor) {
  return typeof valor === 'number' && valor > 0 ? valor / 100000 : null;
}

function extrairDadosDomShopee() {
  const analise = criarAnaliseVazia('shopee');
  const ids = extrairIdsShopee();
  analise.id = ids ? `${ids.shopId}.${ids.itemId}` : null;
  analise.tipoAnuncio = 'Shopee';

  for (const script of $$('script[type="application/ld+json"]')) {
    try {
      const dados = JSON.parse(script.textContent);
      const produtos = Array.isArray(dados) ? dados : [dados];
      for (const produto of produtos) {
        if (produto['@type'] !== 'Product') continue;
        analise.titulo = analise.titulo || produto.name;
        if (produto.offers?.price) analise.preco = analise.preco ?? parseFloat(produto.offers.price);
        if (produto.aggregateRating) {
          analise.avaliacoes = {
            media: parseFloat(produto.aggregateRating.ratingValue) || null,
            total: parseInt(produto.aggregateRating.reviewCount, 10) || 0,
            distribuicao: null,
            lista: [],
            termosNegativos: [],
            termosPositivos: [],
          };
        }
      }
    } catch {
      /* ignora */
    }
  }

  analise.titulo =
    analise.titulo || textOf('[data-sqe="name"]') || textOf('h1') || document.title.split('|')[0].trim();

  if (analise.preco == null) {
    // A Shopee separa o "R$" do número em nós distintos.
    const marcador = $$('span, div').find((node) => node.textContent.trim() === 'R$');
    if (marcador?.parentElement) analise.preco = parseNumeroBR(marcador.parentElement.textContent);
  }

  const corpo = document.body.textContent || '';
  const vendidos = corpo.match(/([\d.,]+\s*(?:mil)?)\s*vendidos?/i);
  if (vendidos) analise.vendasTotais = parseQuantidadeTexto(vendidos[1]);

  analise.freteGratis = /frete gr[áa]tis/i.test(corpo);
  analise.fonteDados.push('DOM');
  return analise;
}

const SHOPEE_CDN = 'https://down-br.img.susercontent.com/file/';

/**
 * Aplica o payload da API da Shopee sobre o modelo lido do DOM.
 *
 * Semântica das vendas na Shopee (é o dado que a wTool destaca):
 *   - `sold`             → unidades vendidas nos **últimos 30 dias**;
 *   - `historical_sold`  → total acumulado desde a criação do anúncio.
 * Ou seja, aqui as vendas de 30 dias não são estimadas: vêm da plataforma.
 */
function aplicarAnaliseApiShopee(analise, { item, loja, avaliacoes }) {
  if (item) {
    analise.titulo = item.name || analise.titulo;
    analise.id = item.itemid ? `${item.shopid}.${item.itemid}` : analise.id;
    analise.permalink = item.itemid ? `${window.location.origin}/product/${item.shopid}/${item.itemid}` : null;

    analise.preco = shopeeParaReais(item.price) ?? analise.preco;
    analise.precoMin = shopeeParaReais(item.price_min);
    analise.precoMax = shopeeParaReais(item.price_max);
    analise.precoOriginal = shopeeParaReais(item.price_before_discount);
    if (analise.precoOriginal && analise.preco && analise.precoOriginal > analise.preco) {
      analise.descontoPercent = ((analise.precoOriginal - analise.preco) / analise.precoOriginal) * 100;
    } else if (typeof item.raw_discount === 'number' && item.raw_discount > 0) {
      analise.descontoPercent = item.raw_discount;
    }

    analise.vendasTotais = item.historical_sold ?? item.sold ?? analise.vendasTotais;
    if (typeof item.sold === 'number') {
      analise.vendas30d = item.sold;
      analise.vendas30dFonte = 'plataforma';
      analise.vendasPorDia = item.sold / 30;
    }

    analise.estoque = item.stock ?? analise.estoque;
    analise.curtidas = item.liked_count ?? null;
    analise.dataCriacao = item.ctime ? new Date(item.ctime * 1000).toISOString() : analise.dataCriacao;
    analise.condicao = item.condition === 1 ? 'Novo' : item.condition === 2 ? 'Usado' : analise.condicao;
    analise.marca = item.brand || analise.marca;
    analise.freteGratis = Boolean(item.show_free_shipping) || analise.freteGratis;
    analise.localizacao = item.shop_location || null;

    if (Array.isArray(item.categories) && item.categories.length) {
      analise.categoria = {
        id: item.catid ?? null,
        nome: item.categories[item.categories.length - 1]?.display_name || null,
        caminho: item.categories.map((c) => c.display_name).filter(Boolean),
        totalItens: null,
      };
    }

    // Ficha técnica da Shopee (usada pelo diagnóstico de SEO).
    if (Array.isArray(item.attributes)) {
      analise.atributos = item.attributes.map((attr) => ({
        id: attr.id ?? attr.name,
        name: attr.name,
        value_name: attr.value || null,
      }));
      analise.ean = valorAtributo(analise.atributos, 'GTIN', 'EAN') || analise.ean;
    }

    // Variações: preço, estoque e vendas por modelo.
    if (Array.isArray(item.models) && item.models.length) {
      analise.variacoes = item.models.map((modelo) => ({
        nome: modelo.name,
        preco: shopeeParaReais(modelo.price),
        estoque: modelo.stock ?? null,
        vendas: modelo.sold ?? null,
      }));
    }

    analise.fotos = (item.images || []).map((hash) => `${SHOPEE_CDN}${hash}`);
    const video = item.video_info_list?.[0];
    analise.video = video?.default_format?.url || video?.video_url || null;
    analise.descricao = item.description || null;

    if (item.item_rating) {
      // rating_count[0] é o total; os índices 1..5 são as estrelas.
      const contagem = item.item_rating.rating_count || [];
      analise.avaliacoes = {
        media: item.item_rating.rating_star ?? null,
        total: contagem[0] ?? item.cmt_count ?? 0,
        distribuicao: contagem.length >= 6 ? contagem.slice(1, 6) : null,
        lista: [],
        termosNegativos: [],
        termosPositivos: [],
      };
    }
  }

  if (avaliacoes?.ratings?.length && analise.avaliacoes) {
    analise.avaliacoes.lista = avaliacoes.ratings.map((r) => ({
      nota: r.rating_star ?? null,
      titulo: null,
      texto: r.comment || '',
      data: r.ctime ? new Date(r.ctime * 1000).toISOString() : null,
      likes: r.like_count ?? 0,
    }));
    analise.avaliacoes.termosNegativos = minerarTermos(
      analise.avaliacoes.lista.filter((r) => (r.nota ?? 5) <= 3),
    );
    analise.avaliacoes.termosPositivos = minerarTermos(
      analise.avaliacoes.lista.filter((r) => (r.nota ?? 0) >= 4),
    );
  }

  if (loja) {
    const bons = loja.rating_good ?? 0;
    const ruins = loja.rating_bad ?? 0;
    const normais = loja.rating_normal ?? 0;
    const totalAvaliacoes = bons + ruins + normais;

    analise.vendedor = {
      id: loja.shopid ?? null,
      nick: loja.account?.username || loja.name || analise.vendedor?.nick || null,
      nome: loja.name || null,
      seguidores: loja.follower_count ?? null,
      anunciosAtivos: loja.item_count ?? null,
      cidade: loja.shop_location || loja.place || analise.localizacao || null,
      positivo: totalAvaliacoes > 0 ? (bons / totalAvaliacoes) * 100 : null,
      notaLoja: loja.rating_star ?? null,
      taxaResposta: loja.response_rate ?? null,
      tempoResposta: loja.response_time ?? null,
      taxaCancelamento: loja.shop_performance?.cancellation_rate ?? null,
      oficial: Boolean(loja.is_official_shop),
      verificada: Boolean(loja.shopee_verified),
      desde: loja.ctime ? new Date(loja.ctime * 1000).toISOString() : null,
    };
  }

  if (item || loja) analise.fonteDados.push('API Shopee');
  return analise;
}

// ==================================================================
//  MÉTRICAS DERIVADAS
// ==================================================================

/**
 * Consolida vendas medidas (snapshots) e estimadas (vendas totais ÷ idade),
 * faturamento e cobertura de estoque.
 */
async function calcularMetricasDerivadas(analise) {
  analise.idadeDias = diasEntre(analise.dataCriacao);

  if (analise.vendas30d != null) {
    // A plataforma já informou as vendas do período (caso da Shopee): esse
    // número é melhor que qualquer média de vida inteira, então manda nele.
    if (analise.vendasPorDia == null) analise.vendasPorDia = analise.vendas30d / 30;
  } else if (analise.vendasTotais != null && analise.idadeDias) {
    analise.vendasPorDia = analise.vendasTotais / analise.idadeDias;
    analise.vendas30d = Math.round(analise.vendasPorDia * 30);
    analise.vendas30dFonte = 'estimado';
  }

  // Histórico local: se temos duas medições distantes no tempo, a diferença
  // é a venda REAL do período — muito mais confiável que a média da vida toda.
  if (analise.id != null && analise.vendasTotais != null) {
    const resposta = await send({
      type: 'saveSnapshot',
      data: { productId: String(analise.id), vendas: analise.vendasTotais },
    });
    const historico = resposta.success ? resposta.history || [] : [];

    // Exige uma janela mínima de 3 dias: com 1 dia de histórico o número
    // oscila demais e passaria uma falsa precisão.
    if (historico.length >= 2) {
      const primeiro = historico[0];
      const ultimo = historico[historico.length - 1];
      const dias = diasEntre(primeiro.date, new Date(ultimo.date).getTime()) || 0;
      const delta = ultimo.vendas - primeiro.vendas;
      if (delta >= 0 && dias >= 3) {
        analise.diasRastreados = dias;
        analise.vendasPorDia = delta / dias;
        analise.vendas30d = Math.round((delta / dias) * 30);
        analise.vendas30dFonte = 'medido';
        analise.fonteDados.push('histórico local');
      }
    }
    analise.historicoVendas = historico;
  }

  if (analise.preco != null) {
    if (analise.vendasTotais != null) analise.faturamentoTotal = analise.preco * analise.vendasTotais;
    if (analise.vendas30d != null) analise.faturamento30d = analise.preco * analise.vendas30d;
  }

  if (analise.estoque != null && analise.vendasPorDia > 0) {
    analise.coberturaEstoqueDias = Math.round(analise.estoque / analise.vendasPorDia);
  }

  if (analise.visitas?.total && analise.vendas30d != null && analise.visitas.total > 0) {
    analise.visitas.conversao = (analise.vendas30d / analise.visitas.total) * 100;
  }

  analise.seo = analisarSeo(analise);
  return analise;
}

// ==================================================================
//  SEO & FICHA TÉCNICA
// ==================================================================

const LIMITE_TITULO_ML = 60;

function analisarSeo(analise) {
  const titulo = analise.titulo || '';
  const palavras = titulo
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((palavra) => palavra.length >= 3 && !STOPWORDS.has(palavra));

  const preenchidos = analise.atributos.filter((attr) => attr.value_name).length;
  const total = analise.atributos.length;
  const faltando = analise.atributos
    .filter((attr) => !attr.value_name)
    .map((attr) => attr.name)
    .filter(Boolean)
    .slice(0, 12);

  const alertas = [];
  if (analise.plataforma === 'meli') {
    if (titulo.length > LIMITE_TITULO_ML) {
      alertas.push(`Título com ${titulo.length} caracteres (limite ${LIMITE_TITULO_ML}).`);
    } else if (titulo.length < LIMITE_TITULO_ML - 12) {
      alertas.push(`Título com ${titulo.length}/${LIMITE_TITULO_ML} caracteres — há espaço para mais palavras-chave.`);
    }
    if (analise.saudeFicha != null && analise.saudeFicha < 0.8) {
      alertas.push(`Qualidade da ficha em ${Math.round(analise.saudeFicha * 100)}% — completar atributos melhora o ranqueamento.`);
    }
    if (!analise.ean || /não|nao|n\/a/i.test(analise.ean)) {
      alertas.push('Sem EAN/GTIN cadastrado — perde elegibilidade a catálogo.');
    }
    if (analise.fotos.length < 5) {
      alertas.push(`Apenas ${analise.fotos.length} foto(s) — anúncios com 6+ imagens convertem melhor.`);
    }
    if (!analise.video) alertas.push('Sem vídeo no anúncio.');
  }

  return {
    titulo,
    tamanhoTitulo: titulo.length,
    limiteTitulo: analise.plataforma === 'meli' ? LIMITE_TITULO_ML : null,
    palavras: [...new Set(palavras)],
    atributosPreenchidos: preenchidos,
    atributosTotal: total,
    atributosFaltando: faltando,
    alertas,
  };
}

// ==================================================================
//  CALCULADORA
// ==================================================================

/** Tarifa efetiva do marketplace para um dado preço. */
function tarifaMarketplace(preco, analise) {
  if (analise.plataforma === 'shopee') {
    const taxas = state.taxasShopee || TAXAS_SHOPEE;
    return { percentual: taxas.comissao, fixo: taxas.taxaFixa, valor: preco * taxas.comissao + taxas.taxaFixa };
  }

  // Tarifa oficial da categoria, quando o service worker conseguiu buscá-la.
  if (analise.tarifas?.percentual != null) {
    const taxas = state.taxasMl || TAXAS_MERCADO_LIVRE;
    // A parcela fixa do ML só incide abaixo do limite configurado.
    const fixo = preco < taxas.limiteCustoFixo ? analise.tarifas.fixo : 0;
    return {
      percentual: analise.tarifas.percentual,
      fixo,
      valor: preco * analise.tarifas.percentual + fixo,
    };
  }

  const taxas = state.taxasMl || TAXAS_MERCADO_LIVRE;
  const chave = analise.tipoAnuncio === 'Premium' ? 'Premium' : 'Classico';
  const percentual = taxas.taxasPorAnuncio[chave];
  const fixo = preco < taxas.limiteCustoFixo ? taxas.custoFixo : 0;
  return { percentual, fixo, valor: preco * percentual + fixo };
}

function calcularResultado(preco, custoProduto, custoFrete, analise) {
  const custos = state.custosGlobais || CUSTOS_GLOBAIS_PADRAO;
  const tarifa = tarifaMarketplace(preco, analise);
  const imposto = preco * (custos.imposto / 100);
  const extras = imposto + custos.custoFixo;

  const valorRecebido = preco - tarifa.valor - custoFrete;
  const lucro = valorRecebido - custoProduto - extras;
  const margem = preco > 0 ? (lucro / preco) * 100 : 0;
  const roi = custoProduto > 0 ? (lucro / custoProduto) * 100 : 0;
  const markup = custoProduto > 0 ? preco / custoProduto : null;

  return { preco, tarifa, imposto, extras, valorRecebido, lucro, margem, roi, markup };
}

/**
 * Preço mínimo para lucro zero. Resolve P nas duas hipóteses de taxa fixa
 * (acima e abaixo do limite) e devolve a solução consistente.
 */
function calcularPontoEquilibrio(custoProduto, custoFrete, analise) {
  const custos = state.custosGlobais || CUSTOS_GLOBAIS_PADRAO;
  const taxasMl = state.taxasMl || TAXAS_MERCADO_LIVRE;
  const impostoFrac = custos.imposto / 100;

  const percentual =
    analise.plataforma === 'shopee'
      ? (state.taxasShopee || TAXAS_SHOPEE).comissao
      : analise.tarifas?.percentual ??
        taxasMl.taxasPorAnuncio[analise.tipoAnuncio === 'Premium' ? 'Premium' : 'Classico'];

  const fixoBase =
    analise.plataforma === 'shopee'
      ? (state.taxasShopee || TAXAS_SHOPEE).taxaFixa
      : analise.tarifas?.fixo ?? taxasMl.custoFixo;

  const denominador = 1 - percentual - impostoFrac;
  if (denominador <= 0) return null;

  const resolver = (fixo) => (custoProduto + custoFrete + fixo + custos.custoFixo) / denominador;

  const comFixo = resolver(fixoBase);
  if (analise.plataforma === 'shopee') return comFixo;
  if (comFixo < taxasMl.limiteCustoFixo) return comFixo;

  const semFixo = resolver(0);
  return semFixo >= taxasMl.limiteCustoFixo ? semFixo : taxasMl.limiteCustoFixo;
}

// ==================================================================
//  HUD — CONSTRUÇÃO
// ==================================================================

function chip(texto, tom = 'neutro', titulo = '') {
  return el('span', { className: `hud-chip hud-chip--${tom}`, text: texto, title: titulo });
}

function linha(rotulo, valor, opcoes = {}) {
  const valorNode =
    valor instanceof Node
      ? valor
      : el('span', {
          className: `hud-data-value${opcoes.moeda ? ' hud-currency' : ''}`,
          text: valor,
          style: opcoes.cor ? { color: opcoes.cor } : null,
        });

  return el('div', { className: 'hud-data-row', title: opcoes.dica || '' }, [
    el('span', { className: 'hud-data-label', text: rotulo }),
    valorNode,
  ]);
}

function kpi(rotulo, valor, tom = 'neutro', dica = '') {
  return el('div', { className: 'hud-kpi', title: dica }, [
    el('span', { className: 'hud-kpi-label', text: rotulo }),
    el('span', { className: `hud-kpi-value hud-kpi-value--${tom}`, text: valor }),
  ]);
}

function secao(id, titulo, corpo, { colapsada = false } = {}) {
  const conteudo = el('div', { className: 'hud-section-body', id: `${id}Body` }, corpo);
  const cabecalho = el('div', { className: 'hud-section-header' }, [
    el('span', { className: 'hud-section-title', text: titulo }),
    el('span', { className: 'hud-section-arrow', text: '▼' }),
  ]);
  const wrapper = el('div', { className: `hud-section${colapsada ? ' collapsed' : ''}`, id }, [
    cabecalho,
    conteudo,
  ]);
  cabecalho.addEventListener('click', () => wrapper.classList.toggle('collapsed'));
  return wrapper;
}

function tomPorFaixa(valor, bom, medio) {
  if (valor == null || !Number.isFinite(valor)) return 'neutro';
  if (valor >= bom) return 'bom';
  if (valor >= medio) return 'medio';
  return 'ruim';
}

// --- Seções -------------------------------------------------------

function secaoResumo(a) {
  const grid = el('div', { className: 'hud-kpi-grid' }, [
    kpi(
      a.vendas30dFonte === 'medido' ? `Vendas 30d (medido ${a.diasRastreados}d)` : 'Vendas 30d (est.)',
      fmtNumero(a.vendas30d),
      tomPorFaixa(a.vendas30d, 30, 10),
      a.vendas30dFonte === 'medido'
        ? 'Diferença real entre duas medições salvas pela extensão.'
        : 'Estimativa: vendas totais ÷ idade do anúncio × 30.',
    ),
    kpi('Faturamento 30d', fmtMoeda(a.faturamento30d), 'destaque'),
    kpi('Vendas/dia', fmtDecimal(a.vendasPorDia, 2), tomPorFaixa(a.vendasPorDia, 1, 0.3)),
    kpi('Preço', fmtMoeda(a.preco), 'destaque'),
    a.visitas ? kpi('Visitas 30d', fmtNumero(a.visitas.total), 'neutro') : null,
    a.visitas?.conversao != null
      ? kpi('Conversão', fmtPercent(a.visitas.conversao, 2), tomPorFaixa(a.visitas.conversao, 3, 1))
      : null,
    a.estoque != null ? kpi('Estoque', fmtNumero(a.estoque), 'neutro') : null,
    a.coberturaEstoqueDias != null
      ? kpi('Cobertura', `${fmtNumero(a.coberturaEstoqueDias)} d`, tomPorFaixa(a.coberturaEstoqueDias, 30, 10))
      : null,
    a.avaliacoes?.media != null
      ? kpi('Nota', `${fmtDecimal(a.avaliacoes.media, 2)} ★`, tomPorFaixa(a.avaliacoes.media, 4.5, 4))
      : null,
    a.curtidas != null ? kpi('Curtidas', fmtNumero(a.curtidas), 'neutro') : null,
  ].filter(Boolean));

  const tags = el('div', { className: 'hud-chip-row' }, [
    a.tipoAnuncio ? chip(a.tipoAnuncio, a.tipoAnuncio === 'Premium' ? 'destaque' : 'info') : null,
    a.logistica ? chip(a.logistica, a.logistica === 'Full' ? 'bom' : 'info') : null,
    a.freteGratis ? chip('Frete grátis', 'bom') : null,
    a.condicao ? chip(a.condicao, 'neutro') : null,
    a.descontoPercent ? chip(`-${fmtDecimal(a.descontoPercent, 0)}%`, 'alerta') : null,
    a.catalogo ? chip(a.catalogo.isWinner ? 'Ganhando catálogo' : 'Catálogo', a.catalogo.isWinner ? 'bom' : 'alerta') : null,
    a.ranking?.position ? chip(`#${a.ranking.position} na categoria`, 'destaque') : null,
  ].filter(Boolean));

  return [grid, tags.childNodes.length ? tags : null].filter(Boolean);
}

function secaoProduto(a) {
  return [
    linha('Título', el('span', { className: 'hud-data-value hud-wrap', text: a.titulo || '—' })),
    linha('ID', a.id || '—'),
    linha('EAN / GTIN', a.ean || 'Não informado'),
    a.marca ? linha('Marca', a.marca) : null,
    a.modelo ? linha('Modelo', a.modelo) : null,
    a.condicao ? linha('Condição', a.condicao) : null,
    a.garantia ? linha('Garantia', el('span', { className: 'hud-data-value hud-wrap', text: a.garantia })) : null,
    a.categoria
      ? linha('Categoria', el('span', { className: 'hud-data-value hud-wrap', text: a.categoria.caminho.join(' › ') || a.categoria.nome }))
      : null,
    a.categoria?.totalItens != null ? linha('Anúncios na categoria', fmtNumero(a.categoria.totalItens)) : null,
    a.saudeFicha != null
      ? linha('Qualidade da ficha', barraProgresso(a.saudeFicha * 100, tomPorFaixa(a.saudeFicha * 100, 80, 50)))
      : null,
    a.catalogo?.competitorCount != null
      ? linha('Concorrentes no catálogo', fmtNumero(a.catalogo.competitorCount))
      : null,
    a.catalogo?.winnerPrice != null ? linha('Preço vencedor do catálogo', fmtMoeda(a.catalogo.winnerPrice), { moeda: true }) : null,
  ].filter(Boolean);
}

function barraProgresso(percentual, tom = 'neutro') {
  const valor = Math.max(0, Math.min(100, percentual || 0));
  const preenchida = el('div', { className: `hud-progress-fill hud-progress-fill--${tom}` });
  preenchida.style.width = `${valor}%`;
  return el('div', { className: 'hud-progress-wrap' }, [
    el('div', { className: 'hud-progress' }, [preenchida]),
    el('span', { className: 'hud-progress-label', text: `${Math.round(valor)}%` }),
  ]);
}

function secaoVendas(a) {
  const fonteVendas =
    a.vendas30dFonte === 'medido'
      ? `Medido pela extensão em ${a.diasRastreados} dia(s)`
      : a.vendas30dFonte === 'plataforma'
        ? 'Informado pela Shopee (campo "sold" = últimos 30 dias)'
        : 'Estimado pela média histórica (vendas totais ÷ idade)';

  return [
    linha('Vendas totais', fmtNumero(a.vendasTotais)),
    linha('Vendas 30 dias', fmtNumero(a.vendas30d), { dica: fonteVendas }),
    linha('Origem do dado', el('span', { className: 'hud-data-value hud-muted', text: fonteVendas })),
    linha('Vendas por dia', fmtDecimal(a.vendasPorDia, 2)),
    linha('Faturamento total', fmtMoeda(a.faturamentoTotal), { moeda: true }),
    linha('Faturamento 30d', fmtMoeda(a.faturamento30d), { moeda: true }),
    a.estoque != null ? linha('Estoque disponível', fmtNumero(a.estoque)) : null,
    a.coberturaEstoqueDias != null
      ? linha('Cobertura de estoque', `${fmtNumero(a.coberturaEstoqueDias)} dias`, {
          dica: 'Estoque atual ÷ vendas por dia.',
        })
      : null,
    a.ranking?.position
      ? linha('Ranking na categoria', `#${a.ranking.position} de ${fmtNumero(a.ranking.total)}`)
      : null,
    a.historicoVendas?.length ? linha('Histórico local', `${a.historicoVendas.length} medição(ões)`) : null,
  ].filter(Boolean);
}

function secaoAnuncio(a) {
  return [
    linha('Tipo de anúncio', a.tipoAnuncio || '—'),
    linha('Criado em', fmtData(a.dataCriacao)),
    linha('Idade', fmtIdade(a.idadeDias)),
    a.ultimaAtualizacao ? linha('Última atualização', fmtData(a.ultimaAtualizacao)) : null,
    linha('Logística', a.logistica || '—'),
    linha('Frete grátis', a.freteGratis == null ? '—' : a.freteGratis ? 'Sim' : 'Não'),
    a.precoOriginal ? linha('Preço original', fmtMoeda(a.precoOriginal)) : null,
    a.descontoPercent ? linha('Desconto', fmtPercent(a.descontoPercent, 0)) : null,
    a.precoMin != null && a.precoMax != null && a.precoMin !== a.precoMax
      ? linha('Faixa de preço', `${fmtMoeda(a.precoMin)} — ${fmtMoeda(a.precoMax)}`, {
          dica: 'O anúncio tem variações com preços diferentes.',
        })
      : null,
    a.localizacao ? linha('Origem do envio', a.localizacao) : null,
    a.curtidas != null ? linha('Curtidas', fmtNumero(a.curtidas)) : null,
    a.permalink
      ? el('div', { className: 'hud-data-row' }, [
          el('span', { className: 'hud-data-label', text: 'Link' }),
          el('a', {
            className: 'hud-link',
            text: 'abrir anúncio',
            attrs: { href: a.permalink, target: '_blank', rel: 'noopener noreferrer' },
          }),
        ])
      : null,
  ].filter(Boolean);
}

function secaoVendedor(a) {
  const v = a.vendedor;
  if (!v) return [el('div', { className: 'hud-empty', text: 'Dados do vendedor indisponíveis.' })];

  const selos = [
    v.oficial ? chip('Loja oficial', 'destaque') : null,
    v.verificada ? chip('Verificada', 'bom') : null,
  ].filter(Boolean);

  return [
    linha('Vendedor', v.nome || v.nick || '—'),
    v.nick && v.nome && v.nick !== v.nome ? linha('Usuário', v.nick) : null,
    selos.length ? el('div', { className: 'hud-chip-row' }, selos) : null,
    v.nivel ? linha('Reputação', chipReputacao(v)) : null,
    v.status ? linha('Status', v.status === 'platinum' ? 'MercadoLíder Platinum' : v.status === 'gold' ? 'MercadoLíder Gold' : 'MercadoLíder') : null,
    v.notaLoja != null ? linha('Nota da loja', `${fmtDecimal(v.notaLoja, 2)} ★`, {
      cor: v.notaLoja >= 4.8 ? 'var(--hud-accent-green)' : v.notaLoja >= 4.5 ? 'var(--hud-accent-amber)' : 'var(--hud-accent-red)',
    }) : null,
    v.positivo != null ? linha('Avaliações positivas', fmtPercent(v.positivo, 0), { cor: v.positivo >= 95 ? 'var(--hud-accent-green)' : 'var(--hud-accent-amber)' }) : null,
    v.totalTransacoes != null ? linha('Transações', fmtNumero(v.totalTransacoes)) : null,
    v.canceladas != null ? linha('Canceladas', fmtNumero(v.canceladas)) : null,
    v.taxaCancelamento != null ? linha('Taxa de cancelamento', fmtPercent(v.taxaCancelamento * 100, 1)) : null,
    v.anunciosAtivos != null ? linha('Anúncios ativos', fmtNumero(v.anunciosAtivos)) : null,
    v.seguidores != null ? linha('Seguidores', fmtNumero(v.seguidores)) : null,
    v.taxaResposta != null ? linha('Taxa de resposta', fmtPercent(v.taxaResposta, 0)) : null,
    v.tempoResposta != null ? linha('Tempo de resposta', formatarTempoResposta(v.tempoResposta)) : null,
    v.cidade ? linha('Localização', [v.cidade, v.uf].filter(Boolean).join(' / ')) : null,
    v.desde ? linha('Vendedor desde', fmtData(v.desde)) : null,
  ].filter(Boolean);
}

/** A Shopee informa o tempo de resposta em segundos. */
function formatarTempoResposta(segundos) {
  if (typeof segundos !== 'number' || segundos <= 0) return '—';
  if (segundos < 3600) return `${Math.round(segundos / 60)} min`;
  if (segundos < 86400) return `${Math.round(segundos / 3600)} h`;
  return `${Math.round(segundos / 86400)} dias`;
}

/** Variações (modelos) da Shopee: mostra onde o estoque e as vendas estão. */
function secaoVariacoes(a) {
  if (!a.variacoes?.length) return null;

  const corpo = el('tbody');
  const ordenadas = [...a.variacoes].sort((x, y) => (y.vendas ?? 0) - (x.vendas ?? 0));

  for (const variacao of ordenadas.slice(0, 20)) {
    corpo.appendChild(
      el('tr', {}, [
        el('td', { text: variacao.nome || '—', title: variacao.nome || '' }),
        el('td', { text: fmtMoeda(variacao.preco) }),
        el('td', { text: fmtNumero(variacao.estoque) }),
        el('td', {
          text: fmtNumero(variacao.vendas),
          style: { color: variacao.vendas > 0 ? 'var(--hud-accent-green)' : 'var(--hud-text-muted)' },
        }),
      ]),
    );
  }

  const semEstoque = a.variacoes.filter((v) => (v.estoque ?? 0) === 0).length;

  return [
    linha('Variações', fmtNumero(a.variacoes.length)),
    semEstoque ? linha('Sem estoque', `${semEstoque} variação(ões)`, { cor: 'var(--hud-accent-amber)' }) : null,
    el('table', { className: 'hud-matrix-table hud-tabela-variacoes' }, [
      el('thead', {}, [
        el('tr', {}, [
          el('th', { text: 'Variação' }),
          el('th', { text: 'Preço' }),
          el('th', { text: 'Estoque' }),
          el('th', { text: 'Vendas' }),
        ]),
      ]),
      corpo,
    ]),
  ].filter(Boolean);
}

function chipReputacao(vendedor) {
  const cores = {
    '5_green': 'bom',
    '4_light_green': 'bom',
    '3_yellow': 'alerta',
    '2_orange': 'alerta',
    '1_red': 'ruim',
  };
  return chip(vendedor.nivel, cores[vendedor.nivelId] || 'neutro');
}

function secaoVisitas(a) {
  if (!a.visitas) return null;
  const serie = a.visitas.serie || [];
  const conteudo = [
    linha('Visitas (30 dias)', fmtNumero(a.visitas.total)),
    a.visitas.conversao != null
      ? linha('Taxa de conversão', fmtPercent(a.visitas.conversao, 2), {
          dica: 'Vendas 30d ÷ visitas 30d.',
        })
      : null,
    serie.length ? sparkline(serie.map((ponto) => ponto.total)) : null,
  ].filter(Boolean);
  return conteudo;
}

/** Mini gráfico de linha em SVG (sem dependências externas). */
function sparkline(valores, largura = 300, altura = 48) {
  if (!valores.length) return null;
  const max = Math.max(...valores, 1);
  const passo = valores.length > 1 ? largura / (valores.length - 1) : largura;

  const pontos = valores
    .map((valor, indice) => `${(indice * passo).toFixed(1)},${(altura - (valor / max) * (altura - 6) - 3).toFixed(1)}`)
    .join(' ');

  const svg = svgEl('svg', {
    class: 'hud-sparkline',
    viewBox: `0 0 ${largura} ${altura}`,
    preserveAspectRatio: 'none',
    role: 'img',
    'aria-label': `Série de visitas: pico de ${max}`,
  });
  svg.appendChild(
    svgEl('polyline', { points: pontos, fill: 'none', stroke: 'var(--hud-accent-green)', 'stroke-width': '2' }),
  );
  svg.appendChild(
    svgEl('polygon', {
      points: `0,${altura} ${pontos} ${largura},${altura}`,
      fill: 'rgba(0,255,136,0.12)',
      stroke: 'none',
    }),
  );
  return el('div', { className: 'hud-sparkline-wrap' }, [svg, el('span', { className: 'hud-muted', text: `pico: ${fmtNumero(max)}/dia` })]);
}

function secaoAvaliacoes(a) {
  const av = a.avaliacoes;
  if (!av || (!av.total && !av.lista?.length)) {
    return [el('div', { className: 'hud-empty', text: 'Sem avaliações disponíveis para este anúncio.' })];
  }

  const nodes = [
    linha('Nota média', av.media != null ? `${fmtDecimal(av.media, 2)} ★` : '—', {
      cor: av.media >= 4.5 ? 'var(--hud-accent-green)' : av.media >= 4 ? 'var(--hud-accent-amber)' : 'var(--hud-accent-red)',
    }),
    linha('Total de avaliações', fmtNumero(av.total)),
  ];

  if (av.distribuicao) {
    const totalDist = av.distribuicao.reduce((soma, valor) => soma + valor, 0) || 1;
    const barras = av.distribuicao
      .map((quantidade, indice) => {
        const estrelas = indice + 1;
        const percentual = (quantidade / totalDist) * 100;
        const preenchida = el('div', {
          className: `hud-progress-fill hud-progress-fill--${estrelas >= 4 ? 'bom' : estrelas === 3 ? 'medio' : 'ruim'}`,
        });
        preenchida.style.width = `${percentual}%`;
        return el('div', { className: 'hud-rating-row' }, [
          el('span', { className: 'hud-rating-star', text: `${estrelas}★` }),
          el('div', { className: 'hud-progress' }, [preenchida]),
          el('span', { className: 'hud-rating-count', text: fmtNumero(quantidade) }),
        ]);
      })
      .reverse();
    nodes.push(el('div', { className: 'hud-rating-dist' }, barras));
  }

  if (av.termosNegativos?.length) {
    nodes.push(
      el('div', { className: 'hud-subtitle', text: '⚠ Dores mais citadas (notas ≤ 3)' }),
      el(
        'div',
        { className: 'hud-chip-row' },
        av.termosNegativos.map((t) => chip(`${t.termo} (${t.total})`, 'ruim')),
      ),
    );
  }

  if (av.termosPositivos?.length) {
    nodes.push(
      el('div', { className: 'hud-subtitle', text: '★ Elogios mais citados (notas ≥ 4)' }),
      el(
        'div',
        { className: 'hud-chip-row' },
        av.termosPositivos.map((t) => chip(`${t.termo} (${t.total})`, 'bom')),
      ),
    );
  }

  const amostra = (av.lista || []).slice(0, 6);
  if (amostra.length) {
    nodes.push(el('div', { className: 'hud-subtitle', text: '💬 Comentários recentes' }));
    nodes.push(
      el(
        'div',
        { className: 'hud-review-list' },
        amostra.map((review) =>
          el('div', { className: 'hud-review' }, [
            el('div', { className: 'hud-review-head' }, [
              el('span', {
                className: 'hud-review-stars',
                text: '★'.repeat(Math.round(review.nota || 0)).padEnd(5, '☆'),
              }),
              el('span', { className: 'hud-muted', text: fmtData(review.data) }),
            ]),
            el('div', { className: 'hud-review-text', text: review.texto || review.titulo || '(sem texto)' }),
          ]),
        ),
      ),
    );
    nodes.push(
      el('button', {
        className: 'hud-inline-btn',
        text: '📋 Copiar todas as avaliações',
        on: { click: () => copiarAvaliacoes(av) },
      }),
    );
  }

  return nodes;
}

function secaoSeo(a) {
  const seo = a.seo;
  if (!seo) return null;

  const nodes = [
    linha('Tamanho do título', seo.limiteTitulo ? `${seo.tamanhoTitulo}/${seo.limiteTitulo}` : String(seo.tamanhoTitulo), {
      cor:
        seo.limiteTitulo && seo.tamanhoTitulo > seo.limiteTitulo
          ? 'var(--hud-accent-red)'
          : 'var(--hud-accent-green)',
    }),
  ];

  if (seo.atributosTotal) {
    nodes.push(
      linha(
        'Ficha técnica',
        `${seo.atributosPreenchidos}/${seo.atributosTotal} atributos`,
        { cor: seo.atributosPreenchidos / seo.atributosTotal >= 0.8 ? 'var(--hud-accent-green)' : 'var(--hud-accent-amber)' },
      ),
    );
  }

  if (seo.palavras.length) {
    nodes.push(el('div', { className: 'hud-subtitle', text: '🔑 Palavras-chave do título' }));
    nodes.push(
      el(
        'div',
        { className: 'hud-chip-row' },
        seo.palavras.map((palavra) => {
          const node = chip(palavra, 'info', 'Clique para pesquisar este termo');
          node.classList.add('hud-chip--clicavel');
          node.addEventListener('click', () => {
            const busca =
              a.plataforma === 'shopee'
                ? `https://shopee.com.br/search?keyword=${encodeURIComponent(palavra)}`
                : `https://lista.mercadolivre.com.br/${encodeURIComponent(palavra)}`;
            window.open(busca, '_blank', 'noopener');
          });
          return node;
        }),
      ),
    );
  }

  if (seo.atributosFaltando.length) {
    nodes.push(el('div', { className: 'hud-subtitle', text: '➖ Atributos não preenchidos' }));
    nodes.push(
      el(
        'div',
        { className: 'hud-chip-row' },
        seo.atributosFaltando.map((nome) => chip(nome, 'alerta')),
      ),
    );
  }

  if (seo.alertas.length) {
    nodes.push(el('div', { className: 'hud-subtitle', text: '🩺 Diagnóstico' }));
    nodes.push(
      el(
        'ul',
        { className: 'hud-list' },
        seo.alertas.map((alerta) => el('li', { text: alerta })),
      ),
    );
  }

  nodes.push(
    el('div', { className: 'hud-btn-row' }, [
      el('button', {
        className: 'hud-inline-btn',
        text: '📋 Copiar título',
        on: { click: () => copiarTexto(a.titulo || '', 'Título copiado!') },
      }),
      el('button', {
        className: 'hud-inline-btn',
        text: '📋 Copiar palavras-chave',
        on: { click: () => copiarTexto(seo.palavras.join(', '), 'Palavras-chave copiadas!') },
      }),
      el('button', {
        className: 'hud-inline-btn',
        text: '📋 Copiar ficha técnica',
        on: { click: () => copiarFichaTecnica(a) },
      }),
    ]),
  );

  return nodes;
}

function secaoMidias(a) {
  const nodes = [
    linha('Fotos', fmtNumero(a.fotos.length)),
    linha('Vídeo', a.video ? 'Sim' : 'Não'),
  ];

  if (a.fotos.length) {
    nodes.push(
      el(
        'div',
        { className: 'hud-thumbs' },
        a.fotos.slice(0, 8).map((url) =>
          el('img', {
            className: 'hud-thumb',
            attrs: { src: url, alt: 'Foto do anúncio', loading: 'lazy' },
          }),
        ),
      ),
    );
  }

  nodes.push(
    el('div', { className: 'hud-btn-row' }, [
      el('button', {
        className: 'hud-inline-btn',
        text: '📥 Baixar todas as fotos',
        on: { click: baixarMidias },
      }),
      a.video
        ? el('a', {
            className: 'hud-inline-btn',
            text: '▶ Abrir vídeo',
            attrs: { href: a.video, target: '_blank', rel: 'noopener noreferrer' },
          })
        : null,
    ].filter(Boolean)),
  );

  return nodes;
}

function secaoCalculadora(a) {
  const inputCusto = el('input', {
    id: 'custoProduto',
    attrs: { type: 'number', step: '0.01', min: '0', placeholder: 'R$ 0,00' },
  });
  const inputFrete = el('input', {
    id: 'custoFrete',
    attrs: { type: 'number', step: '0.01', min: '0', placeholder: 'R$ 0,00' },
  });

  inputCusto.addEventListener('input', recalcularCalculadora);
  inputFrete.addEventListener('input', recalcularCalculadora);

  const origemTarifa = a.tarifas?.fonte === 'API'
    ? `Comissão oficial da categoria: ${fmtPercent(a.tarifas.percentual * 100, 1)}${a.tarifas.fixo ? ` + ${fmtMoeda(a.tarifas.fixo)}` : ''}`
    : 'Usando as taxas configuradas no popup (a API de tarifas não respondeu).';

  const resultado = el('div', { className: 'hud-results', id: 'calcResultados' });
  const matriz = el('div', { className: 'hud-matrix', id: 'calcMatriz' });

  return [
    el('div', { className: 'hud-note', text: origemTarifa }),
    el('div', { className: 'hud-calc-inputs' }, [
      el('div', { className: 'hud-input-group' }, [
        el('label', { text: 'Custo do produto', attrs: { for: 'custoProduto' } }),
        inputCusto,
      ]),
      el('div', { className: 'hud-input-group' }, [
        el('label', { text: 'Custo do frete', attrs: { for: 'custoFrete' } }),
        inputFrete,
      ]),
    ]),
    resultado,
    matriz,
  ];
}

// ==================================================================
//  HUD — RENDERIZAÇÃO PRINCIPAL
// ==================================================================

function removerPainel() {
  document.getElementById(PANEL_ID)?.remove();
}

function exibirPainelCarregando() {
  removerPainel();
  const painel = montarEsqueletoPainel('📊 ANÁLISE PRO');
  painel.conteudo.appendChild(
    el('div', { className: 'hud-loading' }, [
      el('div', { className: 'hud-spinner' }),
      el('span', { text: 'Coletando dados do anúncio…' }),
    ]),
  );
  document.body.appendChild(painel.painel);
  return painel;
}

function montarEsqueletoPainel(titulo) {
  const conteudo = el('div', { className: 'painel-content' });
  const toast = el('div', { className: 'hud-toast', id: 'hudToast', text: 'Copiado!' });
  const acoes = el('div', { className: 'hud-actions' });

  const fechar = el('button', { className: 'hud-close-btn', text: '✕', title: 'Fechar' });
  const cabecalho = el('div', { className: 'hud-header' }, [
    el('h3', { text: titulo }),
    fechar,
  ]);

  const painel = el('div', { id: PANEL_ID }, [cabecalho, conteudo, toast, acoes]);
  fechar.addEventListener('click', removerPainel);

  return { painel, conteudo, acoes, cabecalho };
}

function exibirPainelErro(mensagem) {
  removerPainel();
  const { painel, conteudo } = montarEsqueletoPainel('⚠ ANÁLISE PRO');
  conteudo.appendChild(
    el('div', { className: 'hud-error' }, [
      el('p', { text: mensagem }),
      el('button', {
        className: 'hud-inline-btn',
        text: '🔄 Tentar novamente',
        on: { click: () => analisarProdutoAtual() },
      }),
    ]),
  );
  document.body.appendChild(painel);
  makeDraggable(painel, 'posicaoPainel');
  loadAndApplyPosition(painel, 'posicaoPainel');
}

/**
 * Explica ao usuário por que uma parte dos dados pode estar faltando —
 * sem login não há série de visitas, e sem API só resta o que o DOM mostra.
 */
function montarAviso(a) {
  if (a.avisoApi) {
    return el('div', { className: 'hud-aviso hud-aviso--erro' }, [
      el('span', { text: `Dados da API indisponíveis (${a.avisoApi}). Exibindo apenas o que foi lido da página.` }),
    ]);
  }
  if (a.avisoAutenticacao) {
    return el('div', { className: 'hud-aviso' }, [
      el('span', { text: 'Conecte sua conta do Mercado Livre no popup para liberar visitas, conversão e tarifas oficiais.' }),
    ]);
  }
  return null;
}

function exibirPainel(a) {
  removerPainel();
  const { painel, conteudo, acoes } = montarEsqueletoPainel(
    a.plataforma === 'shopee' ? '📊 ANÁLISE PRO — SHOPEE' : '📊 ANÁLISE PRO — MERCADO LIVRE',
  );

  const aviso = montarAviso(a);
  if (aviso) conteudo.appendChild(aviso);

  conteudo.appendChild(el('div', { className: 'hud-resumo' }, secaoResumo(a)));
  conteudo.appendChild(secao('sectionProduto', '📦 Produto', secaoProduto(a)));
  conteudo.appendChild(secao('sectionVendas', '📈 Vendas & Estoque', secaoVendas(a)));
  conteudo.appendChild(secao('sectionAnuncio', '🏷️ Anúncio', secaoAnuncio(a), { colapsada: true }));
  conteudo.appendChild(secao('sectionVendedor', '🏪 Vendedor', secaoVendedor(a), { colapsada: true }));

  const variacoes = secaoVariacoes(a);
  if (variacoes) conteudo.appendChild(secao('sectionVariacoes', '🎨 Variações', variacoes, { colapsada: true }));

  const visitas = secaoVisitas(a);
  if (visitas) conteudo.appendChild(secao('sectionVisitas', '👁️ Visitas & Conversão', visitas));

  conteudo.appendChild(secao('sectionCalc', '🧮 Calculadora de lucro', secaoCalculadora(a)));
  conteudo.appendChild(secao('sectionAvaliacoes', '💬 Avaliações', secaoAvaliacoes(a), { colapsada: true }));

  const seo = secaoSeo(a);
  if (seo) conteudo.appendChild(secao('sectionSEO', '🎯 SEO & Ficha técnica', seo, { colapsada: true }));

  conteudo.appendChild(secao('sectionMidias', '📸 Mídias', secaoMidias(a), { colapsada: true }));

  conteudo.appendChild(
    el('div', { className: 'hud-fonte', text: `Fontes: ${[...new Set(a.fonteDados)].join(' + ')}` }),
  );

  acoes.append(
    el('button', { className: 'hud-action-btn', text: '📋 Copiar', title: 'Copiar relatório', on: { click: copiarRelatorio } }),
    el('button', { className: 'hud-action-btn', text: '📸 Mídias', title: 'Baixar fotos', on: { click: baixarMidias } }),
    el('button', { className: 'hud-action-btn', text: '⭐ Garimpo', title: 'Salvar no garimpo', on: { click: salvarGarimpo } }),
    el('button', { className: 'hud-action-btn', text: '🔄 Atualizar', title: 'Recarregar análise', on: { click: () => analisarProdutoAtual() } }),
  );

  document.body.appendChild(painel);
  makeDraggable(painel, 'posicaoPainel');
  loadAndApplyPosition(painel, 'posicaoPainel');
  recalcularCalculadora();
}

// ==================================================================
//  CALCULADORA — RENDER
// ==================================================================

function recalcularCalculadora() {
  const a = state.analise;
  const container = document.getElementById('calcResultados');
  if (!a || !container) return;

  const custoProduto = parseFloat(document.getElementById('custoProduto')?.value) || 0;
  const custoFrete = parseFloat(document.getElementById('custoFrete')?.value) || 0;
  const preco = a.preco || 0;
  const r = calcularResultado(preco, custoProduto, custoFrete, a);

  clear(container);
  container.append(
    linha(a.plataforma === 'shopee' ? 'Comissão Shopee' : 'Tarifa Mercado Livre', fmtMoeda(r.tarifa.valor), {
      dica: `${fmtPercent(r.tarifa.percentual * 100, 1)}${r.tarifa.fixo ? ` + ${fmtMoeda(r.tarifa.fixo)} fixo` : ''}`,
    }),
    linha('Impostos & custos extras', fmtMoeda(r.extras)),
    linha('Valor recebido', fmtMoeda(r.valorRecebido), { moeda: true }),
    el('div', { className: `hud-result-highlight ${r.lucro >= 0 ? 'lucro-positivo' : 'lucro-negativo'}` }, [
      el('span', { className: 'hud-data-label', text: 'Lucro por venda' }),
      el('span', {
        className: 'hud-data-value',
        text: fmtMoeda(r.lucro),
        style: { color: r.lucro >= 0 ? 'var(--hud-accent-green)' : 'var(--hud-accent-red)' },
      }),
    ]),
    linha('Margem', fmtPercent(r.margem, 2), {
      cor: r.margem >= 20 ? 'var(--hud-accent-green)' : r.margem >= 10 ? 'var(--hud-accent-amber)' : 'var(--hud-accent-red)',
    }),
    linha('ROI sobre o custo', custoProduto > 0 ? fmtPercent(r.roi, 2) : '—'),
    linha('Markup', r.markup ? `${fmtDecimal(r.markup, 2)}x` : '—'),
  );

  if (custoProduto > 0) {
    const equilibrio = calcularPontoEquilibrio(custoProduto, custoFrete, a);
    if (equilibrio) {
      container.appendChild(
        linha('Preço de equilíbrio', fmtMoeda(equilibrio), {
          dica: 'Abaixo deste preço a venda dá prejuízo.',
          cor: preco > equilibrio ? 'var(--hud-accent-green)' : 'var(--hud-accent-red)',
        }),
      );
    }
    if (a.vendas30d) {
      container.appendChild(
        linha('Lucro projetado 30d', fmtMoeda(r.lucro * a.vendas30d), {
          dica: 'Lucro por venda × vendas dos últimos 30 dias.',
          moeda: true,
        }),
      );
    }
  }

  renderMatriz(a, custoProduto, custoFrete);
}

function renderMatriz(a, custoProduto, custoFrete) {
  const container = document.getElementById('calcMatriz');
  if (!container) return;
  clear(container);

  if (!(custoProduto > 0) || !a.preco) return;

  container.appendChild(el('div', { className: 'hud-subtitle', text: '📊 Sensibilidade de preço' }));

  const variacoes = [-0.15, -0.1, -0.05, 0, 0.05, 0.1, 0.15];
  const corpo = el('tbody');

  for (const variacao of variacoes) {
    const preco = a.preco * (1 + variacao);
    const r = calcularResultado(preco, custoProduto, custoFrete, a);
    const atual = variacao === 0;
    const cor = r.lucro >= 0 ? 'var(--hud-accent-green)' : 'var(--hud-accent-red)';

    corpo.appendChild(
      el('tr', { className: atual ? 'hud-matrix-current' : '' }, [
        el('td', { text: atual ? 'Atual' : `${variacao > 0 ? '+' : ''}${Math.round(variacao * 100)}%` }),
        el('td', { text: fmtMoeda(preco) }),
        el('td', { text: fmtMoeda(r.lucro), style: { color: cor } }),
        el('td', { text: fmtPercent(r.margem, 1), style: { color: cor } }),
      ]),
    );
  }

  container.appendChild(
    el('table', { className: 'hud-matrix-table' }, [
      el('thead', {}, [
        el('tr', {}, [
          el('th', { text: 'Var.' }),
          el('th', { text: 'Preço' }),
          el('th', { text: 'Lucro' }),
          el('th', { text: 'Margem' }),
        ]),
      ]),
      corpo,
    ]),
  );
}

// ==================================================================
//  AÇÕES DO HUD
// ==================================================================

function toast(mensagem) {
  const node = document.getElementById('hudToast');
  if (!node) return;
  node.textContent = mensagem;
  node.classList.add('visible');
  setTimeout(() => node.classList.remove('visible'), 1800);
}

async function copiarTexto(texto, mensagem = 'Copiado!') {
  try {
    await navigator.clipboard.writeText(texto);
    toast(mensagem);
  } catch {
    // A área de transferência exige foco no documento; caímos para um textarea.
    const area = el('textarea', { text: texto, style: { position: 'fixed', opacity: '0' } });
    document.body.appendChild(area);
    area.select();
    document.execCommand('copy');
    area.remove();
    toast(mensagem);
  }
}

function copiarRelatorio() {
  const a = state.analise;
  if (!a) return;

  const custoProduto = parseFloat(document.getElementById('custoProduto')?.value) || 0;
  const custoFrete = parseFloat(document.getElementById('custoFrete')?.value) || 0;
  const r = calcularResultado(a.preco || 0, custoProduto, custoFrete, a);

  const linhas = [
    `=== ANÁLISE PRO — ${a.plataforma === 'shopee' ? 'SHOPEE' : 'MERCADO LIVRE'} ===`,
    `Produto: ${a.titulo || '—'}`,
    `ID: ${a.id || '—'}`,
    `URL: ${a.permalink || a.url}`,
    `EAN: ${a.ean || '—'}`,
    `Marca: ${a.marca || '—'}`,
    `Categoria: ${a.categoria?.caminho?.join(' > ') || '—'}`,
    '',
    '--- PREÇO E VENDAS ---',
    `Preço: ${fmtMoeda(a.preco)}`,
    a.precoOriginal ? `Preço original: ${fmtMoeda(a.precoOriginal)} (-${fmtDecimal(a.descontoPercent, 0)}%)` : null,
    `Vendas totais: ${fmtNumero(a.vendasTotais)}`,
    `Vendas 30d (${a.vendas30dFonte || 'n/d'}): ${fmtNumero(a.vendas30d)}`,
    `Vendas/dia: ${fmtDecimal(a.vendasPorDia, 2)}`,
    `Estoque: ${fmtNumero(a.estoque)}`,
    `Faturamento total: ${fmtMoeda(a.faturamentoTotal)}`,
    `Faturamento 30d: ${fmtMoeda(a.faturamento30d)}`,
    a.visitas ? `Visitas 30d: ${fmtNumero(a.visitas.total)} | Conversão: ${fmtPercent(a.visitas.conversao, 2)}` : null,
    '',
    '--- ANÚNCIO ---',
    `Tipo: ${a.tipoAnuncio || '—'}`,
    `Criado em: ${fmtData(a.dataCriacao)} (${fmtIdade(a.idadeDias)})`,
    `Logística: ${a.logistica || '—'}`,
    `Frete grátis: ${a.freteGratis ? 'Sim' : 'Não'}`,
    a.saudeFicha != null ? `Qualidade da ficha: ${Math.round(a.saudeFicha * 100)}%` : null,
    '',
    '--- VENDEDOR ---',
    `Nome: ${a.vendedor?.nick || '—'}`,
    a.vendedor?.nivel ? `Reputação: ${a.vendedor.nivel}` : null,
    a.vendedor?.totalTransacoes != null ? `Transações: ${fmtNumero(a.vendedor.totalTransacoes)}` : null,
    a.vendedor?.anunciosAtivos != null ? `Anúncios ativos: ${fmtNumero(a.vendedor.anunciosAtivos)}` : null,
    '',
    '--- FINANCEIRO ---',
    `Custo do produto: ${fmtMoeda(custoProduto)}`,
    `Custo do frete: ${fmtMoeda(custoFrete)}`,
    `Tarifa do marketplace: ${fmtMoeda(r.tarifa.valor)}`,
    `Impostos e extras: ${fmtMoeda(r.extras)}`,
    `Valor recebido: ${fmtMoeda(r.valorRecebido)}`,
    `Lucro por venda: ${fmtMoeda(r.lucro)}`,
    `Margem: ${fmtPercent(r.margem, 2)}`,
    `ROI: ${custoProduto > 0 ? fmtPercent(r.roi, 2) : '—'}`,
    '',
    a.avaliacoes?.media ? `Avaliações: ${fmtDecimal(a.avaliacoes.media, 2)}★ (${fmtNumero(a.avaliacoes.total)})` : null,
    a.avaliacoes?.termosNegativos?.length
      ? `Dores citadas: ${a.avaliacoes.termosNegativos.map((t) => t.termo).join(', ')}`
      : null,
  ].filter((texto) => texto !== null);

  copiarTexto(linhas.join('\n'), 'Relatório copiado!');
}

function copiarFichaTecnica(a) {
  const linhas = a.atributos
    .filter((attr) => attr.value_name)
    .map((attr) => `${attr.name}: ${attr.value_name}`);
  if (!linhas.length) {
    toast('Ficha técnica indisponível.');
    return;
  }
  copiarTexto(linhas.join('\n'), 'Ficha técnica copiada!');
}

function copiarAvaliacoes(avaliacoes) {
  const linhas = (avaliacoes.lista || []).map(
    (review) => `[${review.nota || '?'}★] ${review.titulo ? `${review.titulo} — ` : ''}${review.texto}`,
  );
  copiarTexto(linhas.join('\n\n'), `${linhas.length} avaliações copiadas!`);
}

async function baixarMidias() {
  const a = state.analise;
  if (!a?.fotos?.length) {
    toast('Nenhuma foto encontrada.');
    return;
  }
  toast('Baixando mídias…');
  const prefixo = (a.titulo || 'produto').slice(0, 40);
  const resposta = await send({ type: 'downloadMedia', urls: a.fotos, prefix: prefixo });
  if (resposta.success) {
    toast(`${resposta.baixadas} arquivo(s) baixado(s)${resposta.falhas ? `, ${resposta.falhas} falha(s)` : ''}`);
  } else {
    toast(`Erro: ${resposta.error}`);
  }
}

async function salvarGarimpo() {
  const a = state.analise;
  if (!a) return;

  const custoProduto = parseFloat(document.getElementById('custoProduto')?.value) || 0;
  const custoFrete = parseFloat(document.getElementById('custoFrete')?.value) || 0;
  const r = calcularResultado(a.preco || 0, custoProduto, custoFrete, a);

  const item = {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    timestamp: new Date().toISOString(),
    plataforma: a.plataforma,
    titulo: a.titulo,
    url: a.permalink || a.url,
    itemId: a.id,
    preco: a.preco,
    precoOriginal: a.precoOriginal,
    vendas: a.vendasTotais,
    vendas30d: a.vendas30d,
    vendasPorDia: a.vendasPorDia,
    faturamento30d: a.faturamento30d,
    estoque: a.estoque,
    visitas30d: a.visitas?.total ?? null,
    conversao: a.visitas?.conversao ?? null,
    tipoAnuncio: a.tipoAnuncio,
    logistica: a.logistica,
    freteGratis: a.freteGratis,
    ean: a.ean,
    marca: a.marca,
    categoria: a.categoria?.caminho?.join(' > ') || null,
    idadeDias: a.idadeDias,
    dataCriacao: a.dataCriacao,
    saudeFicha: a.saudeFicha,
    nota: a.avaliacoes?.media ?? null,
    totalAvaliacoes: a.avaliacoes?.total ?? null,
    sellerNick: a.vendedor?.nick || null,
    sellerReputacao: a.vendedor?.nivel || null,
    sellerAnuncios: a.vendedor?.anunciosAtivos ?? null,
    custoProduto,
    custoFrete,
    lucro: r.lucro,
    margem: r.margem,
  };

  const resposta = await send({ type: 'saveGarimpo', item });
  toast(resposta.success ? '⭐ Salvo no Garimpo!' : `Erro: ${resposta.error}`);
}

// ==================================================================
//  ORQUESTRAÇÃO DA ANÁLISE
// ==================================================================

let analiseEmAndamento = false;

async function analisarProdutoAtual() {
  if (analiseEmAndamento) return;
  analiseEmAndamento = true;

  try {
    exibirPainelCarregando();
    await carregarConfiguracoes();

    const analise =
      state.plataforma === 'shopee' ? await analisarShopee() : await analisarMercadoLivre();

    if (!analise) {
      exibirPainelErro('Não foi possível identificar o anúncio nesta página.');
      return;
    }

    await calcularMetricasDerivadas(analise);
    state.analise = analise;
    exibirPainel(analise);
  } catch (error) {
    console.error('[Analisador Pro] Falha na análise:', error);
    exibirPainelErro(`Falha ao analisar: ${error.message}`);
  } finally {
    analiseEmAndamento = false;
  }
}

async function analisarMercadoLivre() {
  const analise = extrairDadosDomMeli();
  let itemId = analise.id;

  // Em anúncios de catálogo sem `wid`, descobrimos o item vencedor pela API.
  if (!itemId) {
    const catalogId = extrairIdCatalogoDaUrl();
    if (catalogId) {
      const resposta = await send({ type: 'fetchMlCatalogProduct', productId: catalogId });
      itemId = resposta.success ? resposta.data?.buy_box_winner?.item_id || null : null;
    }
  }

  if (itemId) {
    const resposta = await send({ type: 'analyzeMlItem', itemId });
    if (resposta.success && resposta.analysis) {
      aplicarAnaliseApiMeli(analise, resposta.analysis);
      if (!resposta.analysis.visits && !resposta.analysis.authenticated) {
        analise.avisoAutenticacao = true;
      }
    } else {
      analise.avisoApi = resposta.error || 'API indisponível';
    }
  }

  // Sem tarifa da API a calculadora cai para as taxas configuradas no popup.
  return analise.titulo || analise.preco ? analise : null;
}

/**
 * Monta a análise da Shopee combinando, nesta ordem:
 *   1. o que a ponte já capturou das chamadas da própria página;
 *   2. chamadas diretas à API (mesma origem, com cookies);
 *   3. o que der para ler do DOM/JSON-LD.
 */
async function analisarShopee() {
  const analise = extrairDadosDomShopee();
  const ids = extrairIdsShopee();
  if (!ids) return analise.titulo || analise.preco ? analise : null;

  const { shopId, itemId } = ids;

  // --- Item ---
  let item = shopeeCache.itens.get(itemId) || null;
  if (!item) {
    const resposta =
      (await shopeeApi(`/api/v4/item/get?itemid=${itemId}&shopid=${shopId}`)) ||
      (await shopeeApi(`/api/v4/pdp/get_pc?item_id=${itemId}&shop_id=${shopId}`));
    item = resposta?.data?.item ?? resposta?.data ?? null;
    if (item?.itemid) shopeeCache.itens.set(String(item.itemid), item);
  }

  // Sem item, a busca da página pode ter trazido o essencial deste anúncio.
  if (!item) item = shopeeCache.buscas.get(itemId) || null;

  // --- Loja e avaliações, em paralelo ---
  const [loja, avaliacoes] = await Promise.all([
    (async () => {
      const emCache = shopeeCache.lojas.get(shopId);
      if (emCache) return emCache;
      const resposta = await shopeeApi(`/api/v4/shop/get_shop_base?shopid=${shopId}`);
      const dados = resposta?.data ?? null;
      if (dados) shopeeCache.lojas.set(shopId, dados);
      return dados;
    })(),
    (async () => {
      const emCache = shopeeCache.avaliacoes.get(itemId);
      if (emCache) return emCache;
      const resposta = await shopeeApi(
        `/api/v4/item/get_ratings?itemid=${itemId}&shopid=${shopId}&filter=1&flag=1&type=0&limit=20&offset=0`,
      );
      const dados = resposta?.data ?? null;
      if (dados) shopeeCache.avaliacoes.set(itemId, dados);
      return dados;
    })(),
  ]);

  if (item || loja) {
    aplicarAnaliseApiShopee(analise, { item, loja, avaliacoes });
  } else {
    analise.avisoApi =
      'A Shopee não respondeu às consultas de dados. Recarregue a página do anúncio (F5) para a extensão capturar os dados que a própria página busca.';
  }

  return analise.titulo || analise.preco ? analise : null;
}

// ==================================================================
//  DRAG & DROP + POSIÇÃO PERSISTIDA
// ==================================================================

function makeDraggable(elemento, storageKey) {
  const alca = elemento.querySelector('.hud-header') || elemento;
  let inicioX = 0;
  let inicioY = 0;

  const mover = (evento) => {
    evento.preventDefault();
    const deltaX = inicioX - evento.clientX;
    const deltaY = inicioY - evento.clientY;
    inicioX = evento.clientX;
    inicioY = evento.clientY;
    elemento.style.top = `${elemento.offsetTop - deltaY}px`;
    elemento.style.left = `${elemento.offsetLeft - deltaX}px`;
    elemento.style.right = 'auto';
  };

  const soltar = () => {
    document.removeEventListener('mousemove', mover);
    document.removeEventListener('mouseup', soltar);
    chrome.storage.local.set({
      [storageKey]: { top: elemento.style.top, left: elemento.style.left },
    });
  };

  alca.addEventListener('mousedown', (evento) => {
    if (evento.target.closest('button, input, a, .hud-section-header')) return;
    evento.preventDefault();
    inicioX = evento.clientX;
    inicioY = evento.clientY;
    document.addEventListener('mousemove', mover);
    document.addEventListener('mouseup', soltar);
  });
}

function loadAndApplyPosition(elemento, storageKey) {
  chrome.storage.local.get(storageKey, (resultado) => {
    if (chrome.runtime.lastError) return;
    const posicao = resultado[storageKey];
    if (!posicao) return;
    // Descarta posições fora da janela atual (monitor trocado, zoom, etc.).
    const top = parseInt(posicao.top, 10);
    const left = parseInt(posicao.left, 10);
    if (Number.isFinite(top) && top >= 0 && top < window.innerHeight - 60) elemento.style.top = posicao.top;
    if (Number.isFinite(left) && left >= 0 && left < window.innerWidth - 60) {
      elemento.style.left = posicao.left;
      elemento.style.right = 'auto';
    }
  });
}

// ==================================================================
//  PÁGINAS DE BUSCA — BADGES NOS CARDS
// ==================================================================

/** Fila de itens aguardando enriquecimento pela API (lotes de 20). */
const filaEnriquecimento = new Map();
let timerFila = null;

function extrairIdCard(card) {
  const link = card.querySelector('a[href*="mercadolivre.com"], a[href*="/MLB-"], a[href*="/p/MLB"]');
  if (!link) return null;
  return extrairIdItemDaUrl(link.href);
}

function precoDoCard(card) {
  const fracao = card.querySelector('.andes-money-amount__fraction');
  if (!fracao) return null;
  const inteiro = parseNumeroBR(fracao.textContent);
  if (inteiro == null) return null;
  const centavos = parseNumeroBR(card.querySelector('.andes-money-amount__cents')?.textContent);
  return inteiro + (centavos ? centavos / 100 : 0);
}

function vendasDoCard(card) {
  const match = (card.textContent || '').match(/([\d.,]+\s*(?:mil)?)\s*vendid/i);
  return match ? parseQuantidadeTexto(match[1]) : null;
}

/** Cria (ou atualiza) o badge de um card com o que já se sabe. */
function renderBadge(card, dados) {
  let badge = card.querySelector(`.${BADGE_CLASS}`);
  if (!badge) {
    badge = el('div', {
      className: BADGE_CLASS,
      on: {
        // O card inteiro costuma ser um link: sem isto, ler o badge
        // (ou passar o mouse nele) acaba abrindo o anúncio.
        click: (evento) => {
          evento.preventDefault();
          evento.stopPropagation();
        },
      },
    });
    card.appendChild(badge);
  }
  clear(badge);

  const itens = [];

  if (dados.preco) {
    itens.push(
      el('span', { className: 'ml-search-badge__item ml-search-badge__item--faturamento' }, [
        el('span', { className: 'ml-search-badge__icon', text: '💲' }),
        el('span', { className: 'ml-search-badge__value', text: fmtMoeda(dados.preco) }),
      ]),
    );
  }

  if (dados.vendas != null) {
    // Na Shopee `sold` já são as vendas dos últimos 30 dias — o rótulo diz qual é qual.
    const sufixo = dados.rotuloVendas ? ` vend./${dados.rotuloVendas}` : ' vend.';
    itens.push(
      el(
        'span',
        {
          className: 'ml-search-badge__item ml-search-badge__item--vendas',
          title:
            dados.vendasTotais != null
              ? `${fmtNumero(dados.vendasTotais)} vendas no total desde a criação`
              : '',
        },
        [
          el('span', { className: 'ml-search-badge__icon', text: '📦' }),
          el('span', { className: 'ml-search-badge__value', text: `${fmtNumero(dados.vendas)}${sufixo}` }),
        ],
      ),
    );
  }

  if (dados.faturamento) {
    itens.push(
      el(
        'span',
        {
          className: 'ml-search-badge__item ml-search-badge__item--faturamento',
          title: dados.rotuloVendas === '30d' ? 'Faturamento dos últimos 30 dias' : 'Faturamento estimado',
        },
        [
          el('span', { className: 'ml-search-badge__icon', text: '💰' }),
          el('span', { className: 'ml-search-badge__value', text: fmtMoeda(dados.faturamento) }),
        ],
      ),
    );
  }

  if (dados.nota) {
    itens.push(
      el('span', { className: 'ml-search-badge__item' }, [
        el('span', { className: 'ml-search-badge__icon', text: '⭐' }),
        el('span', { className: 'ml-search-badge__value', text: fmtDecimal(dados.nota, 1) }),
      ]),
    );
  }

  if (dados.idadeDias != null) {
    itens.push(
      el('span', { className: 'ml-search-badge__item' }, [
        el('span', { className: 'ml-search-badge__icon', text: '⏱️' }),
        el('span', { className: 'ml-search-badge__value', text: fmtIdade(dados.idadeDias) }),
      ]),
    );
  }

  if (dados.estoque != null) {
    itens.push(
      el('span', { className: 'ml-search-badge__item' }, [
        el('span', { className: 'ml-search-badge__icon', text: '🏬' }),
        el('span', { className: 'ml-search-badge__value', text: `${fmtNumero(dados.estoque)} un.` }),
      ]),
    );
  }

  for (const item of itens) {
    if (badge.childNodes.length) badge.appendChild(el('span', { className: 'ml-search-badge__separator' }));
    badge.appendChild(item);
  }

  const tags = [];
  if (dados.tipoAnuncio) {
    tags.push(
      el('span', {
        className: `ml-search-badge__tag ml-search-badge__tag--${dados.tipoAnuncio === 'Premium' ? 'premium' : 'classico'}`,
        text: dados.tipoAnuncio,
      }),
    );
  }
  if (dados.logistica) {
    tags.push(
      el('span', {
        className: `ml-search-badge__tag ml-search-badge__tag--${dados.logistica === 'Full' ? 'full' : 'logistica'}`,
        text: dados.logistica,
      }),
    );
  }
  if (dados.freteGratis) {
    tags.push(el('span', { className: 'ml-search-badge__tag ml-search-badge__tag--frete', text: 'Frete grátis' }));
  }
  if (dados.catalogo) {
    tags.push(el('span', { className: 'ml-search-badge__tag ml-search-badge__tag--catalogo', text: 'Catálogo' }));
  }
  if (dados.oficial) {
    tags.push(el('span', { className: 'ml-search-badge__tag ml-search-badge__tag--catalogo', text: 'Loja oficial' }));
  }
  if (dados.localizacao) {
    tags.push(
      el('span', {
        className: 'ml-search-badge__tag ml-search-badge__tag--logistica',
        text: `📍 ${dados.localizacao}`,
      }),
    );
  }

  if (dados.vendedor) {
    const repeticoes = state.contagemVendedores.get(dados.vendedor) || 0;
    const dominio = repeticoes >= 3;
    tags.push(
      el('span', {
        className: `ml-search-badge__tag ml-search-badge__tag--${dominio ? 'dominio' : 'seller'}`,
        text: dominio ? `🔒 ${dados.vendedor} (${repeticoes}x)` : `🏪 ${dados.vendedor}`,
        title: dominio
          ? `Este vendedor ocupa ${repeticoes} posições nesta página — nicho concentrado.`
          : 'Vendedor do anúncio',
        dataset: { seller: dados.vendedor },
      }),
    );
  }

  if (tags.length) {
    const linhaTags = el('div', { className: 'ml-search-badge__tags' }, tags);
    badge.appendChild(linhaTags);
  }
}

function agendarEnriquecimento(card, itemId) {
  filaEnriquecimento.set(itemId, card);
  if (timerFila) return;
  timerFila = setTimeout(() => {
    timerFila = null;
    processarFilaEnriquecimento();
  }, 500);
  state.timers.push(timerFila);
}

async function processarFilaEnriquecimento() {
  if (!filaEnriquecimento.size) return;

  const lote = [...filaEnriquecimento.entries()].slice(0, 20);
  for (const [id] of lote) filaEnriquecimento.delete(id);

  const resposta = await send({ type: 'fetchMlItemsBatch', ids: lote.map(([id]) => id) });
  if (!resposta.success) return;

  const { items = {}, sellers = {} } = resposta;

  // Primeiro passe: contabiliza vendedores para detectar monopólio.
  for (const [id] of lote) {
    const item = items[id];
    const nick = item && sellers[item.seller_id]?.nickname;
    if (nick) state.contagemVendedores.set(nick, (state.contagemVendedores.get(nick) || 0) + 1);
  }

  for (const [id, card] of lote) {
    const item = items[id];
    if (!item || !card.isConnected) continue;

    const vendas = typeof item.sold_quantity === 'number' ? item.sold_quantity : vendasDoCard(card);
    const idadeDias = diasEntre(item.date_created);

    renderBadge(card, {
      preco: item.price ?? precoDoCard(card),
      vendas,
      faturamento: item.price && vendas ? item.price * vendas : null,
      idadeDias,
      estoque: item.available_quantity ?? null,
      tipoAnuncio: TIPO_ANUNCIO_LABEL[item.listing_type_id] || null,
      logistica: rotuloLogistica(item.shipping),
      freteGratis: item.shipping?.free_shipping ?? false,
      catalogo: Boolean(item.catalog_listing),
      vendedor: sellers[item.seller_id]?.nickname || null,
    });
  }

  // A API aceita 20 ids por chamada; se sobrou fila, drena o resto.
  if (filaEnriquecimento.size > 0) {
    const timer = setTimeout(processarFilaEnriquecimento, 400);
    state.timers.push(timer);
    return;
  }

  // Com a fila vazia já sabemos quantas posições cada vendedor ocupa.
  atualizarMarcasDeDominio();
}

/**
 * Depois que todos os lotes voltam, os cards desenhados antes ainda não sabiam
 * quantas posições cada vendedor ocupa. Este passe final marca os monopólios.
 */
function atualizarMarcasDeDominio() {
  for (const tag of $$('.ml-search-badge__tag--seller, .ml-search-badge__tag--dominio')) {
    const nick = tag.dataset.seller;
    if (!nick) continue;
    const repeticoes = state.contagemVendedores.get(nick) || 0;
    if (repeticoes < 3) continue;
    tag.className = 'ml-search-badge__tag ml-search-badge__tag--dominio';
    tag.textContent = `🔒 ${nick} (${repeticoes}x)`;
    tag.title = `Este vendedor ocupa ${repeticoes} posições nesta página — nicho concentrado.`;
  }
}

function selecionarCardsMeli() {
  const seletores = [
    '.ui-search-layout__item',
    '.poly-card',
    '.ui-search-result__wrapper',
    'li.ui-search-layout__item',
  ];
  for (const seletor of seletores) {
    const encontrados = $$(seletor);
    if (encontrados.length) return encontrados;
  }
  return [];
}

function processarCardsMeli() {
  const cards = selecionarCardsMeli();
  for (const card of cards) {
    if (state.cardsEnriquecidos.has(card)) continue;
    state.cardsEnriquecidos.add(card);

    // Desenho imediato com o que dá para ler do DOM; a API refina depois.
    renderBadge(card, {
      preco: precoDoCard(card),
      vendas: vendasDoCard(card),
      freteGratis: /frete gr[áa]tis/i.test(card.textContent || ''),
    });

    const itemId = extrairIdCard(card);
    if (itemId) agendarEnriquecimento(card, itemId);
  }

  atualizarBarraBusca(cards.length, cards.length - filaEnriquecimento.size);
}

// ==================================================================
//  BARRA DA PÁGINA DE BUSCA (contador + exportação)
// ==================================================================

const BARRA_ID = 'analisador-pro-barra-busca';

/**
 * Barra flutuante nas páginas de busca: mostra quantos cards já têm dados
 * reais da API e permite exportar a página inteira de resultados em CSV —
 * o fluxo de prospecção em massa das ferramentas de garimpo.
 */
function atualizarBarraBusca(total, comDadosReais) {
  let barra = document.getElementById(BARRA_ID);

  if (!barra) {
    barra = el('div', { id: BARRA_ID }, [
      el('span', { className: 'ap-barra-titulo', text: '📊 Analisador Pro' }),
      el('span', { className: 'ap-barra-contador', id: 'apBarraContador', text: '' }),
      el('button', {
        className: 'ap-barra-btn',
        text: '📥 Exportar página (CSV)',
        title: 'Exporta todos os produtos carregados nesta página de resultados',
        on: { click: exportarBuscaCsv },
      }),
    ]);
    document.body.appendChild(barra);
  }

  const contador = barra.querySelector('#apBarraContador');
  if (contador) {
    contador.textContent =
      comDadosReais > 0
        ? `${comDadosReais}/${total} com dados da API`
        : `${total} produtos — role a página para carregar os dados`;
  }
}

/** Reúne os dados de todos os cards da busca atual. */
function coletarLinhasBusca() {
  const linhas = [];

  if (state.plataforma === 'shopee') {
    for (const [, ids] of selecionarCardsShopee()) {
      const dados = shopeeCache.buscas.get(ids.itemId) || shopeeCache.itens.get(ids.itemId);
      if (!dados) continue;
      const preco = shopeeParaReais(dados.price);
      const vendas30d = typeof dados.sold === 'number' ? dados.sold : null;
      linhas.push({
        plataforma: 'shopee',
        id: `${ids.shopId}.${ids.itemId}`,
        titulo: dados.name || '',
        url: `${window.location.origin}/product/${ids.shopId}/${ids.itemId}`,
        preco,
        precoOriginal: shopeeParaReais(dados.price_before_discount),
        vendas30d,
        vendasTotais: dados.historical_sold ?? null,
        faturamento30d: preco != null && vendas30d != null ? preco * vendas30d : null,
        estoque: dados.stock ?? null,
        nota: dados.item_rating?.rating_star ?? null,
        avaliacoes: dados.item_rating?.rating_count?.[0] ?? null,
        curtidas: dados.liked_count ?? null,
        vendedor: dados.shop_name || '',
        localizacao: dados.shop_location || '',
        oficial: dados.is_official_shop ? 'Sim' : 'Não',
        freteGratis: dados.show_free_shipping ? 'Sim' : 'Não',
        criadoEm: dados.ctime ? new Date(dados.ctime * 1000).toISOString().slice(0, 10) : '',
      });
    }
  } else {
    for (const card of selecionarCardsMeli()) {
      const preco = precoDoCard(card);
      const vendas = vendasDoCard(card);
      const link = card.querySelector('a[href]');
      const titulo = card.querySelector('h2, h3, .poly-component__title')?.textContent?.trim() || '';
      const vendedorTag = card.querySelector('.ml-search-badge__tag--seller, .ml-search-badge__tag--dominio');
      linhas.push({
        plataforma: 'meli',
        id: extrairIdCard(card) || '',
        titulo,
        url: link?.href || '',
        preco,
        vendasTotais: vendas,
        faturamento: preco && vendas ? preco * vendas : null,
        vendedor: vendedorTag?.dataset.seller || '',
      });
    }
  }

  return linhas;
}

function exportarBuscaCsv() {
  const linhas = coletarLinhasBusca();
  if (!linhas.length) {
    alert('Nenhum produto com dados carregados nesta página ainda. Role a página e tente de novo.');
    return;
  }

  const colunas = [...new Set(linhas.flatMap((linha) => Object.keys(linha)))];
  const celula = (valor) => {
    if (valor === null || valor === undefined) return '';
    const texto = String(valor);
    return /[";\n]/.test(texto) ? `"${texto.replace(/"/g, '""')}"` : texto;
  };

  const csv = [
    colunas.join(';'),
    ...linhas.map((linha) => colunas.map((coluna) => celula(linha[coluna])).join(';')),
  ].join('\r\n');

  const blob = new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const termo = (new URLSearchParams(window.location.search).get('keyword') || 'busca')
    .replace(/[^a-zA-Z0-9]/g, '-')
    .slice(0, 30);
  const link = el('a', { attrs: { href: url, download: `busca_${state.plataforma}_${termo}.csv` } });
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/**
 * Localiza os cards da busca da Shopee. As classes são ofuscadas e mudam a
 * cada deploy, então a âncora confiável é o próprio link do produto
 * (`/nome-i.SHOPID.ITEMID`), do qual subimos até o container do card.
 */
function selecionarCardsShopee() {
  const cards = new Map(); // elemento -> itemid

  for (const link of $$('a[href*="-i."]')) {
    const ids = extrairIdsShopee(link.href);
    if (!ids) continue;
    const container =
      link.closest('[data-sqe="item"], .shopee-search-item-result__item, .col-xs-2-4') || link;
    if (!cards.has(container)) cards.set(container, ids);
  }

  return cards;
}

/**
 * Enriquece o grid da Shopee. Diferente do Mercado Livre, aqui não é preciso
 * pedir nada: `search_items` já passou pela ponte com todos os dados de cada
 * card — inclusive `sold`, que são as vendas dos últimos 30 dias.
 */
function processarCardsShopee() {
  const cards = selecionarCardsShopee();
  let comDadosReais = 0;

  for (const [card, ids] of cards) {
    const dadosApi = shopeeCache.buscas.get(ids.itemId) || shopeeCache.itens.get(ids.itemId) || null;

    // Já desenhado com dados da API? Não há o que refazer.
    if (state.cardsEnriquecidos.has(card) && !dadosApi) continue;
    if (card.dataset.apDadosReais === '1') {
      comDadosReais += 1;
      continue;
    }
    state.cardsEnriquecidos.add(card);

    if (dadosApi) {
      const preco = shopeeParaReais(dadosApi.price);
      const vendas30d = typeof dadosApi.sold === 'number' ? dadosApi.sold : null;
      const vendasTotais = dadosApi.historical_sold ?? null;
      const loja = dadosApi.shop_name || dadosApi.shop_location || null;

      renderBadge(card, {
        preco,
        vendas: vendas30d,
        rotuloVendas: '30d',
        vendasTotais,
        faturamento: preco != null && vendas30d != null ? preco * vendas30d : null,
        estoque: dadosApi.stock ?? null,
        nota: dadosApi.item_rating?.rating_star ?? null,
        idadeDias: dadosApi.ctime ? diasEntre(new Date(dadosApi.ctime * 1000).toISOString()) : null,
        freteGratis: Boolean(dadosApi.show_free_shipping),
        vendedor: loja,
        localizacao: dadosApi.shop_location || null,
        oficial: Boolean(dadosApi.is_official_shop),
      });

      card.dataset.apDadosReais = '1';
      comDadosReais += 1;
      if (loja) state.contagemVendedores.set(loja, (state.contagemVendedores.get(loja) || 0) + 1);
      continue;
    }

    // Sem dados da ponte ainda: desenha o que dá para ler do card.
    const texto = card.textContent || '';
    const precoMatch = texto.match(/R\$\s*([\d.]+(?:,\d{2})?)/);
    const preco = precoMatch ? parseNumeroBR(precoMatch[1]) : null;
    const vendidosMatch = texto.match(/([\d.,]+\s*(?:mil)?)\s*vendidos?/i);
    const vendas = vendidosMatch ? parseQuantidadeTexto(vendidosMatch[1]) : null;

    renderBadge(card, {
      preco,
      vendas,
      faturamento: preco && vendas ? preco * vendas : null,
      freteGratis: /frete gr[áa]tis/i.test(texto),
    });
  }

  atualizarMarcasDeDominio();
  atualizarBarraBusca(cards.size, comDadosReais);
}

/**
 * Observa a lista de resultados. O callback é agendado em `requestIdleCallback`
 * com trava de reentrância: sem isso, inserir um badge dispara o próprio
 * observer e o scan vira um laço infinito.
 */
function observarResultados(processar) {
  let agendado = false;

  const executar = () => {
    agendado = false;
    try {
      processar();
    } catch (error) {
      console.warn('[Analisador Pro] Falha ao processar cards:', error);
    }
  };

  const agendar = () => {
    if (agendado) return;
    agendado = true;
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(executar, { timeout: 800 });
    } else {
      setTimeout(executar, 300);
    }
  };

  executar();

  const observer = new MutationObserver((mutacoes) => {
    // Ignora mutações causadas pelos próprios badges.
    const relevante = mutacoes.some((mutacao) =>
      [...mutacao.addedNodes].some(
        (node) => node.nodeType === 1 && !node.classList?.contains(BADGE_CLASS) && !node.closest?.(`.${BADGE_CLASS}`),
      ),
    );
    if (relevante) agendar();
  });

  const alvo = $('.ui-search-results, .ui-search-layout, #root-app, main') || document.body;
  observer.observe(alvo, { childList: true, subtree: true });
  state.observers.push(observer);
}

// ==================================================================
//  ROTEAMENTO
// ==================================================================

function limparPagina() {
  for (const observer of state.observers) observer.disconnect();
  state.observers = [];
  for (const timer of state.timers) clearTimeout(timer);
  state.timers = [];
  filaEnriquecimento.clear();
  state.contagemVendedores.clear();
  state.cardsEnriquecidos = new WeakSet();
  document.querySelector(`.${BUTTON_CLASS}`)?.remove();
  document.getElementById(BARRA_ID)?.remove();
  removerPainel();
}

function ehPaginaProdutoMeli() {
  return Boolean(
    extrairIdItemDaUrl() ||
      extrairIdCatalogoDaUrl() ||
      $('.ui-pdp-container, .ui-vip-core, .ui-pdp-title'),
  );
}

function ehPaginaBuscaMeli() {
  const url = window.location.href;
  return (
    /\/lista\.|listado\.|\/ofertas|search_layout=|#D\[A:/.test(url) ||
    Boolean($('.ui-search-results, .ui-search-layout'))
  );
}

function ehPaginaProdutoShopee() {
  return /-i\.\d+\.\d+/.test(window.location.href);
}

function ehPaginaBuscaShopee() {
  const url = window.location.href;
  return url.includes('/search') || url.includes('keyword=') || url.includes('/mall/');
}

function criarBotaoAnalise() {
  if (document.querySelector(`.${BUTTON_CLASS}`)) return;
  const botao = el('button', {
    className: BUTTON_CLASS,
    text: '▶ ANÁLISE PRO',
    title: 'Analisar este anúncio (arraste para reposicionar)',
    on: { click: () => analisarProdutoAtual() },
  });
  document.body.appendChild(botao);
  makeDraggable(botao, 'posicaoBotao');
  loadAndApplyPosition(botao, 'posicaoBotao');
}

/** Espera o React hidratar antes de decidir que a página não é de produto. */
function aguardarPdp(verificar, aoEncontrar, tempoLimite = 12000) {
  if (verificar()) {
    aoEncontrar();
    return;
  }

  const observer = new MutationObserver(() => {
    if (!verificar()) return;
    observer.disconnect();
    aoEncontrar();
  });
  observer.observe(document.body, { childList: true, subtree: true });
  state.observers.push(observer);

  const timer = setTimeout(() => observer.disconnect(), tempoLimite);
  state.timers.push(timer);
}

function rotear() {
  limparPagina();

  if (state.plataforma === 'shopee') {
    // Recupera o que a ponte capturou antes deste script carregar.
    solicitarReplayShopee();

    if (ehPaginaBuscaShopee() && !ehPaginaProdutoShopee()) {
      observarResultados(processarCardsShopee);
      return;
    }
    if (ehPaginaProdutoShopee()) {
      aguardarPdp(() => Boolean($('h1, [data-sqe="name"]')), criarBotaoAnalise);
    }
    return;
  }

  if (ehPaginaBuscaMeli()) {
    observarResultados(processarCardsMeli);
    return;
  }

  if (ehPaginaProdutoMeli()) {
    aguardarPdp(ehPaginaProdutoMeli, criarBotaoAnalise);
  }
}

/**
 * ML e Shopee são SPAs: o content script roda uma única vez, então
 * interceptamos as trocas de rota do History API além do popstate.
 */
function monitorarNavegacao() {
  let ultimaUrl = window.location.href;

  const aoMudar = () => {
    if (window.location.href === ultimaUrl) return;
    ultimaUrl = window.location.href;
    setTimeout(rotear, 400);
  };

  for (const metodo of ['pushState', 'replaceState']) {
    const original = history[metodo];
    history[metodo] = function patched(...args) {
      const resultado = original.apply(this, args);
      window.dispatchEvent(new Event('analisador:navegacao'));
      return resultado;
    };
  }

  window.addEventListener('analisador:navegacao', aoMudar);
  window.addEventListener('popstate', aoMudar);

  // Rede de segurança: algumas transições não passam pelo History API.
  setInterval(aoMudar, 2000);
}

// ==================================================================
//  BOOTSTRAP
// ==================================================================

function detectarPlataforma() {
  const host = window.location.hostname;
  if (host.includes('mercadolivre.com.br')) return 'meli';
  if (host.includes('shopee.com.br')) return 'shopee';
  return 'unknown';
}

function iniciar() {
  state.plataforma = detectarPlataforma();
  if (state.plataforma === 'unknown') return;

  carregarConfiguracoes();
  rotear();
  monitorarNavegacao();
}

iniciar();
