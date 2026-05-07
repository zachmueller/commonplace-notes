# Spec: In-Plugin Infrastructure Deployment via CloudFormation

## Problem

Users must manually deploy a separate CDK repository and copy-paste outputs (bucket name, CloudFront distribution ID) into plugin settings. This creates friction when launching a new published site.

## Goal

Let users provision their publishing infrastructure (S3 + CloudFront + optional custom domain with ACM) directly from Obsidian, without leaving the plugin or installing additional tools.

## Key Requirements

1. Support custom domains with ACM certificates (DNS-validated)
2. Allow choice to NOT use Route53 (manual DNS verification) to save costs
3. Optionally allow Route53 for auto-configure
4. Plugin should help facilitate grabbing DNS validation record details (easy copy/paste)
5. Must ship within Obsidian's standard plugin format (main.js, manifest.json, styles.css only)

---

## Architecture Overview

```
Build time:  CDK code (infrastructure/) --> cdk synth --> CloudFormation JSON templates
                                                              |
                                                Embedded as string constants in src/
                                                              |
Runtime:     Plugin (main.js) --> AWS SDK CloudFormation client --> deploys template
                                       with user-specific parameter values
```

- CDK stays in the repo as a **dev dependency** for template generation only
- Users only need AWS credentials (already required for publishing)
- No CDK CLI, no npx, no npm install at runtime
- Templates are **fully portable across AWS accounts** via CloudFormation's built-in mechanisms

### How Portability Works

CloudFormation templates are inherently account-agnostic. The same template deploys correctly in any AWS account because:

1. **Account-specific values** (`AWS::AccountId`, `AWS::Region`) are pseudo-parameters that auto-resolve at deploy time.

2. **User-configurable values** (bucket name, S3 prefix, domain, variant name) are declared as `Parameters` in the template. The plugin passes these from the wizard UI when calling `CreateStack`:
   ```json
   "Parameters": {
     "S3Prefix": { "Type": "String", "Default": "" },
     "VariantName": { "Type": "String", "Default": "" },
     "CustomDomain": { "Type": "String", "Default": "" }
   }
   ```

3. **Cross-resource references** (e.g., CloudFront distribution ID in the bucket policy, certificate ARN on the distribution) use CloudFormation intrinsic functions (`!Ref`, `!GetAtt`, `Fn::Sub`) that resolve at deploy time as resources are created:
   ```json
   "BucketPolicy": {
     "Condition": { "StringEquals": {
       "AWS:SourceArn": { "Fn::Sub": "arn:aws:cloudfront::${AWS::AccountId}:distribution/${NotesDistribution}" }
     }}
   }
   ```
   The `${NotesDistribution}` reference resolves to whatever distribution ID AWS assigns.

4. **Conditional resources** (Route53 records, custom domain config) use CloudFormation `Conditions` so a single template handles all variants:
   ```json
   "Conditions": {
     "HasCustomDomain": { "Fn::Not": [{ "Fn::Equals": [{ "Ref": "CustomDomain" }, ""] }] },
     "UseRoute53": { "Fn::Equals": [{ "Ref": "UseRoute53Param" }, "true"] }
   }
   ```

---

## 1. CDK Code (Build-Time Only)

Keep `infrastructure/` at the repo root as a development tool:

```
infrastructure/
  bin/synth.ts                   # Script to synthesize templates into src/
  lib/
    published-notes-stack.ts     # Full stack (S3 + CloudFront + ACM + optional Route53)
    certificate-stack.ts         # Phase 1: cert-only stack (for two-phase deploy)
  assets/index/index.html
  package.json                   # aws-cdk-lib, constructs (dev only)
  tsconfig.json
  cdk.json
```

**Critical CDK pattern -- use `CfnParameter` instead of props:**

The CDK code must use `CfnParameter` for all user-configurable values. This ensures the synthesized CloudFormation template contains proper parameters (not hardcoded literals):

```typescript
// In the CDK stack constructor:
const variantName = new cdk.CfnParameter(this, 'VariantName', {
  type: 'String',
  default: '',
  description: 'Optional variant suffix for multi-instance deployments',
});

const s3Prefix = new cdk.CfnParameter(this, 'S3Prefix', {
  type: 'String',
  default: '',
  description: 'Optional path prefix in S3 bucket for notes',
});

// Use in resource definitions via valueAsString:
const bucket = new s3.Bucket(this, 'Bucket', {
  bucketName: cdk.Fn.sub('published-notes-${AWS::AccountId}-cpn${Suffix}', {
    Suffix: cdk.Fn.conditionIf('HasVariantName',
      cdk.Fn.sub('-${VariantName}'),
      ''
    ).toString(),
  }),
});
```

This differs from the typical CDK pattern of passing values via `props` (which bakes them as constants). Using `CfnParameter` keeps the template generic.

**Build script** (`infrastructure/bin/synth.ts`): Synthesizes both templates and writes them as TypeScript string constants to `src/infrastructure/templates.ts`:

```typescript
// Auto-generated - do not edit. Run `npm run synth` to regenerate.
export const CERTIFICATE_TEMPLATE = `{...CloudFormation JSON with Parameters...}`;
export const FULL_STACK_TEMPLATE = `{...CloudFormation JSON with Parameters + Conditions...}`;
```

**npm script:** Add `"synth": "cd infrastructure && npx ts-node bin/synth.ts"` to root `package.json`.

**When to regenerate:** Only when `infrastructure/lib/*.ts` changes. The generated `templates.ts` is committed to the repo, so contributors building the plugin don't need CDK installed.

---

## 2. CDK Stack Design (Two-Phase Deploy)

### Phase 1: Certificate Stack (`certificate-stack.ts`)

Creates only:
- ACM Certificate (in us-east-1) with DNS validation
- Custom resource Lambda that queries ACM for validation CNAME records and outputs them

**CloudFormation Parameters:**

| Parameter | Type | Purpose |
|-----------|------|---------|
| `CustomDomain` | String | The domain to issue a cert for (e.g. `notes.example.com`) |

**Outputs:**
- `CertificateArn` - passed into Phase 2
- `ValidationRecordName` - CNAME name for DNS validation
- `ValidationRecordValue` - CNAME value for DNS validation

**Note:** This stack is always deployed to `us-east-1` (ACM requirement for CloudFront). The plugin hardcodes this region for the cert stack regardless of the user's chosen region for the main stack.

### Phase 2: Full Stack (`published-notes-stack.ts`)

Creates:
- S3 bucket (block all public access, versioned, RETAIN)
- CloudFront distribution with:
  - S3 origin via OAC (not the deprecated OAI)
  - Optional custom domain + viewer certificate (references cert ARN from Phase 1)
  - REDIRECT_TO_HTTPS, HTTP/2, PRICE_CLASS_100
- Bucket policy (CloudFront service principal, using `!GetAtt Distribution.DistributionId` for the condition)
- BucketDeployment for base index.html
- **Conditional:** Route53 A/AAAA alias records (only if `UseRoute53 = true`)

**CloudFormation Parameters:**

| Parameter | Type | Default | Purpose |
|-----------|------|---------|---------|
| `VariantName` | String | `""` | Multi-instance suffix (e.g. "personal", "work") |
| `S3Prefix` | String | `""` | Optional path prefix in bucket for notes storage |
| `CustomDomain` | String | `""` | Custom domain for CloudFront (blank = CloudFront domain only) |
| `CertificateArn` | String | `""` | ACM cert ARN from Phase 1 (blank = no custom cert) |
| `UseRoute53` | String | `"false"` | Whether to create Route53 records |
| `HostedZoneId` | String | `""` | Route53 hosted zone ID (required if UseRoute53=true) |
| `HostedZoneName` | String | `""` | Route53 hosted zone name (required if UseRoute53=true) |

**Conditions (derived from parameters):**
```
HasCustomDomain:  CustomDomain != ""
HasCertificate:   CertificateArn != ""
ShouldUseRoute53: UseRoute53 == "true"
HasVariantName:   VariantName != ""
HasS3Prefix:      S3Prefix != ""
```

**Resource naming uses `Fn::Sub` with pseudo-parameters:**
```json
"BucketName": { "Fn::Sub": [
  "published-notes-${AWS::AccountId}-cpn${Suffix}",
  { "Suffix": { "Fn::If": ["HasVariantName", { "Fn::Sub": "-${VariantName}" }, ""] } }
]}
```

**Outputs:**

| Output | Value | Purpose |
|--------|-------|---------|
| `BucketName` | `!Ref Bucket` | For plugin's S3 upload commands |
| `DistributionDomainName` | `!GetAtt Distribution.DomainName` | The CloudFront URL |
| `DistributionID` | `!Ref Distribution` | For CloudFront invalidation commands |
| `SiteUrl` | Conditional: custom domain or CF domain | The final URL for `baseUrl` setting |

**How cross-resource references work at deploy time:**
- Bucket policy references distribution: `!GetAtt Distribution.DistributionId` resolves to `E1ABC2DEF3GHIJ` (auto-assigned)
- CloudFront references bucket: `!GetAtt Bucket.RegionalDomainName` resolves to `published-notes-123456789012-cpn.s3.us-east-1.amazonaws.com`
- CloudFront references cert: `!Ref CertificateArn` (parameter) resolves to whatever ARN the user passes from Phase 1
- Route53 record references distribution: `!GetAtt Distribution.DomainName` resolves to `d1234abc.cloudfront.net`

None of these values need to be known in advance.

---

## 3. New Plugin Source Files

All under `src/infrastructure/`:

| File | Purpose |
|------|---------|
| `templates.ts` | Auto-generated embedded CF templates (committed to repo) |
| `cloudFormationManager.ts` | AWS SDK calls: createStack, describeStacks, deleteStack, waiters |
| `deploymentWizardModal.ts` | Multi-step standalone Obsidian Modal |
| `dnsAssistantModal.ts` | Modal showing validation CNAME records with copy buttons |
| `types.ts` | `InfrastructureDeploymentState`, `DeploymentConfig`, `StackOutputs` |

---

## 4. `CloudFormationManager` Class

Uses `@aws-sdk/client-cloudformation` (new dependency) and the existing credential pattern (AWS CLI profile-based auth via environment).

Key methods:

```typescript
class CloudFormationManager {
  // Stack lifecycle
  async deployCertificateStack(config): Promise<CertDeployResult>
  async deployFullStack(config): Promise<FullDeployResult>
  async getStackStatus(stackName): Promise<StackStatus>
  async getStackOutputs(stackName): Promise<Record<string, string>>
  async deleteStack(stackName): Promise<void>

  // Certificate validation
  async getCertificateValidationRecords(certArn): Promise<DnsRecord[]>
  async checkCertificateStatus(certArn): Promise<'PENDING' | 'ISSUED' | 'FAILED'>

  // Utilities
  async isStackDeployed(stackName): Promise<boolean>
  async pollStackUntilComplete(stackName, onProgress): Promise<StackStatus>
}
```

**How parameters are passed at deploy time:**

The plugin calls `CreateStack` with user values as parameters:

```typescript
await cfnClient.send(new CreateStackCommand({
  StackName: `cpn-${profileId}`,
  TemplateBody: FULL_STACK_TEMPLATE,  // the embedded template string
  Parameters: [
    { ParameterKey: 'VariantName', ParameterValue: config.variantName || '' },
    { ParameterKey: 'S3Prefix', ParameterValue: config.s3Prefix || '' },
    { ParameterKey: 'CustomDomain', ParameterValue: config.customDomain || '' },
    { ParameterKey: 'CertificateArn', ParameterValue: config.certificateArn || '' },
    { ParameterKey: 'UseRoute53', ParameterValue: config.useRoute53 ? 'true' : 'false' },
    { ParameterKey: 'HostedZoneId', ParameterValue: config.hostedZoneId || '' },
    { ParameterKey: 'HostedZoneName', ParameterValue: config.hostedZoneName || '' },
  ],
  Capabilities: ['CAPABILITY_IAM'],  // required since stack creates IAM roles
}));
```

CloudFormation resolves all `!Ref`, `Fn::Sub`, and `Fn::If` expressions using these parameter values plus the deploying account's pseudo-parameters. The template never changes -- only the parameter values differ per user.

**Credential resolution:** Use `fromIni({ profile: awsProfile })` credential provider from `@aws-sdk/credential-providers`, matching the profile configured in plugin settings. Works within the Obsidian process without shelling out.

---

## 5. Deployment Wizard UX (Standalone Modal)

Register command: **"Deploy publishing infrastructure"**

### Step 1: Configuration
- Profile selector (which publishing profile to deploy for)
- Custom domain input (optional, e.g. `notes.example.com`)
- Route53 toggle:
  - If yes: Hosted Zone ID + Hosted Zone Name inputs
  - If no: info text explaining manual DNS will be needed
- Region dropdown (pre-filled from profile)
- Variant name (pre-filled from profile ID)

### Step 2: Deploy Certificate (only if custom domain configured + no Route53)
- Creates the certificate stack in us-east-1
- Shows progress (CREATE_IN_PROGRESS)
- On completion: transitions to DNS step

### Step 3: DNS Validation (only if manual DNS)
- Opens inline DNS records display (or separate `DnsAssistantModal`)
- Shows CNAME records with **Copy** buttons
- Polling "Check Status" button
- Once validated: proceed to full deploy

### Step 4: Deploy Full Stack
- Deploys the main stack (passes cert ARN if applicable)
- Shows progress with stack event streaming
- On completion: show outputs

### Step 5: Completion
- Display all outputs (bucket, distribution domain, distribution ID)
- **"Auto-populate profile settings"** button that fills:
  - `bucketName` from BucketName output
  - `cloudFrontDistributionId` from DistributionID output
  - `baseUrl` from custom domain or CloudFront domain
- "Done" button

---

## 6. DNS Assistant Modal

```
+-----------------------------------------------+
|  DNS Validation Required                       |
|                                                |
|  Add this CNAME record at your DNS provider:   |
|                                                |
|  Name:  _abc123.notes.example.com     [Copy]   |
|  Value: _xyz789.acm-validations...    [Copy]   |
|                                                |
|  Status: Pending validation                    |
|                                                |
|  [Check Status]            [Cancel]            |
+-----------------------------------------------+
```

- Copy buttons use `navigator.clipboard.writeText()`
- "Check Status" calls `ACM.describeCertificate()` and checks `DomainValidationOptions[].ValidationStatus`
- Status updates to "Validated" when complete
- Auto-transitions to full deploy after validation

---

## 7. Type Changes

In `src/types.ts`, add:

```typescript
export interface InfrastructureState {
  certStackName?: string;
  fullStackName?: string;
  status: 'none' | 'cert-deployed' | 'waiting-dns' | 'deployed' | 'failed';
  customDomain?: string;
  useRoute53: boolean;
  certificateArn?: string;
  lastDeployTimestamp?: number;
}
```

Add to `PublishingProfile`:
```typescript
infrastructureState?: InfrastructureState;
```

---

## 8. Settings UI Changes

In `src/settings.ts`, within AWS profile settings section:

- **Infrastructure status badge** showing current state
- **"Deploy Infrastructure"** button that opens wizard modal
- If deployed: read-only display of stack outputs
- If deployed: **"Sync settings from stack"** button to re-pull outputs
- If deployed: **"Destroy infrastructure"** button (double-confirm)

---

## 9. Dependencies

Add to `package.json` (production):
```json
"@aws-sdk/client-cloudformation": "^3.x.x",
"@aws-sdk/client-acm": "^3.x.x",
"@aws-sdk/credential-providers": "^3.x.x"
```

Note: `@aws-sdk/client-s3` is already listed. These are tree-shakeable and esbuild will bundle only what's used.

Add to root `package.json` (dev scripts):
```json
"synth": "cd infrastructure && npx ts-node bin/synth.ts"
```

Add to `.gitignore`:
```
infrastructure/node_modules
infrastructure/cdk.out
```

---

## 10. Files to Modify

| File | Change |
|------|--------|
| `src/types.ts` | Add `InfrastructureState` interface, add field to `PublishingProfile` |
| `src/main.ts` | Instantiate `CloudFormationManager`, register deploy command |
| `src/settings.ts` | Add infrastructure section to AWS profile settings |
| `package.json` | Add `@aws-sdk/client-cloudformation`, `@aws-sdk/client-acm`, `@aws-sdk/credential-providers`, add `synth` script |
| `.gitignore` | Add `infrastructure/node_modules`, `infrastructure/cdk.out` |

**New files:**

| File | Purpose |
|------|---------|
| `src/infrastructure/templates.ts` | Auto-generated CF template strings |
| `src/infrastructure/cloudFormationManager.ts` | AWS SDK orchestration |
| `src/infrastructure/deploymentWizardModal.ts` | Multi-step deployment modal |
| `src/infrastructure/dnsAssistantModal.ts` | DNS validation helper modal |
| `src/infrastructure/types.ts` | Deployment-specific types |
| `infrastructure/` (entire dir) | CDK project for template generation |

---

## 11. Build Pipeline Change

Add a pre-build step (or make it part of `npm run build`):

1. `cd infrastructure && npm install && npx cdk synth`
2. Run `bin/synth.ts` which writes parametrized CF templates to `src/infrastructure/templates.ts`
3. Normal esbuild bundles everything including the template strings into `main.js`

The templates are committed to the repo (so contributors don't need CDK installed unless modifying infrastructure). They only need regeneration when the CDK code changes.

---

## 12. Verification Plan

1. **Template generation:** Run `npm run synth`, verify `src/infrastructure/templates.ts` contains valid CF JSON with expected parameters and conditions
2. **Unit test:** Verify `CloudFormationManager` correctly parameterizes templates and makes expected SDK calls (mock SDK)
3. **Manual deploy test:** Open Obsidian, run "Deploy publishing infrastructure", walk through wizard with a test domain
4. **DNS flow:** Verify CNAME records display correctly, copy buttons work, polling detects validation
5. **Auto-populate:** After deploy, verify profile settings auto-fill from stack outputs
6. **Full E2E:** Deploy infra, publish notes, verify content at CloudFront URL
7. **Destroy:** Run destroy from settings, verify stack deleted and state updated
8. **No-domain flow:** Deploy without custom domain (skip cert phase entirely), verify CloudFront-only setup works

---

## Open Questions

- Should the plugin support updating an existing stack (e.g. adding a custom domain after initial CloudFront-only deploy)? This would use `UpdateStack` instead of `CreateStack`.
- Should we support deploying to a different region than the one configured in the profile's AWS settings? (The full stack can go anywhere; only the cert stack is pinned to us-east-1.)
- How should we handle the case where users have an existing manually-deployed stack from the old CDK repo? Detect via stack name and offer to "adopt" it?
