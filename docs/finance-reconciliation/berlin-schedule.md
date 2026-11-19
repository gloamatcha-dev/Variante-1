# Berlin finance schedule

| Existing Healthchecks | Cron expression | Time zone | Grace time |
| --- | --- | --- | --- |
| Sync scan and sync reconciliation | `0 13 * * *` | `Europe/Berlin` | 65 minutes |
| Daily scan and daily reconciliation | `0 14 * * *` | `Europe/Berlin` | 65 minutes |

Apply these settings to the four existing checks when publishing this release. Keep their ping URLs and integrations. The grace period covers dispatch throughout the Vercel Hobby hour and time for the final signal.

After publication, confirm all four Finance cron entries in the GLOA Production project. The routes admit only the matching Berlin hour before starting a worker or emitting its Healthchecks signals. An out-of-window request returns `outside_schedule`. Existing continuation, lease and reconciliation rules still apply.

A separately approved one-cycle DB window must use the UTC equivalents for its date. Use 12:00–13:00 UTC for sync and 13:00–14:00 UTC for verification in winter. Use 11:00–12:00 UTC and 12:00–13:00 UTC in summer. Release publication keeps the Finance DB gate closed and the historical Snapshot Guard blocked.
