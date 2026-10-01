<!--
// Copyright © 2024 Hardcore Engineering Inc.
//
// Licensed under the Eclipse Public License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License. You may
// obtain a copy of the License at https://www.eclipse.org/legal/epl-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
//
// See the License for the specific language governing permissions and
// limitations under the License.
-->
<script lang="ts">
  import { AccountRole, getCurrentAccount, hasAccountRole, Ref, WithLookup } from '@hcengineering/core'
  import { Floor, Room } from '@hcengineering/love'
  import { getMetadata } from '@hcengineering/platform'
  import { Component, DropdownLabels, Header, IconEdit, ModernButton } from '@hcengineering/ui'
  import { Viewlet, ViewletPreference } from '@hcengineering/view'
  import { ViewletSelector } from '@hcengineering/view-resources'
  import { createEventDispatcher } from 'svelte'

  import lovePlg from '../plugin'
  import { discordOffice } from '../discordOffice'
  import DiscordOfficePanel from './DiscordOfficePanel.svelte'
  import { floors, selectedFloor } from '../stores'

  export let rooms: Room[] = []
  export let floor: Ref<Floor>

  const dispatch = createEventDispatcher()

  let viewlet: WithLookup<Viewlet> | undefined
  let preference: ViewletPreference | undefined
  let loading = false
  let showDiscord = false
  const configuredOffice = getMetadata(lovePlg.metadata.OfficeUrl)
  const hasDiscordOffice = configuredOffice?.startsWith('/') === true && !configuredOffice.startsWith('//')

  let selected = $floors.filter((fl) => fl._id === floor)[0]
  $: selected = $floors.filter((fl) => fl._id === floor)[0]

  const me = getCurrentAccount()

  let editable: boolean = false
  $: editable = hasAccountRole(me, AccountRole.Maintainer)

  let items = $floors.map((p) => {
    return { id: p._id, label: p.name }
  })
  $: items = $floors.map((p) => {
    return { id: p._id, label: p.name }
  })

  function changeFloor (event: CustomEvent<Ref<Floor>>) {
    if (event.detail) {
      selectedFloor.set(event.detail)
    }
  }
</script>

<div class="hulyComponent discord-office-floor">
  <Header adaptive={'disabled'}>
    <DropdownLabels
      {items}
      selected={selected?._id}
      size={'large'}
      kind={'ghost'}
      enableSearch={false}
      autoSelect={false}
      on:selected={changeFloor}
    />
    <svelte:fragment slot="beforeTitle">
      <ViewletSelector bind:viewlet bind:preference bind:loading viewletQuery={{ attachTo: lovePlg.class.Floor }} />
    </svelte:fragment>
    <svelte:fragment slot="actions">
      {#if hasDiscordOffice}
        <button
          class="discord-toggle"
          type="button"
          aria-expanded={showDiscord}
          on:click={() => (showDiscord = !showDiscord)}
          >Discord{#if $discordOffice}
            · {$discordOffice.members.filter(
              (member) => member.staff && ['online', 'idle', 'dnd'].includes(member.status)
            ).length} active{/if}</button
        >
      {/if}
      {#if editable}
        <ModernButton
          icon={IconEdit}
          label={lovePlg.string.EditOffice}
          size={'small'}
          on:click={() => dispatch('configure')}
        />
      {/if}
    </svelte:fragment>
  </Header>
  <div class="hulyComponent-content__column content">
    {#if viewlet?.$lookup?.descriptor?.component}
      <Component
        is={viewlet.$lookup.descriptor.component}
        props={{ floor, rooms }}
        on:open
      />
    {/if}
  </div>
  {#if hasDiscordOffice && showDiscord}
    <DiscordOfficePanel on:close={() => (showDiscord = false)} />
  {/if}
</div>

<style>
  .discord-office-floor {
    position: relative;
  }
  .discord-toggle {
    border: 1px solid var(--theme-popup-divider, #454751);
    border-radius: 0.4rem;
    background: transparent;
    color: var(--theme-content-color, #e8eaef);
    padding: 0.4rem 0.65rem;
    font: inherit;
    cursor: pointer;
  }
  .discord-toggle:hover {
    background: #ffffff12;
  }
  .discord-toggle:focus-visible {
    outline: 2px solid #a69de5;
    outline-offset: 2px;
  }
</style>
