# Rewrite Bridge Widget (OIDC-Protected)

This repository includes a reusable **Rewrite Widget UI** for the rewrite service.

## Scope of this widget

The shipped browser widget currently targets **text rewrite only**. It does **not** provide a built-in UI for the T2A service.

That means:

- the widget calls `POST /api/rewrite-bridge/rewrite`
- the widget polls `GET /api/rewrite-bridge/model-status`
- it does not call T2A or transcription endpoints

If you are building an app that needs T2A, use the [project README](../../README.md) and [API reference](../reference/api-reference.md) directly from your own frontend or backend integration layer.

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
docs/
  guides/
    rewrite-widget.md
```

## Quick start

### 1. Serve the widget statically

`server.js` does not register `express.static` or a `/rewrite-widget` route.
Serve `public/rewrite-widget/` using the frontend web server. For Apache, add a
static alias to the deployed repository path (adjust it to your checkout):

```apache
Alias /rewrite-widget/ /opt/hk-ollama-rewrite-bridge/public/rewrite-widget/
<Directory "/opt/hk-ollama-rewrite-bridge/public/rewrite-widget/">
    Require all granted
</Directory>
```

Apply your site's OIDC policy to the widget page and API namespace. No change to
the bridge server is required to serve these assets.

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
- `pollModelStatus` (boolean, default `true`): controls the extra initial poll only; subscribing still starts the shared periodic poller
- `loginPageUrl` for manual sign-in flows when `reloadOnLoginRequired: false`
- `streamEnabledByDefault` (boolean): initial streaming-checkbox state; the backend must independently enable rewrite streaming
- `maxChars` (number, default `100`): widget limit; it is not read from the backend. Counts JavaScript UTF-16 code units, while the backend counts trimmed Unicode code points. Align it with `REWRITE_MAX_TEXT_LENGTH` for the intended workflow.

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

`RewriteWidget.mount(config)` is asynchronous and returns a Promise for the instance. Await it before calling instance methods:

```js
async function initializeWidget() {
  const widget = await RewriteWidget.mount({ containerSelector: "#rw", apiBase: "" });
  widget.onRewriteComplete(({ success, after }) => {
    if (success) console.log(after); // use only non-sensitive demo text
  });
  return widget;
}
initializeWidget();
```

The resolved instance provides:

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
- protected by the checked-in proxy namespace: `GET /api/rewrite-bridge/model-status`

The backend does not header-authenticate model status. Its public access policy comes from the proxy; the supplied `apache/proxy-snippet.conf` protects the entire API namespace.

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

  RequestHeader unset X-Forwarded-For
  RequestHeader unset X-Forwarded-Proto
  RequestHeader unset Forwarded

  <Location "/api/rewrite-bridge">
    AuthType openid-connect
    Require valid-user

    RequestHeader unset X-Authenticated-Email
    RequestHeader unset X-Authenticated-User
    RequestHeader unset X-Authenticated-Subject
    RequestHeader unset X-Bridge-Auth

    RequestHeader set X-Authenticated-Email "%{OIDC_CLAIM_email}e" env=OIDC_CLAIM_email
    RequestHeader set X-Authenticated-User "%{REMOTE_USER}e"
    RequestHeader set X-Bridge-Auth "<INTERNAL_SHARED_SECRET>"
  </Location>

  ProxyPass        /api/rewrite-bridge/rewrite       http://127.0.0.1:3001/rewrite
  ProxyPassReverse /api/rewrite-bridge/rewrite       http://127.0.0.1:3001/rewrite

  ProxyPass        /api/rewrite-bridge/model-status  http://127.0.0.1:3001/model-status
  ProxyPassReverse /api/rewrite-bridge/model-status  http://127.0.0.1:3001/model-status

  Alias /rewrite-widget/ /opt/hk-ollama-rewrite-bridge/public/rewrite-widget/
  <Directory "/opt/hk-ollama-rewrite-bridge/public/rewrite-widget/">
    Require all granted
  </Directory>
  <Location "/rewrite-widget">
    AuthType openid-connect
    Require valid-user
  </Location>
</VirtualHost>
```

## Keeping secrets out of git

Recommended approach:

1. store secrets in a local Apache include file such as `/etc/apache2/oidc-secrets.conf`
2. include that file from the vhost
3. restrict permissions to the secrets file
4. ignore secret-bearing files in git
