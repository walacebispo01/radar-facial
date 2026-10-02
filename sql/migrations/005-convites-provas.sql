BEGIN;
CREATE TABLE IF NOT EXISTS public.criadores_convites (
 criador_id text PRIMARY KEY REFERENCES public.criadores(id),
 token text NOT NULL UNIQUE CHECK(length(token)=43), criado_em timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS public.criadores_candidaturas (
 id text PRIMARY KEY, email text NOT NULL UNIQUE REFERENCES public.usuarios(email), nome text NOT NULL,
 indicador_id text NOT NULL REFERENCES public.criadores(id),
 status text NOT NULL DEFAULT 'pendente' CHECK(status IN ('pendente','aprovado','recusado')),
 criador_id text REFERENCES public.criadores(id), decidido_por text, decidido_em timestamptz,
 criado_em timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS public.criadores_videos (
 id text PRIMARY KEY, criador_id text NOT NULL REFERENCES public.criadores(id), titulo text NOT NULL,
 url text NOT NULL CHECK(url LIKE 'https://%'), plataforma text NOT NULL,
 status text NOT NULL DEFAULT 'pendente' CHECK(status IN ('pendente','aprovado','recusado','removido')),
 destaque boolean NOT NULL DEFAULT false, posicao integer NOT NULL DEFAULT 0 CHECK(posicao>=0),
 versao integer NOT NULL DEFAULT 1, decidido_por text, decidido_em timestamptz,
 criado_em timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP, atualizado_em timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS criadores_videos_publicos ON public.criadores_videos(status,destaque,posicao,criado_em);
CREATE TABLE IF NOT EXISTS public.criadores_portal_auditoria (
 id text PRIMARY KEY, ator text NOT NULL, acao text NOT NULL, objeto_id text NOT NULL,
 dados jsonb NOT NULL DEFAULT '{}', criado_em timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
COMMIT;
