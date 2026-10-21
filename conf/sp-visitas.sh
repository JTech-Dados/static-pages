#!/bin/sh
# ============================================================
# Agrega /database/visitas.log (NGINX, uma linha por visita:
# "<ISO-8601>\t<uri>") em /database/visitas.json:
#
#   { "atualizado": "...", "dias": 30,
#     "paginas": { "/time/pagina/": 123, ... } }
#
# Normaliza /x/index.html -> /x/ (é assim que a home linka).
# Roda a cada 5 min pelo entrypoint. Mantém no log só os últimos
# VISITAS_RETER dias para ele não crescer sem limite.
# ============================================================
set -u

LOG=/database/visitas.log
OUT=/database/visitas.json
DIAS="${VISITAS_DIAS:-30}"
RETER="${VISITAS_RETER:-120}"

[ -f "$LOG" ] || : > "$LOG"
agora="$(date -u +%s)"
corte="$(date -u -d "@$((agora - DIAS * 86400))" +%Y-%m-%dT%H:%M:%S)"
corte_log="$(date -u -d "@$((agora - RETER * 86400))" +%Y-%m-%dT%H:%M:%S)"

awk -F '\t' -v corte="$corte" -v quando="$(date -u +%Y-%m-%dT%H:%M:%SZ)" -v dias="$DIAS" '
    $1 >= corte {
        uri = $2
        sub(/[iI][nN][dD][eE][xX]\.[hH][tT][mM][lL]?$/, "", uri)
        n[uri]++
    }
    END {
        printf "{\"atualizado\":\"%s\",\"dias\":%d,\"paginas\":{", quando, dias
        sep = ""
        for (u in n) {
            gsub(/\\/, "\\\\", u); gsub(/"/, "\\\"", u)
            printf "%s\"%s\":%d", sep, u, n[u]
            sep = ","
        }
        printf "}}\n"
    }' "$LOG" > "$OUT.tmp" && mv "$OUT.tmp" "$OUT"
chmod 644 "$OUT"

# poda o log (mantém RETER dias) quando passar de ~20 MB
if [ "$(wc -c < "$LOG")" -gt 20000000 ]; then
    awk -F '\t' -v corte="$corte_log" '$1 >= corte' "$LOG" > "$LOG.tmp" && cat "$LOG.tmp" > "$LOG" && rm -f "$LOG.tmp"
fi
exit 0
