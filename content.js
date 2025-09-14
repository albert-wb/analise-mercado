console.log("Meu Analisador (v3.0 - Calculadora) carregado!");

// --- ESTRUTURA DE TAXAS (EXEMPLO) ---
// ATENÇÃO: Estes valores são apenas exemplos! Consulte a página oficial do
// Mercado Livre para obter as taxas mais recentes e completas para cada categoria.
const TAXAS_MERCADO_LIVRE = {
    "limiteCustoFixo": 79.00,
    "custoFixo": 6.00,
    "taxasPorAnuncio": {
        "Classico": 0.13, // 13%
        "Premium": 0.18   // 18%
    }
    // Para uma versão mais avançada, você poderia detalhar por categoria:
    // "taxasPorCategoria": { "Eletronicos": { "Classico": 0.14, "Premium": 0.19 }, ... }
};

// Objeto global para armazenar os dados do produto
let dadosProduto = {};

function analisarProduto() {
    console.log("Iniciando análise avançada...");

    // ... (O código de extração de dados da versão anterior continua o mesmo) ...
    let dados = {};
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
    } catch (error) {
        console.error("Falha ao extrair preço do JSON-LD. Tentando via DOM.", error);
    }
    
    if (!dados.preco) {
        const precoString = document.querySelector('.andes-money-amount__fraction')?.innerText;
        if (precoString) {
            dados.preco = parseFloat(precoString.replace(/\./g, '').replace(',', '.'));
        }
    }
    // ----
    
    dadosProduto = dados; // Salva os dados do produto globalmente
    exibirPainel();
}

function exibirPainel() {
    let painelExistente = document.getElementById('meu-painel-analise');
    if (painelExistente) painelExistente.remove();

    const painel = document.createElement('div');
    painel.id = 'meu-painel-analise';
    
    const precoVenda = dadosProduto.preco || 0;

    painel.innerHTML = `
        <h3>📊 Análise e Lucratividade</h3>
        <div class="section">
            <p><strong>Produto:</strong> ${dadosProduto.titulo || 'Não encontrado'}</p>
            <p><strong>Preço de Venda:</strong> <span class="price">${precoVenda.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}</span></p>
        </div>
        
        <div class="section calculator">
            <h4>Calculadora de Lucro</h4>
            <div class="input-group">
                <label for="custoProduto">Custo do Produto (R$)</label>
                <input type="number" id="custoProduto" placeholder="Ex: 25,50">
            </div>
            <div class="input-group">
                <label for="custoFrete">Custo do Frete (R$)</label>
                <input type="number" id="custoFrete" placeholder="Custo do frete grátis">
            </div>
            <div class="input-group">
                <label for="outrosCustos">Outros Custos (R$)</label>
                <input type="number" id="outrosCustos" placeholder="Impostos, embalagem...">
            </div>
            <div class="input-group">
                <label for="tipoAnuncio">Tipo de Anúncio</label>
                <select id="tipoAnuncio">
                    <option value="Classico">Clássico (${TAXAS_MERCADO_LIVRE.taxasPorAnuncio.Classico * 100}%)</option>
                    <option value="Premium">Premium (${TAXAS_MERCADO_LIVRE.taxasPorAnuncio.Premium * 100}%)</option>
                </select>
            </div>
            <div id="results">
                <p><strong>Tarifa ML:</strong> <span id="resTarifaML">R$ 0,00</span></p>
                <p><strong>Custos Totais:</strong> <span id="resCustosTotais">R$ 0,00</span></p>
                <hr>
                <p><strong>Lucro por Venda:</strong> <span id="resLucro" class="lucro">R$ 0,00</span></p>
                <p><strong>Margem de Lucro:</strong> <span id="resMargem" class="lucro">0,00%</span></p>
            </div>
        </div>
    `;

    document.body.appendChild(painel);
    setupCalculadoraListeners(); // Adiciona os "ouvintes" aos inputs
}

function setupCalculadoraListeners() {
    const inputs = ['custoProduto', 'custoFrete', 'outrosCustos', 'tipoAnuncio'];
    inputs.forEach(id => {
        document.getElementById(id).addEventListener('input', calcularLucro);
    });
    calcularLucro(); // Roda uma vez para inicializar com valores zerados
}

function calcularLucro() {
    const precoVenda = dadosProduto.preco || 0;

    // 1. Ler os valores dos inputs
    const custoProduto = parseFloat(document.getElementById('custoProduto').value) || 0;
    const custoFrete = parseFloat(document.getElementById('custoFrete').value) || 0;
    const outrosCustos = parseFloat(document.getElementById('outrosCustos').value) || 0;
    const tipoAnuncio = document.getElementById('tipoAnuncio').value;

    // 2. Calcular as taxas do Mercado Livre
    const taxaPercentual = TAXAS_MERCADO_LIVRE.taxasPorAnuncio[tipoAnuncio];
    let comissaoML = precoVenda * taxaPercentual;
    let custoFixoML = 0;
    if (precoVenda < TAXAS_MERCADO_LIVRE.limiteCustoFixo) {
        custoFixoML = TAXAS_MERCADO_LIVRE.custoFixo;
    }
    const tarifaTotalML = comissaoML + custoFixoML;

    // 3. Calcular os resultados
    const custosTotais = tarifaTotalML + custoProduto + custoFrete + outrosCustos;
    const lucro = precoVenda - custosTotais;
    const margem = (precoVenda > 0) ? (lucro / precoVenda) * 100 : 0;

    // 4. Exibir os resultados na tela
    document.getElementById('resTarifaML').innerText = tarifaTotalML.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    document.getElementById('resCustosTotais').innerText = custosTotais.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    document.getElementById('resLucro').innerText = lucro.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    document.getElementById('resMargem').innerText = `${margem.toFixed(2)}%`;

    // Adiciona uma cor para lucro/prejuízo
    const lucroElements = document.querySelectorAll('.lucro');
    if (lucro < 0) {
        lucroElements.forEach(el => el.style.color = '#e74c3c'); // Vermelho
    } else {
        lucroElements.forEach(el => el.style.color = '#2ecc71'); // Verde
    }
}


// Cria o botão de análise somente se ele ainda não existir na página
if (!document.querySelector('.meu-botao-analise')) {
    const botaoAnalisar = document.createElement('button');
    botaoAnalisar.innerText = "Analisar Lucratividade";
    botaoAnalisar.className = 'meu-botao-analise';
    document.body.appendChild(botaoAnalisar);
    botaoAnalisar.addEventListener('click', analisarProduto);
}