---
title: Deployment Runbook
---

# Deployment Runbook

## Full Procedure

Before starting, confirm the release branch is tagged and the changelog entry exists. The on-call engineer owns the rollout from the first canary until the final promotion, and nobody else touches the pipeline during that window.

Step one is the database check. Run the pending-migrations report and make sure every migration in the release is additive. Destructive migrations ship in a separate release after the code that stops reading the old columns has been live for a full week.

Step two is the canary. Promote the build to the canary pool, which takes roughly two percent of production traffic. Watch the error budget dashboard and the p99 latency panel for fifteen minutes. Any regression above the alert threshold aborts the rollout automatically.

Step three is the regional wave. Promote to one region at a time, starting with the region that has the lowest traffic at that hour. Each wave waits for the health checks to report green on every instance before the next wave begins.

Step four covers feature flags. New behaviour stays behind a flag that defaults to off. Turn it on for internal tenants first, then for ten percent of external tenants, then for everyone. Record each flag flip in the release ticket with a timestamp.

Step five is verification. Run the synthetic transaction suite against production. It creates a throwaway tenant, performs a signup, a payment and a refund, and deletes the tenant afterwards. A failing synthetic check pages the on-call engineer even if dashboards look healthy.

Step six handles rollback. If anything looks wrong, roll back first and investigate second. The rollback command redeploys the previous image tag; it never reverts database migrations, which is why migrations must stay additive.

Step seven is communication. Post the release summary in the engineering channel with the version, the flags involved and any known issues. Support gets a separate note written for customers, without internal jargon or ticket numbers.

Step eight closes the loop. Update the runbook if any step surprised you. A runbook that drifts from reality is worse than none, because people trust it during an incident when they have the least time to double-check.

Appendix on timing: avoid deploying within two hours of a scheduled batch job, during the monthly invoicing run, or on the last business day before a holiday. Those windows have the least slack for a rollback and the most customers watching.

Appendix on secrets: deployments never print environment variables. The pipeline masks anything that looks like a key, but the safer habit is to never echo configuration in the first place, even in debug output.

Appendix on capacity: before a large launch, raise the autoscaler floor so the first traffic spike lands on warm instances. Cold instances add seconds of latency while caches fill and connection pools open.

Appendix on dependencies: when a release bumps a shared library, deploy the services that consume it in dependency order, leaf services first. A gateway that speaks a newer protocol than its upstreams can turn a harmless bump into a cascading outage.

Appendix on observability: every release annotates the dashboards with its version, so a latency step change lines up visually with the deploy that caused it. Without annotations, on-call engineers waste the first ten minutes of an incident guessing which change landed when.

Appendix on mobile clients: server releases must stay compatible with the three most recent app versions, because users update slowly. Breaking a field that an old client still reads shows up as crashes in app store reviews days later, long after the deploy looks clean.

Appendix on freezes: during a declared freeze only security fixes ship, and each one needs a second reviewer from the platform team. The freeze calendar lives next to this runbook and wins over any other schedule.

Appendix on access: production shell access is granted per incident through the break-glass workflow, expires after four hours, and is logged to the audit trail. Routine deploys never need it; if a step requires a shell, the step belongs in the pipeline instead.

Appendix on drills: once a quarter the team rehearses a rollback on a staging copy of production, timing each step. The drill results feed back into the timing estimates at the top of this runbook.
