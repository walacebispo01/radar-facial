(() => {
    'use strict';
    const section = document.getElementById('social-proofs'); if (!section) return;
    const grid = section.querySelector('.rf-proof-grid'); const full = section.dataset.full === 'true'; let page = 1, busy = false;
    const el = (tag, text, cls) => { const node = document.createElement(tag); if (text) node.textContent = text; if (cls) node.className = cls; return node; };
    function safe(raw) { try { const u = new URL(raw); return u.protocol === 'https:' && !u.username && !u.password ? u : null; } catch { return null; } }
    function watch(video) {
        const u = safe(video.url); if (!u) return;
        const host = u.hostname.replace(/^www\./, '');
        const id = host === 'youtu.be' ? u.pathname.slice(1) : host === 'youtube.com' ? u.searchParams.get('v') || u.pathname.match(/^\/(?:shorts|embed)\/([A-Za-z0-9_-]+)/)?.[1] : null;
        if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id)) { window.open(u.href, '_blank', 'noopener,noreferrer'); return; }
        const dialog = el('dialog', null, 'rf-video-dialog'); const close = el('button', 'Fechar vídeo'); close.onclick = () => dialog.close();
        const iframe = el('iframe'); iframe.src = 'https://www.youtube-nocookie.com/embed/' + id; iframe.title = video.titulo; iframe.allow = 'encrypted-media; picture-in-picture'; iframe.allowFullscreen = true; iframe.referrerPolicy = 'strict-origin-when-cross-origin';
        dialog.append(close, iframe); document.body.append(dialog); dialog.addEventListener('close', () => dialog.remove()); dialog.showModal();
    }
    function card(video) {
        const u = safe(video.url); if (!u) return;
        const card = el('article', null, 'rf-proof-card'); const cover = el('button', null, 'rf-proof-cover ' + String(video.plataforma).toLowerCase()); cover.type = 'button'; cover.setAttribute('aria-label', 'Assistir: ' + video.titulo); cover.onclick = () => watch(video);
        const body = el('div'); body.append(el('strong', video.titulo), el('span', '▶', 'rf-proof-play')); cover.append(el('span', video.plataforma, 'rf-proof-badge'), body);
        const info = el('div', null, 'rf-proof-info'); const link = el('a', 'Assistir no endereço original ↗'); link.href = u.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; info.append(el('p', video.criador_nome + ' · Criador afiliado'), link); card.append(cover, info); grid.append(card);
    }
    async function load() {
        if (busy) return; busy = true;
        try {
            const res = await fetch('/api/provas-sociais?destaques=' + !full + '&page=' + page, { credentials: 'omit', cache: 'no-store' }); if (!res.ok) throw new Error(); const data = await res.json();
            (data.items || []).forEach(card); section.hidden = !grid.children.length && !full;
            if (full && !grid.children.length) section.querySelector('.rf-proof-status').textContent = 'Ainda não há vídeos publicados.';
            const more = document.getElementById('proof-more'); if (more) { more.hidden = page * 12 >= data.total; more.onclick = () => { page++; load(); }; }
        } catch { if (full) section.querySelector('.rf-proof-status').textContent = 'Não foi possível carregar os vídeos. Tente novamente mais tarde.'; }
        finally { busy = false; }
    }
    const buy = section.querySelector('[data-proof-buy]'); if (buy) buy.onclick = () => { if (typeof window.abrirModalPlanos === 'function') window.abrirModalPlanos(); };
    if (full || !('IntersectionObserver' in window)) load(); else { const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { observer.disconnect(); load(); } }, { rootMargin: '250px' }); observer.observe(section.parentElement); }
})();
