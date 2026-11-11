# Distributed Wagering Processor 🦧

Serviço financeiro distribuído para processamento de transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) de múltiplos provedores de jogos, construído com **Bun 1.x**, **TypeScript (strict mode)**, **NestJS**, **MikroORM**, **PostgreSQL 16** e **AWS SQS (LocalStack)**.

---

## Pré-requisitos

- **Bun** `>= 1.1` (testado com `1.4.4`)
- **Docker** e **Docker Compose** (v2)

---

## Como Subir o Ambiente do Zero

1. **Instale as dependências**:
   ```bash
   bun install
   ```

2. **(Opcional) Crie o arquivo `.env` a partir do template**:
   > O projeto já possui defaults idênticos ao `.env.example` em `src/infrastructure/config/env.config.ts`, funcionando out-of-the-box mesmo sem `.env`.
   >
   > **Conflito na porta `5432` do PostgreSQL**: se a porta `5432` do host já estiver ocupada por outro Postgres local ou container, defina `DB_PORT` (ex.: `DB_PORT=5434`) no `.env` ou nas variáveis de ambiente do shell. Tanto o `docker-compose.yml` (`${DB_PORT:-5432}:5432`) quanto as migrations e todos os testes respeitam `DB_PORT`.
   ```bash
   cp .env.example .env
   ```

3. **Suba a infraestrutura (PostgreSQL 16.4 + LocalStack 3.7.2 com filas SQS FIFO)**:
   ```bash
   docker compose up -d --wait
   ```
   O hook `/etc/localstack/init/ready.d/init-sqs.sh` provisiona automaticamente:
   - `wager-transactions-dlq.fifo` (Dead-Letter Queue FIFO)
   - `wager-transactions.fifo` (Fila principal FIFO com `RedrivePolicy` para a DLQ após `maxReceiveCount = 3`)
   - `wager-events.fifo` (Fila FIFO dedicada para publicação dos eventos de integração do Outbox)

4. **Aplique as migrations e valide o projeto**:
   > Use **`bun run test`** (e não `bun test` direto sem filtro): `bun test` dispara todos os arquivos em `test/` simultaneamente contra o mesmo PostgreSQL/LocalStack, enquanto os scripts `bun run test*` aguardam a infraestrutura e executam cada suíte de forma isolada e sequencial.
   ```bash
   bun run migration:up
   bun run lint
   bun run typecheck
   bun run build
   bun run test
   bun run test:concurrency
   bun run test:load
   ```

5. **Inicie a aplicação em modo desenvolvimento**:
   ```bash
   bun run start:dev
   ```

---

## Comandos Disponíveis

| Comando | Descrição |
| :--- | :--- |
| `bun run start` | Inicia o servidor HTTP NestJS |
| `bun run start:dev` | Inicia em modo watch |
| `bun run build` | Compila o projeto TypeScript (`tsconfig.build.json`) |
| `bun run lint` | Executa Biome (`check`) + TypeScript (`tsc --noEmit`) |
| `bun run lint:fix` | Aplica correções automáticas de lint e formatação |
| `bun run typecheck` | Validação estrita de tipos (`tsc --noEmit`) |
| `bun run infra:up` | Sobe containers Docker e aguarda healthchecks (`--wait`) |
| `bun run infra:down` | Remove containers e volumes (`docker compose down -v`) |
| `bun run infra:wait` | Aguarda ativamente PostgreSQL e filas SQS ficarem prontos |
| `bun run test` | Executa em sequência `test:unit` + `test:integration` |
| `bun run test:unit` | Executa apenas testes unitários (`test/unit`) |
| `bun run test:integration` | Aguarda infraestrutura e executa testes de integração reais (`test/integration`) |
| `bun run test:concurrency` | Aguarda infraestrutura e executa testes de concorrência (`test/concurrency`) |
| `bun run test:load` | Executa teste de carga HTTP + SQS (`scripts/load-test.ts`) e reconcilia 100% das carteiras |
| `bun run migration:up` | Aplica migrations pendentes no PostgreSQL |
| `bun run migration:down` | Reverte a última migration aplicada |
| `bun run migration:status` | Lista migrations aplicadas e pendentes |

---

## Endpoints HTTP

### Wallets, Transações, Consultas e Reconciliação
> Rotas de domínio passam pelo ponto de extensão explícito `NoopProviderAuthGuard` / `ProviderIdentityPort` (Seção 2 de `docs/CHALLENGE.md`).

- `POST /wallets` — Cria carteira (`201 Created`; se `initialBalance > 0`, cria `OPENING` + `CREDIT` no ledger).
- `GET /wallets/:walletId` — Consulta saldo e versão da carteira.
- `GET /wallets/:walletId/ledger?cursor=...&limit=50` — Lista entradas imutáveis do ledger com cursor opaco estável.
- `POST /wallets/:walletId/reconciliation` — Compara saldo materializado vs soma do ledger (sem correção silenciosa; incrementa métrica e emite log em caso de divergência).
- `POST /wagering/transactions` — Submete `BET`, `WIN`, `LOSS`, `REFUND` ou `ROLLBACK` (`Idempotency-Key` obrigatório; aceita `x-correlation-id` opcional; retorna `200`, `202` se `PENDING_REFERENCE`, `422` se `REJECTED`, `409` se conflito, `503` com `Retry-After` em `WALLET_LOCK_TIMEOUT`).
- `GET /wagering/transactions/:transactionId` — Consulta transação por ID interno.
- `GET /providers/:providerId/wagering/transactions/:externalTransactionId` — Consulta transação por `(providerId, externalTransactionId)`.

### Health Checks & Observabilidade (abertos sem autenticação)
- `GET /health/live` — Liveness probe (processo ativo e uptime).
- `GET /health/ready` (e alias `GET /health`) — Readiness probe (`SELECT 1` no PostgreSQL via MikroORM e verificação de conectividade + atributos FIFO/RedrivePolicy de `wager-transactions.fifo`, `wager-transactions-dlq.fifo` e `wager-events.fifo` no AWS SQS).
- `GET /metrics` — Exposição Prometheus (`text/plain; version=0.0.4`) ou JSON (`?format=json`) com contadores de transações por status/tipo, duplicatas, retries, roteamentos DLQ, conflitos de lock, divergências de reconciliação, histograma de latência, outbox lag e profundidade aproximada da DLQ (com cache de 3s e tolerância a falha isolada de Postgres/SQS).
- **Logs estruturados (JSON)**: emitidos por `JsonStructuredLogger` contendo `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId` e `idempotencyKey`, com redação automática impedindo vazamento de valores monetários (`amount`, `money`, `balance`, `storedBalance`) ou segredos.

---

## Mensageria Assíncrona (SQS FIFO, Inbox e Outbox)

- **Entrada**: fila `wager-transactions.fifo` (`RedrivePolicy` com `maxReceiveCount = 3` para `wager-transactions-dlq.fifo`), consumida por `SqsWagerConsumerService` agrupando lotes por `MessageGroupId = walletId` com concorrência limitada entre carteiras e ordenação sequencial intra-carteira.
- **Deduplicação**: `inbox_messages` (`consumer_name`, `message_id`) gravada na mesma transação SQL que o processamento da transação; `DeleteMessage` só executa após o `COMMIT`.
- **Saída (`Transactional Outbox`)**: `WagerTransactionProcessed`, `WagerTransactionRejected`, `WalletBalanceChanged` e `WagerTransactionPendingReference` persistidos em `outbox_messages` na mesma transação e publicados em `wager-events.fifo` por `OutboxPublisherWorker` (`FOR UPDATE SKIP LOCKED`, backoff exponencial, `MessageGroupId = aggregateId`, `MessageDeduplicationId = eventId`).

---

## Variáveis de Ambiente (`.env.example`)

| Variável | Padrão | Descrição |
| :--- | :--- | :--- |
| `NODE_ENV` / `PORT` / `LOG_LEVEL` | `development` / `3000` / `info` | Ambiente, porta HTTP e nível de log |
| `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_NAME` | `127.0.0.1` / `5432` / `jungle` / `jungle_secret` / `jungle_wagering` | Conexão PostgreSQL |
| `DB_POOL_MIN` / `DB_POOL_MAX` | `2` / `20` | Limites do pool de conexões MikroORM |
| `DB_LOCK_TIMEOUT_MS` | `3000` | Timeout transacional `SET LOCAL lock_timeout` (ms) para `SELECT ... FOR UPDATE` |
| `PENDING_REF_WORKER_ENABLED` / `POLL_INTERVAL_MS` / `BATCH_SIZE` | `true` / `1000` / `50` | Worker de reprocessamento de `PENDING_REFERENCE` |
| `PENDING_REF_BASE_DELAY_MS` / `MAX_DELAY_MS` / `MAX_ATTEMPTS` / `TTL_MS` | `1000` / `30000` / `5` / `300000` | Backoff exponencial e limite de exaustão (5 tentativas ou 5 min) |
| `AWS_REGION` / `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `SQS_ENDPOINT` | `us-east-1` / `test` / `test` / `http://127.0.0.1:4566` | Cliente SQS apontando para LocalStack |
| `SQS_WAGER_QUEUE_NAME` / `SQS_WAGER_DLQ_NAME` / `SQS_EVENTS_QUEUE_NAME` | `wager-transactions.fifo` / `wager-transactions-dlq.fifo` / `wager-events.fifo` | Filas FIFO de entrada, DLQ e saída de eventos |
| `SQS_MAX_RECEIVE_COUNT` / `SQS_CONSUMER_VISIBILITY_TIMEOUT_SEC` | `3` / `30` | Limite antes da DLQ e visibilidade (`>> lock_timeout`) |
| `SQS_CONSUMER_ENABLED` / `BATCH_SIZE` / `CONCURRENCY` / `POLL_INTERVAL_MS` | `true` / `10` / `5` / `50` | Parâmetros do `SqsWagerConsumerService` |
| `OUTBOX_PUBLISHER_ENABLED` / `POLL_INTERVAL_MS` / `BATCH_SIZE` / `BASE_DELAY_MS` / `MAX_DELAY_MS` | `true` / `200` / `50` / `500` / `30000` | Publicador da tabela `outbox_messages` para `wager-events.fifo` |
| `LOAD_COLD_WALLETS` / `LOAD_HOT_WALLETS` / `LOAD_HTTP_OPS` / `LOAD_HTTP_CONCURRENCY` / `LOAD_SQS_OPS` | `30` / `3` / `600` / `24` / `90` | Sobrescritas opcionais de intensidade para `bun run test:load` |

---

## Estrutura de Pastas

```text
├── docs/
│   └── CHALLENGE.md               # Especificação completa do desafio
├── docker/
│   └── localstack/
│       └── init-sqs.sh            # Provisionamento automático das filas SQS FIFO + DLQ + Eventos
├── scripts/
│   ├── wait-for-infra.ts          # Polling de prontidão de Postgres + SQS antes dos testes
│   └── migrations.ts              # CLI de execução de migrations reversíveis
├── src/
│   ├── domain/                    # Entidades ricas, Value Objects (Money), eventos e regras (puro TS)
│   ├── application/               # Use cases compartilhados (HTTP + SQS), Outbox publisher e portas
│   ├── infrastructure/            # MikroORM, Postgres, SQS client/publisher, workers, config, health
│   ├── presentation/              # Controllers HTTP, consumer SQS FIFO, exception filters
│   └── migrations/                # Migrations versionadas e reversíveis (up / down)
├── test/
│   ├── unit/                      # Testes de unidade isolados e rápidos
│   ├── integration/               # Testes de integração com PostgreSQL e LocalStack reais
│   └── concurrency/               # Testes de corrida e paralelismo real (HTTP + SQS + Outbox)
├── AGENTS.md                      # Regras fixas e fluxo de trabalho por sprint
├── ARCHITECTURE.md                # Decisões arquiteturais, trade-offs e justificativas
└── docker-compose.yml             # Orquestração local com imagens fixadas
```

