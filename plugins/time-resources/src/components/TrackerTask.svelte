<script lang="ts">
  import type { WithLookup } from '@hcengineering/core'
  import { getEmbeddedLabel } from '@hcengineering/platform'
  import task from '@hcengineering/task'
  import type { ToDo } from '@hcengineering/time'
  import tracker, { type Issue } from '@hcengineering/tracker'
  import { canEditIssue } from '@hcengineering/tracker-resources/src/utils'
  import DueDateEditor from '@hcengineering/tracker-resources/src/components/issues/DueDateEditor.svelte'
  import IssueStatusIcon from '@hcengineering/tracker-resources/src/components/issues/IssueStatusIcon.svelte'
  import { Button, showPanel } from '@hcengineering/ui'
  import time from '../plugin'

  export let issue: WithLookup<Issue>
  export let todo: ToDo | undefined

  let editable = false
  $: {
    const currentIssue = issue
    editable = false
    void canEditIssue(currentIssue).then((result) => {
      if (issue === currentIssue) editable = result
    })
  }
  $: done =
    issue.$lookup?.status?.category === task.statusCategory.Won ||
    issue.$lookup?.status?.category === task.statusCategory.Lost
</script>

<div class="tracker-task" class:done>
  <button class="task-link" on:click={() => showPanel(tracker.component.EditIssue, issue._id, issue._class, 'content')}>
    <IssueStatusIcon value={issue.$lookup?.status} space={issue.space} taskType={issue.kind} size="small" />
    <span class="task-id">{issue.identifier}</span>
    <span class="task-title">{issue.title}</span>
  </button>
  <div class="task-actions">
    <DueDateEditor value={issue} {editable} />
    {#if editable && !done && todo !== undefined}
      <Button
        label={getEmbeddedLabel('Schedule')}
        kind="tertiary"
        size="small"
        borderStyle="none"
        on:click={() => todo !== undefined && showPanel(time.component.EditToDo, todo._id, todo._class, 'content')}
      />
    {/if}
  </div>
</div>

<style lang="scss">
  .tracker-task {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--spacing-1);
    padding: var(--spacing-2);
    color: var(--theme-content-color);
    border-radius: var(--small-BorderRadius);

    &:hover {
      background: var(--theme-bg-accent-color);
    }
    &.done .task-title {
      text-decoration: line-through;
      color: var(--theme-dark-color);
    }
  }
  .task-link {
    display: flex;
    align-items: center;
    gap: var(--spacing-2);
    flex: 1 1 14rem;
    min-width: 0;
    text-align: left;
  }
  .task-id {
    color: var(--theme-dark-color);
    white-space: nowrap;
  }
  .task-title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .task-actions {
    display: flex;
    align-items: center;
    gap: var(--spacing-1);
    margin-left: auto;
  }
</style>
