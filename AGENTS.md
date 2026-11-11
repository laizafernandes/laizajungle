# AGENTS.md — Regras de Engenharia e Fluxo de Trabalho

Este arquivo define as regras inegociáveis para qualquer agente ou desenvolvedor atuando neste repositório.

## 1. Regras Fixas Invioláveis

1. **Dinheiro nunca é `number`, `float` ou `double`**:
   - Na aplicação: sempre usar o Value Object imutável `Money` serializado como string decimal de escala fixa (`"25.00"`) e aritmética decimal exata (`decimal.js`).
   - No banco de dados: sempre armazenar valores monetários como `numeric(18,2)` e moeda como código ISO-4217 (`varchar(3)` / `char(3)`).
2. **Garantias vivem no banco de dados (`UNIQUE`, `CHECK`, `FOREIGN KEY`, `TRIGGER`)**:
   - Não confie apenas na validação em memória/código de aplicação.
   - Restrições de saldo não-negativo (`balance_amount >= 0`), unicidade de carteira (`player_id, currency`), unicidade de transação (`idempotency_key`, `(provider_id, external_transaction_id)`), unicidade de reversão por tipo, unicidade de lançamento no ledger por transação e **imutabilidade do ledger** (trigger bloqueando `UPDATE` e `DELETE` em `wallet_ledger_entries`) devem ser impostas no schema PostgreSQL.
3. **Testes de integração usam PostgreSQL e SQS (LocalStack) reais, sem mocks**:
   - Proibido substituir o PostgreSQL ou o AWS SQS por mocks em testes de integração e concorrência.
   - Os testes devem aguardar os containers estarem saudáveis (`healthy`) antes de rodar, garantindo reprodutibilidade do zero (`docker compose up`).
4. **Um único Use Case compartilhado entre HTTP e SQS**:
   - O processamento de transações (`ProcessWagerTransactionUseCase`) deve ser compartilhado entre o controller HTTP (`POST /wagering/transactions`) e o consumidor SQS (`wager-transactions.fifo`).
   - Diferenças de protocolo (headers HTTP vs envelope SQS + registro na tabela `inbox_messages`) são tratadas na borda/contexto transacional, preservando uma única regra de negócio e transação SQL atômica.
5. **SQS FIFO é otimização de transporte, não garantia final**:
   - As filas seguem a nomenclatura exigida em `docs/CHALLENGE.md` (`wager-transactions.fifo` e `wager-transactions-dlq.fifo`), utilizando `MessageGroupId = walletId` para afinidade de ordenação por carteira e `RedrivePolicy` para envio à DLQ após o limite de tentativas.
   - A garantia real de idempotência, ordenação lógica (via `PENDING_REFERENCE`) e consistência financeira reside no PostgreSQL (`inbox_messages`, `wager_transactions`, locks e constraints).

## 2. Fluxo de Trabalho por Sprint

- **Antes de codar cada sprint**:
  1. Ler `docs/CHALLENGE.md` e `AGENTS.md`.
  2. Propor um plano curto e objetivo.
  3. **Aguardar aprovação explícita** antes de escrever ou alterar código.
- **Ao final de cada sprint**:
  1. Executar o linter (`bun run lint`), typecheck (`bun run typecheck`) e as suítes de testes (`bun test` / `bun run test:integration`).
  2. Atualizar a documentação relevante (`README.md` e/ou `ARCHITECTURE.md`).
  3. Listar claramente as decisões técnicas tomadas e os trade-offs assumidos.
