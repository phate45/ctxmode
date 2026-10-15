---
owner: platform
---

# Caching Guide

## Read-Through Cache

Reads hit the cache first and fall back to the database on a miss, then populate the cache with a jittered TTL.

## Write Path

Writes go to the database and publish an invalidation event; caches never accept writes directly.
