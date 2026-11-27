# Legal intents: groups, anchors, and the default

Every intent type the pinned engine can offer a seat, what it points at on the board, and which part of the product client offers it. The host computes these in [`src/match/legal-anchors.ts`](../src/match/legal-anchors.ts) and sends them on each entry of a seat snapshot's `legal` list. The `Record<Intent["type"], LegalGroup>` there fails the typecheck when an engine pin adds an intent type this table does not list.

## The fields

Each `legal` entry keeps `intent`, `label`, `source`, `card`, and `cites`, and adds:

| Field | Meaning |
|---|---|
| `group` | Where the interface offers it: `basic` (the fixed basic-action bar), `install`, `play`, `run`, `ability` (on a card on the table), `window` (pass, keep, mulligan), `choice` (a prompt) |
| `anchor` | What the player clicks first: `{kind:"card",cardId}`, `{kind:"server",serverId}`, `{kind:"subroutine",cardId,index}`, `{kind:"new_remote"}`, or `{kind:"none"}` |
| `target` | Where it lands when it takes a second click: an install's server or host, an event's or ability's server, a break's subroutine. Left out when there is no second click to choose |
| `default` | `true` on exactly one entry when the list is not empty. It is what the primary button takes |

The client treats `intent` as opaque: it sends back the intent at the chosen index and never reads its fields.

## Visibility

An anchor or target names a card id only when that id is not secret for the seat: never a card in a hand or a deck that seat may not see (CR 10.2.2a, CR 4.1.5). A facedown installed card's id is its location, which is open (CR 1.21.1, CR 4.1.4), so the Runner's anchor can point at it without naming its face. A card being accessed is open to the Runner (CR 7.3.1a). Where the card is hidden, the anchor falls back to the attacked server, or to none.

The visibility fuzz (CR audit tool 1.7) walks every string in each snapshot, so anchor and target ids are in its sweep. `tests/visibility/visibility-fuzz.test.ts` plants a hidden id in each to prove it, and `tests/match/match.test.ts` walks a seeded match checking every anchor against the fuzz oracle.

## Inventory

| Intent type | Group | Anchor | Target |
|---|---|---|---|
| `basic_gain_credit` | basic | none | |
| `basic_draw` | basic | none | |
| `basic_remove_tag` | basic | none | |
| `basic_purge_virus` | basic | none | |
| `basic_install` | install | card in hand | server (`remote_root`, `protect`), new remote, host card or ice (`host_*`), none for the Runner's rig |
| `play_event` | play | card in grip | server, when the event names one |
| `play_operation` | play | card in HQ | |
| `basic_run` | run | server | |
| `continue_run` | run | attacked server | |
| `jack_out` | run | attacked server | |
| `access_card` | run | card if open to the Runner, else attacked server | |
| `steal_agenda` | run | accessed card (attacked server if hidden) | |
| `trash_accessed` | run | accessed card (attacked server if hidden) | |
| `finish_access` | run | attacked server | |
| `finish_breach` | run | attacked server | |
| `access_rfg_paying_trash_cost` | run | accessed card | |
| `access_trash_from_grip` | run | the card being accessed | |
| `access_trash_with_virus` | run | accessed card | |
| `access_trash_free` | run | accessed card | |
| `access_trash_paying_printed_cost_from_stealth` | run | accessed card | |
| `access_trash_self_non_agenda_draw` | run | accessed card | |
| `access_host_non_agenda_faceup` | run | accessed card | |
| `access_host_agenda_on_film_critic` | run | accessed card | |
| `basic_trash_resource` | ability | the resource | |
| `advance` | ability | the card | |
| `score_agenda` | ability | the agenda | |
| `rez_ice` | ability | the ice | |
| `rez_asset` | ability | the card | |
| `use_paid_ability` | ability | the card | server, when the ability names one |
| `use_identity_ability` | ability | the identity | |
| `break_subroutine` | ability | the breaker | subroutine on the encountered ice |
| `break_bioroid_subroutine` | ability | subroutine on the encountered ice | |
| `break_bioroid_subroutines` | ability | the encountered ice | |
| `trigger_pending_trash_interrupt` | ability | the card | |
| `pass_window` | window | none | |
| `keep_starting_hand` | window | none | |
| `mulligan` | window | none | |
| `discard_to_hand_size` | choice | the card when one is named, else none | |
| `choose_option` | choice | the choice's source card, if this seat may see it | |
| `choose_trash_program` | choice | the program | |
| `resolve_sabotage` | choice | none | |
| `boost_trace` | choice | none | |
| `spend_link` | choice | none | |
| `resolve_trace` | choice | none | |
| `psi_runner_bid` | choice | none | |
| `psi_corp_bid` | choice | none | |
| `prevent_damage` | choice | none | |
| `prevent_damage_lose_all_clicks` | choice | none | |
| `accept_damage` | choice | none | |
| `accept_tags` | choice | none | |
| `accept_end_the_run` | choice | none | |
| `accept_expose` | choice | none | |
| `accept_installed_trash` | choice | none | |

## The default

The first match in this order, else the first entry: `keep_starting_hand`, `continue_run`, `finish_access`, `finish_breach`, `pass_window`, the `accept_*` intents, `resolve_trace`, the lowest psi bid (CR 10.14.6b), `basic_gain_credit`. So the button reads Keep this hand, Continue the run, Pass, or, in an action phase with clicks left, Gain 1 credit.
