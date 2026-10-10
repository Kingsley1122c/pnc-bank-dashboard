# PNC Core Deployment

## Render environment

The production service is configured for one origin and one application base URL:

- `APP_BASE_URL=https://pnc-core.com`
- `ALLOWED_ORIGINS=https://pnc-core.com,https://www.pnc-core.com`
- `VITE_API_BASE_URL` remains empty because the frontend and API are served by the same Render service.

Keep `EMAIL_MODE=disabled` until the sender domain and controlled-recipient tests pass. Resend is the sole provider; store its API key and webhook secret only in Render's secret environment settings.

## Render custom domain

1. Open the `pnc-bank-dashboard` web service in Render.
2. Under **Settings > Custom Domains**, add the preferred hostname (`pnc-core.com` for an apex-primary setup or `www.pnc-core.com` for a www-primary setup). Render automatically adds the counterpart and redirects it to the hostname that was added.
3. Copy the exact DNS type, host, and target shown by Render for each generated row. Do not use a target copied from another service or from an example.
4. After DNS propagation, click **Verify** for the domain and wait for Render to report that TLS is active.
5. Keep the working `pnc-bank-dashboard.onrender.com` subdomain enabled until both custom hostnames pass HTTPS and health checks.
6. Do not enable production email links until Render reports the custom domain as verified and TLS is active.

As observed on October 10, 2026, the workspace's two included custom-domain slots are used by `nivoracore.com` and `www.nivoracore.com` on the `nivora-core` service. Those domains must remain attached and operational. The approved PNC configuration adds `pnc-core.com` through this repository's Blueprint; Render automatically adds `www.pnc-core.com` as the redirect counterpart. Render's published overage price is `$0.25` per additional domain per month, so the approved maximum incremental cost for the PNC pair is `$0.50` per month. This does not require a workspace plan upgrade.

## Namecheap DNS

In **Namecheap > Domain List > pnc-core.com > Advanced DNS**, create only the records displayed by Render. The required rows cannot be filled with verified values from this repository because Render assigns and displays the authoritative targets in its dashboard.

The authoritative Namecheap nameservers returned the following website records on October 10, 2026 (TTL 1800):

| Host | Type | Current value | Status |
| --- | --- | --- | --- |
| `@` | `A` | `162.255.119.159` | Conflicts with Render; points the apex away from the Render service |
| `www` | `CNAME` | `parkingpage.namecheap.com` | Conflicts with Render; points `www` to Namecheap parking |

Preserve unrelated MX and TXT records. Also check for and remove hostname-conflicting URL Redirect, ALIAS, and `AAAA` records only when updating that same hostname according to Render's displayed instructions. Render does not use IPv6 for custom-domain routing, so an `AAAA` record on `@` or `www` can prevent reliable routing.

Applied Namecheap records:

| Purpose | Type | Host | Value | TTL |
| --- | --- | --- | --- | --- |
| Apex domain | `A` | `@` | `216.24.57.1` | 1 minute |
| `www` domain | `CNAME` | `www` | `pnc-bank-dashboard.onrender.com` | 1 minute |

Both records were published by Namecheap and verified by Render on October 10, 2026. TLS certificate issuance must still show `issued` before the custom domain is considered production-ready.

Safe update order:

1. Add the preferred custom hostname to the correct Render service and confirm that Render shows both the apex and `www` rows.
2. Copy the exact displayed DNS values into the table above before editing Namecheap.
3. In Namecheap, replace only the conflicting `@` website record with Render's displayed apex record.
4. Replace only the conflicting `www` parking/redirect record with Render's displayed `www` record.
5. Leave mail-related MX/TXT records and any unrelated subdomains unchanged.
6. Wait for both authoritative Namecheap nameservers and public resolvers to return the new values, then click **Verify** in Render.
7. Confirm certificate issuance, HTTPS redirects, and `https://pnc-core.com/api/health` before changing any application URL or disabling the Render subdomain.

DNS and TLS are considered complete only when Render shows both hostnames verified and HTTPS requests succeed.

## Resend DNS

Add the sending domain in Resend separately from the Render custom domain. Resend will provide the exact SPF, DKIM, and return-path records. Copy those values into Namecheap without replacing unrelated website records. Review existing SPF and DMARC records before editing; multiple SPF TXT records for the same host are invalid.

Production delivery requires all of the following:

- Resend sender domain shows verified.
- `EMAIL_FROM` uses that verified domain.
- `EMAIL_REPLY_TO` is a monitored address.
- `RESEND_API_KEY` and `RESEND_WEBHOOK_SECRET` are Render secrets.
- Controlled sending succeeds in restricted mode before `EMAIL_MODE` is changed to `live`.

## Email rollout and operations

Configure these values in Render: `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `EMAIL_FROM`, `EMAIL_FROM_NAME`, `EMAIL_REPLY_TO`, `EMAIL_MODE`, `EMAIL_TEST_RECIPIENT`, and `APP_BASE_URL`. Set the Resend webhook URL to `https://pnc-core.com/api/webhooks/resend` and subscribe to delivered, bounced, complained, and failed email events.

Use this rollout sequence:

1. Leave `EMAIL_MODE=disabled` while deploying and checking `/api/health`.
2. Verify the Resend sender domain, SPF, DKIM, return path, and a single valid DMARC policy. Do not replace unrelated DNS records.
3. Set `EMAIL_TEST_RECIPIENT` to a controlled inbox and change `EMAIL_MODE=restricted`.
4. Register a test-only account using that address and confirm the admin communication history records provider acceptance.
5. Confirm the signed webhook changes the status to delivered and verify the message arrived in the controlled inbox.
6. Test password reset, verification, one transaction notification, and one admin announcement only with controlled test data.
7. Change `EMAIL_MODE=live` only after every controlled test passes.

Application events commit their business data and email outbox records in the same database transaction. A background worker submits each email to Resend with a stable idempotency key. Provider acceptance is not delivery: `accepted` means Resend accepted the request, while `delivered`, `bounced`, `complained`, and `failed` come from verified webhook events. Failed submissions retry at increasing delays for at most five attempts; financial operations are never replayed by an email retry.

Admin announcements are authorized and expanded server-side into one message per recipient, so recipient addresses are never disclosed to each other. Bulk campaigns require the exact confirmation phrase shown in the preview. Only failed campaign jobs can be requeued.

Email content and provider metadata remain in the application database for operational history. Access is limited to authenticated admin communication endpoints; action tokens are SHA-256 hashes, expire, and can be used once. Establish an approved retention period before enabling live mail, then add an audited purge job for expired tokens, old webhook payloads, and old rendered message payloads.