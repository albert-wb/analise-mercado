/**
 * popup.js — Analisador Pro v8.0
 *
 * Toda a UI é montada com `el()`/textContent. Nada de innerHTML: títulos de
 * anúncio e sugestões de busca vêm de terceiros e não podem virar markup.
 */

// ==================================================================
//  DEFAULTS
// ==================================================================

const DEFAULT_TAXES = {
  limiteCustoFixo: 79.0,
  custoFixo: 6.0,
  taxasPorAnuncio: { Classico: 0.13, Premium: 0.18 },
};

const DEFAULT_SHOPEE_TAXES = { comissao: 0.14, taxaFixa: 3.0 };
const DEFAULT_GLOBAL_COSTS = { imposto: 0, custoFixo: 0 };

// ==================================================================
//  HELPERS
// ==================================================================

const $ = (id) => document.getElementById(id);

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  if (props.className) node.className = props.className;
  if (props.text !== undefined && props.text !== null) node.textContent = String(props.text);
  if (props.title) node.title = props.title;
  if (props.dataset) for (const [k, v] of Object.entries(props.dataset)) node.dataset[k] = v;
  if (props.attrs) for (const [k, v] of Object.entries(props.attrs)) node.setAttribute(k, v);
  if (props.on) for (const [evt, fn] of Object.entries(props.on)) node.addEventListener(evt, fn);
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

function replaceChildren(container, ...nodes) {
  while (container.firstChild) container.removeChild(container.firstChild);
  for (const node of nodes.flat()) if (node) container.appendChild(node);
}

function send(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ success: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response || { success: false, error: 'Sem resposta do service worker.' });
    });
  });
}

const fmtMoeda = (valor) =>
  typeof valor === 'number' && Number.isFinite(valor)
    ? valor.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
    : '—';

const fmtNumero = (valor) =>
  typeof valor === 'number' && Number.isFinite(valor) ? valor.toLocaleString('pt-BR') : '—';

let messageTimer = null;

function showMessage(texto, tipo = 'success') {
  const node = $('popupMessage');
  node.textContent = texto;
  node.className = `popup-message ${tipo}`;
  clearTimeout(messageTimer);
  messageTimer = setTimeout(() => {
    node.className = 'popup-message';
  }, 4000);
}

/** Feedback visual efêmero em um botão de ação. */
async function copiarComFeedback(texto, botao, rotuloOk = '✅') {
  try {
    await navigator.clipboard.writeText(texto);
  } catch {
    showMessage('Não foi possível acessar a área de transferência.', 'error');
    return;
  }
  if (!botao) return;
  const original = botao.textContent;
  botao.textContent = rotuloOk;
  botao.classList.add('ok');
  setTimeout(() => {
    botao.textContent = original;
    botao.classList.remove('ok');
  }, 1400);
}

// ==================================================================
//  ABAS
// ==================================================================

for (const botao of document.querySelectorAll('.tab-btn')) {
  botao.addEventListener('click', () => {
    for (const outro of document.querySelectorAll('.tab-btn')) outro.classList.remove('active');
    for (const painel of document.querySelectorAll('.tab-content')) painel.classList.remove('active');
    botao.classList.add('active');
    $(`tab-content-${botao.dataset.tab}`)?.classList.add('active');
  });
}

// ==================================================================
//  AUTENTICAÇÃO
// ==================================================================

async function checkAuthStatus() {
  const resposta = await send({ type: 'getAuthStatus' });

  const aplicar = (estado, rotulo, detalhe, mostrarLogin) => {
    $('authDot').className = `auth-dot ${estado}`;
    $('authLabel').textContent = rotulo;
    $('authDetail').textContent = detalhe;
    $('loginButton').hidden = !mostrarLogin;
    $('logoutButton').hidden = mostrarLogin;
  };

  if (!resposta.success && !resposta.status) {
    aplicar('offline', 'Desconectado', 'Falha de comunicação', true);
    return;
  }

  if (resposta.status === 'logged_in') {
    const minutos = Math.floor(resposta.expiresIn / 60);
    const horas = Math.floor(minutos / 60);
    const detalhe = horas > 0 ? `${horas}h ${minutos % 60}m restantes` : `${minutos}m restantes`;
    aplicar('online', 'Conectado', detalhe, false);
  } else if (resposta.status === 'expired') {
    aplicar(
      'expired',
      'Token expirado',
      resposta.canRefresh ? 'Renovando automaticamente…' : 'Faça login novamente',
      !resposta.canRefresh,
    );
  } else {
    aplicar('offline', 'Desconectado', 'Clique para autenticar', true);
  }
}

$('loginButton').addEventListener('click', async () => {
  const botao = $('loginButton');
  botao.disabled = true;
  replaceChildren(botao, el('span', { className: 'loading-spinner' }), ' CONECTANDO…');

  const resposta = await send({ type: 'login' });

  botao.disabled = false;
  botao.textContent = '▶ Conectar com o Mercado Livre';

  if (resposta.success) {
    showMessage('Login realizado com sucesso!');
  } else {
    showMessage(resposta.error || 'Falha no login.', 'error');
  }
  checkAuthStatus();
});

$('logoutButton').addEventListener('click', async () => {
  const resposta = await send({ type: 'logout' });
  showMessage(resposta.success ? 'Desconectado.' : 'Erro ao desconectar.', resposta.success ? 'success' : 'error');
  checkAuthStatus();
});

// ==================================================================
//  GARIMPO
// ==================================================================

function montarItemGarimpo(item) {
  const plataforma = (item.plataforma || 'meli').toLowerCase();
  const data = item.timestamp
    ? new Date(item.timestamp).toLocaleDateString('pt-BR', {
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '';

  const meta = [
    el('span', { text: `💲 ${fmtMoeda(item.preco)}` }),
    item.vendas30d != null
      ? el('span', { text: `📈 ${fmtNumero(item.vendas30d)}/30d` })
      : el('span', { text: `📦 ${fmtNumero(item.vendas)} vendas` }),
    item.margem != null
      ? el('span', {
          className: item.margem >= 0 ? 'lucro-pos' : 'lucro-neg',
          text: `${item.margem >= 0 ? '▲' : '▼'} ${item.margem.toFixed(1)}%`,
          title: `Lucro por venda: ${fmtMoeda(item.lucro)}`,
        })
      : null,
    item.sellerNick ? el('span', { text: `🏪 ${item.sellerNick}` }) : null,
    data ? el('span', { text: `📅 ${data}` }) : null,
  ].filter(Boolean);

  const titulo = el('div', {
    className: 'garimpo-item-title',
    text: item.titulo || 'Sem título',
    title: item.titulo || '',
    on: {
      click: () => {
        if (item.url) chrome.tabs.create({ url: item.url });
      },
    },
  });

  return el('div', { className: 'garimpo-item' }, [
    el('span', {
      className: `garimpo-platform ${plataforma === 'shopee' ? 'shopee' : 'meli'}`,
      text: plataforma === 'shopee' ? 'SHP' : 'ML',
    }),
    el('div', { className: 'garimpo-item-body' }, [titulo, el('div', { className: 'garimpo-item-meta' }, meta)]),
    el('button', {
      className: 'garimpo-delete',
      text: '✕',
      title: 'Remover',
      on: {
        click: async () => {
          const resposta = await send({ type: 'removeGarimpoItem', itemId: item.id });
          if (resposta.success) loadGarimpoList();
        },
      },
    }),
  ]);
}

async function loadGarimpoList() {
  const resposta = await send({ type: 'getGarimpoList' });
  const itens = resposta.success ? resposta.items || [] : [];
  const container = $('garimpoContainer');

  $('garimpoCount').textContent = itens.length ? `${itens.length} item${itens.length > 1 ? 's' : ''}` : '';
  $('garimpoActions').hidden = itens.length === 0;

  if (!itens.length) {
    replaceChildren(
      container,
      el('div', { className: 'garimpo-empty' }, [
        el('span', { className: 'garimpo-empty-icon', text: '📭' }),
        'Nenhum produto salvo.',
        el('br'),
        'Use o botão ⭐ Garimpo no HUD do anúncio.',
      ]),
    );
    return;
  }

  replaceChildren(container, itens.map(montarItemGarimpo));
}

/** Uma célula CSV com escape de aspas e separador. */
function csvCell(valor) {
  if (valor === null || valor === undefined) return '';
  const texto = String(valor);
  return /[";\n]/.test(texto) ? `"${texto.replace(/"/g, '""')}"` : texto;
}

$('exportCsvBtn').addEventListener('click', async () => {
  const resposta = await send({ type: 'getGarimpoList' });
  const itens = resposta.success ? resposta.items || [] : [];

  if (!itens.length) {
    showMessage('Nenhum item para exportar.', 'error');
    return;
  }

  const colunas = [
    ['Plataforma', (i) => i.plataforma],
    ['Título', (i) => i.titulo],
    ['URL', (i) => i.url],
    ['ID', (i) => i.itemId],
    ['Preço', (i) => i.preco],
    ['Preço original', (i) => i.precoOriginal],
    ['Vendas totais', (i) => i.vendas],
    ['Vendas 30d', (i) => i.vendas30d],
    ['Vendas/dia', (i) => (i.vendasPorDia != null ? i.vendasPorDia.toFixed(2) : '')],
    ['Faturamento 30d', (i) => i.faturamento30d],
    ['Estoque', (i) => i.estoque],
    ['Visitas 30d', (i) => i.visitas30d],
    ['Conversão %', (i) => (i.conversao != null ? i.conversao.toFixed(2) : '')],
    ['Tipo de anúncio', (i) => i.tipoAnuncio],
    ['Logística', (i) => i.logistica],
    ['Frete grátis', (i) => (i.freteGratis ? 'Sim' : 'Não')],
    ['EAN', (i) => i.ean],
    ['Marca', (i) => i.marca],
    ['Categoria', (i) => i.categoria],
    ['Idade (dias)', (i) => i.idadeDias],
    ['Criado em', (i) => i.dataCriacao],
    ['Qualidade da ficha', (i) => (i.saudeFicha != null ? Math.round(i.saudeFicha * 100) : '')],
    ['Nota', (i) => i.nota],
    ['Avaliações', (i) => i.totalAvaliacoes],
    ['Vendedor', (i) => i.sellerNick],
    ['Reputação', (i) => i.sellerReputacao],
    ['Anúncios do vendedor', (i) => i.sellerAnuncios],
    ['Custo produto', (i) => i.custoProduto],
    ['Custo frete', (i) => i.custoFrete],
    ['Lucro', (i) => (i.lucro != null ? i.lucro.toFixed(2) : '')],
    ['Margem %', (i) => (i.margem != null ? i.margem.toFixed(2) : '')],
    ['Salvo em', (i) => i.timestamp],
  ];

  const linhas = [
    colunas.map(([titulo]) => csvCell(titulo)).join(';'),
    ...itens.map((item) => colunas.map(([, get]) => csvCell(get(item))).join(';')),
  ];

  // BOM para o Excel reconhecer UTF-8; ";" como separador no padrão pt-BR.
  const blob = new Blob([`﻿${linhas.join('\r\n')}`], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = el('a', { attrs: { href: url, download: `garimpo_${new Date().toISOString().slice(0, 10)}.csv` } });
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);

  showMessage(`${itens.length} itens exportados.`);
});

$('clearGarimpoBtn').addEventListener('click', async () => {
  if (!confirm('Remover todos os itens salvos no Garimpo?')) return;
  const resposta = await send({ type: 'clearGarimpo' });
  if (resposta.success) {
    showMessage('Garimpo limpo.');
    loadGarimpoList();
  } else {
    showMessage('Erro ao limpar o Garimpo.', 'error');
  }
});

// ==================================================================
//  CONFIGURAÇÕES
// ==================================================================

function numeroDoCampo(id, padrao) {
  const valor = parseFloat($(id).value);
  return Number.isFinite(valor) ? valor : padrao;
}

async function loadTaxConfig() {
  const resposta = await send({ type: 'getCustomTaxes' });
  const taxas = resposta.success && resposta.taxes?.taxasPorAnuncio ? resposta.taxes : DEFAULT_TAXES;
  $('taxClassico').value = ((taxas.taxasPorAnuncio.Classico ?? 0.13) * 100).toFixed(1);
  $('taxPremium').value = ((taxas.taxasPorAnuncio.Premium ?? 0.18) * 100).toFixed(1);
  $('taxCustoFixo').value = (taxas.custoFixo ?? 6).toFixed(2);
  $('taxLimiteCusto').value = (taxas.limiteCustoFixo ?? 79).toFixed(2);
}

$('saveTaxesBtn').addEventListener('click', async () => {
  const taxes = {
    limiteCustoFixo: numeroDoCampo('taxLimiteCusto', 79),
    custoFixo: numeroDoCampo('taxCustoFixo', 6),
    taxasPorAnuncio: {
      Classico: numeroDoCampo('taxClassico', 13) / 100,
      Premium: numeroDoCampo('taxPremium', 18) / 100,
    },
  };
  const resposta = await send({ type: 'saveCustomTaxes', taxes });
  showMessage(resposta.success ? 'Taxas do Mercado Livre salvas.' : 'Erro ao salvar.', resposta.success ? 'success' : 'error');
});

$('resetTaxesBtn').addEventListener('click', async () => {
  const resposta = await send({ type: 'saveCustomTaxes', taxes: null });
  if (resposta.success) {
    await loadTaxConfig();
    showMessage('Taxas restauradas ao padrão.');
  }
});

async function loadShopeeTaxConfig() {
  const resposta = await send({ type: 'getShopeeCustomTaxes' });
  const taxas = resposta.success && resposta.taxes ? resposta.taxes : DEFAULT_SHOPEE_TAXES;
  $('shopeeComissao').value = ((taxas.comissao ?? 0.14) * 100).toFixed(1);
  $('shopeeTaxaFixa').value = (taxas.taxaFixa ?? 3).toFixed(2);
}

$('saveShopeeBtn').addEventListener('click', async () => {
  const taxes = {
    comissao: numeroDoCampo('shopeeComissao', 14) / 100,
    taxaFixa: numeroDoCampo('shopeeTaxaFixa', 3),
  };
  const resposta = await send({ type: 'saveShopeeCustomTaxes', taxes });
  showMessage(resposta.success ? 'Taxas da Shopee salvas.' : 'Erro ao salvar.', resposta.success ? 'success' : 'error');
});

$('resetShopeeBtn').addEventListener('click', async () => {
  const resposta = await send({ type: 'saveShopeeCustomTaxes', taxes: null });
  if (resposta.success) {
    await loadShopeeTaxConfig();
    showMessage('Taxas da Shopee restauradas.');
  }
});

async function loadGlobalCosts() {
  const resposta = await send({ type: 'getGlobalCosts' });
  const custos = resposta.success && resposta.costs ? resposta.costs : DEFAULT_GLOBAL_COSTS;
  $('impostoGlobal').value = Number(custos.imposto ?? 0).toFixed(1);
  $('custoFixoGlobal').value = Number(custos.custoFixo ?? 0).toFixed(2);
}

$('saveGlobalCostsBtn').addEventListener('click', async () => {
  const costs = {
    imposto: numeroDoCampo('impostoGlobal', 0),
    custoFixo: numeroDoCampo('custoFixoGlobal', 0),
  };
  const resposta = await send({ type: 'saveGlobalCosts', costs });
  showMessage(resposta.success ? 'Impostos e custos salvos.' : 'Erro ao salvar.', resposta.success ? 'success' : 'error');
});

$('resetGlobalCostsBtn').addEventListener('click', async () => {
  const resposta = await send({ type: 'saveGlobalCosts', costs: null });
  if (resposta.success) {
    await loadGlobalCosts();
    showMessage('Impostos zerados.');
  }
});

// --- Credenciais OAuth -------------------------------------------

async function loadOAuthConfig() {
  const [config, redirect] = await Promise.all([
    send({ type: 'getOAuthConfig' }),
    send({ type: 'getRedirectUri' }),
  ]);

  if (config.success && config.isCustom) $('oauthClientId').value = config.clientId || '';
  if (redirect.success) $('redirectUri').textContent = redirect.redirectUri;
}

$('saveOAuthBtn').addEventListener('click', async () => {
  const clientId = $('oauthClientId').value.trim();
  const clientSecret = $('oauthClientSecret').value.trim();

  if (!clientId || !clientSecret) {
    showMessage('Informe Client ID e Client Secret.', 'error');
    return;
  }

  const resposta = await send({ type: 'saveOAuthConfig', config: { clientId, clientSecret } });
  if (resposta.success) {
    $('oauthClientSecret').value = '';
    showMessage('Credenciais salvas. Faça login novamente.');
    checkAuthStatus();
  } else {
    showMessage(resposta.error || 'Erro ao salvar credenciais.', 'error');
  }
});

$('resetOAuthBtn').addEventListener('click', async () => {
  const resposta = await send({ type: 'saveOAuthConfig', config: null });
  if (resposta.success) {
    $('oauthClientId').value = '';
    $('oauthClientSecret').value = '';
    showMessage('Credenciais padrão restauradas. Faça login novamente.');
    checkAuthStatus();
  }
});

// ==================================================================
//  GERADOR DE EAN-13
// ==================================================================

let eansGerados = [];

function digitoVerificadorEan(codigo12) {
  let soma = 0;
  for (let i = 0; i < 12; i += 1) {
    const digito = Number(codigo12[i]);
    soma += i % 2 === 0 ? digito : digito * 3;
  }
  return (10 - (soma % 10)) % 10;
}

function gerarEan13() {
  // 789 é o prefixo GS1 do Brasil.
  let corpo = '789';
  for (let i = 0; i < 9; i += 1) corpo += Math.floor(Math.random() * 10);
  return corpo + digitoVerificadorEan(corpo);
}

function renderEanList() {
  const lista = $('eanResultsList');
  $('copyAllEanBtn').hidden = eansGerados.length === 0;

  if (!eansGerados.length) {
    replaceChildren(lista, el('div', { className: 'tools-list-empty', text: 'Nenhum EAN gerado ainda.' }));
    return;
  }

  replaceChildren(
    lista,
    eansGerados.map((ean) => {
      const botao = el('button', { className: 'item-action-btn', text: '📋 Copiar' });
      botao.addEventListener('click', () => copiarComFeedback(ean, botao, '✅ Copiado'));
      return el('div', { className: 'list-item' }, [
        el('span', { className: 'ean-value', text: ean }),
        el('div', { className: 'item-actions' }, [botao]),
      ]);
    }),
  );
}

$('generateEanBtn').addEventListener('click', () => {
  const quantidade = parseInt($('eanQtySelect').value, 10) || 1;
  eansGerados = Array.from({ length: quantidade }, gerarEan13);
  renderEanList();
});

$('copyAllEanBtn').addEventListener('click', () => {
  if (!eansGerados.length) return;
  copiarComFeedback(eansGerados.join('\n'), $('copyAllEanBtn'), '✅ Todos copiados');
});

// ==================================================================
//  SEO — SUGESTÕES DE BUSCA
// ==================================================================

let plataformaSeo = 'ml';
let debounceSeo = null;

for (const botao of document.querySelectorAll('.platform-toggle-btn')) {
  botao.addEventListener('click', () => {
    for (const outro of document.querySelectorAll('.platform-toggle-btn')) outro.classList.remove('active');
    botao.classList.add('active');
    plataformaSeo = botao.dataset.platform;
    buscarSugestoes();
  });
}

$('seoQueryInput').addEventListener('input', () => {
  clearTimeout(debounceSeo);
  debounceSeo = setTimeout(buscarSugestoes, 320);
});

async function buscarSugestoes() {
  const lista = $('seoResultsList');
  const termo = $('seoQueryInput').value.trim();

  if (!termo) {
    replaceChildren(lista, el('div', { className: 'tools-list-empty', text: 'Digite algo para ver as sugestões reais de busca.' }));
    return;
  }

  replaceChildren(
    lista,
    el('div', { className: 'tools-list-empty' }, [el('span', { className: 'loading-spinner' }), ' Buscando…']),
  );

  const resposta = await send({
    type: plataformaSeo === 'ml' ? 'fetchMlSuggestions' : 'fetchShopeeSuggestions',
    query: termo,
  });

  if (!resposta.success) {
    replaceChildren(
      lista,
      el('div', { className: 'tools-list-empty', text: `Não foi possível carregar as sugestões: ${resposta.error}` }),
    );
    return;
  }

  const sugestoes = resposta.suggestions || [];
  if (!sugestoes.length) {
    replaceChildren(lista, el('div', { className: 'tools-list-empty', text: 'Nenhuma sugestão encontrada.' }));
    return;
  }

  replaceChildren(
    lista,
    sugestoes.map((palavra) => {
      const copiar = el('button', { className: 'item-action-btn', text: '📋' , title: 'Copiar termo' });
      copiar.addEventListener('click', () => copiarComFeedback(palavra, copiar, '✅'));

      const buscar = el('button', {
        className: 'item-action-btn',
        text: '🔍',
        title: 'Abrir busca com este termo',
        on: {
          click: () => {
            const url =
              plataformaSeo === 'ml'
                ? `https://lista.mercadolivre.com.br/${encodeURIComponent(palavra)}`
                : `https://shopee.com.br/search?keyword=${encodeURIComponent(palavra)}`;
            chrome.tabs.create({ url });
          },
        },
      });

      return el('div', { className: 'list-item' }, [
        el('span', { className: 'keyword-text', text: palavra, title: palavra }),
        el('div', { className: 'item-actions' }, [copiar, buscar]),
      ]);
    }),
  );
}

// ==================================================================
//  INICIALIZAÇÃO
// ==================================================================

$('versionLabel').textContent = `v${chrome.runtime.getManifest().version}`;

checkAuthStatus();
loadGarimpoList();
loadTaxConfig();
loadShopeeTaxConfig();
loadGlobalCosts();
loadOAuthConfig();
