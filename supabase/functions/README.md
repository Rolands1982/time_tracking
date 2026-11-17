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

## eds

The app's link to the VID EDS API for the monthly employer's report (Darba devēja ziņojums): create the
document, run EDS's checks, read its state, submit it. The browser can neither reach EDS (no cross-origin
access) nor should it hold the API key, so the key lives only in this function's secrets.

### Deploy

```sh
supabase functions deploy eds --project-ref rukkgafbqvwsoekzwnge
```

or in the dashboard: **Edge Functions → Deploy a new function → Via editor**, name it `eds`, and paste
`index.ts` and `validate.ts` from `supabase/functions/eds/` (add the second file with the "+" in the file
tree). The function verifies the caller's token itself; leave "Verify JWT" at its default.

### Secrets

Create the credential in EDS: **IESTATĪJUMI → API atslēgas**, scope **Dokumentu API**, no IP address
(Supabase calls from changing addresses).

| Secret              | Value                                                                    |
| ------------------- | ------------------------------------------------------------------------ |
| `EDS_API_KEY`       | an API key (valid up to 90 days; replace the secret when you renew it)   |
| `EDS_ALLOWED_USERS` | optional: the e-mail you sign in to cloud sync with                      |

Instead of a key, an API certificate (its private key is used here to sign a token per day):

| Secret            | Value                                                               |
| ----------------- | ------------------------------------------------------------------- |
| `EDS_CERT_ID`     | the certificate's id from EDS                                       |
| `EDS_CERT_KEY`    | its private key, PKCS#8 in base64 (a PEM body works)                |
| `EDS_TAXPAYER_NO` | the company registration number                                     |

### Test

From the app: Reports → Employer's report for VID → Send to EDS and check. Nothing is submitted until
"Submit to VID" is pressed and confirmed. Errors come back as `{ "error": "..." }`; the function's **Logs**
tab shows which document was created, submitted or deleted.
