const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env'), quiet: true });
const { createPool } = require('./lib/database');
const { createStore, StoreError } = require('./lib/postgres-store');
const { createSessionStore } = require('./lib/session-store');
const { createGoogleVerifier } = require('./lib/google-auth');
const { createAuth, isAuthPath } = require('./lib/auth');
const { mountProgram } = require('./lib/program-routes');
const { createProgramSecurity, verifyMercadoPagoSignature } = require('./lib/program-security');
const { getPurchasePlan } = require('./lib/purchase-plans');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');
const { MercadoPagoConfig, Payment } = require('mercadopago');

function createApp({ store, sessions, payment: paymentOverride, verifyGoogle,
    creatorStore, commissionProgram, programSecurity, webhookSecret = process.env.MERCADOPAGO_WEBHOOK_SECRET,
    appOrigin = process.env.APP_ORIGIN || process.env.RENDER_EXTERNAL_URL } = {}) {
if (!store) throw new Error('Persistência PostgreSQL obrigatória.');
const app = express();
const auth = createAuth({ sessions, origin: appOrigin, isAdmin: emailEhAdmin,
    verifyGoogle: verifyGoogle || createGoogleVerifier({ audience: process.env.GOOGLE_CLIENT_ID }) });

/* =========================================================
   CONFIGURAÇÃO GERAL
========================================================= */

const publicCors = cors();
app.use((req, res, next) => isAuthPath(req.path) ? next() : publicCors(req, res, next));
app.use(express.json());
app.use((req, res, next) => isAuthPath(req.path) ? auth.noStore(req, res, next) : next());
app.get('/auth.js', (req, res) => res.sendFile(path.join(__dirname, 'public', 'auth.js')));
require('./lib/photo-assets')(app);
require('./lib/test-credit').mountTestCredit(app, { auth, store });
mountProgram(app, { auth, creators: creatorStore, commissions: commissionProgram, security: programSecurity, isAdmin: emailEhAdmin });
app.get('/api/session', auth.requireSession, auth.session);
app.post('/api/logout', auth.browserMutation, auth.requireSession, auth.csrf, auth.logout);
app.use(['/api/descontar-credito', '/api/criar-pix', '/api/verificar-pix', '/api/escanear-rosto',
    '/api/admin/afiliados', '/api/admin/simulacao', '/api/simulacao'],
    auth.browserMutation, auth.requireSession, auth.csrf);
if (programSecurity) {
    app.use('/api/admin/afiliados', (req, res, next) => {
        if (!emailEhAdmin(req.auth?.email)) return res.status(403).json({ success: false, error: 'Acesso administrativo não autorizado.' });
        // Legacy mutation endpoints cannot bypass the new administrator second factor.
        const endpoint = req.path.toLowerCase().replace(/\/+$/, '');
        if (['/criar', '/atualizar', '/pagar'].includes(endpoint)) {
            if (!creatorStore) return res.status(503).json({ success: false, error: 'Administração temporariamente desativada.' });
            return programSecurity.requireStepUp(req, res, next);
        }
        next();
    }, programSecurity.limiter('legacy-admin', 60));
    app.use(['/api/criar-pix', '/api/verificar-pix', '/api/escanear-rosto'], programSecurity.limiter('paid-operations', 30));
    app.use('/api/login-google', programSecurity.limiter('login', 30));
}

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Sirva apenas o frontend pela rota acima; a raiz contém código e dados privados.

const storage = multer.memoryStorage();

const upload = multer({
    storage: storage,
    limits: {
        fileSize: 15 * 1024 * 1024
    }
});


/* =========================================================
   MERCADO PAGO
========================================================= */

if (!process.env.MERCADOPAGO_TOKEN) {
    console.warn('⚠️ MERCADOPAGO_TOKEN não configurado no .env');
}

const client = new MercadoPagoConfig({
    accessToken: process.env.MERCADOPAGO_TOKEN || '',
    options: { timeout: 15000 }
});

const payment = paymentOverride || new Payment(client);


/* =========================================================
   ADMIN / AFILIADOS
   Os e-mails de administrador ficam SOMENTE no ambiente:
   ADMIN_EMAILS=email1@dominio.com,email2@dominio.com
========================================================= */

function obterAdminsPermitidos() {
    return String(process.env.ADMIN_EMAILS || '')
        .split(',')
        .map(email => email.toLowerCase().trim())
        .filter(Boolean);
}

function emailEhAdmin(email) {
    if (!email) return false;
    return obterAdminsPermitidos().includes(
        String(email).toLowerCase().trim()
    );
}

function normalizarCodigoAfiliado(valor) {
    return String(valor || '')
        .toLowerCase()
        .trim()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9_-]/g, '')
        .slice(0, 40);
}

function validarAdminPorSessao(req) {
    const email = req.auth?.email;
    return email && emailEhAdmin(email) ? email : null;
}

const REDES_SOCIAIS_SIMULACAO = [
    'instagram.com', 'facebook.com', 'fb.com', 'youtube.com', 'youtu.be',
    'tiktok.com', 'x.com', 'twitter.com', 'linkedin.com', 'pinterest.com',
    'pin.it', 'telegram.me', 't.me', 'reddit.com', 'vk.com'
];

function normalizarEmail(valor) {
    const email = String(valor || '').toLowerCase().trim();
    return email.length <= 160 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

function normalizarUrlSocial(valor) {
    const bruto = String(valor || '').trim();
    if (!bruto || bruto.length > 2048) throw new StoreError('URL de rede social inválida.', 400);
    let url;
    try { url = new URL(bruto); } catch (_) { throw new StoreError('URL de rede social inválida.', 400); }
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    const suportada = REDES_SOCIAIS_SIMULACAO.some(dominio => host === dominio || host.endsWith(`.${dominio}`));
    if (url.protocol !== 'https:' || url.username || url.password || !suportada) {
        throw new StoreError('Use uma URL HTTPS válida de uma rede social compatível.', 400);
    }
    url.hash = '';
    return url.href;
}

// Mantém erros públicos existentes e não expõe detalhes do PostgreSQL.
function erroAfiliado(res, error, fallback) {
    return res.status(error instanceof StoreError ? error.status : 500).json({
        success: false,
        error: error instanceof StoreError && error.status < 500 ? error.message : fallback
    });
}

function chaveIdempotencia(req) {
    const key = req.get('Idempotency-Key');
    if (key && (key.length > 200 || !key.trim())) {
        throw new StoreError('Chave de idempotência inválida.', 400);
    }
    return key || null;
}

app.post('/api/admin/afiliados/listar', async (req, res) => {
    try {
        if (!validarAdminPorSessao(req)) {
            return res.status(403).json({ success: false, error: 'Acesso administrativo não autorizado.' });
        }
        return res.json({ success: true, afiliados: await store.listAffiliates() });
    } catch (error) { return erroAfiliado(res, error, 'Erro ao carregar afiliados.'); }
});

app.post('/api/admin/afiliados/criar', async (req, res) => {
    try {
        if (!validarAdminPorSessao(req)) {
            return res.status(403).json({ success: false, error: 'Acesso administrativo não autorizado.' });
        }
        const nome = String(req.body?.nome || '').trim().slice(0, 100);
        const email = String(req.body?.email || '').toLowerCase().trim().slice(0, 160);
        const percentual = Number(req.body?.percentual);
        if (!nome) return res.status(400).json({ success: false, error: 'Nome do afiliado é obrigatório.' });
        if (![10, 15].includes(percentual)) return res.status(400).json({ success: false, error: 'A comissão deve ser 10% ou 15%.' });
        return res.json({ success: true, afiliado: await store.createAffiliate({ nome, email, percentual }) });
    } catch (error) { return erroAfiliado(res, error, 'Erro ao criar afiliado.'); }
});

app.post('/api/admin/afiliados/atualizar', async (req, res) => {
    try {
        if (!validarAdminPorSessao(req)) {
            return res.status(403).json({ success: false, error: 'Acesso administrativo não autorizado.' });
        }
        const codigo = normalizarCodigoAfiliado(req.body?.codigo);
        const percentual = Number(req.body?.percentual);
        const status = req.body?.status === 'inativo' ? 'inativo' : 'ativo';
        if (!await store.findAffiliate(codigo)) return res.status(404).json({ success: false, error: 'Afiliado não encontrado.' });
        if (![10, 15].includes(percentual)) return res.status(400).json({ success: false, error: 'A comissão deve ser 10% ou 15%.' });
        const afiliado = await store.updateAffiliate(codigo, percentual, status);
        if (!afiliado) return res.status(404).json({ success: false, error: 'Afiliado não encontrado.' });
        return res.json({ success: true, afiliado });
    } catch (error) { return erroAfiliado(res, error, 'Erro ao atualizar afiliado.'); }
});

app.post('/api/afiliados/clique', async (req, res) => {
    try {
        if (!await store.recordClick(normalizarCodigoAfiliado(req.body?.codigo))) {
            return res.status(404).json({ success: false, error: 'Afiliado inválido.' });
        }
        return res.json({ success: true });
    } catch (error) { return erroAfiliado(res, error, 'Erro ao registrar clique.'); }
});

app.post('/api/admin/afiliados/resumo', async (req, res) => {
    try {
        if (!validarAdminPorSessao(req)) {
            return res.status(403).json({ success: false, error: 'Acesso administrativo não autorizado.' });
        }
        const afiliado = await store.affiliateSummary(normalizarCodigoAfiliado(req.body?.codigo));
        if (!afiliado) return res.status(404).json({ success: false, error: 'Afiliado não encontrado.' });
        return res.json({ success: true, afiliado });
    } catch (error) { return erroAfiliado(res, error, 'Erro ao carregar resumo do afiliado.'); }
});

app.post('/api/admin/afiliados/pagar', async (req, res) => {
    try {
        const adminEmail = validarAdminPorSessao(req);
        if (!adminEmail) return res.status(403).json({ success: false, error: 'Acesso administrativo não autorizado.' });
        const result = await store.payAffiliate(normalizarCodigoAfiliado(req.body?.codigo), adminEmail, chaveIdempotencia(req));
        return res.json({ success: true, ...result });
    } catch (error) { return erroAfiliado(res, error, 'Erro ao registrar pagamento do afiliado.'); }
});

app.post('/api/admin/simulacao/listar', async (req, res) => {
    try {
        if (!validarAdminPorSessao(req)) {
            return res.status(403).json({ success: false, error: 'Acesso administrativo não autorizado.' });
        }
        return res.json({ success: true, criadores: await store.listSimulationCreators() });
    } catch (error) { return erroAfiliado(res, error, 'Erro ao carregar criadores autorizados.'); }
});

app.post('/api/admin/simulacao/autorizar', async (req, res) => {
    try {
        const adminEmail = validarAdminPorSessao(req);
        if (!adminEmail) {
            return res.status(403).json({ success: false, error: 'Acesso administrativo não autorizado.' });
        }
        const email = normalizarEmail(req.body?.email);
        if (!email) return res.status(400).json({ success: false, error: 'Informe um e-mail válido.' });
        const criador = await store.authorizeSimulationCreator(email, adminEmail);
        return res.json({ success: true, criador });
    } catch (error) { return erroAfiliado(res, error, 'Erro ao autorizar criador.'); }
});

app.post('/api/admin/simulacao/remover', async (req, res) => {
    try {
        if (!validarAdminPorSessao(req)) {
            return res.status(403).json({ success: false, error: 'Acesso administrativo não autorizado.' });
        }
        const email = normalizarEmail(req.body?.email);
        if (!email) return res.status(400).json({ success: false, error: 'Informe um e-mail válido.' });
        const removido = await store.removeSimulationCreator(email);
        if (!removido) return res.status(404).json({ success: false, error: 'Criador autorizado não encontrado.' });
        return res.json({ success: true });
    } catch (error) { return erroAfiliado(res, error, 'Erro ao remover autorização.'); }
});

app.post('/api/simulacao/perfil', async (req, res) => {
    try {
        const perfil = await store.getSimulationProfile(req.auth.email);
        if (!perfil) return res.status(403).json({ success: false, error: 'Modo Simulação não autorizado.' });
        return res.json({ success: true, autorizado: true, links: perfil.links });
    } catch (error) { return erroAfiliado(res, error, 'Erro ao carregar o Modo Simulação.'); }
});

app.post('/api/simulacao/executar', async (req, res) => {
    try {
        const perfil = await store.getSimulationProfile(req.auth.email);
        if (!perfil) return res.status(403).json({ success: false, error: 'Modo Simulação não autorizado.' });
        return res.json({ success: true, simulado: true, links: perfil.links.slice(0, 2) });
    } catch (error) { return erroAfiliado(res, error, 'Erro ao executar o Modo Simulação.'); }
});

app.post('/api/simulacao/links', async (req, res) => {
    try {
        if (!Array.isArray(req.body?.links) || req.body.links.length > 2) {
            return res.status(400).json({ success: false, error: 'Cadastre no máximo 2 links.' });
        }
        const links = req.body.links.map(normalizarUrlSocial);
        if (new Set(links).size !== links.length) {
            return res.status(400).json({ success: false, error: 'Não repita o mesmo link.' });
        }
        const perfil = await store.saveSimulationLinks(req.auth.email, links);
        return res.json({ success: true, autorizado: true, links: perfil.links });
    } catch (error) { return erroAfiliado(res, error, 'Erro ao salvar os links de simulação.'); }
});

app.get('/api/afiliados/validar/:codigo', async (req, res) => {
    try {
        const afiliado = await store.findAffiliate(normalizarCodigoAfiliado(req.params.codigo));
        if (!afiliado || afiliado.status !== 'ativo') return res.status(404).json({ success: false, valido: false });
        return res.json({ success: true, valido: true, codigo: afiliado.codigo });
    } catch (error) { return res.status(500).json({ success: false, valido: false }); }
});


/* =========================================================
   LOGIN GOOGLE
========================================================= */

app.post('/api/login-google', auth.browserMutation, auth.login);


/* =========================================================
   CRIAR PIX
========================================================= */

app.post(
    '/api/criar-pix',
    async (req, res) => {

        try {

            const { pacote, valor, creditos, afiliado_codigo } = req.body;
            const email = req.auth.email;


            if (!email) {

                return res.status(400).json({

                    success: false,

                    error:
                        'E-mail do usuário é obrigatório.'
                });
            }


            if (!process.env.MERCADOPAGO_TOKEN) {

                return res.status(500).json({

                    success: false,

                    error:
                        'Mercado Pago não configurado no servidor.'
                });
            }


            const emailNormalizado =
                String(email)
                    .toLowerCase()
                    .trim();


            const planoSelecionado = getPurchasePlan(pacote);
            if (!planoSelecionado) {
                return res.status(400).json({ success: false, error: 'Pacote de créditos inválido.' });
            }
            const qtdCreditos = planoSelecionado.creditos;
            const valorCentavos = planoSelecionado.centavos;
            const valorNumerico = valorCentavos / 100;

            // Compatibilidade defensiva: se um cliente antigo ainda enviar estes campos,
            // eles precisam coincidir com o catálogo imutável do servidor.
            if (valor !== undefined && Math.round(Number(valor) * 100) !== valorCentavos) {
                return res.status(400).json({ success: false, error: 'Preço do pacote inválido.' });
            }
            if (creditos !== undefined && Number(creditos) !== qtdCreditos) {
                return res.status(400).json({ success: false, error: 'Quantidade de créditos inválida.' });
            }


            const codigoAfiliadoNormalizado =
                normalizarCodigoAfiliado(
                    afiliado_codigo
                );

            const afiliadoEncontrado = await store.findAffiliate(codigoAfiliadoNormalizado);
            const afiliadoValido = afiliadoEncontrado?.status === 'ativo' ? afiliadoEncontrado.codigo : null;

            const requestKey = chaveIdempotencia(req);
            const idempotencyKey = requestKey
                ? 'pix_' + crypto.createHash('sha256').update(JSON.stringify([emailNormalizado, requestKey])).digest('hex')
                : 'pix_' + crypto.randomUUID();

            const body = {

                transaction_amount:
                    Number(
                        valorNumerico.toFixed(2)
                    ),

                description:
                    `Radar Facial - ${planoSelecionado.nome}`,

                payment_method_id:
                    'pix',

                payer: {
                    email:
                        emailNormalizado
                },

                metadata: {

                    email:
                        emailNormalizado,

                    creditos:
                        qtdCreditos,

                    plano:
                        planoSelecionado.nome,

                    afiliado_codigo:
                        afiliadoValido
                }
            };


            const result =
                await payment.create({

                    body,

                    requestOptions: {
                        idempotencyKey
                    }
                });


            if (
                !result ||
                !result.id
            ) {

                return res.status(502).json({

                    success: false,

                    error:
                        'Mercado Pago não retornou o ID do pagamento.'
                });
            }


            const transactionData =
                result
                    .point_of_interaction
                    ?.transaction_data || {};


            const qrCode =
                transactionData.qr_code ||
                null;

            const qrCodeBase64 =
                transactionData
                    .qr_code_base64 ||
                null;

            const ticketUrl =
                transactionData
                    .ticket_url ||
                null;


            await store.createPayment({
                payment_id: String(result.id),
                status: result.status || 'pending',
                status_detail: result.status_detail || null,
                email: emailNormalizado,
                buscas_restantes: qtdCreditos,
                idempotency_key: idempotencyKey,
                afiliado_codigo: afiliadoValido,
                valor_pago: Number(valorNumerico.toFixed(2))
            });

            if (
                !qrCode &&
                !qrCodeBase64 &&
                !ticketUrl
            ) {

                return res.status(502).json({

                    success: false,

                    error:
                        'O pagamento foi criado, mas o Mercado Pago não retornou o QR Code.',

                    transaction_id:
                        String(result.id)
                });
            }


            return res.json({

                success: true,

                transaction_id:
                    String(result.id),

                status:
                    result.status ||
                    'pending',

                status_detail:
                    result.status_detail ||
                    null,

                qr_code:
                    qrCode,

                qr_code_base64:
                    qrCodeBase64,

                ticket_url:
                    ticketUrl,

                transaction_data: {

                    qr_code:
                        qrCode,

                    qr_code_base64:
                        qrCodeBase64,

                    ticket_url:
                        ticketUrl
                }
            });


        } catch (error) {

            if (error instanceof StoreError) {
                return res.status(error.status).json({ success: false,
                    error: error.status < 500 ? error.message : 'Erro ao gerar o pagamento via PIX.' });
            }
            console.error(
                'ERRO AO CRIAR PIX:',
                error.response?.data ||
                error.message ||
                error
            );


            return res.status(500).json({

                success: false,

                error:
                    error.response
                        ?.data
                        ?.message ||

                    error.response
                        ?.data
                        ?.error ||

                    error.message ||

                    'Erro ao gerar o pagamento via PIX.'
            });
        }
    }
);


/* =========================================================
   PAGAMENTOS E CRÉDITOS — TRANSAÇÕES POSTGRESQL
========================================================= */

const consultarPagamento = id => payment.get({ id });

app.post('/api/verificar-pix', async (req, res) => {
    try {
        const { transaction_id } = req.body;
        if (!transaction_id) return res.status(400).json({ success: false, error: 'ID da transação não informado.' });
        if (!await store.paymentBelongsToUser(String(transaction_id), req.auth.email)) {
            return res.status(404).json({ success: false, error: 'Transação não encontrada.' });
        }
        const result = await store.syncPayment(String(transaction_id), consultarPagamento);
        if (!result) return res.status(404).json({ success: false, error: 'Transação não encontrada.' });
        return res.json({ success: true, ...result, transaction_id: String(transaction_id) });
    } catch (error) {
        return res.status(500).json({ success: false, error: 'Erro ao verificar pagamento.' });
    }
});

app.post('/api/mercadopago-webhook', async (req, res) => {
    try {
        if ((commissionProgram || webhookSecret) && !verifyMercadoPagoSignature(req, webhookSecret)) {
            return res.sendStatus(401);
        }
        if (programSecurity && !await programSecurity.consume('webhook', req.ip, 120, 60)) return res.sendStatus(429);
        const paymentId = req.query?.['data.id'] || req.query?.id || req.body?.data?.id || req.body?.id;
        if (paymentId) await store.syncPayment(String(paymentId), consultarPagamento);
        // Confirmar apenas depois do COMMIT permite ao provedor repetir falhas.
        return res.sendStatus(200);
    } catch (error) {
        console.error('[WEBHOOK] Não foi possível persistir o pagamento.');
        return res.sendStatus(500);
    }
});

app.post('/api/descontar-credito', async (req, res) => {
    try {
        const { email } = req.auth;
        if (!email) return res.status(400).json({ success: false, error: 'E-mail obrigatório.' });
        const saldo = await store.debit(String(email).toLowerCase().trim());
        if (saldo === null) return res.status(403).json({ success: false, error: 'Créditos esgotados.', creditos: 0 });
        return res.json({ success: true, creditos: saldo });
    } catch (error) {
        return res.status(500).json({ success: false, error: 'Erro ao descontar crédito.' });
    }
});


/* =========================================================
   FACECHECK
   BUSCA BIOMÉTRICA REAL
========================================================= */

app.post(
    '/api/escanear-rosto',

    upload.single('imagem'),

    async (req, res) => {

        try {

            /* =================================================
               VERIFICAR IMAGEM
            ================================================= */

            if (!req.file) {

                return res.status(400).json({

                    success: false,

                    error:
                        'Nenhuma imagem enviada.'
                });
            }


            /* =================================================
               VERIFICAR TOKEN FACECHECK
            ================================================= */

            if (
                !process.env.FACECHECK_API_KEY
            ) {

                return res.status(500).json({

                    success: false,

                    error:
                        'Chave da API do FaceCheck não configurada no servidor.'
                });
            }

            let requestKey;
            try {
                requestKey = chaveIdempotencia(req);
            } catch (error) {
                return res.status(error.status || 400).json({ success: false, error: error.message });
            }
            if (!requestKey) {
                return res.status(400).json({ success: false, error: 'Idempotency-Key é obrigatório para a busca.' });
            }

            const reservation = await store.beginFaceSearch(req.auth.email, requestKey);
            if (reservation.status === 'sem_credito') {
                return res.status(403).json({ success: false, error: 'Créditos esgotados.', creditos: 0 });
            }
            if (reservation.status === 'concluida') {
                return res.json({ ...reservation.resposta, creditos: reservation.creditos, idempotentReplay: true });
            }
            if (reservation.reused) {
                return res.status(409).json({ success: false,
                    error: reservation.status === 'processando' ? 'Esta busca ainda está em processamento.' :
                        'Esta tentativa falhou e o crédito já foi devolvido.',
                    code: reservation.status === 'processando' ? 'SEARCH_IN_PROGRESS' : 'SEARCH_REFUNDED',
                    creditos: reservation.creditos });
            }

            // Centraliza conclusão e compensação para todas as saídas da integração externa.
            const sendJson = res.json.bind(res);
            res.json = async body => {
                try {
                    if (res.statusCode >= 400 || body?.success !== true) {
                        const creditos = await store.refundFaceSearch(reservation.id, req.auth.email);
                        return sendJson({ ...body, creditos });
                    }
                    const persisted = { ...body };
                    const creditos = await store.completeFaceSearch(reservation.id, req.auth.email, persisted);
                    return sendJson({ ...persisted, creditos });
                } catch (persistenceError) {
                    console.error('[FACECHECK] Falha ao finalizar consumo de crédito.');
                    res.statusCode = 500;
                    return sendJson({ success: false, error: 'Não foi possível finalizar a busca com segurança.' });
                }
            };


            const FACECHECK_SITE =
                'https://facecheck.id';


            const FACECHECK_TOKEN =
                process.env
                    .FACECHECK_API_KEY
                    .trim();


            console.log(
                '=========================================='
            );

            console.log(
                '[FACECHECK] Iniciando busca biométrica...'
            );

            console.log(
                '[FACECHECK] Arquivo:',
                req.file.originalname ||
                'rosto.jpg'
            );

            console.log(
                '[FACECHECK] Tipo:',
                req.file.mimetype ||
                'image/jpeg'
            );

            console.log(
                '[FACECHECK] Tamanho:',
                req.file.buffer.length,
                'bytes'
            );


            /* =================================================
               1 - UPLOAD DA FOTO
            ================================================= */

            const uploadForm =
                new FormData();


            /*
             * IMPORTANTE:
             * A API atual do FaceCheck usa "images".
             */

            uploadForm.append(
                'images',

                req.file.buffer,

                {
                    filename:
                        req.file.originalname ||
                        'rosto.jpg',

                    contentType:
                        req.file.mimetype ||
                        'image/jpeg',

                    knownLength:
                        req.file.buffer.length
                }
            );


            /*
             * Campo usado pelo exemplo oficial.
             */

            uploadForm.append(
                'id_search',
                ''
            );


            console.log(
                '[FACECHECK] Enviando imagem para API...'
            );


            let uploadRes;


            try {

                uploadRes =
                    await axios.post(

                        `${FACECHECK_SITE}/api/upload_pic`,

                        uploadForm,

                        {

                            headers: {

                                ...uploadForm
                                    .getHeaders(),

                                accept:
                                    'application/json',

                                Authorization:
                                    FACECHECK_TOKEN
                            },


                            timeout:
                                60000,


                            maxContentLength:
                                Infinity,


                            maxBodyLength:
                                Infinity,


                            validateStatus:
                                () => true
                        }
                    );


            } catch (uploadError) {

                console.error(
                    '[FACECHECK] Falha de conexão no upload:',
                    uploadError.message
                );


                return res.status(502).json({

                    success: false,

                    error:
                        'Não foi possível conectar ao FaceCheck durante o envio da imagem.',

                    detalhe:
                        uploadError.message
                });
            }


            console.log(
                `[FACECHECK] Upload HTTP ${uploadRes.status}`
            );


            console.log(
                '[FACECHECK] Resposta do upload:',
                uploadRes.data
            );


            /* =================================================
               ERRO HTTP DO UPLOAD
            ================================================= */

            if (
                uploadRes.status < 200 ||
                uploadRes.status >= 300
            ) {

                return res.status(502).json({

                    success: false,

                    error:

                        uploadRes.data
                            ?.error ||

                        uploadRes.data
                            ?.message ||

                        `FaceCheck recusou o upload (HTTP ${uploadRes.status}).`,

                    codigo_facecheck:

                        uploadRes.data
                            ?.code ||

                        uploadRes.status
                });
            }


            const uploadData =
                uploadRes.data;


            if (!uploadData) {

                return res.status(502).json({

                    success: false,

                    error:
                        'FaceCheck retornou resposta vazia no upload.'
                });
            }


            /* =================================================
               ERRO RETORNADO PELO FACECHECK
            ================================================= */

            if (uploadData.error) {

                console.error(
                    '[FACECHECK] Erro no upload:',
                    uploadData
                );


                return res.status(502).json({

                    success: false,

                    error:
                        uploadData.error,

                    codigo_facecheck:
                        uploadData.code ||
                        null
                });
            }


            /* =================================================
               PEGAR ID_SEARCH
            ================================================= */

            const idSearch =
                uploadData.id_search;


            if (!idSearch) {

                console.error(
                    '[FACECHECK] id_search ausente:',
                    uploadData
                );


                return res.status(502).json({

                    success: false,

                    error:
                        'FaceCheck não retornou o identificador da busca.',

                    resposta_facecheck:
                        uploadData
                });
            }


            console.log(
                `[FACECHECK] Upload concluído. id_search=${idSearch}`
            );


            /* =================================================
               2 - CONFIGURAR BUSCA
            ================================================= */

            const searchPayload = {

                id_search:
                    idSearch,

                with_progress:
                    true,

                status_only:
                    false,

                /*
                 * FALSE = BUSCA REAL.
                 *
                 * Isso consome os créditos
                 * da conta FaceCheck.
                 */

                demo:
                    false
            };


            let searchData =
                null;


            /*
             * Faz polling.
             *
             * A busca do FaceCheck não necessariamente
             * termina na primeira requisição.
             */

            const maxTentativas =
                120;


            /* =================================================
               3 - CONSULTAR RESULTADO
            ================================================= */

            for (
                let tentativa = 1;

                tentativa <=
                maxTentativas;

                tentativa++
            ) {


                console.log(
                    `[FACECHECK] Consulta ${tentativa}/${maxTentativas}`
                );


                let searchRes;


                try {

                    searchRes =
                        await axios.post(

                            `${FACECHECK_SITE}/api/search`,

                            searchPayload,

                            {

                                headers: {

                                    accept:
                                        'application/json',

                                    Authorization:
                                        FACECHECK_TOKEN,

                                    'Content-Type':
                                        'application/json'
                                },


                                timeout:
                                    60000,


                                validateStatus:
                                    () => true
                            }
                        );


                } catch (searchError) {

                    console.error(
                        '[FACECHECK] Falha de conexão na busca:',
                        searchError.message
                    );


                    return res.status(502).json({

                        success: false,

                        error:
                            'A conexão com o FaceCheck falhou durante a pesquisa.',

                        detalhe:
                            searchError.message
                    });
                }


                console.log(
                    `[FACECHECK] Search HTTP ${searchRes.status}`
                );


                /* =============================================
                   ERRO HTTP
                ============================================= */

                if (
                    searchRes.status < 200 ||
                    searchRes.status >= 300
                ) {

                    console.error(
                        '[FACECHECK] Erro HTTP:',
                        searchRes.data
                    );


                    return res.status(502).json({

                        success: false,

                        error:

                            searchRes.data
                                ?.error ||

                            searchRes.data
                                ?.message ||

                            `FaceCheck retornou HTTP ${searchRes.status}.`,

                        codigo_facecheck:

                            searchRes.data
                                ?.code ||

                            searchRes.status
                    });
                }


                searchData =
                    searchRes.data;


                if (!searchData) {

                    console.log(
                        '[FACECHECK] Resposta vazia. Tentando novamente...'
                    );


                    await new Promise(
                        resolve =>
                            setTimeout(
                                resolve,
                                1000
                            )
                    );


                    continue;
                }


                /* =============================================
                   ERRO DA API
                ============================================= */

                if (searchData.error) {

                    console.error(
                        '[FACECHECK] API retornou erro:',
                        searchData
                    );


                    return res.status(502).json({

                        success: false,

                        error:
                            searchData.error,

                        codigo_facecheck:
                            searchData.code ||
                            null
                    });
                }


                console.log(
                    `[FACECHECK] ${searchData.message || 'Processando'} | ${searchData.progress ?? '?'}%`
                );


                /* =============================================
                   RESULTADOS PRONTOS
                ============================================= */

                if (searchData.output) {


                    const items =
                        Array.isArray(
                            searchData
                                .output
                                ?.items
                        )

                            ? searchData
                                .output
                                .items

                            : [];


                    console.log(
                        `[FACECHECK] Busca concluída com ${items.length} resultado(s).`
                    );


                    console.log(
                        '=========================================='
                    );


                    /*
                     * MANTÉM "resultados"
                     *
                     * Isso é proposital para tentar
                     * manter compatibilidade com seu
                     * index.html atual.
                     *
                     * Também disponibilizamos "items".
                     */


                    return res.json({

                        success:
                            true,

                        message:
                            'Busca biométrica realizada com sucesso!',

                        id_search:
                            idSearch,

                        total:
                            items.length,

                        items:
                            items,

                        resultados:
                            searchData
                    });
                }


                /* =============================================
                   AINDA PROCESSANDO
                ============================================= */

                await new Promise(
                    resolve =>
                        setTimeout(
                            resolve,
                            1000
                        )
                );
            }


            /* =================================================
               TEMPO LIMITE
            ================================================= */

            console.error(
                '[FACECHECK] Tempo máximo de processamento atingido.'
            );


            console.error(
                '[FACECHECK] Última resposta:',
                searchData
            );


            return res.status(504).json({

                success: false,

                error:
                    'O FaceCheck ainda estava processando a busca. Tente novamente.',

                id_search:
                    idSearch,

                progresso:
                    searchData
                        ?.progress ??
                    null,

                mensagem_facecheck:
                    searchData
                        ?.message ??
                    null
            });


        } catch (error) {


            /* =================================================
               ERRO INESPERADO
            ================================================= */


            console.error(
                '=========================================='
            );


            console.error(
                '[FACECHECK] ERRO INESPERADO'
            );


            console.error(
                'Mensagem:',
                error.message
            );


            console.error(
                'Status:',
                error.response?.status
            );


            console.error(
                'Resposta:',
                error.response?.data
            );


            console.error(
                '=========================================='
            );


            const facecheckData =
                error.response?.data ||
                null;


            const mensagem =

                facecheckData?.error ||

                facecheckData?.message ||

                error.message ||

                'Erro ao processar a busca no FaceCheck.';


            return res.status(500).json({

                success:
                    false,

                error:
                    mensagem,

                codigo_facecheck:
                    facecheckData?.code ||
                    null
            });
        }
    }
);


/* =========================================================
   ROTA DE TESTE
========================================================= */

app.get(
    '/api/status',
    (req, res) => {

        res.json({

            success:
                true,

            servidor:
                'online',

            mercado_pago:
                Boolean(
                    process.env
                        .MERCADOPAGO_TOKEN
                ),

            google:
                Boolean(
                    process.env
                        .GOOGLE_CLIENT_ID
                ),

            facecheck:
                Boolean(
                    process.env
                        .FACECHECK_API_KEY
                )
        });
    }
);


/* =========================================================
   TRATAMENTO DE ERRO DO MULTER
========================================================= */

app.use(
    (error, req, res, next) => {

        if (
            error instanceof
            multer.MulterError
        ) {

            console.error(
                '[UPLOAD] Erro Multer:',
                error.message
            );


            if (
                error.code ===
                'LIMIT_FILE_SIZE'
            ) {

                return res.status(413).json({

                    success:
                        false,

                    error:
                        'A imagem enviada é muito grande.'
                });
            }


            return res.status(400).json({

                success:
                    false,

                error:
                    `Erro no upload: ${error.message}`
            });
        }


        next(error);
    }
);


return app;
}

/* =========================================================
   SERVIDOR
========================================================= */

async function startServer() {
const pool = createPool();
let commissionProgram, creatorStore, programSecurity;
const programEnabled = process.env.CREATOR_PROGRAM_ENABLED === 'true';
try {
    await pool.query('SELECT 1');
    const migrated = (await pool.query("SELECT to_regclass('public.comissoes_rede_eventos') AS relation")).rows[0].relation;
    // Existing snapshots must continue to receive refunds even during a feature rollback.
    if (migrated || programEnabled) {
        if (!process.env.MERCADOPAGO_WEBHOOK_SECRET) throw new Error('Configure MERCADOPAGO_WEBHOOK_SECRET antes de ativar o programa.');
        if (!migrated) throw new Error('Execute migrate:creators antes de ativar o programa.');
        commissionProgram = require('./lib/commission-program').createCommissionProgram(pool);
        programSecurity = createProgramSecurity(pool);
    }
    if (programEnabled) {
        const maxGrant = Number(process.env.MAX_ADMIN_GRANT || 1000);
        if (!Number.isSafeInteger(maxGrant) || maxGrant < 1) throw new Error('MAX_ADMIN_GRANT deve ser um inteiro positivo.');
        const tables = ['criadores', 'criadores_creditos', 'criadores_cenarios', 'comissoes_rede_eventos', 'comissoes_rede_lancamentos', 'admin_stepup'];
        for (const table of tables) {
            const { rows } = await pool.query('SELECT to_regclass($1) AS relation', ['public.' + table]);
            if (!rows[0].relation) throw new Error('Execute migrate:creators antes de ativar o programa.');
        }
        creatorStore = require('./lib/creator-store').createCreatorStore(pool, { maxGrant });
    }
} catch (error) {
    await pool.end();
    throw error;
}
const app = createApp({ store: createStore(pool, { commissionProgram }), sessions: createSessionStore(pool),
    creatorStore, commissionProgram, programSecurity });
let workerRunning = null;
const runWorker = () => {
    if (!commissionProgram || workerRunning) return;
    workerRunning = commissionProgram.processPending(20)
        .catch(() => console.error('Não foi possível processar comissões. A fila será tentada novamente.'))
        .finally(() => { workerRunning = null; });
};
const workerTimer = commissionProgram ? setInterval(runWorker, 15000) : null;
workerTimer?.unref();
runWorker();
const PORT =
    process.env.PORT ||
    3000;


const server = app.listen(
    PORT,
    () => {

        console.log(
            '=========================================='
        );

        console.log(
            `🚀 Servidor rodando em http://localhost:${PORT}`
        );

        console.log(
            `💳 Mercado Pago: ${
                process.env.MERCADOPAGO_TOKEN
                    ? 'CONFIGURADO'
                    : 'NÃO CONFIGURADO'
            }`
        );

        console.log(
            `🔐 Google: ${
                process.env.GOOGLE_CLIENT_ID
                    ? 'CONFIGURADO'
                    : 'NÃO CONFIGURADO'
            }`
        );

        console.log(
            `🔍 FaceCheck: ${
                process.env.FACECHECK_API_KEY
                    ? 'CONFIGURADO'
                    : 'NÃO CONFIGURADO'
            }`
        );

        console.log(
            '=========================================='
        );
    }
);

let shuttingDown = false;
const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(workerTimer);
    server.close(async () => {
        await workerRunning;
        await pool.end().catch(() => { process.exitCode = 1; });
    });
};
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
server.on('error', () => {
    console.error('Não foi possível iniciar o servidor HTTP.');
    clearInterval(workerTimer);
    Promise.resolve(workerRunning).then(() => pool.end()).catch(() => {});
    process.exitCode = 1;
});
return server;
}

if (require.main === module) {
    startServer().catch(error => {
        console.error(error.message);
        process.exitCode = 1;
    });
}

module.exports = { createApp, startServer };
