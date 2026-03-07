# Rewrite Bridge Widget (OIDC-Protected)

This repository includes a reusable **Rewrite Widget UI** for the HK
Rewrite Bridge API.

It provides:

-   A demo-style card UI (textbox, character counter, **Rewrite**,
    **Undo**)
-   A **model-ready status dot** (ready / loading / down)
-   A **single shared model-status poller** across multiple widgets (no
    duplicated network requests)
-   Canonical status-phase handling (`down` / `degraded` / `ready` /
    `starting` / `unknown`) derived from backend `status` and
    `serviceState`
-   Secure API calls using browser cookies (`credentials: "include"`)
    for OIDC-protected endpoints
-   Safe documentation templates (no sensitive information included)

------------------------------------------------------------------------

# Folder Structure

public/ rewrite-widget/ rewrite-widget.js example.html README.md

------------------------------------------------------------------------

# Quick Start

## 1. Serve the widget statically (Node / Express)

Add to your server.js:

``` js
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use("/rewrite-widget", express.static(path.join(__dirname, "public/rewrite-widget")));
```

## 2. Access the demo page

    https://<YOUR_DOMAIN>/rewrite-widget/example.html

------------------------------------------------------------------------

# Using the Widget in Any Page

``` html
<div id="rw"></div>

<script src="/rewrite-widget/rewrite-widget.js"></script>
<script>
  RewriteWidget.mount({
    containerSelector: "#rw",
    apiBase: "",  // same-origin recommended
    title: "Rewrite",
    maxChars: 100,
    reloadOnLoginRequired: true
  });
</script>
```

`loginPageUrl` is optional and only used when you run a manual sign-in flow
(`reloadOnLoginRequired: false`).

You can also pass optional tuning flags:

- `statusPollIntervalMs` (number, min 1000) to change shared poll interval
- `pollModelStatus` (boolean, default `true`) to skip the initial forced poll

------------------------------------------------------------------------

# Multiple Widgets on One Page

Each widget maintains its own textbox and Undo state, but shares one
model-status poller (no duplicated API calls).

``` html
<div id="rw1"></div>
<div id="rw2"></div>

<script src="/rewrite-widget/rewrite-widget.js"></script>
<script>
  RewriteWidget.mount({ containerSelector:"#rw1", apiBase:"" });
  RewriteWidget.mount({ containerSelector:"#rw2", apiBase:"" });
</script>
```

------------------------------------------------------------------------

# Widget API

`RewriteWidget.mount(config)` returns an instance with:

- `rewrite()` – manually trigger rewrite
- `undo()` – restore last pre-rewrite text
- `pollStatusOnce()` – force immediate shared status poll
- `getCurrentText()` – read current textarea content
- `onRewriteStart(callback)` – subscribe before each rewrite call
- `onRewriteComplete(callback)` – subscribe after rewrite attempt
- `onTextChange(callback)` – subscribe on textarea input changes
- `destroy()` – unsubscribe + remove widget DOM

Event payloads:

- `onRewriteStart`: `{ text }`
- `onRewriteComplete`: `{ before, after, changed, success, errorMessage }`
- `onTextChange`: `{ text }`

------------------------------------------------------------------------

# Front-end Status Behavior Notes

The widget polls `GET /api/rewrite-bridge/model-status` and reads both:

-   `status` (overall rewrite-model readiness)
-   `serviceState` (service lifecycle/display state)

Important behavior:

-   The widget normalizes model state into a shared `phase` using both
    `status` and `serviceState` with this precedence:
    1. unreachable/down
    2. degraded
    3. ready
    4. starting/warming/loading
    5. unknown
-   **Rewrite button readiness is driven by normalized phase `ready`**.
-   `degraded` keeps Rewrite disabled and shows quality warning text.
-   `starting`/`warming`/`loading` shows loading UI and disables Rewrite.
-   `down` (or unreachable API) shows retry messaging and auto-retry polling.

This keeps all widget instances consistent and avoids per-widget drift in
status interpretation.

------------------------------------------------------------------------

# OIDC Protection Overview

The rewrite endpoint is typically protected by Apache
`mod_auth_openidc`:

-   Protected: POST /api/rewrite-bridge/rewrite

-   Usually Public: GET /api/rewrite-bridge/model-status

The widget sends API calls using:

    fetch(..., credentials: "include")

This means: - The browser must already have a valid OIDC session
cookie - If not logged in, Apache redirects to Google login

Best UX: Protect the widget page itself with OIDC so login happens
automatically.

Recommended auth config by page type:

- OIDC-protected widget pages (recommended):

```js
RewriteWidget.mount({
  containerSelector: "#rw",
  apiBase: "",
  reloadOnLoginRequired: true
});
```

- Public/non-protected pages:

```js
RewriteWidget.mount({
  containerSelector: "#rw",
  apiBase: "",
  reloadOnLoginRequired: false,
  loginPageUrl: "/login"
});
```

If your page is public and you set `reloadOnLoginRequired: false` without a
`loginPageUrl`, the widget shows a generic message:
"Login required. Re-authenticate in your org portal and retry."

------------------------------------------------------------------------

# Safe Apache Configuration Template (NO REAL SECRETS)

Replace placeholder values wrapped in \<...\>. DO NOT commit real
secrets into GitHub.

``` apache
<VirtualHost *:443>
  ServerName <YOUR_DOMAIN>

  OIDCProviderMetadataURL https://accounts.google.com/.well-known/openid-configuration
  OIDCClientID <GOOGLE_OIDC_CLIENT_ID>
  OIDCClientSecret <GOOGLE_OIDC_CLIENT_SECRET>  # DO NOT COMMIT
  OIDCRedirectURI https://<YOUR_DOMAIN>/oidc/callback
  OIDCCryptoPassphrase <RANDOM_LONG_SECRET>     # DO NOT COMMIT

  OIDCScope "openid email profile"
  OIDCRemoteUserClaim email
  OIDCClaimPrefix "OIDC_CLAIM_"

  <Location "/api/rewrite-bridge/rewrite">
    AuthType openid-connect
    Require valid-user

    RequestHeader unset X-Authenticated-Email
    RequestHeader unset X-Authenticated-User

    RequestHeader set X-Authenticated-Email "%{OIDC_CLAIM_email}e"
    RequestHeader set X-Authenticated-User "%{REMOTE_USER}e"
  </Location>

  ProxyPass        /api/rewrite-bridge/rewrite       http://127.0.0.1:3001/rewrite
  ProxyPassReverse /api/rewrite-bridge/rewrite       http://127.0.0.1:3001/rewrite

  ProxyPass        /api/rewrite-bridge/model-status  http://127.0.0.1:3001/model-status
  ProxyPassReverse /api/rewrite-bridge/model-status  http://127.0.0.1:3001/model-status

  ProxyPass        /rewrite-widget/  http://127.0.0.1:3001/rewrite-widget/
  ProxyPassReverse /rewrite-widget/  http://127.0.0.1:3001/rewrite-widget/
</VirtualHost>
```

------------------------------------------------------------------------

# Keeping Secrets Out of Git

Recommended method:

1.  Create a local Apache include file: /etc/apache2/oidc-secrets.conf

2.  Store secrets there: OIDCClientID `<REAL_ID>`{=html}
    OIDCClientSecret `<REAL_SECRET>`{=html} OIDCCryptoPassphrase
    `<REAL_SECRET>`{=html}

3.  Include in vhost: Include /etc/apache2/oidc-secrets.conf

4.  Restrict permissions: chmod 600 /etc/apache2/oidc-secrets.conf

Also add to .gitignore:

.env .env.* *.secrets.conf

------------------------------------------------------------------------

# Troubleshooting

Login required: - User has no valid OIDC session. - Open a protected
page to log in, then retry.

If repeated auth-triggered reloads occur, the widget now stops auto-reloading
after a short burst and shows a stable manual login message.

Rewrite disabled: - Model status is not "ready". - Check
/api/rewrite-bridge/model-status (`status` must be `"ready"`) and
server logs.

Cross-domain usage: - Using widget from another domain requires CORS +
credentials setup. - Recommended: host widget on same domain as API.

------------------------------------------------------------------------

# Production Recommendations

-   Keep rewrite endpoint protected
-   Keep model-status public
-   Protect widget demo page for best UX
-   Never commit secrets
-   Use pull requests for deployment changes

------------------------------------------------------------------------

# Migration Note (Removed Demo Login Fallback)

The old demo-path fallback (`/tools/rewritedemo.html`) is deprecated and
removed from default widget behavior.

Before:

```js
RewriteWidget.mount({
  containerSelector: "#rw",
  apiBase: "",
  reloadOnLoginRequired: false,
  loginPageUrl: "/tools/rewritedemo.html"
});
```

After (manual login flow):

```js
RewriteWidget.mount({
  containerSelector: "#rw",
  apiBase: "",
  reloadOnLoginRequired: false,
  loginPageUrl: "/login"
});
```

After (OIDC-protected page flow):

```js
RewriteWidget.mount({
  containerSelector: "#rw",
  apiBase: "",
  reloadOnLoginRequired: true
});
```
