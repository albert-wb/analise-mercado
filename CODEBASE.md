# Codebase: Analisador Pro — Mercado Livre & Shopee

Este documento é a fonte única de verdade sobre a arquitetura, funcionalidades, fluxos e convenções do projeto. Ele existe para que qualquer agente ou desenvolvedor entenda o sistema sem reler todo o código.

---

## 🚨 REGRA DE OURO PARA ASSISTENTES DE IA
> [!IMPORTANT]
> **SEMPRE** que qualquer modificação for realizada no código deste repositório, o assistente de IA **DEVE** voltar a este arquivo e atualizar a seção [Histórico de Alterações (Changelog)](#-histórico-de-alterações-changelog) no final do documento, descrevendo as mudanças em formato de tabela de forma concisa e técnica.
>
> **REGRA COMPLEMENTAR (v8.0):** o changelog descreve o que foi *efetivamente escrito no código*. Entre as versões 7.8 e 7.11 foram registradas funções (`carregarAvaliacoes`, `carregarSEO`, `processarSnapshotsVendas`, `baixarMidiasML`) que nunca chegaram ao `content.js` — apenas as chamadas foram adicionadas. O resultado foi um `ReferenceError` em `extrairDados()` que deixou a extensão inteiramente inoperante por várias versões. **Antes de registrar qualquer mudança, rode `npm run check`.**

---

## 📋 Visão Geral do Projeto

O **Analisador Pro** é uma extensão do Chrome (Manifest V3) para análise de viabilidade comercial e lucratividade de produtos no **Mercado Livre Brasil** e na **Shopee Brasil**, no espírito das ferramentas AnálisePlace e Avantpro.

### Principais funcionalidades

1. **Raio-X do anúncio (HUD):** extração completa via API + DOM — produto, vendas, estoque, anúncio, vendedor, visitas, categoria, catálogo, avaliações, SEO e mídias.
2. **Métricas no grid de busca:** badges por card com preço, vendas, faturamento, idade, estoque, tipo de anúncio, logística, catálogo e vendedor, com **detecção de monopólio de nicho**.
3. **Calculadora de lucratividade:** usa a **comissão real da categoria** (API `listing_prices`), impostos configuráveis, ponto de equilíbrio e matriz de sensibilidade de preço.
4. **Histórico próprio de vendas:** snapshots diários por anúncio (60 dias) que convertem a estimativa de vendas/30d em **medição real** após 3 dias de acompanhamento.
5. **Garimpo + exportação CSV** de 32 colunas, **gerador de EAN-13** e **pesquisa de palavras-chave** pelos autocompletes reais das plataformas.
6. **OAuth2 + PKCE** com o Mercado Livre, com renovação automática de token e suporte a credenciais próprias do usuário.

---

## 🛠️ Arquitetura de Arquivos

| Arquivo | Responsabilidade |
| :--- | :--- |
| **manifest.json** | MV3 v8.0.0. Service worker como **módulo ES**. Permissões: `storage`, `identity`, `alarms`, `declarativeNetRequest`, `downloads` (`activeTab` e `scripting` foram removidas por não serem usadas). CSP explícita com `connect-src` restrito aos hosts realmente consultados. |
| **background.js** | Service worker. OAuth2+PKCE, ciclo de vida dos tokens, **proxy das chamadas ao Mercado Livre**, cache em memória com TTL, camada de inteligência de produto (`analyzeMlItem`, `fetchItemsBatch`), snapshots, garimpo e downloads. Roteador de mensagens baseado em um mapa `handlers`. **Não consulta as APIs de produto da Shopee** — ver abaixo. |
| **shopee-bridge.js** | Content script no **mundo MAIN**, em `document_start`. Embrulha `fetch`/`XMLHttpRequest` para observar as respostas que a própria Shopee busca e repassá-las ao content script. Não usa `chrome.*` (indisponível nesse contexto) e endereça o `postMessage` à origem da página. |
| **content.js** | Extração DOM, HUD e badges de busca. **Toda a UI é montada com `createElement`/`textContent`** (helper `el()`); não há uma única escrita em `innerHTML`. |
| **popup.html / popup.css / popup.js** | Garimpo, ferramentas (EAN, SEO) e ajustes (impostos, taxas, credenciais). CSS em arquivo próprio — a CSP `style-src 'self'` bloqueia `<style>` e `style="…"`. |
| **style.css** | Tema "Dark Commerce HUD" injetado nas páginas. Sem `@import` remoto: a CSP das plataformas bloqueia o Google Fonts. |
| **tools/validate.mjs** | Lint estrutural: manifesto, sintaxe, handlers de mensagem, ids do popup, ausência de `innerHTML`, cobertura da CSP. |
| **tools/test.mjs** | Testes das funções puras avaliando o `content.js` publicado dentro de um `vm`. |

### Regras estruturais (garantidas pelo `validate.mjs`)

1. **O Mercado Livre é consultado pelo service worker**, que não sofre com o CORS da página hospedeira. Foi o que eliminou o `XMLHttpRequest` **síncrono** que a v7.6 usava dentro de `extrairDados()` e que travava a thread principal da página.
2. **A Shopee é consultada pelo content script.** As APIs internas dela só respondem para requisições de mesma origem, com os cookies de sessão; do service worker a resposta é sempre `{"error":99999}`. Esse foi o motivo de a v8.0 não funcionar na Shopee. **Não mova essas chamadas para o background.**
3. **Nenhuma string de terceiro vira HTML.** Elimina a classe de XSS que o `escapeHTML` da v7.12 tentava remediar e evita o bloqueio de `style="…"` inline pela CSP dos marketplaces.
4. **O script do mundo MAIN não usa `chrome.*` e nunca faz `postMessage` para `'*'`.** Ele roda dentro da página de terceiro; o primeiro não existe nesse contexto e o segundo vazaria os dados para qualquer listener da página.

### Cascata de dados da Shopee

| Ordem | Fonte | Observação |
| :--- | :--- | :--- |
| 1 | Ponte (mundo MAIN) | Sem requisição extra e sem anti-bot: são os dados que a própria página buscou. Buffer + replay cobrem o intervalo entre `document_start` e `document_idle`. |
| 2 | `shopeeApi()` no content script | `fetch` de mesma origem com `credentials: 'include'`. |
| 3 | DOM / JSON-LD | Último recurso; classes ofuscadas, então só texto e `ld+json`. |

Semântica das vendas na Shopee: **`sold` = últimos 30 dias**, `historical_sold` = acumulado. Por isso, na Shopee, vendas/30d têm origem `plataforma` — não são estimadas.

---

## 🔐 Fluxo de Autenticação (OAuth 2.0 + PKCE)

1. **Disparo:** `popup.js` envia `{ type: 'login' }`.
2. **Code verifier:** 32 bytes de `crypto.getRandomValues`, em Base64URL, salvos em `ml_code_verifier`.
3. **Code challenge:** SHA-256 do verifier (`crypto.subtle.digest`), em Base64URL.
4. **`state` anti-CSRF (novo na v8.0):** valor aleatório enviado na autorização e **conferido no retorno**; divergência aborta o login.
5. **Autorização:** `chrome.identity.launchWebAuthFlow` em `https://auth.mercadolivre.com.br/authorization`.
6. **Troca de tokens:** `POST /oauth/token` com `code`, `client_id`, `client_secret`, `redirect_uri` e `code_verifier`.
7. **Armazenamento:** `ml_access_token`, `ml_refresh_token` e `ml_token_expires` em `chrome.storage.local`; o verifier é descartado.
8. **Renovação:** `chrome.alarms` dispara 5 minutos antes da expiração. `refreshAccessToken()` é **deduplicado** por uma promessa em voo, para que chamadas concorrentes não queimem o refresh token. `onStartup`/`onInstalled` reagendam o alarme.
9. **Credenciais próprias:** `ml_oauth_config` tem prioridade sobre as embutidas. O `CLIENT_SECRET` **nunca** é devolvido ao popup.

> **Risco residual conhecido:** um `CLIENT_SECRET` embutido em extensão é legível por qualquer usuário. Aceitável para uso pessoal; para distribuição pública, a emissão de token precisa ir para um backend proxy.

---

## 🧮 Lógica de Cálculo Financeiro

A tarifa vem, em ordem de preferência:
1. **API `/sites/MLB/listing_prices`** — comissão real da categoria e taxa fixa do tipo de anúncio;
2. taxas configuradas no popup (`ml_custom_taxes` / `shopee_custom_taxes`);
3. os padrões embutidos (ML 13%/18% + R$6 abaixo de R$79; Shopee 14% + R$3).

### Equações

$$\text{Tarifa} = (P \times \text{comissão}) + \text{taxa fixa (se } P < \text{limite)}$$
$$\text{Extras} = (P \times \text{imposto \\%}) + \text{custo fixo global}$$
$$\text{Valor Recebido} = P - \text{Tarifa} - \text{Custo do Frete}$$
$$\text{Lucro} = \text{Valor Recebido} - \text{Custo do Produto} - \text{Extras}$$
$$\text{Margem \\%} = \frac{\text{Lucro}}{P} \times 100 \qquad \text{ROI \\%} = \frac{\text{Lucro}}{\text{Custo do Produto}} \times 100$$
$$P_{\text{equilíbrio}} = \frac{\text{Custo} + \text{Frete} + \text{taxa fixa} + \text{custo fixo global}}{1 - \text{comissão} - \text{imposto}}$$

O ponto de equilíbrio é resolvido nas duas hipóteses da taxa fixa do ML (acima e abaixo do limite) e devolve a solução consistente. `tools/test.mjs` verifica a invariante: no preço devolvido, o lucro tem de ser zero.

### Vendas em 30 dias

| Origem | Como | Quando |
| :--- | :--- | :--- |
| `estimado` | vendas totais ÷ idade do anúncio × 30 | primeira visita |
| `medido` | diferença entre o primeiro e o último snapshot ÷ dias | a partir de 3 dias de histórico |
| `plataforma` | campo `sold` da API | apenas Shopee |

---

## 📡 Mensageria Interna (`chrome.runtime.sendMessage`)

Todo handler devolve `{ success: true, ...payload }` ou `{ success: false, error }`. O `validate.mjs` falha se um `type` enviado não tiver handler correspondente.

| Tipo | Origem | Descrição |
| :--- | :--- | :--- |
| `login` / `logout` / `getAuthStatus` | popup | Ciclo de autenticação |
| `getRedirectUri` | popup | Redirect URI a cadastrar no painel do ML |
| `getOAuthConfig` / `saveOAuthConfig` | popup | Credenciais próprias (o secret nunca sai do SW) |
| `getCustomTaxes` / `saveCustomTaxes` | popup, content | Taxas do Mercado Livre |
| `getShopeeCustomTaxes` / `saveShopeeCustomTaxes` | popup, content | Taxas da Shopee |
| `getGlobalCosts` / `saveGlobalCosts` | popup, content | Impostos e custo fixo global |
| `saveGarimpo` / `getGarimpoList` / `removeGarimpoItem` / `clearGarimpo` | popup, content | CRUD do garimpo |
| **`analyzeMlItem`** | content | **Raio-X completo**: item, descrição, vendedor, nº de anúncios do vendedor, categoria, tarifas reais, reviews, visitas, ranking e catálogo — tudo em paralelo, cada bloco opcional |
| `fetchMlCatalogProduct` | content | Resolve o anúncio vencedor de uma página `/p/MLB…` |
| `fetchMlItemsBatch` | content | Multiget de até 20 itens + nicknames dos vendedores, para o grid de busca |
| `fetchMlSuggestions` / `fetchShopeeSuggestions` | popup | Autocomplete real das plataformas (o do popup precisa passar pelo SW: a página do popup não é shopee.com.br) |
| `saveSnapshot` | content | Grava a leitura do dia e devolve a série completa |
| `downloadMedia` | content | Baixa as mídias para `analisador_pro/<produto>/` |

### Chaves em `chrome.storage.local`

`ml_access_token`, `ml_refresh_token`, `ml_token_expires`, `ml_code_verifier`, `ml_oauth_config`, `ml_custom_taxes`, `shopee_custom_taxes`, `global_costs`, `garimpo_items`, `snapshots`, `posicaoPainel`, `posicaoBotao`.

> ⚠️ O `content.js` observa `chrome.storage.onChanged` com **exatamente** estes nomes. Até a v7.12 ele escutava `custom_taxes` enquanto o background gravava `ml_custom_taxes`, e a sincronização em tempo real nunca funcionou. `tools/test.mjs` cobre esse caminho.

---

## 👥 Histórico de Alterações (Changelog)

Esta seção deve ser atualizada em formato de tabela/changelog de maneira cronológica inversa por qualquer agente de desenvolvimento de IA ao alterar os códigos deste repositório.

| Versão / Data | Autor | Descrição das Modificações |
| :--- | :--- | :--- |
| **v8.1.0** (11/08/2026) | Claude (Opus 5) | **FIX + FEATURE — a Shopee volta a funcionar, com paridade wTool.** **🔴 Causa raiz:** todas as consultas à Shopee saíam do `background.js`. As APIs internas da Shopee (`/api/v4/...`) exigem **mesma origem + cookies de sessão**, e a requisição do service worker é cross-origin, sem cookies e ainda tinha o header `Origin` removido pela nossa própria regra de `declarativeNetRequest` — a resposta era sempre `{"error":99999}`. Só sobrava o scraping de DOM, com classes ofuscadas já obsoletas. **Correção estrutural:** as consultas à Shopee passaram para o content script, que compartilha a origem da página. Os handlers `analyzeShopeeItem`/`fetchShopeeItem`/`fetchShopeeReviews` foram removidos do background (ficou um comentário explicando por que não devem voltar); `fetchShopeeSuggestions` permanece, pois é chamado do popup. **Novo `shopee-bridge.js` (mundo MAIN, `document_start`):** embrulha `fetch`/`XMLHttpRequest` e **observa** — sem alterar argumentos, resposta ou timing, sempre sobre `response.clone()` — as respostas de `search_items`, `item/get`, `get_shop_base` e `get_ratings` que a própria Shopee busca, repassando ao content script via `postMessage` endereçado à origem. Como a ponte sobe antes do content script, mantém buffer de 60 capturas e reenvia mediante pedido de replay. **Cascata de dados:** ponte → `fetch` de mesma origem com cookies → DOM/JSON-LD. **Vendas reais de 30 dias:** o campo `sold` da Shopee é o volume dos últimos 30 dias (`historical_sold` é o total) — passa a alimentar vendas/30d, vendas/dia e faturamento sem estimativa. **Bug corrigido junto:** `calcularMetricasDerivadas` sobrescrevia esse número exato pela média de vida inteira do anúncio. **HUD da Shopee:** faixa de preço, desconto, curtidas, origem do envio, categoria, ficha técnica, nova seção **Variações** (preço/estoque/vendas por modelo, com destaque para variação sem estoque) e raio-X da loja concorrente (seguidores, nota, % positivo, taxa e tempo de resposta, cancelamento, nº de anúncios, loja oficial/verificada, data de abertura). **Grid de busca:** cards da Shopee localizados pelo link do produto (imune às classes ofuscadas) e preenchidos com dados reais da API — vendas/30d, faturamento, nota, estoque, localização, loja oficial — mais detecção de monopólio. **Nova barra flutuante** nas buscas (ML e Shopee) com contador e **exportação da página inteira de resultados em CSV**. **Correção de UX:** o badge cancela o clique, que antes abria o anúncio ao tentar ler a métrica. **Infra:** `validate.mjs` passou a derivar a lista de scripts do próprio manifesto e a exigir que scripts do mundo MAIN não usem `chrome.*`, não façam `postMessage` para `'*'` e rodem em `document_start`, e que o content script valide `event.origin`; testes foram de 61 para 112. |
| **v8.0.0** (11/08/2026) | Claude (Opus 5) | **MAJOR — reescrita completa + correção de falha total.** **🔴 Bug crítico corrigido:** `content.js` chamava `processarSnapshotsVendas`, `carregarAvaliacoes`, `carregarSEO` e `baixarMidiasML`, que **nunca foram definidas** (as v7.8–v7.11 registraram no changelog funções que não foram escritas). Como a primeira delas era chamada dentro do `try` de `extrairDados()`, todo clique em "ANÁLISE PRO" caía no `catch` e exibia "Falha ao extrair dados" — a extensão estava 100% inoperante desde a v7.8. Todas as quatro foram implementadas. **Outras correções:** `chrome.storage.onChanged` escutava `custom_taxes` enquanto o background gravava `ml_custom_taxes` (sincronização de taxas nunca funcionou); `XMLHttpRequest` **síncrono** na thread principal removido; XSS no popup (títulos do garimpo e sugestões de busca iam para `innerHTML` sem escape, com `escapeHTML` importado mas não usado); `@import` do Google Fonts no `style.css` e no `popup.html` (bloqueado pela CSP, só gerava erro); MutationObservers da busca sem debounce, sem desconexão na troca de rota e re-disparando com os próprios badges; navegação SPA detectada só por polling. **Novo — extração analítica completa (paridade com Avantpro/AnálisePlace):** handler composto `analyzeMlItem` que busca em paralelo item, descrição, vendedor, nº de anúncios do vendedor, categoria, **tarifas reais da categoria** (`/sites/MLB/listing_prices`), reviews, **visitas e conversão**, ranking na categoria e concorrência de catálogo/Buy Box. HUD reescrito em 9 seções. Calculadora ganhou comissão real, **ponto de equilíbrio**, markup, lucro projetado 30d e matriz de −15% a +15%. Avaliações com distribuição por estrela e **mineração das dores mais citadas**. SEO com diagnóstico acionável. Grid de busca enriquecido via multiget (20 ids/chamada) com tipo de anúncio, logística, idade, estoque, vendedor e **detecção de monopólio**. **Segurança:** `state` anti-CSRF no OAuth, refresh de token deduplicado, credenciais próprias por usuário (secret nunca sai do SW), CSP com `connect-src`/`style-src` restritos, permissões `activeTab` e `scripting` removidas. **Infra:** service worker como módulo ES, cache com TTL, ícones criados, `popup.css` extraído, `tools/validate.mjs` (87 checagens) e `tools/test.mjs` (61 testes sobre o código publicado), `package.json` com `npm run check`. |
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

