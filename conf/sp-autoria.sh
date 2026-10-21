#!/bin/sh
# ============================================================
# Hook do File Browser: registra QUEM alterou cada arquivo.
#
# Chamado pelo File Browser depois de upload, save, rename e
# delete (ver entrypoint.sh). Variáveis recebidas do runner:
#   FILE         caminho absoluto do arquivo afetado
#   DESTINATION  novo caminho (rename/copy)
#   USERNAME     usuário que fez a ação
#   TRIGGER      evento (after_upload, after_save, ...)
#
# Grava em dois lugares:
#   <pasta>/.autoria           último autor por arquivo (lido pelo
#                              painel para a coluna "Alterado por";
#                              dotfile = 404 no site público)
#   /database/auditoria.log    histórico completo (fora do site)
# ============================================================
set -u

[ -n "${SP_AUTORIA_DEBUG:-}" ] && env | sort > /database/_hook-debug.txt

# DESTINATION só tem sentido em rename/copy: nos outros eventos o
# File Browser envia a raiz (/srv), que não é o arquivo afetado.
case "${TRIGGER:-}" in
    *rename|*copy) destino="${DESTINATION:-}" ;;
    *)             destino="" ;;
esac
alvo="${destino:-${FILE:-}}"
[ -n "$alvo" ] || exit 0
case "$alvo" in /srv/*) ;; *) exit 0 ;; esac

quando="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
quem="${USERNAME:-?}"
evento="${TRIGGER:-?}"
pasta="$(dirname "$alvo")"
nome="$(basename "$alvo")"

# mexer na lixeira não é atividade de conteúdo; restaurar (rename
# saindo de lá) é registrado normalmente pelo destino
case "$alvo" in /srv/_lixeira|/srv/_lixeira/*) exit 0 ;; esac

# o próprio registro não entra no histórico
case "$nome" in .autoria) exit 0 ;; esac

LIMITE=1000   # linhas mantidas por pasta

registro="$pasta/.autoria"
if [ -d "$pasta" ]; then
    printf '%s\t%s\t%s\t%s\n' "$nome" "$quem" "$quando" "$evento" >> "$registro"
    if [ "$(wc -l < "$registro")" -gt "$LIMITE" ]; then
        tail -n "$LIMITE" "$registro" > "$registro.tmp" && mv "$registro.tmp" "$registro"
    fi
fi

# rename: a origem também some da pasta antiga
if [ "${TRIGGER:-}" = "after_rename" ] && [ -n "$destino" ] && [ -n "${FILE:-}" ]; then
    origem="$(dirname "$FILE")"
    case "$origem" in /srv/_lixeira|/srv/_lixeira/*) origem="" ;; esac
    [ -n "$origem" ] && [ -d "$origem" ] && printf '%s\t%s\t%s\t%s\n' "$(basename "$FILE")" "$quem" "$quando" "renamed" >> "$origem/.autoria"
fi

printf '%s\t%s\t%s\t%s\t%s\n' "$quando" "$quem" "$evento" "${FILE:-}" "$destino" >> /database/auditoria.log
exit 0
