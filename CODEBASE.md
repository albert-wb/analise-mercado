# Codebase: Meu Analisador de Produtos (com API)

Este documento serve como a fonte única de verdade sobre a arquitetura, funcionalidades, fluxos e convenções do projeto. Ele foi projetado para que futuros agentes de IA compreendam o sistema instantaneamente sem a necessidade de reanalisar todo o código a cada interação.

---

## 🚨 REGRA DE OURO PARA ASSISTENTES DE IA
> [!IMPORTANT]
> **SEMPRE** que qualquer modificação for realizada no código deste repositório, o assistente de IA **DEVE** voltar a este arquivo ([CODEBASE.md](file:///d:/Projetos pessoais/analise-mercado/CODEBASE.md)) e atualizar a seção [Histórico de Alterações (Changelog)](#-histórico-de-alterações-changelog) no final do documento, descrevendo as mudanças efetuadas em formato de tabela/changelog de forma concisa e técnica.

---

## 📋 Visão Geral do Projeto

O **Meu Analisador de Produtos** é uma extensão do Google Chrome (desenvolvida sob a especificação Manifest V3) voltada para auxiliar na análise de viabilidade comercial e lucratividade de produtos anunciados na plataforma **Mercado Livre Brasil** (`mercadolivre.com.br`).

### Principais Funcionalidades:
1.  **Extração de Dados em Tempo Real:** Identifica e extrai metadados do anúncio em exibição (título, preço, estimativa de vendas históricas, tipo de anúncio - Clássico ou Premium, código EAN/GTIN, detecção de frete grátis, ID do produto e nickname do vendedor).
2.  **Calculadora de Lucratividade:** Painel flutuante interativo "Dark Commerce HUD" com calculadora de lucro, margem e ROI, score visual de lucratividade com barra colorida, seções colapsáveis, e botão de copiar dados.
3.  **Integração OAuth2 com a API do Mercado Livre:** Fluxo de login PKCE completo com renovação automática de tokens via `chrome.alarms`, status de autenticação em tempo real no popup, e função `fetchWithAuth` para chamadas autenticadas à API.
4.  **Configuração de Taxas:** Popup com painel de configuração de taxas do Mercado Livre (Clássico, Premium, custo fixo, limite), com persistência via `chrome.storage.local`.

---

## 🛠️ Arquitetura de Arquivos

O projeto é modularizado em arquivos de extensão tradicionais:

*   **[manifest.json](file:///d:/Projetos pessoais/analise-mercado/manifest.json):** Manifesto Manifest V3 (versão `7.1`). Permissões: `activeTab`, `scripting`, `storage`, `identity`, `alarms`. Hosts: `mercadolivre.com.br` e `api.mercadolibre.com`.
*   **[background.js](file:///d:/Projetos pessoais/analise-mercado/background.js):** Service worker. Responsável por: fluxo OAuth2 PKCE, gerenciamento de tokens (obtenção, renovação via refresh_token, expiração), função `fetchWithAuth()` para chamadas autenticadas, `getAuthStatus()` para estado de login, listeners de mensagens (`login`, `logout`, `getAuthStatus`, `getSellerData`, `saveCustomTaxes`, `getCustomTaxes`), e `chrome.alarms` para renovação automática.
*   **[content.js](file:///d:/Projetos pessoais/analise-mercado/content.js):** Script injetado nas páginas do Mercado Livre. Em **páginas de produto**: extrai dados via JSON-LD e DOM, renderiza o painel "Dark Commerce HUD" com seções colapsáveis, calculadora de lucro/margem/ROI, score visual, botão de copiar e fechar. Em **páginas de busca**: detecta contexto automaticamente, injeta badges compactos (`.ml-search-badge`) nos cards de resultados com vendas estimadas, faturamento, tags de Frete Grátis e Full, utilizando MutationObserver para cards carregados dinamicamente. Suporta drag & drop com persistência de posição.
*   **[style.css](file:///d:/Projetos pessoais/analise-mercado/style.css):** Tema "Dark Commerce HUD" — paleta escura profissional (`#0d1117`/`#161b22`), acentos em verde neon (`#00ff88`), vermelho (`#ff3b3b`) e âmbar (`#f0b429`). Tipografia JetBrains Mono para dados financeiros + Inter para texto. Animações GPU-accelerated com suporte a `prefers-reduced-motion`. Seções colapsáveis, scrollbar customizada, score bar animada, **badges de busca** (`.ml-search-badge`) com separadores, tags coloridas e hover glow.
*   **[popup.html](file:///d:/Projetos pessoais/analise-mercado/popup.html):** Interface do popup com tema escuro consistente. Status de autenticação com indicador dot colorido, botões de login/logout com loading state, seção de configuração de taxas customizáveis, mensagens de feedback.
*   **[popup.js](file:///d:/Projetos pessoais/analise-mercado/popup.js):** Lógica do popup. Verifica status de autenticação ao abrir, exibe tempo restante do token, gerencia login/logout via messaging, salva/carrega/restaura configuração de taxas customizáveis.

---

## 🔐 Fluxo de Autenticação Detalhado (OAuth 2.0 + PKCE)

Para garantir segurança no fluxo de autorização sem depender de um servidor intermediário, a extensão adota a especificação **PKCE (Proof Key for Code Exchange)** no [background.js](file:///d:/Projetos pessoais/analise-mercado/background.js).

### Detalhamento Criptográfico e de Etapas:
1.  **Disparo:** O script do popup ([popup.js](file:///d:/Projetos pessoais/analise-mercado/popup.js)) envia uma mensagem `{ type: 'login' }` para o service worker.
2.  **Geração do Code Verifier:**
    *   O service worker gera um segredo criptográfico aleatório chamado `codeVerifier` por meio de `crypto.getRandomValues(new Uint8Array(32))`.
    *   Este segredo é codificado no formato Base64URL (removendo caracteres especiais de padding e substituindo `+` e `/` por `-` e `_`).
    *   O `codeVerifier` é imediatamente gravado no `chrome.storage.local` sob a chave `'ml_code_verifier'`.
3.  **Geração do Code Challenge:**
    *   O `codeVerifier` é transformado em um buffer binário (`TextEncoder`).
    *   É gerado um hash criptográfico SHA-256 do buffer por meio do método `crypto.subtle.digest('SHA-256', data)`.
    *   O hash resultante é codificado no formato Base64URL, originando o `codeChallenge`.
4.  **Solicitação de Autorização:**
    *   É montada a URL para o endpoint de autorização oficial (`https://auth.mercadolivre.com.br/authorization`), passando como parâmetros de busca o `client_id`, a `redirect_uri` de retorno gerada pelo Chrome, o `code_challenge` e o método utilizado (`S256`).
    *   A API `chrome.identity.launchWebAuthFlow` é chamada em modo interativo (`interactive: true`), exibindo a página de consentimento do Mercado Livre para o usuário final.
5.  **Obtenção do Authorization Code:**
    *   Quando a autorização é concedida, a plataforma redireciona o fluxo para a URI da extensão anexando o código temporário: `redirect_url?code=AUTH_CODE`.
    *   O script extrai o parâmetro `code` da URL.
6.  **Troca de Tokens (Access & Refresh):**
    *   É efetuada uma chamada `POST` para `https://api.mercadolibre.com/oauth/token` com o cabeçalho `Content-Type: application/x-www-form-urlencoded`.
    *   Os parâmetros enviados incluem o código de autorização (`code`), as credenciais `client_id` e `client_secret`, o redirecionamento original e, crucialmente, o parâmetro `code_verifier` original que foi recuperado do `chrome.storage.local`.
    *   *Aviso de Segurança:* Embora o fluxo PKCE mitigue riscos no tráfego, as credenciais `CLIENT_ID` e `CLIENT_SECRET` constam expostas no código do script de segundo plano. Em ambiente de produção comercial, a etapa de requisição final do Token deve idealmente ser enviada a um servidor proxy backend seguro controlado pelo desenvolvedor para proteger o `CLIENT_SECRET` contra engenharia reversa do pacote da extensão.
7.  **Armazenamento de Credenciais:**
    *   Os tokens de acesso (`ml_access_token`), atualização (`ml_refresh_token`) e a expiração absoluta (`ml_token_expires`) são armazenados no `chrome.storage.local` para uso em chamadas de API subsequentes. O verifier temporário no storage é então excluído.
8.  **Renovação Automática (v7.0):**
    *   Após a obtenção dos tokens, um `chrome.alarms` é agendado para disparar 5 minutos antes da expiração, chamando `refreshAccessToken()` que usa o `ml_refresh_token` para obter um novo par de tokens.
    *   Se a renovação falhar, os tokens são limpos e o usuário precisará re-autenticar.

---

## 🧮 Lógica de Cálculo Financeiro (Tarifas do Mercado Livre)

A lógica de cálculo das taxas é executada no cliente ([content.js](file:///d:/Projetos pessoais/analise-mercado/content.js)) e suporta taxas customizáveis configuradas pelo popup:

*   **Limite de Custo Fixo:** R$ 79,00 (padrão, configurável).
*   **Custo Fixo por Venda:** R$ 6,00 (aplicado somente se o preço do produto for inferior ao limite — padrão, configurável).
*   **Comissões do Canal:**
    *   Anúncio **Clássico:** 13% do valor do produto (`0.13` — padrão, configurável).
    *   Anúncio **Premium:** 18% do valor do produto (`0.18` — padrão, configurável).

### Equações do Fluxo de Caixa:
$$\text{Tarifa ML} = (\text{Preço do Produto} \times \text{Taxa do Tipo de Anúncio}) + \text{Custo Fixo (se aplicável)}$$
$$\text{Valor Recebido} = \text{Preço do Produto} - \text{Tarifa ML} - \text{Custo do Frete}$$
$$\text{Lucro Líquido} = \text{Valor Recebido} - \text{Custo do Produto}$$
$$\text{Margem de Lucro \%} = \left( \frac{\text{Lucro Líquido}}{\text{Preço do Produto}} \right) \times 100$$
$$\text{ROI \%} = \left( \frac{\text{Lucro Líquido}}{\text{Custo do Produto} + \text{Custo do Frete}} \right) \times 100$$

### Score de Lucratividade Visual:
| Margem       | Cor         | Classificação |
| :----------- | :---------- | :------------ |
| < 15%        | 🔴 Vermelho | Baixa         |
| 15% — 30%   | 🟡 Âmbar    | Moderada      |
| > 30%        | 🟢 Verde    | Saudável      |

---

## 📡 Mensageria Interna (chrome.runtime.sendMessage)

| Tipo de Mensagem    | Origem      | Destino       | Descrição                                      |
| :------------------ | :---------- | :------------ | :--------------------------------------------- |
| `login`             | popup.js    | background.js | Inicia fluxo OAuth2 PKCE                       |
| `logout`            | popup.js    | background.js | Limpa todos os tokens do storage               |
| `getAuthStatus`     | popup.js    | background.js | Retorna status de autenticação e tempo restante |
| `getSellerData`     | content.js  | background.js | Busca dados do vendedor via API autenticada    |
| `saveCustomTaxes`   | popup.js    | background.js | Salva configuração de taxas no storage         |
| `getCustomTaxes`    | popup/content | background.js | Carrega taxas customizadas                     |

---

## 👥 Histórico de Alterações (Changelog)

Esta seção deve ser atualizada em formato de tabela/changelog de maneira cronológica inversa por qualquer agente de desenvolvimento de IA ao alterar os códigos deste repositório.

| Versão / Data | Autor | Descrição das Modificações |
| :--- | :--- | :--- |
| **v7.12** (07/06/2026) | AI (Antigravity) | **HOTFIX (Segurança):** Auditoria OWASP 2025. **`content.js` e `popup.js`:** Adicionada função de sanitização `escapeHTML` para todas as strings dinâmicas (títulos, nicknames, ean, reviews, keywords) provenientes de APIs ou DOM externo antes da injeção via `innerHTML`. Isso mitiga riscos severos de XSS (A05) por vendedores ou dados maliciosos. **`manifest.json`:** Endurecimento da política de segurança (CSP) com `script-src 'self'` para as páginas da extensão. Documentado o risco residual do fluxo PKCE via client-side sem backend. Bump v7.12. |
| **v7.11** (06/06/2026) | AI (Antigravity) | **FEATURE (Etapa 11):** Snapshot de Vendas e Histórico Real. **`background.js`:** adicionados endpoints `saveSnapshot` e `getSnapshot` usando `chrome.storage.local` para salvar um log diário do número de vendas do produto (limitado a 60 dias). **`content.js`:** criada a função `processarSnapshotsVendas()` que roda no carregamento de qualquer produto no ML e Shopee. Ela compara o total de vendas atual com o snapshot mais antigo de até 30 dias atrás para calcular a média de "Vendas Reais/30d". O HUD foi atualizado para exibir `📈 Vendas/30d (Real)` no lugar de "Est. Vendas/30d" quando os snapshots estão disponíveis. Bump v7.11. |
| **v7.10** (06/06/2026) | AI (Antigravity) | **FEATURE (Etapa 10):** Títulos, Tags e Diagnóstico de Ficha (SEO/Compliance). **`content.js`:** criada a seção colapsável `🎯 SEO & Ficha` no HUD (ML e Shopee) logo após a seção de Avaliações. A função `carregarSEO()` conta os caracteres do título (alertando verde para `≤ 60` e âmbar para `> 60`), filtra stop-words do título e constrói um array com a frequência das palavras simulando as tags mais relevantes que indexam o anúncio no algoritmo do marketplace, exibidas de forma visual. Bump v7.10. |
| **v7.9** (06/06/2026) | AI (Antigravity) | **FEATURE (Etapa 9):** Vendedor + Logística na Busca do ML. **`content.js`:** adicionadas funções `extractSellerNameFromCard` e `extractLogisticsType` para extrair informações do vendedor (ex: "Loja Oficial XYZ", "Por Olist") e tipo de entrega detalhada ("Full", "Flex (Hoje)", "Flex (Amanhã)" ou "Correios/Coleta"). Atualizadas as funções `injectBadgeIntoCard` e `buildBadgeHTML` para renderizar o nome do vendedor (limitado com reticências) e substituir a tag estática "Full" por tags dinâmicas de logística com codificação de cores (Verde para Full, Âmbar para Flex, Azul para Correios). Bump v7.9. |
| **v7.8** (06/06/2026) | AI (Antigravity) | **FEATURE (Etapa 8):** Extrator de Avaliações (Reviews). **`background.js`:** adicionados endpoints para buscar reviews via APIs públicas `fetchMlReviews` (`/reviews/item/{id}`) e `fetchShopeeReviews` (`/api/v2/item/get_ratings`). **`content.js`:** criada a seção colapsável `💬 Avaliações` no HUD (ML e Shopee) inserida dinamicamente após "Dados do Produto". A função `carregarAvaliacoes(plataforma)` renderiza o score médio de estrelas, total de avaliações, e as 10 avaliações mais recentes com texto útil em cards formatados. Inclui botão `📋 Copiar` específico para extrair todo o texto dos reviews renderizados. Bump v7.8. |
| **v7.7** (06/06/2026) | AI (Antigravity) | **FEATURE (Etapa 7):** Download de Fotos e Vídeos. **`manifest.json`:** adicionada permissão `downloads`. **`content.js`:** adicionados botões `📸 Mídias` na barra de ações dos HUDs (ML e Shopee). Criadas funções `baixarMidiasML()` e `baixarMidiasShopee()` que vasculham o DOM por imagens e vídeos, forçando carregamento em altíssima resolução (removendo sufixos `_tn` ou substituindo `-O.webp` por `-F.webp`) e enviam as URLs para o background. **`background.js`:** adicionado listener para `downloadMedia` que utiliza `chrome.downloads.download` para processar a fila de mídias simultaneamente, salvando na pasta `analisador_pro/` de forma silenciosa (sem prompt individual para cada foto). Bump v7.7. |
| **v7.6** (06/06/2026) | AI (Antigravity) | **FEATURE (Etapa 6):** Data de Criação do Anúncio + Velocidade de Vendas. **`content.js`:** função `extrairDados()` agora consulta a API pública do ML (`/items/MLB{id}`) para obter `date_created` e `sold_quantity` oficiais. Fallback via regex no texto da página ("Publicado há X dias/meses/anos"). Calcula `idadeDias`, `vendasPorDia` e `vendasEstimadas30d`. Função `extrairDadosShopee()` consulta API pública Shopee (`/api/v4/item/get`) para obter `ctime` (unix timestamp de criação) e `historical_sold`. HUD ML e Shopee atualizados com 4 novas linhas: "📅 Criado em" (data formatada), "⏱️ Idade" (formatada em dias/meses/anos), "📈 Est. Vendas/30d" (com cores: verde >30, âmbar >10, vermelho <10), "🔥 Vendas/Dia" (média diária). Adicionados helpers `formatIdade()` e `formatDate()`. Bump v7.6. |
| **v7.5** (06/06/2026) | AI (Antigravity) | **FEATURE (Etapa 5):** Precificação Avançada & Matriz de Sensibilidade (Elasticidade). **`popup.html`/`popup.js`:** adicionada seção "Impostos & Custos Globais" para configurar taxa de imposto (%) e custos fixos operacionais (R$) de forma global, com botões para salvar e zerar, armazenando em `global_costs`. **`background.js`:** adicionados handlers `saveGlobalCosts` e `getGlobalCosts`. **`content.js`:** incorporada leitura de `custosGlobais`. HUD atualizado para exibir linha "Impostos & Custos". Cálculo atualizado (`calcularLucro` e `calcularLucroShopee`) para deduzir os impostos e custo fixo no lucro e no ROI. **Nova UI:** Matriz de Sensibilidade no HUD (`renderMatrixMeli` e `renderMatrixShopee`), gerando uma tabela comparativa com cenários de preço de venda (-10%, -5%, Atual, +5%, +10%) e recalculando dinamicamente as tarifas de marketplace, os impostos, o lucro final e a margem, exibindo tudo com codificação de cores. Bump v7.5. |
| **v7.4.1** (06/06/2026) | AI (Antigravity) | **HOTFIX:** Correção de bloqueio CORS/Origin no autocomplete de palavras-chave do Mercado Livre e reinjeção automática de botão de análise sob SPA. **`manifest.json`:** adicionada permissão `declarativeNetRequest`. **`background.js`:** adicionadas regras dinâmicas do Declarative Net Request para remover o cabeçalho `Origin` de requisições de autocomplete enviadas para `mlstatic.com` e `shopee.com.br` (evitando 403 Forbidden). **`content.js`:** aprimorada a função `checkUrlChange()` para verificar se o botão de análise (`.meu-botao-analise`) foi removido do DOM (ex: hidratação pós-render React em SPAs) e forçar sua reinjeção imediata. Bump v7.4.1. |
| **v7.4** (06/06/2026) | AI (Antigravity) | **FEATURE (Etapa 4):** Ferramentas de Produtividade (Gerador EAN-13 & SEO Palavras-chave) com interface de abas (Tabs). **`manifest.json`:** adicionado host `*://*.mlstatic.com/*` em `host_permissions` para CORS-free autocompletes. **`popup.html`:** criado cabeçalho de abas (`.popup-tabs`) para "⭐ Garimpo", "🛠️ Ferramentas" e "⚙️ Ajustes". Divididos os contêineres originais em seções `#tab-content-*` ocultadas/exibidas via CSS e JS. Criado card `📦 Gerador EAN-13` (dropdown de quantidade, botão de gerar, lista `#eanResultsList` de resultados estilizada com botão Copiar individual e botão global Copiar Todos). Criado card `🔍 SEO Palavras-chave` (toggles de plataforma ML/Shopee, input de termo com busca assíncrona). **`popup.js`:** adicionada lógica de navegação de abas. Algoritmo do Gerador EAN-13 gerando EANs válidos com prefixo 789 (Brasil) e dígito verificador Modulo 10. SEO Keywords busca sugestões de `http2.mlstatic.com` (ML) ou `shopee.com.br` (Shopee) via fetch e exibe lista; clicar em cada item/botões copia o termo para a área de transferência e abre busca na plataforma. |
| **v7.3** (06/06/2026) | AI (Antigravity) | **FEATURE (Etapa 3):** Sandbox de Garimpo Local. **`content.js`:** função `salvarGarimpo()` que serializa dados do produto atual (título, URL, preço, vendas, volume, tipo, EAN, frete, custo, vendedor) e envia via message para persistência em `chrome.storage.local`. Botão "⭐ Garimpo" adicionado aos painéis HUD tanto de ML quanto Shopee, com feedback visual via toast ("⭐ Salvo!"). **`background.js`:** 4 novos handlers CRUD: `saveGarimpo` (unshift ao array), `getGarimpoList`, `removeGarimpoItem` (filter por id), `clearGarimpo`. **`popup.html`:** body expandido para 420px, seção "⭐ Garimpo" com container scrollável (max 280px), cards de produtos com badge de plataforma (ML amarelo / Shopee laranja), título clicável que abre a URL, meta info (preço, vendas, data), botão delete individual, estado vazio ("📭 Nenhum produto salvo"), barra de ações com "📥 EXPORTAR CSV" e "🗑️ LIMPAR TUDO". CSS completo para garimpo (scrollbar custom, platform badges, hover effects, empty state). **`popup.js`:** `loadGarimpoList()` renderiza items, clique em título abre aba, delete individual via `removeGarimpoItem`, export CSV com separador `;` e BOM UTF-8 para Excel, clear all com `confirm()`. Bump v7.3. |
| **v7.2** (05/06/2026) | AI (Antigravity) | **FEATURE (Etapa 2):** Suporte completo à Shopee. **Manifest:** adicionados hosts `shopee.com.br` em `host_permissions` e `content_scripts.matches`. **`content.js`:** detecção de plataforma (`detectPlatform()` → `'meli'`/`'shopee'`), constantes `TAXAS_SHOPEE` (14% comissão + R$3 fixo), funções `isShopeeProductPage()`/`isShopeeSearchPage()`/`extractShopeeIds()`, extração de dados Shopee (título, preço, vendas, rating, vendedor via DOM com fallback multi-seletores), painel HUD Shopee (`exibirPainelShopee`), calculadora Shopee (`calcularLucroShopee`), badges de busca Shopee (`scanAndInjectShopeeBadges` + `observeShopeeSearchResults`), refatoração IIFE com `createAnalysisButton()`. **`background.js`:** handlers `saveShopeeCustomTaxes`/`getShopeeCustomTaxes`. **`popup.html`:** seção "🏪 Taxas Shopee" (comissão %, taxa fixa R$), header "ANALISADOR PRO", footer atualizado. **`popup.js`:** lógica save/load/reset taxas Shopee + `DEFAULT_SHOPEE_TAXES`. Bump v7.2. |
| **v7.1.1** (05/06/2026) | AI (Antigravity) | **HOTFIX:** Corrigido bug de extração nos badges de busca. **Causa raiz:** O ML renderiza preços como elementos `<image roledescription="Valor">` com alt text ("Agora: 5471 reais"), não como texto em `.andes-money-amount__fraction`. Além disso, **não existe contagem de vendas nos cards de busca** — os números 47-49 eram capturados incorretamente de notas do vendedor e specs. **Correção:** Reescrita completa de `extractPriceFromCard()` para parsear alt text de imagens, remoção de `extractSalesFromCard()`, adição de `extractSellerRating()`, `extractDiscountFromCard()` e `extractOriginalPriceFromCard()`. Badges agora mostram: preço real, nota do vendedor (⭐ colorida), desconto (🏷️ %), tags Frete Grátis e Full. |
| **v7.1** (05/06/2026) | AI (Antigravity) | **FEATURE (Etapa 1):** Injeção de métricas nos resultados de busca do Mercado Livre. **Novo sistema em `content.js`:** roteamento automático de contexto (`isSearchPage()` / `isProductPage()`), extração de vendas e preço de cards de busca (`extractSalesFromCard`, `extractPriceFromCard`), detecção de Frete Grátis e Full, construção e injeção de badges (`.ml-search-badge`) com MutationObserver para scroll infinito e paginação SPA. **`style.css`:** ~100 linhas de estilos novos para badges compactos, separadores, tags coloridas (Full/Premium/Frete), animação `searchBadgeFadeIn`, hover glow. **Manifest:** bump v7.1, descrição atualizada. |
| **v7.0** (05/06/2026) | AI (Antigravity) | **MAJOR:** Reescrita completa de todos os arquivos. **Bugs corrigidos:** variável `key` → `storageKey` em `loadAndApplyPosition`, null checks no popup.js. **Segurança:** documentação do risco de CLIENT_SECRET exposto, implementação de `refreshAccessToken()` com `chrome.alarms`. **Design:** tema "Dark Commerce HUD" (fundo escuro, verde neon/vermelho/âmbar, JetBrains Mono, animações GPU-accelerated, `prefers-reduced-motion`). **Funcionalidades novas:** score de lucratividade visual, seções colapsáveis, cálculo de ROI, botão de copiar dados, detecção de frete grátis, botão fechar painel, popup com status de autenticação, logout, configuração de taxas customizáveis, renovação automática de token. **Manifest:** bump v7.0, permissão `alarms` adicionada. |
| **v6.1** (05/06/2026) | AI (Antigravity) | Criação da documentação inicial da base de código (`CODEBASE.md`) detalhando o funcionamento geral, fluxo de login com PKCE, lógica da calculadora de tarifas do Mercado Livre e estabelecimento da regra de atualização obrigatória. |
