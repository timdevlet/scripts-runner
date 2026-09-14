// Release helpers driven by Taskfile.yml:
//   task tag -- 0.2.0   — tag an explicit version
//   task bump           — increment the patch version and tag it (0.1.0 → 0.1.1)
//   task push           — push the current branch and the latest release tag
//   task release        — bump and push in one step
//
// Tags are bare (`0.2.0`, no leading `v`) to match the sibling samsung-tv-control repo.
// package.json is the version of record and every tag matches it, so a bump moves both
// together in one commit. Lightweight tags are pushed explicitly by name — `--follow-tags`
// only pushes annotated ones and would silently skip these.

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LEVELS = ["patch", "minor", "major"];

function run(cmd) {
  console.log(`$ ${cmd}`);
  execSync(cmd, { cwd: root, stdio: "inherit" });
}

function capture(cmd) {
  return execSync(cmd, { cwd: root, encoding: "utf8" }).trim();
}

function fail(msg) {
  console.error(`release: ${msg}`);
  process.exit(1);
}

function parseVersion(value) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(value).trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function compare(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

function packageVersion() {
  const { version } = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const parsed = parseVersion(version);
  if (!parsed) fail(`package.json version "${version}" is not a semver version like 0.1.0`);
  return parsed;
}

// Every release tag, newest version first. Sorted by value rather than creation date so an
// out-of-order tag (hand-made, or pushed from another machine) can't hide a higher version.
function releaseTags() {
  return capture("git tag -l")
    .split("\n")
    .map((name) => ({ name, version: parseVersion(name) }))
    .filter((t) => t.version)
    .sort((a, b) => compare(b.version, a.version));
}

// The version a bump counts from: whichever is higher, package.json or the newest tag. They
// normally agree; taking the max means a bump after a hand-made tag still moves forward
// instead of colliding with a tag that already exists.
function baseVersion() {
  const fromPackage = packageVersion();
  const newestTag = releaseTags()[0];
  if (newestTag && compare(newestTag.version, fromPackage) > 0) return newestTag.version;
  return fromPackage;
}

function format([major, minor, patch]) {
  return `${major}.${minor}.${patch}`;
}

function next(version, level) {
  const [major, minor, patch] = version;
  if (level === "major") return [major + 1, 0, 0];
  if (level === "minor") return [major, minor + 1, 0];
  return [major, minor, patch + 1];
}

function requireCleanTree() {
  if (capture("git status --porcelain")) {
    fail("working tree is not clean — commit or stash first");
  }
}

function tag(versionArg) {
  if (!versionArg) fail("missing version — usage: task tag -- 0.2.0");
  const parsed = parseVersion(versionArg);
  if (!parsed) fail(`"${versionArg}" is not a semver version like 0.2.0`);
  const version = format(parsed);
  if (capture(`git tag -l ${version}`)) fail(`tag ${version} already exists`);
  requireCleanTree();

  run(`npm version ${version} --no-git-tag-version`);
  // npm rewrites package.json and package-lock.json; if they already said this version
  // there is nothing to commit and the tag just lands on the current commit.
  if (capture("git status --porcelain")) {
    run(`git commit -am "chore: release ${version}"`);
  } else {
    console.log(`release: already at ${version}, nothing to commit.`);
  }
  run(`git tag ${version}`);
  console.log(`release: tagged ${version}. Push it with: task push`);
  return version;
}

function bump(levelArg = "patch") {
  const level = String(levelArg).trim() || "patch";
  if (!LEVELS.includes(level)) fail(`unknown level "${level}" — use one of: ${LEVELS.join(", ")}`);
  // Checked before the bump is announced, so a dirty tree doesn't print a version change
  // that never happens.
  requireCleanTree();
  const from = baseVersion();
  const to = next(from, level);
  console.log(`release: ${level} bump ${format(from)} → ${format(to)}`);
  return tag(format(to));
}

function push() {
  const newest = releaseTags()[0];
  if (!newest) fail("no release tag to push — create one with `task bump` or `task tag -- 0.2.0`");
  const branch = capture("git rev-parse --abbrev-ref HEAD");
  // The branch goes first: a tag pointing at a commit the remote doesn't have yet would
  // otherwise leave the release referring to nothing on GitHub.
  run(`git push origin ${branch}`);
  run(`git push origin ${newest.name}`);
  console.log(`release: pushed ${branch} and tag ${newest.name}.`);
}

const [command, arg] = process.argv.slice(2);
switch (command) {
  case "tag":
    tag(arg);
    break;
  case "bump":
    bump(arg);
    break;
  case "push":
    push();
    break;
  case "release":
    bump(arg);
    push();
    break;
  default:
    fail(`unknown command "${command ?? ""}" — use tag, bump, push, or release`);
}
