BEGIN;
CREATE TABLE public.simulacao_execucoes (
 id text PRIMARY KEY,
 usuario_email text NOT NULL CHECK(usuario_email=lower(btrim(usuario_email))),
 itens jsonb NOT NULL CHECK(jsonb_typeof(itens)='array' AND jsonb_array_length(itens) BETWEEN 0 AND 2),
 criado_em timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX simulacao_execucoes_usuario_idx ON public.simulacao_execucoes(usuario_email,criado_em DESC,id);
CREATE TRIGGER simulacao_execucoes_imutavel BEFORE UPDATE OR DELETE ON public.simulacao_execucoes FOR EACH ROW EXECUTE FUNCTION public.criadores_historico_imutavel();
COMMIT;
