# How to judge a piece

You are a **harsh critic**. Your job is not to encourage the builder. Your job is to
decide, honestly, whether our render beats a real shipped AAA game when the two are
put side by side with the labels stripped off.

Praise is not useful. A builder who is told "great progress, just polish the edges"
ships something that loses. A builder who is told "the flash is three times too long
and reads as a lamp, not an explosion" ships something that wins.

## The procedure

1. **Capture ours.**
   `node tools/capture.mjs --shot <shot> --out reference/ours/<shot>.png`
   Non-zero exit means the page threw. A black frame is not a result — fix it first.

2. **Pick the real thing.** Something in `reference/cs2/`, `reference/cod/`,
   `reference/overwatch/`, `reference/valorant/` or `reference/ffxiv/`. Pick the frame
   that is closest in subject and framing to ours. Comparing our hipfire shot against
   their key art is not a comparison.

3. **Build the blind composite.**
   ```
   node tools/blind.mjs --ours reference/ours/<shot>.png \
                        --real reference/<game>/<file>.jpg \
                        --out  reference/blind/<piece>_r<N>.png
   ```
   The tool flips a coin for the ordering and writes the answer key to a separate
   `.key.txt` file.

4. **Look at the composite with the Read tool. Decide before you open the key.**
   Which of A and B looks better? Not "which is ours" — which one would a player
   rather be looking at. Commit to the answer in writing first.

5. **Only then read the `.key.txt`.**

6. **Name the single biggest remaining gap.** One thing. The thing that, if fixed,
   would most change the verdict. Not a list — a list lets the builder pick the easy
   item. One gap, stated concretely enough to act on:
   - Bad: "materials need work"
   - Good: "every surface is the same roughness, so nothing reads as metal vs stone"

7. **Report it.**
   ```
   node tools/status.mjs round <piece-id> --won <true|false> --gap "<the one gap>"
   ```

## When to say we won

Only when you genuinely picked ours blind, or would have called it a coin flip
against a real shipped game. Not "ours is good for a browser game". Not "ours has
improved a lot". The bar is the real game, at the same size, on the same screen.

If ours does not win, it keeps going.

## Traps

- **Do not grade on effort.** You cannot see how hard the builder tried, and you
  should not want to.
- **Do not accept "good for the constraints".** The bar does not care that this runs
  in a browser.
- **Do not let one strong element carry a weak frame.** A beautiful muzzle flash on a
  grey-box wall still loses the frame.
- **Look at what is actually there**, not at what the builder says is there. Read the
  image.

---

# Build hygiene (all agents)

Before you capture, run:

```
node tools/check.mjs
```

It parses every source file and tells you which one is broken. It takes a second
and it will save you from spending a round diagnosing someone else's typo.

## The trap that has already taken the build down once

**Never put a backtick inside a GLSL template literal.** Shader source lives in
`` /* glsl */ `...` `` template strings, so a Markdown-style code quote in a
shader comment terminates the string and the file breaks mid-shader. The browser
reports it as `Unexpected identifier` with no filename and no stack.

Wrong:
```js
/* glsl */ `
  // `pow(abs(cos(a)), k)` draws a flower
`
```

Right:
```js
/* glsl */ `
  // 'pow(abs(cos(a)), k)' draws a flower
`
```

## If the game will not boot

1. `node tools/check.mjs` — catches parse errors, names the file.
2. `node tools/boot_test.mjs` — boots the page and prints runtime errors.
3. If it is not your file, say so on the status board or message the lead. Do not
   fix another agent's file without telling them; two agents editing one file is
   how work gets silently reverted.

---

# Captures are deterministic (as of round 4)

`tools/capture.mjs` installs a **seeded PRNG** over `Math.random` and reseeds it
before every shot. Two captures of the same shot with unchanged source now
produce byte-identical frames (verified: 0.00% of pixels differ by more than
8/255; the residual max difference of 4/255 is GPU float rounding).

**This means you can trust a numeric frame diff.** Before this fix you could
not: the monster gait, particle systems, decals, fissures and burst spheres all
called `Math.random()` directly, so consecutive captures of an *unchanged* shot
differed by ~2-44% depending on how much was moving. A builder measured "40% of
pixels changed" from a shader edit, then captured twice with an identical shader
and got 44% — the metric was pure capture noise.

To measure whether a change actually did anything:

```
node tools/capture.mjs --shot monster --out /tmp/before.png
# ... make your edit ...
node tools/capture.mjs --shot monster --out /tmp/after.png
python3 -c "
from PIL import Image, ImageChops
a=Image.open('/tmp/before.png').convert('RGB'); b=Image.open('/tmp/after.png').convert('RGB')
h=ImageChops.difference(a,b).convert('L').histogram()
print('changed >8/255:', sum(h[8:]), 'of', a.width*a.height)
"
```

A change that reports ~0 changed pixels did not happen, whatever the source
diff says. That is the single fastest way to catch a fix that silently did not
take effect — which has already happened several times in this project.

Note: the game itself still uses real `Math.random()` at play time. The seeding
is installed by the harness only.

---

# The perf number changed meaning (round 6)

`tools/capture.mjs` now prints **milliseconds of GPU work for the shot you just
captured**, not a synthetic fps figure. Two bugs made the old number unusable:

1. **It measured the wrong scene.** The probe called `reset()` and spawned 8
   monsters before timing, so the number printed under every capture described
   that stock scene rather than the frame above it. "Glacier runs at 54 fps" was
   never a statement about glacier — every shot was measuring the same thing,
   and the small variations were residual state.
2. **Headless Chromium runs with vsync off.** The fps figure is uncapped, which
   is why a simple shot now reports sub-millisecond frames. As "what a player
   sees" that is meaningless.

**Read the milliseconds, not the fps.** As a relative cost metric it is
excellent: a shot at 8.6 ms genuinely costs ~14x one at 0.6 ms, and a change
that moves the ms figure has moved real work.

Current costs (1080p, same machine):

```
arena          0.60 ms      <- the base scene
hipfire        0.70 ms
horde          1.30 ms      <- 4 creatures
spell_ice      1.30 ms
spell_snare    6.10 ms
spell_glacier  8.60 ms      <- the outlier, ~14x base
```

If you own a spell, the number to beat is the base scene plus your effect. Ice
at 1.3 ms is fine. Glacier at 8.6 ms is not, and snare at 6.1 ms is worth a look.

Related fix: `App.start()` is now guarded against being called twice. It
previously spawned an independent rAF chain per call while only remembering the
most recent, so pause/resume cycles leaked uncancellable render loops.
