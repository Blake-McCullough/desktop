# GitHub Desktop Custom

A customised build of [GitHub Desktop](https://github.com/desktop/desktop)
with repository groups, GitLab CI/CD pipeline status, a Fork-style history
graph, and other workflow improvements. It installs as a separate app
(**GitHub Desktop Custom**), so it can sit alongside the official GitHub
Desktop.

**[Download the latest release](https://github.com/Blake-McCullough/desktop/releases/latest)**

| Platform | Download | Install |
| --- | --- | --- |
| Windows | `GitHubDesktopCustomSetup-x64.exe` | Run it. It isn't code-signed, so SmartScreen will warn you the first time: choose **More info → Run anyway**. |
| Arch Linux, CachyOS, Manjaro, EndeavourOS | `github-desktop-custom-bin-….pkg.tar.zst` | `sudo pacman -U github-desktop-custom-bin-*.pkg.tar.zst` — then launch **GitHub Desktop Custom** from your app menu, or run `github-desktop-custom`. |
| Other Linux | `GitHubDesktopCustom-…-x64.AppImage` | `chmod +x` it and run it. |
| Other Linux (no AppImage) | `GitHubDesktopCustom-…-linux-x64.tar.gz` | Extract and run `github-desktop-custom/github-desktop-custom`. |

On Linux, sign-in and tokens are stored in your keyring, so `libsecret`
(and a keyring such as GNOME Keyring or KWallet) needs to be available —
the Arch package pulls `libsecret` in automatically.

## Updating

The app checks this repository's releases for a newer version shortly after
it starts and every few hours, and shows a banner when one is available.
You can also use **Help → Check for updates…**. **Update now** downloads and
installs the right file for how you installed it, then restarts:

- **Windows** — runs the new installer.
- **Arch / CachyOS package** — installs it with `pacman`, asking for your
  password through the desktop's normal prompt.
- **AppImage** — replaces the AppImage file in place.

A copy extracted from the `.tar.gz` can't update itself; the update window
links to the release instead. Automatic checks can be turned off in the
update window.

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

- **Sidebar**: a dot per job for the latest commit you've pushed on the
  current branch; running jobs pulse, and clicking a dot opens the job in
  GitLab. Manual jobs show a **▶ Run** button. Right after a push, the
  sidebar waits for that commit's pipeline rather than showing an older one.
- **History**: a dot per job for every commit; click to open the pipeline.
- **Clone from GitLab**: **File → Clone repository → GitLab** lists every
  project your token can see, grouped by GitLab group and subgroup, with a
  filter and an instance picker if you use more than one instance. Cloning
  over HTTPS uses your token, so there's no password prompt. The clone is
  added to a sidebar group named after its GitLab group (you can rename it or
  untick the box).
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

### Windows

Requirements:

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

### Linux

Requirements: Node.js (the version in [`.node-version`](./.node-version)),
npm 11.17+, Python 3, a C/C++ toolchain, and `libsecret` headers — on Arch /
CachyOS: `sudo pacman -S --needed base-devel python libsecret`.

```sh
git clone --recurse-submodules https://github.com/Blake-McCullough/desktop.git
cd desktop
npm ci
npm run build:prod
npm run package
```

This writes to `dist/`:

- `github-desktop-custom-linux-x64/github-desktop-custom` — the app, ready to
  run;
- `GitHubDesktopCustom-<version>-linux-x64.tar.gz` and a `PKGBUILD` next to
  it — on Arch-based systems, `cd dist && makepkg -si` builds and installs a
  pacman package from them;
- an AppImage, if `APPIMAGETOOL` points at
  [appimagetool](https://github.com/AppImage/appimagetool).

Settings live in `~/.config/GitHub Desktop Custom`.

## Releasing

Every push to `main` is released automatically. The **Auto release (main)**
workflow builds the Windows installer, the Linux AppImage and tarball, and an
Arch Linux package on GitHub Actions, and publishes them as a new GitHub
release, usually within 15–20 minutes:

- Version: the `version` in [`app/package.json`](./app/package.json) plus a
  build number, e.g. `3.6.11-custom1-b00042` (tag `v3.6.11-custom1-b00042`).
- Release notes list the commits since the previous release.
- Changes that only touch Markdown files or `docs/` don't trigger a release.
- If several commits are pushed close together, only the newest is built.

To start a new version series (for example after merging a new upstream
release), change `version` in `app/package.json`.

You can also publish a release by hand — **Releases → Draft a new release**
with a new tag — and the **Release (custom build)** workflow will build and
attach the installers to it.

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
