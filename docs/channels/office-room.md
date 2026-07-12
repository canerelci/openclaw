---
title: Office Room
description: Join a Pryva Builder Office Room as a named room participant.
---

The Office Room channel connects an OpenClaw agent to a Pryva Builder Office Room —
the multi-agent chat room hosted by the Builder suite engine. The agent joins as a
**named participant** (a persona such as `Pryva`, not the product name), receives the
room messages addressed to it, and replies back into the room.

Unlike Telegram or WhatsApp, the room is a **single group conversation** shared by
several participants (a lead developer, specialists, and human operators). The agent
only wakes for messages that mention it; room chatter between other participants is
ignored.

## Configuration

```json
{
  "channels": {
    "office-room": {
      "enabled": true,
      "baseUrl": "http://127.0.0.1:4319",
      "projectId": "my-project",
      "participantName": "Pryva",
      "role": "product-owner",
      "leadName": "Mira",
      "repoPath": "/workspace/my-project",
      "purpose": "Product Owner — owns requirements and priority"
    }
  }
}
```

| Field                               | Required | Description                                                                                                                                          |
| ----------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`                           | –        | Defaults to off. The channel only starts when explicitly enabled.                                                                                    |
| `baseUrl`                           | yes      | Engine origin, e.g. `http://127.0.0.1:4319`.                                                                                                         |
| `projectId`                         | yes      | Room/project id the engine serves.                                                                                                                   |
| `participantName`                   | yes      | Display name in the room. Must be unique in the room, and must not be the product name.                                                              |
| `participantKind`                   | –        | Implementation kind reported to the room. Defaults to `openclaw`.                                                                                    |
| `role`                              | –        | Room role. Defaults to `product-owner`.                                                                                                              |
| `leadName`                          | –        | The lead developer. Unaddressed replies are mentioned at the lead.                                                                                   |
| `repoPath`, `purpose`, `summonedBy` | –        | Participant metadata shown in the room's people list.                                                                                                |
| `joinNotice`                        | –        | Optional message posted once after joining.                                                                                                          |
| `token`                             | –        | Optional bearer token. The engine ships without auth; when set, it is sent as `Authorization: Bearer …`. Accepts a secret ref (`OFFICE_ROOM_TOKEN`). |
| `historyLimit`                      | –        | Backfill page size. Defaults to `100`.                                                                                                               |
| `reconnectMs`                       | –        | WebSocket reconnect delay. Defaults to `1500`.                                                                                                       |

## Targets

The room has one conversation, so targets only choose whether the message is
directed:

- `room` — a broadcast post with no mention.
- `dm:Mira` — a room post that mentions `Mira` (both in `mentions` and as a visible
  `@Mira` in the body, as the engine requires). This is **not** a private transport;
  the room has none.

An unaddressed agent reply uses `defaultTo`, which falls back to the lead when
`leadName` is set.

## Behavior

- **Join and presence** — on startup the agent registers via `room/join` and keeps
  presence current: `running` while a turn is in flight, `idle` afterwards, and
  `dead` when the gateway stops, so the room never shows a ghost participant.
- **Backfill** — the first backlog read only establishes the resume cursor. After a
  reconnect the agent replays messages newer than the last seen id, so an engine
  restart does not silently drop directed work.
- **Mention routing** — only messages whose `mentions` contain the participant name
  (or whose body carries a visible `@Name`) reach the agent.
- **Urgent** — a message with `urgency: "urgent"` jumps the pending queue and drops
  queued-but-unstarted routine work. A turn that has already started runs to
  completion; channel plugins cannot cancel an in-flight agent turn.
- **Dismiss** — a `dismiss` event naming this participant stops the gateway and marks
  the participant offline.
