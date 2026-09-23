(function (root) {
    'use strict';

    function createClient({ onSession, fetchImpl = root.fetch.bind(root) }) {
        let csrfToken = null;
        let revision = 0;
        let loginPending = null;
        const apply = data => {
            csrfToken = data?.csrfToken || null;
            onSession(data);
        };
        const options = () => ({ credentials: 'same-origin', cache: 'no-store', mode: 'same-origin' });

        async function restore() {
            const current = revision;
            const res = await fetchImpl('/api/session', options());
            if (current !== revision) return;
            if (res.status === 401) { apply(null); return null; }
            if (!res.ok) throw new Error('Não foi possível restaurar a sessão. Tente novamente.');
            const data = await res.json();
            if (current === revision) apply(data);
            return data;
        }

        async function request(url, init = {}) {
            if (typeof url !== 'string' || !url.startsWith('/api/')) throw new Error('Destino de autenticação inválido.');
            const current = revision;
            const headers = new Headers(init.headers || {});
            headers.set('X-Radar-Request', '1');
            if (csrfToken) headers.set('X-CSRF-Token', csrfToken);
            const res = await fetchImpl(url, { ...init, ...options(), headers });
            if (res.status === 401 && current === revision) apply(null);
            return res;
        }

        function login(credential) {
            if (loginPending) return loginPending;
            revision++;
            loginPending = (async () => {
                const res = await fetchImpl('/api/login-google', {
                    ...options(), method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'X-Radar-Request': '1' },
                    body: JSON.stringify({ credential }),
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Não foi possível entrar.');
                apply(data);
                return data;
            })().finally(() => { loginPending = null; });
            return loginPending;
        }

        async function logout() {
            const res = await request('/api/logout', { method: 'POST',
                headers: { 'Content-Type': 'application/json' }, body: '{}' });
            if (!res.ok && res.status !== 401) throw new Error('Não foi possível sair. Tente novamente.');
            revision++;
            apply(null);
        }

        return { restore, request, login, logout };
    }

    root.RadarAuth = { createClient };
})(typeof window === 'undefined' ? globalThis : window);
