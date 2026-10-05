# Google Analytics 4

GA4_MEASUREMENT_ID and GA4_API_SECRET are configured in Render. The API secret is server-only.
Migration 007 creates an isolated pending purchase table; no balances, commissions or existing orders are changed.

The home page asks permission before loading Google. Metrics are page_view, begin_checkout and purchase.
Automatic enhanced measurement is disabled in GA4. Only public package information, pseudonymous Google client/session identifiers and verified order identifiers are sent. Photos, search results, account emails, receipt parameters and affiliate codes are excluded. URL queries are stripped; campaign source/medium values use a small allowlist.

Purchase is sent exclusively by the server worker for confirmed, credited InfinitePay orders with consent and a valid Google client/session identifier. The customer need not return to the site. The durable row survives restarts; the order ID is the transaction_id for deduplication of retries. Failed sends wait five minutes; events older than Google's 72-hour window are excluded. No historical sales are imported. Visitors who refuse metrics or block Google may not be represented. Withdrawal removes that account's unsent purchase rows; already collected events are not retroactively removed.

Missing configuration/schema disables analytics and preserves checkout. A failure storing analytics context does not fail the order. No Meta/TikTok integrations, changes to prices, refunds or commission rules.

Validation: 70 tests pass, including consent, sensitive URL exclusion, pending payment exclusion, server-authoritative amounts, retry/deduplication, ownership and withdrawal. A successful Measurement Protocol HTTP response only acknowledges receipt, so final reporting must also be observed in GA4. No real payment is used for the smoke test; a production purchase remains to be observed when the first consenting customer pays.
