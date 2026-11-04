# Yours card

A card for one thing that is the Director's: a decision, an approval, a grant. It carries Cypher's recommendation inside it, so the Director never has to open a chat to know what Cypher would do.

**Anatomy, top to bottom.** A `label` row in `coral-text` with the 20px eye, the kind and the project ("Decide · Ansell") and the clock at the right ("2:24" in `coral-text`, or "No clock" in `text-3`); the question in `card-title`; one line of context in `body-small`, `text-2`; Cypher's verdict in a `surface-quiet` well with the 22px watching eye, the verdict in bold and the reason after it; two buttons, the first Cypher's pick in `ink`, the second the alternative in `surface` with a `mist` border; a `meta` line with the raiser's avatar in their team hue, their name, team and when.

**Surfaces.** `surface` on `radius-xl` with `shadow-card`, padded `space-5`. Three to a row at 1200px; the fourth waits. The large form on Mission Control (one card, two columns, `radius-xxl`, `shadow-decision`) adds the context paragraph, links to the raiser's reasoning and the source, and a line beneath the buttons: "If you say nothing: one, at 2:24".

**Copy rules.** The question is a question. The verdict starts with "I'd" and ends in one line. Counts under thirteen are words. The primary button is the choice itself ("One"), never "Accept recommendation".

**The consumer provides** the kind, project, clock, question, context, the recommendation `{verdict, why, pick}`, the alternatives, the raiser and the handlers. The card never composes the verdict.
