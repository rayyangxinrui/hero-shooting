# rayloop-spec — what changed and why

A second variant of `rayloop`, not a replacement. Both stay installed and they
answer different situations.

## The request

Two constraints, from a user who had just watched the original run for seven
rounds:

1. Remove the word limit.
2. Stop requiring natural language — let the user hand over a technical route:
   engine, architecture, shader techniques, numeric parameters, perf budgets.

## What the original enforced, and why removing it is not free

`rayloop` says, verbatim:

> Short. Around 150 to 220 words. If the prompt needs a heading to stay
> readable, it is too long.
>
> Plain sentences. No bullet lists inside the prompt.

And in its rules:

> Everything else stays out. No architecture, no file layout, no decomposition,
> no round count, no stack choice unless the user demanded it. The agent decides
> those, and it decides better than a spec written before the work started.

That last claim was *earned*, not assumed. In the seven-round run this skill came
out of, nothing about architecture, decomposition or technique was specified, and
the agents chose better than a pre-written spec would have. Examples: chamfered
box primitives carrying an `aEdge` attribute so wear could be placed
geometrically; collapsing the whole dynamic light pool into one viewmodel-layer
light to avoid a shader recompile per light; a luminance-space tonemap rolloff
that re-applies chroma. None of those would have appeared in a spec written on
day one.

So the length limit was never really about length. It was a **forcing function
against premature specification**. Removing it without replacing that function
would produce prompts full of invented constraints — worse output, not better.

## What replaced it

**The LOCKED / OPEN partition.** Every constraint in the prompt must be labelled
as one of:

- **LOCKED** — the user specified it; carry it verbatim, never silently substitute.
- **OPEN** — the user did not; the builder decides and does not ask.

This preserves the original's judgment-preserving property exactly where it
still applies, while making user-specified decisions binding. The rule inverts
cleanly:

> In plain rayloop, unstated means the agent decides.
> Here, stated means locked, and unstated still means the agent decides.

Two guards around it:

- **"Do not invent constraints."** Named as this skill's characteristic failure
  mode, the way hallucinating a bar is plain rayloop's.
- **"Locked does not mean unquestionable."** A builder that finds a locked
  constraint impossible must stop, report which constraint, and show the
  measurement proving it. Not silently substitute, not quietly drop it. That is
  what separates a spec from a wish.

## Also new

**Two bars instead of one.** A spec hands you a second, cheaper bar the original
did not have:

- *Taste bar* — the named reference, judged blind by a critic.
- *Conformance bar* — the spec itself, checkable mechanically, automated, run
  every round.

With an explicit warning that conformance is necessary and not sufficient: a
piece passing every numeric check and losing the blind A/B has not passed.
Otherwise a builder reads green tests as done.

**Padding ban.** No length limit is not licence to ramble. Every line must be a
constraint the builder could not have derived on its own. "A 900-line prompt
where 400 lines are encouragement is worse than a 120-line prompt that is all
constraint."

**A "which version to use" table**, so the two skills do not compete. Plus an
explicit warning that spec-driving a user who has no spec produces invented
constraints and worse work than the short version.

**Spec terms are not translated.** Carried over from the original's language
section, with one addition: parameter names, API identifiers, file paths and
library names stay in their original form. Translating `viewmodelFov` into prose
is how a builder ends up unable to find the field.

## Carried over unchanged

The parts that earned their place in the real run:

- **Correctness before taste** — with the five real bugs that each absorbed
  multiple rounds of useless art direction: the unlit viewmodel, the shared
  shader program, recoil divided by 100, the `NaN` ADS offset, the backwards face
  winding. Every one presented as an aesthetic problem and was functional.
- **Measurement has to be trustworthy** — the non-deterministic captures (44% of
  pixels differing between two captures of an *unchanged* scene) and the perf
  probe that measured a synthetic scene with vsync off.
- **Winnable vs asymptotic bars** and their different exit conditions.
- **Blind A/B, harsh binary critic, separate agent, name one gap, no round-count
  exit.**

## Honest limitations

- **Untested at scale.** The original was validated across seven rounds and about
  twenty pieces. This variant has been run once, on a synthetic Phaser spec. The
  LOCKED/OPEN partition holding up over dozens of rounds is a reasonable
  expectation, not a demonstrated fact.
- **The partition needs judgment.** The skill says to ask the user when unsure
  which side an item belongs on. An agent that guesses instead will produce
  either a frozen spec or a drifting one, and the skill cannot force that call.
- **Longer prompts are harder to audit.** The original's length limit made
  violations obvious at a glance. A 300-line spec prompt can hide a contradiction
  that nobody notices until round five. The "surface contradictions before
  writing" rule is a mitigation, not a solution.

## Round-1 test results (appended after the first full run)

Ran once, end-to-end, on a real spec (a Phaser 3.80 / TypeScript cyberpunk
platformer with 8 pinned items: engine versions, 480x270 pixel-perfect, Arcade
gravity and jump numbers in frames, a strict 16-color palette, Tiled 16x16,
perf and bundle budgets, a directory layout).

What worked:

- The bar step executed correctly, including the reachability check at bar-setting
  time (Steam page fetched before the bar was offered), and the flow stopped and
  waited for the user's pick.
- All 8 spec bullets landed in LOCKED with values verbatim; none belonged in
  OPEN. The two split calls were right: the 4 named hexes locked, the other 12
  palette colors open; "Vite build" locked, the Vite *version* open (pinning it
  would have been an invented lock).
- The partition absorbed the tester's own urge to invent constraints (it wanted
  to pin the remaining palette colors and physics values; the skill correctly
  forced them into OPEN).

Two defects found, both now fixed in this file:

1. **The flow steps were invisible from the spec skill alone.** The file said
   "Same engine as rayloop" and relied on the sibling skill's Flow section; an
   agent loading only this file skipped the stop-and-wait bar step entirely.
   The Flow is now restated in this file.
2. **The template's /loop exit contradicted the asymptotic option.** The exit
   line hardcoded "until the critic picks ours blind" while the bar line offered
   an asymptotic exit — the exact "loop that never stops" the skill itself
   warns about. The exit is now an unfilled bracket that must match the chosen
   bar, and a rule says so. The same contradiction existed in the sibling
   `rayloop` (its non-visual example paired an asymptotic bar with the winnable
   exit); fixed there too.

Open judgment calls the tester had to make, worth knowing about: "strictly 16
colors" does not say whether a Tiled transparent pixel counts against the 16,
and frame-based timings ("coyote 6 frames") need the locked 60fps to be
meaningful. Both are candidates for a user question in a real run rather than a
silent operationalization.
