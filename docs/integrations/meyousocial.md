# Signing up for Producer Studio from meyousocial.com

How a membership sold on **meyousocial.com** (WordPress + MemberPress) creates and keeps a **Producer Studio** workspace
("space") in step, and how a space made in the app gets a membership. Producer Studio's side is built and live
(`services/membership.ts`, `routes/provision.ts`, migration v21); this page is the contract the website builds against.

## The three flows

1. **Join on the website** (new or existing member). Checkout completes on meyousocial.com → the website's server calls
   `POST /api/provision/signup` → Producer Studio makes the space (and the account, when the email has none) and answers
   with a one-time `signIn.url` → the website redirects the member's browser to it → they land signed in to their new
   space. An account made this way has no password: the link page asks them to choose one (or "Later").
2. **Sign up in the app, then join**. *Off since 28 Nov 2026* (the owner: "Send them to meyousocial.com"): with
   `APP_SIGNUP=website`, the default on the hosted server, `https://producerstudio.app/signup` sends people to
   `MEMBERSHIP_URL`, and `POST /api/auth/signup` makes an account only for an address with a pending invitation, so a
   member can still bring in their team up to their seats (403 with `details.membershipUrl` otherwise).
   `GET /api/auth/options` (public) says which mode is on. Free trials start on the website. `APP_SIGNUP=open` on Railway
   reopens what follows. When open, anyone can sign up at `https://producerstudio.app/signup` (a free account
   and a personal space), and make more spaces from the space switcher. Right after signing up, a **welcome step**
   (`/welcome`) offers **Choose a plan** (the claim below, for the new space), **Use my own AI key**, or **Continue free**,
   so expect claim visitors who have no WordPress account yet. In **the **Members** page (left menu)**, a space's owner sees
   **Membership → Get a membership for this space**: it sends them to `MEMBERSHIP_URL?ps_claim=<claim>`. The website keeps
   `ps_claim` through checkout and passes it as `claim` in the signup call: the membership goes on **that** space, and
   nothing new is made. A claim lasts 7 days.
3. **Open Producer Studio from the website** (an account page button). `POST /api/provision/sign-in-links` → redirect to
   the `url` it returns.

Then, for the membership's life, MemberPress events → `PUT /api/provision/memberships/:externalId` (plan, status, seats).

## What a membership does in Producer Studio

| status | the space gets |
|---|---|
| `active` | the server's own AI key (Producer, the assistant, AI pictures and clips through the server), and its `seats` |
| `past_due`, `paused`, `cancelled`, `expired` | the server's AI is turned off and the owner can't turn it back on until it's `active` again. Nothing is deleted: the space, its projects and media stay, readable and exportable, and its own AI keys (Settings → AI) still work |

- **seats** (optional, `null` = no limit): the most people the space may hold, counting members **and** pending
  invitations. An invite past it is refused with a message pointing to `MEMBERSHIP_URL`.
- **plan** is stored and shown (the **Members** page (left menu) → Membership); it doesn't change behaviour by itself yet. Expected
  slugs: `member`, `contributor`, `steward`, `founder` (any lowercase slug is accepted).
- **The server's AI is members-only** (since 26 Nov 2026): an owner can switch it on (Usage page) only with an active
  membership; operators can switch it on anywhere. Spaces with no membership keep what they had: one that already used
  the server's AI keeps it (and can switch it off); one that didn't is told it comes with a membership and pointed to its
  Members page. Every space can always use its own AI keys (Settings → AI).

## Setting it up

1. **The secret.** It is in `C:\Users\Admin\producer-studio\.env.provision.local` (gitignored; never paste it in chat or
   commit it). Copy `PROVISION_SECRET` from there.
2. **Producer Studio (Railway).** In the Producer Studio service's variables, set `PROVISION_SECRET` to that value
   (32+ characters; shorter or unset = provisioning is off and every call answers 404) and `MEMBERSHIP_URL` to the page a
   member joins on (default `https://www.meyousocial.com/`). Railway redeploys; nothing else is needed.
3. **WordPress.** Keep the same secret server-side only, e.g. in `wp-config.php`:
   `define('PS_PROVISION_SECRET', '…');` and `define('PS_API', 'https://producerstudio.app');`. Never send it to a browser.
4. **Check it.** `POST /api/provision/ping` with `{}` must answer `{ "ok": true, "server": "producer-studio" }`.

## Signing every call

Every call is a JSON `POST`/`PUT` from the website's server with two headers:

```
X-PS-Timestamp: <milliseconds since 1970 (seconds also accepted)>
X-PS-Signature: sha256=<hex HMAC-SHA256 of "<timestamp>.<raw JSON body>" keyed with PROVISION_SECRET>
Content-Type: application/json
```

- The timestamp must be within **5 minutes** of the server's clock; each signature works **once** (a replay is 401).
- Sign the exact bytes you send (encode the JSON once, sign that string, send that string).
- Errors are JSON `{ "error": "<what's wrong, in words>", "code": "…" }`: 400 bad body (the message names the fields),
  401 signature, 404 unknown membership/account or provisioning off, 409 conflict (e.g. a disabled account, a claim for a
  space that already has an active membership), 429 too many sign-in links for one account in an hour (30).

PHP helper for the website (WordPress):

```php
/** Call Producer Studio's provisioning API. Returns [status, decoded body]. */
function ps_provision($method, $path, array $body = []) {
    $json = wp_json_encode((object) $body);
    $ts   = (string) round(microtime(true) * 1000);
    $sig  = hash_hmac('sha256', $ts . '.' . $json, PS_PROVISION_SECRET);
    $res  = wp_remote_request(rtrim(PS_API, '/') . $path, [
        'method'  => $method,
        'timeout' => 20,
        'headers' => [
            'Content-Type'   => 'application/json',
            'X-PS-Timestamp' => $ts,
            'X-PS-Signature' => 'sha256=' . $sig,
        ],
        'body'    => $json,
    ]);
    if (is_wp_error($res)) return [0, ['error' => $res->get_error_message()]];
    return [wp_remote_retrieve_response_code($res), json_decode(wp_remote_retrieve_body($res), true)];
}
```

## Endpoints

Base: `https://producerstudio.app` (the web edition only; the desktop app answers 404). `source` defaults to
`"meyousocial"` everywhere and may be left out.

### `POST /api/provision/ping`

Body `{}` → `200 { "ok": true, "server": "producer-studio", "time": 1764100000000 }`. Changes nothing.

### `POST /api/provision/signup`

```json
{
  "externalId": "mp-sub-1234",
  "email": "maya@example.com",
  "name": "Maya Lee",
  "plan": "member",
  "status": "active",
  "seats": 1,
  "workspaceName": "Maya Films",
  "claim": "v1.ws_….…"
}
```

- `externalId` (required, ≤120 chars): **the website's own id for this membership**, stable for its whole life (a
  MemberPress subscription id, e.g. `mp-sub-<id>`; for a one-off purchase `mp-txn-<id>`). The call is **idempotent** on
  it: the same `externalId` again returns the same space and makes nothing new (safe to retry).
- `email`, `name` (required): the member. A new email gets a new account (no password yet; the address counts as
  confirmed). An email that already has an account gets a **new space** on that account; the account is untouched.
- `plan` (required, lowercase slug), `status` (default `active`), `seats` (optional, integer ≥1 or `null`).
- `workspaceName` (optional): the new space's name (default "Maya's space").
- `claim` (optional): the `ps_claim` the member arrived with from the app. With it, the membership goes on that space
  (whatever email was typed at checkout) and no account or space is made.

`200`:

```json
{
  "user":       { "id": "u_…", "email": "maya@example.com", "created": true, "needsPassword": true },
  "workspace":  { "id": "ws_…", "name": "Maya Films", "created": true },
  "membership": { "source": "meyousocial", "externalId": "mp-sub-1234", "workspaceId": "ws_…", "plan": "member",
                  "status": "active", "seats": 1, "email": "maya@example.com", "createdAt": 0, "updatedAt": 0 },
  "signIn":     { "url": "https://producerstudio.app/link/<token>?ws=ws_…", "expiresAt": 1764100900000 }
}
```

Redirect the member to `signIn.url` straight away (`wp_redirect`). It works **once**, for **15 minutes**, and each call
returns a fresh one that cancels the one before (a retried webhook: use the latest). `signIn` is `null` if the account
had 30 links this hour. Store `user.id` and `workspace.id` against the membership if useful; `externalId` is the key
Producer Studio uses.

### `PUT /api/provision/memberships/:externalId`

Body (any of): `{ "plan": "steward", "status": "cancelled", "seats": 4, "email": "new@example.com" }` →
`200 { "membership": { … } }`. 404 for an `externalId` never provisioned. Changing `status` applies at once (see the
table above).

### `POST /api/provision/memberships/:externalId/read`

Body `{}` → `200 { "membership": { … } }` (a signed read: POST so the body is signed).

### `POST /api/provision/sign-in-links`

Body `{ "externalId": "mp-sub-1234" }` (the space's owner, opening that space) **or** `{ "email": "maya@example.com" }`
(the account, opening its last space) → `200 { "url": "…/link/<token>[?ws=…]", "expiresAt": … }`. 404 when there's no such
membership or account. Same rules as `signIn.url`.

## Suggested MemberPress wiring (to check against the installed MemberPress)

| MemberPress moment | Call |
|---|---|
| a signup or first transaction completes (`mepr-event-transaction-completed` / `mepr-event-member-signup-completed`) | `POST /signup` with `externalId` = the subscription (or transaction) id, `plan` from the membership's slug, `seats` from the tier; then redirect to `signIn.url` (the thank-you page is a good place, or right after checkout) |
| renewed / resumed (`subscription-resumed`, a recurring `transaction-completed`) | `PUT /memberships/:id` `{ "status": "active" }` |
| upgraded / downgraded (`subscription-upgraded`, `subscription-downgraded`) | `PUT` the **same** `externalId` with the new `plan` and `seats`. MemberPress may make a new subscription on an upgrade: keep the first one's id as the `externalId` (store it in user meta) so the member keeps their space |
| payment failed (`transaction-failed`) | `PUT` `{ "status": "past_due" }` |
| paused (`subscription-paused`) | `PUT` `{ "status": "paused" }` |
| cancelled (`subscription-stopped`) | `PUT` `{ "status": "cancelled" }` (or keep `active` until the paid period ends, then `expired`) |
| expired (`subscription-expired`, `transaction-expired`) | `PUT` `{ "status": "expired" }` |
| "Open Producer Studio" on the account page | `POST /sign-in-links` `{ "externalId": … }`, redirect |
| arriving with `?ps_claim=…` | keep it (session/cookie/hidden checkout field) and pass it as `claim` in `POST /signup` |

The event names above are MemberPress's usual ones but weren't checked against this site's MemberPress version.

## Security notes

- The secret signs everything: keep it in server-side config only, rotate it by changing it in both places together.
- `signIn.url` is a credential: redirect to it, don't email it, log it or show it.
- A signed request can't be replayed, and its timestamp must be fresh: keep the WordPress server's clock in sync (NTP).
- Every provisioning call is in Producer Studio's audit log (Operator → Audit; `membership.*`, `signin.link`), and the
  space's own Audit tab shows the membership's changes.

## Trying it

```bash
# with PROVISION_SECRET in the environment
body='{}'; ts=$(($(date +%s)*1000))
sig=$(printf '%s' "$ts.$body" | openssl dgst -sha256 -hmac "$PROVISION_SECRET" -hex | sed 's/^.* //')
curl -s https://producerstudio.app/api/provision/ping -H "Content-Type: application/json" \
  -H "X-PS-Timestamp: $ts" -H "X-PS-Signature: sha256=$sig" -d "$body"
```

A test signup makes a real account and space: use an address you own, and remove the space afterwards in the app
(the **Members** page (left menu) → Delete space) or ask for it to be cleaned up.
