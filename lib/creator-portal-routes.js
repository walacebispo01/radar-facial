const express = require('express');
const path = require('node:path');
const APPROVERS = new Set(['osasukedoinsta@gmail.com', 'walacegab1998@gmail.com']);
const isApprover = email => APPROVERS.has(String(email || '').toLowerCase());
function mountCreatorPortal(app, { auth, portal, security, enabled, isAdmin }) {
    const dir = path.join(__dirname, '../public');
    for (const file of ['creator-hub.js','social-proofs.js','social-proofs.css','creator-invite.js']) app.get('/' + file, (_, res) => res.sendFile(path.join(dir, file)));
    app.get('/convite', (_, res) => res.sendFile(path.join(dir, 'creator-invite.html')));
    app.get('/provas-sociais', (_, res) => res.sendFile(path.join(dir, 'social-proofs.html')));
    const wrap = handler => async (req, res) => { try { await handler(req, res); } catch (e) { const safe = e.status >= 400 && e.status < 500; res.status(safe ? e.status : 503).json({ success: false, error: safe ? e.message : 'Não foi possível concluir a operação.' }); } };
    app.get('/api/provas-sociais', wrap(async (req, res) => {
        res.set('Cache-Control', 'no-store');
        res.json({ success: true, ...(portal ? await portal.publicVideos({ highlights: req.query.destaques === 'true', page: req.query.page }) : { items: [], total: 0, page: 1, pageSize: 12 }) });
    }));
    app.get('/api/convite', wrap(async (req, res) => {
        res.set('Cache-Control', 'no-store');
        if (!portal || !enabled) return res.status(503).json({ success: false, error: 'Convites ainda não disponíveis.' });
        res.json({ success: true, inviter: await portal.invite(req.query.token), googleClientId: process.env.GOOGLE_CLIENT_ID || '' });
    }));
    const router = express.Router(); router.use(auth.noStore, auth.requireSession);
    router.use((req, res, next) => req.method === 'GET' ? next() : auth.browserMutation(req, res, () => auth.csrf(req, res, next)));
    router.use((req, res, next) => portal && security ? next() : res.status(503).json({ success: false, error: 'Área de criadores ainda não disponível.' }));
    router.use((req, res, next) => security.limiter('creator-portal', 90)(req, res, next));
    const reviewer = (req, res, next) => isAdmin(req.auth.email) && isApprover(req.auth.email) ? security.requireStepUp(req, res, next) : res.status(403).json({ success: false, error: 'Aprovação não autorizada.' });
    const program = (req, res, next) => enabled ? next() : res.status(503).json({ success: false, error: 'Convites ainda não disponíveis.' });
    router.get('/me', wrap(async (req, res) => res.json({ success: true, enabled, reviewer: isAdmin(req.auth.email) && isApprover(req.auth.email), creator: await portal.profile(req.auth.email), adminStepUp: await security.active(req.auth), application: await portal.application(req.auth.email) })));
    router.get('/links', program, wrap(async (req, res) => res.json({ success: true, ...await portal.links(req.auth.email) })));
    router.post('/candidaturas', program, wrap(async (req, res) => res.status(201).json({ success: true, application: await portal.apply(req.auth.email, req.body || {}) })));
    router.get('/videos', wrap(async (req, res) => res.json({ success: true, items: await portal.ownVideos(req.auth.email) })));
    router.post('/videos', wrap(async (req, res) => res.status(201).json({ success: true, video: await portal.saveVideo(req.auth.email, req.body || {}) })));
    router.delete('/videos/:id', wrap(async (req, res) => { await portal.removeVideo(req.auth.email, req.params.id); res.json({ success: true }); }));
    router.get('/admin/candidaturas', reviewer, wrap(async (_, res) => res.json({ success: true, items: await portal.applications() })));
    router.post('/admin/candidaturas/:id', reviewer, program, wrap(async (req, res) => { if (typeof req.body?.approved !== 'boolean') return res.status(400).json({ success: false, error: 'Decisão inválida.' }); res.json({ success: true, application: await portal.decideApplication(req.params.id, req.body.approved, req.auth.email) }); }));
    router.get('/admin/videos', reviewer, wrap(async (_, res) => res.json({ success: true, items: await portal.moderation() })));
    router.post('/admin/videos/:id', reviewer, wrap(async (req, res) => res.json({ success: true, video: await portal.moderate(req.params.id, req.body || {}, req.auth.email) })));
    router.post('/admin/ordenacao', reviewer, wrap(async (req, res) => { await portal.reorder(req.body?.ids, req.auth.email); res.json({ success: true }); }));
    app.use('/api/criadores', router);
}
module.exports = { mountCreatorPortal, isApprover };
