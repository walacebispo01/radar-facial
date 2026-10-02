const crypto = require('node:crypto');
const net = require('node:net');
const { StoreError } = require('./postgres-store');
const uid = prefix => prefix + '_' + crypto.randomUUID();
const fail = (message, status = 400) => { throw new StoreError(message, status); };
function text(value, max = 120) { if (typeof value !== 'string' || !value.trim() || value.trim().length > max) fail('Texto inválido.'); return value.trim(); }
function videoLink(raw) {
    let u; try { u = new URL(text(raw, 2048)); } catch (_) { fail('Informe um link HTTPS público válido.'); }
    const host = u.hostname.toLowerCase();
    if (u.protocol !== 'https:' || u.username || u.password || u.port || !host.includes('.') || net.isIP(host.replace(/^\[|\]$/g, '')) || /(^|\.)(localhost|local|internal|test|example|invalid)$/.test(host)) fail('Informe um link HTTPS público válido.');
    const domain = d => host === d || host.endsWith('.' + d);
    const platform = domain('tiktok.com') ? 'TikTok' : domain('youtube.com') || domain('youtu.be') ? 'YouTube' : domain('instagram.com') ? 'Instagram' : domain('facebook.com') || domain('fb.watch') ? 'Facebook' : 'Outras';
    return { url: u.href, plataforma: platform };
}
function createCreatorPortalStore(pool, creators) {
    async function tx(work) { const db = await pool.connect(); try { await db.query('BEGIN'); const result = await work(db); await db.query('COMMIT'); return result; } catch (e) { await db.query('ROLLBACK'); throw e; } finally { db.release(); } }
    async function member(db, address) { const c = (await db.query('SELECT * FROM public.criadores WHERE email=$1 FOR UPDATE', [address])).rows[0]; if (!c || c.status !== 'ativo') fail('Acesso de criador não autorizado.', 403); return c; }
    async function audit(db, actor, action, id, data = {}) { await db.query('INSERT INTO public.criadores_portal_auditoria(id,ator,acao,objeto_id,dados) VALUES($1,$2,$3,$4,$5)', [uid('audit'), actor, action, id, JSON.stringify(data)]); }
    const methods = {
        async profile(address) { return creators.me(address); },
        async invite(token) {
            if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) fail('Convite inválido ou indisponível.', 404);
            const c = (await pool.query("SELECT c.id,c.nome FROM public.criadores_convites i JOIN public.criadores c ON c.id=i.criador_id WHERE i.token=$1 AND c.status='ativo'", [token])).rows[0];
            if (!c) fail('Convite inválido ou indisponível.', 404); return c;
        },
        async links(address) { return tx(async db => { const c = await member(db, address); const token = crypto.randomBytes(32).toString('base64url'); const row = (await db.query('INSERT INTO public.criadores_convites(criador_id,token) VALUES($1,$2) ON CONFLICT(criador_id) DO UPDATE SET criador_id=EXCLUDED.criador_id RETURNING token', [c.id, token])).rows[0]; return { sale: '/?ref=' + encodeURIComponent(c.afiliado_codigo), invitation: '/convite?token=' + encodeURIComponent(row.token) }; }); },
        async application(address) { return (await pool.query('SELECT id,nome,status,criado_em FROM public.criadores_candidaturas WHERE email=$1', [address])).rows[0] || null; },
        async apply(address, { token, nome }) {
            nome = text(nome); const inviter = await methods.invite(token);
            return tx(async db => {
                // Candidate identity always comes from the authenticated Google session.
                await db.query('SELECT email FROM public.usuarios WHERE email=$1 FOR UPDATE', [address]);
                const parent = (await db.query('SELECT status FROM public.criadores WHERE id=$1 FOR SHARE', [inviter.id])).rows[0];
                if (!parent || parent.status !== 'ativo') fail('Convite indisponível.', 409);
                if ((await db.query('SELECT id FROM public.criadores WHERE email=$1', [address])).rows.length) fail('Esta conta já está cadastrada como criador.', 409);
                const prior = (await db.query('SELECT * FROM public.criadores_candidaturas WHERE email=$1', [address])).rows[0];
                if (prior) { if (prior.indicador_id !== inviter.id) fail('Sua candidatura já está vinculada a outro convite.', 409); return prior; }
                const row = (await db.query('INSERT INTO public.criadores_candidaturas(id,email,nome,indicador_id) VALUES($1,$2,$3,$4) RETURNING *', [uid('app'), address, nome, inviter.id])).rows[0];
                await audit(db, address, 'candidatura', row.id); return row;
            });
        },
        async applications() { return (await pool.query("SELECT a.*,c.nome AS indicador_nome FROM public.criadores_candidaturas a JOIN public.criadores c ON c.id=a.indicador_id WHERE a.status='pendente' ORDER BY a.criado_em LIMIT 200")).rows; },
        async decideApplication(id, approved, actor) { return tx(async db => {
            const a = (await db.query('SELECT * FROM public.criadores_candidaturas WHERE id=$1 FOR UPDATE', [id])).rows[0];
            if (!a) fail('Candidatura não encontrada.', 404);
            const desired = approved ? 'aprovado' : 'recusado';
            if (a.status === desired) return a; if (a.status !== 'pendente') fail('Candidatura já decidida.', 409);
            const c = approved ? await creators.createCreator({ nome: a.nome, email: a.email, parent_id: a.indicador_id, demo_enabled: true, motivo: 'Aprovação de candidatura via convite Google' }, actor, db) : null;
            const row = (await db.query('UPDATE public.criadores_candidaturas SET status=$2,criador_id=$3,decidido_por=$4,decidido_em=CURRENT_TIMESTAMP WHERE id=$1 RETURNING *', [id, desired, c?.id || null, actor])).rows[0];
            await audit(db, actor, 'candidatura:' + desired, id); return row;
        }); },
        async ownVideos(address) { return tx(async db => { const c = await member(db, address); return (await db.query("SELECT * FROM public.criadores_videos WHERE criador_id=$1 AND status<>'removido' ORDER BY criado_em DESC", [c.id])).rows; }); },
        async saveVideo(address, { id = null, titulo, url }) { titulo = text(titulo, 80); const link = videoLink(url); return tx(async db => {
            const c = await member(db, address);
            if (id) {
                const row = (await db.query("SELECT * FROM public.criadores_videos WHERE id=$1 AND criador_id=$2 AND status<>'removido' FOR UPDATE", [id, c.id])).rows[0]; if (!row) fail('Vídeo não encontrado.', 404);
                const updated = (await db.query("UPDATE public.criadores_videos SET titulo=$2,url=$3,plataforma=$4,status='pendente',destaque=false,versao=versao+1,decidido_por=NULL,decidido_em=NULL,atualizado_em=CURRENT_TIMESTAMP WHERE id=$1 RETURNING *", [id, titulo, link.url, link.plataforma])).rows[0];
                await audit(db, address, 'video:editado', id, { versao: updated.versao }); return updated;
            }
            const count = Number((await db.query("SELECT count(*) AS n FROM public.criadores_videos WHERE criador_id=$1 AND status<>'removido'", [c.id])).rows[0].n); if (count >= 5) fail('Você pode manter até 5 vídeos. Remova ou substitua um deles.', 409);
            const row = (await db.query('INSERT INTO public.criadores_videos(id,criador_id,titulo,url,plataforma) VALUES($1,$2,$3,$4,$5) RETURNING *', [uid('video'), c.id, titulo, link.url, link.plataforma])).rows[0]; await audit(db, address, 'video:enviado', row.id); return row;
        }); },
        async removeVideo(address, id) { return tx(async db => { const c = await member(db, address); const row = (await db.query("UPDATE public.criadores_videos SET status='removido',destaque=false,versao=versao+1,atualizado_em=CURRENT_TIMESTAMP WHERE id=$1 AND criador_id=$2 AND status<>'removido' RETURNING id", [id, c.id])).rows[0]; if (!row) fail('Vídeo não encontrado.', 404); await audit(db, address, 'video:removido', id); }); },
        async moderation() { return (await pool.query("SELECT v.*,c.nome AS criador_nome,c.status AS criador_status FROM public.criadores_videos v JOIN public.criadores c ON c.id=v.criador_id WHERE v.status<>'removido' ORDER BY v.destaque DESC,v.posicao,v.criado_em DESC LIMIT 500")).rows; },
        async moderate(id, { status, destaque, versao }, actor) {
            if (!['aprovado','recusado'].includes(status) || typeof destaque !== 'boolean' || !Number.isSafeInteger(versao)) fail('Decisão inválida.');
            return tx(async db => {
                await db.query("SELECT pg_advisory_xact_lock(hashtext('radar:video-order'))");
                const initial = (await db.query('SELECT criador_id FROM public.criadores_videos WHERE id=$1', [id])).rows[0]; if (!initial) fail('Vídeo não encontrado.', 404);
                const c = (await db.query('SELECT status FROM public.criadores WHERE id=$1 FOR UPDATE', [initial.criador_id])).rows[0]; if (c.status !== 'ativo') fail('Criador suspenso.', 409);
                const row = (await db.query("UPDATE public.criadores_videos SET status=$2,destaque=$3,decidido_por=$4,decidido_em=CURRENT_TIMESTAMP,versao=versao+1 WHERE id=$1 AND versao=$5 AND status<>'removido' RETURNING *", [id, status, status === 'aprovado' && destaque, actor, versao])).rows[0]; if (!row) fail('O vídeo foi alterado. Atualize antes de aprovar.', 409);
                if (row.destaque) {
                    const max = Number((await db.query('SELECT coalesce(max(posicao),-1) AS n FROM public.criadores_videos WHERE destaque=true AND id<>$1', [id])).rows[0].n);
                    row.posicao = max + 1;
                    await db.query('UPDATE public.criadores_videos SET posicao=$2 WHERE id=$1', [id, row.posicao]);
                }
                await audit(db, actor, 'video:' + status, id, { destaque: row.destaque }); return row;
            });
        },
        async reorder(ids, actor) {
            if (!Array.isArray(ids) || ids.length > 500 || ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length) fail('Ordem inválida.');
            return tx(async db => {
                await db.query("SELECT pg_advisory_xact_lock(hashtext('radar:video-order'))");
                const current = (await db.query("SELECT id FROM public.criadores_videos WHERE status='aprovado' AND destaque=true ORDER BY posicao,criado_em FOR UPDATE")).rows.map(r => r.id);
                if (current.length !== ids.length || current.some(id => !ids.includes(id))) fail('A lista de destaques mudou. Atualize a página.', 409);
                for (let i = 0; i < ids.length; i++) await db.query('UPDATE public.criadores_videos SET posicao=$2 WHERE id=$1', [ids[i], i]);
                await audit(db, actor, 'videos:ordenados', 'destaques', { ids });
            });
        },
        async publicVideos({ highlights = false, page = 1 } = {}) {
            page = Number(page); if (!Number.isSafeInteger(page) || page < 1 || page > 10000) fail('Página inválida.');
            const where = "v.status='aprovado' AND c.status='ativo' AND ($1::boolean=false OR v.destaque=true)";
            const items = (await pool.query(`SELECT v.id,v.titulo,v.url,v.plataforma,c.nome AS criador_nome FROM public.criadores_videos v JOIN public.criadores c ON c.id=v.criador_id WHERE ${where} ORDER BY v.posicao,v.criado_em DESC,v.id LIMIT 12 OFFSET $2`, [highlights, (page - 1) * 12])).rows;
            const total = Number((await pool.query(`SELECT count(*) AS n FROM public.criadores_videos v JOIN public.criadores c ON c.id=v.criador_id WHERE ${where}`, [highlights])).rows[0].n);
            return { items, page, total, pageSize: 12 };
        },
    };
    return methods;
}
module.exports = { createCreatorPortalStore, videoLink };
