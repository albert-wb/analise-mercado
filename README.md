# Analisador Pro — Mercado Livre & Shopee

Extensão do Chrome (Manifest V3) para análise de viabilidade e lucratividade de
produtos no **Mercado Livre** e na **Shopee**. Injeta um HUD analítico na página do
anúncio e métricas diretamente nos cards da página de busca — no espírito das
ferramentas AnálisePlace e Avantpro.

![ícone](icons/icon48.png)

---

## O que a extensão extrai

### Na página do anúncio (HUD "Análise Pro")

| Bloco | Dados |
| --- | --- |
| **Resumo** | Vendas 30 dias, faturamento 30 dias, vendas/dia, preço, visitas, taxa de conversão, estoque, cobertura de estoque |
| **Produto** | Título, ID, EAN/GTIN, marca, modelo, condição, garantia, categoria completa, total de anúncios na categoria, qualidade da ficha, concorrentes no catálogo, preço vencedor da Buy Box |
| **Vendas & estoque** | Vendas totais, vendas 30d (**medidas** ou estimadas), origem do dado, vendas/dia, faturamento total e 30d, estoque, cobertura em dias, posição no ranking da categoria |
| **Anúncio** | Tipo (Clássico/Premium), data de criação, idade, última atualização, logística (Full/Flex/Coleta/Correios), frete grátis, preço original e desconto |
| **Vendedor** | Nick, reputação, MercadoLíder, % de avaliações positivas, transações, canceladas, anúncios ativos, localização, data de cadastro |
| **Visitas** | Total de 30 dias, gráfico diário e conversão (exige login) |
| **Calculadora** | Comissão **real da categoria**, impostos, valor recebido, lucro, margem, ROI, markup, **preço de equilíbrio**, lucro projetado 30d e matriz de sensibilidade de preço (−15% a +15%) |
| **Avaliações** | Nota média, distribuição por estrela, **dores mais citadas**, elogios mais citados, comentários recentes e exportação |
| **SEO & ficha** | Tamanho do título vs. limite, palavras-chave, atributos preenchidos/faltantes, diagnóstico acionável |
| **Mídias** | Miniaturas, contagem de fotos, vídeo e download em lote |

### Na Shopee

A Shopee expõe o dado que mais importa: o campo `sold` da API é o número de
unidades vendidas nos **últimos 30 dias** (`historical_sold` é o acumulado). Ou
seja, aqui as vendas recentes não são estimadas — vêm da plataforma.

O HUD da Shopee mostra: vendas 30d e totais, faturamento 30d, estoque, curtidas,
nota e distribuição por estrela, dores citadas nas avaliações, faixa de preço,
desconto, origem do envio, categoria, ficha técnica, **variações** (preço,
estoque e vendas por modelo) e o raio-X da **loja concorrente** — seguidores,
nota, % positivo, taxa e tempo de resposta, nº de anúncios, loja oficial e data
de abertura.

### Na página de busca (métricas no grid)

Cada card recebe um badge com preço, vendas, faturamento, idade do anúncio,
estoque, nota, tipo de anúncio, logística, frete grátis, selo de catálogo,
localização e **nome do vendedor**. Quando um mesmo vendedor ocupa 3+ posições da
página, o badge vira `🔒 vendedor (Nx)` — a leitura instantânea de **monopólio de
nicho**.

Uma barra flutuante mostra quantos cards já têm dados da API e exporta **a página
inteira de resultados em CSV**, para prospecção em massa na planilha.

### Ferramentas no popup

- **Garimpo**: salva anúncios com todas as métricas e exporta um CSV de 32 colunas.
- **Gerador de EAN-13**: códigos válidos com prefixo brasileiro (789) e dígito verificador correto.
- **SEO**: sugestões reais de busca do Mercado Livre e da Shopee (autocomplete das plataformas).
- **Ajustes**: impostos e custos globais, taxas de fallback e credenciais próprias da API.

---

## Instalação

1. Baixe ou clone este repositório.
2. Abra `chrome://extensions` e ligue o **Modo do desenvolvedor**.
3. Clique em **Carregar sem compactação** e selecione a pasta do projeto.
4. Abra um anúncio do Mercado Livre ou da Shopee e clique em **▶ ANÁLISE PRO**.

Não há etapa de build: os arquivos são carregados como estão.

### Conectando sua conta do Mercado Livre (opcional)

A extensão funciona sem login usando os endpoints públicos. Conectar libera
**visitas**, **taxa de conversão** e as **tarifas oficiais da categoria**.

1. Abra o popup → aba **Ajustes** → **Conectar com o Mercado Livre**.
2. Se quiser usar sua própria aplicação, crie uma em
   [developers.mercadolivre.com.br](https://developers.mercadolivre.com.br),
   cadastre a Redirect URI mostrada no popup (copie exatamente, incluindo a barra final)
   e informe Client ID e Client Secret em **Credenciais da API**.

> **Aviso de segurança.** O `CLIENT_SECRET` embutido em uma extensão não é secreto:
> qualquer pessoa consegue lê-lo descompactando o pacote. Isso é aceitável para uso
> pessoal. Para distribuir publicamente, mova a emissão de token para um backend
> proxy seu, ou exija que cada usuário cadastre as próprias credenciais.

---

## Como as vendas de 30 dias são calculadas

Esta é a métrica central e tem duas origens, sempre identificadas no HUD:

- **Estimada** — `vendas totais ÷ idade do anúncio × 30`. Disponível na primeira
  visita, mas dilui picos e quedas na média de toda a vida do anúncio.
- **Medida** — a extensão grava um snapshot diário das vendas totais de cada
  anúncio visitado (60 dias de histórico, em `chrome.storage.local`). A partir de
  **3 dias** de histórico ela passa a usar a diferença real entre a primeira e a
  última medição, que é o número que reflete a tração atual.

Ou seja: quanto mais você usa, mais precisa a ferramenta fica. Nenhum dado sai da
sua máquina.

---

## Desenvolvimento

```bash
npm run validate   # manifesto, sintaxe, mensagens, ids do popup, CSP e XSS
npm test           # testes das funções puras (parsing, cálculo financeiro, SEO, EAN)
npm run check      # os dois
```

`tools/validate.mjs` verifica o que o Chrome só reclamaria em execução: arquivos
declarados no manifesto, sintaxe de cada script, se todo `type:` enviado por
`sendMessage` tem handler no service worker, se todo id usado pelo `popup.js`
existe no `popup.html`, se nenhum arquivo escreve em `innerHTML` e se a CSP cobre
todos os hosts consultados.

`tools/test.mjs` avalia o `content.js` publicado dentro de um `vm` com um DOM
mínimo e testa as funções puras — sem cópia paralela da lógica. Cobre parsing de
números em pt-BR, extração de ID de anúncio (incluindo a distinção entre id de
catálogo e id de item), sincronização de configurações, a calculadora nas duas
plataformas, a invariante do ponto de equilíbrio, mineração de termos de
avaliações, diagnóstico de SEO e a validade dos EANs gerados.

### Arquitetura

```
manifest.json     MV3: service worker (módulo), content scripts, popup, ícones, CSP
background.js     OAuth2+PKCE, proxy das chamadas ao Mercado Livre, cache, storage
shopee-bridge.js  Mundo MAIN: observa as chamadas que a própria Shopee faz
content.js        Extração + HUD + badges de busca (100% construído via DOM API)
popup.html/.css/.js  Garimpo, ferramentas e ajustes
style.css         Tema "Dark Commerce HUD" injetado nas páginas
tools/            validate.mjs e test.mjs
```

Regras estruturais que o `validate.mjs` mantém:

1. **O Mercado Livre é consultado pelo service worker**, que não sofre com o CORS
   da página hospedeira.
2. **A Shopee é consultada pelo content script.** As APIs internas dela só
   respondem para requisições de mesma origem, com os cookies de sessão; chamadas
   vindas do service worker voltam `{"error":99999}`. Foi exatamente esse o
   motivo de a v8.0 não funcionar na Shopee.
3. **Nenhuma string de terceiro vira HTML.** Toda a UI é montada com
   `createElement`/`textContent`, o que elimina XSS e evita o bloqueio de
   `style="…"` inline pela CSP do Mercado Livre e da Shopee.
4. **O script do mundo MAIN não usa `chrome.*` e nunca faz `postMessage` para
   `'*'`** — ele roda dentro da página de terceiro.

### Como a ponte da Shopee funciona

`shopee-bridge.js` roda no contexto da própria página, em `document_start`, e
embrulha `fetch`/`XMLHttpRequest` para **observar** (nunca alterar) as respostas
de `search_items`, `item/get`, `get_shop_base` e `get_ratings` que a Shopee já
busca para renderizar. Os dados chegam ao content script por `postMessage`
endereçado à própria origem.

Vantagem: zero requisição extra, nada que o anti-bot possa recusar, e os números
são exatamente os que a Shopee mostrou. Como a ponte sobe antes do content
script, ela mantém um buffer e o reenvia quando o content script pede o replay.
Se mesmo assim faltar algo, o content script refaz a chamada de dentro da página
(mesma origem, com cookies) e, em último caso, lê o DOM/JSON-LD.

---

## Limitações conhecidas

- Na Shopee, se o HUD abrir sem dados, recarregue a página (F5): a ponte precisa
  estar ativa quando a página faz as próprias chamadas. Trocar de aba e voltar
  não refaz as requisições.
- `sold_quantity` deixou de ser exposto pela API do Mercado Livre em parte dos
  anúncios. Quando falta, a extensão usa `initial_quantity − available_quantity`
  e, por último, o texto "+N vendidos" da própria página.
- Visitas e conversão exigem token: sem login o bloco não aparece.
- Marketplaces mudam o HTML com frequência. Os seletores de DOM têm fallback, mas
  são o ponto que mais envelhece.

## Licença

Ver [LICENSE](LICENSE).
