/**
 * shopee-bridge.js — Analisador Pro v8.1
 *
 * Roda no **mundo MAIN** (contexto da própria página da Shopee), em
 * `document_start`, antes do bundle da Shopee subir.
 *
 * Por que isso existe
 * -------------------
 * As APIs internas da Shopee (`/api/v4/...`) só respondem para requisições
 * de mesma origem, com os cookies de sessão e passando pelo anti-bot. Chamadas
 * feitas do service worker da extensão voltam com `{"error":99999}`.
 *
 * A saída mais confiável — e mais barata — é não chamar nada: a própria página
 * já busca esses dados para renderizar. Este script embrulha `fetch` e
 * `XMLHttpRequest`, **observa** as respostas que interessam e as repassa ao
 * content script por `postMessage`. Zero requisição extra, zero risco de
 * bloqueio, e os dados são exatamente os que a Shopee mostrou ao usuário.
 *
 * Regras de convivência (este código roda dentro da página de terceiro):
 *   - nunca altera argumentos, resposta ou timing das chamadas originais;
 *   - trabalha sempre sobre `response.clone()`, para não consumir o body;
 *   - qualquer exceção aqui é engolida — uma falha nossa não pode quebrar a Shopee;
 *   - o postMessage é endereçado à própria origem, nunca a '*'.
 */

(() => {
  // Evita instalar duas vezes se a extensão for recarregada na mesma aba.
  if (window.__analisadorProBridge) return;
  window.__analisadorProBridge = true;

  const ORIGIN = window.location.origin;

  /** Endpoints observados, do mais específico para o mais genérico. */
  const ROTAS = [
    [/\/api\/v4\/(item|pdp)\/get(_pc)?/, 'item'],
    [/\/api\/v4\/search\/search_items/, 'busca'],
    [/\/api\/v4\/recommend\/recommend/, 'busca'],
    [/\/api\/v4\/shop\/get_shop_(base|detail|seo)/, 'loja'],
    [/\/api\/v[24]\/item\/get_ratings/, 'avaliacoes'],
  ];

  function classificar(url) {
    if (typeof url !== 'string') return null;
    for (const [padrao, tipo] of ROTAS) if (padrao.test(url)) return tipo;
    return null;
  }

  /**
   * A ponte sobe em `document_start`, mas o content script só entra em
   * `document_idle` — as primeiras respostas da Shopee chegariam antes de
   * existir alguém escutando. Por isso tudo fica num buffer que o content
   * script pede de volta assim que carrega.
   */
  const historico = [];
  const LIMITE_HISTORICO = 60;

  function publicar(tipo, url, dados) {
    if (!dados) return;
    const mensagem = { __analisadorPro: 'shopee', tipo, url, dados };

    if (tipo !== 'pronto') {
      historico.push(mensagem);
      if (historico.length > LIMITE_HISTORICO) historico.shift();
    }

    try {
      window.postMessage(mensagem, ORIGIN);
    } catch {
      /* payload não clonável — ignora */
    }
  }

  // O content script pede o histórico ao iniciar (e a cada troca de rota).
  window.addEventListener('message', (evento) => {
    if (evento.source !== window || evento.origin !== ORIGIN) return;
    if (evento.data?.__analisadorPro !== 'shopee-replay') return;
    for (const mensagem of historico) {
      try {
        window.postMessage(mensagem, ORIGIN);
      } catch {
        /* ignora */
      }
    }
  });

  // ---- fetch ------------------------------------------------------
  const fetchOriginal = window.fetch;
  if (typeof fetchOriginal === 'function') {
    window.fetch = function analisadorProFetch(...args) {
      const resposta = fetchOriginal.apply(this, args);
      try {
        const entrada = args[0];
        const url = typeof entrada === 'string' ? entrada : entrada?.url;
        const tipo = classificar(url);
        if (tipo) {
          resposta
            .then((res) => {
              // clone() para que a página continue lendo o body normalmente.
              res
                .clone()
                .json()
                .then((dados) => publicar(tipo, url, dados))
                .catch(() => {});
            })
            .catch(() => {});
        }
      } catch {
        /* não interfere no fluxo original */
      }
      return resposta;
    };
  }

  // ---- XMLHttpRequest ---------------------------------------------
  const abrirOriginal = XMLHttpRequest.prototype.open;
  const enviarOriginal = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function analisadorProOpen(metodo, url, ...resto) {
    try {
      this.__analisadorProUrl = url;
    } catch {
      /* objeto selado */
    }
    return abrirOriginal.call(this, metodo, url, ...resto);
  };

  XMLHttpRequest.prototype.send = function analisadorProSend(...args) {
    try {
      const tipo = classificar(this.__analisadorProUrl);
      if (tipo) {
        this.addEventListener('load', () => {
          try {
            if (this.responseType && this.responseType !== 'text' && this.responseType !== 'json') return;
            const bruto = this.responseType === 'json' ? this.response : JSON.parse(this.responseText);
            publicar(tipo, this.__analisadorProUrl, bruto);
          } catch {
            /* resposta não-JSON */
          }
        });
      }
    } catch {
      /* segue o fluxo original */
    }
    return enviarOriginal.apply(this, args);
  };

  // Sinaliza ao content script que a ponte está de pé.
  publicar('pronto', ORIGIN, { pronto: true });
})();
