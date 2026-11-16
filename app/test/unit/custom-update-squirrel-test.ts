import { describe, it } from 'node:test'
import assert from 'node:assert'
import {
  findInSquirrelReleases,
  IGitHubReleaseJson,
  selectSquirrelPackage,
  toCustomRelease,
} from '../../src/lib/custom-update'

const nupkgName = 'GitHubDesktopCustom-3.6.11-custom1-b00014-x64-full.nupkg'

const assets: IGitHubReleaseJson['assets'] = [
  nupkgName,
  'GitHubDesktopCustomSetup-x64.exe',
  'RELEASES',
].map(name => ({
  name,
  browser_download_url: `https://example.com/${name}`,
  size: name === nupkgName ? 123456 : 1,
}))

describe('Windows Squirrel updates', () => {
  it('picks the full package and RELEASES for Windows installs', () => {
    const pkg = selectSquirrelPackage(assets, 'windows-setup', 'x64')
    assert.equal(pkg?.nupkg.name, nupkgName)
    assert.equal(pkg?.releases.name, 'RELEASES')

    assert.equal(selectSquirrelPackage(assets, 'pacman', 'x64'), null)
    assert.equal(selectSquirrelPackage(assets, 'windows-setup', 'arm64'), null)
    assert.equal(
      selectSquirrelPackage(
        assets.filter(a => a.name !== 'RELEASES'),
        'windows-setup',
        'x64'
      ),
      null
    )
  })

  it('includes it in the release, keeping Setup.exe as the fallback', () => {
    const release = toCustomRelease(
      {
        tag_name: 'v3.6.11-custom1-b00014',
        name: null,
        body: null,
        html_url: 'https://example.com',
        published_at: null,
        draft: false,
        prerelease: false,
        assets,
      },
      'windows-setup',
      'win32',
      'x64'
    )
    assert.equal(release?.squirrelPackage?.nupkg.name, nupkgName)
    assert.equal(release?.asset?.name, 'GitHubDesktopCustomSetup-x64.exe')
  })

  it('finds the downloaded package in RELEASES, even renamed', () => {
    const sha1 = 'A'.repeat(40)
    // The real release: RELEASES names the package without "-x64".
    const listed = 'GitHubDesktopCustom-3.6.11-custom1-b00014-full.nupkg'
    const text = `﻿${sha1} ${listed} 123456\r\n`
    assert.deepEqual(findInSquirrelReleases(text, nupkgName, 123456), {
      sha1: 'a'.repeat(40),
      fileName: listed,
      size: 123456,
    })
    // Wrong size, or nothing listed: not ours.
    assert.equal(findInSquirrelReleases(text, nupkgName, 1), null)
    assert.equal(findInSquirrelReleases('', nupkgName, 123456), null)
    // Never a path.
    assert.equal(
      findInSquirrelReleases(
        `${sha1} ..\\evil-full.nupkg 123456`,
        nupkgName,
        123456
      ),
      null
    )
  })
})
