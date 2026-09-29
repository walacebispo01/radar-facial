(function (root) {
    'use strict';
    const scenarioId = new URLSearchParams(root.location.search).get('cenario');
    const requested = new URLSearchParams(root.location.search).has('cenario');
    let account = null, generation = 0, client = null, state = null;
    let pending = Promise.resolve();

    function renderAccess() {
        const button = document.getElementById('creatorPanelBtn');
        if (button) button.style.display = state?.isAdmin || (state?.enabled && state.creator?.status === 'ativo') ? 'flex' : 'none';
    }
    async function read(url, init) {
        const response = await client.request(url, init);
        const data = await response.json();
        if (!response.ok || data.success === false) throw new Error(data.error || 'Não foi possível acessar o cenário.');
        return data;
    }
    function onSession(session, authClient) {
        client = authClient;
        if (account === (session?.email || null)) return;
        account = session?.email || null;
        const current = ++generation;
        state = null;
        renderAccess();
        pending = account ? read('/api/programa/me').then(data => {
            if (current === generation) { state = data; renderAccess(); }
        }).catch(() => { /* Missing privileges fail closed when a scenario is requested. */ }) : Promise.resolve();
    }
    async function ensure() {
        if (!requested) return false;
        const current = generation;
        await pending;
        if (current !== generation || !account || !state?.enabled || state.creator?.status !== 'ativo' || !state.creator.demo_enabled || !scenarioId) {
            throw new Error('Este cenário não está disponível para sua conta. Abra o painel de criadores e selecione um cenário autorizado.');
        }
        return true;
    }
    async function execute() {
        await ensure();
        const current = generation;
        const data = await read('/api/programa/cenarios/' + encodeURIComponent(scenarioId) + '/executar', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
        });
        if (current !== generation) throw new Error('A sessão mudou. Entre novamente para continuar.');
        return data.items;
    }
    root.RadarCreatorDemo = { onSession, ensure, execute, requested, enabled: () => state?.enabled === true };
})(window);
