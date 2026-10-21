#!/bin/sh
# ============================================================
# Backup diário dos volumes do static-pages (serviço "backup").
#
#   /data/srv  (site, somente leitura)   -> srv/
#   /data/db   (usuários, logs; leitura) -> db/
#   /backups/static-pages-AAAA-MM-DD_HHMM.tar.gz
#
# Variáveis:
#   BACKUP_HORA       hora do dia (0-23, fuso de TZ)      padrão 3
#   BACKUP_MANTER     quantos arquivos manter             padrão 7
#   BACKUP_NA_SUBIDA  "true" = faz um backup ao iniciar   padrão true
# ============================================================
set -eu

HORA="${BACKUP_HORA:-3}"
MANTER="${BACKUP_MANTER:-7}"
case "$HORA" in ''|*[!0-9]*) HORA=3 ;; esac
case "$MANTER" in ''|*[!0-9]*) MANTER=7 ;; esac
[ "$MANTER" -ge 1 ] || MANTER=1

log() { echo "[backup] $(date '+%Y-%m-%d %H:%M') $*"; }

fazer_backup() {
    nome="static-pages-$(date +%Y-%m-%d_%H%M).tar.gz"
    tmp="/backups/.$nome.parcial"
    if tar -czf "$tmp" -C /data srv db; then
        mv "$tmp" "/backups/$nome"
        log "ok: $nome ($(du -h "/backups/$nome" | cut -f1))"
    else
        rm -f "$tmp"
        log "ERRO ao gerar $nome"
        return 1
    fi
    # mantém só os MANTER mais recentes
    ls -1t /backups/static-pages-*.tar.gz 2>/dev/null | tail -n +"$((MANTER + 1))" | while read -r velho; do
        rm -f "$velho" && log "removido: $(basename "$velho")"
    done
}

mkdir -p /backups
log "agendado para as ${HORA}h ($(date +%Z)), mantendo $MANTER arquivo(s)."
if [ "${BACKUP_NA_SUBIDA:-true}" = "true" ]; then fazer_backup || true; fi

ultimo=""
while true; do
    hoje="$(date +%Y-%m-%d)"
    agora="$(date +%H | sed 's/^0//')"
    if [ "$ultimo" != "$hoje" ] && [ "${agora:-0}" -eq "$HORA" ]; then
        fazer_backup || true
        ultimo="$hoje"
    fi
    sleep 600
done
