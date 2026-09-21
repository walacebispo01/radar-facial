require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');
const path = require('path');
const { MercadoPagoConfig, Payment } = require('mercadopago');

const app = express();
app.use(cors());
app.use(express.json());

// Rota raiz explícita para abrir o index.html na porta 3000
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Serve automaticamente todos os arquivos da pasta
app.use(express.static(__dirname));

// Configuração do Multer (armazena o ficheiro temporariamente na memória RAM)
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// Configuração do Mercado Pago
const client = new MercadoPagoConfig({
    accessToken: process.env.MERCADOPAGO_TOKEN || 'APP_USR-3578665707429750-091914-44c0aa98dea37416ae75f18fa91e7db8-770314428'
});
const payment = new Payment(client);

// Base de dados temporária em memória estrita
const transacoes = {};

// 1. Rota para gerar PIX Real
app.post('/api/criar-pix', async (req, res) => {
    try {
        const { valor, plano, email } = req.body;

        const body = {
            transaction_amount: Number(valor || 24.99),
            description: `Radar Facial - ${plano || 'Pacote de Buscas'}`,
            payment_method_id: 'pix',
            payer: { email: email || 'cliente@radar.com' }
        };

        const result = await payment.create({ body });
        const qtdCreditos = plano === 'Pesquisa Única' ? 1 : (plano === 'Pacote Investigador' ? 10 : 40);

        // Registo estrito da transação pendente
        transacoes[result.id] = {
            status: 'pending',
            buscas_restantes: qtdCreditos,
            criado_em: new Date()
        };

        res.json({
            success: true,
            payment_id: result.id,
            qr_code: result.point_of_interaction?.transaction_data?.qr_code,
            qr_code_base64: result.point_of_interaction?.transaction_data?.qr_code_base64
        });
    } catch (error) {
        console.error('Erro ao gerar PIX:', error.response?.data || error.message);
        res.status(500).json({ success: false, error: 'Erro ao gerar o pagamento via PIX.' });
    }
});

// 2. Rota de Webhook do Mercado Pago
app.post('/api/webhook-mercadopago', async (req, res) => {
    try {
        const { type, data } = req.body;

        if (type === 'payment' && data?.id) {
            const paymentData = await payment.get({ id: data.id });

            if (paymentData.status === 'approved' && transacoes[data.id]) {
                transacoes[data.id].status = 'approved';
                console.log(`✅ Pagamento ${data.id} APROVADO! Buscas liberadas com sucesso.`);
            }
        }
        res.sendStatus(200);
    } catch (error) {
        console.error('Erro no Webhook:', error);
        res.sendStatus(500);
    }
});

// 3. Rota de verificação do status do pagamento
app.get('/api/status-pagamento/:paymentId', async (req, res) => {
    try {
        const { paymentId } = req.params;
        let transacao = transacoes[paymentId];

        // Consulta também direto na API do Mercado Pago para garantir aprovação imediata se já foi pago
        if (paymentId && !paymentId.startsWith('pix_')) {
            try {
                const mpCheck = await payment.get({ id: paymentId });
                if (mpCheck.status === 'approved') {
                    if (!transacao) {
                        transacao = { status: 'approved', buscas_restantes: 1 };
                        transacoes[paymentId] = transacao;
                    } else {
                        transacao.status = 'approved';
                    }
                }
            } catch (e) {
                // Ignora erro de consulta se o ID for inválido/simulado
            }
        }

        if (transacao) {
            res.json({
                status: transacao.status,
                buscas_restantes: transacao.buscas_restantes
            });
        } else {
            res.status(404).json({ error: 'Transação não encontrada.' });
        }
    } catch (err) {
        res.status(500).json({ error: 'Erro ao verificar pagamento.' });
    }
});

// 4. Rota para Executar a Busca Facial Real via FaceCheck API (Estrita e sem fallbacks falsos)
app.post('/api/escanear-rosto', upload.single('imagem'), async (req, res) => {
    try {
        const { payment_id } = req.body;
        
        let transacao = transacoes[payment_id];

        // Se o pagamento não existir ou não estiver aprovado, bloqueia estritamente
        if (!transacao || transacao.status !== 'approved' || transacao.buscas_restantes <= 0) {
            return res.status(403).json({ error: 'Pagamento não confirmado ou créditos esgotados. Efetue o pagamento via PIX para realizar a busca.' });
        }

        if (!req.file) {
            return res.status(400).json({ error: 'Nenhuma imagem enviada.' });
        }

        // PASSO 1: Envia a imagem real para a API do FaceCheck obter o id_search
        const formDataUpload = new FormData();
        formDataUpload.append('images', req.file.buffer, { 
            filename: 'rosto.jpg', 
            contentType: req.file.mimetype || 'image/jpeg' 
        });

        const uploadRes = await axios.post('https://facecheck.id/api/v1/upload_pic', formDataUpload, {
            headers: {
                ...formDataUpload.getHeaders(),
                'Authorization': `Bearer ${process.env.FACECK_API_KEY}`
            }
        });

        const idSearch = uploadRes.data.id_search;
        if (!idSearch) {
            return res.status(500).json({ error: 'Erro ao gerar ID de busca na API facial.' });
        }

        // PASSO 2: Executa a varredura real na internet (testing_mode: false obrigatório)
        const searchRes = await axios.post('https://facecheck.id/api/v1/search', {
            id_search: idSearch,
            testing_mode: false 
        }, {
            headers: {
                'Authorization': `Bearer ${process.env.FACECK_API_KEY}`,
                'Content-Type': 'application/json'
            }
        });

        // Deduz estritamente 1 crédito após o sucesso da busca real
        transacao.buscas_restantes -= 1;

        res.json({
            sucesso: true,
            buscas_restantes: transacao.buscas_restantes,
            mensagem: 'Escaneamento biométrico executado com sucesso.',
            perfis_encontrados: searchRes.data.output?.items || []
        });

    } catch (error) {
        const erroDetalhado = error.response ? (error.response.data || error.response.statusText) : error.message;
        console.error('Erro detalhado FaceCheck:', erroDetalhado);
        res.status(500).json({ error: 'Falha ao processar escaneamento biométrico na API externa.', detalhes: erroDetalhado });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Servidor Radar Facial rodando perfeitamente em: http://localhost:${PORT}`);
});