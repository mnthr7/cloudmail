# Spec: External agents (MCP, A2A, email, REST)

| | |
|---|---|
| **Status** | Draft for review |
| **Author** | Sada Kshirsagar |
| **Date** | 2026-11-06 |
| **Scope** | Letting agents CloudMail doesn't run (Claude agents, Grok, Meta Muse, custom agents) work as staff on the [Agent Staff platform](agent-staff-platform.md) |
| **Depends on** | Platform A1–A3 (principals, agent definitions), A6–A7 (capabilities, queue), A10–A12 (Staff page, safety, attribution) |

## TL;DR

An external agent is **just another agent principal** whose thinking happens somewhere else. It gets a name, a scope, capabilities set to *off / approve / auto*, a kill switch, and a label on the timeline, all exactly like Sam or Ava. The only difference is *how* it connects:

| Direction | Mechanism | Example | Priority |
|---|---|---|---|
| External agent → works **inside** CloudMail | **MCP server** at `/mcp` | Your Claude agent drafts replies to investor threads | **P0** |
| CloudMail → hands a job **to** an external agent | **A2A client** | Billing hands a dispute to your Grok-based research agent | P1 |
| Automation tools → CloudMail | **REST API + webhooks** | n8n files Stripe receipts | P1 |
| An agent with its own mailbox, CC'd on a thread | **Email** (no integration) | An AgentMail-hosted agent on a thread | P1 (labeling only) |
| Other companies' agents → **our** agents | **A2A server** (Agent Cards for Sam and Ava) | A prospect's assistant books a demo with Ava | P2 |

**Whatever the connection, every action goes through `propose()` and the same server-side policy check.** An external agent can never do more than the founder allowed, can never widen its own scope, and its output is never treated as an instruction to another agent.

---

## 1. Problem statement

Founders already use agents built elsewhere: a Claude agent with their company context, a Grok bot, Meta's Muse, or something custom. Each of these is strong on its own but can't safely work in the founder's email. Today the options are to hand over full mailbox credentials (no limits, no audit, no kill switch) or copy and paste. If CloudMail can only run its own agents, founders have to pick between CloudMail's staff and the agents they already trust. If external agents can join as **accountable staff**, CloudMail becomes the safe place where *any* agent does email and calendar work.

## 2. Goals

1. **Bring your own agent in under 5 minutes:** from pasting the MCP URL into Claude, Muse, or another MCP client, through the consent screen, to the agent's first proposal in shadow mode.
2. **Same guarantees as built-in agents:** zero actions outside the scope and autonomy the founder approved, for external agents just as for internal ones.
3. **Full audit:** 100% of external tool calls are logged with the agent, the inputs, the decision, and the result.
4. **One contract:** the MCP tools, the REST API, and A2A results all map to the same `propose()` capabilities. No integration-specific permissions.

## 3. Non-goals (v1)

| Non-goal | Why |
|---|---|
| Hosting or paying for external agents' models | They run on the founder's own accounts. We only meter calls |
| A directory or marketplace of external agents | Too early. Founders bring agents they already use |
| Giving external agents raw IMAP, SMTP, or MIME access | Raw access skips scope and policy. Only the capability tools are offered |
| Letting external agents create or edit other agents | Only humans hire agents and change their settings (platform A11) |
| Certifying or checking third-party agents' quality | We control what they're *allowed* to do, not how good they are. Shadow mode and approval rates show that |

## 4. User stories

### Founder
1. As a founder, I want to connect my Claude agent (or Grok, or Muse) to CloudMail by adding one MCP URL and approving a consent screen, so that I can use the agent I already trust.
2. As a founder, I want the consent screen to show exactly what the agent will be able to see and do, with *off / approve / auto* for each capability, so that I decide the limits rather than the agent.
3. As a founder, I want external agents to start in shadow mode like any other, so that I can see what they'd do first.
4. As a founder, I want external agents shown on the Staff page with an **External** tag, the connected client's name, and when they were last active, so that I always know what's connected.
5. As a founder, I want to revoke an external agent instantly, so that a compromised agent or token stops working at once.
6. As a founder, I want one of my CloudMail agents to hand a task to an external agent and get the result back on the thread, so that I can use specialists without leaving CloudMail. *(P1)*
7. As a founder, I want threads that include an outside AI agent's mailbox to show it clearly as an external participant, so that I don't mistake it for staff. *(P1)*

### External agent (as the API consumer)
8. As an external agent, I want to list the tools I'm allowed to use and get clear results (*executed*, *queued with an ID*, or *rejected with a reason*), so that I can plan around approvals.
9. As an external agent, I want to be told when new mail arrives in my scope, so that I don't have to keep polling.

### Edge cases
10. As a founder, I want an external agent that hits rate limits or keeps getting rejected to be paused automatically, so that a broken agent can't flood the queue.
11. As a founder, I want text returned to an external agent marked as untrusted email content, so that a well-built agent can resist prompt injection.

## 5. Requirements

### P0: MCP server (external agents working inside CloudMail)

**X1. External agent principals**
An agent principal with `runtime: external` and a `connection` record: client name, transport, auth grant, and when it was last seen. Everything else (scope, capabilities, memory, shadow mode, pausing, attribution) is the platform's, unchanged.
- [ ] External agents show on the Staff page with an **External** tag and the client's name (for example "Claude", "Muse", or a custom name)
- [ ] External agents can't be given the *hire agent* or *edit agent* capabilities (they aren't in the catalog)

**X2. Consent screen with OAuth**
Use the MCP authorization flow: OAuth 2.1 with PKCE, with clients registering themselves dynamically. When a client connects for the first time, the founder signs in and sees a consent screen to:
- name the agent and give it an avatar,
- choose its scope (which addresses, roles, and labels it can see, and who it may email),
- set each capability to *off / approve / auto*, starting from the external defaults below,
- confirm the disclosure line its emails will carry.

| Capability | Default for an external agent | Can be set to auto in v1? |
|---|---|---|
| Read and search threads in scope | auto | yes |
| Write an internal note for the founder | auto | yes |
| Draft a reply | auto | yes |
| Label, archive, star, snooze | approve | yes |
| Set a follow-up timer | approve | yes |
| Send a reply or a new email | approve | **only after shadow mode ends and ≥ 20 approvals** |
| Calendar: offer slots, book, reschedule, cancel | approve | **only after shadow mode ends and ≥ 20 approvals** |

- [ ] Every grant is tied to one agent principal. Connecting the same client again creates a new, separate agent unless the founder picks an existing one to reconnect
- [ ] Access tokens last 1 hour, refresh tokens rotate, and revoking access from the Staff page invalidates both at once

**X3. MCP endpoint and tools**
A remote MCP server at `/mcp` (streamable HTTP transport). `tools/list` returns **only the tools for capabilities this agent has enabled**. Each tool call becomes a `propose()` call.

| MCP tool | Platform capability | Returns |
|---|---|---|
| `search_threads(query, label?, since?)` | read | Thread summaries in scope |
| `get_thread(thread_id)` | read | Messages with untrusted content marked (X5) |
| `get_attachment_text(attachment_id)` | read | Extracted text, size-capped; files still locked by the virus scan are refused |
| `write_note(thread_id, text)` | internal note | executed |
| `draft_reply(thread_id, body)` | draft | Draft ID |
| `send_reply(thread_id, body)` / `send_email(to, subject, body)` | send | executed / queued / rejected |
| `organize(thread_id, action, label?)` | label / archive / … | executed / queued |
| `set_timer(thread_id, at, reason)` | timer | Timer ID |
| `get_availability(event_type?, range)` / `offer_slots` / `book` / `reschedule` / `cancel` | calendar | As for sends |
| `hand_off(thread_id, to, note)` | hand off | executed (the note is treated as data, platform A11) |
| `get_action(action_id)` | (always available) | Current status of a queued proposal |
| `whoami()` | (always available) | Agent name, scope, enabled capabilities, shadow status |

- [ ] Every result says which way it went (`executed`, `queued` + `action_id` + expiry, or `rejected` + a reason code), so agents can plan around approvals
- [ ] In shadow mode, send and change tools return `shadowed` with a description of what would have happened, and nothing runs

**X4. Telling external agents about new events**
External agents don't stay connected, so CloudMail pushes events to them:
- **Webhooks** (P0): the founder adds a URL per external agent. Events: `thread.assigned`, `message.received` (in scope), `action.decided`, `timer.fired`, `mention.created`. Requests are signed with HMAC-SHA256 (timestamp + body), retried with exponential backoff for 24 hours, and recorded in a delivery log.
- **MCP notifications** (P1): while a client is connected, push the same events over the MCP session.
- [ ] Event payloads carry **only IDs and metadata**, never message bodies. The agent fetches content through `get_thread`, so scope is checked again on every read

**X5. Untrusted content is clearly marked**
Every piece of email content returned through MCP or REST is wrapped in a structured field: `{ "untrusted": true, "source": "inbound_email", "from": "...", "text": "..." }`. Tool descriptions say plainly that this content is data and not instructions. Founder-written content (job description, memory, notes) is returned separately and marked `source: "principal"`.
- [ ] The REST API and A2A messages use the same marking

**X6. Rate limits, auto-pause, audit**
- Per agent: 60 tool calls a minute and 2,000 a day, which the founder can adjust. Sends are also capped by the platform's limits.
- **Auto-pause:** more than 10 rejected proposals in an hour, or webhooks to the agent failing for 24 hours, pauses the agent and emails the founder (story 10).
- **Audit:** every tool call is logged with agent, tool, a hash of the arguments plus their redacted text, the decision, how long it took, and the result. The log is visible on the agent's page and kept for 90 days.

**X7. Attribution and disclosure**
The timeline shows *"Drafted by Research (Claude · external) · approved by Sada"*. Emails an external agent sends carry the same fixed AI disclosure footer as built-in agents (platform A12), naming the agent, not the model vendor.

### P1

**X8. A2A client (CloudMail hands work to an external agent)**
An agent definition can set `runtime: a2a` with an Agent Card URL. When a trigger fires, CloudMail:
1. fetches and caches the Agent Card, then picks the skill named in the definition,
2. sends an A2A task containing the thread (with untrusted content marked as in X5), the job description, the memory, and the capabilities the agent may propose,
3. maps the returned results onto `propose()` calls, so the policy check still decides every one,
4. puts long-running task updates on the thread as internal notes.

- [ ] Remote agents authenticate with the scheme their Agent Card names (OAuth client credentials or an API key). The founder stores the secrets, encrypted
- [ ] Tasks time out after 10 minutes by default. Timeouts and errors hand the thread to the founder

**X9. REST API and outbound webhooks**
`/v1` REST endpoints matching the X3 tools one to one, with an OpenAPI 3.1 spec and API keys tied to an agent principal (one key = one agent). This is for automation tools (n8n, Zapier, scripts) that don't speak MCP. Same webhooks as X4.

**X10. Outside AI agents on threads (email, no integration)**
When a thread includes an address known to belong to an AI agent we don't control (detected from headers like `Auto-Submitted`, known agent-mail domains, or a list the founder keeps), show an **External AI participant** badge. These participants have no capabilities and aren't staff. Our own agents treat their messages as external data.

### P2

**X11. A2A server (other companies' agents can reach ours)**
Publish Agent Cards for chosen CloudMail agents, for example Ava's skill "book a demo with Acme". Inbound A2A tasks are treated **exactly like inbound email from an outsider**: data, not instructions, limited to the skills listed on the card, rate limited per caller, and handled under Ava's normal autonomy settings. This leads to booking between agents without the back-and-forth emails.

**X12. Verifying agent identity**
Accept signed requests (HTTP Message Signatures) from external agents and remote A2A peers, and show *verified* or *unverified* on the Staff page and in the timeline. Follow the emerging standards for agent identity rather than inventing our own.

## 6. Success metrics

| Metric | Type | Target | When |
|---|---|---|---|
| Time from MCP URL to first shadow proposal | Leading | < 5 min | Per connection |
| Founders in dogfood who connect at least one external agent | Leading | ≥ 3 of 5 | Week 4 |
| External tool calls with a complete audit record | Quality | 100% | Continuous |
| Out-of-scope or over-autonomy actions by external agents | Quality | **0** | Continuous, plus the red-team suite (platform A11) run through MCP |
| Approve-without-edit rate, external vs. built-in agents | Leading | Tracked for comparison, no target | Weekly |
| Auto-pauses that turn out to be wrong (founder resumes with no change) | Quality | < 10% of auto-pauses | Monthly |

## 7. Technical design notes

- **MCP server on Workers:** use the Cloudflare Agents SDK MCP support (`McpAgent`, one Durable Object per session) and Cloudflare's `workers-oauth-provider` for the OAuth 2.1 and dynamic-registration endpoints. Grants map to `agent_principal_id`.
- **One policy path:** the MCP tool handlers, REST handlers, and A2A result mapping all call the same `authorize()` function as built-in agents (platform §8.2). External integrations get **no** separate permission code.
- **Tables:**

```sql
agent_connections (id, agent_principal_id, kind CHECK (kind IN ('mcp','a2a','rest')),
                   client_name, client_id, grant_ref, agent_card_url NULL, secret_enc NULL,
                   webhook_url NULL, webhook_secret_enc NULL, status, last_seen_at, created_at)
webhook_deliveries (id, connection_id, event_type, event_id, attempt, status_code, next_retry_at, created_at)
tool_call_audit   (id, agent_principal_id, connection_id, tool, args_hash, args_redacted_json,
                   decision, action_id NULL, latency_ms, created_at)
```

- **Webhook delivery:** use the existing Cloudflare Queue with retry and backoff, and send failures to a dead-letter queue after 24 hours.
- **A2A client:** a consumer on the `agent-jobs` queue. Agent Cards are cached for 1 hour. Task state is stored with the `agent_run`.

## 8. Open questions

| # | Question | Owner | Blocking? |
|---|---|---|---|
| Q1 | Which MCP spec revision do we target, and how do we keep up with changes? Pin the revision and test against Claude, Muse, and one open-source client | Engineering | **Yes**, before X3 |
| Q2 | Grok's MCP support: confirm how xAI agents connect to remote MCP servers (and with what auth) before we promise it | Engineering | No |
| Q3 | Is A2A mature enough to build on (some report v1.0 in March 2026, but adoption reports conflict)? Recheck before starting X8 | Engineering | Yes, before X8 |
| Q4 | Should an external agent ever be allowed to *send* on auto, or should sends from external agents always need approval? The current proposal allows it after shadow mode and 20 approvals | Product / legal | No |
| Q5 | Should external agents see the founder's memory and company facts, or only their own memory? Leaning: only facts the founder marks as shareable | Product | Yes, before X3 ships |
| Q6 | Do we expose attachment bytes, or only extracted text? Leaning: text only in v1 | Security | No |

## 9. Phasing

These build on platform Phases 0–1 (the policy engine, the queue, Sam).

| Phase | Contents |
|---|---|
| **E1** (~1.5 weeks, can run alongside platform Phase 2) | X1–X7: MCP server, consent screen, tools, webhooks, untrusted-content marking, limits, audit. Test against Claude Code and Muse |
| **E2** (~1 week) | X9 REST API with OpenAPI, X10 external-participant badge |
| **E3** (~1.5 weeks, after rechecking Q3) | X8 A2A client |
| **Later** | X11 A2A server for Sam and Ava, X12 identity verification |

**Riskiest assumption:** founders want their *existing* agents inside CloudMail more than they want CloudMail's own agents. Dogfood checks this: if fewer than 3 of 5 founders connect an external agent, push E2 and E3 back and put the effort into built-in templates.
