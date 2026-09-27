BEGIN;
ALTER TABLE public.transacoes ADD COLUMN criador_programa boolean NOT NULL DEFAULT false;
ALTER TABLE public.transacoes ADD COLUMN criador_snapshot jsonb;
CREATE TABLE public.comissoes_rede_eventos (
 id bigserial PRIMARY KEY, payment_id text NOT NULL REFERENCES public.transacoes(payment_id),
 evento_chave text NOT NULL UNIQUE, payload jsonb NOT NULL,
 status text NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','concluido')),
 tentativas integer NOT NULL DEFAULT 0, ultimo_erro text,
 criado_em timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX comissoes_rede_pendentes ON public.comissoes_rede_eventos(id) WHERE status='pendente';
CREATE INDEX comissoes_rede_eventos_pagamento ON public.comissoes_rede_eventos(payment_id);
CREATE TABLE public.comissoes_rede_lancamentos (
 id bigserial PRIMARY KEY, payment_id text NOT NULL REFERENCES public.transacoes(payment_id),
 criador_id text REFERENCES public.criadores(id), parcela text NOT NULL,
 tipo text NOT NULL CHECK (tipo IN ('comissao','estorno')),
 valor numeric(22,6) NOT NULL CHECK (valor>=0), evento_chave text NOT NULL,
 criado_em timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(payment_id, parcela, tipo, evento_chave)
);
CREATE INDEX comissoes_rede_criador ON public.comissoes_rede_lancamentos(criador_id,payment_id);
CREATE TABLE public.comissoes_rede_reembolsos (
 payment_id text NOT NULL REFERENCES public.transacoes(payment_id), refund_id text NOT NULL,
 valor numeric(22,6) NOT NULL CHECK(valor>=0), status text,
 criado_em timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(payment_id,refund_id)
);
CREATE FUNCTION public.proteger_comissao_rede() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Lançamentos de comissão são imutáveis'; END $$;
CREATE TRIGGER comissoes_rede_imutaveis BEFORE UPDATE OR DELETE ON public.comissoes_rede_lancamentos
 FOR EACH ROW EXECUTE FUNCTION public.proteger_comissao_rede();
CREATE FUNCTION public.proteger_snapshot_rede() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.criador_snapshot IS NOT NULL AND (NEW.criador_snapshot IS DISTINCT FROM OLD.criador_snapshot OR NEW.criador_programa IS DISTINCT FROM OLD.criador_programa)
 THEN RAISE EXCEPTION 'Snapshot de comissão é imutável'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER snapshot_rede_imutavel BEFORE UPDATE ON public.transacoes FOR EACH ROW EXECUTE FUNCTION public.proteger_snapshot_rede();
COMMIT;
