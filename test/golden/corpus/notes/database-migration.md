---
title: Database Migration Plan
tags: [postgres, migration]
---

# Database Migration Plan

Moving the ledger service from SQLite to PostgreSQL so the read replicas can scale out.

## Schema Changes

The `accounts` table switches to UUID primary keys. Every foreign key referencing `accounts.id` is rewritten in the same migration.

### Index Strategy

A composite index on `(tenant_id, created_at)` serves the monthly statement query.

```sql
CREATE INDEX idx_accounts_tenant_created ON accounts (tenant_id, created_at);
ALTER TABLE accounts ADD COLUMN archived_at TIMESTAMPTZ;
```

## Rollback

A feature flag named `ledger_pg_reads` routes reads back to SQLite within one deploy.
