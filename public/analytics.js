(function () {
    'use strict';
    const preference = 'radar_analytics_consent';
    let config, loaded = false, ready;
    const read = () => { try { return localStorage.getItem(preference); } catch { return 'denied'; } };
    function tag() { window.dataLayer.push(arguments); }
    function start() {
        if (loaded || !config?.measurementId || read() !== 'granted' || navigator.globalPrivacyControl) return;
        loaded = true;
        window.dataLayer = window.dataLayer || [];
        window.gtag = tag;
        tag('consent', 'default', { analytics_storage: 'granted', ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' });
        tag('js', new Date());
        // Never pass checkout receipts, account identifiers or search results in URLs/titles.
        const options = { send_page_view: false, page_location: location.origin + '/', page_title: 'Radar Facial',
            page_referrer: '', allow_google_signals: false, allow_ad_personalization_signals: false };
        try {
            const ref = new URL(document.referrer);
            if (ref.origin !== location.origin) options.page_referrer = ref.origin + '/';
        } catch { /* Empty or invalid referrer. */ }
        const params = new URLSearchParams(location.search);
        const source = params.get('utm_source'), medium = params.get('utm_medium');
        if (['instagram', 'facebook', 'tiktok', 'youtube', 'google', 'afiliado'].includes(source)) options.campaign_source = source;
        if (['social', 'organic', 'referral', 'email', 'cpc', 'paid_social'].includes(medium)) options.campaign_medium = medium;
        tag('config', config.measurementId, options);
        tag('event', 'page_view', { page_location: options.page_location, page_title: options.page_title, page_referrer: options.page_referrer });
        const script = document.createElement('script');
        script.async = true;
        script.src = 'https://www.googletagmanager.com/gtag/js?id=' + config.measurementId;
        document.head.append(script);
    }
    function choose(value) {
        try { localStorage.setItem(preference, value); } catch { return; }
        if (value === 'granted') {
            if (loaded) {
                window['ga-disable-' + config.measurementId] = false;
                tag('consent', 'update', { analytics_storage: 'granted' });
            } else start();
        }
        else if (loaded) {
            window['ga-disable-' + config.measurementId] = true;
            tag('consent', 'update', { analytics_storage: 'denied' });
        }
    }
    function showPreferences() {
        const existing = document.getElementById('radar-analytics-choice');
        if (existing) { existing.hidden = false; return; }
        const panel = document.createElement('aside');
        panel.id = 'radar-analytics-choice';
        panel.setAttribute('aria-label', 'Preferências de métricas');
        panel.style.cssText = 'position:fixed;bottom:16px;left:16px;right:16px;max-width:500px;margin:auto;z-index:1200;background:#101a2b;color:#eef2fa;border:1px solid #344157;border-radius:18px;padding:18px;box-shadow:0 8px 32px #0008;font:14px/1.5 system-ui';
        const text = document.createElement('p');
        text.textContent = 'Podemos usar o Google Analytics para entender visitas e compras? Fotos, resultados de buscas e seu e-mail não são enviados. Você pode mudar sua escolha em “Privacidade e métricas”.';
        text.style.margin = '0 0 12px';
        panel.append(text);
        const details = document.createElement('a');
        details.href = 'https://policies.google.com/technologies/partner-sites?hl=pt-BR';
        details.target = '_blank'; details.rel = 'noopener noreferrer'; details.textContent = 'Como o Google usa os dados';
        details.style.cssText = 'display:block;color:#c5d4ef;margin-bottom:12px'; panel.append(details);
        for (const [label, value] of [['Permitir métricas', 'granted'], ['Agora não', 'denied']]) {
            const button = document.createElement('button');
            button.type = 'button'; button.textContent = label;
            button.style.cssText = 'padding:10px 16px;border:1px solid #66748b;border-radius:10px;margin-right:8px;cursor:pointer;font:inherit;background:#18243a;color:#fff';
            button.addEventListener('click', () => {
                choose(value); panel.hidden = true;
                if (value === 'denied') window.dispatchEvent(new Event('radar-analytics-withdraw'));
            });
            panel.append(button);
        }
        document.body.append(panel);
    }
    window.RadarAnalytics = {
        async context() {
            await ready;
            if (!loaded || read() !== 'granted' || navigator.globalPrivacyControl || !window.gtag) return null;
            const get = field => new Promise(resolve => {
                const timeout = setTimeout(() => resolve(null), 350);
                window.gtag('get', config.measurementId, field, value => { clearTimeout(timeout); resolve(value); });
            });
            const [clientId, sessionId] = await Promise.all([get('client_id'), get('session_id')]);
            return clientId && sessionId ? { consent: true, clientId, sessionId } : null;
        },
        async beginCheckout(item) {
            if (!loaded || read() !== 'granted' || navigator.globalPrivacyControl) return;
            await new Promise(resolve => {
                const timeout = setTimeout(resolve, 200);
                tag('event', 'begin_checkout', { currency: 'BRL', value: item.price,
                    items: [item], event_callback() { clearTimeout(timeout); resolve(); }, event_timeout: 200 });
            });
        },
    };
    ready = (async () => {
        try {
            const response = await fetch('/api/analytics/config', { signal: AbortSignal.timeout(1500) });
            config = await response.json();
            if (!/^G-[A-Z0-9]{6,20}$/.test(config.measurementId || '')) return;
            const settings = document.createElement('button');
            settings.type = 'button'; settings.textContent = 'Privacidade e métricas';
            settings.style.cssText = 'display:block;margin:18px auto;background:transparent;border:0;color:#94a3b8;font:13px system-ui;cursor:pointer';
            settings.addEventListener('click', showPreferences); document.body.append(settings);
            if (read() === 'granted') start();
            else if (!read() && !navigator.globalPrivacyControl) showPreferences();
        } catch { /* Analytics is optional and must never block purchases. */ }
    })();
})();
