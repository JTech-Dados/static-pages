# static-pages — instruções para o Claude

Site estático (NGINX) + painel de arquivos (File Browser) em `/admin`, num container Docker. Times, lixeira, auditoria, visitas, cota por time e login Microsoft (opcional) são extensões nossas sobre o File Browser.

## Leia antes de mexer

| Documento | Responde | Quando ler |
|---|---|---|
| [docs/PRD.md](docs/PRD.md) | **por quê**: problema, público, fora do escopo | pedido novo ou dúvida de prioridade |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | **como funciona**: peças, fluxos, onde cada coisa mora | antes de qualquer mudança de código |
| [docs/RULES.md](docs/RULES.md) | **o que não pode**: regras inegociáveis | **sempre**, antes de editar e antes de commitar |
| [DESIGN.md](DESIGN.md) | **como deve parecer**: tokens, fontes, componentes | qualquer mudança visual |
| [docs/MEMORY.md](docs/MEMORY.md) | **o que já aprendemos**: decisões e erros, com data e motivo | antes de "consertar" algo que parece estranho |
| [docs/TASKS.md](docs/TASKS.md) | **o que falta**: backlog com prioridade e critério de pronto | ao terminar uma tarefa ou achar pendência |

## Como trabalhar aqui

1. **Toda modificação começa por uma spec** em `specs/` (use `/spec`). Mudar uma frase do plano é barato; refazer código é caro. Exceção: correção de 1 linha ou texto.
2. Mudança técnica não trivial → peça o desenho ao agente **tech-lead** (lê a spec + ARCHITECTURE e devolve plano e riscos).
3. Implemente, rode o app e os testes, confira cada critério de aceite da spec.
4. **Commit só via `/finalizar-commit`**: ele confere RULES, testes, critérios, docs e segredos antes de commitar.
5. Aprendeu algo não óbvio (bug, decisão, armadilha)? Registre em `docs/MEMORY.md` no mesmo commit.

## Comandos

```bash
docker compose up -d --build                      # sobe app + backup
docker compose logs -f app                        # logs
python -m pytest tests -v                         # testes E2E (usa FB_ADMIN_PASSWORD do .env)
node --test --test-force-exit tests/sp-auth.test.js   # unitários do sp-auth (login Microsoft, cota)
BROWSER_CHANNEL=msedge python -m pytest tests     # com o Edge instalado (sem baixar Chromium)
BROWSER_PATH=/caminho/chromium python -m pytest tests   # com um Chromium já instalado
docker compose exec app sp-visitas                # força a agregação de visitas
```

Arquivos em `content/` só entram num `/srv` vazio. Para testar uma mudança na home localmente:
`docker cp content/index.html static-pages:/srv/index.html`.

## Commits

- Formato: `<tipo>: <descrição>` em português (`feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`). Corpo explica o **porquê**.
- **Sem linha de coautoria/atribuição** (preferência do dono do repo).
- **Autor = e-mail noreply do GitHub**, nunca o corporativo (o repo é público). Confira com `git config user.email` antes do primeiro commit numa máquina nova.
- Nunca commitar `.env`, `proxy/.env`, `backups/`, `*.db` ou prints com dados reais.
- O CI (`.github/workflows/ci.yml`) roda a suíte a cada push; não suba para a VPS com ❌.

## Ambiente local (Windows, rede corporativa)

- O build precisa de `APK_HTTP=true` no `.env` local (inspeção SSL quebra o `apk` via https). Na VPS e no CI é `false`.
- No Git Bash, use `MSYS_NO_PATHCONV=1` antes de `docker exec`/`docker cp` com caminhos `/srv/...`.
- Não use `sed` para trocar texto com `&` ou `\n`/`\t` — prefira editar o arquivo direto (ver MEMORY).

## Prefixo (`SP_BASE`) e login Microsoft

- O app pode rodar sob um prefixo atrás de um proxy (`SP_BASE=/pages`; vazio = raiz, o padrão). O NGINX do container guarda o prefixo em `$sp_base` e o remove antes de escolher o `location` (ver ARCHITECTURE). **Não escreva caminho absoluto (`/admin`, `/_pastas`…) em HTML/JS novo**: derive o prefixo da URL ou use caminho relativo. Teste com os dois (`BASE_URL=http://localhost:8080` e, com `SP_BASE=/pages`, `…/pages`).
- Login Microsoft (Entra ID) **no painel** (`conf/entra/sp-auth.js` + `conf/times/entra-login.js`), desligado se `ENTRA_TENANT_ID`/`ENTRA_CLIENT_ID` estiverem vazios. Admin local continua só com usuário e senha. Entra **por site** não existe (adiado; ver `specs/2026-10-22-entra-por-site-ADIADA.md`). Testes: `tests/sp-auth.test.js` (unitários) e `tests/test_entra.py` (E2E com chaves de teste via `ENTRA_JWKS_FILE`).
