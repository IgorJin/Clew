# Clew Web UI

`ui/` is a fixture-first Preact/TypeScript/Vite client for the v0.4 control plane. Run `npm install --prefix ui` and `npm run build --prefix ui`; the production bundle is emitted to `ui/dist`, included in the installed package, and served by the local daemon at `/` and `/assets/*`.

The Vite development server uses safe control-plane fixtures when no daemon is present. With the daemon-served page, `/api/v1/bootstrap` establishes an HttpOnly same-origin session cookie. The UI loads an aggregated in-process snapshot from `/api/v1/snapshot`, sends explicit operator actions through the v1 command API, and follows the `ws`-backed WebSocket cursor stream. The daemon and CLI invoke the same in-process `ClewService`; event bursts are coalesced into one snapshot refresh instead of spawning CLI processes or issuing reads per task and event.

Selected task identity and the latest cursor are kept in session storage across reloads. A reconnect re-runs same-origin bootstrap so a restarted daemon can rotate its token safely. When the daemon is unavailable, the last known data remains visible with an explicit timestamp, but every operator action is disabled. Production never substitutes fixture tasks for daemon data. The UI renders curated summaries only and does not render raw event payloads, native prompts, tool output, or arbitrary HTML.
