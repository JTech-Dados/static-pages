# Spec: tokens de API pessoais para automações

> Status: rascunho · aprovada · em andamento · concluída · descartada

**Status:** concluída em 2026-10-22 (fatias 1 a 4); falta só levar para o `static-pages` público
**Pedido por:** dono do projeto · **Data:** 2026-10-22

## Objetivo

Scripts e automações (por exemplo, um job que gera um HTML todo dia) publicarem e atualizarem páginas no Pages **sem abrir o painel**, chamando a API do File Browser **como a própria pessoa que criou o token**. Valem as regras de hoje: só escreve na pasta do time, o Leitor só consulta, a cota bloqueia, a autoria entra na Atividade e o que é apagado vai para a lixeira. Liga ao item "Tokens de API para automações" do TASKS. Nasce da spec do MCP, adiada (`specs/2026-10-22-mcp-publicar-pelo-chat-ADIADA.md`), cuja revisão técnica vale aqui.

## Fora do escopo

- MCP e extensão do Claude Desktop (adiados).
- Endpoint de publicação próprio ("PUT HTML aqui"): a automação usa a API do File Browser que já existe (duplicar autorização, cota e autoria seria pior).
- Token por time ou por página (o token herda o papel e o time da pessoa).
- Webhooks de entrada (alguém chamar o Pages sem token).
- Admin ver ou revogar tokens de outras pessoas pela tela (v1: cada um vê os seus; apagar o usuário já invalida os dele).
- Login Microsoft pelo token (é só uma credencial de máquina).

## Como deve funcionar

### Para quem automatiza

1. No painel, menu **Tokens de API** (aparece para usuário com `@`, **inclusive admin por e-mail**; o `admin` local, sem `@`, só entra por senha e não tem token) abre `api.html`. A pessoa cria um token com um **nome** ("Job de vendas") e uma **validade** (30, 90 ou 365 dias; padrão 90). O token (`sp_…`) aparece **uma única vez**. A lista mostra nome, criado em, expira em e último uso, com **Revogar**. Máximo 5 tokens ativos por pessoa.
2. A automação troca o token por uma sessão e usa a API do File Browser:

```bash
BASE=https://<domínio>/pages
JWT=$(curl -s -X POST "$BASE/admin/entra/api/sessao" -H 'Content-Type: application/json' \
      -d '{"token":"sp_..."}' | jq -r .jwt)
# publica (cria a pasta e o index.html; 409 se já existir, a menos que override=true)
curl -s -X POST "$BASE/admin/api/resources/relatorio-mensal/index.html?override=false" \
     -H "X-Auth: $JWT" -H 'Content-Type: text/html' --data-binary @relatorio.html
```

3. A página abre em `<BASE>/<time>/relatorio-mensal/` e aparece sozinha na home. O `/_ajuda/` ganha a seção **Automatizar com token de API** (token, as duas chamadas, atualizar sem perder a versão, aviso de visibilidade) e um script de exemplo em Python.

### Regras e bordas

- A sessão devolvida (`jwt`) é a do File Browser, com as **permissões e o escopo reais** do usuário: Editor escreve só em `/<time>`; Leitor lê e baixa, mas recebe 403 ao escrever; **Admin** enxerga e escreve em qualquer time (o caminho inclui o time: `/<time>/<nome>/index.html`).
- **O token nunca passa do papel que a pessoa tinha ao criá-lo.** O papel (Admin > Editor > Leitor) fica gravado no token; se o dono for **promovido** depois, a troca recusa (401) até gerar um token novo; se for **rebaixado**, a sessão já sai com o papel menor. Assim a automação de um Editor não vira admin sozinha.
- **Atualizar uma página:** `override=true` sobrescreve **sem lixeira** (RULES 12: o `before_delete` só atua em DELETE); a versão anterior só existe no backup diário. O guia recomenda, para quem quer histórico, `DELETE` do arquivo (vai para a lixeira por 30 dias) e depois o `POST`. A API não esconde isso.
- **Cota:** a cota só enxerga `Content-Length`; o `curl --data-binary` já manda. Clientes HTTP que usam `Transfer-Encoding: chunked` **não** passam pelo limite da cota no corpo (sem tamanho conhecido) e devem enviar `Content-Length`; o guia avisa e o NGINX recusa escrita sem `Content-Length` (411) nas rotas de escrita da API para fechar o furo.
- Token expirado, revogado, de usuário removido, ou de usuário que virou admin: `401` com `{"erro":"token_invalido"}` (mensagem única, tempo uniforme, sem dizer o motivo).
- O token **nunca** aparece em log (`docker logs`, `auditoria.log`, resposta de erro).
- Sem Entra ligado (`ENTRA_TENANT_ID`/`ENTRA_CLIENT_ID` vazios) o sp-auth responde 503 e o recurso fica desligado (as rotas dependem do mesmo mecanismo de troca de senha do login Microsoft).

## Onde mexe

- [x] NGINX (`conf/nginx/`): regex do limite `entra` passa a incluir `api/sessao`; exigir `Content-Length` nas escritas de `/admin/api/resources` e `/admin/api/tus` (411 sem ele)
- [ ] Entrypoint / hooks: sem mudança
- [x] Painel (`conf/times/`): item "Tokens de API" no menu (`inject.js`) e `api.html` (criar, listar, revogar)
- [ ] Site: home / 404 — sem mudança
- [x] sp-auth (`conf/entra/sp-auth.js`): store de tokens, rotas, mutex por usuário, `fb.loginAs`
- [ ] Compose / Dockerfile: `.env.example` ganha `API_TOKEN_MAX` (padrão 5) e `API_TOKEN_DIAS_PADRAO` (90) só se quisermos ajustar; sem mudança obrigatória
- [x] Testes (`tests/`)
- [x] Docs: README · ARCHITECTURE · RULES · MEMORY · TASKS · guia `/_ajuda/`

## Desenho proposto

(Reaproveita a revisão do tech-lead sobre a spec do MCP, 2026-10-22.)

**Armazenamento.** `/database/api-tokens.json` (`SP_AUTH_API_TOKENS`), mapa `hash → {id, usuarioId, usuario, nome, criado, expira, ultimoUso}`. O token é `sp_` + 32 bytes aleatórios em `base64url`; em disco fica só o **SHA-256** (sem sal basta para 256 bits aleatórios), com busca por `Map[hash]` (sem comparação linear). Gravação `tmp` + `rename`, modo 0640, como `createPedidos`. Guarda também o **id do usuário** do File Browser: usuário removido e recriado com o mesmo e-mail não herda tokens. `ultimoUso` em memória, gravado no máximo 1 vez/min e no `exit`.

**Rotas no sp-auth** (objeto `routes`):

| Rota | Quem | O que faz |
|---|---|---|
| `POST /api/tokens` | sessão (`X-Auth`, `userFromToken`) | cria; exige `@` (admin por e-mail pode; `admin` local não); grava o papel atual; máx. 5; evento `acesso_token_criado` (com o papel) |
| `GET /api/tokens` | sessão | lista só os do dono (sem o token) |
| `POST /api/tokens/revogar {id}` | sessão | revoga; confere que o dono é o chamador; evento `acesso_token_revogado` |
| `POST /api/sessao {token}` | pública (por token) | valida hash, expiração, existência do usuário (mesmo id), `@` e que o papel atual **não excede** o gravado no token (checado a cada troca); troca a senha por aleatória (`randomBytes(24)`) sob **mutex por usuário** (`Map<username, Promise>`, compartilhado com `/login` Microsoft); faz o login no File Browser (`fb.loginAs`) e devolve `{jwt}`; repete 1 vez se o login der 401 |

O roteador do sp-auth casa método+caminho exatos (por isso a revogação é um `POST …/revogar`, como `/pedidos/recusar`).

**NGINX.** `/admin/entra/api/*` já passa por `location /admin/entra/`. A regex do limite vira `^/admin/entra/(login|solicitar|api/sessao)$` (`limit_req zone=entra burst=30 nodelay`): só a troca por token é limitada, **não** as rotas com sessão (RULES 24: atrás de um proxy o IP é compartilhado). O JWT segue em `X-Auth`, como no painel. Escritas em `/admin/api/resources` e `/admin/api/tus` sem `Content-Length` recebem 411 antes da checagem de cota (hoje o `sp-auth` `/cota` trata o tamanho ausente como 0 e deixaria passar). **A confirmar:** o NGINX não recusa isso sozinho; é preciso um `map` em `$content_length` vazio com método de escrita (e cuidado com o POST de criação do tus, que manda `Content-Length: 0`). Se não for viável sem efeito colateral no painel, a alternativa é o NGINX bufferizar o corpo (`proxy_request_buffering on`, que torna o tamanho conhecido) e a spec documentar o limite.

**Atualização sem perder versão.** Não há mágica no servidor: o guia documenta o padrão `DELETE` + `POST` para ter lixeira, e `override=true` para quem aceita sobrescrever.

**Alternativas descartadas**
- *Token como JWT do File Browser*: expira em horas e não é revogável por pessoa.
- *Aceitar o token direto em `/admin/api/*` via `auth_request`*: toca no caminho de toda a API e na cota; a troca por sessão é mais simples e reaproveita o login já existente.
- *Endpoint de publicação no sp-auth*: duplica autorização, cota e autoria.
- *Token sem validade*: um vazamento viraria acesso permanente; validade máxima de 365 dias.

**Riscos**
- Token vaza (repositório, log de CI): escreve no time até a validade ou a revogação. Mitigações: só hash em disco, validade, último uso na lista, revogação imediata, máximo de 5, evento no histórico, e o guia diz tratar como senha e usar o cofre de segredos da ferramenta de automação.
- Corrida de trocas de senha (duas automações do mesmo usuário): mutex por usuário e repetição única; o JWT já emitido continua válido após a troca de senha (a confirmar em teste), então o painel aberto não cai.
- `lockPassword: true` dos usuários Microsoft: o `PUT` via `sp-svc` já funciona no login atual; testar explicitamente.
- Automação publica HTML com script não revisado: o site roda em sandbox sem acesso ao painel (RULES 4); o guia reforça o aviso de visibilidade.
- Muitas trocas seguidas (job em laço): limite por IP no NGINX; a automação deve reutilizar o `jwt` até expirar.
- **Token de admin vazado** dá acesso total ao Pages (todos os times, usuários e lixeira). Mitigações específicas: token de admin com validade máxima de **90 dias** (os demais, 365), nome do papel destacado na lista, evento de criação com o papel, e o guia pede cofre de segredos e revogar ao menor sinal. Um admin que não precisa de poder total pode criar o token com a conta de Editor.
- Usuário promovido depois de criar o token: a troca recusa até gerar token novo (o papel gravado é o teto).

## Critérios de aceite

**sp-auth (unitários, `tests/sp-auth.test.js`)**
- [ ] Criar devolve `sp_…` uma vez; o arquivo guarda só o hash (o token em claro não aparece em disco).
- [ ] Listar mostra só os tokens do próprio dono; revogar remove; revogar token de outra pessoa → 403/404; o 6º token é recusado.
- [ ] Admin por e-mail gera token (validade ≤ 90 dias) e a sessão dele é admin (lê e escreve em qualquer time); o `admin` local (sem `@`) não gera token.
- [ ] Promover o dono depois de criar o token recusa a troca (401); rebaixar mantém a troca, com o papel menor.
- [ ] Expirado, revogado, desconhecido ou de usuário removido/recriado → 401 `token_invalido`; corpo > 16 KB → 413.
- [ ] Duas `/api/sessao` simultâneas do mesmo usuário, e `/api/sessao` junto de `/login` Microsoft, funcionam (mutex).
- [ ] Nenhum `sp_…` em log nem no `auditoria.log`.

**E2E (`tests/`)**
- [ ] Editor com token publica `/<time>/<nome>/index.html` (200), a página abre e aparece na home do time.
- [ ] `override=false` numa página existente → 409; `override=true` → atualiza.
- [ ] Leitor com token: ler e listar ok; publicar e apagar → 403.
- [ ] Editor não alcança outro time (`../` recusado pelo File Browser).
- [ ] Acima da cota → 413 com a mensagem em português; escrita sem `Content-Length` → 411.
- [ ] `DELETE` do arquivo vai para a lixeira (restaurável pela aba Lixeira) e o `POST` seguinte recria.
- [ ] Token revogado → 401 na próxima troca; o JWT já emitido continua válido até expirar (documentado).
- [ ] O JWT do painel continua válido depois da troca de senha por token.
- [ ] `.autoria` e a Atividade registram o dono do token na pasta nova.
- [ ] A tela `api.html`: criar mostra o token uma vez; a lista mostra expira e último uso; revogar funciona.
- [ ] O limite `entra` de `/api/sessao` é verificado **isolado no NGINX** (não no E2E: o IP compartilhado interfere nos outros testes).

**Gerais**
- [ ] Nenhuma regra do RULES quebrada (21: servidor valida; 22/24: limites; 20: sem caminho absoluto fixo; senhas só aleatórias, tokens só em hash)
- [ ] `python -m pytest tests` e `node --test tests/sp-auth.test.js` verdes; CI verde
- [ ] Console do navegador sem erros em `api.html` (verificação manual)
- [ ] Guia `/_ajuda/` com a seção "Automatizar com token de API" e o script de exemplo

## Fatias de implementação

1. sp-auth: store, criar/listar/revogar, `/api/sessao` com mutex e `loginAs`, regex do limite no NGINX e 411 sem `Content-Length`; unitários e E2E de sessão.
2. `api.html` e o item de menu em `inject.js`.
3. E2E de publicação (Editor, Leitor, cota, lixeira, autoria).
4. Guia, exemplo em Python, docs (ARCHITECTURE, RULES 25+, MEMORY, TASKS, README) e, depois, levar para o `static-pages` (sem a marca).

## Decisões do dono (2026-10-22)

1. **Admin pode ter token: sim.** Com as proteções acima (validade máxima de 90 dias, papel gravado como teto, evento com o papel). O `admin` local, sem `@`, continua só por senha.
2. **Validade:** padrão de 90 dias, máximo de 365 (admin: máximo de 90). *(recomendado)*
3. **Sobrescrever:** só documentar o padrão `DELETE` + `POST` para ter lixeira; `override=true` segue sem lixeira. *(recomendado)*
4. **411 sem `Content-Length`** nas escritas da API: aceito; clientes em chunked precisam enviar o tamanho. *(recomendado; viabilidade no NGINX a confirmar na fatia 1)*

## Desenho técnico

Revisão do tech-lead já feita sobre o mesmo mecanismo (spec do MCP adiada, 2026-10-22). Antes de implementar, confirmar em teste os pontos marcados "a confirmar" (JWT sobrevive à troca de senha; `.autoria` em pasta nova; `lockPassword`).

## Andamento

- 2026-10-22 — rascunho escrito a partir da spec do MCP e do parecer do tech-lead.
- 2026-10-22 — **fatia 1 concluída**: `sp-auth` (store, criar/listar/revogar, `/api/sessao` com mutex e `loginAs`, papel como teto), regex do limite `entra`, 411 em chunked, correção do `client_max_body_size` de `/_cota`; 5 unitários e 5 E2E novos. Confirmado em teste: o JWT do painel sobrevive à troca de senha, `.autoria` é gravado na pasta nova, `lockPassword` não atrapalha. Próxima: fatia 2 (`conectar`/menu).
- 2026-10-22 — **fatia 2 concluída**: `conf/times/api.html` (criar com nome e validade, token mostrado uma vez, lista com papel, expira e último uso, revogar, exemplo de `curl`), item "Tokens de API" no menu (`inject.js`; só contas de e-mail com o Entra ligado), estilo comum extraído para `painel.css`. 2 E2E de tela; conferido em 360 px. Próximas: fatia 3 (E2E extra, quase toda coberta) e 4 (guia, exemplo em Python, docs).
- 2026-10-22 — **fatias 3 e 4 concluídas**: guia com a seção "Automatizar com token de API" (passo a passo, `curl`, tabela de criar/atualizar/sobrescrever, aviso de `Content-Length` e validade), `conf/guia/publicar.py` (testado por E2E: publicar, recusa sem `--atualizar`, atualizar com lixeira, Leitor, admin com `--time`, mensagens de erro) e docs. O limite `entra` de `/api/sessao` foi verificado isolado no NGINX (100 chamadas: 31 respostas 401 e 69 respostas 429; `/config` sem limite). Todos os critérios da spec estão cobertos por teste ou verificação manual registrada.
- 2026-10-22 — decisões do dono: admin **pode** ter token (com validade máxima de 90 dias e papel gravado como teto); as outras três seguem o recomendado. Spec aprovada; próxima ação: fatia 1.
