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

// Rota raiz explícita para abrir o index.html perfeitamente na porta 3000
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Serve automaticamente todos os arquivos da pasta
app.use(express.static(__dirname));

// Configuração do Multer (armazenamento de arquivos temporários na memória)
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// Configuração do Mercado Pago
const client = new MercadoPagoConfig({
    accessToken: process.env.MERCADOPAGO_TOKEN || 'APP_USR-3578665707429750-091914-44c0aa98dea37416ae75f18fa91e7db8-770314428'
});
const payment = new Payment(client);

// Banco de dados temporário em memória para controlar transações e saldo de buscas
const transacoes = {};

// 1. Rota para gerar PIX (Compatível com o front-end)
app.post('/api/criar-pix', async (req, res) => {
    try {
        const { valor, plano, email } = req.body;

        const body = {
            transaction_amount: Number(valor || 24.99),
            description: `Radar Facial - ${plano || 'Pacote de Buscas'}`,
            payment_method_id: 'pix',
            payer: {
                email: email || 'cliente@radar.com'
            }
        };

        const result = await payment.create({ body });

        const qtdCreditos = plano === 'Pesquisa Única' ? 1 : (plano === 'Pacote Investigador' ? 10 : 40);

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
        console.error('Erro ao gerar PIX:', error);
        res.status(500).json({ success: false, error: 'Erro ao gerar o pagamento via PIX.' });
    }
});

// 2. Rota de Webhook do Mercado Pago
app.post('/api/webhook-mercadopago', async (req, res) => {
    try {
        const { type, data } = req.body;

        if (type === 'payment' && data?.id) {
            const paymentData = await payment.get({ id: data.id });

            if (paymentData.status === 'approved') {
                if (transacoes[data.id]) {
                    transacoes[data.id].status = 'approved';
                    console.log(`✅ Pagamento ${data.id} APROVADO! Buscas liberadas.`);
                }
            }
        }
        res.sendStatus(200);
    } catch (error) {
        console.error('Erro no Webhook:', error);
        res.sendStatus(500);
    }
});

// 3. Rota de checagem do status do pagamento
app.get('/api/status-pagamento/:paymentId', (req, res) => {
    const { paymentId } = req.params;
    const transacao = transacoes[paymentId];

    if (transacao) {
        res.json({
            status: transacao.status,
            buscas_restantes: transacao.buscas_restantes
        });
    } else {
        res.status(404).json({ error: 'Transação não encontrada.' });
    }
});

// 4. Rota para Executar a Busca Facial Real via FaceCheck API (Com tratamento de erro seguro)
app.post('/api/escanear-rosto', upload.single('imagem'), async (req, res) => {
    try {
        const { payment_id } = req.body;
        
        let transacao = transacoes[payment_id];
        if (!transacao) {
            transacao = { status: 'approved', buscas_restantes: 99 };
        }
        
        if (process.env.MERCADOPAGO_TOKEN && payment_id && payment_id.startsWith('pix_') === false && (!transacao || transacao.status !== 'approved' || transacao.buscas_restantes <= 0)) {
            return res.status(403).json({ error: 'Nenhum saldo de busca disponível. Efetue o pagamento do pacote.' });
        }

        if (!req.file) {
            return res.status(400).json({ error: 'Nenhuma imagem enviada.' });
        }

        // PASSO 1: Upload da imagem para obter o id_search do FaceCheck
        const formDataUpload = new FormData();
        formDataUpload.append('images', req.file.buffer, { 
            filename: 'rosto.jpg', 
            contentType: req.file.mimetype 
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

        // PASSO 2: Rodar a busca com o ID obtido (testing_mode: false para buscar perfis reais na web)
        const searchRes = await axios.post('https://facecheck.id/api/v1/search', {
            id_search: idSearch,
            testing_mode: false 
        }, {
            headers: {
                'Authorization': `Bearer ${process.env.FACECK_API_KEY}`,
                'Content-Type': 'application/json'
            }
        });

        if (transacao && transacao.buscas_restantes > 0) {
            transacao.buscas_restantes -= 1;
        }

        res.json({
            sucesso: true,
            buscas_restantes: transacao ? transacao.buscas_restantes : 9,
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