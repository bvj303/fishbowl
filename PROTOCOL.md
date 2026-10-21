# Fishbowl wire protocol (v1)

This is the source of truth for how a client talks to the Fishbowl server. The web client
(`public/client.js`) uses it, and a native host app (for example on tvOS) can be built
from this document alone. `test/protocol.test.js` checks every message a real server sends
during a full game against the tables below, so this file can't drift from the code.

- [Transport](#transport)
- [Envelope](#envelope)
- [Identity: rooms, host tokens and player ids](#identity-rooms-host-tokens-and-player-ids)
- [Connection lifecycle](#connection-lifecycle)
- [Reconnecting](#reconnecting)
- [The turn clock](#the-turn-clock)
- [Client → server messages](#client--server-messages)
- [Server → client messages](#server--client-messages)
- [Game events](#game-events)
- [Game state](#game-state)
- [Error codes](#error-codes)
- [Limits](#limits)
- [Versioning](#versioning)
- [Appendix A: Swift `Codable` models](#appendix-a-swift-codable-models)
- [Appendix B: connecting with `URLSessionWebSocketTask`](#appendix-b-connecting-with-urlsessionwebsockettask)

## Transport

- One WebSocket per client at **`/ws`** on the same host and port as the web page:
  `wss://fishbowl.example.com/ws` when served over HTTPS, `ws://192.168.1.20:3000/ws` on a
  home network. Web clients derive it from `location`. No subprotocol, no cookies, no auth headers.
- Every message is a single **text** frame holding one JSON object (UTF-8). Binary frames are rejected.
- Messages from clients must be at most **8 KiB**. Bigger frames close the connection with code `1009`.
- The server sends a WebSocket **ping** frame every 15 s. A connection that hasn't answered with a
  pong by the next ping is terminated. Browsers and `URLSessionWebSocketTask` answer pings automatically.

Other HTTP endpoints on the same server:

| Path | What it is |
| --- | --- |
| `GET /` | The web app (landing page). |
| `GET /ABCD`, `GET /?join=ABCD` | The phone join screen for room `ABCD`. This is what the QR code points to. |
| `GET /?host=ABCD` | A web host screen for room `ABCD` (resumes with the token saved in that browser). |
| `GET /healthz` | `200 {"ok":true,"rooms":3,"connections":17,"protocolVersion":1}` for load balancers. |

## Envelope

Every message, in both directions, is a JSON object with these fields next to its payload:

| Field | Type | Notes |
| --- | --- | --- |
| `v` | `int` | Protocol version. Always `1` for this document. |
| `type` | `string` | The message type, for example `"joinRoom"` or `"state"`. |
| `id` | `string` | Client → server only, optional. 1–64 characters. If present, the server answers with a `reply` carrying the same `id`. |

Payload fields sit at the top level next to `v`/`type`/`id` (there is no nested `payload` object).
The server rejects unknown fields, so don't send extras.

```json
{ "v": 1, "type": "gotWord", "id": "17", "wordId": "1b4f0c2e-6a0e-4f43-9a51-8a4f7c3c9f10" }
```

**Replies.** A request with an `id` always gets exactly one `reply`, in success or failure:

```json
{ "v": 1, "type": "reply", "id": "17", "ok": true }
{ "v": 1, "type": "reply", "id": "18", "ok": false, "code": "STALE", "error": "That word was already answered." }
```

`code` is stable and meant for programs ([error codes](#error-codes)); `error` is a friendly
English sentence you can show as-is. A request **without** an `id` gets no reply on success;
on failure the server sends an [`error`](#error) message instead. Requests are handled in the
order they arrive, and replies come back in the same order, except `createRoom` and
`resumeHost`, which may finish a little later because they render a QR code.

## Identity: rooms, host tokens and player ids

**Room code.** Four capital letters from `ABCDEFGHJKLMNPQRSTUVWXYZ` (no `I` or `O`, and no digits,
so no `0`/`1` lookalikes), for example `"KJPW"`. Codes are unique among live rooms and are
case-insensitive on input. Once a room is deleted its code can be reused by a new room.

**Host token.** A random secret (32 URL-safe characters) returned once by `createRoom`. Whoever
presents it with `resumeHost` becomes a host of that room on that connection, and only host
connections may send the [host-only messages](#host-only). Keep it out of URLs and QR codes. Store
it (Keychain or `UserDefaults` on tvOS, `localStorage` on the web) together with the room code and
the `serverId` from `welcome`, so you can resume after a crash or relaunch. Several connections
may be hosts of the same room at once (say, a TV and a laptop).

**Player id.** Chosen by the phone: 6–64 characters of `A–Z a–z 0–9 _ -`. Use one stable id per
device. A phone that joins again with the same id gets its seat, team and turn back. If a
different device joins with the name of an *offline* player, it takes over that seat.

**A connection is in at most one room, as either a host or a player.** `createRoom`,
`resumeHost` and `joinRoom` move it (leaving any previous room); `leaveRoom` takes it out.

## Connection lifecycle

```
client                                   server
  | ---- WebSocket upgrade to /ws ------>  |
  | <--- welcome {protocolVersion,         |   always the first message
  |       serverId, serverNow, limits} --  |
  |                                        |
  |  host, first time:                     |
  | ---- createRoom {id} ---------------->  |
  | <--- reply {room: code, hostToken,     |
  |       joinUrl, qrDataUrl} -----------  |
  | <--- state {state} -------------------  |   then a fresh state after every change
  |                                        |
  |  host, coming back:                    |
  | ---- resumeHost {code, hostToken} --->  |
  | <--- reply {room: …} -----------------  |
  | <--- state ---------------------------  |
  |                                        |
  |  phone:                                |
  | ---- lookupRoom {code} -------------->  |   optional: check the code before asking for a name
  | <--- reply {room: phase, playerCount…}  |
  | ---- joinRoom {code, playerId, name} ->  |
  | <--- reply {room: {code}, playerId} --  |
  | <--- state ---------------------------  |
  |                                        |
  | <--- turnStarted / wordGuessed / … ---  |   events, after the state they describe
  | <--- roomClosed {reason} -------------  |   the room is gone; the socket stays open
```

After a successful `createRoom`, `resumeHost` or `joinRoom`, the `reply` always arrives before the
first `state` for the room. From then on the server sends a complete `state` whenever anything in
the room changes: there are no diffs and no ticks, so a client can simply replace its copy.
Events are hints for animations and sounds; they are sent right after the `state` that already
reflects them, and the state is always the source of truth.

**Room lifetime.** Rooms live in the server's memory. A room is deleted:

- when nobody (host or phone) has been connected to it for 30 minutes (`ROOM_IDLE_MINUTES`);
- 30 minutes after a game ends, unless the host starts another one (`ROOM_GAME_OVER_MINUTES`);
- when the host sends `closeRoom`;
- when the server restarts or redeploys. **All running games end.**

Connected clients get [`roomClosed`](#roomclosed) when a room is deleted (except on a restart,
when the socket simply closes with `1012`).

## Reconnecting

Networks drop, phones lock, TVs sleep. The server keeps a seat (and a host room) for as long as
the room exists, so reconnecting is always safe:

1. When the socket closes (or a `ping` gets no reply within ~5 s), open a new one with
   exponential backoff: 0.5 s, 1 s, 2 s, 4 s… capped at 10 s, with ±25 % jitter. Reset the delay
   once `welcome` arrives. Retry immediately when the app comes back to the foreground.
2. On every `welcome`, re-identify: hosts send `resumeHost` with the stored code and token,
   phones send `joinRoom` with the stored code, player id and name.
3. If that fails with `ROOM_NOT_FOUND` (or `HOST_TOKEN_INVALID`), the room is gone. Compare
   `welcome.serverId` with the `serverId` you stored when you created or joined the room: if it
   changed, the server restarted ("This game ended because the server restarted"); otherwise the
   room expired or was closed. Offer to start over.

While a phone is disconnected it is shown as offline and skipped when its turn comes. If it was
the active player, the turn keeps running and the phone sees the same card and deadline when it
comes back. While no host is connected, `state.room.hostConnected` is `false` and phones show
"Waiting for the host to come back…"; the game itself carries on.

**Liveness.** Ping frames from the server catch dead connections on the server side. A client
can't see those, so it should also send `ping` requests (every ~20 s, and whenever it returns
to the foreground) and treat a missing reply as a dead socket.

Close codes the server uses:

| Code | Meaning | What to do |
| --- | --- | --- |
| `1008` | Too many messages (flooding past the rate limit). | Reconnect with backoff. |
| `1009` | A message was larger than 8 KiB. | Fix the client. |
| `1012` | The server is restarting. | Reconnect; expect `ROOM_NOT_FOUND`. |
| `4000` | Unsupported protocol version. | Tell the user to update the app. |

## The turn clock

The server owns the clock and ends turns itself. It never sends per-second updates. Instead:

- While a turn's clock is running, `state.turnEndsAt` is the deadline in **epoch milliseconds**
  (server time) and `state.remainingMs` is the time left at the moment the state was sent.
- While the clock is paused, or before the actor presses start, `turnEndsAt` is `null` and
  `remainingMs` is the frozen amount left.
- `state.serverNow` (and `turnStarted.serverNow`, `welcome.serverNow`, the `ping` reply) is the
  server's clock when the message was sent, so you can correct for skew:

```text
offset   = serverNow + rtt / 2 - localNowWhenReceived   // from a ping: rtt = receive - send time
timeLeft = turnEndsAt != null ? max(0, turnEndsAt - (localNow + offset)) : remainingMs
seconds  = ceil(timeLeft / 1000)
```

Keep the offset from the ping with the lowest round-trip time, and animate locally (a display
link or `requestAnimationFrame`). When your local countdown reaches zero, show 0 and wait: the
server sends `turnEnded` and a new `state` within a few milliseconds of the deadline.

The web client pulses the clock in the last 10 seconds and vibrates the active player's phone
once a second in the last 5.

## Client → server messages

Field names ending in `?` are optional. All other fields are required. Types are `string`,
`int`, `bool`, `T?` (may be `null`), `T[]` (array), or a named type defined further down.

### Anyone

#### `ping`

Keep-alive and clock sync. Reply: `serverNow`.

<!-- schema: client.ping -->
| Field | Type | Notes |
| --- | --- | --- |

<!-- schema: reply.ping -->
| Field | Type | Notes |
| --- | --- | --- |
| `serverNow` | `int` | Server time, epoch ms. |

#### `createRoom`

Creates a room and makes this connection its host. Rate limited to 20 per IP address per 10 minutes.
Errors: `SERVER_FULL`, `RATE_LIMITED`.

<!-- schema: client.createRoom -->
| Field | Type | Notes |
| --- | --- | --- |

<!-- schema: reply.createRoom -->
| Field | Type | Notes |
| --- | --- | --- |
| `room` | `HostRoom` | The new room, including its secret host token. |

<!-- example: reply.createRoom -->
```json
{
  "v": 1, "type": "reply", "id": "1", "ok": true,
  "room": {
    "code": "KJPW",
    "hostToken": "Zq3l0b2v8WkqgT1v1ql3b6F8z2o0aR3x",
    "joinUrl": "https://fishbowl.example.com/KJPW",
    "qrDataUrl": "data:image/png;base64,iVBORw0KGgo…"
  }
}
```

<!-- schema: HostRoom -->
| Field | Type | Notes |
| --- | --- | --- |
| `code` | `string` | The 4-letter room code. Show it big. |
| `hostToken` | `string` | Secret. Store it; never display it. |
| `joinUrl` | `string` | What phones should open, e.g. `https://fishbowl.example.com/KJPW`. Encode it in your own QR code if you like. |
| `qrDataUrl` | `string?` | A PNG QR code for `joinUrl` as a `data:` URL (handy for web clients). |

#### `resumeHost`

Becomes the host of an existing room again (after a refresh, crash or network change).
Errors: `ROOM_NOT_FOUND`, `HOST_TOKEN_INVALID`.

<!-- schema: client.resumeHost -->
| Field | Type | Notes |
| --- | --- | --- |
| `code` | `string` | Room code (any case). |
| `hostToken` | `string` | The token from `createRoom`. 16–128 characters. |

<!-- schema: reply.resumeHost -->
| Field | Type | Notes |
| --- | --- | --- |
| `room` | `HostRoom` | Same as `createRoom`. |

#### `lookupRoom`

Checks a code without joining, so a phone can say "no game with that code" or "game in progress"
before asking for a name. Errors: `ROOM_NOT_FOUND`.

<!-- schema: client.lookupRoom -->
| Field | Type | Notes |
| --- | --- | --- |
| `code` | `string` | Room code (any case). |

<!-- schema: reply.lookupRoom -->
| Field | Type | Notes |
| --- | --- | --- |
| `room` | `RoomSummary` | |

<!-- schema: RoomSummary -->
| Field | Type | Notes |
| --- | --- | --- |
| `code` | `string` | Normalized (upper case) room code. |
| `phase` | `Phase` | |
| `playerCount` | `int` | |
| `maxPlayers` | `int` | |
| `hostConnected` | `bool` | |

#### `joinRoom`

Takes a seat as a player, or takes your seat back (same `playerId`). Players who join after the
words are in are put on the smaller team. Errors: `ROOM_NOT_FOUND`, `ROOM_FULL`, `INVALID_NAME`,
`NAME_TAKEN`.

<!-- schema: client.joinRoom -->
| Field | Type | Notes |
| --- | --- | --- |
| `code` | `string` | Room code (any case). |
| `playerId` | `string` | Stable per device, 6–64 of `A–Z a–z 0–9 _ -`. |
| `name` | `string` | Up to 64 characters; trimmed and cut to 16. Unique in the room (ignoring case). |

<!-- schema: reply.joinRoom -->
| Field | Type | Notes |
| --- | --- | --- |
| `room` | `JoinedRoom` | |
| `playerId` | `string` | Your seat. Usually the id you sent. |

<!-- schema: JoinedRoom -->
| Field | Type | Notes |
| --- | --- | --- |
| `code` | `string` | Normalized room code. |

#### `leaveRoom`

Leaves the current room. A player who leaves in the lobby gives up their seat; later on they're
just marked offline. Always succeeds.

<!-- schema: client.leaveRoom -->
| Field | Type | Notes |
| --- | --- | --- |

### Players

These need a connection that joined as a player (`NOT_IN_ROOM` otherwise).

#### `submitWords`

Adds your words to the bowl during `SUBMISSION`. Exactly `config.wordsPerPlayer` non-empty words.
Errors: `WRONG_PHASE`, `ALREADY_SUBMITTED`, `INVALID_WORDS`.

<!-- schema: client.submitWords -->
| Field | Type | Notes |
| --- | --- | --- |
| `words` | `string[]` | At most 8 items of up to 200 characters; each is trimmed and cut to 60. |

#### `startTurn`

The active player starts the clock. Errors: `WRONG_PHASE`, `NOT_YOUR_TURN`.

<!-- schema: client.startTurn -->
| Field | Type | Notes |
| --- | --- | --- |

#### `gotWord`

The team guessed the card. `wordId` must be the card you're looking at, so a double tap can't
score twice. Errors: `STALE` (already answered, paused, or the turn ended; safe to ignore).

<!-- schema: client.gotWord -->
| Field | Type | Notes |
| --- | --- | --- |
| `wordId` | `string` | `state.currentWord.id`. |

#### `skipWord`

Puts the card back at the bottom of the bowl. Errors: `STALE`, `LAST_WORD`.

<!-- schema: client.skipWord -->
| Field | Type | Notes |
| --- | --- | --- |
| `wordId` | `string` | `state.currentWord.id`. |

### Host only

<a id="host-only"></a>These need a connection that is a host of the room (`NOT_HOST` otherwise).
None of them has extra reply fields.

| Type | Does | Errors |
| --- | --- | --- |
| `startSubmission` | Lobby → word entry, with the settings below. | `WRONG_PHASE`, `NOT_ENOUGH_PLAYERS` |
| `shuffleTeams` | Re-deals the teams before round 1. | `WRONG_PHASE` |
| `startRound` | Starts round 1 (from `READY_TO_START`) or the next round (from `ROUND_OVER`). | `WRONG_PHASE` |
| `togglePause` | Pauses or resumes a running turn clock. | `WRONG_PHASE` |
| `skipTurn` | Ends the current turn now; the card goes back in the bowl. | `WRONG_PHASE` |
| `removePlayer` | Removes a player (e.g. someone who left without submitting). | `NOT_FOUND` |
| `playAgain` | After the game: back to the lobby with the same players. | `WRONG_PHASE` |
| `resetLobby` | Empties the room: everyone has to join again. Same code. | |
| `closeRoom` | Deletes the room. Everyone gets `roomClosed` with reason `closedByHost`. | |

<!-- schema: client.startSubmission -->
| Field | Type | Notes |
| --- | --- | --- |
| `timer` | `int` | Seconds per turn. Clamped to `limits.timer` (15–180). |
| `words` | `int` | Words per player. Clamped to `limits.words` (1–8). |

<!-- schema: client.shuffleTeams -->
| Field | Type | Notes |
| --- | --- | --- |

<!-- schema: client.startRound -->
| Field | Type | Notes |
| --- | --- | --- |

<!-- schema: client.togglePause -->
| Field | Type | Notes |
| --- | --- | --- |

<!-- schema: client.skipTurn -->
| Field | Type | Notes |
| --- | --- | --- |

<!-- schema: client.removePlayer -->
| Field | Type | Notes |
| --- | --- | --- |
| `playerId` | `string` | |

<!-- schema: client.playAgain -->
| Field | Type | Notes |
| --- | --- | --- |

<!-- schema: client.resetLobby -->
| Field | Type | Notes |
| --- | --- | --- |

<!-- schema: client.closeRoom -->
| Field | Type | Notes |
| --- | --- | --- |

## Server → client messages

Every server message has `v` and `type`, plus the fields below.

#### `welcome`

The first message on every connection.

<!-- schema: server.welcome -->
| Field | Type | Notes |
| --- | --- | --- |
| `protocolVersion` | `int` | `1`. If it's not a version you support, stop and ask the user to update. |
| `serverId` | `string` | Random per server process. A different value after reconnecting means the server restarted and every room is gone. |
| `serverNow` | `int` | Server time, epoch ms. |
| `limits` | `ServerLimits` | |

<!-- schema: ServerLimits -->
| Field | Type | Notes |
| --- | --- | --- |
| `maxMessageBytes` | `int` | Largest message the server accepts (8192). |
| `maxPlayersPerRoom` | `int` | 12 by default. |
| `heartbeatMs` | `int` | How often the server sends ping frames. |

<!-- example: server.welcome -->
```json
{
  "v": 1, "type": "welcome", "protocolVersion": 1,
  "serverId": "6f2d8c1e-5d0c-4a59-9a36-0d7f6b1f2a11", "serverNow": 1760000000000,
  "limits": { "maxMessageBytes": 8192, "maxPlayersPerRoom": 12, "heartbeatMs": 15000 }
}
```

#### `reply`

The answer to a request that had an `id`. On success: `ok: true` plus the request's
reply fields (listed with each request above). On failure: `ok: false`, `code` and `error`, and nothing else.

<!-- schema: server.reply -->
| Field | Type | Notes |
| --- | --- | --- |
| `id` | `string` | The request's `id`. |
| `ok` | `bool` | |
| `code?` | `ErrorCode` | Only when `ok` is `false`. |
| `error?` | `string` | Only when `ok` is `false`. Friendly text to show. |

#### `error`

A failure for a message without an `id`, or one that couldn't be parsed.

<!-- schema: server.error -->
| Field | Type | Notes |
| --- | --- | --- |
| `code` | `ErrorCode` | |
| `error` | `string` | |

#### `state`

The complete state of your room as **you** may see it. Sent after joining and after every change.

<!-- schema: server.state -->
| Field | Type | Notes |
| --- | --- | --- |
| `serverNow` | `int` | Server time when this was sent, epoch ms. |
| `state` | `GameState` | See [Game state](#game-state). |

#### `roomClosed`

The room was deleted. The connection stays open but is no longer in a room.

<!-- schema: server.roomClosed -->
| Field | Type | Notes |
| --- | --- | --- |
| `code` | `string` | |
| `reason` | `RoomClosedReason` | |

<!-- enum: RoomClosedReason -->
| Value | Meaning |
| --- | --- |
| `"idle"` | Nobody was connected for a long time. |
| `"gameOver"` | The game ended a while ago and nobody started a new one. |
| `"closedByHost"` | The host sent `closeRoom`. |
| `"serverShutdown"` | The server is shutting down. |

## Game events

Small, fire-and-forget messages for animations and sounds. Each is sent to everyone in the room
(host and phones) right after the `state` that reflects it. **No event ever contains word text.**

#### `turnStarted`

The active player pressed start.

<!-- schema: server.turnStarted -->
| Field | Type | Notes |
| --- | --- | --- |
| `round` | `int` | 1–3. |
| `team` | `Team` | |
| `playerId` | `string` | The active player. |
| `durationMs` | `int` | Full turn length. |
| `turnEndsAt` | `int` | Deadline, epoch ms. |
| `serverNow` | `int` | Server time when sent. |

<!-- example: server.turnStarted -->
```json
{ "v": 1, "type": "turnStarted", "round": 1, "team": "A", "playerId": "lq3k9x2a7f", "durationMs": 60000, "turnEndsAt": 1760000060000, "serverNow": 1760000000000 }
```

#### `wordGuessed`

<!-- schema: server.wordGuessed -->
| Field | Type | Notes |
| --- | --- | --- |
| `team` | `Team` | The team that scored. |
| `turnScore` | `int` | Words guessed so far this turn. |
| `teamScore` | `int` | The team's new total. |
| `bowlCount` | `int` | Words still in the bowl, not counting the next card. |

<!-- example: server.wordGuessed -->
```json
{ "v": 1, "type": "wordGuessed", "team": "B", "turnScore": 3, "teamScore": 11, "bowlCount": 6 }
```

#### `wordSkipped`

<!-- schema: server.wordSkipped -->
| Field | Type | Notes |
| --- | --- | --- |
| `team` | `Team` | |

#### `turnEnded`

Time ran out, the host skipped the turn, or the bowl ran out of words.

<!-- schema: server.turnEnded -->
| Field | Type | Notes |
| --- | --- | --- |
| `playerId` | `string?` | Who was giving clues. |
| `name` | `string` | Their name, for "Sam got 4 words". |
| `team` | `Team` | |
| `got` | `int` | Words guessed this turn. |
| `reason` | `TurnEndReason` | |

<!-- enum: TurnEndReason -->
| Value | Meaning |
| --- | --- |
| `"time"` | The clock ran out (play the buzzer). |
| `"skipped"` | The host skipped the turn. |
| `"bowl"` | The last word was guessed; a `roundEnded` follows. |

<!-- example: server.turnEnded -->
```json
{ "v": 1, "type": "turnEnded", "playerId": "lq3k9x2a7f", "name": "Sam", "team": "A", "got": 4, "reason": "time" }
```

#### `roundStarted`

<!-- schema: server.roundStarted -->
| Field | Type | Notes |
| --- | --- | --- |
| `round` | `int` | 1–3. Rules are in `state.rounds[round - 1]`. |
| `team` | `Team` | The team that goes first. |

#### `roundEnded`

<!-- schema: server.roundEnded -->
| Field | Type | Notes |
| --- | --- | --- |
| `round` | `int` | The round that just finished. |
| `roundScores` | `TeamScores` | Points scored in that round. |
| `scores` | `TeamScores` | Running totals. |

#### `gameEnded`

Sent after the last `roundEnded`.

<!-- schema: server.gameEnded -->
| Field | Type | Notes |
| --- | --- | --- |
| `scores` | `TeamScores` | Final totals. |
| `winner` | `Team?` | `null` for a tie. |

## Game state

`state.state` in a [`state`](#state) message. Each connection gets its own copy: only the active
player, while their clock runs, sees `currentWord`. Hosts get the same view as a spectator
(`you` is `null`).

<!-- schema: GameState -->
| Field | Type | Notes |
| --- | --- | --- |
| `phase` | `Phase` | |
| `you` | `string?` | Your player id, or `null` for hosts and players who aren't seated. |
| `players` | `Player[]` | In join order. |
| `teams` | `TeamRosters` | Player ids per team, in turn order. Empty until teams are dealt. |
| `scores` | `TeamScores` | Totals. |
| `roundScores` | `TeamScores[]` | One entry per round (3). |
| `config` | `GameConfig` | Settings chosen by the host. |
| `limits` | `GameLimits` | Fixed rules. |
| `rounds` | `RoundInfo[]` | The 3 rounds, in order. |
| `round` | `int` | Current (or just finished) round, 1–3. |
| `activeTeam` | `Team` | Whose turn it is (meaningful in `GAMELOOP`). |
| `activePlayerId` | `string?` | Who is giving clues. |
| `upNextId` | `string?` | Who goes after them. |
| `timerRunning` | `bool` | The current turn's clock has been started (it may be paused). |
| `paused` | `bool` | |
| `turnEndsAt` | `int?` | Deadline, epoch ms, while the clock runs. `null` when paused or not started. |
| `remainingMs` | `int` | Time left when this state was sent. |
| `bowlCount` | `int` | Words left in the bowl this round, including the current card. |
| `deckCount` | `int` | Total words submitted. |
| `turnScore` | `int` | Words guessed this turn. |
| `lastTurn` | `LastTurn?` | The previous turn, for "Sam got 4" between turns. |
| `currentWord` | `Word?` | Only for the active player while their clock runs. |
| `lastWord` | `bool` | `true` when `currentWord` is the last one in the bowl (skip is disabled). |
| `room` | `RoomInfo` | |

<!-- enum: Phase -->
| Value | Meaning |
| --- | --- |
| `"LOBBY"` | Players are joining. The host picks settings and sends `startSubmission`. |
| `"SUBMISSION"` | Everyone types their words. Teams are dealt automatically when all are in. |
| `"READY_TO_START"` | Teams are shown. The host can `shuffleTeams` or `startRound`. |
| `"GAMELOOP"` | A round is being played, turn by turn. |
| `"ROUND_OVER"` | The bowl is empty. The host starts the next round with `startRound`. |
| `"GAME_OVER"` | After round 3. The host can `playAgain` or `resetLobby`. |

<!-- enum: Team -->
| Value | Meaning |
| --- | --- |
| `"A"` | Team A (red in the web UI). |
| `"B"` | Team B (blue in the web UI). |

<!-- schema: Player -->
| Field | Type | Notes |
| --- | --- | --- |
| `id` | `string` | Player id. |
| `name` | `string` | 1–16 characters. |
| `team` | `Team?` | `null` until teams are dealt. |
| `connected` | `bool` | Has at least one open connection. |
| `hasSubmitted` | `bool` | Their words are in. |

<!-- schema: TeamScores -->
| Field | Type | Notes |
| --- | --- | --- |
| `A` | `int` | |
| `B` | `int` | |

<!-- schema: TeamRosters -->
| Field | Type | Notes |
| --- | --- | --- |
| `A` | `string[]` | |
| `B` | `string[]` | |

<!-- schema: GameConfig -->
| Field | Type | Notes |
| --- | --- | --- |
| `timerDuration` | `int` | Seconds per turn. |
| `wordsPerPlayer` | `int` | |

<!-- schema: GameLimits -->
| Field | Type | Notes |
| --- | --- | --- |
| `minPlayers` | `int` | 4. |
| `maxPlayers` | `int` | 12 by default. |
| `nameLength` | `int` | 16. |
| `wordLength` | `int` | 60. |
| `timer` | `IntRange` | Seconds per turn. |
| `words` | `IntRange` | Words per player. |

<!-- schema: IntRange -->
| Field | Type | Notes |
| --- | --- | --- |
| `min` | `int` | |
| `max` | `int` | |
| `default` | `int` | |

<!-- schema: RoundInfo -->
| Field | Type | Notes |
| --- | --- | --- |
| `name` | `string` | "Describe It", "Act It Out", "One Word". |
| `rule` | `string` | One sentence to show on screen. |

<!-- schema: LastTurn -->
| Field | Type | Notes |
| --- | --- | --- |
| `playerId` | `string?` | |
| `name` | `string` | |
| `team` | `Team` | |
| `got` | `int` | |
| `reason` | `TurnEndReason` | |

<!-- schema: Word -->
| Field | Type | Notes |
| --- | --- | --- |
| `id` | `string` | Send it back with `gotWord` / `skipWord`. |
| `text` | `string` | The secret word. Only ever sent to the active player. |

<!-- schema: RoomInfo -->
| Field | Type | Notes |
| --- | --- | --- |
| `code` | `string` | |
| `hostConnected` | `bool` | `false` while no host is connected. |
| `joinUrl` | `string?` | The link phones should open. |

<!-- example: server.state -->
```json
{
  "v": 1,
  "type": "state",
  "serverNow": 1760000012000,
  "state": {
    "phase": "GAMELOOP",
    "you": null,
    "players": [
      { "id": "lq3k9x2a7f", "name": "Sam", "team": "A", "connected": true, "hasSubmitted": true },
      { "id": "lq3kb1c9d0", "name": "Alex", "team": "B", "connected": true, "hasSubmitted": true },
      { "id": "lq3kc7e2f4", "name": "Jo", "team": "A", "connected": false, "hasSubmitted": true },
      { "id": "lq3kd0a8b6", "name": "Kim", "team": "B", "connected": true, "hasSubmitted": true }
    ],
    "teams": { "A": ["lq3k9x2a7f", "lq3kc7e2f4"], "B": ["lq3kb1c9d0", "lq3kd0a8b6"] },
    "scores": { "A": 7, "B": 5 },
    "roundScores": [{ "A": 7, "B": 5 }, { "A": 0, "B": 0 }, { "A": 0, "B": 0 }],
    "config": { "timerDuration": 60, "wordsPerPlayer": 3 },
    "limits": {
      "minPlayers": 4, "maxPlayers": 12, "nameLength": 16, "wordLength": 60,
      "timer": { "min": 15, "max": 180, "default": 60 },
      "words": { "min": 1, "max": 8, "default": 3 }
    },
    "rounds": [
      { "name": "Describe It", "rule": "Say anything except the word itself. No spelling, no \"rhymes with\"." },
      { "name": "Act It Out", "rule": "Charades! No talking or sounds — act it out." },
      { "name": "One Word", "rule": "You get exactly ONE word as a clue. Choose wisely." }
    ],
    "round": 1,
    "activeTeam": "A",
    "activePlayerId": "lq3k9x2a7f",
    "upNextId": "lq3kb1c9d0",
    "timerRunning": true,
    "paused": false,
    "turnEndsAt": 1760000060000,
    "remainingMs": 48000,
    "bowlCount": 6,
    "deckCount": 12,
    "turnScore": 2,
    "lastTurn": { "playerId": "lq3kd0a8b6", "name": "Kim", "team": "B", "got": 3, "reason": "time" },
    "currentWord": null,
    "lastWord": false,
    "room": { "code": "KJPW", "hostConnected": true, "joinUrl": "https://fishbowl.example.com/KJPW" }
  }
}
```

## Error codes

<!-- enum: ErrorCode -->
| Value | Meaning |
| --- | --- |
| `"BAD_REQUEST"` | Not JSON, not an object, missing or wrong-typed fields, unknown fields, binary frame. |
| `"UNKNOWN_TYPE"` | No such message type. |
| `"UNSUPPORTED_VERSION"` | `v` isn't a version this server speaks. The connection then closes with `4000`. |
| `"RATE_LIMITED"` | Too many messages (or rooms created). The message was dropped; retry a little later. |
| `"SERVER_FULL"` | The server has as many rooms as it allows. |
| `"ROOM_NOT_FOUND"` | No live room has that code. It never existed, expired, was closed, or the server restarted. |
| `"ROOM_FULL"` | The room has the maximum number of players. Existing players can still rejoin. |
| `"HOST_TOKEN_INVALID"` | Wrong host token for that room. |
| `"NOT_HOST"` | A host-only message from a connection that isn't a host. |
| `"NOT_IN_ROOM"` | A player message from a connection that hasn't joined. |
| `"INVALID_NAME"` | Empty name. |
| `"NAME_TAKEN"` | Someone online in the room already has that name. |
| `"INVALID_WORDS"` | Wrong number of words, or empty ones. |
| `"ALREADY_SUBMITTED"` | This player's words are already in. |
| `"WRONG_PHASE"` | Not allowed in the current phase. |
| `"NOT_ENOUGH_PLAYERS"` | Fewer than 4 players. |
| `"NOT_YOUR_TURN"` | Only the active player can start the clock. |
| `"STALE"` | The card was already answered, the clock is paused, or the turn ended. Ignore it. |
| `"LAST_WORD"` | Can't skip the last word in the bowl. |
| `"NOT_FOUND"` | No such player. |
| `"REJECTED"` | Any other rule violation. |
| `"INTERNAL"` | A bug on the server. Try again. |

## Limits

| What | Limit | On exceeding |
| --- | --- | --- |
| Message size | 8 KiB | Close `1009` |
| Messages per connection | Bursts of 30, then 15 per second | `RATE_LIMITED`; after 200 dropped in a row, close `1008` |
| Rooms created | 20 per IP per 10 minutes | `RATE_LIMITED` |
| Rooms per server | 500 (`MAX_ROOMS`) | `SERVER_FULL` |
| Players per room | 12 (`MAX_PLAYERS_PER_ROOM`) | `ROOM_FULL` |
| Idle room | 30 minutes with nobody connected (`ROOM_IDLE_MINUTES`) | `roomClosed` `"idle"` |
| Finished game | 30 minutes after `gameEnded` (`ROOM_GAME_OVER_MINUTES`) | `roomClosed` `"gameOver"` |

## Versioning

The version is the `v` on every message and `welcome.protocolVersion`. Within a version the
server may **add** new server → client message types, events, and fields; clients must ignore
anything they don't recognize. Removing or changing a field, or adding a required client field,
means a new version. The server rejects a client message with a `v` it doesn't support
(`UNSUPPORTED_VERSION`, then close code `4000`), and a client should refuse a `welcome` whose
`protocolVersion` it doesn't know.

## Appendix A: Swift `Codable` models

Suggested models for a tvOS host app. They are documentation, not a package: copy what you need.
Unknown message types decode as `.unknown` so newer servers don't break older apps.

```swift
import Foundation

// MARK: - Shared types

enum Team: String, Codable { case A, B }

enum Phase: String, Codable {
    case lobby = "LOBBY", submission = "SUBMISSION", readyToStart = "READY_TO_START"
    case gameLoop = "GAMELOOP", roundOver = "ROUND_OVER", gameOver = "GAME_OVER"
}

enum TurnEndReason: String, Codable { case time, skipped, bowl }
enum RoomClosedReason: String, Codable { case idle, gameOver, closedByHost, serverShutdown }

struct ErrorCode: RawRepresentable, Codable, Hashable {   // open set: new codes may appear
    let rawValue: String
    static let roomNotFound = ErrorCode(rawValue: "ROOM_NOT_FOUND")
    static let hostTokenInvalid = ErrorCode(rawValue: "HOST_TOKEN_INVALID")
    static let rateLimited = ErrorCode(rawValue: "RATE_LIMITED")
    static let stale = ErrorCode(rawValue: "STALE")
}

struct TeamScores: Codable, Equatable { let A: Int; let B: Int }
struct TeamRosters: Codable, Equatable { let A: [String]; let B: [String] }
struct IntRange: Codable { let min: Int; let max: Int; let `default`: Int }

struct Player: Codable, Identifiable, Equatable {
    let id: String
    let name: String
    let team: Team?
    let connected: Bool
    let hasSubmitted: Bool
}

struct GameConfig: Codable { let timerDuration: Int; let wordsPerPlayer: Int }
struct GameLimits: Codable {
    let minPlayers: Int, maxPlayers: Int, nameLength: Int, wordLength: Int
    let timer: IntRange, words: IntRange
}
struct RoundInfo: Codable { let name: String; let rule: String }
struct LastTurn: Codable { let playerId: String?; let name: String; let team: Team; let got: Int; let reason: TurnEndReason }
struct Word: Codable { let id: String; let text: String }
struct RoomInfo: Codable { let code: String; let hostConnected: Bool; let joinUrl: String? }

struct GameState: Codable {
    let phase: Phase
    let you: String?
    let players: [Player]
    let teams: TeamRosters
    let scores: TeamScores
    let roundScores: [TeamScores]
    let config: GameConfig
    let limits: GameLimits
    let rounds: [RoundInfo]
    let round: Int
    let activeTeam: Team
    let activePlayerId: String?
    let upNextId: String?
    let timerRunning: Bool
    let paused: Bool
    let turnEndsAt: Int?      // epoch ms, server clock
    let remainingMs: Int
    let bowlCount: Int
    let deckCount: Int
    let turnScore: Int
    let lastTurn: LastTurn?
    let currentWord: Word?
    let lastWord: Bool
    let room: RoomInfo
}

// MARK: - Server → client

struct ServerLimits: Codable { let maxMessageBytes: Int; let maxPlayersPerRoom: Int; let heartbeatMs: Int }
struct Welcome: Codable { let protocolVersion: Int; let serverId: String; let serverNow: Int; let limits: ServerLimits }
struct StateMessage: Codable { let serverNow: Int; let state: GameState }
struct ErrorMessage: Codable { let code: ErrorCode; let error: String }
struct RoomClosed: Codable { let code: String; let reason: RoomClosedReason }
struct TurnStarted: Codable { let round: Int; let team: Team; let playerId: String; let durationMs: Int; let turnEndsAt: Int; let serverNow: Int }
struct WordGuessed: Codable { let team: Team; let turnScore: Int; let teamScore: Int; let bowlCount: Int }
struct WordSkipped: Codable { let team: Team }
struct TurnEnded: Codable { let playerId: String?; let name: String; let team: Team; let got: Int; let reason: TurnEndReason }
struct RoundStarted: Codable { let round: Int; let team: Team }
struct RoundEnded: Codable { let round: Int; let roundScores: TeamScores; let scores: TeamScores }
struct GameEnded: Codable { let scores: TeamScores; let winner: Team? }

/// A reply's common part. Decode the request-specific fields (e.g. `HostRoomResult`)
/// from the same data once you know which request the `id` belongs to.
struct ReplyHeader: Codable { let id: String; let ok: Bool; let code: ErrorCode?; let error: String? }
struct HostRoom: Codable { let code: String; let hostToken: String; let joinUrl: String; let qrDataUrl: String? }
struct HostRoomResult: Codable { let room: HostRoom }          // createRoom, resumeHost
struct PingResult: Codable { let serverNow: Int }               // ping

enum ServerMessage {
    case welcome(Welcome), reply(ReplyHeader, raw: Data), state(StateMessage), error(ErrorMessage)
    case roomClosed(RoomClosed), turnStarted(TurnStarted), wordGuessed(WordGuessed), wordSkipped(WordSkipped)
    case turnEnded(TurnEnded), roundStarted(RoundStarted), roundEnded(RoundEnded), gameEnded(GameEnded)
    case unknown(type: String)

    private struct Envelope: Decodable { let v: Int; let type: String }

    static func decode(_ data: Data) throws -> ServerMessage {
        let d = JSONDecoder()
        let type = try d.decode(Envelope.self, from: data).type
        switch type {
        case "welcome": return .welcome(try d.decode(Welcome.self, from: data))
        case "reply": return .reply(try d.decode(ReplyHeader.self, from: data), raw: data)
        case "state": return .state(try d.decode(StateMessage.self, from: data))
        case "error": return .error(try d.decode(ErrorMessage.self, from: data))
        case "roomClosed": return .roomClosed(try d.decode(RoomClosed.self, from: data))
        case "turnStarted": return .turnStarted(try d.decode(TurnStarted.self, from: data))
        case "wordGuessed": return .wordGuessed(try d.decode(WordGuessed.self, from: data))
        case "wordSkipped": return .wordSkipped(try d.decode(WordSkipped.self, from: data))
        case "turnEnded": return .turnEnded(try d.decode(TurnEnded.self, from: data))
        case "roundStarted": return .roundStarted(try d.decode(RoundStarted.self, from: data))
        case "roundEnded": return .roundEnded(try d.decode(RoundEnded.self, from: data))
        case "gameEnded": return .gameEnded(try d.decode(GameEnded.self, from: data))
        default: return .unknown(type: type)
        }
    }
}

// MARK: - Client → server

/// Encodes `{ "v": 1, "type": …, "id": …, …fields }` with the payload flattened in.
struct Request<Payload: Encodable>: Encodable {
    let type: String
    let id: String?
    let payload: Payload

    private enum Keys: String, CodingKey { case v, type, id }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        try c.encode(1, forKey: .v)
        try c.encode(type, forKey: .type)
        try c.encodeIfPresent(id, forKey: .id)
        try payload.encode(to: encoder)   // same keyed container: fields sit next to v/type/id
    }
}

struct Empty: Encodable {}
struct ResumeHost: Encodable { let code: String; let hostToken: String }
struct StartSubmission: Encodable { let timer: Int; let words: Int }
struct RemovePlayer: Encodable { let playerId: String }
// Host messages with no fields (startRound, togglePause, …) use `Empty()`.
```

## Appendix B: connecting with `URLSessionWebSocketTask`

A minimal host connection: connect, resume or create the room, re-identify after every
reconnect, keep a clock offset, and back off on failure. No third-party dependencies.

```swift
import Foundation

@MainActor
final class FishbowlConnection {
    private let url: URL                       // e.g. wss://fishbowl.example.com/ws
    private let session = URLSession(configuration: .default)
    private var task: URLSessionWebSocketTask?
    private var attempt = 0
    private var nextId = 1
    private var pending: [String: (Data) -> Void] = [:]
    private var pingTimer: Timer?

    private(set) var serverId: String?
    private(set) var clockOffsetMs: Double = 0    // server clock minus ours
    private var bestRtt = Double.infinity

    var room: (code: String, token: String, serverId: String)?   // persist this (Keychain)
    var onState: (GameState) -> Void = { _ in }
    var onEvent: (ServerMessage) -> Void = { _ in }
    var onRoomGone: (_ serverRestarted: Bool) -> Void = { _ in }

    init(url: URL) { self.url = url }

    func connect() {
        task?.cancel(with: .goingAway, reason: nil)
        let task = session.webSocketTask(with: url)
        task.maximumMessageSize = 1 << 20
        self.task = task
        task.resume()
        receive(on: task)
    }

    private func receive(on task: URLSessionWebSocketTask) {
        task.receive { [weak self] result in
            Task { @MainActor in
                guard let self, self.task === task else { return }
                switch result {
                case .success(.string(let text)):
                    self.handle(Data(text.utf8))
                    self.receive(on: task)
                case .success:
                    self.receive(on: task)       // the server never sends binary frames
                case .failure:
                    self.reconnectLater()
                }
            }
        }
    }

    private func handle(_ data: Data) {
        guard let message = try? ServerMessage.decode(data) else { return }
        switch message {
        case .welcome(let w):
            guard w.protocolVersion == 1 else { return /* ask the user to update */ }
            attempt = 0
            serverId = w.serverId
            clockOffsetMs = Double(w.serverNow) - Date().timeIntervalSince1970 * 1000
            bestRtt = .infinity
            startPinging()
            identify()
        case .reply(let header, let raw):
            pending.removeValue(forKey: header.id)?(raw)
        case .state(let s):
            onState(s.state)
        case .roomClosed:
            room = nil
            onRoomGone(false)
        default:
            onEvent(message)
        }
    }

    // Resume the stored room, or create one.
    private func identify() {
        if let room {
            send("resumeHost", ResumeHost(code: room.code, hostToken: room.token)) { [weak self] raw in
                guard let self, let header = try? JSONDecoder().decode(ReplyHeader.self, from: raw) else { return }
                if !header.ok, header.code == .roomNotFound || header.code == .hostTokenInvalid {
                    let restarted = self.serverId != room.serverId
                    self.room = nil
                    self.onRoomGone(restarted)       // "This game ended because the server restarted"
                }
            }
        } else {
            send("createRoom", Empty()) { [weak self] raw in
                guard let self, let result = try? JSONDecoder().decode(HostRoomResult.self, from: raw) else { return }
                self.room = (result.room.code, result.room.hostToken, self.serverId ?? "")
            }
        }
    }

    func send<P: Encodable>(_ type: String, _ payload: P, reply: ((Data) -> Void)? = nil) {
        guard let task else { return }
        let id = String(nextId); nextId += 1
        if let reply { pending[id] = reply }
        guard let data = try? JSONEncoder().encode(Request(type: type, id: id, payload: payload)),
              let text = String(data: data, encoding: .utf8) else { return }
        task.send(.string(text)) { _ in }
    }

    // Clock sync and liveness: a ping that gets no reply in 5 s means the socket is dead.
    private func startPinging() {
        pingTimer?.invalidate()
        pingTimer = Timer.scheduledTimer(withTimeInterval: 20, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.ping() }
        }
        ping()
    }

    private func ping() {
        let sent = Date()
        var answered = false
        send("ping", Empty()) { [weak self] raw in
            answered = true
            guard let self, let r = try? JSONDecoder().decode(PingResult.self, from: raw) else { return }
            let now = Date()
            let rtt = now.timeIntervalSince(sent) * 1000
            if rtt <= self.bestRtt {
                self.bestRtt = rtt
                self.clockOffsetMs = Double(r.serverNow) + rtt / 2 - now.timeIntervalSince1970 * 1000
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in
            if !answered { self?.reconnectLater() }
        }
    }

    private func reconnectLater() {
        pingTimer?.invalidate()
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        pending.removeAll()
        let delay = min(10, 0.5 * pow(2, Double(attempt))) * Double.random(in: 0.75...1.25)
        attempt += 1
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in self?.connect() }
    }

    /// Seconds left to show, from the latest state. Call it from a display link or timer.
    func secondsLeft(_ s: GameState) -> Int {
        guard let endsAt = s.turnEndsAt else { return Int((Double(s.remainingMs) / 1000).rounded(.up)) }
        let serverNow = Date().timeIntervalSince1970 * 1000 + clockOffsetMs
        return max(0, Int(((Double(endsAt) - serverNow) / 1000).rounded(.up)))
    }
}
```

Call `connect()` at launch and again when the app becomes active. For the QR code on the TV,
either show `qrDataUrl` or generate one from `joinUrl` with `CIFilter.qrCodeGenerator()`.
