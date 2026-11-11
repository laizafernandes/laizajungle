# Arquitetura Técnica — Distributed Wagering Processor

## Resumo Executivo

1. O **Distributed Wagering Processor** processa transações financeiras de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) via HTTP e AWS SQS FIFO com consistência transacional estrita em PostgreSQL 16.
2. Toda aritmética monetária usa o Value Object imutável `Money` (`decimal.js`, escala fixa de 2 casas decimais, `numeric(18,2)` no banco), sem tipos numéricos de ponto flutuante (`number`/`float`).
3. As invariantes críticas vivem no schema PostgreSQL (`CHECK`, `UNIQUE`, `FOREIGN KEY` e trigger de imutabilidade em `wallet_ledger_entries`), complementando as validações de domínio e aplicação.
4. Um único caso de uso (`ProcessWagerTransactionUseCase`) atende tanto à API HTTP quanto ao consumidor SQS, garantindo uma única regra de negócio e transação SQL atômica por operação.
5. A concorrência por carteira é serializada via lock pessimista (`SELECT ... FOR UPDATE` sob isolamento `READ COMMITTED`) com `SET LOCAL lock_timeout = 3000ms`, retornando HTTP `503` + `Retry-After` sob contenção extrema.
6. A idempotência combina `CanonicalPayloadHasher` (SHA-256), chaves únicas no banco (`idempotency_key` e `(provider_id, external_transaction_id)`), saldo histórico persistido (`resulting_balance_amount`) e resolução segura de colisões `23505`.
7. Operações fora de ordem entram como `PENDING_REFERENCE` (`202 Accepted`) e são resolvidas por worker com `FOR UPDATE SKIP LOCKED`, backoff exponencial e ordem global de locks `Wallet -> WagerTransaction`.
8. A mensageria assíncrona utiliza três filas FIFO (`wager-transactions.fifo`, `wager-transactions-dlq.fifo`, `wager-events.fifo`), deduplicação transacional em `inbox_messages` e `Outbox` com publicação *at-least-once*.
9. A observabilidade entrega logs JSON estruturados sem vazamento de valores monetários ou SQL bruto, métricas Prometheus de baixa cardinalidade (`/metrics`) e probes `/health/live` e `/health/ready`.
10. A solução foi validada contra PostgreSQL e LocalStack reais (sem mocks) nas suítes unitária, integração, concorrência multi-instância e carga (`231.59 req/s`, `0` inconsistências em `33/33` carteiras).

---

## 1. Visão Geral da Arquitetura

O serviço segue **DDD + Arquitetura Hexagonal (Ports & Adapters)** em quatro camadas, com regra de dependência apontando exclusivamente para o centro:

1. **Domínio (`src/domain/`)**: Value Objects (`Money`), agregados (`Wallet`, `WagerTransaction`), entidades (`WalletLedgerEntry`, `InboxMessage`, `OutboxMessage`), eventos de integração (`IntegrationEvent<T>`) e erros de domínio (`DomainError`). Não possui dependência de NestJS, MikroORM ou AWS SDK.
2. **Aplicação (`src/application/`)**: casos de uso (`OpenWalletUseCase`, `ProcessWagerTransactionUseCase`, `ProcessPendingReferencesUseCase`, `OutboxPublisherUseCase`, `ReconcileWalletUseCase`, `GetWalletUseCase`, `GetWalletLedgerUseCase`, `GetWagerTransactionUseCase`), serviços de domínio/aplicação (`WagerTransactionResolutionService`, `CanonicalPayloadHasher`, `PendingReferencePolicy`, `LedgerCursorCodec`) e portas (`wagering.ports.ts`, `observability.ports.ts`, `health-checker.port.ts`).
3. **Infraestrutura (`src/infrastructure/`)**: adaptadores MikroORM (`src/infrastructure/database/`), cliente e publicador SQS (`src/infrastructure/messaging/`), workers agendados (`PendingReferenceWorker`, `OutboxPublisherWorker`), health checks (`HealthService`) e observabilidade (`JsonStructuredLogger`, `PrometheusMetricsRegistry`).
4. **Apresentação (`src/presentation/`)**: controllers HTTP (`WalletsController`, `WageringController`, `ProvidersWageringController`, `HealthController`, `MetricsController`), parser de DTOs (`wagering.dto.ts`), `NoopProviderAuthGuard`, `DomainExceptionFilter` e `SqsWagerConsumerService`.

```text
  HTTP Client (Provider)                       SQS FIFO (wager-transactions.fifo)
         │                                                   │
         ▼ [NoopProviderAuthGuard]                           ▼ [SqsWagerConsumerService]
  WageringController                                 Agrupa por MessageGroupId = walletId
         │                                                   │ (ack somente pós-COMMIT;
         └──────────────► ProcessWagerTransactionUseCase ◄───┘  DLQ em falha permanente)
                                     │
                     Transação SQL Única (MikroORM + Postgres)
                     ├─ 0. inbox_messages (PK consumer_name, message_id)
                     ├─ 1. Fast-path idempotência (idempotency_key)
                     ├─ 2. SELECT ... FOR UPDATE (Wallet lock, timeout 3s)
                     ├─ 3. Regras (BET/WIN/LOSS/REFUND/ROLLBACK / PENDING_REF)
                     ├─ 4. wallet_ledger_entries (imutável via TRIGGER)
                     └─ 5. outbox_messages (4 IntegrationEvents)
                                     │
                 ┌───────────────────┴───────────────────┐
                 ▼                                       ▼
     PendingReferenceWorker                    OutboxPublisherWorker
  (Wallet -> Tx FOR UPDATE SKIP LOCKED)     (FOR UPDATE SKIP LOCKED -> wager-events.fifo)
```

### Fronteira de Autenticação

Os controllers de domínio (`WalletsController`, `WageringController`, `ProvidersWageringController`) aplicam `NoopProviderAuthGuard`, apoiado pela interface `ProviderIdentityPort` (`src/application/ports/observability.ports.ts`). Os endpoints operacionais (`/health/live`, `/health/ready`, `/health` e `/metrics`) permanecem abertos para probes e coleta. Para acoplar autenticação em produção (Keycloak/Zitadel via OIDC/JWKS ou assinatura HMAC), basta registrar uma implementação concreta de `ProviderIdentityPort` sem alterar os casos de uso.

---

## 2. Modelo Financeiro, Domínio e Garantias no Banco

### 2.1. Isolamento entre Domínio e Persistência

As entidades de domínio possuem construtores privados, factories explícitas (`open`, `create`, `createOpening`, `rehydrate`) e ausência de setters públicos. As entidades ORM (`WalletOrmEntity`, `WagerTransactionOrmEntity`, `WalletLedgerEntryOrmEntity`, `InboxMessageOrmEntity`, `OutboxMessageOrmEntity`) ficam isoladas em `src/infrastructure/database/entities/`, sendo convertidas via `WageringMapper` e `MessagingMapper`.

- **ORM escolhido**: **MikroORM 6.4.3** (`@mikro-orm/postgresql`) com `allowGlobalContext: false` (`src/infrastructure/database/mikro-orm.config.ts`). Foi adotado pelo controle explícito de `UnitOfWork`, contexto transacional explícito (`em.fork().transactional()`) e suporte nativo a `LockMode.PESSIMISTIC_WRITE` (`SELECT ... FOR UPDATE`).

### 2.2. Precisão Monetária e Limite `numeric(18,2)`

- **`Money` (`src/domain/value-objects/money.ts`)**: encapsula `Decimal` (`decimal.js` com `precision: 28` e `ROUND_HALF_EVEN`) e código ISO-4217 (`^[A-Z]{3}$`).
- **Normalização de entrada e rejeição de sub-centavos**: `Money.from({ amount, currency })` aceita strings decimais não-negativas com `0` a `2` casas decimais (`/^\d+(?:\.\d{1,2})?$/`, normalizando `"25"` para `"25.00"`) e rejeita `number`, strings vazias, sinais, `NaN`, `Infinity`, notação científica e valores com mais de 2 casas decimais (`"25.001"`). Caso um cliente exija estritamente 2 casas na entrada, basta substituir a regex por `\.\d{2}`.
- **Limite máximo do schema (`MAX_MONEY_AMOUNT = '9999999999999999.99'`)**:
  - `Money.from` rejeita valores isolados acima de `numeric(18,2)` com `InvalidMoneyError` (HTTP `400 INVALID_MONEY`).
  - `Wallet.open` e `Wallet.credit` verificam se o saldo resultante ultrapassa `9999999999999999.99`, lançando `BalanceLimitExceededError` (`BALANCE_LIMIT_EXCEEDED`), mapeado para HTTP `422` (sem persistir a transação — rollback atômico) e classificado como permanente no SQS. Optou-se por `422 BALANCE_LIMIT_EXCEEDED` em vez de introduzir um novo `FailureCode` na tabela `wager_transactions`, preservando a taxonomia fechada do contrato.
- **Persistência sem ponto flutuante**: todas as colunas monetárias usam `numeric(18,2)` no PostgreSQL e `type: 'string'` no MikroORM, sendo reconstruídas via `Money.rehydrate()`.

### 2.3. Máquina de Estados e `FailureCode`

- **Transições de `WagerTransaction`**:
  - `PENDING` → `PROCESSED` | `PENDING_REFERENCE` | `REJECTED` | `FAILED`
  - `PENDING_REFERENCE` → `PROCESSED` | `PENDING_REFERENCE` (reagendamento via `scheduleReferenceRetry`) | `REJECTED` | `FAILED`
  - `PROCESSED`, `REJECTED` e `FAILED` são estados **terminais**; qualquer nova transição lança `InvalidTransactionStateError`.
- **Taxonomia de `FailureCode` (`src/domain/enums/wagering.enums.ts`)**:
  - `INSUFFICIENT_BALANCE` (aposta sem saldo) vs `REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE` (reversão de crédito que deixaria a carteira negativa).
  - Falhas de referência: `REFERENCE_NOT_FOUND_EXPIRED`, `INVALID_REFERENCE_KIND`, `REFERENCE_NOT_PROCESSED`, `REFERENCE_ALREADY_REVERSED`, `REFERENCE_MISMATCH`, `REFERENCE_AMOUNT_MISMATCH`.
  - Falhas cadastrais/contrato/infra: `WALLET_NOT_FOUND`, `CURRENCY_MISMATCH`, `PLAYER_MISMATCH`, `INVALID_TRANSACTION_REQUEST`, `INFRASTRUCTURE_FAILURE`.

### 2.4. Garantias Impostas no Schema PostgreSQL

Definidas nas migrations `Migration202611100001_InitialWageringSchema` e `Migration202611110002_InboxAndOutboxSchema`:

- **`wallets`**: `UNIQUE (player_id, currency)` (`uq_wallets_player_currency`), `CHECK (balance_amount >= 0)`, `CHECK (version >= 1)`, `CHECK (currency ~ '^[A-Z]{3}$')`.
- **`wager_transactions`**:
  - `UNIQUE (provider_id, external_transaction_id)` (`uq_wager_tx_provider_external`) e `UNIQUE (idempotency_key)` (`uq_wager_tx_idempotency_key`).
  - `CHECK (amount > 0)`, `CHECK (resulting_balance_amount IS NULL OR resulting_balance_amount >= 0)`, `CHECK (reference_attempts >= 0)`, `CHECK` de `kind` e `status`, e `CHECK` exigindo `reference_external_transaction_id` para `REFUND` e `ROLLBACK`.
  - `FOREIGN KEY`s (`wallet_id`, `reference_transaction_id`) com `ON DELETE RESTRICT`.
  - **Unicidade parcial de reversões**:
    ```sql
    CREATE UNIQUE INDEX uq_wager_tx_single_reversal_per_kind
    ON wager_transactions (reference_transaction_id, kind)
    WHERE reference_transaction_id IS NOT NULL
      AND kind IN ('REFUND', 'ROLLBACK')
      AND status = 'PROCESSED';
    ```
    Filtrar por `status = 'PROCESSED'` garante no banco no máximo 1 `REFUND` e 1 `ROLLBACK` efetivados por transação de referência, permitindo persistir tentativas subsequentes como `REJECTED` (`REFERENCE_ALREADY_REVERSED`) para trilha de auditoria.
  - **Índice parcial de pendentes**: `idx_wager_tx_pending_reference (next_reference_retry_at, created_at) WHERE status = 'PENDING_REFERENCE'`.
- **`wallet_ledger_entries`**:
  - `UNIQUE (wallet_id, transaction_id)` (`uq_ledger_wallet_transaction`), `CHECK (amount > 0)`, `CHECK (balance_before >= 0)`, `CHECK (balance_after >= 0)`.
  - `CHECK` aritmético (`chk_ledger_arithmetic`) validando `balance_after = balance_before + amount` em `CREDIT` e `balance_after = balance_before - amount` em `DEBIT`.
  - **Trigger de imutabilidade** (`trg_wallet_ledger_entries_immutable`): bloqueia `UPDATE` e `DELETE` lançando SQLSTATE `23001` (`restrict_violation`).
- **`inbox_messages` e `outbox_messages`**:
  - `inbox_messages`: `PRIMARY KEY (consumer_name, message_id)`.
  - `outbox_messages`: `CHECK (attempts >= 0)` e índice parcial `idx_outbox_pending_due (next_attempt_at, occurred_at, id) WHERE published_at IS NULL`.

---

## 3. Idempotência, Reversões e `PENDING_REFERENCE`

### 3.1. Fluxo Único e Validação de Contrato

`ProcessWagerTransactionUseCase` (`src/application/use-cases/process-wager-transaction.use-case.ts`) é o ponto único de entrada para HTTP e SQS:

- **Validação de limites de campos (`FIELD_MAX_LENGTH`)**: `validateCommand` valida tamanhos alinhados às colunas do banco (`providerId` <= 100; `Idempotency-Key`, `externalTransactionId`, `roundId`, `gameId`, `referenceExternalTransactionId` <= 255), respondendo HTTP `400 INVALID_PAYLOAD` ou roteando imediatamente para DLQ no SQS.
- **Hash canônico (`CanonicalPayloadHasher`)**: gera SHA-256 hex (64 chars) sobre JSON recursivamente ordenado por chave contendo apenas campos de negócio (`externalTransactionId`, `gameId`, `kind`, `money` normalizado, `playerId`, `providerId`, `referenceExternalTransactionId` normalizado para `null` quando ausente, `roundId`, `walletId`), excluindo `Idempotency-Key` e metadados de transporte. Para transações internas de abertura (`WagerTransaction.createOpening`), o `payloadHash` também usa SHA-256 hex (64 chars), evitando estouro de `varchar(64)` com saldos grandes.

### 3.2. Idempotência Persistente e Replay Fiel

- **Saldo histórico no replay**: `wager_transactions.resulting_balance_amount` armazena o saldo observado no momento em que a transação atinge estado terminal (`PROCESSED` ou `REJECTED`). Como `LOSS` e `REJECTED` não geram entradas em `wallet_ledger_entries`, guardar esse campo na própria transação garante replay fiel mesmo após movimentações posteriores na carteira.
- **Ordem de checagens e garantia real no PostgreSQL**:
  1. **Fast-path pré-lock**: `findByIdempotencyKey` sem lock responde imediatamente a replays já commitados sem entrar na fila da carteira.
  2. **Lock pessimista na carteira**: `findByIdForUpdate` adquire `SELECT ... FROM wallets WHERE id = ? FOR UPDATE`.
  3. **Re-checagem pós-lock (apenas otimização)**: `findByIdempotencyOrExternal` verifica em 1 query se outra requisição para a mesma carteira commitou durante a espera pelo lock, evitando um `INSERT` + erro `23505` + `ROLLBACK`. Sua remoção não compromete a correção.
  4. **Constraints `23505` + `resolveUniqueConstraintCollision` (garantia definitiva)**: qualquer violação de `uq_wager_tx_idempotency_key`, `uq_wager_tx_provider_external` ou `pk_inbox_messages` aciona `resolveUniqueConstraintCollision` em nova transação limpa. Como `uq_wager_tx_provider_external` pode ser avaliada antes de `uq_wager_tx_idempotency_key` no PostgreSQL, a resolução consulta **primeiro** por `idempotencyKey` (replay ou `IDEMPOTENCY_CONFLICT`) e **só então** por `(providerId, externalTransactionId)` (`EXTERNAL_TRANSACTION_CONFLICT`). Para mitigar *snapshot skew* sob `READ COMMITTED`, o loop realiza até 5 leituras curtas caso a transação vencedora ainda esteja concluindo o commit.

### 3.3. Regras de Reversão e Reprocessamento Assíncrono

`WagerTransactionResolutionService` concentra as regras compartilhadas entre o fluxo síncrono/SQS e o worker de pendências:

- **Validação da referência**: busca por `(providerId, referenceExternalTransactionId)`; valida correspondência de `providerId`, `playerId`, `walletId`, `currency` e `roundId` (`REFERENCE_MISMATCH`), igualdade de valor em `REFUND`/`ROLLBACK` (`REFERENCE_AMOUNT_MISMATCH`), status `PROCESSED` da referência (`REFERENCE_NOT_PROCESSED` para `REJECTED`/`FAILED`, ou permanece `PENDING_REFERENCE` se a própria referência ainda estiver pendente), e tipo alvo permitido (`REFUND` e `WIN` opcional apenas sobre `BET`; `ROLLBACK` sobre `BET`, `WIN` ou `REFUND`).
- **Reversão que deixaria saldo negativo**: persistida como `REJECTED` com `REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE`, sem alterar saldo nem inserir no ledger, preservando replay fiel (`422`).
- **`PENDING_REFERENCE` e backoff exponencial (`PendingReferencePolicy`)**: quando a referência ainda não existe, a transação é persistida como `PENDING_REFERENCE` (`202 Accepted` no HTTP). O `PendingReferenceWorker` / `ProcessPendingReferencesUseCase` aplica `delay = min(baseDelayMs * 2^attempts, maxDelayMs)` (padrão `1s..30s`) até o limite de tentativas (`5`) ou TTL (`5 min`), transicionando na exaustão para `REJECTED` com `REFERENCE_NOT_FOUND_EXPIRED` e emitindo `WagerTransactionRejected` no Outbox.

### 3.4. Consultas, Paginação e Reconciliação

- **Consultas implementadas**: `GET /wallets/:walletId` (`GetWalletUseCase`), `GET /wallets/:walletId/ledger` (`GetWalletLedgerUseCase`), `GET /wagering/transactions/:transactionId` e `GET /providers/:providerId/wagering/transactions/:externalTransactionId` (`GetWagerTransactionUseCase`).
- **Paginação opaca do ledger**: `LedgerCursorCodec` codifica `{ createdAt, id }` em `base64url` usando keyset pagination `(created_at, id) < (cursor.t, cursor.id)` sobre o índice `idx_ledger_wallet_created_id`.
- **Reconciliação (`POST /wallets/:walletId/reconciliation`)**: `ReconcileWalletUseCase` adquire `findByIdForUpdate` na carteira para observar um snapshot consistente com `wallet_ledger_entries`, soma as entradas com `Money` e retorna `storedBalance`, `calculatedBalance`, `difference`, `consistent` e `checkedEntries`. Divergências incrementam `wager_reconciliation_mismatches_total` e emitem o log `wallet_reconciliation_mismatch` (sem valores monetários nos logs e sem correção silenciosa no banco).

### 3.5. Mapeamento de Status HTTP

| Situação | Status HTTP | `errorCode` / `failureCode` | Comportamento |
| :--- | :--- | :--- | :--- |
| `POST /wallets` criada | `201 Created` | — | Cria `OPENING` + `CREDIT` no ledger quando `initialBalance > 0` |
| Wallet duplicada `(playerId, currency)` | `409 Conflict` | `WALLET_ALREADY_EXISTS` | Captura `uq_wallets_player_currency` (`23505`) |
| DTO/campo inválido, tamanho excedido, `Money` inválido, `Idempotency-Key` ausente | `400 Bad Request` | `INVALID_PAYLOAD` / `INVALID_MONEY` | Validação na borda e domínio |
| Carteira ou transação inexistente | `404 Not Found` | `WALLET_NOT_FOUND` / `TRANSACTION_NOT_FOUND` | Sem persistência em `wager_transactions` |
| Transação `PROCESSED` (inicial ou replay) | `200 OK` | — | Replay retorna `resultingBalance` original e `idempotentReplay: true` |
| Transação `PENDING_REFERENCE` (inicial ou replay) | `202 Accepted` | — | Aguarda referência no worker |
| Transação persistida como `REJECTED` (inicial ou replay) | `422 Unprocessable Entity` | `FailureCode` correspondente | Persistida sem alterar saldo/ledger; replay retorna `422` + `idempotentReplay: true` |
| Crédito excede `numeric(18,2)` (`9999999999999999.99`) | `422 Unprocessable Entity` | `BALANCE_LIMIT_EXCEEDED` | Rollback sem persistência nem alteração de saldo/ledger |
| Mesmo `Idempotency-Key` com `payloadHash` divergente | `409 Conflict` | `IDEMPOTENCY_CONFLICT` | Não altera saldo/ledger |
| Mesmo `(providerId, externalTransactionId)` com outra key | `409 Conflict` | `EXTERNAL_TRANSACTION_CONFLICT` | Não altera saldo/ledger |
| Lock timeout (`55P03`) ou erro transitório de DB | `503 Service Unavailable` | `WALLET_LOCK_TIMEOUT` / `TRANSIENT_INFRASTRUCTURE_ERROR` | Inclui header `Retry-After` para reenvio seguro |

---

## 4. Concorrência e Controle de Locks

### 4.1. Lock Pessimista por Carteira e Isolamento `READ COMMITTED`

- **Mecanismo adotado**: `MikroOrmWalletRepository.findByIdForUpdate` executa `SELECT ... FROM wallets WHERE id = ? FOR UPDATE` via `LockMode.PESSIMISTIC_WRITE`. Carteiras distintas não competem entre si.
- **Por que Lock Pessimista em vez de Optimistic Locking (`version`) ou `SERIALIZABLE`**: sob alta contenção em *hot wallets*, o lock pessimista enfileira as transações no PostgreSQL sem gerar tempestades de rollbacks/retries, além de manter toda a lógica de saldo, reversões e ledger encapsulada nas entidades de domínio.
- **Ausência de `version: true` no ORM**: `WalletOrmEntity.version` é mapeado sem `{ version: true }`; `Wallet.version` atua apenas como contador monotônico incrementado a cada mutação de saldo (contrato HTTP e payload de `WalletBalanceChanged`).
- **Isolamento `READ COMMITTED`**: intencionalmente mantido como padrão do PostgreSQL, pois quando a transação B acorda após o `COMMIT` da transação A, o PostgreSQL reavalia a linha e entrega a versão já atualizada da carteira (ao passo que `REPEATABLE READ` abortaria B com `40001`).

### 4.2. `lock_timeout` e Pool de Conexões

- **`SET LOCAL lock_timeout`**: `MikroOrmUnitOfWork` executa `SET LOCAL lock_timeout = '${DB_LOCK_TIMEOUT_MS}ms'` (padrão `3000ms`) no início de cada transação, restrito à transação corrente. Em SQLSTATE `55P03`, lança `WalletLockTimeoutError` → HTTP `503` com header `Retry-After`.
- **Uso da conexão transacional no pool**: o pool por instância usa `DB_POOL_MIN=2` e `DB_POOL_MAX=20`. O `SET LOCAL` é executado com `txEm.execute(...)` diretamente na conexão da transação ativa (evitando o deadlock de pool observado ao usar `getConnection().execute()`, que solicitava uma segunda conexão do pool enquanto as conexões ativas aguardavam `BEGIN`).

### 4.3. Evidência Antes e Depois do Lock

Na suíte `test/concurrency/wagering-concurrency.concurrency.spec.ts` contra PostgreSQL real:
- Sem `FOR UPDATE`, 2 apostas paralelas de `80.00 BRL` em saldo `100.00 BRL` foram ambas aprovadas; 50 apostas paralelas divergiram (`walletBalance: "420.00"` vs `ledgerBalance: "-615.00"`); e 3 processos paralelos aprovaram 15 apostas de `15.00 BRL` em saldo `100.00 BRL`.
- Com `LockMode.PESSIMISTIC_WRITE`, todos os cenários passaram de forma estável em múltiplas execuções consecutivas (incluindo mistura `BET`/`WIN`, paralelismo entre carteiras distintas, 3 processos `Bun.spawn` e saturação `503 Retry-After`).

### 4.4. Ordem Global de Locks no Worker (`PENDING_REFERENCE`)

- **Desenho adotado**:
  1. `findDuePendingCandidates` lê `(id, wallet_id)` vencidos **sem lock**.
  2. Para cada candidato, `ProcessPendingReferencesUseCase.processSingleCandidate` abre uma transação curta adquirindo **1º** o lock da carteira (`findByIdForUpdate`) e **2º** o lock condicional da transação (`SELECT id FROM wager_transactions WHERE id = ? AND status = 'PENDING_REFERENCE' FOR UPDATE SKIP LOCKED`).
- **Limite de testabilidade da mutação de inversão**: a mutação hipotética de inverter a ordem no worker (`WagerTransaction -> Wallet`) **não é testável/detectável contra o desenho atual**, porque `ProcessWagerTransactionUseCase` (caminho HTTP/SQS) adquire `FOR UPDATE` apenas em `wallets` e nunca adquire `FOR UPDATE` sobre linhas pré-existentes de `wager_transactions` (faz apenas `SELECT` sem lock em referências existentes ou `INSERT` de novas linhas). Logo, não há ciclo de lock oposto `Wallet <-> WagerTransaction` contra linhas `PENDING_REFERENCE`. Ainda assim, a ordem global `Wallet -> WagerTransaction` é mantida como invariante estrutural preventiva.

---

## 5. Mensageria Assíncrona: SQS FIFO, Inbox e Outbox

### 5.1. Topologia de Três Filas FIFO

O script `docker/localstack/init-sqs.sh` provisiona **três filas FIFO** (validadas tanto no healthcheck do `docker-compose.yml` quanto em `verifySqsQueues` em `src/infrastructure/messaging/sqs.client.ts`):

1. **`wager-transactions.fifo`**: fila de entrada com `ContentBasedDeduplication=true`, `VisibilityTimeout=30` e `RedrivePolicy` apontando para a DLQ após `maxReceiveCount = 3`.
2. **`wager-transactions-dlq.fifo`**: Dead-Letter Queue FIFO (`MessageRetentionPeriod=1209600`).
3. **`wager-events.fifo`**: fila FIFO dedicada aos eventos de integração do Outbox (`ContentBasedDeduplication=false`, evitando loop de autoconsumo pelo worker de entrada).

Mensagens enviadas à fila de entrada usam `MessageGroupId = walletId`; eventos publicados em `wager-events.fifo` usam `MessageGroupId = aggregateId` (`walletId`) e `MessageDeduplicationId = outbox.id` (`eventId`).

### 5.2. Consumidor SQS, Inbox Persistente e Política de Falhas

- **Deduplicação em duas camadas (`inbox_messages` × `idempotency_key`)**:
  - `inbox_messages (consumer_name, message_id)` é gravada **na mesma transação SQL** dos efeitos financeiros. Se uma entrega falhar após o `COMMIT` e antes do `DeleteMessage`, a reentrega encontra a entrada em `inbox_messages` antes do lock da carteira e retorna sem duplicar efeitos.
  - Se o mesmo `messageId` chegar com `payloadHash` divergente, `InboxPayloadMismatchError` (`INBOX_PAYLOAD_MISMATCH`) reverte a transação e segue como erro permanente para a DLQ.
  - Se a mesma transação de negócio chegar com outro `messageId` (ou após passagem prévia por HTTP), a constraint `idempotency_key` em `wager_transactions` garante replay fiel sem reemitir eventos.
- **Classificação de falhas (`SqsWagerConsumerService`)**:
  - **Ack pós-commit (`DeleteMessage`)**: `PROCESSED`, `PENDING_REFERENCE`, `REJECTED` por regra de negócio e replays válidos.
  - **Erro transitório (`ChangeMessageVisibility` com backoff `min(30s, 1s * 2^(receiveCount - 1))`, sem ack)**: `WalletLockTimeoutError`, `TransientInfrastructureError` e falhas transitórias de I/O. Como `SQS_CONSUMER_VISIBILITY_TIMEOUT_SEC = 30s` é `10×` maior que `DB_LOCK_TIMEOUT_MS = 3s`, transações saudáveis não sofrem reentrega espúria durante contenção normal.
  - **Erro permanente → DLQ (`VisibilityTimeout = 0`, sem ack, até `maxReceiveCount = 3`)**: `MalformedSqsEnvelopeError`, `ValidationApplicationError`, `IdempotencyConflictError`, `ExternalTransactionConflictError`, `InboxPayloadMismatchError`, `WalletNotFoundError`, `DomainError` (incluindo `BalanceLimitExceededError`) e erros permanentes do PostgreSQL (`isPermanentPgError`: SQLSTATE `22001` e `22003`).
  - **Por que `WalletNotFoundError` vai para a DLQ**: a criação de carteira (`POST /wallets`) é síncrona e fortemente consistente no PostgreSQL. Quando uma mensagem SQS referencia uma `walletId` inexistente, a transação não pode ser persistida (a `FOREIGN KEY (wallet_id) REFERENCES wallets(id)` impede registro órfão) e repetir com backoff na fila principal apenas desperdiçaria processamento. Classificar `WalletNotFoundError` como permanente devolve a visibilidade a `0s` para que a `RedrivePolicy` (`maxReceiveCount = 3`) isole rapidamente a mensagem em `wager-transactions-dlq.fifo`, preservando o payload para diagnóstico operacional ou reenvio manual após regularização da carteira.
- **Ordenação intra-lote**: o consumidor busca até `10` mensagens por poll, agrupa por `MessageGroupId` (`walletId` na falta do atributo) e processa até `5` carteiras em paralelo. Ao ocorrer falha na mensagem `i` de uma carteira, o grupo para imediatamente e devolve a visibilidade das mensagens `i+1..n` da mesma carteira para `0s` via `ChangeMessageVisibility`.

### 5.3. Outbox Transacional, Semântica *At-Least-Once* e Shutdown

- **Eventos emitidos**: apenas os 4 previstos no contrato (`WagerTransactionProcessed`, `WagerTransactionRejected`, `WalletBalanceChanged` e `WagerTransactionPendingReference` na entrada inicial em `PENDING_REFERENCE`). Replays não geram novos eventos.
- **Atomicidade**: os `OutboxMessage`s são inseridos na mesma transação SQL que altera `wallets`, `wager_transactions` e `wallet_ledger_entries` (validado em `test/integration/outbox-atomicity.integration.spec.ts` com falha injetada após a escrita do outbox e antes do commit).
- **Publicação (`OutboxPublisherUseCase`)**: seleciona lotes pendentes com `ORDER BY occurred_at ASC, id ASC LIMIT ? FOR UPDATE SKIP LOCKED`, publica via `SqsOutboxEventPublisher` e grava `published_at` apenas após retorno positivo do SQS. Falhas aplicam backoff (`500ms..30s`). Se houver falha entre `SendMessageCommand` e `save`, o reenvio usa o mesmo `eventId` estável (`MessageDeduplicationId`), garantindo entrega *at-least-once* com deduplicação de 5 minutos pelo SQS FIFO e idempotência de longo prazo pelo `eventId` no consumidor downstream.
- **Ordenação com múltiplos publishers**: com mais de um publisher concorrente, `FOR UPDATE SKIP LOCKED` pode permitir que dois eventos da mesma carteira alcancem o SQS fora de ordem em caso de atraso de rede em um dos workers; por isso `WalletBalanceChanged` carrega `walletVersion` monotônico por carteira e todo evento carrega `occurredAt` + `eventId`.
- **Injeção de falhas e shutdown gracioso**: os ganchos `setFaultHooks` de `SqsWagerConsumerService` e `OutboxPublisherUseCase` lançam erro se `NODE_ENV === 'production'`. Todos os workers (`SqsWagerConsumerService`, `OutboxPublisherWorker`, `PendingReferenceWorker`) implementam `OnModuleDestroy`, parando o loop (`stopped = true`), limpando timers e aguardando a execução `inFlight` antes de encerrar conexões.

---

## 6. Observabilidade, Ambiente e Teste de Carga

### 6.1. Logs Estruturados e Sanitização de Erros

- **`JsonStructuredLogger` (`src/infrastructure/observability/json-structured-logger.ts`)**: emite JSON com `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId` e `idempotencyKey`. Uma lista recursiva (`SENSITIVE_OR_FINANCIAL_KEYS`) remove automaticamente chaves financeiras e credenciais (`amount`, `money`, `balance`, `resultingBalance`, `initialBalance`, `storedBalance`, `calculatedBalance`, `difference`, `balanceBefore`, `balanceAfter`, `authorization`, `password`, `secret`, `token`, `apiKey`, `payload`, `body`, `rawBody`, `credentials`, `cookie`, `setCookie`).
- **`DomainExceptionFilter` (`src/presentation/http/filters/domain-exception.filter.ts`)**: exceções HTTP não mapeadas (evento `unhandled_http_exception`, como erros de driver MikroORM/PostgreSQL) usam `LOGGER_PORT` e passam por `sanitizeErrorMessage` e `extractSqlState` (`src/presentation/http/filters/sanitize-error-message.ts`), removendo a instrução SQL, linhas `detail: Failing row contains (...)`, literais entre aspas e decimais, mantendo apenas `errorName`, `sqlState` e resumo técnico sanitizado.

### 6.2. Métricas e Health Checks

- **`PrometheusMetricsRegistry` (`GET /metrics`)**: expõe formato Prometheus (`text/plain; version=0.0.4`) ou JSON (`?format=json`), incluindo `wager_transactions_total`, `wager_processing_duration_ms`, `wager_duplicates_total`, `wager_retries_total`, `wager_dlq_routed_total`, `wager_lock_conflicts_total`, `wager_reconciliations_total`, `wager_reconciliation_mismatches_total`, `wager_outbox_pending_count`, `wager_outbox_oldest_pending_lag_ms`, `wager_sqs_dlq_messages_approximate` (cache de 3s) e `wager_metrics_scrape_errors_total`.
  - **Baixa cardinalidade**: `assertAllowedLabels` bloqueia rótulos de identificadores (`FORBIDDEN_HIGH_CARDINALITY_LABELS`: `walletId`, `playerId`, `transactionId`, `providerId`, `idempotencyKey`, `messageId`, `roundId`, `externalTransactionId`, `correlationId`, `causationId`, `externalId`).
  - **Degradação segura**: falhas isoladas ao consultar `outbox_messages` ou SQS DLQ incrementam `wager_metrics_scrape_errors_total{dependency}` sem quebrar a resposta `200 OK` de `/metrics`.
- **Health Checks**: `GET /health/live` (liveness do processo e uptime) e `GET /health/ready` / `GET /health` (`SELECT 1` no PostgreSQL e `verifySqsQueues` nas 3 filas FIFO).

### 6.3. Ambiente Reprodutível e Teste de Carga (`scripts/load-test.ts`)

- **Infraestrutura fixa**: `docker-compose.yml` com `postgres:16.4-alpine` (porta configurável via `DB_PORT`, padrão `5432`) e `localstack/localstack:3.7.2`. `scripts/wait-for-infra.ts` valida ativamente Postgres e as 3 filas SQS antes das suítes de integração, concorrência e carga.
- **Execução de carga medida (`bun run test:load`)**:
  - **Cenário**: `33` carteiras (`30` regulares + `3` *hot wallets* concentrando ~40% da carga), `600` requisições HTTP com concorrência `24` (`BET`, `WIN`, `REFUND` e ~20% replays) + `90` mensagens SQS simultâneas.
  - **Resultados observados**: fase HTTP em `2590.79 ms` (`231.59 req/s`); latências `p50 = 96.31 ms`, `p95 = 181.87 ms`, `p99 = 254.44 ms`, `max = 453.78 ms`; status HTTP `543` × `200 OK`, `57` × `422` (`REFERENCE_ALREADY_REVERSED` nos replays/múltiplos `REFUND` sobre a `BET` semente), `0` × `503` e `0` erros inesperados; duplicatas barradas `115` (HTTP) e `13` (SQS); outbox pós-drenagem com `pendingCount = 0` e `oldestLagMs = 0`; reconciliação final com `33/33` carteiras consistentes, `0` saldos negativos e `0` lançamentos duplicados.
  - **Limitações do experimento**: (1) roda em processo único NestJS em `127.0.0.1` (disputa multi-processo real é coberta em `test/concurrency/`); (2) `SqsOutboxEventPublisher` envia 1 evento por `SendMessageCommand` (sem batching); (3) transações curtas em Postgres local não saturaram `DB_LOCK_TIMEOUT_MS=3000ms` com concorrência 24 (o cenário `503 Retry-After` é exercitado determinísticamente em `Scenario 7` de `wagering-concurrency.concurrency.spec.ts`).

---

## 7. Limitações Conhecidas e Próximos Passos

- **Autenticação completa em IdP**: implementar adapter concreto de `ProviderIdentityPort` (JWKS/OIDC ou HMAC) e rate-limiting na borda antes de exposição pública.
- **Envio em lote no Outbox**: evoluir `SqsOutboxEventPublisher` para `SendMessageBatchCommand` (até 10 eventos por chamada) para reduzir latência de dreno sob picos altos.
- **Ordenação estrita multi-publisher**: caso a ordem de saída por `walletId` precise ser estrita mesmo com múltiplos publishers paralelos, particionar a varredura por hash de `aggregate_id` ou adquirir lock lógico por partição.
- **Reconciliação agregada em SQL**: substituir o carregamento completo de `findAllByWallet` em memória por agregação `SUM` no PostgreSQL (ou checkpoints periódicos) para carteiras com milhões de entradas.
- **Precisão variável por moeda**: `numeric(18,2)` assume 2 casas decimais; moedas com 0 ou 3 casas (ex.: JPY, BHD) exigiriam escala parametrizada por moeda.
