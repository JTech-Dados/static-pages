# MEMORY — o que já aprendemos

> Decisões e erros, com data e motivo. Antes de "consertar" algo estranho, procure aqui.
> Formato: **AAAA-MM-DD — título.** Contexto → decisão → por quê.

## Decisões

- **2026-10-14 — Site isolado do painel com CSP `sandbox`.** Uploads são servidos na mesma origem do `/admin` e o File Browser guarda o token no `localStorage`. Sem isolamento, um HTML enviado poderia roubar a sessão de quem o abrisse. Efeito colateral aceito: páginas do site não têm `localStorage`/cookies. Saída definitiva (futura): admin em subdomínio próprio.
- **2026-10-14 — File Browser roda como usuário `nginx` (su-exec).** Ele grava uploads com modo fixo 0640; rodando como root, os arquivos ficavam `root:root` e o NGINX respondia 403.
- **2026-10-15 — Proxy Caddy desativado.** A VPS já tem NGINX como proxy reverso; `proxy/` fica só como referência.
- **2026-10-15 — DESIGN.md (estilo Vercel) como contrato visual**, com logo próprio (não usar o logo da Vercel).
- **2026-10-21 — Time = pasta com `.time.json`; membro = usuário com escopo.** O File Browser v2 não tem grupos nem cota; o escopo por usuário é o único isolamento nativo.
- **2026-10-21 — Colunas "Time/Alterado por" só para admin.** Para o membro ler `.autoria`, seria preciso desligar "ocultar dotfiles", e aí ele poderia apagar o `.time.json` do time.
- **2026-10-21 — Auditoria protegida por `auth_request` na própria API.** `/admin/api/users` só devolve 200 para admin — vira o "porteiro" sem servidor extra.
- **2026-10-21 — Cota só alerta.** O File Browser não bloqueia upload por tamanho; bloquear exigiria um serviço no meio.

- **2026-10-21 — Repo público; commits com o e-mail noreply do GitHub.** Os commits saíam com o e-mail corporativo, que expunha o nome da empresa. O histórico foi reescrito (`git filter-branch`, os hashes mudaram) e o repo local usa `user.email = <id>+djorshuam@users.noreply.github.com`. Antes de commitar de outra máquina, configure o mesmo e-mail.

## Erros e armadilhas

- **2026-10-15 — Regex de assets roubava o `/admin`.** `location ~* \.(js|css…)` tem prioridade sobre o prefixo `/admin/`; os JS do painel caíam no site. Correção: `location ^~ /admin/`.
- **2026-10-15 — `cp -n` do busybox não copiava a seed** para `/srv` vazio. Trocado por loop explícito.
- **2026-10-15 — Binário do File Browser 2.32 fica em `/filebrowser`**, não em `/bin/filebrowser`.
- **2026-10-15 — SSL corporativo quebra `apk` via https.** Criado `APK_HTTP=true` (só local). Pacotes continuam com assinatura verificada.
- **2026-10-15 — Linux diferencia maiúsculas: `Index.html` dava 403.** A diretiva `index` aceita as variações comuns.
- **2026-10-21 — Hooks recebem `DESTINATION=/srv` em upload/save**, não vazio. Só usar `DESTINATION` em rename/copy.
- **2026-10-21 — `/api/raw` de `.json` volta como JSON (content-type)**, não texto — não dar `JSON.parse` em objeto.
- **2026-10-21 — Cache HTTP devolvia `.registro` antigo** depois de restaurar; a linha continuava na lista. Leitura com `cache: "no-store"`. Pego pelos testes E2E.
- **2026-10-21 — Escapes em heredoc + Python viraram quebras reais** (`\n`, `\t`) dentro de JS e shell, quebrando a sintaxe. Validar com `node --check` / `bash -n` depois de gerar código por script.
- **2026-10-21 — `sed` com `&` na substituição** insere o texto encontrado (embaralhou o título da home). Editar o arquivo direto.
- **2026-10-21 — Rate limit do login (5/min) derrubou o CI**, que roda rápido. Testes reaproveitam o token (`login_token`); só um login pela tela.
- **2026-10-21 — Locator do Playwright por texto pegava dois cards** (o select "Mover para…" de outro time continha o nome). Localizar pelo `h3`.
- **2026-10-21 — `display:inline-flex` do `.btn` vence o atributo `hidden`.** Regra global `[hidden]{display:none!important}`.
- **2026-10-22 — Variante de compose para GitOps (Portainer).** O Portainer (GitOps) não materializa bind mount de arquivo, não tem o `.env` (ignorado pelo git) e o "Re-pull image" falha (`pull access denied`) se o serviço tiver `image:` junto de `build:`. Por isso existe `docker-compose.portainer.yml`: variáveis por `environment:` com padrão, só `build:`, backup com imagem própria (`Dockerfile.backup`) e volume nomeado, rede fixa `static-pages-net` e sem porta no host. O `docker-compose.yml` original (env_file, bind mount, porta) continua sendo o padrão para VPS/Coolify.
- **2026-10-21 — Rede corporativa: Edge headless não captura `http://localhost`**, mas o Playwright com `channel="msedge"` funciona.

- **2026-10-21 — Publicação sob um prefixo (`SP_BASE`) sem o proxy remover o caminho.** O File Browser precisa de `baseURL` e gera links absolutos, então o prefixo tem de chegar até ele. Para não reescrever todas as locations, o NGINX do container remove o prefixo com `rewrite` antes de escolher a location e repassa a URI original ao File Browser (`$request_uri`). Alternativa descartada: o proxy fazer `rewrite` (quebraria assets e redirects do File Browser). Vazio = raiz, o padrão.
- **2026-10-21 — Entra ID no painel: ponte "troca de senha" em vez de `auth.method=proxy`.** O File Browser só tem um método de autenticação por vez; `proxy` desligaria o login do admin por senha (contingência). Então o sp-auth valida o ID token e, para membros cadastrados por e-mail, troca a senha por uma aleatória e a tela de login usa o formulário nativo. Vantagem: sessão, cookies e escopos do File Browser intactos e nada guardado em disco. Custo: a conta técnica `sp-svc` (admin) e o Node na imagem. Alternativas descartadas: oauth2-proxy (exige app registration Web com secret) e validar no NGINX com njs (sem onde guardar o estado dos pedidos).
- **2026-10-21 — Quem entra: e-mails cadastrados + pedido de acesso aprovado pelo admin.** Sem lista de grupos do AD. Pessoa sem cadastro faz login Microsoft, pede acesso e o admin escolhe o time na aba Pedidos da tela Acessos. Só o `admin` local (sem `@`) e o `sp-svc` ficam por senha.
- **2026-10-22 — Entra ID por site: avaliado e adiado.** Custo de infra ≈ zero (mesmo container; só os sites protegidos consultam o sp-auth), trabalho médio e a parte mais sensível de segurança. Sem caso real que exija, fica no backlog. Desenho em `specs/2026-10-22-entra-por-site-ADIADA.md`.
- **2026-10-22 — Admin promovido ficava trancado para fora do Microsoft.** A decisão original era "admin só com senha"; quem promovia um membro quebrava o login dele. Agora contas de e-mail entram pela Microsoft, inclusive admin; só o `admin` local e `sp-svc` ficam por senha. A senha do admin por e-mail é trocada a cada login Microsoft (o `admin` local é a contingência).
- **2026-10-22 — Barra de espaço invisível.** O File Browser usa `vue-simple-progress` com estilo inline; 5 KB de 200 MB dá 0,003% de largura. CSS com `!important` e `min-width`.
- **2026-10-22 — Tamanhos em KB/MB/GB com vírgula.** O File Browser mostra KiB/MiB/GiB e "of ... used" em inglês. O `inject.js` reescreve o texto (lista de arquivos e rodapé do menu). A base continua 1024.
- **2026-10-21 — Cota padrão de 200 MB por time (`TEAM_QUOTA_MB`).** Uma página HTML comum tem de poucos KB a algumas centenas de KB; relatório/dashboard exportado costuma ficar entre 1 e 10 MB; com imagens embutidas pode passar de 20 MB. 200 MB comporta algumas dezenas de relatórios. Ajustável por time (Editar) e por ambiente. Desde 2026-10-22 a cota bloqueia o upload.
- **2026-10-22 — A interface do File Browser envia pelo tus sem `Upload-Length`:** o `POST` cria o arquivo vazio e os bytes vão no `PATCH`. A cota precisa olhar o `Content-Length` do PATCH (além de POST/PUT); só o `POST` deixava passar. Uma recusa deixa um arquivo de 0 B (o placeholder do tus) na pasta; é inofensivo e o membro pode apagar.
- **2026-10-22 — `auth_request` não vale dentro de `if`:** a checagem de cota usa `if ($sp_escrita) { return 418; }` + `error_page 418 = @fb_escrita` (que tem o `auth_request`) e `recursive_error_pages on` para o 403 virar 413 com mensagem.
- **2026-10-21 — `* { margin: 0 }` tirou o centro dos diálogos.** O `<dialog>` modal se centraliza com `margin: auto`; o reset zerava. `dialog { margin: auto }` na tela de Acessos.
- **2026-10-21 — Limite por IP nas rotas autenticadas do sp-auth bloquearia a empresa.** Atrás de um proxy/gateway o IP pode ser compartilhado; `/me`, `/nomes`, `/pedidos` e `/config` são chamados a cada página. O limite ficou só em `/login` e `/solicitar` (location exata). Um `map` com chave vazia **não** desliga o `limit_req` neste nginx: usar locations separadas.
- **2026-10-21 — Painel metade no visual novo, metade no antigo.** O File Browser serve o `custom.css` com `max-age=86400`; o navegador manteve o CSS antigo e carregou o `inject.js` novo. Agora `/admin/static/custom.css` responde `no-cache` (revalida por ETag). Mudou CSS e JS juntos? Confira nesse caminho, não só nos arquivos de `conf/times/`.
- **2026-10-21 — Botão do login voltava a "Login".** O File Browser reescreve o texto do botão quando a tela atualiza; o `inject.js` reaplica "Entrar" a cada ciclo.
- **2026-10-21 — "Login expirou" ao clicar em Solicitar acesso.** O token do Entra era marcado como usado já no `/login`, e a tela chama `/solicitar` com o **mesmo** token logo depois. Agora só o login que libera credenciais consome o token (`consume()`). Os testes antigos mintavam um token por chamada e não pegaram; os novos usam o mesmo token, como a tela.
- **2026-10-21 — Texto da tela de login saía em minúsculas e à direita.** O CSS do login do File Browser estiliza `<p>` e botões; o bloco da Microsoft força `text-align: left; text-transform: none`.
- **2026-10-21 — `node --check a b c` só confere o primeiro arquivo.** Rodar um por vez (laço).
- **2026-10-21 — Cache de chaves (JWKS) com espera de 5 min mascarou chave nova nos testes.** Os testes usam `kid` novo a cada execução e, com `ENTRA_JWKS_FILE`, não há espera para reler.
- **2026-10-21 — Aba Acessos aberta direto via `#acessos` vinha com o seletor de time vazio:** `state.teams` ainda não tinha carregado. A tela publica `window.spLoading` e o `times-tabs.js` espera por ela.
- **2026-10-21 — Limite de login (5/min) e limite do Entra batem em testes que rodam rápido.** Rajada do login subiu para 10 (taxa continua 5/min) e a do Entra é 60/min, rajada 30.
- **2026-10-21 — `const` usada antes da declaração, dentro de `try/catch`, sumiu com os ícones da tela de Times.** O `ReferenceError` (TDZ) caiu num `catch` vazio. Declare constantes compartilhadas no topo do script.
- **2026-10-21 — `localStorage` é da origem inteira.** O File Browser guarda o token na chave `jwt`; outra app no mesmo domínio que use `jwt` colidiria. Combine o nome da chave antes de criar app nova no mesmo domínio.
