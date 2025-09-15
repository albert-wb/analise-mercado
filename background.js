// background.js

const CLIENT_ID = '6682380728420881';
const CLIENT_SECRET = 'c7Ap9cRS8ZuelpoAOQtp3bL61CCJh1a4'; // <-- IMPORTANTE: Use a NOVA chave secreta

// Obtém o Redirect URI dinamicamente
const REDIRECT_URI = chrome.identity.getRedirectURL();

// Listener para a mensagem do popup.js
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === 'login') {
        iniciarAutenticacao()
            .then(() => sendResponse({ success: true }))
            .catch(error => {
                console.error(error);
                sendResponse({ success: false, error: error.message });
            });
        return true; // Indica que a resposta será assíncrona
    }
});

async function iniciarAutenticacao() {
    // 1. Construir a URL de autorização
    const authUrl = new URL('https://auth.mercadolivre.com.br/authorization');
    authUrl.searchParams.append('response_type', 'code');
    authUrl.searchParams.append('client_id', CLIENT_ID);
    authUrl.searchParams.append('redirect_uri', REDIRECT_URI);

    console.log("Iniciando launchWebAuthFlow com URL:", authUrl.href);

    // 2. Iniciar o fluxo de autenticação web
    const redirectUrlComCode = await new Promise((resolve, reject) => {
        chrome.identity.launchWebAuthFlow({
            'url': authUrl.href,
            'interactive': true
        }, (redirect_url) => {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
            } else {
                resolve(redirect_url);
            }
        });
    });

    console.log("Recebido redirect URL:", redirectUrlComCode);

    // 3. Extrair o código de autorização da URL de retorno
    const url = new URL(redirectUrlComCode);
    const authCode = url.searchParams.get('code');

    if (!authCode) {
        throw new Error("Não foi possível extrair o código de autorização.");
    }

    console.log("Código de autorização obtido:", authCode);

    // 4. Trocar o código de autorização por um Access Token
    await obterAccessToken(authCode);
}

async function obterAccessToken(authCode) {
    const tokenUrl = 'https://api.mercadolibre.com/oauth/token';

    const params = new URLSearchParams();
    params.append('grant_type', 'authorization_code');
    params.append('client_id', CLIENT_ID);
    params.append('client_secret', CLIENT_SECRET);
    params.append('code', authCode);
    params.append('redirect_uri', REDIRECT_URI);

    const response = await fetch(tokenUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept': 'application/json'
        },
        body: params
    });

    if (!response.ok) {
        const errorData = await response.json();
        throw new Error(`Erro ao obter access token: ${errorData.message}`);
    }

    const tokenData = await response.json();
    console.log("Token recebido com sucesso!", tokenData);

    // 5. Salvar o token de forma segura
    const expirationTime = Date.now() + (tokenData.expires_in * 1000);
    chrome.storage.local.set({
        'ml_access_token': tokenData.access_token,
        'ml_refresh_token': tokenData.refresh_token,
        'ml_token_expires': expirationTime
    }, () => {
        console.log("Tokens salvos no chrome.storage");
    });
}