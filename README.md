# mathflow-site

**mathflow** — a growing collection of interactive OmniFlow maps of mathematics.
Live: <https://mathflow.kanghelyu.org>

## What it is

A gallery of flow maps (theorem dependencies, reconstruction-and-verification records, reading
notes) produced with [OmniFlow](https://github.com/kanghelyu/omni-flow). Each map opens as its own
full-page OmniFlow workspace.

Two pages, no server:

| Path | Purpose |
| --- | --- |
| `index.html` | Gallery: one card per published map, linking to `map.html#<graphId>` |
| `map.html` | The **unmodified** OmniFlow Studio client, driving a static snapshot |
| `assets/static-api.js` | Browser-side implementation of the Studio's HTTP API over the snapshot |
| `assets/lib/*.js` | OmniFlow's own `graph-core` / `graph-analysis` / `group-suggest` / `converters`, shipped verbatim |
| `vendor/katex/**` | Vendored KaTeX (the Studio loads it from `/vendor/`) |
| `data/index.json` | Map list, folder tree, templates (zh + en) |
| `data/g/<id>.json` | Per-map snapshot: graph + detail + validation + analysis + notes |

## How it works without a backend

`of studio` normally serves the client over an HTTP API. Here the client is unchanged and the API is
implemented in the browser:

- **Algorithms are the real ones.** Layout, validation, analysis, group suggestions, and every
  export format come from OmniFlow's own browser-safe modules, imported verbatim — nothing is
  reimplemented.
- **Reads** come from a build-time snapshot in `data/`.
- **Writes** are applied in memory and mirrored to `localStorage`, so an edit survives a reload in
  *your* browser only. The published snapshot is never modified and visitors never see each other's
  edits. The page shows a small "snapshot" indicator with a reset button when local edits exist.
- Cross-tab sync (SSE) and anything needing durable shared state (graph deletion, conversation
  editing, node attachments) is declined with an explicit message rather than silently failing.

## Rebuilding after adding maps

The site is generated from a local OmniFlow vault:

```bash
node build/build-static.mjs
```

`build/publish.json` decides which graphs are published (`exclude` globs, or an explicit `include`
whitelist). Add a graph to the vault, re-run the build, commit, push — it appears in the gallery.

## Credits

Built with [OmniFlow](https://github.com/kanghelyu/omni-flow) (CC BY-NC 4.0). The OmniFlow Studio
client is shipped unmodified. Mathematical content is a private study record and is not affiliated
with the authors of the papers it refers to.
