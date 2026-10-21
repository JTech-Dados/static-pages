#!/bin/sh
# ============================================================
# Hook do File Browser (before_delete): copia o que vai ser
# apagado para a lixeira antes da exclusão.
#
#   /srv/_lixeira/<AAAA-MM-DD>/<HHMMSS>-<id>/<caminho original>
#   /srv/_lixeira/.registro    quando  quem  original  na_lixeira
#
# A tela de Times lê o registro e restaura movendo o item de volta.
# Itens com mais de LIXEIRA_DIAS dias são apagados pelo entrypoint.
# O NGINX bloqueia /_lixeira/ no site público.
# ============================================================
set -u

LIXEIRA=/srv/_lixeira
alvo="${FILE:-}"
[ -n "$alvo" ] || exit 0
case "$alvo" in
    "$LIXEIRA"|"$LIXEIRA"/*) exit 0 ;;   # apagar da lixeira é definitivo
    /srv/*) ;;
    *) exit 0 ;;
esac
[ -e "$alvo" ] || exit 0

rel="${alvo#/srv/}"
dia="$(date -u +%Y-%m-%d)"
lote="$(date -u +%H%M%S)-$$"
destino="$LIXEIRA/$dia/$lote/$rel"

mkdir -p "$(dirname "$destino")" || exit 0
cp -a "$alvo" "$destino" || exit 0

printf '%s\t%s\t%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${USERNAME:-?}" "/$rel" "/${destino#/srv/}" >> "$LIXEIRA/.registro"
exit 0
