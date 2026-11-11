# GitHub Desktop Custom

A customised build of [GitHub Desktop](https://github.com/desktop/desktop)
with repository groups, GitLab CI/CD pipeline status, a Fork-style history
graph, and other workflow improvements. It installs as a separate app
(**GitHub Desktop Custom**), so it can sit alongside the official GitHub
Desktop.

**[Download the latest release](https://github.com/Blake-McCullough/desktop/releases/latest)**
— run `GitHubDesktopCustomSetup-x64.exe`.

> The installer isn't code-signed, so Windows SmartScreen will warn you the
> first time. Choose **More info → Run anyway**.

## Features

### Repositories sidebar

- An always-visible, resizable, collapsible list of your repositories.
- **Groups with colours**: create groups, drag repositories between them,
  and give each group a colour.
- **Filter box** to find a repository quickly (Enter opens the first match).
- Keyboard accessible; collapse or expand all groups from a group's
  right-click menu.

### Import and export repositories

From the sidebar's **+** menu:

- **Export repositories…** saves every repository's location, remotes,
  alias, group and group colour to a JSON file.
- **Import repositories…** reads that file on another computer (or after a
  reinstall). You can choose a new base folder — the folder structure below
  it is kept — and the import adds repositories already on disk, clones the
  missing ones, and recreates your groups.

### GitLab CI/CD pipelines

Set a personal access token in **Preferences → GitLab** (`read_api` to view,
`api` to also run manual jobs).

- **Sidebar**: a dot per job for each repository's current commit; running
  jobs pulse, and clicking a dot opens the job in GitLab. Manual jobs show a
  **▶ Run** button. If the checked-out commit has no pipeline yet, the
  branch's latest pipeline is shown with a dashed outline.
- **History**: a dot per job for every commit; click to open the pipeline.
- **Self-hosted GitLab**: hosts with "gitlab" in the name are detected
  automatically, other servers are detected by asking them, and you can list
  instances (including ones on a sub path) in Preferences.
- **Rate-limit friendly**: one request per project lists recent pipelines
  for every repository and commit, jobs are only re-fetched when a pipeline
  changes, and idle repositories are checked every 5–10 minutes. If GitLab
  rate limits anyway, updates pause until GitLab's reset time and the
  sidebar says when they'll resume.
- **Test token** in Preferences shows which user and scopes the token has.

### History graph

**View → History graph** (`Ctrl+Alt+G`), or right-click a repository →
**View history graph…**

- All branches (or just the current one) drawn as coloured lanes, with
  merges and branch points connected — similar to Fork.
- Branch labels in their lane's colour, a ✓ on the checked-out branch, a
  cloud when a branch matches its remote, plus remote-only branches and
  tags.
- Commits that aren't on the current branch are dimmed.
- Search by message, author, SHA, branch or tag; keyboard navigation.
- Select a commit to see its full message and changed files.

### Tag colours

**Preferences → Tag colors** maps regular expressions to colours, e.g.
`^Pushed_To_Test` → green. Matching tags are highlighted in History and the
history graph.

### Worktrees

Right-click a repository → **View worktrees…** to see every worktree with
its branch, latest commit, uncommitted changes and ahead/behind state, and
to switch to, open, or remove them.

### Reliability

- If the window's renderer crashes (for example after the computer sleeps),
  the window reloads itself instead of going blank.
- If the app stops responding, you're offered a reload.

## Building it yourself

Requirements (Windows):

- [Node.js](https://nodejs.org/) — the version in [`.node-version`](./.node-version)
- npm 11.17 or newer: `npm install -g npm@latest`
- Python 3
- Visual Studio 2022 Build Tools with **Desktop development with C++**

```powershell
git clone --recurse-submodules https://github.com/Blake-McCullough/desktop.git
cd desktop
npm ci
npm run build:prod
npm run package
```

The installer is written to `dist\GitHubDesktopCustomSetup-x64.exe`, and the
unpacked app to `dist\GitHubDesktopCustom-win32-x64\GitHubDesktopCustom.exe`.

Settings and repository lists live in `%APPDATA%\GitHub Desktop Custom`, so
reinstalling or upgrading keeps them.

## Releasing

1. Bump `version` in [`app/package.json`](./app/package.json) (for example
   `3.6.11-custom2`) and push it.
2. On GitHub, go to **Releases → Draft a new release**, create a new tag
   (`v3.6.11-custom2`) on `main`, and **Publish release**.

The **Release (custom build)** workflow then builds the Windows installer on
GitHub Actions and attaches it to the release, usually within 20–30
minutes. To rebuild an existing release, run the workflow from the
**Actions** tab and enter its tag.

## Keeping up with upstream

```sh
git remote add upstream https://github.com/desktop/desktop.git
git fetch upstream
git merge upstream/development
```

## Credits and licence

Based on [GitHub Desktop](https://github.com/desktop/desktop) by GitHub,
released under the [MIT licence](./LICENSE). This build isn't affiliated
with or supported by GitHub.
