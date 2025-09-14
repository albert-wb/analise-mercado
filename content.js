console.log("Meu Analisador (v4.1 - Correção Vendas) carregado!");

// --- ESTRUTURA DE TAXAS (EXEMPLO) ---
const TAXAS_MERCADO_LIVRE = {
    "limiteCustoFixo": 79.00,
    "custoFixo": 6.00,
    "taxasPorAnuncio": {
        "Classico": 0.13, // 13%
        "Premium": 0.18   // 18%
    }
};

let dadosProduto = {};

function extrairDados() {
    console.log("Iniciando extração de dados Pro...");
    let dados = {};

    // --- 1. Extração Principal via JSON-LD ---
    try {
        const scriptJsonLD = document.querySelector('script[type="application/ld+json"]');
        if (scriptJsonLD) {
            const data = JSON.parse(scriptJsonLD.innerHTML);
            dados.titulo = data.name;
            if (data.offers && data.offers.offers) {
                dados.preco = parseFloat(data.offers.offers[0].price);
            } else if (data.offers) {
                dados.preco = parseFloat(data.offers.price);
            }
        }
    } catch (error) { console.error("Falha ao extrair do JSON-LD.", error); }

    // --- 2. Extração via DOM ---
    const getText = (selector) => document.querySelector(selector)?.innerText.trim() || null;

    if (!dados.preco) {
        const precoString = getText('.andes-money-amount__fraction');
        if (precoString) {
            dados.preco = parseFloat(precoString.replace(/\./g, '').replace(',', '.'));
        }
    }
    dados.valorUnitario = dados.preco;

    // ==================================================================
    //  INÍCIO DA CORREÇÃO - Extração de Vendas Inteligente
    // ==================================================================
    const vendasTexto = getText('.ui-pdp-subtitle'); // Ex: "Novo | +5 mil vendidos"
    let vendas = 0;
    if (vendasTexto) {
        const textoNormalizado = vendasTexto.toLowerCase(); // -> "novo | +5 mil vendidos"
        
        // Pega apenas a parte numérica da string
        const match = textoNormalizado.match(/(\d[\d\.]*)/g);
        
        if (match) {
            // Pega o último número encontrado, remove os pontos e converte para inteiro
            let numeroBase = parseInt(match[match.length - 1].replace(/\./g, '')); // -> 5
            
            // Verifica se a string original continha "mil"
            if (textoNormalizado.includes('mil')) {
                vendas = numeroBase * 1000; // -> 5 * 1000 = 5000
            } else {
                vendas = numeroBase;
            }
        }
    }
    dados.vendas = vendas;
    // ==================================================================
    //  FIM DA CORREÇÃO
    // ==================================================================

    // --- 3. Deducao do Tipo de Anuncio ---
    const installmentsInfo = getText('.ui-pdp-price__subtitles');
    dados.tipoAnuncio = (installmentsInfo && installmentsInfo.toLowerCase().includes('sem juros')) ? "Premium" : "Classico";

    // --- 4. Extração do EAN (GTIN) ---
    dados.ean = "Não encontrado";
    const specTableRows = document.querySelectorAll('.ui-vpp-striped-specs__row');
    specTableRows.forEach(row => {
        const header = row.querySelector('th')?.innerText.trim().toUpperCase();
        if (header === 'EAN' || header === 'CÓDIGO UNIVERSAL DE PRODUTO' || header === 'GTIN') {
            dados.ean = row.querySelector('td')?.innerText.trim();
        }
    });

    // --- 5. Cálculos Brutos ---
    dados.volumeBruto = (dados.valorUnitario && dados.vendas) ? (dados.valorUnitario * dados.vendas) : 0;
    
    dadosProduto = dados;
    console.log("Dados extraídos:", dadosProduto);
    exibirPainel();
}

// ... (O restante do arquivo: exibirPainel, setupCalculadoraListeners, calcularLucro, e o botão, continua EXATAMENTE IGUAL) ...

function exibirPainel() {
    let painelExistente = document.getElementById('meu-painel-analise');
    if (painelExistente) painelExistente.remove();

    const painel = document.createElement('div');
    painel.id = 'meu-painel-analise';

    const formatCurrency = (num) => num ? num.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) : 'N/A';
    const formatNumber = (num) => num ? num.toLocaleString('pt-BR') : 'N/A';

    painel.innerHTML = `
        <h3>📊 Análise de Produto</h3>
        <div class="section">
            <p><strong>EAN:</strong> <span class="highlight">${dadosProduto.ean || 'N/A'}</span></p>
            <p><strong>Tipo de Anúncio:</strong> <span class="highlight">${dadosProduto.tipoAnuncio}</span></p>
        </div>
        <div class="section">
            <p><strong>Valor Unitário:</strong> ${formatCurrency(dadosProduto.valorUnitario)}</p>
            <p><strong>Vendas Estimadas:</strong> ${formatNumber(dadosProduto.vendas)}</p>
            <p><strong>Volume Bruto (Receita):</strong> ${formatCurrency(dadosProduto.volumeBruto)}</p>
        </div>
        
        <div class="section calculator">
            <h4>Calculadora de Lucratividade</h4>
            <div class="input-group">
                <label for="custoProduto">Custo do Produto (R$)</label>
                <input type="number" id="custoProduto" placeholder="Ex: 25,50">
            </div>
            <div class="input-group">
                <label for="custoFrete">Custo do Frete (R$)</label>
                <input type="number" id="custoFrete" placeholder="Se houver">
            </div>
            <div id="results">
                <p><strong>Tarifa ML:</strong> <span id="resTarifaML">R$ 0,00</span></p>
                <p><strong>Valor Recebido (por venda):</strong> <span id="resValorRecebido" class="highlight">R$ 0,00</span></p>
                <hr>
                <p><strong>Lucro por Venda:</strong> <span id="resLucro" class="lucro">R$ 0,00</span></p>
                <p><strong>Margem de Lucro:</strong> <span id="resMargem" class="lucro">0,00%</span></p>
            </div>
        </div>
    `;

    document.body.appendChild(painel);
    setupCalculadoraListeners();
}

function setupCalculadoraListeners() {
    const inputs = ['custoProduto', 'custoFrete'];
    inputs.forEach(id => {
        document.getElementById(id).addEventListener('input', calcularLucro);
    });
    calcularLucro(); 
}

function calcularLucro() {
    const precoVenda = dadosProduto.valorUnitario || 0;
    const tipoAnuncio = dadosProduto.tipoAnuncio || "Classico";

    const custoProduto = parseFloat(document.getElementById('custoProduto').value) || 0;
    const custoFrete = parseFloat(document.getElementById('custoFrete').value) || 0;

    const taxaPercentual = TAXAS_MERCADO_LIVRE.taxasPorAnuncio[tipoAnuncio];
    let comissaoML = precoVenda * taxaPercentual;
    let custoFixoML = (precoVenda < TAXAS_MERCADO_LIVRE.limiteCustoFixo) ? TAXAS_MERCADO_LIVRE.custoFixo : 0;
    const tarifaTotalML = comissaoML + custoFixoML;

    const valorRecebido = precoVenda - tarifaTotalML - custoFrete;
    const lucro = valorRecebido - custoProduto;
    const margem = (precoVenda > 0) ? (lucro / precoVenda) * 100 : 0;

    document.getElementById('resTarifaML').innerText = tarifaTotalML.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    document.getElementById('resValorRecebido').innerText = valorRecebido.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    document.getElementById('resLucro').innerText = lucro.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    document.getElementById('resMargem').innerText = `${margem.toFixed(2)}%`;

    const lucroElements = document.querySelectorAll('.lucro');
    const valorRecebidoEl = document.getElementById('resValorRecebido');
    lucro < 0 ? lucroElements.forEach(el => el.classList.add('prejuizo')) : lucroElements.forEach(el => el.classList.remove('prejuizo'));
    valorRecebido < custoProduto ? valorRecebidoEl.classList.add('prejuizo') : valorRecebidoEl.classList.remove('prejuizo');
}

if (!document.querySelector('.meu-botao-analise')) {
    const botaoAnalisar = document.createElement('button');
    botaoAnalisar.innerText = "Análise PRO";
    botaoAnalisar.className = 'meu-botao-analise';
    document.body.appendChild(botaoAnalisar);
    botaoAnalisar.addEventListener('click', extrairDados);
}