# Security Policy

Security fixes target the current release line.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's private
vulnerability reporting for `plurnk/plurnk`:

1. open the repository's **Security** tab;
2. choose **Report a vulnerability**;
3. include affected versions, impact, reproduction, and any suggested fix.

If private reporting is unavailable, contact the repository owner privately
through their GitHub profile and request a secure reporting channel. Do not
send credentials, API keys, private model transcripts, or an unsanitized
PLURNK database.

A vulnerability in the daemon or its plugins belongs to
[`plurnk/plurnk-service`](https://github.com/plurnk/plurnk-service/security/policy),
which takes reports the same way.

## Scope

Useful reports include the client exposing credentials or daemon tokens,
connecting to a daemon other than the one it was configured to use, running a
proposal or command without the approval the operator configured, writing
outside its documented locations, and vulnerable release artifacts.

The client relays operator decisions to a daemon that executes local tools by
design. A report should distinguish a decision the operator made from a bypass
of the documented approval policy.
