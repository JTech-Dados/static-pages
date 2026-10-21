#!/usr/bin/env bash
# ============================================================
# Startup
#
# - Popula /srv com /seed se não houver index.html
# - Corrige dono de /srv e /database (só o que precisa)
# - Gera snippet de isolamento (CSP sandbox) do site
# - Inicializa banco do File Browser + usuário admin
# - Sincroniza a senha do admin com FB_ADMIN_PASSWORD (se definida)
# - Aplica baseURL e branding
# - Sobe File Browser (usuário nginx) e NGINX
# - Se qualquer um cair, derruba o outro e sai com o código
#   dele (o orquestrador reinicia o container)
#
# Permissões: o File Browser grava uploads com modo fixo 0640.
# Rodando como "nginx", os arquivos ficam nginx:nginx e os
# workers do NGINX (uid 101) conseguem ler.
# ============================================================
set -euo pipefail

log() { echo "[startup] $*"; }

DB=/database/filebrowser.db
ADMIN_USER="${FB_ADMIN_USER:-admin}"
BASEURL="${FB_BASEURL:-/admin}"
BRANDING="${FB_BRANDING_NAME:-Static Pages}"
FB=(su-exec nginx:nginx filebrowser -d "$DB")

log "Inicializando container..."
log "Usuário administrativo: $ADMIN_USER"
log "Base URL do File Browser: $BASEURL"


# ------------------------------------------------------------
# /srv
# ------------------------------------------------------------
if [ ! -f /srv/index.html ]; then
    log "/srv/index.html não encontrado. Copiando /seed (sem sobrescrever)..."
    # loop explícito: o "cp -n" do busybox não é confiável aqui
    for f in /seed/* /seed/.[!.]*; do
        [ -e "$f" ] || continue
        [ -e "/srv/$(basename "$f")" ] || cp -r "$f" /srv/
    done
else
    log "/srv/index.html já existe. Mantendo conteúdo atual."
fi

log "Ajustando dono apenas de arquivos fora de nginx:nginx..."
find /srv /database ! -user nginx -exec chown nginx:nginx {} +


# ------------------------------------------------------------
# Isolamento do site estático
#
# Uploads são servidos na mesma origem do /admin, e o File
# Browser guarda o token no localStorage: um HTML malicioso
# enviado por upload poderia lê-lo. Com o sandbox (sem
# allow-same-origin) as páginas rodam numa origem opaca e não
# alcançam storage/cookies do /admin.
#
# SITE_SANDBOX=false desativa — use só se o site precisar de
# localStorage/cookies próprios, e então sirva o admin em outro
# subdomínio.
# ------------------------------------------------------------
SNIPPET=/etc/nginx/snippets/site-sandbox.conf
if [ "${SITE_SANDBOX:-true}" = "true" ]; then
    log "SITE_SANDBOX=true: site estático isolado do /admin."
    echo 'add_header Content-Security-Policy "sandbox allow-scripts allow-forms allow-popups allow-downloads" always;' > "$SNIPPET"
else
    log "ATENÇÃO: SITE_SANDBOX=false: site estático NÃO isolado do /admin."
    : > "$SNIPPET"
fi


# ------------------------------------------------------------
# Banco do File Browser
# ------------------------------------------------------------
if [ ! -f "$DB" ]; then
    log "Banco não encontrado. Inicializando..."
    "${FB[@]}" config init >/dev/null

    if [ -z "${FB_ADMIN_PASSWORD:-}" ]; then
        ADMIN_PASSWORD="$(head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c 24)"
        echo ''
        echo '############################################################'
        echo '#  FB_ADMIN_PASSWORD não definida. Senha gerada abaixo.'
        echo '#  Ela aparece APENAS AGORA — guarde e troque após o'
        echo '#  primeiro acesso (ou defina FB_ADMIN_PASSWORD).'
        echo '#'
        echo "#     usuário: $ADMIN_USER"
        echo "#     senha:   $ADMIN_PASSWORD"
        echo '############################################################'
        echo ''
    else
        ADMIN_PASSWORD="$FB_ADMIN_PASSWORD"
        log "FB_ADMIN_PASSWORD recebida via variável de ambiente (não exibida)."
    fi

    "${FB[@]}" users add "$ADMIN_USER" "$ADMIN_PASSWORD" --perm.admin=true >/dev/null
    unset ADMIN_PASSWORD
    "${FB[@]}" users update "$ADMIN_USER" --locale "${FB_LOCALE:-pt-br}" >/dev/null
    log "Usuário administrador criado."
else
    log "Banco existente encontrado. Usuários preservados."

    # FB_ADMIN_PASSWORD é a fonte de verdade quando definida:
    # sobrescreve uma senha trocada pela UI. Para manter a da UI,
    # remova a variável ou use FB_SYNC_ADMIN_PASSWORD=false.
    if [ -n "${FB_ADMIN_PASSWORD:-}" ] && [ "${FB_SYNC_ADMIN_PASSWORD:-true}" = "true" ]; then
        log "Sincronizando senha de '$ADMIN_USER' com FB_ADMIN_PASSWORD..."
        "${FB[@]}" users update "$ADMIN_USER" --password "$FB_ADMIN_PASSWORD" >/dev/null
    fi
fi

log "Aplicando baseURL=$BASEURL e branding..."
"${FB[@]}" config set --baseurl "$BASEURL"     --branding.name "$BRANDING"     --branding.files /branding     --branding.disableExternal     --locale "${FB_LOCALE:-pt-br}" >/dev/null


# ------------------------------------------------------------
# Processos
# ------------------------------------------------------------
nginx -t -q

log "Iniciando File Browser em 127.0.0.1:8080 (usuário nginx)..."
"${FB[@]}" -r /srv -p 8080 -a 127.0.0.1 &
FB_PID=$!

log "Iniciando NGINX em 0.0.0.0:80..."
nginx -g 'daemon off;' &
NGINX_PID=$!

shutdown() {
    kill -TERM "$FB_PID" "$NGINX_PID" 2>/dev/null || true
    wait "$FB_PID" "$NGINX_PID" 2>/dev/null || true
}

on_signal() {
    log "Sinal de encerramento recebido. Parando serviços..."
    shutdown
    exit 0
}
trap on_signal TERM INT

log "Pronto. Site: /   File Browser: $BASEURL/"

code=0
wait -n "$FB_PID" "$NGINX_PID" || code=$?
log "Um dos processos encerrou (código $code). Derrubando o container..."
shutdown
exit "$code"
