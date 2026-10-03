<script lang="ts">
  import type { IdMap, WithLookup } from '@hcengineering/core'
  import { SortingOrder } from '@hcengineering/core'
  import { getCurrentEmployee } from '@hcengineering/contact'
  import { getEmbeddedLabel } from '@hcengineering/platform'
  import { createQuery, IconWithEmoji } from '@hcengineering/presentation'
  import type { ToDo } from '@hcengineering/time'
  import tracker, { type Issue, type Project } from '@hcengineering/tracker'
  import view from '@hcengineering/view'
  import { AccordionItem, getPlatformColorDef, getPlatformColorForTextDef, themeStore } from '@hcengineering/ui'
  import time from '../plugin'
  import { getActiveIssueToDos, groupTrackerIssues } from '../trackerPlanner'
  import TrackerTask from './TrackerTask.svelte'

  export let projects: IdMap<Project>
  export let filterValue = ''

  const issuesQuery = createQuery()
  const todosQuery = createQuery()
  let issues: WithLookup<Issue>[] = []
  let todos: ToDo[] = []

  $: issuesQuery.query(
    tracker.class.Issue,
    { space: { $in: Array.from(projects.keys()) } },
    (result) => {
      issues = result
    },
    { sort: { rank: SortingOrder.Ascending }, lookup: { status: tracker.class.IssueStatus } }
  )
  todosQuery.query(time.class.ProjectToDo, { user: getCurrentEmployee() }, (result) => {
    todos = result
  })

  $: activeToDos = getActiveIssueToDos(todos)
  $: groups = groupTrackerIssues(issues, filterValue)
</script>

<AccordionItem
  id="planner-tracker-tasks"
  label={getEmbeddedLabel('Tracker tasks')}
  size="large"
  counter={groups.reduce((count, group) => count + group[1].length, 0)}
  bottomSpace={false}
  fixHeader
  background="var(--theme-navpanel-color)"
>
  {#each groups as [projectId, projectIssues] (projectId)}
    {@const project = projects.get(projectId)}
    {#if project !== undefined}
      <AccordionItem
        id={`planner-tracker-project:${projectId}`}
        title={project.name}
        icon={project.icon === view.ids.IconWithEmoji ? IconWithEmoji : (project.icon ?? tracker.icon.Home)}
        iconProps={project.icon === view.ids.IconWithEmoji
          ? { icon: project.color }
          : {
              fill:
                project.color !== undefined && typeof project.color !== 'string'
                  ? getPlatformColorDef(project.color, $themeStore.dark).icon
                  : getPlatformColorForTextDef(project.name, $themeStore.dark).icon
            }}
        counter={projectIssues.length}
        size="medium"
        nested
      >
        {#each projectIssues as issue (issue._id)}
          <TrackerTask {issue} todo={activeToDos.get(issue._id)} />
        {/each}
      </AccordionItem>
    {/if}
  {/each}
</AccordionItem>
