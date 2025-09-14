console.log("Meu Analisador carregado!");

// Função principal que será executada
function analisarProduto() {
  // --- PASSO 1: Encontrar os dados na página ---
  // ATENÇÃO: Estes seletores SÃO EXEMPLOS e provavelmente precisarão ser atualizados!
  const seletorTitulo = '.ui-pdp-title';
  const seletorPreco = '.andes-money-amount__fraction';
  const seletorVendas = '.ui-pdp-subtitle'; // O ML geralmente coloca "Novo  |  +5000 vendidos"

  // Usamos querySelector para pegar o texto de cada elemento
  const titulo = document.querySelector(seletorTitulo)?.innerText;
  const precoString = document.querySelector(seletorPreco)?.innerText.replace('.', ''); // Remove o ponto de milhar
  const preco = parseFloat(precoString);

  // Extrair apenas os números de vendas do texto
  let vendasTexto = document.querySelector(seletorVendas)?.innerText || '0 vendidos';
  let vendas = parseInt(vendasTexto.replace(/[^0-9]/g, '')); // Remove tudo que não for número

  // Se não encontrar um número (ex: "+ de 5000"), podemos fazer uma estimativa
  if (isNaN(vendas)) {
      if (vendasTexto.includes('+')) {
          vendas = parseInt(vendasTexto.replace(/[^0-9]/g, ''))
      } else {
          vendas = 0; // Se não conseguir extrair, define como 0
      }
  }


  // --- PASSO 2: Calcular métricas simples ---
  const faturamentoEstimado = !isNaN(preco) && !isNaN(vendas) ? (preco * vendas) : 0;


  // --- PASSO 3: Criar e exibir o nosso painel ---
  // Verifica se o painel já existe para não criar vários
  let painelExistente = document.getElementById('meu-painel-analise');
  if (painelExistente) {
    painelExistente.remove();
  }

  const painel = document.createElement('div');
  painel.id = 'meu-painel-analise';
  painel.innerHTML = `
    <h3>📊 Minha Análise Rápida</h3>
    <p><strong>Título:</strong> ${titulo || 'Não encontrado'}</p>
    <p><strong>Preço:</strong> R$ ${preco.toFixed(2) || 'Não encontrado'}</p>
    <p><strong>Vendas (aprox.):</strong> ${vendas || 'Não encontrado'}</p>
    <hr>
    <p><strong>Faturamento Estimado:</strong> R$ ${faturamentoEstimado.toLocaleString('pt-BR', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</p>
  `;

  // Adiciona o painel ao corpo da página
  document.body.appendChild(painel);
}


// --- INJETAR O BOTÃO NA PÁGINA ---
const botaoAnalisar = document.createElement('button');
botaoAnalisar.innerText = "Analisar Produto";
botaoAnalisar.className = 'meu-botao-analise'; // Usaremos esta classe para estilizar
document.body.appendChild(botaoAnalisar);

// Adiciona um "ouvinte" de clique no botão
botaoAnalisar.addEventListener('click', analisarProduto);