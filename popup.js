// popup.js — Analisador de Produtos v7.3 (ML + Shopee + Garimpo)

const DEFAULT_TAXES = {
  limiteCustoFixo: 79.0,
  custoFixo: 6.0,
  taxasPorAnuncio: { Classico: 0.13, Premium: 0.18 },
};

const DEFAULT_SHOPEE_TAXES = {
  comissao: 0.14,
  taxaFixa: 3.0,
};

// ==================================================================
//  ELEMENTOS DOM
// ==================================================================

const authDot = document.getElementById('authDot');
const authLabel = document.getElementById('authLabel');
const authDetail = document.getElementById('authDetail');
const loginButton = document.getElementById('loginButton');
const logoutButton = document.getElementById('logoutButton');
const popupMessage = document.getElementById('popupMessage');
const saveTaxesBtn = document.getElementById('saveTaxesBtn');
const resetTaxesBtn = document.getElementById('resetTaxesBtn');
const saveShopeeBtn = document.getElementById('saveShopeeBtn');
const resetShopeeBtn = document.getElementById('resetShopeeBtn');
const exportCsvBtn = document.getElementById('exportCsvBtn');
const clearGarimpoBtn = document.getElementById('clearGarimpoBtn');

// ==================================================================
//  STATUS DE AUTENTICAÇÃO
// ==================================================================

function checkAuthStatus() {
  chrome.runtime.sendMessage({ type: 'getAuthStatus' }, (response) => {
    if (chrome.runtime.lastError || !response) {
      setAuthUI('offline', 'Desconectado', 'Erro na comunicação');
      loginButton.style.display = 'block';
      logoutButton.style.display = 'none';
      return;
    }

    if (response.status === 'logged_in') {
      const minutes = Math.floor(response.expiresIn / 60);
      const hours = Math.floor(minutes / 60);
      const timeStr = hours > 0 ? `${hours}h ${minutes % 60}m restantes` : `${minutes}m restantes`;
      setAuthUI('online', 'Conectado', timeStr);
      loginButton.style.display = 'none';
      logoutButton.style.display = 'block';
    } else if (response.status === 'expired') {
      setAuthUI('expired', 'Token Expirado', response.canRefresh ? 'Renovação disponível' : 'Faça login novamente');
      loginButton.style.display = 'block';
      logoutButton.style.display = 'none';
    } else {
      setAuthUI('offline', 'Desconectado', 'Clique para autenticar');
      loginButton.style.display = 'block';
      logoutButton.style.display = 'none';
    }
  });
}

function setAuthUI(status, label, detail) {
  authDot.className = `auth-dot ${status}`;
  authLabel.textContent = label;
  authDetail.textContent = detail;
}

function showMessage(text, type) {
  popupMessage.textContent = text;
  popupMessage.className = `popup-message ${type}`;
  setTimeout(() => {
    popupMessage.className = 'popup-message';
  }, 4000);
}

// ==================================================================
//  LOGIN / LOGOUT
// ==================================================================

loginButton.addEventListener('click', () => {
  loginButton.disabled = true;
  loginButton.innerHTML = '<span class="loading-spinner"></span> CONECTANDO...';

  chrome.runtime.sendMessage({ type: 'login' }, (response) => {
    loginButton.disabled = false;
    loginButton.innerHTML = '▶ LOGIN COM MERCADO LIVRE';

    if (chrome.runtime.lastError || !response) {
      showMessage('Erro na comunicação com a extensão.', 'error');
      return;
    }

    if (response.success) {
      showMessage('Login realizado com sucesso!', 'success');
      checkAuthStatus();
    } else {
      showMessage(response.error || 'Falha no login.', 'error');
    }
  });
});

logoutButton.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'logout' }, (response) => {
    if (response?.success) {
      showMessage('Desconectado com sucesso.', 'success');
      checkAuthStatus();
    } else {
      showMessage('Erro ao desconectar.', 'error');
    }
  });
});

// ==================================================================
//  GARIMPO — LISTA DE PRODUTOS SALVOS
// ==================================================================

function loadGarimpoList() {
  chrome.runtime.sendMessage({ type: 'getGarimpoList' }, (response) => {
    if (chrome.runtime.lastError || !response) return;

    const items = response.items || [];
    const container = document.getElementById('garimpoContainer');
    const emptyState = document.getElementById('garimpoEmpty');
    const actions = document.getElementById('garimpoActions');
    const countEl = document.getElementById('garimpoCount');

    if (items.length === 0) {
      emptyState.style.display = 'block';
      actions.style.display = 'none';
      countEl.textContent = '';
      return;
    }

    emptyState.style.display = 'none';
    actions.style.display = 'flex';
    countEl.textContent = `${items.length} item${items.length > 1 ? 's' : ''}`;

    // Build items HTML
    const html = items.map((item) => {
      const plataforma = (item.plataforma || 'meli').toLowerCase();
      const platformLabel = plataforma === 'shopee' ? 'Shopee' : 'ML';
      const platformClass = plataforma === 'shopee' ? 'shopee' : 'meli';
      const preco = typeof item.preco === 'number'
        ? item.preco.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
        : 'N/A';
      const vendas = typeof item.vendas === 'number'
        ? item.vendas.toLocaleString('pt-BR')
        : '0';
      const date = item.timestamp
        ? new Date(item.timestamp).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
        : '';

      return `
        <div class="garimpo-item" data-id="${item.id}">
          <span class="garimpo-platform ${platformClass}">${platformLabel}</span>
          <div class="garimpo-item-body">
            <div class="garimpo-item-title" title="${item.titulo || ''}" data-url="${item.url || ''}">${item.titulo || 'Sem título'}</div>
            <div class="garimpo-item-meta">
              <span>💲 ${preco}</span>
              <span>📦 ${vendas} vendas</span>
              <span>📅 ${date}</span>
            </div>
          </div>
          <button class="garimpo-delete" title="Remover" data-id="${item.id}">✕</button>
        </div>
      `;
    }).join('');

    // Keep empty state element but add items before it
    container.innerHTML = html + '<div class="garimpo-empty" id="garimpoEmpty" style="display:none;"><span class="garimpo-empty-icon">📭</span>Nenhum produto salvo.<br>Use o botão ⭐ Garimpo no HUD.</div>';

    // Attach click listeners for titles (open URL) and delete buttons
    container.querySelectorAll('.garimpo-item-title').forEach((el) => {
      el.addEventListener('click', () => {
        const url = el.dataset.url;
        if (url) chrome.tabs.create({ url });
      });
    });

    container.querySelectorAll('.garimpo-delete').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.id;
        chrome.runtime.sendMessage({ type: 'removeGarimpoItem', itemId: id }, (res) => {
          if (res?.success) loadGarimpoList();
        });
      });
    });
  });
}

// Export CSV
exportCsvBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'getGarimpoList' }, (response) => {
    if (chrome.runtime.lastError || !response) return;

    const items = response.items || [];
    if (items.length === 0) {
      showMessage('Nenhum item para exportar.', 'error');
      return;
    }

    const headers = [
      'Plataforma', 'Título', 'URL', 'Preço', 'Vendas', 'Volume Bruto',
      'Tipo Anúncio', 'EAN', 'Frete Grátis', 'Custo Produto', 'Custo Frete',
      'Vendedor', 'Data'
    ];

    const rows = items.map((item) => [
      item.plataforma || 'meli',
      `"${(item.titulo || '').replace(/"/g, '""')}"`,
      item.url || '',
      item.preco || 0,
      item.vendas || 0,
      item.volumeBruto || 0,
      item.tipoAnuncio || 'N/A',
      item.ean || 'N/A',
      item.freteGratis ? 'Sim' : 'Não',
      item.custoProduto || 0,
      item.custoFrete || 0,
      item.sellerNick || '',
      item.timestamp || ''
    ]);

    const csvContent = [headers.join(';'), ...rows.map(r => r.join(';'))].join('\n');
    const bom = '\uFEFF'; // UTF-8 BOM for Excel compatibility
    const blob = new Blob([bom + csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `garimpo_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);

    showMessage(`${items.length} itens exportados com sucesso!`, 'success');
  });
});

// Clear all
clearGarimpoBtn.addEventListener('click', () => {
  if (!confirm('Tem certeza que deseja limpar todos os itens do Garimpo?')) return;

  chrome.runtime.sendMessage({ type: 'clearGarimpo' }, (response) => {
    if (response?.success) {
      showMessage('Garimpo limpo com sucesso!', 'success');
      loadGarimpoList();
    } else {
      showMessage('Erro ao limpar o Garimpo.', 'error');
    }
  });
});

// ==================================================================
//  CONFIGURAÇÃO DE TAXAS — MERCADO LIVRE
// ==================================================================

function loadTaxConfig() {
  chrome.runtime.sendMessage({ type: 'getCustomTaxes' }, (response) => {
    if (chrome.runtime.lastError || !response) return;

    const taxes = response.taxes || DEFAULT_TAXES;
    document.getElementById('taxClassico').value = (taxes.taxasPorAnuncio.Classico * 100).toFixed(1);
    document.getElementById('taxPremium').value = (taxes.taxasPorAnuncio.Premium * 100).toFixed(1);
    document.getElementById('taxCustoFixo').value = taxes.custoFixo.toFixed(2);
    document.getElementById('taxLimiteCusto').value = taxes.limiteCustoFixo.toFixed(2);
  });
}

saveTaxesBtn.addEventListener('click', () => {
  const taxes = {
    limiteCustoFixo: parseFloat(document.getElementById('taxLimiteCusto').value) || 79.0,
    custoFixo: parseFloat(document.getElementById('taxCustoFixo').value) || 6.0,
    taxasPorAnuncio: {
      Classico: (parseFloat(document.getElementById('taxClassico').value) || 13) / 100,
      Premium: (parseFloat(document.getElementById('taxPremium').value) || 18) / 100,
    },
  };

  chrome.runtime.sendMessage({ type: 'saveCustomTaxes', taxes }, (response) => {
    if (response?.success) {
      showMessage('Taxas ML salvas com sucesso!', 'success');
    } else {
      showMessage('Erro ao salvar taxas.', 'error');
    }
  });
});

resetTaxesBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'saveCustomTaxes', taxes: null }, (response) => {
    if (response?.success) {
      document.getElementById('taxClassico').value = '13.0';
      document.getElementById('taxPremium').value = '18.0';
      document.getElementById('taxCustoFixo').value = '6.00';
      document.getElementById('taxLimiteCusto').value = '79.00';
      showMessage('Taxas ML restauradas ao padrão.', 'success');
    }
  });
});

// ==================================================================
//  CONFIGURAÇÃO DE TAXAS — SHOPEE
// ==================================================================

function loadShopeeTaxConfig() {
  chrome.runtime.sendMessage({ type: 'getShopeeCustomTaxes' }, (response) => {
    if (chrome.runtime.lastError || !response) return;

    const taxes = response.taxes || DEFAULT_SHOPEE_TAXES;
    document.getElementById('shopeeComissao').value = (taxes.comissao * 100).toFixed(1);
    document.getElementById('shopeeTaxaFixa').value = taxes.taxaFixa.toFixed(2);
  });
}

saveShopeeBtn.addEventListener('click', () => {
  const taxes = {
    comissao: (parseFloat(document.getElementById('shopeeComissao').value) || 14) / 100,
    taxaFixa: parseFloat(document.getElementById('shopeeTaxaFixa').value) || 3.0,
  };

  chrome.runtime.sendMessage({ type: 'saveShopeeCustomTaxes', taxes }, (response) => {
    if (response?.success) {
      showMessage('Taxas Shopee salvas com sucesso!', 'success');
    } else {
      showMessage('Erro ao salvar taxas Shopee.', 'error');
    }
  });
});

resetShopeeBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'saveShopeeCustomTaxes', taxes: null }, (response) => {
    if (response?.success) {
      document.getElementById('shopeeComissao').value = '14.0';
      document.getElementById('shopeeTaxaFixa').value = '3.00';
      showMessage('Taxas Shopee restauradas ao padrão.', 'success');
    }
  });
});

// ==================================================================
//  SISTEMA DE ABAS (TABS)
// ==================================================================

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const tabId = btn.dataset.tab;
    
    // Desativar todas as abas
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    
    // Ativar a aba correspondente
    btn.classList.add('active');
    const contentEl = document.getElementById(`tab-content-${tabId}`);
    if (contentEl) contentEl.classList.add('active');
  });
});

// ==================================================================
//  GERADOR DE EAN-13
// ==================================================================

const eanQtySelect = document.getElementById('eanQtySelect');
const generateEanBtn = document.getElementById('generateEanBtn');
const eanResultsList = document.getElementById('eanResultsList');
const copyAllEanBtn = document.getElementById('copyAllEanBtn');

let currentGeneratedEans = [];

function calculateEanCheckDigit(code) {
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    const digit = parseInt(code[i], 10);
    sum += (i % 2 === 0) ? digit : digit * 3;
  }
  return (10 - (sum % 10)) % 10;
}

function generateSingleEAN13() {
  const prefix = "789"; // Prefixo nacional do Brasil
  let body = "";
  for (let i = 0; i < 9; i++) {
    body += Math.floor(Math.random() * 10);
  }
  const checkDigit = calculateEanCheckDigit(prefix + body);
  return prefix + body + checkDigit;
}

generateEanBtn.addEventListener('click', () => {
  const qty = parseInt(eanQtySelect.value, 10) || 1;
  currentGeneratedEans = [];
  
  for (let i = 0; i < qty; i++) {
    currentGeneratedEans.push(generateSingleEAN13());
  }
  
  renderEanList();
});

function renderEanList() {
  if (currentGeneratedEans.length === 0) {
    eanResultsList.innerHTML = '<div class="tools-list-empty">Nenhum EAN gerado ainda.</div>';
    copyAllEanBtn.style.display = 'none';
    return;
  }
  
  const html = currentGeneratedEans.map((ean) => {
    return `
      <div class="ean-list-item">
        <span class="ean-value">${ean}</span>
        <button class="item-action-btn copy-ean-btn" data-ean="${ean}">
          📋 Copiar
        </button>
      </div>
    `;
  }).join('');
  
  eanResultsList.innerHTML = html;
  copyAllEanBtn.style.display = 'block';
  
  // Adicionar listeners para botões de cópia individual
  eanResultsList.querySelectorAll('.copy-ean-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const ean = btn.dataset.ean;
      navigator.clipboard.writeText(ean).then(() => {
        const originalText = btn.textContent;
        btn.textContent = '✅ Copiado!';
        btn.classList.add('btn-success');
        setTimeout(() => {
          btn.textContent = originalText;
          btn.classList.remove('btn-success');
        }, 1500);
      });
    });
  });
}

copyAllEanBtn.addEventListener('click', () => {
  if (currentGeneratedEans.length === 0) return;
  const allEansText = currentGeneratedEans.join('\n');
  navigator.clipboard.writeText(allEansText).then(() => {
    const originalText = copyAllEanBtn.textContent;
    copyAllEanBtn.textContent = '✅ TODOS OS EANS COPIADOS!';
    setTimeout(() => {
      copyAllEanBtn.textContent = originalText;
    }, 2000);
  });
});

// ==================================================================
//  SEO PALAVRAS-CHAVE (AUTOCOMPLETE)
// ==================================================================

const seoQueryInput = document.getElementById('seoQueryInput');
const seoResultsList = document.getElementById('seoResultsList');
const platformBtns = document.querySelectorAll('.platform-toggle-btn');

let activePlatform = 'ml'; // 'ml' ou 'shopee'
let debounceTimer = null;

// Alternar Plataforma
platformBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    platformBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activePlatform = btn.dataset.platform;
    
    // Atualizar busca se houver texto
    triggerSeoSearch();
  });
});

seoQueryInput.addEventListener('input', () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    triggerSeoSearch();
  }, 300); // 300ms debounce
});

function triggerSeoSearch() {
  const query = seoQueryInput.value.trim();
  if (!query) {
    seoResultsList.innerHTML = '<div class="tools-list-empty">Digite algo para ver sugestões.</div>';
    return;
  }
  
  seoResultsList.innerHTML = '<div class="tools-list-empty"><span class="loading-spinner"></span> Buscando sugestões...</div>';
  
  if (activePlatform === 'ml') {
    fetchMlSuggestions(query);
  } else {
    fetchShopeeSuggestions(query);
  }
}

function fetchMlSuggestions(query) {
  const url = `https://http2.mlstatic.com/resources/sites/MLB/autosuggest?q=${encodeURIComponent(query)}`;
  
  fetch(url)
    .then(response => {
      if (!response.ok) throw new Error('Network error');
      return response.json();
    })
    .then(data => {
      const suggestions = (data.suggested_queries || []).map(item => item.q);
      renderSuggestions(suggestions, 'ml');
    })
    .catch(error => {
      console.error('Erro sugestões ML:', error);
      seoResultsList.innerHTML = '<div class="tools-list-empty">Não foi possível carregar sugestões do Mercado Livre.</div>';
    });
}

function fetchShopeeSuggestions(query) {
  const url = `https://shopee.com.br/api/v4/search/search_hint?keyword=${encodeURIComponent(query)}`;
  
  fetch(url)
    .then(response => {
      if (!response.ok) throw new Error('Network error');
      return response.json();
    })
    .then(data => {
      const suggestions = (data.keywords || []).map(item => item.keyword);
      renderSuggestions(suggestions, 'shopee');
    })
    .catch(error => {
      console.error('Erro sugestões Shopee:', error);
      seoResultsList.innerHTML = '<div class="tools-list-empty">Não foi possível carregar sugestões da Shopee.</div>';
    });
}

function renderSuggestions(suggestions, platform) {
  if (!suggestions || suggestions.length === 0) {
    seoResultsList.innerHTML = '<div class="tools-list-empty">Nenhuma sugestão encontrada.</div>';
    return;
  }
  
  const html = suggestions.map((keyword) => {
    return `
      <div class="keyword-list-item" data-keyword="${keyword}" style="cursor: pointer;">
        <span class="keyword-text" title="${keyword}">${keyword}</span>
        <div class="keyword-actions">
          <button class="item-action-btn search-keyword-btn" title="Pesquisar termo">
            🔍 Busca
          </button>
          <button class="item-action-btn copy-keyword-btn" title="Copiar termo">
            📋 Copiar
          </button>
        </div>
      </div>
    `;
  }).join('');
  
  seoResultsList.innerHTML = html;
  
  // Adicionar listeners para as ações
  const items = seoResultsList.querySelectorAll('.keyword-list-item');
  items.forEach((item) => {
    const keyword = item.dataset.keyword;
    const copyBtn = item.querySelector('.copy-keyword-btn');
    const searchBtn = item.querySelector('.search-keyword-btn');
    
    // Ação: Copiar
    const copyFn = (e) => {
      if (e) e.stopPropagation(); // Evitar propagação
      navigator.clipboard.writeText(keyword).then(() => {
        const originalText = copyBtn.textContent;
        copyBtn.textContent = '✅';
        copyBtn.classList.add('btn-success');
        setTimeout(() => {
          copyBtn.textContent = originalText;
          copyBtn.classList.remove('btn-success');
        }, 1500);
      });
    };
    
    // Ação: Buscar
    const searchFn = (e) => {
      if (e) e.stopPropagation(); // Evitar propagação
      const searchUrl = platform === 'ml'
        ? `https://lista.mercadolivre.com.br/${encodeURIComponent(keyword)}`
        : `https://shopee.com.br/search?keyword=${encodeURIComponent(keyword)}`;
      chrome.tabs.create({ url: searchUrl });
    };
    
    // Clicar no botão de copiar
    copyBtn.addEventListener('click', copyFn);
    
    // Clicar no botão de buscar
    searchBtn.addEventListener('click', searchFn);
    
    // Clicar no item (dispara ambas: copia e busca)
    item.addEventListener('click', (e) => {
      copyFn(e);
      searchFn(e);
    });
  });
}

// ==================================================================
//  INICIALIZAÇÃO
// ==================================================================

checkAuthStatus();
loadTaxConfig();
loadShopeeTaxConfig();
loadGarimpoList();