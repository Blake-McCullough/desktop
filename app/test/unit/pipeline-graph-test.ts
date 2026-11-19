import { describe, it } from 'node:test'
import assert from 'node:assert'
import {
  IGraphJob,
  layoutPipelineGraph,
} from '../../src/lib/gitlab/pipeline-graph'
import { IPipelineNeeds } from '../../src/lib/gitlab/pipeline-details'

const job = (id: number, name: string, stage: string): IGraphJob => ({
  id,
  name,
  stage,
})

function place(graph: ReturnType<typeof layoutPipelineGraph>) {
  return Object.fromEntries(
    graph.nodes.map(n => [n.jobId, `${n.column},${n.row}`])
  )
}

describe('layoutPipelineGraph', () => {
  it('lays out needs like the release workflow', () => {
    // version → linux → arch → publish, version → windows → publish
    const jobs = [
      job(1, 'version', 'prepare'),
      job(2, 'linux', 'build'),
      job(3, 'windows', 'build'),
      job(4, 'arch', 'package'),
      job(5, 'publish', 'release'),
    ]
    const needs: IPipelineNeeds = {
      stages: ['prepare', 'build', 'package', 'release'],
      needs: new Map([
        ['version', []],
        ['linux', ['version']],
        ['windows', ['version']],
        ['arch', ['linux']],
        ['publish', ['arch', 'windows']],
      ]),
    }
    const graph = layoutPipelineGraph(jobs, needs)
    assert.equal(graph.mode, 'needs')
    assert.deepEqual(place(graph), {
      1: '0,0',
      2: '1,0',
      3: '1,1',
      4: '2,0',
      5: '3,0',
    })
    assert.equal(graph.columns, 4)
    assert.equal(graph.rows, 2)
    assert.equal(graph.edges.length, 5)
  })

  it('falls back to one column per stage without needs', () => {
    const jobs = [
      job(1, 'build', 'build'),
      job(2, 'unit', 'test'),
      job(3, 'lint', 'test'),
      job(4, 'deploy', 'deploy'),
    ]
    const graph = layoutPipelineGraph(jobs, null)
    assert.equal(graph.mode, 'stages')
    assert.deepEqual(graph.columnLabels, ['build', 'test', 'deploy'])
    assert.deepEqual(place(graph), { 1: '0,0', 2: '1,0', 3: '1,1', 4: '2,0' })
    // Each job links to the stage before it only.
    assert.deepEqual(graph.edges.map(e => `${e.from}>${e.to}`).sort(), [
      '1>2',
      '1>3',
      '2>4',
      '3>4',
    ])
  })

  it('treats jobs without needs: as waiting for the previous stage', () => {
    const jobs = [
      job(1, 'build', 'build'),
      job(2, 'test', 'test'),
      job(3, 'docs', 'test'),
      job(4, 'deploy', 'deploy'),
    ]
    const needs: IPipelineNeeds = {
      stages: ['build', 'test', 'deploy'],
      // docs needs nothing so it starts straight away; deploy has no needs:.
      needs: new Map<string, ReadonlyArray<string> | null>([
        ['build', null],
        ['test', ['build']],
        ['docs', []],
        ['deploy', null],
      ]),
    }
    const graph = layoutPipelineGraph(jobs, needs)
    assert.equal(place(graph)[3], '0,1')
    assert.deepEqual(
      graph.edges
        .filter(e => e.to === 4)
        .map(e => e.from)
        .sort(),
      [2, 3]
    )
  })

  it('links needs to every parallel or matrix copy of a job', () => {
    const jobs = [
      job(1, 'test 1/2', 'test'),
      job(2, 'test 2/2', 'test'),
      job(3, 'build: [linux]', 'test'),
      job(4, 'report', 'report'),
    ]
    const needs: IPipelineNeeds = {
      stages: ['test', 'report'],
      needs: new Map([
        ['test 1/2', []],
        ['test 2/2', []],
        ['build: [linux]', []],
        ['report', ['test', 'build']],
      ]),
    }
    const graph = layoutPipelineGraph(jobs, needs)
    assert.deepEqual(graph.edges.map(e => e.from).sort(), [1, 2, 3])
  })

  it('survives a dependency cycle', () => {
    const jobs = [job(1, 'a', 's'), job(2, 'b', 's')]
    const needs: IPipelineNeeds = {
      stages: ['s'],
      needs: new Map([
        ['a', ['b']],
        ['b', ['a']],
      ]),
    }
    const graph = layoutPipelineGraph(jobs, needs)
    assert.equal(graph.nodes.length, 2)
  })
})
