# Dial

The Bliss / Everything switch that sits in the top bar of every screen and decides how much the screen shows.

**Form.** A `surface` pill with a `mist` border and 4px of padding; two options in `button` style. The active option is an `ink` pill with `on-ink` text; the inactive one is `text-3` on nothing. Inside the shell (on ink) the active option is `surface` with `ink` text and the inactive is `on-ink-muted`.

**Behaviour.** Built on affectUI's Segmented Control, two options, the pill gliding between them in 200ms. The choice is remembered per screen (Mission Control can live in Everything while the Dashboard stays in Bliss). Bliss is the default for every new screen and every new user.

**What changes with it.** The shell (rail versus sidebar), whether search and the Cypher button exist (both are Everything only; Bliss has neither, because Cypher's judgment is already inside the cards), which component variant each surface renders, and the base type size (16 in Bliss, 15 in Everything).

**Accessibility.** `role="group"` with a label of "How much to show"; each option a real button with `aria-pressed`; keyboard arrows move between them.

**The consumer provides** the current mode and the handler.
