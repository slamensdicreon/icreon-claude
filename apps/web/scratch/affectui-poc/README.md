# affectUI on Icreon: proof of concept

A scratch proof of concept for [docs/reference/affectui-evaluation.md](../../../../docs/reference/affectui-evaluation.md).
It shows one affectUI Pro item, **Approval Card**, rendering a Control Center gate escalation on
the Icreon tokens. Nothing here is imported by the app: `apps/web/tsconfig.json` only includes
`src`, and the app's Vite entry never reaches this folder.

| File | What it is |
|---|---|
| `icreon-affectui.css` | The token bridge: affectUI's `--ui-ap-*` variables pointed at our `--web-*` tokens, plus overrides for the literals affectUI doesn't expose (radius, font, weight, motion) |
| `GateApproval.tsx` | Adapter from our `EscalationView` (type `gate`) to `ApprovalCard` props; swallows Esc so it never sends a gate back |
| `main.tsx`, `index.html`, `vite.config.ts` | A one-page demo with toggles for stock vs Icreon and light vs dark |
| `fetch-affectui.mjs` | Downloads affectUI items from the registry into `vendor/` with our access key |
| `vendor/` | **Git-ignored.** affectUI's source. This repository is public and Pro sources are licensed, so they are fetched, never committed |
| `screens/` | Screenshots of the demo |

## Run it

```sh
cd apps/web
AFFECTUI_API_KEY=… node scratch/affectui-poc/fetch-affectui.mjs approval-card
pnpm exec vite --config scratch/affectui-poc/vite.config.ts      # http://localhost:5174
pnpm exec tsc -p scratch/affectui-poc --noEmit                    # typecheck
```

| Icreon, light | Icreon, dark | Stock affectUI |
|---|---|---|
| ![](screens/poc-light.png) | ![](screens/poc-dark.png) | ![](screens/poc-stock.png) |
