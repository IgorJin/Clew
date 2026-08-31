# Clew Web UI

The UI is a fixture-first Preact/Vite client for the v0.4 local control plane. With no daemon session, the development server renders safe fixtures from `src/fixtures.ts`; the production page establishes an HttpOnly same-origin session through `/api/v1/bootstrap`.

```sh
npm install
npm run dev
npm run lint
npm test
npm run build
```

The production build is emitted to `dist/` and included in the installed Clew package. The local daemon serves `/`, `/index.html`, and `/assets/*` without exposing its bearer token to JavaScript. The UI consumes one aggregated `/api/v1/snapshot`, coalesces WebSocket event bursts, and only renders curated summaries and identifiers; it does not render native prompts, tool output, arbitrary HTML, or raw event payloads. Disconnected production views retain last-known data for inspection but disable all operator actions.
