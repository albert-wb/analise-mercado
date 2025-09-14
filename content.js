console.log("Meu Analisador (v5.0 - UI Flexível) carregado!");

// ... (A constante TAXAS_MERCADO_LIVRE e a variável dadosProduto continuam iguais) ...
const TAXAS_MERCADO_LIVRE = {
  limiteCustoFixo: 79.0,
  custoFixo: 6.0,
  taxasPorAnuncio: { Classico: 0.13, Premium: 0.18 },
};
let dadosProduto = {};

// ==================================================================
//  NOVA FUNÇÃO - TORNAR ELEMENTOS ARRASTÁVEIS
// ==================================================================
function makeDraggable(element, storageKey) {
  let pos1 = 0,
    pos2 = 0,
    pos3 = 0,
    pos4 = 0;

  // Define o header do painel como a área de arrastar, ou o próprio elemento se não houver header
  const dragHandle = element.querySelector("h3") || element;

  dragHandle.onmousedown = dragMouseDown;

  function dragMouseDown(e) {
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
    element.style.top = element.offsetTop - pos2 + "px";
    element.style.left = element.offsetLeft - pos1 + "px";
  }

  function closeDragElement() {
    document.onmouseup = null;
    document.onmousemove = null;
    // Salva a posição final
    savePosition(storageKey, {
      top: element.style.top,
      left: element.style.left,
    });
  }
}

// ==================================================================
//  NOVAS FUNÇÕES - SALVAR E CARREGAR POSIÇÕES
// ==================================================================
function savePosition(key, value) {
  chrome.storage.local.set({ [key]: value }, () => {
    console.log(`Posição de '${key}' salva.`);
  });
}

async function loadAndApplyPosition(element, storageKey) {
  chrome.storage.local.get(storageKey, (result) => {
    const pos = result[storageKey];
    if (pos) {
      console.log(`Posição de '${key}' carregada:`, pos);
      if (pos.top) element.style.top = pos.top;
      if (pos.left) element.style.left = pos.left;
      if (pos.width) element.style.width = pos.width;
      if (pos.height) element.style.height = pos.height;
    }
  });
}

// ... (A função extrairDados continua a mesma da v4.1) ...
function extrairDados() {
  console.log("Iniciando extração de dados Pro...");
  let dados = {};
  try {
    const scriptJsonLD = document.querySelector(
      'script[type="application/ld+json"]'
    );
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
    console.error("Falha ao extrair do JSON-LD.", error);
  }
  const getText = (selector) =>
    document.querySelector(selector)?.innerText.trim() || null;
  if (!dados.preco) {
    const precoString = getText(".andes-money-amount__fraction");
    if (precoString) {
      dados.preco = parseFloat(
        precoString.replace(/\./g, "").replace(",", ".")
      );
    }
  }
  dados.valorUnitario = dados.preco;
  const vendasTexto = getText(".ui-pdp-subtitle");
  let vendas = 0;
  if (vendasTexto) {
    const textoNormalizado = vendasTexto.toLowerCase();
    const match = textoNormalizado.match(/(\d[\d\.]*)/g);
    if (match) {
      let numeroBase = parseInt(match[match.length - 1].replace(/\./g, ""));
      if (textoNormalizado.includes("mil")) {
        vendas = numeroBase * 1000;
      } else {
        vendas = numeroBase;
      }
    }
  }
  dados.vendas = vendas;
  const installmentsInfo = getText(".ui-pdp-price__subtitles");
  dados.tipoAnuncio =
    installmentsInfo && installmentsInfo.toLowerCase().includes("sem juros")
      ? "Premium"
      : "Classico";
  dados.ean = "Não encontrado";
  const specTableRows = document.querySelectorAll(".ui-vpp-striped-specs__row");
  specTableRows.forEach((row) => {
    const header = row.querySelector("th")?.innerText.trim().toUpperCase();
    if (
      header === "EAN" ||
      header === "CÓDIGO UNIVERSAL DE PRODUTO" ||
      header === "GTIN"
    ) {
      dados.ean = row.querySelector("td")?.innerText.trim();
    }
  });
  dados.volumeBruto =
    dados.valorUnitario && dados.vendas
      ? dados.valorUnitario * dados.vendas
      : 0;
  dadosProduto = dados;
  console.log("Dados extraídos:", dadosProduto);
  exibirPainel();
}

function exibirPainel() {
  let painelExistente = document.getElementById("meu-painel-analise");
  if (painelExistente) painelExistente.remove();

  const painel = document.createElement("div");
  painel.id = "meu-painel-analise";

  const formatCurrency = (num) =>
    num
      ? num.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })
      : "N/A";
  const formatNumber = (num) => (num ? num.toLocaleString("pt-BR") : "N/A");

  painel.innerHTML = `
        <h3>📊 Análise de Produto</h3>
        <div class="painel-content">
            <div class="section">
                <p><strong>EAN:</strong> <span class="highlight">${
                  dadosProduto.ean || "N/A"
                }</span></p>
                <p><strong>Tipo de Anúncio:</strong> <span class="highlight">${
                  dadosProduto.tipoAnuncio
                }</span></p>
            </div>
            <div class="section">
                <p><strong>Valor Unitário:</strong> ${formatCurrency(
                  dadosProduto.valorUnitario
                )}</p>
                <p><strong>Vendas Estimadas:</strong> ${formatNumber(
                  dadosProduto.vendas
                )}</p>
                <p><strong>Volume Bruto (Receita):</strong> ${formatCurrency(
                  dadosProduto.volumeBruto
                )}</p>
            </div>
            <div class="section calculator">
                <h4>Calculadora de Lucratividade</h4>
                <div class="input-group"><label for="custoProduto">Custo do Produto (R$)</label><input type="number" id="custoProduto" placeholder="Ex: 25,50"></div>
                <div class="input-group"><label for="custoFrete">Custo do Frete (R$)</label><input type="number" id="custoFrete" placeholder="Se houver"></div>
                <div id="results">
                    <p><strong>Tarifa ML:</strong> <span id="resTarifaML">R$ 0,00</span></p>
                    <p><strong>Valor Recebido (por venda):</strong> <span id="resValorRecebido" class="highlight">R$ 0,00</span></p><hr>
                    <p><strong>Lucro por Venda:</strong> <span id="resLucro" class="lucro">R$ 0,00</span></p>
                    <p><strong>Margem de Lucro:</strong> <span id="resMargem" class="lucro">0,00%</span></p>
                </div>
            </div>
        </div>
    `;

  document.body.appendChild(painel);
  setupCalculadoraListeners();

  // --- NOVIDADES ---
  makeDraggable(painel, "posicaoPainel");
  loadAndApplyPosition(painel, "posicaoPainel");

  // Salva o tamanho do painel ao final do redimensionamento
  const observer = new ResizeObserver(() => {
    savePosition("posicaoPainel", {
      top: painel.style.top,
      left: painel.style.left,
      width: painel.style.width,
      height: painel.style.height,
    });
  });
  observer.observe(painel);
}

// ... (A função calcularLucro e setupCalculadoraListeners continuam as mesmas) ...
function setupCalculadoraListeners() {
  const inputs = ["custoProduto", "custoFrete"];
  inputs.forEach((id) => {
    document.getElementById(id).addEventListener("input", calcularLucro);
  });
  calcularLucro();
}
function calcularLucro() {
  const precoVenda = dadosProduto.valorUnitario || 0;
  const tipoAnuncio = dadosProduto.tipoAnuncio || "Classico";
  const custoProduto =
    parseFloat(document.getElementById("custoProduto").value) || 0;
  const custoFrete =
    parseFloat(document.getElementById("custoFrete").value) || 0;
  const taxaPercentual = TAXAS_MERCADO_LIVRE.taxasPorAnuncio[tipoAnuncio];
  let comissaoML = precoVenda * taxaPercentual;
  let custoFixoML =
    precoVenda < TAXAS_MERCADO_LIVRE.limiteCustoFixo
      ? TAXAS_MERCADO_LIVRE.custoFixo
      : 0;
  const tarifaTotalML = comissaoML + custoFixoML;
  const valorRecebido = precoVenda - tarifaTotalML - custoFrete;
  const lucro = valorRecebido - custoProduto;
  const margem = precoVenda > 0 ? (lucro / precoVenda) * 100 : 0;
  document.getElementById("resTarifaML").innerText =
    tarifaTotalML.toLocaleString("pt-BR", {
      style: "currency",
      currency: "BRL",
    });
  document.getElementById("resValorRecebido").innerText =
    valorRecebido.toLocaleString("pt-BR", {
      style: "currency",
      currency: "BRL",
    });
  document.getElementById("resLucro").innerText = lucro.toLocaleString(
    "pt-BR",
    { style: "currency", currency: "BRL" }
  );
  document.getElementById("resMargem").innerText = `${margem.toFixed(2)}%`;
  const lucroElements = document.querySelectorAll(".lucro");
  const valorRecebidoEl = document.getElementById("resValorRecebido");
  lucro < 0
    ? lucroElements.forEach((el) => el.classList.add("prejuizo"))
    : lucroElements.forEach((el) => el.classList.remove("prejuizo"));
  valorRecebido < custoProduto
    ? valorRecebidoEl.classList.add("prejuizo")
    : valorRecebidoEl.classList.remove("prejuizo");
}

// --- CRIAÇÃO DO BOTÃO (COM NOVIDADES) ---
(function () {
  if (document.querySelector(".meu-botao-analise")) return;

  const botaoAnalisar = document.createElement("button");
  botaoAnalisar.innerText = "Análise PRO";
  botaoAnalisar.className = "meu-botao-analise";
  document.body.appendChild(botaoAnalisar);
  botaoAnalisar.addEventListener("click", extrairDados);

  // --- NOVIDADES ---
  makeDraggable(botaoAnalisar, "posicaoBotao");
  loadAndApplyPosition(botaoAnalisar, "posicaoBotao");
})();
