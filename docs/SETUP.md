# Skipper — Beta Tester Setup

Thanks for trying Skipper. These are unsigned beta builds, so expect one extra
click to get past your OS's security prompt. This guide walks you from download
to a working setup.

## 1. Download

Go to the [Releases page](https://github.com/cicababba/skipper/releases) and grab
the latest **pre-release** (marked _Pre-release_, tagged `v0.1.0-beta.N`):

- **Windows** — the `.exe` (x64).
- **macOS** — the `.dmg` (**Apple Silicon only** — M1 or newer; Intel Macs are not built).

## 2. Get past the unsigned-binary warning

These builds aren't code-signed, so your OS will warn you the first time.

**Windows** — SmartScreen shows "Windows protected your PC". Click **More info**,
then **Run anyway**.

**macOS** — Gatekeeper blocks the first launch. Open the app once (it gets
refused), then go to **System Settings → Privacy & Security**, scroll to the
message about Skipper being blocked, and click **Open Anyway**. Confirm on the
next prompt.

## 3. Install the `claude` CLI (required)

Skipper drives the `claude` CLI for all LLM work and ships **no** LLM
credentials of its own. Before using Skipper:

1. Install the `claude` CLI (see Anthropic's Claude Code docs).
2. Run `claude` once and log in with your own Anthropic account.

Each tester uses their own account — Skipper reuses whatever auth the CLI has.

## 4. Link your provider accounts

In Skipper, open **Settings → Accounts** and connect the trackers / code hosts
you use:

- **GitHub** — installs the Skipper GitHub App; pick which repositories to grant
  it access to.
- **GitLab** (gitlab.com)
- **Jira** (Jira Cloud)
- **Bitbucket** (Bitbucket Cloud)

There is no Google sign-in in the beta.

## 5. Link repositories and set the base branch

Link the repositories you want Skipper to work on. For each repo, check the
**base branch**:

- By default it derives from the repo's `origin/HEAD`.
- If you use gitflow (work integrates on `develop`, not `main`), set the base
  branch to `develop` explicitly so plans and PRs target the right branch.

## 6. Known limitation: no auto-update

Beta builds do **not** self-update. When a new prerelease is published, download
and install it manually from the Releases page.

## Appendix — building from source (contributors)

If you'd rather run from source instead of a prebuilt binary:

```bash
# Node 20+, pnpm
pnpm install
pnpm desktop:build
pnpm --filter @skipper/desktop start
```

Source builds run with placeholder OAuth credentials, so provider sign-in shows
as "unconfigured" until you supply your own clients. See
[`apps/desktop/src/auth/oauth-config.example.ts`](../apps/desktop/src/auth/oauth-config.example.ts)
and the OAuth section of the [README](../README.md#oauth-credentials-optional).
