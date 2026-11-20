# Design notes

## Reference

Visual language follows [thesearchbar.ai](https://thesearchbar.ai/). The tokens in `web/src/styles/tokens.css` were
read from that site's own CSS variables, not estimated from screenshots:

- Paper `#f4f2ee`, card `#faf9f6`, ink `#151515`, secondary ink `#3b3a38`, muted `#77746f`, hairline `#e0ddd6`
- Signal green `#2fb565` (ink variant `#1f8a4b`) as the single accent
- Source Serif 4 (500) for display, Geist for interface text; pill buttons 38 px tall
- Ease `cubic-bezier(0.2, 0.7, 0.2, 1)`

Borrowed motifs: hairline frame with corner ticks, hollow and solid circular nodes (used for location precision and
the filing timeline), and the green "live" pulse.

## Encoding the data

| Visual         | Means                                                                |
| -------------- | -------------------------------------------------------------------- |
| Point color    | Stage of review                                                      |
| Solid dot      | Location from the agency's coordinates                               |
| Hollow ring    | Approximate location (city or county)                                |
| Cluster ring   | Hairline circle with count; **green ring** = contains an open review |
| Breathing halo | Project in public review right now (off with reduced motion)         |

### Stage colors

Validated with the dataviz palette checker against both map surfaces, testing every pair (map points behave like a
scatter plot, where any two colors can sit side by side):

| Stage         | Light (on `#f4f2ee`) | Dark (on `#121212`) |
| ------------- | -------------------- | ------------------- |
| In review     | `#1f9d55`            | `#1e9a56`           |
| Scoping       | `#2a6fd6`            | `#4b82e8`           |
| Review closed | `#e8590c`            | `#e8621a`           |
| Approved      | `#151515` (ink)      | `#efede8`           |
| Exempt        | `#a39f97`            | `#6f6c67`           |
| Other         | `#cfcbc3`            | `#3b3a38`           |

Light set: worst color‑blind separation ΔE 8.9 (passes the 8.0 target), worst normal‑vision separation 17.2
(passes 15). Dark set: all checks pass; the green and orange pair sits at ΔE 7.7 for protanopia, inside the band
that requires a second cue, which the legend, hover label, and drawer chip provide.

The three active stages get hue; the two settled stages (Approved, Exempt), which in the samples we inspected
account for most filings, are neutrals, so the map's color draws the eye to what is still open. Exempt is deliberately recessive (below 3:1
contrast); it is always labeled in the legend.

Status colors are defined once in `packages/shared/src/index.ts` and used by both the map and the interface.
