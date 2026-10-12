# Aside Mobile UI

Mobile PWA for running and following [Aside](https://aside.com) tasks from your phone.

Flow: **choose the computer that runs Aside → open or start a session → read results and send follow-up prompts**. Browser tools (page text, screenshot, key/scroll/type) are optional and load only on demand.

This project ships no credentials, hostnames, or personal settings. Each person runs it next to their own Aside installation.

## Requirements

- macOS with Aside installed and signed in, and the Aside CLI on `PATH`
- [Bun](https://bun.sh) 1.4+
- [Tailscale](https://tailscale.com) for phone access (recommended)

## Quick start (one computer)

```sh
git clone https://github.com/singandmong/aside-mobile-ui.git
cd aside-mobile-ui
./bin/install-launchd.sh
tailscale serve --bg --https=443 http://127.0.0.1:8787
```

Open the printed `https://<machine>.<tailnet>.ts.net` address on your phone and add it to the home screen.

The installer writes settings to `~/.config/aside-mobile/env` (mode `600`): a random `ASIDE_MOBILE_TOKEN`, `TRUST_TAILSCALE_IDENTITY=1`, and absolute paths to `bun` and `aside`. The server listens on `127.0.0.1` only.

## Multiple computers

Each computer runs Aside locally. One computer is the **hub** your phone opens; every other computer runs a small **connector** that dials out to the hub and drives only its own local Aside.

```
phone ──HTTPS──▶ hub (aside-mobile, relay on) ◀──WebSocket── connector (Mac mini)
                    └─ local Aside                            └─ local Aside
```

1. On the hub computer: `./bin/install-launchd.sh --relay`
2. On the phone: **＋ 다른 컴퓨터 연결** shows a one-time code (valid 10 minutes) and the exact command.
3. On the other computer, inside this repository:

   ```sh
   ./bin/install-connector.sh --hub https://<hub-address> --code XXXX-XXXX --label "Mac mini"
   ```

The connector keeps running at login and reconnects automatically. Revoke it from the same sheet on the phone.

Why a connector instead of Aside's built-in remote control: Aside remote control round-trips through Aside's cloud (≈18 s per call in testing), while a connector talks to the local Aside daemon (≈0.2 s).
**Different tailnets.** Connectors only make outbound connections, so they only need to reach the hub. The simplest option is to [share the hub machine](https://tailscale.com/kb/1084/sharing) into the other tailnet. Do not publish the hub with `tailscale funnel`.
**Different tailnets.** Connectors only make outbound connections, so they need to reach the hub, nothing else. Either [share the hub machine](https://tailscale.com/kb/1084/sharing) into the other tailnet, or run the hub behind any authenticated HTTPS endpoint you control. Never expose the hub with `tailscale funnel` without `TRUST_TAILSCALE_IDENTITY` disabled and a strong `ASIDE_MOBILE_TOKEN`.

## Authentication

| Path | How it is authenticated |
| --- | --- |
| Phone → hub via Tailscale Serve | `Tailscale-User-Login` identity header (optionally restricted with `TRUSTED_TAILSCALE_USERS=a@x.com,b@y.com`) |
| Phone → hub otherwise | `ASIDE_MOBILE_TOKEN`, entered once in the app |
| Connector → hub | Per-connector secret issued at pairing, stored hashed on the hub |
| Pairing | Single-use code, 10-minute expiry, rate-limited |

The hub forwards only an allowlisted set of operations. Connectors re-validate every request and always target their own machine.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` / `HOST` | `8787` / `127.0.0.1` | Listen address |
| `ASIDE_MOBILE_TOKEN` | generated | Bearer token for non-Tailscale access |
| `TRUST_TAILSCALE_IDENTITY` | `1` | Accept Tailscale Serve identity headers |
| `TRUSTED_TAILSCALE_USERS` | (any) | Comma-separated logins allowed via Tailscale |
| `ASIDE_MOBILE_RELAY` | off | `1` turns this server into a hub |
| `ASIDE_BIN` | `aside` | Aside CLI path |
| `ASIDE_LOCAL_HOST_ID` | auto | Override detection of this machine's Aside host id |

## Development

```sh
bun test
ALLOW_INSECURE_LOCAL=1 bun run start
```

## Security boundary

This app can start Aside tasks and act in logged-in browser tabs. Keep the server on loopback behind Tailscale Serve or another authenticated ingress, and review who can reach it. API responses, transcripts, and screenshots are never cached by the service worker.

## License

MIT. See `LICENSE`.
