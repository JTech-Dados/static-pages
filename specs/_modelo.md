# Spec: <título curto>

> Copie para `specs/AAAA-MM-DD-<slug>.md`. Escreva **antes** de mexer no código.
> Status: rascunho · aprovada · em andamento · concluída · descartada

**Status:** rascunho
**Pedido por:** <quem> · **Data:** AAAA-MM-DD

## Objetivo

O que muda para quem usa e por quê (1–3 frases). Liga a qual item do PRD/TASKS?

## Fora do escopo

O que esta spec **não** faz (evita crescer no meio do caminho).

## Como deve funcionar

Comportamento esperado, do ponto de vista de quem usa. Casos de borda (vazio, nomes com acento/maiúsculas, membro vs admin, arquivo grande, pasta inexistente).

## Onde mexe

- [ ] NGINX (`conf/nginx/`)
- [ ] Entrypoint / hooks (`conf/*.sh`)
- [ ] Painel: Times / inject / branding (`conf/times/`, `conf/branding/`)
- [ ] Site: home / 404 (`content/`) — lembrar que é seed
- [ ] Compose / Dockerfile / `.env.example`
- [ ] Testes (`tests/`)
- [ ] Docs: README · ARCHITECTURE · RULES · MEMORY · TASKS

## Critérios de aceite

Objetivos e testáveis. Cada um vira um teste ou uma verificação feita antes do commit.

- [ ] …
- [ ] Nenhuma regra do RULES quebrada (segurança, dados, LF, seed)
- [ ] `python -m pytest tests` verde
- [ ] Console do navegador sem erros nas telas afetadas

## Desenho técnico

(Preenchido pelo agente `tech-lead` ou por quem implementa: abordagem, alternativas descartadas, riscos.)

## Andamento

Registro para quem retomar (outra pessoa ou outra sessão).

- AAAA-MM-DD — …
