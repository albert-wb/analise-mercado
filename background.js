// background.js

const CLIENT_ID = '6682380728420881';
const CLIENT_SECRET = 'c7Ap9cRS8ZuelpoAOQtp3bL61CCJh1a4'; // <-- IMPORTANTE: Use a NOVA chave secreta

const REDIRECT_URI = chrome.identity.getRedirectURL();

// ==================================================================
//  FUNÇÕES AUXILIARES PARA O PKCE
// ==================================================================

// Gera uma string aleatória segura para o code_verifier
function generateCodeVerifier() {
    const randomBytes = new Uint8Array(32);
    crypto.getRandomValues(randomBytes);
    return base64urlEncode(randomBytes);
}

// Codifica um buffer em Base64URL
function base64urlEncode(buffer) {
    const base64 = btoa(String.fromCharCode.apply(null, new Uint8Array(buffer)));
    return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Gera o code_challenge a partir do code_verifier
async function generateCodeChallenge(verifier) {
    const encoder = new TextEncoder();
    const data = encoder.encode(verifier);
    const digest = await crypto.subtle.digest('SHA-256', data);
    return base64urlEncode(digest);
}


// ==================================================================
//  FLUXO DE AUTENTICAÇÃO ATUALIZADO
// ==================================================================

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === 'login') {
        iniciarAutenticacao()
            .then(() => sendResponse({ success: true }))
            .catch(error => {
                console.error("Erro no processo de autenticação:", error);
                sendResponse({ success: false, error: error.message });
            });
        return true;
    }
});

async function iniciarAutenticacao() {
    // 1. Gerar e salvar o code_verifier para o PKCE
    const codeVerifier = generateCodeVerifier();
    await chrome.storage.local.set({ 'ml_code_verifier': codeVerifier });
    
    // Gerar o code_challenge
    const codeChallenge = await generateCodeChallenge(codeVerifier);

    // 2. Construir a URL de autorização com os parâmetros do PKCE
    const authUrl = new URL('https://auth.mercadolivre.com.br/authorization');
    authUrl.searchParams.append('response_type', 'code');
    authUrl.searchParams.append('client_id', CLIENT_ID);
    authUrl.searchParams.append('redirect_uri', REDIRECT_URI);
    authUrl.searchParams.append('code_challenge', codeChallenge);
    authUrl.searchParams.append('code_challenge_method', 'S256');

    console.log("Iniciando launchWebAuthFlow com URL:", authUrl.href);

    // 3. Iniciar o fluxo de autenticação web
    const redirectUrlComCode = await new Promise((resolve, reject) => {
        chrome.identity.launchWebAuthFlow({
            'url': authUrl.href,
            'interactive': true
        }, (redirect_url) => {
            if (chrome.runtime.lastError || !redirect_url) {
                reject(new Error(chrome.runtime.lastError?.message || "O usuário fechou a janela de autenticação."));
            } else {
                resolve(redirect_url);
            }
        });
    });

    console.log("Recebido redirect URL:", redirectUrlComCode);

    // 4. Extrair o código de autorização da URL de retorno
    const url = new URL(redirectUrlComCode);
    const authCode = url.searchParams.get('code');
    if (!authCode) throw new Error("Não foi possível extrair o código de autorização.");

    console.log("Código de autorização obtido:", authCode);

    // 5. Trocar o código de autorização por um Access Token
    await obterAccessToken(authCode);
}

async function obterAccessToken(authCode) {
    // 1. Recuperar o code_verifier que salvamos antes
    const { ml_code_verifier } = await chrome.storage.local.get('ml_code_verifier');
    if (!ml_code_verifier) throw new Error("Code verifier não encontrado no storage.");
    
    const tokenUrl = 'https://api.mercadolibre.com/oauth/token';

    const params = new URLSearchParams();
    params.append('grant_type', 'authorization_code');
    params.append('client_id', CLIENT_ID);
    params.append('client_secret', CLIENT_SECRET);
    params.append('code', authCode);
    params.append('redirect_uri', REDIRECT_URI);
    params.append('code_verifier', ml_code_verifier); // <-- O PARÂMETRO QUE FALTAVA!

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
        throw new Error(`Erro ao obter access token: ${errorData.message || response.statusText}`);
    }

    const tokenData = await response.json();
    console.log("Token recebido com sucesso!", tokenData);

    // 6. Salvar os tokens e limpar o code_verifier
    const expirationTime = Date.now() + (tokenData.expires_in * 1000);
    await chrome.storage.local.set({
        'ml_access_token': tokenData.access_token,
        'ml_refresh_token': tokenData.refresh_token,
        'ml_token_expires': expirationTime
    });
    await chrome.storage.local.remove('ml_code_verifier');
    
    console.log("Tokens salvos e verifier limpo.");
}