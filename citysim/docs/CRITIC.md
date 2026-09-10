# Whole-game critic — round 1

**Verdict: 6.5 / 10. The game does not pass.** Pass mark is 8.5.

Twelve shots taken fresh for this review at 1280×720, one at a time, under SwiftShader.
Nothing in this document rests on a screenshot somebody else took. Every number below
was measured off my own PNGs; the sampling and cropping scripts were throwaway and touched
nothing in `src/`, `tools/` or `index.html`.

Shots live in `docs/shots/critic/`:

| # | shot | variant | time |
|---|---|---|---|
| 01 | `01_skyline_1875` | skyline | 18:45 |
| 02 | `02_skyline_0650` | skyline | 06:30 |
| 03 | `03_skyline_1300` | skyline | 13:00 |
| 04 | `04_skyline_2200` | skyline | 22:00 |
| 05 | `05_downtown_1300` | downtown | 13:00 |
| 06 | `06_downtown_2200` | downtown | 22:00 |
| 07 | `07_residential_1300` | residential | 13:00 |
| 08 | `08_aerial_1300` | aerial | 13:00 |
| 09 | `09_aerial_2200` | aerial | 22:00 |
| 10 | `10_waterfront_1875` | waterfront | 18:45 |
| 11 | `11_ui_default` | ui / default | 13:00 |
| 12 | `12_ui_panels` | ui / panels | 13:00 |

---

## 0. The one finding that explains most of the others

Almost every visual failure in this project has the same shape, and it is worth stating
before the per-module scores because it re-frames all of them.

**All the craft is in LOD 0. LOD 0 ends at 260 m. Every hero camera stands 420–780 m out.**

- `src/buildings/Chunks.js:27` — `this.dist = [260, 780]`
- `src/buildings/Chunks.js:182` — `mesh.castShadow = t === 0 && ...`
- `src/buildings/Generate.js:750` — `if (lod === 0) roofClutter(...)`
- `src/buildings/Generate.js:440–447` — reveals, awnings, balconies, string courses all `lod === 0`
- `src/props/Materials.js:257` — light-pool gobo culls out at 225→295 m
- `src/props/Materials.js:248` — shop lights cull out at 275→355 m
- `src/props/Materials.js:209` — car paint culls out at 325→405 m
- `src/demo/shots.js` — skyline vantage searches `minBack: 420, maxBack: 780`; night `330–600`; aerial stands `clamp(span*0.40, 280, 520)` up

So at the exact distance the game chooses to photograph itself, it has already discarded:
cast shadows, window reveals, mullions, balconies, awnings, string courses, roof plant,
street-lamp light pools, shop lights and every vehicle. What survives is bare masses with a
stamped window grid standing on unlit ground. That is precisely what shots 01, 04, 08 and 09
show, and it is why the close shots (05, 12) are so much stronger than the wide ones.

This is good news of a kind: the fix is not "make better art". It is to add a tier that keeps
shadow casting, roof plant and emissive street furniture alive out to ~800 m, and to stop the
composer from standing where nothing is left to see. The art already exists — the renderer
throws it away before the shutter opens.

---

## 1. Per-module scores

Individual builder self-scores are **not recorded** anywhere I can find: `docs/STATUS.json`
carries `score: null` and `scored: 0` for all fourteen entries. The only self-score written
down is `environment` at 8.0/10, in the integrator pass-3 log. I have therefore compared
against the stated 6.5–8.0 band and flagged where I land outside it.

| module | my score | pass ≥8.5 | vs. self-score band |
|---|---|---|---|
| ui | 8.0 | **FAIL** (narrow) | in band, top of it — agree |
| roads | 7.5 | **FAIL** | in band — agree |
| simulation | 7.5 | **FAIL** | in band — agree |
| zoning | 7.0 | **FAIL** | in band — agree |
| props | 7.0 | **FAIL** | in band — agree |
| traffic | 7.0 | **FAIL** | in band — agree |
| tools | 7.0 | **FAIL** | in band — agree |
| audio | 7.0 *(provisional, not evidence-backed)* | **FAIL** | cannot verify |
| environment | 6.5 | **FAIL** | **1.5 below its recorded 8.0 — biggest disagreement** |
| demo | 6.5 | **FAIL** | below band |
| terrain | 6.0 | **FAIL** | below band |
| buildings | 6.0 | **FAIL** | below band |
| effects | 6.0 | **FAIL** | below band |
| **whole game** | **6.5** | **FAIL** | — |

**Nothing passes.** Nine of thirteen land inside the 6.5–8.0 band the builders claimed, so
the self-assessment was broadly honest in aggregate. It was *not* honest about `environment`,
and it was generous about `buildings` and `effects` — which happen to be the three modules
that own the top six issues below.

### terrain — 6.0
The large-scale landform is genuinely well judged: a river valley, a coastal plain and a ring
of hills that gives the city somewhere to *be*, and the aerial perspective over it (08, 03) is
the most convincing single effect in the project. Everything below that scale fails. The
surface is one material — a flat sage green with a slow tan gradient — with no slope-based
blending (no rock on steep faces, no scree, no sand beyond a thin shore band), no macro
variation (no fields, forest, heath or watercourses inland) and no detail normal at close
range. Distant hills are smooth cones with visible triangle banding along their silhouettes
(01 right edge, 10 left). Outside the built area the map is a featureless plain to the horizon,
which is what makes 08 read as a diorama on a table rather than a region. And `flattenAlong`
(R-6, accepted in integrator pass 1; R-tools-5, restated in pass 4) is **still not in the
tree** — I grepped `src/terrain/` and it does not exist — so roads never cut the ground. Shot
07 shows the consequence directly: the highway runs along a graded shelf that meets rolling
terrain at a straight-line break with no cutting, no embankment and no batter.

### environment — 6.5, against a recorded self-score of 8.0
This is where I disagree hardest, and I want to be precise about why, because the module has
real strengths: the sky gradient, the aerial-perspective composite and the cloud lighting at
06:30 and 22:00 are good work, and the bounded shadow fit shipped after R-bldg-3 is a genuine
bug fix. Three defects sink it anyway.

**(a) The zenith renders green whenever the sun is low.** Measured at the top of frame:
06:30 → RGB(60, 77, 71); 18:45 → RGB(117, 136, 130). Green is the dominant channel in both.
No physical sky is green at zenith at any hour — a low-sun zenith is blue-violet with B
dominant, and the warm band belongs at the horizon. This is a systematic sky-model or
tone-map error, visible in two independent frames, and it puts an olive cast over the whole
of shot 02.

**(b) The shadow fit degrades to uselessness at exactly the distances the game photographs
from.** `RADIUS_MAX = 1500` over `SHADOW_MAP = 2048` gives a 3000 m ortho at **1.46 m per
texel**, and `normalBias = clamp(texel * 1.7, 0.02, 4.0)` then offsets the lookup **2.49 m**
along the surface normal. At that bias every shadow smaller than a building is erased and
the survivors detach from their casters. Even at street level (shot 05, orbit 118 m) the fit
gives 0.26 m/texel and 0.45 m of bias — enough to remove tree-canopy dapple entirely, which
is why a densely tree-lined avenue at 13:00 has no shade on it.

**(c) Water is not a water shader.** It reflects nothing at any hour — not the sky, not the
city standing at its edge. Shot 10 is a waterfront at golden hour in which the buildings cast
no reflection at all, which is the one thing a waterfront shot exists to show. It carries a
hard geometry seam straight across the surface (cropped and confirmed), a blotchy
low-frequency noise that reads as moss rather than water, and at noon (03) it measures
brighter than the sky above it.

### roads — 7.5
The best-executed geometry in the project and the module I'd hold up as the standard. Shot 05
has correct lane lines, a hatched yellow median, zebra crossings, stop lines, a proper kerb
and a carriageway that reads as asphalt. Shot 08 shows a plan that a person would believe: a
grid downtown decaying into curved residential streets and cul-de-sacs, with a legible
hierarchy of arterials. Marked down for three things. The surface is one clean grey with no
wear at all — no patching, no wheel-track polish, no oil staining, no manholes, no gutter
line, and markings with no erosion. There are **no bridges anywhere**: R-demo-6 records that
`demo` refuses every span crossing water because `_computeElevation` lifts the profile to the
river bed, so a city built on an estuary never crosses it, and shot 08 shows the whole
settlement stopped dead at one bank. And in shot 07 a coloured lane-surfacing decal with white
chevrons is painted **onto the grass verge**, clearly offset from the carriageway — a decal
clipped to the wrong polygon.

### zoning — 7.0
Judged through its output, since it stages nothing of its own. The density gradient is correct
and legible in 08: towers at the core, a mid-rise ring, low residential at the fringe, with
buildings addressing street frontages properly rather than floating in block interiors. The
zone palette in 11 is coherent and correctly colour-coded. Held down because the land-use
vocabulary is thin: the entire city is residential / commercial / office / industrial boxes.
There are no parks worth the name, no plazas, no civic set-pieces, no parking, no schools or
stadia as physical objects — so from the air every block is the same use, and the city has no
landmark anywhere to orient by. R-tools-6 (any road edit runs `clearAll()` + `autoZone` and
erases hand-painted districts) is also still open.

### buildings — 6.0
The module that costs the most illusion, and I am well below the band. Its massing is good:
setbacks, crowns, masts and a real height distribution, and the crowns were deliberately kept
alive into LOD 1 with a comment explaining that a skyline is judged from 500 m — exactly the
right instinct, applied to exactly one feature. Everything else fails.

The facade system is one idea repeated everywhere: a stamped grid of flat window squares with
no reveal, no mullion relief, no spandrel, no frame and no glass. Cropped at 2× on shot 01,
the two hero towers are horizontal banded wallpaper with 1–2 pixel dashes standing in for
windows; the mid-rise blocks are brown boxes with a blue-grey square grid printed on them.
Normal maps and ORM maps are authored (`Textures.js:652`) and do nothing, because there is no
directional light strong enough to reveal them.

Roofs are worse and matter more. They are bare flat decks in a tan that matches the terrain
albedo almost exactly, so at a glance every building reads as open-topped — I cropped one to
be sure it was not a hole in the mesh, and it is not, it is an empty deck. `roofClutter` is
gated to `lod === 0`, so the roof plant that does exist vanishes at 260 m — in shots 08 and 09,
where roofs are perhaps 40 % of the visible city, every one of them is empty.

### props — 7.0
Strong at street level and invisible where it is needed. Shot 05 has dense, well-formed street
trees with real canopy volume, traffic signals on cantilevered masts, lamp columns, bollards
and hydrants; the night light-pool gobos in 06 are the right shape and the right colour
temperature. Two failures. **One tree species, one saturated yellow-green, repeated hundreds
of times** — shot 07 makes the repetition unmissable, and the green sits out of register with
every other material in the frame, reading as plastic. And the cull ladder retires the light
pool at 295 m, shop lights at 355 m and the lamp lens at 620 m, so the night city above 300 m
has no street-level light whatsoever: shot 09 is a city whose streets are black voids.

### traffic — 7.0
The vehicles are varied in colour and silhouette, sit correctly in lane, hold plausible
spacing and stop at junctions. The night lighting system is properly engineered — patching
`instanceColor` into `totalEmissiveRadiance` so a braking car can brighten is the right
technique, and headlight/taillight intensities are driven off the day/night term. None of it
survives to a wide shot: car paint culls at 405 m, so there is **not one vehicle visible** in
08, 09 or any skyline frame, and the city is permanently deserted in every image that shows
the whole of it. There are no pedestrians at any distance, including in shot 05 where a
downtown avenue at 13:00 has zero people on it. `history('traffic')` is still all zeros
(R-ui-4), which the HUD honestly renders as "not recorded yet".

### effects — 6.0
Doing least where it is needed most.

**No ambient occlusion anywhere in the project.** Nothing darkens where a building meets the
pavement, under a tree canopy, in a facade recess, or between packed blocks. This single
absence is most of why every frame reads as toy-like, and it is most visible in shot 05 where
buildings, trees and cars all sit on the road without contact.

**Bloom is effectively absent at night.** Shot 04 is specified at `bloom: 1.25` and its lit
windows are hard-edged bright squares with no halo at all. A night city is defined by the way
its lights bleed; these do not.

**The grade compresses everything into a narrow desaturated band.** At noon (03) the entire
city measures Y 88–135 with per-channel spread under ~12 units — that is very nearly
greyscale, with no black anywhere in frame and no white anywhere in the city. Facades that
should separate into concrete, brick and glass all land within 15 luminance units of each
other. R-fx-2 claimed the golden-hour wash was found and fixed; shot 01 says it was not.

Credit where due: the depth-of-field treatment is well judged and per-shot, the
aerial-perspective composite is convincing, and the one-pixel scanline of R-demo-4 is
genuinely gone.

### simulation — 7.5
No geometry, so judged through the HUD and the world it produces — and it is demonstrably
live and internally coherent, which is more than most city-builder prototypes manage. Across
11 and 12 the population moved 4,376 → 4,767, the balance $100K → $226K at +83.4K/mo, and the
date advanced to SAT 3 JAN. The inspector in 12 reports a specific building at a real street
address ("73 Granite Boulevard") with 1,471 of 1,740 jobs filled, land value 49 % and growth
pressure Industrial 98 %. Demand curves converge sensibly at R 76 / C 70 / I 100. That is a
real simulation feeding real UI, not a decorative counter. Held down by the traffic index
never recording (R-ui-4) and by R-tools-8 — `world.stats.budget` had two writers and the
ledger won within the same tick, so **building was silently free** in the composed city.

### tools — 7.0
Not directly photographable; judged from the tool UI and the request log. The two-level
hierarchy works correctly (ZONE → zone palette, SERVICE → service palette) with hotkeys and
proper active states, and the interaction model is sound. Marked down because the module ships
around a stack of unfinished core affordances that a player meets immediately: undo cannot
restore a segment with its identity intact (R-tools-2), a demolished building cannot be
restored with its own id (R-tools-4), and **terrain edits do nothing on screen at all**
because `terrain` has no write path and the LOD rings never rebuild (R-tools-5). A TERRAIN
button sitting in the main toolbar that visibly does nothing is a first-minute defect.

### audio — 7.0, provisional and explicitly not evidence-backed
I have to be straight about this one. This is a visual critique run through a screenshot
harness that passes `--mute-audio` in its Chrome flags. **I did not hear anything and I cannot
score the mix.** What I can verify is that the module is present, initialises clean in all
twelve shots (`initMs: 3`, state `ok`), is wired to time and weather events, and that its
builder verified it through an analyser rather than by listening (R-audio-5). I also note it
still has no volume control in the HUD (R-audio-2, open), which is a genuine product defect
regardless of how the mix sounds. The 7.0 is a placeholder, not a judgement; a real audio pass
needs someone with speakers.

### demo — 6.5
The composition logic is the cleverest code in the repository, and I want that on the record:
site analysis, a vantage search that stands the lens out over water and biases it anti-sun,
per-shot DOF and bloom multipliers, and a build pipeline that degrades gracefully around any
failed module. The plan it produces is believable. But a composer is judged on the frames it
actually delivers, and it makes two choices that cost it badly.

First, **the designated money shot is its weakest frame.** Skyline at 18:45 stands the camera
anti-sun, presenting the entire city shadow-side-on. The intent, per the comment in
`shots.js`, was that "the towers are rimmed" — they are not. There is no rim light, no sun
disc, no specular glint and no volumetric separation, so the measured sunlit-to-shadow ratio
across facades in that frame is **1.3–2.1 : 1** where a clear low sun demands 6–15 : 1. The
result is neither lit nor silhouetted; it is mud. Contre-jour without a rim is not drama, it
is flatness — and shot 02, the same camera at dawn, measures 3.5 : 1 and looks dramatically
better, which proves the point.

Second, every hero camera stands 420–780 m out, beyond every detail threshold the sibling
modules were built to. `demo` systematically photographs the city at the one distance where it
has least to show.

Its own `NightFill` hemisphere is also the direct cause of the inverted night described below.
R-demo-7 disclosed it honestly as a photographic necessity; it overshoots.

---

## 2. Whole-game score: 6.5

Squint at shot 08 and it is a city: the plan is believable, the density gradient is right, the
streets go where streets go. Look at any single frame for three seconds and it is a render —
because nothing casts a shadow, nothing occludes anything, the streets are dark at night while
the roofs glow, every facade is the same stamped grid, and every roof is empty.

6.5 is "good indie, pushing toward the top of it". The bones are better than the surface: the
world model, the road graph, the simulation and the UI are all at or near 7.5–8, and they are
being let down by three renderer-level absences (shadows, AO, night light) that are shared
across modules and not owned by any one of them. That is a fixable position, and I'd expect a
focused round on issues 1–4 alone to be worth a full point.

It is not 8.5, and it is a long way from being confusable with Cities: Skylines II.

---

## 3. Top 12 issues blocking 8.5

Ranked by how much each costs the illusion, not by difficulty.

**1 · The city casts no shadows at hero distance.**
*Owns:* buildings (primary) + environment. *Shot:* `08_aerial_1300`.
A noon aerial of a city with 180 m towers has not one shadow in frame. I measured the ground
on opposite sides of a tower base: **Y = 108.9 vs 106.6, a ratio of 1.02 : 1**. Two causes
compound: `castShadow` is gated to LOD tier 0 which ends at 260 m (`Chunks.js:182`), and the
fitted cascade at that orbit gives 1.46 m/texel with a 2.49 m normal bias.
*Fixed looks like:* towers throwing long raking shadows across streets and over each other at
noon and golden hour. Needs a shadow-only proxy that casts regardless of visual LOD, and a
cascade split keeping texel size under ~0.3 m out to 800 m.

**2 · The night city has no street-level light.**
*Owns:* props (primary) + traffic. *Shot:* `09_aerial_2200`.
In a night aerial the roofs measure **93× brighter than the streets**. That is exactly
inverted: in any real night city the road grid is the brightest thing in frame. Light-pool
gobos cull at 295 m, shop lights at 355 m, car paint at 405 m — the aerial camera sits
280–520 m up, so all three are gone.
*Fixed looks like:* the street network glowing as a web of lamp chains with headlight and
taillight trails running through it, brighter than any roof.

**3 · The night fill lights the wrong surfaces, at three different exposures.**
*Owns:* demo (`NightFill`) + effects (R-fx-5's two owners). *Shot:* `06_downtown_2200` against
`05_downtown_1300`, same camera.
Going from 13:00 to 22:00 the road drops **93×**, the trees **18×**, but the facades only
**4×**. An unlit concrete wall at 22:00 is only four times darker than the same wall at solar
noon. Foliage also keeps full daylight saturation — RGB(9, 30, 5), green still 3× red — when
night foliage should desaturate toward the cool of its fill.
*Fixed looks like:* one night exposure. Unlit facades sit near the road's level, not twenty
times above it, and foliage goes blue-grey rather than staying vivid green.

**4 · There is no ambient occlusion anywhere in the project.**
*Owns:* effects. *Shot:* `05_downtown_1300`.
Nothing darkens at a building-to-pavement junction, under a tree canopy, in a facade recess,
or between packed blocks. Everything appears pasted onto everything else, which is the single
largest contributor to the toy-like read across all twelve frames.
*Fixed looks like:* visible contact darkening at every ground junction and canopy underside;
buildings that sit in the scene rather than on it.

**5 · Facades are a stamped grid with no depth, and there is no glass.**
*Owns:* buildings. *Shot:* `01_skyline_1875` (2× crop).
Flat window squares printed on flat walls: no reveal, no mullion, no spandrel, no frame, no
reflection. Authored normal and ORM maps do nothing because nothing lights them directionally.
Every building in the city is the same facade system.
*Fixed looks like:* reveals and mullions that survive well past 260 m, and glass that carries a
sky gradient and a reflection so a curtain-wall tower reads as glass at 500 m.

**6 · Roofs are bare decks in the terrain's own colour.**
*Owns:* buildings. *Shots:* `01_skyline_1875` (crop), `08_aerial_1300`.
`roofClutter` is gated to `lod === 0`, so it disappears at 260 m — in the aerial and skyline
frames, where roofs are around 40 % of the visible city, all of them are empty. Their tan
matches the ground albedo so closely that at a glance the buildings read as open-topped boxes.
*Fixed looks like:* HVAC plant, tanks, stair huts and parapets at every tier, and roof
materials whose albedo is clearly separated from the terrain's.

**7 · The golden-hour money shot is backlit with nothing to back-light it.**
*Owns:* demo + environment + effects. *Shot:* `01_skyline_1875`.
The composer deliberately stands anti-sun for drama and then supplies no rim light, no sun
disc, no glare and no volumetric depth. Measured sunlit-to-shadow across facades:
**1.3–2.1 : 1**, against 6–15 : 1 for a clear low sun. The frame designated as the hero image
is the muddiest in the set, while shot 02 on the same camera at dawn reaches 3.5 : 1 and looks
far better.
*Fixed looks like:* either turn the camera to a three-quarter key, or earn the contre-jour —
hot rim on every tower edge, a sun disc with glare, and haze separating the depth planes.

**8 · Water reflects nothing and carries a visible seam.**
*Owns:* environment. *Shot:* `10_waterfront_1875`.
A waterfront at golden hour with no reflection of the buildings standing at its edge. There is
a hard geometry crease across the surface, the ripple field is blotchy low-frequency noise that
reads as moss, and at noon the water measures brighter than the sky.
*Fixed looks like:* the skyline mirrored and broken up in the river at golden hour; a
depth-graded colour ramp; no seam.

**9 · The grade is desaturated and contrast-dead.**
*Owns:* effects. *Shot:* `03_skyline_1300`.
The whole noon city sits in Y 88–135 with per-channel spread under 12 units — effectively
greyscale, no black in frame, no white in the city. Brick, concrete and glass all land within
15 luminance units of each other.
*Fixed looks like:* real blacks and real speculars in the same frame, with material hue
separation surviving the grade.

**10 · The zenith renders green whenever the sun is low.**
*Owns:* environment. *Shots:* `02_skyline_0650` — RGB(60, 77, 71); `01_skyline_1875` —
RGB(117, 136, 130). Green dominant in both.
*Fixed looks like:* orange → pink → violet → deep blue from horizon to zenith, with blue
dominant up top at both dawn and dusk.

**11 · No bridges: the city refuses to cross its own river.**
*Owns:* roads. *Shot:* `08_aerial_1300`.
R-demo-6 documents it exactly — `_computeElevation` lifts road profiles to the ground, which
over water is the river bed, so `demo` rejects every span that crosses the channel. A city sited
on an estuary that never spans it does not read as a city.
*Fixed looks like:* the `elevated: true` per-segment flag from R-demo-6, decks and piers, and at
least one bridge carrying an arterial across the estuary.

**12 · Roads don't cut the ground, and the map outside the city is empty.**
*Owns:* terrain. *Shots:* `07_residential_1300`, `08_aerial_1300`.
`flattenAlong` was accepted in integrator pass 1, restated in pass 4, and is still absent from
`src/terrain/` — so roads sit on graded shelves that meet rolling ground at unexplained
straight-line breaks. Beyond the built area the map is a single flat green to the horizon.
*Fixed looks like:* roads in proper cuttings and on embankments; slope- and altitude-based
material blending; some outlying land use so the region doesn't end where the city does.

### Just outside the top 12, and worth a line each
- **No signage, storefronts or ground-floor retail anywhere, at any hour.** A downtown avenue
  at 22:00 with no lit shop window and no illuminated sign is a large part of why the night
  reads as dead. Owns: buildings + props.
- **No pedestrians at any distance.** Owns: traffic.
- **One tree species across the whole map.** Owns: props.
- **A lane-surfacing decal painted onto the grass verge** in `07_residential_1300`, offset from
  the carriageway. Owns: roads.
- **No landmark of any kind** — nothing in the skyline or the plan that the eye can orient by.
  Owns: zoning + buildings.

---

## 4. What is genuinely good

A critic who only lists faults is not calibrated, so, specifically:

- **The road module is the standard the rest should meet.** Shot 05's carriageway — lane lines,
  hatched median, zebras, stop lines, kerb — is the one place in the game where I looked for a
  tell and did not immediately find one.
- **The city plan is believable.** Shot 08 shows a grid downtown decaying into curved
  residential streets and cul-de-sacs, with a correct density gradient from towers to
  low-rise and buildings addressing their frontages. Most procedural cities fail this and
  this one does not.
- **The UI is close to shippable.** The statistics panel in shot 12 — four KPI tiles, six
  time-series with legends and real values, an income/expense split — is real design work. The
  building inspector reporting a specific tower at a real street address with jobs filled
  1,471 of 1,740 is the kind of detail that makes a world feel simulated. The honest empty
  state on the traffic chart ("not recorded yet") rather than a fake flat line is a mark of
  genuine care.
- **The simulation is actually running.** Population, balance, date and demand all move
  coherently between shots 11 and 12. It is not a decorative counter.
- **Aerial perspective is the best-executed effect in the project.** The depth read across
  shots 03 and 08 is convincing and does a lot of work.
- **Building massing is good even though the surface is not.** Setbacks, crowns and masts give
  a varied silhouette, and keeping crowns alive into LOD 1 — with a comment explaining that a
  skyline is judged from 500 m — is exactly the right instinct. It just needs applying to
  every other detail class.
- **Dawn proves the lighting can work.** Shot 02 has real warm/cool facade separation and real
  material colour. The renderer is capable of the thing the golden-hour shot fails to do.
- **The engineering discipline held.** Thirteen modules, `state: ok` in all twelve of my runs,
  no failure isolation triggered, deterministic world hash, and a request log that attributes
  cross-module defects honestly rather than hiding them. R-fx-1 tracking the scanline down to
  a half-texel error in its own half-res pass is exemplary.

---

## 5. Technical gate — my own twelve runs

| shot | fps | draw calls | tris (M) | textures | programs | console errors | failed modules |
|---|---|---|---|---|---|---|---|
| 01_skyline_1875 | 10 | 361 | 3.70 | 108 | 72 | 0 | none |
| 02_skyline_0650 | 10 | 361 | 3.69 | 108 | 72 | 0 | none |
| 03_skyline_1300 | 10 | 360 | 3.70 | 107 | 71 | 0 | none |
| 04_skyline_2200 | 10 | 361 | 3.69 | 108 | 72 | 0 | none |
| 05_downtown_1300 | 10 | 393 | 4.77 | 104 | 69 | 0 | none |
| 06_downtown_2200 | 10 | 375 | 4.69 | 105 | 70 | 0 | none |
| 07_residential_1300 | 10 | 419 | 4.05 | 107 | 71 | 0 | none |
| 08_aerial_1300 | 10 | 382 | 3.93 | 107 | 69 | 0 | none |
| 09_aerial_2200 | 10 | 383 | 3.92 | 108 | 70 | 0 | none |
| 10_waterfront_1875 | 10 | 385 | 4.13 | 108 | 72 | 0 | none |
| 11_ui_default | 10 | 361 | 3.71 | 107 | 72 | 0 | none |
| 12_ui_panels | 10 | 382 | 3.93 | 107 | 69 | 0 | none |

- **Draw calls: max 419 against a budget of 1500 — PASS**, at 28 % of budget. There is a great
  deal of headroom here, and issues 1, 2, 5 and 6 all want spending some of it. The budget is
  not what is holding this game back.
- **Console errors: 0 across all twelve shots — PASS.** No module entered `FAILED` state in any
  run; all thirteen reported `ok` every time.
- **fps: not assessable.** All twelve report 10 fps under SwiftShader software WebGL2 on a
  2-CPU box with no GPU. `docs/STATUS.json` correctly records `fpsMeaningful: false` and the
  harness does not gate on it. I am not claiming the 50 fps target is met and I am not claiming
  it is missed — **it is unverified**, and it will stay unverified until someone runs this on
  real hardware. That is an open risk, not a pass.

**Gate result: the technical gate passes on both criteria it can actually measure.** The
failure is entirely artistic.

---

## 6. The blind A/B against real Cities: Skylines II screenshots — not run, and why

The build order calls for a final blind A/B against genuine CS2 screenshots. **I could not run
it, and I did not fake it.**

This sandbox's egress proxy blocks image sources; `ARCHITECTURE.md` §7 already records the same
constraint for Poly Haven and ambientCG, and it applies equally to any source of a real game
screenshot. I could not fetch one. The only ways to produce an "A/B" under those conditions
would be to generate an image and label it as CS2, or to describe a reference from memory and
present the comparison as though it had been side-by-side. Both would make the result worse
than useless, because the entire value of a blind A/B is that the comparison is against
something real and that the judge does not know which is which. A fabricated reference would
launder my own expectations into evidence.

**What the A/B would have tested.** Shuffled pairs at matched framings — golden-hour skyline,
noon aerial, night street, waterfront — shown one at a time, with the judge asked to say which
image is the shipped game, and to name the feature that gave it away. What matters is not the
hit rate but the *reasons*: an A/B is a machine for surfacing tells you have gone blind to. It
would also have caught grade and colour-response differences, which are the hardest things to
judge in isolation because the eye adapts to whatever it has been looking at.

**What I did instead, and its status.** Everything above is a from-memory comparison against my
own knowledge of what CS2 screenshots look like, plus direct measurement of the frames in front
of me. The measurements are solid — a 1.02 : 1 ratio either side of a tower is a fact about the
image, not an opinion. The CS2 comparison is not: it is one critic's recollection, unblinded,
and it should be weighted accordingly. Where I have said "a real city night aerial has bright
streets and dark roofs", that is a claim about photography and about that game which I believe
firmly and cannot demonstrate here.

**Recommendation.** Do not treat this document as having cleared the A/B gate. When this
project runs somewhere with open egress, run the A/B properly before declaring the art done —
and run it against the fixed build, because the issues in §3 are exactly the ones a blind judge
would name first.

---

*Round 1. Twelve shots, all taken by the critic. No module passes. Whole game 6.5 / 10.*

---
---

# Round 2

**Verdict: 7.5 / 10, up from 6.5. Still does not pass.** Pass mark is 8.5.

Twelve frames re-shot at the same variants, hours and size as round 1, one at a time, in
`docs/shots/critic/r2/`. Round 1's frames are untouched in `docs/shots/critic/` so every
comparison below is against a file still on disk.

This was a good round. Three renderer-level absences that defined round 1 — no cast shadows,
no ambient occlusion, no night street lighting — are genuinely gone, and I verified each
independently rather than taking the fix log's word for it. The hero frame went from the worst
image in the set to one of the best. The game is a point better and it earned it.

It also did not reach 8.5, and the reason is worth stating up front: **fixing the renderer
exposed the content.** Round 1's frames were let down by light. Round 2's are let down by the
fact that the city has no ground floor — no shopfronts, no signage, no entrances, almost no
people — and by wide compositions that got worse while the lighting in them got better.

### A note on `--chrome=1`

The flag does not exist. `tools/shoot.mjs` neither parses `a.chrome` nor forwards a `chrome`
query param, so `--chrome=1` is silently ignored. It did not matter: `src/main.js:76` hides the
HUD for any showcase whose name is not `ui`, so `--module=demo` drops the chrome and
`--module=ui` keeps it, which is exactly the split that was wanted. All twelve shots are
correctly chromed. Worth plumbing the flag anyway before someone relies on it.

---

## 1. Adjudicating the disputed round-1 measurements

Three builders could not reproduce numbers I quoted. They were right to say so, and in two of
three cases they were right on the merits. Taking them in turn.

### 1.1 The 1.02 : 1 tower-shadow baseline — **I accept `buildings`' objection in full**

R-bldg-5 says the "ground either side of a tower base" geometry no longer exists: at 13:00 the
sun is 60.9° up, a 214 m tower throws 119 m, the CBD is now wall-to-wall, and of 292 buildings
exactly one still has clear ground on both sides. That is correct, it is a consequence of
fixing the frontage-fill finding, and it makes my estimator unrepeatable through no fault of
theirs. My round-1 method was also, fairly, unreproducible in principle — it depended on me
picking two patches by eye and I published no coordinates.

**Replacement estimator, and it is reproducible.** Classify pixels of *one material* by hue
inside a region, then report the luminance spread across that material in linear light. Because
albedo is held constant, the spread is the lighting ratio: p90 is lit, p10 is shadowed. No
hand-picked patches, no dependence on any particular building's surroundings.

```
grass pixels := G > R+4 and G > B+4      # vegetation only
ratio        := linear_p90 / linear_p10  # sRGB decoded properly, not gamma 2.2
```

Applied to the residential quadrant of the noon aerial, region `(60,420,500,260)`, on both
rounds' files:

| | round 1 `08_aerial_1300` | round 2 `08_aerial_1300` |
|---|---|---|
| grass pixels sampled | 32,168 | 57,318 |
| sRGB p10 → p90 | 93.1 → 128.1 | **38.3 → 121.5** |
| **linear p90/p10** | **1.95 : 1** | **9.51 : 1** |

Round 1's 1.95 : 1 on a single material at solar noon is what "no shadows" looks like. Round
2's 9.51 : 1 is a physically plausible sun-to-shade ratio. **The finding was right and the fix
is real**, and this measurement will survive the next round's city changing shape, which is
what I owed them.

### 1.2 The 93 : 1 night roof:street — **my magnitude was unreliable; the sign was the point**

`props` measured roof:street as 3.7 : 1 → 1.2 : 1 using the mean linear luminance of seven
fixed carriageway boxes. I measured 93 : 1 from a single 30×14 road patch at Y = 9.9. At that
level a road pixel sits on the sRGB quantisation floor, where decoding amplifies a ±2
code-value error into roughly ±50 % of the linear result — so **my ratio's magnitude was not
trustworthy and I should not have quoted it to two significant figures.** Their multi-box mean
is the better instrument and I adopt it.

What my number got right, and what actually mattered, was the *sign*: roofs brighter than
streets is an inversion of how a night city works, and both estimators agree on that and on its
removal. Re-measured this round over three road and three roof boxes on `09_aerial_2200`:
streets are now **8.1× brighter than roofs** (roof:street 0.12 : 1). `props` quotes the more
conservative 1.2 : 1. Quote theirs; the conclusion is the same either way and theirs is the
sounder method.

### 1.3 `demo`'s key-ratio estimator — **I keep mine, and here are the coordinates**

R-demo-9 uses "mean of the brightest 15 % of an all-city rect ÷ mean of the darkest 15 %". That
conflates albedo with lighting: a white tower next to a brown one moves it without a photon
changing. Mine compares two faces *of the same building*, holding albedo constant, which is
what "key-to-fill" means. I hold to it — but the fair half of their complaint was that I never
published coordinates, so:

`01_skyline_1875`, glass tower, round 2 file: shadow face `(768,170,24,130)`, lit face
`(812,170,30,130)`. Round 2 dawn `02_skyline_0650`, one block: `(672,430,20,60)` lit and
`(700,430,26,60)` shadowed. Decode sRGB properly and take the linear ratio.

Their metric is not wrong, it answers a different question, and both agree the frame improved.

---

## 2. Per-module scores, with deltas

| module | round 1 | **round 2** | Δ | their self-score | pass ≥8.5 |
|---|---|---|---|---|---|
| ui | 8.0 | **8.0** | 0 | — | FAIL (closest) |
| buildings | 6.0 | **7.5** | **+1.5** | 7.0 — I am *above* | FAIL |
| effects | 6.0 | **7.5** | **+1.5** | 7.5 — agree | FAIL |
| environment | 6.5 | **7.5** | **+1.0** | 7.5 — agree | FAIL |
| demo | 6.5 | **7.5** | **+1.0** | — | FAIL |
| roads | 7.5 | **7.5** | 0 | — | FAIL |
| simulation | 7.5 | **7.5** | 0 | — | FAIL |
| props | 7.0 | **7.5** | +0.5 | 7.8 — I am *below* | FAIL |
| traffic | 7.0 | **7.5** | +0.5 | — | FAIL |
| terrain | 6.0 | **7.0** | **+1.0** | — | FAIL |
| zoning | 7.0 | **7.0** | 0 | — | FAIL |
| tools | 7.0 | **7.0** | 0 | — | FAIL |
| audio | 7.0 | **7.0** *(still provisional)* | 0 | — | unverifiable |
| **whole game** | **6.5** | **7.5** | **+1.0** | — | **FAIL** |

Nothing passes. The spread has collapsed — round 1 ran 6.0–8.0, round 2 runs 7.0–8.0 — which
means the weakest modules were correctly identified and lifted, and what remains is a broad,
even shortfall rather than three broken things.

### buildings — 6.0 → 7.5 (+1.5). Self-scored 7.0; **I am half a point above them**
The largest single improvement in the project, and they undersold it. LOD 0 to 820 m with
`castShadow` at every tier is what made every other module's lighting work visible, so a share
of `environment`'s and `effects`' gains are really theirs. Verified directly: the roof deck on
`01_skyline_1875` went from RGB(112, 82, 60) — a tan that matched the terrain so exactly that
round 1 read the roofs as open holes — to **RGB(81, 75, 72)**, a neutral dark membrane with a
parapet ring and visible plant. At 2× the tower facades now show real reveal depth and a lit
edge per window frame instead of round 1's flat stamped squares. The skyline hierarchy is
properly resolved at 214 m with four buildings over 180 m. Held at 7.5 by the thing that is
now the game's biggest tell: **every building meets the pavement with a blank wall.** No
shopfronts, no entrances, no awnings, no signage, no ground-floor glazing anywhere in the city
at any hour. Also, per R-fx-7, the vertex-colour AO bake now double-counts with GTAO at exactly
the junctions GTAO covers.

### effects — 6.0 → 7.5 (+1.5). Self-scored 7.5; **agree exactly**
GTAO is real and I confirmed it by eye rather than by their numbers: on `05_downtown_1300` at
2× there is dappled tree-shadow on the pavement, a tight contact shadow under every car, base
darkening on the lamp columns and tree trunks, and a shadow seam along the kerb. Round 1 had
none of it. The grade is now genuinely additive at golden hour — on `01_skyline_1875` with sky
masked, `relSat` **0.275 → 0.525**, near doubling, with 11.0 % of the city below Y = 16, so the
frame has real blacks for the first time. The honesty of R-fx-7 — reporting that the round-2
pass was disabled by its own bias and had been occluding only tree canopies — is exactly the
standard this project should hold. Held at 7.5 because the benefit is confined to the low-sun
frames: at noon the grade did not help (see §4) and the AO is half-res and visibly soft.

### environment — 6.5 → 7.5 (+1.0). Self-scored 7.5; **agree exactly**
Both headline defects fixed, both verified independently. The green zenith is gone: dawn
**(60, 77, 71) G-dominant → (24, 70, 101) B-dominant**, dusk **(117, 136, 130) → (38, 86, 115)**.
That is a correct sky at last, and the clouds that come with it have real volume and warm
underlighting at dawn and golden hour. CSM shipped and shadows now reach every camera. Water
improved materially — a real sun path with directional glitter on `02` and `10`, which round 1
did not have at all. Held at 7.5 by three things it names itself: shadows at aerial orbit are
still 0.92 m/texel with 1.57 m of normal bias, so they are soft blobs and no contact shadow
survives; aerial perspective at noon is heavy enough to wash the whole city (R-env-10, open);
and the water still does not reflect the city, and still carries the seam.

### demo — 6.5 → 7.5 (+1.0)
It took the money-shot call and it worked. On the identical frame and estimator, key-to-fill on
paired faces of one tower went **1.7 : 1 → 4.31 : 1**, and dawn went **3.5 : 1 → 6.03 : 1**,
which is squarely in the physical range for a clear low sun. `01_skyline_1875` is no longer the
worst frame in the set; `02_skyline_0650` is now the best. Held at 7.5 because the trade it
made is worse than R-demo-9 allows (see §6): the golden hour lost its river foreground to a
sliver, and the aerial re-frame pulled so far back that the city is a small object adrift in a
large, low-detail landscape.

### terrain — 6.0 → 7.0 (+1.0)
The "diorama on a table" complaint is largely answered: `08_aerial_1300` now has real mountains
with relief, a believable river course through a valley, altitude-banded green-to-ochre
material, and — the important part — outlying roads, scattered settlements and a road network
that leaves the frame. The map no longer ends where the city does. Held at 7.0 because
`flattenAlong` (R-6, accepted in pass 1, restated in pass 4) is **still not in the tree**, so
roads still sit on graded shelves meeting rolling ground at a straight break, plainly visible
at the left of `07_residential_1300`; because there is still no rock, no forest mass and no
field pattern; and because the new grass/soil blend is a poor texture — at street range it is
pink-magenta blotches on green at a single scale (see §6).

### props — 7.0 → 7.5 (+0.5). Self-scored 7.8; **I am 0.3 below them**
Moving the whole lighting ladder past the cameras for **zero** extra draw calls, because their
LOD is a vertex-shader collapse rather than a mesh swap, is the most elegant fix of the round,
and R-props-5 deserves to be read by every other module. Foliage now has four real greens and
reads much better. I am below their 7.8 for one reason: the fix overshot. At aerial distance
the pools have become over-wide, over-bright scalloped ribbons that swallow the carriageway,
spill well past the kerb onto grass, and leave every house, tree and car standing inside a
near-white pool completely unlit. R-props-6 states this honestly as a known limitation of a
gobo; it is now the most visible night artefact in the game, which is a smaller sin than round
1's total darkness but a real one.

### traffic — 7.0 → 7.5 (+0.5)
Vehicles now survive to 950 m so the city is populated in every wide frame, and headlights and
taillights read correctly at night. Pedestrians exist — I found one on the verge in
`05_downtown_1300` at 2× — but they are so sparse and so crude that a downtown avenue at 13:00
still reads as deserted. Car models remain very simple at close range: smooth blobs without
resolved wheels, glazing or mirrors. `history('traffic')` is *still* all zeros; the HUD still
renders "not recorded yet" (R-ui-4, unfixed).

### roads — 7.5 → 7.5 (0)
No round taken, none really needed. The stray lane-surfacing decal on the grass verge that I
filed in round 1 **is fixed** — verified at 2× on `07_residential_1300`, the chevrons are gone.
Everything else stands: the best geometry in the project, and still no bridges (R-demo-6 open),
still a factory-clean surface with no wear, patching or staining.

### zoning — 7.0 → 7.0 (0) · tools — 7.0 → 7.0 (0) · simulation — 7.5 → 7.5 (0)
Unchanged and not re-exercised by this shot set. Zoning's land-use vocabulary is still thin —
no parks, plazas, civic buildings, parking or landmarks anywhere in `08_aerial_1300`. Tools
still has no terrain write path (R-tools-5), so the TERRAIN button in the main toolbar still
does nothing visible. Simulation's numbers remain coherent and alive across `11`/`12`
(population 4,893, +$110K/mo, jobs 1,385 of 1,721 on a named building).

### ui — 8.0 → 8.0 (0)
Design unchanged; still the strongest module and still the only one within reach. The building
inspector correctly picked up the taller skyline (184.2 m, 44 floors). Everything holding it
below 8.5 in round 1 is untouched: **no minimap**, the OVERLAYS cluster is still four unlabeled
icons floating unanchored, the RCI bars are still ~12 px and unreadable, the two panels still
do not share a baseline grid, and the traffic chart still honestly reports no data.

### audio — 7.0 → 7.0, still provisional and still not evidence-backed
Unchanged from round 1 and for the same reason: the harness runs `--mute-audio`. I have not
heard this game. The score is a placeholder, not a judgement, and it should not be counted
toward any gate until somebody listens to it.

---

## 3. Whole game: 6.5 → 7.5

Round 1's summary was "squint and it is a city; look for three seconds and it is a render,
because nothing casts a shadow, nothing occludes anything, and the streets are dark at night
while the roofs glow." All three of those are now false. `02_skyline_0650` and
`01_skyline_1875` are frames I would accept as game marketing at thumbnail size, which was not
remotely true of anything in round 1.

7.5 is "the top of good indie, with AAA lighting". What separates it from 8.5 is no longer
renderer physics — it is **inhabitation and composition**. The city is correctly lit, correctly
shadowed and correctly graded, and it is still a place where no shop has a front, no building
has a door, no street has a crowd, no river has a bridge and no district has a landmark. Those
are content problems, and content problems are what is left when the rendering is right.

The other point off is composition: two of the four wide frames got worse this round even as
their lighting got better, which is a real cost and is discussed in §6.

---

## 4. Re-ranked: what still blocks 8.5

Ordered by damage to the illusion.

**1 · The city has no ground floor.**
*Owns:* buildings (primary), props, traffic. *Shots:* `05_downtown_1300`, `06_downtown_2200`.
Every building in the city meets the pavement with a blank wall. No shopfronts, no glazed
retail, no doors, no entrance canopies, no awnings, no signage, no illuminated fascias — at any
hour. Pedestrians exist but number in the single digits and are featureless dark blobs. This is
now the largest tell by a clear margin: the lighting work removed the giveaways that used to
mask it, and what is exposed is that nobody lives here.
*Fixed looks like:* a continuous active frontage — glazed ground floors with interiors visible,
signage and fascia lighting that reads at night, doors people could walk through, and enough
pedestrians that a 13:00 avenue is not empty.

**2 · Street lighting is glowing paint.**
*Owns:* props, and core (needs the clustered light pass R-props-6 asks for). *Shot:*
`09_aerial_2200`, crop at `(60,300,260,170)`.
The gobo lights the ground and nothing else. Houses, trees and cars standing inside a
near-white pool are dark; the pools are far wider than the carriageway and spill onto grass;
they scallop into visible overlapping ellipses instead of an evenly lit street; and no lamp
head emits a visible glow. It is not clipping (0.17 % of the frame above Y = 240, nothing at
255) — it is over-bright and detail-free, so the road inside a pool shows no markings, texture
or falloff.
*Fixed looks like:* real point lights — a clustered/tiled forward pass — so a car in a pool is
lit, the kerb wraps, canopies shade the road beneath them, and pool width matches the street.

**3 · The wide compositions regressed while their lighting improved.**
*Owns:* demo. *Shots:* `01_skyline_1875`, `08_aerial_1300`. See §6.
*Fixed looks like:* the three-quarter key *and* a foreground — water, a ridge, a park, rooftops
— with the city filling the frame it is the subject of.

**4 · Shadows are soft blobs with no contact.**
*Owns:* environment. *Shot:* `08_aerial_1300`.
Their own in-page measurement at aerial orbit: ortho 1892 m over 2048 texels = **0.92 m/texel**,
`normalBias` **1.57 m**. Shadows exist everywhere now, which is the win, but nothing smaller
than a building casts one that survives — tree dapple is a diffuse smear, and window reveals,
parapets and balconies contribute nothing. R-bldg-5 asks for a per-cascade bias and a split
holding texel under ~0.3 m out to 800 m; that is the right ask.
*Fixed looks like:* a tree throwing recognisable leaf shadows, and a parapet throwing a crisp
line onto its own roof.

**5 · The noon frames are still washed, and it is aerial perspective now, not the grade.**
*Owns:* environment (R-env-10, open). *Shot:* `03_skyline_1300`.
With sky masked, `relSat` on this frame went **0.131 → 0.113**, i.e. *down*. The whole noon
skyline is a pale grey-white, the mid-ground towers are already heavily hazed, and the hills
are nearly white. Note this is the one frame where my measurement disagrees with the builder's
in direction — R-fx-8 reports 0.096 → 0.119 for the same frame. Our sky masks differ; my
round-1 `relSat` for frame 05 matched theirs to three decimals (0.317), so the metric agrees
and the masking does not. The visual read is unambiguous and I hold to mine.
*Fixed looks like:* per-pixel view-direction fog with a real extinction curve, so distance
desaturates the far hills without bleaching the near city.

**6 · Water reflects nothing, and the seam is still there.**
*Owns:* environment / terrain / effects. *Shot:* `10_waterfront_1875`, crop `(60,500,420,130)`.
SSR is a real gain — there is a genuine sun path and directional glitter now — but a
golden-hour waterfront still shows no mirrored city, and **the hard diagonal geometry crease
across the water surface is unchanged from round 1.** That one is a straightforward bug and it
survived the round untouched.
*Fixed looks like:* the lit skyline inverted and broken up in the water; no crease.

**7 · No bridges — the city still refuses to cross its own river.**
*Owns:* roads (R-demo-6, `elevated` flag never shipped). *Shot:* `08_aerial_1300`.

**8 · Terrain has no macro detail, and roads still do not cut it.**
*Owns:* terrain. *Shots:* `07_residential_1300`, `08_aerial_1300`.
`flattenAlong` remains absent three passes after it was accepted. No rock, no forest, no field
pattern — which now matters more, because the aerial re-frame gives this terrain most of the
frame to carry.

**9 · No landmarks, parks, plazas or civic buildings.**
*Owns:* zoning + buildings. *Shot:* `08_aerial_1300`. Nothing in the plan or the skyline for
the eye to orient by; every block is the same use.

**10 · One facade system per building, and no material ageing.**
*Owns:* buildings. Reveals are real now, but each building is still a single uniform grid, and
nothing in the city is dirty, stained, patched or weathered — roads included.

**11 · Vehicles and pedestrians are crude close up.**
*Owns:* traffic. *Shot:* `05_downtown_1300` at 2×. Cars are smooth blobs without resolved
wheels or glazing; the one pedestrian I found is a featureless dark shape.

**12 · UI: no minimap, and the traffic history still records nothing.**
*Owns:* ui + traffic (R-ui-4, open across two rounds). *Shot:* `12_ui_panels`.

---

## 5. What genuinely improved — named precisely

- **The green sky is gone.** Dawn zenith (60,77,71) → **(24,70,101)**; dusk (117,136,130) →
  **(38,86,115)**. Both now blue-dominant, both verified on my own frames. `environment`
  root-caused it to three's Sky `sunfade` term rather than guessing.
- **Shadows exist at every camera.** Grass shadow depth at noon, one material, albedo held
  constant: **1.95 : 1 → 9.51 : 1**.
- **AO is real and selective.** Dappled tree shade on pavement, contact shadows under cars,
  base darkening on lamp columns and trunks — all visible at 2× on `05_downtown_1300`, none of
  it present in round 1.
- **The night city has streets.** Roof:street inverted from roofs-brighter to **streets ~8×
  brighter**, and the road network is now the brightest thing in a night aerial, which is how a
  night city actually looks.
- **The three night exposures converged.** Round 1's hard surfaces spanned 4×–93× day-to-night
  (23× apart); round 2's span **5.5×–8.2× (1.5× apart)**. Foliage now correctly goes darker
  (27×) instead of keeping daylight saturation.
- **The money shot works.** Key-to-fill on paired faces of one tower **1.7 : 1 → 4.31 : 1** at
  golden hour and **3.5 : 1 → 6.03 : 1** at dawn; `relSat` on the golden frame **0.275 →
  0.525**. `01_skyline_1875` went from the worst frame in the set to a good one, and
  `02_skyline_0650` is now genuinely strong.
- **Roofs are roofs.** Deck albedo RGB(112,82,60) → **(81,75,72)**, with parapet rings and
  plant, at every LOD tier. The round-1 "every building is an open box" read is gone.
- **The map no longer ends at the city.** Outlying roads, hill settlements and a real river
  course in `08_aerial_1300`.
- **The stray verge decal is fixed** — verified at 2×.
- **Zero draw calls for the night-lighting fix**, because props' LOD is a shader term. R-props-5
  is the most reusable finding of the round.
- **Two builders corrected themselves on the record** — R-bldg-6 retracting the `MAX_TOWER_H`
  diagnosis as noise, and R-fx-7 reporting that its own round-2 AO had been doing nothing. That
  is worth more to this project than either fix.

---

## 6. Regressions — looked for deliberately, and there are four

**R1 · The golden-hour hero lost its foreground.** `demo` acknowledges the trade in R-demo-9
and I think it under-weights it. Round 1's `01_skyline_1875` had a river across the whole
bottom of the frame; round 2's has a pale sliver in the bottom-left corner and the city running
off the bottom edge into cropped rooftops. The lighting gain is much larger than the
composition loss, so this is net strongly positive — but "the sun term at weight 2.6 outvotes
foreground water at 2.0" is a rule that has cost the frame its base, and the answer is not to
pick one but to find a stand-point with both.

**R2 · The aerial re-frame left the city too small for its landscape.** Round 1's
`08_aerial_1300` filled the frame with city. Round 2's gives it roughly a third, with the rest
low-detail hills and empty ochre ground. The terrain improved this round, but not nearly enough
to carry two-thirds of a frame, so the composed image is weaker even though every element in it
is better. This one is a straight regression with no compensating gain.

**R3 · Night light pools overshot into glowing paint.** Round 1's defect was that street
lighting was absent past 295 m. Round 2's is that it is present, over-wide, over-bright and
scalloped, spilling onto grass and lighting nothing that stands in it. Much better than
darkness; a new visible artefact all the same, and the most conspicuous thing in
`09_aerial_2200`.

**R4 · The noon skyline got flatter, not less flat.** `relSat` on `03_skyline_1300` fell
0.131 → 0.113. Round 1's complaint about that frame was "desaturated and contrast-dead"; the
tonal band did widen (174.3 → 187.9), but the colour went the wrong way. Every other frame
improved on both axes, so this is specific to the heavy-haze noon case.

**Watch item, not yet a regression.** On `01_skyline_1875` the share of the city below Y = 16
rose 1.77 % → **11.03 %** while the tonal band narrowed 187.2 → 161.5. Deep shadow is correct
for a keyed golden-hour frame and the tower shadow faces still hold window detail when I zoom,
so I am not calling it crush — but if contrast is pushed again next round, that is where it
will break first.

**Minor new blemish.** The grass/soil blend that replaced the fixed decal reads at street range
as pink-magenta blotches on green, at a single scale, tiling visibly
(`07_residential_1300`, crop `(250,560,280,150)`). Smaller than what it replaced, but it is the
nearest texture to camera in that frame.

---

## 7. Technical gate — my own twelve runs

| shot | fps | draw calls | tris (M) | textures | programs | console errors | failed modules |
|---|---|---|---|---|---|---|---|
| 01_skyline_1875 | 10 | 938 | 9.21 | 113 | 69 | 0 | none |
| 02_skyline_0650 | 10 | 913 | 9.23 | 113 | 71 | 0 | none |
| 03_skyline_1300 | 10 | 870 | 9.14 | 112 | 68 | 0 | none |
| 04_skyline_2200 | 10 | 910 | 9.13 | 113 | 69 | 0 | none |
| 05_downtown_1300 | 10 | 587 | 8.74 | 111 | 67 | 0 | none |
| 06_downtown_2200 | 10 | 680 | 8.99 | 112 | 68 | 0 | none |
| 07_residential_1300 | 10 | 635 | 7.88 | 111 | 67 | 0 | none |
| 08_aerial_1300 | 10 | 947 | 8.90 | 112 | 70 | 0 | none |
| 09_aerial_2200 | 10 | **967** | 9.01 | 113 | 71 | 0 | none |
| 10_waterfront_1875 | 10 | 818 | 9.06 | 113 | 69 | 0 | none |
| 11_ui_default | 10 | 871 | 9.16 | 112 | 69 | 0 | none |
| 12_ui_panels | 10 | 947 | 8.90 | 112 | 70 | 0 | none |

- **Draw calls: 587–967, max 967 of 1500 — PASS**, at 64 % of budget, up from 28 %. Note the
  worst frame is **967, not the 938** R-demo-11 predicted; the night aerial is the peak, not the
  golden skyline.
- **Console errors: 0 across all twelve — PASS.** No module left `state: ok` in any run.
- **Triangles roughly doubled**, 3.7–4.8 M → 7.9–9.2 M, which is the LOD-0 extension being paid
  for honestly.
- **fps: still not assessable** under SwiftShader on a 2-CPU box. Unverified, not passed.

**Was the budget bought well?** Yes, and it is the clearest yes in this review. Roughly 550
draw calls purchased cast shadows at every distance, real AO, a correct sky and a night city
with lit streets — the four things that moved the score a full point. There is still 36 % of
the budget unspent, and issues 1, 2 and 4 all want some of it. The one line item I would query
is R-props-7's admission that **42 of 93 prop meshes cast full-resolution shadows across the
whole city with no distance term** — a tree collapsed to a point in the beauty pass still casts
at 1.4 km. That is waste, not value, and it is the obvious place to find headroom for the
clustered light pass that issue 2 needs.

---

## 8. The blind A/B — still not run, same reason

Unchanged from round 1 and worth repeating rather than quietly dropping: the egress proxy
blocks image sources, no genuine Cities: Skylines II screenshot can be fetched here, and
fabricating one would launder my expectations into evidence. Everything above remains a
from-memory comparison plus direct measurement of the frames in front of me. The measurements
are facts about the images; the CS2 comparisons are one critic's recollection, unblinded.

This matters more now than it did at 6.5. At 7.5 the remaining gap is in inhabitation,
composition and material ageing — exactly the qualities a side-by-side surfaces best and a
from-memory judgement serves worst. **Run the A/B before declaring the art done.**

---

*Round 2. Twelve frames, all re-shot by the critic. Nothing passes. Whole game 6.5 → 7.5.
Four regressions found, one of them uncompensated. Technical gate passes on both measurable
criteria at 64 % of the draw-call budget.*

---
---

# Round 3

**Verdict: 8.0 / 10, up from 7.5. Still does not pass, and it is now close.** Pass mark 8.5.

Twelve frames re-shot at the same variants and hours, in `docs/shots/critic/r3/`. Rounds 1 and
2 are untouched on disk, so every trajectory below is measurable against files anyone can open.
`--chrome=1` genuinely works now and was used for the two `ui` frames only.

Four of these twelve — golden hour, dawn, night skyline, waterfront — are frames I would accept
as marketing stills for a shipping game. That was true of none in round 1 and one in round 2.

---

## 0. Method note: I replaced my own estimator, and I was the problem

Two rounds running, builders could not reproduce my key-to-fill numbers, and this round I
found out why in my own data. My paired-face method needs two faces of one building picked by
eye; the faces are narrow, they move when the city changes, and on my first attempt at the
round-3 hero I straddled a boundary and measured **1.21 : 1** on a frame that is obviously
strongly keyed. Re-placed correctly on the same frame it gives **2.16 : 1** on the front glass
tower and **6.60 : 1** on the stone one behind it. The estimator was not measuring the frame,
it was measuring my patch placement.

So the headline number is now population-level and rule-based: select facade pixels in a fixed
region (exclude sky as blue-dominant-and-bright, exclude vegetation as green-dominant), report
the linear-light p90/p10 and the brightness-invariant `relSat`. Same rule, same region, applied
to all three rounds' files. Script logic is in §6 of this round's notes and is ten lines.

**Golden-hour hero, region `(100,320,1080,240)`, identical rule:**

| | round 1 | round 2 | round 3 |
|---|---|---|---|
| facade p90/p10 (linear) | 7.43 : 1 | 24.47 : 1 | **38.84 : 1** |
| relSat | 0.418 | 0.441 | **0.576** |

That is the trajectory, and it is monotonic. `demo` measures the same frame 4.51 → 9.63 on its
own estimator; different instrument, same direction, both large. I no longer claim mine is the
better one — it answers a narrower question and it is far more fragile than I admitted.

---

## 1. Per-module scores, with deltas

| module | R1 | R2 | **R3** | Δ | their self-score | pass ≥8.5 |
|---|---|---|---|---|---|---|
| terrain | 6.0 | 7.0 | **8.0** | **+1.0** | — | FAIL |
| buildings | 6.0 | 7.5 | **8.0** | +0.5 | — | FAIL |
| props | 7.0 | 7.5 | **8.0** | +0.5 | — | FAIL |
| traffic | 7.0 | 7.5 | **8.0** | +0.5 | — | FAIL |
| demo | 6.5 | 7.5 | **8.0** | +0.5 | — | FAIL |
| ui | 8.0 | 8.0 | **8.0** | 0 | — | FAIL |
| environment | 6.5 | 7.5 | **7.5** | **0** | — | FAIL |
| effects | 6.0 | 7.5 | **7.5** | 0 | — | FAIL |
| simulation | 7.5 | 7.5 | **7.5** | 0 | — | FAIL |
| zoning | 7.0 | 7.0 | **7.5** | +0.5 | — | FAIL |
| tools | 7.0 | 7.0 | **7.5** | +0.5 *(documentary)* | — | FAIL |
| audio | 7.0 | 7.0 | **7.0** *(still provisional)* | 0 | — | unverifiable |
| **roads** | 7.5 | 7.5 | **7.0** | **−0.5** | — | FAIL |
| **whole game** | **6.5** | **7.5** | **8.0** | **+0.5** | — | **FAIL** |

Six modules now sit at 8.0. One went backwards.

### terrain — 7.0 → 8.0 (+1.0). Biggest gain of the round
The module that had never had a fix round took the largest step. The landform control map
(flow accumulation, curvature, field parcels, rock exposure) replaces noise with structure and
it shows: `08_aerial_1300` has readable drainage, valley floors and slope-banded material where
round 2 had one green. `flattenAlong` finally shipped after being accepted in pass 1 and open
for three passes, verified live to 6.000 m. But the transformative change is the **planar water
reflection**: in `10_waterfront_1875` the entire skyline is mirrored in the river with proper
vertical break-up, and it is the single most valuable visual addition of the round — it closes
a defect I filed in round 1 and repeated in round 2. Held below 8.5 because the mountains are
still smooth, repetitive cones, and because **the seam is still there** (see §5).

### buildings — 7.5 → 8.0 (+0.5)
The ground floors are real and, at 2×, genuinely good: stone-clad bases, glazing recessed
behind structural piers, stallrisers, transoms, a projecting base course, entrance surrounds
with canopies. Finding that `isStreet` was `face === 0` — so only the elevation facing its own
frontage polyline got treated, and a street camera mostly sees flanks — is exactly the kind of
bug that makes good work look like no work. Doing all of it for **+1 to +6 draw calls** is
excellent engineering. Only +0.5 because the work is nearly invisible in the composed frames
(§4 issue 2, not their fault), the facades above ground floor are still one uniform grid per
building, and there is still no lettering anywhere in the city.

### props — 7.5 → 8.0 (+0.5)
The **607-light clustered forward pass** on the core patch chain, reaching 594 materials, is
the most technically impressive change in the project so far, and it is visible: in
`06_downtown_2200` lamps light the road, the kerb, the pavement, passing cars and the
undersides of tree canopies. My logged round-2 regression is fixed and I verified the number —
share above Y240 on the night aerial **0.169 % → 0.002 %**, a 42× reduction, p99 216.9 → 156.6.
Culling the shadow pass by distance for a measured 12 % whole-frame saving at zero draw calls
is a clean win. Held at 8.0 because the new level is too low from altitude (§5).

### traffic — 7.5 → 8.0 (+0.5)
The crowd landed. A stateless ambient walker — a pure function of edge, slot and time — takes
visible pedestrians from ~0–1 to **890 downtown and 1605 residential**, and it is the right
architecture for the problem. Signal aspects now bind to `props`' lenses across 64 of 77 heads
and I can read an amber in both downtown frames. Network saturation 1.75 → 5.47 m/s. Held at
8.0 because at 2× the agents are **untextured flat-colour figures** — pure saturated green,
red, yellow, black, head to toe, no shading, in near-identical standing poses — and they are
now numerous enough to be judged. Some stand on grass (R-traffic-6, honestly filed, correctly
attributed to the unowned kerb-to-building strip rather than to their own placement).

### demo — 7.5 → 8.0 (+0.5)
Closed my one uncompensated round-2 regression properly, and closed it the right way: it built
a projection probe that classifies a 64×36 screen lattice into city/water/sky rather than
eyeballing the framing. Aerial city fraction **47.1 % → 62.5 % with nothing clipped**, and it
found that the clipping which drove the round-2 retreat was a target-height problem, not a
standoff problem. Water is back in the hero at 7.4 % of frame, carrying a full reflection.
Golden hour is now the strongest frame in the project and I agree with its own assessment.
Held at 8.0 by R-demo-13, which it diagnosed accurately and cannot fix from its own folder.

### zoning — 7.0 → 7.5 (+0.5)
Parks with real path networks now exist and read well in `01`, `03` and `04` — a land-use type
that was absent for two rounds. I cannot tell from the frames whether zoning or demo owns them,
so I am crediting it here with that caveat. Otherwise unchanged, and it is now **blocking**
someone: R-demo-13 needs either a contiguous retail high street or a `lotsOfZone()` accessor
before buildings' ground floors can be photographed.

### tools — 7.0 → 7.5 (+0.5, documentary)
Not photographable, so this is a paper score and flagged as such. `terrain` shipping
`flattenAlong`, `applyHeightPatch`, `rebuildRegion`, `setHeights` and a `rebuild()` hook means
R-tools-5 is finally closed and the TERRAIN button is no longer inert — the first-minute defect
I filed in rounds 1 and 2 is structurally gone. I have not verified it interactively.

### environment — 7.5 → 7.5 (0). Good work on the wrong axis
Real 3-cascade CSM shipped on the core patch chain, and the numbers are excellent: street
**0.265 → 0.033 m/texel**, bias **0.450 → 0.026 m**, range to 900 m. I want to credit the
honesty — it reported that this moved the metrics severalfold and the image far less, and
correctly concluded the limiter had become AO. That is a builder measuring its own work
sceptically and it is the right instinct.

But the module holds at 7.5 because **R-env-10, per-pixel aerial perspective, is now the single
largest remaining defect in the project and it has been open and assigned since pass 6.** It is
cited independently by `demo` (R-demo-14), by `terrain` (R-terr-3, which reports the noon wash
erasing its new mid-field structure) and by me, from three different measurements. Noon `relSat`
on the skyline is **0.089 against golden hour's 0.576 on the same city** — a 6.5× gap — and noon
is a third of the day. Shipping better cascades when the frame's problem was fog is good work
aimed at the wrong axis, and the axis was named in my round-2 report.

### effects — 7.5 → 7.5 (0) · simulation — 7.5 → 7.5 (0) · ui — 8.0 → 8.0 (0)
Not re-exercised this round. GTAO and the additive grade continue to hold up; contact shading
is present in every street frame. `ui` is unchanged and still the module closest to the bar,
still with **no minimap**, and its traffic chart still reads "not recorded yet" — R-ui-4 open
across three rounds, though the KPI tile now shows 13 %.

### audio — 7.0, provisional for the third round
The harness runs `--mute-audio`. I have never heard this game. This number should not count
toward any gate.

### roads — 7.5 → 7.0 (−0.5). The one module going backwards
Its surfaces did improve — `05_downtown_1300` shows real wear, patching and tyre-track polish
where round 2 had clean vinyl, and that is worth something. But three items assigned to it are
untaken, and one of them is now the ugliest thing in the project:

- **The verge blotching is measurably worse.** R-terr-1 attributed it to `roads`'
  `buildVerge` (`bare = smooth01(pfbm(u,v,9,3), …)`, a single lattice period), and it did so
  with a properly constructed disproof-against-self: across a full material rewrite the blotch
  crop moved 4.4/px while pure render noise moved 6.5/px. I find that methodologically sound
  and I accept the attribution. In `07_residential_1300` the sampled verge region went from
  **8.0 % pink pixels to 26.9 %**, with mean R−G rising 33.1 → 44.6. At 2× it is a strong
  salmon mottle at one scale that reads as neither soil nor dry grass — a material error, and
  the nearest texture to camera in that frame.
- **It has not called `terrain.flattenAlong`** now that it exists, which is what R-terr-1 asks
  for and what would retire the verge problem at source.
- **Still no bridges.** R-demo-6 has been open since round 1; the city has never crossed its
  own river in three rounds.

---

## 2. Whole game: 7.5 → 8.0

Round 2's summary was "correctly lit, correctly shadowed, and still a place where no shop has a
front and no street has a crowd." Both of those are now false: the shopfronts are built and the
crowds are there. Add a full water reflection, real street lights, a terrain that carries
structure, and a hero frame that has more than doubled its key separation for the second round
running, and this is a genuinely handsome city builder.

8.0 is "AAA lighting and AAA composition, with content that has not quite caught up." Three
things hold the last half point:

1. **Noon is broken and noon is a third of the day.** 0.089 relSat against 0.576. Two of my
   twelve frames I would not show anyone, and both are noon.
2. **The answer to my round-2 #1 issue is invisible.** Buildings built the ground floor; no
   camera in this city can photograph it (§4 issue 2).
3. **The city still has no text on it anywhere** — no shop names, no street signs, no
   advertising — and its pedestrians are flat-colour figures.

None of those is a rendering problem. All three are reachable.

---

## 3. Regressions — I checked all four from round 2 deliberately

| round-2 regression | status |
|---|---|
| R1 · golden hero lost its river foreground | **FIXED.** Water 1.2 % → 7.4 %, and it carries a full reflection. |
| R2 · aerial city too small (the uncompensated one) | **FIXED.** 47.1 % → 62.5 %, nothing clipped, measured by probe. |
| R3 · night pools over-bright | **FIXED, and overshot the other way** — see below. |
| R4 · noon desaturation | **PARTLY FIXED.** Skyline relSat 0.061 → **0.089**, now above round 1. Still 6.5× behind golden hour. |

**On R4 I correct myself.** I reported noon desaturation as a regression in round 2. On the
skyline frame it has now recovered past round 1, so the round-2 dip was real but the trend is
up, not down. On the noon *aerial* my numbers go the other way — relSat 0.165 → 0.115 and grass
shadow depth 9.51 → 5.87 — but that framing changed substantially between rounds (47 % → 62 %
city), so the pixel population is not comparable and I am **not** calling it a regression. The
honest statement is the gap between hours, not a trend within one.

### New this round

**N1 · Night legibility from altitude went backwards.** Trading the gobo for real lights removed
the artefact and cost the read. Measured on `09_aerial_2200` across all three rounds:

| | R1 | R2 | R3 |
|---|---|---|---|
| frame mean Y | 34.87 | 49.39 | **36.65** |
| share > Y240 | 0.021 % | 0.169 % | **0.004 %** |
| share < Y20 | 53.1 % | 4.9 % | **16.9 %** |

The artefact is gone — that is a real win and props predicted the trade honestly, naming the
dial (`ClusterLights.GAIN` and the gobo `glow` vector). But the street grid, which in round 2
you could trace across the whole city, has largely dissolved back into darkness in the CBD. The
right answer is a middle setting: real lights at higher gain plus a modest gobo floor so the
network still reads from 300 m up. This is a dial, not a rebuild.

**N2 · The verge blotching got substantially worse** — 8.0 % → 26.9 % of the sampled region,
R−G 33.1 → 44.6. Owned by `roads`, assigned in pass 6, not taken.

**N3 · Watch item.** `05_downtown_1300` is now framed 88 m back at 12 m height on fov 54, and
the bottom 40 % of the frame is empty asphalt junction. It reads as a road layout rather than a
street. This is the same trade R-demo-13 describes and it is the reason issue 2 below exists.

---

## 4. What still blocks 8.5

**1 · Noon is washed out, and it is one hour in three.**
*Owns:* environment (R-env-10, open and assigned since pass 6). *Shots:* `03_skyline_1300`,
`08_aerial_1300`.
Noon relSat **0.089** against golden hour's **0.576** on the same city, same rule, same region.
Beyond ~400 m the aerial-perspective term flattens towers, terrain relief and massing to one
pale grey-green; the mountains merge into the sky. Three modules have now measured this
independently. It is scoped, it has been unblocked since pass 5, and it is the highest-value
item in the project.
*Fixed looks like:* per-pixel view-direction fog with a real extinction curve — distance
desaturating the far hills without bleaching the near city.

**2 · The ground floor is built and cannot be photographed.**
*Owns:* zoning (primary), demo. *Shot:* `05_downtown_1300`, crop `(240,220,300,190)`.
`buildings` r4's shopfronts are good and they are ~4 % of the downtown frame, mostly behind
street trees — my crop of the one treated frontage in shot 5 is roughly 70 % occluded by two
canopies. R-demo-13 has the diagnosis exactly right: `demo`'s downtown anchor picks the widest
street because that is where the towers are, and zoning puts COM_LOW on fringes where frontage
is discontinuous, so **no contiguous run of retail lots exists to point a lens at**. This is the
best effort-to-visible-quality ratio on the list: a five-line `lotsOfZone()` accessor plus a
lens change converts work that is already paid for into visible quality.
*Fixed looks like:* a `lane2` high street with a continuous run of shopfronts filling the frame,
the way every Cities: Skylines street screenshot is composed.

**3 · There is no text anywhere in the city.**
*Owns:* props (has `shopSign` and an atlas) + buildings (needs `tenanciesNear()`).
No shop names, no fascia lettering, no street signs, no advertising, no numbers. At street level
this is the most conspicuous remaining absence, and the negotiation to fix it is already open in
R-bldg-7 and R-props-10 — buildings offered the accessor, props asked for it. Someone should
just say yes.

**4 · Pedestrians are flat-colour figures.**
*Owns:* traffic. *Shot:* `05_downtown_1300`, crop `(950,540,300,175)`.
Untextured pure-saturated green/red/yellow/black, head to toe, in near-identical standing poses,
more saturated than anything else in frame. Going from invisible to 890 was the right first
move; they now need texturing, pose variation and desaturation.

**5 · Night reads from the street but not from the air.** *Owns:* props. See N1. A dial.

**6 · The verge blotching.** *Owns:* roads. See N2. One noise function.

**7 · The water seam, third round running.** *Owns:* terrain. *Shot:* `10_waterfront_1875`,
crop `(480,570,420,110)`. Much subtler than round 2 — a thin dark line rather than a bright
crease — but still a straight geometric line across a water surface, which nature does not
produce. `terrain` fixed one cause (its own vertex swell); something else still draws it.

**8 · No bridges.** *Owns:* roads. Open since round 1. A city on an estuary that never crosses
it does not read as a city.

**9 · Facades above the ground floor are one uniform grid per building, and nothing is aged.**
*Owns:* buildings. No staining, no patching, no weathering, no variation between floors.

**10 · The mountains are smooth repetitive cones.** *Owns:* terrain. Now more visible because
everything in front of them improved.

**11 · No landmark or civic set-piece.** *Owns:* zoning + buildings. Nothing in the plan or the
skyline to orient by.

**12 · UI: no minimap; traffic history unrecorded for three rounds.** *Owns:* ui + traffic.

---

## 5. What genuinely improved — named precisely

- **The skyline mirrors in the river.** `terrain`'s planar reflection, `10_waterfront_1875`.
  Filed round 1, repeated round 2, now done and it transforms the frame.
- **The hero frame doubled its separation again.** Facade p90/p10 **24.47 → 38.84 : 1**,
  relSat **0.441 → 0.576**, on the same region and rule.
- **The city has crowds.** ~0–1 → **890 / 1605** visible pedestrians, from a stateless walker.
- **Street lights are real lights.** 607 clustered lights reaching 594 materials; lamps light
  cars, kerbs, facades and canopy undersides. Over-bright artefact **0.169 % → 0.002 %**.
- **Ground floors exist**, with piers, recessed glazing, stallrisers and entrance surrounds, for
  **+1 to +6 draw calls**, plus the `isStreet = face === 0` bug found and fixed.
- **The aerial composition regression is closed by instrument** — 47.1 % → 62.5 % city, probe
  not eyeball. This is the correct response to a composition note and I want it on the record.
- **`flattenAlong` shipped** after three passes open, verified to 6.000 m.
- **Terrain has structure** — flow accumulation and curvature driving the splat instead of noise.
- **Parks with path networks**, day and night, lit.
- **Real 3-cascade CSM** — 0.265 → 0.033 m/texel, bias 0.450 → 0.026 m.
- **`renderer.info` accounting bug found and disclosed by the integrator**, invalidating its own
  earlier numbers rather than quietly moving on. Two rounds running this project has corrected
  itself on the record (R-bldg-6, R-fx-7, now R-terr-2). That is the strongest signal in it.

---

## 6. Technical gate — my own twelve runs

| shot | fps | draw calls | tris (M) | textures | programs | errors | failed |
|---|---|---|---|---|---|---|---|
| 01_skyline_1875 | 10 | **1257** | 12.42 | 117 | 91 | 0 | none |
| 02_skyline_0650 | 10 | 1238 | 12.35 | 117 | 91 | 0 | none |
| 03_skyline_1300 | 10 | 1234 | 12.34 | 116 | 90 | 0 | none |
| 04_skyline_2200 | 10 | 1239 | 12.13 | 117 | 91 | 0 | none |
| 05_downtown_1300 | 10 | 579 | 10.82 | 113 | 84 | 0 | none |
| 06_downtown_2200 | 10 | 661 | 10.36 | 114 | 85 | 0 | none |
| 07_residential_1300 | 10 | 649 | 8.06 | 116 | 84 | 0 | none |
| 08_aerial_1300 | 10 | 1233 | 12.58 | 116 | 88 | 0 | none |
| 09_aerial_2200 | 10 | 1244 | 12.49 | 117 | 89 | 0 | none |
| 10_waterfront_1875 | 10 | 1136 | 12.59 | 117 | 87 | 0 | none |
| 11_ui_default | 10 | 1236 | 12.37 | 116 | 91 | 0 | none |
| 12_ui_panels | 10 | 1233 | 12.58 | 116 | 88 | 0 | none |

- **Draw calls: 579–1257, max 1257 of 1500 — PASS**, 243 headroom on my set. The project's true
  worst is `night_golden` at **1324** (176 headroom), a variant I do not shoot. Budget used has
  gone 28 % → 64 % → **88 %** across three rounds.
- **Console errors: 0 across all twelve — PASS.** No module ever left `state: ok`.
- **Triangles 8.06–12.59 M**, up from 7.9–9.2 M.
- **fps: still unmeasurable** under SwiftShader. See §7 — this is now the project's largest
  unquantified risk, not a footnote.

**Was it bought well?** Yes, again, but this is the last round where that answer is easy. The
spend bought a water reflection, 607 real lights and shadow casting that reaches every camera —
all visible, all valuable. But water is **all-or-nothing at 296 calls** (4.9 % of frame costs
the same as 43 %), so hero framing is now a budget decision. With 176 calls of true headroom,
**the next quality increment has to be paid for by removing something.** The obvious candidate
remains R-props-7's admission that prop meshes cast full-resolution shadows city-wide; the
distance cull on the shadow pass has already reclaimed 12 % of frame time and there is more
there.

---

## 7. Is 8.5 reachable from here? Yes — and part of the remaining gap is structural

**The short answer: yes, and it is roughly one focused round away, not another broad one.**

### The shortest path, in value order

1. **Per-pixel aerial perspective (R-env-10).** One module, already scoped, unblocked since
   pass 5, cited by three modules with numbers. It lifts `03`, `08` and both `ui` frames at
   once — a third of the day currently sits at 0.089 relSat. **This alone is worth most of the
   remaining half point.**
2. **A photographable high street (R-demo-13(b) + a lens).** Five-line accessor plus a framing
   change. Converts `buildings` r4's already-paid-for ground floors from invisible to the
   subject of a frame. Best effort-to-visible-quality ratio on the board.
3. **Signage and lettering.** `props` has `shopSign` and an atlas; `buildings` has offered
   `tenanciesNear()`. The negotiation is already open in R-bldg-7 / R-props-10 — it needs a
   decision, not an invention.
4. **Three dials:** night lamp gain, the `buildVerge` noise period, pedestrian texturing and
   pose variation.

Do 1 and 2 and I would expect 8.5 on the composed frames. Do 3 and it is comfortable.

### What is structurally out of reach here, plainly

- **The blind A/B against real Cities: Skylines II screenshots cannot be run in this sandbox**,
  and after three rounds that is no longer a footnote — it is a ceiling on confidence. The
  egress proxy blocks image sources; no genuine reference can be fetched; fabricating one would
  make the comparison worthless. Every score in all three rounds is calibrated against my
  memory of those screenshots, unblinded, with nobody able to check me. I can defend "this is
  very good." I cannot responsibly certify "indistinguishable," and neither can anyone else
  here. **8.5 should be awarded on the frames, with that limitation stated, or not at all.**
- **fps has never been measured and may not pass.** ARCHITECTURE.md §0 requires ≥50 fps at
  1920×1080. Every shot in every round reports 10 fps under SwiftShader on 2 CPUs, which the
  harness correctly does not gate. But this is now a heavy frame: 1257–1324 draw calls,
  12.6 M triangles, a 607-light clustered forward pass, three shadow cascades, a 296-call planar
  reflection and half-res GTAO. **It is entirely possible this build misses 50 fps on real
  hardware and nothing in this repo would reveal it.** This is the largest unquantified risk in
  the project and it is structural to the environment, not to the code. Somebody should run one
  frame on a real GPU before the art is called done.
- **The draw-call budget is now binding**, at 88 % on the worst frame. The project spent from
  28 % to 88 % in two rounds. Further quality costs removals.
- **Authored asset variety is capped by the asset policy plus the blocked egress.** Every
  texture, mesh and material in this project is procedural because Poly Haven and ambientCG are
  unreachable. That is precisely why the pedestrians are flat colours, why there is no
  lettering, why the mountains are smooth and why every facade is a grid. A real side-by-side
  against CS2 would lose most on hand-authored variety — modelled landmarks, photographed
  materials, hand-placed set dressing — and **no amount of procedural cleverness fully closes
  that in a browser with no asset pipeline.**

**My honest ceiling estimate for this project in this environment is about 8.5–8.75.** 8.5 is
reachable and I would expect it next round if items 1 and 2 land. Above roughly 8.75 you are no
longer fighting the renderer or the composition — you are fighting the absence of an art team
and an asset library, and that is not a bug anyone here can fix.

---

*Round 3. Twelve frames, all re-shot by the critic. Whole game 7.5 → 8.0. Six modules at 8.0,
one regression (`roads`, −0.5), all four round-2 regressions closed, two new ones logged.
Technical gate passes at 88 % of the draw-call budget. 8.5 is one focused round away.*
