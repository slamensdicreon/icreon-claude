# affectUI in apps/web

affectUI (affectui.com, source at github.com/flohoeller/affectui) is a library of React components for agent interfaces. Each item is one `.tsx` file with its styles inside: no Tailwind, no CSS framework, no animation library. It requires React 19, which `apps/web` already runs (19.3). Items are copied into the repository and become source we own; nothing is linked at runtime.

## Install

1. In `apps/web`, add a `components.json` for the shadcn CLI and the `@/` alias (Vite `resolve.alias` and `tsconfig` `paths`, both pointing `@/` at `src/`).
2. Register the namespace once in `components.json`:
   `{"registries": {"@affectui": "https://www.affectui.com/r/{name}.json"}}`
3. Add an item: `npx shadcn@latest add @affectui/segmented-control`. The file lands in `src/components/ui/`; move it to `src/ui/` to match the plan, or point the CLI there.
4. Alternatively copy the file from the `components/` folder of the GitHub repository.

Prefer the `-clean` variants (`segmented-control-clean`) where the registry offers them; they are the plainer style and closer to the Cypher look before restyling.

## Items the plan uses

| Item | Where | License |
| --- | --- | --- |
| Segmented Control | the Dial; Live/Replay on Activity | MIT |
| Smart Recommendation | YoursCard and the decision card | MIT |
| Decision Inbox | Needs you, Everything | MIT |
| Tool Call Card | Activity log rows, the Floor's beat stream | MIT |
| Thinking Loader | Cypher's presence while working | MIT |
| Change Summary | Handled lists, Workbench "what moved since the approved version" | MIT |
| Number Ticker | KPI tiles | MIT |
| Progress Tracker | Plan phase checklist, Workbench completeness | MIT |
| Filter Menu | Workbench Blueprint filters | MIT |
| Comment Thread | Workbench discussion | MIT |
| Notification Stack | Needs you toasts | MIT |
| Message Actions | Cypher sheet bubbles | MIT |
| Profile Menu, Button, OTP Input | Shell user chip, Settings, intake | MIT |
| Agent Tree, Agent Handoff, Trace Waterfall, Context Map, Agent Inbox | Team and Activity depth views in Everything | Pro: one-time license at affectui.com/pricing; until it is in hand, build our own to the canvas and keep them as fallbacks |

## Theming

Each copied file carries its own styles. Replace every literal color, radius and font in the file with the matching `var(--…)` from `tokens.css` and the type classes from `type.css`; remove any font it loads; keep its motion but gate it on `prefers-reduced-motion`. The restyled file is the one that ships; the original stays only in git history. When affectUI publishes an update, diff against the original, not the restyled file.

## An MCP server exists

affectUI ships an MCP server (`claude mcp add --transport http affectui https://www.affectui.com/api/mcp`) and an `llms.txt`. Claude Code can use either to look up an item's props and add it. The Pro items are not available through it without a license.
