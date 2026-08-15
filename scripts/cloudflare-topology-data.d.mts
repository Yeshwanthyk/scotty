interface CloudflareBindingTopologyEntry {
  readonly logicalId: string;
  readonly bindingName: string;
  readonly className?: string;
}

export const CLOUDFLARE_BINDING_TOPOLOGY: Readonly<{
  readonly durableObject: CloudflareBindingTopologyEntry & { readonly className: string };
  readonly authDurableObject: CloudflareBindingTopologyEntry & { readonly className: string };
  readonly runnerRegistryDurableObject: CloudflareBindingTopologyEntry & {
    readonly className: string;
  };
  readonly runnerDurableObject: CloudflareBindingTopologyEntry & { readonly className: string };
  readonly sandboxConfigDurableObject: CloudflareBindingTopologyEntry & {
    readonly className: string;
  };
  readonly kv: CloudflareBindingTopologyEntry;
  readonly r2: CloudflareBindingTopologyEntry;
  readonly artifactR2: CloudflareBindingTopologyEntry;
  readonly sandboxBundleR2: CloudflareBindingTopologyEntry;
}>;

export const REQUIRED_TOPOLOGY_DO_FIELDS: readonly [
  "durableObject",
  "authDurableObject",
  "runnerRegistryDurableObject",
  "sandboxConfigDurableObject",
];
export const EXCLUDED_TOPOLOGY_DO_FIELDS: readonly ["runnerDurableObject"];
export const REQUIRED_TOPOLOGY_R2_FIELDS: readonly ["r2", "artifactR2", "sandboxBundleR2"];
