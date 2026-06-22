import { execSync } from "node:child_process";
import fs from "node:fs";

const workspacePackageJsonPattern =
  /^(apps|packages)\/[^/]+\/package\.json$/;

function getChangedWorkspacePackages() {
  const diff = execSync("git diff --name-only HEAD", {
    encoding: "utf8",
  }).trim();

  if (!diff) {
    return [];
  }

  return diff.split("\n").filter((file) => workspacePackageJsonPattern.test(file));
}

const changedPackageJsonFiles = getChangedWorkspacePackages();

if (changedPackageJsonFiles.length === 0) {
  console.log(
    "No workspace package versions changed; skipping root release version sync.",
  );
  process.exit(0);
}

const packageNames = changedPackageJsonFiles
  .map((file) => JSON.parse(fs.readFileSync(file, "utf8")).name)
  .sort();

const rootPkgPath = "package.json";
const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, "utf8"));
const [major, minor, patch] = rootPkg.version.split(".").map(Number);
const newVersion = `${major}.${minor}.${patch + 1}`;

rootPkg.version = newVersion;
fs.writeFileSync(rootPkgPath, `${JSON.stringify(rootPkg, null, 2)}\n`);

const changelogPath = "CHANGELOG.md";
const changelog = fs.readFileSync(changelogPath, "utf8");
const packageList = packageNames.join(", ");
const newSection = `## ${newVersion}

### Patch Changes

- Workspace release: ${packageList} (see package changelogs for details)

`;

if (!changelog.startsWith("# chat-app\n\n")) {
  console.error("Unexpected CHANGELOG.md format; cannot append root release entry.");
  process.exit(1);
}

fs.writeFileSync(
  changelogPath,
  changelog.replace("# chat-app\n\n", `# chat-app\n\n${newSection}`),
);

console.log(
  `Bumped root release version to ${newVersion} (${packageNames.length} workspace package(s) updated).`,
);
