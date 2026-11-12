# Notifications

A person sees a waiting inbox item only in the portal. The first integration is one Slack webhook URL, with one POST
when an inbox item opens. Rejected: email (needs SMTP), a comment (needs an issue), a browser notification (needs an
open tab).

## Nice to have

- Tell a person when an inbox item waits for them. Text from a run is untrusted
  ([workflows.md](../architecture/workflows.md)).
- A fire of a schedule that starts no run has no inbox item ([workflows.md](../architecture/workflows.md)). It is a
  second source of notifications.
- Add an "Integrations" group to the portal nav, and move GitHub and the Slack webhook into it
  ([portal.md](../architecture/portal.md)).
