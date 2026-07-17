# Eufy Local Control

A local web dashboard for Eufy cameras and smart locks. It discovers devices shared with a Eufy account, sends lock commands over local-only P2P, converts camera livestreams to browser-friendly HLS, and optionally records MP4 files to this machine.

## What this solution does

- Lists supported cameras and locks with battery/state information.
- Locks and unlocks with an explicit browser confirmation.
- Streams camera video in the dashboard.
- Saves recordings under `recordings/` when **Watch & record** is used.
- Binds to `127.0.0.1` by default and uses Eufy's quickest P2P mode, which can fall back when a model's LAN path fails.
- Supports Eufy 2FA verification from the dashboard.

## Important Eufy limitations

Eufy does not publish a general local API for its consumer security products. This app uses the community-maintained [`eufy-security-client`](https://github.com/bropat/eufy-security-client), which authenticates with Eufy's cloud to discover/account-authorize devices and then requests a local P2P connection. It is not a fully offline integration. Eufy firmware changes can temporarily break individual models.

Camera support varies by model and firmware. Battery cameras may stop a livestream to preserve battery. Browser output is normalized H.264 HLS; video is transcoded because Eufy's P2P elementary stream does not provide reliable packet timestamps, so streaming uses CPU. One HomeBase P2P session may also limit simultaneous camera streams.

Set `EUFY_P2P_MODE=local-only` if cloud/relay fallback is unacceptable. Some models, notably older standalone cameras such as T8424, may fail to stream in that mode even while both devices are on the same LAN.

`EUFY_EMBEDDED_PKCS1=true` enables the client's compatibility implementation for P2P stream-key decryption. Keep it enabled on current Node.js 20/22 releases; without it, affected cameras may connect but deliver undecodable or immediately terminated video.

## Setup

Requirements: Node.js 20+ on Linux, macOS, or Windows. FFmpeg is included through `ffmpeg-static`.

1. In the Eufy Security app, create a dedicated guest account and share only the lock/camera devices it needs. Avoid using the household owner account.
2. Copy the environment template and enter that guest account's credentials:

   ```bash
   cp .env.example .env
   ```

3. Install and start:

   ```bash
   npm install
   npm start
   ```

4. Open <http://127.0.0.1:3000>. If Eufy requests 2FA, the dashboard displays a verification field.

The `EUFY_COUNTRY` value must match the country selected in the Eufy app or device discovery may return nothing.

## Storage and playback

Temporary HLS segments and per-attempt FFmpeg logs are written under `runtime/<camera serial>/<timestamp>/`. Recordings remain under `recordings/` and use fragmented MP4 so they remain readable if a camera disconnects unexpectedly. Recordings can be moved with `RECORDINGS_DIR`; the temporary runtime directory intentionally remains project-local.

## Remote access

Do not change `HOST` to `0.0.0.0` and expose port 3000 directly: the API can unlock a physical door. For remote access, keep this app private and use a VPN such as WireGuard/Tailscale, or put it behind an authenticated HTTPS reverse proxy with strong access controls.

## API summary

- `GET /api/status` — connection/2FA state
- `GET /api/devices` — discovered devices and capabilities
- `POST /api/devices/:serial/lock` with `{ "locked": true | false }`
- `POST /api/devices/:serial/stream` with `{ "record": true | false }`
- `GET /api/devices/:serial/stream` — HLS readiness and playlist URL
- `DELETE /api/devices/:serial/stream` — stop/finalize stream
- `GET /api/recordings` — locally saved MP4 files

## Development checks

```bash
npm run typecheck
npm test
```

`npm audit` currently reports a moderate advisory in `file-type`, pulled transitively by `eufy-security-client`. The automated force fix would downgrade the Eufy client from 3.8 to 2.9 and remove support for newer hardware, so it is intentionally not applied. Do not feed untrusted media files into this application, and update once the upstream client refreshes that dependency.

## Troubleshooting

- **No devices:** verify the country, account sharing, and that the guest account can see the devices in the official Eufy app.
- **Stream does not start:** confirm the model is supported, stop any stream in the official app, and place this server on the same LAN/VLAN as the HomeBase/camera. Local P2P needs local UDP discovery and connectivity.
- **Lock command accepted but state is delayed:** Eufy commands are asynchronous; press Refresh after the device reports its new state.
- **Captcha requested:** the current UI handles 2FA but not captcha. Log in successfully with the guest account in the official app first, wait out any rate limiting, then restart this app.
- **High CPU:** the camera is likely sending H.265 and FFmpeg is transcoding it to H.264 for browser playback.
