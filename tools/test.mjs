#!/usr/bin/env node
/**
 * Testes das funções puras da extensão.
 *
 *   node tools/test.mjs
 *
 * content.js é avaliado dentro de um `vm` com um DOM mínimo. Como
 * `detectarPlataforma()` devolve 'unknown' fora do ML/Shopee, o bootstrap
 * encerra sozinho e sobram apenas as funções — que são testadas no código
 * realmente publicado, sem cópia paralela da lógica.
 */

import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');

let passou = 0;
const falhas = [];

function check(descricao, condicao, detalhe = '') {
  if (condicao) {
    passou += 1;
  } else {
    falhas.push(`${descricao}${detalhe ? ` — ${detalhe}` : ''}`);
  }
}

function quaseIgual(a, b, tolerancia = 0.01) {
  return Math.abs(a - b) < tolerancia;
}

// ==================================================================
//  SANDBOX
// ==================================================================

const noop = () => {};

/**
 * Captura o listener de `chrome.storage.onChanged` que o content.js registra.
 * É por ele que as configurações do popup chegam ao HUD — testar por aqui
 * exercita o caminho real (e pega divergência de nome de chave).
 */
let aplicarMudancaDeConfig = null;
const listenerStub = {
  addListener: (fn) => {
    aplicarMudancaDeConfig = fn;
  },
  removeListener: noop,
};

const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  setInterval: () => 0,
  clearInterval: noop,
  Math,
  Date,
  JSON,
  Intl,
  Set,
  Map,
  WeakSet,
  Promise,
  Number,
  String,
  Array,
  Object,
  RegExp,
  Error,
  isNaN,
  parseInt,
  parseFloat,
  encodeURIComponent,
  decodeURIComponent,
  MutationObserver: class {
    observe() {}
    disconnect() {}
  },
  navigator: { clipboard: { writeText: async () => {} } },
  fetch: async () => ({ ok: false, json: async () => ({}) }),
  URL,
  URLSearchParams,
  Blob: class {},
  window: {
    location: { hostname: 'exemplo.test', href: 'https://exemplo.test/', origin: 'https://exemplo.test', search: '' },
    addEventListener: noop,
    open: noop,
    innerWidth: 1280,
    innerHeight: 800,
  },
  document: {
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({ style: {}, classList: { add: noop, remove: noop }, appendChild: noop }),
    getElementById: () => null,
    body: { textContent: '', appendChild: noop },
    title: '',
  },
  chrome: {
    runtime: {
      // Responde imediatamente para que `send()` resolva nos testes.
      sendMessage: (_mensagem, callback) => callback?.({ success: true, history: [] }),
      lastError: null,
    },
    storage: { local: { get: noop, set: noop }, onChanged: listenerStub },
  },
};
sandbox.globalThis = sandbox;
sandbox.history = { pushState: noop, replaceState: noop };

const conteudoContentJs = readFileSync(join(raiz, 'content.js'), 'utf8');

const contexto = createContext(sandbox);
runInContext(conteudoContentJs, contexto, { filename: 'content.js' });

/**
 * Declarações `function` viram propriedades do objeto global (e saem no
 * destructuring abaixo), mas `const`/`let` ficam no escopo léxico global — que
 * é compartilhado entre scripts do mesmo contexto, porém invisível em
 * `sandbox`. Para inspecionar essas constantes, avalia-se uma expressão dentro
 * do próprio contexto.
 */
const lerGlobal = (nome) => runInContext(nome, contexto);

const {
  fmtIdade,
  diasEntre,
  parseNumeroBR,
  parseQuantidadeTexto,
  extrairIdItemDaUrl,
  extrairIdCatalogoDaUrl,
  extrairIdsShopee,
  calcularResultado,
  calcularPontoEquilibrio,
  minerarTermos,
  analisarSeo,
  criarAnaliseVazia,
  normalizarTaxasMl,
  normalizarCustosGlobais,
  extrairTarifasReais,
  rotuloLogistica,
  valorAtributo,
  shopeeParaReais,
  aplicarAnaliseApiShopee,
  absorverPayloadShopee,
  formatarTempoResposta,
  calcularMetricasDerivadas,
} = sandbox;

// ==================================================================
//  1. Parsers de texto brasileiro
// ==================================================================

check('parseNumeroBR lê "R$ 1.234,56"', quaseIgual(parseNumeroBR('R$ 1.234,56'), 1234.56));
check('parseNumeroBR lê "89"', quaseIgual(parseNumeroBR('89'), 89));
check('parseNumeroBR devolve null para texto vazio', parseNumeroBR('') === null);
check('parseQuantidadeTexto lê "+2 mil"', parseQuantidadeTexto('+2 mil') === 2000);
check('parseQuantidadeTexto lê "1.500"', parseQuantidadeTexto('1.500') === 1500);
check('parseQuantidadeTexto lê "50"', parseQuantidadeTexto('50') === 50);

// ==================================================================
//  2. Identificação de anúncio na URL (regressão crítica)
// ==================================================================

const casosUrl = [
  ['https://produto.mercadolivre.com.br/MLB-1234567890-fone-bluetooth-_JM', 'MLB1234567890'],
  ['https://www.mercadolivre.com.br/fone/p/MLB18917349#wid=MLB3959594855&position=1', 'MLB3959594855'],
  ['https://www.mercadolivre.com.br/fone/p/MLB18917349', null],
  ['https://lista.mercadolivre.com.br/fone-bluetooth', null],
  ['https://www.mercadolivre.com.br/x?item_id=MLB2222222222', 'MLB2222222222'],
];

for (const [url, esperado] of casosUrl) {
  const obtido = extrairIdItemDaUrl(url);
  check(`extrairIdItemDaUrl("${url.slice(0, 58)}…")`, obtido === esperado, `esperado ${esperado}, obtido ${obtido}`);
}

check(
  'extrairIdCatalogoDaUrl separa o id de catálogo',
  extrairIdCatalogoDaUrl('https://www.mercadolivre.com.br/fone/p/MLB18917349') === 'MLB18917349',
);

const idsShopee = extrairIdsShopee('https://shopee.com.br/Fone-Bluetooth-i.123456.789012');
check('extrairIdsShopee separa shopId e itemId', idsShopee?.shopId === '123456' && idsShopee?.itemId === '789012');

// ==================================================================
//  3. Datas
// ==================================================================

const ontem = new Date(Date.now() - 86400000).toISOString();
check('diasEntre conta 1 dia', diasEntre(ontem) === 1);
check('diasEntre devolve null sem data', diasEntre(null) === null);
check('fmtIdade formata dias', fmtIdade(5) === '5 dias');
check('fmtIdade formata meses', fmtIdade(90) === '3 meses');
check('fmtIdade formata anos', fmtIdade(400) === '1a 1m');

// ==================================================================
//  4. Calculadora — Mercado Livre com tarifa oficial da API
// ==================================================================

const anuncio = criarAnaliseVazia('meli');
anuncio.preco = 100;
anuncio.tipoAnuncio = 'Clássico';
anuncio.tarifas = { percentual: 0.14, fixo: 6, fonte: 'API' };

// Sem impostos globais configurados o cálculo tem que bater na mão:
// tarifa = 100 × 14% = 14 (sem fixo, pois 100 ≥ limite de 79)
// recebido = 100 − 14 − 10 (frete) = 76 ; lucro = 76 − 40 = 36
let r = calcularResultado(100, 40, 10, anuncio);
check('tarifa ML de R$100 a 14% sem custo fixo', quaseIgual(r.tarifa.valor, 14), `obtido ${r.tarifa.valor}`);
check('valor recebido = 76', quaseIgual(r.valorRecebido, 76), `obtido ${r.valorRecebido}`);
check('lucro = 36', quaseIgual(r.lucro, 36), `obtido ${r.lucro}`);
check('margem = 36%', quaseIgual(r.margem, 36), `obtido ${r.margem}`);
check('ROI = 90%', quaseIgual(r.roi, 90), `obtido ${r.roi}`);
check('markup = 2,5x', quaseIgual(r.markup, 2.5), `obtido ${r.markup}`);

// Abaixo do limite de R$79 a parcela fixa passa a incidir.
r = calcularResultado(50, 20, 0, anuncio);
check('taxa fixa incide abaixo de R$79', quaseIgual(r.tarifa.valor, 50 * 0.14 + 6), `obtido ${r.tarifa.valor}`);

// ==================================================================
//  5. Sincronização de configurações vinda do popup
// ==================================================================

check('content.js registrou o listener de chrome.storage', typeof aplicarMudancaDeConfig === 'function');

// As chaves precisam ser exatamente as que o background grava.
aplicarMudancaDeConfig({ global_costs: { newValue: { imposto: 6, custoFixo: 2 } } }, 'local');
r = calcularResultado(100, 40, 10, anuncio);
// extras = 100 × 6% + 2 = 8 ; lucro = 76 − 40 − 8 = 28
check('impostos globais chegam pela chave "global_costs"', quaseIgual(r.extras, 8), `extras ${r.extras}`);
check('lucro com impostos = 28', quaseIgual(r.lucro, 28), `obtido ${r.lucro}`);

// Taxas do ML sob a chave que o background usa (ml_custom_taxes).
const semTarifaApi = criarAnaliseVazia('meli');
semTarifaApi.preco = 100;
semTarifaApi.tipoAnuncio = 'Premium';
aplicarMudancaDeConfig(
  {
    ml_custom_taxes: {
      newValue: { limiteCustoFixo: 79, custoFixo: 6, taxasPorAnuncio: { Classico: 0.11, Premium: 0.2 } },
    },
  },
  'local',
);
check(
  'taxa customizada do ML chega pela chave "ml_custom_taxes"',
  quaseIgual(calcularResultado(100, 0, 0, semTarifaApi).tarifa.valor, 20),
  `obtido ${calcularResultado(100, 0, 0, semTarifaApi).tarifa.valor}`,
);

// Shopee sob shopee_custom_taxes.
const shopeeCustom = criarAnaliseVazia('shopee');
shopeeCustom.preco = 100;
aplicarMudancaDeConfig({ shopee_custom_taxes: { newValue: { comissao: 0.2, taxaFixa: 4 } } }, 'local');
check(
  'taxa customizada da Shopee chega pela chave "shopee_custom_taxes"',
  quaseIgual(calcularResultado(100, 0, 0, shopeeCustom).tarifa.valor, 24),
);

// Restaura os padrões para os testes seguintes.
aplicarMudancaDeConfig(
  {
    global_costs: { newValue: null },
    ml_custom_taxes: { newValue: null },
    shopee_custom_taxes: { newValue: null },
  },
  'local',
);
check('reset das configurações volta ao padrão', quaseIgual(calcularResultado(100, 40, 10, anuncio).lucro, 36));

// ==================================================================
//  6. Ponto de equilíbrio: no preço devolvido o lucro tem que ser zero
// ==================================================================

// Os três casos cobrem as duas hipóteses da taxa fixa do ML: preço de
// equilíbrio abaixo de R$79 (fixo incide) e acima (não incide).
for (const [custo, frete] of [[40, 10], [15, 0], [200, 25]]) {
  const equilibrio = calcularPontoEquilibrio(custo, frete, anuncio);
  const noEquilibrio = calcularResultado(equilibrio, custo, frete, anuncio);
  check(
    `ponto de equilíbrio zera o lucro (custo ${custo}, frete ${frete})`,
    quaseIgual(noEquilibrio.lucro, 0, 0.02),
    `preço ${equilibrio?.toFixed(2)} → lucro ${noEquilibrio.lucro?.toFixed(4)}`,
  );
}

// Mesma invariante com imposto e custo fixo ativos.
aplicarMudancaDeConfig({ global_costs: { newValue: { imposto: 8, custoFixo: 3.5 } } }, 'local');
const equilibrioComImposto = calcularPontoEquilibrio(60, 12, anuncio);
check(
  'ponto de equilíbrio zera o lucro mesmo com impostos',
  quaseIgual(calcularResultado(equilibrioComImposto, 60, 12, anuncio).lucro, 0, 0.02),
  `preço ${equilibrioComImposto?.toFixed(2)}`,
);
aplicarMudancaDeConfig({ global_costs: { newValue: null } }, 'local');

// ==================================================================
//  7. Calculadora — Shopee
// ==================================================================

const anuncioShopee = criarAnaliseVazia('shopee');
anuncioShopee.preco = 100;
r = calcularResultado(100, 30, 0, anuncioShopee);
// comissão padrão 14% + taxa fixa 3 = 17
check('comissão Shopee = 14% + R$3', quaseIgual(r.tarifa.valor, 17), `obtido ${r.tarifa.valor}`);
check('lucro Shopee = 53', quaseIgual(r.lucro, 53), `obtido ${r.lucro}`);

const equilibrioShopee = calcularPontoEquilibrio(30, 0, anuncioShopee);
check(
  'ponto de equilíbrio Shopee zera o lucro',
  quaseIgual(calcularResultado(equilibrioShopee, 30, 0, anuncioShopee).lucro, 0, 0.02),
);

// ==================================================================
//  8. Normalização de configurações corrompidas
// ==================================================================

check('normalizarTaxasMl recupera de valor nulo', normalizarTaxasMl(null).taxasPorAnuncio.Classico === 0.13);
check('normalizarTaxasMl recupera de objeto inválido', normalizarTaxasMl({ foo: 1 }).custoFixo === 6);
check('normalizarCustosGlobais aceita zero', normalizarCustosGlobais({ imposto: 0, custoFixo: 0 }).imposto === 0);

// ==================================================================
//  9. Tarifas vindas da API de listing_prices
// ==================================================================

const tarifas = extrairTarifasReais(
  [
    { listing_type_id: 'gold_special', sale_fee_details: { percentage_fee: 13.5, fixed_fee: 6 } },
    { listing_type_id: 'gold_pro', sale_fee_details: { percentage_fee: 18.5, fixed_fee: 6 } },
  ],
  'gold_pro',
);
check('extrairTarifasReais escolhe o tipo do anúncio', quaseIgual(tarifas.percentual, 0.185), JSON.stringify(tarifas));
check('extrairTarifasReais marca a origem', tarifas.fonte === 'API');
check('extrairTarifasReais devolve null sem dados', extrairTarifasReais([], 'gold_pro') === null);

// ==================================================================
//  10. Mapeamentos da API
// ==================================================================

check('logística fulfillment vira "Full"', rotuloLogistica({ logistic_type: 'fulfillment' }) === 'Full');
check('logística self_service vira "Flex"', rotuloLogistica({ logistic_type: 'self_service' }) === 'Flex');
check('logística ausente devolve null', rotuloLogistica(null) === null);
check(
  'valorAtributo encontra o GTIN',
  valorAtributo([{ id: 'GTIN', value_name: '7891234567895' }], 'GTIN', 'EAN') === '7891234567895',
);
check('valorAtributo ignora atributo vazio', valorAtributo([{ id: 'GTIN', value_name: null }], 'GTIN') === null);

// ==================================================================
//  11. Mineração de termos das avaliações
// ==================================================================

const termos = minerarTermos([
  { titulo: '', texto: 'A bateria acaba rápido demais', nota: 2 },
  { titulo: '', texto: 'bateria fraca, dura pouco', nota: 1 },
  { titulo: '', texto: 'Bateria péssima', nota: 2 },
]);
check('minerarTermos encontra a dor recorrente', termos[0]?.termo === 'bateria', JSON.stringify(termos));
check('minerarTermos conta as ocorrências', termos[0]?.total === 3);
check('minerarTermos descarta termo único', !termos.some((t) => t.termo === 'demais'));

// ==================================================================
//  12. Diagnóstico de SEO
// ==================================================================

const paraSeo = criarAnaliseVazia('meli');
paraSeo.titulo = 'Fone de Ouvido Bluetooth Sem Fio Esportivo com Microfone e Estojo de Carga Rápida';
paraSeo.atributos = [
  { id: 'BRAND', name: 'Marca', value_name: 'Genérica' },
  { id: 'MODEL', name: 'Modelo', value_name: null },
];
paraSeo.fotos = ['a', 'b'];
const seo = analisarSeo(paraSeo);
check('analisarSeo mede o título', seo.tamanhoTitulo === paraSeo.titulo.length);
check('analisarSeo alerta sobre título longo', seo.alertas.some((a) => a.includes('limite')));
check('analisarSeo conta atributos preenchidos', seo.atributosPreenchidos === 1 && seo.atributosTotal === 2);
check('analisarSeo lista atributos faltantes', seo.atributosFaltando.includes('Modelo'));
check('analisarSeo remove stopwords das palavras-chave', !seo.palavras.includes('com') && seo.palavras.includes('fone'));
check('analisarSeo alerta sobre poucas fotos', seo.alertas.some((a) => a.includes('foto')));

// ==================================================================
//  13. Shopee — conversão de preço e mapeamento da API
// ==================================================================

check('shopeeParaReais divide por 100.000', quaseIgual(shopeeParaReais(2990000000), 29900));
check('shopeeParaReais converte R$ 49,90', quaseIgual(shopeeParaReais(4990000), 49.9));
check('shopeeParaReais ignora zero', shopeeParaReais(0) === null);
check('shopeeParaReais ignora não-número', shopeeParaReais(undefined) === null);

// Payload representativo de /api/v4/item/get.
const itemShopee = {
  itemid: 789012,
  shopid: 123456,
  name: 'Fone Bluetooth TWS',
  price: 4990000, // R$ 49,90
  price_before_discount: 9990000, // R$ 99,90
  sold: 340, // últimos 30 dias
  historical_sold: 12500, // total
  stock: 820,
  liked_count: 4400,
  ctime: 1700000000,
  condition: 1,
  brand: 'Genérica',
  shop_location: 'São Paulo',
  show_free_shipping: true,
  images: ['hash1', 'hash2'],
  video_info_list: [{ default_format: { url: 'https://video.example/v.mp4' } }],
  categories: [{ display_name: 'Eletrônicos' }, { display_name: 'Fones' }],
  attributes: [{ id: 'GTIN', name: 'Código de barras', value: '7891234567895' }],
  models: [
    { name: 'Preto', price: 4990000, stock: 500, sold: 300 },
    { name: 'Branco', price: 5490000, stock: 0, sold: 40 },
  ],
  item_rating: { rating_star: 4.82, rating_count: [1500, 20, 30, 50, 400, 1000] },
};

const lojaShopee = {
  shopid: 123456,
  name: 'Loja Teste',
  account: { username: 'lojateste' },
  follower_count: 98000,
  item_count: 430,
  rating_star: 4.9,
  rating_good: 9000,
  rating_normal: 500,
  rating_bad: 500,
  response_rate: 97,
  response_time: 3600,
  ctime: 1500000000,
  is_official_shop: true,
  shop_location: 'São Paulo',
};

const analiseShopee = criarAnaliseVazia('shopee');
aplicarAnaliseApiShopee(analiseShopee, {
  item: itemShopee,
  loja: lojaShopee,
  avaliacoes: {
    ratings: [
      { rating_star: 2, comment: 'A bateria dura pouco, bateria ruim', ctime: 1700000000 },
      { rating_star: 1, comment: 'bateria fraca demais', ctime: 1700000000 },
      { rating_star: 5, comment: 'Chegou rápido, som excelente', ctime: 1700000000 },
    ],
  },
});

check('Shopee: preço convertido', quaseIgual(analiseShopee.preco, 49.9), `obtido ${analiseShopee.preco}`);
check('Shopee: preço original convertido', quaseIgual(analiseShopee.precoOriginal, 99.9));
check('Shopee: desconto calculado', quaseIgual(analiseShopee.descontoPercent, 50, 0.1));
check('Shopee: vendas 30d vêm de "sold"', analiseShopee.vendas30d === 340);
check('Shopee: origem das vendas é a plataforma', analiseShopee.vendas30dFonte === 'plataforma');
check('Shopee: vendas totais vêm de historical_sold', analiseShopee.vendasTotais === 12500);
check('Shopee: vendas por dia = sold/30', quaseIgual(analiseShopee.vendasPorDia, 340 / 30));
check('Shopee: estoque mapeado', analiseShopee.estoque === 820);
check('Shopee: curtidas mapeadas', analiseShopee.curtidas === 4400);
check('Shopee: EAN extraído dos atributos', analiseShopee.ean === '7891234567895');
check('Shopee: categoria montada', analiseShopee.categoria?.caminho.join(' > ') === 'Eletrônicos > Fones');
check('Shopee: fotos com CDN correto', analiseShopee.fotos[0] === 'https://down-br.img.susercontent.com/file/hash1');
check('Shopee: vídeo mapeado', analiseShopee.video === 'https://video.example/v.mp4');
check('Shopee: 2 variações', analiseShopee.variacoes?.length === 2);
check('Shopee: variação sem estoque preservada', analiseShopee.variacoes[1].estoque === 0);
check('Shopee: nota média', quaseIgual(analiseShopee.avaliacoes.media, 4.82));
check('Shopee: total de avaliações vem do índice 0', analiseShopee.avaliacoes.total === 1500);
check(
  'Shopee: distribuição por estrela (índices 1..5)',
  JSON.stringify(analiseShopee.avaliacoes.distribuicao) === JSON.stringify([20, 30, 50, 400, 1000]),
);
check(
  'Shopee: dores mineradas das notas baixas',
  analiseShopee.avaliacoes.termosNegativos[0]?.termo === 'bateria',
  JSON.stringify(analiseShopee.avaliacoes.termosNegativos),
);
check('Shopee: loja oficial detectada', analiseShopee.vendedor.oficial === true);
check('Shopee: seguidores', analiseShopee.vendedor.seguidores === 98000);
check(
  'Shopee: % positivo = bons/(bons+normais+ruins)',
  quaseIgual(analiseShopee.vendedor.positivo, (9000 / 10000) * 100),
);
check('Shopee: fonte registrada', analiseShopee.fonteDados.includes('API Shopee'));

check('formatarTempoResposta converte 1h', formatarTempoResposta(3600) === '1 h');
check('formatarTempoResposta converte 30min', formatarTempoResposta(1800) === '30 min');
check('formatarTempoResposta lida com zero', formatarTempoResposta(0) === '—');

// Regressão: o cálculo de métricas derivadas não pode sobrescrever o número
// exato de 30 dias da Shopee pela média de vida inteira do anúncio.
await calcularMetricasDerivadas(analiseShopee);
check('Shopee: vendas 30d sobrevivem às métricas derivadas', analiseShopee.vendas30d === 340);
check('Shopee: origem continua "plataforma"', analiseShopee.vendas30dFonte === 'plataforma');
check(
  'Shopee: vendas/dia não vira média de vida inteira',
  quaseIgual(analiseShopee.vendasPorDia, 340 / 30),
  `obtido ${analiseShopee.vendasPorDia}`,
);
check(
  'Shopee: faturamento 30d = preço × vendas 30d',
  quaseIgual(analiseShopee.faturamento30d, 49.9 * 340, 0.5),
  `obtido ${analiseShopee.faturamento30d}`,
);
check(
  'Shopee: faturamento total usa as vendas acumuladas',
  quaseIgual(analiseShopee.faturamentoTotal, 49.9 * 12500, 1),
);

// O caminho do Mercado Livre (sem vendas informadas) continua estimando.
const anuncioMl = criarAnaliseVazia('meli');
anuncioMl.preco = 100;
anuncioMl.vendasTotais = 600;
anuncioMl.dataCriacao = new Date(Date.now() - 60 * 86400000).toISOString();
await calcularMetricasDerivadas(anuncioMl);
check('ML: vendas 30d estimadas por idade', anuncioMl.vendas30d === 300, `obtido ${anuncioMl.vendas30d}`);
check('ML: origem marcada como estimada', anuncioMl.vendas30dFonte === 'estimado');

// ==================================================================
//  14. Shopee — ponte com o mundo MAIN
// ==================================================================

absorverPayloadShopee('item', { data: { itemid: 555, shopid: 111, name: 'Item da ponte' } });
absorverPayloadShopee('busca', {
  items: [
    { item_basic: { itemid: 777, shopid: 222, name: 'Card 1', price: 1990000, sold: 12 } },
    { item_basic: { itemid: 888, shopid: 222, name: 'Card 2', price: 2990000, sold: 45 } },
  ],
});
absorverPayloadShopee('loja', { data: { shopid: 222, name: 'Loja da ponte' } });

const cachePonte = lerGlobal('shopeeCache');
check('ponte guarda o item capturado', cachePonte.itens.get('555')?.name === 'Item da ponte');
check('ponte guarda os cards da busca', cachePonte.buscas.size === 2);
check('ponte indexa a busca por itemid', cachePonte.buscas.get('888')?.sold === 45);
check('ponte guarda a loja', cachePonte.lojas.get('222')?.name === 'Loja da ponte');

// O bridge roda no mundo MAIN: não pode depender de chrome.* nem vazar dados.
const fonteBridge = readFileSync(join(raiz, 'shopee-bridge.js'), 'utf8');
check('bridge não usa chrome.*', !/\bchrome\./.test(fonteBridge));
check('bridge não faz postMessage para "*"', !/postMessage\([^)]*['"]\*['"]/.test(fonteBridge));
check('bridge usa response.clone() para não consumir o body', fonteBridge.includes('.clone()'));
check('bridge preserva o retorno do fetch original', /return resposta;/.test(fonteBridge));
check('bridge delega ao send/open originais', /return enviarOriginal\.apply/.test(fonteBridge));

// A ponte sobe em document_start e o content script em document_idle: sem o
// buffer + replay, as primeiras respostas da Shopee se perderiam.
check('bridge mantém histórico das capturas', /historico\.push/.test(fonteBridge));
check('bridge limita o histórico', /historico\.shift\(\)/.test(fonteBridge));
check('bridge responde ao pedido de replay', fonteBridge.includes('shopee-replay'));
check('content.js pede o replay ao rotear', /solicitarReplayShopee\(\)/.test(conteudoContentJs));

// O badge não pode disparar a navegação do card (que é um link).
check(
  'badge cancela o clique para não abrir o anúncio',
  /click:\s*\(evento\)\s*=>\s*\{[\s\S]{0,120}preventDefault/.test(conteudoContentJs),
);

// ==================================================================
//  15. EAN-13 do popup (validado no código publicado)
// ==================================================================

const popupSrc = readFileSync(join(raiz, 'popup.js'), 'utf8');
const trechoEan = popupSrc.slice(
  popupSrc.indexOf('function digitoVerificadorEan'),
  popupSrc.indexOf('function renderEanList'),
);
const sandboxEan = createContext({ Math, Number });
runInContext(`${trechoEan}; globalThis.__gerar = gerarEan13; globalThis.__dv = digitoVerificadorEan;`, sandboxEan);

check('dígito verificador do EAN 4006381333931', sandboxEan.__dv('400638133393') === 1);
check('dígito verificador do EAN 7891234567895', sandboxEan.__dv('789123456789') === 5);

let todosValidos = true;
for (let i = 0; i < 200; i += 1) {
  const ean = sandboxEan.__gerar();
  if (ean.length !== 13 || !ean.startsWith('789') || sandboxEan.__dv(ean.slice(0, 12)) !== Number(ean[12])) {
    todosValidos = false;
    break;
  }
}
check('200 EANs gerados são válidos e com prefixo 789', todosValidos);

// ==================================================================
//  Relatório
// ==================================================================

console.log(`\n✔ ${passou} testes passaram`);
for (const falha of falhas) console.log(`✖ ${falha}`);

if (falhas.length) {
  console.log(`\n${falhas.length} teste(s) falharam.\n`);
  process.exit(1);
}
console.log('\nTodos os testes passaram.\n');
