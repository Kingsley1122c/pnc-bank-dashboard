# Nevora Core Deployment

## Render environment

After `nevoracore.com` is verified on the existing Render service, configure:

- `APP_BASE_URL=https://nevoracore.com`
- `ALLOWED_ORIGINS=https://nevoracore.com,https://www.nevoracore.com`
- `VITE_API_BASE_URL` remains empty because the frontend and API are served by the same Render service.

Keep `EMAIL_MODE=disabled` until the sender domain and controlled-recipient tests pass. Resend is the sole provider; store its API key and webhook secret only in Render's secret environment settings.

Do not apply these runtime values before Render verifies the new hostnames and issues TLS. Keep the current Render subdomain available for rollback.

## Render custom domain

1. Open service `srv-d7elbh1j2pic738q646g` (`pnc-bank-dashboard`) in Render. The service name is a legacy infrastructure identifier and does not define the public brand.
2. Under **Settings > Custom Domains**, add `nevoracore.com` as the preferred apex hostname. Confirm Render also prepares `www.nevoracore.com` as its counterpart before editing DNS.
3. Copy the exact DNS type, host, and target shown by Render for each generated row. Do not use a target copied from another service or from an example.
4. After DNS propagation, click **Verify** for the domain and wait for Render to report that TLS is active.
5. Keep the working `pnc-bank-dashboard.onrender.com` subdomain enabled until both custom hostnames pass HTTPS and health checks.
6. Do not enable production email links until Render reports the custom domain as verified and TLS is active.

`nivoracore.com` and `www.nivoracore.com` belong to the separate `nivora-core` project. Never edit, detach, redirect, or reuse either hostname during this migration. If Render presents a charge or plan change for the Nevora Core pair, stop and obtain approval before accepting it.

## Namecheap DNS

In **Namecheap > Domain List > nevoracore.com > Advanced DNS**, create only the records displayed by Render for service `srv-d7elbh1j2pic738q646g`. Do not copy values from `pnc-core.com`, `nivoracore.com`, another Render service, or an example.

Record the provider-displayed values here before editing Namecheap:

| Purpose | Type | Host | Render target | TTL | Status |
| --- | --- | --- | --- | --- | --- |
| Apex domain | Pending Render instructions | `@` | Pending Render instructions | Pending | Not configured |
| WWW domain | Pending Render instructions | `www` | Pending Render instructions | Pending | Not configured |

Preserve unrelated MX and TXT records. Remove or replace hostname-conflicting URL Redirect, ALIAS, A, CNAME, or AAAA records only for `nevoracore.com` when Render's displayed instructions require it.

Safe update order:

1. Add the preferred custom hostname to the correct Render service and confirm that Render shows both the apex and `www` rows.
2. Copy the exact displayed DNS values into the table above before editing Namecheap.
3. In Namecheap, replace only the conflicting `@` website record with Render's displayed apex record.
4. Replace only the conflicting `www` parking/redirect record with Render's displayed `www` record.
5. Leave mail-related MX/TXT records and any unrelated subdomains unchanged.
6. Wait for both authoritative Namecheap nameservers and public resolvers to return the new values, then click **Verify** in Render.
7. Confirm certificate issuance, HTTPS redirects, and `https://nevoracore.com/api/health` before applying the new runtime URL or changing production traffic.

DNS and TLS are considered complete only when Render shows both hostnames verified and HTTPS requests succeed.

## Resend DNS

Add the sending domain in Resend separately from the Render custom domain. Resend will provide the exact SPF, DKIM, and return-path records. Copy those values into Namecheap without replacing unrelated website records. Review existing SPF and DMARC records before editing; multiple SPF TXT records for the same host are invalid.

Production delivery requires all of the following:

- Resend sender domain shows verified.
- `EMAIL_FROM` uses that verified domain.
- `RESEND_API_KEY` and `RESEND_WEBHOOK_SECRET` are Render secrets.
- Controlled sending succeeds in restricted mode before `EMAIL_MODE` is changed to `live`.

## Email rollout and operations

Configure these values in Render: `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `EMAIL_FROM`, `EMAIL_FROM_NAME`, `EMAIL_MODE`, `EMAIL_TEST_RECIPIENT`, and `APP_BASE_URL`. Set the Resend webhook URL to `https://nevoracore.com/api/webhooks/resend` and subscribe to delivered, bounced, complained, and failed email events only after TLS is active.

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