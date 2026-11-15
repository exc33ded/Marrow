---
covers: [index.html, test-frontend.js, test-ui.mjs]
---

# Looks (themes)

A look is a set of CSS custom properties on `[data-look=<name>]`, plus an optional block of rules. The original look, *Lab notebook*, is the plain `:root` with no attribute. Dark mode is `[data-theme=dark]`, and inside a look it is `[data-look=<name>][data-theme=dark]`.

All looks sit at the end of the stylesheet, between `/* LOOKS-BEGIN */` and `/* LOOKS-END */`. The `LOOKS` array in the script lists them for the picker (`lookPicker()`) as `[id, name, one-line description]`.

## Tokens every look must define (light and dark)

`--bg --panel --ink --muted --line --acc --acc-bg --ok --pdf --web --vid --sh --pop --pri --pri-h --on-pri --on-n --scrim --logo-a --logo-b --sig --h0..--h4 --f-body --f-display --f-mono --r --r2`

`--h0` to `--h4` are the five activity-grid levels. The dark block has to restate every colour, or the light values win.

## Adding a look

1. Add a light block and a dark block between the markers.
2. Add `['mine', 'My look', 'One line.']` to `LOOKS`.
3. If you use a web font, add it to the Google Fonts link in `<head>`.
4. Anything beyond colours and type goes in rules starting with `html[data-look=mine]`.

The tests find looks on their own, so they never need editing:

- `node test-frontend.js` reports a missing token, a missing dark block, a missing font, a missing picker entry, or text under 4.5:1 contrast.
- `test-ui.mjs` then renders every look on every screen.

## The shell (shared by every look)

Right after `/* LOOKS-END */`, a block of `html[data-theme] …` rules sets shape and layout for all looks. A look keeps its own colours, type and selected states. It does not set these:

- buttons, chips and the reader's step tabs are pills; cards, look cards, palette rows and sidebar items keep their own corners
- fields have 10px corners
- above 900px wide, the rail is a 212px sidebar with an icon and a word side by side, the "Marrow" wordmark at the top (in the rail's text colour), and a Ctrl K hint on Search

The shell comes after the looks, so it wins any tie. A look that needs a different rail text colour sets `color` on its `#rail` (Concourse and Cyanotype do).

Icons are [Lucide](https://lucide.dev) (ISC licence, `lucide-static` 1.73.0). Each one is flattened to a single path in the `IC` map, so `ic()` still draws one `<path>`.

## Choosing a look

*Studio* (`studio`) is the default: with nothing remembered, the inline script in `<head>` applies it. Studio hides the rail icons and the logo tile and shows words only. The picker sets `document.documentElement.dataset.look` and remembers it in the browser, including an empty value for Lab notebook, so picking the original sticks. The Lab notebook swatch carries `data-look=""`, which `:root`'s tokens also match, so it shows its own colours under any look. `?look=survey&theme=dark` in the address previews a look without saving it; the inline script in `<head>` applies it before first paint.
