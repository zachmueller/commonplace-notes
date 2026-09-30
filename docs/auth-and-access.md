# Authentication & access

By default a published Commonplace Notes site is fully public. You can optionally
gate **who can read** it and add a **comment box** that only signed-in readers can
write to. All of this is configured in the
[deployment wizard](infrastructure-deployment.md)'s Authentication step and shown
under **Settings → Publishing profiles → Authentication & Delivery**.

## Two independent axes

These are separate choices served by (optionally) the same AWS Cognito pool:

- **Read access** — who can *view* the site (the read gate).
- **Comment identity** — who can *write* comments (sign-in).

They compose freely. For example, you can password-protect reads *and* let readers
sign in with Google to comment.

## Read-gating modes

The read gate produces (or omits) a versioned viewer-request **Lambda@Edge** ARN
that's wired into the site's CloudFront distribution (the `AuthLambdaEdgeArn`
parameter). Four modes, selected via the wizard's **Read access** dropdown:

| Mode | Wizard label | Behavior |
|------|--------------|----------|
| `none` | Public (anyone can read) | Fully public reads. No edge function, unless you turn on [per-note access groups](#per-note-access-groups-on-a-public-site). |
| `cognito` | Login required (Cognito + Google) | Whole-site sign-in via Cognito Hosted UI + Google. Supports [per-note access groups](#per-note-access-groups). |
| `password` | Password (anyone with the password) | Shared password enforced at the edge. |
| `byo` | Custom Lambda@Edge ARN (advanced) | You supply your own viewer-request Lambda@Edge ARN. |

## Cognito and Google sign-in

Choosing `cognito` reads (or enabling comment identity) provisions an AWS Cognito
user pool with Google as the identity provider, deployed as its own sub-stack. To
finish setup you register CPN's callback URLs with Google:

1. In the wizard, enter your **Google Client ID** and **Google Client Secret**
   (from the Google Cloud Console → Credentials → OAuth 2.0 Client ID), and choose
   an **Auth domain prefix** — a globally-unique name that becomes
   `<prefix>.auth.<region>.amazoncognito.com`.
2. CPN shows the exact **authorized JavaScript origin** and **redirect URI** to
   paste into your Google OAuth client. These are also always retrievable later
   under **Authentication & Delivery** (with copy buttons).

The `googleClientId` and `authDomainPrefix` are persisted as author intent; the
**Google client secret is never stored** — it's captured transiently and passed
as a NoEcho CloudFormation parameter at deploy time (re-enter it on each deploy).

## Password gating

Choosing `password` reads prompts for a **site password**. It's hashed (sha256)
before deploy — the plaintext never leaves the plugin. The hash is persisted (a
low-sensitivity shared read password) so a later stack update doesn't force you to
re-enter it; re-type the password only to change it.

## Bring-your-own (BYO)

Choosing `byo` lets you paste a versioned viewer-request **Lambda@Edge ARN**
(must be in `us-east-1`) — e.g. from your own auth system. You can also set or
change this ARN after deploy via the **Auth Lambda@Edge → Configure/Update**
action in settings, which does a targeted stack update of just the auth wiring.

## Per-note access groups

The read gate applies to the whole site. **Access groups** narrow it for
individual notes: a note that lists groups is readable only by signed-in readers
in at least one of those groups. Notes that list no groups keep the site-wide
read access.

Access groups work on two kinds of site:

- **Login-required sites** (`cognito` read gate). Everyone signs in to read
  anything; gated notes further require membership.
- **Public sites** (`none` read gate). Notes without groups stay public and
  anonymous. Only gated notes need sign-in and membership. See
  [below](#per-note-access-groups-on-a-public-site).

### Setting it up

1. Deploy (or upgrade) the site with the **`cognito`** read gate, or set up a
   [public site](#per-note-access-groups-on-a-public-site). Existing Cognito
   sites need a one-time **Settings → Infrastructure → Upgrade Cognito gate**.
   The upgrade moves the sign-in edge function to its own stack and adds the
   membership trigger. The site stays up throughout; it takes several minutes.
2. Under **Settings → Publishing profiles → Access groups**, add a group (for
   example `family`) and list its members' Google account emails, one per line.
3. In a note, list the groups that may read it:

   ```yaml
   ---
   cpn-publish-contexts:
     - default
   cpn-access-groups:
     - family
   ---
   ```

4. Publish. Membership is uploaded on every publish (or with **Sync membership
   now**).

Group names use lowercase letters, digits, and hyphens (up to 40 characters).

### What readers see

- **Members** see the note like any other, with a lock badge. It opens by link,
  by `#/u<uid>`, and by title.
- **Everyone else** gets the same "might not exist or you may not have
  permission" message as for a missing note. The site does not reveal that the
  note exists. On a public site, signed-out readers also see a **Sign in** link
  there and in the header. The link appears for any missing note, so it gives
  nothing away.
- **Membership changes** apply at a reader's next sign-in. The session cookie
  lasts an hour, so removing someone takes effect within about an hour.

### What a gated note leaves out

A gated note is published only to its groups' `restricted/<group>/` area. It is
kept out of everything readable site-wide:

- **Search**, **LLM chat**, and **comments** skip gated notes in this version.
- **Links** to a gated note render as plain text unless every reader of the
  linking note can also read the target.
- **Backlinks** from a gated note appear only in copies its readers can see.

### Fail-closed rules

CPN never publishes a gated note publicly. A note that lists groups is removed
from the site, with a notice, when any of these hold:

- A listed group isn't defined in the profile, or a name is invalid.
- The read gate is `password`, or `byo` without the opt-in below.
- The read gate is `cognito` but the gate hasn't been upgraded, or it runs the
  public-site build of the edge function.
- The read gate is `none` but access groups aren't turned on for the site, or
  the access-groups edge function isn't deployed.
- The site was pointed at a different edge function by hand.
- The profile uses the Local publish mechanism.
- The note is the profile's home note.

Changing a note's groups deletes its old copies, including earlier revisions,
from every area it left, and invalidates the CloudFront cache. Permalinks
(`#/p<hash>`) and diffs that point at those deleted revisions stop working.

### Per-note access groups on a public site

A public site can gate individual notes without asking anyone else to sign in.
CPN attaches the Cognito edge function in a **public-reads** mode:

- Every path outside `/restricted/` passes straight through. There's no
  token check, so public notes stay anonymous.
- `/restricted/<group>/…` requires a signed-in reader in `<group>`.
- `GET /restricted/whoami` answers signed-out readers with
  `{"groups": [], "signedIn": false}`, so the site knows to offer sign-in.

**Cost.** This adds a Lambda@Edge invocation to every request, public ones
included. That's about US$0.60 per million requests plus a small duration
charge, and a few milliseconds of latency. It's off unless you turn it on.

To set it up:

1. The site needs the Cognito sign-in pool. A site with comments already has
   one. Otherwise re-run the deployment wizard with **Public** reads and turn
   on **Gate individual notes with access groups**, which deploys everything.
2. For an existing pool, turn on **Access groups → Gate notes on this public
   site**, then run **Settings → Infrastructure → Deploy access-groups edge
   function**. It adds the membership trigger and attaches the edge function.
   Public notes keep working throughout.
3. Define groups and gate notes as [above](#setting-it-up), then publish.

Why a signed-out reader gets **403**, not a redirect to sign-in, on a gated
note: the site only ever fetches gated notes in the background, where a
redirect to the sign-in page can't be followed. A "please sign in" response
would make the site reload in a loop. And the same 403 for "signed out" and
"not a member" means a stranger can't tell whether a note exists. The site
offers sign-in itself, based on whoami.

**Turning it off.** Switching the toggle off leaves the edge function
attached, so already-published gated notes stay protected. They're removed
from the site at the next publish.

**Detaching is refused while gated notes exist.** If `restricted/` in the site
bucket has any objects, CPN refuses to attach an edge function that doesn't
enforce access groups. That covers re-running the wizard with plain public
reads, switching to a password gate, or clearing the ARN in **Auth
Lambda@Edge → Update**. Remove the groups from those notes and publish, or
remove the groups in settings, first. The Auth Lambda@Edge dialog has an
explicit **Detach anyway** button for recovery; it makes those notes public.

### Bring-your-own edge functions

A `byo` site can use access groups when its edge function enforces the same
contract. It must allow `/restricted/<group>/*` only for viewers in `<group>`,
and answer `GET /restricted/whoami` with `{"groups": [...]}`. Confirm this with
**My edge function enforces access groups** in the Access groups section.
Password sites can't use access groups.

## Commenting

Enabling commenting deploys a self-hosted comment backend as a sub-stack — an S3
bucket, an API Gateway, and a DynamoDB table. It **requires Cognito comment
identity** (only signed-in readers can write; comment *reads* inherit the site's
read-access mode). In the wizard:

- Toggle **Enable commenting (Cognito + Google sign-in)** to provision the pool.
- Toggle **Deploy commenting backend** to stand up the comment infrastructure.

The comment box renders on published note pages, so after enabling it run
**Publish all notes** and open a note to see it.

## What gets deployed

CPN uses these CloudFormation templates (see `src/infrastructure/templates.ts`):

| Template | Purpose |
|----------|---------|
| `CERTIFICATE_TEMPLATE` | ACM certificate for a custom domain (DNS-validated, in `us-east-1`). |
| `COGNITO_AUTH_TEMPLATE` | Cognito user pool + Google IdP + OAuth callback + access-group membership trigger. |
| `COGNITO_EDGE_TEMPLATE` | The Cognito viewer-request edge function (`cpn-authedge-<variant>`), packaged as an S3 asset. Its `PublicReads` parameter and output record whether it runs in public-site mode. |
| `PASSWORD_AUTH_TEMPLATE` | Password-check viewer-request edge function. |
| `FULL_STACK_OAC_TEMPLATE` | S3 + CloudFront using Origin Access Control (modern). |
| `FULL_STACK_OAI_TEMPLATE` | S3 + CloudFront using Origin Access Identity (legacy). |
| `COMMENT_STACK_TEMPLATE` | Comment backend: S3 + API Gateway + DynamoDB. |

The Cognito edge and password sub-stacks emit the versioned Lambda@Edge ARN
that the full-stack template associates as a `viewer-request` function on the
distribution. Both edge functions are uploaded as zips to the per-account
`cpn-bootstrap` bucket, so their code has no inline size limit.

## Managing after deploy

Under **Authentication & Delivery** (and Infrastructure):

- **Auth Lambda@Edge → Configure/Update** — change the auth edge function ARN with
  a targeted stack update.
- **Cognito gate → Upgrade / Redeploy** — migrate an older Cognito deployment to
  the separate edge stack (needed for access groups), or redeploy the latest edge
  function and trigger code. On a public site with access groups turned on, the
  button reads **Deploy access-groups edge function**.
- **Sync settings from stack** — re-read stack outputs (bucket, distribution ID,
  site URL) into the profile.
- **Manage DNS** — reopen the DNS validation assistant for a pending certificate.

For the deploy/import/destroy mechanics themselves, see
[Infrastructure deployment](infrastructure-deployment.md).

> **Destroying auth stacks.** Lambda@Edge replicas take time for CloudFront to
> remove, so a teardown can leave stacks behind temporarily. If that happens, use
> **Force-clean leftover infrastructure** in the profile's Danger Zone once the
> replicas have cleared.

## Troubleshooting auth

- **Google sign-in fails** — the authorized JavaScript origin / redirect URI in
  your Google OAuth client must exactly match the values CPN shows under
  Authentication & Delivery.
- **Auth domain prefix rejected** — it must be globally unique and can't contain
  `aws`, `amazon`, or `cognito`.
- **Comments don't appear** — commenting requires Cognito comment identity, and
  the widget only shows after you **Publish all notes** and open a published note.

See also [Troubleshooting](troubleshooting.md) and the infra doc's
[troubleshooting section](infrastructure-deployment.md#troubleshooting).
