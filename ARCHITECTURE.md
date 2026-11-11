# ARCHITECTURE.md — Decisões Técnicas e Trade-offs

Este documento registra as decisões de arquitetura, modelagem e infraestrutura adotadas ao longo do desenvolvimento do **Distributed Wagering Processor**.

---

## 1. Visão Geral da Arquitetura (DDD + Hexagonal / Ports & Adapters)

O projeto é organizado em quatro camadas concêntricas com regra estrita de dependência apontando para dentro:

1. **`src/domain/`**:
   - Contém Value Objects (`Money`), Aggregate Roots (`Wallet`, `WagerTransaction`), entidades imutáveis (`WalletLedgerEntry`, `InboxMessage`, `OutboxMessage`), eventos de integração (`IntegrationEvent<T>`) e erros de domínio.
   - **Zero dependência** de NestJS, MikroORM ou AWS SDK.
2. **`src/application/`**:
   - Contém os casos de uso (`ProcessWagerTransactionUseCase`, `OpenWalletUseCase`, `ReconcileWalletUseCase`, etc.) e portas (interfaces) de saída.
   - **Um único use case compartilhado** processa transações vindas tanto da API HTTP (`POST /wagering/transactions`) quanto do consumidor SQS (`wager-transactions.fifo`).
3. **`src/infrastructure/`**:
   - Adaptadores concretos para PostgreSQL via **MikroORM**, mensageria via **AWS SDK v3 (`@aws-sdk/client-sqs`)**, workers agendados (Outbox publisher, Pending Reference retry), health checks e observabilidade.
4. **`src/presentation/`**:
   - Adaptadores de entrada: Controllers HTTP, SQS Consumer e filtros globais de exceção.

---

## 2. Decisões do Sprint 0 (Setup & Fundação)

### 2.1. Escolha do ORM: MikroORM (`@mikro-orm/postgresql` v6)
- **Decisão**: Adotamos o **MikroORM 6.4.3** sobre o driver PostgreSQL com `allowGlobalContext: false`.
- **Justificativa**:
  - Suporte explícito a **Unit of Work** e controle fino de transações via `em.transactional()`.
  - Suporte nativo a **Pessimistic Locking** (`LockMode.PESSIMISTIC_WRITE` -> `SELECT ... FOR UPDATE`) e **Optimistic Locking** (`version`), fundamentais para serializar alterações concorrentes na mesma `Wallet` sem lock global.
  - Desacoplamento limpo entre o modelo de domínio rico (instanciado via factories `create` / `rehydrate`) e a camada de persistência.
- **Trade-off**: Exige `em.fork()` explícito em workers/background jobs e mapeamento cuidadoso entre entidades de domínio e persistência, em troca de previsibilidade transacional muito superior ao Active Record.

### 2.2. Filas SQS: Por que FIFO (`wager-transactions.fifo` + `wager-transactions-dlq.fifo`) e Papel do Banco
- **Decisão**: Provisionamos duas filas FIFO no LocalStack via `docker/localstack/init-sqs.sh`:
  - `wager-transactions.fifo` (fila principal)
  - `wager-transactions-dlq.fifo` (Dead-Letter Queue associada via `RedrivePolicy` com `maxReceiveCount = 3`)
- **Justificativa**:
  - A Seção 10 do `docs/CHALLENGE.md` especifica literalmente os nomes `wager-transactions.fifo` e `wager-transactions-dlq.fifo`. No AWS SQS, o sufixo `.fifo` exige o atributo `FifoQueue=true` tanto na fila principal quanto na sua DLQ (uma fila FIFO só pode ter como DLQ outra fila FIFO).
  - Ao publicar mensagens para uma carteira, utilizamos `MessageGroupId = walletId`. Isso permite que o broker entregue operações da mesma carteira em ordem na maioria dos casos (reduzindo a incidência de `PENDING_REFERENCE` e contenção de lock na mesma `Wallet`), enquanto carteiras distintas (`walletId` diferentes) são processadas em paralelo por múltiplos consumidores.
  - Conforme exigido nas Seções 5 e 8, **não confiamos no SQS FIFO como garantia final de consistência ou deduplicação**: a deduplicação definitiva ocorre no PostgreSQL via `inbox_messages (consumer_name, message_id)` e `wager_transactions (idempotency_key)`, e a ordenação fora de ordem é tratada pelo estado `PENDING_REFERENCE`.

### 2.3. Reprodutibilidade do Ambiente (`docker-compose.yml` + `wait-for-infra.ts`)
- **Decisão**:
  - Fixamos versões exatas das imagens Docker: `postgres:16.4-alpine` e `localstack/localstack:3.7.2`.
  - O healthcheck do LocalStack valida que ambas as filas (`wager-transactions.fifo` e `wager-transactions-dlq.fifo`) já foram criadas pelo script `init-sqs.sh` antes de marcar o container como `healthy`.
  - O script `scripts/wait-for-infra.ts` é executado automaticamente antes de `bun run test:integration` e também no `beforeAll` da suíte de integração, aguardando até 60s pela prontidão real do PostgreSQL (`SELECT 1`) e do SQS (`GetQueueUrl` + `GetQueueAttributes` verificando `FifoQueue` e `RedrivePolicy`).
- **Trade-off**: Adiciona ~50ms de verificação no boot da suíte de integração, mas elimina falhas intermitentes ("flaky tests") quando o avaliador executa `docker compose up -d && bun run test:integration` do zero.

### 2.4. Autenticação (Seção 2)
- **Decisão**: De acordo com a Seção 2 do desafio, optamos por focar o timebox nos critérios avaliados (correção financeira, concorrência, idempotência e mensageria) e deixar a autenticação desacoplada através de uma porta/guarda explícita (`ProviderAuthGuard` / `ProviderIdentityPort`), mantendo `/health/live` e `/health/ready` abertos. Em produção, essa porta validaria tokens JWT OAuth2/OIDC emitidos por um IdP externo (Keycloak ou Zitadel) via JWKS caching e mTLS no gateway dos provedores.

---

## 3. Decisões do Sprint 1 (Domínio Puro & Schema PostgreSQL)

### 3.1. Isolamento entre Domínio Puro e Persistência (MikroORM)
- **Decisão**: O pacote `src/domain/` não possui nenhuma importação de `@nestjs/*` nem `@mikro-orm/*`. As entidades ORM (`WalletOrmEntity`, `WagerTransactionOrmEntity`, `WalletLedgerEntryOrmEntity`) vivem em `src/infrastructure/database/entities/` e são convertidas para/de agregados ricos via `WageringMapper` usando `rehydrate()`.
- **Motivo**: Preservar as invariantes financeiras (construtores privados, factories explícitas `open`/`create`/`rehydrate`, ausência de setters públicos) independentes do ORM e facilitar testes unitários puros.
- **Trade-off**: Introduz um passo explícito de mapeamento entre ORM e domínio, em troca de blindar o domínio contra mutações acidentais e acoplamento de framework.

### 3.2. Value Object `Money` — Escala, Arredondamento e Mapeamento (`Decisão 4A`)
- **Decisão**: `Money` encapsula um `Decimal` (`decimal.js` com `precision: 28` e `ROUND_HALF_EVEN`) e uma string `currency` ISO-4217 (`^[A-Z]{3}$`).
  - **`Money.from({ amount, currency })` (Decisão 4A)**: Aceita strings decimais não-negativas com **0 a 2 casas decimais** (`/^\d+(?:\.\d{1,2})?$/`, ex.: `"25"`, `"25.5"`, `"25.00"`) e normaliza a saída sempre para escala fixa de 2 casas (`"25.00"`). Rejeita estritamente `number`, strings vazias, espaços, negativos, `+`, `NaN`, `Infinity`, notação científica e valores com mais de 2 casas decimais (`"25.001"`).
  - **`Money.rehydrate()`**: Permite reconstruir valores já persistidos via `string` (nunca `number`) vindo do driver `pg`.
  - **Persistência**: Valores monetários são armazenados como `numeric(18,2)` e `varchar(3)` no PostgreSQL e mapeados como `type: 'string'` no MikroORM, garantindo que nenhum valor passe por `number` / IEEE-754 entre o banco e a aplicação.
- **Motivo**: Atende à Seção 6.1 (*"entradas inválidas são rejeitadas: ... mais de 2 casas decimais"* e *"sempre com escala fixa de 2 casas"*) mantendo ergonomia para clientes que serializam inteiros como `"25"`, sem jamais arredondar silenciosamente sub-centavos (`"25.001"`).

### 3.3. Saldo Materializado Observado no Replay (`Decisão 1A`)
- **Decisão**: Adicionamos a coluna nullable `resulting_balance_amount numeric(18,2)` em `wager_transactions`, preenchida quando a transação atinge estado terminal (`PROCESSED` ou `REJECTED`).
- **Motivo**: A Seção 7 determina que *"repetir uma operação já processada retorna o resultado original, incluindo o saldo observado naquele momento"*. Transações `LOSS` e `REJECTED` não geram entrada em `wallet_ledger_entries`; sem persistir `resulting_balance_amount` na própria transação, um replay após operações posteriores retornaria o saldo *atual* da carteira em vez do saldo *histórico observado no momento*.
- **Trade-off**: Uma coluna extra em `wager_transactions`, porém elimina joins no caminho quente de idempotência e garante fidelidade histórica para 100% dos tipos e status terminais.

### 3.4. Controle de Retentativas para `PENDING_REFERENCE` (`Decisão 2A`)
- **Decisão**: Adicionamos `reference_attempts integer NOT NULL DEFAULT 0` e `next_reference_retry_at timestamptz NULL` em `wager_transactions`, acompanhados de um índice parcial `idx_wager_tx_pending_reference ON wager_transactions (next_reference_retry_at, created_at) WHERE status = 'PENDING_REFERENCE'`.
- **Motivo**: A Seção 7.1 exige reprocessamento com backoff exponencial e limite de tentativas/TTL. Armazenar o agendamento na própria linha permite ao worker consultar apenas transações elegíveis via índice parcial e locká-las atomicamente (`FOR UPDATE SKIP LOCKED`) sem manter tabela auxiliar nem polling full-table.
- **Trade-off**: Coloca metadados de retry na tabela de transações (análogo ao `OutboxMessage`), reduzindo complexidade de schema e garantindo atomicidade na transição `PENDING_REFERENCE -> PROCESSED/REJECTED`.

### 3.5. Unicidade Parcial de Reversões (`Decisão 3A`)
- **Decisão**: Criamos o índice único parcial:
  ```sql
  CREATE UNIQUE INDEX uq_wager_tx_single_reversal_per_kind
  ON wager_transactions (reference_transaction_id, kind)
  WHERE reference_transaction_id IS NOT NULL
    AND kind IN ('REFUND', 'ROLLBACK')
    AND status = 'PROCESSED';
  ```
- **Motivo**: A Seção 7 define que *"uma referência não pode ser revertida duas vezes pelo mesmo tipo de operação"*. Filtrar por `status = 'PROCESSED'` sobre `(reference_transaction_id, kind)` garante no banco que no máximo 1 `REFUND` e no máximo 1 `ROLLBACK` possam ser efetivados para uma mesma transação, enquanto permite registrar tentativas duplicadas subsequentes como `REJECTED` (com `failure_code = REFERENCE_ALREADY_REVERSED`) para trilha de auditoria completa.
- **Trade-off**: Duas reversões concorrentes que cheguem *antes* da transação referenciada (`PENDING_REFERENCE`) ainda não terão `reference_transaction_id` preenchido no momento do aceite inicial; quando o worker/reprocessamento tentar aplicar a segunda, a constraint única parcial (somada ao lock na `Wallet` e verificação transacional) impedirá a dupla reversão efetiva.

### 3.6. Máquina de Estados de `WagerTransaction` e Taxonomia de `FailureCode`
- **Transições válidas**:
  - `PENDING` → `PROCESSED` | `PENDING_REFERENCE` | `REJECTED` | `FAILED`
  - `PENDING_REFERENCE` → `PROCESSED` | `PENDING_REFERENCE` (via `scheduleReferenceRetry`) | `REJECTED` | `FAILED`
  - `PROCESSED`, `REJECTED`, `FAILED` são **terminais**; qualquer transição a partir deles lança `InvalidTransactionStateError`.
- **Taxonomia de `FailureCode`**:
  - Distingue explicitamente `INSUFFICIENT_BALANCE` (aposta sem saldo) de `REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE` (reversão de crédito que deixaria a carteira negativa, conforme Seção 7).
  - Separa falhas de referência (`REFERENCE_NOT_FOUND_EXPIRED`, `INVALID_REFERENCE_KIND`, `REFERENCE_NOT_PROCESSED`, `REFERENCE_ALREADY_REVERSED`, `REFERENCE_MISMATCH`, `REFERENCE_AMOUNT_MISMATCH`), de carteira/contrato (`WALLET_NOT_FOUND`, `CURRENCY_MISMATCH`, `PLAYER_MISMATCH`, `INVALID_TRANSACTION_REQUEST`) e de infraestrutura (`INFRASTRUCTURE_FAILURE`).

### 3.7. Garantias Impostas Diretamente no PostgreSQL
- **`wallets`**: `UNIQUE (player_id, currency)`, `CHECK (balance_amount >= 0)`, `CHECK (version >= 1)`, `CHECK (currency ~ '^[A-Z]{3}$')`.
- **`wager_transactions`**: `UNIQUE (provider_id, external_transaction_id)`, `UNIQUE (idempotency_key)`, `CHECK (amount > 0)`, `CHECK` exigindo `reference_external_transaction_id` para `REFUND`/`ROLLBACK`, `FK`s com `ON DELETE RESTRICT` e índice único parcial `uq_wager_tx_single_reversal_per_kind`.
- **`wallet_ledger_entries`**: `UNIQUE (wallet_id, transaction_id)`, `CHECK (amount > 0)`, `CHECK (balance_before >= 0)`, `CHECK (balance_after >= 0)`, `CHECK` aritmético validando `CREDIT` (`balance_after = balance_before + amount`) e `DEBIT` (`balance_after = balance_before - amount`), e trigger `trg_wallet_ledger_entries_immutable` (`BEFORE UPDATE OR DELETE`) lançando erro SQLSTATE `23001` (`restrict_violation`).

### 3.8. Pontos que um Avaliador Pode Questionar
1. **Concorrência de dois `REFUND`s em `PENDING_REFERENCE` antes da `BET` chegar**: Como `uq_wager_tx_single_reversal_per_kind` atua quando `status = 'PROCESSED'` e `reference_transaction_id IS NOT NULL`, duas requisições com `idempotency_key` distintos enviadas antes da `BET` podem ser aceitas como `PENDING_REFERENCE`; ao resolver a referência sob lock da `Wallet`, apenas a primeira vira `PROCESSED` e a segunda cai na constraint/regra e vira `REJECTED` (`REFERENCE_ALREADY_REVERSED`). Um avaliador pode perguntar por que não bloquear já no `PENDING_REFERENCE` — a resposta é permitir que a 2ª tentativa seja auditada como `REJECTED` no histórico e não falhar com erro 500 de constraint antes de saber se a 1ª seria sequer válida.
2. **Aceitar `"25"` além de `"25.00"` (`Decisão 4A`)**: A Seção 6.1 diz *"recebido e serializado como string decimal, sempre com escala fixa de 2 casas"* e também lista explicitamente *"mais de 2 casas decimais"* nas entradas inválidas. Um avaliador rigoroso pode preferir rejeitar `"25"` (Opção 4B). Caso queira endurecer, basta trocar `(?:\.\d{1,2})?` por `\.\d{2}` em `Money.ts`.
3. **Saldo materializado vs cálculo puro pelo ledger**: Em carteiras com milhões de lançamentos, somar o ledger a cada aposta seria $O(N)$ inviável; portanto mantemos saldo materializado em `wallets.balance_amount` sincronizado atomicamente com `wallet_ledger_entries` na mesma transação e verificável via `POST /wallets/:walletId/reconciliation`.
4. **Precisão `numeric(18,2)` vs moedas sem/com 3 decimais**: O schema usa `numeric(18,2)` conforme exigido por `AGENTS.md` (até trilhões com 2 casas decimais). Para moedas como JPY (0 casas) ou BHD (3 casas), seria necessário parametrizar a escala por moeda no futuro.

---

## 4. Decisões do Sprint 2 (Fluxo HTTP, Use Case Único & Idempotência Persistente)

### 4.1. Use Case Único e Fronteira Transacional (`ProcessWagerTransactionUseCase`)
- **Decisão**: O processamento de transações vive integralmente em `ProcessWagerTransactionUseCase` (`src/application/use-cases/process-wager-transaction.use-case.ts`), sem dependência de HTTP, decorators NestJS ou MikroORM. A fronteira transacional é controlada via `UnitOfWorkPort` (`MikroOrmUnitOfWork` executando `em.fork().transactional()`).
- **Motivo**: Garantir que o mesmo fluxo de negócio, idempotência e escrita atômica (`wallets` + `wager_transactions` + `wallet_ledger_entries`) seja reutilizado pelo consumidor SQS no Sprint 5.
- **Lock intencionalmente ausente neste sprint**: Conforme planejado, `MikroOrmWalletRepository.findById` ainda não aplica `LockMode.PESSIMISTIC_WRITE` para demonstrar o cenário de corrida de saldo falhando antes da correção no Sprint 3.

### 4.2. Algoritmo de `payloadHash` Canônico (`Decisão 4A`)
- **Algoritmo**: `SHA-256` em hex (`64` caracteres) calculado por `CanonicalPayloadHasher` sobre JSON canônico com chaves ordenadas alfabeticamente de forma recursiva.
- **Campos incluídos**: apenas os campos de negócio (`externalTransactionId`, `gameId`, `kind`, `money: { amount, currency }`, `playerId`, `providerId`, `referenceExternalTransactionId` normalizado para `null` quando omitido, `roundId`, `walletId`).
- **Campos excluídos**: header `Idempotency-Key` e metadados de transporte.
- **Normalização**: `money.amount` é normalizado via `Money.from()` antes do hash (coerente com a Decisão 4A do Sprint 1: `"25"` e `"25.00"` representam a mesma quantia monetária e geram o mesmo `payloadHash`).

### 4.3. Mapeamento de Status HTTP (`Decisões 1A, 2A, 3A, 5A`)
Conforme Seção 9 de `docs/CHALLENGE.md`, os status HTTP distinguem explicitamente cada classe de resultado:

| Situação | Status HTTP | `errorCode` / `failureCode` | Observação |
| :--- | :--- | :--- | :--- |
| `POST /wallets` criada | `201 Created` | — | Gera `OPENING` + `CREDIT` no ledger se `initialBalance > 0` |
| Wallet duplicada `(playerId, currency)` | `409 Conflict` | `WALLET_ALREADY_EXISTS` | Captura `uq_wallets_player_currency` (`23505`) |
| Payload/DTO inválido, `Money` inválido, `Idempotency-Key` ausente, `OPENING` externo | `400 Bad Request` | `INVALID_PAYLOAD` / `INVALID_MONEY` | Validação estrita na borda e domínio |
| Carteira inexistente (`Decisão 2A`) | `404 Not Found` | `WALLET_NOT_FOUND` | **Sem replay idempotente** (FK `wallet_id -> wallets(id)` impede persistência em `wager_transactions`) |
| Transação `PROCESSED` (`BET`, `WIN`, `LOSS`) — inicial ou replay (`Decisão 3A`) | `200 OK` | — | Replay retorna `resulting_balance_amount` original e `idempotentReplay: true` |
| Transação persistida como `REJECTED` (`INSUFFICIENT_BALANCE`, `CURRENCY_MISMATCH`, `PLAYER_MISMATCH`) (`Decisão 1A`) | `422 Unprocessable Entity` | `FailureCode` correspondente | Persistida sem alterar saldo/ledger; replay retorna `422` + `idempotentReplay: true` |
| Mesmo `Idempotency-Key` com `payloadHash` divergente | `409 Conflict` | `IDEMPOTENCY_CONFLICT` | Não altera saldo/ledger |
| Mesmo `(providerId, externalTransactionId)` com outro `Idempotency-Key` (`Decisão 5A`) | `409 Conflict` | `EXTERNAL_TRANSACTION_CONFLICT` | `Idempotency-Key` é a fonte da verdade; reutilizar `externalTransactionId` sob outra key é conflito |
| Erro transitório de conexão/banco | `503 Service Unavailable` | `TRANSIENT_INFRASTRUCTURE_ERROR` | Provedor pode reenviar com segurança usando a mesma `Idempotency-Key` |

### 4.4. Tratamento de Corrida de Idempotência no PostgreSQL
Durante os testes paralelos (15 requisições simultâneas com a mesma `Idempotency-Key`), emergiram dois comportamentos reais do PostgreSQL sob `READ COMMITTED` que foram tratados explicitamente:
1. **Ordem de avaliação de constraints `23505`**: Como `uq_wager_tx_provider_external` foi declarada antes de `uq_wager_tx_idempotency_key`, requisições paralelas idênticas frequentemente colidem primeiro em `uq_wager_tx_provider_external`. Por isso, qualquer `23505` em `wager_transactions` dispara `resolveUniqueConstraintCollision`, que relê em nova transação limpa buscando **primeiro** por `idempotencyKey` (replay ou `IDEMPOTENCY_CONFLICT`) e **só então** por `(providerId, externalTransactionId)` (`EXTERNAL_TRANSACTION_CONFLICT`).
2. **Snapshot skew sob `READ COMMITTED`**: Entre dois `SELECT` consecutivos (`findByIdempotencyKey` seguido de `findByProviderExternalId`) dentro da mesma transação, a vencedora pode commitar exatamente entre as duas leituras. Se `findByProviderExternalId` encontrar a linha recém-commitada e `existing.idempotencyKey === command.idempotencyKey`, o fluxo trata corretamente como replay em vez de falso conflito de chave externa.

### 4.5. Pontos que um Avaliador Pode Questionar
1. **`WALLET_NOT_FOUND` sem replay idempotente**: Por causa da `FOREIGN KEY (wallet_id) REFERENCES wallets(id)`, o banco impede gravar `wager_transactions` para uma `walletId` inexistente. Se a carteira for criada *depois* e o provedor reenviar com a mesma `Idempotency-Key`, a transação será processada normalmente (comportamento esperado para `404` não persistido).
2. **`422 Unprocessable Entity` no replay de transação `REJECTED`**: Alguns gateways preferem `200` no replay, mas retornar `422` de forma consistente (com `idempotentReplay: true` e `failureCode`) evita colapsar sucesso financeiro e rejeição de regra de negócio no mesmo código HTTP (Seção 9).
3. **Ausência de `SELECT ... FOR UPDATE` no Sprint 2**: Proposital e restrito a este sprint; requisições paralelas *diferentes* disputando a mesma carteira ainda estão sujeitas a lost update até o Sprint 3.
4. **Endpoints `GET` adiados (`Decisão 6A`)**: Mantidos fora deste sprint para manter o escopo enxuto; serão implementados junto com consultas paginadas por cursor opaco e reconciliação.

---

## 5. Decisões do Sprint 3 (Concorrência & Lock Pessimista por Wallet)

### 5.1. Evidência Real da Falha Antes do Lock
Antes de introduzir `LockMode.PESSIMISTIC_WRITE`, executamos a suíte `bun run test:concurrency` contra o PostgreSQL real (sem nenhum lock em `wallets`). Os seguintes bugs de concorrência foram reproduzidos diretamente:

- **Cenário 1 (Obrigatório — Seção 8: saldo `100.00 BRL`, 2 apostas paralelas de `80.00 BRL`)**:
  - Esperado: `1 PROCESSED`, `1 REJECTED`.
  - Observado sem lock: `Expected length: 1 | Received length: 2` — **ambas** as apostas de `80.00` passaram simultaneamente pela checagem `wallet.balance.isLessThan(money)` antes de qualquer `UPDATE`.
- **Cenário 2 (`50` apostas variadas em paralelo na mesma wallet de `500.00 BRL`)**:
  - Observado sem lock: `walletBalance: "420.00"` vs `ledgerBalance (reconstruído): "-615.00"` — *lost updates* graves no saldo materializado e divergência total com o ledger.
- **Cenário 4 (mistura paralela de `20 BETs` + `20 WINs`, esperado `300.00 BRL`)**:
  - Observado sem lock: `walletBalance: "220.00"` vs `ledgerBalance: "300.00"`.
- **Cenário 6 (`3` processos independentes via `Bun.spawn`, `15` apostas de `15.00 BRL` em wallet de `100.00 BRL`)**:
  - Esperado: `6 PROCESSED`, `9 REJECTED`.
  - Observado sem lock: `Expected length: 6 | Received length: 15` — todas as 15 apostas (`225.00 BRL`) foram aprovadas.

### 5.2. Estratégia Adotada (`1A`, `2A`, `3A`)
1. **Ordem Lock × Idempotência (`Decisão 1A`)**:
   - **Passo 1 (Fast-path pré-lock)**: `findByIdempotencyKey` sem lock. Replays tardios de transações já commitadas respondem imediatamente sem entrar na fila da *hot wallet*.
   - **Passo 2 (Lock pessimista por carteira)**: `findByIdForUpdate` executa `SELECT ... FROM wallets WHERE id = $1 FOR UPDATE` via `LockMode.PESSIMISTIC_WRITE` do MikroORM. Carteiras diferentes não competem pelo mesmo lock.
   - **Passo 3 (Re-checagem pós-lock)**: `findByIdempotencyOrExternal` (`$or: [{ idempotencyKey }, { providerId, externalTransactionId }]`) roda em 1 única query após adquirir o lock. Se outra requisição para a mesma carteira acabou de commitar enquanto esta esperava o lock, o replay/conflito é resolvido sem precisar provocar `23505` + `ROLLBACK`.
   - **Passo 4 (`23505` como rede de segurança)**: Mantido para colisões raras envolvendo a mesma `Idempotency-Key` apontando para `walletId`s distintos.
2. **Por que Lock Pessimista (`Decisão 2A`)**:
   - Sob alta contenção em *hot wallets* (ex.: 50 apostas paralelas na mesma carteira), o lock pessimista enfileira ordenadamente no PostgreSQL sem desperdício de rollbacks/retries (como ocorreria em *optimistic locking* com `version` ou em `SERIALIZABLE`), e mantém toda a lógica financeira encapsulada nos agregados `Wallet` / `WalletLedgerEntry` (facilitando `REFUND`/`ROLLBACK` no Sprint 4, ao contrário de `UPDATE` condicional em SQL cru).
3. **Política de `lock_timeout` (`Decisão 3A`)**:
   - Cada transação executa `SET LOCAL lock_timeout = '${DB_LOCK_TIMEOUT_MS}ms'` (padrão `3000ms`), escopado exclusivamente à transação atual (`SET LOCAL` nunca vaza entre conexões do pool).
   - Se o timeout estourar (PostgreSQL SQLSTATE `55P03` `lock_not_available`), o erro é mapeado para `WalletLockTimeoutError` → **HTTP `503 Service Unavailable`** (`errorCode: "WALLET_LOCK_TIMEOUT"`) com header **`Retry-After`** (`>= 1` segundo), instruindo o provedor a reenviar com segurança usando a mesma `Idempotency-Key`.

### 5.3. Confirmações Arquiteturais Explícitas
- **Nível de isolamento da transação**: Mantemos o padrão do PostgreSQL **`READ COMMITTED`**. Isso é intencional e necessário com `SELECT ... FOR UPDATE`: sob `READ COMMITTED`, quando a transação B acorda após a transação A liberar o lock da linha, o PostgreSQL reavalia o predicado e retorna a **versão recém-commitada** da `Wallet` (ao contrário de `REPEATABLE READ` + `FOR UPDATE`, que abortaria B com `40001 could not serialize access due to concurrent update`).
- **Ausência de `version: true` (optimistic locking) em `WalletOrmEntity`**: `WalletOrmEntity.version` é mapeado como `@Property({ type: 'integer', default: 1 })` **sem** `{ version: true }`. O controle de concorrência é feito exclusivamente pelo lock pessimista (`FOR UPDATE`), enquanto `Wallet.version` continua sendo incrementado no domínio a cada alteração de saldo para auditoria e contrato da API.
- **Dimensionamento do pool e armadilha corrigida**: Configurado via `DB_POOL_MIN=2` e `DB_POOL_MAX=20` por instância no Tarn/Knex (`mikro-orm.config.ts`). Durante os testes de 50 requisições paralelas, descobrimos e corrigimos um deadlock de pool sutil: `txEm.getConnection().execute(...)` sem passar `txEm.getTransactionContext()` tentava adquirir uma **2ª conexão** do pool enquanto todas as 20 conexões já estavam dentro de `BEGIN`, travando o pool inteiro. Substituir por `txEm.execute(...)` executa `SET LOCAL` na mesma conexão transacional (eliminando o deadlock e reduzindo 50 apostas paralelas para ~340–570ms).

### 5.4. Pontos que um Avaliador Pode Questionar
1. **Risco de `503 WALLET_LOCK_TIMEOUT` em picos extremos de uma única *hot wallet***: Com `lock_timeout = 3000ms`, se mais de ~300–500 transações modificadoras chegarem exatamente no mesmo segundo para a *mesma* `walletId`, algumas receberão `503` + `Retry-After` em vez de derrubarem o pool de conexões da aplicação inteira. Esse trade-off de *fail-fast / backpressure* protege a disponibilidade das demais carteiras.
2. **Ordem de execução quando há múltiplos locks**: Neste sprint apenas 1 `Wallet` é lockada por transação, portanto **não há risco de deadlock entre duas carteiras**. Se em evoluções futuras uma operação tocar duas carteiras (ex.: transferência P2P), será obrigatório ordenar os locks por `walletId` crescente.
3. **Por que manter `Wallet.version` se não usamos optimistic locking**: Mantemos `version` no domínio e no contrato HTTP (`POST /wallets`) porque o enunciado especifica que `version` inicia em 1 e incrementa somente quando o saldo muda (Seção 6.2), servindo como contador monotônico de mutações de saldo para consumidores/eventos (`WalletBalanceChanged`).

---

## 6. Decisões do Sprint 4 (Reversões, `PENDING_REFERENCE`, Ordem Global de Locks & Consultas)

### 6.1. Regras de `REFUND`, `ROLLBACK` e `WIN` Opcional (`Decisão 4A`)
- **Serviço compartilhado (`WagerTransactionResolutionService`)**: Tanto `ProcessWagerTransactionUseCase` (HTTP/SQS) quanto `ProcessPendingReferencesUseCase` (worker) executam exatamente as mesmas regras de negócio e persistência atômica dentro da mesma transação SQL.
- **Resolução e validação da referência**:
  - Resolvida por `(providerId, referenceExternalTransactionId)` e validada quanto a `providerId`, `playerId`, `walletId`, `currency` e `roundId` (`REFERENCE_MISMATCH`), igualdade exata de valor para reversões (`REFERENCE_AMOUNT_MISMATCH`), status `PROCESSED` (`REFERENCE_NOT_PROCESSED` para `REJECTED`/`FAILED`, ou `PENDING_REFERENCE` se a própria referência ainda estiver aguardando referência pai), e tipo alvo permitido (`REFUND` -> apenas `BET`; `ROLLBACK` -> `BET`, `WIN` ou `REFUND`; `WIN` opcional -> apenas `BET`, conforme `Decisão 4A`).
  - Unicidade por tipo de reversão (`uq_wager_tx_single_reversal_per_kind`): 1 `REFUND` e 1 `ROLLBACK` são tipos distintos de reversão, enquanto um segundo `REFUND` ou segundo `ROLLBACK` para a mesma referência é rejeitado com `REFERENCE_ALREADY_REVERSED`.
- **Reversão que produziria saldo negativo**:
  - Rejeitada explicitamente como `REJECTED` com **`REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE`** (distinto de `INSUFFICIENT_BALANCE` de uma aposta), sem alterar saldo nem gravar ledger, e preservando o replay fiel (`422 Unprocessable Entity` + `resulting_balance_amount`).

### 6.2. `PENDING_REFERENCE`, Backoff Exponencial e Exaustão (`Decisões 2A, 3A`)
- **Aceite fora de ordem**: Quando a referência ainda não existe, a transação é persistida em `PENDING_REFERENCE` com `next_reference_retry_at` e a API responde **`202 Accepted`** (Seção 9: *"aceite com processamento pendente"*).
- **Backoff exponencial + limite/TTL (`Decisão 3A`)**:
  - `PendingReferencePolicy` calcula `delay = min(baseDelayMs * 2^attempt, maxDelayMs)` (padrão `1s -> 2s -> 4s -> 8s -> 16s`, teto `30s`).
  - Exaustão ocorre quando `attempts >= maxAttempts` (padrão `5`) **ou** `now - createdAt >= ttlMs` (padrão `5 min`), parametrizável via `PENDING_REF_*` no `.env`.
- **Estado terminal na exaustão (`Decisão 2A`)**:
  - Seguindo literalmente a Seção 7.1 de `docs/CHALLENGE.md`, ao esgotar o limite a transação transiciona para **`REJECTED`** com `failureCode = REFERENCE_NOT_FOUND_EXPIRED` (reservando `FAILED` para falhas permanentes de infraestrutura conforme Seção 6.3).

### 6.3. Ordem Global Única de Locks (`Decisão 1A`) — Anti-Deadlock
- **Problema evitado**: Se o caminho HTTP lockar `Wallet -> WagerTransaction` e o worker em lote lockar `WagerTransaction (FOR UPDATE SKIP LOCKED) -> Wallet`, há risco clássico de deadlock AB-BA (`40P01`).
- **Desenho adotado**:
  1. **Descoberta leve (sem lock)**: `findDuePendingCandidates` lê apenas `(id, wallet_id)` das linhas `PENDING_REFERENCE` vencidas.
  2. **Ordem global única `Wallet -> WagerTransaction`**: Para cada candidato, o worker abre uma transação curta por transação:
     - **1º Lock**: `findByIdForUpdate(tx, walletId)` (`SELECT ... FROM wallets WHERE id = ? FOR UPDATE`) — idêntico ao caminho HTTP.
     - **2º Lock**: `findPendingByIdForUpdate(tx, txId)` (`SELECT id FROM wager_transactions WHERE id = ? AND status = 'PENDING_REFERENCE' FOR UPDATE SKIP LOCKED`). Se outro worker já processou/mudou o status, retorna `skipped` imediatamente.
- **Evidência em teste de estresse**: O teste `deadlock stress test` (tráfego HTTP paralelo de `BET`/`WIN`/`REFUND`/`ROLLBACK` disputando as mesmas carteiras enquanto 2 loops de worker rodam em paralelo) completou com **zero deadlocks (`40P01`)** e `wallet.balance == ledgerBalance` em 100% das carteiras.

### 6.4. Consultas e Reconciliação (`Decisão 5A`)
- **Paginação opaca do ledger (`GET /wallets/:walletId/ledger?cursor=...&limit=50`)**: `LedgerCursorCodec` codifica `{ t: createdAt, id }` em `base64url` usando keyset pagination `(created_at, id) < (cursor.t, cursor.id)` sobre o índice `idx_ledger_wallet_created_id`, mantendo estabilidade sob inserções concorrentes.
- **Reconciliação (`POST /wallets/:walletId/reconciliation`)**: Adquire `findByIdForUpdate` na carteira para obter snapshot consistente com `wallet_ledger_entries`, soma entradas com `Money`, e retorna `storedBalance`, `calculatedBalance`, `difference` (incluindo diferença negativa quando `stored < calculated`), `consistent` e `checkedEntries`. Divergências emitem log estruturado `wallet_reconciliation_mismatch` sem corrigir silenciosamente o banco.

### 6.5. Pontos que um Avaliador Pode Questionar
1. **Concorrência de dois `REFUND`s em `PENDING_REFERENCE` antes da `BET` chegar**: Ambos retornam `202 PENDING_REFERENCE` inicialmente (pois `reference_transaction_id` ainda é nulo); quando a `BET` chega e o worker executa na ordem `Wallet -> WagerTransaction`, o 1º `REFUND` torna-se `PROCESSED` e o 2º torna-se `REJECTED` (`REFERENCE_ALREADY_REVERSED`) de forma auditável.
2. **Descoberta sem lock no worker em múltiplas réplicas**: Duas réplicas podem selecionar o mesmo candidato na leitura inicial, mas a 1ª que adquirir o lock da `Wallet` processa e a 2ª sai `skipped` no `SELECT ... FOR UPDATE SKIP LOCKED` (zero duplicação, ao custo de no máximo uma leitura descartada).
3. **`REFUND` + `ROLLBACK` permitidos na mesma `BET`**: Seguimos literalmente a regra da Seção 7 (*"não pode ser revertida duas vezes pelo mesmo tipo de operação"*) e `uq_wager_tx_single_reversal_per_kind (reference_transaction_id, kind)`. Em integrações onde `REFUND` e `ROLLBACK` sobre a mesma `BET` fossem mutuamente exclusivos, bastaria remover `kind` da chave do índice único parcial.
4. **Custo de `findAllByWallet` na reconciliação**: Para carteiras com histórico muito longo (milhões de entradas), a reconciliação poderia evoluir para agregação `SUM(CASE WHEN direction='CREDIT' THEN amount ELSE -amount END)` no PostgreSQL ou checkpoints periódicos — aqui mantivemos o cálculo explícito sobre as entradas via `Money` para validar também `checkedEntries` sem `number`.

---

## 7. Sprint 5 — Consumer SQS FIFO, Inbox Persistente e Outbox Transacional

### 7.1. Use Case Compartilhado entre HTTP e SQS (`ProcessWagerTransactionUseCase`)
- **Borda HTTP (`WageringController`)** e **borda SQS (`SqsWagerConsumerService`)** convertem seus respectivos protocolos para o mesmo `ProcessWagerTransactionCommand` e executam **uma única regra de negócio e transação SQL** em `ProcessWagerTransactionUseCase`.
- O consumidor SQS valida o envelope (`messageId`, `type = WagerTransactionRequested`, `occurredAt`, `data`), normaliza `Money` para escala `"0.00"` e calcula `inboxPayloadHash` (SHA-256 sobre `type`, `idempotencyKey` e o hash canônico de negócio de `CanonicalPayloadHasher`), passando `inboxContext` (`consumerName`, `messageId`, `payloadHash`, `receivedAt`) e propagando `correlationId = messageId` / `causationId = messageId` para rastreabilidade até os eventos do Outbox.
- O **ack (`DeleteMessage`) só ocorre após o `COMMIT` bem-sucedido** da transação PostgreSQL.

### 7.2. Relação entre `inbox_messages` e `idempotency_key`
As duas tabelas formam **duas camadas complementares de deduplicação**:
1. **`inbox_messages` (`PRIMARY KEY (consumer_name, message_id)`) — Deduplicação de transporte/mensageria**:
   - Gravada **na mesma transação SQL** da mutação financeira (`wallets`, `wager_transactions`, `wallet_ledger_entries`, `outbox_messages`).
   - Se uma mensagem SQS for reentregue com o mesmo `messageId` (ex.: queda do consumidor após o `COMMIT` e antes do `DeleteMessage`, ou reenvio pelo produtor com o mesmo `messageId`), o fast-path no início da transação detecta `(consumer_name, message_id)` antes mesmo do lock da carteira (`FOR UPDATE`), retorna o resultado original e encerra sem duplicar débito, ledger ou eventos no Outbox.
2. **`wager_transactions` (`UNIQUE (idempotency_key)` + `UNIQUE (provider_id, external_transaction_id)`) — Deduplicação de negócio cross-channel**:
   - Protege quando a mesma transação de negócio chega por canais diferentes ou com `messageId` diferente (ex.: já processada via HTTP e depois entregue via SQS com novo `messageId` e mesma `idempotency_key`).
   - Nesse caso, o fast-path de `idempotency_key` valida o `payloadHash` canônico, registra o novo `messageId` em `inbox_messages` na mesma transação e retorna o replay sem emitir novos eventos de integração.

### 7.3. `messageId` Repetido com Payload Divergente (`INBOX_PAYLOAD_MISMATCH`)
- Se uma mensagem SQS chega com `(consumer_name, message_id)` já presente em `inbox_messages`, porém com `payload_hash` diferente, `ProcessWagerTransactionUseCase` rejeita imediatamente lançando `InboxPayloadMismatchError` (`INBOX_PAYLOAD_MISMATCH`), revertendo a transação sem alterar saldo, transação ou eventos.
- No consumidor SQS, `InboxPayloadMismatchError` é tratado como **erro permanente** (`VisibilityTimeout = 0`, sem `DeleteMessage`), permitindo que o broker esgote `maxReceiveCount = 3` e encaminhe a mensagem divergente para `wager-transactions-dlq.fifo`.

### 7.4. Decisões Aprovadas e Alinhamento com `docs/CHALLENGE.md`
- **Destino dos eventos (`Decisão 1A`)**: Provisionada fila FIFO dedicada **`wager-events.fifo`** (`SQS_EVENTS_QUEUE_NAME`) em conjunto com **`wager-transactions.fifo`** e **`wager-transactions-dlq.fifo`** (Seção 10 de `docs/CHALLENGE.md`). Como a Seção 11 especifica os eventos publicados sem nomear uma fila de saída própria, separá-los em `wager-events.fifo` evita loop de autoconsumo pelo worker de entrada. Cada evento é enviado com `MessageGroupId = aggregateId` (`walletId`) e `MessageDeduplicationId = outbox.id` (`eventId` UUIDv7 estável).
- **`VisibilityTimeout` vs `lock_timeout` (`Decisão 2A`)**: `SQS_CONSUMER_VISIBILITY_TIMEOUT_SEC = 30s` é `10×` maior que `DB_LOCK_TIMEOUT_MS = 3s`, garantindo folga operacional para transações válidas sem reentrega espúria durante contenção de carteira. Em erros transitórios (`WalletLockTimeoutError` / falhas de I/O), a mensagem **não** recebe ack e sua visibilidade é ajustada via `ChangeMessageVisibility` com backoff exponencial curto (`min(30s, baseSec * 2^(receiveCount - 1))`, `baseSec = 1s`).
- **Classificação de falhas e DLQ (`Decisão 3A`)**:
  - **Sucesso de processamento (`DeleteMessage` após commit)**: `PROCESSED`, `PENDING_REFERENCE`, `REJECTED` por regra de negócio (`INSUFFICIENT_BALANCE`, `REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE`, `REFERENCE_NOT_FOUND_EXPIRED` etc.) e replays válidos de Inbox/Idempotência.
  - **Encaminhamento à DLQ (`VisibilityTimeout = 0`, sem ack, até `maxReceiveCount = 3`)**: payload JSON inválido ou campos inválidos (`MalformedSqsEnvelopeError` / `ValidationApplicationError`), `IdempotencyConflictError`, `ExternalTransactionConflictError`, `InboxPayloadMismatchError`, `WalletNotFoundError` e violações de domínio (`DomainError`). Embora no HTTP `WALLET_NOT_FOUND` devolva `404` síncrono sem persistir transação, na fila assíncrona `RedrivePolicy` com `maxReceiveCount = 3` dá margem contra eventual atraso de propagação na abertura de carteira e preserva o registro morto na DLQ caso a carteira realmente não exista.
- **Processamento em lote e concorrência controlada (`Decisão 4A`)**:
  - O consumidor busca até `SQS_CONSUMER_BATCH_SIZE = 10` mensagens por poll, agrupa pelo `MessageGroupId` (`walletId` na falta do atributo) mantendo a ordem de chegada no grupo, e executa grupos distintos concorrentemente até `SQS_CONSUMER_CONCURRENCY = 5`.
  - Se a mensagem `i` de uma carteira falhar (por erro transitório ou permanente), o processamento daquele grupo é interrompido imediatamente e todas as mensagens subsequentes `i+1..n` da mesma carteira no lote têm sua visibilidade devolvida para **`0s` via `ChangeMessageVisibility`**, preservando a ordenação lógica por carteira e evitando espera ociosa de `30s`, enquanto carteiras independentes no mesmo lote seguem normalmente.
- **Eventos de integração emitidos (`Decisão 5A`)**:
  - Somente os 4 eventos previstos na Seção 11 de `docs/CHALLENGE.md`: `WagerTransactionProcessed` (toda transação `PROCESSED`, inclusive `LOSS` e `OPENING` quando `initialBalance > 0`), `WagerTransactionRejected` (toda `REJECTED`, imediata ou após exaustão de `PENDING_REFERENCE`), `WalletBalanceChanged` (somente quando há entrada no ledger) e `WagerTransactionPendingReference` (apenas na entrada inicial em `PENDING_REFERENCE`, sem re-emitir a cada retry do worker). Replays e deduplicações não gravam novos eventos.

### 7.5. Outbox Transacional, Concorrência de Publishers e Semântica At-Least-Once
- `OutboxPublisherUseCase` reivindica eventos pendentes vencidos com `SELECT id FROM outbox_messages WHERE published_at IS NULL AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY occurred_at ASC, id ASC LIMIT ? FOR UPDATE SKIP LOCKED`.
- Cada item só recebe `published_at` após confirmação síncrona do `SendMessageCommand` ao SQS; falhas incrementam `attempts` e aplicam backoff exponencial (`min(baseDelayMs * 2^attempt, maxDelayMs)`, padrão `500ms..30s`).
- **Semântica at-least-once e reenvio seguro**: Se o publisher falhar **entre** o envio ao SQS e o `UPDATE outbox_messages SET published_at = ...`, o próximo ciclo reenviará exatamente o mesmo `eventId` estável (`MessageDeduplicationId = outbox.id`). Dentro da janela de deduplicação FIFO do SQS (5 minutos), o broker descarta a duplicata automaticamente; além dela, consumidores downstream mantêm idempotência por `eventId`.
- **Ordem de eventos com múltiplos publishers (Trade-off)**:
  - Um único publisher processa estritamente em ordem global `occurred_at ASC, id ASC`. Com múltiplos publishers concorrentes (`FOR UPDATE SKIP LOCKED`), o Publisher A pode travar o evento `E1` de `W1` enquanto o Publisher B trava `E2` da mesma `W1`; se `A` sofrer atraso de rede antes de chamar `SendMessage`, `E2` pode alcançar `wager-events.fifo` antes de `E1` dentro do mesmo `MessageGroupId`.
  - **Mitigação documentada**: cada `WalletBalanceChanged` carrega `walletVersion` monotônico por carteira e todo evento carrega `occurredAt` + `eventId`, permitindo que projeções/consumidores ordenem ou ignorem estados obsoletos por `(aggregateId, walletVersion)`. Se ordem rígida de saída por carteira mesmo sob múltiplos publishers passar a ser requisito forte, basta adquirir um lock leve de partição/carteira no publisher ou particionar a varredura por hash de `aggregate_id`.

### 7.6. Injeção de Falhas para Testes Reais e Shutdown Gracioso
- Em vez de mockar PostgreSQL ou SQS nos testes, `SqsWagerConsumerService` (`beforeProcessMessage`, `afterCommitBeforeAck`) e `OutboxPublisherUseCase` (`afterSendBeforeMarkPublished`) aceitam ganchos de falha determinísticos in-process para exercitar quedas exatas entre commit e ack e entre envio e marcação de publicação contra infraestrutura real.
- `SqsWagerConsumerService`, `OutboxPublisherWorker` e `PendingReferenceWorker` implementam `OnModuleDestroy`: interrompem novos ciclos (`stopped = true`), cancelam `setTimeout` pendente e aguardam a conclusão da iteração `inFlight` antes de fechar o pool do PostgreSQL e destruir o `SQSClient`.

### 7.7. Pontos que um Avaliador Pode Questionar
1. **Por que cada mensagem SQS abre sua própria transação SQL em vez de uma única transação para o lote de 10?** Uma transação única para carteiras distintas abortaria mensagens válidas caso uma mensagem irmã falhasse ou batesse `lock_timeout`, além de ampliar o tempo de retenção de locks de linha no PostgreSQL. Isolar o commit por mensagem garante progresso independente por carteira e ack individual preciso.
2. **Por que `wager-events.fifo` em vez de SNS FIFO?** O desafio provisiona apenas o SQS LocalStack (`init-sqs.sh`) e exige `wager-transactions.fifo` + DLQ FIFO na entrada. Uma fila FIFO dedicada mantém `MessageGroupId = aggregateId` e `MessageDeduplicationId = eventId` nativamente no mesmo broker, sem impedir futura substituição da implementação de `EventPublisherPort` por SNS/EventBridge.
3. **Como lidar com a janela de 5 minutos da deduplicação FIFO do SQS?** Se um publisher ficar desconectado por mais de 5 minutos após um crash exatamente pós-`SendMessage`, o SQS pode aceitar a segunda entrega; por isso o Outbox garante semântica *at-least-once* com `eventId` imutável no payload, transferindo a idempotência de longo prazo ao consumidor do evento.
4. **Por que `polling` (`waitUntil`) nos testes de mensageria?** Evita `sleep` cego e flakiness sob carga de CI/LocalStack: os testes consultam estado real em intervalos curtos (50ms) até convergência determinística ou timeout explícito.

