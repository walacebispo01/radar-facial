BEGIN;

ALTER TABLE public.cliques_afiliados
    ADD COLUMN IF NOT EXISTS dedupe_key text;

CREATE UNIQUE INDEX IF NOT EXISTS cliques_afiliados_dedupe_key_idx
    ON public.cliques_afiliados(dedupe_key);

COMMIT;
