# static-pages

NGINX servindo um site estático de `/srv` + File Browser em `/admin/` para editar os arquivos.

```
static-pages/
├── Dockerfile
├── docker-compose.yml                # usado local e na VPS
├── subir.bat                         # atalho Windows p/ compose
├── proxy/                            # [DESATIVADO] Caddy p/ HTTPS
│   ├── docker-compose.yml  Caddyfile  .env.example
├── .env.example                      # copie para .env
├── conf/
│   ├── entrypoint.sh                 # startup (tini é o PID 1)
│   └── nginx/
│       ├── default.conf
│       └── snippets/
│           ├── fb-proxy.conf         # proxy do File Browser
│           └── security-headers.conf
└── content/                          # copiado para /srv se não houver index.html
    ├── index.html  404.html  robots.txt  favicon.svg
```

## Variáveis de ambiente

| Variável | Padrão | O que faz |
|---|---|---|
| `FB_ADMIN_USER` | `admin` | Usuário admin criado no 1º boot |
| `FB_ADMIN_PASSWORD` | *(vazio)* | Se vazia, gera senha aleatória e mostra **uma vez** no log. Se definida, é sincronizada a cada boot |
| `FB_SYNC_ADMIN_PASSWORD` | `true` | `false` = não sobrescrever a senha trocada pela UI |
| `FB_BASEURL` | `/admin` | Base do File Browser (**se mudar, ajuste também `conf/nginx/default.conf`**) |
| `FB_BRANDING_NAME` | `Static Pages` | Nome exibido no File Browser |
| `SITE_SANDBOX` | `true` | Isola o site do `/admin` via CSP `sandbox` (ver abaixo) |

> Versões recentes do File Browser exigem senha com no mínimo 12 caracteres.

## Volumes

- `/srv`: conteúdo do site
- `/database`: banco do File Browser (usuários, config)

## Segurança: `SITE_SANDBOX`

Arquivos enviados pelo File Browser são servidos na **mesma origem** do `/admin`, e o File Browser guarda o token no `localStorage`. Um `.html` malicioso enviado por upload poderia roubar a sessão de quem o abrisse.

Com `SITE_SANDBOX=true`, as páginas do site rodam numa origem opaca e não acessam storage/cookies do admin. Efeito colateral: o **site** também perde `localStorage`/cookies próprios. Se precisar deles, defina `SITE_SANDBOX=false` **e** sirva o admin em outro subdomínio (a solução definitiva).

## Outros comportamentos

- Login (`/admin/api/login`) limitado a 5 tentativas/min por IP (HTTP 429).
- IP real lido de `X-Forwarded-For` vindo de redes privadas (proxy do Coolify).
- Dotfiles (`.env`, `.git`…) respondem 404.
- gzip; assets com cache de 7 dias; HTML com `no-cache`.
- `HEALTHCHECK` verifica `/healthz` e `/admin/`.
- Se o NGINX ou o File Browser morrer, o container sai com o código de erro e o orquestrador reinicia.

## Rodar local (Windows)

Dois cliques em `subir.bat` (ou `subir.bat 9000` para outra porta). Ele cria o `.env` a partir do `.env.example` se faltar e roda `docker compose up -d --build`.

## Subir na VPS (atrás do NGINX já existente)

```bash
cd static-pages
cp .env.example .env && nano .env      # FB_ADMIN_PASSWORD (12+), HTTP_BIND=127.0.0.1, HTTP_PORT=8080
docker compose up -d --build
docker compose logs -f
```

No NGINX da VPS (o certificado/HTTPS continua com ele):

```nginx
server {
    server_name meusite.com.br;
    # ... listen 443 ssl / certificados que você já usa ...

    client_max_body_size 0;          # uploads grandes no /admin
    proxy_request_buffering off;
    proxy_read_timeout 1h;
    proxy_send_timeout 1h;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade           $http_upgrade;
        proxy_set_header Connection        "upgrade";
    }
}
```

> O app confia no `X-Forwarded-For` vindo de redes privadas (rede do Docker). Com o NGINX no host, a conexão chega pelo gateway do Docker, que é privado — o IP real do cliente é preservado.

- Atualizar: `git pull && docker compose up -d --build`.
- Dados: volumes `static-pages_srv` e `static-pages_db`.
- Backup: `docker run --rm -v static-pages_srv:/s -v static-pages_db:/d -v "$PWD":/b alpine tar czf /b/backup.tgz /s /d`
- A pasta `proxy/` (Caddy) está desativada; serve só se um dia trocar o NGINX da VPS.
