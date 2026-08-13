import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Result } from "effect";
import { CliError, EXIT } from "./core";
import { parsePiPackageName } from "./sandbox-sources";

export interface GitPackageResolution {
  readonly commit: string;
  readonly name: string;
}

const GIT_COMMIT_PATTERN = /^[0-9a-f]{40}$/u;

const sandboxGitRefInvalid = (message: string, hint: string): CliError =>
  new CliError("sandbox_git_ref_invalid", message, hint, EXIT.USAGE);

const sandboxSourceAuthFailed = (): CliError =>
  new CliError(
    "sandbox_source_auth_failed",
    "Git authentication failed for the package repository",
    "Use your normal local Git credentials, then retry scotty sandbox add.",
    EXIT.AUTH,
  );

const sandboxPackageUnsupported = (message: string, hint: string): CliError =>
  new CliError("sandbox_package_unsupported", message, hint, EXIT.USAGE);

const redactGitText = (value: string): string =>
  value.replace(/https:\/\/[^/\s]*@/gu, "https://").replace(/ssh:\/\/[^@/\s]+@/gu, "ssh://git@");

const runGit = async (
  args: ReadonlyArray<string>,
  cwd?: string,
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> => {
  const child = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "true",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
};

const failFromGit = (stderr: string, fallback: CliError): CliError => {
  const redacted = redactGitText(stderr).toLowerCase();
  if (
    redacted.includes("authentication") ||
    redacted.includes("permission denied") ||
    redacted.includes("could not read username") ||
    redacted.includes("terminal prompts disabled") ||
    redacted.includes("could not read password")
  )
    return sandboxSourceAuthFailed();
  return fallback;
};

const resolveCommitFromLsRemote = (stdout: string, requestedRef: string): string => {
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.some((line) => /\trefs\/heads\//u.test(line))) {
    // oxlint-disable-next-line scotty/no-try-catch-or-throw -- boundary: Promise Git adapter rejects floating branches before clone
    throw sandboxGitRefInvalid(
      "Git package sources cannot use a moving branch",
      "Pass an explicit tag or full commit SHA with --ref.",
    );
  }
  const peeled = lines.find((line) => line.endsWith("^{}"));
  const selected = peeled ?? lines[0];
  const commit = selected?.slice(0, 40).toLowerCase();
  if (commit === undefined || !GIT_COMMIT_PATTERN.test(commit)) {
    // oxlint-disable-next-line scotty/no-try-catch-or-throw -- boundary: Promise Git adapter rejects unresolved refs before clone
    throw sandboxGitRefInvalid(
      `Git ref ${requestedRef} did not resolve to a commit`,
      "Pass an explicit tag or full commit SHA with --ref.",
    );
  }
  return commit;
};

export async function resolveGitPackage(
  repository: string,
  requestedRef: string,
): Promise<GitPackageResolution> {
  const explicitCommit = GIT_COMMIT_PATTERN.test(requestedRef) ? requestedRef : undefined;
  const listed = await runGit(["ls-remote", "--exit-code", repository, requestedRef]);
  if (listed.exitCode !== 0 && explicitCommit === undefined) {
    // oxlint-disable-next-line scotty/no-try-catch-or-throw -- boundary: Promise Git adapter maps ls-remote failure to a typed CLI error
    throw failFromGit(
      listed.stderr,
      sandboxGitRefInvalid(
        `Git ref ${requestedRef} did not resolve to a commit`,
        "Pass an explicit tag or full commit SHA with --ref.",
      ),
    );
  }
  const commit =
    explicitCommit ??
    (listed.exitCode === 0 ? resolveCommitFromLsRemote(listed.stdout, requestedRef) : undefined);
  if (commit === undefined) {
    // oxlint-disable-next-line scotty/no-try-catch-or-throw -- boundary: Promise Git adapter rejects unresolved refs before clone
    throw sandboxGitRefInvalid(
      `Git ref ${requestedRef} did not resolve to a commit`,
      "Pass an explicit tag or full commit SHA with --ref.",
    );
  }
  const root = await mkdtemp(join(tmpdir(), "scotty-sandbox-git-"));
  // oxlint-disable-next-line scotty/no-try-catch-or-throw -- boundary: Promise Git adapter must remove its staging copy on every exit
  try {
    const initialized = await runGit(["init", "--quiet"], root);
    if (initialized.exitCode !== 0) {
      // oxlint-disable-next-line scotty/no-try-catch-or-throw -- boundary: Promise Git adapter rejects staging failure before checkout
      throw sandboxPackageUnsupported(
        "Could not prepare a Git staging directory",
        "Retry scotty sandbox add after checking local Git.",
      );
    }
    const fetched = await runGit(
      ["fetch", "--quiet", "--depth", "1", "--no-tags", repository, commit],
      root,
    );
    if (fetched.exitCode !== 0) {
      // oxlint-disable-next-line scotty/no-try-catch-or-throw -- boundary: Promise Git adapter maps fetch failure to a typed CLI error
      throw failFromGit(
        fetched.stderr,
        sandboxGitRefInvalid(
          `Git commit ${commit} could not be fetched`,
          "Confirm the repository and --ref, then retry.",
        ),
      );
    }
    const checkedOut = await runGit(["checkout", "--quiet", "--detach", "FETCH_HEAD"], root);
    if (checkedOut.exitCode !== 0) {
      // oxlint-disable-next-line scotty/no-try-catch-or-throw -- boundary: Promise Git adapter rejects checkout failure before package decode
      throw sandboxGitRefInvalid(
        `Git commit ${commit} could not be checked out`,
        "Confirm the repository and --ref, then retry.",
      );
    }
    const head = await runGit(["rev-parse", "HEAD"], root);
    const resolved = head.stdout.trim().toLowerCase();
    if (head.exitCode !== 0 || resolved !== commit) {
      // oxlint-disable-next-line scotty/no-try-catch-or-throw -- boundary: Promise Git adapter rejects HEAD mismatch before package decode
      throw sandboxGitRefInvalid(
        "Checked-out Git HEAD did not match the resolved commit",
        "Retry scotty sandbox add with an explicit commit SHA.",
      );
    }
    let manifest: string | undefined;
    // oxlint-disable-next-line scotty/no-try-catch-or-throw -- boundary: Promise Git adapter treats a missing root package.json as unsupported
    try {
      manifest = await readFile(join(root, "package.json"), "utf8");
    } catch {
      manifest = undefined;
    }
    if (manifest === undefined) {
      // oxlint-disable-next-line scotty/no-try-catch-or-throw -- boundary: Promise Git adapter rejects missing package.json as unsupported
      throw sandboxPackageUnsupported(
        "Pi package repository must contain package.json at the root",
        "v1 does not support monorepo subpaths.",
      );
    }
    const name = parsePiPackageName(manifest);
    if (Result.isFailure(name)) {
      // oxlint-disable-next-line scotty/no-try-catch-or-throw -- boundary: Promise Git adapter rejects an invalid package name as unsupported
      throw sandboxPackageUnsupported(
        "Pi package.json must declare a valid package name",
        "Check the repository at the resolved commit.",
      );
    }
    return { commit, name: name.success };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
