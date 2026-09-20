import {
  prepareMaintainerContainerImage,
  resolveMaintainerCloudflareAccountId,
} from "../cli/src/installation-deployment.ts";
import { parseContainerImageSource } from "../cli/src/container-image.ts";

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Production Container image preparation requires ${name}.`);
  return value;
};

const controller = new AbortController();
const interrupt = (): void => controller.abort();
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);

try {
  const profile = process.env.ALCHEMY_PROFILE?.trim() || "default";
  if (process.argv[2] === "--account") {
    const accountId = await resolveMaintainerCloudflareAccountId(profile, controller.signal);
    process.stdout.write(`${JSON.stringify({ accountId })}\n`);
  } else {
    const reference = await prepareMaintainerContainerImage(
      {
        installationName: required("SCOTTY_INSTALLATION_NAME"),
        profile,
        expectedAccountId: required("SCOTTY_EXPECTED_ACCOUNT_ID"),
        source: parseContainerImageSource(required("SCOTTY_CONTAINER_IMAGE_SOURCE")),
      },
      controller.signal,
    );
    process.stdout.write(`${JSON.stringify({ reference })}\n`);
  }
} finally {
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
}
