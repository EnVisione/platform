<script lang="ts">
  import { createEventDispatcher } from 'svelte'
  import {
    changeDiscordMeeting,
    discordOffice,
    discordOfficeError,
    discordVoiceUrl,
    type DiscordRoom
  } from '../discordOffice'

  const dispatch = createEventDispatcher()
  const active = new Set(['online', 'idle', 'dnd'])
  let search = ''
  let pending: string | undefined
  let confirmation: { room: DiscordRoom; action: 'start' | 'end' } | undefined
  let actionError: string | undefined

  $: activeStaff = $discordOffice?.members.filter((member) => member.staff && active.has(member.status)) ?? []
  $: members = ($discordOffice?.members ?? [])
    .filter((member) => member.name.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => Number(active.has(b.status)) - Number(active.has(a.status)) || a.name.localeCompare(b.name))
    .slice(0, 50)

  async function updateMeeting(room: DiscordRoom, action: 'start' | 'end'): Promise<void> {
    pending = room.id
    confirmation = undefined
    actionError = undefined
    try {
      await changeDiscordMeeting(room, action)
    } catch (error) {
      actionError = error instanceof Error ? error.message : 'The meeting could not be updated'
    } finally {
      pending = undefined
    }
  }

  function lastSeen(value?: number): string {
    return value === undefined ? 'Not yet observed' : `Last active ${new Date(value).toLocaleString()}`
  }
</script>

<svelte:window
  on:keydown={(event) => {
    if (event.key === 'Escape') dispatch('close')
  }}
/>

<section class="discord-panel" aria-label="Discord office">
  <header>
    <div>
      <strong>Discord office</strong>
      <p>{$discordOffice?.connected ? 'Connected' : 'Presence unavailable'}</p>
    </div>
    <button type="button" aria-label="Close Discord office" on:click={() => dispatch('close')}>×</button>
  </header>

  {#if $discordOfficeError}
    <p class="notice" role="status">{$discordOfficeError}</p>
  {/if}
  {#if $discordOffice}
    <div class="summary" aria-label="Current activity">
      <span>{activeStaff.length} active staff</span>
      <span>{$discordOffice.rooms.reduce((count, room) => count + room.memberIds.length, 0)} in voice</span>
      <span>{$discordOffice.members.length} members</span>
    </div>

    <h2>Voice rooms</h2>
    {#each $discordOffice.rooms as room (room.id)}
      <div class="room">
        <div class="room-line">
          <strong>{room.name}</strong>
          <span class:live={room.status === 'live'}
            >{room.status === 'live' ? 'Live' : room.status === 'closed' ? 'Locked' : room.status}</span
          >
        </div>
        <small>{room.memberIds.length} in voice</small>
        <div class="actions">
          {#if room.joinable && discordVoiceUrl(room)}
            <a href={discordVoiceUrl(room)} target="_blank" rel="noreferrer">Join voice ↗</a>
          {/if}
          {#if $discordOffice.canHost && $discordOffice.connected && room.kind === 'meeting'}
            <button
              type="button"
              disabled={pending !== undefined}
              on:click={() => (confirmation = { room, action: room.status === 'live' ? 'end' : 'start' })}
              >{room.status === 'live' ? 'End meeting' : 'Start meeting'}</button
            >
          {/if}
        </div>
        {#if confirmation?.room.id === room.id}
          <div class="confirm">
            <p>
              {confirmation.action === 'start'
                ? 'Unlock this room and notify the Todo role?'
                : 'Lock new joins and end this meeting?'}
            </p>
            <button type="button" on:click={() => (confirmation = undefined)}>Cancel</button>
            <button type="button" on:click={() => confirmation && updateMeeting(room, confirmation.action)}
              >Confirm</button
            >
          </div>
        {/if}
      </div>
    {/each}
    {#if actionError}<p class="notice" role="alert">{actionError}</p>{/if}

    <h2>Active staff</h2>
    {#if activeStaff.length === 0}
      <p class="empty">No staff currently appear online.</p>
    {:else}
      {#each activeStaff as member (member.id)}
        <div class="member">
          <img src={member.avatar} alt="" />
          <div>
            <strong>{member.name}</strong><small>{member.ranks.join(' · ') || 'Staff'} · {member.status}</small>
          </div>
        </div>
      {/each}
    {/if}

    <h2>Server members</h2>
    <label for="discord-member-search">Search members</label>
    <input id="discord-member-search" type="search" bind:value={search} placeholder="Name" />
    {#each members as member (member.id)}
      <div class="member">
        <img src={member.avatar} alt="" />
        <div>
          <strong>{member.name}</strong>
          <small>{active.has(member.status) ? `Active now · ${member.status}` : lastSeen(member.lastActiveAt)}</small>
        </div>
      </div>
    {/each}
    {#if $discordOffice.members.length > 50 && search === ''}
      <p class="empty">Search to find more members.</p>
    {/if}
    <p class="empty">Last active is recorded from observed Discord presence. Earlier activity is unavailable.</p>
    {#if /^https:\/\/discord\.com\/channels\/\d+\/\d+$/.test($discordOffice.discordUrl)}
      <a class="discord-link" href={$discordOffice.discordUrl} target="_blank" rel="noreferrer">Open Discord ↗</a>
    {/if}
  {/if}
</section>

<style>
  .discord-panel {
    position: absolute;
    z-index: 30;
    top: 3.5rem;
    right: 0.75rem;
    width: min(25rem, calc(100vw - 1.5rem));
    max-height: min(80vh, 52rem);
    overflow: auto;
    padding: 1rem;
    border: 1px solid var(--theme-popup-divider, #363943);
    border-radius: 0.75rem;
    background: var(--popup-bg-hover, #202329);
    color: var(--theme-content-color, #e8eaef);
    box-shadow: 0 1rem 2rem #0007;
  }
  header,
  .room-line,
  .summary,
  .actions,
  .confirm {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }
  header {
    margin-bottom: 0.75rem;
  }
  header p,
  small,
  .empty,
  label {
    color: var(--theme-caption-color, #9da1aa);
    font-size: 0.75rem;
  }
  header p {
    margin: 0.25rem 0 0;
  }
  h2 {
    font-size: 0.85rem;
    margin: 1rem 0 0.5rem;
  }
  .summary {
    padding: 0.6rem 0;
    border-block: 1px solid var(--theme-popup-divider, #363943);
    font-size: 0.75rem;
  }
  .room {
    padding: 0.7rem 0;
    border-bottom: 1px solid var(--theme-popup-divider, #363943);
  }
  .room-line span {
    text-transform: capitalize;
    color: var(--theme-caption-color, #9da1aa);
    font-size: 0.75rem;
  }
  .room-line span.live {
    color: #66c9a2;
  }
  .actions {
    justify-content: flex-start;
    margin-top: 0.5rem;
  }
  .confirm {
    flex-wrap: wrap;
    justify-content: flex-start;
    margin-top: 0.6rem;
  }
  .confirm p {
    width: 100%;
    margin: 0;
    font-size: 0.75rem;
  }
  button,
  .actions a,
  .discord-link {
    border: 1px solid var(--theme-popup-divider, #464950);
    border-radius: 0.4rem;
    background: transparent;
    color: inherit;
    padding: 0.35rem 0.5rem;
    cursor: pointer;
    text-decoration: none;
    font: inherit;
    font-size: 0.75rem;
  }
  button:hover,
  .actions a:hover,
  .discord-link:hover {
    background: #ffffff12;
  }
  button:focus-visible,
  a:focus-visible,
  input:focus-visible {
    outline: 2px solid #a69de5;
    outline-offset: 2px;
  }
  button:disabled {
    opacity: 0.5;
    cursor: wait;
  }
  .member {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.4rem 0;
  }
  .member img {
    width: 2rem;
    height: 2rem;
    border-radius: 0.5rem;
  }
  .member div {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .member strong {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .member small {
    margin-top: 0.1rem;
  }
  label {
    display: block;
    margin-bottom: 0.3rem;
  }
  input {
    box-sizing: border-box;
    width: 100%;
    border: 1px solid var(--theme-popup-divider, #464950);
    border-radius: 0.4rem;
    background: #0002;
    color: inherit;
    padding: 0.45rem;
  }
  .notice {
    color: #ffc0ba;
    font-size: 0.8rem;
  }
  .discord-link {
    display: inline-block;
    margin-top: 0.9rem;
  }
</style>
