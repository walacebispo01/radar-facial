(function () {
    'use strict';
    const status = document.getElementById('status'), button = document.getElementById('grant');
    let session = null;
    const auth = RadarAuth.createClient({ onSession(value) {
        session = value;
        if (!value) { button.disabled = true; status.textContent = 'Entre com sua conta Google no site e depois volte a esta página.'; }
    } });
    async function read(method = 'GET') {
        const response = await auth.request('/api/teste/credito', method === 'GET' ? {} : {
            method, headers: { 'Content-Type': 'application/json' }, body: '{}'
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Não foi possível acessar o teste.');
        return data;
    }
    button.addEventListener('click', async () => {
        button.disabled = true;
        try {
            const data = await read('POST');
            status.textContent = data.granted ? '1 crédito liberado. Volte ao site para fazer sua pesquisa.' : 'Você já tem ' + data.creditos + ' crédito(s). Use seu saldo antes de liberar outro.';
        } catch (error) { status.textContent = error.message; }
        finally { button.disabled = !session; }
    });
    (async () => {
        try {
            if (!await auth.restore()) return;
            const data = await read();
            status.textContent = 'Conta autorizada. Saldo: ' + data.creditos + ' crédito(s).';
            button.disabled = false;
        } catch (error) { status.textContent = error.message; button.disabled = true; }
    })();
})();
