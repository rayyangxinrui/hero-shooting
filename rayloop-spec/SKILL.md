---
name: rayloop-spec
description: The spec-driven RayLoop. Turns a goal - or a full technical specification - into one paste-ready prompt that makes an agent set a concrete quality bar, split the work into small judgeable pieces, run a builder and a separate harsh critic on each, compare blind against the bar, and loop until it wins. Unlike plain rayloop there is NO length limit and NO natural-language requirement: the user may hand over engine choice, architecture, file layout, shader techniques, numeric parameters, perf budgets, API contracts, and every one of those is carried through verbatim as a hard constraint. Use this when the user already knows how they want it built. Triggers on "/rayloop-spec", "rayloop spec", "spec rayloop", "技术规格循环", "带参数的 rayloop", "详细规格盲测循环", and on any rayloop request that arrives with a written spec, parameter table, architecture diagram, or config block attached.
---

# RayLoop / Spec

Same engine as `rayloop`: a real bar, small judgeable pieces, a builder and a
separate harsh critic on each, blind A/B, loop until it wins.

One difference, and it changes what you are allowed to write: **the user is
permitted to specify the implementation, and whatever they specify you must
carry through verbatim.**

Plain `rayloop` deliberately withholds architecture, decomposition and stack
choice, on the principle that every extra instruction is one fewer decision the
agent makes with its own judgment. That principle is right *when the user has no
opinion*. It is wrong when they do. So the rule inverts:

> In plain rayloop, unstated means the agent decides.
> Here, **stated means locked**, and unstated still means the agent decides.

## Flow

This file must stand alone — an agent that loaded only this skill was observed
skipping the bar-picking step entirely, because the flow lived in the sibling
skill's file. So the full flow is restated here:

1. **Read the goal and the spec.** Restatement in your head, not on screen.
2. **Set the bar.** If the user supplied a reference, use it. If not, offer
   **2 or 3 candidate bars**, one line each, and stop. Wait for their pick. Do
   not write the prompt yet.
3. **Write the prompt.** One block, paste-ready, no preamble, no narration
   after it.
4. **Offer to run it.** One flat line under the prompt: "I can run this here."
   Not a question.

If they say run it, you become the lead agent and follow the prompt you just
wrote.

## No length limit

There is no word count. A prompt carrying a real spec may run to hundreds of
lines, and it should — a truncated spec is a spec the builder will violate.

Headings, tables, numbered lists, code blocks, config snippets, ASCII diagrams,
JSON, YAML, GLSL, type signatures: all allowed inside the prompt. Use whatever
structure makes the constraint unambiguous to a machine.

What is still banned is **padding**. Length must be carried by content the
builder cannot derive on its own. Delete anything that merely restates the
obvious. A 900-line prompt where 400 lines are encouragement is worse than a
120-line prompt that is all constraint.

## Separate the locked from the open

This is the single most valuable thing this skill does, and the thing an agent
gets wrong if you do not force it. Every prompt must partition its instructions
into two explicitly labelled sets:

**LOCKED — do not deviate.** Things the user specified. Engine, language,
library versions, architecture, file layout, algorithms, numeric parameters,
API shapes, perf budgets, platform targets, art direction. If the builder thinks
a locked item is wrong, it says so and *keeps building to spec* — it does not
silently substitute.

**OPEN — your call.** Everything the user did not pin down. The builder decides
these with its own judgment and does not ask permission.

Write both lists. An unlabelled spec gets treated as advisory and drifted from
by round three; an over-locked spec freezes decisions the user never actually
cared about. If you are unsure which side an item belongs on, ask the user
before writing the prompt rather than guessing — a wrong lock is expensive and
silent.

### Locked does not mean unquestionable

A spec written before the work started can be wrong, and a builder that
discovers a locked constraint is impossible must not just fail quietly. Require
this in the prompt:

> If a locked constraint turns out to be unachievable or to contradict another
> locked constraint, stop that piece, report which constraint and why with the
> measurement that proves it, and wait. Do not silently substitute. Do not
> quietly drop it and keep going.

That is the difference between a spec and a wish.

## The bar is still the whole trick

Unchanged from `rayloop`, and a spec does not replace it. A prompt full of
parameters and no reference produces something that satisfies the spec and still
looks wrong, because the spec was never the goal — it was the route.

A bar has to pass three tests:

- **Named.** A specific thing, not a category.
- **Fetchable.** The critic can actually get it: screenshot the live page, read
  the published piece, run the binary, open the repo, watch the footage. If the
  agent cannot obtain it, it will hallucinate the comparison.
- **Comparable.** Both can sit side by side and a judge can pick one.

| Goal | Bar that works |
|---|---|
| Website, app, UI | The live site of a specific best-in-class product, at the same viewport |
| Game, 3D, visual | Real footage or screenshots from a named shipped title |
| Writing | A specific published piece by a named author, same length and format |
| Code, tooling | A named repo's implementation, plus its benchmark or test suite |
| Research, analysis | A named report or a paper's methods section, on rigour and coverage |
| Deck, doc, deliverable | A real artifact from a firm known for it, same page count |

Prefer the hardest bar the agent can genuinely reach. Too easy and the loop
exits on round one.

### Two bars, when a spec is involved

A spec gives you a second, cheaper bar that plain rayloop does not have, and you
should state both:

- **The taste bar** — the named reference, judged blind by a critic.
- **The conformance bar** — the spec itself, checkable mechanically. Does it hold
  60fps at 1440p? Is p99 under 8ms? Does the file layout match? Are the
  parameters the stated values? This half needs no taste and no critic, so it
  should be automated and run every round.

Conformance is necessary and not sufficient. A piece that passes every numeric
check and loses the blind A/B has not passed. Say that in the prompt, or the
builder will treat green tests as done.

### Say out loud whether the taste bar is reachable

Some bars cannot be beaten by the thing being built, and pretending otherwise is
how a loop runs forever. A browser renderer will not out-model a title with an
art team. State which case you are in:

- **Winnable bar.** Ours can genuinely beat it. Exit = ours wins blind.
- **Asymptotic bar.** Ours will not beat it outright, but every round closes the
  gap. Exit = two consecutive rounds produce no gap that is both real and
  fixable.

An asymptotic bar with a winnable bar's exit condition is a loop that never
stops, and the user finds out sixty rounds in.

## Correctness before taste

**The highest-value rule in either version of this skill, learned the hard way.**

A critic asked to judge how something *looks* will produce pages of art
direction for a thing that is broken, unlit, mis-wired or not on screen at all.
Real failures found this way, each of which had absorbed multiple rounds of
useless taste feedback first:

- A first-person weapon received **zero light**, because the camera drawing it
  saw only its own layer and the renderer collects lights per camera per layer.
  Four rounds of material critique on an object that was never lit.
- Every patched material in a project **shared one compiled shader program**,
  because the graphics library keys its program cache on the patch function's
  source text and every patch went through one identically-named wrapper. Four
  materials, one shader. Rounds of "the wood looks wrong" on wood that was
  rendering as steel.
- Recoil was integrated with a stray `* 0.01`, so a mid-burst frame was
  **pixel-identical** to a resting one. Four rounds of "the recoil feels weak"
  about a value being divided by a hundred on its way to the screen.
- Aim-down-sights was fed a setting that **was read but never defined**, so every
  offset was `NaN`. Four rounds of critique on a feature that could not work.
- Twelve of eighteen faces on a primitive were **wound backwards**, so with
  backface culling the object was a hollow shell of floating plates. Blamed on
  lighting for rounds.

Every one is a functional bug that presents as an aesthetic one. So require, in
the prompt, in this order:

1. **Is it there?** On screen, in the DOM, in the output. Assert it, do not assume.
2. **Is it wired?** Receiving light, input, data, events. Probe the actual
   runtime values, do not read the source and conclude.
3. **Does a change to it change the output?** Capture, edit, capture, diff. If
   the diff is empty, the fix did not happen, whatever the source diff says.
4. **Only now, how good does it look?**

A critic that skips to 4 will burn rounds writing beautiful notes about nothing.

## Measurement has to be trustworthy

If the loop's own instruments lie, every round after that is noise. Both of
these were real, and both invalidated multiple rounds of work:

- **Captures were not deterministic.** The simulation called a global RNG in the
  animation, particle, decal and debris paths, so two captures of an *unchanged*
  scene differed by up to 44% of pixels. A builder measured "40% changed" from
  its own edit and was measuring nothing. Fix: seed the RNG in the capture
  harness, verify two captures of an unchanged scene differ by ~0%, and only
  then trust a diff.
- **The perf probe measured the wrong scene.** It reset and built a synthetic
  scene before timing, so the number printed under every screenshot described
  that stock scene, not the frame above it — every shot reported the same cost.
  And it ran with vsync off, so the fps figure was uncapped and meaningless.
  Fix: measure the artifact actually captured, report milliseconds rather than
  fps, and say which it is.

So require in the prompt: **before trusting any metric, prove the metric.**
Capture the same state twice unchanged and confirm the measurement is stable.
State what each number is measured on. A metric nobody validated is worse than
no metric, because it is believed.

## Prompt template

Adapt every time. Fill the brackets. Sections with no content get deleted, not
left empty. Keep the last two lines.

````
Build [GOAL].

## The bar

The taste bar is [NAMED REFERENCE]. Get the real thing first and compare against
it directly, not against a description of it. [Ours can beat this / Ours will not
beat this outright, so the exit is two consecutive rounds with no real fixable
gap.]

The conformance bar is the spec below, and it is checkable mechanically. Automate
it and run it every round. Passing it is necessary and not sufficient - a piece
that passes every numeric check and still loses the blind A/B has not passed.

## LOCKED - do not deviate

[Everything the user specified: engine, versions, architecture, file layout,
algorithms, numeric parameters, API shapes, perf budgets, platform targets, art
direction. Tables, code blocks and config snippets welcome. Be exact - a range
where the user gave a number is a silent licence to drift.]

If a locked constraint turns out to be unachievable, or to contradict another
locked constraint, stop that piece and report which constraint and why, with the
measurement that proves it. Do not silently substitute. Do not quietly drop it.

## OPEN - your call

[Everything the user did not pin down. Decide these yourself and do not ask.]

## How to run it

Break this into the smallest pieces that can be improved and judged on their
own. For each piece, fan out a builder and a separate critic with fresh context.
The critic inspects the actual output, puts it next to the bar blind with the
labels stripped, says which one is better, and names the single biggest
remaining gap. Then it goes back to the builder.

Before judging how good a piece looks, prove it works: that it is there, that it
is wired and receiving its inputs, and that editing it changes the output.
Capture deterministically and diff after every fix - no diff means the fix did
not happen. Most big jumps are broken wiring wearing a taste problem's clothes.

Prove your instruments before trusting them. Capture the same unchanged state
twice and confirm the measurement is stable. Say what each number is measured on.

The critic should be a harsh critic. Praise is not useful. If ours does not win,
it keeps going.

/loop on each piece until [the critic picks ours blind / two consecutive rounds
yield no gap that is both real and fixable] and conformance passes. Fill in the
exit that matches the bar above — the two are not interchangeable, and a
winnable exit on an asymptotic bar is a loop that never stops. Do not stop
before that.

Keep a live progress page updating as the work evolves so I can watch it.

Fan out subagents and ultracode.
````

## Rules for what you fill in

- **Carry the spec verbatim.** Numbers, versions and names exactly as given. If
  the user wrote `p99 < 8ms at 1440p`, do not soften it to "should be fast".
- **Label every constraint locked or open.** No unlabelled instructions.
- **Do not invent constraints.** If the user did not specify the renderer, it
  goes in OPEN. Inventing a lock is the failure mode of this skill, exactly as
  hallucinating a bar is the failure mode of plain rayloop.
- **Contradictions get surfaced, not resolved.** If two specified things cannot
  both hold, say so before writing the prompt.
- Add a budget or cost ceiling **only if the user named one**.
- Add tool names only if the goal needs them.
- Keep the taste bar even when the spec is enormous. Spec conformance is not
  quality.
- **Fill in the /loop exit to match the bar.** The template's bracket ships
  unresolved on purpose; a prompt that leaves it unresolved, or that pairs a
  winnable exit with an asymptotic bar, is broken. This was caught in testing:
  the template previously hardcoded the winnable exit while offering the
  asymptotic option, which is the exact "loop that never stops" the skill warns
  about elsewhere.

## Which version to use

| Situation | Use |
|---|---|
| "make me a landing page that feels alive" | `rayloop` |
| User has no implementation opinion | `rayloop` |
| User hands over a parameter table, architecture, or config | **`rayloop-spec`** |
| Rebuilding something to match an existing system's conventions | **`rayloop-spec`** |
| Hard numeric targets: perf budget, bundle size, latency | **`rayloop-spec`** |
| Porting: engine, platform or language is fixed | **`rayloop-spec`** |

When in doubt, ask which they want. A spec-driven prompt for a user with no spec
is a prompt full of invented constraints, and it will produce worse work than
the short version.

## Working in another language

The mechanism is language-independent, and this was tested rather than assumed:
the same blind composite was given to two critics differing only in the language
of their instructions. Both picked the real reference, both at maximum
confidence, both refused to flatter, both produced the required structured
verdict. The blind A/B, the harsh binary judgement and the "name one gap"
discipline all survive translation intact.

Four things need attention:

- **Trigger phrases.** List them in the user's language or the skill will not fire.
- **The bar must be fetchable *from here*.** A regional product's page may need a
  login or block scraping, and an agent that cannot fetch the bar will invent the
  comparison. Check reachability when you set the bar, not when the critic reports.
- **Match the bar's language to the artifact's language.** If the deliverable is
  prose in language X, the bar must be a real piece written in X.
- **Instruction language and artifact language are separate choices.** Writing
  code comments and commit messages in English while talking to the user in
  another language is usually correct - comments are for whoever reads the code
  later. Only the artifact itself has to be in the user's language.

**A spec is the one part that should not be translated loosely.** Parameter
names, API identifiers, file paths and library names stay in their original
form. Translating `viewmodelFov` into another language's prose is how a builder
ends up unable to find the field.

## Portability

`/loop` and `ultracode` are Claude Code features. `/loop` reruns the prompt on an
interval or lets the model pace itself. `ultracode` opts the turn into
multi-agent orchestration.

For any other agent, swap the last two lines for: "Keep looping until the critic
picks ours. Run the builders and critics as parallel subagents." The structure
carries over unchanged.

## What breaks a spec-driven loop

- **A vague bar.** Still the most common failure. The critic invents a comparison
  and approves everything.
- **Judging taste on a broken piece.** See *Correctness before taste*. This wastes
  more rounds than every other item combined.
- **Untrusted instruments.** A metric nobody validated is worse than no metric.
- **Invented locks.** Constraints the user never asked for, frozen into the prompt
  and never questioned again.
- **Unlabelled spec.** Treated as advisory, drifted from by round three.
- **Green tests read as done.** Conformance passing while the blind A/B loses.
- **The builder judging its own work.** The critic must be a separate agent with
  fresh context. It should not know how hard the builder tried.
- **A soft critic.** Say "harsh" and give it a binary job. Scores out of ten drift
  upward every round.
- **Exit after N rounds.** The exit is winning the comparison, or the user
  stopping the run. Never a round count.
- **Padding mistaken for detail.** No length limit is not licence to write nine
  hundred lines of encouragement. Every line must be a constraint the builder
  could not have derived.
