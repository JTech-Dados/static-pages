# PRD — static-pages

> O "porquê". Atualize quando mudar o problema, o público ou o escopo.

## Problema

Times internos produzem páginas HTML (dashboards exportados, relatórios, protótipos, landings) e precisam de **um lugar para publicar e ter uma URL**, sem depender de SSH, `scp`, pipeline ou de alguém de infraestrutura a cada atualização.

## Para quem

| Público | Precisa de |
|---|---|
| **Quem publica** (membros de times) | subir/editar o HTML pelo navegador, só na pasta do seu time |
| **Quem consome** (qualquer pessoa com o link) | abrir a página rápido; achar o que existe pela home |
| **Admin** (dono do servidor) | criar times, dar/retirar acesso, ver quem mudou o quê, recuperar o que foi apagado |

## O que o produto faz

1. Serve qualquer pasta como site (`/pasta/` → `pasta/index.html`).
2. Painel `/admin` (File Browser) para enviar, editar e organizar arquivos.
3. **Times**: cada time é uma pasta; membros só enxergam a pasta do time.
4. **Home automática**: lista as páginas por time, sem editar HTML.
5. **Segurança**: site isolado do painel (CSP sandbox), login com limite de tentativas, dotfiles e pastas internas bloqueados.
6. **Login Microsoft no painel** (opcional): membros entram com a conta corporativa; quem não tem acesso pede e o admin aprova e escolhe o time.
7. **Cota por time**: espaço visível no menu e upload acima da cota recusado.
8. **Rastreabilidade e recuperação**: autoria por arquivo, histórico de atividade, lixeira com restauração, backup diário.
9. **Visitas**: contagem de acessos por página (30 dias).

## Fora do escopo (hoje)

- **Controle de quem VÊ** as páginas: o site é público para quem tem a URL (o guia `/_ajuda/` avisa). Login de leitura por site/time (Entra ID) está no TASKS, com o desenho em `specs/2026-10-22-entra-por-site-ADIADA.md`; no painel `/admin` o login Microsoft existe.
- Build de sites (SSG, npm, frameworks): só servimos arquivos prontos.
- Edição colaborativa em tempo real e versionamento de arquivo (além da lixeira).
- HTTPS dentro do container: é responsabilidade do proxy da VPS.

## Métricas de sucesso

- Publicar/atualizar uma página leva minutos, sem envolver infraestrutura.
- Nenhuma página publicada por upload consegue ler a sessão do admin.
- Nada apagado no painel é irrecuperável por 30 dias.
- CI verde antes de cada atualização da VPS.
