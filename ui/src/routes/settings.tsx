import * as stylex from "@stylexjs/stylex";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { CircleAlert, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { CloudSettings } from "../../../protocol/settings/cloud-settings";
import { scottyBaseAgentInstructions } from "../../../protocol/agents/agent-instructions";
import { agentDescriptors, AgentIdSchema } from "../../../protocol/agents/agents";
import { ClaudeReasoningEffort } from "../../../protocol/agents/claude/claude-model-capabilities";
import { codexModelCapabilities } from "../../../protocol/agents/codex/codex-model-capabilities";
import { Button } from "../components/Button";
import { SettingsShell, type SettingsPane } from "../components/SettingsShell";
import { ResourcesSection, type ResourcesSectionHandle } from "../components/ResourcesSection";
import {
  addRepository,
  readCredentials,
  useGithubTokenPermissions,
  type CredentialStatus,
  readCloudSettings,
  readRepositories,
  readResources,
  removeRepository,
  updateCloudSettings,
  type SettingsResult,
} from "../data/settings";
import { readCurrentPrincipal, type CurrentPrincipal } from "../data/admin";
import { colors, spacing } from "../theme/tokens.stylex";
import {
  settingsPreviewCredentials,
  settingsPreviewPrincipal,
  settingsPreviewRepositories,
  settingsPreviewResources,
  settingsPreviewSnapshot,
} from "../fixtures/settings";
import { isSettingsPreview } from "../data/settings-preview";

export const Route = createFileRoute("/settings")({
  loader: ({ abortController, location }) => {
    const preview = isSettingsPreview(location.searchStr, import.meta.env.DEV);
    if (preview)
      return Promise.resolve({
        preview,
        principal: settingsPreviewPrincipal,
        settings: { ok: true, value: settingsPreviewSnapshot } as const,
        repositories: { ok: true, value: settingsPreviewRepositories } as const,
        resources: { ok: true, value: settingsPreviewResources } as const,
        credentials: { ok: true, value: settingsPreviewCredentials } as const,
      });
    const options = { signal: abortController.signal };
    return Promise.all([
      readCurrentPrincipal(options),
      readCloudSettings(options),
      readRepositories(options),
      readResources(options),
    ]).then(async ([principal, settings, repositories, resources]) => ({
      preview,
      principal,
      settings,
      repositories,
      resources,
      credentials:
        principal.ok && principal.value.role === "owner"
          ? await readCredentials(options)
          : ({ ok: true, value: [] } as const),
    }));
  },
  component: SettingsRoute,
});

const styles = stylex.create({
  page: {
    width: "min(760px, 100%)",
    marginInline: "auto",
    padding: "48px clamp(24px, 5vw, 64px) 72px",
    display: "grid",
    gap: spacing.xxl,
    "@media (max-width: 760px)": { padding: `${spacing.xl} ${spacing.lg} 56px` },
  },
  header: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: spacing.xl,
    paddingBottom: spacing.xl,
    borderBottomWidth: "1px",
    borderBottomStyle: "solid",
    borderBottomColor: colors.line,
    "@media (max-width: 600px)": { display: "grid", gap: spacing.md },
  },
  title: {
    margin: 0,
    color: colors.ink,
    fontSize: "28px",
    fontWeight: 700,
    lineHeight: 1.1,
    letterSpacing: "-0.03em",
  },
  intro: {
    maxWidth: "58ch",
    margin: `${spacing.sm} 0 0`,
    color: colors.muted,
    fontSize: "14px",
    lineHeight: 1.5,
  },
  headerMeta: {
    display: "flex",
    alignItems: "center",
    gap: spacing.sm,
    color: colors.quiet,
    fontSize: "11px",
    whiteSpace: "nowrap",
  },
  previewBadge: {
    minHeight: "26px",
    paddingInline: spacing.sm,
    display: "inline-flex",
    alignItems: "center",
    borderRadius: "6px",
    backgroundColor: "rgb(207 99 63 / 0.14)",
    color: colors.warning,
    fontSize: "12px",
    fontWeight: 620,
  },
  dot: { width: "6px", height: "6px", borderRadius: "50%", backgroundColor: colors.success },
  section: { display: "grid", gap: spacing.xl },
  form: {
    display: "grid",
    gap: spacing.xl,
  },
  row: {
    display: "grid",
    gridTemplateColumns: "1fr",
    alignItems: "start",
    gap: spacing.sm,
    paddingBottom: spacing.lg,
    borderBottomWidth: "1px",
    borderBottomStyle: "solid",
    borderBottomColor: colors.lineSoft,
    "@media (max-width: 600px)": {
      gridTemplateColumns: "1fr",
      alignItems: "stretch",
      gap: spacing.xs,
    },
  },
  label: { color: colors.ink, fontSize: "13px", fontWeight: 620 },
  help: { margin: `${spacing.xs} 0 0`, color: colors.muted, fontSize: "13px", lineHeight: 1.5 },
  controls: {
    minWidth: 0,
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: spacing.sm,
  },
  input: {
    width: "100%",
    minHeight: "44px",
    paddingInline: spacing.md,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: colors.line,
    borderRadius: "6px",
    outline: 0,
    backgroundColor: colors.control,
    color: colors.ink,
    fontSize: "14px",
    "@media (max-width: 760px)": { fontSize: "16px" },
    ":focus": { borderColor: colors.focus },
  },
  textarea: {
    width: "100%",
    minHeight: "220px",
    padding: spacing.md,
    resize: "vertical",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: colors.line,
    borderRadius: "6px",
    outline: 0,
    backgroundColor: colors.control,
    color: colors.ink,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: "13px",
    lineHeight: 1.55,
    ":focus": { borderColor: colors.focus },
  },
  disclosure: {
    paddingBlock: spacing.sm,
    borderTopWidth: "1px",
    borderTopStyle: "solid",
    borderTopColor: colors.lineSoft,
  },
  instructionPreview: {
    maxHeight: "260px",
    margin: `${spacing.md} 0 0`,
    padding: spacing.md,
    overflow: "auto",
    whiteSpace: "pre-wrap",
    color: colors.muted,
    backgroundColor: colors.control,
    borderRadius: "6px",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: "12px",
    lineHeight: 1.55,
  },
  controlInput: { flex: "1 1 150px", width: "auto" },
  select: {
    minHeight: "44px",
    paddingInline: spacing.md,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: colors.line,
    borderRadius: "6px",
    outline: 0,
    backgroundColor: colors.control,
    color: colors.ink,
    fontSize: "14px",
    "@media (max-width: 760px)": { fontSize: "16px" },
    ":focus": { borderColor: colors.focus },
  },
  choice: {
    minHeight: "44px",
    paddingInline: spacing.md,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: colors.line,
    borderRadius: "6px",
    backgroundColor: colors.control,
    color: colors.muted,
    cursor: "pointer",
    fontSize: "14px",
    ":hover": { borderColor: colors.lineHover, color: colors.ink },
  },
  choiceActive: {
    borderColor: colors.accent,
    backgroundColor: "rgb(207 99 63 / 0.12)",
    color: colors.ink,
  },
  envList: { display: "grid", gap: spacing.sm },
  envRow: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr) 40px",
    gap: spacing.sm,
    "@media (max-width: 480px)": {
      gridTemplateColumns: "minmax(0, 1fr) 44px",
      gridTemplateAreas: '"key remove" "value remove"',
    },
  },
  envHeader: { "@media (max-width: 480px)": { display: "none" } },
  envKey: { "@media (max-width: 480px)": { gridArea: "key" } },
  envValue: { "@media (max-width: 480px)": { gridArea: "value" } },
  envRemove: { "@media (max-width: 480px)": { gridArea: "remove", alignSelf: "stretch" } },
  smallButton: {
    minWidth: "40px",
    minHeight: "40px",
    paddingInline: spacing.sm,
    borderWidth: 0,
    borderStyle: "solid",
    borderColor: "transparent",
    borderRadius: "6px",
    backgroundColor: "transparent",
    color: colors.quiet,
    cursor: "pointer",
    appearance: "none",
    ":focus-visible": {
      outlineWidth: "2px",
      outlineStyle: "solid",
      outlineColor: colors.focus,
      outlineOffset: "2px",
    },
    ":hover": { backgroundColor: colors.panelRaised, color: colors.ink },
    "@media (max-width: 760px)": { minWidth: "44px", minHeight: "44px" },
  },
  table: { borderTopWidth: "1px", borderTopStyle: "solid", borderTopColor: colors.line },
  repoRow: {
    minHeight: "56px",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md,
    borderBottomWidth: "1px",
    borderBottomStyle: "solid",
    borderBottomColor: colors.lineSoft,
    "@media (max-width: 600px)": { alignItems: "flex-start" },
  },
  repoName: {
    minWidth: 0,
    color: colors.ink,
    fontSize: "14px",
    fontWeight: 620,
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  repoMeta: { marginTop: spacing.xs, color: colors.muted, fontSize: "12px" },
  error: {
    display: "flex",
    alignItems: "flex-start",
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: "7px",
    backgroundColor: "rgb(255 130 120 / 0.1)",
    color: colors.danger,
    fontSize: "13px",
    lineHeight: 1.45,
  },
  empty: { paddingBlock: spacing.lg, color: colors.muted, fontSize: "14px" },
  muted: { color: colors.muted, fontSize: "13px" },
  digest: {
    wordBreak: "break-all",
    color: colors.quiet,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: "10px",
  },
  callout: {
    display: "flex",
    alignItems: "flex-start",
    gap: spacing.sm,
    padding: spacing.md,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: colors.line,
    borderRadius: "7px",
    color: colors.muted,
    fontSize: "13px",
    lineHeight: 1.5,
  },
  icon: { width: "15px", height: "15px", flexShrink: 0, strokeWidth: 1.8 },
  actions: {
    position: "sticky",
    bottom: 0,
    zIndex: 4,
    marginInline: `-${spacing.lg}`,
    paddingTop: spacing.md,
    paddingRight: spacing.lg,
    paddingBottom: `max(${spacing.md}, env(safe-area-inset-bottom))`,
    paddingLeft: spacing.lg,
    display: "flex",
    alignItems: "center",
    gap: spacing.md,
    backgroundColor: colors.shell,
    borderTopWidth: "1px",
    borderTopStyle: "solid",
    borderTopColor: colors.line,
  },
  unavailable: {
    paddingBlock: spacing.xxl,
    display: "grid",
    gap: spacing.lg,
    borderTopWidth: "1px",
    borderTopStyle: "solid",
    borderTopColor: colors.line,
    borderBottomWidth: "1px",
    borderBottomStyle: "solid",
    borderBottomColor: colors.line,
  },
  unavailableTitle: { margin: 0, color: colors.ink, fontSize: "16px", fontWeight: 680 },
  unavailableCopy: {
    maxWidth: "62ch",
    margin: 0,
    color: colors.muted,
    fontSize: "14px",
    lineHeight: 1.55,
  },
});

function SettingsRoute() {
  return <SettingsEditor />;
}

// oxlint-disable-next-line eslint/complexity -- one editor coordinates the five focused panes and their local drafts
function SettingsEditor() {
  const {
    principal,
    settings: initialSettings,
    repositories: initialRepositories,
    resources: initialResources,
    credentials,
    preview,
  } = Route.useLoaderData();
  const router = useRouter();
  const [snapshot, setSnapshot] = useState(initialSettings.ok ? initialSettings.value : null);
  const [draft, setDraft] = useState<CloudSettings | null>(
    initialSettings.ok ? initialSettings.value.settings : null,
  );
  const [repositories, setRepositories] = useState(
    initialRepositories.ok ? [...initialRepositories.value] : [],
  );
  const [resources, setResources] = useState(initialResources.ok ? initialResources.value : null);
  const [draftEpoch, setDraftEpoch] = useState(0);
  const [environmentValid, setEnvironmentValid] = useState(true);
  const [pane, setPane] = useState<SettingsPane>(() => {
    const value = typeof window === "undefined" ? "" : window.location.hash.slice(1);
    return (
      (["agents", "repositories", "environment", "resources", "connections"] as const).find(
        (item) => item === value,
      ) ?? "agents"
    );
  });
  const [repositoryError, setRepositoryError] = useState<string | null>(null);
  const [resourceError, setResourceError] = useState<string | null>(null);
  const [resourceEditorOpen, setResourceEditorOpen] = useState(false);
  const resourcesRef = useRef<ResourcesSectionHandle>(null);
  const draftTouched = useRef(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");
  const [error, setError] = useState<string | null>(
    initialSettings.ok ? null : initialSettings.failure.message,
  );

  useEffect(() => {
    if (initialSettings.ok && !draftTouched.current) {
      setSnapshot(initialSettings.value);
      setDraft(initialSettings.value.settings);
      setEnvironmentValid(true);
      setDraftEpoch((value) => value + 1);
    }
    if (initialResources.ok) setResources(initialResources.value);
  }, [initialResources, initialSettings]);

  const owner = principal.ok && principal.value.role === "owner";
  const canEdit = owner && saveState !== "saving";
  const settingsReady = snapshot !== null && draft !== null;
  const dirty = settingsReady && JSON.stringify(draft) !== JSON.stringify(snapshot.settings);
  const selectPane = (next: SettingsPane): void => {
    setPane(next);
    window.history.replaceState(null, "", `#${next}`);
  };
  const updateDraft = (patch: Partial<CloudSettings>): void => {
    if (draft !== null) {
      draftTouched.current = true;
      setDraft({ ...draft, ...patch });
    }
  };
  const save = (): void => {
    if (!canEdit || !environmentValid || snapshot === null || draft === null) return;
    setSaveState("saving");
    setError(null);
    if (preview) {
      const next = { ...snapshot, revision: snapshot.revision + 1, settings: draft };
      setSnapshot(next);
      setDraft(next.settings);
      draftTouched.current = false;
      setSaveState("saved");
      window.setTimeout(() => setSaveState("idle"), 1800);
      return;
    }
    void updateCloudSettings({ expectedRevision: snapshot.revision, settings: draft })
      .then((result) => {
        if (!result.ok) {
          setSaveState("idle");
          setError(result.failure.message);
          return;
        }
        setSnapshot(result.value);
        draftTouched.current = false;
        setResources((current) =>
          current === null
            ? null
            : {
                ...current,
                revision: result.value.revision,
                activeDigest: result.value.activeDigest,
              },
        );
        setDraft(result.value.settings);
        setDraftEpoch((value) => value + 1);
        setSaveState("saved");
        window.setTimeout(() => setSaveState("idle"), 1800);
      })
      .catch(() => {
        setSaveState("idle");
        setError("Cloud settings could not be saved.");
      });
  };
  const reload = (): void => {
    if (preview) {
      draftTouched.current = false;
      setSnapshot(settingsPreviewSnapshot);
      setDraft(settingsPreviewSnapshot.settings);
      setRepositories([...settingsPreviewRepositories]);
      setResources(settingsPreviewResources);
      setEnvironmentValid(true);
      setError(null);
      setDraftEpoch((value) => value + 1);
      return;
    }
    void Promise.all([readCloudSettings(), readResources()]).then(([settings, nextResources]) => {
      if (settings.ok) {
        draftTouched.current = false;
        setSnapshot(settings.value);
        setDraft(settings.value.settings);
        setDraftEpoch((value) => value + 1);
        setEnvironmentValid(true);
        setError(null);
      } else setError(settings.failure.message);
      if (nextResources.ok) setResources(nextResources.value);
    });
  };

  const descriptions: Record<SettingsPane, string> = {
    agents: "Choose the agent and model used for new sessions.",
    repositories: "Manage repositories available to new sessions.",
    environment: "Set plain environment values for new sessions.",
    resources: "Manage skills and runtime files in the cloud.",
    connections: "Review browser access and local credential sources.",
  };
  const titles: Record<SettingsPane, string> = {
    agents: "Agents",
    repositories: "Repositories",
    environment: "Environment",
    resources: "Skills & resources",
    connections: "Connections",
  };
  const installationUnavailable = !preview && (!principal.ok || !settingsReady);
  return (
    <SettingsShell
      active={pane}
      onSelect={selectPane}
      status={saveState === "saved" ? "Saved" : undefined}
    >
      <div {...stylex.props(styles.page)}>
        <header {...stylex.props(styles.header)}>
          <div>
            {preview ? <span {...stylex.props(styles.previewBadge)}>Local preview</span> : null}
            <h1 {...stylex.props(styles.title)}>{titles[pane]}</h1>
            <p {...stylex.props(styles.intro)}>{descriptions[pane]}</p>
          </div>
          {!installationUnavailable && pane === "resources" && !resourceEditorOpen ? (
            <Button
              variant="primary"
              disabled={!canEdit}
              onClick={() => resourcesRef.current?.startNew()}
            >
              <Plus aria-hidden size={15} />
              Add resource
            </Button>
          ) : null}
        </header>
        {installationUnavailable ? (
          <UnavailableSettings onRetry={() => void router.invalidate()} />
        ) : !principal.ok ? null : principal.value.role === "standard" ? (
          <div {...stylex.props(styles.callout)}>
            You can view installation settings. The primary device manages changes.
          </div>
        ) : null}
        {installationUnavailable ||
        error === null ||
        (pane !== "agents" && pane !== "environment") ? null : (
          <div>
            <ErrorMessage message={error} />
            <Button variant="quiet" onClick={reload}>
              Reload cloud settings
            </Button>
          </div>
        )}
        {!installationUnavailable && pane === "agents" && settingsReady ? (
          <AgentSection
            draft={draft}
            owner={canEdit}
            skillNames={
              resources?.items.filter(({ kind }) => kind === "skill").map(({ name }) => name) ?? []
            }
            onChange={updateDraft}
          />
        ) : null}
        <div hidden={installationUnavailable || pane !== "repositories"}>
          {repositoryError !== null && <ErrorMessage message={repositoryError} />}
          <RepositoriesSection
            owner={canEdit}
            preview={preview}
            repositories={repositories}
            onChange={(next) => setRepositories([...next])}
            onError={setRepositoryError}
          />
        </div>
        <div hidden={installationUnavailable || pane !== "environment"}>
          <EnvironmentSection
            draft={draft}
            owner={canEdit}
            key={draftEpoch}
            onValidityChange={(valid) => {
              if (!valid) draftTouched.current = true;
              setEnvironmentValid(valid);
            }}
            onChange={(environment) => updateDraft({ environment })}
          />
        </div>
        <div hidden={installationUnavailable || pane !== "resources"}>
          {resourceError !== null && <ErrorMessage message={resourceError} />}
          <ResourcesSection
            ref={resourcesRef}
            owner={canEdit}
            preview={preview}
            snapshot={resources}
            onChange={(next) => {
              setResources(next);
              setSnapshot((current) =>
                current === null
                  ? current
                  : { ...current, revision: next.revision, activeDigest: next.activeDigest },
              );
            }}
            onError={setResourceError}
            onEditingChange={setResourceEditorOpen}
            onReload={reload}
          />
        </div>
        <div hidden={installationUnavailable || pane !== "connections"}>
          <ConnectionsSection
            principal={principal}
            credentials={credentials}
            preview={preview}
            onRefresh={() => (preview ? Promise.resolve() : router.invalidate())}
          />
        </div>
        {!installationUnavailable && (dirty || saveState !== "idle") && (
          <div {...stylex.props(styles.actions)}>
            {!environmentValid && (
              <span {...stylex.props(styles.help)}>Finish each environment key to save.</span>
            )}
            <span style={{ flex: 1 }} />
            <span {...stylex.props(styles.help)}>
              {saveState === "saved" ? "Changes saved" : "Unsaved changes"}
            </span>
            <Button
              variant="primary"
              disabled={!canEdit || !settingsReady || !environmentValid || !dirty}
              onClick={save}
            >
              {saveState === "saving" ? "Saving…" : "Save changes"}
            </Button>
          </div>
        )}
      </div>
    </SettingsShell>
  );
}

function AgentSection({
  draft,
  owner,
  skillNames,
  onChange,
}: {
  readonly draft: CloudSettings;
  readonly owner: boolean;
  readonly skillNames: ReadonlyArray<string>;
  readonly onChange: (patch: Partial<CloudSettings>) => void;
}) {
  const setPi = (patch: Partial<CloudSettings["pi"]>) =>
    onChange({ pi: { ...draft.pi, ...patch } });
  const setCodex = (patch: Partial<CloudSettings["codex"]>) =>
    onChange({ codex: { ...draft.codex, ...patch } });
  const setClaude = (patch: Partial<CloudSettings["claude"]>) =>
    onChange({ claude: { ...draft.claude, ...patch } });
  return (
    <section id="settings-agents" {...stylex.props(styles.section)}>
      <div {...stylex.props(styles.form)}>
        <div {...stylex.props(styles.row)}>
          <span {...stylex.props(styles.label)}>Agent</span>
          <div {...stylex.props(styles.controls)}>
            {AgentIdSchema.literals.map((agent) => (
              <button
                key={agent}
                type="button"
                disabled={!owner}
                aria-pressed={draft.agent === agent}
                onClick={() => onChange({ agent })}
                {...stylex.props(styles.choice, draft.agent === agent && styles.choiceActive)}
              >
                {agentDescriptors[agent].label}
              </button>
            ))}
          </div>
        </div>
        {draft.agent === "pi" && (
          <>
            <div {...stylex.props(styles.row)}>
              <label htmlFor="pi-model" {...stylex.props(styles.label)}>
                Model
              </label>
              <input
                id="pi-model"
                aria-label="Pi model"
                disabled={!owner}
                placeholder="Use agent default"
                value={draft.pi.model ?? ""}
                onChange={(event) => setPi({ model: event.target.value || undefined })}
                {...stylex.props(styles.input)}
              />
            </div>
            <div {...stylex.props(styles.row)}>
              <label htmlFor="pi-effort" {...stylex.props(styles.label)}>
                Reasoning
              </label>
              <select
                id="pi-effort"
                aria-label="Pi effort"
                disabled={!owner}
                value={draft.pi.effort ?? "off"}
                onChange={(event) =>
                  setPi({ effort: event.target.value as CloudSettings["pi"]["effort"] })
                }
                {...stylex.props(styles.select)}
              >
                {["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((effort) => (
                  <option key={effort}>{effort}</option>
                ))}
              </select>
            </div>
            <details>
              <summary {...stylex.props(styles.help)}>Advanced · model provider</summary>
              <div {...stylex.props(styles.row)}>
                <label htmlFor="pi-provider" {...stylex.props(styles.label)}>
                  Model provider
                </label>
                <input
                  id="pi-provider"
                  aria-label="Pi model provider"
                  disabled={!owner}
                  placeholder="Use agent default"
                  value={draft.pi.modelProvider ?? ""}
                  onChange={(event) => setPi({ modelProvider: event.target.value || undefined })}
                  {...stylex.props(styles.input)}
                />
              </div>
            </details>
          </>
        )}
        {draft.agent === "codex" && (
          <>
            <div {...stylex.props(styles.row)}>
              <label htmlFor="codex-model" {...stylex.props(styles.label)}>
                Model
              </label>
              <select
                id="codex-model"
                aria-label="Codex model"
                disabled={!owner}
                value={draft.codex.model}
                onChange={(event) => {
                  const capability = codexModelCapabilities.find(
                    ({ slug }) => slug === event.target.value,
                  );
                  if (capability === undefined) return;
                  setCodex({
                    model: capability.slug,
                    effort: capability.efforts.includes(draft.codex.effort)
                      ? draft.codex.effort
                      : capability.efforts[0],
                  });
                }}
                {...stylex.props(styles.select)}
              >
                {codexModelCapabilities.map(({ slug }) => (
                  <option key={slug}>{slug}</option>
                ))}
              </select>
            </div>
            <div {...stylex.props(styles.row)}>
              <label htmlFor="codex-effort" {...stylex.props(styles.label)}>
                Reasoning
              </label>
              <select
                id="codex-effort"
                aria-label="Codex effort"
                disabled={!owner}
                value={draft.codex.effort}
                onChange={(event) =>
                  setCodex({ effort: event.target.value as CloudSettings["codex"]["effort"] })
                }
                {...stylex.props(styles.select)}
              >
                {codexModelCapabilities
                  .find(({ slug }) => slug === draft.codex.model)
                  ?.efforts.map((effort) => (
                    <option key={effort}>{effort}</option>
                  ))}
              </select>
            </div>
          </>
        )}
        {draft.agent === "claude" && (
          <>
            <div {...stylex.props(styles.row)}>
              <label htmlFor="claude-model" {...stylex.props(styles.label)}>
                Model
              </label>
              <input
                id="claude-model"
                aria-label="Claude model"
                disabled={!owner}
                placeholder="opus, sonnet, or a model ID"
                value={draft.claude.model}
                onChange={(event) => setClaude({ model: event.target.value })}
                {...stylex.props(styles.input)}
              />
            </div>
            <div {...stylex.props(styles.row)}>
              <label htmlFor="claude-effort" {...stylex.props(styles.label)}>
                Reasoning
              </label>
              <select
                id="claude-effort"
                aria-label="Claude effort"
                disabled={!owner}
                value={draft.claude.effort}
                onChange={(event) => {
                  const effort = ClaudeReasoningEffort.literals.find(
                    (literal) => literal === event.target.value,
                  );
                  if (effort !== undefined) setClaude({ effort });
                }}
                {...stylex.props(styles.select)}
              >
                {ClaudeReasoningEffort.literals.map((effort) => (
                  <option key={effort}>{effort}</option>
                ))}
              </select>
            </div>
          </>
        )}
        <div {...stylex.props(styles.row)}>
          <label htmlFor="custom-agent-instructions" {...stylex.props(styles.label)}>
            Custom instructions
          </label>
          <p id="custom-agent-instructions-help" {...stylex.props(styles.help)}>
            Markdown for new agent sessions. Scotty combines it with the base instructions once when
            a session is created; existing sessions keep their saved copy.
          </p>
          <textarea
            id="custom-agent-instructions"
            aria-describedby="custom-agent-instructions-help"
            disabled={!owner}
            value={draft.customInstructions}
            placeholder="Add installation-specific guidance for agents…"
            onChange={(event) => onChange({ customInstructions: event.target.value })}
            {...stylex.props(styles.textarea)}
          />
          {skillNames.length === 0 ? null : (
            <p {...stylex.props(styles.help)}>
              Available installed skills:{" "}
              {skillNames.map((name, index) => (
                <span key={name}>
                  {index === 0 ? null : ", "}
                  <code>{name}</code>
                </span>
              ))}
            </p>
          )}
        </div>
        <details {...stylex.props(styles.disclosure)}>
          <summary {...stylex.props(styles.help)}>Scotty base instructions · read-only</summary>
          <pre {...stylex.props(styles.instructionPreview)}>{scottyBaseAgentInstructions}</pre>
        </details>
      </div>
    </section>
  );
}

function RepositoriesSection({
  owner,
  preview,
  repositories,
  onChange,
  onError,
}: {
  readonly owner: boolean;
  readonly preview: boolean;
  readonly repositories: ReadonlyArray<{
    repo: string;
    defaultBranch: string;
    addedAt: string;
    lastUsedAt: string;
  }>;
  readonly onChange: (
    repositories: ReadonlyArray<{
      repo: string;
      defaultBranch: string;
      addedAt: string;
      lastUsedAt: string;
    }>,
  ) => void;
  readonly onError: (message: string | null) => void;
}) {
  const [repo, setRepo] = useState("");
  const [busy, setBusy] = useState(false);
  const add = (): void => {
    if (!owner || busy || repo.trim() === "") return;
    setBusy(true);
    onError(null);
    if (preview) {
      const now = new Date().toISOString();
      const value = { repo: repo.trim(), defaultBranch: "main", addedAt: now, lastUsedAt: now };
      onChange([value, ...repositories.filter((entry) => entry.repo !== value.repo)]);
      setRepo("");
      setBusy(false);
      return;
    }
    void addRepository(repo.trim())
      .then((result) => {
        if (!result.ok) onError(result.failure.message);
        else {
          onChange([
            result.value,
            ...repositories.filter((entry) => entry.repo !== result.value.repo),
          ]);
          setRepo("");
        }
      })
      .finally(() => setBusy(false));
  };
  const remove = (value: string): void => {
    if (!owner || busy) return;
    setBusy(true);
    onError(null);
    if (preview) {
      onChange(repositories.filter((entry) => entry.repo !== value));
      setBusy(false);
      return;
    }
    void removeRepository(value)
      .then((result) => {
        if (!result.ok) onError(result.failure.message);
        else if (result.value.removed)
          onChange(repositories.filter((entry) => entry.repo !== value));
      })
      .finally(() => setBusy(false));
  };
  return (
    <section id="settings-repositories" {...stylex.props(styles.section)}>
      <div {...stylex.props(styles.form)}>
        <div {...stylex.props(styles.controls)}>
          <input
            aria-label="Repository owner and name"
            disabled={!owner || busy}
            placeholder="owner/name"
            value={repo}
            onChange={(event) => setRepo(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") add();
            }}
            {...stylex.props(styles.input, styles.controlInput)}
          />
          <Button disabled={!owner || busy || repo.trim() === ""} onClick={add}>
            <Plus aria-hidden {...stylex.props(styles.icon)} />
            Add repository
          </Button>
        </div>
        <div {...stylex.props(styles.table)}>
          {repositories.length === 0 ? (
            <div {...stylex.props(styles.empty)}>No repositories are registered.</div>
          ) : (
            repositories.map((entry) => (
              <div key={entry.repo} {...stylex.props(styles.repoRow)}>
                <div>
                  <div {...stylex.props(styles.repoName)}>{entry.repo}</div>
                  <div {...stylex.props(styles.repoMeta)}>
                    default branch · {entry.defaultBranch}
                  </div>
                </div>
                <button
                  type="button"
                  aria-label={`Remove ${entry.repo}`}
                  disabled={!owner || busy}
                  onClick={() => remove(entry.repo)}
                  {...stylex.props(styles.smallButton)}
                >
                  <Trash2 aria-hidden {...stylex.props(styles.icon)} />
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </section>
  );
}

function EnvironmentSection({
  draft,
  owner,
  onChange,
  onValidityChange,
}: {
  readonly draft: CloudSettings | null;
  readonly owner: boolean;
  readonly onChange: (environment: Readonly<Record<string, string>>) => void;
  readonly onValidityChange: (valid: boolean) => void;
}) {
  const [entries, setEntries] = useState(() =>
    Object.entries(draft?.environment ?? {}).map(([key, value]) => ({
      id: crypto.randomUUID(),
      key,
      value,
    })),
  );
  const publish = (next: typeof entries): void => {
    setEntries(next);
    const names = next.map((entry) => entry.key);
    const valid =
      names.every((name) => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) &&
      new Set(names).size === names.length;
    onValidityChange(valid);
    if (valid) onChange(Object.fromEntries(next.map(({ key, value }) => [key, value])));
  };
  return (
    <section id="settings-environment" {...stylex.props(styles.section)}>
      <p {...stylex.props(styles.help)}>
        Values are plain text. Scotty runtime and credential keys are reserved.
      </p>
      <div {...stylex.props(styles.form)}>
        <div {...stylex.props(styles.envList)}>
          <div {...stylex.props(styles.envRow, styles.envHeader)}>
            <span {...stylex.props(styles.label)}>Key</span>
            <span {...stylex.props(styles.label)}>Value</span>
            <span />
          </div>
          {entries.map(({ id, key, value }, index) => (
            <div key={id} {...stylex.props(styles.envRow)}>
              <input
                aria-label={`Environment key ${index + 1}`}
                disabled={!owner}
                value={key}
                placeholder="KEY"
                onChange={(event) =>
                  publish(
                    entries.map((entry) =>
                      entry.id === id ? { ...entry, key: event.target.value } : entry,
                    ),
                  )
                }
                {...stylex.props(styles.input, styles.envKey)}
              />
              <input
                aria-label={`Environment value ${index + 1}`}
                disabled={!owner}
                value={value}
                placeholder="value"
                onChange={(event) =>
                  publish(
                    entries.map((entry) =>
                      entry.id === id ? { ...entry, value: event.target.value } : entry,
                    ),
                  )
                }
                {...stylex.props(styles.input, styles.envValue)}
              />
              <button
                type="button"
                aria-label={`Remove ${key}`}
                disabled={!owner}
                onClick={() => publish(entries.filter((entry) => entry.id !== id))}
                {...stylex.props(styles.smallButton, styles.envRemove)}
              >
                <Trash2 aria-hidden {...stylex.props(styles.icon)} />
              </button>
            </div>
          ))}
        </div>
        <div>
          <Button
            disabled={!owner}
            onClick={() => publish([...entries, { id: crypto.randomUUID(), key: "", value: "" }])}
            variant="quiet"
          >
            <Plus aria-hidden {...stylex.props(styles.icon)} />
            Add another
          </Button>
        </div>
        {entries.some(
          (entry) =>
            entry.key === "" ||
            entries.filter((candidate) => candidate.key === entry.key).length > 1,
        ) ? (
          <p {...stylex.props(styles.help)}>Enter a unique key for each variable before saving.</p>
        ) : null}
      </div>
    </section>
  );
}

function ConnectionsSection({
  principal,
  credentials,
  preview,
  onRefresh,
}: {
  readonly principal: SettingsResult<CurrentPrincipal>;
  readonly credentials: SettingsResult<ReadonlyArray<CredentialStatus>>;
  readonly preview: boolean;
  readonly onRefresh: () => Promise<void>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const owner = principal.ok && principal.value.role === "owner";
  const widenAccess = async (credential: CredentialStatus) => {
    if (busy !== null) return;
    setBusy(credential.name);
    setError(null);
    if (preview) {
      await onRefresh();
      setBusy(null);
      return;
    }
    try {
      const result = await useGithubTokenPermissions(credential);
      if (!result.ok) setError(result.failure.message);
      await onRefresh();
    } catch {
      setError(
        "Connections could not be refreshed. Refresh access to check the current repository coverage.",
      );
    } finally {
      setBusy(null);
    }
  };
  return (
    <section id="settings-connections" {...stylex.props(styles.section)}>
      <div {...stylex.props(styles.form)}>
        <div {...stylex.props(styles.row)}>
          <span {...stylex.props(styles.label)}>Browser access</span>
          <span {...stylex.props(styles.muted)}>
            {principal.ok
              ? `${principal.value.role === "owner" ? "Primary device" : "Standard device"} · active`
              : "Unavailable"}
          </span>
        </div>
        <div {...stylex.props(styles.controls)}>
          <Button variant="quiet" disabled={busy !== null} onClick={() => void onRefresh()}>
            <RefreshCw aria-hidden {...stylex.props(styles.icon)} />
            Refresh access
          </Button>
          <span {...stylex.props(styles.muted)}>
            Run <code>scotty sync</code> locally with a named credential source. Use{" "}
            <code>scotty sync --help</code> for options.
          </span>
        </div>
        {error !== null ? <ErrorMessage message={error} /> : null}
        <div {...stylex.props(styles.table)}>
          {credentials.ok && credentials.value.length > 0 ? (
            credentials.value.map((credential) => (
              <div key={credential.name} {...stylex.props(styles.repoRow)}>
                <div {...stylex.props(styles.repoName)}>
                  <span>{credential.name}</span>
                  {credential.kind === "github-cli" ? (
                    <p {...stylex.props(styles.muted)}>
                      {credential.scope === "global"
                        ? "All repositories this token can access"
                        : `Selected repositories: ${credential.repositories?.join(", ") ?? "none"}`}
                    </p>
                  ) : null}
                  {owner &&
                  credential.kind === "github-cli" &&
                  credential.scope === "repository" ? (
                    <Button
                      variant="quiet"
                      disabled={busy !== null}
                      onClick={() => void widenAccess(credential)}
                    >
                      {busy === credential.name ? "Updating…" : "Use all accessible repos"}
                    </Button>
                  ) : null}
                </div>
                <span {...stylex.props(styles.muted)}>
                  {!credential.configured
                    ? "needs refresh"
                    : credential.expires !== undefined && credential.expires <= Date.now()
                      ? "expired · refresh locally"
                      : credential.expires !== undefined
                        ? `configured · expires ${new Date(credential.expires).toLocaleString()}`
                        : "configured"}
                </span>
              </div>
            ))
          ) : (
            <div {...stylex.props(styles.empty)}>
              {credentials.ok ? "No managed connections yet." : credentials.failure.message}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function ErrorMessage({ message }: { readonly message: string }) {
  return (
    <div role="alert" {...stylex.props(styles.error)}>
      <CircleAlert aria-hidden {...stylex.props(styles.icon)} />
      {message}
    </div>
  );
}

function UnavailableSettings({ onRetry }: { readonly onRetry: () => void }) {
  return (
    <section aria-labelledby="settings-unavailable" {...stylex.props(styles.unavailable)}>
      <div>
        <h2 id="settings-unavailable" {...stylex.props(styles.unavailableTitle)}>
          Installation settings are unavailable
        </h2>
        <p {...stylex.props(styles.unavailableCopy)}>
          Scotty could not verify this installation’s settings authority. Reconnect and try again;
          no settings have been changed.
        </p>
      </div>
      <div {...stylex.props(styles.controls)}>
        <Button onClick={onRetry} variant="primary">
          <RefreshCw aria-hidden {...stylex.props(styles.icon)} />
          Try again
        </Button>
        {import.meta.env.DEV ? (
          <Button onClick={() => window.location.assign("/settings?preview=1")} variant="quiet">
            Open local preview
          </Button>
        ) : null}
      </div>
    </section>
  );
}
