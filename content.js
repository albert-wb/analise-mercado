// content.js — Analisador de Produtos v7.4.1 (ML + Shopee + Garimpo)

// ==================================================================
//  CONSTANTES E ESTADO
// ==================================================================

const TAXAS_MERCADO_LIVRE = {
  limiteCustoFixo: 79.0,
  custoFixo: 6.0,
  taxasPorAnuncio: { Classico: 0.13, Premium: 0.18 },
};

const TAXAS_SHOPEE = {
  comissao: 0.14,
  taxaFixa: 3.0,
  limiteFreteGratis: 0,
};

let dadosProduto = {};
let taxasCustomizadas = null;
let taxasShopeeCustomizadas = null;
let custosGlobais = null;

/**
 * Detects which platform we are on.
 * Returns 'meli', 'shopee', or 'unknown'.
 */
function detectPlatform() {
  const host = window.location.hostname;
  if (host.includes('mercadolivre.com.br')) return 'meli';
  if (host.includes('shopee.com.br')) return 'shopee';
  return 'unknown';
}

const CURRENT_PLATFORM = detectPlatform();

// Load custom taxes from storage
chrome.runtime.sendMessage({ type: 'getCustomTaxes' }, (response) => {
  if (chrome.runtime.lastError) return;
  if (response?.success && response.taxes) {
    taxasCustomizadas = response.taxes;
  }
});
chrome.runtime.sendMessage({ type: 'getShopeeCustomTaxes' }, (response) => {
  if (chrome.runtime.lastError) return;
  if (response?.success && response.taxes) {
    taxasShopeeCustomizadas = response.taxes;
  }
});
chrome.runtime.sendMessage({ type: 'getGlobalCosts' }, (response) => {
  if (chrome.runtime.lastError) return;
  if (response?.success && response.costs) {
    custosGlobais = response.costs;
  } else {
    custosGlobais = { imposto: 6.0, custoFixo: 2.0 };
  }
});

// Sincronizar configurações dinamicamente quando alteradas no popup
chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'local') {
    if (changes.custom_taxes) taxasCustomizadas = changes.custom_taxes.newValue;
    if (changes.shopee_custom_taxes) taxasShopeeCustomizadas = changes.shopee_custom_taxes.newValue;
    if (changes.global_costs) custosGlobais = changes.global_costs.newValue;
    
    // Se o painel estiver aberto, recalcular
    if (document.getElementById('meu-painel-analise')) {
      if (CURRENT_PLATFORM === 'shopee') {
        if (typeof calcularLucroShopee === 'function') calcularLucroShopee();
      } else {
        if (typeof calcularLucro === 'function') calcularLucro();
      }
    }
  }
});

// ==================================================================
//  DRAG & DROP — TORNAR ELEMENTOS ARRASTÁVEIS
// ==================================================================

function makeDraggable(element, storageKey) {
  let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
  const dragHandle = element.querySelector('.hud-header') || element;

  dragHandle.onmousedown = dragMouseDown;

  function dragMouseDown(e) {
    if (e.target.closest('.hud-close-btn') || e.target.closest('.hud-section-header') || e.target.closest('input') || e.target.closest('button')) return;
    e.preventDefault();
    pos3 = e.clientX;
    pos4 = e.clientY;
    document.onmouseup = closeDragElement;
    document.onmousemove = elementDrag;
  }

  function elementDrag(e) {
    e.preventDefault();
    pos1 = pos3 - e.clientX;
    pos2 = pos4 - e.clientY;
    pos3 = e.clientX;
    pos4 = e.clientY;
    element.style.top = (element.offsetTop - pos2) + 'px';
    element.style.left = (element.offsetLeft - pos1) + 'px';
  }

  function closeDragElement() {
    document.onmouseup = null;
    document.onmousemove = null;
    savePosition(storageKey, {
      top: element.style.top,
      left: element.style.left,
    });
  }
}

// ==================================================================
//  PERSISTÊNCIA DE POSIÇÃO
// ==================================================================

function savePosition(key, value) {
  chrome.storage.local.set({ [key]: value });
}

function loadAndApplyPosition(element, storageKey) {
  chrome.storage.local.get(storageKey, (result) => {
    const pos = result[storageKey];
    if (pos) {
      if (pos.top) element.style.top = pos.top;
      if (pos.left) element.style.left = pos.left;
    }
  });
}

// ==================================================================
//  EXTRAÇÃO DE DADOS
// ==================================================================

function extrairDados() {
  try {
    let dados = {};

    // --- JSON-LD ---
    const scriptJsonLD = document.querySelector('script[type="application/ld+json"]');
    if (scriptJsonLD) {
      try {
        const data = JSON.parse(scriptJsonLD.innerHTML);
        dados.titulo = data.name;
        if (data.offers?.offers) {
          dados.preco = parseFloat(data.offers.offers[0].price);
        } else if (data.offers) {
          dados.preco = parseFloat(data.offers.price);
        }
      } catch (e) { /* JSON-LD parse falhou, seguir com fallback DOM */ }
    }

    const getText = (selector) => document.querySelector(selector)?.innerText.trim() || null;

    // --- Fallback de Preço ---
    if (!dados.preco) {
      const precoString = getText('.andes-money-amount__fraction');
      if (precoString) {
        dados.preco = parseFloat(precoString.replace(/\./g, '').replace(',', '.'));
      }
    }
    dados.valorUnitario = dados.preco;

    // --- Vendas Estimadas ---
    const vendasTexto = getText('.ui-pdp-subtitle');
    let vendas = 0;
    if (vendasTexto) {
      const textoNormalizado = vendasTexto.toLowerCase();
      const match = textoNormalizado.match(/(\d[\d\.]*)/g);
      if (match) {
        let numeroBase = parseInt(match[match.length - 1].replace(/\./g, ''));
        vendas = textoNormalizado.includes('mil') ? numeroBase * 1000 : numeroBase;
      }
    }
    dados.vendas = vendas;

    // --- Tipo de Anúncio ---
    const installmentsInfo = getText('.ui-pdp-price__subtitles');
    dados.tipoAnuncio =
      installmentsInfo && installmentsInfo.toLowerCase().includes('sem juros')
        ? 'Premium' : 'Classico';

    // --- EAN ---
    dados.ean = 'Não encontrado';
    const specTableRows = document.querySelectorAll('.ui-vpp-striped-specs__row');
    specTableRows.forEach((row) => {
      const header = row.querySelector('th')?.innerText.trim().toUpperCase();
      if (header === 'EAN' || header === 'CÓDIGO UNIVERSAL DE PRODUTO' || header === 'GTIN') {
        dados.ean = row.querySelector('td')?.innerText.trim();
      }
    });

    // --- Frete Grátis ---
    const freteEl = document.querySelector('.ui-pdp-media__body');
    const freteTexto = freteEl?.innerText?.toLowerCase() || '';
    dados.freteGratis = freteTexto.includes('grátis') || freteTexto.includes('gratis');

    // --- ID do Produto (da URL) ---
    const urlMatch = window.location.href.match(/MLB-?(\d+)/i);
    dados.productId = urlMatch ? urlMatch[1] : null;

    // --- ID do Vendedor ---
    const sellerLink = document.querySelector('a[href*="/perfil/"]');
    if (sellerLink) {
      const sellerMatch = sellerLink.href.match(/perfil\/([^\/\?]+)/);
      dados.sellerNick = sellerMatch ? sellerMatch[1] : null;
    }

    // --- Data de Criação do Anúncio ---
    dados.dataCriacao = null;
    dados.idadeDias = null;
    dados.vendasPorDia = 0;
    dados.vendasEstimadas30d = 0;

    if (dados.productId) {
      try {
        const apiUrl = `https://api.mercadolibre.com/items/MLB${dados.productId}`;
        const xhr = new XMLHttpRequest();
        xhr.open('GET', apiUrl, false);
        xhr.send();
        if (xhr.status === 200) {
          const itemData = JSON.parse(xhr.responseText);
          if (itemData.date_created) dados.dataCriacao = itemData.date_created;
          if (itemData.sold_quantity) dados.vendas = itemData.sold_quantity;
        }
      } catch (e) {}
    }

    if (!dados.dataCriacao) {
      const allText = document.body.innerText || '';
      const dateMatch = allText.match(/Publicado há (\d+)\s*(dia|mês|meses|ano|anos)/i);
      if (dateMatch) {
        const num = parseInt(dateMatch[1], 10);
        const unit = dateMatch[2].toLowerCase();
        const now = new Date();
        if (unit.startsWith('dia')) now.setDate(now.getDate() - num);
        else if (unit.startsWith('mês') || unit.startsWith('mese')) now.setMonth(now.getMonth() - num);
        else if (unit.startsWith('ano')) now.setFullYear(now.getFullYear() - num);
        dados.dataCriacao = now.toISOString();
      }
    }

    if (dados.dataCriacao) {
      const criado = new Date(dados.dataCriacao);
      const agora = new Date();
      dados.idadeDias = Math.max(1, Math.floor((agora - criado) / (1000 * 60 * 60 * 24)));
      dados.vendasPorDia = dados.vendas / dados.idadeDias;
      dados.vendasEstimadas30d = Math.round(dados.vendasPorDia * 30);
    }

    // --- Volume Bruto ---
    dados.volumeBruto = (dados.valorUnitario && dados.vendas)
      ? dados.valorUnitario * dados.vendas : 0;

    dadosProduto = dados;
    processarSnapshotsVendas(dadosProduto, () => {
      exibirPainel();
    });
  } catch (error) {
    exibirPainelErro('Falha ao extrair dados da página. Tente recarregar.');
  }
}

// ==================================================================
//  FORMATADORES
// ==================================================================

const formatCurrency = (num) =>
  num != null ? num.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) : 'N/A';

const formatNumber = (num) =>
  num != null ? num.toLocaleString('pt-BR') : 'N/A';

function formatIdade(dias) {
  if (dias < 1) return 'Hoje';
  if (dias < 30) return `${dias} dia${dias > 1 ? 's' : ''}`;
  if (dias < 365) {
    const meses = Math.floor(dias / 30);
    return `${meses} ${meses > 1 ? 'meses' : 'mês'}`;
  }
  const anos = Math.floor(dias / 365);
  return `${anos} ano${anos > 1 ? 's' : ''}`;
}

// ==================================================================
//  PAINEL DE ERRO
// ==================================================================

function exibirPainelErro(mensagem) {
  let painelExistente = document.getElementById('meu-painel-analise');
  if (painelExistente) painelExistente.remove();

  const painel = document.createElement('div');
  painel.id = 'meu-painel-analise';
  painel.innerHTML = `
    <div class="hud-header">
      <h3>⚠ ERRO</h3>
      <button class="hud-close-btn" title="Fechar">✕</button>
    </div>
    <div class="painel-content" style="padding: 20px 16px;">
      <p style="color: var(--hud-accent-red); font-size: 13px; margin: 0;">${mensagem}</p>
    </div>
  `;
  document.body.appendChild(painel);
  painel.querySelector('.hud-close-btn').addEventListener('click', () => painel.remove());
}

// ==================================================================
//  PAINEL PRINCIPAL
// ==================================================================

function exibirPainel() {
  let painelExistente = document.getElementById('meu-painel-analise');
  if (painelExistente) painelExistente.remove();

  const painel = document.createElement('div');
  painel.id = 'meu-painel-analise';

  const tipoTag = dadosProduto.tipoAnuncio === 'Premium'
    ? '<span class="hud-tag hud-tag-premium">Premium</span>'
    : '<span class="hud-tag hud-tag-classico">Clássico</span>';

  const freteTag = dadosProduto.freteGratis
    ? '<span class="hud-tag hud-tag-frete-gratis">Frete Grátis</span>' : '';

  painel.innerHTML = `
    <div class="hud-header">
      <h3>📊 ANÁLISE PRO</h3>
      <button class="hud-close-btn" title="Fechar">✕</button>
    </div>

    <div class="painel-content">
      <!-- Score de Lucratividade (atualizado pela calculadora) -->
      <div class="hud-score-section" id="scoreSection" style="display:none;">
        <div class="hud-score-label">Score de Lucratividade</div>
        <div class="hud-score-bar-container">
          <div class="hud-score-bar" id="scoreBar" style="width: 0%;"></div>
        </div>
        <div class="hud-score-value" id="scoreValue">—</div>
      </div>

      <!-- Seção: Dados do Produto -->
      <div class="hud-section" id="sectionDados">
        <div class="hud-section-header">
          <span class="hud-section-title">📦 Dados do Produto</span>
          <span class="hud-section-arrow">▼</span>
        </div>
        <div class="hud-section-body">
          <div class="hud-data-row">
            <span class="hud-data-label">EAN</span>
            <span class="hud-data-value">${dadosProduto.ean || 'N/A'}</span>
          </div>
          <div class="hud-data-row">
            <span class="hud-data-label">Tipo de Anúncio</span>
            ${tipoTag}
          </div>
          ${freteTag ? `<div class="hud-data-row"><span class="hud-data-label">Frete</span>${freteTag}</div>` : ''}
          <div class="hud-data-row">
            <span class="hud-data-label">Valor Unitário</span>
            <span class="hud-data-value hud-currency">${formatCurrency(dadosProduto.valorUnitario)}</span>
          </div>
          <div class="hud-data-row">
            <span class="hud-data-label">Vendas Totais</span>
            <span class="hud-data-value">${formatNumber(dadosProduto.vendas)}</span>
          </div>
          ${dadosProduto.dataCriacao ? `
          <div class="hud-data-row">
            <span class="hud-data-label">⏱️ Idade</span>
            <span class="hud-data-value">${formatIdade(dadosProduto.idadeDias)}</span>
          </div>
          <div class="hud-data-row">
            <span class="hud-data-label">${dadosProduto.vendasReais30d !== undefined ? '📈 Vendas/30d (Real)' : '📈 Est. Vendas/30d'}</span>
            <span class="hud-data-value" style="color: ${(dadosProduto.vendasReais30d !== undefined ? dadosProduto.vendasReais30d : dadosProduto.vendasEstimadas30d) > 30 ? 'var(--hud-accent-green)' : (dadosProduto.vendasReais30d !== undefined ? dadosProduto.vendasReais30d : dadosProduto.vendasEstimadas30d) > 10 ? 'var(--hud-accent-amber)' : 'var(--hud-accent-red)'};">
              ${dadosProduto.vendasReais30d !== undefined ? formatNumber(dadosProduto.vendasReais30d) + ' un. <span style="font-size:9px; color:var(--hud-text-secondary);">(' + dadosProduto.diasRastreados + 'd medidos)</span>' : '~' + formatNumber(dadosProduto.vendasEstimadas30d) + ' un.'}
            </span>
          </div>
          <div class="hud-data-row">
            <span class="hud-data-label">🔥 Vendas/Dia</span>
            <span class="hud-data-value" style="font-family: var(--hud-font-mono);">${dadosProduto.vendasPorDia.toFixed(1)}/dia</span>
          </div>
          ` : ''}
          <div class="hud-data-row">
            <span class="hud-data-label">Volume Bruto</span>
            <span class="hud-data-value hud-currency">${formatCurrency(dadosProduto.volumeBruto)}</span>
          </div>
        </div>
      </div>

      <!-- Seção: Avaliações -->
      <div class="hud-section" id="sectionAvaliacoes" style="display: none;">
        <div class="hud-section-header">
          <span class="hud-section-title">💬 Avaliações</span>
          <span class="hud-section-arrow">▼</span>
        </div>
        <div class="hud-section-body" id="avaliacoesBody">
          <div style="text-align: center; color: var(--hud-text-secondary); font-size: 11px; padding: 10px;">Carregando avaliações...</div>
        </div>
      </div>

      <!-- Seção: SEO & Ficha -->
      <div class="hud-section" id="sectionSEO" style="display: none;">
        <div class="hud-section-header">
          <span class="hud-section-title">🎯 SEO & Ficha</span>
          <span class="hud-section-arrow">▼</span>
        </div>
        <div class="hud-section-body" id="seoBody">
        </div>
      </div>

      <!-- Seção: Calculadora -->
      <div class="hud-section" id="sectionCalc">
        <div class="hud-section-header">
          <span class="hud-section-title">🧮 Calculadora</span>
          <span class="hud-section-arrow">▼</span>
        </div>
        <div class="hud-section-body">
          <div class="hud-calc-inputs">
            <div class="hud-input-group">
              <label for="custoProduto">Custo do Produto</label>
              <input type="number" id="custoProduto" placeholder="R$ 0,00" step="0.01">
            </div>
            <div class="hud-input-group">
              <label for="custoFrete">Custo do Frete</label>
              <input type="number" id="custoFrete" placeholder="R$ 0,00" step="0.01">
            </div>
          </div>
          <div class="hud-results" id="results">
            <div class="hud-result-row">
              <span class="hud-result-label">Tarifa ML</span>
              <span class="hud-result-value" id="resTarifaML">R$ 0,00</span>
            </div>
            <div class="hud-result-row">
              <span class="hud-result-label">Impostos & Custos</span>
              <span class="hud-result-value" id="resImpostos">R$ 0,00</span>
            </div>
            <div class="hud-result-row">
              <span class="hud-result-label">Valor Recebido</span>
              <span class="hud-result-value hud-currency" id="resValorRecebido">R$ 0,00</span>
            </div>
            <div class="hud-result-row hud-result-highlight" id="lucroRow">
              <span class="hud-result-label">Lucro por Venda</span>
              <span class="hud-result-value" id="resLucro">R$ 0,00</span>
            </div>
            <div class="hud-result-row">
              <span class="hud-result-label">Margem de Lucro</span>
              <span class="hud-result-value" id="resMargem">0,00%</span>
            </div>
            <div class="hud-result-row">
              <span class="hud-result-label">ROI</span>
              <span class="hud-result-value" id="resROI">0,00%</span>
            </div>
          </div>

          <!-- Matriz de Sensibilidade -->
          <div class="hud-matrix-section" id="matrixSection" style="display:none; margin-top: 15px;">
             <div class="hud-section-header" style="padding: 0; background: transparent; border: none; margin-bottom: 8px;">
               <span class="hud-section-title" style="font-size: 11px; color: var(--hud-text-secondary);">📈 Matriz de Sensibilidade (Preço vs. Lucro)</span>
             </div>
             <table class="hud-matrix-table" style="width: 100%; font-size: 11px; border-collapse: collapse;">
               <thead>
                 <tr style="color: var(--hud-text-secondary); text-align: right; border-bottom: 1px solid var(--hud-border);">
                   <th style="text-align: left; padding: 4px;">Var.</th>
                   <th style="padding: 4px;">Preço</th>
                   <th style="padding: 4px;">Lucro</th>
                   <th style="padding: 4px;">Margem</th>
                 </tr>
               </thead>
               <tbody id="matrixTableBody">
               </tbody>
             </table>
          </div>
        </div>
      </div>
    </div>

    <!-- Toast de feedback -->
    <div class="hud-toast" id="hudToast">Copiado!</div>

    <!-- Barra de Ações -->
    <div class="hud-actions">
      <button class="hud-action-btn" id="btnCopiar" title="Copiar dados">📋 Copiar</button>
      <button class="hud-action-btn" id="btnMidias" title="Baixar Mídias">📸 Mídias</button>
      <button class="hud-action-btn" id="btnGarimpo" title="Salvar no Garimpo">⭐ Garimpo</button>
      <button class="hud-action-btn" id="btnRecarregar" title="Recarregar dados">🔄 Atualizar</button>
    </div>
  `;

  document.body.appendChild(painel);

  // --- Event Listeners ---
  setupCalculadoraListeners();
  setupSectionToggle();
  carregarAvaliacoes('meli');
  carregarSEO();

  painel.querySelector('.hud-close-btn').addEventListener('click', () => painel.remove());
  painel.querySelector('#btnCopiar').addEventListener('click', copiarDados);
  const btnMidias = painel.querySelector('#btnMidias');
  if (btnMidias) btnMidias.addEventListener('click', baixarMidiasML);
  painel.querySelector('#btnGarimpo').addEventListener('click', salvarGarimpo);
  painel.querySelector('#btnRecarregar').addEventListener('click', extrairDados);

  makeDraggable(painel, 'posicaoPainel');
  loadAndApplyPosition(painel, 'posicaoPainel');
}

// ==================================================================
//  SEÇÕES COLAPSÁVEIS
// ==================================================================

function setupSectionToggle() {
  const sections = document.querySelectorAll('#meu-painel-analise .hud-section');
  sections.forEach((section) => {
    const header = section.querySelector('.hud-section-header');
    header.addEventListener('click', () => {
      section.classList.toggle('collapsed');
    });
  });
}

// ==================================================================
//  CALCULADORA DE LUCRATIVIDADE
// ==================================================================

function setupCalculadoraListeners() {
  ['custoProduto', 'custoFrete'].forEach((id) => {
    document.getElementById(id)?.addEventListener('input', calcularLucro);
  });
  calcularLucro();
}

function calcularLucro() {
  const taxas = taxasCustomizadas || TAXAS_MERCADO_LIVRE;
  const precoVenda = dadosProduto.valorUnitario || 0;
  const tipoAnuncio = dadosProduto.tipoAnuncio || 'Classico';
  const custoProduto = parseFloat(document.getElementById('custoProduto')?.value) || 0;
  const custoFrete = parseFloat(document.getElementById('custoFrete')?.value) || 0;

  const taxaPercentual = taxas.taxasPorAnuncio[tipoAnuncio];
  const comissaoML = precoVenda * taxaPercentual;
  const custoFixoML = precoVenda < taxas.limiteCustoFixo ? taxas.custoFixo : 0;
  const tarifaTotalML = comissaoML + custoFixoML;

  const impostoGlobal = (custosGlobais?.imposto || 0) / 100;
  const custoFixoGlobal = custosGlobais?.custoFixo || 0;
  const valorImposto = precoVenda * impostoGlobal;
  const totalImpostosECustosExtras = valorImposto + custoFixoGlobal;

  const valorRecebido = precoVenda - tarifaTotalML - custoFrete;
  const lucro = valorRecebido - custoProduto - totalImpostosECustosExtras;
  const margem = precoVenda > 0 ? (lucro / precoVenda) * 100 : 0;
  const custoTotal = custoProduto + custoFrete + totalImpostosECustosExtras;
  const roi = custoTotal > 0 ? (lucro / custoTotal) * 100 : 0;

  // Atualizar valores
  const setVal = (id, text) => {
    const el = document.getElementById(id);
    if (el) el.innerText = text;
  };

  setVal('resTarifaML', formatCurrency(tarifaTotalML));
  setVal('resImpostos', formatCurrency(totalImpostosECustosExtras));
  setVal('resValorRecebido', formatCurrency(valorRecebido));
  setVal('resLucro', formatCurrency(lucro));
  setVal('resMargem', `${margem.toFixed(2)}%`);
  setVal('resROI', `${roi.toFixed(2)}%`);

  // Coloração de lucro/prejuízo
  const lucroEl = document.getElementById('resLucro');
  const margemEl = document.getElementById('resMargem');
  const roiEl = document.getElementById('resROI');
  const valorRecebidoEl = document.getElementById('resValorRecebido');
  const lucroRow = document.getElementById('lucroRow');

  if (lucroEl) lucroEl.style.color = lucro < 0 ? 'var(--hud-accent-red)' : 'var(--hud-accent-green)';
  if (margemEl) margemEl.style.color = margem < 0 ? 'var(--hud-accent-red)' : 'var(--hud-accent-green)';
  if (roiEl) roiEl.style.color = roi < 0 ? 'var(--hud-accent-red)' : 'var(--hud-accent-green)';
  if (valorRecebidoEl) {
    valorRecebidoEl.classList.toggle('negative', valorRecebido < custoProduto);
  }
  if (lucroRow) {
    lucroRow.classList.remove('lucro-positivo', 'lucro-negativo');
    lucroRow.classList.add(lucro >= 0 ? 'lucro-positivo' : 'lucro-negativo');
  }

  // Score de lucratividade (visível apenas quando o custo é preenchido)
  const scoreSection = document.getElementById('scoreSection');
  const scoreBar = document.getElementById('scoreBar');
  const scoreValue = document.getElementById('scoreValue');

  if (custoProduto > 0 && scoreSection && scoreBar && scoreValue) {
    scoreSection.style.display = 'block';
    const margemClamped = Math.max(0, Math.min(100, margem));
    scoreBar.style.width = `${margemClamped}%`;

    scoreBar.classList.remove('score-red', 'score-amber', 'score-green');
    scoreValue.classList.remove('score-red', 'score-amber', 'score-green');

    let scoreClass;
    if (margem < 15) scoreClass = 'score-red';
    else if (margem < 30) scoreClass = 'score-amber';
    else scoreClass = 'score-green';

    scoreBar.classList.add(scoreClass);
    scoreValue.classList.add(scoreClass);
    scoreValue.innerText = `${margem.toFixed(1)}%`;
    
    // Renderizar a Matriz de Sensibilidade apenas quando temos custo do produto
    renderMatrixMeli(precoVenda, custoProduto, custoFrete, taxas, tipoAnuncio);
  } else if (scoreSection) {
    scoreSection.style.display = 'none';
    const matrixSection = document.getElementById('matrixSection');
    if (matrixSection) matrixSection.style.display = 'none';
  }
}

function renderMatrixMeli(precoAtual, custoProduto, custoFrete, taxas, tipoAnuncio) {
  const matrixSection = document.getElementById('matrixSection');
  const matrixTableBody = document.getElementById('matrixTableBody');
  if (!matrixSection || !matrixTableBody) return;

  matrixSection.style.display = 'block';

  const impostoGlobal = (custosGlobais?.imposto || 0) / 100;
  const custoFixoGlobal = custosGlobais?.custoFixo || 0;
  const taxaPercentual = taxas.taxasPorAnuncio[tipoAnuncio];

  const variacoes = [-0.10, -0.05, 0, 0.05, 0.10];
  const variacoesLabels = ['-10%', '-5%', 'Atual', '+5%', '+10%'];

  let html = '';

  variacoes.forEach((variacao, index) => {
    const precoSimulado = precoAtual * (1 + variacao);
    
    const comissaoML = precoSimulado * taxaPercentual;
    const custoFixoML = precoSimulado < taxas.limiteCustoFixo ? taxas.custoFixo : 0;
    const tarifaTotalML = comissaoML + custoFixoML;

    const valorImposto = precoSimulado * impostoGlobal;
    const totalImpostos = valorImposto + custoFixoGlobal;

    const valorRecebido = precoSimulado - tarifaTotalML - custoFrete;
    const lucro = valorRecebido - custoProduto - totalImpostos;
    const margem = precoSimulado > 0 ? (lucro / precoSimulado) * 100 : 0;

    const isAtual = variacao === 0;
    const rowBg = isAtual ? 'rgba(0, 255, 136, 0.1)' : 'transparent';
    const lucroColor = lucro >= 0 ? 'var(--hud-accent-green)' : 'var(--hud-accent-red)';
    const fontW = isAtual ? 'bold' : 'normal';

    html += `
      <tr style="text-align: right; background: ${rowBg}; font-weight: ${fontW};">
        <td style="text-align: left; padding: 4px;">${variacoesLabels[index]}</td>
        <td style="padding: 4px;">${formatCurrency(precoSimulado)}</td>
        <td style="padding: 4px; color: ${lucroColor};">${formatCurrency(lucro)}</td>
        <td style="padding: 4px; color: ${lucroColor};">${margem.toFixed(1)}%</td>
      </tr>
    `;
  });

  matrixTableBody.innerHTML = html;
}

// ==================================================================
//  COPIAR DADOS
// ==================================================================

function copiarDados() {
  const taxas = taxasCustomizadas || TAXAS_MERCADO_LIVRE;
  const custoProduto = parseFloat(document.getElementById('custoProduto')?.value) || 0;
  const custoFrete = parseFloat(document.getElementById('custoFrete')?.value) || 0;
  const precoVenda = dadosProduto.valorUnitario || 0;
  const taxaPercentual = taxas.taxasPorAnuncio[dadosProduto.tipoAnuncio || 'Classico'];
  const comissao = precoVenda * taxaPercentual;
  const custoFixo = precoVenda < taxas.limiteCustoFixo ? taxas.custoFixo : 0;
  const tarifa = comissao + custoFixo;
  const recebido = precoVenda - tarifa - custoFrete;
  const lucro = recebido - custoProduto;
  const margem = precoVenda > 0 ? ((lucro / precoVenda) * 100).toFixed(2) : '0.00';

  const texto = [
    `Produto: ${dadosProduto.titulo || 'N/A'}`,
    `EAN: ${dadosProduto.ean || 'N/A'}`,
    `Tipo: ${dadosProduto.tipoAnuncio || 'N/A'}`,
    `Frete Grátis: ${dadosProduto.freteGratis ? 'Sim' : 'Não'}`,
    `Preço: ${formatCurrency(precoVenda)}`,
    `Vendas: ${formatNumber(dadosProduto.vendas)}`,
    `Volume Bruto: ${formatCurrency(dadosProduto.volumeBruto)}`,
    `---`,
    `Custo Produto: ${formatCurrency(custoProduto)}`,
    `Custo Frete: ${formatCurrency(custoFrete)}`,
    `Tarifa ML: ${formatCurrency(tarifa)}`,
    `Valor Recebido: ${formatCurrency(recebido)}`,
    `Lucro: ${formatCurrency(lucro)}`,
    `Margem: ${margem}%`,
  ].join('\n');

  navigator.clipboard.writeText(texto).then(() => {
    const toast = document.getElementById('hudToast');
    const btn = document.getElementById('btnCopiar');
    if (toast) {
      toast.classList.add('visible');
      setTimeout(() => toast.classList.remove('visible'), 1500);
    }
    if (btn) {
      btn.classList.add('copied');
      setTimeout(() => btn.classList.remove('copied'), 1500);
    }
  });
}

// ==================================================================
//  GARIMPO — SALVAR PRODUTO PARA ANÁLISE POSTERIOR
// ==================================================================

function salvarGarimpo() {
  const custoProduto = parseFloat(document.getElementById('custoProduto')?.value) || 0;
  const custoFrete = parseFloat(document.getElementById('custoFrete')?.value) || 0;

  const item = {
    id: Date.now().toString(36) + Math.random().toString(36).substring(2, 6),
    timestamp: new Date().toISOString(),
    plataforma: dadosProduto.plataforma || CURRENT_PLATFORM || 'meli',
    titulo: dadosProduto.titulo || 'N/A',
    url: window.location.href,
    preco: dadosProduto.valorUnitario || 0,
    vendas: dadosProduto.vendas || 0,
    volumeBruto: dadosProduto.volumeBruto || 0,
    tipoAnuncio: dadosProduto.tipoAnuncio || 'N/A',
    ean: dadosProduto.ean || 'N/A',
    freteGratis: dadosProduto.freteGratis || false,
    custoProduto,
    custoFrete,
    sellerNick: dadosProduto.sellerNick || null,
  };

  chrome.runtime.sendMessage({ type: 'saveGarimpo', item }, (response) => {
    const toast = document.getElementById('hudToast');
    const btn = document.getElementById('btnGarimpo');
    if (response?.success) {
      if (toast) {
        toast.textContent = '⭐ Salvo no Garimpo!';
        toast.classList.add('visible');
        setTimeout(() => {
          toast.classList.remove('visible');
          toast.textContent = 'Copiado!';
        }, 1800);
      }
      if (btn) {
        btn.classList.add('copied');
        btn.textContent = '✅ Salvo!';
        setTimeout(() => {
          btn.classList.remove('copied');
          btn.textContent = '⭐ Garimpo';
        }, 1800);
      }
    } else {
      if (toast) {
        toast.textContent = '❌ Erro ao salvar';
        toast.classList.add('visible');
        setTimeout(() => {
          toast.classList.remove('visible');
          toast.textContent = 'Copiado!';
        }, 1800);
      }
    }
  });
}

// ==================================================================
//  BUSCA — INJEÇÃO DE MÉTRICAS NOS RESULTADOS DE PESQUISA
// ==================================================================

function isSearchPage() {
  const url = window.location.href;
  return (
    url.includes('/lista') ||
    url.includes('search_layout=') ||
    url.includes('mercadolivre.com.br/ofertas') ||
    document.querySelector('.ui-search-results, .ui-search-layout')
  );
}

function isProductPage() {
  const url = window.location.href;
  const hostname = window.location.hostname;
  return (
    url.includes('/MLB-') ||
    url.includes('/p/MLB') ||
    hostname === 'produto.mercadolivre.com.br' ||
    document.querySelector('.ui-pdp-container, .ui-vip-core')
  );
}

/**
 * Extracts price from search card image alt text.
 * ML renders prices as <image> with roledescription="Valor"
 * and alt text like "Agora: 5471 reais" or "5471 reais com 90 centavos".
 */
function extractPriceFromCard(cardEl) {
  // Strategy 1: ML renders prices as images with roledescription="Valor"
  const priceImages = cardEl.querySelectorAll('img[roledescription="Valor"], [roledescription="Valor"]');
  let currentPrice = 0;

  for (const img of priceImages) {
    const alt = (img.alt || img.getAttribute('aria-label') || '').toLowerCase();

    // Skip "Antes:" (original price) — we want the current/discounted price
    if (alt.startsWith('antes:')) continue;

    // Parse "Agora: 5471 reais" or "5471 reais" or "5471 reais com 90 centavos"
    const cleaned = alt.replace('agora:', '').trim();
    const reaisMatch = cleaned.match(/(\d[\d.]*)\s*reais/);
    if (reaisMatch) {
      let value = parseFloat(reaisMatch[1].replace(/\./g, ''));
      // Check for cents: "com 90 centavos"
      const centsMatch = cleaned.match(/com\s+(\d+)\s*centavo/);
      if (centsMatch) {
        value += parseInt(centsMatch[1], 10) / 100;
      }
      // Take the first non-"antes" price as the main price
      if (currentPrice === 0) {
        currentPrice = value;
      }
    }
  }

  // Strategy 2: Fallback to text-based price extraction
  if (currentPrice === 0) {
    const fractionEl = cardEl.querySelector(
      '.andes-money-amount__fraction, [class*="price-tag"] .andes-money-amount__fraction'
    );
    if (fractionEl) {
      const raw = fractionEl.innerText.replace(/\./g, '').replace(',', '.');
      const value = parseFloat(raw);
      if (!isNaN(value)) {
        const centsEl = cardEl.querySelector('.andes-money-amount__cents');
        const cents = centsEl ? parseInt(centsEl.innerText, 10) / 100 : 0;
        currentPrice = value + cents;
      }
    }
  }

  return currentPrice;
}

/**
 * Extracts original (pre-discount) price from search card.
 * Looks for images with alt text starting with "Antes:".
 */
function extractSellerNameFromCard(cardEl) {
  const sellerEl = cardEl.querySelector('.ui-search-official-store-label, .ui-search-official-store-item__link');
  if (sellerEl) {
    const text = sellerEl.innerText.trim();
    if (text.toLowerCase().includes('por ')) return text.split('por ')[1];
    return text;
  }
  return null;
}

function extractLogisticsType(cardEl) {
  const text = cardEl.innerText.toLowerCase();
  if (text.includes('full')) return 'full';
  if (text.includes('chegará hoje') || text.includes('chegará amanhã')) return 'flex';
  return 'correios';
}

function extractOriginalPriceFromCard(cardEl) {
  const priceImages = cardEl.querySelectorAll('img[roledescription="Valor"], [roledescription="Valor"]');
  for (const img of priceImages) {
    const alt = (img.alt || img.getAttribute('aria-label') || '').toLowerCase();
    if (alt.startsWith('antes:')) {
      const cleaned = alt.replace('antes:', '').trim();
      const reaisMatch = cleaned.match(/(\d[\d.]*)\s*reais/);
      if (reaisMatch) {
        let value = parseFloat(reaisMatch[1].replace(/\./g, ''));
        const centsMatch = cleaned.match(/com\s+(\d+)\s*centavo/);
        if (centsMatch) value += parseInt(centsMatch[1], 10) / 100;
        return value;
      }
    }
  }
  return 0;
}

/**
 * Extracts seller rating (e.g., 4.8, 4.9) from the card.
 * ML shows ratings as StaticText nodes with values like "4.9".
 */
function extractSellerRating(cardEl) {
  const allText = cardEl.innerText || '';
  const lines = allText.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    // Rating is a standalone number like "4.8" or "4.9"
    if (/^\d\.\d$/.test(trimmed)) {
      const rating = parseFloat(trimmed);
      if (rating >= 3.0 && rating <= 5.0) return rating;
    }
  }
  return 0;
}

/**
 * Checks if the card has a "frete grátis" indicator.
 */
function hasFreteGratis(cardEl) {
  const text = cardEl.innerText?.toLowerCase() || '';
  return text.includes('frete grátis') || text.includes('chegará grátis');
}

/**
 * Checks if the card is a "Full" (fulfilled) listing.
 * ML shows "Enviado pelo FULL" or has a FULL badge image.
 */
function isFullListing(cardEl) {
  const text = cardEl.innerText?.toLowerCase() || '';
  if (text.includes('full')) return true;
  // Also check for FULL badge images
  const imgs = cardEl.querySelectorAll('img');
  for (const img of imgs) {
    const alt = (img.alt || '').toLowerCase();
    if (alt.includes('full')) return true;
  }
  return false;
}

/**
 * Extracts discount percentage from card text (e.g., "38% OFF", "16% OFF").
 */
function extractDiscountFromCard(cardEl) {
  const text = cardEl.innerText || '';
  const match = text.match(/(\d+)%\s*OFF/i);
  return match ? parseInt(match[1], 10) : 0;
}

/**
 * Builds the HTML for a single search badge.
 * Shows: Price, Seller Rating, Discount, Frete Grátis, Full tags.
 */
function buildBadgeHTML(data) {
  const parts = [];

  // Price
  if (data.preco > 0) {
    const precoStr = data.preco.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    parts.push(`
      <span class="ml-search-badge__item ml-search-badge__item--faturamento">
        <span class="ml-search-badge__icon">💲</span>
        <span class="ml-search-badge__value">${precoStr}</span>
      </span>
    `);
  }

  // Seller Rating
  if (data.rating > 0) {
    const ratingColor = data.rating >= 4.5 ? '#00ff88' : data.rating >= 4.0 ? '#f0b429' : '#ff3b3b';
    parts.push(`<span class="ml-search-badge__separator"></span>`);
    parts.push(`
      <span class="ml-search-badge__item ml-search-badge__item--vendas">
        <span class="ml-search-badge__icon">⭐</span>
        <span class="ml-search-badge__value" style="color: ${ratingColor}">${data.rating.toFixed(1)}</span>
      </span>
    `);
  }

  // Discount
  if (data.discount > 0) {
    parts.push(`<span class="ml-search-badge__separator"></span>`);
    const discColor = data.discount >= 30 ? '#00ff88' : data.discount >= 15 ? '#f0b429' : '#8b949e';
    parts.push(`
      <span class="ml-search-badge__item">
        <span class="ml-search-badge__icon">🏷️</span>
        <span class="ml-search-badge__value" style="color: ${discColor}">-${data.discount}%</span>
      </span>
    `);
  }

  // Tags
  if (data.freteGratis) {
    parts.push('<span class="ml-search-badge__tag ml-search-badge__tag--frete">Frete Grátis</span>');
  }
  if (data.isFull) {
    parts.push('<span class="ml-search-badge__tag ml-search-badge__tag--full">Full</span>');
  }

  return parts.join('');
}

/**
 * Injects a badge into a single search result card.
 */
function injectBadgeIntoCard(cardEl) {
  if (cardEl.querySelector('.ml-search-badge')) return;

  const preco = extractPriceFromCard(cardEl);
  const rating = extractSellerRating(cardEl);
  const discount = extractDiscountFromCard(cardEl);
  const freteGratis = hasFreteGratis(cardEl);
  const isFull = isFullListing(cardEl);

  const badge = document.createElement('div');
  badge.className = 'ml-search-badge';
  badge.innerHTML = buildBadgeHTML({ preco, rating, discount, freteGratis, isFull });

  // Append at the end of the card content
  cardEl.appendChild(badge);
}

/**
 * Scans all visible search result cards and injects badges.
 */
function scanAndInjectBadges() {
  // ML uses various selectors for search item containers
  const selectors = [
    '.ui-search-layout__item',
    '.ui-search-result__wrapper',
    'li[class*="ui-search"]',
    '.ui-search-layout--grid .andes-card',
    '.ui-search-layout--stack .andes-card',
  ];

  let cards = [];
  for (const sel of selectors) {
    const found = document.querySelectorAll(sel);
    if (found.length > 0) {
      cards = found;
      break;
    }
  }

  // Fallback: try anchor-based detection on the results section
  if (cards.length === 0) {
    const resultsContainer = document.querySelector(
      '.ui-search-results, [class*="search-results"], main ol, main .shops__search-results'
    );
    if (resultsContainer) {
      cards = resultsContainer.querySelectorAll(':scope > li, :scope > div > li');
    }
  }

  cards.forEach((card) => {
    try {
      injectBadgeIntoCard(card);
    } catch (_) { /* ignore individual card errors */ }
  });
}

/**
 * Sets up MutationObserver for dynamically loaded search results
 * (infinite scroll, pagination via SPA navigation, etc.).
 */
function observeSearchResults() {
  scanAndInjectBadges();

  const observerTarget = document.querySelector(
    '.ui-search-results, .ui-search-layout, main, #root-app'
  ) || document.body;

  const observer = new MutationObserver((mutations) => {
    let hasNewNodes = false;
    for (const mutation of mutations) {
      if (mutation.addedNodes.length > 0) {
        hasNewNodes = true;
        break;
      }
    }
    if (hasNewNodes) {
      scanAndInjectBadges();
    }
  });

  observer.observe(observerTarget, { childList: true, subtree: true });
}

// ==================================================================
//  SHOPEE — EXTRAÇÃO DE DADOS DE PRODUTO
// ==================================================================

function isShopeeProductPage() {
  const url = window.location.href;
  // Shopee product URLs: shopee.com.br/product-name-i.SHOPID.ITEMID
  return url.includes('shopee.com.br/') && /\-i\.\d+\.\d+/.test(url);
}

function isShopeeSearchPage() {
  const url = window.location.href;
  return (
    url.includes('shopee.com.br/search') ||
    url.includes('shopee.com.br/mall/search') ||
    (url.includes('shopee.com.br/') && url.includes('keyword='))
  );
}

/**
 * Extracts Shopee product IDs from URL.
 * URL pattern: shopee.com.br/Product-Name-i.SHOP_ID.ITEM_ID
 */
function extractShopeeIds() {
  const match = window.location.href.match(/\-i\.(\d+)\.(\d+)/);
  if (match) return { shopId: match[1], itemId: match[2] };
  return null;
}

/**
 * Extracts product data from Shopee product page using DOM.
 * Shopee uses dynamic classes, so we use multiple fallback strategies.
 */
function extrairDadosShopee() {
  try {
    let dados = {};
    dados.plataforma = 'shopee';

    // --- JSON-LD Data Extraction (Most Reliable) ---
    let ldPrice = 0;
    let ldSales = 0;
    let ldRating = 0;
    const scripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (const script of scripts) {
      try {
        const json = JSON.parse(script.innerText);
        if (json['@type'] === 'Product') {
          if (json.offers && json.offers.price) ldPrice = parseFloat(json.offers.price);
          if (json.aggregateRating && json.aggregateRating.reviewCount) ldSales = parseInt(json.aggregateRating.reviewCount, 10);
          if (json.aggregateRating && json.aggregateRating.ratingValue) ldRating = parseFloat(json.aggregateRating.ratingValue);
        }
      } catch (e) {}
    }

    // --- Title ---
    const titleEl = document.querySelector(
      '[data-sqe="name"], [class*="product-briefing"] [class*="title"], ' +
      'h1, [class*="VNWMaH"], [class*="product"] h1, [class*="attM6y"]'
    );
    dados.titulo = titleEl?.innerText?.trim() || document.title.split('|')[0]?.trim() || 'N/A';

    // --- Price ---
    let precoEncontrado = ldPrice;
    if (!precoEncontrado) {
      // Find elements containing only "R$" (Shopee splits currency and value)
      const currencyElements = Array.from(document.querySelectorAll('span, div'))
        .filter(el => el.textContent.trim() === 'R$');
      
      for (const currencyEl of currencyElements) {
        const container = currencyEl.parentElement;
        if (container) {
          const text = container.innerText.replace(/[^\d,.]/g, '').replace(/\./g, '').replace(',', '.');
          const value = parseFloat(text);
          if (!isNaN(value) && value > 0) {
            precoEncontrado = value;
            break;
          }
        }
      }
    }
    
    // Fallback seletores comuns
    if (!precoEncontrado) {
      const priceSelectors = [
        '[data-sqe="price"]', '[class*="price"] [class*="current"]',
        '[class*="pmmxKx"]', '[class*="G27FPf"]', '.pqTWsK', '.Yreb5F'
      ];
      for (const sel of priceSelectors) {
        const el = document.querySelector(sel);
        if (el) {
          const text = el.innerText.replace(/[^\d,.]/g, '').replace(/\./g, '').replace(',', '.');
          const value = parseFloat(text);
          if (!isNaN(value) && value > 0) {
            precoEncontrado = value;
            break;
          }
        }
      }
    }
    dados.preco = precoEncontrado || 0;
    if (!dados.preco) dados.preco = 0;
    dados.valorUnitario = dados.preco;

    // --- Sales ---
    let vendas = ldSales;
    if (!vendas) {
      const allText = document.body.innerText || '';
      const vendasMatch = allText.match(/(\d+[\d.,]*)\s*(mil|k)?\s*vendido/i) || allText.match(/(\d+[\d.,]*)\s*Avaliações/i);
      if (vendasMatch) {
        let numStr = vendasMatch[1].replace(/[^\d,]/g, '').replace(',', '.');
        vendas = parseFloat(numStr);
        if (vendasMatch[2]?.toLowerCase() === 'mil' || vendasMatch[2]?.toLowerCase() === 'k') vendas *= 1000;
      }
    }
    dados.vendas = Math.round(vendas || 0);

    // --- Rating ---
    let rating = ldRating;
    if (!rating) {
      const ratingEl = document.querySelector('[class*="rating"] [class*="score"], [class*="OitLRu"]');
      rating = ratingEl ? parseFloat(ratingEl.innerText) : 0;
    }
    dados.rating = rating;

    // --- Category / Ad type ---
    dados.tipoAnuncio = 'Shopee';

    // --- EAN ---
    dados.ean = 'N/A (Shopee)';

    // --- Free Shipping ---
    const freteText = document.body.innerText.toLowerCase();
    dados.freteGratis = freteText.includes('frete grátis') || freteText.includes('gratis');

    // --- Seller ---
    const sellerEl = document.querySelector(
      '[class*="seller"] [class*="name"], [class*="shop-name"], [class*="page-product__shop"] a, [class*="VlD_Re"]'
    );
    dados.sellerNick = sellerEl?.innerText?.trim() || null;

    // --- Gross Volume ---
    dados.volumeBruto = (dados.valorUnitario && dados.vendas)
      ? dados.valorUnitario * dados.vendas : 0;

    // --- Product ID ---
    const ids = extractShopeeIds();
    dados.productId = ids ? `${ids.shopId}.${ids.itemId}` : null;

    dadosProduto = dados;
    processarSnapshotsVendas(dadosProduto, () => {
      exibirPainelShopee();
    });
  } catch (error) {
    exibirPainelErro('Falha ao extrair dados da Shopee. Tente recarregar.');
  }
}

// ==================================================================
//  SHOPEE — PAINEL HUD (reutiliza a estética Dark Commerce)
// ==================================================================

function exibirPainelShopee() {
  let painelExistente = document.getElementById('meu-painel-analise');
  if (painelExistente) painelExistente.remove();

  const painel = document.createElement('div');
  painel.id = 'meu-painel-analise';

  const freteTag = dadosProduto.freteGratis
    ? '<span class="hud-tag hud-tag-frete-gratis">Frete Grátis</span>' : '';

  painel.innerHTML = `
    <div class="hud-header">
      <h3>📊 ANÁLISE PRO — SHOPEE</h3>
      <button class="hud-close-btn" title="Fechar">✕</button>
    </div>

    <div class="painel-content">
      <!-- Score (atualizado pela calculadora) -->
      <div class="hud-score-section" id="scoreSection" style="display:none;">
        <div class="hud-score-label">Score de Lucratividade</div>
        <div class="hud-score-bar-container">
          <div class="hud-score-bar" id="scoreBar" style="width: 0%;"></div>
        </div>
        <div class="hud-score-value" id="scoreValue">—</div>
      </div>

      <!-- Dados do Produto -->
      <div class="hud-section" id="sectionDados">
        <div class="hud-section-header">
          <span class="hud-section-title">📦 Dados do Produto</span>
          <span class="hud-section-arrow">▼</span>
        </div>
        <div class="hud-section-body">
          <div class="hud-data-row">
            <span class="hud-data-label">Plataforma</span>
            <span class="hud-tag hud-tag-premium">SHOPEE</span>
          </div>
          ${freteTag ? `<div class="hud-data-row"><span class="hud-data-label">Frete</span>${freteTag}</div>` : ''}
          <div class="hud-data-row">
            <span class="hud-data-label">Valor Unitário</span>
            <span class="hud-data-value hud-currency">${formatCurrency(dadosProduto.valorUnitario)}</span>
          </div>
          <div class="hud-data-row">
            <span class="hud-data-label">Vendas Totais</span>
            <span class="hud-data-value">${formatNumber(dadosProduto.vendas)}</span>
          </div>
          ${dadosProduto.dataCriacao ? `
          <div class="hud-data-row">
            <span class="hud-data-label">⏱️ Idade</span>
            <span class="hud-data-value">${formatIdade(dadosProduto.idadeDias)}</span>
          </div>
          <div class="hud-data-row">
            <span class="hud-data-label">${dadosProduto.vendasReais30d !== undefined ? '📈 Vendas/30d (Real)' : '📈 Est. Vendas/30d'}</span>
            <span class="hud-data-value" style="color: ${(dadosProduto.vendasReais30d !== undefined ? dadosProduto.vendasReais30d : dadosProduto.vendasEstimadas30d) > 30 ? 'var(--hud-accent-green)' : (dadosProduto.vendasReais30d !== undefined ? dadosProduto.vendasReais30d : dadosProduto.vendasEstimadas30d) > 10 ? 'var(--hud-accent-amber)' : 'var(--hud-accent-red)'};">
              ${dadosProduto.vendasReais30d !== undefined ? formatNumber(dadosProduto.vendasReais30d) + ' un. <span style="font-size:9px; color:var(--hud-text-secondary);">(' + dadosProduto.diasRastreados + 'd medidos)</span>' : '~' + formatNumber(dadosProduto.vendasEstimadas30d) + ' un.'}
            </span>
          </div>
          <div class="hud-data-row">
            <span class="hud-data-label">🔥 Vendas/Dia</span>
            <span class="hud-data-value" style="font-family: var(--hud-font-mono);">${dadosProduto.vendasPorDia.toFixed(1)}/dia</span>
          </div>
          ` : ''}
          <div class="hud-data-row">
            <span class="hud-data-label">Volume Bruto</span>
            <span class="hud-data-value hud-currency">${formatCurrency(dadosProduto.volumeBruto)}</span>
          </div>
          ${dadosProduto.sellerNick ? `<div class="hud-data-row"><span class="hud-data-label">Vendedor</span><span class="hud-data-value">${dadosProduto.sellerNick}</span></div>` : ''}
        </div>
      </div>

      <!-- Calculadora -->
      <div class="hud-section" id="sectionCalc">
        <div class="hud-section-header">
          <span class="hud-section-title">🧮 Calculadora</span>
          <span class="hud-section-arrow">▼</span>
        </div>
        <div class="hud-section-body">
          <div class="hud-calc-inputs">
            <div class="hud-input-group">
              <label for="custoProduto">Custo do Produto</label>
              <input type="number" id="custoProduto" placeholder="R$ 0,00" step="0.01">
            </div>
            <div class="hud-input-group">
              <label for="custoFrete">Custo do Frete</label>
              <input type="number" id="custoFrete" placeholder="R$ 0,00" step="0.01">
            </div>
          </div>
          <div class="hud-results" id="results">
            <div class="hud-result-row">
              <span class="hud-result-label">Comissão Shopee</span>
              <span class="hud-result-value" id="resTarifaML">R$ 0,00</span>
            </div>
            <div class="hud-result-row">
              <span class="hud-result-label">Impostos & Custos</span>
              <span class="hud-result-value" id="resImpostos">R$ 0,00</span>
            </div>
            <div class="hud-result-row">
              <span class="hud-result-label">Valor Recebido</span>
              <span class="hud-result-value hud-currency" id="resValorRecebido">R$ 0,00</span>
            </div>
            <div class="hud-result-row hud-result-highlight" id="lucroRow">
              <span class="hud-result-label">Lucro por Venda</span>
              <span class="hud-result-value" id="resLucro">R$ 0,00</span>
            </div>
            <div class="hud-result-row">
              <span class="hud-result-label">Margem de Lucro</span>
              <span class="hud-result-value" id="resMargem">0,00%</span>
            </div>
            <div class="hud-result-row">
              <span class="hud-result-label">ROI</span>
              <span class="hud-result-value" id="resROI">0,00%</span>
            </div>
          </div>

          <!-- Matriz de Sensibilidade -->
          <div class="hud-matrix-section" id="matrixSection" style="display:none; margin-top: 15px;">
             <div class="hud-section-header" style="padding: 0; background: transparent; border: none; margin-bottom: 8px;">
               <span class="hud-section-title" style="font-size: 11px; color: var(--hud-text-secondary);">📈 Matriz de Sensibilidade (Preço vs. Lucro)</span>
             </div>
             <table class="hud-matrix-table" style="width: 100%; font-size: 11px; border-collapse: collapse;">
               <thead>
                 <tr style="color: var(--hud-text-secondary); text-align: right; border-bottom: 1px solid var(--hud-border);">
                   <th style="text-align: left; padding: 4px;">Var.</th>
                   <th style="padding: 4px;">Preço</th>
                   <th style="padding: 4px;">Lucro</th>
                   <th style="padding: 4px;">Margem</th>
                 </tr>
               </thead>
               <tbody id="matrixTableBody">
               </tbody>
             </table>
          </div>
        </div>
      </div>
    </div>

    <div class="hud-toast" id="hudToast">Copiado!</div>
    <div class="hud-actions">
      <button class="hud-action-btn" id="btnCopiar" title="Copiar dados">📋 Copiar</button>
      <button class="hud-action-btn" id="btnMidias" title="Baixar Mídias">📸 Mídias</button>
      <button class="hud-action-btn" id="btnGarimpo" title="Salvar no Garimpo">⭐ Garimpo</button>
      <button class="hud-action-btn" id="btnRecarregar" title="Recarregar dados">🔄 Atualizar</button>
    </div>
  `;

  document.body.appendChild(painel);

  setupShopeeCalculadoraListeners();
  setupSectionToggle();

  painel.querySelector('.hud-close-btn').addEventListener('click', () => painel.remove());
  painel.querySelector('#btnCopiar').addEventListener('click', copiarDados);
  const btnMidias = painel.querySelector('#btnMidias');
  if (btnMidias) btnMidias.addEventListener('click', baixarMidiasML);
  painel.querySelector('#btnGarimpo').addEventListener('click', salvarGarimpo);
  painel.querySelector('#btnRecarregar').addEventListener('click', extrairDadosShopee);

  makeDraggable(painel, 'posicaoPainel');
  loadAndApplyPosition(painel, 'posicaoPainel');
}

// ==================================================================
//  SHOPEE — CALCULADORA DE LUCRATIVIDADE
// ==================================================================

function setupShopeeCalculadoraListeners() {
  ['custoProduto', 'custoFrete'].forEach((id) => {
    document.getElementById(id)?.addEventListener('input', calcularLucroShopee);
  });
  calcularLucroShopee();
}

function calcularLucroShopee() {
  const taxas = taxasShopeeCustomizadas || TAXAS_SHOPEE;
  const precoVenda = dadosProduto.valorUnitario || 0;
  const custoProduto = parseFloat(document.getElementById('custoProduto')?.value) || 0;
  const custoFrete = parseFloat(document.getElementById('custoFrete')?.value) || 0;

  const comissaoTotal = precoVenda * taxas.comissao;
  const tarifaShopee = comissaoTotal + taxas.taxaFixa;

  const impostoGlobal = (custosGlobais?.imposto || 0) / 100;
  const custoFixoGlobal = custosGlobais?.custoFixo || 0;
  const valorImposto = precoVenda * impostoGlobal;
  const totalImpostosECustosExtras = valorImposto + custoFixoGlobal;

  const valorRecebido = precoVenda - tarifaShopee - custoFrete;
  const lucro = valorRecebido - custoProduto - totalImpostosECustosExtras;
  const margem = precoVenda > 0 ? (lucro / precoVenda) * 100 : 0;
  const custoTotal = custoProduto + custoFrete + totalImpostosECustosExtras;
  const roi = custoTotal > 0 ? (lucro / custoTotal) * 100 : 0;

  const setVal = (id, text) => {
    const el = document.getElementById(id);
    if (el) el.innerText = text;
  };

  setVal('resTarifaML', formatCurrency(tarifaShopee));
  setVal('resImpostos', formatCurrency(totalImpostosECustosExtras));
  setVal('resValorRecebido', formatCurrency(valorRecebido));
  setVal('resLucro', formatCurrency(lucro));
  setVal('resMargem', `${margem.toFixed(2)}%`);
  setVal('resROI', `${roi.toFixed(2)}%`);

  // Color coding
  const lucroEl = document.getElementById('resLucro');
  const margemEl = document.getElementById('resMargem');
  const roiEl = document.getElementById('resROI');
  const lucroRow = document.getElementById('lucroRow');

  if (lucroEl) lucroEl.style.color = lucro < 0 ? 'var(--hud-accent-red)' : 'var(--hud-accent-green)';
  if (margemEl) margemEl.style.color = margem < 0 ? 'var(--hud-accent-red)' : 'var(--hud-accent-green)';
  if (roiEl) roiEl.style.color = roi < 0 ? 'var(--hud-accent-red)' : 'var(--hud-accent-green)';
  if (lucroRow) {
    lucroRow.classList.remove('lucro-positivo', 'lucro-negativo');
    lucroRow.classList.add(lucro >= 0 ? 'lucro-positivo' : 'lucro-negativo');
  }

  // Score bar
  const scoreSection = document.getElementById('scoreSection');
  const scoreBar = document.getElementById('scoreBar');
  const scoreValue = document.getElementById('scoreValue');

  if (custoProduto > 0 && scoreSection && scoreBar && scoreValue) {
    scoreSection.style.display = 'block';
    const margemClamped = Math.max(0, Math.min(100, margem));
    scoreBar.style.width = `${margemClamped}%`;
    scoreBar.classList.remove('score-red', 'score-amber', 'score-green');
    scoreValue.classList.remove('score-red', 'score-amber', 'score-green');
    let scoreClass = margem < 15 ? 'score-red' : margem < 30 ? 'score-amber' : 'score-green';
    scoreBar.classList.add(scoreClass);
    scoreValue.classList.add(scoreClass);
    scoreValue.innerText = `${margem.toFixed(1)}%`;
    
    renderMatrixShopee(precoVenda, custoProduto, custoFrete, taxas);
  } else if (scoreSection) {
    scoreSection.style.display = 'none';
    const matrixSection = document.getElementById('matrixSection');
    if (matrixSection) matrixSection.style.display = 'none';
  }
}

function renderMatrixShopee(precoAtual, custoProduto, custoFrete, taxas) {
  const matrixSection = document.getElementById('matrixSection');
  const matrixTableBody = document.getElementById('matrixTableBody');
  if (!matrixSection || !matrixTableBody) return;

  matrixSection.style.display = 'block';

  const impostoGlobal = (custosGlobais?.imposto || 0) / 100;
  const custoFixoGlobal = custosGlobais?.custoFixo || 0;

  const variacoes = [-0.10, -0.05, 0, 0.05, 0.10];
  const variacoesLabels = ['-10%', '-5%', 'Atual', '+5%', '+10%'];

  let html = '';

  variacoes.forEach((variacao, index) => {
    const precoSimulado = precoAtual * (1 + variacao);
    
    const comissaoTotal = precoSimulado * taxas.comissao;
    const tarifaShopee = comissaoTotal + taxas.taxaFixa;

    const valorImposto = precoSimulado * impostoGlobal;
    const totalImpostos = valorImposto + custoFixoGlobal;

    const valorRecebido = precoSimulado - tarifaShopee - custoFrete;
    const lucro = valorRecebido - custoProduto - totalImpostos;
    const margem = precoSimulado > 0 ? (lucro / precoSimulado) * 100 : 0;

    const isAtual = variacao === 0;
    const rowBg = isAtual ? 'rgba(0, 255, 136, 0.1)' : 'transparent';
    const lucroColor = lucro >= 0 ? 'var(--hud-accent-green)' : 'var(--hud-accent-red)';
    const fontW = isAtual ? 'bold' : 'normal';

    html += `
      <tr style="text-align: right; background: ${rowBg}; font-weight: ${fontW};">
        <td style="text-align: left; padding: 4px;">${variacoesLabels[index]}</td>
        <td style="padding: 4px;">${formatCurrency(precoSimulado)}</td>
        <td style="padding: 4px; color: ${lucroColor};">${formatCurrency(lucro)}</td>
        <td style="padding: 4px; color: ${lucroColor};">${margem.toFixed(1)}%</td>
      </tr>
    `;
  });

  matrixTableBody.innerHTML = html;
}

// ==================================================================
//  SHOPEE — BUSCA: INJEÇÃO DE BADGES
// ==================================================================

function scanAndInjectShopeeBadges() {
  const selectors = [
    '[data-sqe="item"]',
    '.shopee-search-item-result__item',
    '[class*="search-item"]',
    '.col-xs-2-4',
  ];

  let cards = [];
  for (const sel of selectors) {
    const found = document.querySelectorAll(sel);
    if (found.length > 0) {
      cards = found;
      break;
    }
  }

  // Fallback: any grid of product-like links
  if (cards.length === 0) {
    const gridItems = document.querySelectorAll('a[href*="-i."][data-sqe], a[href*="-i."]');
    if (gridItems.length > 0) {
      cards = [];
      gridItems.forEach((a) => {
        const parent = a.closest('li, div[class]');
        if (parent && !parent.querySelector('.ml-search-badge')) cards.push(parent);
      });
    }
  }

  cards.forEach((card) => {
    try {
      if (card.querySelector('.ml-search-badge')) return;

      // Try to extract price from the card text
      const text = card.innerText || '';
      let preco = 0;
      const priceMatch = text.match(/R\$\s*([\d.]+[,.]\d{2})/i);
      if (priceMatch) {
        preco = parseFloat(priceMatch[1].replace(/\./g, '').replace(',', '.'));
      }

      // Try to extract sold count
      let vendas = 0;
      const soldMatch = text.match(/(\d[\d.]*)\s*(mil)?\s*vendido/i);
      if (soldMatch) {
        vendas = parseInt(soldMatch[1].replace(/\./g, ''), 10);
        if (soldMatch[2]) vendas *= 1000;
      }

      const faturamento = preco * vendas;
      const freteGratis = text.toLowerCase().includes('frete grátis') || text.toLowerCase().includes('gratis');

      const badge = document.createElement('div');
      badge.className = 'ml-search-badge';

      const parts = [];
      if (preco > 0) {
        parts.push(`<span class="ml-search-badge__item ml-search-badge__item--faturamento">
          <span class="ml-search-badge__icon">💲</span>
          <span class="ml-search-badge__value">${preco.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}</span>
        </span>`);
      }
      if (vendas > 0) {
        parts.push(`<span class="ml-search-badge__separator"></span>`);
        parts.push(`<span class="ml-search-badge__item ml-search-badge__item--vendas">
          <span class="ml-search-badge__icon">📦</span>
          <span class="ml-search-badge__value">${vendas.toLocaleString('pt-BR')}</span> vendas
        </span>`);
      }
      if (freteGratis) {
        parts.push('<span class="ml-search-badge__tag ml-search-badge__tag--frete">Frete Grátis</span>');
      }

      badge.innerHTML = parts.join('');
      card.appendChild(badge);
    } catch (_) { /* ignore */ }
  });
}

function observeShopeeSearchResults() {
  // Shopee is SPA, wait for content to render
  setTimeout(scanAndInjectShopeeBadges, 2000);

  const observer = new MutationObserver(() => {
    scanAndInjectShopeeBadges();
  });

  observer.observe(document.body, { childList: true, subtree: true });
}

// ==================================================================
//  INICIALIZAÇÃO — ROTEAMENTO DE CONTEXTO (com suporte a SPA)
// ==================================================================

function createAnalysisButton(extractFn) {
  if (document.querySelector('.meu-botao-analise')) return;
  const botaoAnalisar = document.createElement('button');
  botaoAnalisar.innerText = '▶ ANÁLISE PRO';
  botaoAnalisar.className = 'meu-botao-analise';
  document.body.appendChild(botaoAnalisar);
  botaoAnalisar.addEventListener('click', extractFn);
  makeDraggable(botaoAnalisar, 'posicaoBotao');
  loadAndApplyPosition(botaoAnalisar, 'posicaoBotao');
}

function removeAnalysisButton() {
  const btn = document.querySelector('.meu-botao-analise');
  if (btn) btn.remove();
  const painel = document.getElementById('meu-painel-analise');
  if (painel) painel.remove();
}

function routeContext() {
  // ========== SHOPEE ==========
  if (CURRENT_PLATFORM === 'shopee') {
    if (isShopeeSearchPage()) {
      removeAnalysisButton();
      observeShopeeSearchResults();
      return;
    }
    if (isShopeeProductPage()) {
      setTimeout(() => createAnalysisButton(extrairDadosShopee), 2000);
      return;
    }
    removeAnalysisButton();
    return;
  }

  // ========== MERCADO LIVRE ==========
  if (isSearchPage()) {
    removeAnalysisButton();
    observeSearchResults();
    return;
  }

  if (isProductPage()) {
    createAnalysisButton(extrairDados);
    return;
  }

  // Fallback: wait for ML React DOM to hydrate
  const waitForPDP = () => {
    if (document.querySelector('.ui-pdp-container, .ui-vip-core')) {
      createAnalysisButton(extrairDados);
      return;
    }
    // Check if URL now matches product page pattern
    const url = window.location.href;
    if (url.includes('/MLB-') || url.includes('/p/MLB')) {
      // DOM not ready yet — try MutationObserver briefly
      const observer = new MutationObserver((_, obs) => {
        if (document.querySelector('.ui-pdp-container, .ui-vip-core') || document.querySelector('[class*="pdp"]')) {
          obs.disconnect();
          createAnalysisButton(extrairDados);
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
      // Stop observing after 10s to avoid leaking
      setTimeout(() => observer.disconnect(), 10000);
    }
  };
  waitForPDP();
}

// SPA Navigation Detection: ML and Shopee are both SPAs.
// The content script only runs once, so we need to detect URL changes.
let lastUrl = window.location.href;

function checkUrlChange() {
  const currentUrl = window.location.href;
  if (currentUrl !== lastUrl) {
    lastUrl = currentUrl;
    removeAnalysisButton();
    routeContext();
  } else {
    // Evita que o botão de análise suma após a hidratação da DOM pelo React
    if (CURRENT_PLATFORM === 'shopee' && isShopeeProductPage()) {
      if (!document.querySelector('.meu-botao-analise')) {
        createAnalysisButton(extrairDadosShopee);
      }
    } else if (CURRENT_PLATFORM === 'meli' && isProductPage()) {
      if (!document.querySelector('.meu-botao-analise')) {
        createAnalysisButton(extrairDados);
      }
    }
  }
}

// Run routing on initial load
routeContext();

// Poll for URL changes every 1.5 seconds (lightweight)
setInterval(checkUrlChange, 1500);

// Also listen for popstate (browser back/forward)
window.addEventListener('popstate', () => {
  setTimeout(() => {
    lastUrl = window.location.href;
    removeAnalysisButton();
    routeContext();
  }, 500);
});
