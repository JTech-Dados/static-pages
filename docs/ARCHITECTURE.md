# ARCHITECTURE — como funciona

> O mapa. Atualize quando uma peça, rota ou fluxo mudar.

## Visão geral

```
Visitante ─HTTPS─► Proxy da VPS ─► 127.0.0.1:8080 ─► container static-pages
                                                     │
                     ┌───────────────────────────────┴───────────────────────┐
                     │ tini (PID 1) → entrypoint.sh                          │
                     │   NGINX :80 ── /          → /srv (site, CSP sandbox)  │
                     │             ── /admin/    → File Browser 127.0.0.1:8080│
                     │             ── /admin/times → tela estática (Times)   │
                     │   File Browser (usuário nginx) ── hooks sp-autoria /  │
                     │                                    sp-lixeira         │
                     │   laços: sp-visitas (5 min), limpeza da lixeira (24h) │
                     └───────────────────────────────────────────────────────┘
container static-pages-backup ── lê srv/db (ro) ──► ./backups/*.tar.gz (diário)
```

## Volumes

| Volume | Montado em | Contém |
|---|---|---|
| `srv` | `/srv` | o site + `.time.json`, `.autoria`, `meta.json`, `_lixeira/` |
| `db` | `/database` | `filebrowser.db` (usuários), `auditoria.log`, `visitas.log`, `visitas.json` |

## Onde cada coisa mora

| Caminho no repo | Vai para | Papel |
|---|---|---|
| `Dockerfile` | imagem | nginx + filebrowser + tini; copia `conf/`; remove CRLF dos scripts |
| `conf/entrypoint.sh` | `/usr/local/bin/entrypoint.sh` | seed de `/srv`, admin, branding, `--signup=false`, hooks, laços |
| `conf/nginx/default.conf` + `snippets/` | `/etc/nginx/` | rotas, segurança, CORS, auth_request, log de visitas |
| `conf/sp-autoria.sh` | hook `after_*` | grava `<pasta>/.autoria` e `/database/auditoria.log` |
| `conf/sp-lixeira.sh` | hook `before_delete` | copia para `/srv/_lixeira/<dia>/<lote>/` + `.registro` |
| `conf/sp-visitas.sh` | laço 5 min | `visitas.log` → `visitas.json` |
| `conf/backup.sh` | serviço `backup` | tar.gz diário, mantém N |
| `conf/branding/` | `/branding` | CSS, logo e ícones do painel (`--branding.files`) |
| `conf/times/times.html` | `/admin/times` | tela de Times (aba Times) |
| `conf/times/times-tabs.js` | `/admin/times/times-tabs.js` | abas Lixeira e Atividade |
| `conf/times/inject.js` | injetado no `/admin` (sub_filter) | item "Times" no menu + colunas Time/Alterado por |
| `conf/times/modelo-time.html` | `/admin/times/…` | `index.html` inicial de time novo |
| `content/` | **seed** de `/srv` | home e 404 — só copiados se `/srv/index.html` não existir |

> ⚠️ `content/` é **seed**: editar `content/index.html` não muda um servidor que já tem `/srv/index.html`. Publique pelo painel ou `docker cp`.

## Rotas do NGINX

| Rota | O que é | Acesso |
|---|---|---|
| `/` , `/pasta/`, `/pagina` | site (`try_files $uri $uri.html $uri/`) | público, CSP sandbox |
| `/_pastas/<caminho>/` | autoindex JSON (menu da home) | público, CORS `*` |
| `/<pasta>/.time.json` (só 1º nível) | nome/cota do time | público |
| `/<…>/meta.json` | metadados do card (ausente → 204) | público |
| `/_visitas.json` | contagem de visitas | público |
| `/_lixeira/`, `/_backup/`, dotfiles | internos | **404** |
| `/admin/` | File Browser (proxy) | login; `/admin/api/login` 5/min por IP |
| `/admin/times`, `/admin/times/*` | tela de Times (estática) | a página exige token de admin |
| `/admin/_auditoria` | `auditoria.log` | **só admin** (auth_request → `/admin/api/users`) |
| `/healthz` | healthcheck | público |

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
