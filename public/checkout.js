(function () {
    'use strict';
    let busy = false;
    window.RadarCheckout = {
        async buy(auth, pacote, afiliado) {
            if (busy) return true;
            busy = true;
            try {
                const configResponse = await auth.request('/api/checkout/config');
                if (!configResponse.ok) throw new Error('Entre com sua conta Google para comprar créditos.');
                const config = await configResponse.json();
                if (config.provider !== 'infinitepay') return false;
                const saved = JSON.parse(sessionStorage.getItem('radar_checkout_request') || 'null');
                const request = saved?.pacote === pacote && saved?.afiliado === afiliado ? saved :
                    { pacote, afiliado, key: crypto.randomUUID() };
                sessionStorage.setItem('radar_checkout_request', JSON.stringify(request));
                const response = await auth.request('/api/checkout/create', { method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': request.key },
                    body: JSON.stringify({ pacote, afiliado_codigo: afiliado }) });
                const data = await response.json();
                if (!response.ok) throw new Error(data.error || 'Não foi possível abrir o checkout.');
                if (data.alreadyPaid) {
                    sessionStorage.removeItem('radar_checkout_request');
                    throw new Error('A compra anterior já foi confirmada. Atualize seu saldo; para fazer outra compra, selecione o pacote novamente.');
                }
                const url = new URL(data.url);
                if (url.protocol !== 'https:' || !['checkout.infinitepay.com.br', 'checkout.infinitepay.io'].includes(url.hostname) ||
                    url.username || url.password || url.port) throw new Error('Endereço de pagamento inválido.');
                window.location.assign(url.href);
                return true;
            } finally { busy = false; }
        },
    };
})();
