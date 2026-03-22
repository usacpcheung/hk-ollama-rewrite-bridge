# Rewrite Bridge Widget (OIDC-Protected)

This repository includes a reusable **Rewrite Widget UI** for the rewrite service.

## Scope of this widget

The shipped browser widget currently targets **text rewrite only**. It does **not** provide a built-in UI for the T2A service.

That means:

- the widget calls `POST /api/rewrite-bridge/rewrite`
- the widget polls `GET /api/rewrite-bridge/model-status`
- it does not call `POST /api/rewrite-bridge/t2a`

If you are building an app that needs T2A, use the documented API contracts in `README.md` and `docs/api-reference.md` directly from your own frontend or backend integration layer.

## What the widget provides

- demo-style card UI with textbox, character counter, **Rewrite**, and **Undo**
- model-ready status dot
- one shared model-status poller across multiple widget instances
- canonical phase handling derived from backend `status` and `serviceState`
- secure cookie-based requests with `credentials: "include"` for OIDC-protected deployments

## Folder structure

```text
public/
  rewrite-widget/
    rewrite-widget.js
    example.html
    README_rewrite_widget.md
```

## Quick start

### 1. Serve the widget statically

Add to your server:

```js
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use("/rewrite-widget", express.static(path.join(__dirname, "public/rewrite-widget")));
```

### 2. Open the example page

```text
https://<YOUR_DOMAIN>/rewrite-widget/example.html
```

## Using the widget in any page

```html
<div id="rw"></div>

<script src="/rewrite-widget/rewrite-widget.js"></script>
<script>
  RewriteWidget.mount({
    containerSelector: "#rw",
    apiBase: "",
    title: "Rewrite",
    maxChars: 100,
    reloadOnLoginRequired: true
  });
</script>
```

Optional config:

- `statusPollIntervalMs` (number, minimum 1000)
- `pollModelStatus` (boolean, default `true`)
- `loginPageUrl` for manual sign-in flows when `reloadOnLoginRequired: false`

## Multiple widgets on one page

Each widget has its own editor state but shares one model-status poller.

```html
<div id="rw1"></div>
<div id="rw2"></div>

<script src="/rewrite-widget/rewrite-widget.js"></script>
<script>
  RewriteWidget.mount({ containerSelector: "#rw1", apiBase: "" });
  RewriteWidget.mount({ containerSelector: "#rw2", apiBase: "" });
</script>
```

## Widget API

`RewriteWidget.mount(config)` returns an instance with:

- `rewrite()`
- `undo()`
- `pollStatusOnce()`
- `getCurrentText()`
- `onRewriteStart(callback)`
- `onRewriteComplete(callback)`
- `onTextChange(callback)`
- `destroy()`

Event payloads:

- `onRewriteStart`: `{ text }`
- `onRewriteComplete`: `{ before, after, changed, success, errorMessage }`
- `onTextChange`: `{ text }`

## Front-end status behavior notes

The widget polls `GET /api/rewrite-bridge/model-status` and uses:

- `status`
- `serviceState`

Phase precedence:

1. down or unreachable
2. degraded
3. ready
4. starting or warming
5. unknown

Behavior:

- Rewrite button is enabled only in normalized `ready` phase.
- `degraded` keeps rewrite disabled and shows a warning.
- `starting` / `warming` keeps rewrite disabled and shows loading UI.
- `down` or unreachable API shows retry messaging.

## OIDC protection overview

Typical deployment pattern:

- protected: `POST /api/rewrite-bridge/rewrite`
- often public or less restricted: `GET /api/rewrite-bridge/model-status`

The widget uses:

```js
fetch(..., { credentials: "include" })
```

Best UX is to protect the widget page itself with OIDC so the user is already signed in before they interact with the widget.

Recommended widget config:

```js
RewriteWidget.mount({
  containerSelector: "#rw",
  apiBase: "",
  reloadOnLoginRequired: true
});
```

## Important note for T2A adopters

If your application needs both rewrite and T2A:

- you can continue using this widget for rewrite
- implement T2A separately using `POST /api/rewrite-bridge/t2a`
- choose either binary audio handling or `base64_json` based on your app needs

## Safe Apache configuration template

Replace placeholder values wrapped in `<...>`. Never commit real secrets.

```apache
<VirtualHost *:443>
  ServerName <YOUR_DOMAIN>

  OIDCProviderMetadataURL https://accounts.google.com/.well-known/openid-configuration
  OIDCClientID <GOOGLE_OIDC_CLIENT_ID>
  OIDCClientSecret <GOOGLE_OIDC_CLIENT_SECRET>
  OIDCRedirectURI https://<YOUR_DOMAIN>/oidc/callback
  OIDCCryptoPassphrase <RANDOM_LONG_SECRET>

  OIDCScope "openid email profile"
  OIDCRemoteUserClaim email
  OIDCClaimPrefix "OIDC_CLAIM_"

  <Location "/api/rewrite-bridge/rewrite">
    AuthType openid-connect
    Require valid-user

    RequestHeader unset X-Authenticated-Email
    RequestHeader unset X-Authenticated-User
    RequestHeader unset X-Bridge-Auth

    RequestHeader set X-Authenticated-Email "%{OIDC_CLAIM_email}e"
    RequestHeader set X-Authenticated-User "%{REMOTE_USER}e"
    RequestHeader set X-Bridge-Auth "<INTERNAL_SHARED_SECRET>"
  </Location>

  ProxyPass        /api/rewrite-bridge/rewrite       http://127.0.0.1:3001/rewrite
  ProxyPassReverse /api/rewrite-bridge/rewrite       http://127.0.0.1:3001/rewrite

  ProxyPass        /api/rewrite-bridge/model-status  http://127.0.0.1:3001/model-status
  ProxyPassReverse /api/rewrite-bridge/model-status  http://127.0.0.1:3001/model-status

  ProxyPass        /rewrite-widget/  http://127.0.0.1:3001/rewrite-widget/
  ProxyPassReverse /rewrite-widget/  http://127.0.0.1:3001/rewrite-widget/
</VirtualHost>
```

## Keeping secrets out of git

Recommended approach:

1. store secrets in a local Apache include file such as `/etc/apache2/oidc-secrets.conf`
2. include that file from the vhost
3. restrict permissions to the secrets file
4. ignore secret-bearing files in git
