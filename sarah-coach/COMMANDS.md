# Sarah Coach command reference

Sarah Coach turns a pasted inbound guest message into a suggested reply through
the Voice Service, then records whether the suggestion was sent as-is or edited.

```bash
node sarah-coach/scripts/coach.js
node sarah-coach/scripts/outcome.js
```

Exact payload formats are available with each script's usage output. Channel
and authorized-user identifiers live only in ignored
`sarah-coach/config.json`.

<!-- BEGIN GENERATED: durable workflows on the sarah-coach surface — regenerate with `npm run docs:commands` -->

### Durable workflows — Sarah Coach

Generated from the workflow registry. Whether a mutating workflow executes for
real or is shadowed is runtime state, not repo state: ask `!help` in the channel.

| Workflow | Capability | Effects | How it runs |
| --- | --- | --- | --- |
| `guest.reply.draft` | `guest_messages.draft` | mutates | agent tool |

**Available in every controlled channel**

- `!review resolve <review-id> sent <provider-ref>`
- `!review resolve <review-id> <not-sent|abandon>`

  Resolves an open manual review from any controlled channel.

- `!help`

  Lists the commands and workflows this channel can actually run right now.

<!-- END GENERATED -->
