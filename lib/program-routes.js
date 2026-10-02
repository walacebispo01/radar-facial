const express = require('express');
const path = require('node:path');
const { StoreError } = require('./postgres-store');

function mountProgram(app, { auth, creators, commissions, security, isAdmin }) {
    const publicDir = path.join(__dirname, '../public');
    app.get('/painel', (req, res) => res.sendFile(path.join(publicDir, 'creator-panel.html')));
    for (const file of ['creator-panel.js', 'creator-panel.css', 'creator-demo.js']) {
        app.get('/' + file, (req, res) => res.sendFile(path.join(publicDir, file)));
    }
    const router = express.Router();
    router.use(auth.requireSession);
    router.use((req, res, next) => {
        if (req.method === 'GET' || req.method === 'HEAD') return next();
        auth.browserMutation(req, res, () => auth.csrf(req, res, next));
    });
    const wrap = handler => async (req, res) => {
        try { await handler(req, res); }
        catch (error) {
            const status = error instanceof StoreError ? error.status : Number(error.status);
            const publicError = status >= 400 && status < 500;
            res.status(publicError ? status : 500).json({ success: false,
                error: publicError ? error.message : 'Não foi possível concluir a operação. Tente novamente.' });
        }
    };
    router.get('/me', wrap(async (req, res) => {
        const admin = isAdmin(req.auth.email);
        res.json({ success: true, enabled: !!creators, isAdmin: admin, creator: creators ? await creators.me(req.auth.email) : null,
            adminStepUp: admin && !!security && await security.active(req.auth) });
    }));
    function admin(req, res, next) {
        if (!isAdmin(req.auth.email)) return res.status(403).json({ success: false, error: 'Acesso administrativo não autorizado.' });
        next();
    }
    router.post('/admin/verificar', admin, wrap(async (req, res) => {
        if (!security) return res.status(503).json({ success: false, code: 'ADMIN_2FA_NOT_CONFIGURED', error: 'Configure o autenticador administrativo antes de liberar operações.' });
        return security.limiter('admin-totp', 5, 300)(req, res, async () => {
            const result = await security.verify(req.auth, req.body?.code);
            if (!result.ok) return res.status(result.code === 'ADMIN_2FA_NOT_CONFIGURED' ? 503 : 403).json({ success: false, code: result.code,
                error: result.code === 'ADMIN_2FA_NOT_CONFIGURED' ? 'Configure o autenticador administrativo antes de liberar operações.' : 'Código inválido ou já usado. Aguarde um novo código.' });
            res.json({ success: true, expires_in: 300 });
        });
    }));
    router.use((req, res, next) => {
        if (!creators || !security || !commissions) return res.status(503).json({ success: false, error: 'Programa de criadores ainda não ativado.' });
        next();
    });
    router.use((req, res, next) => security.limiter('program', 120)(req, res, next));
    async function member(req, res, next) {
        try {
            req.creator = await creators.me(req.auth.email);
            if (!req.creator || req.creator.status !== 'ativo') return res.status(403).json({ success: false, error: 'Acesso de criador não autorizado.' });
            next();
        } catch (_) { res.status(503).json({ success: false, error: 'Não foi possível verificar o acesso.' }); }
    }
    const stepUp = (req, res, next) => security.requireStepUp(req, res, next);
    router.get('/admin/criadores', admin, stepUp, wrap(async (req, res) => res.json({ success: true, ...await creators.listCreators(req.query) })));
    router.post('/admin/criadores', admin, stepUp, wrap(async (req, res) => {
        if (!require('./creator-portal-routes').isApprover(req.auth.email)) return res.status(403).json({ success: false, error: 'Aprovação não autorizada.' });
        const { nome, email, parent_id, percentual, demo_enabled, motivo } = req.body || {};
        res.status(201).json({ success: true, creator: await creators.createCreator({ nome, email, parent_id, percentual, demo_enabled: true, motivo }, req.auth.email) });
    }));
    router.patch('/admin/criadores/:id', admin, stepUp, wrap(async (req, res) => {
        const { nome, percentual, status, demo_enabled, motivo } = req.body || {};
        res.json({ success: true, creator: await creators.updateCreator(req.params.id, { nome, percentual, status, demo_enabled, motivo }, req.auth.email) });
    }));
    router.post('/admin/criadores/:id/creditos', admin, stepUp, (req, res, next) => security.limiter('admin-grants', 20, 3600)(req, res, next), wrap(async (req, res) => {
        const idempotency_key = req.get('Idempotency-Key');
        if (!idempotency_key || !/^[A-Za-z0-9:_-]{8,160}$/.test(idempotency_key)) return res.status(400).json({ success: false, error: 'Chave de operação obrigatória.' });
        const result = await creators.grantCredits(req.params.id, {
            quantidade: req.body?.quantidade, motivo: req.body?.motivo, idempotency_key,
        }, req.auth.email);
        res.json({ success: true, ...result });
    }));
    router.get('/admin/criadores/:id/historico', admin, stepUp, wrap(async (req, res) =>
        res.json({ success: true, ...await creators.creatorHistory(req.params.id) })));
    router.get('/admin/pendencias', admin, stepUp, wrap(async (req, res) => res.json({ success: true, items: await commissions.listIssues() })));
    router.post('/admin/reprocessar', admin, stepUp, (req, res, next) => security.limiter('admin-reprocess', 5)(req, res, next), wrap(async (req, res) => {
        await commissions.processPending(20);
        res.json({ success: true });
    }));
    router.get('/rede/:id', wrap(async (req, res) => {
        const viewer = isAdmin(req.auth.email) ? null : await creators.me(req.auth.email);
        if (!isAdmin(req.auth.email) && (!viewer || viewer.status !== 'ativo' || !await creators.canAccessNetwork(viewer.id, req.params.id))) {
            return res.status(403).json({ success: false, error: 'Rede não autorizada.' });
        }
        const result = await creators.network(req.params.id, req.query);
        if (viewer) {
            // A member can navigate referrals, but not retrieve other creators' private profiles.
            const safe = row => row && ({ id: row.id, nome: row.nome, parent_id: row.parent_id, depth: row.depth, status: row.status });
            result.items = (result.items || []).map(safe);
            if (result.creator) result.creator = safe(result.creator);
            if (result.path) result.path = result.path.map(safe);
        }
        res.json({ success: true, ...result });
    }));
    async function commissionViewer(req, res, next) {
        if (isAdmin(req.auth.email)) return stepUp(req, res, () => { req.viewerId = null; next(); });
        await member(req, res, () => { req.viewerId = req.creator.id; next(); });
    }
    router.get('/comissoes', commissionViewer, wrap(async (req, res) => {
        const filters = { ...req.query };
        if (req.viewerId) delete filters.creator_id;
        res.json({ success: true, ...await commissions.listCommissions(filters, req.viewerId) });
    }));
    router.get('/comissoes/:paymentId', commissionViewer, wrap(async (req, res) => {
        const detail = await commissions.paymentDetail(req.params.paymentId, req.viewerId);
        if (!detail) return res.status(404).json({ success: false, error: 'Venda não encontrada.' });
        res.json({ success: true, ...detail });
    }));
    router.get('/cenarios', member, wrap(async (req, res) => res.json({ success: true, items: await creators.listScenarios(req.auth.email) })));
    router.post('/cenarios', member, wrap(async (req, res) => {
        const { id, nome, links } = req.body || {};
        res.json({ success: true, scenario: await creators.saveScenario(req.auth.email, { id, nome, links }) });
    }));
    router.post('/cenarios/:id/executar', member, (req, res, next) => security.limiter('creator-demo', 30)(req, res, next), wrap(async (req, res) =>
        res.json({ success: true, ...await creators.runScenario(req.auth.email, req.params.id) })));
    app.use('/api/programa', router);
}

module.exports = { mountProgram };
