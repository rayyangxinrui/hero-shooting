---
name: rayloop
description: Turns any goal into one short, paste-ready "RayLoop" prompt - a prompt that makes an agent set a concrete quality bar, split the work into small judgeable pieces, run a builder and a separate harsh critic on each, compare blind against the bar, and loop until it wins. Works for builds, writing, code, research, or design. Triggers on "/rayloop", "rayloop", "ray loop", "make a rayloop prompt", "loop until it beats X", the older "gauntlet loop" / "gauntlet this" phrasing, and the same requests in any language - e.g. "擂台循环", "盲测循环", "跑个 rayloop", "一直改到超过 X", "循环到打败 X".
---

# RayLoop

The user gives a goal. You give back ONE short prompt they can paste into a fresh agent session.

You are not doing the work. You are writing the prompt that makes another agent grind on the work until it beats a real reference.

## Flow

1. **Read the goal.** One line restatement in your head, not on screen.
2. **Set the bar.** If the user supplied a reference, use it. If not, offer **2 or 3 candidate bars**, one line each, and stop. Wait for their pick. Do not write the prompt yet.
3. **Write the prompt.** One block, paste-ready, no preamble, no headings inside it, no narration after it.
4. **Offer to run it.** One flat line under the prompt: "I can run this here." Not a question.

If they say run it, you become the lead agent and follow the prompt you just wrote.

## The bar is the whole trick

Everything else in a RayLoop is scaffolding. The loop only produces quality if the thing it compares against is real.

A bar has to pass three tests:

- **Named.** A specific thing, not a category. "Stripe's pricing page" works. "Award-winning SaaS sites" does not.
- **Fetchable.** The critic can actually get it - screenshot the live page, read the published piece, run the binary, open the repo, watch the footage. If the agent cannot obtain it, it will hallucinate the comparison.
- **Comparable.** Both can sit side by side and a judge can pick one. If you cannot imagine the A/B, it is not a bar.

Bars by goal type:

| Goal | Bar that works |
|---|---|
| Website, app, UI | The live site of a specific best-in-class product, screenshotted at the same viewport |
| Game, 3D, visual | Real footage or screenshots from a named shipped title |
| Writing | A specific published piece by a named author or publication, same length and format |
| Code, tooling | A named repo's implementation, plus its benchmark or test suite as the measurable half |
| Research, analysis | A named analyst report or a paper's methods section, judged on rigour and coverage |
| Deck, doc, deliverable | A real artifact from a firm known for it, same page count |

When you propose bars, prefer the hardest one the agent can genuinely reach. A bar that is too easy makes the loop exit on round one.

If the goal has a measurable half (load time, token cost, benchmark score, word count, pass rate), name it alongside the reference. Taste plus a number beats taste alone.

### Say out loud whether the bar is reachable

Some bars cannot be beaten by the thing being built, and pretending otherwise is how a loop runs forever. A browser renderer will not out-model a title with an art team and a 30k-triangle budget. A solo essay will not out-report a newsroom.

That does not make the bar wrong - an unreachable bar still drags the work up, which is the point. It makes the *exit condition* wrong. So when you set the bar, say which of these you are doing:

- **Winnable bar.** Ours can genuinely beat it. Exit = ours wins blind.
- **Asymptotic bar.** Ours will not beat it outright, but every round closes the gap. Exit = the critic can no longer name a gap that is both real and fixable, or two consecutive rounds produce no fixable gap.

State this in the prompt. An asymptotic bar with a winnable bar's exit condition is a loop that never stops, and the user finds out sixty rounds in.

## Correctness before taste

**The most important addition to this skill, learned the hard way.**

A critic looking at pixels reports what it sees: "the weapon is too dark." That is a taste finding. It is also, very often, a *symptom* - and the cause is that the weapon is receiving no light at all, because the viewmodel camera renders a layer the light rig never touches.

In a long run, most of the big jumps come from correctness bugs, not from taste. Real examples from one run:

- Every patched material silently shared one compiled shader, so four rounds of material work were never evaluated.
- Recoil was divided by 10,000 by a stray factor, so a mid-burst frame was pixel-identical to a resting one.
- A config value was read but never defined, making every weapon's aim offset `NaN`, which read to the critic as "the worst frame in the project."
- The tone curve clamped 326,816 pixels to exact zero before the shadow lift ran, so all shadow detail was destroyed after being correctly rendered.

Every one of those looked like an art problem and was a wiring problem. A critic told to judge beauty will describe the symptom forever.

So the prompt must tell the critic to do two things:

1. **Say whether the piece is even functioning** before judging how good it looks. Is it drawn at all? Is it receiving input, light, data? Does the value in the config reach the thing that uses it?
2. **Root-cause its own finding in the source** when it can, not just report the pixels.

And it must tell the builder: when a critic reports the same gap three rounds running and your fix "should have worked," stop tuning and go find out whether the code path executes.

## Measure, do not squint

A critic that only eyeballs produces "the gun is too dark." A critic with a ruler produces "0 of 14 hand parts clear the weapon's solids - every finger is 17-23 mm inside the wood." The second one is actionable and the first one is not.

The prompt should require the loop to build its own instruments early:

- **A deterministic capture.** Same input, byte-identical output. Seed randomness, step simulations at a fixed rate. Without this you cannot tell a real change from noise.
- **A diff.** After every fix, compare the new artifact to the old one numerically. **A change that produces no diff did not happen**, whatever the source diff says. This is the single fastest way to catch a fix that silently failed - and it catches builders who report success without verifying.
- **Numeric probes for the specific claim.** Not general metrics - the exact number that settles the current question. Screen coverage percentage. Histogram cliff. Distance between two parts. Pixel counts by region.

Half of this is guarding against your own agents. In one run, a builder measured "40% of pixels changed" from a shader edit, then captured the same shot twice with an *identical* shader and got 44% - the metric was pure noise. It reported this honestly and against its own interest, which is the behaviour you want; the instrument is what made it visible.

## Do not trust the critic blindly either

Harsh is not the same as correct. Verify a finding before you spend a round on it.

From one run: a critic reported the weapon was "51% off-frame." Measured, 93% was on screen - the claim did not reproduce. Its underlying point was still right for a different reason, and acting on the *stated* reason would have been wrong. Another reported "all the creature variants read as one species" - true of the frame it was given, because the capture harness was spawning the same two archetypes. The generator was fine.

So: the lead verifies before dispatching. Cheaply, with a probe, not with a whole round. And when a critic is wrong, tell it - a critic that is never corrected drifts.

Both are cases of a broader rule: **the critic judges the artifact, not the code.** When its diagnosis of *cause* is wrong but its observation of *effect* is right, keep the observation and throw away the cause.

## Judge only what is on disk right now

Re-capture immediately before compositing a comparison. Do not judge an artifact produced before the last round of fixes.

This sounds obvious and it is very easy to get wrong when several builders are running: in one run a critic spent a full pass criticising missing hands and missing shadows, both of which had landed forty minutes earlier. It worked that out from file timestamps and said so, which cost the round.

Make the comparison tool re-generate the artifact itself, so a stale input is impossible rather than merely discouraged. Stamp the artifact's timestamp into the answer key.

## Running several builders at once

Fan-out is where the throughput is, and it is also where the self-inflicted wounds are.

- **One owner per file.** Two agents editing one file silently revert each other. Say who owns what in the dispatch.
- **One broken file blocks everyone.** Give the loop a fast syntax/build gate and require every agent to run it before capturing. A build that will not start burns every agent's round simultaneously, and the error usually names no file.
- **Agents die.** API errors, lost transcripts, agents that stop mid-edit. The lead must be able to pick up an unfinished piece, and must not assume a dispatched task landed. Check the artifact, not the report.
- **Cross-cutting fixes belong to the lead.** When one bug is blocking four pieces, the lead fixes it once and tells the four builders it is fixed and what they can now rely on. Do not let four agents each discover it.

## Prompt template

Adapt the wording every time. Fill the brackets, keep it short, keep the last line.

```
Build [GOAL].

The bar is [BAR]. Get the real thing first and compare against it directly, not against a description of it. [Ours can beat this / Ours will not beat this outright, so the exit is when no real fixable gap is left.]

Break this into the smallest pieces that can be improved and judged on their own. For each piece, fan out a builder and a separate critic with fresh context. The critic inspects the actual output, puts it next to the bar blind with the labels stripped, says which one is better, and names the single biggest remaining gap. Then it goes back to the builder.

Check a piece is actually working - drawn, wired, receiving its inputs - before judging how good it looks. Most big jumps are broken wiring wearing a taste problem's clothes. Capture deterministically and diff after every fix: no diff means the fix did not happen.

The critic should be a harsh critic. Praise is not useful. If ours does not win, it keeps going.

/loop on each piece until [the critic picks ours blind / two consecutive rounds yield no real fixable gap]. Fill in the exit that matches the bar above — the two are not interchangeable, and a winnable exit on an asymptotic bar is a loop that never stops. Do not stop before that.

Keep a live progress page updating as the work evolves so I can watch it.

Fan out subagents and ultracode.
```

Rules for what you fill in:

- Bake the bar in as a concrete, fetchable thing. URL, product name, repo, title.
- Say which exit condition applies - winnable or asymptotic.
- Fill in the /loop line to match it. The template's bracket is left open on purpose; a winnable exit on an asymptotic bar is a loop that never stops.
- Add a budget or cost ceiling line **only if the user named one**. No default cap.
- Add tool names only if the goal needs them (image or video generation, a browser, a deploy target).
- Everything else stays out. No architecture, no file layout, no decomposition, no round count, no stack choice unless the user demanded it. The agent decides those, and it decides better than a spec written before the work started.

## Length and voice

Short. Around 150 to 220 words. If the prompt needs a heading to stay readable, it is too long.

Plain sentences. No bullet lists inside the prompt. It should read like someone telling an agent what perfect looks like and refusing to accept less.

## Working in another language

The mechanism is language-independent, and this was tested rather than assumed:
the same blind composite was given to two critics differing only in the language
of their instructions. Both picked the real game, both at maximum confidence,
both refused to flatter, both produced the required structured verdict. The
blind A/B, the harsh binary judgement and the "name one gap" discipline all
survive translation intact.

Four things do need attention:

- **Trigger phrases.** A skill whose description lists only English trigger
  phrases will not fire when the user asks for the same thing in their own
  language. List them.
- **The bar must be fetchable *from here*.** A globally famous reference is
  easy. A regional product's page may need a login, may block scraping, or may
  simply not be reachable — and an agent that cannot fetch the bar will invent
  the comparison, which is this skill's most common failure mode. Check
  reachability when you set the bar, not when the critic reports.
- **Match the bar's language to the artifact's language.** If the deliverable is
  prose in language X, the bar has to be a real piece written in X. An
  acclaimed English essay is not a bar for Chinese copy: half of what a critic
  would be judging is rhythm and register that do not transfer.
- **Instruction language and artifact language are separate choices.** Talking
  to the user in one language while writing code comments, agent dispatches and
  commit messages in another is usually correct — comments are written for
  whoever reads the code later, not for this conversation. Only the artifact
  itself has to be in the user's language.

## Portability

`/loop` and `ultracode` are Claude Code features. `/loop` reruns the prompt on an interval or lets the model pace itself. `ultracode` opts the turn into multi-agent orchestration.

For any other agent, swap the last two lines for: "Keep looping until the critic picks ours. Run the builders and critics as parallel subagents." The structure carries over unchanged.

## Two filled examples

**Visual goal.** User: "landing page for my running brand, athletic, green and dark, has to feel alive."

Bars offered: A) Nike's current running campaign page B) On Running's homepage C) Gymshark's product landing page. User picks A.

```
Build a landing page for a running brand. Athletic, peak performance, green and dark, energetic, aimed at a young healthy audience. It needs to be interactive and visually unmistakable.

The bar is Nike's current running campaign page. Screenshot it at desktop and mobile and compare against those directly, not against a description of them. We can beat this outright.

Break this into the smallest pieces that can be improved and judged on their own - hero, motion, type, colour, imagery, interaction, mobile. For each piece, fan out a builder and a separate critic with fresh context. The critic opens the real page in a browser, puts our screenshot next to Nike's blind with the labels stripped, says which is better, and names the single biggest remaining gap. Then it goes back to the builder.

Check a piece actually works before judging how it looks. Screenshot at a fixed viewport and diff after every fix - a fix that changes no pixels did not happen.

The critic should be a harsh critic. Praise is not useful. If ours does not win, it keeps going.

/loop on each piece until the critic picks ours blind. Do not stop before that.

Keep a live progress page updating as the work evolves so I can watch it.

Fan out subagents and ultracode.
```

**Non-visual goal.** User: "a 2000-word explainer on vector databases for non-engineers."

Bars offered: A) a specific Stripe engineering blog explainer B) a named Julia Evans post C) the Wikipedia article plus a comprehension test. User picks B.

```
Write a 2000-word explainer on vector databases for smart non-engineers.

The bar is Julia Evans' writing on hard technical topics. Pull three of her actual posts and compare against them directly, not against a description of her style. We will not out-write her, so exit when no real fixable gap is left.

Break this into the smallest pieces that can be judged on their own - the opening, each explanation, the diagrams, the analogies, the ending. For each piece, fan out a writer and a separate critic with fresh context. The critic reads ours and hers blind with the bylines stripped, says which a non-engineer would understand faster, and names the biggest remaining gap. Then it goes back to the writer.

Check the piece is doing its job before judging its prose - claims accurate, no term used before it is defined. Have a fresh non-expert answer three comprehension questions from the draft alone; a rewrite that does not move it did not help.

The critic should be a harsh critic. Praise is not useful. If ours does not win, it keeps going.

/loop on each piece until no real fixable gap is left. Do not stop before that.

Keep a live progress page updating as the work evolves so I can watch it.

Fan out subagents and ultracode.
```

## What breaks a RayLoop

- **A vague bar.** The critic invents a comparison and approves everything. Most common failure by far.
- **An unreachable bar with a winnable exit.** The loop runs forever and nobody notices until the round count is absurd. Name the exit condition when you name the bar.
- **The builder judging its own work.** The critic must be a separate agent with fresh context. It should not know how hard the builder tried.
- **A soft critic.** Say "harsh" in the prompt and give it a binary job: which one is better, A or B. Scores out of 10 drift upward every round.
- **Judging a stale artifact.** Re-generate before comparing, or the round is spent on defects that were fixed hours ago.
- **Treating a critic's diagnosis as fact.** Its observation is usually right; its explanation of the cause often is not. Verify cheaply before spending a round.
- **Tuning a code path that never runs.** Three rounds of "it's still too dark" means stop tuning and check whether the value reaches the renderer.
- **Named exit after N rounds.** The exit is winning the comparison, running out of fixable gaps, or the user stopping the run. Never a round count.
- **Over-specifying.** Every extra instruction is one fewer decision the agent makes with its own judgment. Minimal wins.
