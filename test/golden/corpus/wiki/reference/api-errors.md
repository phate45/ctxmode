# API Error Reference

## ERR_RATE_LIMITED

Returned with HTTP 429 when a client exceeds its quota. The `Retry-After` header says when to retry.

## ERR_TENANT_SUSPENDED

Returned with HTTP 403 when billing suspends a tenant.
