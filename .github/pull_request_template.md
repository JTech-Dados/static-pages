## O que muda

<!-- 1–3 frases: o que muda para quem usa e por quê -->

**Spec:** `specs/AAAA-MM-DD-<slug>.md` <!-- ou "não se aplica (correção de 1 linha / texto)" -->

## Checklist

- [ ] Critérios de aceite da spec conferidos e marcados
- [ ] `python -m pytest tests` verde localmente (e CI verde)
- [ ] Comportamento novo tem teste em `tests/`
- [ ] Nenhuma regra do [RULES](../docs/RULES.md) quebrada (segredos, CSP/CORS, dotfiles, seed, LF)
- [ ] Sem `.env`, backups, bancos, logs ou dados reais (prints com dados fictícios)
- [ ] Docs atualizados: ARCHITECTURE · README · MEMORY · TASKS (o que se aplica)

## Como testar

<!-- passos para quem revisa conferir na prática -->
