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

restritos="$(ls -1 /database/restritos 2>/dev/null | tr '\n' ' ')"
# páginas restritas ("time/pagina", uma por linha; o nome pode ter espaço, então o separador é \034)
paginas="$(find /database/restritos/_p -mindepth 2 -maxdepth 2 -type f 2>/dev/null | sed 's#^/database/restritos/_p/##' | tr '\n' '\034')"

LC_ALL=C awk -F '\t' -v restritos="$restritos" -v paginas="$paginas" -v corte="$corte" -v quando="$(date -u +%Y-%m-%dT%H:%M:%SZ)" -v dias="$DIAS" '
    # O NGINX grava $uri com bytes fora do ASCII como \xHH (ex.: "ú" => \xC3\xBA), o que não é JSON válido.
    # Aqui viram %HH (a home decodifica); os nomes das páginas restritas passam pela mesma conversão.
    function enc(s,   i, c, o, out) {
        out = ""
        for (i = 1; i <= length(s); i++) {
            c = substr(s, i, 1); o = ord[c]
            out = out ((o < 32 || o >= 127 || c == "\"" || c == "\\") ? sprintf("%%%02X", o) : c)
        }
        return out
    }
    BEGIN {
        for (i = 1; i < 256; i++) ord[sprintf("%c", i)] = i
        nr = split(restritos, lista, " "); for (i = 1; i <= nr; i++) if (lista[i] != "") restrito[lista[i]] = 1
        np = split(paginas, pl, "\034"); for (i = 1; i <= np; i++) if (pl[i] != "") pagina_restrita[enc(pl[i])] = 1
    }
    $1 >= corte {
        uri = $2
        gsub(/\\x/, "%", uri)
        split(uri, seg, "/")
        if (seg[2] in restrito) next   # time restrito: a visita não aparece em /_visitas.json
        if ((seg[2] "/" seg[3]) in pagina_restrita) next   # página restrita também não
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
