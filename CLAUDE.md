# static-pages — instruções para o Claude

Site estático (NGINX) + painel de arquivos (File Browser) em `/admin`, num container Docker. Times, lixeira, auditoria e visitas são extensões nossas sobre o File Browser.

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
BROWSER_CHANNEL=msedge python -m pytest tests     # com o Edge instalado (sem baixar Chromium)
docker compose exec app sp-visitas                # força a agregação de visitas
```

Arquivos em `content/` só entram num `/srv` vazio. Para testar uma mudança na home localmente:
`docker cp content/index.html static-pages:/srv/index.html`.

## Commits

- Formato: `<tipo>: <descrição>` em português (`feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`). Corpo explica o **porquê**.
- **Sem linha de coautoria/atribuição** (preferência do dono do repo).
- Nunca commitar `.env`, `proxy/.env`, `backups/`, `*.db` ou prints com dados reais.
- O CI (`.github/workflows/ci.yml`) roda a suíte a cada push; não suba para a VPS com ❌.

## Ambiente local (Windows, rede corporativa)

- O build precisa de `APK_HTTP=true` no `.env` local (inspeção SSL quebra o `apk` via https). Na VPS e no CI é `false`.
- No Git Bash, use `MSYS_NO_PATHCONV=1` antes de `docker exec`/`docker cp` com caminhos `/srv/...`.
- Não use `sed` para trocar texto com `&` ou `\n`/`\t` — prefira editar o arquivo direto (ver MEMORY).
