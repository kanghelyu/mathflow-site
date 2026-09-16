# mathflow-site

Public site for the OmniFlow map **“DIM Algebra N=2 — From Paper to Verified Study Material”**.

Live: <https://mathflow.kanghelyu.org>

## What it is

An interactive, self-contained flow map of how the $N$-body representation of the DIM algebra,
its Cherednik and $R$-operators, and the operators attached to the $(-1,r)$ ray were reconstructed
and symbolically verified from

> A. Mironov, A. Morozov, A. Popolitov, *Commutative families in DIM algebra, integrable many-body
> systems and $q,t$ matrix models*, [arXiv:2406.16688](https://arxiv.org/abs/2406.16688).

21 cards · 27 typed relations · 5 groups · 45/45 symbolic checks passed at $N=2$.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Landing page: framing, group overview, verification ledger, embedded map |
| `canvas.html` | Unmodified OmniFlow standalone HTML export — fully offline, KaTeX inlined |
| `CNAME` | `mathflow.kanghelyu.org` |

No build step, no dependencies, no external requests at runtime.

## Rebuilding

The map lives in a local OmniFlow store, not in this repository:

```bash
of export DIMAlgebraN2FromPapertoV-775n --format html --out canvas.html
```

Then copy `canvas.html` here and redeploy. See [OmniFlow](https://github.com/kanghelyu/omni-flow).

## Credits

Built with [OmniFlow](https://github.com/kanghelyu/omni-flow) (CC BY-NC 4.0).
Mathematical content is a private study record and is not affiliated with the authors of the paper.
