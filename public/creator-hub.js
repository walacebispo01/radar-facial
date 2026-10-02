(() => {
    'use strict';
    const root = document.getElementById('creator-hub'); if (!root) return;
    let me, view = 'links';
    const el = (tag, text, cls) => { const n = document.createElement(tag); if (text) n.textContent = text; if (cls) n.className = cls; return n; };
    const status = el('p', null, 'form-status'); status.setAttribute('role', 'status');
    const auth = RadarAuth.createClient({ onSession(session) { if (!session) { root.hidden = true; root.replaceChildren(); } } });
    async function api(route, body, method = 'POST') { const r = await auth.request('/api/criadores' + route, body === undefined ? {} : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); const data = await r.json(); if (!r.ok) { if (data.code === 'STEP_UP_REQUIRED') await render(); throw new Error(data.error); } return data; }
    function action(text, run, quiet = false) { const b = el('button', text, quiet ? 'quiet' : ''); b.type = 'button'; b.onclick = async () => { b.disabled = true; status.textContent = ''; try { await run(); } catch (e) { status.textContent = e.message; } finally { b.disabled = false; } }; return b; }
    function field(form, title, name, type = 'text', value = '') { const label = el('label', title), input = el('input'); input.name = name; input.type = type; input.required = true; input.value = value; input.maxLength = type === 'url' ? 2048 : 80; label.append(input); form.append(label); return input; }
    function formPanel(video) {
        const form = el('form', null, 'surface stack'); form.append(el('h3', video ? 'Editar vídeo' : 'Adicionar meu vídeo'), el('p', 'Cole o link público do seu criativo. TikTok, YouTube, Instagram, Facebook ou outra plataforma.', 'muted'));
        field(form, 'Link do vídeo', 'url', 'url', video?.url); field(form, 'Título do criativo', 'titulo', 'text', video?.titulo);
        form.append(el('p', 'Até 5 vídeos. Novos envios e edições ficam pendentes de aprovação.', 'muted'));
        const submit = el('button', 'Enviar para aprovação'); submit.type = 'submit'; form.append(submit);
        form.onsubmit = async e => { e.preventDefault(); submit.disabled = true; try { await api('/videos', { ...(video ? { id: video.id } : {}), url: form.elements.url.value, titulo: form.elements.titulo.value }); await render(); status.textContent = 'Vídeo enviado para aprovação.'; } catch (e) { status.textContent = e.message; } finally { submit.disabled = false; } };
        if (video) form.append(action('Cancelar edição', render, true)); return form;
    }
    async function render() {
        me = await api('/me'); root.replaceChildren(status); root.hidden = false;
        if (me.application && !me.creator) root.append(el('p', 'Sua candidatura está: ' + me.application.status + '.', 'surface'));
        if (me.creator?.status === 'suspenso') { root.append(el('p', 'Seu acesso de criador está suspenso. Os vídeos estão ocultos e o histórico foi preservado.', 'surface')); return; }
        if (!me.creator && me.reviewer) view = 'review';
        const nav = el('nav'); nav.setAttribute('aria-label', 'Links, vídeos e aprovações');
        const options = [...(me.creator?.status === 'ativo' ? [['links','Meus links'],['videos','Meus vídeos']] : []), ...(me.reviewer ? [['review','Aprovações']] : [])];
        for (const [key, title] of options) { const b = action(title, async () => { view = key; await render(); }, true); if (view === key) b.setAttribute('aria-current', 'page'); nav.append(b); } root.append(nav);
        if (me.creator?.status === 'ativo') {
            const links = el('section', null, 'surface stack'); links.hidden = view !== 'links'; links.append(el('h2', 'Meus links'), el('p', 'Venda créditos ou convide novos criadores para sua rede.', 'muted'));
            if (me.enabled) { const data = await api('/links'); for (const [key, title] of [['sale','Link de venda'], ['invitation','Convite de criador']]) { const url = location.origin + data[key]; const label = el('label', title), input = el('input'); input.readOnly = true; input.value = url; label.append(input); const actions = el('div', null, 'actions'); actions.append(action('Copiar link', async () => { await navigator.clipboard.writeText(url); status.textContent = 'Link copiado!'; })); if (navigator.share) actions.append(action('Compartilhar', async () => { try { await navigator.share({ title, url }); } catch (e) { if (e.name !== 'AbortError') throw e; } }, true)); links.append(label, actions); } }
            else links.append(el('p', 'Os convites estarão disponíveis quando o programa estiver ativado.', 'muted'));
            const simulation = el('a', 'Abrir Modo Simulação →', 'button'); simulation.href = '/?modo=simulacao'; links.append(simulation); root.append(links);
            const videoSection = el('section'); videoSection.hidden = view !== 'videos'; videoSection.append(el('h2', 'Meus vídeos')); const list = el('div', null, 'scenario-grid'); const data = await api('/videos');
            for (const video of data.items) { const card = el('article', null, 'surface'); const link = el('a', 'Ver publicação ↗'); link.href = video.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; const actions = el('div', null, 'actions'); actions.append(action('Editar link', () => { const f = formPanel(video); list.replaceChildren(f); f.scrollIntoView({ behavior: 'smooth' }); }, true), action('Remover', async () => { if (confirm('Remover este vídeo da galeria?')) { await api('/videos/' + encodeURIComponent(video.id), {}, 'DELETE'); await render(); } }, true)); card.append(el('h3', video.titulo), el('p', video.plataforma + ' · ' + video.status, 'muted'), link, actions); list.append(card); }
            videoSection.append(list, formPanel()); root.append(videoSection);
        }
        if (me.reviewer) {
            const panel = el('section', null, 'surface stack'); panel.hidden = view !== 'review'; panel.append(el('h2', 'Aprovações e destaques'));
            if (!me.adminStepUp) {
                const f = el('form', null, 'stack'); const code = field(f, 'Código do autenticador', 'code'); code.maxLength = 6; code.inputMode = 'numeric'; code.pattern = '[0-9]{6}'; code.autocomplete = 'one-time-code'; const submit = el('button', 'Confirmar acesso'); submit.type = 'submit'; f.append(submit);
                f.onsubmit = async e => { e.preventDefault(); submit.disabled = true; try { const r = await auth.request('/api/programa/admin/verificar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: code.value }) }); const d = await r.json(); if (!r.ok) throw new Error(d.error); await render(); } catch (e) { status.textContent = e.message; } finally { submit.disabled = false; } }; panel.append(f); root.append(panel); return;
            }
            const applications = await api('/admin/candidaturas'); panel.append(el('h3', 'Novos criadores'));
            if (!applications.items.length) panel.append(el('p', 'Nenhuma candidatura pendente.', 'muted'));
            for (const a of applications.items) { const row = el('article', null, 'surface'); row.append(el('h3', a.nome), el('p', a.email + ' · Indicado por ' + a.indicador_nome, 'muted')); const actions = el('div', null, 'actions'); actions.append(action('Aprovar criador', async () => { await api('/admin/candidaturas/' + a.id, { approved: true }); await render(); }), action('Recusar', async () => { await api('/admin/candidaturas/' + a.id, { approved: false }); await render(); }, true)); row.append(actions); panel.append(row); }
            const videos = (await api('/admin/videos')).items; panel.append(el('h3', 'Vídeos e destaques'));
            const highlights = videos.filter(v => v.status === 'aprovado' && v.destaque).sort((a,b) => a.posicao - b.posicao || new Date(a.criado_em) - new Date(b.criado_em));
            for (const v of videos) { const row = el('article', null, 'surface'); const link = el('a', 'Assistir ao vídeo ↗'); link.href = v.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; row.append(el('h3', v.titulo), el('p', v.criador_nome + ' · ' + v.status + (v.destaque ? ' · Destaque' : '') + (v.criador_status !== 'ativo' ? ' · Criador suspenso: oculto' : ''), 'muted'), link); const actions = el('div', null, 'actions');
                const decision = async (status, destaque) => { await api('/admin/videos/' + v.id, { status, destaque, versao: v.versao }); await render(); };
                if (v.criador_status === 'ativo') { if (v.status !== 'aprovado') actions.append(action('Aprovar vídeo', () => decision('aprovado', false))); else actions.append(action(v.destaque ? 'Retirar destaque' : 'Destacar na inicial', () => decision('aprovado', !v.destaque), true)); actions.append(action(v.status === 'aprovado' ? 'Ocultar vídeo' : 'Recusar vídeo', () => decision('recusado', false), true)); }
                const position = highlights.findIndex(item => item.id === v.id);
                if (position >= 0) for (const [title, delta] of [['↑ Subir',-1], ['↓ Descer',1]]) { const next = position + delta; if (next >= 0 && next < highlights.length) actions.append(action(title, async () => { const ids = highlights.map(item => item.id); [ids[position], ids[next]] = [ids[next], ids[position]]; await api('/admin/ordenacao', { ids }); await render(); }, true)); }
                row.append(actions); panel.append(row);
            }
            root.append(panel);
        }
    }
    (async () => { try { const session = await auth.restore(); if (session) await render(); } catch (e) { if (!/ainda não disponível/.test(e.message)) { root.hidden = false; root.replaceChildren(status); status.textContent = e.message; } } })();
})();
