---
name: spec
description: Escreve a spec de uma mudança no static-pages ANTES de mexer no código — faz as perguntas certas, define fora do escopo, onde mexe e critérios de aceite testáveis. Use quando o pedido for uma funcionalidade, mudança de comportamento ou ajuste que toque mais de um arquivo ("quero que…", "adiciona…", "muda…").
---

# /spec — alinhar antes de mexer

Objetivo: chegar ao formato certo **antes** do esforço. Mudar uma frase do plano é barato; refazer código é caro.

## Passos

1. **Ler o contexto**: `docs/PRD.md` (escopo), `docs/ARCHITECTURE.md` (onde mexe), `docs/RULES.md` (limites), `docs/MEMORY.md` (armadilhas já vistas) e `docs/TASKS.md` (se o pedido já existe lá).
2. **Perguntar só o que muda a solução** (no máximo 4 perguntas, com opção recomendada primeiro), por exemplo:
   - Quem usa: admin, membro de time ou visitante do site?
   - O que é "pronto" de forma verificável?
   - Casos de borda: pasta vazia, nome com acento/maiúscula, muitos itens, membro sem permissão.
   - Precisa valer para conteúdo que já existe no servidor (lembrar que `content/` é seed)?
   Não pergunte o que dá para descobrir lendo o código.
3. **Escrever a spec** em `specs/AAAA-MM-DD-<slug>.md` a partir de `specs/_modelo.md`:
   - Objetivo e **Fora do escopo** explícitos.
   - **Onde mexe**: marque as caixas (NGINX, hooks, painel, site, compose, testes, docs).
   - **Critérios de aceite** objetivos — cada um tem que poder virar teste em `tests/` ou checagem antes do commit.
   - Se a mudança tocar segurança (rotas, CORS, dotfiles, auth, conteúdo de upload no DOM), cite a regra do RULES correspondente.
4. **Mudança técnica não trivial?** Peça o desenho ao agente `tech-lead` e cole o resultado em "Desenho técnico".
5. Mostre a spec ao usuário e peça aprovação. Só então implemente. Atualize o status para `aprovada` / `em andamento`.
6. Durante o trabalho, registre decisões no bloco **Andamento** (quem retomar continua dali).

## Quando NÃO precisa de spec

Correção de uma linha, texto/copy, ajuste de documentação. Nesses casos vá direto e use `/finalizar-commit`.
