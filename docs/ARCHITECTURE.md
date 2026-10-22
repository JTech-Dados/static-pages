# ARCHITECTURE — como funciona

> O mapa. Atualize quando uma peça, rota ou fluxo mudar.

## Visão geral

```
Visitante ─HTTPS─► Proxy da VPS ─► 127.0.0.1:8080 ─► container static-pages
                                                     │
                     ┌───────────────────────────────┴───────────────────────┐
                     │ tini (PID 1) → entrypoint.sh                          │
                     │   NGINX :80 ── (remove $sp_base da URI, ver abaixo)   │
                     │             ── /          → /srv (site, CSP sandbox)  │
                     │             ── /admin/    → File Browser 127.0.0.1:8080│
                     │             ── /admin/times → tela estática (Acessos) │
                     │             ── /admin/entra/ → sp-auth (Node :8090)   │
                     │   File Browser (usuário nginx, baseURL $SP_BASE/admin)  │
                     │            ── hooks sp-autoria / sp-lixeira           │
                     │   laços: sp-visitas (5 min), limpeza da lixeira (24h) │
                     └───────────────────────────────────────────────────────┘
container static-pages-backup ── lê srv/db (ro) ──► ./backups/*.tar.gz (diário)
```

## Volumes

| Volume | Montado em | Contém |
|---|---|---|
| `srv` | `/srv` | o site + `.time.json`, `.autoria`, `meta.json`, `_lixeira/` |
| `db` | `/database` | `filebrowser.db` (usuários), `auditoria.log`, `visitas.log`, `visitas.json` |

## Prefixo público (`SP_BASE`, vazio por padrão)

Atrás de um proxy que publica o app num caminho (ex.: `/pages/`) sem reescrever nada, defina `SP_BASE=/pages`. Por isso:

- O entrypoint gera `/etc/nginx/snippets/base.conf` com `set $sp_base "<prefixo>";`, um `rewrite ^<prefixo>(/.*)$ $1;` no nível do `server` e `location = <prefixo>` → 301 `<prefixo>/`. O `rewrite` roda **antes** da escolha do `location`: todas as locations do `default.conf` continuam escritas como se o app estivesse na raiz (`/admin/`, `/_pastas/`…).
- O que volta ao navegador ou vai ao File Browser usa `$sp_base`: o 301 de `/admin`, o `<script>` injetado no painel (`sub_filter`), o `auth_request` de `/admin/_auditoria` e o `X-Forwarded-Prefix`. O File Browser roda com `baseURL=$SP_BASE/admin` e recebe a URI original (`$request_uri`) em `fb-proxy.conf`.
- Front-end: nada de caminho absoluto fixo. `times.html`, `inject.js` e a home deduzem o prefixo da própria URL (`location.pathname`); o `404.html` usa o marcador `__SP_BASE__`, trocado pelo NGINX (`sub_filter`); o `modelo-time.html` usa o mesmo marcador, trocado pela tela de Times ao criar o time. Nos caminhos lógicos (`/a/b/`, chaves de `/_visitas.json`) o prefixo não aparece — o NGINX registra a URI já sem ele.
- `SP_BASE` vazio = app na raiz (padrão). Valor inválido derruba o container no boot.
- Troca de prefixo com a stack já no ar: reinicie o container (regenera `base.conf` e o `baseURL`) e ajuste o proxy. A home e o `404.html` se ajustam sozinhos; só o `index.html` de times criados a partir do modelo guarda o prefixo antigo — edite-os.

## Onde cada coisa mora

| Caminho no repo | Vai para | Papel |
|---|---|---|
| `Dockerfile` | imagem | nginx + filebrowser + tini + node (sp-auth); copia `conf/`; remove CRLF dos scripts |
| `Dockerfile.backup` | imagem do backup | alpine + `backup.sh` (COPY, para orquestradores GitOps que não materializam bind mount de arquivo) |
| `docker-compose.portainer.yml` (+ `.local.yml`) | variante GitOps | sem bind mount, sem `env_file`, sem `image:`, sem porta no host, rede fixa `static-pages-net`, backup em volume nomeado; o `.local.yml` só publica a porta para teste |
| `conf/entrypoint.sh` | `/usr/local/bin/entrypoint.sh` | seed de `/srv`, admin, `base.conf` (prefixo), branding, `--signup=false`, hooks, laços |
| `conf/nginx/default.conf` + `snippets/` | `/etc/nginx/` | rotas, segurança, CORS, auth_request, log de visitas |
| `conf/sp-autoria.sh` | hook `after_*` | grava `<pasta>/.autoria` e `/database/auditoria.log` |
| `conf/sp-lixeira.sh` | hook `before_delete` | copia para `/srv/_lixeira/<dia>/<lote>/` + `.registro` |
| `conf/sp-visitas.sh` | laço 5 min | `visitas.log` → `visitas.json` |
| `conf/backup.sh` | serviço `backup` | tar.gz diário, mantém N |
| `conf/branding/` | `/branding` | CSS, logo e ícones do painel (`--branding.files`) |
| `conf/entra/sp-auth.js` | `/usr/local/lib/sp-auth.js` (Node, 127.0.0.1:8090) | ponte do login Microsoft: valida o ID token, troca a senha do usuário e devolve; guarda pedidos de acesso |
| `conf/times/entra-login.js` + `msal-browser.min.js` | `/admin/times/…` | botão "Entrar com Microsoft" na tela de login (MSAL 3.28.1, MIT, vendorizado); carregado pelo `inject.js` |
| `conf/times/times.html` | `/admin/times` | tela Acessos e times: card de time em largura total (resumo, cota, ações); as pessoas abrem num diálogo (clique no card ou em "Pessoas") |
| `conf/times/times-tabs.js` | `/admin/times/times-tabs.js` | abas Lixeira, Atividade e Pedidos (pedidos de acesso do login Microsoft) |
| `conf/times/inject.js` | injetado no `/admin` (sub_filter) | item "Acessos" no menu (com o contador de pedidos), colunas Time/Alterado por e, na barra superior, quem está logado + time + papel (Admin/Editor) + aviso de pedidos pendentes (admin) |
| `conf/times/modelo-time.html` | `/admin/times/…` | `index.html` inicial de time novo |
| `conf/guia/` | `/_ajuda/` | guia "Como publicar" (página estática da imagem) |
| `content/index.html`, `404.html`, `favicon.svg` | `/usr/share/static-pages/home/` (imagem) | home, 404 e favicon, **servidos pela imagem**: cada deploy os atualiza; um `/srv/index.html` antigo fica sem efeito. Com `HOME_FROM_SRV=true` são semeados e servidos do `/srv` (`snippets/home-root.conf`, gerado no boot) |
| `content/` (o resto, ex.: `robots.txt`) | **seed** de `/srv` | só copiado se ainda não existir em `/srv` |

> A home, a 404 e o favicon não vêm do `/srv` (salvo `HOME_FROM_SRV=true`): para mudar, edite `content/` e reimplante a imagem. Só o resto de `content/` é semente do `/srv`.

## Rotas do NGINX

> Valem **sob o prefixo** (`/pages/admin/`, `/pages/_pastas/`…); o NGINX do container as enxerga já sem ele.

| Rota | O que é | Acesso |
|---|---|---|
| `/` , `/pasta/`, `/pagina` | site (`try_files $uri $uri.html $uri/`) | público, CSP sandbox |
| `/_pastas/<caminho>/` | autoindex JSON (menu da home) | público, CORS `*` |
| `/<pasta>/.time.json` (só 1º nível) | nome/cota do time | público |
| `/<…>/meta.json` | metadados do card (ausente → 204) | público |
| `/_visitas.json` | contagem de visitas | público |
| `/_ajuda/` | guia "Como publicar" (da imagem) | público |
| `/_lixeira/`, `/_backup/`, dotfiles | internos | **404** |
| `/admin/` | File Browser (proxy) | login; `/admin/api/login` 5/min por IP |
| `/admin/times`, `/admin/times/*` | tela de Times (estática) | a página exige token de admin |
| `/admin/_auditoria` | `auditoria.log` | **só admin** (auth_request → `/admin/api/users`) |
| `/admin/entra/config`, `/login`, `/solicitar` | login Microsoft (sp-auth) | públicos; validam o ID token; `/login` e `/solicitar` com limite de 60/min por IP |
| `/admin/entra/me`, `/nomes`, `/pedidos*` | nome/papel/time de quem está logado, nomes das contas Microsoft, pedidos | exigem token do File Browser (`/nomes` e `/pedidos*` só admin) |
| `/admin/api/usage/…` | espaço usado (barra do menu) | sessão; membro vê o espaço do **time** (pasta x cota), admin a resposta nativa (disco) |
| `/admin/entra/pedidos*` | lista, recusa e remove pedidos de acesso | **só admin** (o sp-auth confere o `X-Auth` na API do File Browser) |
| `/healthz` | healthcheck | público |

## Login Microsoft (Entra ID)

Desligado por padrão: com `ENTRA_TENANT_ID`/`ENTRA_CLIENT_ID` vazios o botão não aparece e tudo segue só com usuário e senha. Para ligar, registre um app "SPA" (sem secret) no Entra ID.

```
navegador ──MSAL popup──► Microsoft ──► Redirect URI (<prefixo>/admin/entra/retorno) ──► ID token
navegador ──POST entra/login {idToken}──► sp-auth
   sp-auth: valida assinatura (chaves do Entra), emissor, audiência, tenant, validade, idade ≤ 10 min, uso único
            usuário do File Browser com nome = e-mail (contém "@"), não admin?
              sim ─► troca a senha por uma aleatória ─► { usuario, senha }
                     a tela de login preenche o formulário NATIVO do File Browser e envia (token, cookies, escopo normais)
              não ─► 403 sem_acesso ─► botão "Solicitar acesso" ─► POST entra/solicitar ─► /database/entra-pedidos.json
admin (menu Acessos > aba Pedidos): escolhe o time e aprova ─► a tela cria o usuário (e-mail, senha aleatória, lockPassword) ─► remove o pedido
```

- **Membro Microsoft = usuário do File Browser** com o e-mail como nome de usuário e escopo `/<time>`. Quem cadastra: a aba "Conta Microsoft" do diálogo Adicionar pessoa, ou a aprovação de um pedido. Mudar de time e remover usam as mesmas ações dos outros membros.
- **Contas de e-mail entram pela Microsoft, inclusive admin** (promovido na aba Usuários não fica trancado). O `admin` local (sem `@`) só entra por usuário e senha, como contingência. A conta técnica `sp-svc` (admin do File Browser, senha aleatória a cada boot em `/run/sp-auth/svc`, modo 600) existe só para o sp-auth listar usuários e trocar senhas. O Entra não guarda senha nenhuma em disco: a senha do membro muda a cada login.
- Redirect URI: por padrão `https://<domínio>[/prefixo]/admin/entra/retorno` (página vazia servida pelo NGINX; cadastre-a no app registration como tipo SPA). `ENTRA_REDIRECT_URI` troca por outro endereço do mesmo domínio que também feche o popup. **Não validado com um tenant real** (só com o Entra de teste da suíte); valide ao ligar.
- `ENTRA_JWKS_FILE` (só testes) troca as chaves do Entra por um arquivo local; não defina em produção.
- **Nomes:** o nome da Microsoft (token) é guardado em `/database/entra-nomes.json` no login e no pedido de acesso; a tela de Acessos e a barra superior mostram primeiro e último nome (`Maria Santos`) e, sem nome, deduzem do e-mail. Contas só com usuário (ex.: `joao`) aparecem como são.
- **Espaço por time:** o File Browser mostra o disco da máquina na barra do menu. `/admin/api/usage/…` vai para o sp-auth: membro vê o tamanho da **pasta do time** contra a cota (`cota_mb` do `.time.json` ou `TEAM_QUOTA_MB`, padrão 200 MB); admin recebe a resposta nativa. A cota também **bloqueia**: escritas (POST/PUT e o PATCH do tus) em `/admin/api/resources` e `/admin/api/tus` passam por `auth_request /_cota` → `GET /admin/entra/cota` no sp-auth (pasta + tamanho x cota; admin sem limite). Estourou: 413 com a mensagem em português e o evento `acesso_cota` na Atividade.
- **Guia e visibilidade:** `/_ajuda/` serve o guia estático `conf/guia/`; com `SITE_NOINDEX=true` todo conteúdo leva `X-Robots-Tag: noindex` (gerado pelo entrypoint em `snippets/noindex.conf`). As páginas são sempre públicas para quem tem o link; o guia avisa disso.
- **Histórico de acessos:** o sp-auth grava `acesso_login/pedido/recusado/cota` no `auditoria.log`; a tela de Times manda `acesso_criado/papel/time/removido/aprovado` por `POST /admin/entra/evento` (só admin).
- O sp-auth roda num laço do entrypoint: se cair, volta em 2 s; o site e o painel não dependem dele.

## Conceitos

- **Time** = pasta de 1º nível com `.time.json` (`{nome, cota_mb}`).
- **Membro** = usuário do File Browser com `scope: "/<time>"`, `hideDotfiles: true`, sem admin.
- **Página** = pasta com `index.html` (variações de maiúsculas aceitas).
- Pastas que começam com `_` ou `.` ficam fora da home e da tela de Times.

## Fluxos principais

- **Home**: `/_pastas/` → para cada pasta: `/_pastas/<p>/` (tem index?), `meta.json`, `.time.json` → seções por time + `/_visitas.json`.
- **Exclusão**: painel DELETE → hook `before_delete` copia p/ lixeira → apaga → `after_delete` registra autoria/auditoria.
- **Restaurar**: aba Lixeira → PATCH rename de `/_lixeira/...` p/ o caminho original (`rename=true`) → remove a linha do `.registro`.
- **CSP sandbox**: páginas do site rodam em origem opaca; por isso os JSON públicos respondem com `Access-Control-Allow-Origin: *`.
