import { describe, it } from 'node:test'
import assert from 'node:assert'
import {
  IGitHubReleaseJson,
  isNewerVersion,
  selectAsset,
  summarizeReleaseNotes,
  toCustomRelease,
  versionFromTag,
} from '../../src/lib/custom-update'

const assets: IGitHubReleaseJson['assets'] = [
  'github-desktop-custom-bin-3.6.11.custom1.b00006-1-x86_64.pkg.tar.zst',
  'GitHubDesktopCustom-3.6.11-custom1-b00006-linux-x64.tar.gz',
  'GitHubDesktopCustom-3.6.11-custom1-b00006-x64-full.nupkg',
  'GitHubDesktopCustom-3.6.11-custom1-b00006-x64.AppImage',
  'GitHubDesktopCustomSetup-x64.exe',
  'GitHubDesktopCustomSetup-x64.msi',
  'PKGBUILD',
  'RELEASES',
].map(name => ({
  name,
  browser_download_url: `https://example.com/${name}`,
  size: 1,
}))

describe('custom updates', () => {
  it('reads the SHA-256 GitHub publishes for a file', () => {
    const withDigest: IGitHubReleaseJson['assets'] = [
      {
        name: 'GitHubDesktopCustomSetup-x64.exe',
        browser_download_url: 'https://example.com/setup.exe',
        size: 5,
        digest: `sha256:${'AB'.repeat(32)}`,
      },
    ]
    assert.equal(
      selectAsset(withDigest, 'windows-setup', 'win32', 'x64')?.sha256,
      'ab'.repeat(32)
    )
    assert.equal(
      selectAsset(assets, 'windows-setup', 'win32', 'x64')?.sha256,
      null
    )
  })

  it('reads versions from release tags', () => {
    assert.equal(
      versionFromTag('v3.6.11-custom1-b00006'),
      '3.6.11-custom1-b00006'
    )
    assert.equal(versionFromTag('not-a-version'), null)
  })

  it('orders build numbers and version series', () => {
    assert.equal(
      isNewerVersion('3.6.11-custom1-b00006', '3.6.11-custom1-b00005'),
      true
    )
    assert.equal(
      isNewerVersion('3.6.11-custom1-b00010', '3.6.11-custom1-b00009'),
      true
    )
    assert.equal(
      isNewerVersion('3.6.11-custom1-b00005', '3.6.11-custom1-b00005'),
      false
    )
    assert.equal(
      isNewerVersion('3.6.11-custom1-b00004', '3.6.11-custom1-b00005'),
      false
    )
    // A local build without a build number is older than any release of it.
    assert.equal(
      isNewerVersion('3.6.11-custom1-b00001', '3.6.11-custom1'),
      true
    )
    // A new upstream base wins over any build of the old one.
    assert.equal(
      isNewerVersion('3.6.12-custom1-b00001', '3.6.11-custom1-b00099'),
      true
    )
    assert.equal(isNewerVersion('garbage', '3.6.11'), false)
  })

  it('picks the right file for each kind of install', () => {
    const pick = (
      kind: Parameters<typeof selectAsset>[1],
      platform: NodeJS.Platform
    ) => selectAsset(assets, kind, platform, 'x64')?.name

    assert.equal(
      pick('windows-setup', 'win32'),
      'GitHubDesktopCustomSetup-x64.exe'
    )
    assert.equal(
      pick('pacman', 'linux'),
      'github-desktop-custom-bin-3.6.11.custom1.b00006-1-x86_64.pkg.tar.zst'
    )
    assert.equal(
      pick('appimage', 'linux'),
      'GitHubDesktopCustom-3.6.11-custom1-b00006-x64.AppImage'
    )
    assert.equal(
      pick('manual', 'linux'),
      'GitHubDesktopCustom-3.6.11-custom1-b00006-linux-x64.tar.gz'
    )
    assert.equal(pick('manual', 'darwin'), undefined)
  })

  it('ignores drafts and non-version tags', () => {
    const base = {
      name: 'x',
      body: 'notes',
      html_url: 'https://example.com',
      published_at: '2026-11-12T00:00:00Z',
      prerelease: false,
      assets,
    }
    assert.equal(
      toCustomRelease(
        { ...base, tag_name: 'v3.6.11-custom1-b00006', draft: true },
        'pacman',
        'linux',
        'x64'
      ),
      null
    )
    assert.equal(
      toCustomRelease(
        { ...base, tag_name: 'nightly', draft: false },
        'pacman',
        'linux',
        'x64'
      ),
      null
    )
    const release = toCustomRelease(
      { ...base, tag_name: 'v3.6.11-custom1-b00006', draft: false },
      'pacman',
      'linux',
      'x64'
    )
    assert.equal(release?.version, '3.6.11-custom1-b00006')
    assert.ok(release?.asset?.name.endsWith('.pkg.tar.zst'))
  })

  it('shows only the list of changes from the release notes', () => {
    const body = [
      'Built automatically from abc on main.',
      '',
      '### Install',
      '',
      '- **Windows:** run `Setup.exe`.',
      '',
      '### Changes since v3.6.11-custom1-b00005',
      '',
      '- Fix the **sidebar** (abc1234)',
      '- Add `updater` (def5678)',
    ].join('\n')
    assert.equal(
      summarizeReleaseNotes(body),
      '• Fix the sidebar (abc1234)\n• Add updater (def5678)'
    )
  })
})
