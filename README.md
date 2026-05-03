# ⚡ Actions Optimizer

**Analyzes your GitHub Actions workflows and recommends concrete optimizations.**

> **Gap filled:** Workflow Telemetry observes runtime metrics. No existing action prescriptively analyzes workflow YAML and suggests parallelization, caching, cost reduction, and skip-logic improvements.

## Optimization Rules

| Rule | Category | Impact | What It Finds |
|------|----------|--------|---------------|
| OPT001 | Caching | 🔴 High | Package install without cache step |
| OPT002 | Parallelization | 🔴 High | Jobs mixing build/test/lint that could run in parallel |
| OPT003 | Redundancy | 🟢 Low | Duplicate checkout steps |
| OPT004 | Skip Logic | 🔴 High | Missing path filters causing unnecessary runs |
| OPT005 | Cost | 🟡 Medium | macOS/Windows runners when Linux would work |
| OPT006 | Skip Logic | 🟡 Medium | Missing concurrency control (wasted parallel runs) |
| OPT007 | Cost | 🟡 Medium | No timeout (default 6h can burn credits) |
| OPT008 | Performance | 🟢 Low | Full git fetch when shallow clone suffices |

## Usage

```yaml
- uses: your-org/actions-optimizer@v1
  with:
    workflow-dir: '.github/workflows'
```
