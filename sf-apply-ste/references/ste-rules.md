# STE rules used by sf-apply-ste

Source: published summaries of ASD-STE100 (Simplified Technical English). This file is NOT the standard.
For the exact rules and the approved dictionary, use the official free specification (asd-ste100.org).

## Writing rules and who checks them
| Rule | Checked by |
|---|---|
| Descriptive sentence ≤ 25 words | script (`STE-LEN`, error) |
| Procedural sentence (numbered step) ≤ 20 words | script (`STE-LEN`, error) |
| Paragraph ≤ 6 sentences | script (`STE-PARA`, warning) |
| No contractions | script (`STE-CONTRACTION`, error; `fix` expands most) |
| No ambiguous modal verbs (`may`, `might`, `could`, `should`); `shall` is not an approved word | script (`STE-MODAL`) |
| Curated non-STE words and phrases (`utilize`, `ensure`, `via`, `prior to`, `in order to`, `e.g.`, `i.e.`, `etc.`, …) | script (`STE-WORD`, error; `fix` handles some) |
| No ellipses | script (`STE-ELLIPSIS`, warning) |
| Use the active voice | script heuristic (`STE-PASSIVE`, warning; false positives possible) |
| One instruction per sentence in procedures | agent |
| One idea per sentence | agent |
| Simple present tense; avoid `-ing` forms as verbs | agent |
| Noun clusters of at most 3 words | agent |
| One word, one meaning; one term per concept | agent |
| Keep articles (`the`, `a`); no slang or idioms | agent |
| Approved vocabulary | script only with a word list (`STE-DICT`, info; noisy); otherwise agent |
| `NOTE` / `CAUTION` / `WARNING` for important text | agent |

## Protected text (never changed by `fix`, never counted as prose)
Fenced code, inline code, front matter, HTML comments, URLs and link targets, requirement IDs.

## Spec safety (`seal`)
A style rewrite must not change the meaning of a requirement. `seal` verifies: spec lint passes; requirement IDs unchanged;
criteria count, type and priority unchanged per requirement. If the text changed, an approved spec becomes `draft`, the plan needs
`rehash` and re-approval, and plan criteria that still hold the old spec text are listed. The action is recorded in `.sf/ledger.jsonl`.
