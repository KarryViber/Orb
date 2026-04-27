# Dead scripts cleanup report - 2026-04

Scope: candidates from `specs/cleanup-dead-scripts-and-handlers.md`.

Checks run for each script:
- `profiles/karry/data/cron-jobs.json`
- `profiles/karry/workspace/.claude/skills/`
- `profiles/karry/workspace/CLAUDE.md`
- `CLAUDE.md`
- `profiles/karry/scripts/`
- `git log --all -S <script-name> --oneline | head -10`

## Results

| Candidate | Live references | History references | Disposition |
| --- | --- | --- | --- |
| `check-agents-health.sh` | none | none | archived to `profiles/karry/scripts/_archive/2026-04-27/check-agents-health.sh` |
| `finance/run-stock-screener.sh` | none | none | archived to `profiles/karry/scripts/_archive/2026-04-27/finance/run-stock-screener.sh` |
| `finance/stock-screener-slack-report.py` | none | none | archived to `profiles/karry/scripts/_archive/2026-04-27/finance/stock-screener-slack-report.py` |
| `project-weekly-summary-context.sh` | none | none | archived to `profiles/karry/scripts/_archive/2026-04-27/project-weekly-summary-context.sh` |
| `project-weekly-summary-draft.sh` | none | none | archived to `profiles/karry/scripts/_archive/2026-04-27/project-weekly-summary-draft.sh` |
| `teahouse-watch-cli.py` | none | none | archived to `profiles/karry/scripts/_archive/2026-04-27/teahouse-watch-cli.py` |
| `work-inspection-weekend-summary.py` | none | none | archived to `profiles/karry/scripts/_archive/2026-04-27/work-inspection-weekend-summary.py` |
| `x-content-proposals-cli.py` | none | `4eb024c fix: extract stopReason from Claude output for accurate auto-continue message` | archived to `profiles/karry/scripts/_archive/2026-04-27/x-content-proposals-cli.py`; history-only reference is not an active dependency |
| `handlers/test_echo.py` | none for `test_echo` / `test-echo`; no action card producer found | none | moved to `profiles/karry/scripts/handlers/_examples/test_echo.py` |

## Notes

- No `src`, `cron-jobs.json`, `skills`, or `CLAUDE.md` files were changed.
- Daemon restart is not required for this cleanup.
- Follow-up safety check: monitor cron errors for 7 days before deleting archived copies.
