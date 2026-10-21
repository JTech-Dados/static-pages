# Contribuindo

Obrigado por ajudar. Este projeto roda em produção e guarda conteúdo de várias equipes, por isso o fluxo é deliberado.

## Antes de começar

Leia, nesta ordem: [PRD](docs/PRD.md) (o porquê), [ARCHITECTURE](docs/ARCHITECTURE.md) (como funciona), [RULES](docs/RULES.md) (o que não pode) e [MEMORY](docs/MEMORY.md) (o que já deu errado). Mudanças visuais seguem o [DESIGN.md](DESIGN.md).

## Fluxo

1. **Spec primeiro.** Copie [`specs/_modelo.md`](specs/_modelo.md) para `specs/AAAA-MM-DD-<slug>.md` e preencha objetivo, fora do escopo, onde mexe e **critérios de aceite testáveis**. Correções de 1 linha e textos dispensam spec.
2. **Branch** a partir da `main`: `feat/<slug>`, `fix/<slug>`, `docs/<slug>`.
3. **Implemente** e rode localmente:
   ```bash
   docker compose up -d --build app
   python -m pytest tests -v
   ```
4. **Comportamento novo tem teste** em `tests/` (prefixo `zz-`, com limpeza garantida).
5. **Docs no mesmo commit**: ARCHITECTURE se mudou rota ou fluxo, MEMORY se aprendeu algo não óbvio e TASKS ao concluir ou criar pendência.
6. **Pull request** com o checklist do template preenchido e o CI verde.

## Commits

`<tipo>: <descrição>` em português (`feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`). O corpo explica o **porquê**.

## Com o Claude Code

O repo já vem configurado em `.claude/`:

| Comando | O que faz |
|---|---|
| `/spec` | faz as perguntas certas e escreve a spec antes do código |
| agente `tech-lead` | lê a spec e a arquitetura e devolve o desenho técnico com os riscos |
| `/finalizar-commit` | confere regras, segredos, sintaxe, testes, critérios e docs, e só então commita |

## Nunca

- Commitar `.env`, `backups/`, bancos ou logs.
- Usar nomes reais de pessoas, pastas ou empresas em prints, testes ou docs.
- Subir para a VPS com o CI vermelho.

Detalhes em [RULES.md](docs/RULES.md).
