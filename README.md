# Aside Mobile UI

Standalone mobile PWA for controlling an Aside installation from a private network.

This project does not include Aside credentials, browser cookies, API keys, hostnames, Tailscale identities, or personal environment values. Each operator runs it beside their own Aside CLI and private network.

## Requirements

- macOS with Aside installed and signed in
- Aside CLI available as `aside` on `PATH`
- Bun 1.4+
- Optional: Tailscale for private phone access

## Run locally

```sh
bun install
ASIDE_MOBILE_TOKEN="$(openssl rand -hex 24)" bun run start
```

The server listens on `127.0.0.1:8787` by default. Set `ASIDE_BIN` when `aside` is not on `PATH`. Use `ALLOW_INSECURE_LOCAL=1` only for local development without authentication.

## Mac login startup

```sh
./bin/install-launchd.sh
```

The installer creates a random token in `~/.config/aside-mobile/env` with mode `600`, enables Tailscale identity authentication, and runs the app at login. It does not copy or manage Aside credentials.

## Phone access with Tailscale

Keep the server on loopback and expose it only to the tailnet:

```sh
tailscale serve --bg --https=443 http://127.0.0.1:8787
```

With `TRUST_TAILSCALE_IDENTITY=1`, Tailscale Serve's `Tailscale-User-Login` identity header authenticates tailnet requests, so the phone does not need the bearer token. This header is trusted only through the loopback Serve path. Never bind the app directly to a network interface.

Without Tailscale identity headers, set `ASIDE_MOBILE_TOKEN` and enter it in the PWA. Never use `tailscale funnel` for this app.

## Features

- Aside host and session lists
- Structured session messages
- New task, follow-up prompt, and stop request
- Session selection close without stopping the underlying task
- On-demand DOM projection of the selected tab
- On-demand screenshot
- Browser click, scroll, keyboard, and text actions
- Session refresh polling
- App-shell-only Service Worker cache; API, messages, and screenshots are not cached

DOM projection is a sanitized read-only view. It does not execute page scripts, cookies, iframe contents, or original page HTML on the phone.

## Development

```sh
bun test
bun build src/server.ts --target bun --outdir /tmp/aside-mobile-build
bun build public/app.js --target browser --outdir /tmp/aside-mobile-web
```

## Security boundary

The app can control logged-in browser tabs and send prompts to Aside. Bind it to loopback, use Tailscale Serve or another authenticated private ingress, keep any bearer token private, and review the app's permissions before use.

## License

MIT. See `LICENSE`.
