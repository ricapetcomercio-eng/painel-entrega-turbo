# Auditoria: `api/concorrentes.js`

Data: 06/out/2026 · Escopo: só leitura, nada foi alterado no arquivo nem nas dependências.

## TL;DR

**O endpoint não pode estar funcionando em produção da forma como está neste repo.**
Ele faz `require("redis")`, mas o pacote `redis` **não está** no `package.json` (e nunca
esteve, em nenhum commit). No deploy da Vercel isso deve gerar `Cannot find module 'redis'`
e erro 500 em toda chamada, GET ou POST. Também não há nenhuma referência a ele
dentro do repo. Conclusão: é **sobra do projeto `analise-concorrencia`**, sem uso aqui.
**Recomendação: pode remover**, depois das duas conferências rápidas da seção 5.

## 1. O que o arquivo faz

`api/concorrentes.js` (160 linhas) é um endpoint serverless que guarda snapshots do scraper
de concorrentes (Python/Playwright, rodando localmente) num Redis **próprio** (`REDIS_URL`,
cliente `redis` do node, conexão TCP), e não no Turso nem no Upstash REST usado no resto do repo.

| Método / rota | Auth | O que faz |
|---|---|---|
| `POST /api/concorrentes` | `Authorization: Bearer $CONCORRENTES_WEBHOOK_SECRET` | Recebe o payload do scraper (`{ categorias, concorrentes, coletado_em }`), grava em `concorrentes:ultimo_snapshot` e `concorrentes:historico:YYYY-MM-DD` e adiciona o dia ao set `concorrentes:datas` |
| `GET /api/concorrentes` | nenhuma | Devolve o último snapshot |
| `GET /api/concorrentes?data=YYYY-MM-DD` | nenhuma | Devolve o snapshot do dia |
| `GET /api/concorrentes?action=historico` | nenhuma | Posição por subcategoria/vendedor/dia (lê todos os dias do set) |
| `GET /api/concorrentes?action=historico_concorrentes` | nenhuma | Vendas/visitas/conversão por concorrente/produto/dia |

Quem deveria chamar: o **POST** viria do scraper local (comentário no topo: "chave que o scraper
local usa pra autenticar") e os **GETs** do frontend do painel de concorrência.

Chaves Redis usadas: `concorrentes:ultimo_snapshot`, `concorrentes:historico:<data>`,
`concorrentes:datas`. Nenhuma delas aparece em outro arquivo do repo.

## 2. Referências encontradas no repo

Busca por `concorrentes`, `/api/concorrentes`, `REDIS_URL`, `CONCORRENTES_WEBHOOK_SECRET`,
`require("redis")` em `api/`, `lib/`, `public/` (incluindo `public/assets/`), `scripts/`,
`package.json`, `vercel.json`, `README.md`:

| Onde | O que é | Chama o endpoint? |
|---|---|---|
| `CLAUDE.md:1118`, `:1354-1356`, `:1375` | Documentação já marcando o arquivo como "possível leftover" | Não |
| `CLAUDE.md:870`, `api/collect.js:25` | Citam o projeto `concorrentes-ml` como um dos que compartilhavam o Redis antigo | Não |
| `public/index.html:274`, `:851`, `:917`, `:2680-2688` | Menu "Concorrência": abre **`https://ricapet-concorrencia.vercel.app`** num `<iframe>` (`CONCORRENCIA_URL`) e conversa por `postMessage` | Não. O painel de concorrência é outro deploy, com a própria API |
| `public/{bipagem,ponto,acessos,estoque,estoque-saldo,projecao-financeira}.html` | Link `/?painel=concorrencia`, que só abre o mesmo iframe pelo `index.html` | Não |
| `public/acessos.html:205` | Chave de permissão `concorrencia` | Não |

**Nenhum `fetch('/api/concorrentes')` nem link para essa rota em lugar nenhum do repo.**
`vercel.json` está vazio (`{}`); `scripts/` não referencia.

## 3. Dependências

- `package.json` só tem `@upstash/redis`, `@libsql/client` e `undici`. **Falta o pacote `redis`**
  que o arquivo exige (`const { createClient } = require("redis")`). O repo também não tem
  `package-lock.json`.
- `git log -S'"redis"' -- package.json` não retorna nada: o pacote nunca foi declarado.
- Nada mais no repo usa `redis` (o node-redis), `REDIS_URL` ou `CONCORRENTES_WEBHOOK_SECRET`.
  O `lib/redis.js` legado usa `@upstash/redis` (REST), outra biblioteca e outras variáveis
  (`UPSTASH_REDIS_REST_*`). Remover `concorrentes.js` não afeta essa dependência.

## 4. Histórico

- Criado em `a870fa3` (15/jul/2026, "Add files via upload", upload pela interface do GitHub),
  2 dias depois do 1º commit do repo, num commit só com esse arquivo. **Nunca mais foi alterado.**
- O conteúdo (comentário "scraper local", tratamento de anúncios repetidos do ML) bate com o
  projeto `analise-concorrencia` / `ricapet-concorrencia.vercel.app`. O mais provável é que
  tenha sido enviado ao repo errado, ou copiado como referência.

## 5. Conclusão e recomendação

**Conclusão: não usado.** Nada no repo chama o endpoint, e mesmo uma chamada externa (o scraper
ou o painel `ricapet-concorrencia`) não funcionaria aqui: sem o pacote `redis` a função quebra
na importação. Se o scraper estiver configurado com a URL deste projeto, ele já está recebendo
erro há meses, e o painel de concorrência continua funcionando porque usa a própria API.

**Recomendação: remover** `api/concorrentes.js` e, na Vercel, as variáveis `REDIS_URL` e
`CONCORRENTES_WEBHOOK_SECRET` do projeto `ricapetadministrativo` (se existirem). Antes disso,
duas conferências rápidas (Claude Code não tem acesso à conta Vercel):

1. **Logs da Vercel** (`ricapetadministrativo` → Logs, filtrar `/api/concorrentes`, últimos dias):
   - nenhuma requisição → pode remover sem risco;
   - requisições com 500 / `Cannot find module 'redis'` → algo externo ainda aponta para cá
     (provavelmente o scraper). Ver o item 2 antes de remover.
2. **Configuração do scraper e do `analise-concorrencia`**: conferir para qual URL o scraper
   faz o POST, e se o repo `analise-concorrencia` tem o próprio `api/concorrentes.js`. Se o
   scraper apontar para `ricapetadministrativo.vercel.app`/`painel-entrega-turbo.vercel.app`,
   corrigir para `ricapet-concorrencia.vercel.app` (que é onde o painel lê os dados).

Também ajuda olhar Vercel → Project Settings → Environment Variables: se `REDIS_URL` nem existe
no `ricapetadministrativo`, o endpoint não teria como funcionar nem com o pacote instalado.

Depois da remoção, atualizar o `CLAUDE.md` (Estrutura de arquivos, variáveis de ambiente
e "Pendências conhecidas").
