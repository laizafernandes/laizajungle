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
   > O projeto já possui defaults idênticos ao `.env.example` em `src/infrastructure/config/env.config.ts`, funcionando out-of-the-box mesmo sem `.env`. Caso a porta `5432` já esteja ocupada na sua máquina, ajuste `DB_PORT` no `.env` (o `docker-compose.yml` e os testes respeitam a mesma variável).
   ```bash
   cp .env.example .env
   ```

3. **Suba a infraestrutura (PostgreSQL 16.4 + LocalStack 3.7.2 com filas SQS FIFO e DLQ)**:
   ```bash
   docker compose up -d
   ```
   O hook `/etc/localstack/init/ready.d/init-sqs.sh` provisiona automaticamente:
   - `wager-transactions-dlq.fifo` (Dead-Letter Queue FIFO)
   - `wager-transactions.fifo` (Fila principal FIFO com `RedrivePolicy` apontando para a DLQ após `maxReceiveCount = 3`)

4. **Rode os testes de integração (aguarda automaticamente os containers ficarem saudáveis)**:
   ```bash
   bun run test:integration
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
| `bun test` | Executa suíte de testes unitários + integração |
| `bun run test:unit` | Executa apenas testes unitários (`test/unit`) |
| `bun run test:integration` | Aguarda infraestrutura e executa testes de integração reais (`test/integration`) |
| `bun run test:concurrency` | Aguarda infraestrutura e executa testes de concorrência (`test/concurrency`) |
| `bun run test:load` | Executa harness de teste de carga |
| `bun run migration:up` | Aplica migrations pendentes no PostgreSQL |
| `bun run migration:down` | Reverte a última migration aplicada |
| `bun run migration:status` | Lista migrations aplicadas e pendentes |

---

## Endpoints HTTP

### Wallets, Transações, Consultas e Reconciliação
- `POST /wallets` — Cria carteira (`201 Created`; se `initialBalance > 0`, cria `OPENING` + `CREDIT` no ledger).
- `GET /wallets/:walletId` — Consulta saldo e versão da carteira.
- `GET /wallets/:walletId/ledger?cursor=...&limit=50` — Lista entradas imutáveis do ledger com cursor opaco estável.
- `POST /wallets/:walletId/reconciliation` — Compara saldo materializado vs soma do ledger (sem correção silenciosa).
- `POST /wagering/transactions` — Submete `BET`, `WIN`, `LOSS`, `REFUND` ou `ROLLBACK` (`Idempotency-Key` obrigatório; retorna `200`, `202` se `PENDING_REFERENCE`, `422` se `REJECTED`, `409` se conflito).
- `GET /wagering/transactions/:transactionId` — Consulta transação por ID interno.
- `GET /providers/:providerId/wagering/transactions/:externalTransactionId` — Consulta transação por `(providerId, externalTransactionId)`.

### Health Checks (abertos sem autenticação)
- `GET /health/live` — Liveness probe (processo ativo e uptime).
- `GET /health/ready` (e alias `GET /health`) — Readiness probe (executa `SELECT 1` no PostgreSQL via MikroORM e valida conectividade + existência das filas `wager-transactions.fifo`, `wager-transactions-dlq.fifo` e `wager-events.fifo` no AWS SQS).

---

## Mensageria Assíncrona (SQS FIFO, Inbox e Outbox)

- **Entrada**: fila `wager-transactions.fifo` (`RedrivePolicy` com `maxReceiveCount = 3` para `wager-transactions-dlq.fifo`), consumida por `SqsWagerConsumerService` agrupando lotes por `MessageGroupId = walletId` com concorrência limitada entre carteiras e ordenação sequencial intra-carteira.
- **Deduplicação**: `inbox_messages` (`consumer_name`, `message_id`) gravada na mesma transação SQL que o processamento da transação; `DeleteMessage` só executa após o `COMMIT`.
- **Saída (`Transactional Outbox`)**: `WagerTransactionProcessed`, `WagerTransactionRejected`, `WalletBalanceChanged` e `WagerTransactionPendingReference` persistidos em `outbox_messages` na mesma transação e publicados em `wager-events.fifo` por `OutboxPublisherWorker` (`FOR UPDATE SKIP LOCKED`, backoff exponencial, `MessageGroupId = aggregateId`, `MessageDeduplicationId = eventId`).

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

