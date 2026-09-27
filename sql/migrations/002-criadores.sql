BEGIN;
CREATE TABLE public.criadores (
 id text PRIMARY KEY, email text NOT NULL UNIQUE REFERENCES public.usuarios(email),
 afiliado_codigo varchar(40) NOT NULL UNIQUE REFERENCES public.afiliados(codigo),
 nome text NOT NULL CHECK(length(btrim(nome)) BETWEEN 1 AND 100),
 parent_id text REFERENCES public.criadores(id), depth smallint NOT NULL CHECK(depth BETWEEN 1 AND 100),
 percentual numeric(5,2) NOT NULL CHECK(percentual BETWEEN 0 AND 30),
 status text NOT NULL DEFAULT 'ativo' CHECK(status IN ('ativo','suspenso')),
 demo_enabled boolean NOT NULL DEFAULT false,
 criado_em timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP, atualizado_em timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX criadores_parent_idx ON public.criadores(parent_id,criado_em,id);
CREATE FUNCTION public.proteger_arvore_criadores() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_depth integer;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.parent_id IS DISTINCT FROM OLD.parent_id OR NEW.depth<>OLD.depth OR NEW.email<>OLD.email OR NEW.afiliado_codigo<>OLD.afiliado_codigo OR NEW.id<>OLD.id THEN
   RAISE EXCEPTION 'Identidade e ascendencia imutaveis';
  END IF;
 ELSE
  IF NEW.parent_id IS NULL THEN
   IF NEW.depth<>1 THEN RAISE EXCEPTION 'Profundidade invalida'; END IF;
  ELSE
   SELECT depth INTO parent_depth FROM public.criadores WHERE id=NEW.parent_id;
   IF parent_depth IS NULL OR NEW.depth<>parent_depth+1 THEN RAISE EXCEPTION 'Ascendencia invalida'; END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER criadores_arvore BEFORE INSERT OR UPDATE ON public.criadores FOR EACH ROW EXECUTE FUNCTION public.proteger_arvore_criadores();
CREATE TABLE public.criadores_auditoria (
 id text PRIMARY KEY, criador_id text NOT NULL REFERENCES public.criadores(id), ator text NOT NULL,
 acao text NOT NULL, motivo text NOT NULL CHECK(length(btrim(motivo))>0),
 anterior jsonb, atual jsonb, criado_em timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX criadores_auditoria_idx ON public.criadores_auditoria(criador_id,criado_em DESC);
CREATE TABLE public.criadores_creditos (
 id text PRIMARY KEY, criador_id text NOT NULL REFERENCES public.criadores(id), quantidade integer NOT NULL CHECK(quantidade>0),
 saldo_depois bigint NOT NULL CHECK(saldo_depois>=0), motivo text NOT NULL CHECK(length(btrim(motivo))>0),
 ator text NOT NULL, idempotency_key text NOT NULL UNIQUE, criado_em timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE FUNCTION public.criadores_historico_imutavel() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Historico imutavel'; END $$;
CREATE TRIGGER criadores_auditoria_imutavel BEFORE UPDATE OR DELETE ON public.criadores_auditoria FOR EACH ROW EXECUTE FUNCTION public.criadores_historico_imutavel();
CREATE TRIGGER criadores_creditos_imutavel BEFORE UPDATE OR DELETE ON public.criadores_creditos FOR EACH ROW EXECUTE FUNCTION public.criadores_historico_imutavel();
CREATE TABLE public.criadores_cenarios (
 id text PRIMARY KEY, criador_id text NOT NULL REFERENCES public.criadores(id), nome text NOT NULL CHECK(length(btrim(nome)) BETWEEN 1 AND 100),
 links jsonb NOT NULL CHECK(jsonb_typeof(links)='array' AND jsonb_array_length(links) BETWEEN 1 AND 20),
 criado_em timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP, atualizado_em timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE public.criadores_simulacoes (
 id text PRIMARY KEY, criador_id text NOT NULL REFERENCES public.criadores(id), cenario_id text NOT NULL REFERENCES public.criadores_cenarios(id),
 itens jsonb NOT NULL, criado_em timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TRIGGER criadores_simulacoes_imutavel BEFORE UPDATE OR DELETE ON public.criadores_simulacoes FOR EACH ROW EXECUTE FUNCTION public.criadores_historico_imutavel();
CREATE TABLE public.programa_rate_limits (key text PRIMARY KEY,hits integer NOT NULL CHECK(hits>0),expires_at timestamptz NOT NULL);
CREATE TABLE public.admin_totp_usos (email text PRIMARY KEY,step bigint NOT NULL);
CREATE TABLE public.admin_stepup (session_hash bytea PRIMARY KEY CHECK(octet_length(session_hash)=32),email text NOT NULL,expires_at timestamptz NOT NULL);
COMMIT;
