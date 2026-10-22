#!/usr/bin/env bash
# ============================================================
# Startup
#
# - Popula /srv com /seed (home, 404 e favicon só com HOME_FROM_SRV=true)
# - Corrige dono de /srv e /database (só o que precisa)
# - Gera snippet de isolamento (CSP sandbox) do site
# - Gera snippet do prefixo público (SP_BASE, ex.: /pages)
# - Cria a conta técnica sp-svc (senha aleatória a cada boot) e sobe o
#   sp-auth, a ponte do login Microsoft
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
# Prefixo público do app atrás do proxy (vazio = raiz). Sem barra final.
SP_BASE="${SP_BASE:-}"
SP_BASE="${SP_BASE%/}"
if [ -n "$SP_BASE" ] && ! printf '%s' "$SP_BASE" | grep -Eq '^(/[A-Za-z0-9_-]+)+$'; then
    echo "[startup] SP_BASE inválido: '$SP_BASE' (use algo como /pages, só letras, números, _ e -)" >&2
    exit 1
fi
BASEURL="${SP_BASE}/admin"
BRANDING="${FB_BRANDING_NAME:-Static Pages}"
FB=(su-exec nginx:nginx filebrowser -d "$DB")

log "Inicializando container..."
log "Usuário administrativo: $ADMIN_USER"
log "Prefixo público: ${SP_BASE:-<raiz>}"
log "Base URL do File Browser: $BASEURL"


# ------------------------------------------------------------
# /srv
# ------------------------------------------------------------
# index.html, 404.html e favicon.svg NÃO são semeados: por padrão o NGINX os serve da
# imagem (/usr/share/static-pages/home), então cada deploy os atualiza. Com
# HOME_FROM_SRV=true eles são semeados e servidos do /srv (editáveis pelo painel).
# O resto de /seed (ex.: robots.txt) só entra se ainda não existir em /srv.
for f in /seed/* /seed/.[!.]*; do
    [ -e "$f" ] || continue
    case "$(basename "$f")" in index.html|404.html|favicon.svg) [ "${HOME_FROM_SRV:-false}" = "true" ] || continue ;; esac
    # loop explícito: o "cp -n" do busybox não é confiável aqui
    [ -e "/srv/$(basename "$f")" ] || cp -r "$f" /srv/
done
if [ "${HOME_FROM_SRV:-false}" = "true" ]; then
    echo 'root /srv;' > /etc/nginx/snippets/home-root.conf
    log "Home, 404 e favicon: servidos do /srv (HOME_FROM_SRV=true)"
else
    echo 'root /usr/share/static-pages/home;' > /etc/nginx/snippets/home-root.conf
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
# Prefixo público
#
# Um proxy pode publicar o app em /<SP_BASE>/ sem reescrever
# nada. Aqui o NGINX recebe a URI completa, guarda o prefixo em
# $sp_base e o remove antes de escolher o location (ver
# conf/nginx/default.conf). Vazio = app na raiz.
# ------------------------------------------------------------
{
    echo "set \$sp_base \"$SP_BASE\";"
    if [ -n "$SP_BASE" ]; then
        echo "rewrite ^${SP_BASE}(/.*)\$ \$1;"
        echo "location = ${SP_BASE} { return 301 ${SP_BASE}/; }"
    fi
} > /etc/nginx/snippets/base.conf

# SITE_NOINDEX=true => X-Robots-Tag: noindex em tudo (conteúdo interno, fora de buscadores)
if [ "${SITE_NOINDEX:-false}" = "true" ]; then
    echo 'add_header X-Robots-Tag "noindex, nofollow" always;' > /etc/nginx/snippets/noindex.conf
else
    : > /etc/nginx/snippets/noindex.conf
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

log "Aplicando baseURL=$BASEURL, branding e cadastro desligado..."
# --signup=false: ninguém cria conta pela tela de login; usuários
# só entram pelo admin (Configurações ou tela de Times). Reaplicado
# a cada boot para não depender de lembrar de desmarcar na UI.
"${FB[@]}" config set \
    --baseurl "$BASEURL" \
    --branding.name "$BRANDING" \
    --branding.files /branding \
    --branding.disableExternal \
    --locale "${FB_LOCALE:-pt-br}" \
    --signup=false \
    --shell "sh -c" >/dev/null

# Conta técnica do sp-auth (login Microsoft): admin do File Browser usada só
# por ele para listar usuários e trocar senhas. Senha nova a cada boot, num
# arquivo que só o usuário nginx lê (fora de qualquer pasta servida).
SVC_PASS="$(head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c 32)"
if "${FB[@]}" users ls 2>/dev/null | awk '{print $2}' | grep -qx sp-svc; then
    "${FB[@]}" users update sp-svc --password "$SVC_PASS" >/dev/null
else
    "${FB[@]}" users add sp-svc "$SVC_PASS" --perm.admin=true >/dev/null
fi
mkdir -p /run/sp-auth && chown nginx:nginx /run/sp-auth && chmod 700 /run/sp-auth
printf 'sp-svc\n%s\n' "$SVC_PASS" > /run/sp-auth/svc
chown nginx:nginx /run/sp-auth/svc && chmod 600 /run/sp-auth/svc
unset SVC_PASS

# Hooks (idempotente: só adiciona o que ainda não está registrado)
#   sp-autoria  -> coluna "Alterado por" + /database/auditoria.log
#   sp-lixeira  -> copia para /srv/_lixeira antes de apagar
log "Registrando hooks de autoria e lixeira..."
HOOKS="$("${FB[@]}" cmds ls 2>/dev/null || true)"
for par in after_upload:sp-autoria after_save:sp-autoria after_rename:sp-autoria \
           after_delete:sp-autoria after_copy:sp-autoria before_delete:sp-lixeira; do
    evento="${par%%:*}"; cmd="${par#*:}"
    if ! printf '%s\n' "$HOOKS" | grep -q "$evento.*$cmd"; then
        "${FB[@]}" cmds add "$evento" "$cmd" >/dev/null
    fi
done

# Lixeira: apaga lotes com mais de LIXEIRA_DIAS dias (1x por dia)
LIXEIRA_DIAS="${LIXEIRA_DIAS:-30}"
case "$LIXEIRA_DIAS" in ''|*[!0-9]*) LIXEIRA_DIAS=30 ;; esac
mkdir -p /srv/_lixeira && chown nginx:nginx /srv/_lixeira
(
    while true; do
        find /srv/_lixeira -mindepth 1 -maxdepth 1 -type d -mtime +"$LIXEIRA_DIAS" -exec rm -rf {} + 2>/dev/null
        # lotes esvaziados por restaurações
        find /srv/_lixeira -mindepth 1 -type d -empty -delete 2>/dev/null
        # mantém no .registro só o que ainda está na lixeira
        if [ -f /srv/_lixeira/.registro ]; then
            TAB="$(printf '\t')"
            while IFS="$TAB" read -r q u o l; do
                [ -e "/srv$l" ] && printf '%s\t%s\t%s\t%s\n' "$q" "$u" "$o" "$l"
            done < /srv/_lixeira/.registro > /srv/_lixeira/.registro.tmp
            mv /srv/_lixeira/.registro.tmp /srv/_lixeira/.registro
            chown nginx:nginx /srv/_lixeira/.registro
        fi
        sleep 86400
    done
) &
log "Lixeira: itens ficam $LIXEIRA_DIAS dias."

# Visitas: agrega o log do NGINX em /database/visitas.json (a cada 5 min)
sp-visitas
( while true; do sleep 300; sp-visitas; done ) &
log "Contador de visitas ativo (últimos ${VISITAS_DIAS:-30} dias)."


# ------------------------------------------------------------
# Processos
# ------------------------------------------------------------
nginx -t -q

log "Iniciando File Browser em 127.0.0.1:8080 (usuário nginx)..."
"${FB[@]}" -r /srv -p 8080 -a 127.0.0.1 &
FB_PID=$!

# sp-auth: se cair, volta sozinho (o site e o painel não dependem dele)
(
    while true; do
        su-exec nginx:nginx node /usr/local/lib/sp-auth.js || true
        sleep 2
    done
) &
SPAUTH_LOOP=$!

log "Iniciando NGINX em 0.0.0.0:80..."
nginx -g 'daemon off;' &
NGINX_PID=$!

shutdown() {
    kill -TERM "$SPAUTH_LOOP" 2>/dev/null || true
    pkill -TERM -f sp-auth.js 2>/dev/null || true
    kill -TERM "$FB_PID" "$NGINX_PID" 2>/dev/null || true
    wait "$FB_PID" "$NGINX_PID" 2>/dev/null || true
}

on_signal() {
    log "Sinal de encerramento recebido. Parando serviços..."
    shutdown
    exit 0
}
trap on_signal TERM INT

log "Pronto. Site: ${SP_BASE}/   File Browser: $BASEURL/"

code=0
wait -n "$FB_PID" "$NGINX_PID" || code=$?
log "Um dos processos encerrou (código $code). Derrubando o container..."
shutdown
exit "$code"
