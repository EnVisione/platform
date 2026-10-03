import type { Ref, StatusCategory, WithLookup } from '@hcengineering/core'
import type { ToDo } from '@hcengineering/time'
import type { Issue } from '@hcengineering/tracker'
import { getActiveIssueToDos, groupTrackerIssues } from '../trackerPlanner'

describe('Tracker tasks in Planner', () => {
  const closedCategories = new Set(['won', 'lost'] as Ref<StatusCategory>[])
  const issues = [
    { _id: 'discord', space: 'dev', identifier: 'DEV-1', title: 'Imported task', assignee: null },
    { _id: 'native', space: 'dev', identifier: 'DEV-2', title: 'Native task', assignee: 'other' },
    {
      _id: 'done',
      space: 'staff',
      identifier: 'STAFF-1',
      title: 'Completed task',
      assignee: null,
      $lookup: { status: { category: 'won' } }
    },
    {
      _id: 'cancelled',
      space: 'staff',
      identifier: 'STAFF-2',
      title: 'Cancelled task',
      assignee: null,
      $lookup: { status: { category: 'lost' } }
    }
  ] as unknown as WithLookup<Issue>[]

  it('shows open unassigned, imported and other staff issues without planning copies', () => {
    const groups = groupTrackerIssues(issues, '', closedCategories)
    expect(groups.map(([project, rows]) => [project, rows.map((row) => row._id)])).toEqual([
      ['dev', ['discord', 'native']]
    ])
  })

  it('filters by task name or identifier without changing the underlying issues', () => {
    expect(groupTrackerIssues(issues, ' dev-2 ', closedCategories)[0][1]).toEqual([issues[1]])
    expect(groupTrackerIssues(issues, 'IMPORTED', closedCategories)[0][1]).toEqual([issues[0]])
    expect(groupTrackerIssues(issues, 'missing', closedCategories)).toEqual([])
    expect(groupTrackerIssues(issues, 'completed', closedCategories)).toEqual([])
    expect(issues).toHaveLength(4)
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
    expect(groupTrackerIssues(issues, '', closedCategories).flatMap(([, rows]) => rows)).toHaveLength(2)
  })
})
