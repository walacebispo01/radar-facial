require('dotenv').config();

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');
const { MercadoPagoConfig, Payment } = require('mercadopago');

const app = express();

/* =========================================================
   CONFIGURAÇÃO GERAL
========================================================= */

app.use(cors());
app.use(express.json());

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
    accessToken: process.env.MERCADOPAGO_TOKEN || ''
});

const payment = new Payment(client);


/* =========================================================
   ARMAZENAMENTO
========================================================= */

const DATA_FILE = path.join(
    __dirname,
    'data',
    'radar-data.json'
);


function carregarDadosPersistidos() {

    try {

        const pasta = path.dirname(DATA_FILE);

        if (!fs.existsSync(pasta)) {
            fs.mkdirSync(pasta, {
                recursive: true
            });
        }

        if (!fs.existsSync(DATA_FILE)) {

            return {
                transacoes: {},
                usuariosCreditos: {},
                afiliados: {},
                comissoesAfiliados: {},
                cliquesAfiliados: [],
                repassesAfiliados: []
            };
        }

        const raw = fs.readFileSync(
            DATA_FILE,
            'utf8'
        );

        if (!raw.trim()) {

            return {
                transacoes: {},
                usuariosCreditos: {},
                afiliados: {},
                comissoesAfiliados: {},
                cliquesAfiliados: [],
                repassesAfiliados: []
            };
        }

        const parsed = JSON.parse(raw);

        return {
            transacoes: parsed.transacoes || {},
            usuariosCreditos:
                parsed.usuariosCreditos || {},
            afiliados: parsed.afiliados || {},
            comissoesAfiliados: parsed.comissoesAfiliados || {},
            cliquesAfiliados: Array.isArray(parsed.cliquesAfiliados) ? parsed.cliquesAfiliados : [],
            repassesAfiliados: Array.isArray(parsed.repassesAfiliados) ? parsed.repassesAfiliados : []
        };

    } catch (error) {

        console.error(
            'Erro ao carregar dados persistidos:',
            error.message
        );

        return {
            transacoes: {},
            usuariosCreditos: {},
            afiliados: {},
            comissoesAfiliados: {},
            cliquesAfiliados: [],
            repassesAfiliados: []
        };
    }
}


const dbStorage = carregarDadosPersistidos();

const transacoes =
    dbStorage.transacoes;

const usuariosCreditos =
    dbStorage.usuariosCreditos;

const afiliados =
    dbStorage.afiliados || {};

const comissoesAfiliados =
    dbStorage.comissoesAfiliados || {};

const cliquesAfiliados =
    Array.isArray(dbStorage.cliquesAfiliados) ? dbStorage.cliquesAfiliados : [];

const repassesAfiliados =
    Array.isArray(dbStorage.repassesAfiliados) ? dbStorage.repassesAfiliados : [];


function salvarDadosPersistidos() {

    try {

        const pasta =
            path.dirname(DATA_FILE);

        if (!fs.existsSync(pasta)) {

            fs.mkdirSync(
                pasta,
                {
                    recursive: true
                }
            );
        }

        const data = {
            transacoes,
            usuariosCreditos,
            afiliados,
            comissoesAfiliados,
            cliquesAfiliados,
            repassesAfiliados
        };

        fs.writeFileSync(
            DATA_FILE,
            JSON.stringify(
                data,
                null,
                2
            ),
            'utf8'
        );

    } catch (error) {

        console.error(
            'Erro ao salvar dados persistidos:',
            error.message
        );

        throw error;
    }
}


/* =========================================================
   GOOGLE
========================================================= */

async function validarTokenGoogle(credential) {

    if (!credential) {
        return null;
    }

    try {

        const response = await axios.get(
            'https://oauth2.googleapis.com/tokeninfo',
            {
                params: {
                    id_token: credential
                },

                timeout: 10000
            }
        );

        const data = response.data;

        if (
            !data ||
            !data.email ||
            !(
                data.email_verified === true ||
                data.email_verified === 'true'
            )
        ) {

            return null;
        }


        if (
            process.env.GOOGLE_CLIENT_ID &&
            data.aud !==
            process.env.GOOGLE_CLIENT_ID
        ) {

            console.error(
                'Google Client ID não confere com o token.'
            );

            return null;
        }


        return data.email
            .toLowerCase()
            .trim();

    } catch (error) {

        console.error(
            'Erro ao validar token Google:',
            error.message
        );

        return null;
    }
}



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

async function validarAdminPorCredential(credential) {
    const email = await validarTokenGoogle(credential);
    if (!email || !emailEhAdmin(email)) return null;
    return email;
}

function gerarIdAfiliado() {
    return `af_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function gerarCodigoAfiliadoUnico() {
    let codigo;

    do {
        codigo = `af_${crypto.randomBytes(6).toString('hex')}`;
    } while (afiliados[codigo]);

    return codigo;
}

function gerarIdComissao(paymentId) {
    return `com_${String(paymentId)}`;
}

function registrarComissaoSeNecessario(transaction, paymentId, mpCheck) {
    if (!transaction || !transaction.afiliado_codigo) return;

    const codigo = normalizarCodigoAfiliado(transaction.afiliado_codigo);
    const afiliado = afiliados[codigo];

    if (!afiliado || afiliado.status !== 'ativo') return;

    const idComissao = gerarIdComissao(paymentId);
    if (comissoesAfiliados[idComissao]) return;

    const valorPago = Number(
        mpCheck?.transaction_amount ??
        transaction.valor_pago ??
        0
    );

    if (!Number.isFinite(valorPago) || valorPago <= 0) return;

    const percentual = Number(afiliado.comissao_percentual);
    if (![10, 15].includes(percentual)) return;

    comissoesAfiliados[idComissao] = {
        id: idComissao,
        payment_id: String(paymentId),
        afiliado_codigo: codigo,
        afiliado_id: afiliado.id,
        percentual,
        valor_venda: Number(valorPago.toFixed(2)),
        valor_comissao: Number((valorPago * percentual / 100).toFixed(2)),
        status: 'disponivel',
        criado_em: new Date().toISOString()
    };

    transaction.comissao_afiliado_id = idComissao;
}


/* =========================================================
   ROTAS ADMINISTRATIVAS DE AFILIADOS
========================================================= */

app.post('/api/admin/afiliados/listar', async (req, res) => {
    try {
        const adminEmail = await validarAdminPorCredential(req.body?.credential);

        if (!adminEmail) {
            return res.status(403).json({
                success: false,
                error: 'Acesso administrativo não autorizado.'
            });
        }

        const lista = Object.values(afiliados)
            .map(a => obterResumoAfiliado(a.codigo))
            .sort((a, b) => String(b.criado_em).localeCompare(String(a.criado_em)));

        return res.json({
            success: true,
            afiliados: lista
        });
    } catch (error) {
        console.error('[AFILIADOS] Erro ao listar:', error.message);
        return res.status(500).json({
            success: false,
            error: 'Erro ao carregar afiliados.'
        });
    }
});

app.post('/api/admin/afiliados/criar', async (req, res) => {
    try {
        const adminEmail = await validarAdminPorCredential(req.body?.credential);

        if (!adminEmail) {
            return res.status(403).json({
                success: false,
                error: 'Acesso administrativo não autorizado.'
            });
        }

        const nome = String(req.body?.nome || '').trim().slice(0, 100);
        const email = String(req.body?.email || '').toLowerCase().trim().slice(0, 160);
        const codigo = gerarCodigoAfiliadoUnico();
        const percentual = Number(req.body?.percentual);

        if (!nome) {
            return res.status(400).json({
                success: false,
                error: 'Nome do afiliado é obrigatório.'
            });
        }

        if (![10, 15].includes(percentual)) {
            return res.status(400).json({
                success: false,
                error: 'A comissão deve ser 10% ou 15%.'
            });
        }

        afiliados[codigo] = {
            id: gerarIdAfiliado(),
            nome,
            email,
            codigo,
            comissao_percentual: percentual,
            status: 'ativo',
            criado_em: new Date().toISOString(),
            atualizado_em: new Date().toISOString()
        };

        salvarDadosPersistidos();

        return res.json({
            success: true,
            afiliado: afiliados[codigo]
        });
    } catch (error) {
        console.error('[AFILIADOS] Erro ao criar:', error.message);
        return res.status(500).json({
            success: false,
            error: 'Erro ao criar afiliado.'
        });
    }
});

app.post('/api/admin/afiliados/atualizar', async (req, res) => {
    try {
        const adminEmail = await validarAdminPorCredential(req.body?.credential);

        if (!adminEmail) {
            return res.status(403).json({
                success: false,
                error: 'Acesso administrativo não autorizado.'
            });
        }

        const codigo = normalizarCodigoAfiliado(req.body?.codigo);
        const percentual = Number(req.body?.percentual);
        const status = req.body?.status === 'inativo' ? 'inativo' : 'ativo';

        if (!afiliados[codigo]) {
            return res.status(404).json({
                success: false,
                error: 'Afiliado não encontrado.'
            });
        }

        if (![10, 15].includes(percentual)) {
            return res.status(400).json({
                success: false,
                error: 'A comissão deve ser 10% ou 15%.'
            });
        }

        afiliados[codigo].comissao_percentual = percentual;
        afiliados[codigo].status = status;
        afiliados[codigo].atualizado_em = new Date().toISOString();

        salvarDadosPersistidos();

        return res.json({
            success: true,
            afiliado: afiliados[codigo]
        });
    } catch (error) {
        console.error('[AFILIADOS] Erro ao atualizar:', error.message);
        return res.status(500).json({
            success: false,
            error: 'Erro ao atualizar afiliado.'
        });
    }
});


function obterResumoAfiliado(codigo) {
    const afiliado = afiliados[codigo];
    const comissoes = Object.values(comissoesAfiliados)
        .filter(c => c.afiliado_codigo === codigo);

    const vendas = comissoes.length;
    const cliques = cliquesAfiliados.filter(c => c.afiliado_codigo === codigo).length;
    const faturamento = comissoes.reduce((s, c) => s + Number(c.valor_venda || 0), 0);
    const comissaoTotal = comissoes.reduce((s, c) => s + Number(c.valor_comissao || 0), 0);
    const comissaoPaga = comissoes
        .filter(c => c.status === 'pago')
        .reduce((s, c) => s + Number(c.valor_comissao || 0), 0);
    const comissaoDisponivel = comissoes
        .filter(c => c.status === 'disponivel' || c.status === 'pendente')
        .reduce((s, c) => s + Number(c.valor_comissao || 0), 0);

    return {
        ...afiliado,
        metricas: {
            cliques,
            vendas,
            conversao: cliques > 0 ? Number(((vendas / cliques) * 100).toFixed(2)) : 0,
            faturamento: Number(faturamento.toFixed(2)),
            comissao_total: Number(comissaoTotal.toFixed(2)),
            comissao_disponivel: Number(comissaoDisponivel.toFixed(2)),
            comissao_paga: Number(comissaoPaga.toFixed(2))
        },
        repasses: repassesAfiliados
            .filter(r => r.afiliado_codigo === codigo)
            .sort((a, b) => String(b.pago_em).localeCompare(String(a.pago_em)))
    };
}

app.post('/api/afiliados/clique', (req, res) => {
    const codigo = normalizarCodigoAfiliado(req.body?.codigo);
    const afiliado = afiliados[codigo];

    if (!afiliado || afiliado.status !== 'ativo') {
        return res.status(404).json({ success: false, error: 'Afiliado inválido.' });
    }

    cliquesAfiliados.push({
        id: `clk_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
        afiliado_codigo: codigo,
        criado_em: new Date().toISOString()
    });

    salvarDadosPersistidos();
    return res.json({ success: true });
});

app.post('/api/admin/afiliados/resumo', async (req, res) => {
    try {
        const adminEmail = await validarAdminPorCredential(req.body?.credential);
        if (!adminEmail) {
            return res.status(403).json({ success: false, error: 'Acesso administrativo não autorizado.' });
        }

        const codigo = normalizarCodigoAfiliado(req.body?.codigo);
        if (!afiliados[codigo]) {
            return res.status(404).json({ success: false, error: 'Afiliado não encontrado.' });
        }

        return res.json({ success: true, afiliado: obterResumoAfiliado(codigo) });
    } catch (error) {
        return res.status(500).json({ success: false, error: 'Erro ao carregar resumo do afiliado.' });
    }
});

app.post('/api/admin/afiliados/pagar', async (req, res) => {
    try {
        const adminEmail = await validarAdminPorCredential(req.body?.credential);
        if (!adminEmail) {
            return res.status(403).json({ success: false, error: 'Acesso administrativo não autorizado.' });
        }

        const codigo = normalizarCodigoAfiliado(req.body?.codigo);
        const afiliado = afiliados[codigo];

        if (!afiliado) {
            return res.status(404).json({ success: false, error: 'Afiliado não encontrado.' });
        }

        const abertas = Object.values(comissoesAfiliados).filter(c =>
            c.afiliado_codigo === codigo &&
            (c.status === 'disponivel' || c.status === 'pendente')
        );

        if (!abertas.length) {
            return res.status(400).json({ success: false, error: 'Não há comissão disponível para marcar como paga.' });
        }

        const valor = Number(abertas.reduce((s, c) => s + Number(c.valor_comissao || 0), 0).toFixed(2));
        const repasseId = `rep_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
        const pagoEm = new Date().toISOString();

        abertas.forEach(c => {
            c.status = 'pago';
            c.pago_em = pagoEm;
            c.repasse_id = repasseId;
        });

        repassesAfiliados.push({
            id: repasseId,
            afiliado_codigo: codigo,
            afiliado_id: afiliado.id,
            valor,
            quantidade_comissoes: abertas.length,
            pago_em: pagoEm,
            registrado_por: adminEmail
        });

        salvarDadosPersistidos();

        return res.json({
            success: true,
            repasse: repassesAfiliados[repassesAfiliados.length - 1],
            afiliado: obterResumoAfiliado(codigo)
        });
    } catch (error) {
        return res.status(500).json({ success: false, error: 'Erro ao registrar pagamento do afiliado.' });
    }
});

app.get('/api/afiliados/validar/:codigo', (req, res) => {
    const codigo = normalizarCodigoAfiliado(req.params.codigo);
    const afiliado = afiliados[codigo];

    if (!afiliado || afiliado.status !== 'ativo') {
        return res.status(404).json({
            success: false,
            valido: false
        });
    }

    return res.json({
        success: true,
        valido: true,
        codigo: afiliado.codigo
    });
});


/* =========================================================
   LOGIN GOOGLE
========================================================= */

app.post(
    '/api/login-google',
    async (req, res) => {

        try {

            const {
                credential
            } = req.body;


            if (!credential) {

                return res.status(400).json({
                    success: false,
                    error:
                        'Token Google não informado.'
                });
            }


            const emailValidado =
                await validarTokenGoogle(
                    credential
                );


            if (!emailValidado) {

                return res.status(401).json({
                    success: false,
                    error:
                        'Autenticação Google inválida.'
                });
            }


            if (
                usuariosCreditos[
                    emailValidado
                ] === undefined
            ) {

                usuariosCreditos[
                    emailValidado
                ] = 0;

                salvarDadosPersistidos();
            }


            return res.json({

                success: true,

                email:
                    emailValidado,

                creditos:
                    usuariosCreditos[
                        emailValidado
                    ],

                isAdmin:
                    emailEhAdmin(
                        emailValidado
                    )
            });


        } catch (error) {

            console.error(
                'Erro no login Google:',
                error.message
            );


            return res.status(500).json({

                success: false,

                error:
                    'Erro ao sincronizar usuário.'
            });
        }
    }
);


/* =========================================================
   CRIAR PIX
========================================================= */

app.post(
    '/api/criar-pix',
    async (req, res) => {

        try {

            const {
                valor,
                plano,
                email,
                creditos,
                afiliado_codigo
            } = req.body;


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


            let qtdCreditos =
                Number(creditos);


            if (!Number.isFinite(qtdCreditos)) {

                if (
                    plano ===
                    'Pesquisa Única'
                ) {

                    qtdCreditos = 1;

                } else if (
                    plano ===
                    'Pacote Investigador'
                ) {

                    qtdCreditos = 10;

                } else {

                    qtdCreditos = 40;
                }
            }


            const codigoAfiliadoNormalizado =
                normalizarCodigoAfiliado(
                    afiliado_codigo
                );

            const afiliadoValido =
                codigoAfiliadoNormalizado &&
                afiliados[codigoAfiliadoNormalizado] &&
                afiliados[codigoAfiliadoNormalizado].status === 'ativo'
                    ? codigoAfiliadoNormalizado
                    : null;


            const valorNumerico =
                Number(valor);


            if (
                !Number.isFinite(
                    valorNumerico
                ) ||
                valorNumerico <= 0
            ) {

                return res.status(400).json({

                    success: false,

                    error:
                        'Valor do pagamento inválido.'
                });
            }


            if (
                !Number.isInteger(
                    qtdCreditos
                ) ||
                qtdCreditos <= 0
            ) {

                return res.status(400).json({

                    success: false,

                    error:
                        'Quantidade de créditos inválida.'
                });
            }


            const idempotencyKey =
                `pix_${Date.now()}_${Math.random()
                    .toString(36)
                    .slice(2, 12)}`;


            const body = {

                transaction_amount:
                    Number(
                        valorNumerico.toFixed(2)
                    ),

                description:
                    `Radar Facial - ${
                        plano ||
                        'Pacote de Créditos'
                    }`,

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
                        plano ||
                        'Pacote de Créditos',

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


            transacoes[
                String(result.id)
            ] = {

                status:
                    result.status ||
                    'pending',

                status_detail:
                    result.status_detail ||
                    null,

                email:
                    emailNormalizado,

                buscas_restantes:
                    qtdCreditos,

                criado_em:
                    new Date()
                        .toISOString(),

                credited:
                    false,

                idempotency_key:
                    idempotencyKey,

                afiliado_codigo:
                    afiliadoValido,

                valor_pago:
                    Number(valorNumerico.toFixed(2))
            };


            salvarDadosPersistidos();


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
   VERIFICAR PIX
========================================================= */

app.post(
    '/api/verificar-pix',
    async (req, res) => {

        try {

            const {
                transaction_id
            } = req.body;


            if (!transaction_id) {

                return res.status(400).json({

                    success: false,

                    error:
                        'ID da transação não informado.'
                });
            }


            const transaction =
                transacoes[
                    String(transaction_id)
                ];


            if (!transaction) {

                return res.status(404).json({

                    success: false,

                    error:
                        'Transação não encontrada.'
                });
            }


            const mpCheck =
                await payment.get({

                    id:
                        String(
                            transaction_id
                        )
                });


            const currentStatus =
                mpCheck.status;


            transaction.status =
                currentStatus;

            transaction.status_detail =
                mpCheck.status_detail ||
                null;


            let pago = false;


            if (
                currentStatus ===
                'approved'
            ) {

                pago = true;


                if (
                    !transaction.credited
                ) {

                    const email =
                        transaction.email;

                    const quantidade =
                        Number(
                            transaction
                                .buscas_restantes ||
                            0
                        );


                    if (
                        email &&
                        quantidade > 0
                    ) {

                        const antes =
                            Number(
                                usuariosCreditos[
                                    email
                                ] || 0
                            );


                        usuariosCreditos[
                            email
                        ] =
                            antes +
                            quantidade;


                        transaction.credited =
                            true;


                        transaction.credited_em =
                            new Date()
                                .toISOString();


                        registrarComissaoSeNecessario(
                            transaction,
                            transaction_id,
                            mpCheck
                        );

                        salvarDadosPersistidos();
                    }
                }
            }


            const email =
                transaction.email;


            const saldo =
                email
                    ? Number(
                        usuariosCreditos[
                            email
                        ] || 0
                    )
                    : 0;


            return res.json({

                success: true,

                pago,

                status:
                    currentStatus,

                creditos:
                    saldo,

                transaction_id:
                    String(
                        transaction_id
                    )
            });


        } catch (error) {

            console.error(
                'Erro ao verificar PIX:',
                error.response?.data ||
                error.message
            );


            return res.status(500).json({

                success: false,

                error:
                    'Erro ao verificar pagamento.'
            });
        }
    }
);


/* =========================================================
   WEBHOOK MERCADO PAGO
========================================================= */

app.post(
    '/api/mercadopago-webhook',
    async (req, res) => {

        res.sendStatus(200);


        try {

            const queryData =
                req.query || {};

            const bodyData =
                req.body || {};


            let paymentId =

                queryData['data.id'] ||

                queryData.id ||

                bodyData.data?.id ||

                bodyData.id;


            if (!paymentId) {
                return;
            }


            const mpCheck =
                await payment.get({

                    id:
                        String(
                            paymentId
                        )
                });


            const currentStatus =
                mpCheck.status;


            const transaction =
                transacoes[
                    String(paymentId)
                ];


            if (!transaction) {
                return;
            }


            transaction.status =
                currentStatus;


            transaction.status_detail =
                mpCheck.status_detail ||
                null;


            if (
                currentStatus !==
                    'approved' ||
                transaction.credited
            ) {

                salvarDadosPersistidos();

                return;
            }


            const email =
                transaction.email;


            const quantidade =
                Number(
                    transaction
                        .buscas_restantes ||
                    0
                );


            if (
                !email ||
                quantidade <= 0
            ) {
                return;
            }


            const antes =
                Number(
                    usuariosCreditos[
                        email
                    ] || 0
                );


            usuariosCreditos[
                email
            ] =
                antes +
                quantidade;


            transaction.credited =
                true;


            transaction.credited_em =
                new Date()
                    .toISOString();


            registrarComissaoSeNecessario(
                transaction,
                paymentId,
                mpCheck
            );

            salvarDadosPersistidos();


        } catch (error) {

            console.error(
                '[WEBHOOK] Erro:',
                error.response?.data ||
                error.message ||
                error
            );
        }
    }
);


/* =========================================================
   DESCONTAR CRÉDITO
========================================================= */

app.post(
    '/api/descontar-credito',
    async (req, res) => {

        try {

            const {
                email
            } = req.body;


            if (!email) {

                return res.status(400).json({

                    success: false,

                    error:
                        'E-mail obrigatório.'
                });
            }


            const emailNormalizado =
                String(email)
                    .toLowerCase()
                    .trim();


            const saldo =
                Number(
                    usuariosCreditos[
                        emailNormalizado
                    ] || 0
                );


            if (saldo <= 0) {

                return res.status(403).json({

                    success: false,

                    error:
                        'Créditos esgotados.',

                    creditos:
                        0
                });
            }


            usuariosCreditos[
                emailNormalizado
            ] =
                saldo - 1;


            salvarDadosPersistidos();


            return res.json({

                success: true,

                creditos:
                    usuariosCreditos[
                        emailNormalizado
                    ]
            });


        } catch (error) {

            console.error(
                'Erro ao descontar crédito:',
                error.message
            );


            return res.status(500).json({

                success: false,

                error:
                    'Erro ao descontar crédito.'
            });
        }
    }
);


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


/* =========================================================
   SERVIDOR
========================================================= */

const PORT =
    process.env.PORT ||
    3000;


app.listen(
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
