# Board design system

The board uses the tokens of [`@apliteni/apliteni-ui`](https://www.npmjs.com/package/@apliteni/apliteni-ui)
0.146.0. This folder records which tokens the board uses, and why.

| File | What it is |
| --- | --- |
| [`DESIGN.md`](DESIGN.md) | The source. Its front matter holds each token with its value and its reason. The body holds the rules, the status badges, the board-specific gaps and the deviations. |
| [`colors_and_type.css`](colors_and_type.css) | The tokens as CSS custom properties. `build.mjs` makes this file. Do not edit it by hand. |
| [`system.html`](system.html) | One self-contained page. It shows the tokens, then a sample board screen built only from them. |
| [`build.mjs`](build.mjs) | Makes `colors_and_type.css` from `DESIGN.md` and copies the same CSS into `system.html`. |

## Change a token

1. Change the token in the front matter of `DESIGN.md`. Each token needs a `why`.
2. Run `node design/build.mjs` from the repository root.
3. Run `node design/build.mjs --check`. It exits 1 when a file is out of date.

A token value must match the kit exactly. If the board needs a value that the kit does not have,
add a row to the board-specific gaps table and use the nearest token.

## Open the page

Open `system.html` in a browser. It needs no server and no network. The page has three switches:
dark, compact and the accent. Each switch changes the whole page.

The URL hash holds the state, so a link opens the same view:

| Hash | View |
| --- | --- |
| `#tokens` | The tokens, light. |
| `#board-light` | The sample board, light. |
| `#board-dark` | The sample board, dark. |
| `#board-compact` | The sample board, light and compact. |

`-dark` and `-compact` combine, for example `#board-dark-compact` or `#tokens-dark`. Add
`/phoenix`, `/ocean` or `/emerald` for another accent, for example `#board-dark/ocean`.

## Format of DESIGN.md

The design skill names a format file, `references/design-md.md`, but that file does not exist. So
this format was chosen for this repository. Each token is one line in the front matter:

```yaml
  --surface: { value: "#ffffff", why: "..." }
```

The front matter has the groups `shared`, `dark`, `light` and `accents`. Accent tokens have a `dark`
and a `light` value in place of `value`.
