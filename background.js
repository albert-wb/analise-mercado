// background.js — Analisador de Produtos v7.3 (ML + Shopee + Garimpo)

// ⚠️ SEGURANÇA: Em produção comercial, CLIENT_SECRET deve ser protegido
// em um servidor backend proxy. Nunca distribua extensões públicas com
// o secret exposto. Rotacione as chaves se comprometidas.
const CLIENT_ID = '6682380728420881';
const CLIENT_SECRET = 'c7Ap9cRS8ZuelpoAOQtp3bL61CCJh1a4';

// A redirect URI será gerada automaticamente pelo Chrome e DEVE ser cadastrada
// EXATAMENTE igual no painel de desenvolvedor do Mercado Livre (incluindo a barra final).
const REDIRECT_URI = chrome.identity.getRedirectURL();
console.log('--- ATENÇÃO: COPIE ESTA REDIRECT URI PARA O MERCADO LIVRE ---');
console.log(REDIRECT_URI);
console.log('------------------------------------------------------------');
const TOKEN_REFRESH_ALARM = 'ml-token-refresh';

// ==================================================================
//  FUNÇÕES AUXILIARES PARA O PKCE
// ==================================================================

function generateCodeVerifier() {
    const randomBytes = new Uint8Array(32);
    crypto.getRandomValues(randomBytes);
    return base64urlEncode(randomBytes);
}

function base64urlEncode(buffer) {
    const base64 = btoa(String.fromCharCode.apply(null, new Uint8Array(buffer)));
    return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function generateCodeChallenge(verifier) {
    const encoder = new TextEncoder();
    const data = encoder.encode(verifier);
    const digest = await crypto.subtle.digest('SHA-256', data);
    return base64urlEncode(digest);
}

// ==================================================================
//  GERENCIAMENTO DE TOKENS
// ==================================================================

async function getAuthStatus() {
    const data = await chrome.storage.local.get([
        'ml_access_token',
        'ml_refresh_token',
        'ml_token_expires'
    ]);

    if (!data.ml_access_token) {
        return { status: 'logged_out' };
    }

    const now = Date.now();
    const expiresAt = data.ml_token_expires || 0;
    const remainingMs = expiresAt - now;

    if (remainingMs <= 0) {
        if (data.ml_refresh_token) {
            return { status: 'expired', canRefresh: true };
        }
        return { status: 'expired', canRefresh: false };
    }

    return {
        status: 'logged_in',
        expiresIn: Math.floor(remainingMs / 1000),
        expiresAt
    };
}

async function refreshAccessToken() {
    const { ml_refresh_token } = await chrome.storage.local.get('ml_refresh_token');
    if (!ml_refresh_token) {
        throw new Error('Refresh token não encontrado. Faça login novamente.');
    }

    const params = new URLSearchParams();
    params.append('grant_type', 'refresh_token');
    params.append('client_id', CLIENT_ID);
    params.append('client_secret', CLIENT_SECRET);
    params.append('refresh_token', ml_refresh_token);

    const response = await fetch('https://api.mercadolibre.com/oauth/token', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept': 'application/json'
        },
        body: params
    });

    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        await clearTokens();
        throw new Error(`Falha ao renovar token: ${errorData.message || response.statusText}`);
    }

    const tokenData = await response.json();
    const expirationTime = Date.now() + (tokenData.expires_in * 1000);

    await chrome.storage.local.set({
        'ml_access_token': tokenData.access_token,
        'ml_refresh_token': tokenData.refresh_token,
        'ml_token_expires': expirationTime
    });

    scheduleTokenRefresh(tokenData.expires_in);
    return tokenData.access_token;
}

async function fetchWithAuth(url) {
    let authStatus = await getAuthStatus();

    if (authStatus.status === 'expired' && authStatus.canRefresh) {
        await refreshAccessToken();
        authStatus = await getAuthStatus();
    }

    if (authStatus.status !== 'logged_in') {
        throw new Error('Usuário não autenticado.');
    }

    const { ml_access_token } = await chrome.storage.local.get('ml_access_token');

    const response = await fetch(url, {
        headers: {
            'Authorization': `Bearer ${ml_access_token}`,
            'Accept': 'application/json'
        }
    });

    if (response.status === 401) {
        try {
            const newToken = await refreshAccessToken();
            const retryResponse = await fetch(url, {
                headers: {
                    'Authorization': `Bearer ${newToken}`,
                    'Accept': 'application/json'
                }
            });
            return retryResponse.json();
        } catch {
            throw new Error('Sessão expirada. Faça login novamente.');
        }
    }

    if (!response.ok) {
        throw new Error(`Erro na API: ${response.statusText}`);
    }

    return response.json();
}

async function clearTokens() {
    await chrome.storage.local.remove([
        'ml_access_token',
        'ml_refresh_token',
        'ml_token_expires',
        'ml_code_verifier'
    ]);
    await chrome.alarms.clear(TOKEN_REFRESH_ALARM);
}

function scheduleTokenRefresh(expiresInSeconds) {
    const refreshInMinutes = Math.max(1, (expiresInSeconds - 300) / 60);
    chrome.alarms.create(TOKEN_REFRESH_ALARM, {
        delayInMinutes: refreshInMinutes
    });
}

// ==================================================================
//  FLUXO DE AUTENTICAÇÃO (PKCE)
// ==================================================================

async function iniciarAutenticacao() {
    const codeVerifier = generateCodeVerifier();
    await chrome.storage.local.set({ 'ml_code_verifier': codeVerifier });

    const codeChallenge = await generateCodeChallenge(codeVerifier);

    const authUrl = new URL('https://auth.mercadolivre.com.br/authorization');
    authUrl.searchParams.append('response_type', 'code');
    authUrl.searchParams.append('client_id', CLIENT_ID);
    authUrl.searchParams.append('redirect_uri', REDIRECT_URI);
    authUrl.searchParams.append('code_challenge', codeChallenge);
    authUrl.searchParams.append('code_challenge_method', 'S256');

    const redirectUrlComCode = await new Promise((resolve, reject) => {
        chrome.identity.launchWebAuthFlow({
            'url': authUrl.href,
            'interactive': true
        }, (redirect_url) => {
            if (chrome.runtime.lastError || !redirect_url) {
                reject(new Error(chrome.runtime.lastError?.message || 'Janela de autenticação fechada.'));
            } else {
                resolve(redirect_url);
            }
        });
    });

    const url = new URL(redirectUrlComCode);
    const authCode = url.searchParams.get('code');
    if (!authCode) throw new Error('Código de autorização não encontrado.');

    await obterAccessToken(authCode);
}

async function obterAccessToken(authCode) {
    const { ml_code_verifier } = await chrome.storage.local.get('ml_code_verifier');
    if (!ml_code_verifier) throw new Error('Code verifier não encontrado.');

    const params = new URLSearchParams();
    params.append('grant_type', 'authorization_code');
    params.append('client_id', CLIENT_ID);
    params.append('client_secret', CLIENT_SECRET);
    params.append('code', authCode);
    params.append('redirect_uri', REDIRECT_URI);
    params.append('code_verifier', ml_code_verifier);

    const response = await fetch('https://api.mercadolibre.com/oauth/token', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept': 'application/json'
        },
        body: params
    });

    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(`Erro ao obter token: ${errorData.error || errorData.message || response.statusText}`);
    }

    const tokenData = await response.json();
    const expirationTime = Date.now() + (tokenData.expires_in * 1000);

    await chrome.storage.local.set({
        'ml_access_token': tokenData.access_token,
        'ml_refresh_token': tokenData.refresh_token,
        'ml_token_expires': expirationTime
    });

    await chrome.storage.local.remove('ml_code_verifier');
    scheduleTokenRefresh(tokenData.expires_in);
}

// ==================================================================
//  LISTENERS
// ==================================================================

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === 'login') {
        iniciarAutenticacao()
            .then(() => sendResponse({ success: true }))
            .catch(error => sendResponse({ success: false, error: error.message }));
        return true;
    }

    if (request.type === 'logout') {
        clearTokens()
            .then(() => sendResponse({ success: true }))
            .catch(error => sendResponse({ success: false, error: error.message }));
        return true;
    }

    if (request.type === 'getAuthStatus') {
        getAuthStatus()
            .then(status => sendResponse(status))
            .catch(() => sendResponse({ status: 'logged_out' }));
        return true;
    }

    if (request.type === 'getSellerData') {
        const sellerId = request.sellerId;
        if (!sellerId) {
            sendResponse({ success: false, error: 'ID do vendedor não fornecido.' });
            return true;
        }
        fetchWithAuth(`https://api.mercadolibre.com/users/${sellerId}`)
            .then(data => sendResponse({ success: true, data }))
            .catch(error => sendResponse({ success: false, error: error.message }));
        return true;
    }

    if (request.type === 'saveCustomTaxes') {
        chrome.storage.local.set({ 'ml_custom_taxes': request.taxes })
            .then(() => sendResponse({ success: true }))
            .catch(error => sendResponse({ success: false, error: error.message }));
        return true;
    }

    if (request.type === 'getCustomTaxes') {
        chrome.storage.local.get('ml_custom_taxes')
            .then(result => sendResponse({ success: true, taxes: result.ml_custom_taxes || null }))
            .catch(error => sendResponse({ success: false, error: error.message }));
        return true;
    }

    if (request.type === 'saveShopeeCustomTaxes') {
        chrome.storage.local.set({ 'shopee_custom_taxes': request.taxes })
            .then(() => sendResponse({ success: true }))
            .catch(error => sendResponse({ success: false, error: error.message }));
        return true;
    }

    if (request.type === 'getShopeeCustomTaxes') {
        chrome.storage.local.get('shopee_custom_taxes')
            .then(result => sendResponse({ success: true, taxes: result.shopee_custom_taxes || null }))
            .catch(error => sendResponse({ success: false, error: error.message }));
        return true;
    }

    if (request.type === 'saveGlobalCosts') {
        chrome.storage.local.set({ 'global_costs': request.costs })
            .then(() => sendResponse({ success: true }))
            .catch(error => sendResponse({ success: false, error: error.message }));
        return true;
    }

    if (request.type === 'getGlobalCosts') {
        chrome.storage.local.get('global_costs')
            .then(result => sendResponse({ success: true, costs: result.global_costs || null }))
            .catch(error => sendResponse({ success: false, error: error.message }));
        return true;
    }

    // ===== GARIMPO =====

    if (request.type === 'saveGarimpo') {
        chrome.storage.local.get('garimpo_items')
            .then(result => {
                const items = result.garimpo_items || [];
                items.unshift(request.item); // add to beginning (newest first)
                return chrome.storage.local.set({ 'garimpo_items': items });
            })
            .then(() => sendResponse({ success: true }))
            .catch(error => sendResponse({ success: false, error: error.message }));
        return true;
    }

    if (request.type === 'getGarimpoList') {
        chrome.storage.local.get('garimpo_items')
            .then(result => sendResponse({ success: true, items: result.garimpo_items || [] }))
            .catch(error => sendResponse({ success: false, error: error.message }));
        return true;
    }

    if (request.type === 'removeGarimpoItem') {
        chrome.storage.local.get('garimpo_items')
            .then(result => {
                const items = (result.garimpo_items || []).filter(i => i.id !== request.itemId);
                return chrome.storage.local.set({ 'garimpo_items': items });
            })
            .then(() => sendResponse({ success: true }))
            .catch(error => sendResponse({ success: false, error: error.message }));
        return true;
    }

    if (request.type === 'clearGarimpo') {
        chrome.storage.local.remove('garimpo_items')
            .then(() => sendResponse({ success: true }))
            .catch(error => sendResponse({ success: false, error: error.message }));
        return true;
    }

    // ===== AUTOCOMPLETE (Bypass CORS) =====

    if (request.type === 'fetchMlSuggestions') {
        const url = `https://http2.mlstatic.com/resources/sites/MLB/autosuggest?q=${encodeURIComponent(request.query)}`;
        fetch(url)
            .then(res => res.json())
            .then(data => {
                const suggestions = (data.suggested_queries || []).map(item => item.q);
                sendResponse({ success: true, suggestions });
            })
            .catch(err => sendResponse({ success: false, error: err.message }));
        return true;
    }

    if (request.type === 'fetchShopeeSuggestions') {
        const url = `https://shopee.com.br/api/v4/search/search_hint?keyword=${encodeURIComponent(request.query)}`;
        fetch(url)
            .then(res => res.json())
            .then(data => {
                const suggestions = (data.keywords || []).map(item => item.keyword);
                sendResponse({ success: true, suggestions });
            })
            .catch(err => sendResponse({ success: false, error: err.message }));
        return true;
    }
});

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === TOKEN_REFRESH_ALARM) {
        refreshAccessToken().catch(() => {});
    }
});

// Setup DeclarativeNetRequest rules to remove Origin header from autocomplete calls
function setupDeclarativeRules() {
    if (!chrome.declarativeNetRequest) return;

    const rules = [
        {
            id: 1,
            priority: 1,
            action: {
                type: "modifyHeaders",
                requestHeaders: [
                    { header: "origin", operation: "remove" }
                ]
            },
            condition: {
                urlFilter: "||mlstatic.com/resources/sites/*/autosuggest",
                resourceTypes: ["xmlhttprequest"]
            }
        },
        {
            id: 2,
            priority: 1,
            action: {
                type: "modifyHeaders",
                requestHeaders: [
                    { header: "origin", operation: "remove" }
                ]
            },
            condition: {
                urlFilter: "||shopee.com.br/api/v4/search/search_hint",
                resourceTypes: ["xmlhttprequest"]
            }
        }
    ];

    chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: [1, 2],
        addRules: rules
    }).then(() => {
        console.log("[DeclarativeNetRequest] Autocomplete Origin-stripping rules active.");
    }).catch(err => {
        console.error("[DeclarativeNetRequest] Error setting rules:", err);
    });
}

// Run setup on startup
setupDeclarativeRules();

// Run setup when extension is installed or updated
chrome.runtime.onInstalled.addListener(() => {
    setupDeclarativeRules();
});
