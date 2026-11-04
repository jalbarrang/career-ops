# LaTeX-in examples (latex-tex mode)

Fictional `.tex` fixtures for `packages/cli/src/commands/cv/extract-latex-content.ts` / `packages/cli/src/commands/cv/patch-latex-content.ts` tests.
Do not use real names, emails, or employers from your own CV here.

| File | Family |
|------|--------|
| `resume-subheading.tex` | `resumeSubheading` — `\resumeItem` bullets + `\textbf{Category}{: items}` skills |
| `tabularx-itemize.tex` | `tabularx-itemize` — `tabularx` header rows + `itemize` bullets |

```bash
bun packages/cli/src/commands/cv/extract-latex-content.ts examples/latex-tex/resume-subheading.tex
```
