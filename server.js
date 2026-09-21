require('dotenv').config();

const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');
const { MercadoPagoConfig, Payment } = require('mercadopago');

const app = express();

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.use(express.static(__dirname));

const storage = multer.memoryStorage();
const upload = multer({ storage });

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
            fs.mkdirSync(pasta, { recursive: true });
        }

        if (!fs.existsSync(DATA_FILE)) {
            return {
                transacoes: {},
                usuariosCreditos: {}
            };
        }

        const raw = fs.readFileSync(DATA_FILE, 'utf8');

        if (!raw.trim()) {
            return {
                transacoes: {},
                usuariosCreditos: {}
            };
        }

        const parsed = JSON.parse(raw);

        return {
            transacoes: parsed.transacoes || {},
            usuariosCreditos: parsed.usuariosCreditos || {}
        };

    } catch (error) {
        console.error('Erro ao carregar dados persistidos:', error.message);
        return {
            transacoes: {},
            usuariosCreditos: {}
        };
    }
}

const dbStorage = carregarDadosPersistidos();

const transacoes = dbStorage.transacoes;
const usuariosCreditos = dbStorage.usuariosCreditos;

function salvarDadosPersistidos() {
    try {
        const pasta = path.dirname(DATA_FILE);

        if (!fs.existsSync(pasta)) {
            fs.mkdirSync(pasta, { recursive: true });
        }

        const data = {
            transacoes,
            usuariosCreditos
        };

        fs.writeFileSync(
            DATA_FILE,
            JSON.stringify(data, null, 2),
            'utf8'
        );

    } catch (error) {
        console.error('Erro ao salvar dados persistidos:', error.message);
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
            data.aud !== process.env.GOOGLE_CLIENT_ID
        ) {
            console.error('Google Client ID não confere com o token.');
            return null;
        }

        return data.email.toLowerCase().trim();

    } catch (error) {
        console.error('Erro ao validar token Google:', error.message);
        return null;
    }
}

/* =========================================================
   LOGIN GOOGLE
========================================================= */

app.post('/api/login-google', async (req, res) => {
    try {
        const { credential } = req.body;

        if (!credential) {
            return res.status(400).json({
                success: false,
                error: 'Token Google não informado.'
            });
        }

        const emailValidado = await validarTokenGoogle(credential);

        if (!emailValidado) {
            return res.status(401).json({
                success: false,
                error: 'Autenticação Google inválida.'
            });
        }

        if (usuariosCreditos[emailValidado] === undefined) {
            usuariosCreditos[emailValidado] = 0;
            salvarDadosPersistidos();
        }

        return res.json({
            success: true,
            email: emailValidado,
            creditos: usuariosCreditos[emailValidado]
        });

    } catch (error) {
        console.error('Erro no login Google:', error.message);

        return res.status(500).json({
            success: false,
            error: 'Erro ao sincronizar usuário.'
        });
    }
});

/* =========================================================
   CRIAR PIX
========================================================= */

app.post('/api/criar-pix', async (req, res) => {
    try {
        const {
            valor,
            plano,
            email,
            creditos
        } = req.body;

        if (!email) {
            return res.status(400).json({
                success: false,
                error: 'E-mail do usuário é obrigatório.'
            });
        }

        if (!process.env.MERCADOPAGO_TOKEN) {
            return res.status(500).json({
                success: false,
                error: 'Mercado Pago não configurado no servidor.'
            });
        }

        const emailNormalizado = String(email).toLowerCase().trim();

        let qtdCreditos = Number(creditos);

        if (!Number.isFinite(qtdCreditos)) {
            if (plano === 'Pesquisa Única') {
                qtdCreditos = 1;
            } else if (plano === 'Pacote Investigador') {
                qtdCreditos = 10;
            } else {
                qtdCreditos = 40;
            }
        }

        const valorNumerico = Number(valor);

        if (
            !Number.isFinite(valorNumerico) ||
            valorNumerico <= 0
        ) {
            return res.status(400).json({
                success: false,
                error: 'Valor do pagamento inválido.'
            });
        }

        if (
            !Number.isInteger(qtdCreditos) ||
            qtdCreditos <= 0
        ) {
            return res.status(400).json({
                success: false,
                error: 'Quantidade de créditos inválida.'
            });
        }

        const idempotencyKey =
            `pix_${Date.now()}_${Math.random()
                .toString(36)
                .slice(2, 12)}`;

        const body = {
            transaction_amount: Number(valorNumerico.toFixed(2)),
            description: `Radar Facial - ${plano || 'Pacote de Créditos'}`,
            payment_method_id: 'pix',
            payer: {
                email: emailNormalizado
            },
            metadata: {
                email: emailNormalizado,
                creditos: qtdCreditos,
                plano: plano || 'Pacote de Créditos'
            }
        };

        const result = await payment.create({
            body,
            requestOptions: {
                idempotencyKey
            }
        });

        if (!result || !result.id) {
            return res.status(502).json({
                success: false,
                error: 'Mercado Pago não retornou o ID do pagamento.'
            });
        }

        const transactionData =
            result.point_of_interaction?.transaction_data || {};

        const qrCode = transactionData.qr_code || null;
        const qrCodeBase64 = transactionData.qr_code_base64 || null;
        const ticketUrl = transactionData.ticket_url || null;

        transacoes[String(result.id)] = {
            status: result.status || 'pending',
            status_detail: result.status_detail || null,
            email: emailNormalizado,
            buscas_restantes: qtdCreditos,
            criado_em: new Date().toISOString(),
            credited: false,
            idempotency_key: idempotencyKey
        };

        salvarDadosPersistidos();

        if (
            !qrCode &&
            !qrCodeBase64 &&
            !ticketUrl
        ) {
            return res.status(502).json({
                success: false,
                error: 'O pagamento foi criado, mas o Mercado Pago não retornou o QR Code.',
                transaction_id: String(result.id)
            });
        }

        return res.json({
            success: true,
            transaction_id: String(result.id),
            status: result.status || 'pending',
            status_detail: result.status_detail || null,
            qr_code: qrCode,
            qr_code_base64: qrCodeBase64,
            ticket_url: ticketUrl,
            transaction_data: {
                qr_code: qrCode,
                qr_code_base64: qrCodeBase64,
                ticket_url: ticketUrl
            }
        });

    } catch (error) {
        console.error(
            'ERRO AO CRIAR PIX:',
            error.response?.data || error.message || error
        );

        return res.status(500).json({
            success: false,
            error:
                error.response?.data?.message ||
                error.response?.data?.error ||
                error.message ||
                'Erro ao gerar o pagamento via PIX.'
        });
    }
});

/* =========================================================
   VERIFICAR PIX
========================================================= */

app.post('/api/verificar-pix', async (req, res) => {
    try {
        const { transaction_id } = req.body;

        if (!transaction_id) {
            return res.status(400).json({
                success: false,
                error: 'ID da transação não informado.'
            });
        }

        const transaction = transacoes[String(transaction_id)];

        if (!transaction) {
            return res.status(404).json({
                success: false,
                error: 'Transação não encontrada.'
            });
        }

        const mpCheck = await payment.get({
            id: String(transaction_id)
        });

        const currentStatus = mpCheck.status;

        transaction.status = currentStatus;
        transaction.status_detail = mpCheck.status_detail || null;

        let pago = false;

        if (currentStatus === 'approved') {
            pago = true;

            if (!transaction.credited) {
                const email = transaction.email;
                const quantidade = Number(transaction.buscas_restantes || 0);

                if (email && quantidade > 0) {
                    const antes = Number(usuariosCreditos[email] || 0);
                    usuariosCreditos[email] = antes + quantidade;
                    transaction.credited = true;
                    transaction.credited_em = new Date().toISOString();
                    salvarDadosPersistidos();
                }
            }
        }

        const email = transaction.email;
        const saldo = email ? Number(usuariosCreditos[email] || 0) : 0;

        return res.json({
            success: true,
            pago,
            status: currentStatus,
            creditos: saldo,
            transaction_id: String(transaction_id)
        });

    } catch (error) {
        console.error(
            'Erro ao verificar PIX:',
            error.response?.data || error.message
        );

        return res.status(500).json({
            success: false,
            error: 'Erro ao verificar pagamento.'
        });
    }
});

/* =========================================================
   WEBHOOK MERCADO PAGO
========================================================= */

app.post('/api/mercadopago-webhook', async (req, res) => {
    res.sendStatus(200);

    try {
        const queryData = req.query || {};
        const bodyData = req.body || {};

        let paymentId =
            queryData['data.id'] ||
            queryData.id ||
            bodyData.data?.id ||
            bodyData.id;

        if (!paymentId) return;

        const mpCheck = await payment.get({
            id: String(paymentId)
        });

        const currentStatus = mpCheck.status;
        const transaction = transacoes[String(paymentId)];

        if (!transaction) return;

        transaction.status = currentStatus;
        transaction.status_detail = mpCheck.status_detail || null;

        if (
            currentStatus !== 'approved' ||
            transaction.credited
        ) {
            salvarDadosPersistidos();
            return;
        }

        const email = transaction.email;
        const quantidade = Number(transaction.buscas_restantes || 0);

        if (!email || quantidade <= 0) return;

        const antes = Number(usuariosCreditos[email] || 0);
        usuariosCreditos[email] = antes + quantidade;
        transaction.credited = true;
        transaction.credited_em = new Date().toISOString();

        salvarDadosPersistidos();

    } catch (error) {
        console.error(
            '[WEBHOOK] Erro:',
            error.response?.data || error.message || error
        );
    }
});

/* =========================================================
   DESCONTAR CRÉDITO
========================================================= */

app.post('/api/descontar-credito', async (req, res) => {
    try {
        const { email } = req.body;

        if (!email) {
            return res.status(400).json({
                success: false,
                error: 'E-mail obrigatório.'
            });
        }

        const emailNormalizado = String(email).toLowerCase().trim();
        const saldo = Number(usuariosCreditos[emailNormalizado] || 0);

        if (saldo <= 0) {
            return res.status(403).json({
                success: false,
                error: 'Créditos esgotados.',
                creditos: 0
            });
        }

        usuariosCreditos[emailNormalizado] = saldo - 1;
        salvarDadosPersistidos();

        return res.json({
            success: true,
            creditos: usuariosCreditos[emailNormalizado]
        });

    } catch (error) {
        console.error('Erro ao descontar crédito:', error.message);

        return res.status(500).json({
            success: false,
            error: 'Erro ao descontar crédito.'
        });
    }
});

/* =========================================================
   PROCESSAMENTO DE IMAGEM (FACECHECK API REAL)
========================================================= */

app.post(
    '/api/escanear-rosto',
    upload.single('imagem'),
    async (req, res) => {
        try {
            if (!req.file) {
                return res.status(400).json({
                    success: false,
                    error: 'Nenhuma imagem enviada.'
                });
            }

            if (!process.env.FACECHECK_API_KEY) {
                return res.status(500).json({
                    success: false,
                    error: 'Chave da API do FaceCheck não configurada no servidor.'
                });
            }

            const uploadForm = new FormData();
            uploadForm.append('images_file', req.file.buffer, {
                filename: req.file.originalname || 'rosto.jpg',
                contentType: req.file.mimetype || 'image/jpeg'
            });

            console.log('[FACECHECK] Enviando imagem para upload na API...');

            const uploadRes = await axios.post(
                'https://facecheck.id/api/v1/upload_pix',
                uploadForm,
                {
                    headers: {
                        ...uploadForm.getHeaders(),
                        'Authorization': `Bearer ${process.env.FACECHECK_API_KEY}`
                    },
                    timeout: 30000
                }
            );

            const idSearch = uploadRes.data.id_search || uploadRes.data.id;

            if (!idSearch) {
                return res.status(502).json({
                    success: false,
                    error: 'FaceCheck não retornou o identificador da busca.'
                });
            }

            console.log(`[FACECHECK] ID gerado: ${idSearch}. Consultando resultados...`);

            const searchRes = await axios.post(
                'https://facecheck.id/api/v1/search',
                { id_search: idSearch },
                {
                    headers: {
                        'Authorization': `Bearer ${process.env.FACECHECK_API_KEY}`,
                        'Content-Type': 'application/json'
                    },
                    timeout: 45000
                }
            );

            return res.json({
                success: true,
                message: 'Busca biométrica realizada com sucesso!',
                resultados: searchRes.data
            });

        } catch (error) {
            console.error(
                'Erro na API FaceCheck:',
                error.response?.data || error.message
            );

            return res.status(500).json({
                success: false,
                error: error.response?.data?.error || 'Erro ao processar a busca no FaceCheck.'
            });
        }
    }
);

/* =========================================================
   ROTA DE TESTE
========================================================= */

app.get('/api/status', (req, res) => {
    res.json({
        success: true,
        servidor: 'online',
        mercado_pago: Boolean(process.env.MERCADOPAGO_TOKEN),
        google: Boolean(process.env.GOOGLE_CLIENT_ID),
        facecheck: Boolean(process.env.FACECHECK_API_KEY)
    });
});

/* =========================================================
   SERVIDOR
========================================================= */

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log('==========================================');
    console.log(`🚀 Servidor rodando em http://localhost:${PORT}`);
    console.log(`💳 Mercado Pago: ${process.env.MERCADOPAGO_TOKEN ? 'CONFIGURADO' : 'NÃO CONFIGURADO'}`);
    console.log(`🔐 Google: ${process.env.GOOGLE_CLIENT_ID ? 'CONFIGURADO' : 'NÃO CONFIGURADO'}`);
    console.log(`🔍 FaceCheck: ${process.env.FACECHECK_API_KEY ? 'CONFIGURADO' : 'NÃO CONFIGURADO'}`);
    console.log('==========================================');
});