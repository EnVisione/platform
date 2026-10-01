<!--
//
// Copyright © 2021 Hardcore Engineering Inc.
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
  import contact, { type Employee } from '@hcengineering/contact'
  import { Class, ClassifierKind, Doc, Mixin, Ref } from '@hcengineering/core'
  import { getMetadata } from '@hcengineering/platform'
  import { getClient } from '@hcengineering/presentation'
  import setting from '@hcengineering/setting'
  import { Icon, Label, themeStore, tooltip } from '@hcengineering/ui'
  import workbench from '@hcengineering/workbench'
  import { getMixinStyle } from '../utils'
  import { staffContactRanks } from '../staffContactRanks'

  export let value: Doc
  export let fullSize: boolean = false

  const client = getClient()
  const hierarchy = client.getHierarchy()
  const staffRanksUrl = getMetadata(workbench.metadata.StaffContactRanksUrl)

  let mixins: Array<Mixin<Doc>> = []
  let staffEmployee = false
  let ranks: string[] = []

  function rankStyle(rank: string, dark: boolean): string {
    return getMixinStyle(`discord:rank:${rank}` as Ref<Class<Doc>>, true, dark)
  }

  $: staffEmployee =
    staffRanksUrl !== undefined && value !== undefined && hierarchy.hasMixin(value, contact.mixin.Employee)
  $: ranks =
    staffEmployee && $staffContactRanks?.connected
      ? ($staffContactRanks.byAccount[(value as Employee).personUuid ?? ''] ?? [])
      : []

  $: if (value !== undefined) {
    const parentClass: Ref<Class<Doc>> = hierarchy.getParentClass(value._class)

    mixins = hierarchy
      .getDescendants(parentClass)
      .filter(
        (m) =>
          hierarchy.getClass(m).kind === ClassifierKind.MIXIN &&
          hierarchy.hasMixin(value, m) &&
          (!staffEmployee || String(m) !== 'hr:mixin:Staff')
        // && !hierarchy.hasMixin(hierarchy.getClass(m), setting.mixin.UserMixin)
      )
      .map((m) => hierarchy.getClass(m) as Mixin<Doc>)
  }
</script>

{#if mixins.length > 0 || ranks.length > 0}
  <div class="mixin-container">
    {#each mixins as mixin}
      {@const userMixin = hierarchy.hasMixin(mixin, setting.mixin.UserMixin)}
      <div
        class="mixin-selector"
        class:user-selector={userMixin && !fullSize}
        style={getMixinStyle(mixin._id, true, $themeStore.dark)}
      >
        {#if !userMixin || fullSize}
          <span class="overflow-label"><Label label={mixin.label} /></span>
        {:else}
          <div use:tooltip={{ label: mixin.label }}>
            {#if mixin.icon}
              <Icon icon={mixin.icon} size={'small'} />
            {:else}
              Ⱞ
            {/if}
          </div>
        {/if}
      </div>
    {/each}
    {#each ranks as rank (rank)}
      <div class="mixin-selector" style={rankStyle(rank, $themeStore.dark)}>
        <span class="overflow-label">{rank}</span>
      </div>
    {/each}
  </div>
{/if}

<style lang="scss">
  .mixin-container {
    display: flex;
    min-width: 0;
    .mixin-selector {
      margin-left: 8px;
      padding-inline: 0.25rem;
      cursor: pointer;
      height: 24px;
      min-width: 84px;
      max-width: 12rem;

      border-radius: 8px;

      font-size: 10px;

      text-transform: uppercase;
      color: var(--theme-caption-color);

      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
    }
    .user-selector {
      min-width: 24px;
    }
  }
</style>
