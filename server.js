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
const usuariosCreditos = {};

// Sincronização de usuário e consulta de créditos reais na API do FaceCheck
app.post('/api/login-google', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) return res.status(400).json({ success: false, error: 'E-mail obrigatório.' });

        let creditosDisponiveis = 10; // Valor padrão inicial
        try {
            // Consulta opcional direta na API do FaceCheck para puxar créditos reais se suportado
            const checkRes = await axios.get('https://facecheck.id/api/v1/credits', {
                headers: { 'Authorization': `Bearer ${process.env.FACECK_API_KEY}` }
            });
            if (checkRes.data && checkRes.data.remaining_credits !== undefined) {
                creditosDisponiveis = checkRes.data.remaining_credits;
            }
        } catch (e) {
            // Se falhar a checagem externa, mantém o controle interno por usuário
        }

        if (usuariosCreditos[email] === undefined) {
            usuariosCreditos[email] = creditosDisponiveis;
        }

        res.json({ success: true, creditos: usuariosCreditos[email] });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Erro ao sincronizar usuário.' });
    }
});

// 1. Rota para gerar PIX Real
app.post('/api/criar-pix', async (req, res) => {
    try {
        const { valor, plano, email, creditos } = req.body;

        const body = {
            transaction_amount: Number(valor || 24.99),
            description: `Radar Facial - ${plano || 'Pacote de Buscas'}`,
            payment_method_id: 'pix',
            payer: { email: email || 'cliente@radar.com' }
        };

        const result = await payment.create({ body });
        const qtdCreditos = creditos || (plano === 'Pesquisa Única' ? 1 : (plano === 'Pacote Investigador' ? 10 : 40));

        transacoes[result.id] = {
            status: 'pending',
            email: email,
            buscas_restantes: qtdCreditos,
            criado_em: new Date()
        };

        res.json({
            success: true,
            transaction_id: result.id,
            qr_code: result.point_of_interaction?.transaction_data?.qr_code,
            qr_code_base64: result.point_of_interaction?.transaction_data?.qr_code_base64
        });
    } catch (error) {
        console.error('Erro ao gerar PIX:', error.response?.data || error.message);
        res.status(500).json({ success: false, error: 'Erro ao gerar o pagamento via PIX.' });
    }
});

// Verificação de pagamento PIX para atualizar o saldo do usuário
app.post('/api/verificar-pix', async (req, res) => {
    try {
        const { email, transaction_id } = req.body;
        let aprovado = false;

        if (transaction_id && transacoes[transaction_id]) {
            try {
                const mpCheck = await payment.get({ id: transaction_id });
                if (mpCheck.status === 'approved') {
                    transacoes[transaction_id].status = 'approved';
                    aprovado = true;
                }
            } catch (e) {}
        }

        // Liberação garantida para testes locais ou aprovação real
        if (aprovado || !transaction_id || transaction_id.startsWith('pix_')) {
            const qtdAdicionar = (transaction_id && transacoes[transaction_id]) ? transacoes[transaction_id].buscas_restantes : 1;
            usuariosCreditos[email] = (usuariosCreditos[email] || 0) + qtdAdicionar;
            return res.json({ success: true, pago: true, creditos: usuariosCreditos[email] });
        }

        res.json({ success: true, pago: false, creditos: usuariosCreditos[email] || 0 });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Erro ao verificar pagamento.' });
    }
});

// 2. Rota para Executar a Busca Facial Real via FaceCheck API
app.post('/api/escanear-rosto', upload.single('imagem'), async (req, res) => {
    try {
        const { email } = req.body;
        
        if (email && usuariosCreditos[email] !== undefined && usuariosCreditos[email] <= 0) {
            return res.status(403).json({ error: 'Créditos esgotados. Efetue o pagamento de um novo pacote.' });
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

        if (email && usuariosCreditos[email] !== undefined) {
            usuariosCreditos[email] -= 1;
        }

        res.json({
            sucesso: true,
            buscas_restantes: (email && usuariosCreditos[email] !== undefined) ? usuariosCreditos[email] : 9,
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