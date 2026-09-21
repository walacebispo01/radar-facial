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

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.use(express.static(__dirname));

const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

const client = new MercadoPagoConfig({
    accessToken: process.env.MERCADOPAGO_TOKEN || 'APP_USR-3578665707429750-091914-44c0aa98dea37416ae75f18fa91e7db8-770314428'
});
const payment = new Payment(client);

const transacoes = {};
const usuariosCreditos = {};

async function consultarCreditosFaceCheck() {
    try {
        const checkRes = await axios.get('https://facecheck.id/api/v1/credits', {
            headers: { 'Authorization': process.env.FACECHECK_API_KEY }
        });
        if (checkRes.data && checkRes.data.remaining_credits !== undefined) {
            return checkRes.data.remaining_credits;
        }
    } catch (e) {
        console.error("Erro ao consultar créditos FaceCheck:", e.message);
    }
    return null;
}

app.post('/api/login-google', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) return res.status(400).json({ success: false, error: 'E-mail obrigatório.' });

        let creditosDisponiveis = await consultarCreditosFaceCheck();
        if (creditosDisponiveis === null) {
            creditosDisponiveis = usuariosCreditos[email] !== undefined ? usuariosCreditos[email] : 100;
        }

        usuariosCreditos[email] = creditosDisponiveis;
        res.json({ success: true, creditos: creditosDisponiveis });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Erro ao sincronizar usuário.' });
    }
});

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
                if (mpCheck.status === 'approved') {
                    transacoes[transaction_id].status = 'approved';
                    aprovado = true;
                }
            } catch (e) {}
        }

        if (aprovado) {
            const qtdAdicionar = transacoes[transaction_id].buscas_restantes;
            usuariosCreditos[email] = (usuariosCreditos[email] || 0) + qtdAdicionar;
            return res.json({ success: true, pago: true, creditos: usuariosCreditos[email] });
        }

        res.json({ success: true, pago: false, creditos: usuariosCreditos[email] || 0 });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Erro ao verificar pagamento.' });
    }
});

app.post('/api/descontar-credito', async (req, res) => {
    try {
        const { email } = req.body;
        const userKey = email || 'walacegab1998@gmail.com';

        let saldoApi = await consultarCreditosFaceCheck();
        if (saldoApi !== null) {
            usuariosCreditos[userKey] = saldoApi;
        }

        if (usuariosCreditos[userKey] > 0) {
            usuariosCreditos[userKey] -= 1;
            return res.json({ success: true, creditos: usuariosCreditos[userKey] });
        } else {
            return res.status(403).json({ success: false, error: 'Créditos esgotados.' });
        }
    } catch (error) {
        res.status(500).json({ success: false, error: 'Erro ao descontar crédito.' });
    }
});

app.post('/api/escanear-rosto', upload.single('imagem'), async (req, res) => {
    try {
        const { email } = req.body;
        const userKey = email || 'walacegab1998@gmail.com';
        
        if (!req.file) {
            return res.status(400).json({ error: 'Nenhuma imagem enviada.' });
        }

        const formDataUpload = new FormData();
        formDataUpload.append('images', req.file.buffer, { 
            filename: 'rosto.jpg', 
            contentType: req.file.mimetype || 'image/jpeg' 
        });
        formDataUpload.append('id_search', '');

        // 1. UPLOAD DA FOTO NA API FACECHECK
        const uploadRes = await axios.post('https://facecheck.id/api/v1/upload_pic', formDataUpload, {
            headers: {
                ...formDataUpload.getHeaders(),
                'Authorization': process.env.FACECHECK_API_KEY
            }
        });

        const idSearch = uploadRes.data.id_search || uploadRes.data.id;
        if (!idSearch) {
            return.json({
                sucesso: false,
                mensagem: 'Falha ao processar imagem na API FaceCheck.',
                perfis_encontrados: []
            });
        }

        // 2. DISPARAR A BUSCA REAL (ATENÇÃO: testing_mode: false obrigatoriamente para descontar e achar rostos reais)
        const searchRes = await axios.post('https://facecheck.id/api/v1/search', {
            id_search: idSearch,
            id: idSearch,
            status: "completed",
            testing_mode: false 
        }, {
            headers: {
                'Authorization': process.env.FACECHECK_API_KEY,
                'Content-Type': 'application/json'
            },
            timeout: 45000
        });

        const dadosRetorno = searchRes.data;
        const itensBrutos = dadosRetorno.output?.items || dadosRetorno.items || dadosRetorno.output || dadosRetorno.results || [];

        const perfisMapeados = itensBrutos.map(item => {
            let urlFinal = item.url || item.link || item.profileUrl || item.weburl;
            if (!urlFinal && item.username) {
                urlFinal = `https://instagram.com/${item.username.replace('@', '')}`;
            }
            if (!urlFinal) {
                urlFinal = "https://instagram.com";
            }

            return {
                title: item.title || item.username || item.description || "Perfil Encontrado",
                url: urlFinal,
                score: item.score || item.similarity || 0.98,
                image: item.image || item.img || null
            };
        });

        let saldoAtualizado = await consultarCreditosFaceCheck();
        if (saldoAtualizado !== null) {
            usuariosCreditos[userKey] = saldoAtualizado;
        }

        res.json({
            sucesso: true,
            buscas_restantes: usuariosCreditos[userKey] || 99,
            mensagem: 'Escaneamento biométrico executado com sucesso.',
            perfis_encontrados: perfisMapeados
        });

    } catch (error) {
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