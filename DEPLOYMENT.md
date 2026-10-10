# PNC Core Deployment

## Render environment

The production service is configured for one origin and one application base URL:

- `APP_BASE_URL=https://pnc-core.com`
- `ALLOWED_ORIGINS=https://pnc-core.com,https://www.pnc-core.com`
- `VITE_API_BASE_URL` remains empty because the frontend and API are served by the same Render service.

Keep `EMAIL_MODE=disabled` until the sender domain and controlled-recipient tests pass. Store all API keys and SMTP credentials only in Render's secret environment settings.

## Render custom domain

1. Open the `pnc-bank-dashboard` web service in Render.
2. Add `pnc-core.com` and, if desired, `www.pnc-core.com` under **Settings > Custom Domains**.
3. Copy the exact DNS type, host, and target shown by Render for each domain.
4. Do not enable production email links until Render reports the custom domain as verified and TLS is active.

## Namecheap DNS

In **Namecheap > Domain List > pnc-core.com > Advanced DNS**, create only the records displayed by Render. The required rows cannot be filled with verified values from this repository because Render assigns and displays the authoritative targets in its dashboard.

Record the verified values here during deployment:

| Purpose | Type | Host | Value | TTL |
| --- | --- | --- | --- | --- |
| Apex domain | From Render | `@` | From Render custom-domain screen | Automatic |
| `www` domain | From Render | `www` | From Render custom-domain screen | Automatic |

Remove conflicting Namecheap parking, redirect, A, ALIAS, or CNAME records only after comparing them with Render's instructions. DNS and TLS are considered complete only when Render shows both domains verified and an HTTPS request succeeds.

## Resend DNS

Add the sending domain in Resend separately from the Render custom domain. Resend will provide the exact SPF, DKIM, and return-path records. Copy those values into Namecheap without replacing unrelated website records. Review existing SPF and DMARC records before editing; multiple SPF TXT records for the same host are invalid.

Production delivery requires all of the following:

- Resend sender domain shows verified.
- `EMAIL_FROM` uses that verified domain.
- `EMAIL_REPLY_TO` is a monitored address.
- `RESEND_API_KEY` and `RESEND_WEBHOOK_SECRET` are Render secrets.
- Controlled sending succeeds in restricted mode before `EMAIL_MODE` is changed to `live`.