import { afterEach, beforeEach, describe, it, mock } from 'node:test'
import assert from 'node:assert'
import { ipcRenderer } from 'electron'
import { TestStatsDatabase } from '../helpers/databases'

import { StatsStore } from '../../src/lib/stats'
import { TestActivityMonitor } from '../helpers/test-activity-monitor'
import { fakePost } from '../fake-stats-post'
import { TokenRefreshEvent } from '../../src/lib/credential-sessions'
import { buildStatsPayload } from '../../src/lib/stats/stats-store'

describe('StatsStore', () => {
  async function createStatsDb() {
    const statsDb = new TestStatsDatabase()
    await statsDb.reset()
    return statsDb
  }
  let statsDb: TestStatsDatabase

  beforeEach(() => {
    const invoke = ipcRenderer.invoke
    mock.method(
      ipcRenderer,
      'invoke',
      async (channel: string, ...args: unknown[]) =>
        channel === 'get-notifications-permission'
          ? 'granted'
          : invoke(channel, ...args)
    )
  })

  afterEach(() => {
    mock.restoreAll()
    statsDb.close()
    localStorage.removeItem('has-sent-stats-opt-in-ping')
    localStorage.removeItem('last-daily-stats-report')
  })

  it("unsubscribes from the activity monitor when it's no longer needed", async () => {
    statsDb = await createStatsDb()
    const activityMonitor = new TestActivityMonitor()

    new StatsStore(statsDb, activityMonitor, fakePost)

    assert.equal(activityMonitor.subscriptionCount, 1)

    activityMonitor.fakeMouseActivity()

    assert.equal(activityMonitor.subscriptionCount, 0)

    // Use a read-write transaction to ensure that the write operation
    // from the StatsStore has completed before we try reading the table.
    await statsDb.transaction('rw!', statsDb.dailyMeasures, async () => {
      const statsEntry = await statsDb.dailyMeasures.limit(1).first()
      assert(statsEntry?.active === true)
    })
  })

  it('resubscribes to the activity monitor after submitting', async () => {
    statsDb = await createStatsDb()
    const activityMonitor = new TestActivityMonitor()

    const store = new StatsStore(statsDb, activityMonitor, fakePost)

    assert.equal(activityMonitor.subscriptionCount, 1)

    activityMonitor.fakeMouseActivity()

    assert.equal(activityMonitor.subscriptionCount, 0)

    // HACK: The stats store is hard coded to bail out of the
    // reporting method if running in a test-environment so
    // we'll have to pull an ugly workaround here and call
    // the instance member that we know for sure gets called
    // after stats submission
    await store.clearDailyStats()
    assert.equal(activityMonitor.subscriptionCount, 1)
  })

  it('tracks GitHub Copilot app handoffs', async () => {
    statsDb = await createStatsDb()
    const store = new StatsStore(statsDb, new TestActivityMonitor(), fakePost)

    await store.increment('openInCopilotAppCount')

    const statsEntry = await statsDb.dailyMeasures.limit(1).first()
    assert.strictEqual(statsEntry?.openInCopilotAppCount, 1)
  })

  it('persists token refresh counters and serializes short-lived usage as a dimension', async () => {
    statsDb = await createStatsDb()
    localStorage.setItem('has-sent-stats-opt-in-ping', '1')
    const payloads: ReturnType<typeof buildStatsPayload>[] = []
    const store = new StatsStore(
      statsDb,
      new TestActivityMonitor(),
      async body => {
        payloads.push(buildStatsPayload(body))
        return new Response(null, { status: 200 })
      }
    )
    const events: ReadonlyArray<TokenRefreshEvent> = [
      'attempt',
      'success',
      'transient-failure',
      'non-transient-failure',
      'abandoned',
      'required-sign-in',
    ]
    await Promise.all(events.map(event => store.recordTokenRefreshEvent(event)))
    store.setUsesShortLivedToken(true)
    await store.sendStats([], [])
    const entry = await statsDb.dailyMeasures.limit(1).first()
    const fields = [
      'tokenRefreshAttemptCount',
      'tokenRefreshSuccessCount',
      'tokenRefreshTransientFailureCount',
      'tokenRefreshNonTransientFailureCount',
      'tokenRefreshAbandonedCount',
      'tokenRefreshRequiredSignInCount',
    ] as const
    for (const field of fields) {
      assert.strictEqual(entry?.[field], 1)
      assert.strictEqual(payloads[0].events[0].measures?.[field], 1)
    }
    assert.strictEqual(
      payloads[0].events[0].dimensions.usesShortLivedToken,
      'true'
    )
    assert.strictEqual(
      'usesShortLivedToken' in (payloads[0].events[0].measures ?? {}),
      false
    )
    store.setUsesShortLivedToken(false)
    await store.sendStats([], [])
    assert.strictEqual(
      payloads[1].events[0].dimensions.usesShortLivedToken,
      'false'
    )
    await store.clearDailyStats()
    await store.sendStats([], [])
    for (const field of fields) {
      assert.strictEqual(payloads[2].events[0].measures?.[field], 0)
    }
  })

  it('includes zero token refresh counters when reading existing daily records', async () => {
    statsDb = await createStatsDb()
    localStorage.setItem('has-sent-stats-opt-in-ping', '1')
    const store = new StatsStore(
      statsDb,
      new TestActivityMonitor(),
      async body => {
        if (body.eventType === 'usage') {
          assert.strictEqual(body.tokenRefreshAttemptCount, 0)
          assert.strictEqual(body.tokenRefreshSuccessCount, 0)
          assert.strictEqual(body.tokenRefreshTransientFailureCount, 0)
          assert.strictEqual(body.tokenRefreshNonTransientFailureCount, 0)
          assert.strictEqual(body.tokenRefreshAbandonedCount, 0)
          assert.strictEqual(body.tokenRefreshRequiredSignInCount, 0)
          assert.strictEqual(body.usesShortLivedToken, false)
        }
        return new Response(null, { status: 200 })
      }
    )
    await store.increment('commits')
    await statsDb.dailyMeasures.toCollection().modify(record => {
      Reflect.deleteProperty(record, 'tokenRefreshAttemptCount')
      Reflect.deleteProperty(record, 'tokenRefreshSuccessCount')
      Reflect.deleteProperty(record, 'tokenRefreshTransientFailureCount')
      Reflect.deleteProperty(record, 'tokenRefreshNonTransientFailureCount')
      Reflect.deleteProperty(record, 'tokenRefreshAbandonedCount')
      Reflect.deleteProperty(record, 'tokenRefreshRequiredSignInCount')
    })
    assert.strictEqual(await store.sendStats([], []), true)
  })

  it('does not submit token refresh counters or usage dimensions when opted out', async () => {
    statsDb = await createStatsDb()
    localStorage.setItem('has-sent-stats-opt-in-ping', '1')
    localStorage.setItem('stats-opt-out', '1')
    try {
      let posted = 0
      const store = new StatsStore(
        statsDb,
        new TestActivityMonitor(),
        async () => {
          posted++
          return new Response(null, { status: 200 })
        }
      )
      store.setUsesShortLivedToken(true)
      await store.recordTokenRefreshEvent('attempt')
      assert.strictEqual(await store.sendStats([], []), false)
      assert.strictEqual(posted, 0)
    } finally {
      localStorage.removeItem('stats-opt-out')
    }
  })

  it('persists eligible and shown notification counts separately', async () => {
    statsDb = await createStatsDb()
    const store = new StatsStore(statsDb, new TestActivityMonitor(), fakePost)

    await store.increment('checksFailedNotificationCount', 2)
    await store.increment('checksFailedNotificationShownCount')
    await store.increment('pullRequestCommentNotificationCount', 2)
    await store.increment('pullRequestCommentNotificationShownCount')
    for (const state of [
      'APPROVED',
      'COMMENTED',
      'CHANGES_REQUESTED',
    ] as const) {
      await store.recordPullRequestReviewNotification(state)
      await store.recordPullRequestReviewNotification(state)
      await store.recordPullRequestReviewNotificationShown(state)
    }

    const statsEntry = await statsDb.dailyMeasures.limit(1).first()
    assert.strictEqual(statsEntry?.checksFailedNotificationCount, 2)
    assert.strictEqual(statsEntry?.checksFailedNotificationShownCount, 1)
    assert.strictEqual(statsEntry?.pullRequestCommentNotificationCount, 2)
    assert.strictEqual(statsEntry?.pullRequestCommentNotificationShownCount, 1)
    assert.strictEqual(
      statsEntry?.pullRequestReviewApprovedNotificationCount,
      2
    )
    assert.strictEqual(
      statsEntry?.pullRequestReviewApprovedNotificationShownCount,
      1
    )
    assert.strictEqual(
      statsEntry?.pullRequestReviewCommentedNotificationCount,
      2
    )
    assert.strictEqual(
      statsEntry?.pullRequestReviewCommentedNotificationShownCount,
      1
    )
    assert.strictEqual(
      statsEntry?.pullRequestReviewChangesRequestedNotificationCount,
      2
    )
    assert.strictEqual(
      statsEntry?.pullRequestReviewChangesRequestedNotificationShownCount,
      1
    )
  })

  it('reports stats on demand in a test environment', async () => {
    statsDb = await createStatsDb()
    const activityMonitor = new TestActivityMonitor()
    const postedBodies: Array<Record<string, any>> = []
    localStorage.setItem('has-sent-stats-opt-in-ping', '1')

    const store = new StatsStore(statsDb, activityMonitor, async body => {
      postedBodies.push(body)
      return new Response(null, { status: 200 })
    })

    await store.increment('commits')
    await store.sendStats([], [])

    assert.strictEqual(postedBodies.length, 1)
    assert.strictEqual(postedBodies[0].eventType, 'usage')
    assert.strictEqual(postedBodies[0].commits, 1)
    assert.strictEqual(localStorage.getItem('last-daily-stats-report'), null)
    assert.strictEqual(await statsDb.dailyMeasures.count(), 1)
  })

  it('never sends stats over the network', async t => {
    statsDb = await createStatsDb()
    localStorage.setItem('has-sent-stats-opt-in-ping', '1')
    const fetch = t.mock.method(globalThis, 'fetch')

    const store = new StatsStore(statsDb, new TestActivityMonitor())
    await store.increment('commits')

    // Treated as delivered, so the local counters are cleared.
    assert.strictEqual(await store.sendStats([], []), true)
    assert.strictEqual(fetch.mock.callCount(), 0)
  })

  it('never sends the opt-in ping over the network', async t => {
    statsDb = await createStatsDb()
    localStorage.removeItem('has-sent-stats-opt-in-ping')
    localStorage.removeItem('stats-opt-out')
    t.after(() => localStorage.removeItem('stats-opt-out'))
    const fetch = t.mock.method(globalThis, 'fetch')

    new StatsStore(statsDb, new TestActivityMonitor())
    await new Promise(resolve => setTimeout(resolve, 50))

    assert.strictEqual(fetch.mock.callCount(), 0)
  })
})
