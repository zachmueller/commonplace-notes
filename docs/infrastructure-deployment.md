# Infrastructure Deployment

Commonplace Notes can provision its own AWS infrastructure (S3 bucket + CloudFront distribution) directly from within Obsidian. This eliminates the need to manage a separate CDK project or manually create AWS resources.

## Prerequisites

- An AWS account with appropriate permissions
- An AWS credentials profile configured locally (via `~/.aws/credentials`, `~/.aws/config`, or SSO)
- The AWS profile must have permissions to create CloudFormation stacks, S3 buckets, CloudFront distributions, and (optionally) ACM certificates and Route53 records

### Required IAM Permissions

The deploying user/role needs at minimum:

- `cloudformation:CreateStack`, `cloudformation:DescribeStacks`, `cloudformation:DescribeStackEvents`, `cloudformation:DeleteStack`
- `s3:CreateBucket`, `s3:PutBucketVersioning`, `s3:PutBucketPolicy`, `s3:PutPublicAccessBlock`
- `cloudfront:CreateDistribution`, `cloudfront:CreateOriginAccessControl` (or `CreateCloudFrontOriginAccessIdentity` for OAI)
- If using custom domains: `acm:RequestCertificate`, `acm:DescribeCertificate`, `acm:ListCertificates` (to offer reuse of existing certificates)
- If using Route53: `route53:ListHostedZones`, `route53:ChangeResourceRecordSets`, `route53:CreateHostedZone` (only if creating a new zone)

---

## New Deployment (From Scratch)

This is the recommended path for users setting up publishing infrastructure for the first time.

### Step 1: Open the Deployment Wizard

Either:
- Open the command palette and run **"Deploy publishing infrastructure"**
- Or navigate to **Settings > Publishing profiles > [Your Profile] > Infrastructure** and click **"Deploy Infrastructure"**

You will be prompted to select a publishing profile if you have more than one.

### Step 2: Configure

The wizard presents a configuration form:

| Field | Required | Description |
|-------|----------|-------------|
| AWS Profile | Yes | The named profile from your `~/.aws/credentials` or `~/.aws/config` |
| Region | Yes | AWS region for the S3 bucket and CloudFront distribution (e.g., `us-east-1`) |
| Variant Name | No | A label for multi-instance deployments (e.g., "personal", "work"). Affects stack and bucket naming. |
| S3 Prefix | No | Path prefix within the bucket if you want notes stored under a subdirectory |
| Origin Access Method | Yes | **OAC** (recommended, modern) or **OAI** (legacy, compatible with older setups) |
| Custom Domain | No | A domain you own (e.g., `notes.example.com`). Requires DNS configuration. |
| Use Route53 | No | Automatically manage DNS records via Route53 (see below) |

#### Route53 Setup (Automatic)

When you enable **Use Route53**, the wizard automatically queries your AWS account for hosted zones:

- **Matching zone found:** If a hosted zone matching your custom domain exists (e.g., you entered `notes.example.com` and a zone for `example.com` exists), it is pre-selected in a dropdown. No manual input needed.
- **No matching zone:** The wizard offers two options:
  - **Create Zone** — creates a new Route53 hosted zone for your domain's parent (e.g., `example.com`). After creation, you'll need to update your domain registrar's nameservers to point to the Route53 nameservers.
  - **Select from existing zones** — pick any zone in your account from a dropdown.
- **Manual override:** You can always switch to "Enter manually..." in the dropdown to type a Hosted Zone ID and Name directly.

If the wizard cannot access Route53 (e.g., missing permissions), it falls back to manual text inputs.

Click **Next** to proceed.

### Step 3: Certificate (Custom Domain Only)

If you specified a custom domain, the wizard first looks for an **existing** ISSUED certificate in `us-east-1` that already covers it (certificates for CloudFront must live in `us-east-1` regardless of your chosen region). Matching considers a certificate's primary domain **and all its Subject Alternative Names**, with wildcard semantics — so a certificate issued for `example.com` with a `*.example.com` SAN is recognized as valid for a subdomain site like `notes.example.com`.

You then choose:
- **Reuse a matching certificate** — the best match (exact over wildcard, latest expiry) is preselected. Reusing an already-validated certificate skips both certificate creation and DNS validation.
- **Create a new certificate** — deploys a fresh ACM certificate for your domain (the previous default). The wizard displays real-time stack events; this typically takes 1-2 minutes, then continues to DNS validation.
- **Enter certificate ARN manually...** — paste an ARN directly. It is validated (must exist, be ISSUED, and cover your domain) before it can be used.
- **Show all issued certificates...** — lists every issued certificate in the account, flagging any that do not cover your domain.

If the wizard cannot list certificates (e.g., missing `acm:ListCertificates`), it falls back to creating a new certificate or entering an ARN manually.

### Step 4: DNS Validation (New Certificate + Manual DNS Only)

If you are **not** using Route53, you must manually add a CNAME record to validate domain ownership:

1. The wizard displays the CNAME **Name** and **Value** — use the copy buttons to grab them
2. Add this CNAME record to your DNS provider (Cloudflare, Namecheap, GoDaddy, etc.)
3. Click **"Check Status"** periodically until the certificate shows as **ISSUED**

DNS propagation typically takes 5-30 minutes depending on your provider.

If you close the wizard before validation completes, you can return to it later via **Settings > Infrastructure > Manage DNS**.

### Step 5: Full Stack Deployment

The wizard deploys the main infrastructure:
- S3 bucket (versioned, private, with retention policy)
- CloudFront distribution (HTTPS, HTTP/2, global edge caching)
- Bucket policy granting CloudFront read access
- Route53 records (if enabled)

Real-time stack events are displayed. This step typically takes 3-5 minutes (CloudFront distribution creation is the slowest part).

### Step 6: Completion

Once deployment succeeds, the wizard shows your new infrastructure outputs:
- **Bucket Name** — where your notes are stored
- **Distribution ID** — for cache invalidation
- **Distribution Domain** — the `*.cloudfront.net` address
- **Site URL** — either your custom domain or the CloudFront domain

Click **"Apply to Profile"** to automatically write these values into your publishing profile settings. This populates:
- Bucket name
- CloudFront distribution ID
- Region
- Base URL

Click **Done** to close the wizard. Your profile is now ready to publish.

### What Gets Created

| Resource | Naming Convention | Notes |
|----------|-------------------|-------|
| CloudFormation Stack | `cpn-{variantName}` or `cpn-default` | Tracks all resources |
| S3 Bucket | `published-notes-{accountId}-cpn-{variantName}` | Retained on stack deletion |
| CloudFront Distribution | Auto-generated ID | PriceClass_100 (NA/EU edges) |
| Certificate Stack | `cpn-cert-{variantName}` | Only if custom domain; always in us-east-1 |

---

## Importing an Existing Deployment

If you previously deployed infrastructure using the standalone CDK project (`published-commonplace-notes-cdk`), you can import that stack so the plugin tracks it alongside your profile settings.

### When to Use Import

- You already have a working S3 bucket and CloudFront distribution deployed via CDK
- You want the plugin's settings UI to display infrastructure status
- You want the "Sync settings from stack" convenience feature

### What Import Does (and Doesn't Do)

**Does:**
- Reads stack outputs (bucket name, distribution ID, site URL) via `DescribeStacks`
- Populates your profile settings automatically
- Displays the stack as "deployed" in the Infrastructure settings section

**Does not:**
- Modify the existing stack in any way
- Take over management of the stack (no updates or destroys from the plugin)
- Require any changes to your existing CDK project

Imported stacks are marked as "Managed externally via CDK" and the plugin will not offer update or destroy actions for them.

### Import Steps

1. Navigate to **Settings > Publishing profiles > [Your Profile] > Infrastructure**
2. If your profile already has a bucket name and distribution ID configured, an **"Import"** button appears
3. Click **Import**
4. Enter the stack name (default: `PublishedCommonplaceNotesStack`). If you used a variant name in CDK, the stack might be named `PublishedCommonplaceNotesStack-{YourVariant}`
5. Enter the region where the stack was deployed
6. The plugin reads the stack outputs and populates your profile settings

### Verifying the Import

After import, the Infrastructure section shows:
- Status: **Deployed**
- Stack name and region
- Origin Access: OAI (Legacy) — since the CDK project uses OAI
- A note indicating external management

---

## Managing Deployed Infrastructure

### Syncing Settings

If stack outputs change (e.g., you updated the CDK stack externally), click **"Sync settings from stack"** in the Infrastructure section to re-read outputs and update your profile.

### DNS Management

If your certificate is pending validation or you need to revisit the DNS records, click **"Manage DNS"** to open the DNS assistant modal. This shows the CNAME records and lets you check certificate status.

### Destroying Infrastructure

For plugin-deployed stacks (not imported ones):

1. Run the command **"Destroy publishing infrastructure"** or find the button in Settings > Infrastructure
2. Confirm the destruction in the confirmation dialog
3. The plugin deletes the full stack, then the certificate stack (if one exists)

**Important:** The S3 bucket has a `Retain` deletion policy — it will **not** be deleted when the stack is destroyed. Your published content remains safe. You must manually delete the bucket via the AWS console if you want to fully clean up.

---

## Troubleshooting

### "No valid AWS credentials found"

The plugin checks credentials in this order:
1. Environment variables (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`)
2. Shared credentials file (`~/.aws/credentials` with the named profile)
3. AWS SSO (`~/.aws/config` with SSO configuration)

Ensure your profile name in the wizard matches what's in your AWS config files.

### Certificate stuck in PENDING_VALIDATION

- Verify the CNAME record was added correctly (exact name and value, no trailing dots unless your provider requires them)
- Some providers take up to 72 hours, but most resolve in under 30 minutes
- Check that you're not accidentally adding the record to the wrong hosted zone

### Stack creation fails with "AccessDenied"

Your AWS credentials lack the required permissions. Check the IAM Permissions section above and ensure your user/role has the necessary policies.

### Stack shows ROLLBACK_COMPLETE

This means creation failed and AWS rolled back. The stack events in the wizard log will show which resource failed and why. Common causes:
- Bucket name already exists (globally unique constraint)
- Certificate ARN is invalid or in wrong region
- Insufficient permissions for a specific resource type

### CloudFront distribution takes too long

CloudFront distributions typically take 3-5 minutes to create, but can occasionally take up to 15 minutes. The wizard polls every 5 seconds and will wait until completion.
