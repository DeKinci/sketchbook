# Groups — design (v3, review-closed)

Status: two hostile review rounds folded in (26 + 17 findings); round 2 verdict:
architecture sound, remaining items were spec pins — all pinned below. Scope:
`@dorodango/draw-board` model + editor semantics. Perf follow-up (group-as-
render-cache) is out of scope for v1.

## Rules (product)

1. Grouped elements are **rigid**: geometry frozen relative to each other. The
   group as a whole can be **moved**, **scaled** (corner anchors, uniform) and
   **stretched** (side anchors, per-axis: members follow the scaling — boxes
   stretch, text keeps its %-position undistorted, bound arrows follow their
   bindings, unbound ones stretch too); members can never be individually
   moved, resized, cropped, retyped, or deleted while grouped.
2. A group **acts as a single element**: dragging any member drags the group;
   delete/erase on a member removes the whole group; the glue system sees the
   group as one unit — including glue the group itself initiates, and
   group↔group glue.
3. Groups **nest** arbitrarily.
4. A fully-selected group renders the **group AABB** outline (one per unit in
   multi-unit selections).
5. Members can be **deep-selected** (⌘-click) for a restricted edit set:
   stroke color, stroke width (for text this means font size — its bbox
   changes; accepted), text content, label text. Nothing else.
6. Whole-group selection: color/width edits apply to all members.
7. `⌘G` toggles: ≥2 selected units → group; a selection exactly covering ONE
   group → ungroup one level. Proper-subset selections never ungroup.

## Model: `groupPath` on shapes — no group objects

```ts
interface BaseShape {
  /** Group ancestry, ROOT FIRST. Absent = ungrouped. A group exists only as
   *  the set of shapes sharing a path prefix. */
  groupPath?: string[];
}
```

Grouping is a `mapShapes` stamp — history/undo, clipboard, rich round-trip,
spatial index, and culling see ordinary shape edits. Derived (identity-diffed,
NOT rebuilt per frame — same pattern as `SpatialIndex.update`):
`rootUnitOf`, `unitOf`, `groupMembers`, `unitBounds`.

Honest cost note: ⌘G/ungroup restamps N members → N new identities → one
full element-cache + index + static-bitmap rebuild frame. Accepted.

## UNIT-GRAINED GLUE ENGINE (the real work — was wrongly "free" in v1)

The surface answer stands: detection stays member-grained (union of member
surfaces — precise concave coverage, no hulls). But *follow* mechanics must be
rewritten unit-grained. The functions being rewritten, explicitly:

- **`attachAdjacency` → unit graph.** Nodes = root units. Any attach edge
  touching any member connects the two UNITS.
- **`moveClusterIds` → unit BFS.** Seeds expand to full units; admission is
  atomic per unit; threshold compares **unit weights**. Unit weight = area of
  the unit's union AABB (a stroke-only MANUAL group is an object, not massless;
  overlap isn't double-counted). **Exception — auto doodle clusters** (a pen
  started on a pen, `isDoodleGid` root): massless like their member strokes, so a
  multi-stroke annotation still follows the shape it's drawn on. Equal-size
  separability law applies at unit grain. `containedIds`: a unit is contained only if ALL members are inside;
  a unit contains only via its members' boxes (not hull air) — v1: containment
  checks against member boxes individually, containee = whole units.
- **`reflowAttachments` → moves UNITS rigidly.** When a follower's anchor
  fires, `offsetShape` applies to every member of the follower's unit.
- **`reattach` → unit-aware stamping.** After a unit move, outward detection
  runs per member against non-members, but at most ONE outward edge per unit
  survives (nearest contact); it's stored on the touching member and owned by
  the unit. Grouped members are never stamped as lone followers.
- **Group↔group glue works** by construction: an edge from member(A)→member(B)
  connects unit(A)→unit(B) in the unit graph.

**On group creation**: members' existing outward edges (attach + connector
binds to non-members) are **severed** — and honestly: severing lasts *until
the next move*, since a still-touching neighbor re-glues via the unit-grained
reattach on the first drag; undo restores exactly. Internal edges crossing
between the forming group's child units move to a **level-keyed dormant
stash**:

```ts
dormant?: Array<{ gid: string; attach?: Attach; bindStart?: Bind; bindEnd?: Bind }>;
```

Level-keyed because nesting collides in single slots: a unit-owned outward
edge stamped during an inner group's life must be stashable again when an
outer group forms. Ungroup restores ONLY its gid's entries; **precedence: a
live outward edge stamped during the group's life wins — a dormant edge
restores only into an empty slot.** `scaleUnit` scales dormant metrics at
EVERY level. Dormant fields are invisible to all reflow/adjacency consumers.
The unit-owned outward edge only ever stamps a non-connector member
(`isConnector` law), and after dissolution it remains as an ordinary
member-grained edge (its anchor was member→target all along).

Correctness dependency, stated: dormant restore is idempotent under undo/redo
because history is SNAPSHOT-based (redo re-applies stored arrays, never
re-executes ungroup). A future command-history migration would break this.

**Inbound edges (outsider → member)** stay live: followers ride the unit;
bound arrows cling to member borders (rigid ⇒ bound-to-member ≡ bound-to-
group). After `scaleUnit`, ALL inbound edges targeting members are re-judged
(keep-or-drop + anchor refresh — the `refreshOwnAnchor` rule generalized),
because anchor `dx/dy` and bind `gap` are absolute lengths.

## Selection model

`selectedIds` stays shape-id-only. **`normalizeSelection` lives in the
REDUCER**: the `select` action gains `{ deep?: boolean }`; non-deep selects
expand each id to its full unit (⌘-click passes `deep: true`). Marquee: ANY
member intersecting expands to the whole unit. `toggleSelect` becomes
UNIT-grained in the reducer — if any member of the clicked unit is selected,
remove ALL its member ids, else add all (an id-then-expand toggle could never
deselect a unit). Safe-by-inspection writes, pinned by tests rather than
funneled: clears (`setTool`/`beginDraw`/`deleteSelected`), `endDraw`
`[draftId]` (new loose shape), `addShapes` (whole pasted units, given
clipboard remap below), `deleteShapes` filter (post-expansion), undo/redo
`keepExisting` (a surviving proper subset legitimately renders as
deep-select).

Deep-select (⌘-click) is the only producer of proper-subset selections, and
the state is defined by that shape: any selection that is a proper subset of a
unit RENDERS and BEHAVES as deep-select (own outline + subdued unit outline;
restricted edits). No extra state flag.

Rendering: partition selection into root units — fully-covered units get one
AABB outline each; loose shapes get per-shape outlines.

## Move / scale / edit semantics

**Move**: unit BFS as above. Drag-preview glue highlight operates at unit
level (highlight the would-be partner unit's bounds, not a lone member box).

**Scale — one atomic `scaleUnit` action** (not N Transformer bakes):
`{ ids, factor, origin, distScale }`, uniform only (`distScale` = the
committing view's `1/scale`, one value for the whole bake — feeds the inbound
re-judge screen-true, same as `commitResize`). `origin` = the fixed point
opposite the active Transformer anchor. History-NEUTRAL inside the
begin/endGesture pair, like `commitResize`. The view attaches the Transformer
to a synthetic PROXY rect over the unit bounds (members' own nodes never get
handles; `keepRatio` forced). Live follow is MODEL-driven — a
`scaleUnitGhost` analog of `reflowChildrenTo` re-stamps member geometry per
frame (new identities → dynamic layer; never imperative node scaling, which
would fight the element caches). Commit bakes, for every member:
- geometry: x/y/w/h and all point arrays, affine about `origin`;
- `fontSize × factor`; `strokeWidth × factor` (continuous values allowed —
  the 3/6/10 toolbar slots highlight nearest, stated);
- label-chip note: stroke-label chips render at fixed 15px and DON'T scale
  (area labels derive from bbox and do) — accepted, documented;
- image `crop` rects: source-pixel space — explicitly untouched;
- dormant (ALL levels) + live internal glue metrics (dx/dy/gap) × factor;
- then the inbound-edge re-judge pass (above), using the action's `distScale`.
Per-member minimum-size clamps do NOT apply during unit scale (they'd distort
rigidity; text may go sub-8px — accepted); only a unit-level minimum (unit box
≥ 6 SCREEN px, enforced in the Transformer's boundBoxFunc which already works
in screen space) gates the gesture. An all-stroke group IS scalable via the
proxy (rule 1) even though lone strokes are move-only — intended asymmetry.

**Stretch — the side-anchor analog, `stretchUnit` `{ ids, fx, fy, origin,
distScale }`** (+ `stretchUnitGhost` live frames): a disproportional per-axis
resize where members FOLLOW the scaling. Boxes (rect/ellipse/image) map fully
affinely per axis (position remaps, `width×fx` / `height×fy`); point members
(line/arrow/pen) remap per-point; TEXT keeps its %-position (center remaps) at
its own size — glyphs never distort. No `fontSize`/`strokeWidth` change (no
uniform factor exists). Bound arrows follow their BINDINGS, not the raw remap —
the settle's `reflowBindings` re-clings them to the stretched targets with
absolute gaps; unbound ones keep the per-point remap. Intra-unit attach anchors
re-derive from the final geometry (no single metric factor; underivable edges
kept verbatim, settle at ungroup); dormant box offsets stretch `dx×fx`/`dy×fy`,
radial metrics best-effort.

**Restricted edits**: allowed on members — `setColor`, `setStrokeWidth`
(incl. text font-size semantics), `setText`, label edit. Disallowed while
grouped — move, resize, crop, retype. Guards live in the REDUCER (single
owner):
- `translateShapes` with a partial-unit id set EXPANDS to full units (never
  partial-translate, never silently drop);
- subset delete DOES NOT EXIST — `deleteShapes`/`deleteSelected` expand to
  full units (an erase swipe grazing one member deletes the group — rule 2)
  — with ONE exception: Backspace during an active DEEP-SELECT is a no-op
  (a deliberate member-editing context must not nuke the group; ungroup to
  prune);
- `armCluster` retype applies to LOOSE shapes only; if the post-skip set is
  empty it is a total no-op (no history entry, no variant cycle);
- `cropImage` no-ops on grouped images.
The view additionally gates affordances: Transformer never attaches to a
deep-selected member (`soleResizable` requires a singleton unit), and
double-click crop on a grouped image doesn't open the overlay.

**Draw-on-group**: new strokes never auto-join a group; endDraw attach
detection may glue the NEW shape to a member (inbound — rides the unit).

## ⌘G exact semantics

Guarded like history ops: no-op while `gestureBase || draftId` (a mid-drag ⌘G
would corrupt the open gesture's history pair and the live move cluster) and
while a camera gesture's bitmap cache is live (the N-identity restamp would
force a full recache hitch mid-pan). The reducer stays pure: `groupSelection`
carries the minted `gid` in its payload (ids-from-the-view law).

- Group: normalize selection (expand); if ≥2 units → new gid prepended to every
  member's path (`[gid, ...old]`, loose shapes `[gid]`). Post-state: selection
  = the new unit's members (so ⌘G⌘G round-trips), one history commit.
- Ungroup: only when the selection EXACTLY covers one unit whose root is a
  group → strip `path[0]` per member; dormant internal edges of THAT level
  restore (scaled); post-state: selection unchanged (now the freed members).
- Deep-selected member + ⌘G: no-op (proper subset never ungroups — F19).
- Single-member groups are collapsed on creation attempts and by import
  normalization.

## Clipboard / import / export

- `clonePastedShapes`: remap gids per batch (fresh ids, prefix-preserving);
  **remap dormant-edge target ids too** (drop entries whose target left the
  batch — else ungrouping a pasted copy welds it to the ORIGINAL); collapse
  single-member groups after partial-batch copies.
- **Import/open normalization pass** (new, required for cross-version safety):
  docs edited by older app versions can hold duplicated gids across unrelated
  assemblies, sheared "rigid" groups, or singleton paths — normalize by
  connected-component gid dedupe + singleton collapse. Old apps ignore
  `groupPath` and may violate rigidity; normalization makes the damage
  well-formed, not undone. Stated limitation.
- Rich PNG/SVG round-trip: free (`groupPath` rides shape JSON). The v1 idea of
  `<g>`-wrapping slim SVG is DROPPED: `paintOrder` hoists images behind
  vectors, so group members aren't contiguous in output order.

## Phases

1. Model + glue engine: groupPath, derived unit index (identity-diffed),
   dormant-edge transform, unit-grained `attachAdjacency`/`moveClusterIds`/
   `containedIds`/`reflowAttachments`/`reattach`, `groupSelection`/`ungroup`
   actions with gesture guards, edit guards, `scaleUnit` with the full bake
   list + inbound re-judge. Pure; the heaviest test surface of the feature.
2. Interaction: `normalizeSelection` funnel, deep-select, partitioned
   outlines, proxy-rect Transformer, dblclick/crop gating, unit-level drag
   highlights, ⌘G keyboard + keymap.ts + toolbar affordance.
3. Files: clipboard remap + collapse, import normalization, e2e (group, drag
   whole, glue in/out, scale with inbound re-judge, deep-edit, ungroup
   restore, paste round-trip, cross-version normalization fixture).
4. (Separate) Perf: root units as cached render nodes.

## Decisions taken in review (flag if you disagree)

- Groups CAN initiate glue and glue to each other (unit-owned outward edge,
  max one per unit) — chosen over "glue-inert groups" to honor rule 2.
- Unit weight = union-AABB area (not member-sum: overlap double-counts; not
  massless-if-strokes: a manual group is an object). Auto doodle clusters
  (`isDoodleGid` root) are the exception — massless, like their member strokes.
- Grouping severs outward glue permanently (undo-only restore) — simple over
  archival restore, stated in UX copy.
- Retype of grouped members disallowed; stroke-width edits allowed including
  the text-bbox drift.
- Deep-select modifier: ⌘-click (double-click stays text/label/crop).
