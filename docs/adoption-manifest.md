# Legacy installation adoption

Fresh installations need only a name:

```sh
scotty init --name home
```

Use an adoption manifest only when an installation already exists under resource names that don't
match the current `scotty-NAME-*` convention. Keep the file outside the repository, or name it
`.scotty-adoption.json` so Git ignores it.

```json
{
  "schemaVersion": 1,
  "installationName": "home",
  "stackName": "EXISTING_ALCHEMY_STACK_NAME",
  "resources": {
    "workerName": "EXISTING_WORKER_NAME",
    "runnerWorkerName": "EXISTING_RUNNER_WORKER_NAME",
    "containerName": "EXISTING_CONTAINER_APPLICATION_NAME",
    "kvTitle": "EXISTING_KV_NAMESPACE_TITLE",
    "backupBucketName": "EXISTING_R2_BUCKET_NAME"
  },
  "logicalIds": {
    "worker": "EXISTING_WORKER_LOGICAL_ID"
  }
}
```

Recover access with:

```sh
scotty recover --name home --adoption-manifest /private/path/adoption.json
```

Scotty reads the manifest, checks the exact Worker in the selected Cloudflare account, displays the
mapping, and asks for confirmation before it rotates the root token. Recovery does not deploy code
or rewrite Alchemy state. A later `scotty deploy` can use this mapping only when the named Alchemy
stack already owns those resources.

The manifest contains identifiers, not credentials. Scotty keeps the generated root token only in
the Cloudflare Worker secret, the local mode-0600 config, and a temporary mode-0600 recovery journal
that it removes after success.
