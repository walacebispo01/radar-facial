// Esta camada nunca cria tabelas: a migração é uma etapa externa e explícita.
function createSessionStore(pool) {
    function profile(row) {
        if (!row) return null;
        const creditos = Number(row.creditos);
        if (!Number.isSafeInteger(creditos)) throw new Error('Saldo fora do limite seguro.');
        return { email: row.usuario_email, sub: row.google_sub, creditos,
            csrfToken: Buffer.from(row.csrf_token).toString('base64url'), expiresAt: row.expira_em };
    }

    return {
        async create({ email, sub, tokenHash, csrfToken }) {
            const db = await pool.connect();
            let broken;
            try {
                await db.query('BEGIN');
                await db.query('INSERT INTO public.usuarios (email) VALUES ($1) ON CONFLICT (email) DO NOTHING', [email]);
                // PK usuario_email serializa logins concorrentes: só uma sessão permanece válida.
                await db.query(`INSERT INTO public.sessoes
                    (usuario_email, google_sub, token_hash, csrf_token, criado_em, expira_em)
                    VALUES ($1,$2,$3,$4,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP + INTERVAL '7 days')
                    ON CONFLICT (usuario_email) DO UPDATE SET google_sub = EXCLUDED.google_sub,
                    token_hash = EXCLUDED.token_hash, csrf_token = EXCLUDED.csrf_token,
                    criado_em = EXCLUDED.criado_em, expira_em = EXCLUDED.expira_em`,
                [email, sub, tokenHash, csrfToken]);
                const result = await db.query(`SELECT s.*, u.creditos FROM public.sessoes s
                    JOIN public.usuarios u ON u.email = s.usuario_email WHERE s.token_hash = $1`, [tokenHash]);
                const user = profile(result.rows[0]);
                await db.query('COMMIT');
                return user;
            } catch (error) {
                try { await db.query('ROLLBACK'); } catch (rollbackError) { broken = rollbackError; }
                // Não propagar mensagens do driver nem dados da sessão.
                throw new Error('Não foi possível persistir a sessão.');
            } finally { db.release(broken); }
        },

        async find(tokenHash) {
            const { rows } = await pool.query(`SELECT s.*, u.creditos FROM public.sessoes s
                JOIN public.usuarios u ON u.email = s.usuario_email
                WHERE s.token_hash = $1 AND s.expira_em > CURRENT_TIMESTAMP`, [tokenHash]);
            return profile(rows[0]);
        },

        async remove(tokenHash) {
            // Não excluir por e-mail: logout atrasado não deve apagar um login mais recente.
            await pool.query('DELETE FROM public.sessoes WHERE token_hash = $1', [tokenHash]);
        },
    };
}

module.exports = { createSessionStore };
