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
const upload = multer({ storage: storage });

const client = new MercadoPagoConfig({
    accessToken: process.env.MERCADOPAGO_TOKEN || ''
});
const payment = new Payment(client);

const DATA_FILE = path.join(__dirname, 'data', 'radar-data.json');

function carregarDadosPersistidos() {
    try {
        if (!fs.existsSync(path.dirname(DATA_FILE))) {
            fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
        }
        if (fs.existsSync(DATA_FILE)) {
            const raw = fs.readFileSync(DATA_FILE, 'utf8');
            const parsed = JSON.parse(raw);
            return {
                transacoes: parsed.transacoes || {},
                usuariosCreditos: parsed.usuariosCreditos || {}
            };
        }
    } catch (e) {
        console.error("Erro ao carregar dados persistidos:", e.message);
    }
    return { transacoes: {}, usuariosCreditos: {} };
}

function salvarDadosPersistidos() {
    try {
        if (!fs.existsSync(path.dirname(DATA_FILE))) {
            fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
        }
        const dataToSave = {
            transacoes,
            usuariosCreditos
        };
        fs.writeFileSync(DATA_FILE, JSON.stringify(dataToSave, null, 2), 'utf8');
    } catch (e) {
        console.error("Erro ao salvar dados persistidos:", e.message);
    }
}

const dbStorage = carregarDadosPersistidos();
const transacoes = dbStorage.transacoes;
const usuariosCreditos = dbStorage.usuariosCreditos;

async function validarTokenGoogle(credential) {
    if (!credential) return null;
    try {
        const response = await axios.get(`https://oauth2.googleapis.com/tokeninfo?id_token=${credential}`, {
            timeout: 10000
        });
        const data = response.data;
        if (data && data.email && (data.email_verified === true || data.email_verified === 'true')) {
            if (process.env.GOOGLE_CLIENT_ID && data.aud !== process.env.GOOGLE_CLIENT_ID) {
                console.error("Google Client ID não confere com o token.");
                return null;
            }
            return data.email;
        }
    } catch (e) {
        console.error("Erro ao validar token Google:", e.message);
    }
    return null;
}

app.post('/api/login-google', async (req, res) => {
    try {
        const { email, credential } = req.body;
        let emailValidado = null;

        if (credential) {
            emailValidado = await validarTokenGoogle(credential);
        }

        if (!emailValidado && email) {
            emailValidado = email;
        }

        if (!emailValidado) {
            return res.status(400).json({ success: false, error: 'Autenticação Google inválida ou e-mail ausente.' });
        }

        if (usuariosCreditos[emailValidado] === undefined) {
            usuariosCreditos[emailValidado] = 0;
            salvarDadosPersistidos();
        }

        res.json({ success: true, creditos: usuariosCreditos[emailValidado] });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Erro ao sincronizar usuário.' });
    }
});

app.post('/api/criar-pix', async (req, res) => {
    try {
        const { valor, plano, email, creditos, idempotencyKey } = req.body;
        if (!email) {
            return res.status(400).json({ success: false, error: 'E-mail do usuário é obrigatório para gerar o PIX.' });
        }

        const qtdCreditos = creditos || (plano === 'Pesquisa Única' ? 1 : (plano === 'Pacote Investigador' ? 10 : 40));
        const valorNumerico = Number(valor || 24.99);

        const body = {
            transaction_amount: valorNumerico,
            description: `Radar Facial - ${plano || 'Pacote de Buscas'}`,
            payment_method_id: 'pix',
            payer: { email: email }
        };

        const requestOptions = {};
        if (idempotencyKey) {
            requestOptions.headers = { 'X-Idempotency-Key': idempotencyKey };
        }

        const result = await payment.create({ body, requestOptions });

        transacoes[result.id] = {
            status: result.status || 'pending',
            email: email,
            buscas_restantes: qtdCreditos,
            criado_em: new Date(),
            credited: false
        };
        salvarDadosPersistidos();

        console.log(`[PIX CRIADO] ID: ${result.id} | Email: ${email} | Créditos: ${qtdCreditos}`);

        res.json({
            success: true,
            transaction_id: result.id,
            qr_code: result.point_of_interaction?.transaction_data?.qr_code,
            qr_code_base64: result.point_of_interaction?.transaction_data?.qr_code_base64
        });
    } catch (error) {
        console.error('Erro ao criar PIX:', error.message);
        res.status(500).json({ success: false, error: 'Erro ao gerar o pagamento via PIX.' });
    }
});

app.post('/api/verificar-pix', async (req, res) => {
    try {
        const { email, transaction_id } = req.body;
        let aprovado = false;

        if (transaction_id && transacoes[transaction_id]) {
            try {
                const mpCheck = await payment.get({ id: transaction_id });
                const currentStatus = mpCheck.status;
                transacoes[transaction_id].status = currentStatus;

                console.log(`[VERIFICAR PIX] Transação ID: ${transaction_id} | Status MP: ${currentStatus} | Credited: ${transacoes[transaction_id].credited}`);

                if (currentStatus === 'approved' && !transacoes[transaction_id].credited) {
                    transacoes[transaction_id].credited = true;
                    const qtdAdicionar = transacoes[transaction_id].buscas_restantes || 0;
                    const targetEmail = transacoes[transaction_id].email || email;
                    if (targetEmail) {
                        const antes = usuariosCreditos[targetEmail] || 0;
                        console.log(`[CRÉDITO ADICIONADO - VERIFICAR PIX] Antes: ${antes} | Adicionando: ${qtdAdicionar}`);
                        usuariosCreditos[targetEmail] = antes + qtdAdicionar;
                        console.log(`[CRÉDITO ADICIONADO - VERIFICAR PIX] Depois: ${usuariosCreditos[targetEmail]}`);
                    }
                    aprovado = true;
                    salvarDadosPersistidos();
                } else if (currentStatus === 'approved' && transacoes[transaction_id].credited) {
                    aprovado = true;
                }
            } catch (e) {
                console.error('Erro ao consultar MP na verificação:', e.message);
            }
        }

        const userKey = email || (transaction_id && transacoes[transaction_id]?.email);
        const saldoAtual = userKey ? (usuariosCreditos[userKey] || 0) : 0;

        res.json({ success: true, pago: aprovado, creditos: saldoAtual });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Erro ao verificar pagamento.' });
    }
});

app.post('/api/mercadopago-webhook', async (req, res) => {
    try {
        const queryData = req.query;
        const bodyData = req.body;

        res.status(200).send('OK');

        let paymentId = null;
        if (queryData && (queryData['data.id'] || queryData.id)) {
            paymentId = queryData['data.id'] || queryData.id;
        } else if (bodyData) {
            if (bodyData.data && bodyData.data.id) {
                paymentId = bodyData.data.id;
            } else if (bodyData.id) {
                paymentId = bodyData.id;
            }
        }

        if (!paymentId) return;

        const mpCheck = await payment.get({ id: paymentId });
        const currentStatus = mpCheck.status;

        console.log(`[WEBHOOK] Payment ID: ${paymentId} | Status: ${currentStatus}`);

        if (transacoes[paymentId]) {
            transacoes[paymentId].status = currentStatus;
            if (currentStatus === 'approved' && !transacoes[paymentId].credited) {
                transacoes[paymentId].credited = true;
                const qtdAdicionar = transacoes[paymentId].buscas_restantes || 0;
                const targetEmail = transacoes[paymentId].email;
                if (targetEmail) {
                    const antes = usuariosCreditos[targetEmail] || 0;
                    console.log(`[CRÉDITO ADICIONADO - WEBHOOK] Antes: ${antes} | Adicionando: ${qtdAdicionar}`);
                    usuariosCreditos[targetEmail] = antes + qtdAdicionar;
                    console.log(`[CRÉDITO ADICIONADO - WEBHOOK] Depois: ${usuariosCreditos[targetEmail]}`);
                    salvarDadosPersistidos();
                }
            }
        } else {
            if (currentStatus === 'approved') {
                const payerEmail = mpCheck.payer?.email || mpCheck.metadata?.email;
                const externalRef = mpCheck.external_reference;
                const qtdAdicionar = Number(mpCheck.metadata?.creditos || externalRef || 1);
                if (payerEmail) {
                    if (!transacoes[paymentId] || !transacoes[paymentId].credited) {
                        transacoes[paymentId] = {
                            status: 'approved',
                            email: payerEmail,
                            buscas_restantes: qtdAdicionar,
                            criado_em: new Date(),
                            credited: true
                        };
                        const antes = usuariosCreditos[payerEmail] || 0;
                        console.log(`[CRÉDITO ADICIONADO - WEBHOOK NOVO] Antes: ${antes} | Adicionando: ${qtdAdicionar}`);
                        usuariosCreditos[payerEmail] = antes + qtdAdicionar;
                        console.log(`[CRÉDITO ADICIONADO - WEBHOOK NOVO] Depois: ${usuariosCreditos[payerEmail]}`);
                        salvarDadosPersistidos();
                    }
                }
            }
        }
    } catch (error) {
        console.error('Erro no processamento do webhook:', error.message);
    }
});

app.post('/api/descontar-credito', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) {
            return res.status(400).json({ success: false, error: 'E-mail obrigatório.' });
        }

        const saldoAtual = usuariosCreditos[email] || 0;
        console.log(`[CRÉDITO ANTES - DESCONTAR] Usuário: ${email} | Saldo: ${saldoAtual}`);
        
        if (saldoAtual > 0) {
            usuariosCreditos[email] = saldoAtual - 1;
            salvarDadosPersistidos();
            console.log(`[CRÉDITO DEPOIS - DESCONTAR] Usuário: ${email} | Saldo: ${usuariosCreditos[email]}`);
            return res.json({ success: true, creditos: usuariosCreditos[email] });
        } else {
            return res.status(403).json({ success: false, error: 'Créditos esgotados.' });
        }
    } catch (error) {
        console.error('Erro ao descontar crédito:', error.message);
        res.status(500).json({ success: false, error: 'Erro ao descontar crédito.' });
    }
});

app.post('/api/escanear-rosto', upload.single('imagem'), async (req, res) => {
    let creditosConsumidos = false;
    const { email } = req.body;
    const userKey = email;

    try {
        if (!userKey) {
            return res.status(400).json({ sucesso: false, error: 'E-mail do usuário não informado.' });
        }

        const saldoAntes = usuariosCreditos[userKey] || 0;
        console.log(`[CRÉDITO ANTES - ESCANEAR] Usuário: ${userKey} | Saldo: ${saldoAntes}`);

        if (saldoAntes < 1) {
            return res.status(403).json({ sucesso: false, error: 'Créditos do Radar Facial insuficientes.' });
        }

        usuariosCreditos[userKey] = saldoAntes - 1;
        creditosConsumidos = true;
        salvarDadosPersistidos();
        console.log(`[CRÉDITO DEPOIS - ESCANEAR] Usuário: ${userKey} | Saldo: ${usuariosCreditos[userKey]}`);

        if (!req.file) {
            if (creditosConsumidos) {
                usuariosCreditos[userKey] = (usuariosCreditos[userKey] || 0) + 1;
                salvarDadosPersistidos();
                console.log(`[CRÉDITO ESTORNADO - SEM IMAGEM] Saldo restaurado para: ${usuariosCreditos[userKey]}`);
            }
            return res.status(400).json({ sucesso: false, error: 'Nenhuma imagem enviada.' });
        }

        const formDataUpload = new FormData();
        formDataUpload.append('images', req.file.buffer, { 
            filename: 'rosto.jpg', 
            contentType: req.file.mimetype || 'image/jpeg' 
        });

        const uploadRes = await axios.post('https://facecheck.id/api/v1/upload_pic', formDataUpload, {
            headers: {
                ...formDataUpload.getHeaders(),
                'Authorization': process.env.FACECHECK_API_KEY
            },
            timeout: 30000
        });

        const idSearch = uploadRes.data.id_search || uploadRes.data.id;
        if (!idSearch) {
            return res.json({
                sucesso: true,
                buscas_restantes: usuariosCreditos[userKey] || 0,
                mensagem: 'Nenhum resultado encontrado.',
                perfis_encontrados: []
            });
        }

        let dadosRetorno = null;
        let tentativas = 0;
        const maxTentativas = 6;

        while (tentativas < maxTentativas) {
            await new Promise(resolve => setTimeout(resolve, 3000));
            try {
                const searchRes = await axios.post('https://facecheck.id/api/v1/search', {
                    id_search: idSearch,
                    id: idSearch,
                    testing_mode: false 
                }, {
                    headers: {
                        'Authorization': process.env.FACECHECK_API_KEY,
                        'Content-Type': 'application/json'
                    },
                    timeout: 15000
                });

                if (searchRes.data) {
                    dadosRetorno = searchRes.data;
                    const itemsList = dadosRetorno?.output?.items || dadosRetorno?.items || [];
                    if (itemsList.length > 0 || dadosRetorno.status === 'completed') {
                        break;
                    }
                }
            } catch (pollErr) {
                // Continua tentando em caso de instabilidade pontual no polling
            }
            tentativas++;
        }

        const itensBrutos = dadosRetorno?.output?.items || dadosRetorno?.items || dadosRetorno?.output || dadosRetorno?.results || [];

        const perfisMapeados = itensBrutos.map(item => {
            let urlFinal = item.url || item.link || item.profileUrl || item.weburl;
            if (!urlFinal && item.username) {
                urlFinal = `https://instagram.com/${item.username.replace('@', '')}`;
            }
            return {
                title: item.title || item.username || item.description || "Perfil Encontrado",
                url: urlFinal || "",
                score: item.score || item.similarity || 0,
                image: item.image || item.img || null
            };
        }).filter(item => item.url);

        res.json({
            sucesso: true,
            buscas_restantes: usuariosCreditos[userKey] || 0,
            mensagem: 'Escaneamento biométrico concluído com sucesso.',
            perfis_encontrados: perfisMapeados
        });

    } catch (error) {
        if (creditosConsumidos && userKey) {
            usuariosCreditos[userKey] = (usuariosCreditos[userKey] || 0) + 1;
            salvarDadosPersistidos();
            console.log(`[CRÉDITO ESTORNADO - ERRO API] Saldo restaurado para: ${usuariosCreditos[userKey]}`);
        }
        console.error('Erro detalhado FaceCheck:', error.response?.data || error.message);
        res.status(500).json({
            sucesso: false,
            error: 'Erro ao conectar com a API FaceCheck: ' + (error.response?.data?.error || error.message)
        });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Servidor Radar Facial rodando perfeitamente em: http://localhost:${PORT}`);
});