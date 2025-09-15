document.getElementById('loginButton').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'login' }, (response) => {
        if (response.success) {
            window.close(); // Fecha o popup se o login foi iniciado
        } else {
            console.error("Falha ao iniciar o login.");
        }
    });
});