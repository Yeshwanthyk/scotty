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

Recover or deploy it with:

```sh
scotty init --name home --existing --adoption-manifest /private/path/adoption.json
```

The manifest contains identifiers, not credentials. Scotty still keeps the generated root token
only in the Cloudflare Worker secret and the local mode-0600 config.
