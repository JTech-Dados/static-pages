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
- **2026-10-21 — Rede corporativa: Edge headless não captura `http://localhost`**, mas o Playwright com `channel="msedge"` funciona.
