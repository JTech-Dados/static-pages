---
name: finalizar-commit
description: Confere tudo antes de commitar no static-pages — regras do RULES, segredos e dados reais, sintaxe dos scripts, testes E2E, critérios de aceite da spec, docs (ARCHITECTURE/README/MEMORY/TASKS) — e só então faz o commit no padrão do repo. Use sempre que for commitar ("commita", "sobe", "pode commitar", "finaliza").
---

# /finalizar-commit — checklist antes do commit

Não commite se algum item obrigatório falhar: explique o que falhou e pergunte como seguir.

## 1. O que entra

```bash
git status --short
git diff --stat
```
Liste os arquivos e confirme que só entra o que pertence à mudança.

## 2. Segredos e dados reais (obrigatório)

- Nenhum destes pode estar no stage: `.env`, `proxy/.env`, `backups/`, `*.db`, `auditoria.log`, `visitas.log`.
- Procure segredos e dados reais no que vai ser commitado:
  ```bash
  git diff --cached -U0 | grep -iE "password=.+|senha|token|secret|BEGIN .*PRIVATE|gh[op]_"
  ```
  Linhas de código que só *referenciam* variáveis (`FB_ADMIN_PASSWORD=` vazio, `$FB_ADMIN_PASSWORD`) são ok.
- Prints e textos não podem conter nomes reais de pastas/pessoas do servidor nem nome de empresa (RULES 2–3).

## 3. Sintaxe (obrigatório quando houver mudanças nesses arquivos)

```bash
for f in conf/*.sh; do sed 's/\r$//' "$f" | bash -n || echo "ERRO: $f"; done
node --check conf/times/times-tabs.js conf/times/inject.js
docker compose config -q
```
HTML com `<script>` grande editado por script: extraia e rode `node --check`.

## 4. Testes (obrigatório para mudança de comportamento)

```bash
docker compose up -d --build app            # imagem com a mudança
python -m pytest tests -q                   # local: BROWSER_CHANNEL=msedge
```
Mudou a home (`content/`)? É seed — copie para o container antes de testar:
`MSYS_NO_PATHCONV=1 docker cp content/index.html static-pages:/srv/index.html`.
Comportamento novo sem teste? Adicione em `tests/` (prefixo `zz-`, limpeza garantida).

## 5. Spec e critérios de aceite

Se existe spec em `specs/` para a mudança: confira **cada** critério, marque `[x]` e atualize Status/Andamento. Critério não atendido → não commitar.

## 6. Docs no mesmo commit

- Rota, peça ou fluxo mudou → `docs/ARCHITECTURE.md` (e README se afeta quem usa).
- Regra nova inegociável → `docs/RULES.md`.
- Bug, armadilha ou decisão não óbvia → `docs/MEMORY.md` (data + motivo).
- Tarefa concluída → mover para "Feito" em `docs/TASKS.md`; pendência nova → adicionar com prioridade e critério de pronto.

## 7. Commit

- Formato: `<tipo>: <descrição>` em português — `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`.
- Corpo: o **porquê** e os pontos principais (lista curta).
- **Sem linha de coautoria/atribuição.**
- Use HEREDOC para a mensagem. Não use `--no-verify`.
- Só faça `git push` se o usuário pediu. Depois do push, confira o CI uma vez (`gh run list --limit 1`) e informe o link — não suba para a VPS com o CI vermelho.

## 8. Resumo ao usuário

Diga o que foi commitado, o que foi verificado (testes, sintaxe, segredos) e o que **não** foi verificado.
