# Security

## Report a problem

Please do not open a public issue for a security problem.
Use GitHub private vulnerability reporting on this repository (Security tab, "Report a vulnerability").

## Scope

In scope: the server in `server/`, the web app in `web/`, and the install scripts in `scripts/`.
Examples: auth bypass, token leak, a way to reach the server without Tailscale,
a way to send commands from another origin, private session fields reaching the
phone or the log, writes to Claude's files.

Out of scope: Tailscale, the Claude app, Claude Code, and Claude Control
(report those to their own projects).

## What you should know before you install

- Anyone with your login link has full access. Treat it like a password.
  To rotate the token, stop the agent, delete `data/token`, run `scripts/install.sh`, and make a new link.
- Sessions you can open or revive from the phone run commands on your Mac.
- Do not expose port 7810 with anything other than `tailscale serve`.
