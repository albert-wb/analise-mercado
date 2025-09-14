console.log("Meu Analisador (v2.0) carregado!");

// Função principal que será executada
function analisarProduto() {
  console.log("Iniciando análise avançada...");

  let dados = {};

  // --- MÉTODO 1: TENTAR EXTRAIR DO JSON-LD (MUITO MAIS ROBUSTO) ---
  try {
    const scriptJsonLD = document.querySelector('script[type="application/ld+json"]');
    if (scriptJsonLD) {
      const data = JSON.parse(scriptJsonLD.innerHTML);
      
      dados.titulo = data.name;
      dados.sku = data.sku;
      dados.descricao = data.description;
      dados.condicao = data.itemCondition?.includes('New') ? 'Novo' : 'Usado';
      
      if (data.offers && data.offers.offers) {
          dados.preco = parseFloat(data.offers.offers[0].price);
          dados.moeda = data.offers.offers[0].priceCurrency;
      } else if (data.offers) {
          dados.preco = parseFloat(data.offers.price);
          dados.moeda = data.offers.priceCurrency;
      }

      if (data.aggregateRating) {
        dados.notaMedia = data.aggregateRating.ratingValue;
        dados.totalAvaliacoes = data.aggregateRating.reviewCount;
      }
      
      dados.marca = data.brand?.name;
      console.log("Dados extraídos com sucesso via JSON-LD!", dados);
    }
  } catch (error) {
    console.error("Falha ao extrair dados do JSON-LD. Tentando via DOM.", error);
  }

  // --- MÉTODO 2: EXTRAIR DADOS DO DOM (FALLBACK E DADOS COMPLEMENTARES) ---
  // Usamos isso para pegar dados que não estão no JSON, como Vendas e Vendedor.
  
  // Função auxiliar para pegar texto de forma segura
  const getText = (selector) => {
    const element = document.querySelector(selector);
    return element ? element.innerText.trim() : null;
  };
  
  // Se o título não foi pego pelo JSON, tenta pelo seletor
  if (!dados.titulo) {
      dados.titulo = getText('.ui-pdp-title');
  }
  
  // A quantidade de vendas raramente está no JSON, então sempre pegamos do DOM
  const vendasTexto = getText('.ui-pdp-subtitle'); // Seletor: "Novo  |  +5000 vendidos"
  let vendas = 0;
  if (vendasTexto) {
    const match = vendasTexto.match(/(\d[\d\.]*)/g); // Expressão regular para pegar números (incluindo com pontos)
    if (match) {
      vendas = parseInt(match[match.length - 1].replace(/\./g, '')); // Pega o último número e remove pontos
    }
  }
  dados.vendas = vendas;

  // Extraindo informações do vendedor
  const sellerElement = document.querySelector('.ui-pdp-seller__link-trigger');
  if (sellerElement) {
      dados.vendedorNome = sellerElement.innerText;
      dados.vendedorLink = sellerElement.href;
  } else {
      // Tenta um seletor alternativo para o nome do vendedor
      dados.vendedorNome = getText('.ui-pdp-seller__header__title');
  }

  // --- CÁLCULOS FINAIS ---
  dados.faturamentoEstimado = (dados.preco && dados.vendas) ? (dados.preco * dados.vendas) : 0;

  exibirPainel(dados);
}


function exibirPainel(dados) {
  // Remove o painel antigo se existir
  let painelExistente = document.getElementById('meu-painel-analise');
  if (painelExistente) painelExistente.remove();

  // Cria o novo painel
  const painel = document.createElement('div');
  painel.id = 'meu-painel-analise';
  
  // Formatação para exibir os dados de forma mais limpa
  const formatNumber = (num) => num ? num.toLocaleString('pt-BR') : 'N/A';
  const formatCurrency = (num) => num ? num.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) : 'N/A';
  
  painel.innerHTML = `
    <h3>📊 Análise Avançada</h3>
    <div class="section">
        <p><strong>Produto:</strong> ${dados.titulo || 'Não encontrado'}</p>
        <p><strong>Marca:</strong> ${dados.marca || 'N/A'}</p>
        <p><strong>Condição:</strong> ${dados.condicao || 'N/A'}</p>
    </div>
    <div class="section">
        <p><strong>Preço:</strong> <span class="price">${formatCurrency(dados.preco)}</span></p>
        <p><strong>Vendas:</strong> ${formatNumber(dados.vendas)}</p>
        <p><strong>Faturamento Est.:</strong> ${formatCurrency(dados.faturamentoEstimado)}</p>
    </div>
    <div class="section">
        <p><strong>Avaliações:</strong> ⭐ ${dados.notaMedia || 'N/A'} (${formatNumber(dados.totalAvaliacoes)} reviews)</p>
    </div>
    <div class="section">
        <p><strong>Vendedor:</strong> <a href="${dados.vendedorLink || '#'}" target="_blank">${dados.vendedorNome || 'Não encontrado'}</a></p>
    </div>
  `;

  document.body.appendChild(painel);
  console.log("Análise concluída e painel exibido.");
}


// Cria o botão de análise somente se ele ainda não existir na página
if (!document.querySelector('.meu-botao-analise')) {
  const botaoAnalisar = document.createElement('button');
  botaoAnalisar.innerText = "Análise Avançada";
  botaoAnalisar.className = 'meu-botao-analise';
  document.body.appendChild(botaoAnalisar);
  botaoAnalisar.addEventListener('click', analisarProduto);
}