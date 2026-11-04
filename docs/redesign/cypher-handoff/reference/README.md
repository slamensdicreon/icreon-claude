# Reference screens

Five artboards from the Cypher canvas, 1440 wide, all set at the same hour on the same Tuesday so one screen can be checked against another.

| File | Screen | Mode | Frame height |
| --- | --- | --- | --- |
| `screens/Brand.dc.html` | Brand sheet: the eye in three states, palette with roles, the type scale, voice says/not, the six density rules, the dial | both | 1000 |
| `screens/Dashboard-Bliss.dc.html` | Portfolio home: the eye and the sentence, three cards that are yours with Cypher's pick inside, four project tiles with eye states, handled list; labelled icon rail | Bliss | 1140 |
| `screens/Dashboard-Everything.dc.html` | Portfolio console: four KPI tiles, projects table, needs-you list, deploys, agents under load, two charts; full sidebar; the Cypher button closed | Everything | 1320 |
| `screens/Mission-Bliss.dc.html` | Ansell: phase track, the sentence, the one decision card, two quieter cards, the team in one line each, handled | Bliss | 1180 |
| `screens/Mission-Everything.dc.html` | Ansell console: phase strip, four metric cards, needs-you list, tasks table, team list, activity log; the Cypher button open with its sheet | Everything | 1340 |

`screens/canvas.json` records where each board sits on the canvas and the row notes.

## How to read an artboard

Each file is a self-contained design-canvas page: a `<x-dc>` block holds the markup with inline styles (every size, color and radius is literal in the `style` attribute, so they are exact), and the `<script type="text/x-dc">` at the bottom holds the data the loops render (`<sc-for list="{{rows}}" as="r">` repeats its body once per item; `{{r.name}}` is a field). Icon paths are in the `I` object in that script. The pages do not render outside the canvas runtime (`support.js` is not included), so treat them as the layout and copy spec; open the canvas link in `CLAUDE.md` to see them rendered.

Colors in the boards predate the final token names in `tokens.json`; the values are identical. Map by value: `#141433` is `ink`, `#f6f5fc` is `bliss`, `#e3e0f2` is `mist`, `#c8402b` is `coral-text`, `#e8553d` is `coral`, `#6b4ee6` `#2f5ee6` `#0b7b7d` `#9a6b00` are `iris` `blue` `teal` `gold`.
