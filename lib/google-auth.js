const { OAuth2Client } = require('google-auth-library');

function createGoogleVerifier({ audience, client = new OAuth2Client() }) {
    if (!audience?.trim()) throw new Error('GOOGLE_CLIENT_ID é obrigatório para autenticação.');
    return async credential => {
        if (typeof credential !== 'string' || credential.length > 16384) return null;
        try {
            // A biblioteca verifica assinatura RSA, issuer, expiração e audience.
            const ticket = await client.verifyIdToken({ idToken: credential, audience: audience.trim() });
            const payload = ticket.getPayload();
            if (!payload?.sub || !payload.email || payload.email_verified !== true ||
                payload.aud !== audience.trim() ||
                !['accounts.google.com', 'https://accounts.google.com'].includes(payload.iss) ||
                !Number.isFinite(payload.exp) || payload.exp <= Date.now() / 1000) return null;
            return { sub: payload.sub, email: payload.email.toLowerCase().trim() };
        } catch (error) {
            // Erros de transporte não significam credencial revogada.
            if (error.code && ['ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN'].includes(error.code)) {
                throw new Error('Validação Google temporariamente indisponível.');
            }
            if (error.response?.status >= 500) throw new Error('Validação Google temporariamente indisponível.');
            return null;
        }
    };
}

module.exports = { createGoogleVerifier };
