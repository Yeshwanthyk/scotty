import * as stylex from "@stylexjs/stylex";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Archive,
  CircleAlert,
  LoaderCircle,
  Moon,
  Play,
  RefreshCw,
  Save,
  Sparkles,
  Trash2,
} from "lucide-react";
import { SessionMenu } from "../components/SessionMenu";
import { SessionSelection } from "../components/SessionSelection";
import { AppShell } from "../components/AppShell";
import { Button } from "../components/Button";
import { ConversationPreview, LiveConversation } from "../components/LiveConversation";
import { SessionWorkbench } from "../components/SessionWorkbench";
import { mutateSessionLifecycle, type SessionLifecycleAction } from "../data/session-lifecycle";
import {
  decideConsoleEligibility,
  readAuthoritativeSession,
  type ConsoleEligibility,
  type SessionAction,
  type SessionModel,
  type SessionReadFailure,
} from "../data/session-reader";
import { useSessionCatalog } from "../data/session-catalog";
import {
  isLifecycleMessageResolved,
  resolveLifecycleActionMessage,
  type LifecycleControlMessage,
} from "../domain/session-lifecycle-reconciliation";
import { presentSession, type SessionPresentation } from "../domain/session-presentation";
import { sessionFixtureForId } from "../fixtures/sessions";
import { conversationFixture } from "../fixtures/conversation";
import { markdownFixture } from "../fixtures/markdown";
import { colors, motion, spacing } from "../theme/tokens.stylex";

interface SessionRouteReady {
  readonly state: "ready";
  readonly session: SessionModel;
  readonly fixture: boolean;
}

interface SessionRouteFailed {
  readonly state: "failed";
  readonly failure: SessionReadFailure;
  readonly conflict: boolean;
}

type SessionRouteData = SessionRouteReady | SessionRouteFailed;

export const Route = createFileRoute("/s/$sessionId")({
  ssr: false,
  loader: async ({ abortController, params }): Promise<SessionRouteData> => {
    const result = await readAuthoritativeSession(params.sessionId, {
      fixture: sessionFixtureForId(params.sessionId),
      fixtureFallback: import.meta.env.DEV,
      signal: abortController.signal,
    });
    if (!result.ok)
      return {
        state: "failed",
        failure: result.failure,
        conflict: result.failure.kind === "http" && result.failure.status === 409,
      };

    return {
      state: "ready",
      session: result.session,
      fixture: result.session.source === "fixture",
    };
  },
  pendingComponent: SessionPending,
  component: SessionRoute,
});

const actionDetails = {
  checkpoint: { label: "Save checkpoint", pendingLabel: "Saving", icon: Save },
  sleep: { label: "Sleep session", pendingLabel: "Going to sleep", icon: Moon },
  resume: { label: "Resume session", pendingLabel: "Waking", icon: Play },
  work: { label: "Open work tools", icon: Sparkles },
  vaporize: { label: "Vaporize session", pendingLabel: "Vaporizing", icon: Trash2 },
} as const satisfies Record<
  SessionAction,
  { readonly label: string; readonly pendingLabel?: string; readonly icon: typeof Save }
>;

const styles = stylex.create({
  pendingStage: {
    minHeight: "100dvh",
    display: "grid",
    placeItems: "center",
    padding: spacing.xl,
  },
  pendingLine: {
    width: "min(560px, 100%)",
    height: "2px",
    overflow: "hidden",
    backgroundColor: colors.line,
  },
  pendingBeam: {
    width: "36%",
    height: "100%",
    backgroundColor: colors.warning,
    animationName: stylex.keyframes({
      from: { transform: "translateX(-110%)" },
      to: { transform: "translateX(310%)" },
    }),
    animationDuration: "900ms",
    animationIterationCount: "infinite",
    animationTimingFunction: motion.easeOut,
  },
  page: {
    height: "100dvh",
    minHeight: "100dvh",
    overflow: "hidden",
    backgroundColor: colors.space,
    "@media (max-width: 760px)": {
      height: "calc(100dvh - 52px)",
      minHeight: "calc(100dvh - 52px)",
    },
  },
  breadcrumb: {
    minWidth: 0,
    display: "flex",
    alignItems: "center",
    gap: "6px",
    color: colors.quiet,
    fontSize: "11px",
    "@media (max-width: 760px)": { fontSize: "10px" },
  },
  repo: {
    overflow: "hidden",
    color: colors.muted,
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  slash: { opacity: 0.5 },
  branch: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  },
  workspace: {
    minWidth: 0,
    minHeight: 0,
    width: "100%",
    height: "100%",
    padding: `16px clamp(20px, 3vw, 40px) 0`,
    display: "grid",
    gridTemplateRows: "auto minmax(0, 1fr)",
    gap: spacing.md,
    overflow: "hidden",
    "@media (max-width: 760px)": {
      padding: `8px ${spacing.md} 0`,
      gap: spacing.sm,
    },
  },
  headingRow: {
    minWidth: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.lg,
    "@media (max-width: 760px)": {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.sm,
    },
  },
  titleBlock: {
    minWidth: 0,
    display: "grid",
    gap: "4px",
    "@media (max-width: 760px)": {
      flex: 1,
      overflow: "hidden",
    },
  },
  statusLine: {
    display: "inline-flex",
    alignItems: "center",
    gap: "6px",
    color: colors.muted,
    fontSize: "11px",
  },
  stateIcon: { width: "12px", height: "12px", color: colors.warning, strokeWidth: 1.8 },
  heading: {
    maxWidth: "720px",
    margin: 0,
    color: colors.ink,
    overflow: "hidden",
    fontSize: "20px",
    fontWeight: 680,
    lineHeight: 1.15,
    letterSpacing: "-0.025em",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    "@media (max-width: 760px)": { fontSize: "16px" },
  },
  metadata: {
    display: "flex",
    flexWrap: "wrap",
    gap: spacing.md,
    color: colors.quiet,
    fontSize: "11px",
    fontVariantNumeric: "tabular-nums",
    "@media (max-width: 760px)": { gap: spacing.sm, fontSize: "10px" },
  },
  defaultBranchItem: { "@media (max-width: 760px)": { display: "none" } },
  metadataItem: { display: "inline-flex", alignItems: "center", gap: "6px" },
  selectionMetadata: { minWidth: 0, overflowWrap: "anywhere" },
  smallIcon: { width: "13px", height: "13px", strokeWidth: 1.8 },
  actionArea: {
    minWidth: 0,
    display: "grid",
    justifyItems: "end",
    gap: spacing.sm,
    "@media (max-width: 760px)": {
      minWidth: 0,
      maxWidth: "100%",
      flexShrink: 0,
      justifyItems: "end",
    },
  },
  actionRow: { display: "flex", alignItems: "center", gap: "4px" },
  actionMenu: { position: "relative" },
  actionSummary: {
    width: "40px",
    height: "40px",
    display: "grid",
    placeItems: "center",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: colors.line,
    borderRadius: "8px",
    backgroundColor: colors.control,
    color: colors.muted,
    cursor: "pointer",
    listStyle: "none",
    "::-webkit-details-marker": { display: "none" },
    "@media (max-width: 760px)": { width: "44px", height: "44px" },
  },
  mobileOnlyActionMenu: { "@media (min-width: 761px)": { display: "none" } },
  mobileOnlyAction: { "@media (min-width: 761px)": { display: "none" } },
  desktopOnlyAction: { "@media (max-width: 760px)": { display: "none" } },
  menuPanel: {
    position: "absolute",
    zIndex: 20,
    top: "calc(100% + 6px)",
    right: 0,
    width: "190px",
    padding: spacing.sm,
    display: "grid",
    gap: "2px",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: colors.line,
    borderRadius: "8px",
    backgroundColor: colors.panelRaised,
    boxShadow: "0 4px 8px rgb(0 0 0 / 35%)",
  },
  dangerButton: { color: colors.danger },
  confirm: {
    maxWidth: "330px",
    padding: spacing.md,
    display: "grid",
    gap: spacing.sm,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: colors.danger,
    borderRadius: "8px",
    backgroundColor: colors.panel,
    "@media (max-width: 760px)": { width: "100%", maxWidth: "none" },
  },
  confirmCopy: { margin: 0, color: colors.muted, fontSize: "12px", lineHeight: 1.5 },
  actionIcon: { width: "15px", height: "15px", strokeWidth: 1.8 },
  actionNote: {
    width: "100%",
    margin: 0,
    color: colors.quiet,
    fontSize: "11px",
    textAlign: "right",
    "@media (max-width: 760px)": { textAlign: "left" },
  },
  actionMessage: {
    width: "100%",
    margin: 0,
    color: colors.muted,
    fontSize: "11px",
    lineHeight: 1.45,
    textAlign: "right",
    "@media (max-width: 760px)": { textAlign: "left" },
  },
  actionError: { color: colors.danger },
  actionReconciliation: { color: colors.warning },
  progressTrack: {
    gridColumn: "1 / -1",
    height: "3px",
    overflow: "hidden",
    borderRadius: "3px",
    backgroundColor: colors.line,
  },
  progressValue: {
    width: "42%",
    height: "100%",
    borderRadius: "3px",
    backgroundColor: colors.warning,
    animationName: stylex.keyframes({
      "0%": { transform: "translateX(-75%)" },
      "100%": { transform: "translateX(235%)" },
    }),
    animationDuration: "1.4s",
    animationIterationCount: "infinite",
    animationTimingFunction: motion.easeOut,
  },
  surface: {
    position: "relative",
    minWidth: 0,
    minHeight: 0,
    overflow: "hidden",
  },
  body: {
    padding: "clamp(24px, 6vw, 56px)",
    display: "grid",
    placeItems: "center",
    textAlign: "center",
  },
  bodyInner: {
    width: "min(520px, 100%)",
    display: "grid",
    justifyItems: "center",
    gap: spacing.md,
  },
  bodyIcon: { width: "20px", height: "20px", color: colors.muted, strokeWidth: 1.7 },
  bodyTitle: { margin: 0, color: colors.ink, fontSize: "16px", fontWeight: 650 },
  bodyCopy: {
    maxWidth: "64ch",
    margin: 0,
    color: colors.muted,
    fontSize: "13px",
    lineHeight: 1.6,
    textWrap: "pretty",
  },
  errorIcon: { color: colors.danger },
  errorCode: {
    color: colors.quiet,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: "11px",
  },
  spin: {
    animationName: stylex.keyframes({ to: { transform: "rotate(360deg)" } }),
    animationDuration: "900ms",
    animationIterationCount: "infinite",
    animationTimingFunction: "linear",
  },
});

function SessionPending() {
  return (
    <AppShell>
      <section
        aria-label="Checking session authority"
        aria-busy="true"
        {...stylex.props(styles.pendingStage)}
      >
        <div {...stylex.props(styles.pendingLine)}>
          <div {...stylex.props(styles.pendingBeam)} />
        </div>
      </section>
    </AppShell>
  );
}

const formatDuration = (seconds: number): string => {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
};

const configuredSelectionLabel = (selection: SessionModel["selection"]): string => {
  if (selection === undefined) return "Selection unavailable";
  const effort =
    selection.effort === undefined ? "default thinking" : `${selection.effort} thinking`;
  if (selection.agent === "codex") return `OpenAI · Codex · ${selection.model} · ${effort}`;
  if (selection.agent === "claude")
    return `Anthropic · Claude Code · ${selection.model} · ${effort}`;
  return `Pi · ${selection.modelProvider ?? "provider unavailable"} · ${selection.model ?? "default model"} · ${effort}`;
};

function SessionRoute() {
  const data = Route.useLoaderData();
  const router = useRouter();
  if (data.state === "failed")
    return <SessionReadError data={data} retry={() => void router.invalidate()} />;
  return <SessionWorkspace data={data} />;
}

function SessionReadError({
  data,
  retry,
}: {
  readonly data: SessionRouteFailed;
  readonly retry: () => void;
}) {
  const message =
    data.failure.kind === "http"
      ? data.failure.message
      : data.failure.kind === "malformed-response"
        ? "Scotty returned a session shape this UI cannot safely use."
        : "Scotty could not reach the session authority.";
  return (
    <AppShell>
      <section {...stylex.props(styles.pendingStage)}>
        <div role="alert" {...stylex.props(styles.bodyInner)}>
          <CircleAlert aria-hidden {...stylex.props(styles.bodyIcon, styles.errorIcon)} />
          <h1 {...stylex.props(styles.bodyTitle)}>
            {data.conflict ? "Session state changed" : "Session unavailable"}
          </h1>
          <p {...stylex.props(styles.bodyCopy)}>{message}</p>
          {data.failure.kind === "http" ? (
            <span {...stylex.props(styles.errorCode)}>HTTP {data.failure.status}</span>
          ) : null}
          <Button onClick={retry} variant="primary">
            <RefreshCw aria-hidden {...stylex.props(styles.actionIcon)} />
            Check again
          </Button>
        </div>
      </section>
    </AppShell>
  );
}

function SessionWorkspace({ data }: { readonly data: SessionRouteReady }) {
  const { fixture } = data;
  const { refresh: refreshCatalog, refreshActor, seedActor, verifiedActors } = useSessionCatalog();
  const session = verifiedActors.get(data.session.id) ?? data.session;
  const presentation = presentSession(session, {
    now: new Date(),
    source: "actor",
    runtimeAvailability: "checking",
  });
  const eligibility = decideConsoleEligibility(session);
  const refreshLifecycle = useCallback(() => {
    void refreshActor(session.id);
  }, [refreshActor, session.id]);
  const transitioning = presentation.operation !== null;
  useEffect(() => {
    if (fixture || !transitioning) return;
    let active = true;
    let timer: number | undefined;
    const pollActor = async () => {
      if (document.visibilityState !== "visible") {
        timer = window.setTimeout(() => void pollActor(), 2_000);
        return;
      }
      const result = await refreshActor(session.id);
      if (!active) return;
      if (result?.ok) {
        if (result.session.authority.kind === "stable") {
          await refreshCatalog();
          return;
        }
      }
      timer = window.setTimeout(() => void pollActor(), 2_000);
    };
    timer = window.setTimeout(() => void pollActor(), 2_000);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [fixture, refreshActor, refreshCatalog, session.id, transitioning]);

  useEffect(() => {
    if (fixture) return;
    const refreshActorOnFocus = () => {
      if (document.visibilityState !== "visible") return;
      void refreshActor(session.id);
    };
    const timer = window.setInterval(refreshActorOnFocus, 30_000);
    window.addEventListener("focus", refreshActorOnFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshActorOnFocus);
    };
  }, [fixture, refreshActor, session.id]);

  useEffect(() => {
    if (!seedActor(data.session)) void refreshActor(data.session.id);
  }, [data.session, refreshActor, seedActor]);
  return (
    <AppShell>
      <div
        data-design="session-page"
        data-session-source={fixture ? "fixture" : "actor"}
        {...stylex.props(styles.page)}
      >
        <div data-design="workspace" {...stylex.props(styles.workspace)}>
          <header data-design="session-header" {...stylex.props(styles.headingRow)}>
            <div data-design="session-title" {...stylex.props(styles.titleBlock)}>
              <div data-design="breadcrumb" {...stylex.props(styles.breadcrumb)}>
                <span {...stylex.props(styles.repo)}>{session.display.repository}</span>
                <span aria-hidden {...stylex.props(styles.slash)}>
                  /
                </span>
                <span {...stylex.props(styles.branch)}>
                  {session.display.branch ?? "Vaporized"}
                </span>
              </div>
              <h1 {...stylex.props(styles.heading)}>{session.display.title}</h1>
            </div>
            <SessionMenu>
              <dl>
                <dt>Repository</dt>
                <dd>{session.display.repository}</dd>
                <dt>Working branch</dt>
                <dd>{session.display.branch ?? "Vaporized"}</dd>
                <dt>Base branch</dt>
                <dd>{session.display.defaultBranch ?? "Unavailable"}</dd>
                <dt>Time remaining</dt>
                <dd>{formatDuration(session.times.capRemainingSeconds)}</dd>
                <dt>Status</dt>
                <dd>{presentation.operation?.label ?? presentation.railLabel}</dd>
                <dt>Data source</dt>
                <dd>{fixture ? "Local preview" : "Live session"}</dd>
                <dt>Agent, model, and thinking</dt>
                <dd>{configuredSelectionLabel(session.selection)}</dd>
              </dl>
              <LifecycleControls
                key={session.id}
                presentation={presentation}
                sessionId={session.id}
              />
            </SessionMenu>
          </header>

          <section aria-label="Conversation" {...stylex.props(styles.surface)}>
            <SessionSelection.Provider value={configuredSelectionLabel(session.selection)}>
              <SessionWorkbench
                defaultBranch={session.display.defaultBranch}
                previewTurns={
                  fixture
                    ? session.id === "warm-demo-01"
                      ? markdownFixture
                      : conversationFixture
                    : undefined
                }
                runtimeAvailable={eligibility.eligible}
                sessionId={session.id}
              >
                <SessionSurface
                  eligibility={eligibility}
                  presentation={presentation}
                  onLifecycleMismatch={refreshLifecycle}
                  sessionId={session.id}
                  simulateConversation={
                    fixture && (session.id === "warm-working-001" || session.id === "warm-demo-01")
                  }
                />
              </SessionWorkbench>
            </SessionSelection.Provider>
            {presentation.operation !== null ? (
              <div className="session-selection-paused">
                {configuredSelectionLabel(session.selection)}
              </div>
            ) : null}
          </section>
        </div>
      </div>
    </AppShell>
  );
}

interface PendingLifecycleAction {
  readonly action: SessionLifecycleAction;
  readonly sessionId: string;
}

const isGone = (result: Awaited<ReturnType<typeof readAuthoritativeSession>>): boolean =>
  result.ok &&
  result.session.authority.kind === "stable" &&
  result.session.authority.lifecycle === "gone";

function LifecycleControls({
  presentation,
  sessionId,
}: {
  readonly presentation: SessionPresentation;
  readonly sessionId: string;
}) {
  const router = useRouter();
  const { refresh, refreshActor } = useSessionCatalog();
  const [confirmingVaporizeFor, setConfirmingVaporizeFor] = useState<string | null>(null);
  const [message, setMessage] = useState<LifecycleControlMessage | null>(null);
  const [pending, setPending] = useState<PendingLifecycleAction | null>(null);
  const requestSerial = useRef(0);
  const activeRequest = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      requestSerial.current += 1;
      activeRequest.current = null;
    };
  }, []);

  const currentPending = pending?.sessionId === sessionId ? pending : null;
  const currentMessage = message?.sessionId === sessionId ? message : null;
  const confirmingVaporize = confirmingVaporizeFor === sessionId;
  const stableLifecycle =
    presentation.authority.kind === "stable" ? presentation.authority.lifecycle : null;

  const authoritativeMessageWasResolved = isLifecycleMessageResolved(
    currentMessage,
    presentation.source,
    presentation.freshness,
    stableLifecycle,
  );
  if (authoritativeMessageWasResolved) setMessage(null);
  const visibleMessage = authoritativeMessageWasResolved ? null : currentMessage;

  const runAction = (action: SessionLifecycleAction): void => {
    if (activeRequest.current !== null) return;
    const serial = ++requestSerial.current;
    activeRequest.current = serial;
    setMessage(null);
    setConfirmingVaporizeFor(null);
    setPending({ action, sessionId });
    const startedFrom = stableLifecycle;

    void (async () => {
      const mutation = await mutateSessionLifecycle(sessionId, action);
      const authoritative = await refreshActor(sessionId);
      let refreshed = true;
      try {
        await refresh();
      } catch {
        refreshed = false;
      }

      if (requestSerial.current !== serial) return;
      if (action === "vaporize" && authoritative !== undefined && isGone(authoritative)) {
        await router.navigate({ to: "/sessions" });
        return;
      }

      setMessage(
        resolveLifecycleActionMessage(
          action,
          sessionId,
          startedFrom,
          mutation,
          authoritative,
          refreshed,
        ),
      );
    })().finally(() => {
      if (requestSerial.current !== serial) return;
      activeRequest.current = null;
      setPending(null);
    });
  };

  if (presentation.operation !== null)
    return (
      <div
        data-design="session-actions"
        data-design-operation="true"
        {...stylex.props(styles.actionArea)}
      >
        <Button disabled>
          <LoaderCircle aria-hidden {...stylex.props(styles.actionIcon, styles.spin)} />
          {presentation.operation.label}
        </Button>
        <p {...stylex.props(styles.actionNote)}>Controls return when this finishes.</p>
      </div>
    );

  const primary: SessionAction | undefined = presentation.availableActions.includes("resume")
    ? "resume"
    : presentation.availableActions.includes("sleep")
      ? "sleep"
      : undefined;
  const secondary = presentation.availableActions.filter(
    (action) => action !== primary && action !== "vaporize",
  );
  const canVaporize = presentation.availableActions.includes("vaporize");
  if (currentPending !== null) {
    const detail = actionDetails[currentPending.action];
    const Icon = detail.icon;
    return (
      <div
        aria-busy="true"
        data-session-action={currentPending.action}
        data-design="session-actions"
        {...stylex.props(styles.actionArea)}
      >
        <Button disabled variant={currentPending.action === "checkpoint" ? "default" : "primary"}>
          <LoaderCircle aria-hidden {...stylex.props(styles.actionIcon, styles.spin)} />
          {detail.pendingLabel}
        </Button>
        <p role="status" aria-live="polite" {...stylex.props(styles.actionNote)}>
          <Icon aria-hidden {...stylex.props(styles.actionIcon)} />
          Waiting for session authority…
        </p>
      </div>
    );
  }

  if (primary === undefined && secondary.length === 0 && !canVaporize) return null;

  if (confirmingVaporize)
    return (
      <div {...stylex.props(styles.confirm)}>
        <p {...stylex.props(styles.confirmCopy)}>
          Vaporize permanently removes the runtime and owned session state. Confirmation is required
          before a request can be sent.
        </p>
        <div {...stylex.props(styles.actionRow)}>
          <Button onClick={() => setConfirmingVaporizeFor(null)} variant="quiet">
            Cancel
          </Button>
          <Button onClick={() => runAction("vaporize")}>
            <Trash2 aria-hidden {...stylex.props(styles.actionIcon)} />
            Confirm vaporize
          </Button>
        </div>
      </div>
    );

  return (
    <div data-design="session-actions" {...stylex.props(styles.actionArea)}>
      <LifecycleActionRow
        canVaporize={canVaporize}
        onAction={runAction}
        onVaporize={() => setConfirmingVaporizeFor(sessionId)}
        primary={primary}
        secondary={secondary}
      />
      {visibleMessage ? (
        <p
          role={visibleMessage.kind === "error" ? "alert" : "status"}
          aria-live="polite"
          {...stylex.props(
            styles.actionMessage,
            visibleMessage.kind === "error" ? styles.actionError : styles.actionReconciliation,
          )}
        >
          {visibleMessage.text}
        </p>
      ) : null}
    </div>
  );
}

function LifecycleActionRow({
  canVaporize,
  onAction,
  onVaporize,
  primary,
  secondary,
}: {
  readonly canVaporize: boolean;
  readonly onAction: (action: SessionLifecycleAction) => void;
  readonly onVaporize: () => void;
  readonly primary: SessionAction | undefined;
  readonly secondary: ReadonlyArray<SessionAction>;
}) {
  return (
    <div data-design="menu-actions">
      {primary === undefined ? null : (
        <LifecycleButton action={primary} onAction={onAction} primary />
      )}
      {secondary.map((action) => (
        <LifecycleButton key={action} action={action} onAction={onAction} />
      ))}
      {canVaporize ? <LifecycleButton action="vaporize" onAction={() => onVaporize()} /> : null}
    </div>
  );
}

function LifecycleButton({
  action,
  onAction,
  primary = false,
}: {
  readonly action: SessionAction;
  readonly onAction: (action: SessionLifecycleAction) => void;
  readonly primary?: boolean;
}) {
  const detail = actionDetails[action];
  const Icon = detail.icon;
  const onClick = action === "work" ? undefined : () => onAction(action);
  return (
    <Button disabled={action === "work"} onClick={onClick} variant={primary ? "primary" : "quiet"}>
      <Icon
        aria-hidden
        {...stylex.props(styles.actionIcon, action === "vaporize" && styles.dangerButton)}
      />
      {detail.label}
    </Button>
  );
}

function SessionSurface({
  eligibility,
  onLifecycleMismatch,
  presentation,
  sessionId,
  simulateConversation,
}: {
  readonly eligibility: ConsoleEligibility;
  readonly onLifecycleMismatch: () => void;
  readonly presentation: SessionPresentation;
  readonly sessionId: string;
  readonly simulateConversation: boolean;
}) {
  if (simulateConversation)
    return (
      <ConversationPreview
        turns={sessionId === "warm-demo-01" ? markdownFixture : conversationFixture}
      />
    );
  if (eligibility.eligible)
    return (
      <LiveConversation
        onLifecycleMismatch={onLifecycleMismatch}
        runtimeAvailable
        sessionId={sessionId}
      />
    );
  if (eligibility.reason === "lifecycle-operation")
    return (
      <div aria-busy="true" {...stylex.props(styles.body)}>
        <div {...stylex.props(styles.bodyInner)}>
          <LoaderCircle aria-hidden {...stylex.props(styles.bodyIcon, styles.spin)} />
          <h3 {...stylex.props(styles.bodyTitle)}>{presentation.shellTitle}</h3>
          <p {...stylex.props(styles.bodyCopy)}>
            {presentation.operation?.phase ?? "Finishing the current session operation."}
          </p>
          <div aria-hidden {...stylex.props(styles.progressTrack)}>
            <div {...stylex.props(styles.progressValue)} />
          </div>
        </div>
      </div>
    );
  if (presentation.authority.kind === "stable" && presentation.authority.lifecycle === "sleeping")
    return (
      <LiveConversation
        onLifecycleMismatch={onLifecycleMismatch}
        runtimeAvailable={false}
        sessionId={sessionId}
      />
    );
  if (presentation.authority.kind === "stable" && presentation.authority.lifecycle === "gone")
    return (
      <div {...stylex.props(styles.body)}>
        <div {...stylex.props(styles.bodyInner)}>
          <Archive aria-hidden {...stylex.props(styles.bodyIcon)} />
          <h3 {...stylex.props(styles.bodyTitle)}>Session vaporized</h3>
          <p {...stylex.props(styles.bodyCopy)}>
            This is the terminal session record. No runtime or workspace can be reopened.
          </p>
        </div>
      </div>
    );
  return (
    <div {...stylex.props(styles.body)}>
      <div {...stylex.props(styles.bodyInner)}>
        <CircleAlert aria-hidden {...stylex.props(styles.bodyIcon, styles.errorIcon)} />
        <h3 {...stylex.props(styles.bodyTitle)}>{presentation.shellTitle}</h3>
        <p {...stylex.props(styles.bodyCopy)}>
          {presentation.failureMessage ??
            "This session cannot open a live conversation in its current state."}
        </p>
      </div>
    </div>
  );
}
