export function PlayerResults({
  items,
  hideNicknames,
  formatPlaytime,
  formatDate,
}) {
  return (
    <div className="player-results" role="region" aria-label="Player results" tabIndex={0}>
      <table>
        <thead>
          <tr>
            <th scope="col">Player</th>
            <th scope="col">Status</th>
            <th scope="col">Server</th>
            <th scope="col">Network playtime</th>
            <th scope="col">Last heartbeat</th>
          </tr>
        </thead>
        <tbody>
          {items.map((player) => {
            const nickname = hideNicknames ? "" : player.nickname;
            return (
              <tr key={player.uuid}>
                <td>
                  <a className="moderation-person" href={`/players/${player.uuid}`}>
                    <strong>{nickname || player.name}</strong>
                    {nickname && <small>RealName: {player.name}</small>}
                  </a>
                </td>
                <td>{player.online ? "Online" : player.stale ? "Unknown" : "Offline"}</td>
                <td>{player.server}</td>
                <td>{formatPlaytime(player.playtimeSeconds)}</td>
                <td><time>{formatDate(player.lastSeen)}</time></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
