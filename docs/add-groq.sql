-- NovoT provedor de IA: Groq (API compatível com OpenAI Chat Completions).
-- Execute no Supabase Dashboard > SQL Editor. O backend (src/lib/ai.js) já
-- aceita 'groq' em CALLERS e src/routes/ias.js na lista PROVEDORES.
-- Depois, na ferramenta InstagramConfig: selecione groq, salve a API key
-- (fica criptografada em tbias.api_key_enc) e defina como em uso.

-- Cria a linha só se ainda não existir (idempotente).
insert into public.tbias (provedor, env_key, modelo, prioridade, max_tokens, ativo, em_uso, api_key_enc)
select 'groq', 'GROQ_API_KEY', 'llama-3.1-8b-instant', 5, 150, true, false, null
where not exists (select 1 from public.tbias where provedor = 'groq');

-- Modelos Groq válidos (JSON Object Mode suportado):
--   llama-3.3-70b-versatile  (mais capaz, 280 t/s)
--   llama-3.1-8b-instant     (mais rápido e barato, 560 t/s)
-- Troque o modelo a qualquer momento na ferramenta (campo "Modelo").

-- Verificação
-- select provedor, modelo, ativo, em_uso, (api_key_enc is not null) as tem_chave
-- from public.tbias order by prioridade;