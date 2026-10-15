---
title: Authentication Flow
---

# Authentication Flow

Sessions use short-lived access tokens and a rotating refresh token stored in an HttpOnly cookie.

## Token Refresh

The client calls `refreshSession()` when the access token is within thirty seconds of expiry.

```typescript
export async function refreshSession(client: ApiClient): Promise<Session> {
  const res = await client.post("/auth/refresh", { credentials: "include" });
  if (res.status === 401) throw new SessionExpiredError();
  return res.json();
}
```

## Password Hashing

Passwords are hashed with argon2id, memory cost 64 MiB, three iterations.
