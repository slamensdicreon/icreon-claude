# Eye

Cypher's presence as a mark: a disc with an eye that is resting, watching, or needs a word.

**States.** `resting` (`ink` disc, closed lid in `on-ink`): nothing needs the Director. `watching` (`ink` disc, open almond and pupil in `on-ink`): agents are working. `needs-a-word` (`coral` disc, white almond, `ink` pupil): a decision is the Director's.

**Sizes.** 20px beside a label, 22px in the rail, 34–46px in the shell, 44px inside a project ring, 102–118px as the hero of a Bliss page. Always drawn from the SVG in Assets › Marks, never redrawn.

**Halo.** The hero eye only sits in a halo: `coral-halo` when the state is needs-a-word, `mist-2` otherwise, with a `surface` disc between the halo and the eye. It breathes over 4.5s and stops under `prefers-reduced-motion`.

**Behaviour.** On a new item that is the Director's, the eye blinks once (320ms) and the state moves to needs-a-word. The state is derived, never set by hand: needs-a-word when anything is waiting on the Director, watching when any task is running, resting otherwise.

**Accessibility.** `role="img"` with the state as its label where the eye conveys state; `aria-hidden="true"` where it decorates a word that already says it.

**The consumer provides** the state and the size.
