BEGIN;

CREATE TABLE public.simulacao_criadores (
    usuario_email text PRIMARY KEY REFERENCES public.usuarios(email) ON DELETE CASCADE,
    autorizado_por varchar(160) NOT NULL,
    criado_em timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT simulacao_autorizador_normalizado CHECK (autorizado_por = lower(btrim(autorizado_por)))
);

CREATE TABLE public.simulacao_links (
    usuario_email text NOT NULL REFERENCES public.simulacao_criadores(usuario_email) ON DELETE CASCADE,
    posicao smallint NOT NULL,
    url varchar(2048) NOT NULL,
    criado_em timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (usuario_email, posicao),
    UNIQUE (usuario_email, url),
    CONSTRAINT simulacao_links_limite CHECK (posicao BETWEEN 1 AND 2),
    CONSTRAINT simulacao_links_https CHECK (url LIKE 'https://%')
);

COMMIT;
