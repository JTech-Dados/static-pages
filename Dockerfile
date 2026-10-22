# syntax=docker/dockerfile:1

# ============================================================
# Versões fixadas (atualize conscientemente; evite "latest")
# ============================================================
ARG FILEBROWSER_VERSION=v2.32.0
ARG NGINX_VERSION=1.27-alpine


# ============================================================
# File Browser
# ============================================================
FROM filebrowser/filebrowser:${FILEBROWSER_VERSION} AS fb-bin


# ============================================================
# Runtime
# ============================================================
FROM nginx:${NGINX_VERSION}

# nodejs   : sp-auth (ponte do login Microsoft; sem dependências npm)
# bash     : entrypoint
# su-exec  : roda o File Browser como "nginx" (ver conf/entrypoint.sh)
# tini     : PID 1 — repassa sinais e recolhe zumbis
# APK_HTTP=true: baixa pacotes via http (redes corporativas com
# inspeção SSL quebram o https). Os pacotes continuam com a
# assinatura verificada pelo apk. Na VPS deixe false.
ARG APK_HTTP=false
RUN if [ "$APK_HTTP" = "true" ]; then sed -i 's#https://#http://#' /etc/apk/repositories; fi  && apk add --no-cache bash su-exec tini nodejs

# Na v2.32 o binário fica em /filebrowser (em versões mais novas: /bin/filebrowser)
COPY --from=fb-bin /filebrowser /usr/local/bin/filebrowser

RUN mkdir -p /srv /seed /database /etc/nginx/snippets \
 && chown -R nginx:nginx /srv /database

COPY content/                       /seed/
COPY content/index.html content/404.html content/favicon.svg /usr/share/static-pages/home/
COPY conf/nginx/default.conf   /etc/nginx/conf.d/default.conf
COPY conf/nginx/snippets/      /etc/nginx/snippets/
COPY conf/branding/            /branding/
COPY conf/times/               /usr/share/static-pages/times/
COPY conf/entra/sp-auth.js     /usr/local/lib/sp-auth.js
COPY conf/guia/                /usr/share/static-pages/guia/
# o NGINX (workers como "nginx") lê o auditoria.log em /database
RUN chmod 755 /database
# CRLF (checkout no Windows) quebra o bash: normaliza por garantia
COPY conf/entrypoint.sh        /usr/local/bin/entrypoint.sh
COPY conf/sp-autoria.sh        /usr/local/bin/sp-autoria
COPY conf/sp-lixeira.sh        /usr/local/bin/sp-lixeira
COPY conf/sp-visitas.sh        /usr/local/bin/sp-visitas
RUN sed -i 's/\r$//' /usr/local/bin/entrypoint.sh /usr/local/bin/sp-autoria /usr/local/bin/sp-lixeira \
        /usr/local/bin/sp-visitas /etc/nginx/snippets/*.conf /etc/nginx/conf.d/default.conf \
 && chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/sp-autoria /usr/local/bin/sp-lixeira /usr/local/bin/sp-visitas


# ============================================================
# Defaults não sensíveis
#
# FB_ADMIN_PASSWORD  -> se ausente, uma senha aleatória é gerada
#                       e exibida UMA vez no log (só na criação
#                       do banco).
# SITE_SANDBOX       -> "true" isola o site estático do /admin
#                       (ver conf/nginx/default.conf).
# SP_BASE            -> prefixo público atrás de um proxy (ex.: /pages).
#                       Vazio = app na raiz. O File Browser fica em
#                       $SP_BASE/admin.
# HOME_FROM_SRV      -> "true" serve home, 404 e favicon do /srv (editáveis pelo painel);
#                       padrão false: vêm da imagem e cada deploy os atualiza.
# SITE_NOINDEX       -> "true" manda X-Robots-Tag: noindex (fora de buscadores).
# ENTRA_TENANT_ID /
# ENTRA_CLIENT_ID    -> login Microsoft (vazios = desligado).
# ENTRA_REDIRECT_URI -> Redirect URI do app Entra; vazio = <prefixo>/admin/entra/retorno.
# TEAM_QUOTA_MB      -> cota padrão por time (bloqueia upload acima dela).
# ============================================================
ENV FB_ADMIN_USER=admin \
    FB_BRANDING_NAME="Static Pages" \
    SITE_SANDBOX=true \
    SITE_NOINDEX=false \
    HOME_FROM_SRV=false \
    SP_BASE="" \
    ENTRA_TENANT_ID="" \
    ENTRA_CLIENT_ID="" \
    ENTRA_REDIRECT_URI="" \
    TEAM_QUOTA_MB=200


VOLUME ["/srv", "/database"]

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1/healthz >/dev/null \
   && wget -qO- "http://127.0.0.1${SP_BASE}/admin/" >/dev/null \
   || exit 1

ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/entrypoint.sh"]
