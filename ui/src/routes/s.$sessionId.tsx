import * as stylex from "@stylexjs/stylex";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import {
  Archive,
  CircleAlert,
  Clock3,
  Cloud,
  GitBranch,
  LoaderCircle,
  MoreHorizontal,
  Moon,
  Play,
  RefreshCw,
  Save,
  Sparkles,
  Trash2,
} from "lucide-react";
import { AppShell } from "../components/AppShell";
import { Button } from "../components/Button";
import { Conversation } from "../components/Conversation";
import {
  mutateSessionLifecycle,
  type SessionLifecycleAction,
  type SessionMutationResult,
} from "../data/session-lifecycle";
import {
  decideConsoleEligibility,
  readAuthoritativeSession,
  type ConsoleEligibility,
  type SessionAction,
  type SessionModel,
  type SessionReadFailure,
} from "../data/session-reader";
import { readSessionList } from "../data/session-list-reader";
import { presentSession, type SessionPresentation } from "../domain/session-presentation";
import { buildSessionRail } from "../domain/session-rail";
import { sessionFixtureForId, sessionListFixtures } from "../fixtures/sessions";
import { conversationFixture } from "../fixtures/conversation";
import { colors, motion, spacing } from "../theme/tokens.stylex";

interface SessionRouteReady {
  readonly state: "ready";
  readonly session: SessionModel;
  readonly presentation: SessionPresentation;
  readonly eligibility: ConsoleEligibility;
  readonly fixture: boolean;
  readonly projections: ReadonlyArray<SessionModel>;
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
    const [result, list] = await Promise.all([
      readAuthoritativeSession(params.sessionId, {
        fixture: sessionFixtureForId(params.sessionId),
        fixtureFallback: import.meta.env.DEV,
        signal: abortController.signal,
      }),
      readSessionList({
        fixture: sessionListFixtures,
        fixtureFallback: import.meta.env.DEV,
        signal: abortController.signal,
      }),
    ]);
    if (!result.ok)
      return {
        state: "failed",
        failure: result.failure,
        conflict: result.failure.kind === "http" && result.failure.status === 409,
      };

    const eligibility = decideConsoleEligibility(result.session);
    return {
      state: "ready",
      session: result.session,
      presentation: presentSession(result.session, {
        now: new Date(),
        source: "actor",
        runtimeAvailability: "checking",
      }),
      eligibility,
      fixture: result.session.source === "fixture",
      projections: list.ok ? list.projections.map(({ session }) => session) : [],
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
    minHeight: "100dvh",
    display: "grid",
    gridTemplateRows: "auto minmax(0, 1fr)",
    backgroundColor: colors.space,
  },
  topbar: {
    minHeight: "64px",
    paddingInline: spacing.xl,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.lg,
    borderBottomWidth: "1px",
    borderBottomStyle: "solid",
    borderBottomColor: colors.line,
    backgroundColor: colors.shell,
    "@media (max-width: 720px)": { minHeight: "52px", paddingInline: spacing.md },
  },
  breadcrumb: {
    minWidth: 0,
    display: "flex",
    alignItems: "center",
    gap: spacing.sm,
    color: colors.quiet,
    fontSize: "12px",
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
    width: "min(1040px, 100%)",
    marginInline: "auto",
    padding: "clamp(24px, 5vw, 64px)",
    display: "grid",
    alignContent: "start",
    gap: spacing.xxl,
    "@media (max-width: 720px)": { padding: spacing.lg, gap: spacing.xl },
  },
  headingRow: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: spacing.xl,
    "@media (max-width: 720px)": { flexDirection: "column", gap: spacing.lg },
  },
  titleBlock: { minWidth: 0, display: "grid", gap: spacing.sm },
  statusLine: {
    display: "flex",
    alignItems: "center",
    gap: spacing.sm,
    color: colors.muted,
    fontSize: "12px",
  },
  stateIcon: { width: "14px", height: "14px", color: colors.warning, strokeWidth: 1.8 },
  heading: {
    maxWidth: "720px",
    margin: 0,
    color: colors.ink,
    fontSize: "28px",
    fontWeight: 680,
    lineHeight: 1.15,
    letterSpacing: "-0.025em",
    textWrap: "balance",
  },
  metadata: {
    display: "flex",
    flexWrap: "wrap",
    gap: spacing.lg,
    color: colors.quiet,
    fontSize: "12px",
    fontVariantNumeric: "tabular-nums",
  },
  metadataItem: { display: "inline-flex", alignItems: "center", gap: "6px" },
  smallIcon: { width: "13px", height: "13px", strokeWidth: 1.8 },
  actionArea: {
    minWidth: "250px",
    display: "grid",
    justifyItems: "end",
    gap: spacing.sm,
    "@media (max-width: 720px)": {
      width: "100%",
      minWidth: 0,
      justifyItems: "start",
    },
  },
  actionRow: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: spacing.sm },
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
  },
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
    "@media (max-width: 720px)": { width: "100%", maxWidth: "none" },
  },
  confirmCopy: { margin: 0, color: colors.muted, fontSize: "12px", lineHeight: 1.5 },
  actionIcon: { width: "15px", height: "15px", strokeWidth: 1.8 },
  actionNote: {
    width: "100%",
    margin: 0,
    color: colors.quiet,
    fontSize: "11px",
    textAlign: "right",
    "@media (max-width: 720px)": { textAlign: "left" },
  },
  actionMessage: {
    width: "100%",
    margin: 0,
    color: colors.muted,
    fontSize: "11px",
    lineHeight: 1.45,
    textAlign: "right",
    "@media (max-width: 720px)": { textAlign: "left" },
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
    height: "min(680px, calc(100dvh - 280px))",
    minHeight: "420px",
    display: "grid",
    gridTemplateRows: "auto minmax(0, 1fr)",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: colors.line,
    borderRadius: "12px",
    backgroundColor: colors.panel,
    "@media (max-width: 720px)": {
      height: "calc(100dvh - 230px)",
      minHeight: "460px",
    },
  },
  surfaceHeader: {
    minHeight: "48px",
    paddingInline: spacing.lg,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md,
    borderBottomWidth: "1px",
    borderBottomStyle: "solid",
    borderBottomColor: colors.line,
  },
  surfaceTitle: { margin: 0, color: colors.muted, fontSize: "12px", fontWeight: 650 },
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
    <AppShell repositories={[]}>
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
    <AppShell repositories={[]}>
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
  const { eligibility, fixture, presentation, session } = data;
  const rail = buildSessionRail(data.projections, { selectedActor: session });
  return (
    <AppShell archivedSessions={rail.archivedSessions} repositories={rail.repositories}>
      <div data-session-source={fixture ? "fixture" : "actor"} {...stylex.props(styles.page)}>
        <header {...stylex.props(styles.topbar)}>
          <div {...stylex.props(styles.breadcrumb)}>
            <span {...stylex.props(styles.repo)}>{session.display.repository}</span>
            <span aria-hidden {...stylex.props(styles.slash)}>
              /
            </span>
            <span {...stylex.props(styles.branch)}>{session.display.branch ?? "Vaporized"}</span>
          </div>
        </header>
        <div {...stylex.props(styles.workspace)}>
          <section {...stylex.props(styles.headingRow)}>
            <div {...stylex.props(styles.titleBlock)}>
              <div {...stylex.props(styles.statusLine)}>
                {presentation.operation === null ? (
                  <Cloud aria-hidden {...stylex.props(styles.stateIcon)} />
                ) : (
                  <LoaderCircle aria-hidden {...stylex.props(styles.stateIcon, styles.spin)} />
                )}
                {presentation.railLabel}
              </div>
              <h1 {...stylex.props(styles.heading)}>{session.display.title}</h1>
              <div {...stylex.props(styles.metadata)}>
                <span {...stylex.props(styles.metadataItem)}>
                  <GitBranch aria-hidden {...stylex.props(styles.smallIcon)} />
                  {session.display.defaultBranch ?? "No active branch"}
                </span>
                <span {...stylex.props(styles.metadataItem)}>
                  <Clock3 aria-hidden {...stylex.props(styles.smallIcon)} />
                  {formatDuration(session.times.capRemainingSeconds)} remaining
                </span>
              </div>
            </div>
            <LifecycleControls presentation={presentation} sessionId={session.id} />
          </section>

          <section {...stylex.props(styles.surface)}>
            <header {...stylex.props(styles.surfaceHeader)}>
              <h2 {...stylex.props(styles.surfaceTitle)}>Conversation</h2>
            </header>
            <SessionSurface
              eligibility={eligibility}
              presentation={presentation}
              simulateConversation={fixture && session.id === "warm-working-001"}
            />
          </section>
        </div>
      </div>
    </AppShell>
  );
}

type ControlMessage = {
  readonly kind: "error" | "reconciliation";
  readonly sessionId: string;
  readonly text: string;
};

interface PendingLifecycleAction {
  readonly action: SessionLifecycleAction;
  readonly sessionId: string;
}

const actionVerb = (action: SessionLifecycleAction): string =>
  action === "checkpoint"
    ? "save the checkpoint"
    : action === "sleep"
      ? "put the session to sleep"
      : action === "resume"
        ? "resume the session"
        : "vaporize the session";

const isGone = (result: Awaited<ReturnType<typeof readAuthoritativeSession>>): boolean =>
  result.ok &&
  result.session.authority.kind === "stable" &&
  result.session.authority.lifecycle === "gone";

const expectedLifecycleFor = (action: SessionLifecycleAction): "warm" | "sleeping" | "gone" =>
  action === "sleep" ? "sleeping" : action === "vaporize" ? "gone" : "warm";

const hasExpectedLifecycle = (
  result: Awaited<ReturnType<typeof readAuthoritativeSession>>,
  action: SessionLifecycleAction,
): boolean =>
  result.ok &&
  result.session.authority.kind === "stable" &&
  result.session.authority.lifecycle === expectedLifecycleFor(action);

const mutationErrorMessage = (
  action: SessionLifecycleAction,
  result: Extract<SessionMutationResult, { readonly ok: false }>,
): string => {
  if (result.failure.kind === "network")
    return `Could not reach the session to ${actionVerb(action)}. Check your connection and try again.`;
  if (result.failure.kind === "malformed-response")
    return "The session action response could not be verified. Check the current state before trying again.";
  if (result.failure.status === 401 || result.failure.status === 403)
    return "You are not authorized to change this session. Sign in again and retry.";
  if (result.failure.status === 404)
    return "This session is no longer available. Refresh the session list.";
  return `Could not ${actionVerb(action)}. ${result.failure.hint ?? "Check the current state and try again."}`;
};

function LifecycleControls({
  presentation,
  sessionId,
}: {
  readonly presentation: SessionPresentation;
  readonly sessionId: string;
}) {
  const router = useRouter();
  const [confirmingVaporizeFor, setConfirmingVaporizeFor] = useState<string | null>(null);
  const [message, setMessage] = useState<ControlMessage | null>(null);
  const [pending, setPending] = useState<PendingLifecycleAction | null>(null);
  const requestSerial = useRef(0);
  const activeRequest = useRef<number | null>(null);

  useEffect(() => {
    requestSerial.current += 1;
    activeRequest.current = null;
    setConfirmingVaporizeFor(null);
    setMessage(null);
    setPending(null);
    return () => {
      requestSerial.current += 1;
      activeRequest.current = null;
    };
  }, [sessionId]);

  const currentPending = pending?.sessionId === sessionId ? pending : null;
  const currentMessage = message?.sessionId === sessionId ? message : null;
  const confirmingVaporize = confirmingVaporizeFor === sessionId;

  const runAction = (action: SessionLifecycleAction): void => {
    if (activeRequest.current !== null) return;
    const serial = ++requestSerial.current;
    activeRequest.current = serial;
    setMessage(null);
    setConfirmingVaporizeFor(null);
    setPending({ action, sessionId });

    void (async () => {
      const mutation = await mutateSessionLifecycle(sessionId, action);
      const authoritative = await readAuthoritativeSession(sessionId);
      let invalidated = true;
      try {
        await router.invalidate();
      } catch {
        invalidated = false;
      }

      if (requestSerial.current !== serial) return;
      if (action === "vaporize" && isGone(authoritative)) {
        await router.navigate({ to: "/sessions" });
        return;
      }

      if (mutation.ok && !authoritative.ok) {
        setMessage({
          kind: "error",
          sessionId,
          text: "The action completed, but the current session state could not be verified. Check again.",
        });
      } else if (
        !mutation.ok &&
        mutation.failure.kind === "http" &&
        mutation.failure.status === 409
      ) {
        setMessage({
          kind: "reconciliation",
          sessionId,
          text: authoritative.ok
            ? invalidated
              ? "The session changed while this action was starting. The latest state is shown."
              : "The session changed while this action was starting. Refresh to see the latest state."
            : "The session changed while this action was starting. Refresh to see the latest state.",
        });
      } else if (!mutation.ok) {
        setMessage({ kind: "error", sessionId, text: mutationErrorMessage(action, mutation) });
      } else if (!invalidated) {
        setMessage({
          kind: "error",
          sessionId,
          text: "The action completed, but the session view could not refresh. Reload to confirm.",
        });
      } else if (!hasExpectedLifecycle(authoritative, action)) {
        setMessage({
          kind: "reconciliation",
          sessionId,
          text: "The session state changed while this action was completing. The latest state is shown.",
        });
      }
    })().finally(() => {
      if (requestSerial.current !== serial) return;
      activeRequest.current = null;
      setPending(null);
    });
  };

  if (presentation.operation !== null)
    return (
      <div {...stylex.props(styles.actionArea)}>
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
    <div {...stylex.props(styles.actionArea)}>
      <div {...stylex.props(styles.actionRow)}>
        {primary === undefined ? null : (
          <LifecycleButton action={primary} onAction={runAction} primary />
        )}
        {secondary.length > 0 ? (
          <details {...stylex.props(styles.actionMenu)}>
            <summary aria-label="More session actions" {...stylex.props(styles.actionSummary)}>
              <MoreHorizontal aria-hidden {...stylex.props(styles.actionIcon)} />
            </summary>
            <div {...stylex.props(styles.menuPanel)}>
              {secondary.map((action) => (
                <LifecycleButton action={action} key={action} onAction={runAction} />
              ))}
            </div>
          </details>
        ) : null}
        {canVaporize ? (
          <Button onClick={() => setConfirmingVaporizeFor(sessionId)} variant="quiet">
            <Trash2 aria-hidden {...stylex.props(styles.actionIcon, styles.dangerButton)} />
            Vaporize
          </Button>
        ) : null}
      </div>
      {currentMessage ? (
        <p
          role={currentMessage.kind === "error" ? "alert" : "status"}
          aria-live="polite"
          {...stylex.props(
            styles.actionMessage,
            currentMessage.kind === "error" ? styles.actionError : styles.actionReconciliation,
          )}
        >
          {currentMessage.text}
        </p>
      ) : null}
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
      <Icon aria-hidden {...stylex.props(styles.actionIcon)} />
      {detail.label}
    </Button>
  );
}

function SessionSurface({
  eligibility,
  presentation,
  simulateConversation,
}: {
  readonly eligibility: ConsoleEligibility;
  readonly presentation: SessionPresentation;
  readonly simulateConversation: boolean;
}) {
  if (simulateConversation) return <Conversation turns={conversationFixture} />;
  if (eligibility.eligible)
    return (
      <div {...stylex.props(styles.body)}>
        <div {...stylex.props(styles.bodyInner)}>
          <LoaderCircle aria-hidden {...stylex.props(styles.bodyIcon, styles.spin)} />
          <h3 {...stylex.props(styles.bodyTitle)}>Checking runtime</h3>
          <p {...stylex.props(styles.bodyCopy)}>Runtime availability has not been confirmed yet.</p>
        </div>
      </div>
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
      <div {...stylex.props(styles.body)}>
        <div {...stylex.props(styles.bodyInner)}>
          <Moon aria-hidden {...stylex.props(styles.bodyIcon)} />
          <h3 {...stylex.props(styles.bodyTitle)}>Conversation retained</h3>
          <p {...stylex.props(styles.bodyCopy)}>
            The cloud runtime is stopped. Resume restores the confirmed backup before work can
            continue.
          </p>
        </div>
      </div>
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
