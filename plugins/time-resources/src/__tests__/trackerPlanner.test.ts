import type { Ref, WithLookup } from '@hcengineering/core'
import type { ToDo } from '@hcengineering/time'
import type { Issue } from '@hcengineering/tracker'
import { getActiveIssueToDos, groupTrackerIssues } from '../trackerPlanner'

describe('Tracker tasks in Planner', () => {
  const issues = [
    { _id: 'discord', space: 'dev', identifier: 'DEV-1', title: 'Imported task', assignee: null },
    { _id: 'native', space: 'dev', identifier: 'DEV-2', title: 'Native task', assignee: 'other' },
    { _id: 'done', space: 'staff', identifier: 'STAFF-1', title: 'Completed task', assignee: null }
  ] as unknown as WithLookup<Issue>[]

  it('shows unassigned, imported, other staff and completed issues without planning copies', () => {
    const groups = groupTrackerIssues(issues, '')
    expect(groups.map(([project, rows]) => [project, rows.map((row) => row._id)])).toEqual([
      ['dev', ['discord', 'native']],
      ['staff', ['done']]
    ])
  })

  it('filters by task name or identifier without changing the underlying issues', () => {
    expect(groupTrackerIssues(issues, ' dev-2 ')[0][1]).toEqual([issues[1]])
    expect(groupTrackerIssues(issues, 'IMPORTED')[0][1]).toEqual([issues[0]])
    expect(groupTrackerIssues(issues, 'missing')).toEqual([])
    expect(issues).toHaveLength(3)
  })

  it('uses one current planning copy and ignores completed assignment history', () => {
    const todos = [
      { _id: 'old', attachedTo: 'native', doneOn: 123, modifiedOn: 10 },
      { _id: 'active', attachedTo: 'native', doneOn: null, modifiedOn: 20 },
      { _id: 'newer', attachedTo: 'native', doneOn: null, modifiedOn: 30 },
      { _id: 'done', attachedTo: 'done', doneOn: 456, modifiedOn: 40 }
    ] as unknown as ToDo[]
    const active = getActiveIssueToDos(todos)
    expect(active.size).toBe(1)
    expect(active.get('native' as Ref<Issue>)?._id).toBe('newer')
    expect(groupTrackerIssues(issues, '').flatMap(([, rows]) => rows)).toHaveLength(3)
  })
})
