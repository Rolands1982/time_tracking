# Edge Functions

## send-mail

Sends an e-mail with attachments (customer summaries, later invoices) through a plain SMTP mailbox on
behalf of the signed-in app user. The browser cannot talk SMTP, so this is the one server-side piece
of the app. The mailbox password lives only in the function's secrets, never in the repository.

### Deploy

Either with the CLI from a machine where you are logged in to Supabase:

```sh
supabase functions deploy send-mail --project-ref rukkgafbqvwsoekzwnge
```

or in the dashboard: **Edge Functions → Deploy a new function → Via editor**, name it `send-mail`,
and paste `index.ts` and `validate.ts` (add the second file with the "+" in the file tree).
The function verifies the caller's token itself; leave "Verify JWT" at its default.

### Secrets

Dashboard → **Edge Functions → Secrets** (or `supabase secrets set NAME=value`):

| Secret               | Value for mail.online.lv                                   |
| -------------------- | ---------------------------------------------------------- |
| `SMTP_HOST`          | `mail.online.lv`                                           |
| `SMTP_PORT`          | `465` (if that fails, try `587` with `SMTP_TLS=false`)     |
| `SMTP_TLS`           | `true`                                                     |
| `SMTP_USER`          | the mailbox login, usually `rolands@actusbi.lv`            |
| `SMTP_PASS`          | the mailbox password                                       |
| `MAIL_FROM`          | `Rolands <rolands@actusbi.lv>`                             |
| `MAIL_ALLOWED_USERS` | optional: the e-mail you sign in to cloud sync with        |

### Test

Dashboard → Edge Functions → send-mail → Invoke, or from the app: Customer summary → E-mail → Send.
Errors come back as `{ "error": "..." }`; the function's **Logs** tab shows the SMTP conversation.
