# Clew Web UI

`ui/` is a fixture-first Preact/TypeScript/Vite client for the v0.4 control plane. Run `npm install --prefix ui` and `npm run build --prefix ui`; the production bundle is emitted to `ui/dist`, included in the installed package, and served by the local daemon at `/` and `/assets/*`.

The Vite development server uses safe control-plane fixtures when no daemon is present. With the daemon-served page, `/api/v1/bootstrap` establishes an HttpOnly same-origin session cookie and the client uses the v1 command API, the CLEW-070 Task Thread projection, and the WebSocket cursor stream. Selected task identity and the latest cursor are kept in session storage across reloads. The UI renders curated summaries only and does not render raw event payloads, native prompts, tool output, or arbitrary HTML.
