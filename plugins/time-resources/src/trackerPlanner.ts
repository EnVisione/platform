import type { Ref, WithLookup } from '@hcengineering/core'
import type { ToDo } from '@hcengineering/time'
import type { Issue, Project } from '@hcengineering/tracker'

export function groupTrackerIssues(
  issues: WithLookup<Issue>[],
  filterValue: string
): [Ref<Project>, WithLookup<Issue>[]][] {
  const filter = filterValue.trim().toLowerCase()
  const groups = new Map<Ref<Project>, WithLookup<Issue>[]>()
  for (const issue of issues) {
    if (filter !== '' && !`${issue.identifier} ${issue.title}`.toLowerCase().includes(filter)) continue
    const group = groups.get(issue.space) ?? []
    group.push(issue)
    groups.set(issue.space, group)
  }
  return Array.from(groups)
}

export function getActiveIssueToDos(todos: ToDo[]): Map<Ref<Issue>, ToDo> {
  const result = new Map<Ref<Issue>, ToDo>()
  for (const todo of todos) {
    if (todo.doneOn != null) continue
    const issueId = todo.attachedTo as Ref<Issue>
    const current = result.get(issueId)
    if (current === undefined || todo.modifiedOn > current.modifiedOn) result.set(issueId, todo)
  }
  return result
}
