CREATE TABLE public.sessoes (
    usuario_email text PRIMARY KEY
        REFERENCES public.usuarios(email),

    google_sub text NOT NULL,

    token_hash bytea NOT NULL UNIQUE
        CHECK (octet_length(token_hash) = 32),

    csrf_token bytea NOT NULL
        CHECK (octet_length(csrf_token) = 32),

    criado_em timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expira_em timestamptz NOT NULL,

    CONSTRAINT sessoes_expiracao_valida
        CHECK (expira_em > criado_em)
);

CREATE INDEX sessoes_expira_em_idx
    ON public.sessoes(expira_em);

CREATE TABLE public.buscas_faciais (
    id bigserial PRIMARY KEY,
    usuario_email text NOT NULL
        REFERENCES public.usuarios(email),
    idempotency_key text NOT NULL,
    status text NOT NULL
        CHECK (status IN ('processando', 'concluida', 'reembolsada')),
    resposta jsonb,
    criado_em timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    atualizado_em timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT buscas_faciais_idempotencia_unica
        UNIQUE (usuario_email, idempotency_key),
    CONSTRAINT buscas_faciais_chave_valida
        CHECK (length(idempotency_key) BETWEEN 1 AND 200),
    CONSTRAINT buscas_faciais_resposta_consistente
        CHECK ((status = 'concluida' AND resposta IS NOT NULL)
            OR (status <> 'concluida' AND resposta IS NULL))
);

CREATE INDEX buscas_faciais_processando_idx
    ON public.buscas_faciais(usuario_email, criado_em)
    WHERE status = 'processando';
