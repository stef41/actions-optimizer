const core = require("@actions/core");
const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

const OPTIMIZATIONS = [
  {
    id: "OPT001",
    name: "missing-cache",
    category: "caching",
    impact: "high",
    check: (workflow) => {
      const findings = [];
      const jobs = workflow.jobs || {};
      for (const [jobName, job] of Object.entries(jobs)) {
        const steps = job.steps || [];
        const hasCache = steps.some(
          (s) => s.uses && (s.uses.includes("actions/cache") || s.uses.includes("actions/setup-node")),
        );
        const hasInstall = steps.some(
          (s) => s.run && /\b(npm\s+(ci|install)|yarn\s+install|pip\s+install|poetry\s+install|cargo\s+build|go\s+build|bundle\s+install|composer\s+install)\b/.test(s.run),
        );
        if (hasInstall && !hasCache) {
          findings.push({
            job: jobName,
            message: "Package installation detected without cache step",
            suggestion: "Add actions/cache or use setup-* action with built-in caching",
            savingsEstimate: "30-60% of install time",
          });
        }
      }
      return findings;
    },
  },
  {
    id: "OPT002",
    name: "sequential-independent-jobs",
    category: "parallelization",
    impact: "high",
    check: (workflow) => {
      const findings = [];
      const jobs = workflow.jobs || {};
      const jobNames = Object.keys(jobs);
      const dependencyChains = [];

      for (const [jobName, job] of Object.entries(jobs)) {
        const needs = job.needs
          ? Array.isArray(job.needs) ? job.needs : [job.needs]
          : [];
        if (needs.length > 0) {
          dependencyChains.push({ job: jobName, needs });
        }
      }

      // Find jobs with same dependencies that could run in parallel
      const independentJobs = jobNames.filter(
        (name) => !jobs[name].needs,
      );

      // Check if all jobs have no needs (sequential by default would be parallel anyway)
      // But check for single-job workflows doing multiple things
      for (const [jobName, job] of Object.entries(jobs)) {
        const steps = job.steps || [];
        if (steps.length > 8) {
          // Check if steps could be split into parallel jobs
          const stepGroups = { build: [], test: [], lint: [], deploy: [] };
          for (const step of steps) {
            const name = (step.name || step.run || "").toLowerCase();
            if (name.includes("build") || name.includes("compile")) stepGroups.build.push(step);
            else if (name.includes("test") || name.includes("spec")) stepGroups.test.push(step);
            else if (name.includes("lint") || name.includes("format") || name.includes("check")) stepGroups.lint.push(step);
          }
          const nonEmptyGroups = Object.entries(stepGroups).filter(([, v]) => v.length > 0);
          if (nonEmptyGroups.length >= 2) {
            findings.push({
              job: jobName,
              message: `Job has ${steps.length} steps mixing ${nonEmptyGroups.map(([k]) => k).join(", ")}`,
              suggestion: "Split into parallel jobs: lint and test can run simultaneously",
              savingsEstimate: "20-50% of total pipeline time",
            });
          }
        }
      }
      return findings;
    },
  },
  {
    id: "OPT003",
    name: "duplicate-checkout",
    category: "redundancy",
    impact: "low",
    check: (workflow) => {
      const findings = [];
      const jobs = workflow.jobs || {};
      for (const [jobName, job] of Object.entries(jobs)) {
        const steps = job.steps || [];
        const checkouts = steps.filter(
          (s) => s.uses && s.uses.includes("actions/checkout"),
        );
        if (checkouts.length > 1) {
          findings.push({
            job: jobName,
            message: `${checkouts.length} checkout steps in single job`,
            suggestion: "Consolidate to a single checkout step",
            savingsEstimate: "5-10 seconds per extra checkout",
          });
        }
      }
      return findings;
    },
  },
  {
    id: "OPT004",
    name: "missing-path-filter",
    category: "skip-logic",
    impact: "high",
    check: (workflow) => {
      const triggers = workflow.on || {};
      const hasPush = typeof triggers === "object" && ("push" in triggers || "pull_request" in triggers);
      if (!hasPush) return [];

      // Check if workflow has path filters
      const pushConfig = triggers.push || {};
      const prConfig = triggers.pull_request || {};
      const hasPathFilter = pushConfig.paths || prConfig.paths;

      if (!hasPathFilter) {
        // Check if the workflow is specific to certain languages/tools
        const jobs = workflow.jobs || {};
        const allSteps = Object.values(jobs).flatMap((j) => j.steps || []);
        const isSpecific = allSteps.some(
          (s) => s.run && /\b(npm|yarn|pip|cargo|go|bundle|gradle|mvn)\b/.test(s.run),
        );
        if (isSpecific) {
          return [{
            message: "Workflow runs on all pushes but only processes specific file types",
            suggestion: "Add 'paths' filter to trigger only on relevant file changes",
            savingsEstimate: "Skips 30-70% of unnecessary runs",
          }];
        }
      }
      return [];
    },
  },
  {
    id: "OPT005",
    name: "expensive-runner",
    category: "cost",
    impact: "medium",
    check: (workflow) => {
      const findings = [];
      const jobs = workflow.jobs || {};
      for (const [jobName, job] of Object.entries(jobs)) {
        const runsOn = JSON.stringify(job["runs-on"] || "");
        if (runsOn.includes("macos") || runsOn.includes("windows")) {
          // Check if the job actually needs the specific OS
          const steps = job.steps || [];
          const needsOS = steps.some(
            (s) => s.run && /\b(xcodebuild|xcrun|swift|msbuild|dotnet|choco)\b/.test(s.run),
          );
          if (!needsOS) {
            findings.push({
              job: jobName,
              message: `Uses ${runsOn} runner but may not need OS-specific features`,
              suggestion: "Use ubuntu-latest (10x cheaper than macOS, 2x cheaper than Windows)",
              savingsEstimate: "50-90% cost reduction for this job",
            });
          }
        }
      }
      return findings;
    },
  },
  {
    id: "OPT006",
    name: "missing-concurrency",
    category: "skip-logic",
    impact: "medium",
    check: (workflow) => {
      if (workflow.concurrency) return [];
      const triggers = workflow.on || {};
      if (typeof triggers === "object" && ("push" in triggers || "pull_request" in triggers)) {
        return [{
          message: "No concurrency control — multiple runs stack up on rapid pushes",
          suggestion: "Add concurrency group to cancel in-progress runs on new pushes",
          savingsEstimate: "Prevents wasted minutes from superseded runs",
        }];
      }
      return [];
    },
  },
  {
    id: "OPT007",
    name: "timeout-missing",
    category: "cost",
    impact: "medium",
    check: (workflow) => {
      const findings = [];
      const jobs = workflow.jobs || {};
      for (const [jobName, job] of Object.entries(jobs)) {
        if (!job["timeout-minutes"]) {
          findings.push({
            job: jobName,
            message: "No timeout-minutes set (default is 360 minutes = 6 hours!)",
            suggestion: "Add timeout-minutes to prevent runaway jobs from burning credits",
            savingsEstimate: "Prevents worst-case 6h billing on stuck jobs",
          });
        }
      }
      return findings;
    },
  },
  {
    id: "OPT008",
    name: "fetch-depth-optimization",
    category: "performance",
    impact: "low",
    check: (workflow) => {
      const findings = [];
      const jobs = workflow.jobs || {};
      for (const [jobName, job] of Object.entries(jobs)) {
        const steps = job.steps || [];
        for (const step of steps) {
          if (step.uses && step.uses.includes("actions/checkout")) {
            const withBlock = step.with || {};
            if (!withBlock["fetch-depth"]) {
              const needsHistory = steps.some(
                (s) => s.run && /\b(git\s+log|git\s+blame|git\s+diff|changelog)\b/.test(s.run),
              );
              if (!needsHistory) {
                findings.push({
                  job: jobName,
                  message: "Full git history fetched but may not be needed",
                  suggestion: "Add fetch-depth: 1 for shallow clone (faster checkout)",
                  savingsEstimate: "5-30 seconds depending on repo size",
                });
              }
            }
          }
        }
      }
      return findings;
    },
  },
];

async function run() {
  const workflowDir = core.getInput("workflow-dir");
  const minSavings = parseInt(core.getInput("min-savings-threshold"));

  const workflowPath = path.resolve(workflowDir);
  if (!fs.existsSync(workflowPath)) {
    core.warning(`Workflow directory not found: ${workflowPath}`);
    return;
  }

  const files = fs.readdirSync(workflowPath).filter(
    (f) => f.endsWith(".yml") || f.endsWith(".yaml"),
  );

  let allFindings = [];
  for (const file of files) {
    const filePath = path.join(workflowPath, file);
    const content = fs.readFileSync(filePath, "utf8");
    let workflow;
    try {
      workflow = yaml.load(content);
    } catch {
      continue;
    }
    if (!workflow || typeof workflow !== "object") continue;

    for (const opt of OPTIMIZATIONS) {
      const findings = opt.check(workflow);
      for (const finding of findings) {
        allFindings.push({
          file,
          ...finding,
          rule: opt.id,
          name: opt.name,
          category: opt.category,
          impact: opt.impact,
        });
      }
    }
  }

  core.setOutput("optimization-count", allFindings.length.toString());
  core.setOutput("report", JSON.stringify(allFindings));

  // Generate summary
  core.summary.addHeading("⚡ Actions Optimizer Report", 2);
  core.summary.addRaw(`Analyzed **${files.length}** workflow files\n\n`);

  if (allFindings.length === 0) {
    core.summary.addRaw("✅ No optimizations found — workflows look good!\n");
  } else {
    const byCategory = {};
    for (const f of allFindings) {
      byCategory[f.category] = (byCategory[f.category] || 0) + 1;
    }
    core.summary.addTable([
      [{ data: "Category", header: true }, { data: "Findings", header: true }],
      ...Object.entries(byCategory).map(([k, v]) => [k, v.toString()]),
    ]);

    core.summary.addHeading("Recommendations", 3);
    for (const finding of allFindings) {
      const icon = finding.impact === "high" ? "🔴" : finding.impact === "medium" ? "🟡" : "🟢";
      core.summary.addRaw(
        `${icon} **[${finding.rule}]** ${finding.message}\n` +
        (finding.file ? `  - File: \`${finding.file}\`` : "") +
        (finding.job ? ` | Job: \`${finding.job}\`` : "") + "\n" +
        `  - 💡 ${finding.suggestion}\n` +
        `  - 📊 ${finding.savingsEstimate}\n\n`,
      );
    }
  }

  await core.summary.write();
}

run().catch((error) => core.setFailed(error.message));
